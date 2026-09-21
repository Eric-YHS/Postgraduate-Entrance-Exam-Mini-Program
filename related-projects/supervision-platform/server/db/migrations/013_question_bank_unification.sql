-- The physical tables remain backward-compatible, but now represent the unified
--刷题书库. companion_enabled marks whether a book is exposed to timed 代学.
ALTER TABLE companion_study_books
  ADD COLUMN IF NOT EXISTS companion_enabled boolean NOT NULL DEFAULT true;

-- Ordinary question-bank books do not need a timed session, so their duration
-- may be absent. Timed imports still validate and persist a duration per item.
ALTER TABLE companion_study_questions
  ALTER COLUMN duration_seconds DROP NOT NULL;

