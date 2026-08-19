import type { ItemView } from '../api.js'

export interface ProductGroup {
  title: string
  imageUrl: string | null
  units: number
  incoming: number
  inStock: number
  gone: number
  costMinor: number
  /** What the sold units of this product fetched, and what they earned. */
  soldMinor: number
  profitMinor: number
  lastBoughtAt: string | null
  retailers: string[]
}

/**
 * The same units, counted by what they are.
 *
 * Inventory is one row per physical unit, which is right for selling and
 * tracking but hopeless for the question "how many of these do I actually
 * have". Grouping by title answers that, and keeps the money beside it so a
 * position is one line rather than an arithmetic exercise.
 *
 * Titles are matched on their visible text with spacing and case ignored: the
 * same product arrives worded identically from one retailer but not always
 * spaced identically.
 */
export function groupByProduct(items: ItemView[]): ProductGroup[] {
  const groups = new Map<string, ProductGroup>()

  for (const item of items) {
    const key = item.title.replace(/\s+/g, ' ').trim().toLowerCase()
    const group = groups.get(key) ?? {
      title: item.title.replace(/\s+/g, ' ').trim(),
      imageUrl: null,
      units: 0,
      incoming: 0,
      inStock: 0,
      gone: 0,
      costMinor: 0,
      soldMinor: 0,
      profitMinor: 0,
      lastBoughtAt: null,
      retailers: [],
    }

    group.units += 1
    group.costMinor += item.costMinor
    group.soldMinor += item.soldMinor ?? 0
    group.profitMinor += item.profitMinor ?? 0
    group.imageUrl = group.imageUrl ?? item.imageUrl
    if (item.status === 'incoming') group.incoming += 1
    else if (['in_stock', 'listed'].includes(item.status)) group.inStock += 1
    else group.gone += 1

    if (item.purchasedAt && (!group.lastBoughtAt || item.purchasedAt > group.lastBoughtAt)) {
      group.lastBoughtAt = item.purchasedAt
    }
    if (item.retailer && !group.retailers.includes(item.retailer)) group.retailers.push(item.retailer)

    groups.set(key, group)
  }

  // Most-held first: the question is which products you are deepest in.
  return [...groups.values()].sort((a, b) => b.units - a.units || b.costMinor - a.costMinor)
}
