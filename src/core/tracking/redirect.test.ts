import { describe, expect, it } from 'vitest'
import {
  COOKIE_ACCEPT, EMAIL_INPUT, SELECT_BUTTON, SERVICEPOINT_CARD, STORE_ROW,
  redirectParcel, type Page,
} from './redirect.js'

/**
 * A stand-in for DHL's page.
 *
 * It answers the presence checks the driver makes and records what was
 * clicked, which is what the sequence has to get right: the consent banner
 * before anything else, the ServicePoint option before the list of points, and
 * the confirm button last of all.
 */
function fakePage(options: {
  present?: string[]
  disabled?: boolean
  appearsAfter?: Record<string, number>
} = {}) {
  const clicks: string[] = []
  const visited: string[] = []
  let evaluations = 0
  const present = new Set(options.present ?? [
    COOKIE_ACCEPT, SERVICEPOINT_CARD, STORE_ROW, SELECT_BUTTON, EMAIL_INPUT, 'confirm',
  ])

  const page: Page = {
    async goto(url) {
      visited.push(url)
    },
    async evaluate<T>(script: string): Promise<T> {
      evaluations += 1

      const has = (selector: string) => {
        if (!present.has(selector)) return false
        const after = options.appearsAfter?.[selector]
        return after === undefined || evaluations >= after
      }

      for (const selector of [COOKIE_ACCEPT, SERVICEPOINT_CARD, STORE_ROW, SELECT_BUTTON, EMAIL_INPUT]) {
        if (script.includes(JSON.stringify(selector))) {
          if (script.includes('.click()')) {
            clicks.push(selector)
            return true as T
          }
          if (script.includes('aria-disabled')) return Boolean(options.disabled) as T
          if (script.includes('setter.call')) {
            clicks.push('email-filled')
            return true as T
          }
          if (script.includes('innerText')) {
            return { name: 'Primera Rotterdam', distance: '400 m', address: 'Kruisplein 1, 3012CC Rotterdam' } as T
          }
          return has(selector) as T
        }
      }

      if (script.includes('querySelectorAll')) {
        if (script.includes('.click()')) {
          clicks.push('confirm')
          return true as T
        }
        return has('confirm') as T
      }

      return false as T
    },
  }

  return { page, clicks, visited }
}

const nothing = async () => {}

describe('redirecting a parcel to a ServicePoint', () => {
  it('refuses a parcel with no postcode rather than opening anything', async () => {
    const { page, visited } = fakePage()
    const result = await redirectParcel(
      page,
      { trackingNumber: 'JVGL0627463317265600', postalCode: null },
      { email: 'someone@example.com', sleep: nothing },
    )

    expect(result).toMatchObject({ ok: false, reason: 'not-addressable' })
    expect(visited).toEqual([])
  })

  it('refuses a parcel with no barcode', async () => {
    const { page, visited } = fakePage()
    const result = await redirectParcel(
      page,
      { trackingNumber: null, postalCode: '3071NE' },
      { email: null, sleep: nothing },
    )

    expect(result).toMatchObject({ ok: false, reason: 'not-addressable' })
    expect(visited).toEqual([])
  })

  it('drives the page in order and reports the point it chose', async () => {
    const { page, clicks, visited } = fakePage()
    const result = await redirectParcel(
      page,
      { trackingNumber: 'JVGL0627463317265600', postalCode: '3071 NE' },
      { email: 'someone@example.com', sleep: nothing },
    )

    expect(visited).toEqual([
      'https://my.dhlecommerce.nl/home/tracktrace/JVGL0627463317265600/3071NE/interventions',
    ])
    expect(clicks).toEqual([
      COOKIE_ACCEPT, SERVICEPOINT_CARD, STORE_ROW, SELECT_BUTTON, 'email-filled', 'confirm',
    ])
    expect(result).toMatchObject({
      ok: true,
      dryRun: false,
      servicePoint: { name: 'Primera Rotterdam', distance: '400 m' },
    })
  })

  it('stops before the last click on a test run', async () => {
    const { page, clicks } = fakePage()
    const result = await redirectParcel(
      page,
      { trackingNumber: 'JVGL0627463317265600', postalCode: '3071NE' },
      { email: 'someone@example.com', dryRun: true, sleep: nothing },
    )

    expect(result).toMatchObject({ ok: true, dryRun: true })
    expect(clicks).not.toContain('confirm')
  })

  it('carries on when no consent banner is shown', async () => {
    const { page, clicks } = fakePage({
      present: [SERVICEPOINT_CARD, STORE_ROW, SELECT_BUTTON, EMAIL_INPUT, 'confirm'],
    })
    const result = await redirectParcel(
      page,
      { trackingNumber: 'JVGL0627463317265600', postalCode: '3071NE' },
      { email: null, sleep: nothing, timeoutMs: 300 },
    )

    expect(result).toMatchObject({ ok: true })
    expect(clicks).not.toContain(COOKIE_ACCEPT)
  })

  it('leaves the parcel alone when DHL has the option switched off', async () => {
    const { page, clicks } = fakePage({ disabled: true })
    const result = await redirectParcel(
      page,
      { trackingNumber: 'JVGL0627463317265600', postalCode: '3071NE' },
      { email: null, sleep: nothing },
    )

    expect(result).toMatchObject({ ok: false, reason: 'not-yet-changeable' })
    expect(clicks).not.toContain(SERVICEPOINT_CARD)
  })

  it('says so plainly when the option never appears', async () => {
    const { page } = fakePage({ present: [COOKIE_ACCEPT] })
    const result = await redirectParcel(
      page,
      { trackingNumber: 'JVGL0627463317265600', postalCode: '3071NE' },
      { email: null, sleep: nothing, timeoutMs: 50 },
    )

    expect(result).toMatchObject({ ok: false, reason: 'not-yet-changeable' })
    expect((result as { message: string }).message).toContain('nothing was changed')
  })

  it('skips the address field when no address is configured', async () => {
    const { page, clicks } = fakePage()
    await redirectParcel(
      page,
      { trackingNumber: 'JVGL0627463317265600', postalCode: '3071NE' },
      { email: null, sleep: nothing },
    )

    expect(clicks).not.toContain('email-filled')
    expect(clicks).toContain('confirm')
  })

  it('reports a page that throws rather than pretending it worked', async () => {
    const page: Page = {
      goto: async () => { throw new Error('net::ERR_NAME_NOT_RESOLVED') },
      evaluate: async () => false as never,
    }
    const result = await redirectParcel(
      page,
      { trackingNumber: 'JVGL0627463317265600', postalCode: '3071NE' },
      { email: null, sleep: nothing },
    )

    expect(result).toMatchObject({ ok: false, reason: 'failed' })
  })
})
