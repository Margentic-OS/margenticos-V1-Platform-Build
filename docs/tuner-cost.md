# What the sourcing tuner costs, and what it stopped costing

Measured 2026-09-09. Every figure here came from a live run against a real client's
search. Nothing in this file is estimated from a rate card except the dollar
conversion, which uses published list prices and is named as such.

## What this is about

The tuner reads a page about each sampled company so a judge can say whether that
company could buy from the client. That reading was the bill, and until this date
the project could not see most of it.

## The finding: two thirds of a lookup was invisible

`webSearch` calculated the token usage on every single call and threw it away. Only
the search fee was recorded anywhere, so only the search fee was ever costed.

One lookup, six measured, `claude-haiku-4-5-20251001`:

| line          | per lookup     | cost      | share |
|---------------|----------------|-----------|-------|
| search fee    | 1.50 searches  | $0.01500  | 57%   |
| input tokens  | 9,487          | $0.00949  | 36%   |
| output tokens | 368            | $0.00184  | 7%    |
| **total**     |                | **$0.02633** | |

9,487 input tokens buys a 930-character answer. That is the page text the
server-side search tool injects into the model's context, and it is charged as
input. It is the line nobody was looking at.

**A spend cap counted in searches therefore bounded 57% of the bill.** That is why
the cap is now in dollars.

## What was changed, and what it bought

The read was narrowed to one question with an explicit instruction to answer from
the first set of results and an explicit way to give up. Measured over 40 paired
lookups on the SAME companies, old read against new:

|                        | billable searches | input tokens | batch of 80 |
|------------------------|-------------------|--------------|-------------|
| old, 4-6 bullets       | 1.48              | 9,637        | $2.22       |
| new, one question      | 1.00              | 9,619        | $1.77       |

Every one of the 40 new lookups answered in a single search. None gave up, and none
came back too short to use.

**The verdicts held.** 33 of 40 unchanged. That number only means something next to
its control: **the judge moves 6 of 40 on identical input**, re-run with the same
rows and the same text. The cheaper read moved 7. The difference is inside the
judge's own noise and cannot be attributed to reading less.

## What could NOT be cut, and why

**The page text.** 9,637 to 9,619 input tokens, which is no change at all.

No version of the web search tool the SDK exposes has a `max_content_tokens` field.
`WebSearchTool20250305` does not, and neither does `WebSearchTool20260209`. Only the
`web_fetch` tools have one, and those take a URL, which we do not have and would
have to search for first.

So how much page arrives is the provider's decision, and there is no parameter at
any price that changes it. The only reachable saving was in how many times it
arrived, which is why the work went at the search count instead.

## The gate that is built and switched off

Asking the judge from the employer name alone, and paying only for the rows it
cannot settle, **settled 0 of 40**.

That is not the judge failing. The judge prompt says to decide "from the researched
description and the two customer descriptions above, and from nothing else", and it
defines `cannot_establish` as covering the case where there was no description.
Under those instructions a row with no research has exactly one correct answer.

Turning this on means changing what evidence the judge may use, which is a change to
**how judging works** rather than to how much is read. It is available as
`skipNamesTheJudgeCanSettle` and defaults to off.

## Where the money now gets counted

- `src/lib/tuner/pricing.ts` — list prices, named per model. An unknown model is
  priced at the **most expensive** published rate, never at zero: a ceiling that
  silently stops counting when a model is renamed is not a ceiling.
- `SpendBudget` and `LookupBudget` — ceiling in dollars, checked **before** a round
  rather than during one, so a run never stops halfway through a sample.
- Spend is logged per round, not only at the end.

## What to check if it looks wrong

- A per-lookup figure near $0.015 means the tokens are not being counted again.
  `WebSearchResult.inputTokens` is the field; it was zero for months.
- A billable-search figure above 1.0 per lookup means the brief framing is not
  reaching the API. `lookup.ts` passes `brief: true`; the request cap does not work
  and never did.
- A spend report showing searches but no tokens is the original blind spot
  returning.
