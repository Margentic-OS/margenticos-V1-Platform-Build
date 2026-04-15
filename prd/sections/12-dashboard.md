# sections/12-dashboard.md — All Views, Components, Phased Unlock
# MargenticOS PRD | April 2026
# Read prd/PRD.md first. Also read /docs/design.md before building any UI component.
# The design system in /docs/design.md is the single source of truth for all visual decisions.

---

## Dashboard overview

The dashboard has two modes:
  Client view:    What the client sees — their IP and their results
  Operator view:  What Doug sees — all clients, all controls, all agent activity

These are not separate applications. The operator view is an overlay on the client view
with additional navigation items, an amber operator badge, and access to cross-client data.

---

## Phased unlock — pipeline view

Months 1–2: default view is the setup and strategy view. Pipeline view is locked.
Unlock trigger: 2 months elapsed OR 5 meetings booked, whichever comes first.
The unlock trigger is evaluated on the organisations table (pipeline_unlocked field).

Trend line appears: after 8 weeks of campaign data.
Trend line becomes dominant: after 12 weeks.

Why: Early results are low. Showing "2 meetings" as the hero number in month one
creates doubt before the system has had time to work. The strategy documents are
complete and impressive from day one — keep focus there during the warming period.

---

## View 1 — Empty state view (default for months 1–2)

This is a first-class view, not a fallback. It is the client's experience for the
first two months. It must feel like an arrival, not an absence.

Primary component: Welcome card (dark green background)
  - Headline: "Your campaigns launch [date]"
  - Short explanation of the warmup process
  - Warmup progress indicator

Three setup step cards (showing progress):
  - Strategy documents: "Ready v1.0" with green status
  - Campaign setup: status of Instantly/Lemlist configuration
  - LinkedIn content: first posts approved/queued

Strategy panel (right side):
  All four strategy documents shown with "Ready v1.0" status
  Each document is clickable to read in full

Sidebar:
  Shows setup progress steps rather than pipeline metrics
  Steps: Intake complete → Documents generated → Integrations connected → Launch ready

Empty state copy rules:
  Forward-looking, specific, warm.
  "Your first campaign launches 1 May — meetings will appear here."
  Never: "No data available." Never: "Pipeline empty."

---

## View 2 — Client pipeline view (post-unlock)

Layout:
  Approval banner (if pending approvals — amber stripe at top)
  Momentum block (primary metric — progress toward monthly target)
  Main content: [meetings list | strategy panel] side by side
  Stats row (secondary metrics below)

### Momentum block
Primary visual: progress bar toward monthly meetings target.
"7 of 8 meetings — On track" is the hero statement.
Raw numbers alone ("7 meetings") are never the hero — always show context (of target).
This is the key UX decision: momentum over raw numbers.

### Meetings list
  Each meeting row: prospect name, company, date, qualification badge
  Qualification badges: Qualified (green) / Flag pending (amber) / Not qualified (red) / No show (red)
  Revenue value (if marked): shown small, below the company name
  Click to expand: notes field for Doug or client to add context

### Strategy panel (permanent fixture, right side)
  Four documents shown with version and last-updated date
  "Strategy is learning from campaign data" status with pulse dot
  Each document clickable to full view

### Stats row (secondary metrics)
  Reply rate vs benchmark
  Qualified rate
  Pipeline value (estimated)
  Shown smaller than the momentum block — these are context, not headline

---

## View 3 — Operator view

Built on top of the client view with these additions:

Sidebar:
  Amber "Operator view" badge below logo
  Client selector dropdown — switch between all client organisations
  Additional nav section "Operator only":
    All clients (overview table)
    Agent activity (log of all agent runs)
    Signals log (all signals across all clients)
    Settings (integrations, thresholds, per-client toggles)

Topbar:
  "View as client" button — strips operator additions and shows pure client view

Warnings rail:
  Between the topbar and main content
  Shows amber/red warnings across all clients
  Each warning expandable with diagnostic and recommended action

Cross-client panels (visible only in "All clients" view):
  Client list with status dots (green = active, amber = warming, grey = setup)
  Approval queue across all clients
  Agent activity feed
  Document health (staleness flags)

Operator-only fields shown:
  Payment status (current / overdue)
  Contract status (active / paused / churned)
  Engagement month counter

These fields NEVER appear in client-facing queries or components.

---

## View 4 — Strategy document view

When a client clicks a document:
  Full document displayed in clean reading format
  Section headings: 14px weight 500, dark green left border accent
  Body text: 12–13px, 1.6 line height
  Version indicator at top: "v2.1 — Updated 3 days ago · Trigger added"
  Living status: small pulse dot + "Strategy is learning from campaign data"
  No editing controls for clients — read-only view

---

## View 5 — Approvals view

Accessible from the "Approvals" nav item in the client sidebar.

Lists all pending approval items:
  Email sequences awaiting approval
  LinkedIn posts awaiting approval
  LinkedIn DM sequences awaiting approval

Each item shows:
  Content preview
  Auto-approve countdown ("Auto-approves in 2 days 4 hours")
  Approve / Reject buttons
  Batch sample button (if applicable)

Approved items archived. Rejected items flagged to Doug.

---

## Sidebar structure

### Client sidebar
  Top: Logo + wordmark
  Below logo: "Viewing" eyebrow + client company name
  Section 1 — Results: Pipeline, Campaigns, Benchmarks, Approvals
  Section 2 — Strategy: Prospect profile, Positioning, Voice guide, Messaging
  Bottom (months 1–2): Setup progress steps
  Bottom (post-unlock): Monthly progress metrics

### Operator sidebar additions
  Amber "Operator view" badge
  Client selector dropdown
  Section 3 — Operator only: All clients, Agent activity, Signals log, Settings
  Bottom: Compact client list with status dots

---

## Component and copy rules

All visual rules live in /docs/design.md. Read it before building any component.

Key copy rules:
  Never passive voice in status messages.
  Never "No data available" for empty states.
  Never vague placeholders: "data", "content", "items".
  Loading states describe what is being loaded: "Reading your website..." not "Loading..."
  One exclamation mark per interface. Use it sparingly or not at all.
