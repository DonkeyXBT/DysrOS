import { randomUUID } from 'node:crypto'
import type { Db } from '../db/connection.js'

/**
 * Mail account storage.
 *
 * Passwords are never stored in plaintext and never leave this process. The
 * cipher is injected rather than imported so the core stays free of Electron:
 * the application supplies a `safeStorage`-backed implementation (DPAPI on
 * Windows), and tests supply a fake.
 */
export interface Encryptor {
  encrypt(plaintext: string): string
  decrypt(ciphertext: string): string
}

export interface MailAccount {
  id: string
  label: string
  email: string
  provider: string
  host: string
  port: number
  useTls: boolean
  username: string
  enabled: boolean
  lastSyncAt: string | null
  lastError: string | null
}

export interface NewAccount {
  label: string
  email: string
  provider: string
  host: string
  port: number
  useTls: boolean
  username: string
  password: string
}

interface AccountRow {
  id: string
  label: string
  email: string
  provider: string
  host: string
  port: number
  use_tls: number
  username: string
  secret_cipher: string
  enabled: number
  last_sync_at: string | null
  last_error: string | null
}

function toAccount(row: AccountRow): MailAccount {
  return {
    id: row.id,
    label: row.label,
    email: row.email,
    provider: row.provider,
    host: row.host,
    port: row.port,
    useTls: row.use_tls === 1,
    username: row.username,
    enabled: row.enabled === 1,
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error,
  }
}

export class AccountRepo {
  constructor(
    private readonly db: Db,
    private readonly encryptor: Encryptor,
  ) {}

  list(): MailAccount[] {
    const rows = this.db
      .prepare("SELECT * FROM accounts WHERE id != 'local-import' ORDER BY label")
      .all() as AccountRow[]
    return rows.map(toAccount)
  }

  add(account: NewAccount, now: string): MailAccount {
    const id = randomUUID()
    this.db.prepare(
      `INSERT INTO accounts
         (id, label, email, provider, host, port, use_tls, username, secret_cipher, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      account.label.trim() || account.email,
      account.email.trim().toLowerCase(),
      account.provider,
      account.host.trim(),
      account.port,
      account.useTls ? 1 : 0,
      (account.username || account.email).trim(),
      this.encryptor.encrypt(account.password),
      now,
    )
    return this.get(id)!
  }

  get(id: string): MailAccount | null {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as
      | AccountRow
      | undefined
    return row ? toAccount(row) : null
  }

  /** The decrypted password. Kept off `MailAccount` so it is never returned to
   *  the renderer by accident — retrieving it has to be deliberate. */
  password(id: string): string | null {
    const row = this.db.prepare('SELECT secret_cipher FROM accounts WHERE id = ?').get(id) as
      | { secret_cipher: string }
      | undefined
    if (!row) return null
    try {
      return this.encryptor.decrypt(row.secret_cipher)
    } catch {
      return null
    }
  }

  updatePassword(id: string, password: string): void {
    this.db
      .prepare('UPDATE accounts SET secret_cipher = ? WHERE id = ?')
      .run(this.encryptor.encrypt(password), id)
  }

  setEnabled(id: string, enabled: boolean): void {
    this.db.prepare('UPDATE accounts SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
  }

  recordSyncSuccess(id: string, at: string): void {
    this.db
      .prepare('UPDATE accounts SET last_sync_at = ?, last_error = NULL WHERE id = ?')
      .run(at, id)
  }

  recordSyncFailure(id: string, error: string): void {
    this.db.prepare('UPDATE accounts SET last_error = ? WHERE id = ?').run(error, id)
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
  }
}
