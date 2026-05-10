ALTER TABLE time_off_requests
  ADD COLUMN IF NOT EXISTS aegis_recommendation TEXT CHECK (aegis_recommendation IN ('approve', 'deny', 'neutral')),
  ADD COLUMN IF NOT EXISTS aegis_reasoning TEXT;
