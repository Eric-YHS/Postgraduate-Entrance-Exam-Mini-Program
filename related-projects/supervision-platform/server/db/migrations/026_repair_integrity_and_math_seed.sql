-- 026 repair and runtime integrity additions. Do not edit already-applied migrations.
-- This migration is repeatable through src/migrate.js and repairs malformed math seed snapshots.

ALTER TABLE student_plans
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS assessment_question_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid REFERENCES students(id) ON DELETE CASCADE,
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 60),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  assessment_type text NOT NULL CHECK (assessment_type IN ('daily','weekly','monthly')),
  state text NOT NULL DEFAULT '草稿' CHECK (state IN ('草稿','已发布','已归档')),
  questions jsonb NOT NULL DEFAULT '[]',
  created_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE assessment_records
  ADD COLUMN IF NOT EXISTS question_set_id uuid REFERENCES assessment_question_sets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS objective_score numeric,
  ADD COLUMN IF NOT EXISTS subjective_score numeric,
  ADD COLUMN IF NOT EXISTS grading_status text NOT NULL DEFAULT 'pending_review',
  ADD COLUMN IF NOT EXISTS grading_note text,
  ADD COLUMN IF NOT EXISTS graded_by uuid REFERENCES accounts(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='assessment_records'::regclass AND conname='assessment_records_grading_status_check') THEN
    ALTER TABLE assessment_records ADD CONSTRAINT assessment_records_grading_status_check
      CHECK (grading_status IN ('graded','pending_review','partially_graded','已批改','待批改','部分待批改'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS assessment_question_sets_lookup_idx
  ON assessment_question_sets(student_id, assessment_type, subject, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS assessment_records_grading_status_idx
  ON assessment_records(student_id, grading_status, submitted_at DESC);

ALTER TABLE companion_study_books
  ADD COLUMN IF NOT EXISTS course_id uuid REFERENCES courses(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS companion_books_course_idx ON companion_study_books(course_id, state, subject);

-- 020 was generated from object-valued frontend options and persisted invalid option text.
-- Keep the existing question IDs/answers, restore four keyed text options, then rebuild snapshots.
WITH fixes(item_index, options) AS (VALUES
    (0, $json$[{"key": "A", "text": "(x^n)' = n x^{n-1}"}, {"key": "B", "text": "(x^n)' = x^{n+1}"}, {"key": "C", "text": "(x^n)' = n x^{n+1}"}, {"key": "D", "text": "(x^n)' = n x^n"}]$json$::jsonb),
    (1, $json$[{"key": "A", "text": "0"}, {"key": "B", "text": "∞"}, {"key": "C", "text": "不存在"}, {"key": "D", "text": "1"}]$json$::jsonb),
    (2, $json$[{"key": "A", "text": "∞"}, {"key": "B", "text": "0"}, {"key": "C", "text": "e"}, {"key": "D", "text": "1"}]$json$::jsonb),
    (3, $json$[{"key": "A", "text": "π"}, {"key": "B", "text": "π/5"}, {"key": "C", "text": "π/3"}, {"key": "D", "text": "π/2"}]$json$::jsonb),
    (4, $json$[{"key": "A", "text": "1"}, {"key": "B", "text": "2"}, {"key": "C", "text": "0"}, {"key": "D", "text": "1/2"}]$json$::jsonb),
    (5, $json$[{"key": "A", "text": "-sin x"}, {"key": "B", "text": "cos x"}, {"key": "C", "text": "-cos x"}, {"key": "D", "text": "sin x"}]$json$::jsonb),
    (6, $json$[{"key": "A", "text": "3x"}, {"key": "B", "text": "x^4/4"}, {"key": "C", "text": "3x^2"}, {"key": "D", "text": "x^2"}]$json$::jsonb),
    (7, $json$[{"key": "A", "text": "2"}, {"key": "B", "text": "1/2"}, {"key": "C", "text": "1"}, {"key": "D", "text": "0"}]$json$::jsonb),
    (8, $json$[{"key": "A", "text": "0"}, {"key": "B", "text": "1"}, {"key": "C", "text": "不存在"}, {"key": "D", "text": "sin 0"}]$json$::jsonb),
    (9, $json$[{"key": "A", "text": "0"}, {"key": "B", "text": "∞"}, {"key": "C", "text": "1/2"}, {"key": "D", "text": "1"}]$json$::jsonb),
    (10, $json$[{"key": "A", "text": "2"}, {"key": "B", "text": "∞"}, {"key": "C", "text": "e^2"}, {"key": "D", "text": "e"}]$json$::jsonb),
    (11, $json$[{"key": "A", "text": "π/4"}, {"key": "B", "text": "π/2"}, {"key": "C", "text": "π"}, {"key": "D", "text": "2π"}]$json$::jsonb),
    (12, $json$[{"key": "A", "text": "2"}, {"key": "B", "text": "1"}, {"key": "C", "text": "3"}, {"key": "D", "text": "1/3"}]$json$::jsonb),
    (13, $json$[{"key": "A", "text": "xe^x + C"}, {"key": "B", "text": "e^x/x + C"}, {"key": "C", "text": "ln x + C"}, {"key": "D", "text": "e^x + C"}]$json$::jsonb),
    (14, $json$[{"key": "A", "text": "1/e"}, {"key": "B", "text": "2"}, {"key": "C", "text": "1"}, {"key": "D", "text": "e"}]$json$::jsonb),
    (15, $json$[{"key": "A", "text": "∞"}, {"key": "B", "text": "e^3"}, {"key": "C", "text": "e"}, {"key": "D", "text": "3"}]$json$::jsonb),
    (16, $json$[{"key": "A", "text": "2"}, {"key": "B", "text": "0"}, {"key": "C", "text": "1"}, {"key": "D", "text": "π"}]$json$::jsonb),
    (17, $json$[{"key": "A", "text": "π"}, {"key": "B", "text": "2π"}, {"key": "C", "text": "π/3"}, {"key": "D", "text": "π/2"}]$json$::jsonb),
    (18, $json$[{"key": "A", "text": "e"}, {"key": "B", "text": "e+1"}, {"key": "C", "text": "1"}, {"key": "D", "text": "0"}]$json$::jsonb),
    (19, $json$[{"key": "A", "text": "e"}, {"key": "B", "text": "1"}, {"key": "C", "text": "0"}, {"key": "D", "text": "∞"}]$json$::jsonb),
    (20, $json$[{"key": "A", "text": "π/3"}, {"key": "B", "text": "π"}, {"key": "C", "text": "π/2"}, {"key": "D", "text": "2π/3"}]$json$::jsonb),
    (21, $json$[{"key": "A", "text": "e − 1"}, {"key": "B", "text": "e"}, {"key": "C", "text": "0"}, {"key": "D", "text": "1"}]$json$::jsonb),
    (22, $json$[{"key": "A", "text": "ln(1+x^2) + C"}, {"key": "B", "text": "x^2/2 + C"}, {"key": "C", "text": "arctan x + C"}, {"key": "D", "text": "1/x + C"}]$json$::jsonb),
    (23, $json$[{"key": "A", "text": "-cos x"}, {"key": "B", "text": "sin x"}, {"key": "C", "text": "cos x"}, {"key": "D", "text": "-sin x"}]$json$::jsonb),
    (24, $json$[{"key": "A", "text": "2"}, {"key": "B", "text": "1"}, {"key": "C", "text": "1/2"}, {"key": "D", "text": "∞"}]$json$::jsonb),
    (25, $json$[{"key": "A", "text": "1"}, {"key": "B", "text": "7/3"}, {"key": "C", "text": "2"}, {"key": "D", "text": "4/3"}]$json$::jsonb),
    (26, $json$[{"key": "A", "text": "π/3"}, {"key": "B", "text": "2π/3"}, {"key": "C", "text": "π/2"}, {"key": "D", "text": "π"}]$json$::jsonb),
    (27, $json$[{"key": "A", "text": "x ln x − x + C"}, {"key": "B", "text": "(x^2/2)ln x − x^2/4 + C"}, {"key": "C", "text": "ln x + C"}, {"key": "D", "text": "(1/2)x^2 + C"}]$json$::jsonb),
    (28, $json$[{"key": "A", "text": "4"}, {"key": "B", "text": "2"}, {"key": "C", "text": "5"}, {"key": "D", "text": "3"}]$json$::jsonb),
    (29, $json$[{"key": "A", "text": "-cos x"}, {"key": "B", "text": "sin x"}, {"key": "C", "text": "-sin x"}, {"key": "D", "text": "cos x"}]$json$::jsonb),
    (30, $json$[{"key": "A", "text": "ln x"}, {"key": "B", "text": "e^x"}, {"key": "C", "text": "1/x"}, {"key": "D", "text": "x"}]$json$::jsonb),
    (31, $json$[{"key": "A", "text": "1/e^x"}, {"key": "B", "text": "e^x"}, {"key": "C", "text": "x e^(x-1)"}, {"key": "D", "text": "ln x"}]$json$::jsonb),
    (32, $json$[{"key": "A", "text": "1"}, {"key": "B", "text": "0"}, {"key": "C", "text": "∞"}, {"key": "D", "text": "不存在"}]$json$::jsonb),
    (33, $json$[{"key": "A", "text": "0"}, {"key": "B", "text": "e"}, {"key": "C", "text": "∞"}, {"key": "D", "text": "1"}]$json$::jsonb),
    (34, $json$[{"key": "A", "text": "∞"}, {"key": "B", "text": "不存在"}, {"key": "C", "text": "1"}, {"key": "D", "text": "0"}]$json$::jsonb),
    (35, $json$[{"key": "A", "text": "x^2 + C"}, {"key": "B", "text": "x^2/2 + C"}, {"key": "C", "text": "x + C"}, {"key": "D", "text": "2x + C"}]$json$::jsonb),
    (36, $json$[{"key": "A", "text": "ln|x| + C"}, {"key": "B", "text": "1/x + C"}, {"key": "C", "text": "x + C"}, {"key": "D", "text": "e^x + C"}]$json$::jsonb),
    (37, $json$[{"key": "A", "text": "cos x + C"}, {"key": "B", "text": "sin x + C"}, {"key": "C", "text": "-sin x + C"}, {"key": "D", "text": "-cos x + C"}]$json$::jsonb),
    (38, $json$[{"key": "A", "text": "1"}, {"key": "B", "text": "2"}, {"key": "C", "text": "1/3"}, {"key": "D", "text": "1/2"}]$json$::jsonb),
    (39, $json$[{"key": "A", "text": "2"}, {"key": "B", "text": "1"}, {"key": "C", "text": "0"}, {"key": "D", "text": "1/2"}]$json$::jsonb),
    (40, $json$[{"key": "A", "text": "0"}, {"key": "B", "text": "2"}, {"key": "C", "text": "1"}, {"key": "D", "text": "π"}]$json$::jsonb),
    (41, $json$[{"key": "A", "text": "1"}, {"key": "B", "text": "2"}, {"key": "C", "text": "π/2"}, {"key": "D", "text": "1/2"}]$json$::jsonb),
    (42, $json$[{"key": "A", "text": "1"}, {"key": "B", "text": "1/3"}, {"key": "C", "text": "2/3"}, {"key": "D", "text": "1/2"}]$json$::jsonb),
    (43, $json$[{"key": "A", "text": "2π"}, {"key": "B", "text": "π/3"}, {"key": "C", "text": "π/2"}, {"key": "D", "text": "π"}]$json$::jsonb),
    (44, $json$[{"key": "A", "text": "π"}, {"key": "B", "text": "π/2"}, {"key": "C", "text": "2π"}, {"key": "D", "text": "1"}]$json$::jsonb),
    (45, $json$[{"key": "A", "text": "x^2"}, {"key": "B", "text": "2x"}, {"key": "C", "text": "x^3"}, {"key": "D", "text": "x^3/3"}]$json$::jsonb),
    (46, $json$[{"key": "A", "text": "3x²"}, {"key": "B", "text": "x³−2"}, {"key": "C", "text": "3x²−2"}, {"key": "D", "text": "x²−2"}]$json$::jsonb),
    (47, $json$[{"key": "A", "text": "−1"}, {"key": "B", "text": "0"}, {"key": "C", "text": "1"}, {"key": "D", "text": "不存在"}]$json$::jsonb),
    (48, $json$[{"key": "A", "text": "单调递增"}, {"key": "B", "text": "单调递减"}, {"key": "C", "text": "恒为零"}, {"key": "D", "text": "没有变化"}]$json$::jsonb),
    (49, $json$[{"key": "A", "text": "单调递增"}, {"key": "B", "text": "恒为常数"}, {"key": "C", "text": "必有极值"}, {"key": "D", "text": "单调递减"}]$json$::jsonb)
)
UPDATE entrance_questions q
SET options=f.options, updated_at=now()
FROM entrance_paper_items i JOIN fixes f ON f.item_index=i.item_index
WHERE i.paper_id='entry-math' AND i.question_id=q.id;

UPDATE entrance_paper_items i
SET question_snapshot=jsonb_build_object(
  'subject',q.subject,
  'questionType',q.question_type,
  'stem',q.stem,
  'options',q.options,
  'correctAnswer',q.correct_answer,
  'score',q.score,
  'analysis',COALESCE(q.analysis,''),
  'knowledgePoint',COALESCE(q.knowledge_point,'')
)
FROM entrance_questions q
WHERE i.paper_id='entry-math' AND i.question_id=q.id;
