// src/app/api/mock/instantly/[...path]/route.ts
//
// In-app mock server for the Instantly V2 API.
// Used when instantly_api_active = false in integrations_registry.
//
// Why in-app rather than third-party: developer.instantly.ai/_mock/api/v2 returns
// 404 HTML (Mintlify docs site) — the third-party mock is dead as of 2026-06-04.
// An in-app mock removes third-party drift permanently.
//
// URL: ${VERCEL_URL or NEXT_PUBLIC_APP_URL}/api/mock/instantly
// All Instantly call sites resolve this URL via resolveInstantlyBaseUrl(isActive=false).
//
// Endpoint coverage (all endpoints used by the system):
//   GET  /campaigns/analytics
//   GET  /campaigns/:id
//   PATCH /campaigns/:id
//   POST /leads/add
//   POST /leads/list
//   POST /dfy-email-account-orders
//   PATCH /leads/:id
//   POST /emails/reply
//   GET  /emails
//   GET  /emails/:id

import { NextRequest, NextResponse } from 'next/server'

type RouteContext = { params: Promise<{ path: string[] }> }

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status })
}

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(_req: NextRequest, ctx: RouteContext) {
  const { path } = await ctx.params
  const [resource, id] = path

  // GET /campaigns/analytics → empty array (fetchCampaignStats returns empty Map gracefully)
  if (resource === 'campaigns' && id === 'analytics') {
    return json([])
  }

  // GET /campaigns/:id → minimal campaign shape (validateCampaign, syncSequenceShell)
  if (resource === 'campaigns' && id) {
    return json({
      id,
      name: 'Mock Campaign',
      status: 'active',
      scheduling_status: 'scheduled',
      sequences: [],
    })
  }

  // GET /emails/:id → minimal email shape (fetchOutboundEmailBody in polling)
  if (resource === 'emails' && id) {
    return json({
      id,
      body_text: 'Mock outbound email body.',
      subject: 'Mock subject',
      eaccount: 'mock@example.com',
    })
  }

  // GET /emails → empty list (reply polling — no real replies in mock mode)
  if (resource === 'emails') {
    return json({ items: [], pagination: {} })
  }

  return json({ error: `Mock: unhandled GET /${path.join('/')}` }, 404)
}

// ── POST ──────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest, ctx: RouteContext) {
  const { path } = await ctx.params
  const [resource, subpath] = path

  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* non-JSON or empty body — ignore */ }

  // POST /leads/add → create all submitted leads (uploadLeads)
  if (resource === 'leads' && subpath === 'add') {
    const leads = (body.leads as Array<{ email: string }>) ?? []
    return json({
      status: 'ok',
      leads_uploaded: leads.length,
      created_leads: leads.map((l, i) => ({
        id: `mock-lead-${i}-${Date.now()}`,
        email: l.email,
      })),
      in_blocklist: 0,
      duplicated_leads: 0,
      invalid_email_count: 0,
      incomplete_count: 0,
    })
  }

  // POST /leads/list → empty list (lead status scan in polling, process-reply lead lookup)
  if (resource === 'leads' && subpath === 'list') {
    return json({ items: [], pagination: {} })
  }

  // POST /dfy-email-account-orders → valid quote (simulate=true only;
  // real orders are blocked before the API call when flag is off)
  if (resource === 'dfy-email-account-orders') {
    const items = (body.items as Array<{ domain: string }>) ?? []
    return json({
      order_placed: false,
      order_is_valid: true,
      total_price: items.length * 35,  // $35/domain — realistic mock price
    })
  }

  // POST /emails/reply → success with mock message ID (sendThreadReply)
  if (resource === 'emails' && subpath === 'reply') {
    return json({ id: `mock-message-${Date.now()}` })
  }

  return json({ error: `Mock: unhandled POST /${path.join('/')}` }, 404)
}

// ── PATCH ─────────────────────────────────────────────────────────────────────

export async function PATCH(_req: NextRequest, ctx: RouteContext) {
  const { path } = await ctx.params
  const [resource, id] = path

  // PATCH /campaigns/:id → success (syncSequenceShell)
  if (resource === 'campaigns' && id) {
    return json({
      id,
      updated_at: new Date().toISOString(),
    })
  }

  // PATCH /leads/:id → success (suppressLead in reply-actions)
  if (resource === 'leads' && id) {
    return json({ id, lt_interest_status: -1 })
  }

  return json({ error: `Mock: unhandled PATCH /${path.join('/')}` }, 404)
}
