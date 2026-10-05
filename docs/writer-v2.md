# Writer v2

## What it does

For a client with `organisations.sequence_writer_v2_enabled = true`, one model call writes each prospect's whole four-email sequence, as one conversation, from:

- every dated research fact stored for the prospect (12 months at most, the last 6 preferred, never a founding date, tagline or ended role);
- the firm fact (what the firm does, quoted from its website), or else the industry label;
- the client's playbook: market story, angles, offer, proof, never-claim list, calls to action, voice and approved example emails. It lives in the messaging document as `content.writer_playbook`.

Every sequence records a tier:

| Tier | When |
|---|---|
| personalised | a qualifying research fact exists and a sequence built on it passes the checks |
| semi-personalised | no research fact qualifies, or the personalised tier failed twice |
| template | the last resort: the client's approved template, with no old-writer copy |

Each tier gets one retry with its failures stated, then falls to the next. An attempt that fails **only** because some emails are too long is first shortened (see below). Only if that fails does the retry run.

Decision record: ADR-068. Spec: Notion, "Writer v2: playbook format, MargenticOS playbook v1, writer instructions (prototype spec)".

## Where the code is

| Piece | File |
|---|---|
| The agent (entry point) | `src/agents/sequence-writer-agent.ts` |
| Generic prompt (no client content) | `src/lib/writer-v2/prompt.ts` |
| The only checks, and the dash and paragraph transforms | `src/lib/writer-v2/checks.ts` |
| Fact eligibility | `src/lib/writer-v2/facts.ts` |
| Playbook shape, validation, rendering | `src/lib/writer-v2/playbook.ts` |
| What is stored on the prospect, and whether it may ship | `src/lib/writer-v2/record.ts` |
| Composition of a stored sequence | `src/lib/composition/writer-v2-compose.ts`, branch at the top of `composeSequence` |
| Propose a playbook | `scripts/propose-writer-playbook.ts` |
| Trial run and reading file | `scripts/run-writer-v2.ts` |

## What it connects to

- **Research** (inline, queue and batch collect): when the switch is on, `produceOpening` skips the old writer before paying for it, the firm fact is extracted for every prospect, and `maybeWriteSequenceAfterResearch` writes and stores the sequence.
- **Upload** (`handleUploadLeads`): composes from `prospects.writer_v2_sequence`. A prospect with no shippable sequence is held (back to pending, reason on the row), never sent on old copy.
- **Footer and List-Unsubscribe:** the footer is added by `finaliseForReading`, the same single call site as every email. For a writer v2 client it is the playbook's `opt_out_footer` when set (validated as a notice), in all three tiers; otherwise the default. It travels on the composed sequence (`opt_out_footer`) so the HTML still spaces it as a notice. The List-Unsubscribe header is added by the sending tool (`insert_unsubscribe_header` on the campaign, read back 2026-10-03).
- **Reply handling** reads the sent copy from the sending tool, so v2 sequences are covered with no change.
- **Reporting:** `sent_sequences.sequence_writer`, `writer_tier` and `playbook_version`. The sourcing funnel counts a v2 personalised prospect as personalised.
- **Spend:** one `research_usage` row per prospect, arm `writer_v2`, with the writer's tokens in the `opening` column. A second row, arm `writer_v2_shorten`, is written when any shorten call was made. Both are priced the same way and both count in run spend.

## How to turn it on for a client

1. Decide any pending messaging suggestion (only one can be pending per client).
2. `npx tsx scripts/propose-writer-playbook.ts --org <id> --playbook .writer-export/<file>.json`, then approve the suggestion in the dashboard.
3. Set `organisations.sequence_writer_v2_enabled = true` for that client.
4. Write sequences for prospects already researched: `npx tsx scripts/run-writer-v2.ts --org <id> --out-dir .writer-export/<dir> --persist`. New research writes them automatically.

## What to check if it breaks

- **Uploads hold with "writer v2: ...":** the prospect has no shippable sequence. Run step 4 for it. "Trial playbook file" means it was written before the playbook was approved; rerun with `--persist`.
- **"the messaging document has no writer_playbook":** the playbook was never approved, or a pending messaging suggestion without it was approved over it. Propose it again.
- **Everything lands in the template tier:** read the check failures in `prospects.writer_v2_sequence->attempts`.
- **Spend looks wrong:** `research_usage` rows with `arm = 'writer_v2'` and `arm = 'writer_v2_shorten'`.
- **Was a sequence shortened, and what was cut?** In `prospects.writer_v2_sequence->attempts`, an attempt with `kind = 'shorten'` holds each email it shortened, `before` and `after`.

## Why key decisions were made

- **Only three checks.** The old gates rejected natural writing. The operator's blind read is the quality bar; word count and truth are the hard rules.
- **The playbook lives in the messaging document,** so it is versioned, restorable and approved the same way as every other piece of client copy.
- **Template is the last resort, with old copy set aside,** so a v2 client never receives a half-old sequence.

## Writer guidance added after the first read (2026-10-04)

Generic, in `src/lib/writer-v2/prompt.ts`: one idea per short paragraph and the question alone on its own line (replacing "aim shorter" targets, which moved nothing over 20 prospects; the hard limits stay); one story across the emails when a personal fact exists; never tie the offer or close to the prospect's audience or event (timing references are fine); long titles referred to briefly; a fear named by what the reader would lose; questions the reader can answer now; hedged situations, no absolutes; abbreviated months and no relative day or week words; the prospect's own facts first; no traits or workload guesses; stock lines at most once per sequence. Where their work comes from is asked, never stated.

## Shorten before retrying (2026-10-05)

**What it does.** When an attempt fails only because one or more emails are over their word limit, those emails alone go back to the model in a small, separate call: the generic shorten prompt and the emails, with no playbook. The answer replaces just those emails, and the whole sequence is checked again with every check. If it passes, the sequence is done with no full rewrite. If it fails, or the answer is malformed or cut off, the normal retry runs exactly as before. An attempt with any other failure, or with an email that is too short, goes straight to the normal retry. Code: `overLengthOnly` in `checks.ts`, `shortenOverLength` and `shortenRequest` in `sequence-writer-agent.ts`, the prompt in `prompt.ts`.

**The request.** It says what to keep: the greeting, the personal detail, the consequence for the reader (what they would lose or risk), the offer, the question, and each declared sentence word for word, so the declarations still match. It says what to cut first: lead-in phrases, repetition and extra qualifiers. It asks for about 10 words under the limit, because the model does not count exactly; code does the final count. It asks for the text only, capped at 300 output tokens per email.

**Why.** Stating the limit in the main prompt did not reduce over-length drafts. That was measured on 4 and 5 Oct 2026 and recorded in the Notion Knowledge Base. In the first batch, all 121 word-count failures were over the limit, and each one paid for a full rewrite of four emails. Shortening acts on the draft after it exists, and costs a fraction of a rewrite.

**The limit, stated so nobody over-trusts it.** The checks re-run on the shortened text, so nothing untrue or out of scope can get through. But a cut that drops meaning without breaking a check is not caught. The first trial dropped what the reader would lose from one email, which is why the request now names it as something to keep.

**Trial, 2026-10-05: 17 prospects from the first batch, trial only, $0.89.** The first 5 ran with the first version of the shorten request, the other 12 with the one above. Passed with no full rewrite: 9 of 17, against 6 of 17 stored for the same prospects. 7 shorten calls, 6 of which passed, costing about $0.006 each, against about $0.03 for a full rewrite. Cost per sequence $0.053, against $0.055 stored. Calls per sequence 2.00, against 1.71: a shorten is a call, and on this run more first drafts failed than when the batch was written, which is ordinary writer noise. The remaining full rewrites were mostly for claims citing several facts, and for sentences naming the firm.

**What shortening did to meaning.** On reading every shortened email: "cut extra qualifiers" also removes hedges. "We hear from founder-led firms: outreach is ..." became "For founder-led firms, outreach is ...", and "tends to stay" became "stays". Twice, a cut removed half of an argument or the cost to the reader. No check catches either.
