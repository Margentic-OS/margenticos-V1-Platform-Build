# Research arms: the 50/50 split, the batch route, and the upload hold

**Decision record:** ADR-069 in `docs/ADR.md`. **Backlog:** "BUILD: move production research to the batch route".

## What this does, in plain English

Every prospect is researched by an AI model that reads its sources and picks the one fact worth opening an email on. That reasoning costs most of the money. There are two ways to ask the model for it:

- **standard**: the request as it has always been built.
- **short_reasoning**: the same request with one extra instruction asking the model to keep its reasoning short. It writes about 63% less, and costs about 41% less across the whole research step. Its effect on who gets emailed is not yet proven, so its output waits at the upload gate until the operator approves it.

Two rules make this safe:

1. **Random, fixed, and recorded.** A prospect is given an arm by a coin flip before it is researched. The arm is written once on the prospect and never changed. Every research row and every spend line records which arm produced it.
2. **Nothing waits on the test.** If the split switch is off, or cannot be read, every prospect is standard. The batch runs and nothing is held.

## What it connects to

| Piece | Where | What it does |
|---|---|---|
| Arm type and draw | `src/lib/agents/research/research-arm.ts` | Pure: the two arms, the coin flip, the balanced plan for a dry run. No database. |
| Stored assignment | `src/lib/agents/research/research-arm-store.ts` | Assigns, reads, settles and releases arms. Every write is conditional on the arm being empty. |
| The instruction | `src/lib/agents/research/synthesize.ts` (`SHORT_REASONING_INSTRUCTION`) | Appended to the user message only, so the cached part of the request is identical for both arms. |
| Batch submission | `src/lib/agents/research/batch-sweep.ts` | Reads each prospect's stored arm and builds its request under it. |
| Collection | `src/lib/agents/prospect-research-collect-agent.ts` | Reads the stored arm and the batch id and records them on the research row and spend line. |
| Inline path | `src/lib/agents/prospect-research-agent-v2.ts` | Settles an unset prospect to standard. Never assigns the short arm. |
| Enqueue | `src/lib/queue/enqueue/research.ts` | Assigns arms, before phase one, for named or scope runs on the batch route. |
| CLI runner | `scripts/run-research.ts` | `--ids` now goes to the batch route. Only `--fresh` runs inline. |
| Upload hold | `src/lib/sourcing/send-gate.ts` (`RESEARCH_ARM_RELEASED_CLAUSE`) | The one shared gate. Holds a short prospect until released. |
| Comparison | `src/lib/operator/research-arm-report.ts` | Per arm: personalised share, tier split, fit grades, cost per research, per 100, per personalised email. |
| Operator script | `scripts/research-arms.ts` | `report`, `approve --yes`, and `split --set on|off`. |
| Dry run | `scripts/research-arm-dry-run.ts` | Six named prospects, three per arm, through the real route, with a cap. |

## What to check if it breaks

- **A prospect is held that should not be.** Run `scripts/research-arms.ts report --org <id>`. The count held should match prospects with arm `short_reasoning` and no release. If a batch is done and its short prospects are still held, check that the batch was approved with `--yes`.
- **Every prospect is standard even though the switch is on.** The switch read may be failing, which is logged as "could not read the split switch". Or every prospect already has prior research, which is the rule, not a fault.
- **An enqueue is refused with "could not store".** The arm write failed. Nothing was queued. The log names the error.
- **Research rows missing an arm.** Rows from before 6 October 2026 have none, which reads as standard. Rows after that date with none are a bug: the collect step or the inline step did not record the arm.
- **Cost per prospect looks wrong.** Check `research_usage.synthesis_batched`. A short-arm row with `synthesis_batched = false` was researched inline, which should only happen with `--fresh`.

## Why the key decisions were made

- **The arm is decided before research, not after.** A decision made after the research would be made on the output it is meant to judge, and a rerun could flip it.
- **The arm is stored, not recomputed.** A retry, a resubmitted batch or a second enqueue must produce the same arm, or the record of what ran is false.
- **The instruction is appended to the user message, never the system prompt.** The system block is what the prompt cache keeps. Changing it would cost a cache miss on every prospect.
- **Prospects with prior research are standard.** Their findings predate the split, or a reuse run makes no synthesis call. Recording the short arm for them would describe a request that never ran.
- **Release is by batch, and covers failures.** A prospect whose research failed ships as a template, where the arm changes nothing, so holding it would only delay it.
- **The switch is off by default.** Turning the split on changes what the next batch does, so it is an explicit operator action with a before and after printed.

## Verified against the live database

Migration `20261006100000_research_arm` was applied to production (`hjpvnvjryxdjcfdsfhzy`) and the test database (`tidqheqjzvwmrrrebzir`). On both, all six columns exist with the expected types and defaults, both CHECK constraints and the foreign key exist, and table grants are unchanged. Production's grants differ from the test database's (see the Backlog finding on grants).

## Not built

- A panel on the upload page. The comparison is a report.
- An approval path for short research with no batch (an explicit `--fresh` inline run of a short-arm prospect).
- The batch-route worst-case in the CLI's spend check. It still prices a fetch at full price, so six fetching prospects at a $2 cap are refused. The dry run uses a stated projection instead.
