import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { OperatorTopbar } from '@/components/dashboard/OperatorTopbar'
import Link from 'next/link'

interface IntakeResponse {
  field_key: string
  field_label: string
  response_value: string | null
  section: string
  updated_at: string
  is_critical: boolean
}

export default async function ClientIntakePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  // ── 1. Authenticated ───────────────────────────────────────────────────────
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // ── 2. Operator role - checked on every request, not just at login ─────────
  const { data: userRow } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!userRow || userRow.role !== 'operator') notFound()

  // ── 3. Fetch org - notFound() for both non-operator and missing org (no info leak) ──
  const { data: org } = await supabase
    .from('organisations')
    .select('id, name')
    .eq('id', id)
    .maybeSingle()

  if (!org) notFound()

  // Fetch all intake responses for this client, ordered by section then by field_key
  const { data: responses } = await supabase
    .from('intake_responses')
    .select('field_key, field_label, response_value, section, updated_at, is_critical')
    .eq('organisation_id', org.id)
    .order('section', { ascending: true })
    .order('field_key', { ascending: true })

  // Group responses by section
  const groupedBySection: Record<string, IntakeResponse[]> = {}
  for (const response of responses ?? []) {
    if (!groupedBySection[response.section]) {
      groupedBySection[response.section] = []
    }
    groupedBySection[response.section].push(response)
  }

  const sections = Object.entries(groupedBySection).sort((a, b) =>
    a[0].localeCompare(b[0])
  )

  // Get the most recent updated_at timestamp for the submission date
  const latestUpdateTime = (responses ?? []).reduce(
    (latest: string | null, r) => {
      if (!latest || r.updated_at > latest) return r.updated_at
      return latest
    },
    null
  )

  const submissionDate = latestUpdateTime ? new Date(latestUpdateTime) : null

  return (
    <>
      <OperatorTopbar
        eyebrow="Operator view"
        title={org.name}
        userEmail={user.email}
      />
      <div className="flex-1 overflow-y-auto bg-surface-content">
        <div className="px-7 py-6 max-w-[1040px]">
          <Link
            href={`/dashboard/operator/clients/${org.id}`}
            className="inline-flex items-center gap-1.5 text-[12px] text-text-secondary hover:text-text-primary transition-colors mb-6"
          >
            ← Return to client
          </Link>

          <div className="mb-8">
            <h1 className="text-2xl font-semibold text-text-primary mb-2">
              Intake form
            </h1>
            {submissionDate && (
              <p className="text-[13px] text-text-secondary">
                Submitted on {submissionDate.toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                  timeZone: 'UTC',
                })} UTC
              </p>
            )}
          </div>

          {sections.length === 0 ? (
            <div className="rounded-lg border border-border-light bg-surface-secondary p-6 text-center">
              <p className="text-[13px] text-text-secondary">
                No intake responses recorded yet.
              </p>
            </div>
          ) : (
            <div className="space-y-8">
              {sections.map(([sectionName, sectionResponses]) => (
                <section key={sectionName} className="space-y-4">
                  <h2 className="text-[15px] font-semibold text-text-primary capitalize">
                    {sectionName.replace(/_/g, ' ')}
                  </h2>

                  <div className="space-y-6 pl-4 border-l-2 border-border-light">
                    {sectionResponses.map((response) => (
                      <div key={response.field_key}>
                        <label className="text-[13px] font-medium text-text-primary block mb-2">
                          {response.field_label}
                          {response.is_critical && (
                            <span className="text-red-400 ml-1">*</span>
                          )}
                        </label>
                        <div className="text-[13px] text-text-secondary leading-relaxed whitespace-pre-wrap">
                          {response.response_value ? (
                            response.response_value
                          ) : (
                            <span className="italic text-text-tertiary">
                              Not answered
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}
