/**
 * Client for the AYCD Inbox Tasks API.
 *
 * Inbox works differently from IMAP, and the difference shapes everything here.
 * It is **forward-looking**: you register a task saying "an email will arrive at
 * this address after this moment, matching these filters — extract these
 * fields", and Inbox waits for it. It cannot read history, and it returns only
 * the fields the task asked for rather than the message itself.
 *
 * Two consequences worth knowing:
 *
 * - There is no `.eml` to retain, so mail captured this way cannot be re-parsed
 *   later the way IMAP-fetched mail can. Extraction rules live in the task.
 * - A task expires (an hour at most), so continuous capture means keeping tasks
 *   rolling rather than registering one and forgetting it.
 *
 * It therefore complements IMAP for catching mail as it lands; it does not
 * replace it for building a back catalogue.
 */

export const AYCD_BASE_URL = 'https://inbox-api.aycd.io/api/v1'

/** Documented limits. Exceeding them is a 400, so they are checked locally. */
export const AYCD_LIMITS = {
  maxFieldLength: 1024,
  maxFilters: 10,
  maxElements: 10,
  maxOrValues: 10,
  maxTimeoutSeconds: 3600,
  /** The vendor's own recommendation, rather than the maximum. */
  recommendedTimeoutSeconds: 600,
} as const

export type FilterTarget = 'subject' | 'from'
export type FilterComparator = 'includes' | 'excludes' | 'matches'
export type ElementTarget = 'subject' | 'body' | 'from'
export type ElementFormatter = 'text' | 'html' | 'link' | 'numeric'
export type RegexSource = 'pretty' | 'raw'

export interface MailFilter {
  target: FilterTarget
  comparator: FilterComparator
  value: string
  orValues?: string[]
  optional?: boolean
}

export interface MailElement {
  name: string
  target: ElementTarget
  selector?: string
  regex?: string
  regexSource?: RegexSource
  formatter?: ElementFormatter
}

export interface MailTask {
  email: string
  /** Epoch **seconds**, not milliseconds. */
  receivedAt: number
  mailFilters: MailFilter[]
  mailElements: MailElement[]
  templateId?: string
  group?: string
  timeout?: number
}

export interface CompletedTask {
  id: string
  status: 'success' | 'error' | 'timeout'
  results?: Record<string, string>
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export interface AycdClientOptions {
  apiKey: string
  fetcher?: FetchLike
  baseUrl?: string
  group?: string
}

export class AycdError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'AycdError'
  }
}

/** Values arrive newline-separated when a selector matched more than once. */
export function splitResultValues(value: string): string[] {
  return value.split('\n').map((part) => part.trim()).filter((part) => part.length > 0)
}

export function validateTask(task: MailTask): string[] {
  const problems: string[] = []

  if (!task.email.trim()) problems.push('email is required')
  if (!Number.isInteger(task.receivedAt) || task.receivedAt <= 0) {
    problems.push('receivedAt must be a positive integer in epoch seconds')
  }
  // A millisecond timestamp is the easy mistake, and it silently means "never".
  if (task.receivedAt > 100_000_000_000) {
    problems.push('receivedAt looks like milliseconds; it must be epoch seconds')
  }
  if (task.mailFilters.length === 0) problems.push('at least one mail filter is required')
  if (task.mailFilters.length > AYCD_LIMITS.maxFilters) {
    problems.push(`at most ${AYCD_LIMITS.maxFilters} mail filters are allowed`)
  }
  if (task.mailElements.length === 0) problems.push('at least one mail element is required')
  if (task.mailElements.length > AYCD_LIMITS.maxElements) {
    problems.push(`at most ${AYCD_LIMITS.maxElements} mail elements are allowed`)
  }
  if (task.timeout !== undefined && task.timeout > AYCD_LIMITS.maxTimeoutSeconds) {
    problems.push(`timeout must not exceed ${AYCD_LIMITS.maxTimeoutSeconds} seconds`)
  }

  for (const filter of task.mailFilters) {
    if (filter.value.length > AYCD_LIMITS.maxFieldLength) {
      problems.push(`filter value for "${filter.target}" exceeds ${AYCD_LIMITS.maxFieldLength} characters`)
    }
    if (filter.orValues && filter.orValues.length > AYCD_LIMITS.maxOrValues) {
      problems.push(`at most ${AYCD_LIMITS.maxOrValues} orValues are allowed`)
    }
  }

  for (const element of task.mailElements) {
    if (element.target === 'body' && !element.selector) {
      problems.push(`element "${element.name}" targets the body, which requires a selector`)
    }
  }

  return problems
}

export class AycdClient {
  private readonly fetcher: FetchLike
  private readonly baseUrl: string
  readonly group: string

  constructor(private readonly options: AycdClientOptions) {
    this.fetcher = options.fetcher ?? (globalThis.fetch as unknown as FetchLike)
    this.baseUrl = options.baseUrl ?? AYCD_BASE_URL
    this.group = options.group ?? 'resell-ops'
  }

  private headers(): Record<string, string> {
    return {
      'Authorization': `Token ${this.options.apiKey}`,
      'Content-Type': 'application/json',
    }
  }

  private async request(path: string, init: { method: string; body?: unknown }): Promise<unknown> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      method: init.method,
      headers: this.headers(),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })

    const text = await response.text()
    if (!response.ok) {
      throw new AycdError(explainStatus(response.status, text), response.status)
    }
    return text.length > 0 ? (JSON.parse(text) as unknown) : null
  }

  /** Confirms the key works and that the Inbox desktop application is running. */
  async verify(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.request('/user/verify', { method: 'GET' })
      return { ok: true, message: 'Connected to AYCD Inbox.' }
    } catch (error) {
      const message = error instanceof AycdError ? error.message : String(error)
      return { ok: false, message }
    }
  }

  async createTask(task: MailTask): Promise<{ id: string }> {
    const problems = validateTask(task)
    if (problems.length > 0) {
      throw new AycdError(`Invalid mail task: ${problems.join('; ')}`, 0)
    }

    const payload = {
      timeout: AYCD_LIMITS.recommendedTimeoutSeconds,
      group: this.group,
      ...task,
    }
    const body = (await this.request('/tasks/mail/create', { method: 'POST', body: payload })) as
      | { id?: string }
      | null

    if (!body?.id) throw new AycdError('Inbox did not return a task id.', 0)
    return { id: body.id }
  }

  /** Completed tasks for this group. Inbox drops each one ten minutes after
   *  completion, so a task not collected in time is simply gone. */
  async completedTasks(): Promise<CompletedTask[]> {
    const body = await this.request(
      `/tasks/completed?group=${encodeURIComponent(this.group)}`,
      { method: 'GET' },
    )
    if (Array.isArray(body)) return body as CompletedTask[]
    if (body && typeof body === 'object' && Array.isArray((body as { tasks?: unknown }).tasks)) {
      return (body as { tasks: CompletedTask[] }).tasks
    }
    return []
  }
}

/**
 * Poll interval, following the vendor client: three seconds normally, one when
 * a full page comes back, because a backlog means more is waiting.
 */
export function nextPollDelayMs(completedCount: number): number {
  return completedCount >= 100 ? 1000 : 3000
}

export function explainStatus(status: number, body: string): string {
  if (status === 401) {
    return 'AYCD Inbox rejected the API key. The Inbox desktop application must be running, and the key comes from its Settings > Tasks (API) screen.'
  }
  if (status === 429) {
    return 'AYCD Inbox rate limit reached (5000 requests per minute). This is a hard limit; slow the polling down.'
  }
  if (status === 400) {
    return `AYCD Inbox rejected the task as invalid. ${body}`.trim()
  }
  return `AYCD Inbox returned ${status}. ${body}`.trim()
}
