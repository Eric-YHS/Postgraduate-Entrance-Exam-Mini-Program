-- 学习工具完成进度：刷题、背词、背公式、代学完成记录，替代纯浏览器 localStorage 进度。
CREATE TABLE IF NOT EXISTS student_learning_progress (
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  resource_type text NOT NULL CHECK (char_length(resource_type) BETWEEN 1 AND 60),
  resource_id text NOT NULL CHECK (char_length(resource_id) BETWEEN 1 AND 120),
  item_id text NOT NULL CHECK (char_length(item_id) BETWEEN 1 AND 120),
  total_count integer NOT NULL DEFAULT 0 CHECK (total_count >= 0),
  completed_on date NOT NULL DEFAULT ((now() AT TIME ZONE 'Asia/Shanghai')::date),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (student_id, resource_type, resource_id, item_id)
);
CREATE INDEX IF NOT EXISTS student_learning_progress_resource_idx ON student_learning_progress(student_id, resource_type, resource_id);
