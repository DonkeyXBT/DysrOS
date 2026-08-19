/**
 * The carrier's own tracking page, built from what the mail already told us.
 *
 * Retailer mail links to a redirect that expires and often lands on a login
 * page. The carriers themselves take the barcode and the delivery postcode
 * straight in the URL, so once both are known the real page can be addressed
 * directly — and that page is the one with the delivery options on it.
 *
 * Without a postcode the same page still opens and asks for one, which is
 * better than nothing; a wrong guess would not be, so nothing is invented.
 */

/** A Dutch postcode as the carriers want it in a URL: `3043LC`, no space. */
export function normalisePostcode(postalCode: string | null): string | null {
  if (!postalCode) return null
  const compact = postalCode.replace(/\s+/g, '').toUpperCase()
  return /^[1-9][0-9]{3}[A-Z]{2}$/.test(compact) ? compact : null
}

/** PostNL barcodes carry the country and postcode in the URL, not the code. */
function bareCode(code: string): string {
  return code.replace(/-[A-Z]{2}-[A-Z0-9]+$/i, '').trim().toUpperCase()
}

export function carrierTrackingUrl(
  carrier: string | null,
  trackingNumber: string | null,
  postalCode: string | null,
): string | null {
  if (!trackingNumber) return null
  const code = bareCode(trackingNumber)
  if (!/^[A-Z0-9]{6,35}$/.test(code)) return null
  const postcode = normalisePostcode(postalCode)

  switch ((carrier ?? '').toLowerCase()) {
    case 'postnl':
      // jouw.postnl.nl/track-and-trace/3STUNM283054292-NL-3043LC
      return postcode
        ? `https://jouw.postnl.nl/track-and-trace/${code}-NL-${postcode}`
        : `https://jouw.postnl.nl/track-and-trace/${code}`
    case 'dhl':
      // The same address the redirect tool drives, so both agree on the parcel.
      return postcode
        ? `https://my.dhlecommerce.nl/home/tracktrace/${code}/${postcode}`
        : `https://my.dhlecommerce.nl/home/tracktrace/${code}`
    case 'ups':
      return `https://www.ups.com/track?loc=nl_NL&tracknum=${code}`
    default:
      // An unknown carrier gets no invented URL; the mail's own link stands.
      return null
  }
}
