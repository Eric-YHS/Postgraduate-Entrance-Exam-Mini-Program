-- 学习工具内容库：政治题书、英语单词书、英语选择题书、数学公式/定理书。
-- 教师端“应用管理”批量导入，学生端刷题/背词/背公式按书籍读取，替代原浏览器 localStorage 演示数据。
CREATE TABLE IF NOT EXISTS application_books (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tool text NOT NULL CHECK (tool IN ('politics','english_words','english_choice','math_formula','math_theorem')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  state text NOT NULL DEFAULT '已发布' CHECK (state IN ('草稿','已发布','已归档')),
  created_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tool, name)
);

CREATE TABLE IF NOT EXISTS application_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL REFERENCES application_books(id) ON DELETE CASCADE,
  item_index integer NOT NULL CHECK (item_index >= 0),
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(book_id, item_index)
);
CREATE INDEX IF NOT EXISTS application_items_book_idx ON application_items(book_id, item_index);
