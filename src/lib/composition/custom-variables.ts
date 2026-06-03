// Converts a ComposedSequence into Instantly per-lead custom variable key-value pairs.
//
// Naming convention: m_subject_N (plain text) / m_body_N (HTML paragraphs).
// The shell holds {{m_subject_N}} / {{m_body_N}} as Instantly template variables.
// Each lead's upload payload carries the resolved values for their specific sequence.
//
// {{first_name}} is substituted with the actual prospect first name before HTML conversion —
// we cannot rely on Instantly resolving a nested variable inside a custom variable value.
//
// Completeness invariant (addendum-1): a lead may only be uploaded with the COMPLETE variable
// set. assertCompleteVariables throws if any step's body is missing or empty; callers must
// catch and exclude the lead (setting outbound_upload_status='failed') rather than uploading
// a partial set that would cause a blank/broken email.

import type { ComposedEmail } from './compose-sequence'

// Convert composed emails to flat Instantly custom variable map.
// firstName: substituted into {{first_name}} placeholders before HTML conversion.
export function composedToVariables(
  emails: ComposedEmail[],
  firstName: string | null,
): Record<string, string> {
  const name = firstName ?? ''
  const vars: Record<string, string> = {}

  for (const email of emails) {
    const n = email.sequence_position
    vars[`m_subject_${n}`] = email.subject_line ?? ''

    // Substitute {{first_name}} with the actual name before HTML encoding.
    const resolvedBody = email.body.replace(/\{\{first_name\}\}/g, name)
    vars[`m_body_${n}`] = plainTextToHtml(resolvedBody)
  }

  return vars
}

// Throw if any step is missing a body or subject key.
// Callers invoke this before attaching variables to a lead payload.
export function assertCompleteVariables(
  vars: Record<string, string>,
  stepCount: number,
): void {
  for (let n = 1; n <= stepCount; n++) {
    if (!(`m_subject_${n}` in vars)) {
      throw new Error(
        `compose-variables: missing m_subject_${n} (step ${n} of ${stepCount})`
      )
    }
    if (!(`m_body_${n}` in vars) || vars[`m_body_${n}`].trim() === '') {
      throw new Error(
        `compose-variables: missing or empty m_body_${n} (step ${n} of ${stepCount})`
      )
    }
  }
}

// Convert plaintext with \n\n paragraph breaks to HTML <p> tags.
// Single \n within a paragraph becomes <br>.
// HTML-special characters are escaped; {{...}} markers are not present in composed
// bodies (first_name is substituted before this call; no other markers remain).
export function plainTextToHtml(text: string): string {
  return text
    .split('\n\n')
    .filter(p => p.trim().length > 0)
    .map(para => {
      const escaped = para
        .trim()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
      return `<p>${escaped.replace(/\n/g, '<br>')}</p>`
    })
    .join('\n')
}
