// Generated 2026-05-23. Static snapshot. Re-generate if code has moved.
window.MAP_DATA = {
  generatedAt: '2026-05-23',

  systemState: {
    capabilitiesConnected: false,
    instantlyApiActive: false,
    instantlyApiMode: 'mock',
    apolloApiActive: false,
    note: 'Every capability in integrations_registry shows connection_status: disconnected as of 2026-05-23. Platform is in full sandbox mode pending Costa Rica subscriptions activation.',
  },

  notableFindings: [
    {
      title: 'Tool-agnostic capability layer is unwired',
      plain: 'capability.ts is the intended switchboard for all external tool actions — the architectural heart of ADR-001. The handlers map at line 31 is empty. Every real Instantly call bypasses this file and goes directly from individual handler files. The architecture is correct; the wiring is unfinished. Nothing in the live codebase calls executeCapability() for a real operation.',
      cite: 'src/lib/handlers/capability.ts:31',
    },
    {
      title: 'Two prospect research agents coexist',
      plain: 'prospect-research-agent.ts (v1) uses a sequential source chain. prospect-research-agent-v2.ts runs all four sources in parallel via Promise.all() and is the active, ADR-confirmed version. v1 has not been deleted. Any new hire will be confused about which is active. Delete v1 once v2 is confirmed stable post client zero.',
      cite: 'src/lib/agents/prospect-research-agent.ts AND src/lib/agents/prospect-research-agent-v2.ts',
    },
    {
      title: 'ADR-017 is dead architecture',
      plain: 'ADR-017 specifies a sourced_tier column driving three enrichment tiers and separate sending domain pools. None of it was built. The actual branching at compose-sequence.ts:422 uses has_dateable_signal + signal_relevance — two different fields. The sourced_tier column does not exist on prospects. ADR-017 was updated May 2026 to document this; pre-c1 decision needed: reconcile the ADR or build the column.',
      cite: 'src/lib/composition/compose-sequence.ts:422',
    },
  ],

  clusters: [
    { id: 'surfaces',   label: 'Operator & Client surfaces',         color: '#4ea1ff', x: 40,   y: 80, w: 340, h: 1560 },
    { id: 'api-routes', label: 'API routes',                         color: '#7bd389', x: 420,  y: 80, w: 340, h: 1960 },
    { id: 'agents',     label: 'Agents & Orchestrators',             color: '#c792ea', x: 800,  y: 80, w: 340, h: 1360 },
    { id: 'capability', label: 'Capability layer (ADR-001)',         color: '#f5b942', x: 1180, y: 80, w: 340, h: 1160 },
    { id: 'database',   label: 'Database',                           color: '#ffb86b', x: 1560, y: 80, w: 340, h: 1360 },
    { id: 'external',   label: 'External services + email templates',color: '#ff6b9d', x: 1940, y: 80, w: 340, h: 1560 },
  ],

  nodes: [

    // ─── CLUSTER 1: Operator & Client surfaces ──────────────────────────────────

    {
      id: 'login-page', cluster: 'surfaces',
      label: 'login/page.tsx', sub: 'Magic link auth',
      x: 70, y: 180, w: 280, h: 80, color: 'service',
      role: 'Login page for both operators and clients — sends a Supabase magic link email; no password.',
      plain: 'The login screen. You enter your email and Supabase sends a one-click link. No password. Both Doug and clients use the same page. After clicking the link, auth/callback/route.ts finishes the session handshake and redirects to the dashboard.',
      path: 'src/app/login/page.tsx',
      notes: ['Redirect target comes from next= query param; open-redirect guard requires value to start with /', 'Magic link model — Supabase OTP, no password field'],
      whatCanBreak: ['Supabase Site URL was previously set to localhost — magic links redirected to a machine that does not exist. Fixed 2026-05-04. If links stop working, verify Supabase dashboard → Authentication → URL Configuration is set to https://app.margenticos.com', 'OTP rate limit shows the same "Something went wrong" as a real auth failure — operator may keep requesting links and deepen the lockout. Fix: parse the error code in src/app/login/actions.ts and show "Too many requests — wait a few minutes" (BACKLOG BL-LOGIN, pre-c1)', 'NEXT_PUBLIC_SUPABASE_ANON_KEY missing from Vercel env — page renders but magic link never sends'],
      tag: ['all'],
    },

    {
      id: 'intake-page', cluster: 'surfaces',
      label: 'intake/page.tsx', sub: 'Client intake form — CRITICAL',
      x: 70, y: 280, w: 280, h: 80, color: 'service',
      critical: true,
      role: 'Client-facing intake questionnaire; triggers all four strategy agents when 80% of critical fields are answered.',
      plain: 'Where the client fills in their strategy inputs — target customer, offer, writing samples, company URL. A Done button appears when 80% of critical questions are answered. Clicking it calls /api/intake/complete which fires all four strategy agents in the background while the client\'s screen immediately confirms receipt.',
      path: 'src/app/intake/page.tsx',
      notes: ['Completeness check is client-side (shows Done button) AND server-side (/api/intake/complete re-verifies before firing agents)', 'File uploads accept PDF/DOCX/TXT/MD up to 10MB; text extracted at upload time by /api/intake/files/upload'],
      whatCanBreak: ['Done button appears but POST to /api/intake/complete fails — check browser console for 401 (not authenticated) or 400 (server-side threshold re-check failed)', 'Website fetch fires on company_url blur — if the site is behind Cloudflare it may return empty silently; agents proceed with less context, no error surfaces'],
      tag: ['overview', 'all'],
    },

    {
      id: 'dashboard-home', cluster: 'surfaces',
      label: 'dashboard/page.tsx', sub: 'Client home',
      x: 70, y: 380, w: 280, h: 80, color: 'service',
      role: 'Client home — renders IntakeIncompleteState, StrategyInReviewState, or DocumentsActiveState depending on org progress.',
      plain: 'What the client sees when they log in. Three possible states: intake not yet complete, agents are running and documents are being written, or documents are approved and live. The pipeline view is hidden for the first 2 months (ADR-008).',
      path: 'src/app/dashboard/page.tsx',
      notes: ['Three empty-state components: IntakeIncompleteState, StrategyInReviewState, DocumentsActiveState', 'Pipeline view unlocks after 2 months elapsed OR 5 meetings booked'],
      whatCanBreak: ['Client sees blank page — NEXT_PUBLIC_SUPABASE_URL missing, or the users table has no row for this auth.users ID (indicates a handle_new_user trigger failure)', 'DocumentsActiveState shows "in progress" indefinitely — check agent_runs for this org in operator/activity; if all four show completed but setup_status.documents is not "complete", the setup_status JSONB on organisations may not have been updated'],
      tag: ['all'],
    },

    {
      id: 'strategy-view', cluster: 'surfaces',
      label: 'dashboard/strategy/[type]/page.tsx', sub: 'Client strategy view — CRITICAL',
      x: 70, y: 480, w: 280, h: 80, color: 'service',
      critical: true,
      role: 'Client-facing renderer for an approved strategy document (icp | positioning | tov | messaging); reads strategy_documents where status = active.',
      plain: 'Where clients read their approved strategy documents. Document type comes from the URL. When Doug approves a suggestion, the document here updates immediately. Only status = "active" rows are shown — never "pending" or "archived".',
      path: 'src/app/dashboard/strategy/[type]/page.tsx',
      notes: ['Messaging content is a bare JSON array, not an object (ADR-012) — renderer must check Array.isArray(content) before any key lookup', 'Valid [type] values: icp | positioning | tov | messaging'],
      whatCanBreak: ['Page shows empty — query strategy_documents for this org + document_type + status=\'active\'; if no row exists, the agent has not run yet or the approval failed partway through', 'Messaging document renders blank — if renderer checks content.emails instead of content[0], it returns undefined; the content column stores a bare JSON array for messaging only (see ADR-012)', 'Query using status=\'approved\' instead of status=\'active\' returns zero rows silently — this exact bug was fixed in prospect-research-agent.ts (BACKLOG DONE 2026-04-22)'],
      tag: ['overview', 'all'],
    },

    {
      id: 'pipeline-page', cluster: 'surfaces',
      label: 'dashboard/pipeline/page.tsx', sub: 'Pipeline metrics (phased unlock)',
      x: 70, y: 580, w: 280, h: 80, color: 'service',
      role: 'Client pipeline metrics (meetings booked, reply rate, momentum); locked for the first 2 months per ADR-008.',
      plain: 'Shows pipeline results — meetings booked, reply rate, send momentum. Deliberately hidden for the first two months to avoid showing low early numbers while campaigns warm up. Unlocks after 2 months elapsed or 5 meetings booked, whichever comes first.',
      path: 'src/app/dashboard/pipeline/page.tsx',
      notes: ['StatsRow reply rate reads from campaigns.sent_count / replied_count — migration 20260505_campaigns_sent_count.sql, confirmed applied 2026-05-22', 'Trend line visible after 8 weeks of data; dominant at 12 weeks'],
      whatCanBreak: ['Page stays locked after 2 months — check organisations.created_at is set correctly and the unlock calculation in the server component', 'StatsRow reply rate shows 0% even with active campaigns — confirm campaigns.external_id is set for each Instantly campaign; stats cron cannot update a row it cannot find'],
      tag: ['all'],
    },

    {
      id: 'benchmarks-page', cluster: 'surfaces',
      label: 'dashboard/benchmarks/page.tsx', sub: 'Campaign benchmarks',
      x: 70, y: 680, w: 280, h: 80, color: 'service',
      role: 'Benchmarks page comparing client campaign metrics against Instantly 2025 and Belkins 2025 industry norms.',
      plain: 'Shows how the client\'s results compare to industry averages — reply rate, bounce rate, meeting rate, positive reply rate. Benchmark targets are TypeScript constants in tier1-benchmarks.ts. Client numbers come from the campaigns table.',
      path: 'src/app/dashboard/benchmarks/page.tsx',
      notes: ['BENCHMARKS_LAST_UPDATED = \'May 2026\' in src/lib/benchmarks/tier1-benchmarks.ts — refresh when Instantly/Belkins publish new annual reports (target: January/February)', 'Spam complaint rate excluded — Instantly analytics endpoint does not return it (phase 2)'],
      whatCanBreak: ['All metrics show zero — campaigns table has no rows with sent_count > 0; check whether instantly-poll cron is running and campaigns.external_id is populated', 'Open rate is absent by design — excluded due to Apple Mail Privacy Protection making it unreliable (ADR decision, not a bug)'],
      tag: ['all'],
    },

    {
      id: 'approvals-page', cluster: 'surfaces',
      label: 'dashboard/approvals/page.tsx', sub: 'Document approval queue — CRITICAL',
      x: 70, y: 780, w: 280, h: 80, color: 'service',
      critical: true,
      role: 'Operator-only page listing all pending document_suggestions; approve promotes to strategy_documents, reject discards.',
      plain: 'Where Doug reviews and approves strategy documents before clients can see them. When agents finish, their output lands here. Approving calls /api/suggestions/[id]/approve which runs an atomic Postgres transaction. Only operators can access this page.',
      path: 'src/app/dashboard/approvals/page.tsx',
      notes: ['Reads document_suggestions where status = \'pending\'', 'Auto-approve fires after organisations.auto_approve_window_hours (default 72h) via /api/cron/auto-approve pg_cron job'],
      whatCanBreak: ['Queue empty but agents show completed in activity log — check document_suggestions table directly; if no pending row exists, the agent hit an error after the LLM call but before the DB insert; check agent_runs.error_message', 'Suggestion auto-approved before review — check organisations.auto_approve_window_hours; pg_cron auto-approve job fires hourly'],
      tag: ['overview', 'all'],
    },

    {
      id: 'operator-home', cluster: 'surfaces',
      label: 'dashboard/operator/page.tsx', sub: 'Operator home — all clients',
      x: 70, y: 880, w: 280, h: 80, color: 'service',
      role: 'Operator home listing all client organisations with intake and document status at a glance.',
      plain: 'Doug\'s home screen. Shows every client and where each is in the process — intake done? Documents approved? Campaigns running? Clicking a client goes to the detailed client view. Operator-only via layout.tsx role gate.',
      path: 'src/app/dashboard/operator/page.tsx',
      notes: ['Renders AllClientsView which queries organisations joined to agent_runs counts', 'operator/layout.tsx enforces role = operator on all routes under this path'],
      whatCanBreak: ['Page shows no clients — check the organisations table has rows and that the logged-in user has role = \'operator\' in the users table', 'Client missing from list — check organisations table directly in Supabase dashboard; a failed RLS policy could hide rows from the operator query'],
      tag: ['all'],
    },

    {
      id: 'operator-client-detail', cluster: 'surfaces',
      label: 'operator/clients/[id]/page.tsx', sub: 'Operator client detail',
      x: 70, y: 980, w: 280, h: 80, color: 'service',
      role: 'Operator control panel for one client: DFY mailbox order, lead upload, campaign registration, setup status panels.',
      plain: 'Doug\'s control panel for a single client. From here: order pre-warmed mailboxes (calls orderMailboxes handler), upload a prospect list to Instantly (calls uploadLeads handler), register an Instantly campaign UUID so polling can link events to this client, and view setup status. All actions are operator-only.',
      path: 'src/app/dashboard/operator/clients/[id]/page.tsx',
      notes: ['MailboxOrderPanel: simulate=true for a price quote, simulate=false places a real order (real money) — safety gate in orderMailboxes.ts:55 blocks real orders when instantly_api_active=false', 'LeadUploadPanel: only processes prospects with outbound_upload_status=\'pending\'; skip_if_in_campaign=true deduplicates at Instantly\'s end'],
      whatCanBreak: ['Lead upload button disabled — no prospects have outbound_upload_status=\'pending\' for this org, or instantly_api_active feature flag is false in integrations_registry', 'Mailbox order appears to succeed but no mailbox arrives — instantly_api_active=false blocks real orders even when simulate=false; check the feature flag row in integrations_registry', 'Campaign registration UUID not found — UUID belongs to a different Instantly account than the API key in integration_credentials'],
      tag: ['all'],
    },

    {
      id: 'operator-triage', cluster: 'surfaces',
      label: 'operator/triage/page.tsx', sub: 'Reply draft triage (mock path)',
      x: 70, y: 1080, w: 280, h: 80, color: 'service',
      mock: true,
      role: 'Operator triage queue listing reply_drafts with status pending_review; approve sends the draft via Instantly, reject discards.',
      plain: 'Where Doug reviews AI-written reply drafts before they are sent. A draft lands here when a prospect replies to an outbound email and the classifier routes it to Tier 2 (AI can draft) or Tier 3 (manual required). This entire path is built but not yet running against live campaigns.',
      path: 'src/app/dashboard/operator/triage/page.tsx',
      notes: ['Tier badge: Tier 2 = AI-drafted, Tier 3 = manual required — shown on each DraftCard', 'Queue only populates once real Instantly campaigns produce reply signals'],
      whatCanBreak: ['Queue always empty — check signals table for reply_received rows with processed=false; if no signals exist, the instantly-poll cron is not running or campaigns.external_id is not set', 'Draft approve returns 500 — send-approved-draft needs organisations.founder_first_name and organisations.calendly_url to be set; check those two columns'],
      tag: ['all'],
    },

    {
      id: 'operator-faqs', cluster: 'surfaces',
      label: 'operator/faqs/page.tsx', sub: 'FAQ curation',
      x: 70, y: 1180, w: 280, h: 80, color: 'service',
      role: 'Operator page for reviewing FAQ extraction candidates; approved entries enter the matcher to auto-populate future Tier 2 drafts.',
      plain: 'After a Tier 3 reply is handled manually, the faq-extraction-agent tries to capture the Q&A as a reusable FAQ. Those candidates land here. Approving one adds it to the live FAQ library. Over time a larger FAQ library means fewer Tier 3 manual replies — the system gets smarter per client.',
      path: 'src/app/dashboard/operator/faqs/page.tsx',
      notes: ['faq_extractions (pending) → faqs (approved) via approve_new or approve_merge (append_faq_variant function)', 'filler-detection.ts pre-flight skips obvious non-extractable text before the Haiku call'],
      whatCanBreak: ['No extractions appear — check whether send-orchestrator is firing extractFaq() for Tier 3 sends; also check whether filler-detection gate is skipping all replies', 'approve-merge fails with FK violation — the similar_faq_id on the extraction row points to a faq that was deleted; use approve-new instead'],
      tag: ['all'],
    },

    {
      id: 'operator-activity', cluster: 'surfaces',
      label: 'operator/activity/page.tsx', sub: 'Agent activity log',
      x: 70, y: 1280, w: 280, h: 80, color: 'service',
      role: 'Operator page showing recent agent_runs across all clients: name, status, timestamps, output summary or error.',
      plain: 'A log of every agent run across all clients — success, failure, or still running. First place to look when strategy documents seem stuck or missing. Cross-org query is intentional for operator context (ADR-021 comment in page code).',
      path: 'src/app/dashboard/operator/activity/page.tsx',
      notes: ['Cross-org agent_runs query intentional for operator — ADR-021 comment in page code documents this', 'output_summary falls back to error_message for failed runs'],
      whatCanBreak: ['Page shows no activity — agent_runs table is empty; agents have never fired, or the after() dispatch in intake/complete timed out before any agent route received the call', 'Run shows "running" indefinitely — the agent invocation timed out silently; check whether document_suggestions row was written for this org'],
      tag: ['all'],
    },

    {
      id: 'operator-signals', cluster: 'surfaces',
      label: 'operator/signals/page.tsx', sub: 'Signals log',
      x: 70, y: 1380, w: 280, h: 80, color: 'service',
      role: 'Operator page showing the signals table: all campaign events (replies, bounces, unsubscribes) with signal type, prospect, and raw data.',
      plain: 'The feed of every event from campaigns — replies, bounces, unsubscribes. If the triage queue is empty but you expect replies, check here first to confirm the polling cron is working at all. A signal with processed=false means the process-replies cron has not handled it yet.',
      path: 'src/app/dashboard/operator/signals/page.tsx',
      notes: ['Reads signals joined to organisations and prospects, limit 200, ordered created_at DESC', 'SignalsLogView handles all 17 SignalType enum values'],
      whatCanBreak: ['No signals — instantly-poll cron not running, or campaigns.external_id is NULL for all active Instantly campaigns (signals cannot be linked to an org without this)', 'Signals stuck at processed=false — process-replies cron not running or failing; check Sentry for "Instantly poll: reply polling threw" errors'],
      tag: ['all'],
    },

    {
      id: 'operator-settings', cluster: 'surfaces',
      label: 'operator/settings/page.tsx', sub: 'Operator settings',
      x: 70, y: 1480, w: 280, h: 80, color: 'service',
      role: 'Operator settings page; SettingsView component currently renders partially hardcoded mock data for integrations.',
      plain: 'Shows integration connection status and org configuration. The integrations list is currently mock data — it shows placeholder tool names and fake connection dates, not live data from integrations_registry. Must be wired to real data before a paying client is onboarded.',
      path: 'src/app/dashboard/operator/settings/page.tsx',
      notes: ['SettingsView.tsx integrations display lines 31-35 are hardcoded mock data — pre-c1 fix: replace with live integrations_registry query', 'SettingsView.tsx:188 contains "configured directly in Instantly" — ADR-001 violation (BACKLOG BL-ADR001, pre-c1)'],
      whatCanBreak: ['Settings page shows orgName "Apex Consulting" — that is the PLACEHOLDER_SETTINGS hardcoded value, not a real client; the component is not yet reading live data', 'Integration status always shows "connected" regardless of reality — same hardcoded mock data issue'],
      tag: ['all'],
    },


    // ─── CLUSTER 2: API routes ───────────────────────────────────────────────────

    {
      id: 'route-intake-complete', cluster: 'api-routes',
      label: '/api/intake/complete', sub: 'POST · CRITICAL',
      x: 450, y: 180, w: 280, h: 80, color: 'route',
      critical: true,
      role: 'POST route that atomically claims agent dispatch and fires all four strategy agents via Next.js after(); returns 202 immediately.',
      plain: 'The trigger. When the intake form\'s Done button is clicked, this runs. It immediately responds "got it" so the screen does not hang, then fires four AI agents in the background. A database lock on organisations.agents_dispatched_at means this can only fire once per client — clicking twice or refreshing does not run eight agents.',
      path: 'src/app/api/intake/complete/route.ts:34',
      notes: ['line:62 — atomic UPDATE WHERE agents_dispatched_at IS NULL; zero rows returned = already dispatched, returns 200 already_dispatched', 'line:144 — Promise.all dispatches all four agent routes with an 8s AbortController timeout; a timeout only means dispatch was received, not that the agent failed'],
      whatCanBreak: ['NEXT_INTERNAL_SECRET missing from Vercel env — agents receive the fetch but return 401 because the x-internal-secret header is empty; agents_dispatched_at is already stamped locking the client from re-triggering (BACKLOG BL-ORPHAN, pre-c1: needs an operator reset route)', 'All four agent dispatches fail silently (cold-start timeout) — agents_dispatched_at is stamped, no agents ran, no error in Sentry; check agent_runs for this org — zero rows means this happened', 'RESEND_OPERATOR_EMAIL not set — intake-complete notification email silently skipped; agents still run'],
      tag: ['overview', 'all'],
    },

    {
      id: 'route-agents-icp', cluster: 'api-routes',
      label: '/api/agents/icp', sub: 'POST · CRITICAL',
      x: 450, y: 280, w: 280, h: 80, color: 'route',
      critical: true,
      role: 'POST route that accepts operator session or x-internal-secret, runs runIcpGenerationAgent(), and sends the all-docs-generated email when all four agents are done.',
      plain: 'The ICP agent\'s entry door. Accepts calls from an operator clicking a button (requires operator role) or from the automated intake/complete dispatch (verified by internal secret header). Runs the ICP agent, logs to agent_runs, and — once all four agents are done — sends an email to notify the operator that documents are ready for review.',
      path: 'src/app/api/agents/icp/route.ts:84',
      notes: ['line:39 — AGENT_NAMES list used for all-docs-complete check: [icp-generation, positioning-generation, tov-generation, messaging-generation]', 'line:59 — atomic UPDATE WHERE docs_complete_notification_sent_at IS NULL prevents duplicate emails when all four agents finish near-simultaneously'],
      whatCanBreak: ['ANTHROPIC_API_KEY not set in Vercel — agent throws at Anthropic client init inside icp-generation-agent.ts:436 and logs to Sentry; no suggestion row is written', 'agent_runs shows completed but document_suggestions has no row — error occurred after the LLM call but before the DB insert; check agent_runs.error_message for a JSON parse error or DB insert failure', 'All-docs email sent multiple times — should not happen due to IS NULL guard; if it does, check for a clock skew issue in the Supabase UPDATE timing'],
      tag: ['overview', 'agents', 'all'],
    },

    {
      id: 'route-agents-positioning', cluster: 'api-routes',
      label: '/api/agents/positioning', sub: 'POST · CRITICAL',
      x: 450, y: 380, w: 280, h: 80, color: 'route',
      critical: true,
      role: 'POST route that accepts operator session or x-internal-secret and runs runPositioningGenerationAgent().',
      plain: 'Entry door for the Positioning agent. Same authentication model as the ICP route — operator session or internal secret. Same all-docs-complete participation. See icp route notes; the pattern is identical for all four document agent routes.',
      path: 'src/app/api/agents/positioning/route.ts',
      notes: ['Same auth model as /api/agents/icp', 'Model: claude-opus-4-6 (POSITIONING_MODEL at positioning-generation-agent.ts:25)'],
      whatCanBreak: ['ANTHROPIC_API_KEY not set — throws at client init in positioning-generation-agent.ts', 'Agent fails and agents_dispatched_at prevents re-trigger — use the Regenerate button on the approvals page to re-run this specific agent without resetting the full dispatch guard'],
      tag: ['agents', 'all'],
    },

    {
      id: 'route-agents-tov', cluster: 'api-routes',
      label: '/api/agents/tov', sub: 'POST · CRITICAL',
      x: 450, y: 480, w: 280, h: 80, color: 'route',
      critical: true,
      role: 'POST route that accepts operator session or x-internal-secret and runs runTovGenerationAgent(); reads voice samples from both pasted text and uploaded files.',
      plain: 'Entry door for the Tone of Voice agent. Same auth model as the other agent routes. This agent is notable for reading from two sources: the pasted voice_samples text field in the intake form, AND any uploaded writing sample files. Both are merged before the LLM call.',
      path: 'src/app/api/agents/tov/route.ts',
      notes: ['TOV agent reads intake_files with file_purpose=\'voice_sample\' in addition to the voice_samples text field', 'Model: claude-opus-4-6 (TOV_MODEL at tov-generation-agent.ts:34)'],
      whatCanBreak: ['Uploaded writing samples not reflected in TOV output — check intake_files table: were rows inserted with file_purpose=\'voice_sample\' for this org? If upload failed silently, agent ran with only the text field', 'ANTHROPIC_API_KEY not set — same failure as ICP route'],
      tag: ['agents', 'all'],
    },

    {
      id: 'route-agents-messaging', cluster: 'api-routes',
      label: '/api/agents/messaging', sub: 'POST · CRITICAL',
      x: 450, y: 580, w: 280, h: 80, color: 'route',
      critical: true,
      role: 'POST route that runs runMessagingGenerationAgent(); generates four email sequence variants; currently uses claude-sonnet-4-6 as a local-dev workaround (should be opus).',
      plain: 'Entry door for the Messaging agent. Generates four complete email sequence variants at once — each covers the same offer from a different angle. All four go through approval together. Currently using claude-sonnet-4-6 instead of opus because Opus connections timed out on a home network during development. Must be retested on a wired connection and reverted to Opus before paying clients.',
      path: 'src/app/api/agents/messaging/route.ts',
      notes: ['MESSAGING_MODEL = \'claude-sonnet-4-6\' at messaging-generation-agent.ts:29 — ADR-013 says revert to opus-4-6 when streaming works stable on production', 'MAX_TOKENS = 16384 (messaging-generation-agent.ts:32) — four variants require double the token budget of other agents'],
      whatCanBreak: ['Output truncated mid-JSON — four variants may still hit the 16384 ceiling; agent logs a JSON parse error in agent_runs.error_message', 'claude-opus-4-6 timeout if reverted — original failure was 180s idle TCP timeout on home router; test on Vercel production before committing to Opus for paying clients', 'ANTHROPIC_API_KEY not set — same failure as other agent routes'],
      tag: ['agents', 'all'],
    },

    {
      id: 'route-suggestions-approve', cluster: 'api-routes',
      label: '/api/suggestions/[id]/approve', sub: 'POST · CRITICAL',
      x: 450, y: 680, w: 280, h: 80, color: 'route',
      critical: true,
      role: 'POST route that promotes a pending document suggestion into an active strategy document via the approve_document_suggestion Postgres function.',
      plain: 'The button press that makes a suggestion real. Three checks on every request: logged in, operator role, suggestion still pending. Then a Postgres function runs a transaction — archives the old document version, writes the new version as active, marks the suggestion approved. If any step fails, the whole thing rolls back and the suggestion stays pending.',
      path: 'src/app/api/suggestions/[id]/approve/route.ts:1',
      notes: ['line:55 — operator role checked on every request via users table lookup, not cached from login session', 'line:101 — calls approve_document_suggestion RPC; if the function throws, suggestion stays pending and strategy_documents is unchanged'],
      whatCanBreak: ['SUPABASE_SERVICE_ROLE_KEY wrong or missing — returns 500 on every approval; check Vercel env vars', 'approve_document_suggestion returns an error — check Supabase function logs for which step (archive old, insert new, or update suggestion) failed; suggestion stays pending', 'User role is not "operator" — returns 403; verify the users table row has role=\'operator\' for this user'],
      tag: ['overview', 'all'],
    },

    {
      id: 'route-suggestions-reject', cluster: 'api-routes',
      label: '/api/suggestions/[id]/reject', sub: 'POST',
      x: 450, y: 780, w: 280, h: 80, color: 'route',
      role: 'POST route that marks a document suggestion rejected; strategy_documents is not touched.',
      plain: 'When Doug clicks Reject on a suggestion, this marks it rejected in document_suggestions. The strategy document is not changed. The client can request a regeneration from the approvals page.',
      path: 'src/app/api/suggestions/[id]/reject/route.ts',
      notes: ['Sets document_suggestions.status = \'rejected\'', 'Operator role required — same three-check pattern as approve route'],
      whatCanBreak: ['Suggestion stays pending after rejection — DB update failed; check SUPABASE_SERVICE_ROLE_KEY', 'Rejected suggestion reappears — auto-approve cron may have fired between rejection and page refresh if the window was already met; check organisations.auto_approve_window_hours'],
      tag: ['all'],
    },

    {
      id: 'route-suggestions-regenerate', cluster: 'api-routes',
      label: '/api/suggestions/regenerate', sub: 'POST',
      x: 450, y: 880, w: 280, h: 80, color: 'route',
      role: 'POST route that re-triggers a specific document generation agent after a rejection without resetting agents_dispatched_at.',
      plain: 'After Doug rejects a suggestion he can request a fresh attempt. This re-fires the specific agent route (by document_type) without touching the intake dispatch guard. The new suggestion lands in the approval queue.',
      path: 'src/app/api/suggestions/regenerate/route.ts',
      notes: ['Does not reset organisations.agents_dispatched_at — only re-triggers the one specified agent', 'Operator only'],
      whatCanBreak: ['Agent fires but writes a second pending row alongside the rejected one — approve the new one; both are visible in the queue', 'Route returns 400 for unrecognised document_type — valid values are icp | positioning | tov | messaging (exact lowercase match)'],
      tag: ['all'],
    },

    {
      id: 'route-cron-poll', cluster: 'api-routes',
      label: '/api/cron/instantly-poll', sub: 'POST · pg_cron 15 min',
      x: 450, y: 980, w: 280, h: 80, color: 'route',
      role: 'pg_cron-triggered route that polls Instantly for new replies, bounced leads, and unsubscribed leads; writes signal rows to the signals table.',
      plain: 'Every 15 minutes, pg_cron calls this route. It polls Instantly for three types of events: new email replies, bounced leads, unsubscribed leads. Each event found gets written as a raw row to the signals table. A separate cron (process-replies) picks those signals up and decides what to do with them.',
      path: 'src/app/api/cron/instantly-poll/route.ts',
      notes: ['CRON_SECRET header required — must match env var CRON_SECRET; returns 401 if missing', 'INSTANTLY_LEAD_STATUS_BOUNCED=\'-2\' and INSTANTLY_LEAD_STATUS_UNSUBSCRIBED=\'-1\' at polling/instantly.ts:37-38 are UNVERIFIED against the live API (BACKLOG BL-PC0-3)'],
      whatCanBreak: ['INSTANTLY_LEAD_STATUS_BOUNCED or UNSUBSCRIBED constants wrong — zero bounce/unsubscribe signals with no error; only verifiable with a live bounced lead from an active campaign', 'campaigns.external_id not set for an Instantly campaign — every polling event from that campaign is silently dropped (no org_id to write the signal to); requires a manual INSERT into campaigns before launching any campaign', 'INSTANTLY_API_KEY not in integration_credentials — getInstantlyApiKey() throws; entire poll fails; check for a row with source=\'instantly\', credential_type=\'api_key\', organisation_id IS NULL'],
      tag: ['all'],
    },

    {
      id: 'route-cron-replies', cluster: 'api-routes',
      label: '/api/cron/process-replies', sub: 'POST · pg_cron 5 min',
      x: 450, y: 1080, w: 280, h: 80, color: 'route',
      mock: true,
      role: 'pg_cron-triggered route that calls processReplies() to classify and action up to 20 unprocessed reply signals per run.',
      plain: 'Every 5 minutes, pg_cron calls this. It picks up to 20 unprocessed reply signals and classifies each (positive reply? opt-out? out-of-office?) then takes action: send Calendly link, suppress in Instantly, or create a draft for the triage queue. Built but not running against live campaigns yet.',
      path: 'src/app/api/cron/process-replies/route.ts',
      notes: ['BATCH_SIZE = 20 at process-reply.ts:42 — sequential; p-limit concurrency deferred to phase 2 (trigger: >20 unprocessed signals at start of any cron run)', 'CRON_SECRET header required'],
      whatCanBreak: ['Signals accumulate but never process — CRON_SECRET is wrong, or the pg_cron job is not scheduled; check cron.job_run_details in Supabase for the process-replies entry', 'Haiku classifier hits 15s AbortController ceiling — classification returns null; signal retried up to 3 times then marked classifier_failed; check Sentry for "classifier retry limit reached" alerts'],
      tag: ['all'],
    },

    {
      id: 'route-cron-autoapprove', cluster: 'api-routes',
      label: '/api/cron/auto-approve', sub: 'POST · pg_cron (phase 4)',
      x: 450, y: 1180, w: 280, h: 80, color: 'route',
      role: 'pg_cron route that auto-approves pending document suggestions older than organisations.auto_approve_window_hours (default 72h).',
      plain: 'Auto-approves strategy document suggestions that have been sitting in the approval queue longer than the configured window (default 72 hours). Phase 4 feature — route works but is inactive. The Vercel Hobby cron entry was removed because Hobby blocks sub-daily crons; it\'s scheduled via pg_cron instead.',
      path: 'src/app/api/cron/auto-approve/route.ts',
      notes: ['Uses approve_document_suggestion RPC — same atomic function as the manual approve route', 'SYSTEM_AUTO_APPROVE_ID sentinel written to document_suggestions.reviewed_by to distinguish from human approvals'],
      whatCanBreak: ['Route exists but no pg_cron job schedules it — verify with cron.job_run_details; the Vercel Hobby cron entry was intentionally removed (BACKLOG DONE 2026-04-29)', 'Auto-approve fires faster than expected — check organisations.auto_approve_window_hours; it can be set per-org'],
      tag: ['all'],
    },

    {
      id: 'route-reply-drafts-approve', cluster: 'api-routes',
      label: '/api/reply-drafts/[id]/approve', sub: 'POST · mock path · CRITICAL',
      x: 450, y: 1280, w: 280, h: 80, color: 'route',
      critical: true,
      mock: true,
      role: 'POST route that marks a reply_draft approved then immediately calls sendApprovedDraft() to send via Instantly.',
      plain: 'When Doug approves a reply draft from the triage queue, this route runs. It updates the draft status to approved in the DB, then calls the send orchestrator to immediately send the email via Instantly. Two Sentry alert rules watch this path. Built but not running against live data yet.',
      path: 'src/app/api/reply-drafts/[id]/approve/route.ts',
      notes: ['Operator role required', 'If sendApprovedDraft() throws, draft moves to send_failed and Sentry alert fires; it never stays at status=\'approved\''],
      whatCanBreak: ['founder_first_name not set on organisations — sendApprovedDraft throws founder_first_name_required_but_missing; UPDATE organisations SET founder_first_name=\'Doug\' WHERE id=\'<org_id>\'', 'calendly_url not set and {calendly_link} placeholder present in final_sent_body — throws calendly_link_required_but_missing; set organisations.calendly_url', 'db_update_failed_after_send — CRITICAL Sentry alert means the email is in the prospect\'s inbox but the DB row is stuck at approved; requires manual SQL reconciliation'],
      tag: ['all'],
    },

    {
      id: 'route-reply-drafts-reject', cluster: 'api-routes',
      label: '/api/reply-drafts/[id]/reject', sub: 'POST',
      x: 450, y: 1380, w: 280, h: 80, color: 'route',
      role: 'POST route that marks a reply_draft rejected; no email sent.',
      plain: 'When Doug rejects a draft, this marks it rejected. No email is sent to the prospect. If the prospect genuinely needs a reply, it must be sent manually outside the system.',
      path: 'src/app/api/reply-drafts/[id]/reject/route.ts',
      notes: ['Sets reply_drafts.status = \'rejected\'', 'Operator role required'],
      whatCanBreak: ['Draft stays at pending_review — DB update failed; check SUPABASE_SERVICE_ROLE_KEY', 'Rejected draft reappears — UI not filtering by status correctly; query should exclude status=\'rejected\''],
      tag: ['all'],
    },

    {
      id: 'route-reply-drafts-list', cluster: 'api-routes',
      label: '/api/reply-drafts', sub: 'GET',
      x: 450, y: 1480, w: 280, h: 80, color: 'route',
      role: 'GET route returning reply_drafts with status pending_review for the triage queue.',
      plain: 'The triage queue page calls this to load the list of drafts awaiting operator review. Returns pending_review drafts ordered by created_at.',
      path: 'src/app/api/reply-drafts/route.ts',
      notes: ['Filters to status = \'pending_review\' only', 'Operator role required'],
      whatCanBreak: ['Returns empty when drafts exist — check status values; drafts in draft_failed or manual_required state are NOT returned here (separate query needed)', 'Returns 403 — operator role check failing; verify users table role column for this user'],
      tag: ['all'],
    },

    {
      id: 'route-intake-upload', cluster: 'api-routes',
      label: '/api/intake/files/upload', sub: 'POST',
      x: 450, y: 1580, w: 280, h: 80, color: 'route',
      role: 'POST route that validates, uploads a file to Supabase Storage (intake-files bucket), extracts text, and inserts an intake_files row.',
      plain: 'Receives files from the intake form upload section. Validates type and size (10MB max, PDF/DOCX/TXT/MD), uploads to Supabase Storage, extracts text at upload time (pdf-parse for PDF, mammoth for DOCX), records metadata in intake_files table.',
      path: 'src/app/api/intake/files/upload/route.ts',
      notes: ['Text extracted synchronously at upload time — extraction failure is non-fatal; file row inserted with null extracted_text', 'intake-files bucket is private (signed URLs required to download)'],
      whatCanBreak: ['File uploaded but agent ignores it — check intake_files row: does it have the correct file_purpose? TOV agent reads only file_purpose=\'voice_sample\'; ICP reads icp_doc and case_study', 'PDF text extraction fails silently — encrypted or image-only PDFs are not readable by pdf-parse; extraction_error is logged but the file row is still inserted'],
      tag: ['all'],
    },

    {
      id: 'route-intake-website', cluster: 'api-routes',
      label: '/api/intake/website/fetch', sub: 'POST · fires on blur',
      x: 450, y: 1680, w: 280, h: 80, color: 'route',
      role: 'POST route triggered by company_url blur in the intake form; fetches homepage and up to 3 inner pages, stores in intake_website_pages.',
      plain: 'When the client types their company URL and moves to the next field, this fires in the background. Fetches the homepage and up to 3 inner pages (About, Services, Case Studies found by anchor text scoring). ICP, Positioning, and TOV agents all read from intake_website_pages for additional context.',
      path: 'src/app/api/intake/website/fetch/route.ts',
      notes: ['Failures are non-fatal — agents proceed without website context; logged at warn not error', 'Inner page selection uses anchor text scoring, not hardcoded URLs'],
      whatCanBreak: ['Company site is behind Cloudflare or requires JS rendering — returns 403 or empty content silently; agents run with no website context', 'Timeout on slow company sites — partial content may be stored; subsequent agent runs have degraded context'],
      tag: ['all'],
    },

    {
      id: 'route-webhook-users', cluster: 'api-routes',
      label: '/api/webhooks/users-pending-review-notify', sub: 'POST · DB webhook',
      x: 450, y: 1780, w: 280, h: 80, color: 'route',
      role: 'Webhook called by a Supabase DB trigger when a users_pending_review row is inserted; sends operator notification via Resend.',
      plain: 'When someone tries to add a second user to a client account and the system blocks them, a row goes into users_pending_review. A Supabase database webhook calls this route, which emails the operator to say someone tried to join and was blocked.',
      path: 'src/app/api/webhooks/users-pending-review-notify/route.ts',
      notes: ['Triggered by Supabase database webhook on INSERT to users_pending_review', 'Sends multi-user-signup-attempt template via Resend'],
      whatCanBreak: ['Email not received on blocked signup — check whether the Supabase webhook is configured to call the production URL (not a preview URL)', 'Route returns 400 on the webhook call — check whether the users_pending_review row payload shape has changed from what the route expects'],
      tag: ['all'],
    },

    {
      id: 'route-faq-extractions', cluster: 'api-routes',
      label: '/api/operator/faq-extractions/[id]/*', sub: 'POST · approve-new | approve-merge | reject',
      x: 450, y: 1880, w: 280, h: 80, color: 'route',
      role: 'Three POST routes for actioning FAQ extraction candidates: approve-new (add to faqs), approve-merge (append to existing FAQ), reject (discard).',
      plain: 'Three routes for the FAQ curation queue. approve-new creates a new FAQ entry. approve-merge calls the append_faq_variant Postgres function to combine this extraction with an existing FAQ. reject discards the candidate. All require operator role.',
      path: 'src/app/api/operator/faq-extractions/[id]/approve-new/route.ts',
      notes: ['approve-merge calls append_faq_variant Postgres function — similar_faq_id must be non-null', 'append_faq_variant was previously callable by unauthenticated users (P0 security bug fixed in migration 20260521134057_revoke_public_execute_security_fix.sql)'],
      whatCanBreak: ['approve-merge fails with FK violation — similar_faq_id points to a deleted faq; use approve-new instead', 'approve-new writes to faqs but matcher does not pick it up — check that the faq row has is_active=true and the matcher query is not filtering by a different field'],
      tag: ['all'],
    },

  // CHUNK 2 APPENDED BELOW

    // ─── CLUSTER 3: Agents & Orchestrators ──────────────────────────────────────

    {
      id: 'agent-icp', cluster: 'agents',
      label: 'icp-generation-agent.ts', sub: 'claude-opus-4-6 · POST /api/agents/icp',
      x: 830, y: 180, w: 280, h: 80, color: 'agent',
      role: 'Generates the ICP strategy document from intake data; writes a document_suggestions row with type=icp on completion.',
      plain: 'Takes everything the client told you in the intake form and uploaded, then writes the Ideal Customer Profile document. Does not write directly to strategy_documents — writes a suggestion you approve. Uses Claude Opus because ICP quality drives everything downstream.',
      path: 'src/agents/icp-generation-agent.ts',
      notes: [
        'Model: claude-opus-4-6 (ADR-013). Explicit model version must be passed — never rely on API defaults.',
        'Called by POST /api/agents/icp fired as a background job from /api/intake/complete via after()',
        'Route uses an 8s AbortController timeout — tight for cold starts (see route-intake-complete)',
        'ANTHROPIC_API_KEY checked at line 436 — throws immediately if missing',
      ],
      whatCanBreak: [
        'Agent never fires — check whether /api/agents/icp received the POST from route-intake-complete; AbortController 8s timeout in Sentry is the most likely cause on cold start',
        'Agent fires but suggestion never appears in approvals queue — check document_suggestions for type=icp and the correct organisation_id; DB insert error will be in Sentry under the agent run',
        'ANTHROPIC_API_KEY not set in Vercel environment — agent throws at startup, not at LLM call; error appears immediately in logs without any LLM usage',
        'Model version string wrong — Anthropic returns 404; confirm model ID is exactly "claude-opus-4-6"',
      ],
      tag: ['all'], critical: true,
    },

    {
      id: 'agent-positioning', cluster: 'agents',
      label: 'positioning-generation-agent.ts', sub: 'claude-opus-4-6 · POST /api/agents/positioning',
      x: 830, y: 280, w: 280, h: 80, color: 'agent',
      role: 'Generates the positioning strategy document from intake data; writes a document_suggestions row with type=positioning.',
      plain: 'Writes the positioning document — how the client is different and why that matters to buyers. Runs after intake completes. The positioning document feeds the messaging agent, so weak positioning means weak emails.',
      path: 'src/agents/positioning-generation-agent.ts',
      notes: [
        'Model: claude-opus-4-6 (ADR-013)',
        'Fired in parallel with ICP, TOV, and messaging agents via Promise.all() in route-intake-complete',
        'Positioning document is a required input to the messaging agent',
      ],
      whatCanBreak: [
        'Positioning suggestion missing after intake — check agent_runs for agent_name=positioning and status=failed; error message in agent_runs.error_message column',
        'Suggestion created but wrong organisation_id — check the client_id parameter passed to the agent; a cross-org write here is a data leak (ADR-003)',
        'Agent times out — the 8s AbortController in route-intake-complete fires before LLM returns; Sentry shows AbortError from the route, not the agent itself',
      ],
      tag: ['all'],
    },

    {
      id: 'agent-tov', cluster: 'agents',
      label: 'tov-generation-agent.ts', sub: 'claude-opus-4-6 · POST /api/agents/tov',
      x: 830, y: 380, w: 280, h: 80, color: 'agent',
      role: 'Generates the tone-of-voice guide from intake data; writes a document_suggestions row with type=tov.',
      plain: 'Writes the tone-of-voice document — how the client talks, what words they use, what their emails should sound like. The messaging agent uses this to make emails actually sound like the client. The reply-draft agent uses it when composing responses.',
      path: 'src/agents/tov-generation-agent.ts',
      notes: [
        'Model: claude-opus-4-6 (ADR-013)',
        'Fired in the same Promise.all() as ICP, positioning, and messaging agents',
        'TOV document is used by reply-draft-agent to match client voice when composing replies',
      ],
      whatCanBreak: [
        'TOV suggestion missing — check agent_runs for agent_name=tov and status=failed',
        'Generated TOV sounds generic — intake data was thin; agent flags this in the document but does not block; manually enrich intake before approving the suggestion',
      ],
      tag: ['all'],
    },

    {
      id: 'agent-messaging', cluster: 'agents',
      label: 'messaging-generation-agent.ts', sub: 'claude-sonnet-4-6 · POST /api/agents/messaging',
      x: 830, y: 480, w: 280, h: 80, color: 'agent',
      role: 'Generates email sequence templates from ICP, positioning, and TOV documents; writes a document_suggestions row with type=messaging containing the full multi-email sequence.',
      plain: 'Takes the three strategy documents and writes the actual cold email sequences — subject lines, bodies, follow-ups. Uses Sonnet not Opus because sequence generation needs speed and iteration. MAX_TOKENS=16384 because full multi-email sequences are long.',
      path: 'src/agents/messaging-generation-agent.ts',
      notes: [
        'Model: claude-sonnet-4-6, MAX_TOKENS: 16384 (lines 29 and 32)',
        'CLAUDE.md note: revert to opus-4-6 when streaming works stable in local dev',
        'Requires ICP, positioning, and TOV as approved strategy_documents before running',
        'Validator enforces subject char limits, word counts, no em dashes — see CLAUDE.md prompt/validator consistency rules',
      ],
      whatCanBreak: [
        'Agent fails with "positioning document not found" — all three strategy docs must be approved before messaging agent runs; approve ICP, positioning, and TOV first',
        'Generated emails fail validator — em dash in body is the most common failure; check that scrubAITells() was called on the output',
        'Email 2 or 3 subject_line is not null — validator rejects; prompt and validator must agree exactly (see CLAUDE.md consistency rules)',
        'MAX_TOKENS=16384 causes higher Anthropic costs — check agent_runs for abnormal token counts if billing spikes',
      ],
      tag: ['all'],
    },

    {
      id: 'agent-prospect-v2', cluster: 'agents',
      label: 'prospect-research-agent-v2.ts', sub: 'ACTIVE · parallel Promise.all()',
      x: 830, y: 580, w: 280, h: 80, color: 'agent',
      role: 'Runs four Apollo-powered prospect sourcing steps in parallel via Promise.all(); active, ADR-confirmed version.',
      plain: 'The active prospect research agent. Runs all four sourcing steps at the same time — faster than v1. Writes results to prospect_research_results then deduplicates into prospects. The v1 version still sits in the same folder and should be deleted (BL-MAP-1).',
      path: 'src/lib/agents/prospect-research-agent-v2.ts',
      notes: [
        'ADR-confirmed active version. v1 (sequential) still present at src/lib/agents/prospect-research-agent.ts — BL-MAP-1',
        'ICP filter spec passed at invocation time; Apollo handler translates canonical industry names to Apollo taxonomy',
        'All four sourcing operations write to prospect_research_results before deduplication into prospects',
      ],
      whatCanBreak: [
        'All sources return empty — APOLLO_API_KEY not set or Apollo account inactive; check integration_credentials for source=apollo',
        'Duplicate prospects in prospects table — deduplication is by email; if Apollo returns same contact from two sources, second INSERT fails with unique constraint violation; check Sentry',
        'Promise.all() throws if any single source throws without catching — verify each sourcing arm catches its own errors and rejects gracefully rather than throwing',
      ],
      tag: ['all'], critical: true,
    },

    {
      id: 'agent-prospect-v1', cluster: 'agents',
      label: 'prospect-research-agent.ts', sub: 'DEAD · sequential · BL-MAP-1',
      x: 830, y: 680, w: 280, h: 80, color: 'agent',
      role: 'Original sequential prospect research agent — superseded by v2; present in codebase but must not be called.',
      plain: 'The old version of the prospect research agent. Runs each source one at a time. Replaced by v2 but not deleted. A new developer would not know which one is real. Marked for deletion in BACKLOG (BL-MAP-1). Do not import or call this file.',
      path: 'src/lib/agents/prospect-research-agent.ts',
      notes: [
        'BL-MAP-1: scheduled for deletion once v2 is confirmed stable post client zero',
        'Not wired into any active route as of 2026-05-23 — presence is a confusion risk only',
        'If accidentally imported instead of v2, it will write to the same tables and cause duplicate prospect rows',
      ],
      whatCanBreak: [
        'This file accidentally imported instead of v2 — check all imports; correct import path is prospect-research-agent-v2',
        'Duplicate prospect rows with no clear cause — v1 may have been triggered; search agent_runs for agent_name=prospect_research without the v2 suffix',
      ],
      tag: ['all'], mock: true,
    },

    {
      id: 'reply-classifier', cluster: 'agents',
      label: 'reply-classifier.ts', sub: 'claude-haiku-4-5-20251001 · called by process-reply',
      x: 830, y: 780, w: 280, h: 80, color: 'agent',
      role: 'Classifies an inbound reply as positive, information_request, negative, opt_out, or out_of_office; returns classification + confidence score.',
      plain: 'Reads each inbound email reply and decides what type it is. Uses Haiku because classification does not need deep reasoning. The result routes the reply: positive goes to draft orchestrator, negative/opt-out triggers instant suppression, OOO triggers sequence pause.',
      path: 'src/lib/agents/reply-classifier.ts',
      notes: [
        'Model: claude-haiku-4-5-20251001 (line 30). ADR-013. Full date suffix required.',
        'Returns one of: positive, information_request, negative, opt_out, out_of_office',
        'Called from process-reply.ts after the polling cursor advances',
        'Confidence score logged but not yet used to gate escalation (deferred to phase 2)',
      ],
      whatCanBreak: [
        'Model ID wrong — Haiku requires the full date suffix; "claude-haiku-4-5" without "20251001" will 404 from Anthropic',
        'Classifier returns "positive" for a hostile email — opt_out keyword gate should fire before LLM classification for phrases like "fuck off", "remove me", "leave me alone"',
        'process-reply batch stalls at classification — check ANTHROPIC_API_KEY is set in the environment where pg_cron fires the route (Vercel production env)',
      ],
      tag: ['all'],
    },

    {
      id: 'process-reply', cluster: 'agents',
      label: 'process-reply.ts', sub: 'BATCH_SIZE=20 · /api/cron/process-replies · every 5 min',
      x: 830, y: 880, w: 280, h: 80, color: 'agent',
      role: 'Polls Instantly for new inbound replies using a cursor, classifies each via reply-classifier, and routes the result to draft orchestrator, suppression, or sequence pause.',
      plain: 'The reply processing engine. Every 5 minutes pg_cron fires /api/cron/process-replies. Picks up the 20 most recent unprocessed replies, runs the classifier on each, and routes them: positive to draft queue, negative/opt-out to suppression, OOO to pause.',
      path: 'src/lib/reply-handling/process-reply.ts',
      notes: [
        'BATCH_SIZE=20 (line 42). Processes 20 replies per pg_cron tick.',
        'Uses polling_cursors table to track last processed reply position per organisation',
        'Writes results to reply_handling_actions for audit trail',
        'Currently mock — Instantly API disconnected (systemState.instantlyApiMode = mock)',
      ],
      whatCanBreak: [
        'pg_cron not firing — check Supabase pg_cron job "process-replies" is scheduled every 5 minutes; check pg_cron.job_run_details for errors',
        'Replies accumulating without processing — BATCH_SIZE=20 means >20 replies in a tick overflow to the next; if volume spikes, increase BATCH_SIZE and redeploy',
        'Cursor not advancing — polling_cursors row missing for the organisation_id; a row must be inserted when an org activates campaigns',
        'Classification calls hitting rate limit — 20 Haiku calls per tick; Anthropic rate limits are per-API-key not per-org',
      ],
      tag: ['all'],
    },

    {
      id: 'draft-orchestrator', cluster: 'agents',
      label: 'draft-orchestrator.ts', sub: 'MOCK · circuit breaker 3 failures · called by process-reply',
      x: 830, y: 980, w: 280, h: 80, color: 'agent',
      role: 'Receives positive reply signals and coordinates reply draft creation; circuit breaker halts new draft attempts after 3 consecutive failures per organisation.',
      plain: 'Traffic controller for positive replies. Calls the reply-draft agent to write a response, saves to reply_drafts. Circuit breaker: if 3 drafts in a row fail, it stops trying — prevents infinite loop of failed API calls. Currently mock because Instantly is disconnected.',
      path: 'src/lib/reply-handling/draft-orchestrator.ts',
      notes: [
        'DRAFT_FAILURE_CIRCUIT_BREAKER=3 (line 46). Circuit breaker condition at line 188.',
        'Circuit breaker state is per-organisation — one org failures do not affect another',
        'Writes draft to reply_drafts with status=pending_review; operator sees it in the reply drafts panel',
        'Currently mock — part of the mock outbound path',
      ],
      whatCanBreak: [
        'Circuit breaker open — reply_drafts shows status=circuit_open for new signals; check the 3 most recent failed drafts for that organisation_id to find root cause before resetting',
        'Draft created but not appearing in operator panel — check reply_drafts.status; if status=generating it may still be in flight; if status=failed check send_error column',
        'Draft generated for wrong org — draft-orchestrator must pass organisation_id to reply-draft-agent; missing org filter here would generate drafts for the wrong client (ADR-003 violation)',
      ],
      tag: ['all'], mock: true,
    },

    {
      id: 'agent-reply-draft', cluster: 'agents',
      label: 'reply-draft-agent.ts', sub: 'MOCK · claude-sonnet-4-6 · TIMEOUT_MS=30000',
      x: 830, y: 1080, w: 280, h: 80, color: 'agent',
      role: 'Generates a reply draft body from the inbound prospect reply, the original outbound email, and the org TOV document; returns text written to reply_drafts.ai_draft_body.',
      plain: 'The agent that writes the reply email. Reads what the prospect said, the email you sent them, and the client voice guide, then drafts a response. Operator reads the draft and approves or edits in final_sent_body before it sends. 30 second hard ceiling.',
      path: 'src/lib/agents/reply-draft-agent.ts',
      notes: [
        'Model: claude-sonnet-4-6, TIMEOUT_MS: 30000 (lines 21-22)',
        'Currently mock — not processing real Instantly replies',
        'Requires approved TOV strategy document; if TOV missing, draft quality degrades silently — no error raised',
        'Operator edits go to reply_drafts.final_sent_body; send-approved-draft sends final_sent_body, not ai_draft_body',
      ],
      whatCanBreak: [
        'Draft body sounds generic — TOV document missing or approved with thin intake content; check strategy_documents for type=tov and read the content column',
        'TIMEOUT_MS exceeded — Sentry shows timeout error tagged to draft_id; draft marked failed; increase TIMEOUT_MS if Claude consistently takes longer for complex threads',
        'final_sent_body empty when operator approves — operator cleared the body before approving; send-approved-draft catches this and returns send_failed with reason=final_sent_body_empty',
      ],
      tag: ['all'], mock: true,
    },

    {
      id: 'agent-faq-extraction', cluster: 'agents',
      label: 'faq-extraction-agent.ts', sub: 'claude-haiku-4-5-20251001 · TIMEOUT_MS=15000 · tier-3 post-send',
      x: 830, y: 1180, w: 280, h: 80, color: 'agent',
      role: 'Extracts question-answer pairs from tier-3 approved reply exchanges; writes to faq_extractions table for operator curation.',
      plain: 'After a tier-3 reply is sent, reads the conversation and extracts useful Q&A pairs for the FAQ library. Best-effort — failure does not affect the send. Uses Haiku because extraction is pattern-matching, not deep reasoning. Only fires for tier-3 (highest-touch) replies.',
      path: 'src/lib/agents/faq-extraction-agent.ts',
      notes: [
        'Model: claude-haiku-4-5-20251001, TIMEOUT_MS: 15000 (lines 27-28)',
        'Called from send-approved-draft step 10, only when draft.tier === 3',
        'Best-effort: wrapped in try/catch; failure logs a warning, does not affect send result',
        'Writes to faq_extractions with status=pending; operator actions these via route-faq-extractions',
        'Checks for similar existing FAQs before inserting (similar_faq_id) — deduplicates the extraction queue',
      ],
      whatCanBreak: [
        'faq_extractions filling with unreviewed rows — operator has not actioned the FAQ curation queue in the operator panel',
        'Extraction running for tier-1 or tier-2 replies — check that tier field on reply_drafts is being set correctly during draft creation in draft-orchestrator',
        'TIMEOUT_MS 15000 fires for complex conversations — 15s is tight for long threads; increase TIMEOUT_MS if this is a recurring Sentry alert',
      ],
      tag: ['all'],
    },

    {
      id: 'send-orchestrator', cluster: 'agents',
      label: 'send-approved-draft.ts', sub: 'MOCK · 10-step send flow · called by route-approve-draft',
      x: 830, y: 1280, w: 280, h: 80, color: 'agent',
      role: 'Orchestrates sending an operator-approved reply draft: idempotency guard, Calendly substitution, sign-off insertion, thread context load, Instantly API call (20s ceiling), atomic DB update to sent, tier-3 FAQ extraction.',
      plain: 'The file that actually sends the approved reply. Ten steps: check idempotency, validate body is not empty, load org, substitute Calendly link, add founder sign-off, get thread context from the original signal, get Instantly API key, call Instantly with a 20 second timeout, update the DB row atomically to sent, trigger FAQ extraction if tier-3. Never leaves a draft stuck at approved.',
      path: 'src/lib/reply-handling/send-approved-draft.ts',
      notes: [
        'Currently mock — Instantly API disconnected',
        'Idempotency guard: checks draft.status before doing anything; already-sent or already-failed drafts return idempotent_skip',
        'Atomic DB update: UPDATE WHERE status=\'approved\' — only one concurrent caller wins the race to set status=sent',
        '20s AbortSignal.timeout on the Instantly call — prevents hang if Instantly is slow',
        'CRITICAL: email sent but DB update failed = db_update_failed_after_send — manual reconciliation required; Sentry alert rule configured',
      ],
      whatCanBreak: [
        'Draft stuck at status=approved — send-approved-draft threw before DB update; check Sentry for the draft_id; most common: Instantly returning non-ok',
        'calendly_link_required_but_missing — org.calendly_url is null in organisations table; populate it in operator settings before any reply can send',
        'founder_first_name_required_but_missing — organisations.founder_first_name is not set; required before any reply can send',
        'thread_context_missing — signal.raw_data missing id or eaccount fields; signal was ingested without full Instantly metadata; check the polling ingestion path',
        'db_update_failed_after_send — email IS in prospect inbox but DB row is inconsistent; Sentry captures draft_id and instantly_message_id for manual reconciliation',
      ],
      tag: ['all'], critical: true, mock: true,
    },

    // ─── CLUSTER 4: Capability layer (ADR-001) ───────────────────────────────────

    {
      id: 'capability-dispatcher', cluster: 'capability',
      label: 'capability.ts · executeCapability()', sub: 'UNWIRED · handlers map empty at line 31',
      x: 1210, y: 180, w: 280, h: 80, color: 'capability',
      role: 'Intended single entry point for all external tool operations — looks up the registered handler for a capability and delegates; handlers map is currently empty.',
      plain: 'This is supposed to be the central switchboard — the whole point of ADR-001. You call executeCapability("can_send_email", params) and the system figures out which tool to use. In reality the handlers map at line 31 is empty. Every real Instantly call bypasses this file and goes directly from individual handler files. The architecture is right; the wiring is not done.',
      path: 'src/lib/handlers/capability.ts',
      notes: [
        'handlers map confirmed empty at line 31 — read 2026-05-23',
        'ADR-001 intent: swap a tool by updating integrations_registry + adding a handler; nothing else changes',
        'No live code path calls executeCapability() for a real operation as of 2026-05-23',
        'Notable finding #1 in this map — see notableFindings[0]',
      ],
      whatCanBreak: [
        'A new integration wired directly to a handler file instead of through executeCapability() — this is the current pattern but defeats ADR-001; flag before adding any new handler',
        'handlers map stays empty when Instantly goes live — mock→real transition requires populating this map; if still empty when instantly_api_active=true, nothing routes through the intended path',
      ],
      tag: ['all'], critical: true,
    },

    {
      id: 'registry-cache', cluster: 'capability',
      label: 'integrations_registry reader', sub: 'capability lookup · is_active gate',
      x: 1210, y: 280, w: 280, h: 80, color: 'capability',
      role: 'Reads integrations_registry to determine which tool is active for a capability and whether that tool is_active flag is true.',
      plain: 'The lookup layer. When something wants to know what tool handles can_send_email right now, it reads integrations_registry. The is_active flag is what switches from mock to real mode. When instantly_api_active becomes true in this table, the Instantly API turns on — if capability-dispatcher is wired up.',
      path: 'src/lib/integrations/handlers/instantly/auth.ts',
      notes: [
        'getInstantlyApiActive() reads integrations_registry where capability=instantly_api_active and tool_name=instantly',
        'Returns false if row is missing — fail-safe toward mock mode',
        'Flag is read by handler-order-mailboxes safety gate before any real order is placed',
        'All is_active values are false as of 2026-05-23 (see systemState)',
      ],
      whatCanBreak: [
        'is_active=true in integrations_registry but handler behaviour does not change — capability-dispatcher is unwired; the flag is read by individual handlers only, not by the intended ADR-001 switchboard',
        'Row missing from integrations_registry for a capability — getInstantlyApiActive() returns false (safe fail); confirm the seeding migration inserted the row',
      ],
      tag: ['all'],
    },

    {
      id: 'handler-upload-leads', cluster: 'capability',
      label: 'uploadLeadsToCampaign handler', sub: 'can_upload_leads · Instantly v2 API',
      x: 1210, y: 380, w: 280, h: 80, color: 'capability',
      role: 'Uploads a batch of prospects as leads to an Instantly campaign via the Instantly v2 API.',
      plain: 'Pushes a list of prospects from the database into an Instantly email campaign. Called from the operator lead upload panel. When the API is live this is what puts prospects into the sending queue.',
      path: 'src/lib/integrations/handlers/instantly/',
      notes: [
        'Part of the Instantly handler suite — not called via executeCapability() (capability-dispatcher is unwired)',
        'Respects the instantly_api_active flag before making real API calls',
        'Batch upload — takes array of prospect records and formats to Instantly lead schema',
      ],
      whatCanBreak: [
        'Upload fails silently — check Instantly API response; 400 errors mean a required field (email, firstName) is missing in the lead payload',
        'Leads uploaded but not appearing in Instantly campaign — campaign_id mismatch; verify campaigns.external_id matches the live Instantly campaign ID exactly (case-sensitive)',
        'getInstantlyApiKey() throws "Instantly API key not configured" — no row in integration_credentials with source=instantly, credential_type=api_key, organisation_id IS NULL; error message includes the exact INSERT SQL needed',
      ],
      tag: ['all'],
    },

    {
      id: 'handler-order-mailboxes', cluster: 'capability',
      label: 'orderMailboxes handler', sub: 'DFY ordering · safety gate on instantly_api_active',
      x: 1210, y: 480, w: 280, h: 80, color: 'capability',
      role: 'Submits a DFY mailbox ordering request to Instantly; gated by instantly_api_active safety flag — cannot place a real order while in sandbox mode.',
      plain: 'Orders email mailboxes for a client through Instantly DFY service. Hard safety gate: if instantly_api_active is false in integrations_registry, it cannot place a real order no matter what the UI sends. Prevents accidentally ordering mailboxes during development.',
      path: 'src/lib/integrations/handlers/instantly/orderMailboxes.ts',
      notes: [
        'Safety gate at line 55 — blocks real orders when instantly_api_active=false',
        'order_placed field on mailbox_orders tracks whether real API call was made or mock returned',
        'BACKLOG DONE: order_placed=false silent-failure path fixed — Instantly silent-failure now correctly sets order_placed=false in DB (commit 246a313)',
      ],
      whatCanBreak: [
        'Order placed in UI but order_placed=false in mailbox_orders — Instantly returned non-ok without throwing; check Sentry for the Instantly API response body for the specific error code',
        'Safety gate not firing — instantly_api_active has been set to true in integrations_registry prematurely; check that row before going live',
        'Order placed but Instantly never provisions mailboxes — Instantly-side delay; check Instantly dashboard directly; no webhook exists for mailbox provisioning completion',
      ],
      tag: ['all'],
    },

    {
      id: 'handler-reply-actions', cluster: 'capability',
      label: 'reply-actions.ts · sendThreadReply()', sub: 'can_send_email · Instantly thread API',
      x: 1210, y: 580, w: 280, h: 80, color: 'capability',
      role: 'Sends a reply into an existing Instantly email thread via the Instantly v2 reply endpoint; returns { ok, message_id } or { ok, error }.',
      plain: 'The function that actually hits Instantly API to send a reply email. Called by send-approved-draft with the assembled body, the thread ID from the original signal raw_data, and the sending account. Returns success with a message_id or failure with an error string.',
      path: 'src/lib/integrations/handlers/instantly/reply-actions.ts',
      notes: [
        'Called from send-approved-draft step 8 with a 20s AbortSignal.timeout wrapper',
        'Returns { ok: true, message_id } or { ok: false, error }',
        'Requires eaccount (Instantly email account), replyToUuid (thread ID from signal.raw_data.id), and subject',
        'Currently mock — Instantly API disconnected',
      ],
      whatCanBreak: [
        '401 Unauthorized — INSTANTLY_API_KEY in integration_credentials is wrong or expired; replace with fresh key from Instantly dashboard',
        '"thread not found" error — replyToUuid from signal.raw_data does not match any thread in Instantly; signal was ingested from a different Instantly workspace than the current API key',
        'AbortError after 20s — Instantly API is slow; check Instantly status page; draft will be marked send_failed and can be retried by re-approving',
      ],
      tag: ['all'], critical: true,
    },

    {
      id: 'handler-campaign-analytics', cluster: 'capability',
      label: 'campaign analytics handler', sub: 'can_get_analytics · Instantly polling · pg_cron 15 min',
      x: 1210, y: 680, w: 280, h: 80, color: 'capability',
      role: 'Fetches campaign-level analytics from Instantly (sent_count, replied_count, bounced_count) on a 15-minute pg_cron schedule and updates the campaigns table.',
      plain: 'Pulls the numbers from Instantly and saves them to the database so the dashboard can show them. Runs every 15 minutes via pg_cron. The four columns it writes were confirmed live in Supabase 2026-05-22.',
      path: 'src/lib/integrations/polling/instantly.ts',
      notes: [
        'BL-PC0-1 DONE: sent_count, replied_count, bounced_count, campaign_stats_updated_at confirmed in campaigns table (Supabase query 2026-05-22)',
        'pg_cron job "instantly-poll" runs every 15 minutes',
        'Currently mock — Instantly API disconnected; polling returns empty data',
      ],
      whatCanBreak: [
        'Dashboard shows stale analytics — pg_cron job failed; check pg_cron.job_run_details for "instantly-poll" errors',
        'campaign_stats_updated_at not advancing — analytics handler runs but Instantly returns 0 counts; verify campaigns.external_id matches the Instantly campaign ID exactly',
        'bounced_count always 0 — BL-PC0-3 (open): BOUNCED constant cannot be verified without a live bounced lead; confirm constant value matches actual Instantly API response when a real bounce occurs',
      ],
      tag: ['all'],
    },

    {
      id: 'handler-auth', cluster: 'capability',
      label: 'instantly/auth.ts · getInstantlyApiKey()', sub: 'integration_credentials lookup · Phase 1 global key',
      x: 1210, y: 780, w: 280, h: 80, color: 'capability',
      role: 'Resolves the Instantly API key from integration_credentials; Phase 1 uses one global key (organisation_id IS NULL); forward-compatible with per-org keys.',
      plain: 'Fetches the Instantly API key from the database before any Instantly call. The key lives in integration_credentials, not in env vars. Phase 1 uses one global key for all clients. The error message includes the exact INSERT SQL to add the key.',
      path: 'src/lib/integrations/handlers/instantly/auth.ts',
      notes: [
        'BACKLOG BL-CREDS (open): integration_credentials stores API keys as plaintext text column — should use pgcrypto or Vault; deferred post-launch',
        'Phase 1: single global key — organisation_id IS NULL in the query (line 21)',
        'Phase 2: query by organisation_id first, fall back to global null row (comment in file at line 7)',
      ],
      whatCanBreak: [
        'Every Instantly handler throws "Instantly API key not configured" — no row in integration_credentials with source=instantly, credential_type=api_key, organisation_id IS NULL; run the INSERT from the error message',
        'Key set but all API calls return 401 — key inserted correctly but expired or wrong; update the value field in integration_credentials with a fresh key from Instantly dashboard',
        'Per-org key lookup (Phase 2 not yet built) — do not insert per-org rows until Phase 2 implementation; current query ignores them and falls back to the global row',
      ],
      tag: ['all'],
    },

    {
      id: 'handler-validate-campaign', cluster: 'capability',
      label: 'validateCampaignBelongsToOrg()', sub: 'org isolation guard · ADR-003 application layer',
      x: 1210, y: 880, w: 280, h: 80, color: 'capability',
      role: 'Verifies a campaign_id belongs to the given organisation_id before any write or read operation; application-level enforcement of ADR-003 for the Instantly integration.',
      plain: 'A guard called before uploading leads or reading analytics. Checks that the campaign you are about to write to actually belongs to the organisation making the request. This is the application-level part of the three-level isolation (RLS + app filter + prompt).',
      path: 'src/lib/integrations/handlers/instantly/',
      notes: [
        'ADR-003 application-level enforcement for the capability layer',
        'Called before uploadLeadsToCampaign and before fetching campaign analytics',
        'Returns false if campaign_id not found in campaigns table with matching organisation_id',
      ],
      whatCanBreak: [
        '"campaign does not belong to org" — campaign_id in the request does not match any campaigns row for that organisation_id; check whether the campaign was created in Instantly first and synced to campaigns table',
        'Validation passes but data is wrong — campaigns.organisation_id was set incorrectly at creation time; the guard cannot catch this; verify campaigns rows have correct org assignment',
      ],
      tag: ['all'],
    },

    {
      id: 'compose-sequence', cluster: 'capability',
      label: 'compose-sequence.ts', sub: 'ADR-017-DEAD · bridge branch at line 422',
      x: 1210, y: 980, w: 280, h: 80, color: 'capability',
      role: 'Composes personalised email sequences for each prospect by selecting template variants and applying substitutions; branching uses has_dateable_signal + signal_relevance, not sourced_tier as ADR-017 specifies.',
      plain: 'Takes the approved email templates and personalises them for each prospect. The branch at line 422 decides whether to use the signal-based hook path or the standard path. ADR-017 says it should branch on a sourced_tier column — that column does not exist. The code branches on has_dateable_signal + signal_relevance instead. ADR-017 is dead architecture.',
      path: 'src/lib/composition/compose-sequence.ts',
      notes: [
        "Line 422: const useBridgePath = prospect.has_dateable_signal === true && prospect.signal_relevance === 'use_as_hook'",
        'ADR-017 specifies sourced_tier column — does not exist on prospects table',
        'Notable finding #3 in this map — see notableFindings[2]',
        'Pre-c1 decision needed: reconcile ADR-017 or build the sourced_tier column',
      ],
      whatCanBreak: [
        'Bridge path never fires — has_dateable_signal not being set to true during enrichment; check the enrichment step that is supposed to write this field',
        'Bridge path fires for every prospect — signal_relevance defaulting to use_as_hook incorrectly; check the default value in the prospects table schema',
        'TypeScript error if sourced_tier referenced in new code — the column does not exist; compile error is a useful guard against ADR-017 zombie code',
      ],
      tag: ['all'],
    },

    {
      id: 'icp-filter-spec', cluster: 'capability',
      label: 'icp-filter-spec builder', sub: 'ICP doc → sourcing parameters · ADR-015 canonical names',
      x: 1210, y: 1080, w: 280, h: 80, color: 'capability',
      role: 'Translates the approved ICP strategy document into structured sourcing parameters (industry, company_size, title_keywords, geo) passed to prospect-research-agent-v2.',
      plain: 'Takes the ICP document and turns it into a concrete filter spec that the prospect research agent passes to Apollo. Industry names are always canonical NAICS-derived here — the Apollo handler translates them to Apollo taxonomy. Doug never sees NAICS codes in the UI.',
      path: 'src/lib/agents/',
      notes: [
        'ADR-015: ICP filter spec always uses canonical industry names — translation to Apollo taxonomy is the Apollo handler responsibility',
        'Industry names stored as canonical strings (e.g. "Management Consulting") — never Apollo taxonomy, never LinkedIn variant',
        'Requires ICP strategy document to be approved before sourcing can run',
      ],
      whatCanBreak: [
        'Prospect sourcing returns wrong industry type — icp-filter-spec passing a tool-specific industry name instead of canonical; check the industry string against the canonical NAICS list in ADR-015',
        'ICP filter spec throws "ICP document not found" — ICP strategy document not yet approved; approve it in the document review panel before running sourcing',
        'Apollo returns zero results for a valid ICP — the canonical-to-Apollo translation map in the Apollo handler may not include the client industry; add it to the translation map in the handler file',
      ],
      tag: ['all'],
    },


    // ─── CLUSTER 5: Database ─────────────────────────────────────────────────────

    {
      id: 'db-organisations', cluster: 'database',
      label: 'organisations', sub: 'Core org row · RLS enforced',
      x: 1590, y: 180, w: 280, h: 80, color: 'data',
      role: 'Root record for every client organisation; holds founder_first_name, calendly_url, auto_approve_window_hours, setup_status JSONB, and created_at for pipeline unlock timing.',
      plain: 'The single row that represents a client. Every other table joins back to this. founder_first_name and calendly_url are required before any reply can send. setup_status JSONB tracks whether intake, agents, and docs are complete. created_at drives the 2-month pipeline view unlock.',
      path: 'supabase/migrations/',
      notes: [
        'founder_first_name: required by send-approved-draft before any reply can send',
        'calendly_url: required if any reply body contains {calendly_link} placeholder',
        'auto_approve_window_hours: default 72h; configurable per org; used by /api/cron/auto-approve',
        'setup_status JSONB: updated by route-agents-icp after all four agents complete (atomic UPDATE WHERE docs_complete_notification_sent_at IS NULL)',
      ],
      whatCanBreak: [
        'founder_first_name_required_but_missing on send — organisations row exists but founder_first_name is NULL or empty string; set it in operator settings',
        'Pipeline view stays locked after 2 months — check organisations.created_at is set at org creation time, not at user creation time; a mismatch means the unlock calculation is wrong',
        'setup_status.documents stuck at "in_progress" — check agent_runs for all four agents; if all show completed, the atomic UPDATE in route-agents-icp may have failed; check Sentry for that route',
      ],
      tag: ['all'], critical: true,
    },

    {
      id: 'db-users', cluster: 'database',
      label: 'users + users_pending_review', sub: 'App users · multi-user gate',
      x: 1590, y: 280, w: 280, h: 80, color: 'data',
      role: 'users table extends auth.users with organisation_id and role; users_pending_review holds blocked multi-user signup attempts pending operator review.',
      plain: 'Every person who logs in has a row here linking them to a client org with a role (operator or client). A Postgres trigger auto-creates this row on signup. If someone tries to join an org that already has a user, they go into users_pending_review instead — a blocked list that emails the operator.',
      path: 'supabase/migrations/',
      notes: [
        'handle_new_auth_user and handle_new_user triggers create users row on auth.users INSERT',
        'get_my_organisation_id() Postgres function reads from this table',
        'users_pending_review INSERT triggers route-webhook-users via Supabase DB webhook',
        'is_operator() Postgres function used in RLS policies across all tables',
      ],
      whatCanBreak: [
        'New user sees blank dashboard — users row not created; handle_new_user trigger failed; check Supabase database logs for trigger errors',
        'User can access wrong org data — organisation_id set incorrectly at signup; RLS policies enforce org isolation at DB level but rely on this column being correct',
        'Blocked signup email not sent — users_pending_review DB webhook may be pointing to a preview URL instead of production; check Supabase webhook configuration',
      ],
      tag: ['all'],
    },

    {
      id: 'db-intake', cluster: 'database',
      label: 'intake_responses · intake_files · intake_website_pages', sub: 'Intake input tables',
      x: 1590, y: 380, w: 280, h: 80, color: 'data',
      role: 'Three tables capturing all client intake inputs: structured questionnaire answers (intake_responses), uploaded files with extracted text (intake_files), and scraped website pages (intake_website_pages).',
      plain: 'Everything the client gives you during intake lives here. intake_responses has the questionnaire answers. intake_files has the uploaded PDFs and docs with their text already extracted. intake_website_pages has the scraped pages from their company URL. All four strategy agents read from these tables.',
      path: 'supabase/migrations/',
      notes: [
        'Text is extracted from uploaded files at upload time by /api/intake/files/upload — not at agent run time',
        'Website scrape fires on company_url blur in the intake form; Cloudflare-protected sites may return empty silently',
        '80% completeness threshold checked against intake_responses critical fields before route-intake-complete fires agents',
      ],
      whatCanBreak: [
        'Agents generate generic output — intake_website_pages is empty because the company site was behind Cloudflare during scrape; no error surface; check intake_website_pages for the org',
        'File upload succeeds in UI but text is missing — text extraction failed silently during upload; check intake_files.extracted_text for NULL values; re-upload the file',
        'Completeness check passes UI but fails server-side — the 80% threshold check in route-intake-complete re-runs on every submit; if a critical field was cleared between the Done button appearing and the submit, it will reject',
      ],
      tag: ['all'],
    },

    {
      id: 'db-document-suggestions', cluster: 'database',
      label: 'document_suggestions', sub: 'Agent output queue — CRITICAL',
      x: 1590, y: 480, w: 280, h: 80, color: 'data',
      critical: true,
      role: 'Staging table for all agent-generated strategy document content; agents write here, operators approve or reject, approve_document_suggestion RPC promotes to strategy_documents.',
      plain: 'The queue between agents and approved documents. Every agent writes its output here as a pending suggestion — never directly to strategy_documents. When Doug approves in the approvals panel, an atomic Postgres transaction archives the old document and activates the new one. Suggestions that are never actioned auto-approve after 72 hours.',
      path: 'supabase/migrations/',
      notes: [
        'ADR-002: agents never write directly to strategy_documents — always through document_suggestions',
        'Status values: pending, approved, rejected, auto_approved',
        'auto_approve_window_hours on organisations row controls the 72h default',
        'approve_document_suggestion Postgres function handles the atomic archive + activate transaction',
      ],
      whatCanBreak: [
        'Approvals queue empty but agents show completed — check document_suggestions directly; if no pending row exists, the agent hit an error after the LLM call but before the DB insert; check agent_runs.error_message',
        'Suggestion approved but strategy_documents not updated — approve_document_suggestion RPC failed; check Sentry for the approve route; the RPC is atomic and will not leave a partial state',
        'Auto-approve fires before review — check organisations.auto_approve_window_hours; pg_cron /api/cron/auto-approve job fires hourly',
      ],
      tag: ['all'],
    },

    {
      id: 'db-strategy-documents', cluster: 'database',
      label: 'strategy_documents', sub: 'Approved docs · status=active only — CRITICAL',
      x: 1590, y: 580, w: 280, h: 80, color: 'data',
      critical: true,
      role: 'Holds approved strategy documents (icp, positioning, tov, messaging) with status=active; one active row per type per organisation; archived rows remain for history.',
      plain: 'Where approved strategy documents live. Only status=active rows are shown to clients. When a new suggestion is approved, the old active document is archived and the new one becomes active — atomically in a single Postgres transaction. The messaging agent and reply-draft agent read from this table at runtime.',
      path: 'supabase/migrations/',
      notes: [
        'Valid document types: icp, positioning, tov, messaging',
        'approve_document_suggestion archives previous active row then inserts new active row — one transaction',
        'Messaging content stored as bare JSON array (ADR-012) — renderers must check Array.isArray(content) before any key lookup',
        'Reply-draft agent reads TOV document from this table at draft generation time',
      ],
      whatCanBreak: [
        'Client sees empty strategy page — no row with status=active for that type and organisation_id; check whether suggestion was approved and approve_document_suggestion ran successfully',
        'Querying status=\'approved\' returns zero rows — the live status is "active" not "approved"; this exact bug was fixed previously (BACKLOG DONE 2026-04-22); never query by status=approved on this table',
        'Messaging document renders blank — renderer checks content.emails instead of content[0]; messaging content is a bare JSON array (ADR-012), not an object',
      ],
      tag: ['all'],
    },

    {
      id: 'db-agent-runs', cluster: 'database',
      label: 'agent_runs', sub: 'Agent execution log · status + error_message',
      x: 1590, y: 680, w: 280, h: 80, color: 'data',
      role: 'Audit log for every agent invocation: agent_name, status (queued, running, completed, failed), started_at, completed_at, error_message, token usage.',
      plain: 'The execution log for every agent run. When Doug checks the operator activity panel, this is what it reads. If an agent failed, the error is here. If it timed out, the error is here. The first place to look when a strategy document is missing after intake.',
      path: 'supabase/migrations/',
      notes: [
        'Written by each agent route on start and on completion/failure',
        'Operator activity panel reads from this table',
        'error_message column holds the actual exception text — more specific than Sentry for agent failures',
        'token_count and cost_usd columns for billing visibility (phase 2 — columns may not exist yet)',
      ],
      whatCanBreak: [
        'Activity panel shows no runs — agent_runs rows not created; check whether the agent routes are being called; a 404 on the agent route means the route file is missing or misnamed',
        'Agent shows status=running indefinitely — agent started but never wrote a completion row; the Vercel function timed out; check Vercel function logs for the agent route',
        'error_message is null on a failed run — the agent caught the error but did not write it to agent_runs.error_message; check the agent route error handler',
      ],
      tag: ['all'],
    },

    {
      id: 'db-prospects', cluster: 'database',
      label: 'prospects + prospect_research_results', sub: 'Sourced contacts · deduplication by email',
      x: 1590, y: 780, w: 280, h: 80, color: 'data',
      role: 'prospects holds deduped, enriched contacts ready for campaign upload; prospect_research_results holds raw sourcing output before deduplication.',
      plain: 'Two-stage prospect storage. Raw sourcing results from Apollo land in prospect_research_results first. After deduplication by email, clean records move to prospects. The composition layer reads from prospects to build personalised sequences. The lead upload handler reads from prospects to push to Instantly.',
      path: 'supabase/migrations/',
      notes: [
        'Deduplication is by email — unique constraint on prospects.email per organisation_id',
        'has_dateable_signal and signal_relevance fields on prospects control the compose-sequence bridge branch',
        'sourced_tier column does not exist — ADR-017 dead architecture (see compose-sequence node)',
        'organisation_id required on every row — RLS policies block cross-org reads',
      ],
      whatCanBreak: [
        'Duplicate prospect rows — unique constraint violation; second Apollo source returned same email; check prospect_research_results for duplicates before inserting into prospects',
        'Bridge path never fires in compose-sequence — has_dateable_signal is NULL rather than false on prospects; check the enrichment step that should set this field',
        'Prospects appear in DB but not in Instantly campaign — uploadLeadsToCampaign has not been called yet, or it failed; check Sentry for the upload route',
      ],
      tag: ['all'],
    },

    {
      id: 'db-signals', cluster: 'database',
      label: 'signals', sub: 'Inbound reply records · raw_data JSONB',
      x: 1590, y: 880, w: 280, h: 80, color: 'data',
      role: 'Each row is an inbound reply event from Instantly; raw_data JSONB holds the full Instantly payload including id (thread UUID), eaccount, subject, body, and bounce/status codes.',
      plain: 'A signal is an inbound reply. Every time a prospect replies, Instantly fires an event, the polling handler ingests it here. The reply_classifier reads the signal body. The send-approved-draft step reads signal.raw_data.id and signal.raw_data.eaccount to thread the outbound reply correctly.',
      path: 'supabase/migrations/',
      notes: [
        'raw_data.id = Instantly thread UUID (replyToUuid) — required by sendThreadReply()',
        'raw_data.eaccount = the Instantly email account that received the reply — required by sendThreadReply()',
        'raw_data.body = the prospect reply text used by reply-classifier and reply-draft-agent',
        'original_outbound_body column: the email the prospect was replying to — used by reply-draft-agent for context',
      ],
      whatCanBreak: [
        'send-approved-draft fails with thread_context_missing — signal.raw_data is missing id or eaccount; signal was ingested before these fields were present in the Instantly payload; check polling handler',
        'reply-classifier receives empty body — raw_data.body is a nested object (body.text) not a string; classifier prompt must handle both shapes; check the signal ingestion normalisation step',
        'Signal ingested for wrong organisation_id — polling handler must scope ingestion to the org whose API key retrieved the reply; cross-org signal ingestion would be a data leak',
      ],
      tag: ['all'], critical: true,
    },

    {
      id: 'db-reply-drafts', cluster: 'database',
      label: 'reply_drafts', sub: 'Draft lifecycle · pending_review → approved → sent',
      x: 1590, y: 980, w: 280, h: 80, color: 'data',
      role: 'Tracks every generated reply draft through its lifecycle: pending_review (awaiting operator), approved (send triggered), sent (Instantly confirmed), send_failed (failed with error), circuit_open (circuit breaker halted this org).',
      plain: 'The table that tracks every reply draft from creation to send. Operators see pending_review drafts in the UI. Approving moves it to approved and fires send-approved-draft. After the Instantly call succeeds, it moves to sent. The status column is the source of truth — the send orchestrator uses it as an idempotency gate.',
      path: 'supabase/migrations/',
      notes: [
        'Status values: pending_review, approved, send_failed, sent, circuit_open',
        'Atomic UPDATE WHERE status=\'approved\' in send-approved-draft guards concurrent approval calls',
        'final_sent_body: what was actually sent (after operator edits + Calendly sub + sign-off)',
        'ai_draft_body: what the agent generated before operator editing',
        'send_error: populated on send_failed with the specific error reason',
        'instantly_message_id: the Instantly message ID returned on successful send',
      ],
      whatCanBreak: [
        'Draft stuck at status=approved — send-approved-draft threw or was never called; re-triggering approval re-enters the idempotency check safely',
        'Draft shows send_failed — check send_error column for the specific reason; most common: calendly_link_required_but_missing, founder_first_name_required_but_missing, instantly_api_error',
        'db_update_failed_after_send state — draft is stuck at send_failed but the email was sent; Sentry has the instantly_message_id; manually set status=sent and populate instantly_message_id',
      ],
      tag: ['all'], critical: true,
    },

    {
      id: 'db-campaigns', cluster: 'database',
      label: 'campaigns', sub: 'Campaign records · analytics columns · external_id',
      x: 1590, y: 1080, w: 280, h: 80, color: 'data',
      role: 'One row per Instantly campaign; holds the external_id (Instantly campaign UUID), status, and analytics columns updated by the 15-minute polling handler.',
      plain: 'One row per email campaign. The external_id column links it to the Instantly campaign so the analytics handler can fetch numbers. The four analytics columns (sent_count, replied_count, bounced_count, campaign_stats_updated_at) are updated every 15 minutes by pg_cron.',
      path: 'supabase/migrations/',
      notes: [
        'external_id must match the Instantly campaign UUID exactly — case-sensitive',
        'sent_count, replied_count, bounced_count, campaign_stats_updated_at: confirmed live in Supabase 2026-05-22 (BL-PC0-1 DONE)',
        'check_prospect_campaign_org_match Postgres function validates campaign belongs to org before writes',
        'Pipeline page StatsRow reads from campaigns.sent_count / replied_count for reply rate calculation',
      ],
      whatCanBreak: [
        'Analytics always show 0 — external_id is not set on the campaigns row; the polling handler finds no Instantly campaign to query',
        'bounced_count not incrementing — BL-PC0-3: BOUNCED constant value unverified; needs a live bounced lead to confirm the Instantly API returns the expected status code',
        'Pipeline reply rate shows wrong number — StatsRow divides replied_count by sent_count; if sent_count is 0 (campaigns launched but no sends yet), the result is 0% not an error',
      ],
      tag: ['all'],
    },

    {
      id: 'db-faqs', cluster: 'database',
      label: 'faqs + faq_extractions', sub: 'FAQ library · curation queue',
      x: 1590, y: 1180, w: 280, h: 80, color: 'data',
      role: 'faqs holds the approved FAQ library for each org; faq_extractions holds candidates extracted from tier-3 reply exchanges awaiting operator approval.',
      plain: 'Two-part FAQ system. faq_extractions is the queue of extracted Q&A pairs the agent found in tier-3 reply conversations — they wait here for operator review. When Doug approves one, it becomes a row in faqs (or merges with an existing FAQ via append_faq_variant). The FAQ library feeds the reply-draft agent.',
      path: 'supabase/migrations/',
      notes: [
        'append_faq_variant Postgres function appends a variant answer to an existing FAQ row',
        'append_faq_variant had public execute access before migration 20260521134057_revoke_public_execute_security_fix.sql — fixed',
        'faq_extractions.similar_faq_id: if set, approve-merge will call append_faq_variant; if null, approve-new creates a fresh faq row',
        'faq_extractions.status: pending, approved_new, approved_merged, rejected',
      ],
      whatCanBreak: [
        'approve-merge fails with FK violation — similar_faq_id points to a deleted faq row; use approve-new instead or update the similar_faq_id to a live faq',
        'FAQ library not being used by reply-draft agent — check that the reply-draft agent prompt actually queries faqs for the org; if the query is missing, the library grows but is never consulted',
        'faq_extractions queue not draining — operator has not visited the FAQ curation panel; no auto-approve for FAQ extractions (by design — curator must decide)',
      ],
      tag: ['all'],
    },

    {
      id: 'db-integration-infra', cluster: 'database',
      label: 'integration_credentials · integrations_registry · polling_cursors · reply_handling_actions · patterns · meetings',
      sub: 'Infrastructure support tables',
      x: 1590, y: 1280, w: 280, h: 80, color: 'data',
      role: 'Six support tables: integration_credentials (API keys), integrations_registry (ADR-001 capability registry), polling_cursors (reply polling state), reply_handling_actions (reply audit), patterns (anonymised cross-org insights), meetings (booked meeting tracking).',
      plain: 'The plumbing tables. integration_credentials stores API keys (plaintext — BL-CREDS). integrations_registry is the ADR-001 capability registry that says which tool handles each capability. polling_cursors tracks where the reply poller left off. reply_handling_actions is the reply processing audit log. patterns holds anonymised insights the aggregation agent generates. meetings tracks booked meetings for pipeline metrics.',
      path: 'supabase/migrations/',
      notes: [
        'integration_credentials: stores API keys as plaintext — BL-CREDS deferred to post-launch',
        'integrations_registry: is_active flags are all false as of 2026-05-23 (systemState)',
        'patterns: written ONLY by the dedicated pattern aggregation agent — no other code writes here (CLAUDE.md)',
        'polling_cursors: must have a row per organisation before reply polling can start',
      ],
      whatCanBreak: [
        'Reply polling never advances — polling_cursors row missing for the org; must be inserted when an org activates campaigns',
        'patterns table written by application code — architectural violation (CLAUDE.md); only the pattern aggregation agent may write here',
        'meetings count in pipeline page is 0 — meetings rows not being created; check whether the meetings creation route is connected to the booking webhook (Calendly or equivalent)',
      ],
      tag: ['all'],
    },

    // ─── CLUSTER 6: External services + email templates ──────────────────────────

    {
      id: 'ext-supabase-auth', cluster: 'external',
      label: 'Supabase Auth', sub: 'Magic link · OTP · session management',
      x: 1970, y: 180, w: 280, h: 80, color: 'external',
      role: 'Provides passwordless email authentication via magic links; manages JWT sessions; fires handle_new_auth_user trigger on signup.',
      plain: 'Handles all login. Doug and clients enter their email, Supabase sends a magic link, clicking it creates a session. No passwords. On first signup Supabase fires the handle_new_auth_user DB trigger which creates the users row.',
      path: 'supabase/',
      notes: [
        'Site URL must be set to production domain in Supabase dashboard — localhost setting causes magic links to redirect to a non-existent machine',
        'OTP rate limit returns same "Something went wrong" error as real auth failures — BL-LOGIN (open): should surface "Too many requests" instead',
        'NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY required in Vercel env for the login page to function',
      ],
      whatCanBreak: [
        'Magic links redirect to localhost — Supabase Site URL is wrong; fix in Supabase dashboard → Authentication → URL Configuration; set to https://app.margenticos.com',
        'Login page renders but magic link never sends — NEXT_PUBLIC_SUPABASE_ANON_KEY missing from Vercel env',
        'User stuck in OTP rate limit loop — same error UI as real failure; BL-LOGIN; operator can see the rate limit state in Supabase Auth logs',
      ],
      tag: ['all'],
    },

    {
      id: 'ext-supabase-db', cluster: 'external',
      label: 'Supabase Postgres', sub: 'RLS · pg_cron · Postgres functions · DB webhooks',
      x: 1970, y: 280, w: 280, h: 80, color: 'external',
      role: 'Managed Postgres with RLS enforced on all 22 public tables; 9 Postgres functions; 2 pg_cron jobs (instantly-poll every 15 min, process-replies every 5 min); DB webhooks for users_pending_review.',
      plain: 'The database. RLS policies on every table mean a client can only ever read their own org data — enforced at the database level, not just in application code. pg_cron runs scheduled jobs inside Postgres. DB webhooks call route-webhook-users when someone is blocked from joining an org.',
      path: 'supabase/',
      notes: [
        '22 public tables confirmed live 2026-05-22 (Supabase MCP query)',
        '9 Postgres functions: append_faq_variant, approve_document_suggestion, check_prospect_campaign_org_match, get_my_organisation_id, handle_new_auth_user, handle_new_user, is_operator, rls_auto_enable, set_updated_at',
        'pg_cron jobs: "instantly-poll" (15 min), "process-replies" (5 min)',
        'SUPABASE_SERVICE_ROLE_KEY used by server-side API routes for admin operations — must never be exposed client-side',
      ],
      whatCanBreak: [
        'RLS policy missing on a new table — any authenticated user can read any row; check rls_auto_enable function is being called in migrations for new tables',
        'pg_cron job stopped — check pg_cron.job_run_details in Supabase SQL editor for error logs; jobs stop on unhandled exceptions',
        'SUPABASE_SERVICE_ROLE_KEY missing from Vercel env — all server-side Supabase queries fail with permission errors; check Vercel environment variables',
      ],
      tag: ['all'], critical: true,
    },

    {
      id: 'ext-anthropic', cluster: 'external',
      label: 'Anthropic API', sub: 'claude-opus-4-6 · claude-sonnet-4-6 · claude-haiku-4-5-20251001',
      x: 1970, y: 380, w: 280, h: 80, color: 'external',
      role: 'LLM API used by all six agent files; three models assigned by ADR-013 based on task complexity and cost profile.',
      plain: 'Claude. Every agent call goes through the Anthropic API. Opus for strategy documents (most expensive, best reasoning). Sonnet for messaging and reply drafts (balanced). Haiku for classification and extraction (fastest, cheapest). ANTHROPIC_API_KEY must be set in Vercel production env.',
      path: 'src/agents/',
      notes: [
        'ADR-013 model assignments — must pass explicit model version string in every call',
        'Model IDs: claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5-20251001 (full date suffix required for Haiku)',
        'ANTHROPIC_API_KEY checked at agent startup — throws immediately if missing',
        'Rate limits are per-API-key; all six agents share one key; high intake volume could hit limits',
      ],
      whatCanBreak: [
        'All agents fail simultaneously — ANTHROPIC_API_KEY missing or revoked in Vercel env; check environment variables in Vercel dashboard',
        '404 from Anthropic on model call — model ID string is wrong; verify exact model IDs; "claude-haiku-4-5" without the "20251001" suffix is the most common mistake',
        'Rate limit errors in Sentry — multiple simultaneous intake completions hitting the same API key; monitor Anthropic usage dashboard and consider rate-limiting intake submissions',
      ],
      tag: ['all'], critical: true,
    },

    {
      id: 'ext-instantly', cluster: 'external',
      label: 'Instantly', sub: 'Email campaigns · DFY mailboxes · reply webhook · v2 API',
      x: 1970, y: 480, w: 280, h: 80, color: 'external',
      role: 'Email automation platform: hosts campaigns, sends sequences, receives inbound replies, provides DFY mailbox provisioning, exposes v2 API for all of the above.',
      plain: 'The email sending tool. Campaigns live here. Prospects are uploaded here. Sequences are sent from here. Replies come back through here. The MargenticOS reply poller pulls from Instantly every 5 minutes. API key stored in integration_credentials. Currently disconnected — sandbox mode.',
      path: 'src/lib/integrations/handlers/instantly/',
      notes: [
        'API key stored in integration_credentials table (plaintext — BL-CREDS)',
        'instantly_api_active flag in integrations_registry gates real API calls',
        'Currently disconnected — systemState.instantlyApiActive = false',
        'BL-PC0-3: BOUNCED constant value unverified without a live bounced lead',
        'No webhook for mailbox provisioning completion — must check Instantly dashboard manually',
      ],
      whatCanBreak: [
        'All Instantly calls fail with 401 — API key in integration_credentials is wrong or expired; replace the value field with a fresh key from the Instantly dashboard',
        'Reply polling returns empty — campaign has no inbound replies yet, OR Instantly workspace does not match the API key; verify the API key belongs to the same workspace as the campaigns',
        'DFY mailbox order placed but not provisioned — Instantly-side delay or error; check Instantly dashboard; there is no programmatic way to check provisioning status',
      ],
      tag: ['all'], critical: true,
    },

    {
      id: 'ext-resend', cluster: 'external',
      label: 'Resend', sub: 'Transactional email · operator notifications',
      x: 1970, y: 580, w: 280, h: 80, color: 'external',
      role: 'Sends operator notification emails: docs_complete (when all four strategy agents finish), multi-user-signup-attempt (when a blocked user tries to join an org).',
      plain: 'The tool that sends notification emails to Doug. Two templates: when all four strategy documents are ready for review, and when someone tries to join a client account and gets blocked. RESEND_API_KEY must be in Vercel env.',
      path: 'src/lib/email/',
      notes: [
        'RESEND_API_KEY required in Vercel env for all notification emails',
        'docs_complete template: fired from route-agents-icp after all four agents complete and the atomic notification guard passes',
        'multi-user-signup-attempt template: fired from route-webhook-users on INSERT to users_pending_review',
      ],
      whatCanBreak: [
        'Doug does not receive docs_complete notification — RESEND_API_KEY missing from Vercel env, OR the from address is not verified in Resend, OR the atomic notification guard (UPDATE WHERE docs_complete_notification_sent_at IS NULL) failed to set the column',
        'multi-user-signup-attempt email not sent — Supabase DB webhook pointing to a preview URL instead of production; check Supabase webhook configuration',
        'Resend rate limit — unlikely at current volume but check Resend dashboard if multiple notifications fire at the same time',
      ],
      tag: ['all'],
    },

    {
      id: 'ext-sentry', cluster: 'external',
      label: 'Sentry', sub: 'Error monitoring · alert rules · db_update_failed_after_send',
      x: 1970, y: 680, w: 280, h: 80, color: 'external',
      role: 'Captures all application exceptions, structured logs at error/warn level, and has a specific alert rule configured for db_update_failed_after_send (email sent but DB row not updated).',
      plain: 'Error tracking. Every unhandled exception in the application goes to Sentry automatically. The logger module also sends structured error and warning events. There is a specific alert rule for db_update_failed_after_send because that case requires manual reconciliation — the email is in the prospect inbox but the database is wrong.',
      path: 'src/lib/logger.ts',
      notes: [
        'SENTRY_DSN required in Vercel env for error capture',
        'db_update_failed_after_send alert rule: fires when send-approved-draft logs a CRITICAL error; requires manual DB reconciliation',
        'logger module wraps all console output — never use console.log/error/warn directly in application code',
        'Debug-level logs must not appear in production — check LOG_LEVEL env var',
      ],
      whatCanBreak: [
        'Errors not appearing in Sentry — SENTRY_DSN missing from Vercel env; or SENTRY_ENVIRONMENT is not set to "production" in production deploys',
        'db_update_failed_after_send alert fires — email was sent but reply_drafts row was not updated to status=sent; check Sentry for draft_id and instantly_message_id; manually update the row',
        'logger writes console.log in production — if LOG_LEVEL is not set correctly, debug logs leak to Vercel function logs and increase log storage costs',
      ],
      tag: ['all'],
    },

    {
      id: 'ext-vercel', cluster: 'external',
      label: 'Vercel', sub: 'Hosting · three environments · Fluid Compute',
      x: 1970, y: 780, w: 280, h: 80, color: 'external',
      role: 'Hosts the Next.js application across three environments (development local, staging preview, production main); manages environment variables per environment.',
      plain: 'Where the app runs. Three environments: your local machine for development, automatic preview deploys on every non-main git push for staging, and the main branch for production. Never push directly to production without staging verification. Environment variables are set separately per environment in the Vercel dashboard.',
      path: 'vercel.json',
      notes: [
        'Repo is currently PUBLIC on GitHub to enable Vercel Hobby deploys — must flip to private before first paying client (requires Vercel Pro upgrade)',
        'Three environments: development (local), staging (Vercel preview), production (Vercel main)',
        'Vercel CLI version 52.0.0 is outdated — current is 54.4.1; upgrade recommended',
        'Default function execution timeout: 300s on all plans',
      ],
      whatCanBreak: [
        'Production env vars missing — a new env var added in development but not set in Vercel production scope; check Vercel dashboard → Settings → Environment Variables',
        'Staging preview URL used in Supabase webhooks — after a new deploy, the preview URL changes; any Supabase webhook pointing to a preview URL will stop working; always point webhooks to the production URL',
        'Repo made private before Vercel plan upgrade — Hobby plan cannot deploy private org repos; upgrade Vercel to Pro before making the repo private',
      ],
      tag: ['all'],
    },

    {
      id: 'ext-apollo', cluster: 'external',
      label: 'Apollo', sub: 'Prospect sourcing · canonical industry translation',
      x: 1970, y: 880, w: 280, h: 80, color: 'external',
      role: 'B2B contact database used by prospect-research-agent-v2 for all four sourcing operations; Apollo-specific industry taxonomy is handled exclusively within the Apollo sourcing handler.',
      plain: 'The database where prospect contacts come from. The agent passes canonical industry names (e.g. "Management Consulting") to the Apollo handler. The handler translates them to whatever Apollo calls that industry internally. Doug and the agents never see Apollo taxonomy — only canonical names.',
      path: 'src/lib/integrations/handlers/',
      notes: [
        'ADR-015: canonical industry names in all upstream code; Apollo handler owns the translation table',
        'API key stored in integration_credentials for source=apollo',
        'Currently not active — Apollo account not set up as of 2026-05-23',
        'prospect-research-agent-v2 runs four sourcing operations in parallel via Promise.all()',
      ],
      whatCanBreak: [
        'All sourcing returns empty — Apollo API key not set in integration_credentials, or Apollo account is on a plan that does not include the data types being queried',
        'Wrong industry type returned — canonical-to-Apollo translation map in the handler missing the client industry; add the mapping to the handler translation table',
        'Apollo returns contacts but they are not in the right ICP — ICP filter spec was not built correctly from the ICP document; check the filter spec parameters being passed to the Apollo handler',
      ],
      tag: ['all'],
    },

    {
      id: 'ext-calendly', cluster: 'external',
      label: 'Calendly', sub: 'Meeting booking · {calendly_link} substitution',
      x: 1970, y: 980, w: 280, h: 80, color: 'external',
      role: 'Client booking tool; the Calendly URL is stored in organisations.calendly_url and substituted into reply bodies at send time via substituteBookingLink().',
      plain: 'Where prospects book meetings. The client\'s Calendly URL is stored in their org record. When send-approved-draft runs, it substitutes {calendly_link} in the reply body with the real URL. If organisations.calendly_url is null, the send fails with calendly_link_required_but_missing.',
      path: 'src/lib/reply-handling/substitute-booking-link.ts',
      notes: [
        'substituteBookingLink() called as step 4 in send-approved-draft',
        'Fails fast: if body contains {calendly_link} placeholder and org.calendly_url is null, the send is blocked',
        'If the reply body has no {calendly_link} placeholder, the null URL is fine — no substitution needed',
        'Calendly is registered as can_book_meeting in integrations_registry',
      ],
      whatCanBreak: [
        'calendly_link_required_but_missing on send — organisations.calendly_url is null; set it in operator settings before approving replies that include a booking link',
        'Wrong Calendly URL in sent email — organisations.calendly_url was updated after the draft was generated but before it was sent; the URL is substituted at send time, so the latest value in the DB is always used',
        'Prospect reports broken Calendly link — the stored URL may be correct but the Calendly schedule may be full or paused; check the Calendly dashboard directly',
      ],
      tag: ['all'],
    },

    {
      id: 'ext-taplio-zapier', cluster: 'external',
      label: 'Taplio (via Zapier)', sub: 'LinkedIn content · dashboard approval only · ADR-004/010',
      x: 1970, y: 1080, w: 280, h: 80, color: 'external',
      role: 'LinkedIn content scheduling tool; connected via Zapier or manual delivery from the MargenticOS dashboard; no programmatic API integration (Taplio has no public scheduling API).',
      plain: 'LinkedIn post scheduling. Taplio is the tool but there is no direct API. The workflow is: agent generates LinkedIn content, Doug approves in the dashboard, content is delivered to Taplio manually or via Zapier. Never attempt to build a programmatic scheduling integration — there is no public API for it (ADR-004 and ADR-010).',
      path: 'docs/ADR.md',
      notes: [
        'ADR-004: Taplio as publishing layer only — dashboard is the approval layer',
        'ADR-010: no programmatic scheduling API — Taplio has not published one',
        'Delivery from dashboard to Taplio is manual or via Zapier; no code integration exists or should be built',
      ],
      whatCanBreak: [
        'Approved LinkedIn content not appearing in Taplio — manual handoff was missed; check the dashboard for approved LinkedIn content waiting for delivery',
        'Zapier workflow breaks — Zapier connection between MargenticOS and Taplio has expired or the Taplio action changed; re-authenticate the Zapier workflow',
      ],
      tag: ['all'],
    },

    {
      id: 'tpl-magic-link', cluster: 'external',
      label: 'magic-link email template', sub: 'Supabase Auth template · login flow',
      x: 1970, y: 1180, w: 280, h: 80, color: 'external',
      role: 'Supabase-managed email template for magic link authentication; configured in the Supabase Auth dashboard.',
      plain: 'The login email. Supabase sends this when someone requests a magic link. The template and sending are handled entirely by Supabase — no application code. The redirect URL in the template must point to /auth/callback, which is auth/callback/route.ts.',
      path: 'supabase/',
      notes: [
        'Template configured in Supabase dashboard → Authentication → Email Templates',
        'Redirect URL must point to https://app.margenticos.com/auth/callback',
        'auth/callback/route.ts handles the OTP exchange and sets the session cookie',
      ],
      whatCanBreak: [
        'Magic link clicks through but user is not logged in — /auth/callback/route.ts is not receiving the OTP params; check the redirect URL in the Supabase template matches the production URL exactly',
        'Magic link email styling broken — the Supabase custom template has HTML that breaks in certain email clients; test in Litmus or Mail Tester',
      ],
      tag: ['all'],
    },

    {
      id: 'tpl-docs-complete', cluster: 'external',
      label: 'docs-complete notification template', sub: 'Resend · operator alert',
      x: 1970, y: 1280, w: 280, h: 80, color: 'external',
      role: 'Resend email template notifying the operator that all four strategy documents are ready for review; fired once per org after the last agent completes.',
      plain: 'The email Doug gets when all four strategy documents are ready to review for a new client. Fired once per org — the atomic UPDATE WHERE docs_complete_notification_sent_at IS NULL guard prevents duplicate sends. If Doug does not receive it, the approvals queue still has the documents.',
      path: 'src/lib/email/',
      notes: [
        'Fired from route-agents-icp after the docs_complete notification guard passes',
        'Atomic idempotency guard on organisations.docs_complete_notification_sent_at prevents duplicate sends',
        'If Resend fails, the documents are still in document_suggestions — they are not lost',
      ],
      whatCanBreak: [
        'Email not received — RESEND_API_KEY missing, from address not verified in Resend, or the notification guard already fired (docs_complete_notification_sent_at is already set); check organisations row',
        'Email fires multiple times for one org — idempotency guard failed; check whether docs_complete_notification_sent_at was set correctly by the UPDATE',
      ],
      tag: ['all'],
    },

    {
      id: 'tpl-pending-review', cluster: 'external',
      label: 'multi-user-signup-attempt template', sub: 'Resend · blocked signup alert',
      x: 1970, y: 1380, w: 280, h: 80, color: 'external',
      role: 'Resend email template alerting the operator when a second user attempt to join a client org is blocked and placed in users_pending_review.',
      plain: 'The email Doug gets when someone tries to log in to a client account that already has a user and is blocked. Triggered by a Supabase DB webhook on INSERT to users_pending_review. Doug can then decide whether to approve or reject the access request.',
      path: 'src/lib/email/',
      notes: [
        'Triggered by Supabase DB webhook on users_pending_review INSERT',
        'Webhook must point to the production URL — not a preview URL',
        'Route: route-webhook-users (/api/webhooks/users-pending-review-notify)',
      ],
      whatCanBreak: [
        'Email not received after a blocked signup — Supabase DB webhook pointing to a preview URL or the RESEND_API_KEY is missing from Vercel production env',
        'Payload shape mismatch — if the users_pending_review table schema changes, the webhook payload may not match what route-webhook-users expects; check for 400 errors in the webhook delivery logs in Supabase',
      ],
      tag: ['all'],
    },

  ], // end nodes

  edges: [

    // ─── Auth & login flow ────────────────────────────────────────────────────────
    { from: 'login-page',               to: 'ext-supabase-auth',           label: 'magic link request' },
    { from: 'ext-supabase-auth',        to: 'tpl-magic-link',              label: 'sends template' },
    { from: 'ext-supabase-auth',        to: 'db-users',                    label: 'handle_new_user trigger on signup' },

    // ─── Intake flow ─────────────────────────────────────────────────────────────
    { from: 'intake-page',              to: 'route-intake-upload',         label: 'file upload' },
    { from: 'intake-page',              to: 'route-intake-website',        label: 'company URL scrape' },
    { from: 'intake-page',              to: 'route-intake-complete',       label: 'Done button POST' },
    { from: 'route-intake-upload',      to: 'db-intake',                   label: 'INSERT intake_files + extracted_text' },
    { from: 'route-intake-website',     to: 'db-intake',                   label: 'INSERT intake_website_pages' },
    { from: 'route-intake-complete',    to: 'db-intake',                   label: 'completeness re-check' },
    { from: 'route-intake-complete',    to: 'db-agent-runs',               label: 'CREATE agent run rows' },
    { from: 'route-intake-complete',    to: 'route-agents-icp',            label: 'after() background POST' },
    { from: 'route-intake-complete',    to: 'route-agents-positioning',    label: 'after() background POST' },
    { from: 'route-intake-complete',    to: 'route-agents-tov',            label: 'after() background POST' },
    { from: 'route-intake-complete',    to: 'route-agents-messaging',      label: 'after() background POST' },

    // ─── Agent routes → agents ────────────────────────────────────────────────────
    { from: 'route-agents-icp',         to: 'agent-icp',                   label: 'invokes' },
    { from: 'route-agents-positioning', to: 'agent-positioning',           label: 'invokes' },
    { from: 'route-agents-tov',         to: 'agent-tov',                   label: 'invokes' },
    { from: 'route-agents-messaging',   to: 'agent-messaging',             label: 'invokes' },
    { from: 'route-agents-icp',         to: 'db-organisations',            label: 'UPDATE docs_complete_notification_sent_at' },
    { from: 'route-agents-icp',         to: 'ext-resend',                  label: 'send docs_complete notification' },
    { from: 'route-agents-icp',         to: 'tpl-docs-complete',           label: 'uses template' },

    // ─── Agent reads from intake + strategy docs ──────────────────────────────────
    { from: 'db-intake',                to: 'agent-icp',                   label: 'intake context' },
    { from: 'db-intake',                to: 'agent-positioning',           label: 'intake context' },
    { from: 'db-intake',                to: 'agent-tov',                   label: 'intake context' },
    { from: 'db-intake',                to: 'agent-messaging',             label: 'intake context' },
    { from: 'db-strategy-documents',    to: 'agent-messaging',             label: 'reads ICP + positioning + TOV docs' },
    { from: 'db-strategy-documents',    to: 'agent-reply-draft',           label: 'reads TOV doc for voice matching' },
    { from: 'db-organisations',         to: 'send-orchestrator',           label: 'founder_first_name + calendly_url' },

    // ─── Agents → document_suggestions (ADR-002 write path) ─────────────────────
    { from: 'agent-icp',                to: 'db-document-suggestions',     label: 'INSERT type=icp' },
    { from: 'agent-positioning',        to: 'db-document-suggestions',     label: 'INSERT type=positioning' },
    { from: 'agent-tov',                to: 'db-document-suggestions',     label: 'INSERT type=tov' },
    { from: 'agent-messaging',          to: 'db-document-suggestions',     label: 'INSERT type=messaging' },

    // ─── Agents → external LLMs ──────────────────────────────────────────────────
    { from: 'agent-icp',                to: 'ext-anthropic',               label: 'claude-opus-4-6' },
    { from: 'agent-positioning',        to: 'ext-anthropic',               label: 'claude-opus-4-6' },
    { from: 'agent-tov',                to: 'ext-anthropic',               label: 'claude-opus-4-6' },
    { from: 'agent-messaging',          to: 'ext-anthropic',               label: 'claude-sonnet-4-6' },
    { from: 'reply-classifier',         to: 'ext-anthropic',               label: 'claude-haiku-4-5-20251001' },
    { from: 'agent-reply-draft',        to: 'ext-anthropic',               label: 'claude-sonnet-4-6' },
    { from: 'agent-faq-extraction',     to: 'ext-anthropic',               label: 'claude-haiku-4-5-20251001' },

    // ─── Approval flow ────────────────────────────────────────────────────────────
    { from: 'approvals-page',           to: 'db-document-suggestions',     label: 'reads pending rows' },
    { from: 'approvals-page',           to: 'route-suggestions-approve',   label: 'approve action' },
    { from: 'approvals-page',           to: 'route-suggestions-reject',    label: 'reject action' },
    { from: 'approvals-page',           to: 'route-suggestions-regenerate',label: 'regenerate action' },
    { from: 'route-suggestions-approve',to: 'db-document-suggestions',     label: 'UPDATE status=approved' },
    { from: 'route-suggestions-approve',to: 'db-strategy-documents',       label: 'approve_document_suggestion RPC → INSERT active row' },
    { from: 'route-cron-autoapprove',   to: 'db-document-suggestions',     label: 'auto-approve after 72h' },
    { from: 'route-cron-autoapprove',   to: 'db-strategy-documents',       label: 'approve_document_suggestion RPC' },

    // ─── Client reads strategy docs ───────────────────────────────────────────────
    { from: 'strategy-view',            to: 'db-strategy-documents',       label: 'SELECT status=active' },
    { from: 'dashboard-home',           to: 'db-organisations',            label: 'reads setup_status JSONB' },

    // ─── Pipeline + benchmarks reads ─────────────────────────────────────────────
    { from: 'pipeline-page',            to: 'db-campaigns',                label: 'reads sent_count + replied_count' },
    { from: 'benchmarks-page',          to: 'db-campaigns',                label: 'reads analytics columns' },

    // ─── Prospect research ────────────────────────────────────────────────────────
    { from: 'agent-prospect-v2',        to: 'icp-filter-spec',             label: 'requests filter spec from ICP doc' },
    { from: 'icp-filter-spec',          to: 'db-strategy-documents',       label: 'reads ICP doc' },
    { from: 'agent-prospect-v2',        to: 'ext-apollo',                  label: 'sourcing queries (4 in parallel)' },
    { from: 'agent-prospect-v2',        to: 'db-prospects',                label: 'INSERT deduped prospects' },
    { from: 'db-prospects',             to: 'handler-upload-leads',        label: 'prospect batch for upload' },
    { from: 'db-prospects',             to: 'compose-sequence',            label: 'reads has_dateable_signal + signal_relevance' },

    // ─── Composition ─────────────────────────────────────────────────────────────
    { from: 'agent-messaging',          to: 'compose-sequence',            label: 'templates feed personalisation layer' },
    { from: 'compose-sequence',         to: 'db-signals',                  label: 'reads dateable signal for bridge path' },

    // ─── Campaign upload and analytics ───────────────────────────────────────────
    { from: 'handler-upload-leads',     to: 'handler-auth',                label: 'fetch API key' },
    { from: 'handler-upload-leads',     to: 'handler-validate-campaign',   label: 'org isolation guard' },
    { from: 'handler-upload-leads',     to: 'ext-instantly',               label: 'POST leads to campaign' },
    { from: 'handler-campaign-analytics', to: 'handler-auth',              label: 'fetch API key' },
    { from: 'handler-campaign-analytics', to: 'ext-instantly',             label: 'GET campaign analytics' },
    { from: 'handler-campaign-analytics', to: 'db-campaigns',              label: 'UPDATE sent_count, replied_count, bounced_count' },
    { from: 'route-cron-poll',          to: 'handler-campaign-analytics',  label: 'pg_cron trigger every 15 min' },
    { from: 'db-campaigns',             to: 'handler-validate-campaign',   label: 'campaign→org membership lookup' },

    // ─── Reply processing pipeline (mock) ────────────────────────────────────────
    { from: 'route-cron-replies',       to: 'process-reply',               label: 'pg_cron trigger every 5 min' },
    { from: 'process-reply',            to: 'ext-instantly',               label: 'GET inbound replies (polling cursor)' },
    { from: 'ext-instantly',            to: 'db-signals',                  label: 'polling handler inserts reply signals' },
    { from: 'process-reply',            to: 'db-signals',                  label: 'reads signal body for classification' },
    { from: 'process-reply',            to: 'reply-classifier',            label: 'classify each reply' },
    { from: 'process-reply',            to: 'draft-orchestrator',          label: 'positive reply → draft queue' },
    { from: 'process-reply',            to: 'db-integration-infra',        label: 'advance polling_cursors' },
    { from: 'draft-orchestrator',       to: 'agent-reply-draft',           label: 'generate draft body' },
    { from: 'draft-orchestrator',       to: 'db-reply-drafts',             label: 'INSERT pending_review draft' },
    { from: 'agent-reply-draft',        to: 'db-signals',                  label: 'reads prospect reply body' },
    { from: 'agent-reply-draft',        to: 'db-reply-drafts',             label: 'writes ai_draft_body' },

    // ─── Operator triage and reply approval ──────────────────────────────────────
    { from: 'operator-triage',          to: 'db-reply-drafts',             label: 'reads pending_review drafts' },
    { from: 'operator-triage',          to: 'route-reply-drafts-approve',  label: 'approve action' },
    { from: 'operator-triage',          to: 'route-reply-drafts-reject',   label: 'reject action' },
    { from: 'route-reply-drafts-approve', to: 'db-reply-drafts',           label: 'UPDATE status=approved' },
    { from: 'route-reply-drafts-approve', to: 'send-orchestrator',         label: 'fire send-approved-draft' },
    { from: 'send-orchestrator',        to: 'handler-reply-actions',       label: 'sendThreadReply()' },
    { from: 'send-orchestrator',        to: 'handler-auth',                label: 'getInstantlyApiKey()' },
    { from: 'send-orchestrator',        to: 'db-signals',                  label: 'reads raw_data.id + eaccount for thread context' },
    { from: 'send-orchestrator',        to: 'db-reply-drafts',             label: 'UPDATE status=sent (atomic WHERE status=approved)' },
    { from: 'send-orchestrator',        to: 'agent-faq-extraction',        label: 'tier-3 post-send (best-effort)' },
    { from: 'handler-reply-actions',    to: 'ext-instantly',               label: 'POST reply to thread' },
    { from: 'agent-faq-extraction',     to: 'db-faqs',                     label: 'INSERT faq_extractions pending' },

    // ─── FAQ curation flow ────────────────────────────────────────────────────────
    { from: 'operator-faqs',            to: 'db-faqs',                     label: 'reads faq_extractions pending' },
    { from: 'operator-faqs',            to: 'route-faq-extractions',       label: 'approve/merge/reject action' },
    { from: 'route-faq-extractions',    to: 'db-faqs',                     label: 'INSERT faqs or append_faq_variant RPC' },

    // ─── Mailbox ordering ─────────────────────────────────────────────────────────
    { from: 'handler-order-mailboxes',  to: 'handler-auth',                label: 'fetch API key' },
    { from: 'handler-order-mailboxes',  to: 'registry-cache',              label: 'check instantly_api_active flag' },
    { from: 'handler-order-mailboxes',  to: 'ext-instantly',               label: 'POST DFY mailbox order (when active)' },

    // ─── Capability registry ──────────────────────────────────────────────────────
    { from: 'capability-dispatcher',    to: 'registry-cache',              label: 'lookup active handler for capability' },
    { from: 'registry-cache',           to: 'db-integration-infra',        label: 'reads integrations_registry' },
    { from: 'handler-auth',             to: 'db-integration-infra',        label: 'reads integration_credentials + integrations_registry' },

    // ─── Multi-user blocked signup ────────────────────────────────────────────────
    { from: 'db-users',                 to: 'route-webhook-users',         label: 'Supabase DB webhook on INSERT to users_pending_review' },
    { from: 'route-webhook-users',      to: 'ext-resend',                  label: 'send blocked-signup notification' },
    { from: 'route-webhook-users',      to: 'tpl-pending-review',          label: 'uses template' },

    // ─── Operator support views ───────────────────────────────────────────────────
    { from: 'operator-activity',        to: 'db-agent-runs',               label: 'reads all agent run history' },
    { from: 'operator-signals',         to: 'db-signals',                  label: 'reads inbound signal log' },
    { from: 'operator-client-detail',   to: 'db-organisations',            label: 'reads org record' },
    { from: 'operator-client-detail',   to: 'db-campaigns',                label: 'reads campaign status' },
    { from: 'operator-home',            to: 'db-organisations',            label: 'reads all client org records' },

    // ─── Ext Sentry (receives from everything) ────────────────────────────────────
    { from: 'ext-vercel',               to: 'ext-sentry',                  label: 'Sentry DSN configured in Vercel env' },
    { from: 'ext-supabase-db',          to: 'ext-vercel',                  label: 'pg_cron calls Vercel API routes' },

    // ─── Calendly substitution ────────────────────────────────────────────────────
    { from: 'send-orchestrator',        to: 'ext-calendly',                label: 'org.calendly_url substituted into reply body' },

    // ─── Taplio content delivery ──────────────────────────────────────────────────
    { from: 'operator-client-detail',   to: 'ext-taplio-zapier',           label: 'approved LinkedIn content delivered manually or via Zapier' },

  ],

  KNOWN_BUGS: {
    'agent-prospect-v1': {
      id: 'BL-MAP-1',
      severity: 'LOW',
      summary: 'prospect-research-agent.ts (v1, sequential) has not been deleted since v2 was confirmed active. Any developer browsing the agents folder will not know which file is live.',
      status: 'open',
      resolution: 'Delete src/lib/agents/prospect-research-agent.ts once v2 is confirmed stable post client zero.',
    },
    'handler-auth': {
      id: 'BL-CREDS',
      severity: 'MEDIUM',
      summary: 'integration_credentials stores API keys (Instantly, Apollo, etc.) as plaintext text column. Keys are visible to anyone with Supabase service role access or direct DB access.',
      status: 'open',
      resolution: 'Implement Supabase Vault or pgcrypto column encryption for integration_credentials.value. Deferred post-launch.',
    },
    'handler-campaign-analytics': {
      id: 'BL-PC0-3',
      severity: 'HIGH',
      summary: 'BOUNCED constant value in the Instantly polling handler cannot be verified without a live bounced lead. All Instantly API documentation URLs returned 404 (2026-05-23). If the constant is wrong, bounced_count will always be 0 in the campaigns table.',
      status: 'open',
      resolution: 'Verify the constant value against a real Instantly API response when the first campaign is live and a bounce occurs. Check src/lib/integrations/polling/instantly.ts for the BOUNCED constant.',
    },
    'capability-dispatcher': {
      id: 'ADR-001-UNWIRED',
      severity: 'MEDIUM',
      summary: 'executeCapability() in capability.ts has an empty handlers map at line 31. No live operation routes through this function. All Instantly calls bypass it and go directly from individual handler files. The ADR-001 architecture is correct but unimplemented.',
      status: 'open',
      resolution: 'Populate the handlers map in capability.ts and route all capability calls through executeCapability() before adding new integrations. This is the pre-c1 wiring task.',
    },
    'compose-sequence': {
      id: 'ADR-017-DEAD',
      severity: 'MEDIUM',
      summary: 'ADR-017 specifies a sourced_tier column on prospects driving three enrichment tiers and separate sending domain pools. The column does not exist on the prospects table. Actual branching at compose-sequence.ts:422 uses has_dateable_signal + signal_relevance — two different fields. ADR-017 was updated 2026-05 to document this but the reconciliation decision has not been made.',
      status: 'open',
      resolution: 'Pre-c1 decision required: either build the sourced_tier column as ADR-017 specifies, or update ADR-017 to formally retire the sourced_tier spec and document the actual branching logic as the canonical approach.',
    },
  },

  FIXES: {
    'handler-order-mailboxes': {
      id: 'BL-OMP-1',
      summary: 'orderMailboxes handler was not setting order_placed=false in mailbox_orders when Instantly returned a silent non-ok response. The UI showed success but no order was placed.',
      fixedIn: 'commit 246a313 (2026-05-21)',
      fixDescription: 'Silent-failure path now explicitly sets order_placed=false and records the Instantly error response. Operator can see the failure state in the mailbox orders panel.',
    },
    'db-faqs': {
      id: 'SECURITY-FAV-PUBLIC',
      summary: 'append_faq_variant Postgres function had PUBLIC EXECUTE access. Any authenticated user could append arbitrary text to any organisation FAQ.',
      fixedIn: 'migration 20260521134057_revoke_public_execute_security_fix.sql',
      fixDescription: 'Revoked PUBLIC EXECUTE on append_faq_variant. Function now requires operator role via RLS. No data was compromised.',
    },
    'db-strategy-documents': {
      id: 'STATUS-ACTIVE-BUG',
      summary: "Code was querying strategy_documents with status='approved' instead of status='active'. approve_document_suggestion sets the row to status='active', so no active documents were ever found after approval.",
      fixedIn: 'BACKLOG DONE 2026-04-22',
      fixDescription: "Changed all queries to status='active'. The live status after approve_document_suggestion runs is 'active' not 'approved'. Any new query on this table must use status='active'.",
    },
    'login-page': {
      id: 'SUPABASE-SITE-URL',
      summary: 'Supabase Site URL was set to localhost:3000. Magic links redirected users to a machine that did not exist, silently failing the auth flow.',
      fixedIn: '2026-05-04',
      fixDescription: 'Updated Supabase Authentication → URL Configuration to https://app.margenticos.com. Magic links now route correctly to the production auth callback.',
    },
  },

};
