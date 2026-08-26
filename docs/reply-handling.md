# reply-handling.md — Reply Handling Reference
# Living technical reference — points to authoritative spec in /prd/sections/09-reply-handling.md.
# Update this when reply handling is built or when spec changes.

## Authoritative source
All reply handling specification lives in `/prd/sections/09-reply-handling.md`.
This file documents implementation gotchas, dependencies, and what to check if it breaks.

## Reply types (summary)
positive        → Automated same-hour response with booking link. Signed with founder name and title.
information     → No automation. Flag to client. Escalation: 15h → 48h → 72h holding msg.
negative/opt-out → Immediate suppression. Push to Instantly API. No further contact.
out-of-office   → Pause sequence. Extract return date. Resume day after (10 days default).

## Identity rule (see ADR-020)
Operator-reviewed replies: signed as founder first name, last name, and title (e.g. "Doug Pettit, Founder & Head of Pipeline").
System-generated messages (not operator-reviewed): signed as "[Company] Team".
Signature format: plain text, no links except Calendly in replies. See `design.md` for signature block spec.

## What a client sees, and what they must never see

The client-facing replies page lives at `/dashboard/replies`. Everything it renders comes
from `getClientVisibleReplies` in `src/lib/reply-handling/get-client-visible-replies.ts`,
which is the single chokepoint. Nothing else may query `reply_handling_actions` for a
client. If something did, the intent filter would simply be absent, and a client would be
shown the reply telling them to get lost.

**It had no nav entry.** The route existed, the chokepoint existed and enforced both
filters correctly, and nothing anywhere linked to it. It was reachable only by typing the
URL. It now sits first under Results in the sidebar, above Pipeline, because it is the
only client page that shows them something a person said to them.

**It also returned nothing, to everyone.** The page passed the session client, and
`reply_handling_actions` is operator-only under RLS, so every client read zero rows in
silence and saw "No replies yet". See dashboard.md, "The RLS trap".

### Shown

| On the card | Source |
|---|---|
| Name, job title, company | `prospects` |
| When they replied | `reply_handling_actions.created_at` |
| Badge: Interested, or Meeting booked | whether a `meetings` row exists for that prospect |
| Their reply, VERBATIM and complete | `signals.raw_data.body` |
| The email that prompted it, collapsed by default | `signals.original_outbound_body` |
| What was sent on their behalf, with a timestamp | see below |
| Meeting date plus "attendance is confirmed after" | `meetings.scheduled_start_at` |

**The reply we sent in their name had no surface anywhere in the product.** It goes out
from the client's domain, in their founder's name, and until now they had no way to read
it. It comes from one of two places, and the operator-approved one wins if both exist:

- a Tier 2/3 draft, only at `reply_drafts.status = 'sent'`, body `final_sent_body`,
  timestamp `sent_at`
- a Tier 1 automatic reply, only when `reply_handling_actions.action_succeeded` is true,
  body `action_payload.reply_body`, timestamp the action row's `updated_at`

Read-only. The card renders no textarea, no input and exactly one button, which is the
prompting-email toggle. A test asserts that.

### Never shown

Negative replies, out-of-office, wrong-person and unclear are excluded by the intent
filter and never leave the database. Bounced addresses do not appear here at all.

Beyond that, three things that ARE on the row are deliberately not selected, so they
cannot leak through a spread, a log line or a nested object: `classified_intent`,
`classification_confidence` and `tier_assigned`. `classified_intent` appears only in the
WHERE clause and is never read back. A test serialises the whole result and asserts no
intent string appears anywhere in it.

**The badge used to be the intent in disguise.** The card rendered one of five labels:
"Ready to book", "Interested", "Asking about details", "Asking about pricing",
"Interested but hesitant". That is the five-intent vocabulary wearing a friendly coat. It
is now two-valued and derived from whether a meeting exists, which is a fact about the
world rather than a judgement about a person.

**A draft awaiting approval is the operator's business.** `status` in `pending`,
`approved` or `rejected` is filtered out at the query, not at the render. Without the
`.eq('status', 'sent')` the page would show a client, as something already said in their
name, text nobody has approved.

### What to check if it breaks

- Empty for a client but full for an operator: RLS. The chokepoint builds its own
  service-role client now, so this should be impossible, but check
  `SUPABASE_SERVICE_ROLE_KEY` is set. Its absence throws rather than returning `[]`,
  deliberately: an empty list reads as "you have had no replies".
- A reply appears with no "Sent on your behalf" block: either nothing was sent, the Tier 1
  send failed (`action_succeeded` false), or the draft is not at `sent` yet. All three are
  correct behaviour.
- The count on the overview disagrees with the number of cards: both read
  `reply_handling_actions` filtered by `CLIENT_VISIBLE_INTENTS`, imported from this
  module. If they disagree, someone has made a second copy of that list.

## What an operator sees

The mirror of the section above. `getOperatorRepliesForOrg` in
`src/lib/reply-handling/get-operator-replies.ts`, rendered at
`/dashboard/operator/clients/[id]/replies`, reachable from the operator sidebar.

All eight intents, no filter, grouped with counts. It carries what the client view is
built to withhold: the raw intent, the classification confidence, the tier, and drafts at
every status rather than only `sent`. The reply body is verbatim in both views.

**Why it is a separate file and not a flag.** `getClientVisibleReplies` enforces one rule
at one place: a client never sees a reply outside `CLIENT_VISIBLE_INTENTS`. A parameter
that turns that filter off would live inside the function whose entire purpose is applying
it, one wrong argument away from showing a client the reply telling them to get lost. Two
functions, two files, no shared switch.

`get-operator-replies.unit.test.ts` asserts the intent filter is absent, that all three
client-hidden intents come back, and that the drafts query carries no `status = 'sent'`.
Those are the assertions that fail loudly if someone ever merges the two reads.

### What to check if it breaks

- Empty for an operator too: `SUPABASE_SERVICE_ROLE_KEY`. This function throws on its
  absence rather than returning an empty result, for the same reason as the client one.
- A reply shows no draft: `log_only` and `tier_1_handled` routes never create one. See
  `route-intent.ts`. That is correct, not a missing row.
- An intent appears under a raw name like `something_new`: the classifier produced an
  intent this module has no label for. It is appended rather than dropped on purpose, so a
  new intent shows up looking odd instead of vanishing from the operator's count. Add it
  to `INTENT_ORDER` and `INTENT_LABELS`, and to `KNOWN_INTENTS` in `route-intent.ts`.
