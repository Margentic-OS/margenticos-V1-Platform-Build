# The HTML a prospect actually receives

## What this does

Our messaging documents hold plain text. A prospect's inbox needs HTML. This is the
layer that turns one into the other, and it is smaller than you would expect: two
pieces of code, a few lines each.

**Piece one, the paragraphs.** `plainTextToHtml` in
`src/lib/composition/custom-variables.ts` takes the composed body, splits it wherever
there is a blank line, and wraps each paragraph in a `<p>` tag. The result is stored on
the prospect's record at the outbound provider as `m_body_1` through `m_body_4`.

**Piece two, the wrapper.** `syncSequenceShell` in
`src/lib/integrations/handlers/instantly/syncSequenceShell.ts` writes a campaign
"shell": a four-step sequence where each step's body is just `<body>{{m_body_N}}</body>`.
The provider substitutes each prospect's own paragraphs into that placeholder at send
time.

So the sent document is assembled from three sources: the provider supplies
`<html><head>...</head>`, we supply the `<body>` wrapper, and we supply the paragraphs
inside it.

## What to check if it breaks

**Emails arrive double-spaced.** Look at `plainTextToHtml`'s final `.join('')`. If it
has become `.join('\n')`, that is the bug. The provider converts every newline inside a
substituted variable value into a `<br>`, so a newline between `</p>` and `<p>` arrives
as `<p>a</p><br><p>b</p>`: the spacing a `<p>` already carries, plus a line break on top.
That shipped on 2026-08-21 and every email in that send had two blank lines between
every sentence. It is not a cosmetic problem. Nobody writes an email that way, and
looking automated is the specific risk this product is trying to avoid.

The join must produce a value with **no newline characters at all**. `<p>` tags carry
their own spacing and need no separator.

**One `<br>` is correct and must survive.** The sign-off is two lines inside a single
paragraph: `<p>Doug<br>MargenticOS</p>`. That comes from a single newline *within* a
paragraph, which `plainTextToHtml` deliberately converts. Do not "fix" it.

**The opt-out footer disappears or loses its spacing.** The footer gets its own
paragraph with `style="margin-top:32px"`, applied in `plainTextToHtml` by matching the
exact footer string from `src/lib/composition/opt-out-footer.ts`. The margin is the only
thing separating it from the sign-off, because `plainTextToHtml` drops blank paragraphs,
so the gap cannot be expressed as extra newlines in the body text. This footer was
silently missing from every stored email once before. It is the compliance line. Tests
in `src/lib/composition/__tests__/composed-email-html.test.ts` gate it.

**The sent mail has no `<body>` tag.** The provider builds the outer document and drops
our shell step body straight in after `</head>`. Our wrapper is the only part of that
document we control, so if it is not a `<body>`, the message does not have one. Some
filters score malformed HTML.

## Why the wrapper is `<body>` and not `<p>`

It used to be `<p>{{m_body_N}}</p>`. That was wrong twice over. It left the sent document
with no `<body>`, and it put block-level `<p>` children inside a `<p>`, which HTML does
not allow and browsers silently repair by closing the outer tag early. Changing the
wrapper to `<body>` fixes both with one edit and adds nothing new to the template.

## What a change here does and does not reach

This is the part that catches people out. **`m_body_N` is never stored in our database.**
It is computed at upload time in
`src/app/dashboard/operator/clients/[id]/actions.ts` and pushed straight onto the
provider's lead record, where it then lives for the life of that lead.

- A change to `plainTextToHtml` reaches **only prospects uploaded after the change
  deploys.** Prospects already uploaded keep the values already on their lead records,
  for every remaining step of their sequence.
- A change to the shell wrapper reaches a campaign **only when that campaign's shell is
  next synced.** Nothing syncs automatically. The only caller is a deliberate operator
  action.

If a fix needs to reach prospects who are already uploaded, the composition change is
not enough on its own. Those leads have to be re-uploaded, which is a live write to an
actively sending campaign and should be a conscious decision, not a side effect.

## A live hazard worth knowing about

`syncSequenceShell` PATCHes the entire `sequences` array, all steps at once. If anyone
has hand-edited a step in the provider's UI, a re-sync replaces it without warning.
This has already happened: step 1 of campaign `cf695496` was hand-edited to
`<div>{{m_body_1}}</div>` while our code writes `<body>`. See BACKLOG.md.
