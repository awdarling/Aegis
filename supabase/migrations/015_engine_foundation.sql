-- Migration 015 — Engine foundation
-- Adds policy_value_json column to policies, dedups (company_id, policy_type, policy_key),
-- then enforces a unique constraint on the triple. Also removes a specific known duplicate.

-- 1. Add policy_value_json column (nullable JSON for structured policy values).
ALTER TABLE policies
  ADD COLUMN IF NOT EXISTS policy_value_json jsonb;

-- 2. Remove the specific duplicate of coverage/gender_requirement before generic dedup.
DELETE FROM policies
WHERE company_id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
  AND policy_type = 'scheduling'
  AND policy_key = 'minimum_gender_requirement';

-- 3. Dedup any remaining (company_id, policy_type, policy_key) collisions.
--    Keep the row with the highest version per triple; ties broken by most recent created_at.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY company_id, policy_type, policy_key
      ORDER BY version DESC, created_at DESC
    ) AS rn
  FROM policies
)
DELETE FROM policies
WHERE id IN (
  SELECT id FROM ranked WHERE rn > 1
);

-- 4. Enforce uniqueness on (company_id, policy_type, policy_key).
ALTER TABLE policies
  ADD CONSTRAINT policies_company_type_key_unique
  UNIQUE (company_id, policy_type, policy_key);
