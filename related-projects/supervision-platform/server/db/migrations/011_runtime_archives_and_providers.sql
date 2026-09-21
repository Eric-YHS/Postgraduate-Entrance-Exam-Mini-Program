CREATE TABLE IF NOT EXISTS ai_providers (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9_-]{2,80}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  capability text NOT NULL CHECK (capability IN ('text','vision','embedding')),
  base_url text NOT NULL,
  secret_ref text NOT NULL CHECK (secret_ref ~ '^[A-Za-z0-9_:-]{2,160}$'),
  status text NOT NULL DEFAULT 'disabled' CHECK (status IN ('disabled','configured','enabled')),
  timeout_ms integer NOT NULL DEFAULT 10000 CHECK (timeout_ms BETWEEN 1000 AND 60000),
  max_retries integer NOT NULL DEFAULT 1 CHECK (max_retries BETWEEN 0 AND 3),
  last_tested_at timestamptz,
  last_test_status text CHECK (last_test_status IN ('passed','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE student_plans ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
ALTER TABLE course_assets ADD COLUMN IF NOT EXISTS uploaded_by uuid REFERENCES accounts(id) ON DELETE SET NULL;
ALTER TABLE course_assets ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'ready' CHECK (state IN ('pending','ready','blocked','deleted'));
ALTER TABLE course_assets ADD COLUMN IF NOT EXISTS sha256 text;
ALTER TABLE course_assets ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE TABLE IF NOT EXISTS wrong_question_archives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  assessment_record_id uuid REFERENCES assessment_records(id) ON DELETE SET NULL,
  submission_id uuid REFERENCES entrance_submissions(id) ON DELETE SET NULL,
  source_hash text NOT NULL,
  subject text NOT NULL,
  question_number integer,
  question_text text NOT NULL DEFAULT '',
  student_answer jsonb,
  correct_answer jsonb,
  analysis text NOT NULL DEFAULT '',
  knowledge_point text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','reviewed','mastered','archived')),
  review_count integer NOT NULL DEFAULT 0 CHECK (review_count >= 0),
  last_reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(student_id, source_hash)
);
CREATE INDEX IF NOT EXISTS wrong_question_student_created_idx ON wrong_question_archives(student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS wrong_question_student_status_idx ON wrong_question_archives(student_id, status);

