-- A calendar start gate is independent from start_day, which remains the
-- position inside a plan's task table.
ALTER TABLE student_plans
  ADD COLUMN IF NOT EXISTS start_date date;

CREATE INDEX IF NOT EXISTS student_plans_student_start_date_idx
  ON student_plans(student_id, start_date);
