'use client'

import { useEffect, useRef, useState } from 'react'

interface RemovalReasonPickerProps {
  reasons: string[]
  onSelect: (reason: string) => void
  onCancel: () => void
  triggerRef?: React.RefObject<HTMLButtonElement>
}

export function RemovalReasonPicker({
  reasons,
  onSelect,
  onCancel,
  triggerRef,
}: RemovalReasonPickerProps) {
  const pickerRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number; isAbove: boolean } | null>(null)

  useEffect(() => {
    if (!triggerRef?.current || !pickerRef.current) return

    const updatePosition = () => {
      if (!triggerRef?.current || !pickerRef.current) return

      const triggerRect = triggerRef.current.getBoundingClientRect()
      const pickerRect = pickerRef.current.getBoundingClientRect()

      const viewportHeight = window.innerHeight
      const bottomSpace = viewportHeight - triggerRect.bottom
      const topSpace = triggerRect.top
      const needsFlip = bottomSpace < pickerRect.height && topSpace > pickerRect.height

      let top: number
      if (needsFlip) {
        top = triggerRect.top - pickerRect.height - 8 + window.scrollY
      } else {
        top = triggerRect.bottom + 8 + window.scrollY
      }

      let left = triggerRect.left + triggerRect.width / 2 - pickerRect.width / 2 + window.scrollX
      left = Math.max(8, Math.min(left, window.innerWidth - pickerRect.width - 8))

      setPosition({
        top,
        left,
        isAbove: needsFlip,
      })
    }

    updatePosition()
    const timer = setTimeout(updatePosition, 0)
    window.addEventListener('scroll', updatePosition, true)
    window.addEventListener('resize', updatePosition)

    return () => {
      clearTimeout(timer)
      window.removeEventListener('scroll', updatePosition, true)
      window.removeEventListener('resize', updatePosition)
    }
  }, [triggerRef])

  if (!position) {
    return (
      <div
        ref={pickerRef}
        className="absolute left-1/2 top-full mt-1 -translate-x-1/2 bg-white border border-gray-200 rounded-lg shadow-lg z-50 min-w-max opacity-0"
      >
        {reasons.map((reason) => (
          <button key={reason} className="block w-full text-left px-4 py-2 text-sm">
            {reason}
          </button>
        ))}
      </div>
    )
  }

  return (
    <div
      ref={pickerRef}
      className="fixed bg-white border border-gray-200 rounded-lg shadow-lg z-50 min-w-max"
      style={{
        top: `${position.top}px`,
        left: `${position.left}px`,
      }}
    >
      {reasons.map((reason) => (
        <button
          key={reason}
          onClick={() => {
            console.log('[TRACE] Reason button clicked:', reason, 'onSelect type:', typeof onSelect)
            onSelect(reason)
          }}
          className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 first:rounded-t-lg last:rounded-b-lg border-b border-gray-100 last:border-b-0"
        >
          {reason}
        </button>
      ))}
      <button
        onClick={onCancel}
        className="block w-full text-left px-4 py-2 text-sm text-gray-500 hover:bg-gray-100 border-t border-gray-100"
      >
        Cancel
      </button>
    </div>
  )
}
