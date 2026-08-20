/**
 * App passwords as they are actually copied.
 *
 * Google shows an app password as four groups of four — `abcd efgh ijkl mnop`
 * — and Apple shows one as `abcd-efgh-ijkl-mnop`. Both are presentation: the
 * password is the sixteen characters. People copy what they see, spaces and
 * all, and the server then rejects a password that is correct in every way
 * that matters. Fixing that is the application's job, not the user's.
 *
 * Only that exact shape is touched. A password that merely contains a space is
 * left alone, because for all this knows the space is part of it.
 */

/** Sixteen letters or digits, in four groups, separated by spaces or dashes. */
const GROUPED = /^[a-z0-9]{4}([ -])[a-z0-9]{4}\1[a-z0-9]{4}\1[a-z0-9]{4}$/i

/** Sixteen letters or digits with any whitespace scattered through them. */
const SIXTEEN = /^[a-z0-9\s]{16,31}$/i

export function normaliseAppPassword(password: string): string {
  const trimmed = password.trim()

  if (GROUPED.test(trimmed)) return trimmed.replace(/[ -]/g, '')

  // Whitespace-separated but not in neat groups — a copy that picked up a line
  // break, say. Still an app password if sixteen characters remain.
  if (SIXTEEN.test(trimmed) && /\s/.test(trimmed)) {
    const squeezed = trimmed.replace(/\s+/g, '')
    if (/^[a-z0-9]{16}$/i.test(squeezed)) return squeezed
  }

  return trimmed
}
