import { describe, expect, it } from 'vitest'
import { carrierTrackingUrl, dhlInterventionUrl, normalisePostcode } from './carrier-url.js'

describe('normalisePostcode', () => {
  it('drops the space and shouts it, as the carriers want it', () => {
    expect(normalisePostcode('3043 lc')).toBe('3043LC')
    expect(normalisePostcode('3043LC')).toBe('3043LC')
  })

  it('refuses anything that is not a Dutch postcode', () => {
    expect(normalisePostcode('0431AB')).toBeNull()
    expect(normalisePostcode('SW1A 1AA')).toBeNull()
    expect(normalisePostcode(null)).toBeNull()
  })
})

describe('carrierTrackingUrl', () => {
  it('builds the PostNL page from barcode and postcode', () => {
    expect(carrierTrackingUrl('postnl', '3STUNM283054292', '3043 LC'))
      .toBe('https://jouw.postnl.nl/track-and-trace/3STUNM283054292-NL-3043LC')
  })

  it('does not repeat a suffix the barcode already carries', () => {
    expect(carrierTrackingUrl('postnl', '3STUNM283054292-NL-3043LC', '3043LC'))
      .toBe('https://jouw.postnl.nl/track-and-trace/3STUNM283054292-NL-3043LC')
  })

  it('still opens the page when the postcode is unknown', () => {
    expect(carrierTrackingUrl('postnl', '3STUNM283054292', null))
      .toBe('https://jouw.postnl.nl/track-and-trace/3STUNM283054292')
  })

  it('builds the DHL page the redirect tool also uses', () => {
    expect(carrierTrackingUrl('dhl', 'JVGL0627463317265600', '3071NE'))
      .toBe('https://my.dhlecommerce.nl/home/tracktrace/JVGL0627463317265600/3071NE')
  })

  it('builds a UPS page, which needs no postcode', () => {
    expect(carrierTrackingUrl('ups', '1Z999AA10123456784', null))
      .toBe('https://www.ups.com/track?loc=nl_NL&tracknum=1Z999AA10123456784')
  })

  it('invents nothing for a carrier it does not know', () => {
    expect(carrierTrackingUrl('budbee', '1234567890', '3043LC')).toBeNull()
    expect(carrierTrackingUrl(null, '1234567890', '3043LC')).toBeNull()
  })

  it('needs a barcode that looks like one', () => {
    expect(carrierTrackingUrl('postnl', null, '3043LC')).toBeNull()
    expect(carrierTrackingUrl('postnl', 'not a code', '3043LC')).toBeNull()
  })

  it('ignores a postcode that is not one rather than putting it in the URL', () => {
    expect(carrierTrackingUrl('dhl', 'JVGL0627463317265600', 'unknown'))
      .toBe('https://my.dhlecommerce.nl/home/tracktrace/JVGL0627463317265600')
  })
})

describe('dhlInterventionUrl', () => {
  it('is the tracking page plus the interventions step', () => {
    expect(dhlInterventionUrl('JVGL0627463317265600', '3071 NE'))
      .toBe('https://my.dhlecommerce.nl/home/tracktrace/JVGL0627463317265600/3071NE/interventions')
  })

  it('is null without a postcode, because DHL shows no options without one', () => {
    expect(dhlInterventionUrl('JVGL0627463317265600', null)).toBeNull()
    expect(dhlInterventionUrl('JVGL0627463317265600', 'nonsense')).toBeNull()
  })

  it('is null without a barcode', () => {
    expect(dhlInterventionUrl(null, '3071NE')).toBeNull()
  })
})
