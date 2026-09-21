CREATE TABLE IF NOT EXISTS entrance_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject text NOT NULL,
  question_type text NOT NULL CHECK (question_type IN ('single_choice','multiple_choice','true_false','fill_blank','short_answer')),
  stem text NOT NULL,
  options jsonb NOT NULL DEFAULT '[]',
  correct_answer jsonb NOT NULL DEFAULT 'null',
  score numeric NOT NULL DEFAULT 1 CHECK (score > 0),
  analysis text,
  knowledge_point text,
  state text NOT NULL DEFAULT '草稿' CHECK (state IN ('草稿','已发布','已归档')),
  created_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS entrance_questions_subject_state_idx ON entrance_questions(subject, state, created_at DESC);

CREATE TABLE IF NOT EXISTS entrance_papers (
  id text PRIMARY KEY,
  title text NOT NULL,
  state text NOT NULL DEFAULT '草稿' CHECK (state IN ('草稿','已发布','已归档')),
  duration_minutes integer NOT NULL DEFAULT 60 CHECK (duration_minutes BETWEEN 1 AND 300),
  created_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS entrance_paper_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id text NOT NULL REFERENCES entrance_papers(id) ON DELETE CASCADE,
  question_id uuid REFERENCES entrance_questions(id) ON DELETE SET NULL,
  item_index integer NOT NULL CHECK (item_index >= 0),
  question_snapshot jsonb NOT NULL,
  UNIQUE(paper_id, item_index)
);
CREATE INDEX IF NOT EXISTS entrance_paper_items_paper_idx ON entrance_paper_items(paper_id, item_index);

ALTER TABLE entrance_submissions
  ADD COLUMN IF NOT EXISTS wrong_questions jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS subject_scores jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS subject_totals jsonb NOT NULL DEFAULT '{}';
