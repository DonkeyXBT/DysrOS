import { describe, expect, it } from 'vitest'
import { normaliseAppPassword } from './app-password.js'

describe('an app password as it is actually copied', () => {
  it('takes the spaces out of the way Google shows one', () => {
    expect(normaliseAppPassword('abcd efgh ijkl mnop')).toBe('abcdefghijklmnop')
  })

  it('takes the dashes out of the way Apple shows one', () => {
    expect(normaliseAppPassword('abcd-efgh-ijkl-mnop')).toBe('abcdefghijklmnop')
  })

  it('leaves one that was copied cleanly exactly as it is', () => {
    expect(normaliseAppPassword('abcdefghijklmnop')).toBe('abcdefghijklmnop')
  })

  it('trims what a copy picks up at the ends', () => {
    expect(normaliseAppPassword('  abcd efgh ijkl mnop \n')).toBe('abcdefghijklmnop')
  })

  it('handles a copy that picked up a line break in the middle', () => {
    expect(normaliseAppPassword('abcd efgh\nijkl mnop')).toBe('abcdefghijklmnop')
  })

  it('takes digits as readily as letters', () => {
    expect(normaliseAppPassword('a1b2 c3d4 e5f6 g7h8')).toBe('a1b2c3d4e5f6g7h8')
  })

  it('leaves a real password with a space in it alone', () => {
    // Nothing here says this is an app password, and a passphrase is allowed
    // to contain spaces.
    expect(normaliseAppPassword('correct horse battery staple'))
      .toBe('correct horse battery staple')
  })

  it('leaves a password that merely looks grouped but is not sixteen', () => {
    expect(normaliseAppPassword('abc def ghi')).toBe('abc def ghi')
    expect(normaliseAppPassword('abcde fghij klmno pqrst')).toBe('abcde fghij klmno pqrst')
  })

  it('leaves punctuation-bearing passwords alone', () => {
    expect(normaliseAppPassword('Tr0ub4dor &3')).toBe('Tr0ub4dor &3')
    expect(normaliseAppPassword('four-score-and-seven')).toBe('four-score-and-seven')
  })

  it('is empty for nothing at all', () => {
    expect(normaliseAppPassword('   ')).toBe('')
  })
})
