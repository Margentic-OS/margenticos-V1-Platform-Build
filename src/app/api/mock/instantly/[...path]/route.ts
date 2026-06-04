// src/app/api/mock/instantly/[...path]/route.ts
//
// HTTP wrapper around the in-process Instantly mock for manual curl testing.
// NO production code path calls this route — all mock dispatch is in-process
// via mock-dispatch.ts. This route exists only so you can curl it manually
// to verify mock shapes during development.
//
// Example: curl https://app.margenticos.com/api/mock/instantly/campaigns/test-id

import { NextRequest, NextResponse } from 'next/server'
import {
  mockCampaignAnalytics,
  mockCampaignGet,
  mockCampaignPatch,
  mockLeadsAdd,
  mockLeadsList,
  mockDfyOrder,
  mockLeadPatch,
  mockEmailReply,
  mockEmailsList,
  mockEmailGet,
} from '@/lib/integrations/handlers/instantly/mock-dispatch'

type RouteContext = { params: Promise<{ path: string[] }> }

function notFound(path: string[]) {
  return NextResponse.json({ error: `Mock: unhandled /${path.join('/')}` }, { status: 404 })
}

// Convert mock-dispatch Response to NextResponse
async function toNext(r: Response) {
  const data = await r.json()
  return NextResponse.json(data, { status: r.status })
}

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(_req: NextRequest, ctx: RouteContext) {
  const { path } = await ctx.params
  const [resource, id] = path

  if (resource === 'campaigns' && id === 'analytics') return toNext(mockCampaignAnalytics())
  if (resource === 'campaigns' && id) return toNext(mockCampaignGet(id))
  if (resource === 'emails' && id) return toNext(mockEmailGet(id))
  if (resource === 'emails') return toNext(mockEmailsList())

  return notFound(path)
}

// ── POST ──────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest, ctx: RouteContext) {
  const { path } = await ctx.params
  const [resource, subpath] = path

  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* empty body */ }

  if (resource === 'leads' && subpath === 'add') {
    const leads = (body.leads as Array<{ email: string }>) ?? []
    return toNext(mockLeadsAdd(leads))
  }
  if (resource === 'leads' && subpath === 'list') return toNext(mockLeadsList())
  if (resource === 'dfy-email-account-orders') {
    const items = (body.items as Array<{ domain: string }>) ?? []
    return toNext(mockDfyOrder(items))
  }
  if (resource === 'emails' && subpath === 'reply') return toNext(mockEmailReply())

  return notFound(path)
}

// ── PATCH ─────────────────────────────────────────────────────────────────────

export async function PATCH(_req: NextRequest, ctx: RouteContext) {
  const { path } = await ctx.params
  const [resource, id] = path

  if (resource === 'campaigns' && id) return toNext(mockCampaignPatch(id))
  if (resource === 'leads' && id) return toNext(mockLeadPatch(id))

  return notFound(path)
}
