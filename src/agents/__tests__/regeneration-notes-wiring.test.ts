// Every document generation agent must carry a rejection note into the run that
// replaces the rejected suggestion. See ADR-038.
//
// WHAT THIS TEST PROVES, AND WHAT IT DOES NOT.
//
// It reads the agent SOURCE and asserts each file calls the two shared builders. That
// catches the drift this defect is made of: a fifth generation agent is added, or an
// existing one is refactored, and the note quietly stops travelling. It does NOT prove
// the block reached Anthropic, because buildUserMessage is private to each agent. The
// behavioural proof of the seam is in
// src/app/api/suggestions/regenerate/__tests__/route.test.ts, which asserts the route
// hands regeneration_notes to the agent, and in
// src/lib/agents/__tests__/regeneration-notes.test.ts, which asserts the builders put
// the note in the string.
//
// The test guards itself: it fails if the glob finds no agents, rather than passing
// vacuously over an empty set.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const AGENT_DIR = join(process.cwd(), 'src/agents')

const agentFiles = readdirSync(AGENT_DIR).filter(f => f.endsWith('-generation-agent.ts'))

describe('generation agents carry the rejection note', () => {
  it('found the generation agents to check', () => {
    // Without this the whole suite below passes on an empty list.
    expect(agentFiles.length).toBeGreaterThanOrEqual(4)
  })

  it.each(agentFiles)('%s accepts regeneration_notes on its input', file => {
    const src = readFileSync(join(AGENT_DIR, file), 'utf8')
    expect(src).toMatch(/regeneration_notes\?: RegenerationNotes/)
  })

  it.each(agentFiles)('%s puts the note in the prompt', file => {
    const src = readFileSync(join(AGENT_DIR, file), 'utf8')
    expect(src).toContain('buildRegenerationNotesBlock(')
  })

  it.each(agentFiles)('%s names the note in suggestion_reason', file => {
    // Without this an operator cannot tell a regeneration that honoured the note from
    // one that ignored it, which is the half of the defect that hid the other half.
    const src = readFileSync(join(AGENT_DIR, file), 'utf8')
    expect(src).toContain('buildRegenerationNotesReason(')
  })

  it.each(agentFiles)('%s keeps its internal plumbing non-optional', file => {
    // The first version of this change shipped with positioning and tov calling
    // buildRegenerationNotesReason(params.regeneration_notes) while their
    // writeDocumentSuggestion call sites never passed regeneration_notes. The value was
    // undefined, the reason sentence was silently empty, tsc said nothing because the
    // parameter was optional, and the presence checks above all passed.
    //
    // The real guard is now the type: internal param types declare
    // `regeneration_notes: RegenerationNotes | undefined`, so an object literal that
    // omits it is a compile error. This test stops someone relaxing that back to `?:`
    // and reopening the hole. The PUBLIC agent input stays optional on purpose, because
    // external callers legitimately omit it.
    const src = readFileSync(join(AGENT_DIR, file), 'utf8')
    const publicInput = /export interface \w+AgentInput \{[\s\S]*?\n\}/.exec(src)?.[0] ?? ''
    const internals = src.replace(publicInput, '')
    expect(internals).not.toContain('regeneration_notes?: RegenerationNotes')
    expect(internals).toContain('regeneration_notes: RegenerationNotes | undefined')
  })
})
