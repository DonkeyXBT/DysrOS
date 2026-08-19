import { useMemo, useState } from 'react'
import { api, type ItemView, type SaleView } from './api.js'

/**
 * Recording a sale made away from any marketplace.
 *
 * A private sale is a price, a buyer and a date — so that is what this asks
 * for. Whether the price already had VAT in it is the one thing that cannot be
 * guessed and changes every figure downstream, so it is a deliberate choice
 * rather than a default nobody notices.
 *
 * The arithmetic is shown before anything is saved: what the tax office gets,
 * and what is actually earned once the VAT on both sides is taken out.
 */
export function SellDialog({
  units,
  onClose,
  onSold,
}: {
  units: ItemView[]
  onClose: () => void
  onSold: () => void
}) {
  const [amount, setAmount] = useState('')
  const [includesVat, setIncludesVat] = useState(true)
  const [perUnit, setPerUnit] = useState(false)
  const [buyer, setBuyer] = useState('')
  const [note, setNote] = useState('')
  const [soldOn, setSoldOn] = useState(() => new Date().toISOString().slice(0, 10))
  const [saving, setSaving] = useState(false)

  const amountMinor = toMinor(amount)
  const costMinor = units.reduce((sum, unit) => sum + unit.costMinor, 0)

  const preview = useMemo(() => {
    if (amountMinor === null) return null
    const gross = includesVat
      ? (perUnit ? amountMinor * units.length : amountMinor)
      : Math.round((perUnit ? amountMinor * units.length : amountMinor) * 1.21)
    const vat = Math.round((gross * 2100) / 12100)
    const costVat = Math.round((costMinor * 2100) / 12100)
    return { gross, vat, net: gross - vat, costVat, profit: gross - costMinor }
  }, [amountMinor, includesVat, perUnit, units.length, costMinor])

  const save = async () => {
    if (amountMinor === null) return
    setSaving(true)
    try {
      await api.sellItems(units.map((unit) => unit.id), {
        amountMinor,
        includesVat,
        perUnit,
        buyer,
        note,
        soldAt: new Date(`${soldOn}T12:00:00`).toISOString(),
      })
      onSold()
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-scrim" onClick={saving ? undefined : onClose}>
      <div className="modal" style={{ width: 480 }} onClick={(event) => event.stopPropagation()}>
        <div className="modal-chrome">
          <span className="modal-pip" />
          <span className="modal-pip" />
          <span className="modal-pip" />
          <span className="modal-chrome-title">
            {units.length === 1 ? 'Sold this unit' : `Sold ${units.length} units`}
          </span>
          <button className="modal-x" onClick={onClose} aria-label="Cancel">×</button>
        </div>

        <div className="modal-body">
          <div className="modal-panel">
            <span className="modal-panel-label">
              {units.length === 1 ? 'UNIT' : `${units.length} UNITS · €${(costMinor / 100).toFixed(2)} COST`}
            </span>
            {units.slice(0, 6).map((unit) => (
              <div
                key={unit.id}
                style={{
                  display: 'flex', gap: 8, fontSize: 11.5, color: 'var(--text-muted)', minWidth: 0,
                }}
              >
                <span
                  style={{
                    minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}
                >
                  {unit.title}
                </span>
                <span className="mono" style={{ marginLeft: 'auto', color: 'var(--text-dimmer)' }}>
                  {unit.cost}
                </span>
              </div>
            ))}
            {units.length > 6 && (
              <span style={{ fontSize: 11, color: 'var(--text-ghost)' }}>
                and {units.length - 6} more
              </span>
            )}
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
              <span className="modal-panel-label">
                {perUnit && units.length > 1 ? 'PRICE PER UNIT' : 'PRICE'}
              </span>
              <input
                className="field-input"
                value={amount}
                inputMode="decimal"
                placeholder="0,00"
                autoFocus
                onChange={(event) => setAmount(event.target.value)}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 140 }}>
              <span className="modal-panel-label">SOLD ON</span>
              <input
                className="field-input"
                type="date"
                value={soldOn}
                onChange={(event) => setSoldOn(event.target.value)}
              />
            </label>
          </div>

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Toggle active={includesVat} onClick={() => setIncludesVat(true)}>
              Price includes 21% BTW
            </Toggle>
            <Toggle active={!includesVat} onClick={() => setIncludesVat(false)}>
              BTW comes on top
            </Toggle>
            {units.length > 1 && (
              <>
                <span style={{ width: 1, background: 'var(--border)', margin: '2px 4px' }} />
                <Toggle active={!perUnit} onClick={() => setPerUnit(false)}>
                  For the lot
                </Toggle>
                <Toggle active={perUnit} onClick={() => setPerUnit(true)}>
                  Each
                </Toggle>
              </>
            )}
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
              <span className="modal-panel-label">SOLD TO</span>
              <input
                className="field-input"
                value={buyer}
                placeholder="Name of the buyer"
                onChange={(event) => setBuyer(event.target.value)}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
              <span className="modal-panel-label">NOTE</span>
              <input
                className="field-input"
                value={note}
                placeholder="optional"
                onChange={(event) => setNote(event.target.value)}
              />
            </label>
          </div>

          {preview && (
            <div className="modal-panel" style={{ gap: 5 }}>
              <Line label="Received" value={preview.gross} strong />
              <Line label="Cost of the units" value={-costMinor} muted />
              <Line label="Profit" value={preview.profit} strong accent />
              <Line label="BTW collected (21%)" value={preview.vat} muted />
              <Line label="BTW already paid on the stock" value={preview.costVat} muted />
              {units.length > 1 && !perUnit && (
                <span style={{ fontSize: 10.5, color: 'var(--text-ghost)', lineHeight: 1.45 }}>
                  Split across the units in proportion to what each cost, so each row shows a
                  margin that means something.
                </span>
              )}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', paddingTop: 2 }}>
            <button className="btn" style={{ padding: '9px 16px' }} onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button
              className="btn"
              style={{
                padding: '9px 16px', fontWeight: 700, border: 0,
                background: 'var(--accent)', color: '#0b1020',
                opacity: amountMinor === null ? .5 : 1,
              }}
              disabled={saving || amountMinor === null}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : units.length === 1 ? 'Record sale' : `Record ${units.length} sales`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Toggle({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className="btn"
      onClick={onClick}
      style={active
        ? { background: '#242c3e', color: 'var(--text)', borderColor: '#3a4a6a' }
        : undefined}
    >
      {children}
    </button>
  )
}

function Line({
  label, value, strong, muted, accent,
}: { label: string; value: number; strong?: boolean; muted?: boolean; accent?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
      <span style={{ fontSize: 11.5, color: muted ? 'var(--text-dimmer)' : 'var(--text-muted)' }}>
        {label}
      </span>
      <span
        className="mono"
        style={{
          marginLeft: 'auto',
          fontSize: strong ? 12.5 : 11.5,
          fontWeight: strong ? 700 : 400,
          color: accent
            ? (value >= 0 ? 'var(--teal)' : 'var(--pink)')
            : muted ? 'var(--text-dimmer)' : 'var(--text)',
        }}
      >
        €{(value / 100).toFixed(2)}
      </span>
    </div>
  )
}

/**
 * Reads a price as a person writes one.
 *
 * Dutch keyboards produce `12,50`; the rest of the world writes `12.50`. Both
 * mean the same thing, and refusing one of them would be pedantry.
 */
export function toMinor(text: string): number | null {
  const cleaned = text.trim().replace(/[€\s]/g, '').replace(',', '.')
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null
  return Math.round(Number(cleaned) * 100)
}

/**
 * Correcting a sale already recorded.
 *
 * The same arithmetic as recording one, over a sale that exists: a price
 * agreed in a hurry is often written down wrong, and the BTW split follows
 * from the price rather than being typed, so it is worked out again from
 * whatever the price becomes.
 */
export function EditSaleDialog({
  sale,
  onClose,
  onSaved,
}: {
  sale: SaleView
  onClose: () => void
  onSaved: () => void
}) {
  const [amount, setAmount] = useState(() => (sale.grossMinor / 100).toFixed(2).replace('.', ','))
  const [includesVat, setIncludesVat] = useState(sale.includedVat)
  const [buyer, setBuyer] = useState(sale.buyer ?? '')
  const [note, setNote] = useState(sale.note ?? '')
  const [soldOn, setSoldOn] = useState(sale.soldAt.slice(0, 10))
  const [saving, setSaving] = useState(false)

  const amountMinor = toMinor(amount)
  const preview = useMemo(() => {
    if (amountMinor === null) return null
    const gross = includesVat ? amountMinor : Math.round(amountMinor * 1.21)
    const vat = Math.round((gross * 2100) / 12100)
    return { gross, vat, profit: sale.costMinor === null ? null : gross - sale.costMinor }
  }, [amountMinor, includesVat, sale.costMinor])

  const save = async () => {
    if (amountMinor === null) return
    setSaving(true)
    try {
      await api.updateSale(sale.id, {
        amountMinor,
        includesVat,
        buyer,
        note,
        soldAt: new Date(`${soldOn}T12:00:00`).toISOString(),
      })
      onSaved()
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-scrim" onClick={saving ? undefined : onClose}>
      <div className="modal" style={{ width: 460 }} onClick={(event) => event.stopPropagation()}>
        <div className="modal-chrome">
          <span className="modal-pip" />
          <span className="modal-pip" />
          <span className="modal-pip" />
          <span className="modal-chrome-title">Edit this sale</span>
          <button className="modal-x" onClick={onClose} aria-label="Cancel">×</button>
        </div>

        <div className="modal-body">
          <div className="modal-panel">
            <span className="modal-panel-label">
              UNIT{sale.cost ? ` · ${sale.cost} COST` : ' · BOUGHT ELSEWHERE'}
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4 }}>
              {sale.title}
            </span>
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
              <span className="modal-panel-label">PRICE</span>
              <input
                className="field-input"
                value={amount}
                inputMode="decimal"
                autoFocus
                onChange={(event) => setAmount(event.target.value)}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 150 }}>
              <span className="modal-panel-label">SOLD ON</span>
              <input
                className="field-input"
                type="date"
                value={soldOn}
                onChange={(event) => setSoldOn(event.target.value)}
              />
            </label>
          </div>

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Toggle active={includesVat} onClick={() => setIncludesVat(true)}>
              Price includes 21% BTW
            </Toggle>
            <Toggle active={!includesVat} onClick={() => setIncludesVat(false)}>
              BTW comes on top
            </Toggle>
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
              <span className="modal-panel-label">SOLD TO</span>
              <input
                className="field-input"
                value={buyer}
                placeholder="Name of the buyer"
                onChange={(event) => setBuyer(event.target.value)}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
              <span className="modal-panel-label">NOTE</span>
              <input
                className="field-input"
                value={note}
                placeholder="optional"
                onChange={(event) => setNote(event.target.value)}
              />
            </label>
          </div>

          {preview && (
            <div className="modal-panel" style={{ gap: 5 }}>
              <Line label="Received" value={preview.gross} strong />
              {sale.costMinor !== null && (
                <Line label="Cost of the unit" value={-sale.costMinor} muted />
              )}
              {preview.profit !== null && (
                <Line label="Profit" value={preview.profit} strong accent />
              )}
              <Line label="BTW collected (21%)" value={preview.vat} muted />
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', paddingTop: 2 }}>
            <button className="btn" style={{ padding: '9px 16px' }} onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button
              className="btn"
              style={{
                padding: '9px 16px', fontWeight: 700, border: 0,
                background: 'var(--accent)', color: '#0b1020',
                opacity: amountMinor === null ? .5 : 1,
              }}
              disabled={saving || amountMinor === null}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
