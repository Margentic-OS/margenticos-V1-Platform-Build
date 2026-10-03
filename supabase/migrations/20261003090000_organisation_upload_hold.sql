-- An enforced hold on uploading a client's leads to the sending tool.
--
-- Operator instruction, 2026-10-03: "Hold all uploads" for MargenticOS while the template
-- copy is rewritten. Until now a hold was only "nobody clicks Upload": no switch, no cron
-- job uploads on its own (checked live 2026-10-03), so the hold was a promise, not a state.
--
-- handleUploadLeads (src/app/dashboard/operator/clients/[id]/actions.ts) reads this column
-- before it claims anything and refuses with the note while it is true. Lifted only by an
-- operator setting it false.
--
-- ACCESS. organisations has two RLS policies (read live 2026-10-03): operators ALL, a client
-- SELECT on its own row. So only an operator can change the hold; a client can see it. No
-- grant changes: the columns inherit the table's grants, and RLS governs the rows.
--
-- Status: NOT YET APPLIED

ALTER TABLE public.organisations
  ADD COLUMN IF NOT EXISTS outbound_upload_hold boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS outbound_upload_hold_note text;

COMMENT ON COLUMN public.organisations.outbound_upload_hold IS
  'When true, handleUploadLeads refuses to upload this client''s leads. Set and cleared by an operator.';
COMMENT ON COLUMN public.organisations.outbound_upload_hold_note IS
  'Why uploads are held, shown to the operator when an upload is refused.';
