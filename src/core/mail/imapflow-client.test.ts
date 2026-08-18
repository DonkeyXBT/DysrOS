import { describe, it, expect } from 'vitest'
import { explainConnectionError } from './imapflow-client.js'

describe('explainConnectionError', () => {
  it('names the app-password cause for a rejected login', () => {
    expect(explainConnectionError(new Error('AUTHENTICATIONFAILED [ALERT] Invalid credentials')))
      .toMatch(/app-specific password/i)
  })

  it('explains an unknown host as a wrong server name', () => {
    expect(explainConnectionError(new Error('getaddrinfo ENOTFOUND imap.exmaple.com')))
      .toMatch(/server name could not be found/i)
  })

  it('points at the port when the connection is refused', () => {
    expect(explainConnectionError(new Error('connect ECONNREFUSED 1.2.3.4:143')))
      .toMatch(/993/)
  })

  it('explains a timeout as firewall or wrong host', () => {
    expect(explainConnectionError(new Error('Socket timeout'))).toMatch(/did not respond in time/i)
  })

  it('explains a certificate failure', () => {
    expect(explainConnectionError(new Error('self signed certificate in chain')))
      .toMatch(/certificate/i)
  })

  it('passes an unrecognised error through rather than inventing a cause', () => {
    expect(explainConnectionError(new Error('Some novel server complaint')))
      .toBe('Some novel server complaint')
  })

  it('handles a non-Error being thrown', () => {
    expect(explainConnectionError('plain string failure')).toBe('plain string failure')
  })
})
