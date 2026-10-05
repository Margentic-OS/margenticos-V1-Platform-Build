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

Each tier gets one retry with its failures stated, then falls to the next.

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
- **Spend:** one `research_usage` row per prospect, arm `writer_v2`, the writer's tokens in the `opening` column.

## How to turn it on for a client

1. Decide any pending messaging suggestion (only one can be pending per client).
2. `npx tsx scripts/propose-writer-playbook.ts --org <id> --playbook .writer-export/<file>.json`, then approve the suggestion in the dashboard.
3. Set `organisations.sequence_writer_v2_enabled = true` for that client.
4. Write sequences for prospects already researched: `npx tsx scripts/run-writer-v2.ts --org <id> --out-dir .writer-export/<dir> --persist`. New research writes them automatically.

## What to check if it breaks

- **Uploads hold with "writer v2: ...":** the prospect has no shippable sequence. Run step 4 for it. "Trial playbook file" means it was written before the playbook was approved; rerun with `--persist`.
- **"the messaging document has no writer_playbook":** the playbook was never approved, or a pending messaging suggestion without it was approved over it. Propose it again.
- **Everything lands in the template tier:** read the check failures in `prospects.writer_v2_sequence->attempts`.
- **Spend looks wrong:** `research_usage` rows with `arm = 'writer_v2'`.

## Why key decisions were made

- **Only three checks.** The old gates rejected natural writing. The operator's blind read is the quality bar; word count and truth are the hard rules.
- **The playbook lives in the messaging document,** so it is versioned, restorable and approved the same way as every other piece of client copy.
- **Template is the last resort, with old copy set aside,** so a v2 client never receives a half-old sequence.

## Writer guidance added after the first read (2026-10-04)

Generic, in `src/lib/writer-v2/prompt.ts`: one idea per short paragraph and the question alone on its own line (replacing "aim shorter" targets, which moved nothing over 20 prospects; the hard limits stay); one story across the emails when a personal fact exists; never tie the offer or close to the prospect's audience or event (timing references are fine); long titles referred to briefly; a fear named by what the reader would lose; questions the reader can answer now; hedged situations, no absolutes; abbreviated months and no relative day or week words; the prospect's own facts first; no traits or workload guesses; stock lines at most once per sequence. Where their work comes from is asked, never stated.

## Retry reduction (2026-10-05)

After the first batch (188 MargenticOS prospects: 58 passed on the first call, 346 calls in all, 130 with at least one failed attempt), four changes were made to cut the paid retries. The checks are no looser on truth or never-claims. **The trial below did not show a reduction.** Code: `src/lib/writer-v2/checks.ts`, `src/lib/writer-v2/prompt.ts`.

1. **Word budget for what the writer writes.** The hard limits are unchanged and still count the email as sent: the greeting, the body and the two-line sign-off, with the footer excluded. The writer is now given the limits for the words after its greeting line (`bodyWordLimits`, derived from the bands for each prospect and sent in the user message). A word-count failure states both numbers. In the batch, every one of the 121 word failures was over the limit.
2. **An offer line naming the firm only as who it is for is a sender claim.** "We find the right buyers for <firm>" and "We work out who <firm> serves best" are judged by the scope check, never as a claim about the firm (`asSenderClaimForTheFirm`). Only those two shapes count. If the firm is named any other way ("so it stops at <firm>", "<firm>'s new practice"), or the sentence is not about what we do, it stays a claim about the firm. A citation never lets such a sentence pass: the words themselves must be in the offer.
3. **A sentence may cite several facts** ("R1, R2", "R3 and R1"). Every cited fact must exist and be usable, and a month or year must match one of them. The chosen fact (`fact_used`) stays one id, because it decides the tier.
4. **Scope reads actions, not wording.** A sender claim passes if the line it cites is in the playbook, or if every content word in it appears in the playbook's offer, short wordings or proof (`wordsOutsideOffer`). The words come from the client's own playbook, never from a list in code. The never-claim and call-to-action patterns still run on every sentence, so "we take the calls" fails even though each of its words is in the offer.

The limit of check 4, stated so nobody over-trusts it: it reads words, not meaning. A sentence that rearranges the offer's own words into a different claim would pass it. The never-claim patterns are the backstop for the claims that matter most.

Trial rerun with a comparison against the stored sequences: `npx tsx scripts/run-writer-v2.ts --org <id> --out-dir .writer-export/<dir> --n 20 --cap 2 --rerun-written` (trial only; writes `comparison.md`, including every sentence that passed only because of these rules).

**Trial, 2026-10-05, 17 of the batch's prospects (3 more timed out), $1.18:** first-call pass 5 of 17 (29%) against 6 of 17 stored for the same prospects; 1.94 calls a sequence against 1.71; $0.070 a sequence against $0.055. That is no improvement, within the noise of 17. What still failed: 8 sequences over length, by 2 to 14 words, even with the writer-side number stated. Telling the model a number does not make it count, which matches the 2026-10-04 finding about length targets. The other failures were sentences naming the firm some other way than as who the work is for ("most firms at <firm>'s stage", "for a firm like <firm>"), and sender lines with a clause beyond the offer ("without you needing to hire"). Three multi-fact sentences passed with content the writer guidance forbids: a workload guess ("show <firm> is busy", "a lot to carry"), and one stated how they win work. Nothing checks content at that level, for single-fact claims either.
