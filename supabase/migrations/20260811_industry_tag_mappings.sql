-- Global industry tag mapping table for Apollo -> Canonical industry translation
-- This allows operators to teach the system new Apollo tag mappings via the UI
-- Mappings are persistent and apply to all future classifications across all clients

create table if not exists public.industry_tag_mappings (
  apollo_tag text primary key,
  canonical_industry text not null,
  created_by uuid not null references auth.users(id),
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

-- RLS: Operator can read this table; mappings are global not per-org
alter table public.industry_tag_mappings enable row level security;

create policy "Operators can read mappings"
  on public.industry_tag_mappings
  for select
  to authenticated
  using (
    exists (
      select 1 from auth.users
      where auth.users.id = auth.uid()
      and auth.users.raw_user_meta_data->>'role' = 'operator'
    )
  );

create policy "Operators can insert mappings"
  on public.industry_tag_mappings
  for insert
  to authenticated
  with check (
    exists (
      select 1 from auth.users
      where auth.users.id = auth.uid()
      and auth.users.raw_user_meta_data->>'role' = 'operator'
    )
  );

create policy "Operators can update mappings"
  on public.industry_tag_mappings
  for update
  to authenticated
  using (
    exists (
      select 1 from auth.users
      where auth.users.id = auth.uid()
      and auth.users.raw_user_meta_data->>'role' = 'operator'
    )
  );

-- Index on canonical_industry for faster lookups during re-tiering
create index idx_industry_tag_mappings_canonical
  on public.industry_tag_mappings(canonical_industry);
