CREATE TABLE IF NOT EXISTS ai_robots (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9_-]{2,80}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  capability text NOT NULL CHECK (capability IN ('text','vision','embedding')),
  status text NOT NULL DEFAULT 'disabled' CHECK (status IN ('disabled','configured','enabled')),
  provider_ref text,
  system_prompt text NOT NULL DEFAULT '',
  restriction_words jsonb NOT NULL DEFAULT '[]',
  requires_human_approval boolean NOT NULL DEFAULT true,
  allowed_tools jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  robot_id text NOT NULL REFERENCES ai_robots(id) ON DELETE RESTRICT,
  requested_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
  student_id uuid REFERENCES students(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','awaiting_approval','completed','failed','cancelled')),
  input jsonb NOT NULL DEFAULT '{}',
  output jsonb,
  error_code text,
  prompt_version text,
  provider_ref text,
  estimated_cost_micros bigint,
  actual_cost_micros bigint,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_jobs_status_created_idx ON ai_jobs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_jobs_student_created_idx ON ai_jobs(student_id, created_at DESC);
