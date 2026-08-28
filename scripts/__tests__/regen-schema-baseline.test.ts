import { describe, it, expect } from 'vitest'
import { buildViewsDdl, type ViewRow } from '../regen-schema-baseline'

// The generator used to ask whether the security_invoker reloption was PRESENT and then
// emit 'true' regardless. A view set to security_invoker=false was therefore written into
// the tracked disaster recovery baseline as secure, on the one property that had just
// turned out to be a live RLS bypass.
//
// The reason it went unnoticed is the reason this test exists: as of 2026-08-27 every view
// in the database is either true or has no reloption, and the broken version emits the
// right text for both of those. The bug is invisible until the next view is created false,
// which is exactly when the baseline would be trusted. So the case has to be CONSTRUCTED.

const view = (over: Partial<ViewRow> = {}): ViewRow => ({
  name: 'v_example',
  securityInvoker: null,
  definition: ' SELECT 1;',
  ...over,
})

describe('buildViewsDdl', () => {
  it('emits false when the view is security_invoker=false', () => {
    const ddl = buildViewsDdl([view({ name: 'mon_019', securityInvoker: 'false' })])
    expect(ddl).toContain('CREATE OR REPLACE VIEW public.mon_019 WITH (security_invoker = false) AS')
    expect(ddl).not.toContain('security_invoker = true')
  })

  it('emits true when the view is security_invoker=true', () => {
    const ddl = buildViewsDdl([view({ name: 'client_prospects_view', securityInvoker: 'true' })])
    expect(ddl).toContain('CREATE OR REPLACE VIEW public.client_prospects_view WITH (security_invoker = true) AS')
  })

  // ABSENT IS NOT FALSE. They behave identically, but a restore that turned reloptions
  // NULL into {security_invoker=false} would not reproduce the catalog it captured.
  it('emits no clause at all when the option is absent', () => {
    const ddl = buildViewsDdl([view({ name: 'queue_depth', securityInvoker: null })])
    expect(ddl).toContain('CREATE OR REPLACE VIEW public.queue_depth AS')
    expect(ddl).not.toContain('security_invoker')
  })

  it('keeps each view independent when a false one sits between two true ones', () => {
    const ddl = buildViewsDdl([
      view({ name: 'a', securityInvoker: 'true' }),
      view({ name: 'b', securityInvoker: 'false' }),
      view({ name: 'c', securityInvoker: 'true' }),
    ])
    expect(ddl).toContain('public.a WITH (security_invoker = true)')
    expect(ddl).toContain('public.b WITH (security_invoker = false)')
    expect(ddl).toContain('public.c WITH (security_invoker = true)')
  })
})
