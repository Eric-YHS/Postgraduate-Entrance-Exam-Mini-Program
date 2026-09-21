ALTER TABLE idempotency_keys
  ADD COLUMN IF NOT EXISTS principal_id text;

UPDATE idempotency_keys
SET principal_id = 'legacy'
WHERE principal_id IS NULL;

-- A partially upgraded legacy database may contain several rows with the same
-- key. Keep the newest completed row before adding the scoped primary key.
DELETE FROM idempotency_keys old
USING idempotency_keys newer
WHERE old.principal_id = 'legacy'
  AND newer.principal_id = 'legacy'
  AND old.idempotency_key = newer.idempotency_key
  AND old.ctid < newer.ctid;

ALTER TABLE idempotency_keys
  ALTER COLUMN principal_id SET NOT NULL;

ALTER TABLE idempotency_keys
  DROP CONSTRAINT IF EXISTS idempotency_keys_pkey;

ALTER TABLE idempotency_keys
  ADD PRIMARY KEY (principal_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idempotency_keys_status_created_idx
  ON idempotency_keys(status, created_at);
