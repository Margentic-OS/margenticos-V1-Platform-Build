'use client'

interface RemovalReasonModalProps {
  prospectName: string
  reasons: string[]
  isLoading: boolean
  onSelect: (reason: string) => void
  onCancel: () => void
}

export function RemovalReasonModal({
  prospectName,
  reasons,
  isLoading,
  onSelect,
  onCancel,
}: RemovalReasonModalProps) {
  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onCancel} />
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        <div className="bg-white rounded-lg shadow-xl p-6 max-w-sm w-full mx-4">
          <h2 className="text-lg font-semibold text-gray-900 mb-6">
            Why remove {prospectName}?
          </h2>

          <div className="space-y-2 mb-6">
            {reasons.map((reason) => (
              <button
                key={reason}
                onClick={() => onSelect(reason)}
                disabled={isLoading}
                className="w-full text-left px-4 py-3 rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm text-gray-700 font-medium"
              >
                {reason}
              </button>
            ))}
          </div>

          <button
            onClick={onCancel}
            disabled={isLoading}
            className="w-full px-4 py-2 rounded border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium"
          >
            Cancel
          </button>
        </div>
      </div>
    </>
  )
}
