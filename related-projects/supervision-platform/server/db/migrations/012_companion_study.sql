CREATE TABLE IF NOT EXISTS companion_study_books (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject text NOT NULL CHECK (subject IN ('政治','英语','数学')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  description text NOT NULL DEFAULT '',
  state text NOT NULL DEFAULT '草稿' CHECK (state IN ('草稿','已发布','已归档')),
  created_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(subject, name)
);

CREATE TABLE IF NOT EXISTS companion_study_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL REFERENCES companion_study_books(id) ON DELETE CASCADE,
  question_number integer NOT NULL CHECK (question_number > 0),
  stem text NOT NULL DEFAULT '',
  duration_seconds integer NOT NULL DEFAULT 1800 CHECK (duration_seconds BETWEEN 60 AND 86400),
  knowledge_point text NOT NULL DEFAULT '',
  half_hint text NOT NULL DEFAULT '',
  answer text NOT NULL DEFAULT '',
  analysis text NOT NULL DEFAULT '',
  state text NOT NULL DEFAULT '已发布' CHECK (state IN ('草稿','已发布','已归档')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(book_id, question_number)
);
CREATE INDEX IF NOT EXISTS companion_questions_book_order_idx ON companion_study_questions(book_id, question_number);

CREATE TABLE IF NOT EXISTS companion_study_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES companion_study_questions(id) ON DELETE CASCADE,
  speed_mode text NOT NULL DEFAULT '适中' CHECK (speed_mode IN ('基础','适中','合适')),
  started_at timestamptz NOT NULL DEFAULT now(),
  effective_duration_seconds integer NOT NULL CHECK (effective_duration_seconds BETWEEN 60 AND 172800),
  finished_at timestamptz,
  finish_reason text CHECK (finish_reason IN ('到时结束','提前结束')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS companion_sessions_student_created_idx ON companion_study_sessions(student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS companion_sessions_question_student_idx ON companion_study_sessions(question_id, student_id, created_at DESC);

