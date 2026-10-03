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
- **Footer and List-Unsubscribe:** the footer is added by `finaliseForReading`, the same single call site as every email. The List-Unsubscribe header is added by the sending tool (`insert_unsubscribe_header` on the campaign, read back 2026-10-03).
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
