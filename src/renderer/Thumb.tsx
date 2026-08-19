import { useEffect, useState } from 'react'
import { api } from './api.js'

/**
 * The article photograph out of the retailer's mail.
 *
 * Pictures are resolved through the main process, which fetches each one once
 * and keeps it. Resolved pictures are remembered here as well, so scrolling a
 * table or moving between screens does not ask again for one already shown.
 *
 * Without a picture — an unrecognised retailer, a mail that carried none —
 * this is the same quiet tile the table drew before, never a broken image.
 */
const resolved = new Map<string, string | null>()

export function Thumb({ url, size = 26 }: { url: string | null; size?: number }) {
  const [source, setSource] = useState<string | null>(() => (url ? resolved.get(url) ?? null : null))

  useEffect(() => {
    if (!url) return setSource(null)

    const known = resolved.get(url)
    if (known !== undefined) return setSource(known)

    let live = true
    void api.productImage(url).then((data) => {
      resolved.set(url, data)
      if (live) setSource(data)
    })
    return () => { live = false }
  }, [url])

  return (
    <div
      className="thumb"
      style={{ width: size, height: size }}
      aria-hidden={!source}
    >
      {source && <img src={source} alt="" draggable={false} />}
    </div>
  )
}
