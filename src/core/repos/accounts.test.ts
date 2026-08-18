import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type Db } from '../db/connection.js'
import { migrate } from '../db/migrations.js'
import { AccountRepo, type Encryptor, type NewAccount } from './accounts.js'

/** Stands in for Electron safeStorage: reversible, and obviously not plaintext. */
const reversibleFake: Encryptor = {
  encrypt: (plaintext) => `enc:${Buffer.from(plaintext, 'utf8').toString('base64')}`,
  decrypt: (ciphertext) => {
    if (!ciphertext.startsWith('enc:')) throw new Error('not encrypted by this cipher')
    return Buffer.from(ciphertext.slice(4), 'base64').toString('utf8')
  },
}

let db: Db
let accounts: AccountRepo

const NOW = '2026-08-19T10:00:00Z'

beforeEach(() => {
  db = openDatabase(':memory:')
  migrate(db)
  accounts = new AccountRepo(db, reversibleFake)
})

function sample(overrides: Partial<NewAccount> = {}): NewAccount {
  return {
    label: 'Main',
    email: 'reseller@gmail.com',
    provider: 'gmail',
    host: 'imap.gmail.com',
    port: 993,
    useTls: true,
    username: 'reseller@gmail.com',
    password: 'app-password-1234',
    ...overrides,
  }
}

describe('adding an account', () => {
  it('stores it and returns it without the password', () => {
    const account = accounts.add(sample(), NOW)

    expect(account.email).toBe('reseller@gmail.com')
    expect(account.host).toBe('imap.gmail.com')
    expect(account.enabled).toBe(true)
    expect(Object.keys(account)).not.toContain('password')
    expect(JSON.stringify(account)).not.toContain('app-password-1234')
  })

  it('never writes the password to the database in the clear', () => {
    accounts.add(sample(), NOW)
    const row = db.prepare('SELECT secret_cipher FROM accounts').get() as { secret_cipher: string }

    expect(row.secret_cipher).not.toContain('app-password-1234')
    expect(row.secret_cipher.startsWith('enc:')).toBe(true)
  })

  it('gives the password back only when asked for explicitly', () => {
    const account = accounts.add(sample(), NOW)
    expect(accounts.password(account.id)).toBe('app-password-1234')
  })

  it('normalises the address and falls back to it for a blank label', () => {
    const account = accounts.add(sample({ email: '  Reseller@GMAIL.com ', label: '' }), NOW)
    expect(account.email).toBe('reseller@gmail.com')
    expect(account.label).toBe('  Reseller@GMAIL.com ')
  })

  it('defaults the username to the address when none is given', () => {
    const account = accounts.add(sample({ username: '' }), NOW)
    expect(account.username).toBe('reseller@gmail.com')
  })
})

describe('listing accounts', () => {
  it('excludes the local import placeholder', () => {
    db.prepare(
      `INSERT INTO accounts (id, label, email, provider, host, port, username, secret_cipher, created_at)
       VALUES ('local-import', 'Imported files', 'local@import', 'custom', '', 0, '', '', ?)`,
    ).run(NOW)
    accounts.add(sample(), NOW)

    const listed = accounts.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]!.email).toBe('reseller@gmail.com')
  })

  it('returns an empty list before anything is connected', () => {
    expect(accounts.list()).toEqual([])
  })
})

describe('sync bookkeeping', () => {
  it('records a successful sync and clears any previous error', () => {
    const account = accounts.add(sample(), NOW)
    accounts.recordSyncFailure(account.id, 'auth rejected')
    accounts.recordSyncSuccess(account.id, '2026-08-19T11:00:00Z')

    const updated = accounts.get(account.id)!
    expect(updated.lastSyncAt).toBe('2026-08-19T11:00:00Z')
    expect(updated.lastError).toBeNull()
  })

  it('records a failure so the UI can say which account is broken', () => {
    const account = accounts.add(sample(), NOW)
    accounts.recordSyncFailure(account.id, 'AUTHENTICATIONFAILED')
    expect(accounts.get(account.id)!.lastError).toBe('AUTHENTICATIONFAILED')
  })
})

describe('password rotation and removal', () => {
  it('replaces a password without touching anything else', () => {
    const account = accounts.add(sample(), NOW)
    accounts.updatePassword(account.id, 'new-app-password')

    expect(accounts.password(account.id)).toBe('new-app-password')
    expect(accounts.get(account.id)!.email).toBe('reseller@gmail.com')
  })

  it('returns null rather than throwing when a secret cannot be decrypted', () => {
    const account = accounts.add(sample(), NOW)
    db.prepare('UPDATE accounts SET secret_cipher = ? WHERE id = ?').run('garbage', account.id)
    expect(accounts.password(account.id)).toBeNull()
  })

  it('removes an account and its folder cursors', () => {
    const account = accounts.add(sample(), NOW)
    db.prepare(
      'INSERT INTO folder_cursors (account_id, folder, uid_validity, last_uid) VALUES (?, ?, 1, 5)',
    ).run(account.id, 'INBOX')

    accounts.remove(account.id)

    expect(accounts.get(account.id)).toBeNull()
    expect(db.prepare('SELECT COUNT(*) AS n FROM folder_cursors').get()).toEqual({ n: 0 })
  })

  it('can be disabled without being deleted', () => {
    const account = accounts.add(sample(), NOW)
    accounts.setEnabled(account.id, false)
    expect(accounts.get(account.id)!.enabled).toBe(false)
  })
})
