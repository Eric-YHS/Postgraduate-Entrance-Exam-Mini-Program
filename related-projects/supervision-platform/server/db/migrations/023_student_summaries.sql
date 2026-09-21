-- 学生学习总结：按 SUMMARY_ROBOT_SERVICE_CONTRACT.md 的表结构落地。
-- 当前由服务端模板化统计生成（不接 AI 也能出内容），后续接入模型时复用同一表与幂等键。
CREATE TABLE IF NOT EXISTS student_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('daily','weekly','monthly')),
  schedule_date date NOT NULL,
  status text NOT NULL DEFAULT 'generated' CHECK (status IN ('queued','generated','sent','failed')),
  content jsonb NOT NULL DEFAULT '{}',
  input_range jsonb NOT NULL DEFAULT '{}',
  prompt_version text NOT NULL DEFAULT 'template-v1',
  generated_at timestamptz,
  delivered_at timestamptz,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(student_id, type, schedule_date)
);
CREATE INDEX IF NOT EXISTS student_summaries_student_type_idx ON student_summaries(student_id, type, schedule_date DESC);
