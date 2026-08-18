const NOTES: Record<string, string> = {
  Inventory:
    'Inventory rows appear once the reconciler turns parsed order events into individual items. The parsers already extract title, quantity and unit price for every order.',
  Sales:
    'The sell side needs a marketplace parser — StockX, Vinted, eBay. No sales email has been supplied yet, so this screen has nothing real to show.',
  Reports:
    'P&L and the VAT return build on purchases and sales together. The VAT arithmetic is written and tested; it needs the sell side before a return can be produced.',
}

export function Placeholder({ screen }: { screen: string }) {
  return (
    <div className="empty" style={{ margin: '70px auto' }}>
      <div className="empty-title">{screen} is not wired up yet</div>
      <div className="empty-body">{NOTES[screen]}</div>
      <div className="empty-body" style={{ color: 'var(--text-ghost)', fontSize: 11.5 }}>
        Deliberately blank rather than filled with sample data — a number on screen should always
        have come from a real email.
      </div>
    </div>
  )
}
