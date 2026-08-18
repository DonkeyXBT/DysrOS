export type ParseStatus = 'pending' | 'parsed' | 'unrecognized' | 'ignored'

export type EventType =
  | 'order_placed'
  | 'order_confirmed'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'refunded'
  | 'sale'
  | 'payout'
  | 'listing'

export type ItemStatus =
  | 'incoming'
  | 'in_stock'
  | 'listed'
  | 'sold'
  | 'shipped_to_buyer'
  | 'delivered'
  | 'cancelled'
  | 'returned'
