-- Add payment_status and contract_status to organisations
-- These are operator-only fields — they must never appear in client-facing queries or components.
-- payment_status: 'current' | 'overdue' | null
-- contract_status: 'active' | 'paused' | 'churned' | null
-- Both nullable with no default; existing rows remain null after this migration.

alter table organisations
  add column if not exists payment_status text,
  add column if not exists contract_status text;
