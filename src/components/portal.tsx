'use client'

import { ReactNode, useEffect, useRef, useState } from 'react'

interface PortalProps {
  children: ReactNode
  triggerRef: React.RefObject<HTMLElement>
}

export function DropdownPortal({ children, triggerRef }: PortalProps) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const portalRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!triggerRef.current || !portalRef.current) return

    const updatePosition = () => {
      if (!triggerRef.current || !portalRef.current) return

      const triggerRect = triggerRef.current.getBoundingClientRect()
      const portalRect = portalRef.current.getBoundingClientRect()

      let top = triggerRect.bottom + 8
      const left = triggerRect.left + triggerRect.width / 2 - portalRect.width / 2

      const viewportHeight = window.innerHeight
      const bottomSpace = viewportHeight - triggerRect.bottom
      const topSpace = triggerRect.top

      if (bottomSpace < portalRect.height && topSpace > portalRect.height) {
        top = triggerRect.top - portalRect.height - 8
      }

      setPosition({
        top: top + window.scrollY,
        left: Math.max(8, Math.min(left, window.innerWidth - portalRect.width - 8)),
      })
    }

    updatePosition()
    window.addEventListener('scroll', updatePosition)
    window.addEventListener('resize', updatePosition)

    return () => {
      window.removeEventListener('scroll', updatePosition)
      window.removeEventListener('resize', updatePosition)
    }
  }, [triggerRef])

  if (!position) return null

  return (
    <div
      ref={portalRef}
      className="fixed z-50 pointer-events-auto"
      style={{
        top: `${position.top}px`,
        left: `${position.left}px`,
      }}
    >
      {children}
    </div>
  )
}
