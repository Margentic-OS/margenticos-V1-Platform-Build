# Handover — Apollo sourcing filter (2026-08-26)

**Merge `origin/sourcing-filter-location-gap`. It is the only branch you need, and it
already contains everything.** It builds straight on `origin/sourcing-filter`, whose tip
`7b77f53` is an ancestor of it, so that branch is not a second thing to merge. Two of the
three commits are already on it and the third is the new work: `8960fa6` replaced the Apollo query with one hardcoded, measured filter
and fixed two silent defects (`q_keywords` is AND over company NAMES, and Apollo seniority
is title-derived so the owner of a consulting firm is usually titled Partner); `7b77f53`
stopped the filter's arrays being shared by reference between calls, which was a
cross-client contamination waiting to happen; and `bca680d` closed the location gap by
adding `person_locations`, brought the ICP spec defaults into line at `['GB','IE','US']`,
and wrote ADR-032. The shipped filter measures **55,975** live, down from 61,523, and that
9 percent of inventory buys back 545 people located in Canada and 238 in Germany who were
reachable at US/UK/IE-registered firms. CASL attaches to the recipient, so that was the
same exposure as the two GmbHs that were mailed, not a smaller one. Read ADR-032 before
changing any value in `APOLLO_FILTER`: every number in it was measured, one parameter at a
time, and Apollo silently ignores a parameter it does not recognise rather than erroring,
so a name typo ships a filter that filters nothing and looks perfectly healthy.

**Never merge the local `sourcing-filter` branch. Merge from origin only.** The local
branch sits at `9977bf8`, one commit ahead of what was ever pushed, and that extra commit
is not from this work at all: it is a duplicate of the other session's
`20260826120000_synthesis_batches.sql` migration, which landed there when a checkout moved
HEAD out from under them in the shared directory. Their own correct copy is already safe on
`origin/batch-synthesis` as `2e9d008`, byte-identical blob (`fafd4f8`), so nothing is at
risk and nothing needs recovering. That local commit was deliberately never pushed and must
never be reset or force-pushed either; it simply dies unmerged. The one worktree fact that
will bite you: `sourcing-filter-location-gap` is checked out in a linked worktree at
`/private/tmp/margenticos-sourcing-filter`, so git will REFUSE to check that branch out in
the main directory while it exists, with a "already checked out" error that looks like
corruption and is not. After merging, run `git worktree remove
/private/tmp/margenticos-sourcing-filter` (or `git worktree prune` if the directory is
already gone), and the same applies to the other session's worktree at
`/private/tmp/margenticos-batch-synthesis`. Parallel sessions now work in worktrees rather
than the shared directory, which is what stops this recurring in either direction.
