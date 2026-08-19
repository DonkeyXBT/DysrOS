import { dhlInterventionUrl } from './carrier-url.js'

/**
 * Sending a DHL parcel to a ServicePoint, from inside the application.
 *
 * DHL offers no API for this: the only way is the page a person would use, so
 * this drives that page — accept the consent banner, choose the ServicePoint
 * option, take the nearest point, give an address for the confirmation, and
 * confirm. It is a port of the standalone redirect tool, which has run against
 * real parcels, and it drives the same URL, so the two agree on what a parcel
 * is.
 *
 * This changes where a real parcel goes. It never runs on its own: something
 * has to ask for it, one parcel or a chosen few, and a test run stops before
 * the last click so the whole path can be checked without committing to it.
 *
 * The page is reached through an injected driver rather than a browser this
 * module opens itself, which is what lets the sequence be tested without one.
 */

export const SERVICEPOINT_CARD = '[data-test="intervention-card-servicePointIntervention"]'
export const STORE_ROW = '.MuiAccordionSummary-content'
export const SELECT_BUTTON = '[data-test="select-button"]'
export const EMAIL_INPUT = '#emailAddress'
export const COOKIE_ACCEPT = '#onetrust-accept-btn-handler'

/** What the last button says, in either language the page uses. */
export const CONFIRM_WORDS = ['bevestig', 'doorgaan', 'confirm', 'verstuur', 'opslaan']

export interface Page {
  goto(url: string): Promise<void>
  /** Runs a snippet in the page and resolves with its value. */
  evaluate<T>(script: string): Promise<T>
}

export interface RedirectTarget {
  trackingNumber: string | null
  postalCode: string | null
}

export interface ServicePoint {
  name: string | null
  distance: string | null
  address: string | null
}

export type RedirectOutcome =
  | { ok: true; dryRun: boolean; servicePoint: ServicePoint }
  | { ok: false; reason: 'not-addressable' | 'not-yet-changeable' | 'failed'; message: string }

export interface RedirectOptions {
  email: string | null
  dryRun?: boolean
  /** Overall budget for one parcel. */
  timeoutMs?: number
  /** Injected so tests do not wait in real time. */
  sleep?: (ms: number) => Promise<void>
  onStep?: (step: string) => void
}

const STEP_TIMEOUT_MS = 30_000
const POLL_MS = 400

/** Quotes a value for embedding in an injected snippet. */
function js(value: string): string {
  return JSON.stringify(value)
}

class StepTimeout extends Error {
  constructor(readonly what: string) {
    super(`timed out waiting for ${what}`)
  }
}

export async function redirectParcel(
  page: Page,
  target: RedirectTarget,
  options: RedirectOptions,
): Promise<RedirectOutcome> {
  const url = dhlInterventionUrl(target.trackingNumber, target.postalCode)
  if (!url) {
    return {
      ok: false,
      reason: 'not-addressable',
      message: 'This parcel needs both its barcode and the delivery postcode before DHL will show any options for it.',
    }
  }

  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadline = Date.now() + (options.timeoutMs ?? 120_000)
  const step = (name: string) => options.onStep?.(name)

  async function waitFor(script: string, what: string): Promise<void> {
    const until = Math.min(Date.now() + STEP_TIMEOUT_MS, deadline)
    for (;;) {
      if (await page.evaluate<boolean>(script)) return
      if (Date.now() >= until) throw new StepTimeout(what)
      await sleep(POLL_MS)
    }
  }

  try {
    step('opening the parcel page')
    await page.goto(url)

    // The consent overlay swallows every click until it is dismissed, and it
    // does not appear at all where consent was already given.
    step('consent banner')
    try {
      await waitFor(`!!document.querySelector(${js(COOKIE_ACCEPT)})`, 'consent banner')
      await page.evaluate(`(document.querySelector(${js(COOKIE_ACCEPT)}).click(), true)`)
    } catch {
      // Never shown; nothing to dismiss.
    }

    step('waiting for the ServicePoint option')
    await waitFor(`!!document.querySelector(${js(SERVICEPOINT_CARD)})`, 'ServicePoint option')

    const disabled = await page.evaluate<boolean>(
      `document.querySelector(${js(SERVICEPOINT_CARD)}).getAttribute('aria-disabled') === 'true'`,
    )
    if (disabled) {
      return {
        ok: false,
        reason: 'not-yet-changeable',
        message: 'DHL is not offering a ServicePoint for this parcel yet. That usually opens up closer to delivery.',
      }
    }

    step('choosing ServicePoint delivery')
    await page.evaluate(`(document.querySelector(${js(SERVICEPOINT_CARD)}).click(), true)`)

    step('waiting for the nearest points')
    await waitFor(`!!document.querySelector(${js(STORE_ROW)})`, 'list of points')

    const servicePoint = await page.evaluate<ServicePoint>(READ_NEAREST_POINT)

    step('selecting the nearest point')
    await page.evaluate(`(document.querySelector(${js(STORE_ROW)}).click(), true)`)

    await waitFor(`!!document.querySelector(${js(SELECT_BUTTON)})`, 'confirmation of that point')
    await page.evaluate(`(document.querySelector(${js(SELECT_BUTTON)}).click(), true)`)

    if (options.email) {
      step('filling in the notification address')
      await waitFor(`!!document.querySelector(${js(EMAIL_INPUT)})`, 'address field')
      await page.evaluate(fillEmail(options.email))
    }

    step('waiting for the confirm button')
    await waitFor(`!!${CONFIRM_BUTTON}`, 'confirm button')

    if (options.dryRun) {
      step('test run — stopping before confirming')
      return { ok: true, dryRun: true, servicePoint }
    }

    step('confirming')
    await page.evaluate(`(${CONFIRM_BUTTON}.click(), true)`)
    await sleep(1500)

    return { ok: true, dryRun: false, servicePoint }
  } catch (error) {
    if (error instanceof StepTimeout) {
      return {
        ok: false,
        reason: 'not-yet-changeable',
        message: `DHL's page never got as far as the ${error.what}, so nothing was changed.`,
      }
    }
    return {
      ok: false,
      reason: 'failed',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/** The first row is the nearest point: its name, distance and address. */
const READ_NEAREST_POINT = `(() => {
  const row = document.querySelector(${JSON.stringify(STORE_ROW)})
  if (!row) return { name: null, distance: null, address: null }
  const text = (selector) => {
    const el = row.querySelector(selector)
    return el && el.innerText ? el.innerText.trim() : null
  }
  const street = text('[data-test="street"]')
  const number = text('[data-test="houseNumber"]')
  const postcode = text('[data-test="postalCode"]')
  const city = text('[data-test="city"]')
  const line = [
    [street, number].filter(Boolean).join(' '),
    [postcode, city].filter(Boolean).join(' '),
  ].filter(Boolean).join(', ')
  return { name: text('h6'), distance: text('.mui-1y8y1b2'), address: line || null }
})()`

/** The last button, found by what it says rather than by a class name. */
const CONFIRM_BUTTON = `([...document.querySelectorAll('button')].find((b) => ${JSON.stringify(CONFIRM_WORDS)}
  .some((word) => (b.innerText || '').toLowerCase().includes(word))))`

/**
 * Fills the address field the way a person would.
 *
 * The page is React, which ignores a value assigned straight to the element:
 * the native setter followed by an input event is what it listens to.
 */
function fillEmail(email: string): string {
  return `(() => {
    const input = document.querySelector(${js(EMAIL_INPUT)})
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, ${js(email)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    input.dispatchEvent(new Event('blur', { bubbles: true }))
    return true
  })()`
}
