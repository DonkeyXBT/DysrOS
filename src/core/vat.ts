import { type Money, money, roundHalfAwayFromZero } from './money.js'

export interface VatBreakdown {
  net: Money
  vat: Money
  gross: Money
  rateBasisPoints: number
}

function assertRate(rateBasisPoints: number): void {
  if (!Number.isInteger(rateBasisPoints)) {
    throw new Error(`VAT rate must be expressed in basis points, received ${rateBasisPoints}`)
  }
  if (rateBasisPoints < 0) {
    throw new Error(`VAT rate must not be negative, received ${rateBasisPoints}`)
  }
}

export function vatFromNet(net: Money, rateBasisPoints: number): VatBreakdown {
  assertRate(rateBasisPoints)
  const vatMinor = roundHalfAwayFromZero((net.minor * rateBasisPoints) / 10000)
  return {
    net,
    vat: money(vatMinor, net.currency),
    gross: money(net.minor + vatMinor, net.currency),
    rateBasisPoints,
  }
}

export function vatFromGross(gross: Money, rateBasisPoints: number): VatBreakdown {
  assertRate(rateBasisPoints)
  const vatMinor = roundHalfAwayFromZero(
    (gross.minor * rateBasisPoints) / (10000 + rateBasisPoints),
  )
  // Net is derived by subtraction rather than its own rounded division, which is
  // what guarantees net + vat === gross exactly.
  return {
    net: money(gross.minor - vatMinor, gross.currency),
    vat: money(vatMinor, gross.currency),
    gross,
    rateBasisPoints,
  }
}
