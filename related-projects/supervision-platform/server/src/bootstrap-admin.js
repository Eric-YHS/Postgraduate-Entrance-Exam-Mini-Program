import 'dotenv/config';
import argon2 from 'argon2';
import pg from 'pg';
const { Pool } = pg;

const { DATABASE_URL, BOOTSTRAP_ADMIN_NAME, BOOTSTRAP_ADMIN_PHONE, BOOTSTRAP_ADMIN_PASSWORD } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!BOOTSTRAP_ADMIN_NAME || !BOOTSTRAP_ADMIN_PHONE || !BOOTSTRAP_ADMIN_PASSWORD) {
  throw new Error('BOOTSTRAP_ADMIN_NAME, BOOTSTRAP_ADMIN_PHONE, and BOOTSTRAP_ADMIN_PASSWORD are required');
}
if (BOOTSTRAP_ADMIN_PASSWORD.length < 12) throw new Error('BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters');

const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 10000 });
try {
  const existing = await pool.query('SELECT id FROM accounts WHERE phone=$1', [BOOTSTRAP_ADMIN_PHONE.trim()]);
  if (existing.rowCount) throw new Error('An account already exists for BOOTSTRAP_ADMIN_PHONE');
  const passwordHash = await argon2.hash(BOOTSTRAP_ADMIN_PASSWORD, { type: argon2.argon2id });
  await pool.query(
    "INSERT INTO accounts(role,name,phone,password_hash,status,must_change_password) VALUES('admin',$1,$2,$3,'启用',true)",
    [BOOTSTRAP_ADMIN_NAME.trim(), BOOTSTRAP_ADMIN_PHONE.trim(), passwordHash],
  );
  console.log('Bootstrap administrator created. Sign in once and change the temporary password immediately.');
} finally {
  await pool.end();
}
