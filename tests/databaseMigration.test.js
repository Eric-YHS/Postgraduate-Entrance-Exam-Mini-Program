const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');

function runInitialization(dbPath, setupOldSchema = false) {
  const dbModule = path.join(__dirname, '..', 'src', 'db.js');
  const setup = setupOldSchema ? `
    const Database = require('better-sqlite3');
    const old = new Database(process.env.DB_PATH);
    old.exec(\`CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL,
      role TEXT NOT NULL, display_name TEXT NOT NULL, class_name TEXT DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE TABLE bots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      type TEXT NOT NULL, config TEXT DEFAULT '{}', is_active INTEGER DEFAULT 0, created_at TEXT NOT NULL
    );\`);
    old.prepare("INSERT INTO bots (code,name,type,config,is_active,created_at) VALUES ('legacy','旧机器人','advisor','{}',0,'2025-01-01T00:00:00.000Z')").run();
    old.close();
  ` : '';
  const script = `${setup}
    const loaded = require(${JSON.stringify(dbModule)});
    loaded.db.close();
    process.exit(0);
  `;
  return spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      DB_PATH: dbPath,
      NODE_ENV: 'test',
      SESSION_SECRET: 'database-migration-test-secret',
      COOKIE_SECURE: 'false'
    },
    encoding: 'utf8',
    timeout: 60000
  });
}

function cleanup(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    const target = `${dbPath}${suffix}`;
    if (fs.existsSync(target)) fs.unlinkSync(target);
  }
}

describe('数据库全新初始化与历史迁移', () => {
  test.each([
    ['全新空库', false],
    ['旧版 users/bots 库', true]
  ])('%s 可完整升级并具备技术要求新增结构', (_label, oldSchema) => {
    const dbPath = path.join(os.tmpdir(), `study-planner-migration-${process.pid}-${Date.now()}-${oldSchema ? 'old' : 'fresh'}.db`);
    try {
      const initialized = runInitialization(dbPath, oldSchema);
      expect({ status: initialized.status, stderr: initialized.stderr }).toEqual({ status: 0, stderr: '' });
      const db = new Database(dbPath, { readonly: true });
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
      for (const table of [
        'student_profiles', 'student_plan_templates', 'study_plan_items', 'weekly_report_deliveries', 'bot_push_deliveries',
        'bot_config_audits', 'bot_handoff_tickets', 'bot_violation_events', 'bot_release_batches',
        'knowledge_bases', 'knowledge_documents', 'knowledge_chunks'
      ]) expect(tables.has(table)).toBe(true);

      const botColumns = new Set(db.prepare('PRAGMA table_info(bots)').all().map((row) => row.name));
      for (const column of ['robot_uid', 'status', 'updated_at', 'config', 'is_active']) expect(botColumns.has(column)).toBe(true);
      const indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name));
      expect(indexes.has('idx_bots_robot_uid')).toBe(true);
      expect(indexes.has('idx_bot_push_daily')).toBe(true);
      expect(indexes.has('idx_study_plan_student_date')).toBe(true);
      if (oldSchema) {
        const legacy = db.prepare("SELECT robot_uid, status, updated_at FROM bots WHERE code = 'legacy'").get();
        expect(legacy.robot_uid).toMatch(/^R-\d{2,}$/);
        expect(legacy.status).toBe('draft');
        expect(legacy.updated_at).toBeTruthy();
      }
      db.close();
    } finally {
      cleanup(dbPath);
    }
  });
});
