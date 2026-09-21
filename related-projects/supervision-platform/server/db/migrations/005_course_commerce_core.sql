ALTER TABLE courses
  ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT '公开课',
  ADD COLUMN IF NOT EXISTS pricing text NOT NULL DEFAULT '免费' CHECK (pricing IN ('免费','付费')),
  ADD COLUMN IF NOT EXISTS price numeric NOT NULL DEFAULT 0 CHECK (price >= 0),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  category text,
  description text,
  pricing text NOT NULL DEFAULT '免费' CHECK (pricing IN ('免费','付费')),
  price numeric NOT NULL DEFAULT 0 CHECK (price >= 0),
  state text NOT NULL DEFAULT '草稿' CHECK (state IN ('草稿','已上架','已下架')),
  course_ids jsonb NOT NULL DEFAULT '[]',
  created_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS products_state_idx ON products(state, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS orders_student_product_pending_unique
  ON orders(student_id, product_id)
  WHERE status = '待支付';
CREATE UNIQUE INDEX IF NOT EXISTS entitlements_student_product_active_unique
  ON entitlements(student_id, product_id)
  WHERE status = '有效' AND ends_at IS NULL;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_note text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status, created_at DESC);
