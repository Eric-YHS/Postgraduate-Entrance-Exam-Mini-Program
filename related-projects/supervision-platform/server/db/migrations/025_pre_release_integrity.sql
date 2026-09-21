-- Pre-release integrity additions. Every statement is repeatable so a partially
-- migrated database can safely be resumed by src/migrate.js.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 1;
ALTER TABLE students ADD COLUMN IF NOT EXISTS major text;
ALTER TABLE registration_applications ADD COLUMN IF NOT EXISTS major text;
ALTER TABLE courses ADD COLUMN IF NOT EXISTS scope jsonb NOT NULL DEFAULT '{}';
ALTER TABLE products ADD COLUMN IF NOT EXISTS scope jsonb NOT NULL DEFAULT '{}';
ALTER TABLE entitlements ADD COLUMN IF NOT EXISTS scope jsonb NOT NULL DEFAULT '{}';
ALTER TABLE student_plans ADD COLUMN IF NOT EXISTS course_id uuid REFERENCES courses(id) ON DELETE SET NULL;
ALTER TABLE assessment_records ADD COLUMN IF NOT EXISTS course_id uuid REFERENCES courses(id) ON DELETE SET NULL;
ALTER TABLE wrong_question_archives ADD COLUMN IF NOT EXISTS course_id uuid REFERENCES courses(id) ON DELETE SET NULL;
ALTER TABLE course_assets ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE course_assets ADD COLUMN IF NOT EXISTS failure_code text;
ALTER TABLE course_assets ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE entrance_submissions ADD COLUMN IF NOT EXISTS assessment_record_id uuid REFERENCES assessment_records(id) ON DELETE SET NULL;
ALTER TABLE entrance_submissions ADD COLUMN IF NOT EXISTS objective_score numeric;
ALTER TABLE entrance_submissions ADD COLUMN IF NOT EXISTS subjective_score numeric;
ALTER TABLE entrance_submissions ADD COLUMN IF NOT EXISTS grading_status text NOT NULL DEFAULT 'graded';
ALTER TABLE entrance_submissions ADD COLUMN IF NOT EXISTS graded_by uuid REFERENCES accounts(id) ON DELETE SET NULL;
ALTER TABLE entrance_submissions ADD COLUMN IF NOT EXISTS grading_note text;
ALTER TABLE entrance_submissions ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE student_learning_progress ADD COLUMN IF NOT EXISTS course_id uuid REFERENCES courses(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS student_plans_student_course_idx ON student_plans(student_id, course_id, created_at DESC);
CREATE INDEX IF NOT EXISTS assessment_records_student_course_idx ON assessment_records(student_id, course_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS wrong_question_student_course_idx ON wrong_question_archives(student_id, course_id, created_at DESC);
CREATE INDEX IF NOT EXISTS course_assets_state_idx ON course_assets(course_id, state, created_at DESC);
CREATE INDEX IF NOT EXISTS entitlements_student_course_idx ON entitlements(student_id, status, ends_at);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='entrance_submissions'::regclass AND conname='entrance_submissions_grading_status_check') THEN
    ALTER TABLE entrance_submissions ADD CONSTRAINT entrance_submissions_grading_status_check CHECK (grading_status IN ('graded','pending_review','partially_graded','已批改','部分待批改','待批改'));
  END IF;
END $$;
