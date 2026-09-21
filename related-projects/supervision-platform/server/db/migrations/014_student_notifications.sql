CREATE TABLE IF NOT EXISTS student_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('资料更新','系统通知')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  body text NOT NULL DEFAULT '' CHECK (char_length(body) <= 2000),
  entity_type text,
  entity_id text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS student_notifications_student_created_idx
  ON student_notifications(student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS student_notifications_unread_idx
  ON student_notifications(student_id, read_at, created_at DESC);

