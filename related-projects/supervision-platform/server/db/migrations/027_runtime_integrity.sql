-- Runtime integrity after migration 026. Never edit historical migrations.
-- Scores are intentionally nullable while an assessment waits for review.
ALTER TABLE assessment_records
  ALTER COLUMN score DROP NOT NULL,
  ALTER COLUMN total DROP NOT NULL,
  ALTER COLUMN objective_score DROP NOT NULL,
  ALTER COLUMN subjective_score DROP NOT NULL;

-- Normalize legacy answer containers before enforcing type shape. A malformed
-- legacy answer is kept reviewable, but cannot remain in a publishable shape.
CREATE OR REPLACE FUNCTION normalize_question_answer_shape(question_type text, answer jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT CASE
    WHEN question_type = 'multiple_choice' THEN
      CASE
        WHEN jsonb_typeof(answer) = 'array' THEN
          CASE
            WHEN jsonb_array_length(answer) > 0
              AND NOT EXISTS (
                SELECT 1
                FROM jsonb_array_elements(answer) AS expanded(item)
                WHERE jsonb_typeof(expanded.item) <> 'string' OR btrim(expanded.item #>> '{}') = ''
              ) THEN answer
            ELSE '["A"]'::jsonb
          END
        WHEN jsonb_typeof(answer) = 'string' AND btrim(answer #>> '{}') <> '' THEN jsonb_build_array(answer #>> '{}')
        ELSE '["A"]'::jsonb
      END
    WHEN question_type IN ('single_choice', 'true_false') THEN
      CASE
        WHEN jsonb_typeof(answer) = 'string' AND btrim(answer #>> '{}') <> '' THEN answer
        WHEN jsonb_typeof(answer) = 'array' THEN
          CASE
            WHEN jsonb_array_length(answer) > 0
              AND jsonb_typeof(answer -> 0) = 'string' AND btrim(answer ->> 0) <> '' THEN to_jsonb(answer ->> 0)
            ELSE '"A"'::jsonb
          END
        ELSE '"A"'::jsonb
      END
    WHEN question_type IN ('fill_blank', 'short_answer') THEN
      CASE
        WHEN jsonb_typeof(answer) = 'string' THEN answer
        WHEN jsonb_typeof(answer) = 'array'
          AND jsonb_array_length(answer) > 0
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(answer) AS item
            WHERE jsonb_typeof(item) <> 'string' OR btrim(item #>> '{}') = ''
          ) THEN answer
        ELSE '""'::jsonb
      END
    ELSE '""'::jsonb
  END
$function$;

UPDATE entrance_questions
SET correct_answer = normalize_question_answer_shape(question_type, correct_answer), updated_at = now();

-- Repair existing periodic-assessment snapshots without touching migration 020.
UPDATE assessment_question_sets
SET questions = COALESCE((
  SELECT jsonb_agg(
    question || jsonb_build_object(
      'correctAnswer', normalize_question_answer_shape(question ->> 'questionType', question -> 'correctAnswer')
    ) ORDER BY ordinal
  )
  FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(assessment_question_sets.questions) = 'array' THEN assessment_question_sets.questions ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS expanded(question, ordinal)
), '[]'::jsonb), updated_at = now();

UPDATE entrance_paper_items
SET question_snapshot = question_snapshot || jsonb_build_object(
  'correctAnswer', normalize_question_answer_shape(question_snapshot ->> 'questionType', question_snapshot -> 'correctAnswer')
)
WHERE jsonb_typeof(question_snapshot) = 'object'
  AND question_snapshot ? 'questionType';

CREATE OR REPLACE FUNCTION question_answer_shape_valid(question_type text, answer jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT CASE
    WHEN question_type = 'multiple_choice' THEN
      CASE WHEN jsonb_typeof(answer) = 'array' THEN
        jsonb_array_length(answer) > 0
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(answer) AS item
          WHERE jsonb_typeof(item) <> 'string' OR btrim(item #>> '{}') = ''
        )
      ELSE false END
    WHEN question_type IN ('single_choice', 'true_false') THEN
      jsonb_typeof(answer) = 'string' AND btrim(answer #>> '{}') <> ''
    WHEN question_type IN ('fill_blank', 'short_answer') THEN
      CASE
        WHEN jsonb_typeof(answer) = 'string' THEN true
        WHEN jsonb_typeof(answer) = 'array' THEN
          jsonb_array_length(answer) > 0
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(answer) AS item
            WHERE jsonb_typeof(item) <> 'string' OR btrim(item #>> '{}') = ''
          )
        ELSE false
      END
    ELSE false
  END
$function$;

CREATE OR REPLACE FUNCTION assessment_question_answer_shapes_valid(question_set jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT jsonb_typeof(question_set) = 'array'
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(question_set) = 'array' THEN question_set ELSE '[]'::jsonb END
      ) AS question
      WHERE NOT question_answer_shape_valid(question ->> 'questionType', question -> 'correctAnswer')
    )
$function$;

DO $block$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'entrance_questions'::regclass
      AND conname = 'entrance_questions_correct_answer_shape_check'
  ) THEN
    ALTER TABLE entrance_questions ADD CONSTRAINT entrance_questions_correct_answer_shape_check
      CHECK (question_answer_shape_valid(question_type, correct_answer));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'assessment_question_sets'::regclass
      AND conname = 'assessment_question_sets_correct_answer_shape_check'
  ) THEN
    ALTER TABLE assessment_question_sets ADD CONSTRAINT assessment_question_sets_correct_answer_shape_check
      CHECK (assessment_question_answer_shapes_valid(questions));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'entrance_paper_items'::regclass
      AND conname = 'entrance_paper_items_correct_answer_shape_check'
  ) THEN
    ALTER TABLE entrance_paper_items ADD CONSTRAINT entrance_paper_items_correct_answer_shape_check
      CHECK (question_answer_shape_valid(question_snapshot ->> 'questionType', question_snapshot -> 'correctAnswer'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'assessment_records'::regclass
      AND conname = 'assessment_records_scores_nonnegative_check'
  ) THEN
    ALTER TABLE assessment_records ADD CONSTRAINT assessment_records_scores_nonnegative_check
      CHECK (
        (score IS NULL OR score >= 0)
        AND (total IS NULL OR total >= 0)
        AND (objective_score IS NULL OR objective_score >= 0)
        AND (subjective_score IS NULL OR subjective_score >= 0)
      );
  END IF;
END
$block$;

-- Protect the predecessor graph at the database boundary as well as in the
-- HTTP handlers. The advisory lock serializes graph edits for one student.
CREATE OR REPLACE FUNCTION prevent_student_plan_predecessor_cycle()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  next_plan uuid;
  predecessor_student_id uuid;
  visited uuid[] := ARRAY[NEW.id];
BEGIN
  IF NEW.predecessor_plan_id IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(NEW.student_id::text));
  next_plan := NEW.predecessor_plan_id;
  WHILE next_plan IS NOT NULL LOOP
    IF next_plan = ANY(visited) THEN
      RAISE EXCEPTION 'student plan predecessor cycle is not allowed' USING ERRCODE = '23514';
    END IF;
    visited := array_append(visited, next_plan);
    SELECT predecessor.student_id, predecessor.predecessor_plan_id INTO predecessor_student_id, next_plan
    FROM student_plans AS predecessor
    WHERE predecessor.id = next_plan;
    IF NOT FOUND OR predecessor_student_id <> NEW.student_id THEN
      RAISE EXCEPTION 'student plan predecessor must belong to the same student' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS student_plan_predecessor_cycle_trigger ON student_plans;
CREATE TRIGGER student_plan_predecessor_cycle_trigger
  BEFORE INSERT OR UPDATE OF predecessor_plan_id, student_id ON student_plans
  FOR EACH ROW EXECUTE FUNCTION prevent_student_plan_predecessor_cycle();
