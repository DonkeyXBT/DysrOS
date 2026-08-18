import { describe, it, expect } from 'vitest'
import {
  AycdClient, AycdError, validateTask, splitResultValues, nextPollDelayMs,
  explainStatus, AYCD_BASE_URL, type FetchLike, type MailTask,
} from './client.js'

interface Recorded {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
}

function fakeFetch(
  respond: (request: Recorded) => { ok?: boolean; status?: number; body?: unknown },
): { fetcher: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = []
  const fetcher: FetchLike = async (url, init) => {
    const record: Recorded = {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body ? JSON.parse(init.body) : undefined,
    }
    calls.push(record)
    const result = respond(record)
    return {
      ok: result.ok ?? true,
      status: result.status ?? 200,
      text: async () => (result.body === undefined ? '' : JSON.stringify(result.body)),
    }
  }
  return { fetcher, calls }
}

function task(overrides: Partial<MailTask> = {}): MailTask {
  return {
    email: 'reseller@example.com',
    receivedAt: 1_787_000_000,
    mailFilters: [{ target: 'from', comparator: 'includes', value: 'bol.com' }],
    mailElements: [{ name: 'orderRef', target: 'subject', regex: '(C[0-9A-Z]{9})' }],
    ...overrides,
  }
}

describe('authentication', () => {
  it('sends the API key as a Token authorization header', async () => {
    const { fetcher, calls } = fakeFetch(() => ({ body: { ok: true } }))
    await new AycdClient({ apiKey: 'KEY123', fetcher }).verify()

    expect(calls[0]!.headers['Authorization']).toBe('Token KEY123')
    expect(calls[0]!.url).toBe(`${AYCD_BASE_URL}/user/verify`)
  })

  it('explains a 401 as Inbox not running rather than a bad key alone', async () => {
    const { fetcher } = fakeFetch(() => ({ ok: false, status: 401 }))
    const result = await new AycdClient({ apiKey: 'KEY123', fetcher }).verify()

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/desktop application must be running/i)
  })
})

describe('creating a task', () => {
  it('posts to the create endpoint and returns the id', async () => {
    const { fetcher, calls } = fakeFetch(() => ({ body: { id: 'task_1' } }))
    const client = new AycdClient({ apiKey: 'K', fetcher })

    await expect(client.createTask(task())).resolves.toEqual({ id: 'task_1' })
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.url).toBe(`${AYCD_BASE_URL}/tasks/mail/create`)
  })

  it('defaults the timeout to the recommended ten minutes, not the maximum', async () => {
    const { fetcher, calls } = fakeFetch(() => ({ body: { id: 'task_1' } }))
    await new AycdClient({ apiKey: 'K', fetcher }).createTask(task())

    expect((calls[0]!.body as { timeout: number }).timeout).toBe(600)
  })

  it('tags the task with the group so completed tasks can be collected', async () => {
    const { fetcher, calls } = fakeFetch(() => ({ body: { id: 'task_1' } }))
    await new AycdClient({ apiKey: 'K', fetcher, group: 'my-group' }).createTask(task())

    expect((calls[0]!.body as { group: string }).group).toBe('my-group')
  })

  it('lets an explicit timeout override the default', async () => {
    const { fetcher, calls } = fakeFetch(() => ({ body: { id: 'task_1' } }))
    await new AycdClient({ apiKey: 'K', fetcher }).createTask(task({ timeout: 1200 }))

    expect((calls[0]!.body as { timeout: number }).timeout).toBe(1200)
  })

  it('rejects an invalid task locally instead of spending a request on a 400', async () => {
    const { fetcher, calls } = fakeFetch(() => ({ body: { id: 'task_1' } }))
    const client = new AycdClient({ apiKey: 'K', fetcher })

    await expect(client.createTask(task({ mailFilters: [] }))).rejects.toThrow(/at least one mail filter/i)
    expect(calls).toHaveLength(0)
  })

  it('raises when Inbox returns no task id', async () => {
    const { fetcher } = fakeFetch(() => ({ body: {} }))
    await expect(new AycdClient({ apiKey: 'K', fetcher }).createTask(task()))
      .rejects.toThrow(/did not return a task id/i)
  })
})

describe('task validation', () => {
  it('accepts a well-formed task', () => {
    expect(validateTask(task())).toEqual([])
  })

  it('catches a millisecond timestamp, which would otherwise mean never', () => {
    expect(validateTask(task({ receivedAt: 1_787_000_000_000 })))
      .toContain('receivedAt looks like milliseconds; it must be epoch seconds')
  })

  it('enforces the documented ceilings on filters and elements', () => {
    const many = Array.from({ length: 11 }, () => ({
      target: 'from' as const, comparator: 'includes' as const, value: 'x',
    }))
    expect(validateTask(task({ mailFilters: many }))).toContain('at most 10 mail filters are allowed')
  })

  it('enforces the 1024 character field limit', () => {
    const long = 'x'.repeat(1025)
    expect(validateTask(task({
      mailFilters: [{ target: 'subject', comparator: 'includes', value: long }],
    }))[0]).toMatch(/exceeds 1024 characters/)
  })

  it('requires a selector when an element targets the body', () => {
    expect(validateTask(task({
      mailElements: [{ name: 'total', target: 'body', regex: '(\\d+)' }],
    }))).toContain('element "total" targets the body, which requires a selector')
  })

  it('rejects a timeout beyond the one-hour maximum', () => {
    expect(validateTask(task({ timeout: 4000 })))
      .toContain('timeout must not exceed 3600 seconds')
  })
})

describe('collecting completed tasks', () => {
  it('requests the group and returns the tasks', async () => {
    const { fetcher, calls } = fakeFetch(() => ({
      body: [{ id: 'task_1', status: 'success', results: { orderRef: 'C0008N401L' } }],
    }))
    const client = new AycdClient({ apiKey: 'K', fetcher, group: 'resell-ops' })

    const tasks = await client.completedTasks()

    expect(calls[0]!.url).toContain('/tasks/completed?group=resell-ops')
    expect(tasks[0]!.results!.orderRef).toBe('C0008N401L')
  })

  it('accepts a wrapped array as well as a bare one', async () => {
    const { fetcher } = fakeFetch(() => ({ body: { tasks: [{ id: 't', status: 'timeout' }] } }))
    const tasks = await new AycdClient({ apiKey: 'K', fetcher }).completedTasks()
    expect(tasks).toHaveLength(1)
  })

  it('returns an empty list for an unexpected shape rather than throwing', async () => {
    const { fetcher } = fakeFetch(() => ({ body: { unexpected: true } }))
    await expect(new AycdClient({ apiKey: 'K', fetcher }).completedTasks()).resolves.toEqual([])
  })

  it('surfaces the rate limit as a distinct, actionable error', async () => {
    const { fetcher } = fakeFetch(() => ({ ok: false, status: 429 }))
    await expect(new AycdClient({ apiKey: 'K', fetcher }).completedTasks())
      .rejects.toThrow(/rate limit/i)
  })

  it('carries the HTTP status on the error', async () => {
    const { fetcher } = fakeFetch(() => ({ ok: false, status: 429 }))
    await new AycdClient({ apiKey: 'K', fetcher }).completedTasks().catch((error) => {
      expect(error).toBeInstanceOf(AycdError)
      expect((error as AycdError).status).toBe(429)
    })
  })
})

describe('result handling', () => {
  it('splits a multi-match result into its values', () => {
    expect(splitResultValues('a\nb\nc')).toEqual(['a', 'b', 'c'])
  })

  it('ignores blank lines in a multi-match result', () => {
    expect(splitResultValues('a\n\n  \nb')).toEqual(['a', 'b'])
  })

  it('treats a single value as a one-element list', () => {
    expect(splitResultValues('C0008N401L')).toEqual(['C0008N401L'])
  })
})

describe('polling cadence', () => {
  it('polls every three seconds normally', () => {
    expect(nextPollDelayMs(0)).toBe(3000)
    expect(nextPollDelayMs(99)).toBe(3000)
  })

  it('speeds up when a full page comes back, since a backlog is waiting', () => {
    expect(nextPollDelayMs(100)).toBe(1000)
  })
})

describe('error explanations', () => {
  it('describes a 400 as a rejected task and keeps the server detail', () => {
    expect(explainStatus(400, 'bad filter')).toMatch(/rejected the task as invalid.*bad filter/i)
  })

  it('passes an unfamiliar status through with its body', () => {
    expect(explainStatus(503, 'maintenance')).toBe('AYCD Inbox returned 503. maintenance')
  })
})
