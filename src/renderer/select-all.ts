import { useEffect, useRef } from 'react'

/**
 * Ctrl+A selects the rows, not the page's text.
 *
 * Inside a table of things you act on, selecting every word on screen is never
 * what was meant. Typing is left alone: the shortcut in a text field still
 * selects what was typed, which is what anyone typing expects.
 *
 * What "all" means is the caller's to decide, and it should mean whatever the
 * current filter shows — selecting rows that are not on screen is a surprise
 * waiting to be acted on.
 */
export function useSelectAll(selectAll: () => void): void {
  // Held in a ref so the listener is attached once rather than on every
  // render, which a fresh closure each time would otherwise cause.
  const latest = useRef(selectAll)
  latest.current = selectAll

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'a') return
      if (event.altKey || event.shiftKey) return

      const target = event.target as HTMLElement | null
      if (target?.isContentEditable) return
      if (target && /^(input|textarea|select)$/i.test(target.tagName)) return

      event.preventDefault()
      latest.current()
    }

    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
}
