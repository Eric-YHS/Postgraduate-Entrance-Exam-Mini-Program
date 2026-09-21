CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'accounts'::regclass AND conname = 'accounts_student_id_fk'
  ) THEN
    ALTER TABLE accounts
      ADD CONSTRAINT accounts_student_id_fk
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS students_account_id_unique
  ON students(account_id) WHERE account_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_student_id_unique
  ON accounts(student_id) WHERE student_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS entrance_submission_distribution_unique
  ON entrance_submissions(distribution_id);

CREATE INDEX IF NOT EXISTS entrance_distribution_student_status_idx
  ON entrance_distributions(student_id, status);
CREATE INDEX IF NOT EXISTS orders_student_status_created_idx
  ON orders(student_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_actor_created_idx
  ON audit_logs(actor_account_id, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'orders'::regclass AND conname = 'orders_amount_nonnegative'
  ) THEN
    ALTER TABLE orders ADD CONSTRAINT orders_amount_nonnegative CHECK (amount >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'entitlements'::regclass AND conname = 'entitlements_date_order'
  ) THEN
    ALTER TABLE entitlements ADD CONSTRAINT entitlements_date_order CHECK (ends_at IS NULL OR ends_at >= starts_at);
  END IF;
END $$;
