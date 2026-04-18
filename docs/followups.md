# Followups — decisions deferred for a later session

Items in this file were explicitly deferred during development.
Each entry names the file where the placeholder lives.

---

## Monthly meetings target — make per-client configurable

Add `monthly_meetings_target` column to the `organisations` table.
Currently hardcoded as `DEFAULT_MONTHLY_MEETINGS_TARGET = 8` in
`src/components/dashboard/pipeline/MomentumBlock.tsx`.

**When:** When the first paying client onboards and needs a target that differs
from the default.

---

## Pipeline redirect — add context to the client

The pipeline page (`src/app/dashboard/pipeline/page.tsx`) silently redirects to
`/dashboard` when `pipeline_unlocked = false`. Clients who navigate there directly
get no explanation of why.

Consider adding a dismissible banner on `/dashboard` or a toast notification
explaining why the redirect happened — something like "Pipeline view unlocks once
your first campaigns are live."

**When:** Before first paying client onboards. Small UX papercut, not urgent.

---
