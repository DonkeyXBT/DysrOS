/**
 * Finding the link in a bol.com mail that actually leads to a carrier.
 *
 * Ported from a working implementation, and the parts that matter are the ones
 * a naive "take the first link.bol.com URL" misses entirely:
 *
 * - A shipping mail contains several bol links. Most go to the account
 *   overview, an order page, or customer service, and following those lands on
 *   a login page rather than a carrier — so they are excluded outright.
 * - Quoted-printable encoding breaks a long href across lines and can drop the
 *   `=` out of `?notificationId=`, leaving a URL that resolves to nothing.
 * - The best candidate is not always first in the document, so candidates are
 *   ranked and several are tried.
 */

/** Links that lead somewhere other than a carrier, however promising they look. */
const EXCLUDED = [
  '/account/overzicht',
  'rnwy/account/overzicht',
  '/rnwy/account',
  '/mijnbol',
  '/mijn-bol',
  'mijn.bol.com',
  '/wsp/login',
  '/authorize',
  '/wl/authorize',
  'login.bol.com',
  '/account/login',
  '/mijnaccount',
  '/bestellingen/overzicht',
  '/klantenservice',
]

/** How many candidates are worth a network request before giving up. */
export const MAX_CANDIDATES = 5

export function isExcludedLink(href: string): boolean {
  const lower = href.trim().toLowerCase()
  if (!lower || lower.startsWith('mailto:')) return true
  return EXCLUDED.some((fragment) => lower.includes(fragment))
}

/**
 * Repairs a URL mangled by quoted-printable encoding.
 *
 * Soft line breaks (`=` at end of line) split long hrefs, and the `=` of
 * `?notificationId=` is itself an escape character — so the separator is
 * sometimes eaten, leaving `?notificationId57b7…`.
 */
export function repairHref(raw: string): string {
  let href = raw
    .replace(/=\r?\n/g, '')
    .replace(/&amp;/gi, '&')
    .trim()

  href = href.replace(
    /([?&])notificationId(?!=)(?=[0-9a-fA-F][0-9a-fA-F-]{6,})/g,
    '$1notificationId=',
  )

  // Quoted-printable leaves =3D for '=' and =2E for '.' inside a URL.
  href = href.replace(/=3D/gi, '=').replace(/=2E/gi, '.')
  return href
}

/** Higher scores are tried first. */
function score(href: string): number {
  const lower = href.toLowerCase()
  if (/https?:\/\/link\.bol\.com\/t\//.test(lower)) return 100
  if (/track|trace|zending|volg/.test(lower)) return 60
  if (/link\.bol\.com/.test(lower)) return 40
  return 10
}

/**
 * Every bol.com link in the mail that could lead to a carrier, best first and
 * de-duplicated. Anything on the exclusion list never appears.
 */
export function collectTrackingCandidates(html: string): string[] {
  const found = new Map<string, string>()

  const add = (raw: string): void => {
    const href = repairHref(raw)
    if (!/bol\.(?:com|nl)/i.test(href)) return
    if (!/^https?:\/\//i.test(href)) return
    if (isExcludedLink(href)) return
    const key = href.toLowerCase()
    if (!found.has(key)) found.set(key, href)
  }

  for (const match of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    add(match[1]!)
  }
  // Also catch links that survive only as bare text, which happens when the
  // anchor itself was mangled.
  for (const match of html.matchAll(/https?:\/\/link\.bol\.com\/t\/[^\s"'<>)\]]+/gi)) {
    add(match[0])
  }

  return [...found.values()]
    .sort((a, b) => score(b) - score(a))
    .slice(0, MAX_CANDIDATES)
}
