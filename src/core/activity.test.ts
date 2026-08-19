import { describe, expect, it, vi } from 'vitest'
import { ActivityHub, HISTORY_LIMIT } from './activity.js'

function clock() {
  let tick = 0
  return () => `2026-08-19T10:00:${String(tick++).padStart(2, '0')}.000Z`
}

describe('ActivityHub', () => {
  it('lists work that is running, with the step it reached', () => {
    const hub = new ActivityHub(clock())
    hub.start('sync', 'Syncing mail')
    hub.step('sync', 'reading message 12 of 40', 12, 40)

    expect(hub.list()).toEqual([
      expect.objectContaining({
        id: 'sync', label: 'Syncing mail', step: 'reading message 12 of 40',
        state: 'running', done: 12, total: 40,
      }),
    ])
  })

  it('keeps running work above what has finished', () => {
    const hub = new ActivityHub(clock())
    hub.start('sync', 'Syncing mail')
    hub.start('tracking', 'Getting tracking codes')
    hub.finish('sync', 'read 40 messages')

    expect(hub.list().map((entry) => entry.id)).toEqual(['tracking', 'sync'])
  })

  it('shows the most recently finished first', () => {
    const hub = new ActivityHub(clock())
    hub.start('a', 'A')
    hub.start('b', 'B')
    hub.finish('a', 'done')
    hub.finish('b', 'done')

    expect(hub.list().map((entry) => entry.id)).toEqual(['b', 'a'])
  })

  it('marks failure as failure rather than quietly as done', () => {
    const hub = new ActivityHub(clock())
    hub.start('redirect', 'Redirecting parcels')
    hub.finish('redirect', 'DHL refused', false)

    expect(hub.list()[0]).toMatchObject({ state: 'failed', step: 'DHL refused' })
  })

  it('records a step for work nobody announced the start of', () => {
    const hub = new ActivityHub(clock())
    hub.step('images', 'fetching a picture')

    expect(hub.list()[0]).toMatchObject({ id: 'images', state: 'running' })
  })

  it('lets work run again after it finished, without duplicating it', () => {
    const hub = new ActivityHub(clock())
    hub.start('sync', 'Syncing mail')
    hub.finish('sync', 'done')
    hub.start('sync', 'Syncing mail')

    expect(hub.list()).toHaveLength(1)
    expect(hub.list()[0]!.state).toBe('running')
  })

  it('keeps a bounded history rather than growing forever', () => {
    const hub = new ActivityHub(clock())
    for (let index = 0; index < HISTORY_LIMIT + 8; index += 1) {
      hub.start(`job-${index}`, 'Work')
      hub.finish(`job-${index}`, 'done')
    }

    expect(hub.list()).toHaveLength(HISTORY_LIMIT)
    // The oldest went, the newest stayed.
    expect(hub.list()[0]!.id).toBe(`job-${HISTORY_LIMIT + 7}`)
  })

  it('never drops running work to make room', () => {
    const hub = new ActivityHub(clock())
    hub.start('long', 'A long job')
    for (let index = 0; index < HISTORY_LIMIT + 5; index += 1) {
      hub.start(`job-${index}`, 'Work')
      hub.finish(`job-${index}`, 'done')
    }

    expect(hub.list().some((entry) => entry.id === 'long')).toBe(true)
  })

  it('tells subscribers on every change, and stops when unsubscribed', () => {
    const hub = new ActivityHub(clock())
    const seen = vi.fn()
    const stop = hub.subscribe(seen)

    hub.start('sync', 'Syncing mail')
    hub.step('sync', 'reading')
    hub.finish('sync', 'done')
    expect(seen).toHaveBeenCalledTimes(3)

    stop()
    hub.start('another', 'Work')
    expect(seen).toHaveBeenCalledTimes(3)
  })
})
