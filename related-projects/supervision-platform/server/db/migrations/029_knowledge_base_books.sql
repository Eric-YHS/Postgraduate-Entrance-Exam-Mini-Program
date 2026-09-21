-- 知识库书籍：上传文件、解析状态与提取出的文本块。
ALTER TABLE books
  ADD COLUMN IF NOT EXISTS file_name text,
  ADD COLUMN IF NOT EXISTS object_key text,
  ADD COLUMN IF NOT EXISTS mime_type text,
  ADD COLUMN IF NOT EXISTS size_bytes bigint,
  ADD COLUMN IF NOT EXISTS parse_status text NOT NULL DEFAULT '未上传',
  ADD COLUMN IF NOT EXISTS parse_error text,
  ADD COLUMN IF NOT EXISTS chunk_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS uploaded_by uuid;

ALTER TABLE books DROP CONSTRAINT IF EXISTS books_parse_status_check;
ALTER TABLE books ADD CONSTRAINT books_parse_status_check
  CHECK (parse_status IN ('未上传','解析中','已解析','解析失败'));

CREATE TABLE IF NOT EXISTS book_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(book_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS book_chunks_book_idx ON book_chunks(book_id, chunk_index);

-- 私信与试卷分发通知共用学生通知渠道。
ALTER TABLE student_notifications DROP CONSTRAINT IF EXISTS student_notifications_type_check;
ALTER TABLE student_notifications ADD CONSTRAINT student_notifications_type_check
  CHECK (type IN ('资料更新','系统通知','私信'));
