-- Add acknowledgement fields to monitor_events
-- Allows operators to acknowledge open problems and track context

ALTER TABLE public.monitor_events ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz;
ALTER TABLE public.monitor_events ADD COLUMN IF NOT EXISTS acknowledged_note text;
