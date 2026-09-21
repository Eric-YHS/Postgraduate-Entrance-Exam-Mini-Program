ALTER TABLE book_distribution_students
  ADD COLUMN IF NOT EXISTS auto_assigned boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS book_distribution_auto_assigned_idx
  ON book_distribution_students(book_id, auto_assigned);
