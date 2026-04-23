const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const WebSocket = require('ws');
const XLSX = require('xlsx');
const iconv = require('iconv-lite');
const dayjs = require('dayjs');
const bcrypt = require('bcryptjs');
const config = require('./config');
const { db } = require('./db');
const { dispatchDailyDigest, dispatchDueTaskReminders, startScheduler } = require('./services/scheduler');
const {
  formatWeekdaysLabel,
  getAllTasks,
  getStudentsByIds,
  getTasksForStudentOnDate,
  normalizeStudentIds,
  normalizeWeekdays,
  safeJsonParse,
  serializeStudentIds,
  serializeWeekdays
} = require('./services/taskService');
const { sanitizeText, escapeHtml, stripHtml } = require('./utils/sanitize');

const MAX_TITLE_LENGTH = 200;
const MAX_CONTENT_LENGTH = 10000;
const MAX_NAME_LENGTH = 100;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const publicDir = path.join(config.rootDir, 'public');
const uploadRootDir = config.uploadRootDir;

['summary', 'course', 'question', 'product', 'task-import', 'cloud', 'forum'].forEach((folderName) => {
  fs.mkdirSync(path.join(uploadRootDir, folderName), { recursive: true });
});

if (config.trustProxy) {
  app.set('trust proxy', 1);
}

// BUG-004: 过滤请求体中的控制字符，防止 500 错误
app.use((request, response, next) => {
  const originalBody = request.body;
  if (originalBody && typeof originalBody === 'object') {
    const sanitize = (value) => {
      if (typeof value === 'string') {
        return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
      }
      return value;
    };
    const clean = (obj) => {
      if (!obj || typeof obj !== 'object') return obj;
      if (Array.isArray(obj)) return obj.map(clean);
      const result = {};
      for (const key of Object.keys(obj)) {
        result[key] = typeof obj[key] === 'string' ? sanitize(obj[key]) : (typeof obj[key] === 'object' ? clean(obj[key]) : obj[key]);
      }
      return result;
    };
    request.body = clean(originalBody);
  }
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb', charset: 'utf-8' }));
app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 7,
      secure: config.cookieSecure
    }
  })
);

// ── 共享工具函数 ──

function toPublicPath(absolutePath) {
  const normalizedUploadRoot = uploadRootDir.split(path.sep).join('/');
  const normalizedPath = absolutePath.split(path.sep).join('/');

  if (normalizedPath.startsWith(normalizedUploadRoot)) {
    return `/uploads${normalizedPath.slice(normalizedUploadRoot.length)}`;
  }

  return normalizedPath.replace(publicDir.split(path.sep).join('/'), '');
}

const ALLOWED_EXTENSIONS = /\.(jpg|jpeg|png|gif|webp|mp4|webm|pdf|doc|docx|xls|xlsx|csv|ppt|pptx|zip|rar|txt|md)$/i;
const UPLOAD_LIMITS = { fileSize: 100 * 1024 * 1024 };

function fileFilter(request, file, callback) {
  if (ALLOWED_EXTENSIONS.test(path.extname(file.originalname || ''))) {
    callback(null, true);
  } else {
    callback(new Error('不支持的文件类型。'));
  }
}

function buildStorage(folderName) {
  return multer.diskStorage({
    destination: (request, file, callback) => {
      callback(null, path.join(uploadRootDir, folderName));
    },
    filename: (request, file, callback) => {
      const extension = path.extname(file.originalname || '');
      const rawBase = path.basename(file.originalname || 'file', extension).replace(/[^\w\u4e00-\u9fff\-]+/g, '_');
      const baseName = rawBase.length > 50 ? rawBase.slice(0, 50) : rawBase;
      callback(null, `${Date.now()}-${Math.random().toString(16).slice(2)}-${baseName}${extension}`);
    }
  });
}

const summaryUpload = multer({ storage: buildStorage('summary'), fileFilter, limits: UPLOAD_LIMITS }).fields([
  { name: 'images', maxCount: 8 },
  { name: 'attachments', maxCount: 8 }
]);
const courseUpload = multer({ storage: buildStorage('course'), fileFilter, limits: UPLOAD_LIMITS }).single('video');
const questionUpload = multer({ storage: buildStorage('question'), fileFilter, limits: UPLOAD_LIMITS }).single('analysisVideo');
const productUpload = multer({ storage: buildStorage('product'), fileFilter, limits: UPLOAD_LIMITS }).single('image');
const taskImportUpload = multer({ storage: buildStorage('task-import'), fileFilter, limits: UPLOAD_LIMITS }).single('file');
const cloudUpload = multer({ storage: buildStorage('cloud'), fileFilter, limits: UPLOAD_LIMITS }).single('file');
const forumUpload = multer({ storage: buildStorage('forum'), fileFilter, limits: UPLOAD_LIMITS }).fields([
  { name: 'images', maxCount: 9 },
  { name: 'videos', maxCount: 1 },
  { name: 'attachments', maxCount: 3 }
]);

// BUG-012: /uploads 静态文件需要鉴权（支持 cookie session 或 ?token= 查询参数）
app.use('/uploads', (request, response, next) => {
  const sessionUser = request.session.userId ? getUserById(request.session.userId) : null;
  const authToken = getBearerToken(request) || request.query.token;
  const tokenUser = authToken ? getUserByToken(authToken) : null;
  if (sessionUser || tokenUser) {
    return next();
  }
  response.status(401).send('未登录');
}, express.static(uploadRootDir));
app.use(express.static(publicDir, { index: false }));

// BUG-057: CSRF 防护 — 对状态变更请求校验 Origin/Referer
function csrfCheck(request, response, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    return next();
  }
  // API 请求通过 Bearer Token 认证的不需要 CSRF（小程序场景）
  const authToken = getBearerToken(request);
  if (authToken) {
    return next();
  }
  // BUG-005: Session 场景：要求 Origin 或 Referer 必须存在且与本站匹配
  const origin = request.headers.origin || '';
  const referer = request.headers.referer || '';
  const host = request.headers.host || '';
  const originOrReferer = origin || referer;
  if (!originOrReferer) {
    response.status(403).json({ error: '缺少 Origin 或 Referer 头，请求被拒绝。' });
    return;
  }
  if (host && !originOrReferer.includes(host)) {
    response.status(403).json({ error: 'CSRF 校验失败。' });
    return;
  }
  next();
}
app.use(csrfCheck);

// BUG-058: 登录/注册速率限制（每 IP 每分钟最多 10 次）
// BUG-102: 登录和注册使用独立的速率限制器
const loginRateLimiter = new Map();
const registerRateLimiter = new Map();

function createRateLimiter(store) {
  return function checkRateLimit(request, response, next) {
    const clientIp = request.ip || request.connection.remoteAddress || 'unknown';
    const now = Date.now();
    const records = store.get(clientIp) || [];
    const recent = records.filter((t) => now - t < 60000);
    if (recent.length >= 10) {
      response.status(429).json({ error: '请求过于频繁，请稍后再试。' });
      return;
    }
    recent.push(now);
    store.set(clientIp, recent);
    if (store.size > 10000) {
      for (const [ip, timestamps] of store) {
        const filtered = timestamps.filter((t) => now - t < 60000);
        if (!filtered.length) store.delete(ip);
        else store.set(ip, filtered);
      }
    }
    next();
  };
}

const checkLoginRateLimit = createRateLimiter(loginRateLimiter);
const checkRegisterRateLimit = createRateLimiter(registerRateLimiter);

// BUG-018: 限速器定期清理过期记录
setInterval(() => {
  const now = Date.now();
  for (const store of [loginRateLimiter, registerRateLimiter]) {
    for (const [ip, timestamps] of store) {
      const filtered = timestamps.filter((t) => now - t < 60000);
      if (!filtered.length) store.delete(ip);
      else store.set(ip, filtered);
    }
  }
}, 300000);

// ── 用户/认证辅助函数 ──

function getUserById(id) {
  if (!id) {
    return null;
  }

  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

function sanitizeUser(user) {
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    username: user.username,
    role: user.role,
    displayName: user.display_name,
    className: user.class_name,
    mustChangePassword: Boolean(user.must_change_password)
  };
}

function getStudents() {
  return db
    .prepare(`SELECT id, username, display_name, class_name FROM users WHERE role = 'student' ORDER BY display_name ASC`)
    .all()
    .map((row) => ({
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      className: row.class_name
    }));
}

// ── 序列化辅助函数 ──

function serializeTask(task) {
  const students = getStudentsByIds(db, task.studentIds);
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    subject: task.subject,
    startTime: task.start_time,
    endTime: task.end_time,
    weekdays: task.weekdays,
    weekdaysLabel: formatWeekdaysLabel(task.weekdays),
    priority: task.priority || 2,
    reminderStart: task.reminder_start || '',
    reminderEnd: task.reminder_end || '',
    createdAt: task.created_at,
    teacherName: task.teacher_name || '',
    students: students.map((student) => ({
      id: student.id,
      username: student.username,
      displayName: student.display_name,
      className: student.class_name
    }))
  };
}

function serializeSummary(row) {
  return {
    id: row.id,
    studentId: row.student_id,
    studentName: row.student_name,
    taskDate: row.task_date,
    content: row.content,
    imagePaths: safeJsonParse(row.image_paths, []),
    attachmentPaths: safeJsonParse(row.attachment_paths, []),
    teacherComment: row.teacher_comment || null,
    commentedAt: row.commented_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function serializeCourse(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    subject: row.subject,
    videoPath: row.video_path,
    videoUrl: row.video_url,
    teacherName: row.teacher_name,
    createdAt: row.created_at
  };
}

function serializeLiveSession(row) {
  const viewers = row.status === 'live' ? (liveRooms.get(row.id) || new Set()).size : 0;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    subject: row.subject,
    status: row.status,
    teacherName: row.teacher_name,
    viewerCount: viewers,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at
  };
}

function serializeForumTopic(topic, repliesMap, likesMap) {
  const replies = (repliesMap ? repliesMap.get(topic.id) || [] : []).map((reply) => ({
    id: reply.id,
    topicId: reply.topic_id,
    content: reply.content,
    imagePaths: safeJsonParse(reply.image_paths, []),
    attachmentPaths: safeJsonParse(reply.attachment_paths, []),
    videoPaths: safeJsonParse(reply.video_paths, []),
    links: safeJsonParse(reply.links, []),
    authorName: reply.author_name,
    authorRole: reply.author_role,
    replyToId: reply.reply_to_id || null,
    replyToUser: reply.reply_to_user || '',
    createdAt: reply.created_at
  }));

  const likeEntry = likesMap ? likesMap.get(topic.id) : null;

  return {
    id: topic.id,
    title: topic.title,
    content: topic.content,
    category: topic.category,
    isPinned: topic.is_pinned || 0,
    isFeatured: topic.is_featured || 0,
    hashtags: safeJsonParse(topic.hashtags, []),
    imagePaths: safeJsonParse(topic.image_paths, []),
    attachmentPaths: safeJsonParse(topic.attachment_paths, []),
    videoPaths: safeJsonParse(topic.video_paths, []),
    links: safeJsonParse(topic.links, []),
    authorId: topic.user_id,
    authorName: topic.author_name,
    authorRole: topic.author_role,
    createdAt: topic.created_at,
    likeCount: likeEntry ? likeEntry.count : 0,
    likedByMe: likeEntry ? likeEntry.likedByMe : false,
    replies
  };
}

// BUG-020: 批量预加载论坛回复，避免 N+1 查询
function batchLoadForumReplies(topicIds) {
  if (!topicIds.length) return new Map();
  const placeholders = topicIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT forum_replies.*, users.display_name AS author_name, users.role AS author_role
     FROM forum_replies
     LEFT JOIN users ON users.id = forum_replies.user_id
     WHERE forum_replies.topic_id IN (${placeholders})
     ORDER BY forum_replies.created_at ASC`
  ).all(...topicIds);
  const map = new Map();
  rows.forEach((row) => {
    const list = map.get(row.topic_id) || [];
    list.push(row);
    map.set(row.topic_id, list);
  });
  return map;
}

function batchLoadForumLikes(topicIds, userId) {
  if (!topicIds.length) return new Map();
  const placeholders = topicIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT topic_id, COUNT(*) AS count FROM forum_likes
     WHERE topic_id IN (${placeholders})
     GROUP BY topic_id`
  ).all(...topicIds);
  const map = new Map();
  rows.forEach((r) => map.set(r.topic_id, { count: r.count, likedByMe: false }));
  if (userId) {
    const likedRows = db.prepare(
      `SELECT topic_id FROM forum_likes WHERE topic_id IN (${placeholders}) AND user_id = ?`
    ).all(...topicIds, userId);
    likedRows.forEach((r) => {
      const entry = map.get(r.topic_id) || { count: 0 };
      entry.likedByMe = true;
      map.set(r.topic_id, entry);
    });
  }
  return map;
}

function serializeQuestionForTeacher(row) {
  return {
    id: row.id,
    title: row.title,
    subject: row.subject,
    questionType: row.question_type || '',
    textbook: row.textbook || '',
    stem: row.stem,
    options: safeJsonParse(row.options, []),
    correctAnswer: row.correct_answer,
    analysisText: row.analysis_text,
    analysisVideoPath: row.analysis_video_path,
    analysisVideoUrl: row.analysis_video_url,
    createdAt: row.created_at
  };
}

function serializeQuestionForStudent(row, latestRecord) {
  return {
    id: row.id,
    title: row.title,
    subject: row.subject,
    stem: row.stem,
    options: safeJsonParse(row.options, []),
    createdAt: row.created_at,
    latestRecord: latestRecord
      ? {
          selectedAnswer: latestRecord.selected_answer,
          isCorrect: Boolean(latestRecord.is_correct),
          createdAt: latestRecord.created_at
        }
      : null
  };
}

function serializeProduct(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    price: row.price,
    originalPrice: row.original_price || 0,
    stock: row.stock,
    imagePath: row.image_path,
    category: row.category || '',
    isVirtual: row.is_virtual || 0,
    virtualContent: row.is_virtual ? (row.virtual_content || '') : '',
    createdAt: row.created_at
  };
}

function serializeOrder(row) {
  return {
    id: row.id,
    productId: row.product_id,
    studentId: row.student_id,
    quantity: row.quantity,
    totalAmount: row.total_amount,
    shippingAddress: row.shipping_address,
    status: row.status,
    createdAt: row.created_at,
    productTitle: row.product_title,
    studentName: row.student_name
  };
}

function serializeNotification(row) {
  return {
    id: row.id,
    studentId: row.student_id,
    type: row.type,
    title: row.title,
    body: row.body,
    taskId: row.task_id,
    taskDate: row.task_date,
    readAt: row.read_at,
    createdAt: row.created_at
  };
}

// ── Bootstrap 数据辅助函数 ──

function getTeacherBootstrapData(user) {
  return getTeacherCoreBootstrapData(user);
}

function getTeacherCoreBootstrapData(user) {
  const tasks = getAllTasks(db).map(serializeTask);
  const summaries = db
    .prepare(
      `
        SELECT summaries.*, users.display_name AS student_name
        FROM summaries
        LEFT JOIN users ON users.id = summaries.student_id
        ORDER BY summaries.updated_at DESC
        LIMIT 5
      `
    )
    .all()
    .map(serializeSummary);

  return {
    user: sanitizeUser(user),
    students: getStudents(),
    tasks,
    summaries
  };
}

function getTeacherModuleData(modules) {
  const result = {};
  for (const mod of modules) {
    if (mod === 'courses') {
      result.courses = db
        .prepare('SELECT courses.*, users.display_name AS teacher_name FROM courses LEFT JOIN users ON users.id = courses.created_by ORDER BY courses.created_at DESC LIMIT 100')
        .all().map(serializeCourse);
    } else if (mod === 'liveSessions') {
      result.liveSessions = db
        .prepare('SELECT live_sessions.*, users.display_name AS teacher_name FROM live_sessions LEFT JOIN users ON users.id = live_sessions.created_by ORDER BY live_sessions.created_at DESC LIMIT 50')
        .all().map(serializeLiveSession);
    } else if (mod === 'forumTopics') {
      const forumTopics = db
        .prepare('SELECT forum_topics.*, users.display_name AS author_name, users.role AS author_role FROM forum_topics LEFT JOIN users ON users.id = forum_topics.user_id ORDER BY forum_topics.created_at DESC LIMIT 50')
        .all();
      const replies = batchLoadForumReplies(forumTopics.map((t) => t.id));
      result.forumTopics = forumTopics.map((t) => serializeForumTopic(t, replies));
    } else if (mod === 'questions') {
      result.questions = db.prepare('SELECT * FROM questions ORDER BY created_at DESC LIMIT 200').all().map(serializeQuestionForTeacher);
    } else if (mod === 'products') {
      result.products = db.prepare('SELECT * FROM products ORDER BY created_at DESC LIMIT 100').all().map(serializeProduct);
    } else if (mod === 'orders') {
      result.orders = db
        .prepare('SELECT orders.*, products.title AS product_title, users.display_name AS student_name FROM orders LEFT JOIN products ON products.id = orders.product_id LEFT JOIN users ON users.id = orders.student_id ORDER BY orders.created_at DESC LIMIT 200')
        .all().map(serializeOrder);
    } else if (mod === 'summaries') {
      result.summaries = db
        .prepare('SELECT summaries.*, users.display_name AS student_name FROM summaries LEFT JOIN users ON users.id = summaries.student_id ORDER BY summaries.updated_at DESC LIMIT 200')
        .all().map(serializeSummary);
    }
  }
  return result;
}

function getStudentBootstrapData(user) {
  return getStudentCoreBootstrapData(user);
}

function getStudentCoreBootstrapData(user) {
  const today = dayjs().format('YYYY-MM-DD');
  const todaysTasks = getTasksForStudentOnDate(db, user.id, today).map(serializeTask);

  // 附加子任务及完成状态
  todaysTasks.forEach((task) => {
    const subtasks = db.prepare('SELECT id, title, sort_order FROM subtasks WHERE task_id = ? ORDER BY sort_order').all(task.id);
    task.subtasks = subtasks.map((st) => {
      const comp = db.prepare('SELECT completed_at FROM subtask_completions WHERE subtask_id = ? AND student_id = ? AND task_date = ?').get(st.id, user.id, today);
      return { id: st.id, title: st.title, completed: !!(comp && comp.completed_at) };
    });
    // 附加学生自选提醒时间
    const reminder = db.prepare('SELECT reminder_time FROM student_reminders WHERE task_id = ? AND student_id = ?').get(task.id, user.id);
    task.myReminderTime = reminder ? reminder.reminder_time : '';
  });

  const notifications = db
    .prepare('SELECT * FROM notifications WHERE student_id = ? ORDER BY created_at DESC LIMIT 10')
    .all(user.id)
    .map(serializeNotification);
  const summaries = db
    .prepare(
      `SELECT summaries.*, users.display_name AS student_name
       FROM summaries LEFT JOIN users ON users.id = summaries.student_id
       WHERE summaries.student_id = ?
       ORDER BY summaries.updated_at DESC LIMIT 3`
    )
    .all(user.id)
    .map(serializeSummary);
  const liveSessions = db
    .prepare(
      `SELECT live_sessions.*, users.display_name AS teacher_name
       FROM live_sessions LEFT JOIN users ON users.id = live_sessions.created_by
       WHERE live_sessions.status != 'ended'
       ORDER BY live_sessions.created_at DESC LIMIT 10`
    )
    .all()
    .map(serializeLiveSession);

  return {
    user: sanitizeUser(user),
    today,
    todaysTasks,
    notifications,
    summaries,
    liveSessions
  };
}

function getStudentModuleData(user, modules) {
  const result = {};
  for (const mod of modules) {
    if (mod === 'courses') {
      result.courses = db
        .prepare('SELECT courses.*, users.display_name AS teacher_name FROM courses LEFT JOIN users ON users.id = courses.created_by ORDER BY courses.created_at DESC LIMIT 100')
        .all().map(serializeCourse);
    } else if (mod === 'forumTopics') {
      const forumTopics = db
        .prepare('SELECT forum_topics.*, users.display_name AS author_name, users.role AS author_role FROM forum_topics LEFT JOIN users ON users.id = forum_topics.user_id ORDER BY forum_topics.created_at DESC LIMIT 50')
        .all();
      const replies = batchLoadForumReplies(forumTopics.map((t) => t.id));
      result.forumTopics = forumTopics.map((t) => serializeForumTopic(t, replies));
    } else if (mod === 'questions') {
      const allQuestions = db.prepare('SELECT * FROM questions ORDER BY created_at DESC LIMIT 200').all();
      const latestRecords = db.prepare(
        `SELECT pr.* FROM practice_records pr
         INNER JOIN (
           SELECT question_id, MAX(created_at) AS max_created
           FROM practice_records WHERE student_id = ?
           GROUP BY question_id
         ) sub ON pr.question_id = sub.question_id AND pr.created_at = sub.max_created
         WHERE pr.student_id = ?`
      ).all(user.id, user.id);
      const recordMap = new Map(latestRecords.map((r) => [r.question_id, r]));
      result.questions = allQuestions.map((row) => serializeQuestionForStudent(row, recordMap.get(row.id) || null));
    } else if (mod === 'products') {
      result.products = db.prepare('SELECT * FROM products ORDER BY created_at DESC LIMIT 100').all().map(serializeProduct);
    } else if (mod === 'orders') {
      result.orders = db
        .prepare('SELECT orders.*, products.title AS product_title, users.display_name AS student_name FROM orders LEFT JOIN products ON products.id = orders.product_id LEFT JOIN users ON users.id = orders.student_id WHERE orders.student_id = ? ORDER BY orders.created_at DESC LIMIT 100')
        .all(user.id).map(serializeOrder);
    } else if (mod === 'notifications') {
      result.notifications = db
        .prepare('SELECT * FROM notifications WHERE student_id = ? ORDER BY created_at DESC LIMIT 50')
        .all(user.id).map(serializeNotification);
    } else if (mod === 'summaries') {
      result.summaries = db
        .prepare('SELECT summaries.*, users.display_name AS student_name FROM summaries LEFT JOIN users ON users.id = summaries.student_id WHERE summaries.student_id = ? ORDER BY summaries.updated_at DESC LIMIT 100')
        .all(user.id).map(serializeSummary);
    } else if (mod === 'liveSessions') {
      result.liveSessions = db
        .prepare('SELECT live_sessions.*, users.display_name AS teacher_name FROM live_sessions LEFT JOIN users ON users.id = live_sessions.created_by ORDER BY live_sessions.created_at DESC LIMIT 50')
        .all().map(serializeLiveSession);
    }
  }
  return result;
}

// ── WebSocket/Live Room 管理 ──

const clientsByUserId = new Map();
const liveRooms = new Map();

function addClient(userId, client) {
  const clients = clientsByUserId.get(userId) || new Set();
  clients.add(client);
  clientsByUserId.set(userId, clients);
}

function removeClient(userId, client) {
  const clients = clientsByUserId.get(userId);
  if (!clients) {
    return;
  }

  clients.delete(client);
  if (!clients.size) {
    clientsByUserId.delete(userId);
  }
}

function sendToUser(userId, payload) {
  const clients = clientsByUserId.get(Number(userId));
  if (!clients) {
    return;
  }

  const message = JSON.stringify(payload);
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

function sendNotificationToStudent(studentId, payload) {
  sendToUser(studentId, payload);
}

function joinLiveRoom(liveId, userId) {
  const room = liveRooms.get(liveId) || new Set();
  room.add(userId);
  liveRooms.set(liveId, room);
}

function leaveLiveRoom(liveId, userId) {
  const room = liveRooms.get(liveId);
  if (!room) {
    return;
  }

  room.delete(userId);
  if (!room.size) {
    liveRooms.delete(liveId);
  }
}

function broadcastToLiveRoom(liveId, payload, options = {}) {
  const room = liveRooms.get(Number(liveId));
  if (!room) {
    return;
  }

  room.forEach((userId) => {
    if (options.excludeUserId && Number(options.excludeUserId) === Number(userId)) {
      return;
    }

    sendToUser(userId, payload);
  });
}

// 直播 WebSocket 广播辅助
function broadcastToLive(liveId, message) {
  wss.clients.forEach((client) => {
    if (client._liveId === liveId && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

// ── 任务导入辅助函数 ──

function parseWeekdaysInput(rawValue) {
  if (Array.isArray(rawValue)) {
    return normalizeWeekdays(rawValue);
  }

  if (!rawValue) {
    return [0, 1, 2, 3, 4, 5, 6];
  }

  const text = String(rawValue).trim();
  if (!text) {
    return [0, 1, 2, 3, 4, 5, 6];
  }

  const mapping = {
    周日: 0,
    星期日: 0,
    周天: 0,
    星期天: 0,
    周一: 1,
    星期一: 1,
    周二: 2,
    星期二: 2,
    周三: 3,
    星期三: 3,
    周四: 4,
    星期四: 4,
    周五: 5,
    星期五: 5,
    周六: 6,
    星期六: 6
  };

  const converted = text.split(/[，,\s|/]+/).map((segment) => {
    const trimmed = segment.trim();
    if (mapping[trimmed] !== undefined) {
      return mapping[trimmed];
    }

    return Number(trimmed);
  });

  return normalizeWeekdays(converted);
}

function resolveStudentIds(rawValue) {
  const candidates = normalizeStudentIds(rawValue);
  if (candidates.length) {
    return candidates;
  }

  if (!rawValue) {
    return [];
  }

  const tokens = String(rawValue)
    .split(/[，,\s|/]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const students = getStudents();

  return students
    .filter((student) => tokens.includes(student.username) || tokens.includes(student.displayName))
    .map((student) => student.id);
}

function readWorkbookRows(filePath) {
  // BUG-036: 改进编码检测 — 先读原始字节判断是否为 GBK，再选择解码方式
  const rawBuffer = fs.readFileSync(filePath);

  // 快速检测：如果含 BOM (EF BB BF)，一定是 UTF-8
  const hasBOM = rawBuffer.length >= 3 && rawBuffer[0] === 0xEF && rawBuffer[1] === 0xBB && rawBuffer[2] === 0xBF;

  let rows;
  if (hasBOM) {
    const workbook = XLSX.readFile(filePath, { codepage: 65001 });
    const sheetName = workbook.SheetNames[0];
    rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
  } else {
    // 尝试 UTF-8 解码，检查是否有无效 UTF-8 序列
    let isLikelyGBK = false;
    // BUG-012: 扩大扫描范围到 32KB
    for (let i = 0; i < Math.min(rawBuffer.length, 32768); i++) {
      const byte = rawBuffer[i];
      if (byte >= 0x80) {
        // 检查是否为合法 UTF-8 序列
        if ((byte & 0xE0) === 0xC0) {
          // 2 字节序列
          if (i + 1 >= rawBuffer.length || (rawBuffer[i + 1] & 0xC0) !== 0x80) { isLikelyGBK = true; break; }
          i += 1;
        } else if ((byte & 0xF0) === 0xE0) {
          // 3 字节序列
          if (i + 2 >= rawBuffer.length || (rawBuffer[i + 1] & 0xC0) !== 0x80 || (rawBuffer[i + 2] & 0xC0) !== 0x80) { isLikelyGBK = true; break; }
          i += 2;
        } else if ((byte & 0xF8) === 0xF0) {
          // 4 字节序列 — BUG-004: 补充 i+1 检查
          if (i + 3 >= rawBuffer.length || (rawBuffer[i + 1] & 0xC0) !== 0x80 || (rawBuffer[i + 2] & 0xC0) !== 0x80 || (rawBuffer[i + 3] & 0xC0) !== 0x80) { isLikelyGBK = true; break; }
          i += 3;
        } else if ((byte & 0xC0) === 0x80) {
          // 孤立的 continuation byte，说明不是合法 UTF-8
          isLikelyGBK = true; break;
        }
      }
    }

    if (isLikelyGBK) {
      try {
        const utf8Content = iconv.decode(rawBuffer, 'gbk');
        const workbook = XLSX.read(utf8Content, { type: 'string' });
        const sheetName = workbook.SheetNames[0];
        rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
      } catch (_) {
        const workbook = XLSX.readFile(filePath, { codepage: 65001 });
        const sheetName = workbook.SheetNames[0];
        rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
      }
    } else {
      const workbook = XLSX.readFile(filePath, { codepage: 65001 });
      const sheetName = workbook.SheetNames[0];
      rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
    }
  }

  return rows;
}

function getFieldValue(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && String(row[key]).trim()) {
      return String(row[key]).trim();
    }
  }

  return '';
}

function createTaskRecord({ title, description, subject, startTime, endTime, weekdays, studentIds, teacherId, priority, reminderStart, reminderEnd }) {
  const now = dayjs().toISOString();
  const result = db
    .prepare(
      `
        INSERT INTO tasks (
          title, description, subject, start_time, end_time, weekdays, student_ids, created_by, created_at, priority, reminder_start, reminder_end
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(title, description, subject || '考研规划', startTime, endTime, serializeWeekdays(weekdays), serializeStudentIds(studentIds), teacherId, now, priority || 2, reminderStart || '', reminderEnd || '');

  return result.lastInsertRowid;
}

// ── Token/Auth 中间件 ──

function generateAuthToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createAuthToken(userId) {
  const now = dayjs();
  const token = generateAuthToken();
  db.prepare('INSERT INTO auth_tokens (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    token,
    userId,
    now.toISOString(),
    now.add(config.tokenTtlDays, 'day').toISOString()
  );
  return token;
}

function getBearerToken(request) {
  const authorizationHeader = request.headers.authorization || '';
  if (authorizationHeader.startsWith('Bearer ')) {
    return authorizationHeader.slice(7).trim();
  }

  return request.headers['x-auth-token'] || null;
}

function getUserByToken(token) {
  if (!token) {
    return null;
  }

  const tokenRow = db
    .prepare(
      `
        SELECT auth_tokens.token, auth_tokens.expires_at, users.*
        FROM auth_tokens
        LEFT JOIN users ON users.id = auth_tokens.user_id
        WHERE auth_tokens.token = ?
      `
    )
    .get(token);

  if (!tokenRow) {
    return null;
  }

  if (dayjs(tokenRow.expires_at).isBefore(dayjs())) {
    db.prepare('DELETE FROM auth_tokens WHERE token = ?').run(token);
    return null;
  }

  return tokenRow;
}

function clearAuthToken(token) {
  if (!token) {
    return;
  }

  db.prepare('DELETE FROM auth_tokens WHERE token = ?').run(token);
}

function getOrCreateAuthToken(userId) {
  // 复用该用户已有的未过期 Token，避免每次刷新都增发新 Token
  const existingToken = db
    .prepare(
      `SELECT token FROM auth_tokens WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1`
    )
    .get(userId, dayjs().toISOString());

  if (existingToken) {
    return existingToken.token;
  }

  return createAuthToken(userId);
}

function requireAuth(request, response, next) {
  const sessionUser = request.session.userId ? getUserById(request.session.userId) : null;
  const authToken = getBearerToken(request);
  const tokenUser = authToken ? getUserByToken(authToken) : null;
  const user = sessionUser || tokenUser;

  if (!user) {
    if (request.session.userId) {
      request.session.destroy(() => {});
    }
    response.status(401).json({ error: '未登录或登录状态已失效。' });
    return;
  }

  request.currentUser = user;
  request.authToken = authToken || null;
  next();
}

function requireTeacher(request, response, next) {
  requireAuth(request, response, () => {
    if (request.currentUser.role !== 'teacher') {
      response.status(403).json({ error: '当前账号没有老师权限。' });
      return;
    }

    next();
  });
}

function requireStudent(request, response, next) {
  requireAuth(request, response, () => {
    if (request.currentUser.role !== 'student') {
      response.status(403).json({ error: '当前账号没有学生权限。' });
      return;
    }

    next();
  });
}

function requireAdmin(request, response, next) {
  requireAuth(request, response, () => {
    if (request.currentUser.role !== 'admin') {
      response.status(403).json({ error: '当前账号没有管理员权限。' });
      return;
    }

    next();
  });
}

// ── fetchJson 辅助函数 ──

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        if (res.statusCode < 200 || res.statusCode >= 300) {
          try {
            reject(new Error(JSON.parse(body).errmsg || `HTTP ${res.statusCode}`));
          } catch (_) {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
      res.on('error', reject);
    });
    req.setTimeout(10000, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

// ── 成就系统辅助 ──

function checkAndUnlockAchievements(userId) {
  const achievements = db.prepare('SELECT * FROM achievements').all();
  const unlocked = new Set(db.prepare('SELECT achievement_id FROM user_achievements WHERE user_id = ?').all(userId).map((r) => r.achievement_id));

  for (const ach of achievements) {
    if (unlocked.has(ach.id)) continue;
    let met = false;

    switch (ach.condition_type) {
      case 'streak': {
        const row = db.prepare('SELECT current_streak FROM study_streaks WHERE student_id = ?').get(userId);
        met = row && row.current_streak >= ach.condition_value;
        break;
      }
      case 'total_questions': {
        const count = db.prepare('SELECT COUNT(*) AS cnt FROM practice_records WHERE student_id = ?').get(userId).cnt;
        met = count >= ach.condition_value;
        break;
      }
      case 'accuracy_90': {
        const row = db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct FROM practice_records WHERE student_id = ?').get(userId);
        met = row.total >= ach.condition_value && (row.correct / row.total) >= 0.9;
        break;
      }
      case 'forum_posts': {
        const count = db.prepare('SELECT COUNT(*) AS cnt FROM forum_topics WHERE user_id = ?').get(userId).cnt;
        met = count >= ach.condition_value;
        break;
      }
      case 'flashcard_reviews': {
        const count = db.prepare('SELECT COUNT(*) AS cnt FROM flashcard_records WHERE student_id = ? AND repetitions > 0').get(userId).cnt;
        met = count >= ach.condition_value;
        break;
      }
      case 'summaries': {
        const count = db.prepare('SELECT COUNT(*) AS cnt FROM summaries WHERE student_id = ?').get(userId).cnt;
        met = count >= ach.condition_value;
        break;
      }
      case 'focus_minutes':
      case 'early_bird':
        // 这些由前端触发，不在自动检查中
        break;
    }

    if (met) {
      db.prepare('INSERT OR IGNORE INTO user_achievements (user_id, achievement_id, unlocked_at) VALUES (?, ?, ?)').run(userId, ach.id, dayjs().toISOString());
    }
  }
}

// ── @提及通知 ──

function sendMentionNotifications(text, senderId, contextTitle) {
  const mentionRegex = /@([^\s@]{1,20})/g;
  const mentioned = new Set();
  let m;
  while ((m = mentionRegex.exec(text)) !== null) {
    mentioned.add(m[1]);
  }
  if (!mentioned.size) return;
  const now = dayjs().toISOString();
  const insertNotif = db.prepare(
    'INSERT OR IGNORE INTO notifications (student_id, type, title, body, schedule_key, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const name of mentioned) {
    const user = db.prepare("SELECT id FROM users WHERE display_name = ? AND id != ?").get(name, senderId);
    if (user) {
      insertNotif.run(user.id, 'mention', '有人在帖子中提及了你', `在"${contextTitle.slice(0, 50)}"中被提及`, 'mention_' + user.id + '_' + Date.now(), now);
    }
  }
}

// ── 学习连续天数辅助函数 ──

function updateStudyStreak(studentId) {
  const today = dayjs().format('YYYY-MM-DD');
  const streak = db.prepare('SELECT * FROM study_streaks WHERE student_id = ?').get(studentId);

  if (!streak) {
    db.prepare('INSERT INTO study_streaks (student_id, current_streak, longest_streak, last_study_date, updated_at) VALUES (?, 1, 1, ?, ?)')
      .run(studentId, today, dayjs().toISOString());
    return;
  }

  if (streak.last_study_date === today) return;

  const yesterday = dayjs(today).subtract(1, 'day').format('YYYY-MM-DD');
  if (streak.last_study_date === yesterday) {
    const newStreak = streak.current_streak + 1;
    db.prepare('UPDATE study_streaks SET current_streak = ?, longest_streak = MAX(longest_streak, ?), last_study_date = ?, updated_at = ? WHERE student_id = ?')
      .run(newStreak, newStreak, today, dayjs().toISOString(), studentId);
  } else {
    db.prepare('UPDATE study_streaks SET current_streak = 1, last_study_date = ?, updated_at = ? WHERE student_id = ?')
      .run(today, dayjs().toISOString(), studentId);
  }
}

// ── AI 调用辅助函数（支持配置外部大模型 API） ──

async function callAI(systemPrompt, userPrompt) {
  const aiApiKey = process.env.AI_API_KEY || config.aiApiKey || '';
  const aiApiUrl = process.env.AI_API_URL || config.aiApiUrl || '';
  const aiModel = process.env.AI_MODEL || config.aiModel || 'gpt-3.5-turbo';

  if (!aiApiKey || !aiApiUrl) {
    // 无 API 配置时返回模拟回复
    return 'AI 功能正在配置中。请联系管理员配置 AI_API_KEY 和 AI_API_URL 环境变量以启用 AI 功能。';
  }

  const res = await fetch(aiApiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + aiApiKey },
    body: JSON.stringify({
      model: aiModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 2000
    })
  });

  if (!res.ok) {
    throw new Error('AI API 返回错误：' + res.status);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || 'AI 未返回有效内容。';
}

// ── WebSocket 连接处理 ──

wss.on('connection', (socket, request) => {
  let requestUrl;
  try {
    requestUrl = new URL(request.url, 'http://localhost');
  } catch (err) {
    socket.close();
    return;
  }
  const token = requestUrl.searchParams.get('token');
  const user = getUserByToken(token);

  if (!user) {
    socket.close(4001, 'Authentication required');
    return;
  }

  socket.userId = user.id;
  socket.role = user.role;
  socket.liveId = null;
  socket.isAlive = true;
  addClient(user.id, socket);

  // 心跳：收到 pong 标记为存活
  socket.on('pong', () => {
    socket.isAlive = true;
  });

  socket.on('message', (message) => {
    let payload;
    try {
      payload = JSON.parse(message.toString());
    } catch (error) {
      return;
    }

    if (payload.type === 'join-live') {
      const liveId = Number(payload.liveId);
      // BUG-018: 验证直播会话存在
      const sessionExists = db.prepare('SELECT id FROM live_sessions WHERE id = ?').get(liveId);
      if (!sessionExists) {
        socket.send(JSON.stringify({ type: 'error', message: '直播不存在。' }));
        return;
      }
      socket.liveId = liveId;
      joinLiveRoom(liveId, socket.userId);
      const members = [...(liveRooms.get(liveId) || new Set())].filter((memberId) => memberId !== socket.userId);
      socket.send(JSON.stringify({ type: 'room-users', liveId, users: members }));
      broadcastToLiveRoom(liveId, { type: 'live-presence', liveId, userId: socket.userId, role: socket.role }, { excludeUserId: socket.userId });
      return;
    }

    if (payload.type === 'leave-live' && socket.liveId) {
      leaveLiveRoom(socket.liveId, socket.userId);
      broadcastToLiveRoom(socket.liveId, { type: 'live-leave', liveId: socket.liveId, userId: socket.userId }, { excludeUserId: socket.userId });
      socket.liveId = null;
      return;
    }

    if (payload.type === 'signal' && payload.targetUserId) {
      if (!socket.liveId) return;
      if (payload.liveId !== socket.liveId) return;
      const room = liveRooms.get(Number(socket.liveId));
      if (!room || !room.has(Number(payload.targetUserId))) return;
      sendToUser(payload.targetUserId, {
        type: 'signal',
        liveId: payload.liveId,
        fromUserId: socket.userId,
        signal: payload.signal
      });
      return;
    }

    // BUG-087: 聊天速率限制 — 每用户每秒最多 3 条
    if (!socket._chatTimestamps) socket._chatTimestamps = [];
    const now = Date.now();
    socket._chatTimestamps = socket._chatTimestamps.filter((t) => now - t < 1000);
    if (socket._chatTimestamps.length >= 3) return;

    if (payload.type === 'live-chat' && payload.liveId && payload.content) {
      socket._chatTimestamps.push(now);
      // BUG-302: 聊天消息长度限制
      const rawContent = String(payload.content).slice(0, 500);
      const content = escapeHtml(sanitizeText(rawContent));
      if (!content) {
        return;
      }

      const createdAt = dayjs().toISOString();
      const result = db
        .prepare(
          `
            INSERT INTO live_messages (live_session_id, user_id, content, created_at)
            VALUES (?, ?, ?, ?)
          `
        )
        .run(payload.liveId, socket.userId, content, createdAt);

      broadcastToLiveRoom(payload.liveId, {
        type: 'live-chat',
        payload: {
          id: result.lastInsertRowid,
          liveSessionId: Number(payload.liveId),
          userId: socket.userId,
          content,
          authorName: user.display_name,
          authorRole: user.role,
          createdAt
        }
      });
    }
  });

  socket.on('close', () => {
    if (socket.liveId) {
      leaveLiveRoom(socket.liveId, socket.userId);
      broadcastToLiveRoom(socket.liveId, { type: 'live-leave', liveId: socket.liveId, userId: socket.userId }, { excludeUserId: socket.userId });
    }

    removeClient(socket.userId, socket);
  });
});

// WebSocket 心跳：每 30 秒 ping 所有连接，清理无响应的僵尸连接
setInterval(() => {
  wss.clients.forEach((socket) => {
    if (!socket.isAlive) {
      if (socket.liveId) {
        leaveLiveRoom(socket.liveId, socket.userId);
        broadcastToLiveRoom(socket.liveId, { type: 'live-leave', liveId: socket.liveId, userId: socket.userId }, { excludeUserId: socket.userId });
      }
      removeClient(socket.userId, socket);
      socket.terminate();
      return;
    }
    socket.isAlive = false;
    socket.ping();
  });
}, 30000);

startScheduler(db, sendNotificationToStudent);

// ── 挂载路由 ──

const shared = {
  db,
  config,
  publicDir,
  uploadRootDir,
  sanitizeUser,
  getStudents,
  serializeTask,
  serializeSummary,
  serializeCourse,
  serializeLiveSession,
  serializeForumTopic,
  serializeQuestionForTeacher,
  serializeQuestionForStudent,
  serializeProduct,
  serializeOrder,
  serializeNotification,
  getAllTasks,
  getTasksForStudentOnDate,
  batchLoadForumReplies,
  batchLoadForumLikes,
  safeJsonParse,
  requireAuth,
  requireTeacher,
  requireStudent,
  requireAdmin,
  getTeacherCoreBootstrapData,
  getTeacherModuleData,
  getStudentCoreBootstrapData,
  getStudentModuleData,
  getUserById,
  getBearerToken,
  getUserByToken,
  getOrCreateAuthToken,
  createAuthToken,
  clearAuthToken,
  checkLoginRateLimit,
  checkRegisterRateLimit,
  fetchJson,
  toPublicPath,
  summaryUpload,
  courseUpload,
  questionUpload,
  productUpload,
  taskImportUpload,
  cloudUpload,
  forumUpload,
  parseWeekdaysInput,
  resolveStudentIds,
  createTaskRecord,
  readWorkbookRows,
  getFieldValue,
  sendNotificationToStudent,
  sendToUser,
  broadcastToLiveRoom,
  broadcastToLive,
  updateStudyStreak,
  checkAndUnlockAchievements,
  sendMentionNotifications,
  callAI,
  dispatchDailyDigest,
  dispatchDueTaskReminders,
  sanitizeText,
  escapeHtml,
  stripHtml,
  liveRooms
};

require('./routes/auth')(app, shared);
require('./routes/admin')(app, shared);
require('./routes/students')(app, shared);
require('./routes/teachers')(app, shared);
require('./routes/courses')(app, shared);
require('./routes/questions')(app, shared);
require('./routes/forum')(app, shared);
require('./routes/store')(app, shared);
require('./routes/live')(app, shared);
require('./routes/search')(app, shared);
require('./routes/misc')(app, shared);

// ── 启动服务器 ──

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${config.port} 已被占用，请先关闭占用该端口的进程，或修改 PORT 环境变量。`);
    process.exit(1);
  }
  throw error;
});

wss.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${config.port} 已被占用，请先关闭占用该端口的进程，或修改 PORT 环境变量。`);
  }
});

server.listen(config.port, () => {
  console.log(`Study planner running at http://localhost:${config.port}`);
});

// BUG-051: 定期清理过期 auth_tokens
setInterval(() => {
  try {
    db.prepare('DELETE FROM auth_tokens WHERE expires_at < ?').run(dayjs().toISOString());
  } catch (_) {}
}, 3600000);

// BUG-075: 优雅关闭
function gracefulShutdown(signal) {
  console.log(`收到 ${signal}，正在关闭服务...`);
  wss.clients.forEach((client) => client.close());
  server.close(() => {
    console.log('服务已关闭。');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// BUG-090: 每日数据库备份（凌晨 3 点）
const backupDir = path.join(path.dirname(config.dbPath), 'backups');
fs.mkdirSync(backupDir, { recursive: true });
setInterval(() => {
  const now = dayjs();
  if (now.format('HH:mm') !== '03:00') return;
  try {
    const backupPath = path.join(backupDir, `backup-${now.format('YYYY-MM-DD')}.sqlite`);
    db.prepare('VACUUM INTO ?').run(backupPath);
    // 保留最近 7 天备份
    const files = fs.readdirSync(backupDir).filter((f) => f.startsWith('backup-')).sort();
    while (files.length > 7) {
      fs.unlinkSync(path.join(backupDir, files.shift()));
    }
    console.log(`数据库备份完成: ${backupPath}`);
  } catch (err) {
    console.error('数据库备份失败:', err.message);
  }
}, 60000);
