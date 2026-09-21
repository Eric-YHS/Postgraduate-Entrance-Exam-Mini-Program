ALTER TABLE students
  ADD COLUMN IF NOT EXISTS shipping_recipient text,
  ADD COLUMN IF NOT EXISTS shipping_phone text;
