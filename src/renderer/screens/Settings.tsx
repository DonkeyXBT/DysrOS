import { Accounts } from './Accounts.js'

export function Settings({
  onAccountsChanged,
  onSync,
  syncing,
}: {
  onAccountsChanged: () => void
  onSync: () => void
  syncing: boolean
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 13, maxWidth: 920 }}>
      <Accounts onChanged={onAccountsChanged} onSync={onSync} syncing={syncing} />

      <section className="section" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="section-head" style={{ marginBottom: 0 }}>
          <h2>DHL ServicePoint redirect</h2>
          <span className="section-note">exports trackings.csv for the redirect tool</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          The tool expects <span className="mono">tracking,postalcode</span> rows. The postal code
          comes from the shipping mail; the tracking code is not in the mail at all and is resolved
          from the retailer&apos;s redirect link first. Export it from the Shipments screen.
        </div>
      </section>
    </div>
  )
}
