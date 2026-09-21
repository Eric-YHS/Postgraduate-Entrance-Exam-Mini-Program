CREATE TABLE IF NOT EXISTS student_subjects (
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 60),
  enrolled boolean NOT NULL DEFAULT true,
  target_score text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (student_id, subject)
);

CREATE TABLE IF NOT EXISTS student_learning_preferences (
  student_id uuid PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
  rest_weekday integer CHECK (rest_weekday BETWEEN 0 AND 6),
  rest_weekday_set_at timestamptz,
  assessment_push jsonb NOT NULL DEFAULT '{}',
  plan_adjustment_automation jsonb NOT NULL DEFAULT '{}',
  task_adjustment_draft jsonb,
  task_adjustment_history jsonb NOT NULL DEFAULT '[]',
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE learning_events
  ADD COLUMN IF NOT EXISTS event_key text,
  ADD COLUMN IF NOT EXISTS tool_id text,
  ADD COLUMN IF NOT EXISTS knowledge_tags jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS schema_version integer NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX IF NOT EXISTS learning_events_student_event_key_idx
  ON learning_events(student_id, event_key)
  WHERE event_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS learning_events_student_tool_occurred_idx
  ON learning_events(student_id, tool_id, occurred_at DESC);
