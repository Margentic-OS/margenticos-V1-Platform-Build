# design.md — MargenticOS Design System
# Read this before building any UI component, dashboard view, or user-facing string.
# This is the single source of truth for visual and copy decisions.

---

## Core design philosophy

The MargenticOS dashboard is not a SaaS product UI.
It is a client intelligence platform that needs to feel like a premium, bespoke service.
The aesthetic is warm, precise, and confident — not startup-generic or corporate-cold.

Two principles that override everything else:
1. Nothing should look like AI generated it
2. Every string should sound like a specific human wrote it for this specific client

---

## Colour palette

### Primary surfaces
Page shell background:    #EDE8DF  — warm beige, outermost container
Main content background:  #F8F4EE  — warm off-white, primary content area
Card background:          #FFFFFF  — pure white, all cards and panels
Card border:              #E8E2D8  — 1px, subtle warm grey

### Sidebar
Client sidebar:           #1C3A2A  — dark green
Operator sidebar:         #1A2E1A  — slightly darker green (signals operator mode)
Sidebar active state:     rgba(245,240,232,0.08) with left border #A8D4B8

### Brand greens
Dark green (primary):     #1C3A2A
Accent green (active):    #A8D4B8
Success green (positive): #3B6D11
Light green (bg tint):    #EAF3DE
Light green (border):     #C0DD97 / #BDDAB0

### Amber (warnings, pending)
Amber primary:            #EF9F27
Amber background:         #FEF7E6 / #FAEEDA
Amber border:             #F0D080
Amber text (on light):    #7A4800

### Status indicators
Qualified / on track:     #3B6D11 text, #EBF5E6 bg, #BDDAB0 border
Pending / warning:        #7A4800 text, #FEF7E6 bg, #F0D080 border
Unqualified / error:      #8B2020 text, #FDEEE8 bg, #EFBCAA border
Building / warmup:        #7A4800 text, #FEF7E6 bg (same as pending)

### Text
Primary text:             #1A1916
Secondary text:           #9A9488
Tertiary / muted:         #C8C3B8
On dark green:            #F5F0E8 (primary), rgba(245,240,232,0.55) (secondary)

---

## Typography

Font: System sans-serif stack (no custom fonts needed)
Weights: 400 (regular) and 500 (medium) only. Never 600 or 700 — too heavy.

Scale:
  Page title:           18px, weight 500
  Section heading:      16px, weight 500
  Card title:           13px, weight 500
  Body / default:       12px, weight 400
  Labels / eyebrows:    10px, weight 400, uppercase, letter-spacing 0.07em
  Small / meta:         10px, weight 400
  Tiny / tags:          9–10px, weight 500

Eyebrow labels: always uppercase, 0.07–0.09em letter spacing, secondary text colour.
Never use all-caps for body copy or headings — eyebrows only.

---

## Spacing and layout

Border radius:
  Cards and panels:     10px (border-radius: 10px)
  Buttons and pills:    20px (fully rounded) or 6–8px (subtle)
  Small tags/badges:    4–6px
  Inner elements:       4–6px

Card padding:           18–22px (generous, never cramped)
Content padding:        22–28px from container edges
Gap between cards:      14–18px
Gap within card rows:   10–14px

Sidebar width:          210px fixed
Never use inline styles. Always Tailwind utilities.

---

## Component patterns

### Status pills
Used for: campaign status, client status, approval state

  Live / Active:     dark-green dot + "Campaigns live" — green pill (#EBF5E6 bg)
  Warming:           amber dot + "Warming up" — amber pill (#FEF7E6 bg)
  Setup:             grey dot + "Setting up" — grey pill (#F0ECE4 bg)
  Operator mode:     amber dot + "Operator mode" — amber pill

### Cards
White background, 1px #E8E2D8 border, 10px radius, generous padding.
No shadows. No gradients.
Card header: title (13px 500) on left, meta/link (11px secondary) on right.
Card content: clear hierarchy, breathing room between rows.

### Meeting qualification badges
  Qualified:         #2B5A1E text, #EBF5E6 bg, #BDDAB0 border
  Flag pending:      #7A4800 text, #FEF7E6 bg, #F0D080 border
  Not qualified:     #8B2020 text, #FDEEE8 bg, #EFBCAA border
  No show:           same as not qualified

### Progress bars
Height: 3–6px. Background: #F0ECE4. Fill: #1C3A2A.
Border radius: 2–3px.
Used for: meetings toward target, emails sent, warmup progress.

### Sidebar navigation
Active item: #1C3A2A bg tint + 2px left border #A8D4B8 + white text 500
Hover item: rgba(245,240,232,0.04) bg
Inactive text: rgba(245,240,232,0.50)
Active text: #F5F0E8, weight 500

Group labels: 8px, rgba(245,240,232,0.28), uppercase, letter-spacing 0.09em

Operator-only nav items: #EF9F27 tinted text (amber) to visually distinguish

### Approval/notification banners
Amber variant (pending approval):
  #FEF7E6 bg, #F0D080 border, amber dot, #7A4800 text
  "Review now" button: rgba(122,72,0,0.07) bg, #F0D080 border

### Empty states
Never show a blank space. Always show:
  - A clear statement of what will appear here
  - When it will appear
  - What is happening in the meantime

Example: "Your first campaign launches 1 May — meetings will appear here."
Never: "No data available."

### Version badges
Strategy document versions: 10px text, #9A9488 colour, #F0ECE4 bg, 8px radius
Format: "v1.0", "v2.1" — always lowercase v, always one decimal place

---

## Dashboard view structure

### Client sidebar (all views)
Top: logo + wordmark
Below logo: "Viewing" eyebrow + client company name
Nav section 1 "Results": Pipeline, Campaigns, Benchmarks, Approvals
Nav section 2 "Strategy": Prospect profile, Positioning, Voice guide, Messaging
Bottom: context-dependent (setup progress steps OR monthly progress metrics)

### Topbar (all views)
Left: eyebrow + title + subtitle
Right: status pill + avatar initials

### Operator sidebar additions
Amber "Operator view" badge below logo
Client selector dropdown (switch between all clients)
Additional nav section "Operator only": All clients, Agent activity, Signals log, Settings
Bottom: compact client list with status dots

---

## Motion and interaction

No animations on data or metrics.
Hover states: subtle background tint (Tailwind hover: utilities only).
Active states: immediate, no transition delay.
Loading states: skeleton screens that match the card layout they replace.
No spinners in the main content area — skeleton only.

---

## UI copy rules

These are as important as the visual rules. Every string must pass this test:
"Would a specific, competent human write this exact sentence?"

### Rules

Never use passive voice in status messages.
Never use corporate filler words: "leverage", "utilize", "synergy", "streamline".
Never use vague placeholders: "data", "information", "content", "items".
Never use AI-sounding affirmations: "Great!", "Absolutely!", "Certainly!".
Never write generic empty states: "No data available for this period."
One exclamation mark per interface. Use it sparingly or not at all.

### Tone by context

Empty states (waiting for data):
  Forward-looking, specific, warm.
  "Your first campaign launches 1 May — meetings will appear here."
  "Strategy is ready. Signals will start processing once campaigns go live."

Progress / momentum states:
  Confident, specific, quietly reassuring.
  "On track — 7 of 8 meetings this month."
  "4 signals processed this week. Strategy is learning."

Approval notifications:
  Direct, clear, no pressure.
  "2 sequences waiting for your approval — auto-approves in 3 days."
  "Not the right fit? Just reply 'stop' and I'll leave you alone."

Error / warning states:
  Calm, diagnostic, never alarming.
  "Reply rate has dropped below 3% for two weeks — worth investigating."
  Never: "ERROR: Campaign performance degraded."

Action prompts:
  Specific, one clear next step.
  "A prospect has asked about your offer. This needs your reply today."
  Never: "Action required."

Loading states (skeleton copy):
  Describe what is being loaded, not that it is loading.
  "Reading your website..." not "Loading..."
  "Building your prospect profile..." not "Please wait..."

### Sign-offs for outbound emails

**ADR-020 (May 2026):** All sent replies sign off with the founder's first name only.

  \n\n${founderFirstName}

Never: company team name, never "AI", never "MargenticOS", never "automated".

Phase 2 operator-approved drafts: the operator reviews and approves before sending, so
signing as the founder is accurate — a human did review it.

Phase 1 auto-Calendly responses (high-confidence direct booking signal): tightly
constrained body, purpose-built for brevity and factual content. Founder sign-off is
consistent with the founder personally responding to a booking request.

Company team attribution is retained only for system-generated messages that are
not operator-reviewed: holding messages (information request escalation) and opt-out
confirmations. These are separate code paths not affected by ADR-020.

`organisations.founder_first_name` is a hard requirement at send time. Missing it
blocks the send with a logged error. Must be populated during client onboarding before
any campaigns go live.

Opt-out footer (mandatory in all outbound):
"Not the right fit? Just reply 'stop' and I'll leave you alone."
Never use the word "unsubscribe."

90-day document refresh email tone:
Warm, personal, from Doug. Not a system notification.
"It's been 90 days — anything changed worth updating in your strategy?"

---

## Strategy document display

Documents display in clean, readable format. No clutter.
Section headings: 14px weight 500, dark green left border accent (3px, rounded).
Body text: 12–13px, 1.6 line height, primary text colour.
Version indicator at top: "v2.1 — Updated 3 days ago · Trigger added"
Living status: small pulse dot + "Strategy is learning from campaign data"

---

## Dashboard design variants reference

Three views have been designed and mockup-verified:

1. Client pipeline view (active engagement, post-unlock)
   Primary focus: momentum block with progress bar to monthly target
   Secondary: reply rate vs benchmark, qualified rate, pipeline value (smaller)
   Layout: approval banner → momentum block → [meetings list | strategy panel] → stats row

2. Empty state view (months 1–2, or pre-5 meetings)
   Primary focus: welcome card (dark green bg) with warmup explanation
   Three setup step cards, strategy panel showing all docs "Ready v1.0"
   Sidebar shows setup progress steps

3. Operator view
   Darker sidebar, amber operator badge, "View as client" button
   Warnings rail between banner and content
   Cross-client panels: all clients, approval queue, agent activity, doc health

These are the approved visual direction. Do not deviate without flagging to Doug first.
