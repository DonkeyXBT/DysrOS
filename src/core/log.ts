import { appendFileSync, mkdirSync, readFileSync, existsSync, statSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * A durable record of what went wrong.
 *
 * A crash during a sync leaves nothing behind by default: the window closes,
 * the console goes with it, and all anyone can report afterwards is "it
 * crashed". Every failure is therefore appended to a file on disk *as it
 * happens*, so it survives the process dying, and kept in memory so the
 * application can show it without reading the file back.
 *
 * Writes are synchronous and deliberately so — an asynchronous write scheduled
 * moments before the process exits is exactly the write that never lands.
 */

export type LogLevel = 'error' | 'warn' | 'info'

export interface LogEntry {
  at: string
  level: LogLevel
  source: string
  message: string
  detail: string | null
}

const MAX_IN_MEMORY = 500
const MAX_FILE_BYTES = 2_000_000

export class ErrorLog {
  private readonly entries: LogEntry[] = []

  constructor(private readonly filePath: string) {
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      this.rotateIfLarge()
    } catch {
      // Logging must never be the reason the application fails to start.
    }
  }

  record(level: LogLevel, source: string, error: unknown, context?: string): LogEntry {
    const message = error instanceof Error ? error.message : String(error)
    const stack = error instanceof Error ? error.stack ?? null : null
    const detail = [context, stack].filter(Boolean).join('\n') || null

    const entry: LogEntry = {
      at: new Date().toISOString(),
      level,
      source,
      message,
      detail,
    }

    this.entries.push(entry)
    if (this.entries.length > MAX_IN_MEMORY) this.entries.shift()

    try {
      appendFileSync(
        this.filePath,
        `${entry.at}  [${level.toUpperCase()}] ${source}: ${message}` +
        (detail ? `\n${detail.split('\n').map((l) => '    ' + l).join('\n')}` : '') +
        '\n',
        'utf8',
      )
    } catch {
      // A failed write must not mask the error being reported.
    }

    return entry
  }

  /** Newest first, because the most recent failure is the one being chased. */
  recent(limit = 100): LogEntry[] {
    return [...this.entries].reverse().slice(0, limit)
  }

  clear(): void {
    this.entries.length = 0
  }

  path(): string {
    return this.filePath
  }

  /** The raw file, for copying into a bug report. */
  tail(bytes = 200_000): string {
    try {
      if (!existsSync(this.filePath)) return ''
      const content = readFileSync(this.filePath, 'utf8')
      return content.length > bytes ? content.slice(content.length - bytes) : content
    } catch {
      return ''
    }
  }

  private rotateIfLarge(): void {
    if (!existsSync(this.filePath)) return
    if (statSync(this.filePath).size < MAX_FILE_BYTES) return
    // Keep exactly one previous file: enough to span a crash, bounded on disk.
    renameSync(this.filePath, this.filePath + '.1')
  }
}

export function defaultLogPath(userDataDir: string): string {
  return join(userDataDir, 'logs', 'resell-ops.log')
}
