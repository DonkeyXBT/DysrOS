import { useState } from 'react'
import { api } from '../api.js'
import { Confirm } from '../Confirm.js'
import { Accounts } from './Accounts.js'
import { AycdPanel } from './AycdPanel.js'
import { DiscordPanel } from './DiscordPanel.js'

export function Settings({
  onAccountsChanged,
  onSync,
  syncing,
  onOpenLogs,
  onOpenReview,
  reviewCount,
}: {
  onAccountsChanged: () => void
  onSync: () => void
  syncing: boolean
  onOpenLogs: () => void
  onOpenReview: () => void
  reviewCount: number
}) {
  const [reparsing, setReparsing] = useState(false)
  const [reparseNote, setReparseNote] = useState<string | null>(null)
  const [wiping, setWiping] = useState(false)
  const [wipeNote, setWipeNote] = useState<string | null>(null)
  const [alsoAccounts, setAlsoAccounts] = useState(false)
  const [confirming, setConfirming] = useState(false)

  return (
    <div className="screen" style={{ gap: 13, maxWidth: 920, overflowY: 'auto' }}>
      {confirming && (
        <Confirm
          title="Delete all data"
          destructive
          confirmLabel="Delete everything"
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            setConfirming(false)
            setWiping(true)
            setWipeNote(null)
            try {
              const result = await api.deleteAllData(alsoAccounts)
              setWipeNote(
                `Deleted ${result.messages} messages, ${result.purchases} purchases and ${result.items} items.`,
              )
              onAccountsChanged()
            } finally {
              setWiping(false)
            }
          }}
          body={
            <>
              Inventory, purchases, shipments, events and the stored copies of your mail will be
              removed{alsoAccounts ? ', and every mailbox disconnected' : ''}. This cannot be
              undone.
              <br /><br />
              Your actual mailbox is untouched — syncing again re-collects everything.
            </>
          }
        />
      )}

      <Accounts onChanged={onAccountsChanged} onSync={onSync} syncing={syncing} />

      <AycdPanel />

      <DiscordPanel />

      <section className="section" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="section-head" style={{ marginBottom: 0 }}>
          <h2>Unrecognised mail</h2>
          <span className="section-note">
            {reviewCount === 0 ? 'nothing waiting' : `${reviewCount} waiting`}
          </span>
          <button className="btn" style={{ marginLeft: 'auto' }} onClick={onOpenReview}>
            Open review queue
          </button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          Mail no parser recognised is kept here rather than dropped. Exporting one as .eml is
          what allows a parser to be written for it, so the same mail is understood next time.
        </div>
      </section>

      <section className="section" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="section-head" style={{ marginBottom: 0 }}>
          <h2>Maintenance</h2>
          <span className="section-note">when a parser has been corrected</span>
        </div>

        <div style={{ display: 'flex', gap: 9, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            className="btn"
            disabled={reparsing}
            onClick={async () => {
              setReparsing(true)
              setReparseNote(null)
              try {
                const result = await api.reparseAll()
                setReparseNote(
                  `Re-read ${result.reparsed} of ${result.examined} messages` +
                  (result.missing > 0
                    ? ` · ${result.missing} had no stored copy and were skipped`
                    : ''),
                )
                onAccountsChanged()
              } finally {
                setReparsing(false)
              }
            }}
          >
            {reparsing ? 'Re-reading mail…' : 'Re-read all mail'}
          </button>
          {reparseNote && (
            <span style={{ fontSize: 11.5, color: 'var(--teal)' }}>{reparseNote}</span>
          )}
        </div>

        <div style={{ fontSize: 11, color: 'var(--text-ghost)', lineHeight: 1.5 }}>
          Runs the current parsers over every message kept on disk and rebuilds inventory,
          purchases and shipments from the result. Nothing is duplicated — corrected data replaces
          the old. Mail fetched before copies were retained cannot be re-read; sync again to
          collect it.
        </div>
      </section>

      <section
        className="section"
        style={{
          display: 'flex', flexDirection: 'column', gap: 10,
          borderColor: '#3a2b33',
        }}
      >
        <div className="section-head" style={{ marginBottom: 0 }}>
          <h2>Start over</h2>
          <span className="section-note">removes everything collected so far</span>
        </div>

        <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          Deletes inventory, purchases, shipments, events and the stored copies of your mail. Your
          actual mailbox is untouched — syncing again re-collects everything.
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
          <input
            type="checkbox"
            checked={alsoAccounts}
            onChange={(event) => setAlsoAccounts(event.target.checked)}
          />
          <span style={{ color: 'var(--text-muted)' }}>
            Also disconnect every mailbox
          </span>
        </label>

        <div style={{ display: 'flex', gap: 9, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            className="btn"
            disabled={wiping}
            style={{ borderColor: '#43303a', color: 'var(--pink)' }}
            onClick={() => setConfirming(true)}
          >
            {wiping ? 'Deleting…' : 'Delete all data'}
          </button>
          {wipeNote && (
            <span style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>{wipeNote}</span>
          )}
        </div>
      </section>

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

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingLeft: 4, paddingBottom: 6 }}>
        <span style={{ fontSize: 11, color: 'var(--text-ghost)' }}>
          Something gone wrong? Errors and crash reports are kept.
        </span>
        <button className="btn" onClick={onOpenLogs} style={{ padding: '4px 11px', fontSize: 11 }}>
          Open logs
        </button>
      </div>
    </div>
  )
}
