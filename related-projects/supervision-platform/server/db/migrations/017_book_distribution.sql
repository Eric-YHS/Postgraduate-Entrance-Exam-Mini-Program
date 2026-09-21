CREATE TABLE IF NOT EXISTS books (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject text NOT NULL CHECK (subject IN ('政治','英语','数学','专业课','通用')),
  name text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS books_subject_idx ON books(subject, created_at DESC);

CREATE TABLE IF NOT EXISTS book_distribution_students (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  student_id uuid REFERENCES students(id) ON DELETE SET NULL,
  recipient text,
  phone text,
  shipping_info text,
  issued_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS book_distribution_student_unique
  ON book_distribution_students(book_id, student_id) WHERE student_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS book_distribution_book_idx ON book_distribution_students(book_id, issued_at);
