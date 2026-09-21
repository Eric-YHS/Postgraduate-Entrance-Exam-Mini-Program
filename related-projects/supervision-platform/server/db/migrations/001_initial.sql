CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), role text NOT NULL CHECK (role IN ('admin','teacher','assistant','operator','student')),
  name text NOT NULL, phone text NOT NULL UNIQUE, password_hash text, status text NOT NULL DEFAULT '启用', student_id uuid,
  must_change_password boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), last_login_at timestamptz
);
CREATE INDEX IF NOT EXISTS accounts_role_idx ON accounts(role);
CREATE TABLE IF NOT EXISTS students (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES accounts(id) ON DELETE SET NULL, name text NOT NULL,
  year text NOT NULL, status text NOT NULL DEFAULT '新人', phone text NOT NULL, email text, shipping_info text, school text,
  target_score text, stage text NOT NULL DEFAULT '未开始', evaluation text, paid_until timestamptz, intake_token_hash text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS students_phone_idx ON students(phone);
CREATE TABLE IF NOT EXISTS registration_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, year text NOT NULL, phone text NOT NULL, email text,
  shipping_info text, school text, stage text NOT NULL DEFAULT '未开始', evaluation text, subjects jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT '待导入', student_type text, imported_student_id uuid REFERENCES students(id) ON DELETE SET NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(), imported_at timestamptz
);
CREATE INDEX IF NOT EXISTS registration_status_idx ON registration_applications(status);
CREATE TABLE IF NOT EXISTS entrance_distributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE, paper_id text NOT NULL,
  paper_title text NOT NULL, share_token_hash text NOT NULL UNIQUE, assigned_at timestamptz NOT NULL DEFAULT now(),
  start_deadline_at timestamptz NOT NULL, started_at timestamptz, exam_deadline_at timestamptz, submitted_at timestamptz,
  status text NOT NULL DEFAULT '待开始', UNIQUE(student_id, paper_id)
);
CREATE INDEX IF NOT EXISTS entrance_token_idx ON entrance_distributions(share_token_hash);
CREATE TABLE IF NOT EXISTS entrance_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), distribution_id uuid NOT NULL REFERENCES entrance_distributions(id) ON DELETE CASCADE,
  answers jsonb NOT NULL DEFAULT '{}', score numeric, total numeric, status text NOT NULL DEFAULT '已提交', submitted_at timestamptz NOT NULL DEFAULT now(), graded_at timestamptz
);
CREATE TABLE IF NOT EXISTS courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, subject text, category text, description text,
  state text NOT NULL DEFAULT '草稿', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS course_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), course_id uuid REFERENCES courses(id) ON DELETE CASCADE, file_name text NOT NULL,
  object_key text NOT NULL, mime_type text, size_bytes bigint, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  product_id text, course_ids jsonb NOT NULL DEFAULT '[]', kind text NOT NULL, starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz, status text NOT NULL DEFAULT '有效', source text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS entitlement_student_idx ON entitlements(student_id, status, ends_at);
CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), student_id uuid REFERENCES students(id) ON DELETE SET NULL, product_id text NOT NULL,
  amount numeric NOT NULL, provider text, provider_trade_id text UNIQUE, status text NOT NULL DEFAULT '待支付', created_at timestamptz NOT NULL DEFAULT now(), paid_at timestamptz
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id bigserial PRIMARY KEY, actor_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL, action text NOT NULL,
  entity_type text, entity_id text, metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_logs(created_at DESC);
