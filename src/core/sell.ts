import { money, type Money } from './money.js'
import { vatFromGross, vatFromNet } from './vat.js'

/**
 * Selling units by hand, to a buyer who is not a marketplace.
 *
 * A private sale is a price and a name, not an order feed, so this takes what
 * a person actually knows — what they got, whether that figure already had VAT
 * in it, and who bought — and turns it into the same shape a marketplace sale
 * would have.
 *
 * Dutch VAT is 21%, and retailer mail states prices with VAT already in them,
 * so cost is treated as gross throughout. Profit is then net against net: VAT
 * collected on a sale is not income, it is money held for the tax office, and
 * VAT paid on a purchase comes back, so counting either as profit would
 * overstate every position.
 */

/** The Dutch standard rate, in basis points. */
export const NL_VAT_BASIS_POINTS = 2100

export interface SaleLineInput {
  itemId: string
  /** What the unit cost, as stated in the mail: VAT included. */
  costMinor: number
}

export interface SaleLine {
  itemId: string
  /** What this unit fetched, VAT included. */
  grossMinor: number
  /** VAT within that price, owed to the tax office. */
  vatMinor: number
  /** The part that is actually revenue. */
  netMinor: number
  /** VAT already paid on buying it, which comes back. */
  costVatMinor: number
  costNetMinor: number
  /** Net revenue less net cost: the figure that is really earned. */
  profitMinor: number
}

export interface SaleInput {
  lines: SaleLineInput[]
  /** The figure the user typed. */
  amountMinor: number
  /** True when that figure already includes VAT, as a private buyer pays. */
  includesVat: boolean
  /** True when the figure is per unit rather than for the whole lot. */
  perUnit?: boolean
  currency?: Money['currency']
  rateBasisPoints?: number
}

export interface SaleBreakdown {
  lines: SaleLine[]
  grossMinor: number
  vatMinor: number
  netMinor: number
  costMinor: number
  profitMinor: number
  rateBasisPoints: number
}

/**
 * Splits what a sale fetched across the units it covered.
 *
 * A lot sold as one price is shared out in proportion to what each unit cost:
 * splitting evenly would make the cheap unit look wildly profitable and the
 * expensive one a loss, when in fact neither is knowable on its own. Units of
 * equal cost therefore split evenly, which is the common case anyway.
 *
 * The last unit takes the remainder, so the parts always add up to exactly the
 * figure that was entered.
 */
export function allocate(amountMinor: number, lines: SaleLineInput[]): number[] {
  if (lines.length === 0) return []
  if (lines.length === 1) return [amountMinor]

  const totalCost = lines.reduce((sum, line) => sum + line.costMinor, 0)
  const shares = totalCost > 0
    ? lines.map((line) => Math.round((amountMinor * line.costMinor) / totalCost))
    : lines.map(() => Math.round(amountMinor / lines.length))

  const allocated = shares.slice(0, -1)
  const rest = amountMinor - allocated.reduce((sum, share) => sum + share, 0)
  return [...allocated, rest]
}

export function breakDownSale(input: SaleInput): SaleBreakdown {
  const currency = input.currency ?? 'EUR'
  const rate = input.rateBasisPoints ?? NL_VAT_BASIS_POINTS
  const count = input.lines.length
  if (count === 0) {
    return {
      lines: [], grossMinor: 0, vatMinor: 0, netMinor: 0, costMinor: 0, profitMinor: 0,
      rateBasisPoints: rate,
    }
  }

  // Whatever was typed, work in gross: that is what changes hands.
  const perUnitTotal = input.perUnit ? input.amountMinor * count : input.amountMinor
  const grossMinor = input.includesVat
    ? perUnitTotal
    : vatFromNet(money(perUnitTotal, currency), rate).gross.minor

  const shares = allocate(grossMinor, input.lines)

  const lines = input.lines.map((line, index) => {
    const sale = vatFromGross(money(shares[index]!, currency), rate)
    const cost = vatFromGross(money(line.costMinor, currency), rate)
    return {
      itemId: line.itemId,
      grossMinor: sale.gross.minor,
      vatMinor: sale.vat.minor,
      netMinor: sale.net.minor,
      costVatMinor: cost.vat.minor,
      costNetMinor: cost.net.minor,
      profitMinor: sale.net.minor - cost.net.minor,
    }
  })

  return {
    lines,
    grossMinor,
    vatMinor: lines.reduce((sum, line) => sum + line.vatMinor, 0),
    netMinor: lines.reduce((sum, line) => sum + line.netMinor, 0),
    costMinor: input.lines.reduce((sum, line) => sum + line.costMinor, 0),
    profitMinor: lines.reduce((sum, line) => sum + line.profitMinor, 0),
    rateBasisPoints: rate,
  }
}

/** The VAT sitting inside a cost the mail stated, which comes back. */
export function vatWithinCost(costMinor: number, currency: Money['currency'] = 'EUR'): number {
  return vatFromGross(money(costMinor, currency), NL_VAT_BASIS_POINTS).vat.minor
}
