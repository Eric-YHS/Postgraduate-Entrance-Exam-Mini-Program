CREATE TABLE IF NOT EXISTS plan_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject text NOT NULL,
  name text NOT NULL,
  category text,
  state text NOT NULL DEFAULT '草稿' CHECK (state IN ('草稿','已发布','已归档')),
  created_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plan_template_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES plan_templates(id) ON DELETE CASCADE,
  row_index integer NOT NULL CHECK (row_index >= 0),
  title text,
  tasks jsonb NOT NULL DEFAULT '[]',
  UNIQUE(template_id, row_index)
);

CREATE TABLE IF NOT EXISTS student_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  template_id uuid REFERENCES plan_templates(id) ON DELETE SET NULL,
  subject text NOT NULL,
  name text NOT NULL,
  task_type text NOT NULL DEFAULT '阶段' CHECK (task_type IN ('长期','阶段')),
  start_day integer NOT NULL DEFAULT 1 CHECK (start_day >= 1),
  lane integer NOT NULL DEFAULT 1 CHECK (lane BETWEEN 1 AND 8),
  predecessor_plan_id uuid REFERENCES student_plans(id) ON DELETE SET NULL,
  rows jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS student_plans_student_subject_idx ON student_plans(student_id, subject, created_at);

CREATE TABLE IF NOT EXISTS task_completions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_plan_id uuid NOT NULL REFERENCES student_plans(id) ON DELETE CASCADE,
  row_index integer NOT NULL CHECK (row_index >= 0),
  task_index integer NOT NULL CHECK (task_index >= 0),
  completed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(student_plan_id, row_index, task_index)
);
CREATE INDEX IF NOT EXISTS task_completions_plan_idx ON task_completions(student_plan_id, row_index);

CREATE TABLE IF NOT EXISTS assessment_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  assessment_type text NOT NULL CHECK (assessment_type IN ('entrance','daily','weekly','monthly')),
  subject text NOT NULL,
  title text NOT NULL,
  score numeric CHECK (score IS NULL OR score >= 0),
  total numeric CHECK (total IS NULL OR total >= 0),
  answers jsonb NOT NULL DEFAULT '{}',
  wrong_questions jsonb NOT NULL DEFAULT '[]',
  submitted_at timestamptz NOT NULL DEFAULT now(),
  graded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assessment_records_student_created_idx ON assessment_records(student_id, created_at DESC);

CREATE TABLE IF NOT EXISTS community_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  title text NOT NULL,
  topic text NOT NULL,
  body text NOT NULL,
  state text NOT NULL DEFAULT '待审核' CHECK (state IN ('待审核','已公开','已拒绝')),
  review_note text,
  reviewed_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS community_posts_state_created_idx ON community_posts(state, created_at DESC);

CREATE TABLE IF NOT EXISTS learning_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  subject text,
  payload jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS learning_events_student_occurred_idx ON learning_events(student_id, occurred_at DESC);
