import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface MenuItem {
  label: string
  onSelect: () => void
  destructive?: boolean
  disabled?: boolean
}

export interface MenuState {
  x: number
  y: number
  title: string
  items: MenuItem[]
}

/**
 * A right-click menu drawn like the rest of the tool.
 *
 * It flips rather than overflows: opened near the right or bottom edge it
 * would otherwise be half off-screen, which is worst exactly where long tables
 * end. Escape and any click elsewhere dismiss it.
 */
export function ContextMenu({ menu, onClose }: { menu: MenuState | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    if (!menu || !ref.current) {
      setPosition(null)
      return
    }
    const box = ref.current.getBoundingClientRect()
    setPosition({
      left: menu.x + box.width > window.innerWidth ? Math.max(4, menu.x - box.width) : menu.x,
      top: menu.y + box.height > window.innerHeight ? Math.max(4, menu.y - box.height) : menu.y,
    })
  }, [menu])

  useEffect(() => {
    if (!menu) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    const onAway = () => onClose()
    document.addEventListener('keydown', onKey)
    // Deferred: the same click that opened it would otherwise close it at once.
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', onAway)
      window.addEventListener('blur', onAway)
    }, 0)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onAway)
      window.removeEventListener('blur', onAway)
    }
  }, [menu, onClose])

  if (!menu) return null

  return (
    <div
      ref={ref}
      className="ctx-menu"
      style={{
        left: position?.left ?? menu.x,
        top: position?.top ?? menu.y,
        // Hidden for the first frame, while its size is measured to decide
        // whether it needs to flip.
        visibility: position ? 'visible' : 'hidden',
      }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="ctx-title">{menu.title}</div>
      {menu.items.map((item) => (
        <button
          key={item.label}
          className={`ctx-item${item.destructive ? ' ctx-item-destructive' : ''}`}
          disabled={item.disabled}
          onClick={() => {
            onClose()
            item.onSelect()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

/**
 * Wires right-click on a row to a menu.
 *
 * Returns the props to spread onto the row and the menu state to render, so a
 * screen adds a context menu without managing placement itself.
 */
export function useContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null)

  const open = (event: React.MouseEvent, title: string, items: MenuItem[]) => {
    event.preventDefault()
    setMenu({ x: event.clientX, y: event.clientY, title, items })
  }

  return { menu, open, close: () => setMenu(null) }
}
