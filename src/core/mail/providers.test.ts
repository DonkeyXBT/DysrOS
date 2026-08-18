import { describe, it, expect } from 'vitest'
import { PROVIDERS, presetFor, providerIds, presetForEmail } from './providers.js'

describe('provider presets', () => {
  it('covers every provider the user asked for', () => {
    expect(providerIds()).toEqual(
      expect.arrayContaining(['gmail', 'outlook', 'yahoo', 'webde', 'icloud', 'namecheap', 'custom']),
    )
  })

  it('uses implicit TLS on port 993 everywhere', () => {
    for (const preset of PROVIDERS) {
      if (preset.id === 'custom') continue
      expect(preset.port).toBe(993)
      expect(preset.useTls).toBe(true)
    }
  })

  it('gives Namecheap Private Email its shared hostname', () => {
    const preset = presetFor('namecheap')
    expect(preset.host).toBe('mail.privateemail.com')
  })

  it('gives web.de its hostname', () => {
    expect(presetFor('webde').host).toBe('imap.web.de')
  })

  it('flags the providers that reject an account password', () => {
    expect(presetFor('gmail').requiresAppPassword).toBe(true)
    expect(presetFor('yahoo').requiresAppPassword).toBe(true)
    expect(presetFor('icloud').requiresAppPassword).toBe(true)
    expect(presetFor('namecheap').requiresAppPassword).toBe(false)
  })

  it('carries setup guidance for providers that need it', () => {
    expect(presetFor('webde').setupNote).toMatch(/imap/i)
    expect(presetFor('gmail').setupNote).toMatch(/app password/i)
  })

  it('leaves the custom preset blank for the user to fill in', () => {
    const preset = presetFor('custom')
    expect(preset.host).toBe('')
    expect(preset.requiresAppPassword).toBe(false)
  })

  it('throws on an unknown provider rather than silently guessing', () => {
    expect(() => presetFor('hotmail-1997')).toThrow(/unknown provider/i)
  })
})

describe('presetForEmail', () => {
  it('suggests a provider from the address domain', () => {
    expect(presetForEmail('reseller@gmail.com')?.id).toBe('gmail')
    expect(presetForEmail('reseller@web.de')?.id).toBe('webde')
    expect(presetForEmail('reseller@yahoo.com')?.id).toBe('yahoo')
    expect(presetForEmail('reseller@icloud.com')?.id).toBe('icloud')
  })

  it('recognises the alternate domains of a provider', () => {
    expect(presetForEmail('reseller@googlemail.com')?.id).toBe('gmail')
    expect(presetForEmail('reseller@hotmail.com')?.id).toBe('outlook')
    expect(presetForEmail('reseller@live.nl')?.id).toBe('outlook')
    expect(presetForEmail('reseller@me.com')?.id).toBe('icloud')
  })

  it('is case and whitespace insensitive', () => {
    expect(presetForEmail('  Reseller@GMAIL.com ')?.id).toBe('gmail')
  })

  it('returns null for a custom domain, since its host cannot be inferred', () => {
    expect(presetForEmail('me@my-sneaker-store.nl')).toBeNull()
  })

  it('returns null for a malformed address', () => {
    expect(presetForEmail('not-an-address')).toBeNull()
  })
})
