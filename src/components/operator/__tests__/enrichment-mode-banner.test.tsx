// @vitest-environment jsdom
//
// Tests for the enrichment mode banner.
//
// The banner previously had two visual states for three situations: live, test, and
// "could not find out". The third collapsed into the second, so an operator looking at
// a blue "Test Mode Active" panel could not tell whether enrichment was genuinely in
// test mode or whether the banner had failed to read anything at all. It had in fact
// been failing on every request since it was written, while the flag was live.
//
// The load-bearing assertion in this file is that the unknown state does NOT render the
// reassuring copy.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { EnrichmentModeBanner } from '../enrichment-mode-banner'

afterEach(cleanup)

describe('EnrichmentModeBanner', () => {
  it('warns loudly when enrichment is live', () => {
    render(<EnrichmentModeBanner mode="live" />)
    expect(screen.getByText('Live Enrichment Active')).toBeInTheDocument()
    expect(screen.getByText(/consume Apollo credits/i)).toBeInTheDocument()
    expect(screen.queryByText('Test Mode Active')).not.toBeInTheDocument()
  })

  it('reassures only when the flag was actually read and is off', () => {
    render(<EnrichmentModeBanner mode="test" />)
    expect(screen.getByText('Test Mode Active')).toBeInTheDocument()
    expect(screen.getByText(/No Apollo credits consumed/i)).toBeInTheDocument()
    expect(screen.queryByText('Live Enrichment Active')).not.toBeInTheDocument()
  })

  // ── The regression guard ──────────────────────────────────────────────────

  it('does NOT render the safe test-mode state when the mode is unknown', () => {
    render(<EnrichmentModeBanner mode="unknown" />)

    // This is the assertion the old component could never have passed: its catch block
    // rendered exactly this copy.
    expect(screen.queryByText('Test Mode Active')).not.toBeInTheDocument()
    expect(screen.queryByText(/No Apollo credits consumed/i)).not.toBeInTheDocument()
  })

  it('renders an unknown mode as a visible warning, not as silence', () => {
    const { container } = render(<EnrichmentModeBanner mode="unknown" />)

    // Rendering nothing would be just as bad as rendering the safe state: an operator
    // would read the absence of a warning as "fine".
    expect(container).not.toBeEmptyDOMElement()
    expect(screen.getByText('Enrichment Mode Unknown')).toBeInTheDocument()
    expect(screen.getByText(/may be live and\s+consuming Apollo credits/i)).toBeInTheDocument()
  })

  it('gives each of the three modes a distinct rendering', () => {
    const { container: live } = render(<EnrichmentModeBanner mode="live" />)
    const liveHtml = live.innerHTML
    cleanup()
    const { container: test } = render(<EnrichmentModeBanner mode="test" />)
    const testHtml = test.innerHTML
    cleanup()
    const { container: unknown } = render(<EnrichmentModeBanner mode="unknown" />)
    const unknownHtml = unknown.innerHTML

    expect(new Set([liveHtml, testHtml, unknownHtml]).size).toBe(3)
  })
})
