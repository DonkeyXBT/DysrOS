/**
 * What the application is doing right now.
 *
 * Work happens on its own — mail is fetched, barcodes are followed, parcels are
 * redirected, pictures are fetched — and until now the only sign of it was a
 * pill in the corner that said "Syncing" and nothing else. This keeps one list
 * of everything running, with the step each one has reached, so the question
 * "what is it doing?" has an answer.
 *
 * Finished work stays briefly: a run that took two seconds is still worth
 * seeing afterwards, and a failure is worth seeing until it is read.
 */

export type ActivityState = 'running' | 'done' | 'failed'

export interface Activity {
  id: string
  /** What the work is, in the user's terms: "Syncing mail", "Redirecting". */
  label: string
  /** Where it has got to. */
  step: string
  state: ActivityState
  done: number | null
  total: number | null
  startedAt: string
  endedAt: string | null
}

/** How many finished entries are kept before the oldest is dropped. */
export const HISTORY_LIMIT = 12

export class ActivityHub {
  private readonly entries = new Map<string, Activity>()
  private readonly listeners = new Set<(activities: Activity[]) => void>()

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  subscribe(listener: (activities: Activity[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Everything running, then what recently finished, newest first. */
  list(): Activity[] {
    const all = [...this.entries.values()]
    const running = all.filter((entry) => entry.state === 'running')
    const finished = all
      .filter((entry) => entry.state !== 'running')
      .sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''))
    return [...running, ...finished]
  }

  start(id: string, label: string, step = 'starting'): void {
    this.entries.set(id, {
      id,
      label,
      step,
      state: 'running',
      done: null,
      total: null,
      startedAt: this.now(),
      endedAt: null,
    })
    this.prune()
    this.emit()
  }

  /**
   * Reports where a piece of work has got to.
   *
   * Silently starts the entry if it was never started: a step is a fact about
   * work that is happening, and dropping it because of bookkeeping would be
   * the wrong way round.
   */
  step(id: string, step: string, done: number | null = null, total: number | null = null): void {
    const entry = this.entries.get(id)
    if (!entry) {
      this.start(id, step)
      return
    }
    entry.step = step
    entry.done = done
    entry.total = total
    entry.state = 'running'
    entry.endedAt = null
    this.emit()
  }

  finish(id: string, step: string, ok = true): void {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.step = step
    entry.state = ok ? 'done' : 'failed'
    entry.endedAt = this.now()
    entry.done = null
    entry.total = null
    this.prune()
    this.emit()
  }

  /** Drops the oldest finished entries once there are too many to be useful. */
  private prune(): void {
    const finished = [...this.entries.values()]
      .filter((entry) => entry.state !== 'running')
      .sort((a, b) => (a.endedAt ?? '').localeCompare(b.endedAt ?? ''))

    for (const entry of finished.slice(0, Math.max(0, finished.length - HISTORY_LIMIT))) {
      this.entries.delete(entry.id)
    }
  }

  private emit(): void {
    const snapshot = this.list()
    for (const listener of this.listeners) listener(snapshot)
  }
}
