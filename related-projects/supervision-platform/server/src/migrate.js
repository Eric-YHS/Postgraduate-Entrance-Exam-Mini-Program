import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 10000 });

const migrationDir = path.join(process.cwd(), 'db/migrations');
const files = (await fs.readdir(migrationDir))
  .filter(file => /^\d+_.+\.sql$/.test(file))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

const client = await pool.connect();
try {
  await client.query('SELECT pg_advisory_lock(hashtext($1))', ['shangan-schema-migrations']);
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const applied = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map(row => row.version));
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await fs.readFile(path.join(migrationDir, file), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [file]);
      await client.query('COMMIT');
      console.log(`Applied ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  console.log('Database migration complete');
} finally {
  await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['shangan-schema-migrations']).catch(() => {});
  client.release();
  await pool.end();
}
