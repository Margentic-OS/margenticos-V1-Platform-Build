// The drafting prompt and the send path must agree on the booking-link placeholder and on
// the hint key, or a draft reaches the prospect with a literal token in it.
//
// WHY A PAIR TEST. The prompt is a markdown file read from disk at runtime, and the
// substitution is TypeScript. Each side can be edited and tested on its own and stay green
// while the two disagree: the prompt teaches one token, the substitution fills another, and
// substituteBookingLink reports "no placeholder, nothing to do". This file exercises the
// PAIR: it reads the real prompt and feeds what it teaches through the real substitution and
// the real final guard.
//
// MUTATION-PROVED on commit. Changing the placeholder in the prompt, the constant in
// substitute-booking-link.ts, or the hint key in reply-draft-agent.ts each turns this red.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  BOOKING_LINK_PLACEHOLDER,
  substituteBookingLink,
} from '../substitute-booking-link'
import { findUnfilledPlaceholder } from '../unfilled-placeholder'

const ROOT = process.cwd()
const PROMPT = readFileSync(join(ROOT, 'docs', 'prompts', 'reply-draft-agent.md'), 'utf-8')
const AGENT_SOURCE = readFileSync(join(ROOT, 'src', 'lib', 'agents', 'reply-draft-agent.ts'), 'utf-8')

// Every single-brace token the prompt quotes to the model as something to write. The
// {organisationName} substitution is not quoted and is filled before the model sees it.
function tokensThePromptTeaches(): string[] {
  const found = PROMPT.match(/"\{[a-z_]+\}"/g) ?? []
  return [...new Set(found.map(t => t.slice(1, -1)))]
}

describe('the drafting prompt and the send path agree on the booking link', () => {
  it('teaches exactly one placeholder, and it is the one the substitution fills', () => {
    const taught = tokensThePromptTeaches()
    // Positive control: the prompt does teach a token. An empty list would make the next
    // assertion vacuous, which is how a pair test passes while the pair is broken.
    expect(taught.length).toBeGreaterThan(0)
    expect(taught).toEqual([BOOKING_LINK_PLACEHOLDER])
  })

  it('a draft written the way the prompt teaches receives a link and passes the final guard', () => {
    const [taught] = tokensThePromptTeaches()
    const draft = `Happy to find a time. Grab a slot here: ${taught}`

    const result = substituteBookingLink(draft, 'https://booking.test/alex')

    expect(result.substituted).toBe(true)
    expect(result.body).toContain('https://booking.test/alex')
    expect(findUnfilledPlaceholder(result.body)).toBeNull()
  })

  it('the hint key the agent sends is the key the prompt reads', () => {
    const agentKeys = AGENT_SOURCE.match(/\binclude_[a-z]+_hint(?=:)/g) ?? []
    // Positive control: the agent does send a hint key.
    expect(agentKeys.length).toBeGreaterThan(0)
    for (const key of new Set(agentKeys)) {
      expect(PROMPT).toContain(`\`${key}\``)
    }
  })
})
