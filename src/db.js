const path = require('path');
const dayjs = require('dayjs');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const config = require('./config');
const { serializeStudentIds, serializeWeekdays } = require('./services/taskService');

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// BUG-090: 定期 WAL checkpoint，防止 WAL 文件无限增长
setInterval(() => {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (_) {}
}, 300000);

// BUG-079: 数据库初始化使用事务保护
function initializeDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'teacher', 'student')),
      display_name TEXT NOT NULL,
      class_name TEXT DEFAULT '',
      openid TEXT DEFAULT '',
      must_change_password INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS teacher_applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      display_name TEXT NOT NULL,
      class_name TEXT DEFAULT '',
      motivation TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      reviewed_by INTEGER DEFAULT NULL,
      reviewed_at TEXT DEFAULT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      subject TEXT DEFAULT '考研规划',
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      weekdays TEXT NOT NULL,
      student_ids TEXT NOT NULL,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_start_time ON tasks(start_time);

    CREATE TABLE IF NOT EXISTS summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      task_date TEXT NOT NULL,
      content TEXT DEFAULT '',
      image_paths TEXT DEFAULT '[]',
      attachment_paths TEXT DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (student_id) REFERENCES users(id),
      UNIQUE(student_id, task_date)
    );

    CREATE TABLE IF NOT EXISTS task_completions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      task_date TEXT NOT NULL,
      completed_at TEXT DEFAULT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id),
      FOREIGN KEY (student_id) REFERENCES users(id),
      UNIQUE(task_id, student_id, task_date)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      task_id INTEGER,
      task_date TEXT DEFAULT '',
      schedule_key TEXT UNIQUE,
      read_at TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (student_id) REFERENCES users(id),
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );

    CREATE TABLE IF NOT EXISTS auth_tokens (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS courses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      subject TEXT DEFAULT '考研规划',
      video_path TEXT DEFAULT '',
      video_url TEXT DEFAULT '',
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      parent_id INTEGER DEFAULT NULL,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);

    CREATE TABLE IF NOT EXISTS folder_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_id INTEGER NOT NULL,
      item_type TEXT NOT NULL DEFAULT 'course' CHECK (item_type IN ('course', 'file', 'video')),
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      subject TEXT DEFAULT '',
      file_path TEXT DEFAULT '',
      file_url TEXT DEFAULT '',
      file_size INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_folder_items_folder ON folder_items(folder_id);

    CREATE TABLE IF NOT EXISTS live_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      subject TEXT DEFAULT '考研规划',
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live', 'ended')),
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT DEFAULT NULL,
      ended_at TEXT DEFAULT NULL,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS live_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      live_session_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (live_session_id) REFERENCES live_sessions(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS forum_topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT DEFAULT '考研交流',
      image_paths TEXT DEFAULT '[]',
      attachment_paths TEXT DEFAULT '[]',
      video_paths TEXT DEFAULT '[]',
      links TEXT DEFAULT '[]',
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS forum_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      image_paths TEXT DEFAULT '[]',
      attachment_paths TEXT DEFAULT '[]',
      video_paths TEXT DEFAULT '[]',
      links TEXT DEFAULT '[]',
      created_at TEXT NOT NULL,
      FOREIGN KEY (topic_id) REFERENCES forum_topics(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS forum_likes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (topic_id) REFERENCES forum_topics(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(topic_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_forum_likes_topic ON forum_likes(topic_id);

    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      subject TEXT DEFAULT '考研英语',
      question_type TEXT DEFAULT '',
      textbook TEXT DEFAULT '',
      stem TEXT NOT NULL,
      options TEXT NOT NULL,
      correct_answer TEXT NOT NULL,
      analysis_text TEXT DEFAULT '',
      analysis_video_path TEXT DEFAULT '',
      analysis_video_url TEXT DEFAULT '',
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS question_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL DEFAULT 'custom' CHECK (category IN ('subject', 'type', 'textbook', 'custom')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS question_tag_relations (
      question_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (question_id, tag_id),
      FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES question_tags(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS flashcards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      subject TEXT DEFAULT '',
      front_content TEXT NOT NULL,
      front_image_path TEXT DEFAULT '',
      back_content TEXT NOT NULL,
      back_image_path TEXT DEFAULT '',
      audio_path TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS flashcard_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      flashcard_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      quality INTEGER NOT NULL DEFAULT 0,
      ease_factor REAL NOT NULL DEFAULT 2.5,
      interval_days INTEGER NOT NULL DEFAULT 0,
      repetitions INTEGER NOT NULL DEFAULT 0,
      next_review_date TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (flashcard_id) REFERENCES flashcards(id),
      FOREIGN KEY (student_id) REFERENCES users(id),
      UNIQUE(flashcard_id, student_id)
    );

    CREATE TABLE IF NOT EXISTS practice_sessions (
      id TEXT PRIMARY KEY,
      student_id INTEGER NOT NULL,
      session_type TEXT NOT NULL DEFAULT 'mixed' CHECK (session_type IN ('mixed', 'subject', 'flashcard', 'wrong_review')),
      subject_filter TEXT DEFAULT '',
      total_questions INTEGER DEFAULT 0,
      correct_count INTEGER DEFAULT 0,
      started_at TEXT NOT NULL,
      ended_at TEXT DEFAULT NULL,
      FOREIGN KEY (student_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS practice_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      selected_answer TEXT NOT NULL,
      is_correct INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (question_id) REFERENCES questions(id),
      FOREIGN KEY (student_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      price REAL NOT NULL,
      stock INTEGER NOT NULL DEFAULT 0,
      image_path TEXT DEFAULT '',
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER,
      student_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      total_amount REAL NOT NULL,
      shipping_address TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'paid',
      created_at TEXT NOT NULL,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL,
      FOREIGN KEY (student_id) REFERENCES users(id)
    );
  `);

  // 教师评语字段
  try { db.exec('ALTER TABLE summaries ADD COLUMN teacher_comment TEXT DEFAULT NULL'); } catch (_) {}
  try { db.exec('ALTER TABLE summaries ADD COLUMN commented_at TEXT DEFAULT NULL'); } catch (_) {}
}

function seedUsers() {
  // BUG-001: 不再检查 count > 0，改为按用户名 INSERT OR IGNORE
  // 避免 migrate() 先创建 admin 后导致 seedUsers 跳过所有种子用户
  const now = dayjs().toISOString();
  const insertUser = db.prepare(`
    INSERT OR IGNORE INTO users (username, password, role, display_name, class_name, must_change_password, created_at)
    VALUES (@username, @password, @role, @display_name, @class_name, @must_change_password, @created_at)
  `);

  insertUser.run({
    username: 'admin',
    password: bcrypt.hashSync('admin123', 10),
    role: 'admin',
    display_name: '超级管理员',
    class_name: '',
    must_change_password: 1,
    created_at: now
  });

  insertUser.run({
    username: 'teacher',
    password: bcrypt.hashSync('123456', 10),
    role: 'teacher',
    display_name: '王老师',
    class_name: '2027考研冲刺班',
    must_change_password: 1,
    created_at: now
  });

  insertUser.run({
    username: 'student1',
    password: bcrypt.hashSync('123456', 10),
    role: 'student',
    display_name: '张同学',
    class_name: '2027考研冲刺班',
    must_change_password: 1,
    created_at: now
  });

  insertUser.run({
    username: 'student2',
    password: bcrypt.hashSync('123456', 10),
    role: 'student',
    display_name: '李同学',
    class_name: '2027考研冲刺班',
    must_change_password: 1,
    created_at: now
  });

  insertUser.run({
    username: 'student3',
    password: bcrypt.hashSync('123456', 10),
    role: 'student',
    display_name: '陈同学',
    class_name: '2027考研冲刺班',
    must_change_password: 1,
    created_at: now
  });
}

function seedContent() {
  const teacher = db.prepare(`SELECT id FROM users WHERE role = 'teacher' LIMIT 1`).get();
  const students = db.prepare(`SELECT id FROM users WHERE role = 'student' ORDER BY id ASC`).all();

  if (!teacher || !students.length) {
    return;
  }

  const taskCount = db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count;
  if (taskCount === 0) {
    const insertTask = db.prepare(`
      INSERT INTO tasks (title, description, subject, start_time, end_time, weekdays, student_ids, created_by, created_at)
      VALUES (@title, @description, @subject, @start_time, @end_time, @weekdays, @student_ids, @created_by, @created_at)
    `);

    const studentIds = students.map((student) => student.id);
    const createdAt = dayjs().toISOString();

    insertTask.run({
      title: '英语长难句精读',
      description: '完成 2 篇考研英语阅读中的长难句拆解，并整理生词。',
      subject: '考研英语',
      start_time: '07:30',
      end_time: '08:20',
      weekdays: serializeWeekdays([1, 2, 3, 4, 5, 6]),
      student_ids: serializeStudentIds(studentIds),
      created_by: teacher.id,
      created_at: createdAt
    });

    insertTask.run({
      title: '数学真题专题训练',
      description: '围绕线代章节刷题 20 道，并记录错题原因。',
      subject: '考研数学',
      start_time: '14:00',
      end_time: '15:30',
      weekdays: serializeWeekdays([1, 3, 5, 6]),
      student_ids: serializeStudentIds(studentIds),
      created_by: teacher.id,
      created_at: createdAt
    });

    insertTask.run({
      title: '政治冲刺背诵',
      description: '背诵当日重点知识点并完成 10 道选择题。',
      subject: '考研政治',
      start_time: '20:00',
      end_time: '20:45',
      weekdays: serializeWeekdays([0, 1, 2, 3, 4, 5, 6]),
      student_ids: serializeStudentIds(studentIds),
      created_by: teacher.id,
      created_at: createdAt
    });
  }

  const courseCount = db.prepare('SELECT COUNT(*) AS count FROM courses').get().count;
  if (courseCount === 0) {
    db.prepare(`
      INSERT INTO courses (title, description, subject, video_path, video_url, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      '考研复习总规划课',
      '讲清楚从基础期到冲刺期的总复习节奏、每日计划拆分方式与错题复盘方法。',
      '考研规划',
      '',
      'https://www.w3schools.com/html/mov_bbb.mp4',
      teacher.id,
      dayjs().toISOString()
    );
  }

  const liveCount = db.prepare('SELECT COUNT(*) AS count FROM live_sessions').get().count;
  if (liveCount === 0) {
    db.prepare(`
      INSERT INTO live_sessions (title, description, subject, status, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      '考研晚自习答疑直播',
      '直播间已就绪，可进行语音视频推流和实时聊天。',
      '考研规划',
      'draft',
      teacher.id,
      dayjs().toISOString()
    );
  }

  const forumCount = db.prepare('SELECT COUNT(*) AS count FROM forum_topics').get().count;
  if (forumCount === 0) {
    const topicResult = db.prepare(`
      INSERT INTO forum_topics (user_id, title, content, category, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      teacher.id,
      '三月复习节奏怎么排最稳？',
      '建议大家把三月分为基础巩固、专题强化、每周复盘三个节奏，不要只盯时长，要盯输出。',
      '备考规划',
      dayjs().toISOString()
    );

    db.prepare(`
      INSERT INTO forum_replies (topic_id, user_id, content, created_at)
      VALUES (?, ?, ?, ?)
    `).run(topicResult.lastInsertRowid, students[0].id, '我现在英语进度落后，是否先补单词再跟阅读？', dayjs().toISOString());
  }

  const questionCount = db.prepare('SELECT COUNT(*) AS count FROM questions').get().count;
  if (questionCount === 0) {
    db.prepare(`
      INSERT INTO questions (
        title, subject, stem, options, correct_answer, analysis_text, analysis_video_path, analysis_video_url, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      '英语阅读细节题示例',
      '考研英语',
      '根据考研英语阅读技巧，细节题最先应该回到哪里定位？',
      JSON.stringify([
        { key: 'A', text: '全文第一段' },
        { key: 'B', text: '题干关键词对应原文位置' },
        { key: 'C', text: '最后一段总结句' },
        { key: 'D', text: '直接凭印象作答' }
      ]),
      'B',
      '细节题优先定位题干关键词，再结合上下文判断，不建议凭感觉选项。',
      '',
      '',
      teacher.id,
      dayjs().toISOString()
    );
  }

  const productCount = db.prepare('SELECT COUNT(*) AS count FROM products').get().count;
  if (productCount === 0) {
    db.prepare(`
      INSERT INTO products (title, description, price, stock, image_path, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      '考研冲刺规划手册',
      '包含周计划模板、错题复盘页、阶段目标拆解模板。',
      39.9,
      80,
      '',
      teacher.id,
      dayjs().toISOString()
    );
  }
}

function migrate() {
  const columns = db.prepare('PRAGMA table_info(users)').all();
  const hasOpenid = columns.some((column) => column.name === 'openid');
  if (!hasOpenid) {
    db.exec('ALTER TABLE users ADD COLUMN openid TEXT DEFAULT ""');
  }

  // BUG-010: 添加 must_change_password 列
  if (!columns.some((column) => column.name === 'must_change_password')) {
    db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0');
  }

  // 升级 users 表 role 约束以支持 admin 角色
  const currentSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (currentSchema && !currentSchema.sql.includes("'admin'")) {
    // 先关闭外键约束，避免 DROP TABLE 时因被引用而失败
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE IF NOT EXISTS users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'teacher', 'student')),
        display_name TEXT NOT NULL,
        class_name TEXT DEFAULT '',
        openid TEXT DEFAULT '',
        must_change_password INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO users_new SELECT id, username, password, role, display_name, class_name, openid, 0, created_at FROM users;
      DROP TABLE IF EXISTS users;
      ALTER TABLE users_new RENAME TO users;
    `);
    db.pragma('foreign_keys = ON');
  }

  // 创建 teacher_applications 表（如不存在）
  db.exec(`
    CREATE TABLE IF NOT EXISTS teacher_applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      display_name TEXT NOT NULL,
      class_name TEXT DEFAULT '',
      motivation TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      reviewed_by INTEGER DEFAULT NULL,
      reviewed_at TEXT DEFAULT NULL,
      created_at TEXT NOT NULL
    );
  `);

  // 创建题库分类相关表
  db.exec(`
    CREATE TABLE IF NOT EXISTS question_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL DEFAULT 'custom' CHECK (category IN ('subject', 'type', 'textbook', 'custom')),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS question_tag_relations (
      question_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (question_id, tag_id),
      FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES question_tags(id) ON DELETE CASCADE
    );
  `);

  // questions 表添加 question_type 和 textbook 列
  const questionColumns = db.prepare('PRAGMA table_info(questions)').all();
  if (!questionColumns.some((c) => c.name === 'question_type')) {
    db.exec('ALTER TABLE questions ADD COLUMN question_type TEXT DEFAULT \'\'');
  }
  if (!questionColumns.some((c) => c.name === 'textbook')) {
    db.exec('ALTER TABLE questions ADD COLUMN textbook TEXT DEFAULT \'\'');
  }

  // 创建文件夹和文件项表
  db.exec(`
    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      parent_id INTEGER DEFAULT NULL,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);
    CREATE TABLE IF NOT EXISTS folder_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_id INTEGER NOT NULL,
      item_type TEXT NOT NULL DEFAULT 'course' CHECK (item_type IN ('course', 'file', 'video')),
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      subject TEXT DEFAULT '',
      file_path TEXT DEFAULT '',
      file_url TEXT DEFAULT '',
      file_size INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_folder_items_folder ON folder_items(folder_id);
  `);

  // 论坛表添加媒体列
  const topicColumns = db.prepare('PRAGMA table_info(forum_topics)').all();
  if (!topicColumns.some((c) => c.name === 'image_paths')) {
    db.exec(`
      ALTER TABLE forum_topics ADD COLUMN image_paths TEXT DEFAULT '[]';
      ALTER TABLE forum_topics ADD COLUMN attachment_paths TEXT DEFAULT '[]';
      ALTER TABLE forum_topics ADD COLUMN video_paths TEXT DEFAULT '[]';
      ALTER TABLE forum_topics ADD COLUMN links TEXT DEFAULT '[]';
    `);
  }

  const replyColumns = db.prepare('PRAGMA table_info(forum_replies)').all();
  if (!replyColumns.some((c) => c.name === 'image_paths')) {
    db.exec(`
      ALTER TABLE forum_replies ADD COLUMN image_paths TEXT DEFAULT '[]';
      ALTER TABLE forum_replies ADD COLUMN attachment_paths TEXT DEFAULT '[]';
      ALTER TABLE forum_replies ADD COLUMN video_paths TEXT DEFAULT '[]';
      ALTER TABLE forum_replies ADD COLUMN links TEXT DEFAULT '[]';
    `);
  }

  // 论坛点赞表
  db.exec(`
    CREATE TABLE IF NOT EXISTS forum_likes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (topic_id) REFERENCES forum_topics(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(topic_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_forum_likes_topic ON forum_likes(topic_id);
  `);

  // 创建词汇卡片和练习会话表
  db.exec(`
    CREATE TABLE IF NOT EXISTS flashcards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      subject TEXT DEFAULT '',
      front_content TEXT NOT NULL,
      front_image_path TEXT DEFAULT '',
      back_content TEXT NOT NULL,
      back_image_path TEXT DEFAULT '',
      audio_path TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS flashcard_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      flashcard_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      quality INTEGER NOT NULL DEFAULT 0,
      ease_factor REAL NOT NULL DEFAULT 2.5,
      interval_days INTEGER NOT NULL DEFAULT 0,
      repetitions INTEGER NOT NULL DEFAULT 0,
      next_review_date TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (flashcard_id) REFERENCES flashcards(id),
      FOREIGN KEY (student_id) REFERENCES users(id),
      UNIQUE(flashcard_id, student_id)
    );
    CREATE TABLE IF NOT EXISTS practice_sessions (
      id TEXT PRIMARY KEY,
      student_id INTEGER NOT NULL,
      session_type TEXT NOT NULL DEFAULT 'mixed' CHECK (session_type IN ('mixed', 'subject', 'flashcard', 'wrong_review')),
      subject_filter TEXT DEFAULT '',
      total_questions INTEGER DEFAULT 0,
      correct_count INTEGER DEFAULT 0,
      started_at TEXT NOT NULL,
      ended_at TEXT DEFAULT NULL,
      FOREIGN KEY (student_id) REFERENCES users(id)
    );
  `);

  // practice_records 添加新列
  const prColumns = db.prepare('PRAGMA table_info(practice_records)').all();
  if (!prColumns.some((c) => c.name === 'time_spent_ms')) {
    db.exec(`
      ALTER TABLE practice_records ADD COLUMN time_spent_ms INTEGER DEFAULT 0;
      ALTER TABLE practice_records ADD COLUMN session_id TEXT DEFAULT '';
    `);
  }

  // 创建任务完成表
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_completions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      task_date TEXT NOT NULL,
      completed_at TEXT DEFAULT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id),
      FOREIGN KEY (student_id) REFERENCES users(id),
      UNIQUE(task_id, student_id, task_date)
    );
  `);

  // 为任务开始时间添加索引，优化定时提醒查询
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_start_time ON tasks(start_time)');

  // 确保 admin 账号存在
  const adminExists = db.prepare("SELECT id FROM users WHERE role = 'admin'").get();
  if (!adminExists) {
    db.prepare(`
      INSERT INTO users (username, password, role, display_name, class_name, created_at)
      VALUES (?, ?, 'admin', '超级管理员', '', ?)
    `).run('admin', bcrypt.hashSync('admin123', 10), dayjs().toISOString());
  }

  db.exec("CREATE TABLE IF NOT EXISTS _migration_flags (key TEXT PRIMARY KEY, value TEXT)");
  const cleanupFlag = db.prepare("SELECT value FROM _migration_flags WHERE key = 'cleanup_question_marks'").get();
  if (!cleanupFlag) {
    db.prepare("UPDATE summaries SET content = '' WHERE content LIKE '%???%'").run();
    db.prepare("UPDATE orders SET shipping_address = '默认地址' WHERE shipping_address LIKE '%???%'").run();
    db.prepare("INSERT INTO _migration_flags (key, value) VALUES ('cleanup_question_marks', '1')").run();
  }

  // BUG-038: 仅迁移明文密码，跳过已哈希的密码（避免对 teacher_applications 审批后残留的空密码重复哈希）
  const plainPasswordUsers = db.prepare("SELECT id, password FROM users WHERE password NOT LIKE '$2%' AND password != ''").all();
  const migratePassword = db.prepare('UPDATE users SET password = ? WHERE id = ?');
  for (const user of plainPasswordUsers) {
    migratePassword.run(bcrypt.hashSync(user.password, 10), user.id);
  }

  // BUG-010: 确保 admin 账号标记为需要修改密码
  const adminUser = db.prepare("SELECT id FROM users WHERE role = 'admin' AND must_change_password = 0 AND username = 'admin'").get();
  if (adminUser) {
    db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(adminUser.id);
  }

  // BUG-021: orders 表添加 ON DELETE SET NULL
  const orderFlag = db.prepare("SELECT value FROM _migration_flags WHERE key = 'orders_on_delete'").get();
  if (!orderFlag) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE IF NOT EXISTS orders_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER,
        student_id INTEGER NOT NULL,
        quantity INTEGER NOT NULL,
        total_amount REAL NOT NULL,
        shipping_address TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'paid',
        created_at TEXT NOT NULL,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL,
        FOREIGN KEY (student_id) REFERENCES users(id)
      );
      INSERT OR IGNORE INTO orders_new SELECT * FROM orders;
      DROP TABLE IF EXISTS orders;
      ALTER TABLE orders_new RENAME TO orders;
    `);
    db.pragma('foreign_keys = ON');
    db.prepare("INSERT INTO _migration_flags (key, value) VALUES ('orders_on_delete', '1')").run();
  }

  // BUG-003: 清理数据库中已存在的乱码记录
  const dirtyDataFlag = db.prepare("SELECT value FROM _migration_flags WHERE key = 'cleanup_dirty_data'").get();
  if (!dirtyDataFlag) {
    // BUG-005: 扩展乱码清理到所有文本表
    db.prepare("UPDATE summaries SET content = '' WHERE content LIKE '%\uFFFD%'").run();
    db.prepare("DELETE FROM summaries WHERE content = '' AND image_paths = '[]' AND attachment_paths = '[]'").run();
    db.prepare("UPDATE tasks SET title = REPLACE(title, X'EFBFBD', '') WHERE title LIKE '%\uFFFD%'").run();
    db.prepare("UPDATE tasks SET description = REPLACE(description, X'EFBFBD', '') WHERE description LIKE '%\uFFFD%'").run();
    db.prepare("UPDATE questions SET title = REPLACE(title, X'EFBFBD', '') WHERE title LIKE '%\uFFFD%'").run();
    db.prepare("UPDATE questions SET stem = REPLACE(stem, X'EFBFBD', '') WHERE stem LIKE '%\uFFFD%'").run();
    db.prepare("DELETE FROM tasks WHERE title = '' OR title LIKE '%??%'").run();
    db.prepare("INSERT INTO _migration_flags (key, value) VALUES ('cleanup_dirty_data', '1')").run();
  }

  // 题目收藏表
  db.exec(`
    CREATE TABLE IF NOT EXISTS question_favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES users(id),
      UNIQUE(question_id, student_id)
    );
    CREATE INDEX IF NOT EXISTS idx_qfav_student ON question_favorites(student_id);
  `);

  // 论坛收藏表
  db.exec(`
    CREATE TABLE IF NOT EXISTS forum_favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (topic_id) REFERENCES forum_topics(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(topic_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_forum_fav_user ON forum_favorites(user_id);
  `);

  // 学习连续天数表
  db.exec(`
    CREATE TABLE IF NOT EXISTS study_streaks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      current_streak INTEGER NOT NULL DEFAULT 0,
      longest_streak INTEGER NOT NULL DEFAULT 0,
      last_study_date TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (student_id) REFERENCES users(id),
      UNIQUE(student_id)
    );
  `);

  // 课程播放进度表
  db.exec(`
    CREATE TABLE IF NOT EXISTS course_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      position_seconds REAL NOT NULL DEFAULT 0,
      duration_seconds REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (course_id) REFERENCES folder_items(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES users(id),
      UNIQUE(course_id, student_id)
    );
  `);

  // 论坛回复楼中楼: reply_to_id + reply_to_user
  const replyCols = db.prepare('PRAGMA table_info(forum_replies)').all();
  if (!replyCols.some((c) => c.name === 'reply_to_id')) {
    db.exec('ALTER TABLE forum_replies ADD COLUMN reply_to_id INTEGER DEFAULT NULL');
  }
  if (!replyCols.some((c) => c.name === 'reply_to_user')) {
    db.exec('ALTER TABLE forum_replies ADD COLUMN reply_to_user TEXT DEFAULT ""');
  }

  // 论坛帖子话题标签
  const topicCols = db.prepare('PRAGMA table_info(forum_topics)').all();
  if (!topicCols.some((c) => c.name === 'hashtags')) {
    db.exec('ALTER TABLE forum_topics ADD COLUMN hashtags TEXT DEFAULT "[]"');
  }

  // 成就系统
  db.exec(`
    CREATE TABLE IF NOT EXISTS achievements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      icon TEXT DEFAULT '',
      condition_type TEXT NOT NULL,
      condition_value INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS user_achievements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      achievement_id INTEGER NOT NULL,
      unlocked_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (achievement_id) REFERENCES achievements(id),
      UNIQUE(user_id, achievement_id)
    );
  `);

  // 种子成就数据
  const achievementCount = db.prepare('SELECT COUNT(*) as cnt FROM achievements').get();
  if (!achievementCount.cnt) {
    const insertAch = db.prepare(
      'INSERT OR IGNORE INTO achievements (code, title, description, icon, condition_type, condition_value) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const achievements = [
      ['streak_7', '坚持一周', '连续打卡7天', '&#128293;', 'streak', 7],
      ['streak_30', '月度学霸', '连续打卡30天', '&#127942;', 'streak', 30],
      ['streak_100', '百日筑基', '连续打卡100天', '&#129351;', 'streak', 100],
      ['questions_100', '百题斩', '累计做题100道', '&#128218;', 'total_questions', 100],
      ['questions_500', '五百题达人', '累计做题500道', '&#127891;', 'total_questions', 500],
      ['questions_1000', '千题破壁', '累计做题1000道', '&#127775;', 'total_questions', 1000],
      ['accuracy_90', '精准射手', '累计正确率≥90%（至少50题）', '&#127919;', 'accuracy_90', 50],
      ['forum_10', '社区活跃', '论坛发帖10篇', '&#128172;', 'forum_posts', 10],
      ['forum_50', '意见领袖', '论坛发帖50篇', '&#128081;', 'forum_posts', 50],
      ['flashcard_100', '词汇达人', '闪卡复习100张', '&#128214;', 'flashcard_reviews', 100],
      ['flashcard_500', '词汇大师', '闪卡复习500张', '&#129504;', 'flashcard_reviews', 500],
      ['summary_7', '周总结达人', '提交学习总结7次', '&#128221;', 'summaries', 7],
      ['summary_30', '月度复盘', '提交学习总结30次', '&#128203;', 'summaries', 30],
      ['focus_60', '专注一小时', '单次专注学习60分钟', '&#9201;', 'focus_minutes', 60],
      ['early_bird', '早起鸟儿', '早上6点前开始学习', '&#127749;', 'early_bird', 1]
    ];
    for (const a of achievements) {
      insertAch.run(...a);
    }
  }

  // 闪卡增加例句字段
  const flashcardCols = db.prepare('PRAGMA table_info(flashcards)').all();
  if (!flashcardCols.some((c) => c.name === 'example_sentence')) {
    db.exec('ALTER TABLE flashcards ADD COLUMN example_sentence TEXT DEFAULT ""');
  }

  // 商品增加分类字段
  const productCols = db.prepare('PRAGMA table_info(products)').all();
  if (!productCols.some((c) => c.name === 'category')) {
    db.exec('ALTER TABLE products ADD COLUMN category TEXT DEFAULT ""');
  }

  // 课程笔记表
  db.exec(`
    CREATE TABLE IF NOT EXISTS course_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      timestamp_seconds REAL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (item_id) REFERENCES folder_items(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_course_notes_item ON course_notes(item_id, student_id);
  `);

  // 课程评价表
  db.exec(`
    CREATE TABLE IF NOT EXISTS course_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      content TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (item_id) REFERENCES folder_items(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES users(id),
      UNIQUE(item_id, student_id)
    );
  `);

  // 购物车表
  db.exec(`
    CREATE TABLE IF NOT EXISTS shopping_cart (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      FOREIGN KEY (student_id) REFERENCES users(id),
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
      UNIQUE(student_id, product_id)
    );
  `);

  // 地址簿表
  db.exec(`
    CREATE TABLE IF NOT EXISTS address_book (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      phone TEXT DEFAULT '',
      address TEXT NOT NULL,
      is_default INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (student_id) REFERENCES users(id)
    );
  `);

  // 商品评价表
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      content TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES users(id)
    );
  `);

  // 直播预约表
  db.exec(`
    CREATE TABLE IF NOT EXISTS live_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      live_session_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (live_session_id) REFERENCES live_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES users(id),
      UNIQUE(live_session_id, student_id)
    );
  `);

  // 直播禁言字段
  const liveMsgCols = db.prepare('PRAGMA table_info(live_messages)').all();
  if (!liveMsgCols.some((c) => c.name === 'is_muted')) {
    db.exec('ALTER TABLE live_messages ADD COLUMN is_muted INTEGER DEFAULT 0');
  }

  // 任务优先级
  const taskCols = db.prepare('PRAGMA table_info(tasks)').all();
  if (!taskCols.some((c) => c.name === 'priority')) {
    db.exec('ALTER TABLE tasks ADD COLUMN priority INTEGER DEFAULT 2');
  }

  // 闪卡每日目标
  db.exec(`
    CREATE TABLE IF NOT EXISTS flashcard_goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      daily_new INTEGER NOT NULL DEFAULT 20,
      daily_review INTEGER NOT NULL DEFAULT 50,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (student_id) REFERENCES users(id),
      UNIQUE(student_id)
    );
  `);

  // 搜索历史（仅后端热门统计用）
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      keyword TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_search_logs_keyword ON search_logs(keyword);
  `);

  // ===== 第二阶段新功能迁移 =====

  // 论坛帖子置顶 & 精华
  const topicCols2 = db.prepare('PRAGMA table_info(forum_topics)').all();
  if (!topicCols2.some((c) => c.name === 'is_pinned')) {
    db.exec('ALTER TABLE forum_topics ADD COLUMN is_pinned INTEGER DEFAULT 0');
  }
  if (!topicCols2.some((c) => c.name === 'is_featured')) {
    db.exec('ALTER TABLE forum_topics ADD COLUMN is_featured INTEGER DEFAULT 0');
  }

  // 论坛热门话题表
  db.exec(`
    CREATE TABLE IF NOT EXISTS forum_trending (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id INTEGER NOT NULL,
      score REAL NOT NULL DEFAULT 0,
      calculated_at TEXT NOT NULL,
      FOREIGN KEY (topic_id) REFERENCES forum_topics(id) ON DELETE CASCADE,
      UNIQUE(topic_id)
    );
    CREATE INDEX IF NOT EXISTS idx_trending_score ON forum_trending(score DESC);
  `);

  // 用户关注系统
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_follows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      follower_id INTEGER NOT NULL,
      following_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (follower_id) REFERENCES users(id),
      FOREIGN KEY (following_id) REFERENCES users(id),
      UNIQUE(follower_id, following_id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_follows_follower ON user_follows(follower_id);
    CREATE INDEX IF NOT EXISTS idx_user_follows_following ON user_follows(following_id);
  `);

  // 内容举报表
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reporter_id INTEGER NOT NULL,
      target_type TEXT NOT NULL CHECK (target_type IN ('topic', 'reply')),
      target_id INTEGER NOT NULL,
      reason TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'dismissed')),
      created_at TEXT NOT NULL,
      FOREIGN KEY (reporter_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_reports_status ON content_reports(status);
  `);

  // 帖子赞同表
  db.exec(`
    CREATE TABLE IF NOT EXISTS forum_endorsements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (topic_id) REFERENCES forum_topics(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(topic_id, user_id)
    );
  `);

  // 闪卡词根词缀 + 搭配字段
  const flashcardCols2 = db.prepare('PRAGMA table_info(flashcards)').all();
  if (!flashcardCols2.some((c) => c.name === 'word_root')) {
    db.exec('ALTER TABLE flashcards ADD COLUMN word_root TEXT DEFAULT ""');
  }
  if (!flashcardCols2.some((c) => c.name === 'affix')) {
    db.exec('ALTER TABLE flashcards ADD COLUMN affix TEXT DEFAULT ""');
  }
  if (!flashcardCols2.some((c) => c.name === 'collocations')) {
    db.exec('ALTER TABLE flashcards ADD COLUMN collocations TEXT DEFAULT "[]"');
  }
  if (!flashcardCols2.some((c) => c.name === 'phonetic')) {
    db.exec('ALTER TABLE flashcards ADD COLUMN phonetic TEXT DEFAULT ""');
  }

  // 题目笔记表
  db.exec(`
    CREATE TABLE IF NOT EXISTS question_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES users(id),
      UNIQUE(question_id, student_id)
    );
  `);

  // 错题复习计划表 (3/7/15天间隔)
  db.exec(`
    CREATE TABLE IF NOT EXISTS wrong_review_schedule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      review_date TEXT NOT NULL,
      review_round INTEGER NOT NULL DEFAULT 1,
      is_done INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_wrong_review_date ON wrong_review_schedule(student_id, review_date);
  `);

  // 模拟考试表
  db.exec(`
    CREATE TABLE IF NOT EXISTS mock_exams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      subject TEXT DEFAULT '',
      duration_minutes INTEGER NOT NULL DEFAULT 120,
      total_score REAL DEFAULT 100,
      question_ids TEXT DEFAULT '[]',
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS mock_exam_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exam_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      answers TEXT DEFAULT '{}',
      score REAL DEFAULT 0,
      time_spent_ms INTEGER DEFAULT 0,
      submitted_at TEXT DEFAULT NULL,
      started_at TEXT NOT NULL,
      FOREIGN KEY (exam_id) REFERENCES mock_exams(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES users(id),
      UNIQUE(exam_id, student_id)
    );
  `);

  // 商城虚拟商品 & 拼团
  const productCols2 = db.prepare('PRAGMA table_info(products)').all();
  if (!productCols2.some((c) => c.name === 'is_virtual')) {
    db.exec('ALTER TABLE products ADD COLUMN is_virtual INTEGER DEFAULT 0');
  }
  if (!productCols2.some((c) => c.name === 'virtual_content')) {
    db.exec('ALTER TABLE products ADD COLUMN virtual_content TEXT DEFAULT ""');
  }
  if (!productCols2.some((c) => c.name === 'original_price')) {
    db.exec('ALTER TABLE products ADD COLUMN original_price REAL DEFAULT 0');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS group_buys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      initiator_id INTEGER NOT NULL,
      target_count INTEGER NOT NULL DEFAULT 3,
      current_count INTEGER NOT NULL DEFAULT 1,
      group_price REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'success', 'expired')),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
      FOREIGN KEY (initiator_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS group_buy_participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_buy_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      order_id INTEGER DEFAULT NULL,
      joined_at TEXT NOT NULL,
      FOREIGN KEY (group_buy_id) REFERENCES group_buys(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES users(id),
      UNIQUE(group_buy_id, student_id)
    );
  `);

  // 考研倒计时设置
  db.exec(`
    CREATE TABLE IF NOT EXISTS exam_countdown (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      exam_date TEXT NOT NULL,
      exam_name TEXT DEFAULT '考研',
      created_at TEXT NOT NULL,
      FOREIGN KEY (student_id) REFERENCES users(id),
      UNIQUE(student_id)
    );
  `);

  // 习惯追踪表
  db.exec(`
    CREATE TABLE IF NOT EXISTS habit_tracking (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      habit_name TEXT NOT NULL,
      target_days INTEGER NOT NULL DEFAULT 7,
      completed_dates TEXT DEFAULT '[]',
      created_at TEXT NOT NULL,
      FOREIGN KEY (student_id) REFERENCES users(id)
    );
  `);

  // 直播弹幕 & 互动答题
  const liveMsgCols2 = db.prepare('PRAGMA table_info(live_messages)').all();
  if (!liveMsgCols2.some((c) => c.name === 'msg_type')) {
    db.exec('ALTER TABLE live_messages ADD COLUMN msg_type TEXT DEFAULT "chat"');
  }
  if (!liveMsgCols2.some((c) => c.name === 'color')) {
    db.exec('ALTER TABLE live_messages ADD COLUMN color TEXT DEFAULT ""');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS live_polls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      live_session_id INTEGER NOT NULL,
      question TEXT NOT NULL,
      options TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      FOREIGN KEY (live_session_id) REFERENCES live_sessions(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS live_poll_votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      poll_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      option_index INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (poll_id) REFERENCES live_polls(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(poll_id, user_id)
    );
  `);

  // AI 功能记录表
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL DEFAULT 'tutor' CHECK (type IN ('tutor', 'essay', 'plan', 'generate', 'summary')),
      context TEXT DEFAULT '',
      prompt TEXT NOT NULL,
      response TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_ai_conv_user ON ai_conversations(user_id, type);
  `);

  // 闪卡学习排行榜 (materialized from flashcard_records)
  // 无需新表，用聚合查询实现
}

function initialize() {
  initializeDatabase();
  migrate();
  seedUsers();
  seedContent();
}

initialize();

module.exports = {
  db
};
