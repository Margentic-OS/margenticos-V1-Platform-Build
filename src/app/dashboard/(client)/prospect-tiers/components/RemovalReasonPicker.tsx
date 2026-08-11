'use client'

interface RemovalReasonPickerProps {
  reasons: string[]
  onSelect: (reason: string) => void
  onCancel: () => void
}

export function RemovalReasonPicker({ reasons, onSelect, onCancel }: RemovalReasonPickerProps) {
  return (
    <div className="absolute left-1/2 top-full mt-1 -translate-x-1/2 bg-white border border-gray-200 rounded-lg shadow-lg z-50 min-w-max">
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
