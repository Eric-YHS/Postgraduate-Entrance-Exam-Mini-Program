CREATE TABLE IF NOT EXISTS idempotency_keys (
  idempotency_key text PRIMARY KEY,
  request_hash text NOT NULL,
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','completed')),
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idempotency_keys_created_at_idx ON idempotency_keys(created_at);
