'use client'

// The company name, editable, with the intake spelling shown beside it.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY BOTH VALUES ARE ON SCREEN AT ONCE
//
// The company name exists in two places. organisations.name is typed by the operator when
// the client is created. The company_name intake response is typed by the client, in their
// own words, weeks later. Nothing has ever compared them, and neither had an edit path.
//
// organisations.name is not a label. It is the second line of the sign-off block on every
// email, read by the messaging agent's preflight and enforced there by a validator. So the
// two spellings are not equally consequential: one of them goes out under every email, and
// the other is what the client calls themselves.
//
// Showing them apart, on two screens, is what let them differ for months. Showing them
// together is the entire fix for the noticing problem. The deciding problem is not ours:
// which spelling is correct is a question for the client.

import { useState, useTransition } from 'react'
import { updateOrganisationName } from './actions'

interface OrganisationNameEditorProps {
  orgId: string
  /** organisations.name. The sign-off line on every email. */
  orgName: string
  /**
   * The client's own company_name intake response, or null when they have not answered.
   *
   * NULL AND EMPTY ARE NOT THE SAME THING and must not render the same way. An unanswered
   * intake is nothing to reconcile. An answered one that differs is a decision waiting for
   * somebody. One live organisation holds an empty string here, which is the second case
   * wearing the clothes of the first.
   */
  intakeName: string | null
}

export function OrganisationNameEditor({ orgId, orgName, intakeName }: OrganisationNameEditorProps) {
  const [current, setCurrent] = useState(orgName)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(orgName)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [pending, startTransition] = useTransition()

  const intake = intakeName?.trim() ?? ''
  const intakeAnswered = intake.length > 0
  // Exact comparison, deliberately. Case and spacing are exactly what differs in the live
  // data, so folding either would hide the thing this is for.
  const differs = intakeAnswered && intake !== current.trim()

  function handleSave() {
    setError(null)
    setSaved(false)
    startTransition(async () => {
      const result = await updateOrganisationName(orgId, draft)
      if (result.error) {
        setError(result.error)
        return
      }
      setCurrent(draft.trim())
      setEditing(false)
      setSaved(true)
    })
  }

  function handleCancel() {
    setDraft(current)
    setError(null)
    setEditing(false)
  }

  return (
    <div className="space-y-2">
      <div className="flex justify-between items-start gap-3">
        <span className="text-[12px] text-text-secondary shrink-0">Company name</span>

        {editing ? (
          <div className="flex flex-col items-end gap-2 w-full">
            <input
              type="text"
              value={draft}
              autoFocus
              onChange={e => { setDraft(e.target.value); setSaved(false) }}
              className="w-full px-2 py-1 text-[12px] text-text-primary bg-surface-content border border-border-card rounded-[6px] text-right focus:outline-none focus:border-brand-green-accent transition-colors"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={handleSave}
                disabled={pending || draft.trim() === current.trim()}
                className="px-3 py-1 text-[11px] font-medium text-[#F5F0E8] bg-brand-green rounded-[20px] hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {pending ? 'Saving' : 'Save'}
              </button>
              <button
                onClick={handleCancel}
                disabled={pending}
                className="px-3 py-1 text-[11px] text-text-secondary border border-border-card rounded-[20px] hover:text-text-primary transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-medium text-text-primary text-right">{current}</span>
            <button
              onClick={() => { setDraft(current); setEditing(true); setSaved(false) }}
              className="text-[11px] text-brand-blue hover:underline shrink-0"
            >
              Edit
            </button>
          </div>
        )}
      </div>

      {saved && !editing && (
        <p className="text-[10px] text-[#3B6D11] text-right">Saved</p>
      )}
      {error && (
        <p className="text-[11px] text-[#C0392B] text-right">{error}</p>
      )}

      {differs && (
        <div className="rounded-[6px] border border-[#E0C089] bg-[#FDF6E7] px-3 py-2 space-y-1">
          <p className="text-[11px] font-medium text-[#8A5A00]">
            The client spells this differently in their intake
          </p>
          <div className="flex justify-between gap-3">
            <span className="text-[10px] text-[#8A5A00]">They typed</span>
            <span className="text-[10px] font-medium text-[#8A5A00] text-right break-words">{intake}</span>
          </div>
          <p className="text-[10px] text-[#8A5A00] leading-relaxed">
            The name above is what appears on the sign-off line of every email. The intake
            spelling is what the client called themselves. Ask them which is right before
            changing anything. Regenerating their messaging document will rewrite the copy
            to whichever name is stored above, so a document already approved can come back
            spelled differently.
          </p>
        </div>
      )}

      {!intakeAnswered && (
        <p className="text-[10px] text-text-secondary italic text-right">
          No company name answered in intake
        </p>
      )}
    </div>
  )
}
