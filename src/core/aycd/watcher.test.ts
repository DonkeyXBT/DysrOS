import { describe, it, expect } from 'vitest'
import type { CompletedTask, MailTask } from './client.js'
import { bolOrderConfirmationTask, bolShipmentTask } from './tasks.js'
import {
  AycdWatcher, COMPLETED_TASK_TTL_MS, ERROR_BACKOFF_MS, MAX_POLL_INTERVAL_MS,
  type CapturedEvent, type InboxTransport, type WatcherClock,
} from './watcher.js'

const START = Date.UTC(2026, 6, 1, 10, 0, 0)

interface TestClock extends WatcherClock {
  advance(ms: number): void
  readonly sleeps: number[]
}

function testClock(onSleep?: (ms: number) => void): TestClock {
  let current = START
  const sleeps: number[] = []
  return {
    now: () => current,
    async sleep(ms) {
      sleeps.push(ms)
      current += ms
      onSleep?.(ms)
    },
    advance(ms) {
      current += ms
    },
    sleeps,
  }
}

class FakeInbox implements InboxTransport {
  readonly created: { id: string; task: MailTask }[] = []
  completed: CompletedTask[] = []
  createError: Error | null = null
  collectError: Error | null = null
  collectCalls = 0
  private next = 1

  async createTask(task: MailTask): Promise<{ id: string }> {
    if (this.createError) throw this.createError
    const id = `task_${this.next++}`
    this.created.push({ id, task })
    return { id }
  }

  async completedTasks(): Promise<CompletedTask[]> {
    this.collectCalls += 1
    if (this.collectError) throw this.collectError
    return this.completed
  }
}

function watcherWith(
  inbox: FakeInbox,
  clock: WatcherClock,
  overrides: Partial<ConstructorParameters<typeof AycdWatcher>[0]> = {},
): { watcher: AycdWatcher; captured: CapturedEvent[]; errors: string[] } {
  const captured: CapturedEvent[] = []
  const errors: string[] = []
  const watcher = new AycdWatcher({
    client: inbox,
    clock,
    addresses: ['orders@example.com'],
    builders: [bolOrderConfirmationTask],
    onEvent: (event) => captured.push(event),
    onError: (message) => errors.push(message),
    ...overrides,
  })
  return { watcher, captured, errors }
}

const ORDER_RESULTS = {
  orderRef: 'C0008N401L',
  title: 'LEGO Star Wars 75192',
  quantity: '1 x €',
  unitPrice: '11,99',
  shipping: '0,00',
  total: '11,99',
}

describe('keeping tasks registered', () => {
  it('registers one task per address and template on the first poll', async () => {
    const inbox = new FakeInbox()
    const { watcher } = watcherWith(inbox, testClock(), {
      addresses: ['a@example.com', 'b@example.com'],
      builders: [bolOrderConfirmationTask, bolShipmentTask],
    })

    const result = await watcher.poll()

    expect(result.registered).toBe(4)
    expect(inbox.created.map((entry) => entry.task.email).sort())
      .toEqual(['a@example.com', 'a@example.com', 'b@example.com', 'b@example.com'])
  })

  it('starts the window at the current moment, in epoch seconds', async () => {
    const inbox = new FakeInbox()
    const { watcher } = watcherWith(inbox, testClock())

    await watcher.poll()

    expect(inbox.created[0]!.task.receivedAt).toBe(Math.floor(START / 1000))
  })

  it('does not re-register while the current task is comfortably alive', async () => {
    const inbox = new FakeInbox()
    const clock = testClock()
    const { watcher } = watcherWith(inbox, clock)

    await watcher.poll()
    clock.advance(60_000)
    const second = await watcher.poll()

    expect(second.registered).toBe(0)
    expect(inbox.created).toHaveLength(1)
  })

  it('registers the replacement before the current task expires, so no gap opens', async () => {
    const inbox = new FakeInbox()
    const clock = testClock()
    const { watcher } = watcherWith(inbox, clock, {
      taskTimeoutSeconds: 600,
      renewMarginSeconds: 60,
    })

    await watcher.poll()
    // 550 seconds in: 50 seconds of life left, inside the renewal margin.
    clock.advance(550_000)
    const second = await watcher.poll()

    expect(second.registered).toBe(1)
    expect(inbox.created).toHaveLength(2)
  })

  it('clamps a task lifetime to the documented maximum instead of being rejected', async () => {
    const inbox = new FakeInbox()
    const { watcher } = watcherWith(inbox, testClock(), { taskTimeoutSeconds: 99_999 })

    await watcher.poll()

    expect(inbox.created[0]!.task.timeout).toBe(3600)
  })

  it('registers a fresh task once the previous one has expired unnoticed', async () => {
    const inbox = new FakeInbox()
    const clock = testClock()
    const { watcher } = watcherWith(inbox, clock, { taskTimeoutSeconds: 600 })

    await watcher.poll()
    clock.advance(700_000)
    const second = await watcher.poll()

    expect(second.registered).toBe(1)
  })

  it('keeps renewing the other templates when one is rejected', async () => {
    const inbox = new FakeInbox()
    const { watcher, errors } = watcherWith(inbox, testClock(), {
      builders: [bolOrderConfirmationTask, bolShipmentTask],
    })
    let calls = 0
    const original = inbox.createTask.bind(inbox)
    inbox.createTask = async (task) => {
      calls += 1
      if (calls === 1) throw new Error('Inbox rejected the task as invalid.')
      return original(task)
    }

    const result = await watcher.poll()

    expect(result.registered).toBe(1)
    expect(errors[0]).toMatch(/could not register aycd-bol-order-confirmation/i)
  })

  it('stops watching an address that is dropped from the set', async () => {
    const inbox = new FakeInbox()
    const { watcher } = watcherWith(inbox, testClock(), {
      addresses: ['a@example.com', 'b@example.com'],
    })

    await watcher.poll()
    watcher.setAddresses(['a@example.com'])
    const second = await watcher.poll()

    expect(second.registered).toBe(0)
    expect(watcher.status().activeTasks).toBe(1)
    expect(watcher.status().addresses).toEqual(['a@example.com'])
  })
})

describe('collecting completed tasks', () => {
  it('converts a successful task into a parsed event', async () => {
    const inbox = new FakeInbox()
    const { watcher, captured } = watcherWith(inbox, testClock())

    await watcher.poll()
    inbox.completed = [{ id: 'task_1', status: 'success', results: ORDER_RESULTS }]
    const result = await watcher.poll()

    expect(result.events).toBe(1)
    expect(captured).toHaveLength(1)
    expect(captured[0]!.taskId).toBe('task_1')
    expect(captured[0]!.builderId).toBe('aycd-bol-order-confirmation')
    expect(captured[0]!.event.externalOrderId).toBe('C0008N401L')
    expect(captured[0]!.event.type).toBe('order_placed')
  })

  it('timestamps the capture from the injected clock, since Inbox reports no date', async () => {
    const inbox = new FakeInbox()
    const clock = testClock()
    const { watcher, captured } = watcherWith(inbox, clock)

    await watcher.poll()
    inbox.completed = [{ id: 'task_1', status: 'success', results: ORDER_RESULTS }]
    await watcher.poll()

    expect(captured[0]!.event.occurredAt).toBe(new Date(START).toISOString())
  })

  it('frees the slot after a capture, so the next poll starts a new task', async () => {
    const inbox = new FakeInbox()
    const { watcher } = watcherWith(inbox, testClock())

    await watcher.poll()
    inbox.completed = [{ id: 'task_1', status: 'success', results: ORDER_RESULTS }]
    await watcher.poll()
    inbox.completed = []
    const third = await watcher.poll()

    expect(third.registered).toBe(1)
    expect(inbox.created).toHaveLength(2)
  })

  it('does not record the same completed task twice if Inbox keeps returning it', async () => {
    const inbox = new FakeInbox()
    const { watcher, captured } = watcherWith(inbox, testClock())

    await watcher.poll()
    inbox.completed = [{ id: 'task_1', status: 'success', results: ORDER_RESULTS }]
    await watcher.poll()
    await watcher.poll()

    expect(captured).toHaveLength(1)
  })

  it('forgets a collected id only after Inbox itself would have dropped it', async () => {
    const inbox = new FakeInbox()
    const clock = testClock()
    const { watcher, captured } = watcherWith(inbox, clock)

    await watcher.poll()
    inbox.completed = [{ id: 'task_1', status: 'success', results: ORDER_RESULTS }]
    await watcher.poll()
    clock.advance(COMPLETED_TASK_TTL_MS - 1000)
    await watcher.poll()

    expect(captured).toHaveLength(1)
  })

  it('ignores a task from an earlier run rather than guessing what it was', async () => {
    const inbox = new FakeInbox()
    const { watcher, captured } = watcherWith(inbox, testClock())

    inbox.completed = [{ id: 'from_a_previous_run', status: 'success', results: ORDER_RESULTS }]
    const result = await watcher.poll()

    expect(result.collected).toBe(1)
    expect(result.succeeded).toBe(1)
    expect(captured).toHaveLength(0)
  })

  it('treats a success with no extracted fields as nothing to record', async () => {
    const inbox = new FakeInbox()
    const { watcher, captured } = watcherWith(inbox, testClock())

    await watcher.poll()
    inbox.completed = [{ id: 'task_1', status: 'success', results: {} }]
    const result = await watcher.poll()

    expect(result.succeeded).toBe(1)
    expect(result.events).toBe(0)
    expect(captured).toHaveLength(0)
  })
})

describe('surviving the unhappy paths', () => {
  it('counts a timeout as routine and re-registers rather than throwing', async () => {
    const inbox = new FakeInbox()
    const { watcher, errors } = watcherWith(inbox, testClock())

    await watcher.poll()
    inbox.completed = [{ id: 'task_1', status: 'timeout' }]
    const second = await watcher.poll()
    inbox.completed = []
    const third = await watcher.poll()

    expect(second.timedOut).toBe(1)
    expect(errors).toEqual([])
    expect(third.registered).toBe(1)
  })

  it('records an errored task without throwing and without inventing an event', async () => {
    const inbox = new FakeInbox()
    const { watcher, captured, errors } = watcherWith(inbox, testClock())

    await watcher.poll()
    inbox.completed = [{ id: 'task_1', status: 'error' }]
    const second = await watcher.poll()

    expect(second.errored).toBe(1)
    expect(captured).toHaveLength(0)
    expect(errors[0]).toMatch(/reported an error/i)
    expect(watcher.status().lastError).toMatch(/reported an error/i)
  })

  it('keeps polling when collection itself fails', async () => {
    const inbox = new FakeInbox()
    const { watcher, errors } = watcherWith(inbox, testClock())
    inbox.collectError = new Error('AYCD Inbox rate limit reached')

    const result = await watcher.poll()

    expect(result.collected).toBe(0)
    expect(errors[0]).toMatch(/rate limit/i)
    expect(result.nextDelayMs).toBe(ERROR_BACKOFF_MS)
  })

  it('does not let a failing event sink stop the watcher', async () => {
    const inbox = new FakeInbox()
    const { watcher, errors } = watcherWith(inbox, testClock(), {
      onEvent: () => {
        throw new Error('database is locked')
      },
    })

    await watcher.poll()
    inbox.completed = [{ id: 'task_1', status: 'success', results: ORDER_RESULTS }]
    const second = await watcher.poll()

    expect(second.events).toBe(0)
    expect(errors[0]).toMatch(/database is locked/)
  })
})

describe('poll cadence', () => {
  it('polls on the vendor cadence: three seconds, one when a backlog comes back', async () => {
    const inbox = new FakeInbox()
    const { watcher } = watcherWith(inbox, testClock())

    expect((await watcher.poll()).nextDelayMs).toBe(3000)

    inbox.completed = Array.from({ length: 100 }, (_, index) => ({
      id: `bulk_${index}`,
      status: 'timeout' as const,
    }))
    expect((await watcher.poll()).nextDelayMs).toBe(1000)
  })

  it('never waits long enough for a completed task to be dropped', async () => {
    // Inbox discards a completed task ten minutes after it completes, so every
    // interval the watcher can produce has to stay far inside that window.
    expect(MAX_POLL_INTERVAL_MS).toBeLessThan(COMPLETED_TASK_TTL_MS / 5)
    expect(ERROR_BACKOFF_MS).toBeLessThanOrEqual(MAX_POLL_INTERVAL_MS)
  })

  it('runs and stops the loop on the injected clock, with no real timers', async () => {
    const inbox = new FakeInbox()
    const running: { watcher: AycdWatcher | null } = { watcher: null }
    let slept = 0
    const clock = testClock(() => {
      slept += 1
      if (slept >= 3) running.watcher?.stop()
    })
    const { watcher } = watcherWith(inbox, clock)
    running.watcher = watcher

    watcher.start()
    await watcher.drain()

    expect(clock.sleeps).toEqual([3000, 3000, 3000])
    expect(inbox.collectCalls).toBe(3)
    expect(watcher.status().running).toBe(false)
  })

  it('reports what it has seen so far', async () => {
    const inbox = new FakeInbox()
    const { watcher } = watcherWith(inbox, testClock())

    await watcher.poll()
    inbox.completed = [{ id: 'task_1', status: 'success', results: ORDER_RESULTS }]
    await watcher.poll()

    expect(watcher.status()).toMatchObject({
      running: false,
      addresses: ['orders@example.com'],
      templates: 1,
      succeeded: 1,
      events: 1,
      // One registration only: the second poll found the first task still alive.
      registered: 1,
      lastPollAt: new Date(START).toISOString(),
      lastError: null,
    })
  })
})
