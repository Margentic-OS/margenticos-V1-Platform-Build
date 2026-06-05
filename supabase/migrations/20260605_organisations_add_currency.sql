ALTER TABLE public.organisations
  ADD COLUMN currency text NOT NULL DEFAULT 'GBP'
  CHECK (currency IN ('GBP', 'EUR', 'USD'));
