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

function getTeacherBootstrapData(user) {
  const tasks = getAllTasks(db).map(serializeTask);
  // BUG-034: 添加 LIMIT 防止数据量过大导致 OOM
  const summaries = db
    .prepare(
      `
        SELECT summaries.*, users.display_name AS student_name
        FROM summaries
        LEFT JOIN users ON users.id = summaries.student_id
        ORDER BY summaries.updated_at DESC
        LIMIT 200
      `
    )
    .all()
    .map(serializeSummary);
  const courses = db
    .prepare(
      `
        SELECT courses.*, users.display_name AS teacher_name
        FROM courses
        LEFT JOIN users ON users.id = courses.created_by
        ORDER BY courses.created_at DESC
        LIMIT 100
      `
    )
    .all()
    .map(serializeCourse);
  const liveSessions = db
    .prepare(
      `
        SELECT live_sessions.*, users.display_name AS teacher_name
        FROM live_sessions
        LEFT JOIN users ON users.id = live_sessions.created_by
        ORDER BY live_sessions.created_at DESC
        LIMIT 50
      `
    )
    .all()
    .map(serializeLiveSession);
  const forumTopics = db
    .prepare(
      `
        SELECT forum_topics.*, users.display_name AS author_name, users.role AS author_role
        FROM forum_topics
        LEFT JOIN users ON users.id = forum_topics.user_id
        ORDER BY forum_topics.created_at DESC
        LIMIT 50
      `
    )
    .all();
  const teacherTopicReplies = batchLoadForumReplies(forumTopics.map((t) => t.id));
  const serializedForumTopics = forumTopics.map((t) => serializeForumTopic(t, teacherTopicReplies));
  const questions = db.prepare('SELECT * FROM questions ORDER BY created_at DESC LIMIT 200').all().map(serializeQuestionForTeacher);
  const products = db.prepare('SELECT * FROM products ORDER BY created_at DESC LIMIT 100').all().map(serializeProduct);
  const orders = db
    .prepare(
      `
        SELECT orders.*, products.title AS product_title, users.display_name AS student_name
        FROM orders
        LEFT JOIN products ON products.id = orders.product_id
        LEFT JOIN users ON users.id = orders.student_id
        ORDER BY orders.created_at DESC
        LIMIT 200
      `
    )
    .all()
    .map(serializeOrder);

  return {
    user: sanitizeUser(user),
    students: getStudents(),
    tasks,
    summaries,
    courses,
    liveSessions,
    forumTopics: serializedForumTopics,
    questions,
    products,
    orders
  };
}

function getStudentBootstrapData(user) {
  const today = dayjs().format('YYYY-MM-DD');
  const todaysTasks = getTasksForStudentOnDate(db, user.id, today).map(serializeTask);
  const notifications = db
    .prepare('SELECT * FROM notifications WHERE student_id = ? ORDER BY created_at DESC LIMIT 50')
    .all(user.id)
    .map(serializeNotification);
  const summaries = db
    .prepare(
      `
        SELECT summaries.*, users.display_name AS student_name
        FROM summaries
        LEFT JOIN users ON users.id = summaries.student_id
        WHERE summaries.student_id = ?
        ORDER BY summaries.updated_at DESC
        LIMIT 100
      `
    )
    .all(user.id)
    .map(serializeSummary);
  const courses = db
    .prepare(
      `
        SELECT courses.*, users.display_name AS teacher_name
        FROM courses
        LEFT JOIN users ON users.id = courses.created_by
        ORDER BY courses.created_at DESC
        LIMIT 100
      `
    )
    .all()
    .map(serializeCourse);
  const liveSessions = db
    .prepare(
      `
        SELECT live_sessions.*, users.display_name AS teacher_name
        FROM live_sessions
        LEFT JOIN users ON users.id = live_sessions.created_by
        ORDER BY live_sessions.created_at DESC
        LIMIT 50
      `
    )
    .all()
    .map(serializeLiveSession);
  const forumTopics = db
    .prepare(
      `
        SELECT forum_topics.*, users.display_name AS author_name, users.role AS author_role
        FROM forum_topics
        LEFT JOIN users ON users.id = forum_topics.user_id
        ORDER BY forum_topics.created_at DESC
        LIMIT 50
      `
    )
    .all();
  const studentTopicReplies = batchLoadForumReplies(forumTopics.map((t) => t.id));
  const serializedForumTopics = forumTopics.map((t) => serializeForumTopic(t, studentTopicReplies));
  // BUG-033: 批量查询学生最近答题记录，避免 N+1
  const allQuestions = db.prepare('SELECT * FROM questions ORDER BY created_at DESC LIMIT 500').all();
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
  const questions = allQuestions.map((row) => serializeQuestionForStudent(row, recordMap.get(row.id) || null));
  // BUG-034: 商品列表添加 LIMIT
  const products = db.prepare('SELECT * FROM products ORDER BY created_at DESC LIMIT 100').all().map(serializeProduct);
  const orders = db
    .prepare(
      `
        SELECT orders.*, products.title AS product_title, users.display_name AS student_name
        FROM orders
        LEFT JOIN products ON products.id = orders.product_id
        LEFT JOIN users ON users.id = orders.student_id
        WHERE orders.student_id = ?
        ORDER BY orders.created_at DESC
        LIMIT 100
      `
    )
    .all(user.id)
    .map(serializeOrder);

  return {
    user: sanitizeUser(user),
    today,
    todaysTasks,
    notifications,
    summaries,
    courses,
    liveSessions,
    forumTopics: serializedForumTopics,
    questions,
    products,
    orders
  };
}

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

function createTaskRecord({ title, description, subject, startTime, endTime, weekdays, studentIds, teacherId, priority }) {
  const now = dayjs().toISOString();
  const result = db
    .prepare(
      `
        INSERT INTO tasks (
          title, description, subject, start_time, end_time, weekdays, student_ids, created_by, created_at, priority
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(title, description, subject || '考研规划', startTime, endTime, serializeWeekdays(weekdays), serializeStudentIds(studentIds), teacherId, now, priority || 2);

  return result.lastInsertRowid;
}

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

app.get('/healthz', (request, response) => {
  response.json({
    ok: true,
    env: config.nodeEnv,
    time: dayjs().toISOString()
  });
});

// WebRTC ICE 服务器配置（STUN + 可选 TURN）
app.get('/api/ice-servers', requireAuth, (request, response) => {
  response.json({ iceServers: config.iceServers });
});

app.get('/ZtVqVx2EAC.txt', (request, response) => {
  response.type('text/plain').send('b464730fde7fc1293f16e10c64f425a7');
});

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

app.post('/api/auth/wx-login', async (request, response) => {
  const { code } = request.body;
  if (!code) {
    response.status(400).json({ error: '缺少登录凭证。' });
    return;
  }

  try {
    const wxUrl = `https://api.weixin.qq.com/sns/jscode2session?appid=${config.wxAppId}&secret=${config.wxAppSecret}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
    const wxData = await fetchJson(wxUrl);

    if (!wxData.openid) {
      // BUG-081: 不泄露微信 API 内部错误信息
      console.error('微信登录失败:', wxData.errmsg || '未获取到用户标识');
      response.status(400).json({ error: '微信登录失败，请重试。' });
      return;
    }

    let user = db.prepare('SELECT * FROM users WHERE openid = ?').get(wxData.openid);

    if (!user) {
      const now = dayjs().toISOString();
      // BUG-078: 生成唯一用户名，避免 openid 后 8 位冲突
      let username = `wx_${wxData.openid.slice(-8)}`;
      let suffix = 0;
      while (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
        suffix += 1;
        username = `wx_${wxData.openid.slice(-8)}_${suffix}`;
      }
      const result = db.prepare(
        'INSERT INTO users (username, password, role, display_name, class_name, openid, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(
        username,
        bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10),
        'student',
        '微信用户',
        '',
        wxData.openid,
        now
      );
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
    }

    request.session.userId = user.id;
    const token = createAuthToken(user.id);
    response.json({
      user: sanitizeUser(user),
      token,
      expiresInDays: config.tokenTtlDays
    });
  } catch (error) {
    response.status(500).json({ error: '微信登录失败，请重试。' });
  }
});

// BUG-058: 登录接口添加速率限制
app.post('/api/auth/login', checkLoginRateLimit, (request, response, next) => {
  const { username, password } = request.body;

  if (!username || !password) {
    response.status(400).json({ error: '请输入账号和密码。' });
    return;
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).trim());

  if (!user) {
    response.status(401).json({ error: '账号或密码错误。' });
    return;
  }

  const passwordMatch = bcrypt.compareSync(String(password).trim(), user.password);
  if (!passwordMatch) {
    response.status(401).json({ error: '账号或密码错误。' });
    return;
  }

  // BUG-304: 登录后重新生成 session，防止 Session Fixation
  request.session.regenerate(() => {
    request.session.userId = user.id;
    // BUG-008: 复用已有未过期 Token，避免 token 表膨胀
    const token = getOrCreateAuthToken(user.id);
    response.json({
      user: sanitizeUser(user),
      token,
      expiresInDays: config.tokenTtlDays
    });
  });
});

app.get('/api/auth/me', (request, response, next) => {
  const sessionUser = request.session.userId ? getUserById(request.session.userId) : null;
  const authToken = getBearerToken(request);
  const tokenUser = getUserByToken(authToken);
  const user = sessionUser || tokenUser;
  let token = authToken;
  if (user && !token) {
    token = getOrCreateAuthToken(user.id);
  }
  response.json({ user: sanitizeUser(user), token: token || null });
});

app.post('/api/auth/logout', (request, response, next) => {
  const authToken = getBearerToken(request);

  // 只清除当前请求携带的 Token，不影响其他设备
  clearAuthToken(authToken);

  request.session.destroy(() => {
    response.json({ ok: true });
  });
});

// BUG-010: 修改密码接口（用于强制修改默认密码）
app.post('/api/auth/change-password', requireAuth, (request, response) => {
  const { oldPassword, newPassword } = request.body;
  const trimmedNewPassword = String(newPassword || '').trim();

  if (!oldPassword || !trimmedNewPassword) {
    response.status(400).json({ error: '请输入旧密码和新密码。' });
    return;
  }

  if (trimmedNewPassword.length < 6) {
    response.status(400).json({ error: '新密码长度不能少于6位。' });
    return;
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(request.currentUser.id);
  if (!bcrypt.compareSync(String(oldPassword).trim(), user.password)) {
    response.status(401).json({ error: '旧密码不正确。' });
    return;
  }

  db.prepare('UPDATE users SET password = ?, must_change_password = 0 WHERE id = ?')
    .run(bcrypt.hashSync(trimmedNewPassword, 10), user.id);

  response.json({ ok: true });
});

// 教师注册申请
app.post('/api/auth/register/teacher', checkRegisterRateLimit, (request, response) => {
  const { username, password, displayName, className, motivation } = request.body;
  const trimmedUsername = String(username || '').trim();
  const trimmedPassword = String(password || '').trim();
  const trimmedDisplayName = sanitizeText(displayName);

  if (!trimmedUsername || !trimmedPassword || !trimmedDisplayName) {
    response.status(400).json({ error: '请填写用户名、密码和显示名称。' });
    return;
  }

  if (trimmedPassword.length < 6) {
    response.status(400).json({ error: '密码长度不能少于6位。' });
    return;
  }

  const existingUser = db.prepare('SELECT id FROM users WHERE username = ?').get(trimmedUsername);
  if (existingUser) {
    response.status(400).json({ error: '该用户名已被使用。' });
    return;
  }

  const existingApp = db.prepare('SELECT id FROM teacher_applications WHERE username = ?').get(trimmedUsername);
  if (existingApp) {
    response.status(400).json({ error: '该用户名已有待审核的注册申请。' });
    return;
  }

  const now = dayjs().toISOString();
  db.prepare(
    `INSERT INTO teacher_applications (username, password, display_name, class_name, motivation, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`
  ).run(
    trimmedUsername,
    bcrypt.hashSync(trimmedPassword, 10),
    trimmedDisplayName,
    sanitizeText(className),
    String(motivation || '').trim().slice(0, MAX_CONTENT_LENGTH),
    now
  );

  response.json({ ok: true, message: '注册申请已提交，请等待管理员审核。' });
});

// 管理后台 - 初始数据
app.get('/api/admin/bootstrap', requireAdmin, (request, response) => {
  const applications = db
    .prepare('SELECT * FROM teacher_applications ORDER BY created_at DESC')
    .all()
    .map((row) => ({
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      className: row.class_name,
      motivation: row.motivation,
      status: row.status,
      reviewedBy: row.reviewed_by,
      reviewedAt: row.reviewed_at,
      createdAt: row.created_at
    }));

  const users = db
    .prepare('SELECT * FROM users ORDER BY created_at DESC')
    .all()
    .map((row) => ({
      id: row.id,
      username: row.username,
      role: row.role,
      displayName: row.display_name,
      className: row.class_name,
      createdAt: row.created_at
    }));

  const stats = {
    totalUsers: users.length,
    teacherCount: users.filter((u) => u.role === 'teacher').length,
    studentCount: users.filter((u) => u.role === 'student').length,
    pendingApplications: applications.filter((a) => a.status === 'pending').length
  };

  response.json({
    user: sanitizeUser(request.currentUser),
    applications,
    users,
    stats
  });
});

// 管理后台 - 审核教师申请
app.post('/api/admin/applications/:id/approve', requireAdmin, (request, response) => {
  const application = db.prepare('SELECT * FROM teacher_applications WHERE id = ?').get(request.params.id);
  if (!application) {
    response.status(404).json({ error: '申请不存在。' });
    return;
  }

  if (application.status !== 'pending') {
    response.status(400).json({ error: '该申请已处理。' });
    return;
  }

  const now = dayjs().toISOString();

  try {
    const approveTransaction = db.transaction(() => {
      // 创建教师账号
      db.prepare(
        `INSERT INTO users (username, password, role, display_name, class_name, created_at)
         VALUES (?, ?, 'teacher', ?, ?, ?)`
      ).run(application.username, application.password, application.display_name, application.class_name, now);

      // BUG-080: 审批后清除申请中的密码
      db.prepare('UPDATE teacher_applications SET status = \'approved\', reviewed_by = ?, reviewed_at = ?, password = \'\' WHERE id = ?')
        .run(request.currentUser.id, now, request.params.id);
    });

    approveTransaction();

    response.json({ ok: true });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint')) {
      response.status(400).json({ error: '用户名已被占用，无法创建账号。' });
      return;
    }
    throw err;
  }
});

app.post('/api/admin/applications/:id/reject', requireAdmin, (request, response) => {
  const application = db.prepare('SELECT * FROM teacher_applications WHERE id = ?').get(request.params.id);
  if (!application) {
    response.status(404).json({ error: '申请不存在。' });
    return;
  }

  if (application.status !== 'pending') {
    response.status(400).json({ error: '该申请已处理。' });
    return;
  }

  const now = dayjs().toISOString();
  db.prepare('UPDATE teacher_applications SET status = \'rejected\', reviewed_by = ?, reviewed_at = ? WHERE id = ?')
    .run(request.currentUser.id, now, request.params.id);

  response.json({ ok: true });
});

// 管理后台 - 用户管理
app.get('/api/admin/users', requireAdmin, (request, response) => {
  const { role, search } = request.query;
  const limit = Math.min(Number(request.query.limit) || 100, 500);
  const offset = Number(request.query.offset) || 0;
  let query = 'SELECT * FROM users WHERE 1=1';
  const params = [];

  if (role) {
    query += ' AND role = ?';
    params.push(role);
  }

  if (search) {
    // BUG-059: 转义 LIKE 通配符
    const safeSearch = String(search).replace(/[%_]/g, '\\$&');
    query += " AND (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')";
    params.push(`%${safeSearch}%`, `%${safeSearch}%`);
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const users = db.prepare(query).all(...params).map((row) => ({
    id: row.id,
    username: row.username,
    role: row.role,
    displayName: row.display_name,
    className: row.class_name,
    createdAt: row.created_at
  }));

  response.json({ users });
});

app.put('/api/admin/users/:id', requireAdmin, (request, response) => {
  const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(request.params.id);
  if (!targetUser) {
    response.status(404).json({ error: '用户不存在。' });
    return;
  }

  const { displayName, className, role } = request.body;
  const updates = [];
  const params = [];

  if (displayName !== undefined) {
    updates.push('display_name = ?');
    params.push(sanitizeText(displayName));
  }

  if (className !== undefined) {
    updates.push('class_name = ?');
    params.push(sanitizeText(className));
  }

  if (role !== undefined) {
    if (!['teacher', 'student', 'admin'].includes(role)) {
      response.status(400).json({ error: '无效的角色类型。' });
      return;
    }
    if (role && targetUser.role === 'admin' && role !== 'admin') {
      const adminCount = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get().count;
      if (adminCount <= 1) {
        response.status(400).json({ error: '不能移除唯一的管理员。' });
        return;
      }
    }
    updates.push('role = ?');
    params.push(role);
  }

  if (!updates.length) {
    response.status(400).json({ error: '没有需要更新的字段。' });
    return;
  }

  params.push(request.params.id);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  response.json({ ok: true });
});

app.delete('/api/admin/users/:id', requireAdmin, (request, response) => {
  const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(request.params.id);
  if (!targetUser) {
    response.status(404).json({ error: '用户不存在。' });
    return;
  }

  if (targetUser.role === 'admin') {
    response.status(400).json({ error: '不能删除管理员账号。' });
    return;
  }

  // 清理该用户的所有关联数据，避免外键约束报错
  const uid = targetUser.id;
  const cleanup = db.transaction(() => {
    db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM practice_records WHERE student_id = ?').run(uid);
    db.prepare('DELETE FROM practice_sessions WHERE student_id = ?').run(uid);
    db.prepare('DELETE FROM flashcard_records WHERE student_id = ?').run(uid);
    db.prepare('DELETE FROM task_completions WHERE student_id = ?').run(uid);
    db.prepare('DELETE FROM task_completions WHERE task_id IN (SELECT id FROM tasks WHERE created_by = ?)').run(uid);
    db.prepare('DELETE FROM notifications WHERE student_id = ?').run(uid);
    db.prepare('DELETE FROM summaries WHERE student_id = ?').run(uid);
    db.prepare('DELETE FROM orders WHERE student_id = ?').run(uid);
    db.prepare('DELETE FROM live_messages WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM forum_replies WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM forum_topics WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM folder_items WHERE created_by = ?').run(uid);
    db.prepare('DELETE FROM folders WHERE created_by = ?').run(uid);
    db.prepare('DELETE FROM question_tag_relations WHERE question_id IN (SELECT id FROM questions WHERE created_by = ?)').run(uid);
    db.prepare('DELETE FROM questions WHERE created_by = ?').run(uid);
    db.prepare('DELETE FROM flashcards WHERE created_by = ?').run(uid);
    db.prepare('DELETE FROM tasks WHERE created_by = ?').run(uid);
    db.prepare('DELETE FROM products WHERE created_by = ?').run(uid);
    db.prepare('DELETE FROM courses WHERE created_by = ?').run(uid);
    db.prepare('DELETE FROM live_messages WHERE live_session_id IN (SELECT id FROM live_sessions WHERE created_by = ?)').run(uid);
    db.prepare('DELETE FROM live_sessions WHERE created_by = ?').run(uid);
    db.prepare('DELETE FROM teacher_applications WHERE reviewed_by = ?').run(uid);
    db.prepare('DELETE FROM users WHERE id = ?').run(uid);
  });

  cleanup();
  response.status(204).end();
});

app.post('/api/summaries', requireStudent, (request, response) => {
  const contentType = request.headers['content-type'] || '';
  const isMultipart = contentType.includes('multipart/form-data');

  const handleSummary = () => {
    const taskDate = request.body.taskDate || dayjs().format('YYYY-MM-DD');
    // BUG-006: 验证日期合法性
    const parsedDate = dayjs(taskDate);
    if (!parsedDate.isValid() || parsedDate.isAfter(dayjs().add(1, 'day'))) {
      response.status(400).json({ error: '无效的总结日期。' });
      return;
    }
    const content = sanitizeText(request.body.content);
    const imagePaths = (request.files?.images || []).map((file) => toPublicPath(file.path));
    const attachmentPaths = (request.files?.attachments || []).map((file) => toPublicPath(file.path));
    const now = dayjs().toISOString();

    // BUG-007: 无内容无附件时拒绝创建新记录
    if (!content && !imagePaths.length && !attachmentPaths.length) {
      const existing = db.prepare('SELECT id FROM summaries WHERE student_id = ? AND task_date = ?').get(request.currentUser.id, taskDate);
      if (!existing) {
        response.status(400).json({ error: '请填写总结内容或上传文件。' });
        return;
      }
    }

    // BUG-017: 用事务防止并发读-改-写竞态
    const upsertSummary = db.transaction(() => {
      const existing = db.prepare('SELECT id, content, image_paths, attachment_paths FROM summaries WHERE student_id = ? AND task_date = ?').get(request.currentUser.id, taskDate);

      if (existing) {
        const mergedImages = [...safeJsonParse(existing.image_paths, []), ...imagePaths];
        const mergedAttachments = [...safeJsonParse(existing.attachment_paths, []), ...attachmentPaths];
        const finalContent = content || existing.content;

        db.prepare(
          `
            UPDATE summaries
            SET content = ?, image_paths = ?, attachment_paths = ?, updated_at = ?
            WHERE id = ?
          `
        ).run(finalContent, JSON.stringify(mergedImages), JSON.stringify(mergedAttachments), now, existing.id);
      } else {
        db.prepare(
          `
            INSERT INTO summaries (
              student_id, task_date, content, image_paths, attachment_paths, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      ).run(request.currentUser.id, taskDate, content, JSON.stringify(imagePaths), JSON.stringify(attachmentPaths), now, now);
      }
    });

    upsertSummary();
    response.json({ ok: true });
  };

  if (isMultipart) {
    summaryUpload(request, response, (error) => {
      if (error) {
        response.status(400).json({ error: '总结上传失败。' });
        return;
      }
      handleSummary();
    });
  } else {
    handleSummary();
  }
});

app.get('/', (request, response) => {
  response.sendFile(path.join(publicDir, 'index.html'));
});

app.get('/teacher', (request, response) => {
  response.sendFile(path.join(publicDir, 'teacher.html'));
});

app.get('/student', (request, response) => {
  response.sendFile(path.join(publicDir, 'student.html'));
});

app.get('/admin', (request, response) => {
  response.sendFile(path.join(publicDir, 'admin.html'));
});

app.get('/forum', (request, response) => {
  response.sendFile(path.join(publicDir, 'forum.html'));
});

app.get('/forum/topic/:id', (request, response) => {
  response.sendFile(path.join(publicDir, 'topic-detail.html'));
});

app.get('/register', (request, response) => {
  response.sendFile(path.join(publicDir, 'register.html'));
});

app.get('/live/:id', (request, response) => {
  response.sendFile(path.join(publicDir, 'live.html'));
});


app.get('/api/teacher/bootstrap', requireTeacher, (request, response) => {
  response.json(getTeacherBootstrapData(request.currentUser));
});

app.get('/api/student/bootstrap', requireStudent, (request, response) => {
  response.json(getStudentBootstrapData(request.currentUser));
});

// 教师端 - 学生维度视图
app.get('/api/teacher/students/overview', requireTeacher, (request, response) => {
  const today = dayjs().format('YYYY-MM-DD');
  // BUG-052: 教师只能查看同班级的学生数据
  const teacherClassName = request.currentUser.class_name || '';
  let students = getStudents();
  if (teacherClassName) {
    students = students.filter((s) => !s.className || s.className === teacherClassName);
  }

  const overview = students.map((student) => {
    const todaysTasks = getTasksForStudentOnDate(db, student.id, today);

    const completedCount = todaysTasks.filter((task) => {
      const completion = db.prepare(
        'SELECT completed_at FROM task_completions WHERE task_id = ? AND student_id = ? AND task_date = ?'
      ).get(task.id, student.id, today);
      return completion && completion.completed_at;
    }).length;

    const latestSummary = db.prepare(
      'SELECT created_at FROM summaries WHERE student_id = ? ORDER BY updated_at DESC LIMIT 1'
    ).get(student.id);

    const practiceStats = db.prepare(
      'SELECT COUNT(*) AS total, SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct FROM practice_records WHERE student_id = ?'
    ).get(student.id);

    return {
      ...student,
      todaysTaskCount: todaysTasks.length,
      todaysCompletedCount: completedCount,
      lastSummaryDate: latestSummary ? latestSummary.created_at : null,
      practiceTotal: practiceStats.total || 0,
      practiceAccuracy: practiceStats.total > 0 ? Math.round(((practiceStats.correct || 0) / practiceStats.total) * 100) : 0
    };
  });

  response.json({ students: overview, today });
});

app.get('/api/teacher/students/:id/overview', requireTeacher, (request, response) => {
  // BUG-052: 教师只能查看同班级的学生详情
  const teacherClassName = request.currentUser.class_name || '';
  const student = db.prepare('SELECT * FROM users WHERE id = ? AND role = \'student\'').get(request.params.id);
  if (!student) {
    response.status(404).json({ error: '学生不存在。' });
    return;
  }
  if (teacherClassName && student.class_name && student.class_name !== teacherClassName) {
    response.status(403).json({ error: '无权查看该学生的数据。' });
    return;
  }

  const today = dayjs().format('YYYY-MM-DD');
  const todaysTasks = getTasksForStudentOnDate(db, student.id, today).map((task) => {
    const completion = db.prepare(
      'SELECT completed_at FROM task_completions WHERE task_id = ? AND student_id = ? AND task_date = ?'
    ).get(task.id, student.id, today);

    return {
      ...serializeTask(task),
      completed: !!(completion && completion.completed_at)
    };
  });

  const summaries = db.prepare(
    'SELECT * FROM summaries WHERE student_id = ? ORDER BY updated_at DESC LIMIT 10'
  ).all(student.id).map(serializeSummary);

  const practiceStats = db.prepare(
    'SELECT COUNT(*) AS total, SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct FROM practice_records WHERE student_id = ?'
  ).get(student.id);

  response.json({
    student: {
      id: student.id,
      username: student.username,
      displayName: student.display_name,
      className: student.class_name
    },
    todaysTasks,
    summaries,
    practiceStats: {
      total: practiceStats.total || 0,
      correct: practiceStats.correct || 0,
      accuracy: practiceStats.total > 0 ? Math.round(((practiceStats.correct || 0) / practiceStats.total) * 100) : 0
    }
  });
});

// 教师提醒指定学生未完成任务
app.post('/api/teacher/students/:id/remind', requireTeacher, (request, response) => {
  const teacherClassName = request.currentUser.class_name || '';
  const student = db.prepare('SELECT * FROM users WHERE id = ? AND role = \'student\'').get(request.params.id);
  if (!student) {
    response.status(404).json({ error: '学生不存在。' });
    return;
  }
  if (teacherClassName && student.class_name && student.class_name !== teacherClassName) {
    response.status(403).json({ error: '无权操作该学生。' });
    return;
  }

  const today = dayjs().format('YYYY-MM-DD');
  const todaysTasks = getTasksForStudentOnDate(db, student.id, today);
  const incompleteTasks = todaysTasks.filter((task) => {
    const completion = db.prepare(
      'SELECT completed_at FROM task_completions WHERE task_id = ? AND student_id = ? AND task_date = ?'
    ).get(task.id, student.id, today);
    return !completion || !completion.completed_at;
  });

  if (!incompleteTasks.length) {
    response.json({ ok: true, sent: 0, message: '该学生今日任务已全部完成。' });
    return;
  }

  const taskList = incompleteTasks.map((t) => `${t.start_time}-${t.end_time} ${t.title}`).join('；');
  const now = dayjs().toISOString();
  const notificationTitle = `老师提醒：今日未完成任务 (${today})`;
  const notificationBody = taskList;

  db.prepare(
    'INSERT INTO notifications (student_id, type, title, body, task_date, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(student.id, '任务提醒', notificationTitle, notificationBody, today, now);

  sendNotificationToStudent(student.id, {
    type: 'notification',
    payload: {
      id: db.prepare('SELECT last_insert_rowid() AS id').get().id,
      studentId: student.id,
      type: '任务提醒',
      title: notificationTitle,
      body: notificationBody,
      taskDate: today,
      readAt: null,
      createdAt: now
    }
  });

  response.json({ ok: true, sent: 1, count: incompleteTasks.length });
});

// 学生标记任务完成
app.post('/api/tasks/:id/complete', requireStudent, (request, response) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(request.params.id);
  if (!task) {
    response.status(404).json({ error: '任务不存在。' });
    return;
  }

  const taskStudents = safeJsonParse(task.student_ids, []);
  if (!taskStudents.includes(request.currentUser.id)) {
    response.status(403).json({ error: '该任务不属于当前学生。' });
    return;
  }

  const today = dayjs().format('YYYY-MM-DD');
  const now = dayjs().toISOString();

  db.prepare(
    `INSERT INTO task_completions (task_id, student_id, task_date, completed_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(task_id, student_id, task_date) DO UPDATE SET completed_at = excluded.completed_at`
  ).run(request.params.id, request.currentUser.id, today, now);

  response.json({ ok: true });
});

// 学生取消任务完成
app.post('/api/tasks/:id/uncomplete', requireStudent, (request, response) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(request.params.id);
  if (!task) {
    response.status(404).json({ error: '任务不存在。' });
    return;
  }

  const taskStudents = safeJsonParse(task.student_ids, []);
  if (!taskStudents.includes(request.currentUser.id)) {
    response.status(403).json({ error: '该任务不属于当前学生。' });
    return;
  }

  const today = dayjs().format('YYYY-MM-DD');
  db.prepare(
    'UPDATE task_completions SET completed_at = NULL WHERE task_id = ? AND student_id = ? AND task_date = ?'
  ).run(request.params.id, request.currentUser.id, today);

  response.json({ ok: true });
});

app.post('/api/tasks', requireTeacher, (request, response) => {
  const { title, description, subject, startTime, endTime, weekdays, studentIds } = request.body;
  const normalizedWeekdays = parseWeekdaysInput(weekdays);
  const normalizedStudentIds = resolveStudentIds(studentIds);

  if (!title || !startTime || !endTime || !normalizedStudentIds.length) {
    response.status(400).json({ error: '请完整填写任务标题、时间与学生。' });
    return;
  }

  // BUG-005: 输入长度限制
  if (String(title).length > MAX_TITLE_LENGTH) {
    response.status(400).json({ error: `标题不能超过${MAX_TITLE_LENGTH}个字符。` });
    return;
  }

  // BUG-05: 校验 weekdays 非空
  if (!normalizedWeekdays.length) {
    response.status(400).json({ error: '请选择有效的周期（周一至周日）。' });
    return;
  }

  // BUG-006: 校验时间格式为合法 HH:mm
  const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
  if (!timeRegex.test(String(startTime)) || !timeRegex.test(String(endTime))) {
    response.status(400).json({ error: '时间格式无效，请使用 HH:mm（00:00-23:59）。' });
    return;
  }

  if (startTime >= endTime) {
    response.status(400).json({ error: '结束时间必须晚于开始时间。' });
    return;
  }

  // BUG-04: 校验 studentIds 中的每个 ID 确实是学生
  const validStudents = db.prepare(`SELECT id FROM users WHERE role = 'student' AND id IN (${normalizedStudentIds.map(() => '?').join(',')})`).all(...normalizedStudentIds);
  if (validStudents.length !== normalizedStudentIds.length) {
    response.status(400).json({ error: '包含无效的学生ID，请检查学生列表。' });
    return;
  }

  // BUG-076: 创建任务返回新 ID
  const taskId = createTaskRecord({
    title: sanitizeText(title),
    description: sanitizeText(description),
    subject: sanitizeText(subject || '考研规划'),
    startTime: String(startTime).trim(),
    endTime: String(endTime).trim(),
    weekdays: normalizedWeekdays,
    studentIds: normalizedStudentIds,
    teacherId: request.currentUser.id,
    priority: Number(request.body.priority) || 2
  });

  response.json({ ok: true, id: taskId });
});

app.post('/api/tasks/import', requireTeacher, (request, response) => {
  taskImportUpload(request, response, (error) => {
    if (error) {
      response.status(400).json({ error: '表格上传失败。' });
      return;
    }

    if (!request.file) {
      response.status(400).json({ error: '请先上传 Excel 或 CSV 文件。' });
      return;
    }

    const rows = readWorkbookRows(request.file.path);
    let imported = 0;
    let skipped = 0;

    rows.forEach((row) => {
      const title = getFieldValue(row, ['任务标题', 'title', 'Title']);
      const description = getFieldValue(row, ['任务内容', 'description', 'Description']);
      const subject = getFieldValue(row, ['科目', 'subject', 'Subject']) || '考研规划';
      const startTime = getFieldValue(row, ['开始时间', 'startTime', 'StartTime']);
      const endTime = getFieldValue(row, ['结束时间', 'endTime', 'EndTime']);
      const weekdays = parseWeekdaysInput(getFieldValue(row, ['周期', '星期', 'weekdays', 'Weekdays']) || '0,1,2,3,4,5,6');
      const studentIds = resolveStudentIds(getFieldValue(row, ['学生', '学生账号', '学生用户名', 'studentIds', 'StudentIds']));

      if (!title || !startTime || !endTime || !studentIds.length) {
        skipped += 1;
        return;
      }

      if (startTime >= endTime) {
        skipped += 1;
        return;
      }

      createTaskRecord({
        title,
        description,
        subject,
        startTime,
        endTime,
        weekdays,
        studentIds,
        teacherId: request.currentUser.id
      });

      imported += 1;
    });

    fs.unlink(request.file.path, () => {});
    response.json({ ok: true, imported, skipped });
  });
});

// 题目批量导入
app.post('/api/questions/import', requireTeacher, (request, response) => {
  taskImportUpload(request, response, (error) => {
    if (error) {
      response.status(400).json({ error: '文件上传失败。' });
      return;
    }

    if (!request.file) {
      response.status(400).json({ error: '请先上传文件。' });
      return;
    }

    const rows = readWorkbookRows(request.file.path);
    let imported = 0;
    let skipped = 0;

    rows.forEach((row) => {
      const title = sanitizeText(getFieldValue(row, ['题目标题', 'title', 'Title']));
      const subject = sanitizeText(getFieldValue(row, ['科目', 'subject', 'Subject']) || '考研英语');
      const questionType = sanitizeText(getFieldValue(row, ['题型', 'questionType', 'QuestionType']));
      const textbook = sanitizeText(getFieldValue(row, ['参考书', 'textbook', 'Textbook']));
      const stem = sanitizeText(getFieldValue(row, ['题干', 'stem', 'Stem']));
      const optionA = sanitizeText(getFieldValue(row, ['选项A', 'optionA', 'OptionA']));
      const optionB = sanitizeText(getFieldValue(row, ['选项B', 'optionB', 'OptionB']));
      const optionC = sanitizeText(getFieldValue(row, ['选项C', 'optionC', 'OptionC']));
      const optionD = sanitizeText(getFieldValue(row, ['选项D', 'optionD', 'OptionD']));
      const correctAnswer = getFieldValue(row, ['正确答案', 'correctAnswer', 'CorrectAnswer']).toUpperCase();
      const analysisText = sanitizeText(getFieldValue(row, ['文字解析', 'analysisText', 'AnalysisText']));

      if (!title || !stem || !correctAnswer) {
        skipped += 1;
        return;
      }

      const options = [
        { key: 'A', text: optionA },
        { key: 'B', text: optionB },
        { key: 'C', text: optionC },
        { key: 'D', text: optionD }
      ].filter((o) => o.text);

      if (options.length < 2 || !options.some((o) => o.key === correctAnswer)) {
        skipped += 1;
        return;
      }

      db.prepare(
        `INSERT INTO questions (title, subject, question_type, textbook, stem, options, correct_answer, analysis_text, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(title, subject, questionType, textbook, stem, JSON.stringify(options), correctAnswer, analysisText, request.currentUser.id, dayjs().toISOString());

      imported += 1;
    });

    fs.unlink(request.file.path, () => {});
    response.json({ ok: true, imported, skipped });
  });
});

// 用户批量导入（管理员）
app.post('/api/users/import', requireAdmin, (request, response) => {
  taskImportUpload(request, response, (error) => {
    if (error) {
      response.status(400).json({ error: '文件上传失败。' });
      return;
    }

    if (!request.file) {
      response.status(400).json({ error: '请先上传文件。' });
      return;
    }

    const rows = readWorkbookRows(request.file.path);
    let imported = 0;
    let skipped = 0;

    rows.forEach((row) => {
      const username = getFieldValue(row, ['用户名', 'username', 'Username']);
      const password = getFieldValue(row, ['密码', 'password', 'Password']);
      const role = getFieldValue(row, ['角色', 'role', 'Role']);
      const displayName = sanitizeText(getFieldValue(row, ['显示名称', 'displayName', 'DisplayName']));
      const className = sanitizeText(getFieldValue(row, ['班级', 'className', 'ClassName']));

      if (!username || !password || !role || !displayName) {
        skipped += 1;
        return;
      }

      // BUG-022: 批量导入验证密码长度
      if (password.length < 6) {
        skipped += 1;
        return;
      }

      if (!['teacher', 'student'].includes(role)) {
        skipped += 1;
        return;
      }

      const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      if (existing) {
        skipped += 1;
        return;
      }

      db.prepare(
        'INSERT INTO users (username, password, role, display_name, class_name, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(username, bcrypt.hashSync(password, 10), role, displayName, className, dayjs().toISOString());

      imported += 1;
    });

    fs.unlink(request.file.path, () => {});
    response.json({ ok: true, imported, skipped });
  });
});

// 词汇卡片批量导入
app.post('/api/flashcards/import', requireTeacher, (request, response) => {
  taskImportUpload(request, response, (error) => {
    if (error) {
      response.status(400).json({ error: '文件上传失败。' });
      return;
    }

    if (!request.file) {
      response.status(400).json({ error: '请先上传文件。' });
      return;
    }

    const rows = readWorkbookRows(request.file.path);
    let imported = 0;
    let skipped = 0;

    rows.forEach((row) => {
      const title = sanitizeText(getFieldValue(row, ['标题', 'title', 'Title']));
      const subject = sanitizeText(getFieldValue(row, ['科目', 'subject', 'Subject']));
      const frontContent = sanitizeText(getFieldValue(row, ['正面内容', 'frontContent', 'FrontContent']));
      const backContent = sanitizeText(getFieldValue(row, ['背面内容', 'backContent', 'BackContent']));
      const tags = sanitizeText(getFieldValue(row, ['标签', 'tags', 'Tags']));

      if (!title || !frontContent || !backContent) {
        skipped += 1;
        return;
      }

      db.prepare(
        'INSERT INTO flashcards (title, subject, front_content, back_content, tags, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(
        title, subject, frontContent, backContent,
        JSON.stringify(tags ? tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean) : []),
        request.currentUser.id, dayjs().toISOString()
      );

      imported += 1;
    });

    fs.unlink(request.file.path, () => {});
    response.json({ ok: true, imported, skipped });
  });
});

// 模板下载
app.get('/api/templates/:type', requireAuth, (request, response) => {
  const typeMap = {
    task: 'task-import-template.csv',
    question: 'question-import-template.csv',
    user: 'user-import-template.csv',
    flashcard: 'flashcard-import-template.csv'
  };

  const fileName = typeMap[request.params.type];
  if (!fileName) {
    response.status(400).json({ error: '未知模板类型。' });
    return;
  }

  const templatePath = path.join(config.rootDir, 'templates', fileName);
  if (!fs.existsSync(templatePath)) {
    response.status(404).json({ error: '模板文件不存在。' });
    return;
  }

  // BUG-011: 设置正确的 Content-Type 和 charset
  response.set('Content-Type', 'text/csv; charset=utf-8');
  response.download(templatePath, fileName);
});

app.post('/api/tasks/dispatch/daily', requireTeacher, (request, response) => {
  const targetDate = request.body.date || dayjs().format('YYYY-MM-DD');
  const notifications = dispatchDailyDigest(db, sendNotificationToStudent, dayjs(`${targetDate} 07:00`));
  response.json({ ok: true, sent: notifications.length });
});

app.post('/api/tasks/dispatch/due', requireTeacher, (request, response) => {
  const targetDate = request.body.date || dayjs().format('YYYY-MM-DD');
  const targetTime = request.body.time || dayjs().format('HH:mm');
  const notifications = dispatchDueTaskReminders(db, sendNotificationToStudent, dayjs(`${targetDate} ${targetTime}`));
  response.json({ ok: true, sent: notifications.length });
});

app.post('/api/notifications/:id/read', requireStudent, (request, response) => {
  const result = db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND student_id = ?').run(dayjs().toISOString(), request.params.id, request.currentUser.id);
  if (!result.changes) {
    response.status(404).json({ error: '通知不存在或不属于当前用户。' });
    return;
  }
  response.json({ ok: true });
});

// 全部标记已读
app.post('/api/notifications/read-all', requireAuth, (request, response) => {
  db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL')
    .run(dayjs().toISOString(), request.currentUser.id);
  response.json({ ok: true });
});

// 未读通知数
app.get('/api/notifications/unread-count', requireAuth, (request, response) => {
  const count = db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND read_at IS NULL')
    .get(request.currentUser.id).count;
  response.json({ count });
});

// 订单状态更新（教师）
app.post('/api/orders/:id/status', requireTeacher, (request, response) => {
  const { status } = request.body;
  const allowed = ['paid', 'shipped', 'delivered', 'confirmed', 'cancelled'];
  if (!allowed.includes(status)) {
    response.status(400).json({ error: '无效的订单状态。' });
    return;
  }
  const result = db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, request.params.id);
  if (!result.changes) { response.status(404).json({ error: '订单不存在。' }); return; }
  response.json({ ok: true });
});

// 学生确认收货
app.post('/api/orders/:id/confirm', requireStudent, (request, response) => {
  const result = db.prepare('UPDATE orders SET status = ? WHERE id = ? AND student_id = ? AND status = ?')
    .run('confirmed', request.params.id, request.currentUser.id, 'delivered');
  if (!result.changes) { response.status(400).json({ error: '订单状态不正确。' }); return; }
  response.json({ ok: true });
});

app.post('/api/courses', requireTeacher, (request, response) => {
  courseUpload(request, response, (error) => {
    if (error) {
      response.status(400).json({ error: '课程上传失败。' });
      return;
    }

    const title = sanitizeText(request.body.title);
    if (!title) {
      response.status(400).json({ error: '课程标题不能为空。' });
      return;
    }

    const courseResult = db.prepare(
      `
        INSERT INTO courses (
          title, description, subject, video_path, video_url, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      title,
      sanitizeText(request.body.description),
      sanitizeText(request.body.subject || '考研规划'),
      request.file ? toPublicPath(request.file.path) : '',
      String(request.body.videoUrl || '').trim(),
      request.currentUser.id,
      dayjs().toISOString()
    );

    response.json({ ok: true, id: courseResult.lastInsertRowid });
  });
});

// 文件夹（网盘）API
function serializeFolder(row) {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    createdBy: row.created_by,
    createdAt: row.created_at
  };
}

function serializeFolderItem(row) {
  return {
    id: row.id,
    folderId: row.folder_id,
    itemType: row.item_type,
    title: row.title,
    description: row.description,
    subject: row.subject,
    filePath: row.file_path,
    fileUrl: row.file_url,
    fileSize: row.file_size,
    sortOrder: row.sort_order,
    createdBy: row.created_by,
    createdAt: row.created_at
  };
}

function getFolderChildren(parentId) {
  const folders = db.prepare('SELECT * FROM folders WHERE parent_id ' + (parentId ? '= ?' : 'IS NULL') + ' ORDER BY name').all(...(parentId ? [parentId] : []));
  const items = db.prepare('SELECT * FROM folder_items WHERE folder_id ' + (parentId ? '= ?' : 'IS NULL') + ' ORDER BY sort_order, created_at DESC').all(...(parentId ? [parentId] : []));
  return {
    folders: folders.map(serializeFolder),
    items: items.map(serializeFolderItem)
  };
}

function getFolderPath(folderId) {
  const breadcrumbs = [];
  const visited = new Set();
  let currentId = folderId;
  while (currentId) {
    if (visited.has(currentId)) break; // 防止循环引用
    visited.add(currentId);
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(currentId);
    if (!folder) break;
    breadcrumbs.unshift({ id: folder.id, name: folder.name });
    currentId = folder.parent_id;
  }
  return breadcrumbs;
}

app.get('/api/folders', requireAuth, (request, response) => {
  const { parentId, subject } = request.query;
  const children = getFolderChildren(parentId || null);
  if (subject) {
    children.items = children.items.filter((item) => item.subject === subject);
  }
  response.json({
    path: parentId ? getFolderPath(Number(parentId)) : [],
    ...children
  });
});

app.get('/api/folders/:id', requireAuth, (request, response) => {
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(request.params.id);
  if (!folder) {
    response.status(404).json({ error: '文件夹不存在。' });
    return;
  }

  const children = getFolderChildren(folder.id);
  response.json({
    folder: serializeFolder(folder),
    path: getFolderPath(folder.id),
    ...children
  });
});

app.post('/api/folders', requireTeacher, (request, response) => {
  const name = sanitizeText(request.body.name);
  if (!name) {
    response.status(400).json({ error: '文件夹名称不能为空。' });
    return;
  }
  if (name.length > MAX_NAME_LENGTH) {
    response.status(400).json({ error: `名称不能超过${MAX_NAME_LENGTH}个字符。` });
    return;
  }

  const parentId = request.body.parentId || null;
  const now = dayjs().toISOString();
  const result = db.prepare('INSERT INTO folders (name, parent_id, created_by, created_at) VALUES (?, ?, ?, ?)').run(name, parentId, request.currentUser.id, now);
  response.json({ ok: true, id: result.lastInsertRowid });
});

app.put('/api/folders/:id', requireTeacher, (request, response) => {
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(request.params.id);
  if (!folder) {
    response.status(404).json({ error: '文件夹不存在。' });
    return;
  }
  // BUG-007: 校验所有权
  if (folder.created_by !== request.currentUser.id) {
    response.status(403).json({ error: '无权操作其他教师的文件夹。' });
    return;
  }

  const name = sanitizeText(request.body.name);
  if (!name) {
    response.status(400).json({ error: '文件夹名称不能为空。' });
    return;
  }

  const parentId = request.body.parentId !== undefined ? request.body.parentId : folder.parent_id;

  // 检测循环引用：parentId 不能是自身，也不能是自身的后代
  if (parentId && Number(parentId) !== folder.parent_id) {
    if (Number(parentId) === folder.id) {
      response.status(400).json({ error: '不能将文件夹设为自己的子文件夹。' });
      return;
    }
    let ancestorId = Number(parentId);
    const visited = new Set();
    while (ancestorId) {
      if (ancestorId === folder.id) {
        response.status(400).json({ error: '不能将文件夹移动到其子文件夹中，这会形成循环。' });
        return;
      }
      if (visited.has(ancestorId)) break;
      visited.add(ancestorId);
      const parent = db.prepare('SELECT parent_id FROM folders WHERE id = ?').get(ancestorId);
      ancestorId = parent ? parent.parent_id : null;
    }
  }

  db.prepare('UPDATE folders SET name = ?, parent_id = ? WHERE id = ?').run(name, parentId, request.params.id);
  response.json({ ok: true });
});

// BUG-050: 删除文件夹时清理关联磁盘文件; BUG-077: 返回 204
app.delete('/api/folders/:id', requireTeacher, (request, response) => {
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(request.params.id);
  if (!folder) {
    response.status(404).json({ error: '文件夹不存在。' });
    return;
  }
  // BUG-007: 校验文件夹所有权
  if (folder.created_by !== request.currentUser.id) {
    response.status(403).json({ error: '无权操作其他教师的文件夹。' });
    return;
  }

  // 清理文件夹内所有 item 的磁盘文件
  const items = db.prepare('SELECT file_path FROM folder_items WHERE folder_id = ?').all(request.params.id);
  items.forEach((item) => {
    if (item.file_path) {
      const diskPath = path.join(uploadRootDir, item.file_path.replace(/^\/uploads/, ''));
      fs.unlink(diskPath, () => {});
    }
  });

  db.prepare('DELETE FROM folders WHERE id = ?').run(request.params.id);
  response.status(204).end();
});

app.post('/api/folder-items', requireTeacher, (request, response) => {
  cloudUpload(request, response, (error) => {
    if (error) {
      response.status(400).json({ error: '文件上传失败。' });
      return;
    }

    const title = sanitizeText(request.body.title);
    const folderId = Number(request.body.folderId) || null;
    const itemType = String(request.body.itemType || 'video').trim();
    const fileUrl = String(request.body.fileUrl || '').trim();

    if (!title) {
      response.status(400).json({ error: '文件标题不能为空。' });
      return;
    }

    if (!folderId) {
      response.status(400).json({ error: '请选择目标文件夹。' });
      return;
    }

    const now = dayjs().toISOString();
    db.prepare(
      `INSERT INTO folder_items (folder_id, item_type, title, description, subject, file_path, file_url, file_size, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      folderId,
      itemType,
      title,
      sanitizeText(request.body.description),
      sanitizeText(request.body.subject),
      request.file ? toPublicPath(request.file.path) : '',
      fileUrl,
      request.file ? request.file.size : 0,
      request.currentUser.id,
      now
    );

    response.json({ ok: true });
  });
});

app.delete('/api/folder-items/:id', requireTeacher, (request, response) => {
  const item = db.prepare('SELECT * FROM folder_items WHERE id = ?').get(request.params.id);
  if (!item) {
    response.status(404).json({ error: '文件不存在。' });
    return;
  }
  // BUG-007: 校验所有权
  if (item.created_by !== request.currentUser.id) {
    response.status(403).json({ error: '无权操作其他教师的文件。' });
    return;
  }

  // BUG-050: 删除文件项时清理磁盘文件
  if (item.file_path) {
    const diskPath = path.join(uploadRootDir, item.file_path.replace(/^\/uploads/, ''));
    fs.unlink(diskPath, () => {});
  }

  db.prepare('DELETE FROM folder_items WHERE id = ?').run(request.params.id);
  response.status(204).end();
});

app.post('/api/live-sessions', requireTeacher, (request, response) => {
  const title = sanitizeText(request.body.title);
  if (!title) {
    response.status(400).json({ error: '直播标题不能为空。' });
    return;
  }

  const liveResult = db.prepare(
    `
      INSERT INTO live_sessions (
        title, description, subject, status, created_by, created_at
      ) VALUES (?, ?, ?, 'draft', ?, ?)
    `
  ).run(
    title,
    sanitizeText(request.body.description),
    sanitizeText(request.body.subject || '考研规划'),
    request.currentUser.id,
    dayjs().toISOString()
  );

  response.json({ ok: true, id: liveResult.lastInsertRowid });
});

app.post('/api/live-sessions/:id/start', requireTeacher, (request, response) => {
  const session = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(request.params.id);
  if (!session) {
    response.status(404).json({ error: '直播间不存在。' });
    return;
  }
  // BUG-007: 校验所有权
  if (session.created_by !== request.currentUser.id) {
    response.status(403).json({ error: '无权操作其他教师的直播。' });
    return;
  }
  if (session.status === 'live') {
    response.status(400).json({ error: '直播已在进行中。' });
    return;
  }

  db.prepare(
    `
      UPDATE live_sessions
      SET status = 'live', started_at = COALESCE(started_at, ?), ended_at = NULL
      WHERE id = ?
    `
  ).run(dayjs().toISOString(), request.params.id);

  response.json({ ok: true });
});

app.post('/api/live-sessions/:id/end', requireTeacher, (request, response) => {
  const session = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(request.params.id);
  if (!session) {
    response.status(404).json({ error: '直播间不存在。' });
    return;
  }
  // BUG-007: 校验所有权
  if (session.created_by !== request.currentUser.id) {
    response.status(403).json({ error: '无权操作其他教师的直播。' });
    return;
  }
  if (session.status !== 'live') {
    response.status(400).json({ error: '直播未在进行中，无法结束。' });
    return;
  }

  db.prepare(
    `
      UPDATE live_sessions
      SET status = 'ended', ended_at = ?
      WHERE id = ?
    `
  ).run(dayjs().toISOString(), request.params.id);

  broadcastToLiveRoom(request.params.id, { type: 'live-ended', liveId: Number(request.params.id) });
  response.json({ ok: true });
});

app.get('/api/live-sessions/:id', requireAuth, (request, response) => {
  const sessionRow = db
    .prepare(
      `
        SELECT live_sessions.*, users.display_name AS teacher_name
        FROM live_sessions
        LEFT JOIN users ON users.id = live_sessions.created_by
        WHERE live_sessions.id = ?
      `
    )
    .get(request.params.id);

  if (!sessionRow) {
    response.status(404).json({ error: '直播不存在。' });
    return;
  }

  const messages = db
    .prepare(
      `
        SELECT live_messages.*, users.display_name AS author_name, users.role AS author_role
        FROM live_messages
        LEFT JOIN users ON users.id = live_messages.user_id
        WHERE live_messages.live_session_id = ?
        ORDER BY live_messages.created_at ASC
      `
    )
    .all(request.params.id)
    .map((message) => ({
      id: message.id,
      liveSessionId: message.live_session_id,
      userId: message.user_id,
      content: message.content,
      authorName: message.author_name,
      authorRole: message.author_role,
      createdAt: message.created_at
    }));

  response.json({
    liveSession: serializeLiveSession(sessionRow),
    messages,
    user: sanitizeUser(request.currentUser)
  });
});

// 论坛主题列表（独立页面用）
app.get('/api/forum/topics', requireAuth, (request, response) => {
  const { category, limit, offset, search, sort, hashtag } = request.query;
  const maxLimit = Math.min(Number(limit) || 50, 200);
  const skip = Number(offset) || 0;
  let query = `
    SELECT forum_topics.*, users.display_name AS author_name, users.role AS author_role
    FROM forum_topics
    LEFT JOIN users ON users.id = forum_topics.user_id
  `;
  const params = [];
  const conditions = [];
  if (category) { conditions.push('forum_topics.category = ?'); params.push(category); }
  if (search) { conditions.push('(forum_topics.title LIKE ? OR forum_topics.content LIKE ?)'); params.push('%' + search + '%', '%' + search + '%'); }
  if (hashtag) { conditions.push('forum_topics.hashtags LIKE ?'); params.push('%"' + hashtag + '"%'); }
  if (conditions.length) { query += ' WHERE ' + conditions.join(' AND '); }

  if (sort === 'hot') {
    query += ' ORDER BY forum_topics.is_pinned DESC, ((SELECT COUNT(*) FROM forum_likes WHERE topic_id = forum_topics.id) * 2 + (SELECT COUNT(*) FROM forum_replies WHERE topic_id = forum_topics.id) * 3) / MAX(julianday("now") - julianday(forum_topics.created_at), 0.5) DESC';
  } else {
    query += ' ORDER BY forum_topics.is_pinned DESC, forum_topics.created_at DESC';
  }
  query += ' LIMIT ? OFFSET ?';
  params.push(maxLimit, skip);
  const topics = db.prepare(query).all(...params);
  const topicIds = topics.map((t) => t.id);
  const repliesMap = batchLoadForumReplies(topicIds);
  const likesMap = batchLoadForumLikes(topicIds, request.currentUser.id);
  const favRows = db.prepare(`SELECT topic_id FROM forum_favorites WHERE topic_id IN (${topicIds.length ? topicIds.map(() => '?').join(',') : '0'}) AND user_id = ?`).all(...(topicIds.length ? topicIds : []), request.currentUser.id);
  const favSet = new Set(favRows.map((r) => r.topic_id));
  // 批量加载赞同数
  const endorseRows = topicIds.length ? db.prepare(`SELECT topic_id, COUNT(*) AS cnt FROM forum_endorsements WHERE topic_id IN (${topicIds.map(() => '?').join(',')}) GROUP BY topic_id`).all(...topicIds) : [];
  const endorseMap = new Map(endorseRows.map((r) => [r.topic_id, r.cnt]));
  response.json({ topics: topics.map((t) => {
    const serialized = serializeForumTopic(t, repliesMap, likesMap);
    serialized.favoritedByMe = favSet.has(t.id);
    serialized.endorseCount = endorseMap.get(t.id) || 0;
    return serialized;
  }) });
});

app.post('/api/forum/topics', requireAuth, (request, response) => {
  forumUpload(request, response, (error) => {
    if (error) {
      response.status(400).json({ error: '上传失败。' });
      return;
    }

    const title = stripHtml(request.body.title);
    const content = stripHtml(request.body.content);

    if (!title || !content) {
      response.status(400).json({ error: '帖子标题和内容都不能为空。' });
      return;
    }

    const imagePaths = (request.files?.images || []).map((f) => toPublicPath(f.path));
    const videoPaths = (request.files?.videos || []).map((f) => toPublicPath(f.path));
    const attachmentPaths = (request.files?.attachments || []).map((f) => toPublicPath(f.path));
    const links = safeJsonParse(request.body.links || '[]', []);

    // 解析 #话题# 标签
    const hashtagRegex = /#([^#\s]+)#/g;
    const extractedTags = [];
    let tagMatch;
    while ((tagMatch = hashtagRegex.exec(content)) !== null) {
      extractedTags.push(tagMatch[1]);
    }

    const topicResult = db.prepare(
      `
        INSERT INTO forum_topics (user_id, title, content, category, hashtags, image_paths, attachment_paths, video_paths, links, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      request.currentUser.id, title, content,
      sanitizeText(request.body.category || '考研交流'),
      JSON.stringify(extractedTags),
      JSON.stringify(imagePaths), JSON.stringify(attachmentPaths),
      JSON.stringify(videoPaths), JSON.stringify(links),
      dayjs().toISOString()
    );

    // 检查成就
    checkAndUnlockAchievements(request.currentUser.id);

    // @提及通知
    sendMentionNotifications(content, request.currentUser.id, title);

    response.json({ ok: true, id: topicResult.lastInsertRowid });
  });
});

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

app.post('/api/forum/topics/:id/replies', requireAuth, (request, response) => {
  forumUpload(request, response, (error) => {
    if (error) {
      response.status(400).json({ error: '上传失败。' });
      return;
    }

    const content = stripHtml(request.body.content);
    if (!content) {
      response.status(400).json({ error: '回复内容不能为空。' });
      return;
    }

    const topic = db.prepare('SELECT id FROM forum_topics WHERE id = ?').get(request.params.id);
    if (!topic) {
      response.status(404).json({ error: '帖子不存在。' });
      return;
    }

    const imagePaths = (request.files?.images || []).map((f) => toPublicPath(f.path));
    const videoPaths = (request.files?.videos || []).map((f) => toPublicPath(f.path));
    const attachmentPaths = (request.files?.attachments || []).map((f) => toPublicPath(f.path));
    const links = safeJsonParse(request.body.links || '[]', []);

    // 楼中楼回复支持
    let replyToId = null;
    let replyToUser = '';
    const replyToIdRaw = request.body.replyToId;
    if (replyToIdRaw) {
      const parentReply = db.prepare(
        'SELECT forum_replies.id, users.display_name FROM forum_replies LEFT JOIN users ON users.id = forum_replies.user_id WHERE forum_replies.id = ? AND forum_replies.topic_id = ?'
      ).get(Number(replyToIdRaw), request.params.id);
      if (parentReply) {
        replyToId = parentReply.id;
        replyToUser = parentReply.display_name || '';
      }
    }

    db.prepare(
      `
        INSERT INTO forum_replies (topic_id, user_id, content, image_paths, attachment_paths, video_paths, links, reply_to_id, reply_to_user, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      request.params.id, request.currentUser.id, content,
      JSON.stringify(imagePaths), JSON.stringify(attachmentPaths),
      JSON.stringify(videoPaths), JSON.stringify(links),
      replyToId, replyToUser,
      dayjs().toISOString()
    );

    // @提及通知
    const topicTitle = db.prepare('SELECT title FROM forum_topics WHERE id = ?').get(request.params.id);
    sendMentionNotifications(content, request.currentUser.id, topicTitle ? topicTitle.title : '回复');

    response.json({ ok: true });
  });
});

// 帖子详情
app.get('/api/forum/topics/:id', requireAuth, (request, response) => {
  const topic = db.prepare(
    `SELECT forum_topics.*, users.display_name AS author_name, users.role AS author_role
     FROM forum_topics
     LEFT JOIN users ON users.id = forum_topics.user_id
     WHERE forum_topics.id = ?`
  ).get(request.params.id);

  if (!topic) {
    response.status(404).json({ error: '帖子不存在。' });
    return;
  }

  const repliesMap = batchLoadForumReplies([topic.id]);
  const likesMap = batchLoadForumLikes([topic.id], request.currentUser.id);
  response.json({ topic: serializeForumTopic(topic, repliesMap, likesMap) });
});

// 帖子点赞/取消
app.post('/api/forum/topics/:id/like', requireAuth, (request, response) => {
  const topic = db.prepare('SELECT id FROM forum_topics WHERE id = ?').get(request.params.id);
  if (!topic) {
    response.status(404).json({ error: '帖子不存在。' });
    return;
  }

  const existing = db.prepare(
    'SELECT id FROM forum_likes WHERE topic_id = ? AND user_id = ?'
  ).get(request.params.id, request.currentUser.id);

  let liked;
  if (existing) {
    db.prepare('DELETE FROM forum_likes WHERE id = ?').run(existing.id);
    liked = false;
  } else {
    db.prepare(
      'INSERT INTO forum_likes (topic_id, user_id, created_at) VALUES (?, ?, ?)'
    ).run(request.params.id, request.currentUser.id, dayjs().toISOString());
    liked = true;
  }

  const likeCount = db.prepare(
    'SELECT COUNT(*) AS count FROM forum_likes WHERE topic_id = ?'
  ).get(request.params.id).count;

  response.json({ liked, likeCount });
});

// 论坛收藏切换
app.post('/api/forum/topics/:id/favorite', requireAuth, (request, response) => {
  const topic = db.prepare('SELECT id FROM forum_topics WHERE id = ?').get(request.params.id);
  if (!topic) { response.status(404).json({ error: '帖子不存在。' }); return; }

  const existing = db.prepare('SELECT id FROM forum_favorites WHERE topic_id = ? AND user_id = ?').get(request.params.id, request.currentUser.id);
  let favorited;
  if (existing) {
    db.prepare('DELETE FROM forum_favorites WHERE id = ?').run(existing.id);
    favorited = false;
  } else {
    db.prepare('INSERT INTO forum_favorites (topic_id, user_id, created_at) VALUES (?, ?, ?)').run(request.params.id, request.currentUser.id, dayjs().toISOString());
    favorited = true;
  }
  response.json({ favorited });
});

// 论坛收藏列表
app.get('/api/forum/topics/favorites', requireAuth, (request, response) => {
  const { category } = request.query;
  let query = `
    SELECT forum_topics.*, users.display_name AS author_name, users.role AS author_role
    FROM forum_favorites
    JOIN forum_topics ON forum_topics.id = forum_favorites.topic_id
    LEFT JOIN users ON users.id = forum_topics.user_id
    WHERE forum_favorites.user_id = ?
  `;
  const params = [request.currentUser.id];
  if (category) { query += ' AND forum_topics.category = ?'; params.push(category); }
  query += ' ORDER BY forum_favorites.created_at DESC LIMIT 50';
  const topics = db.prepare(query).all(...params);
  const topicIds = topics.map((t) => t.id);
  const repliesMap = batchLoadForumReplies(topicIds);
  const likesMap = batchLoadForumLikes(topicIds, request.currentUser.id);
  response.json({ topics: topics.map((t) => serializeForumTopic(t, repliesMap, likesMap)) });
});

// 热门话题标签
app.get('/api/forum/hashtags', requireAuth, (_request, response) => {
  const rows = db.prepare('SELECT hashtags FROM forum_topics WHERE hashtags != "[]"').all();
  const countMap = {};
  rows.forEach((row) => {
    const tags = safeJsonParse(row.hashtags, []);
    tags.forEach((tag) => { countMap[tag] = (countMap[tag] || 0) + 1; });
  });
  const sorted = Object.entries(countMap).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([name, count]) => ({ name, count }));
  response.json({ hashtags: sorted });
});

// ── 成就系统 ──

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

app.get('/api/achievements', requireAuth, (request, response) => {
  const achievements = db.prepare('SELECT * FROM achievements ORDER BY id').all();
  const unlocked = db.prepare('SELECT achievement_id, unlocked_at FROM user_achievements WHERE user_id = ?').all(request.currentUser.id);
  const unlockMap = new Map(unlocked.map((u) => [u.achievement_id, u.unlocked_at]));
  response.json({
    achievements: achievements.map((a) => ({
      id: a.id,
      code: a.code,
      title: a.title,
      description: a.description,
      icon: a.icon,
      unlocked: unlockMap.has(a.id),
      unlockedAt: unlockMap.get(a.id) || null
    }))
  });
});

// 手动解锁成就（用于专注计时器等前端触发的成就）
app.post('/api/achievements/unlock', requireAuth, (request, response) => {
  const { code, value } = request.body;
  const ach = db.prepare('SELECT * FROM achievements WHERE code = ?').get(code);
  if (!ach) { response.json({ unlocked: false }); return; }

  const alreadyUnlocked = db.prepare('SELECT id FROM user_achievements WHERE user_id = ? AND achievement_id = ?').get(request.currentUser.id, ach.id);
  if (alreadyUnlocked) { response.json({ unlocked: false }); return; }

  if (ach.condition_type === 'focus_minutes' && value >= ach.condition_value) {
    db.prepare('INSERT INTO user_achievements (user_id, achievement_id, unlocked_at) VALUES (?, ?, ?)').run(request.currentUser.id, ach.id, dayjs().toISOString());
    response.json({ unlocked: true, achievement: { id: ach.id, code: ach.code, title: ach.title, icon: ach.icon } });
    return;
  }
  if (ach.condition_type === 'early_bird' && value >= 1) {
    db.prepare('INSERT INTO user_achievements (user_id, achievement_id, unlocked_at) VALUES (?, ?, ?)').run(request.currentUser.id, ach.id, dayjs().toISOString());
    response.json({ unlocked: true, achievement: { id: ach.id, code: ach.code, title: ach.title, icon: ach.icon } });
    return;
  }

  response.json({ unlocked: false });
});

// 学习数据详细统计
app.get('/api/practice/stats/detailed', requireStudent, (request, response) => {
  const studentId = request.currentUser.id;

  // 概览
  const overview = db.prepare(`
    SELECT
      COUNT(*) AS totalAttempts,
      SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correctAttempts,
      COALESCE(SUM(time_spent_ms), 0) AS totalTimeSpentMs
    FROM practice_records WHERE student_id = ?
  `).get(studentId);

  const totalSessions = db.prepare('SELECT COUNT(*) AS count FROM practice_sessions WHERE student_id = ?').get(studentId).count;
  const flashcardsLearned = db.prepare('SELECT COUNT(*) AS count FROM flashcard_records WHERE student_id = ? AND repetitions > 0').get(studentId).count;
  const accuracy = overview.totalAttempts > 0 ? Math.round((overview.correctAttempts / overview.totalAttempts) * 100) : 0;

  // 科目正确率
  const subjectAccuracy = db.prepare(`
    SELECT q.subject,
      COUNT(*) AS total,
      SUM(CASE WHEN pr.is_correct = 1 THEN 1 ELSE 0 END) AS correct,
      ROUND(SUM(CASE WHEN pr.is_correct = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 0) AS accuracy
    FROM practice_records pr
    JOIN questions q ON q.id = pr.question_id
    WHERE pr.student_id = ?
    GROUP BY q.subject
    ORDER BY total DESC
  `).all(studentId);

  // 每日活动
  const dailyActivity = db.prepare(`
    SELECT DATE(created_at) AS date,
      COUNT(*) AS questionsAnswered,
      SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correctCount,
      COALESCE(SUM(time_spent_ms), 0) AS timeSpentMs
    FROM practice_records
    WHERE student_id = ? AND created_at >= date('now', '-30 days')
    GROUP BY DATE(created_at)
    ORDER BY date
  `).all(studentId);

  // 最近会话
  const recentSessions = db.prepare(`
    SELECT * FROM practice_sessions WHERE student_id = ?
    ORDER BY started_at DESC LIMIT 10
  `).all(studentId);

  // 标签维度薄弱点分析
  const tagAccuracy = db.prepare(`
    SELECT qt.name AS tagName, qt.category AS tagCategory,
      COUNT(*) AS total,
      SUM(CASE WHEN pr.is_correct = 1 THEN 1 ELSE 0 END) AS correct,
      ROUND(SUM(CASE WHEN pr.is_correct = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 0) AS accuracy
    FROM practice_records pr
    JOIN question_tag_relations qtr ON qtr.question_id = pr.question_id
    JOIN question_tags qt ON qt.id = qtr.tag_id
    WHERE pr.student_id = ?
    GROUP BY qt.id
    HAVING total >= 2
    ORDER BY accuracy ASC
    LIMIT 15
  `).all(studentId);

  response.json({
    overview: {
      totalAttempts: overview.totalAttempts || 0,
      correctAttempts: overview.correctAttempts || 0,
      accuracy,
      flashcardsLearned,
      totalSessions,
      totalTimeSpentMs: overview.totalTimeSpentMs || 0
    },
    subjectAccuracy,
    dailyActivity,
    recentSessions,
    tagAccuracy
  });
});

// ── 周报 ──

app.get('/api/practice/stats/weekly', requireStudent, (request, response) => {
  const studentId = request.currentUser.id;
  const weekOffset = Number(request.query.weekOffset) || 0;
  const baseDate = dayjs().subtract(weekOffset, 'week');
  const weekStart = baseDate.startOf('week').add(1, 'day'); // 周一
  const weekEnd = weekStart.add(6, 'day').endOf('day');

  const stats = db.prepare(`
    SELECT COUNT(*) AS totalQuestions,
      SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correctCount,
      COALESCE(SUM(time_spent_ms), 0) AS totalTimeMs
    FROM practice_records
    WHERE student_id = ? AND created_at >= ? AND created_at <= ?
  `).get(studentId, weekStart.toISOString(), weekEnd.toISOString());

  const subjectBreakdown = db.prepare(`
    SELECT q.subject, COUNT(*) AS total,
      SUM(CASE WHEN pr.is_correct = 1 THEN 1 ELSE 0 END) AS correct,
      COALESCE(SUM(pr.time_spent_ms), 0) AS timeMs
    FROM practice_records pr JOIN questions q ON q.id = pr.question_id
    WHERE pr.student_id = ? AND pr.created_at >= ? AND pr.created_at <= ?
    GROUP BY q.subject ORDER BY total DESC
  `).all(studentId, weekStart.toISOString(), weekEnd.toISOString());

  const dailyBreakdown = db.prepare(`
    SELECT DATE(created_at) AS date, COUNT(*) AS total,
      SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct
    FROM practice_records
    WHERE student_id = ? AND created_at >= ? AND created_at <= ?
    GROUP BY DATE(created_at) ORDER BY date
  `).all(studentId, weekStart.toISOString(), weekEnd.toISOString());

  const flashcardCount = db.prepare(`
    SELECT COUNT(*) AS cnt FROM flashcard_records
    WHERE student_id = ? AND updated_at >= ? AND updated_at <= ?
  `).get(studentId, weekStart.toISOString(), weekEnd.toISOString()).cnt;

  const focusSessions = db.prepare(`
    SELECT COUNT(*) AS cnt FROM practice_sessions
    WHERE student_id = ? AND started_at >= ? AND started_at <= ?
  `).get(studentId, weekStart.toISOString(), weekEnd.toISOString()).cnt;

  response.json({
    weekStart: weekStart.format('YYYY-MM-DD'),
    weekEnd: weekEnd.format('YYYY-MM-DD'),
    totalQuestions: stats.totalQuestions || 0,
    correctCount: stats.correctCount || 0,
    accuracy: stats.totalQuestions > 0 ? Math.round((stats.correctCount / stats.totalQuestions) * 100) : 0,
    totalTimeMinutes: Math.round((stats.totalTimeMs || 0) / 60000),
    subjectBreakdown,
    dailyBreakdown,
    flashcardCount: flashcardCount || 0,
    focusSessions: focusSessions || 0
  });
});

// ── 月报 ──

app.get('/api/practice/stats/monthly', requireStudent, (request, response) => {
  const studentId = request.currentUser.id;
  const monthOffset = Number(request.query.monthOffset) || 0;
  const baseDate = dayjs().subtract(monthOffset, 'month');
  const monthStart = baseDate.startOf('month');
  const monthEnd = baseDate.endOf('month');

  const stats = db.prepare(`
    SELECT COUNT(*) AS totalQuestions,
      SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correctCount,
      COALESCE(SUM(time_spent_ms), 0) AS totalTimeMs
    FROM practice_records
    WHERE student_id = ? AND created_at >= ? AND created_at <= ?
  `).get(studentId, monthStart.toISOString(), monthEnd.toISOString());

  const subjectBreakdown = db.prepare(`
    SELECT q.subject, COUNT(*) AS total,
      SUM(CASE WHEN pr.is_correct = 1 THEN 1 ELSE 0 END) AS correct,
      COALESCE(SUM(pr.time_spent_ms), 0) AS timeMs
    FROM practice_records pr JOIN questions q ON q.id = pr.question_id
    WHERE pr.student_id = ? AND pr.created_at >= ? AND pr.created_at <= ?
    GROUP BY q.subject ORDER BY total DESC
  `).all(studentId, monthStart.toISOString(), monthEnd.toISOString());

  const dailyBreakdown = db.prepare(`
    SELECT DATE(created_at) AS date, COUNT(*) AS total,
      SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct
    FROM practice_records
    WHERE student_id = ? AND created_at >= ? AND created_at <= ?
    GROUP BY DATE(created_at) ORDER BY date
  `).all(studentId, monthStart.toISOString(), monthEnd.toISOString());

  const flashcardCount = db.prepare(`
    SELECT COUNT(*) AS cnt FROM flashcard_records
    WHERE student_id = ? AND updated_at >= ? AND updated_at <= ?
  `).get(studentId, monthStart.toISOString(), monthEnd.toISOString()).cnt;

  const summaryCount = db.prepare(
    `SELECT COUNT(*) AS cnt FROM summaries WHERE student_id = ? AND task_date >= ? AND task_date <= ?`
  ).get(studentId, monthStart.format('YYYY-MM-DD'), monthEnd.format('YYYY-MM-DD')).cnt;

  const activeDays = dailyBreakdown.length;

  response.json({
    month: monthStart.format('YYYY年MM月'),
    monthStart: monthStart.format('YYYY-MM-DD'),
    monthEnd: monthEnd.format('YYYY-MM-DD'),
    totalQuestions: stats.totalQuestions || 0,
    correctCount: stats.correctCount || 0,
    accuracy: stats.totalQuestions > 0 ? Math.round((stats.correctCount / stats.totalQuestions) * 100) : 0,
    totalTimeMinutes: Math.round((stats.totalTimeMs || 0) / 60000),
    subjectBreakdown,
    dailyBreakdown,
    activeDays,
    flashcardCount: flashcardCount || 0,
    summaryCount: summaryCount || 0
  });
});

// ── 最近观看课程 ──

app.get('/api/courses/recent', requireStudent, (request, response) => {
  const studentId = request.currentUser.id;
  const recent = db.prepare(`
    SELECT folder_items.*, course_progress.position_seconds, course_progress.duration_seconds, course_progress.updated_at AS last_watched_at
    FROM course_progress
    JOIN folder_items ON folder_items.id = course_progress.course_id
    WHERE course_progress.student_id = ? AND course_progress.position_seconds > 0
    ORDER BY course_progress.updated_at DESC LIMIT 10
  `).all(studentId);
  response.json({ items: recent });
});

// 打卡日历 + 连续天数
app.get('/api/study/streak', requireStudent, (request, response) => {
  const studentId = request.currentUser.id;
  const year = Number(request.query.year) || new Date().getFullYear();
  const month = Number(request.query.month) || new Date().getMonth() + 1;
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate = `${year}-${String(month).padStart(2, '0')}-31`;

  // 日历天数
  const calendarDays = db.prepare(`
    SELECT DISTINCT date_val AS date FROM (
      SELECT DATE(created_at) AS date_val FROM practice_records WHERE student_id = ? AND DATE(created_at) BETWEEN ? AND ?
      UNION ALL
      SELECT DATE(created_at) AS date_val FROM flashcard_records WHERE student_id = ? AND DATE(created_at) BETWEEN ? AND ?
      UNION ALL
      SELECT DATE(completed_at) AS date_val FROM task_completions WHERE student_id = ? AND completed_at IS NOT NULL AND DATE(completed_at) BETWEEN ? AND ?
    )
    ORDER BY date
  `).all(studentId, startDate, endDate, studentId, startDate, endDate, studentId, startDate, endDate);

  // 连续天数
  const streak = db.prepare('SELECT * FROM study_streaks WHERE student_id = ?').get(studentId);
  const monthDays = calendarDays.length;

  response.json({
    currentStreak: streak ? streak.current_streak : 0,
    longestStreak: streak ? streak.longest_streak : 0,
    lastStudyDate: streak ? streak.last_study_date : null,
    monthDays,
    calendarDays
  });
});

// 更新学习连续天数辅助函数
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

// 课程播放进度
app.get('/api/courses/:id/progress', requireAuth, (request, response) => {
  const row = db.prepare('SELECT position_seconds, duration_seconds, updated_at FROM course_progress WHERE course_id = ? AND student_id = ?')
    .get(request.params.id, request.currentUser.id);
  response.json(row ? { positionSeconds: row.position_seconds, durationSeconds: row.duration_seconds, updatedAt: row.updated_at } : { positionSeconds: 0, durationSeconds: 0 });
});

app.post('/api/courses/:id/progress', requireAuth, (request, response) => {
  const positionSeconds = Number(request.body.positionSeconds) || 0;
  const durationSeconds = Number(request.body.durationSeconds) || 0;
  db.prepare(`
    INSERT INTO course_progress (course_id, student_id, position_seconds, duration_seconds, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(course_id, student_id) DO UPDATE SET position_seconds = excluded.position_seconds, duration_seconds = excluded.duration_seconds, updated_at = excluded.updated_at
  `).run(request.params.id, request.currentUser.id, positionSeconds, durationSeconds, dayjs().toISOString());
  response.json({ ok: true });
});

app.post('/api/questions', requireTeacher, (request, response) => {
  questionUpload(request, response, (error) => {
    if (error) {
      response.status(400).json({ error: '题目录入失败。' });
      return;
    }

    const title = stripHtml(request.body.title);
    const stem = stripHtml(request.body.stem);
    const correctAnswer = String(request.body.correctAnswer || '').trim().toUpperCase();
    const options = ['A', 'B', 'C', 'D']
      .map((key) => ({ key, text: stripHtml(request.body[`option${key}`]) }))
      .filter((option) => option.text);

    if (!title || !stem || !correctAnswer || options.length < 2) {
      response.status(400).json({ error: '请完整填写题干、选项与正确答案。' });
      return;
    }

    if (!options.some((option) => option.key === correctAnswer)) {
      response.status(400).json({ error: '正确答案必须属于已有选项。' });
      return;
    }

    const questionResult = db.prepare(
      `
        INSERT INTO questions (
          title, subject, question_type, textbook, stem, options, correct_answer, analysis_text, analysis_video_path, analysis_video_url, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      title,
      sanitizeText(request.body.subject || '考研英语'),
      sanitizeText(request.body.questionType),
      sanitizeText(request.body.textbook),
      stem,
      JSON.stringify(options),
      correctAnswer,
      sanitizeText(request.body.analysisText),
      request.file ? toPublicPath(request.file.path) : '',
      String(request.body.analysisVideoUrl || '').trim(),
      request.currentUser.id,
      dayjs().toISOString()
    );

    response.json({ ok: true, id: questionResult.lastInsertRowid });
  });
});

// 题目标签管理
app.get('/api/questions/tags', requireAuth, (request, response) => {
  const tags = db.prepare('SELECT * FROM question_tags ORDER BY category, name').all();
  const tagsWithCount = tags.map((tag) => {
    const count = db.prepare('SELECT COUNT(*) AS count FROM question_tag_relations WHERE tag_id = ?').get(tag.id).count;
    return {
      id: tag.id,
      name: tag.name,
      category: tag.category,
      count,
      createdAt: tag.created_at
    };
  });
  response.json({ tags: tagsWithCount });
});

app.post('/api/questions/tags', requireTeacher, (request, response) => {
  const name = sanitizeText(request.body.name);
  const category = String(request.body.category || 'custom').trim();

  if (!name) {
    response.status(400).json({ error: '标签名称不能为空。' });
    return;
  }

  const existing = db.prepare('SELECT id FROM question_tags WHERE name = ?').get(name);
  if (existing) {
    response.status(400).json({ error: '标签已存在。' });
    return;
  }

  db.prepare('INSERT INTO question_tags (name, category, created_at) VALUES (?, ?, ?)').run(name, category, dayjs().toISOString());
  response.json({ ok: true });
});

// BUG-007: 标签删除改为仅管理员可用（标签是全局资源）
app.delete('/api/questions/tags/:id', requireAdmin, (request, response) => {
  db.prepare('DELETE FROM question_tag_relations WHERE tag_id = ?').run(request.params.id);
  db.prepare('DELETE FROM question_tags WHERE id = ?').run(request.params.id);
  response.json({ ok: true });
});

// 题目标签关联
app.post('/api/questions/:id/tags', requireTeacher, (request, response) => {
  const { tagIds } = request.body;
  if (!Array.isArray(tagIds)) {
    response.status(400).json({ error: 'tagIds 必须为数组。' });
    return;
  }

  const question = db.prepare('SELECT id FROM questions WHERE id = ?').get(request.params.id);
  if (!question) {
    response.status(404).json({ error: '题目不存在。' });
    return;
  }

  db.prepare('DELETE FROM question_tag_relations WHERE question_id = ?').run(request.params.id);
  const insertRelation = db.prepare('INSERT OR IGNORE INTO question_tag_relations (question_id, tag_id) VALUES (?, ?)');
  const insertMany = db.transaction((ids) => {
    ids.forEach((tagId) => insertRelation.run(request.params.id, tagId));
  });
  insertMany(tagIds);

  response.json({ ok: true });
});

// 词汇卡片 API
const { calculateNextReview, getInitialReviewParams } = require('./services/spacedRepetition');

function serializeFlashcard(row) {
  return {
    id: row.id,
    title: row.title,
    subject: row.subject,
    frontContent: row.front_content,
    frontImagePath: row.front_image_path,
    backContent: row.back_content,
    backImagePath: row.back_image_path,
    audioPath: row.audio_path,
    exampleSentence: row.example_sentence || '',
    wordRoot: row.word_root || '',
    affix: row.affix || '',
    collocations: safeJsonParse(row.collocations, []),
    phonetic: row.phonetic || '',
    tags: safeJsonParse(row.tags, []),
    createdBy: row.created_by,
    createdAt: row.created_at
  };
}

app.get('/api/flashcards', requireAuth, (request, response) => {
  const { subject } = request.query;
  let query = 'SELECT * FROM flashcards';
  const params = [];

  if (subject) {
    query += ' WHERE subject = ?';
    params.push(subject);
  }

  query += ' ORDER BY created_at DESC LIMIT 500';
  const flashcards = db.prepare(query).all(...params).map(serializeFlashcard);
  response.json({ flashcards });
});

app.get('/api/flashcards/due', requireStudent, (request, response) => {
  const today = dayjs().format('YYYY-MM-DD');
  const flashcards = db.prepare(
    `SELECT f.*, fr.quality, fr.ease_factor, fr.interval_days, fr.repetitions, fr.next_review_date
     FROM flashcards f
     LEFT JOIN flashcard_records fr ON fr.flashcard_id = f.id AND fr.student_id = ?
     WHERE fr.next_review_date IS NULL OR fr.next_review_date <= ?
     ORDER BY f.created_at DESC`
  ).all(request.currentUser.id, today).map((row) => ({
    ...serializeFlashcard(row),
    record: row.quality !== null ? {
      quality: row.quality,
      easeFactor: row.ease_factor,
      intervalDays: row.interval_days,
      repetitions: row.repetitions,
      nextReviewDate: row.next_review_date
    } : null
  }));

  response.json({ flashcards });
});

app.post('/api/flashcards', requireTeacher, (request, response) => {
  const title = sanitizeText(request.body.title);
  const frontContent = sanitizeText(request.body.frontContent);
  const backContent = sanitizeText(request.body.backContent);

  if (!title || !frontContent || !backContent) {
    response.status(400).json({ error: '请填写标题、正面和背面内容。' });
    return;
  }

  const flashcardResult = db.prepare(
    `INSERT INTO flashcards (title, subject, front_content, back_content, example_sentence, tags, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    title,
    sanitizeText(request.body.subject),
    frontContent,
    backContent,
    sanitizeText(request.body.exampleSentence || ''),
    JSON.stringify(request.body.tags || []),
    request.currentUser.id,
    dayjs().toISOString()
  );

  response.json({ ok: true, id: flashcardResult.lastInsertRowid });
});

app.post('/api/flashcards/:id/review', requireStudent, (request, response) => {
  const quality = Number(request.body.quality);
  if (![0, 1, 2, 3].includes(quality)) {
    response.status(400).json({ error: 'quality 必须为 0-3。' });
    return;
  }

  const flashcard = db.prepare('SELECT * FROM flashcards WHERE id = ?').get(request.params.id);
  if (!flashcard) {
    response.status(404).json({ error: '卡片不存在。' });
    return;
  }

  const existing = db.prepare('SELECT * FROM flashcard_records WHERE flashcard_id = ? AND student_id = ?').get(request.params.id, request.currentUser.id);

  let currentEase = existing ? existing.ease_factor : 2.5;
  let currentInterval = existing ? existing.interval_days : 0;
  let currentReps = existing ? existing.repetitions : 0;

  const next = calculateNextReview(quality, currentEase, currentInterval, currentReps);

  if (existing) {
    db.prepare(
      `UPDATE flashcard_records SET quality = ?, ease_factor = ?, interval_days = ?, repetitions = ?, next_review_date = ? WHERE id = ?`
    ).run(quality, next.easeFactor, next.interval, next.repetitions, next.nextReviewDate, existing.id);
  } else {
    db.prepare(
      `INSERT INTO flashcard_records (flashcard_id, student_id, quality, ease_factor, interval_days, repetitions, next_review_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(request.params.id, request.currentUser.id, quality, next.easeFactor, next.interval, next.repetitions, next.nextReviewDate, dayjs().toISOString());
  }

  updateStudyStreak(request.currentUser.id);
  checkAndUnlockAchievements(request.currentUser.id);

  response.json({ ok: true, nextReview: next });
});

// 练习会话 API
app.get('/api/practice/sessions', requireStudent, (request, response) => {
  const sessions = db.prepare(
    'SELECT * FROM practice_sessions WHERE student_id = ? ORDER BY started_at DESC LIMIT 20'
  ).all(request.currentUser.id).map((row) => ({
    id: row.id,
    sessionType: row.session_type,
    subjectFilter: row.subject_filter,
    totalQuestions: row.total_questions,
    correctCount: row.correct_count,
    startedAt: row.started_at,
    endedAt: row.ended_at
  }));

  response.json({ sessions });
});

app.post('/api/practice/sessions', requireStudent, (request, response) => {
  const sessionId = crypto.randomUUID();
  const sessionType = String(request.body.sessionType || 'mixed').trim();
  const subjectFilter = String(request.body.subjectFilter || '').trim();

  db.prepare(
    'INSERT INTO practice_sessions (id, student_id, session_type, subject_filter, started_at) VALUES (?, ?, ?, ?, ?)'
  ).run(sessionId, request.currentUser.id, sessionType, subjectFilter, dayjs().toISOString());

  response.json({ ok: true, sessionId });
});

app.post('/api/practice/sessions/:id/end', requireStudent, (request, response) => {
  const session = db.prepare('SELECT * FROM practice_sessions WHERE id = ? AND student_id = ?').get(request.params.id, request.currentUser.id);
  if (!session) {
    response.status(404).json({ error: '练习会话不存在。' });
    return;
  }

  const { totalQuestions, correctCount } = request.body;
  db.prepare(
    'UPDATE practice_sessions SET total_questions = ?, correct_count = ?, ended_at = ? WHERE id = ?'
  ).run(Number(totalQuestions || 0), Number(correctCount || 0), dayjs().toISOString(), request.params.id);

  response.json({ ok: true });
});

app.get('/api/practice/stats', requireStudent, (request, response) => {
  const totalAttempts = db.prepare('SELECT COUNT(*) AS count FROM practice_records WHERE student_id = ?').get(request.currentUser.id).count;
  const correctAttempts = db.prepare('SELECT COUNT(*) AS count FROM practice_records WHERE student_id = ? AND is_correct = 1').get(request.currentUser.id).count;
  const flashcardsLearned = db.prepare('SELECT COUNT(*) AS count FROM flashcard_records WHERE student_id = ? AND repetitions > 0').get(request.currentUser.id).count;

  response.json({
    totalAttempts,
    correctAttempts,
    accuracy: totalAttempts > 0 ? Math.round((correctAttempts / totalAttempts) * 100) : 0,
    flashcardsLearned
  });
});

app.post('/api/questions/:id/answer', requireStudent, (request, response) => {
  const selectedAnswer = String(request.body.selectedAnswer || '').trim().toUpperCase();
  const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(request.params.id);

  if (!question) {
    response.status(404).json({ error: '题目不存在。' });
    return;
  }

  if (!selectedAnswer) {
    response.status(400).json({ error: '请选择一个答案。' });
    return;
  }

  const isCorrect = selectedAnswer === question.correct_answer ? 1 : 0;
  const sessionId = String(request.body.sessionId || '').trim();
  const timeSpentMs = Number(request.body.timeSpentMs) || 0;
  db.prepare(
    `
      INSERT INTO practice_records (question_id, student_id, selected_answer, is_correct, session_id, time_spent_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
  ).run(question.id, request.currentUser.id, selectedAnswer, isCorrect, sessionId, timeSpentMs, dayjs().toISOString());

  updateStudyStreak(request.currentUser.id);
  checkAndUnlockAchievements(request.currentUser.id);

  // 错题智能复习调度（3/7/15天间隔）
  if (!isCorrect) {
    const now = dayjs();
    const intervals = [3, 7, 15];
    for (const days of intervals) {
      db.prepare(
        'INSERT INTO wrong_review_schedule (question_id, student_id, review_date, review_round, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(question.id, request.currentUser.id, now.add(days, 'day').format('YYYY-MM-DD'), days === 3 ? 1 : (days === 7 ? 2 : 3), now.toISOString());
    }
  }

  response.json({
    ok: true,
    result: {
      isCorrect: Boolean(isCorrect),
      correctAnswer: question.correct_answer,
      analysisText: question.analysis_text,
      analysisVideoPath: question.analysis_video_path,
      analysisVideoUrl: question.analysis_video_url
    }
  });
});

// 题库筛选（学生可用）
app.get('/api/questions', requireAuth, (request, response) => {
  const { subject, questionType, textbook, tagId, page, limit, mode } = request.query;
  const maxLimit = Math.min(Number(limit) || 20, 100);
  const skip = (Number(page) || 1 - 1) * maxLimit;

  let query = `
    SELECT questions.*, users.display_name AS creator_name
    FROM questions
    LEFT JOIN users ON users.id = questions.created_by
  `;
  const params = [];
  const conditions = [];

  if (subject) { conditions.push('questions.subject = ?'); params.push(subject); }
  if (questionType) { conditions.push('questions.question_type = ?'); params.push(questionType); }
  if (textbook) { conditions.push('questions.textbook = ?'); params.push(textbook); }
  if (tagId) {
    query += ' JOIN question_tag_relations ON question_tag_relations.question_id = questions.id ';
    conditions.push('question_tag_relations.tag_id = ?');
    params.push(Number(tagId));
  }

  const studentId = request.currentUser.role === 'student' ? request.currentUser.id : null;

  // 练习模式
  if (mode === 'untried' && studentId) {
    conditions.push('questions.id NOT IN (SELECT question_id FROM practice_records WHERE student_id = ?)');
    params.push(studentId);
  }

  if (conditions.length) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  const countResult = db.prepare(`SELECT COUNT(*) AS total FROM (${query})`).get(...params);

  if (mode === 'random') {
    query += ' ORDER BY RANDOM()';
  } else {
    query += ' ORDER BY questions.created_at DESC';
  }
  query += ' LIMIT ? OFFSET ?';
  params.push(maxLimit, skip);

  const questions = db.prepare(query).all(...params);

  const results = questions.map((q) => {
    let latestRecord = null;
    if (studentId) {
      latestRecord = db.prepare(
        'SELECT selected_answer, is_correct, created_at FROM practice_records WHERE question_id = ? AND student_id = ? ORDER BY created_at DESC LIMIT 1'
      ).get(q.id, studentId);
    }
    const row = serializeQuestionForStudent(q, latestRecord);
    if (studentId) {
      const fav = db.prepare('SELECT id FROM question_favorites WHERE question_id = ? AND student_id = ?').get(q.id, studentId);
      row.favorited = !!fav;
    }
    return row;
  });

  response.json({ questions: results, totalCount: countResult.total, page: Number(page) || 1, limit: maxLimit });
});

// 题目收藏切换
app.post('/api/questions/:id/favorite', requireStudent, (request, response) => {
  const question = db.prepare('SELECT id FROM questions WHERE id = ?').get(request.params.id);
  if (!question) { response.status(404).json({ error: '题目不存在。' }); return; }

  const existing = db.prepare('SELECT id FROM question_favorites WHERE question_id = ? AND student_id = ?').get(request.params.id, request.currentUser.id);
  let favorited;
  if (existing) {
    db.prepare('DELETE FROM question_favorites WHERE id = ?').run(existing.id);
    favorited = false;
  } else {
    db.prepare('INSERT INTO question_favorites (question_id, student_id, created_at) VALUES (?, ?, ?)').run(request.params.id, request.currentUser.id, dayjs().toISOString());
    favorited = true;
  }
  response.json({ favorited });
});

// 收藏题目列表
app.get('/api/questions/favorites', requireStudent, (request, response) => {
  const { subject } = request.query;
  let query = `
    SELECT questions.*, question_favorites.created_at AS favorited_at
    FROM question_favorites
    JOIN questions ON questions.id = question_favorites.question_id
    WHERE question_favorites.student_id = ?
  `;
  const params = [request.currentUser.id];
  if (subject) { query += ' AND questions.subject = ?'; params.push(subject); }
  query += ' ORDER BY question_favorites.created_at DESC LIMIT 100';

  const rows = db.prepare(query).all(...params);
  const questions = rows.map((r) => {
    const latestRecord = db.prepare(
      'SELECT selected_answer, is_correct, created_at FROM practice_records WHERE question_id = ? AND student_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(r.id, request.currentUser.id);
    const serialized = serializeQuestionForStudent(r, latestRecord);
    serialized.favorited = true;
    return serialized;
  });
  response.json({ questions });
});

// 错题列表（增加 subject 筛选）
app.get('/api/practice/wrong', requireStudent, (request, response) => {
  const { subject } = request.query;
  let query = `
    SELECT questions.*, practice_records.selected_answer, practice_records.created_at AS answered_at
    FROM practice_records
    JOIN questions ON questions.id = practice_records.question_id
    WHERE practice_records.student_id = ? AND practice_records.is_correct = 0
  `;
  const params = [request.currentUser.id];
  if (subject) { query += ' AND questions.subject = ?'; params.push(subject); }
  query += ' ORDER BY practice_records.created_at DESC LIMIT 50';

  const rows = db.prepare(query).all(...params);
  response.json({
    questions: rows.map((row) => ({
      ...serializeQuestionForStudent(row, null),
      selectedAnswer: row.selected_answer,
      answeredAt: row.answered_at
    }))
  });
});

// 题库筛选元数据
app.get('/api/questions/meta', requireAuth, (request, response) => {
  const subjects = db.prepare("SELECT DISTINCT subject FROM questions WHERE subject != '' ORDER BY subject").all().map((r) => r.subject);
  const types = db.prepare("SELECT DISTINCT question_type FROM questions WHERE question_type != '' ORDER BY question_type").all().map((r) => r.question_type);
  const textbooks = db.prepare("SELECT DISTINCT textbook FROM questions WHERE textbook != '' ORDER BY textbook").all().map((r) => r.textbook);
  const tags = db.prepare('SELECT id, name, category FROM question_tags ORDER BY name').all();
  response.json({ subjects, types, textbooks, tags });
});

app.post('/api/products', requireTeacher, (request, response) => {
  productUpload(request, response, (error) => {
    if (error) {
      response.status(400).json({ error: '商品上传失败。' });
      return;
    }

    const title = sanitizeText(request.body.title);
    const price = Number(request.body.price || 0);
    const stock = Number(request.body.stock || 0);

    if (!title || Number.isNaN(price) || price <= 0 || Number.isNaN(stock) || stock < 0) {
      response.status(400).json({ error: '请完整填写商品标题、价格与库存。' });
      return;
    }

    const productResult = db.prepare(
      `
        INSERT INTO products (title, description, price, stock, image_path, category, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      title,
      sanitizeText(request.body.description),
      price,
      stock,
      request.file ? toPublicPath(request.file.path) : '',
      sanitizeText(request.body.category || ''),
      request.currentUser.id,
      dayjs().toISOString()
    );

    response.json({ ok: true, id: productResult.lastInsertRowid });
  });
});

app.post('/api/orders', requireStudent, (request, response) => {
  const productId = Number(request.body.productId);
  const rawQuantity = request.body.quantity !== undefined ? request.body.quantity : 1;
  const quantity = Number(rawQuantity);
  const shippingAddress = sanitizeText(request.body.shippingAddress);
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);

  if (!product) {
    response.status(404).json({ error: '商品不存在。' });
    return;
  }

  if (!shippingAddress || Number.isNaN(quantity) || quantity <= 0 || !Number.isInteger(quantity)) {
    response.status(400).json({ error: '请填写有效的正整数数量和收货地址。' });
    return;
  }

  // BUG-015: 使用分计算避免浮点精度问题
  const totalAmount = Math.round(product.price * 100 * quantity) / 100;
  const now = dayjs().toISOString();
  const transaction = db.transaction(() => {
    const stockResult = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?').run(quantity, productId, quantity);
    if (!stockResult.changes) {
      throw new Error('库存不足。');
    }
    db.prepare(
      `
        INSERT INTO orders (product_id, student_id, quantity, total_amount, shipping_address, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'paid', ?)
      `
    ).run(productId, request.currentUser.id, quantity, totalAmount, shippingAddress, now);
  });

  try {
    transaction();
  } catch (error) {
    response.status(400).json({ error: error.message || '库存不足。' });
    return;
  }
  response.json({ ok: true });
});

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

// ── 课程笔记 ──

app.get('/api/courses/:id/notes', requireAuth, (request, response) => {
  const notes = db.prepare(
    'SELECT * FROM course_notes WHERE item_id = ? AND student_id = ? ORDER BY timestamp_seconds ASC'
  ).all(request.params.id, request.currentUser.id);
  response.json({ notes });
});

app.post('/api/courses/:id/notes', requireAuth, (request, response) => {
  const content = stripHtml(request.body.content);
  if (!content) { response.status(400).json({ error: '笔记内容不能为空。' }); return; }
  db.prepare(
    'INSERT INTO course_notes (item_id, student_id, content, timestamp_seconds, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(request.params.id, request.currentUser.id, content, Number(request.body.timestampSeconds) || 0, dayjs().toISOString());
  response.json({ ok: true });
});

app.delete('/api/courses/:id/notes/:noteId', requireAuth, (request, response) => {
  db.prepare('DELETE FROM course_notes WHERE id = ? AND student_id = ?').run(request.params.noteId, request.currentUser.id);
  response.json({ ok: true });
});

// ── 课程评价 ──

app.get('/api/courses/:id/reviews', requireAuth, (request, response) => {
  const reviews = db.prepare(
    `SELECT course_reviews.*, users.display_name AS student_name
     FROM course_reviews
     LEFT JOIN users ON users.id = course_reviews.student_id
     WHERE course_reviews.item_id = ? ORDER BY course_reviews.created_at DESC`
  ).all(request.params.id);
  const myReview = db.prepare('SELECT * FROM course_reviews WHERE item_id = ? AND student_id = ?').get(request.params.id, request.currentUser.id);
  response.json({ reviews, myReview });
});

app.post('/api/courses/:id/reviews', requireAuth, (request, response) => {
  const rating = Number(request.body.rating);
  if (!rating || rating < 1 || rating > 5) { response.status(400).json({ error: '评分须为1-5。' }); return; }
  db.prepare(
    `INSERT INTO course_reviews (item_id, student_id, rating, content, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(item_id, student_id) DO UPDATE SET rating = excluded.rating, content = excluded.content, created_at = excluded.created_at`
  ).run(request.params.id, request.currentUser.id, rating, stripHtml(request.body.content || ''), dayjs().toISOString());
  response.json({ ok: true });
});

// ── 购物车 ──

app.get('/api/cart', requireStudent, (request, response) => {
  const items = db.prepare(
    `SELECT shopping_cart.*, products.title, products.price, products.image_path, products.stock
     FROM shopping_cart
     LEFT JOIN products ON products.id = shopping_cart.product_id
     WHERE shopping_cart.student_id = ? ORDER BY shopping_cart.created_at DESC`
  ).all(request.currentUser.id);
  response.json({ items });
});

app.post('/api/cart', requireStudent, (request, response) => {
  const productId = Number(request.body.productId);
  const quantity = Number(request.body.quantity) || 1;
  const product = db.prepare('SELECT id, stock FROM products WHERE id = ?').get(productId);
  if (!product) { response.status(404).json({ error: '商品不存在。' }); return; }
  db.prepare(
    `INSERT INTO shopping_cart (student_id, product_id, quantity, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(student_id, product_id) DO UPDATE SET quantity = MIN(excluded.quantity, ?)`
  ).run(request.currentUser.id, productId, quantity, dayjs().toISOString(), product.stock);
  response.json({ ok: true });
});

app.delete('/api/cart/:id', requireStudent, (request, response) => {
  db.prepare('DELETE FROM shopping_cart WHERE id = ? AND student_id = ?').run(request.params.id, request.currentUser.id);
  response.json({ ok: true });
});

app.post('/api/cart/checkout', requireStudent, (request, response) => {
  const addressId = Number(request.body.addressId);
  const address = db.prepare('SELECT * FROM address_book WHERE id = ? AND student_id = ?').get(addressId, request.currentUser.id);
  if (!address) { response.status(400).json({ error: '请选择收货地址。' }); return; }
  const cartItems = db.prepare(
    `SELECT shopping_cart.*, products.title AS product_title, products.price, products.stock
     FROM shopping_cart LEFT JOIN products ON products.id = shopping_cart.product_id
     WHERE shopping_cart.student_id = ?`
  ).all(request.currentUser.id);
  if (!cartItems.length) { response.status(400).json({ error: '购物车为空。' }); return; }

  const insertOrder = db.prepare(
    `INSERT INTO orders (product_id, student_id, quantity, total_amount, shipping_address, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'paid', ?)`
  );
  const updateStock = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?');
  const clearCart = db.prepare('DELETE FROM shopping_cart WHERE student_id = ?');

  const txn = db.transaction(() => {
    let created = 0;
    for (const item of cartItems) {
      if (item.stock < item.quantity) throw new Error(`${item.product_title} 库存不足。`);
      const totalCents = Math.round(item.price * 100) * item.quantity;
      insertOrder.run(item.product_id, request.currentUser.id, item.quantity, totalCents / 100, address.address, dayjs().toISOString());
      updateStock.run(item.quantity, item.product_id, item.quantity);
      created++;
    }
    clearCart.run(request.currentUser.id);
    return created;
  });

  try {
    const count = txn();
    response.json({ ok: true, created: count });
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

// ── 地址簿 ──

app.get('/api/addresses', requireStudent, (request, response) => {
  const addresses = db.prepare('SELECT * FROM address_book WHERE student_id = ? ORDER BY is_default DESC, created_at DESC').all(request.currentUser.id);
  response.json({ addresses });
});

app.post('/api/addresses', requireStudent, (request, response) => {
  const name = sanitizeText(request.body.name);
  const address = sanitizeText(request.body.address);
  if (!name || !address) { response.status(400).json({ error: '请填写姓名和地址。' }); return; }
  if (request.body.isDefault) {
    db.prepare('UPDATE address_book SET is_default = 0 WHERE student_id = ?').run(request.currentUser.id);
  }
  db.prepare(
    'INSERT INTO address_book (student_id, name, phone, address, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(request.currentUser.id, name, sanitizeText(request.body.phone || ''), address, request.body.isDefault ? 1 : 0, dayjs().toISOString());
  response.json({ ok: true });
});

app.delete('/api/addresses/:id', requireStudent, (request, response) => {
  db.prepare('DELETE FROM address_book WHERE id = ? AND student_id = ?').run(request.params.id, request.currentUser.id);
  response.json({ ok: true });
});

// ── 商品评价 ──

app.get('/api/products/:id/reviews', requireAuth, (request, response) => {
  const reviews = db.prepare(
    `SELECT product_reviews.*, users.display_name AS student_name
     FROM product_reviews LEFT JOIN users ON users.id = product_reviews.student_id
     WHERE product_reviews.product_id = ? ORDER BY product_reviews.created_at DESC`
  ).all(request.params.id);
  const avgRating = reviews.length ? (reviews.reduce((s, r) => s + r.rating, 0) / reviews.length).toFixed(1) : '0.0';
  response.json({ reviews, avgRating, totalReviews: reviews.length });
});

app.post('/api/products/:id/reviews', requireStudent, (request, response) => {
  const rating = Number(request.body.rating);
  if (!rating || rating < 1 || rating > 5) { response.status(400).json({ error: '评分须为1-5。' }); return; }
  const order = db.prepare(
    `SELECT id FROM orders WHERE product_id = ? AND student_id = ? AND status = 'confirmed'`
  ).get(request.params.id, request.currentUser.id);
  if (!order) { response.status(400).json({ error: '只有确认收货后才能评价。' }); return; }
  db.prepare(
    'INSERT INTO product_reviews (product_id, student_id, rating, content, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(request.params.id, request.currentUser.id, rating, stripHtml(request.body.content || ''), dayjs().toISOString());
  response.json({ ok: true });
});

// ── 直播预约 ──

app.post('/api/live-sessions/:id/reserve', requireStudent, (request, response) => {
  const session = db.prepare('SELECT id, status FROM live_sessions WHERE id = ?').get(request.params.id);
  if (!session) { response.status(404).json({ error: '直播不存在。' }); return; }
  db.prepare(
    'INSERT OR IGNORE INTO live_reservations (live_session_id, student_id, created_at) VALUES (?, ?, ?)'
  ).run(request.params.id, request.currentUser.id, dayjs().toISOString());
  response.json({ ok: true });
});

app.delete('/api/live-sessions/:id/reserve', requireStudent, (request, response) => {
  db.prepare('DELETE FROM live_reservations WHERE live_session_id = ? AND student_id = ?').run(request.params.id, request.currentUser.id);
  response.json({ ok: true });
});

// ── 直播禁言（教师端） ──

app.post('/api/live-sessions/:id/mute', requireTeacher, (request, response) => {
  const userId = Number(request.body.userId);
  if (!userId) { response.status(400).json({ error: '参数错误。' }); return; }
  const duration = Number(request.body.durationMinutes) || 10;
  const mutedUntil = dayjs().add(duration, 'minute').toISOString();
  db.prepare('UPDATE users SET openid = ? WHERE id = ?').run('MUTED:' + mutedUntil, userId);
  response.json({ ok: true, mutedUntil });
});

// ── 每日推荐题目 ──

app.get('/api/questions/daily', requireStudent, (request, response) => {
  const studentId = request.currentUser.id;
  // 错题 + 未做题混合推荐
  const wrongQuestions = db.prepare(
    `SELECT question_id, COUNT(*) AS wrong_count FROM practice_records
     WHERE student_id = ? AND is_correct = 0 GROUP BY question_id
     ORDER BY wrong_count DESC LIMIT 10`
  ).all(studentId).map((r) => r.question_id);

  const untriedLimit = 10 - wrongQuestions.length;
  let untried = [];
  if (untriedLimit > 0) {
    untried = db.prepare(
      `SELECT id FROM questions WHERE id NOT IN (
        SELECT DISTINCT question_id FROM practice_records WHERE student_id = ?
      ) ORDER BY RANDOM() LIMIT ?`
    ).all(studentId, untriedLimit).map((r) => r.id);
  }

  const ids = [...wrongQuestions, ...untried];
  if (!ids.length) { response.json({ questions: [] }); return; }

  const placeholders = ids.map(() => '?').join(',');
  const questions = db.prepare(
    `SELECT * FROM questions WHERE id IN (${placeholders})`
  ).all(...ids);

  const results = questions.map((q) => {
    const latestRecord = db.prepare(
      'SELECT selected_answer, is_correct, created_at FROM practice_records WHERE question_id = ? AND student_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(q.id, studentId);
    const row = serializeQuestionForStudent(q, latestRecord);
    const fav = db.prepare('SELECT id FROM question_favorites WHERE question_id = ? AND student_id = ?').get(q.id, studentId);
    row.favorited = !!fav;
    return row;
  });

  response.json({ questions: results });
});

// ── 全局搜索 ──

app.get('/api/search', requireAuth, (request, response) => {
  const keyword = String(request.query.q || '').trim();
  if (!keyword || keyword.length < 2) { response.json({ topics: [], questions: [], items: [] }); return; }
  const like = '%' + keyword + '%';

  const topics = db.prepare(
    `SELECT forum_topics.id, forum_topics.title, forum_topics.created_at, users.display_name AS author_name
     FROM forum_topics LEFT JOIN users ON users.id = forum_topics.user_id
     WHERE forum_topics.title LIKE ? OR forum_topics.content LIKE ?
     ORDER BY forum_topics.created_at DESC LIMIT 10`
  ).all(like, like);

  const questions = db.prepare(
    `SELECT id, title, subject FROM questions WHERE title LIKE ? OR stem LIKE ?
     ORDER BY created_at DESC LIMIT 10`
  ).all(like, like);

  const items = db.prepare(
    `SELECT id, title, subject, item_type FROM folder_items WHERE title LIKE ?
     ORDER BY created_at DESC LIMIT 10`
  ).all(like);

  response.json({ topics, questions, items });
  // 记录搜索历史
  try {
    db.prepare('INSERT INTO search_logs (user_id, keyword, created_at) VALUES (?, ?, ?)').run(request.currentUser.id, keyword, dayjs().toISOString());
  } catch (_) {}
});

// ── 热门搜索词 ──

app.get('/api/search/hot', requireAuth, (request, response) => {
  const keywords = db.prepare(
    `SELECT keyword, COUNT(*) AS cnt FROM search_logs
     WHERE created_at >= date('now', '-7 days')
     GROUP BY keyword ORDER BY cnt DESC LIMIT 10`
  ).all();
  response.json({ keywords });
});

// ── 闪卡每日目标 ──

app.get('/api/flashcards/goal', requireStudent, (request, response) => {
  const goal = db.prepare('SELECT * FROM flashcard_goals WHERE student_id = ?').get(request.currentUser.id);
  response.json({ goal: goal || { daily_new: 20, daily_review: 50 } });
});

app.post('/api/flashcards/goal', requireStudent, (request, response) => {
  const dailyNew = Math.max(1, Math.min(200, Number(request.body.dailyNew) || 20));
  const dailyReview = Math.max(1, Math.min(500, Number(request.body.dailyReview) || 50));
  db.prepare(
    `INSERT INTO flashcard_goals (student_id, daily_new, daily_review, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(student_id) DO UPDATE SET daily_new = excluded.daily_new, daily_review = excluded.daily_review, updated_at = excluded.updated_at`
  ).run(request.currentUser.id, dailyNew, dailyReview, dayjs().toISOString());
  response.json({ ok: true });
});

// ===== 第二阶段新 API =====

// ── 论坛置顶/精华 ──
app.post('/api/forum/topics/:id/pin', requireAuth, (request, response) => {
  if (request.currentUser.role !== 'teacher' && request.currentUser.role !== 'admin') {
    return response.status(403).json({ error: '无权限操作。' });
  }
  const pinned = Number(request.body.pinned) || 0;
  db.prepare('UPDATE forum_topics SET is_pinned = ? WHERE id = ?').run(pinned, request.params.id);
  response.json({ ok: true });
});

app.post('/api/forum/topics/:id/feature', requireAuth, (request, response) => {
  if (request.currentUser.role !== 'teacher' && request.currentUser.role !== 'admin') {
    return response.status(403).json({ error: '无权限操作。' });
  }
  const featured = Number(request.body.featured) || 0;
  db.prepare('UPDATE forum_topics SET is_featured = ? WHERE id = ?').run(featured, request.params.id);
  response.json({ ok: true });
});

// ── 论坛赞同 ──
app.post('/api/forum/topics/:id/endorse', requireAuth, (request, response) => {
  const topicId = Number(request.params.id);
  const userId = request.currentUser.id;
  const existing = db.prepare('SELECT id FROM forum_endorsements WHERE topic_id = ? AND user_id = ?').get(topicId, userId);
  if (existing) {
    db.prepare('DELETE FROM forum_endorsements WHERE id = ?').run(existing.id);
    response.json({ endorsed: false });
  } else {
    db.prepare('INSERT INTO forum_endorsements (topic_id, user_id, created_at) VALUES (?, ?, ?)').run(topicId, userId, dayjs().toISOString());
    response.json({ endorsed: true });
  }
});

// ── 论坛热门话题 ──
app.get('/api/forum/trending', requireAuth, (_request, response) => {
  // 计算热门分数并更新
  const now = dayjs();
  const topics = db.prepare(`
    SELECT forum_topics.id, forum_topics.title,
      (SELECT COUNT(*) FROM forum_likes WHERE topic_id = forum_topics.id) AS likes,
      (SELECT COUNT(*) FROM forum_replies WHERE topic_id = forum_topics.id) AS replies,
      (SELECT COUNT(*) FROM forum_endorsements WHERE topic_id = forum_topics.id) AS endorsements,
      julianday(?) - julianday(forum_topics.created_at) AS days_since
    FROM forum_topics
    WHERE julianday(?) - julianday(forum_topics.created_at) <= 7
  `).all(now.toISOString(), now.toISOString());

  const trending = topics.map((t) => {
    const days = Math.max(t.days_since, 0.5);
    const score = (t.likes * 2 + t.replies * 3 + t.endorsements * 2) / days;
    return { id: t.id, title: t.title, score: Math.round(score * 100) / 100, likes: t.likes, replies: t.replies };
  }).sort((a, b) => b.score - a.score).slice(0, 20);

  response.json({ trending });
});

// ── 用户关注系统 ──
app.post('/api/users/:id/follow', requireAuth, (request, response) => {
  const followingId = Number(request.params.id);
  const followerId = request.currentUser.id;
  if (followingId === followerId) { return response.status(400).json({ error: '不能关注自己。' }); }
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(followingId);
  if (!target) { return response.status(404).json({ error: '用户不存在。' }); }

  const existing = db.prepare('SELECT id FROM user_follows WHERE follower_id = ? AND following_id = ?').get(followerId, followingId);
  if (existing) {
    db.prepare('DELETE FROM user_follows WHERE id = ?').run(existing.id);
    response.json({ following: false });
  } else {
    db.prepare('INSERT INTO user_follows (follower_id, following_id, created_at) VALUES (?, ?, ?)').run(followerId, followingId, dayjs().toISOString());
    response.json({ following: true });
  }
});

app.get('/api/users/:id/follow-status', requireAuth, (request, response) => {
  const targetId = Number(request.params.id);
  const userId = request.currentUser.id;
  const isFollowing = db.prepare('SELECT id FROM user_follows WHERE follower_id = ? AND following_id = ?').get(userId, targetId);
  const followerCount = db.prepare('SELECT COUNT(*) AS cnt FROM user_follows WHERE following_id = ?').get(targetId).cnt;
  const followingCount = db.prepare('SELECT COUNT(*) AS cnt FROM user_follows WHERE follower_id = ?').get(targetId).cnt;
  response.json({ isFollowing: !!isFollowing, followerCount, followingCount });
});

app.get('/api/users/:id/followers', requireAuth, (request, response) => {
  const userId = Number(request.params.id);
  const rows = db.prepare(`
    SELECT u.id, u.display_name, u.role FROM user_follows f
    JOIN users u ON u.id = f.follower_id WHERE f.following_id = ?
    ORDER BY f.created_at DESC LIMIT 50
  `).all(userId);
  response.json({ followers: rows });
});

app.get('/api/users/:id/following', requireAuth, (request, response) => {
  const userId = Number(request.params.id);
  const rows = db.prepare(`
    SELECT u.id, u.display_name, u.role FROM user_follows f
    JOIN users u ON u.id = f.following_id WHERE f.follower_id = ?
    ORDER BY f.created_at DESC LIMIT 50
  `).all(userId);
  response.json({ following: rows });
});

// ── 内容举报 ──
app.post('/api/reports', requireAuth, (request, response) => {
  const { targetType, targetId, reason } = request.body;
  if (!targetType || !targetId) { return response.status(400).json({ error: '缺少参数。' }); }
  db.prepare('INSERT INTO content_reports (reporter_id, target_type, target_id, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(
    request.currentUser.id, targetType, Number(targetId), sanitizeText(reason || ''), dayjs().toISOString()
  );
  response.json({ ok: true });
});

app.get('/api/reports', requireAuth, (request, response) => {
  if (request.currentUser.role !== 'teacher' && request.currentUser.role !== 'admin') {
    return response.status(403).json({ error: '无权限。' });
  }
  const status = request.query.status || 'pending';
  const reports = db.prepare(`
    SELECT cr.*, u.display_name AS reporter_name FROM content_reports cr
    LEFT JOIN users u ON u.id = cr.reporter_id
    WHERE cr.status = ? ORDER BY cr.created_at DESC LIMIT 50
  `).all(status);
  response.json({ reports });
});

app.post('/api/reports/:id/review', requireAuth, (request, response) => {
  if (request.currentUser.role !== 'teacher' && request.currentUser.role !== 'admin') {
    return response.status(403).json({ error: '无权限。' });
  }
  const action = request.body.action; // 'reviewed' or 'dismissed'
  if (!['reviewed', 'dismissed'].includes(action)) { return response.status(400).json({ error: '无效操作。' }); }
  db.prepare('UPDATE content_reports SET status = ? WHERE id = ?').run(action, request.params.id);
  response.json({ ok: true });
});

// ── 题目笔记 ──
app.get('/api/questions/:id/notes', requireAuth, (request, response) => {
  const note = db.prepare('SELECT * FROM question_notes WHERE question_id = ? AND student_id = ?').get(request.params.id, request.currentUser.id);
  response.json({ note: note || null });
});

app.post('/api/questions/:id/notes', requireAuth, (request, response) => {
  const content = sanitizeText(request.body.content || '');
  if (!content) { return response.status(400).json({ error: '笔记内容不能为空。' }); }
  const now = dayjs().toISOString();
  db.prepare(`
    INSERT INTO question_notes (question_id, student_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(question_id, student_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
  `).run(Number(request.params.id), request.currentUser.id, content, now, now);
  response.json({ ok: true });
});

app.delete('/api/questions/:id/notes', requireAuth, (request, response) => {
  db.prepare('DELETE FROM question_notes WHERE question_id = ? AND student_id = ?').run(Number(request.params.id), request.currentUser.id);
  response.json({ ok: true });
});

// ── 错题智能复习调度 ──
app.get('/api/practice/wrong-review', requireStudent, (request, response) => {
  const today = dayjs().format('YYYY-MM-DD');
  const reviews = db.prepare(`
    SELECT wrs.*, q.title, q.stem, q.options, q.correct_answer, q.analysis_text, q.subject, q.question_type
    FROM wrong_review_schedule wrs
    JOIN questions q ON q.id = wrs.question_id
    WHERE wrs.student_id = ? AND wrs.review_date <= ? AND wrs.is_done = 0
    ORDER BY wrs.review_date ASC LIMIT 50
  `).all(request.currentUser.id, today);

  const questions = reviews.map((r) => ({
    id: r.question_id,
    title: r.title,
    stem: r.stem,
    options: safeJsonParse(r.options, []),
    correctAnswer: r.correct_answer,
    analysisText: r.analysis_text,
    subject: r.subject,
    questionType: r.question_type,
    reviewRound: r.review_round,
    scheduleId: r.id
  }));
  response.json({ questions });
});

app.post('/api/practice/wrong-review/:id/done', requireStudent, (request, response) => {
  const scheduleId = Number(request.params.id);
  db.prepare('UPDATE wrong_review_schedule SET is_done = 1 WHERE id = ? AND student_id = ?').run(scheduleId, request.currentUser.id);
  response.json({ ok: true });
});

// ── 模拟考试 ──
app.get('/api/mock-exams', requireAuth, (request, response) => {
  const exams = db.prepare(`
    SELECT me.*, u.display_name AS creator_name FROM mock_exams me
    LEFT JOIN users u ON u.id = me.created_by
    ORDER BY me.created_at DESC LIMIT 50
  `).all();
  response.json({ exams });
});

app.post('/api/mock-exams', requireAuth, (request, response) => {
  if (request.currentUser.role !== 'teacher') { return response.status(403).json({ error: '无权限。' }); }
  const title = sanitizeText(request.body.title || '');
  const subject = sanitizeText(request.body.subject || '');
  const duration = Math.max(10, Number(request.body.durationMinutes) || 120);
  const questionIds = request.body.questionIds || [];
  if (!title || !questionIds.length) { return response.status(400).json({ error: '缺少参数。' }); }

  const result = db.prepare(
    'INSERT INTO mock_exams (title, subject, duration_minutes, question_ids, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(title, subject, duration, JSON.stringify(questionIds), request.currentUser.id, dayjs().toISOString());
  response.json({ ok: true, id: result.lastInsertRowid });
});

app.post('/api/mock-exams/:id/start', requireStudent, (request, response) => {
  const examId = Number(request.params.id);
  const exam = db.prepare('SELECT * FROM mock_exams WHERE id = ?').get(examId);
  if (!exam) { return response.status(404).json({ error: '考试不存在。' }); }

  const existing = db.prepare('SELECT * FROM mock_exam_submissions WHERE exam_id = ? AND student_id = ?').get(examId, request.currentUser.id);
  if (existing) { return response.json({ submission: existing, exam }); }

  const result = db.prepare(
    'INSERT INTO mock_exam_submissions (exam_id, student_id, started_at) VALUES (?, ?, ?)'
  ).run(examId, request.currentUser.id, dayjs().toISOString());
  const submission = db.prepare('SELECT * FROM mock_exam_submissions WHERE id = ?').get(result.lastInsertRowid);
  response.json({ submission, exam });
});

app.post('/api/mock-exams/:id/submit', requireStudent, (request, response) => {
  const examId = Number(request.params.id);
  const submission = db.prepare('SELECT * FROM mock_exam_submissions WHERE exam_id = ? AND student_id = ?').get(examId, request.currentUser.id);
  if (!submission) { return response.status(404).json({ error: '未开始考试。' }); }
  if (submission.submitted_at) { return response.status(400).json({ error: '已提交。' }); }

  const answers = request.body.answers || {};
  const timeSpent = Number(request.body.timeSpentMs) || 0;

  // 批量判分
  const exam = db.prepare('SELECT * FROM mock_exams WHERE id = ?').get(examId);
  const qIds = safeJsonParse(exam.question_ids, []);
  let score = 0;
  const totalScore = 100;
  const perQuestion = qIds.length > 0 ? totalScore / qIds.length : 0;

  qIds.forEach((qId) => {
    const question = db.prepare('SELECT correct_answer FROM questions WHERE id = ?').get(qId);
    if (question && answers[qId] === question.correct_answer) {
      score += perQuestion;
    }
  });

  db.prepare(
    'UPDATE mock_exam_submissions SET answers = ?, score = ?, time_spent_ms = ?, submitted_at = ? WHERE id = ?'
  ).run(JSON.stringify(answers), Math.round(score * 100) / 100, timeSpent, dayjs().toISOString(), submission.id);

  response.json({ ok: true, score: Math.round(score * 100) / 100, total: totalScore });
});

app.get('/api/mock-exams/:id/result', requireStudent, (request, response) => {
  const examId = Number(request.params.id);
  const exam = db.prepare('SELECT * FROM mock_exams WHERE id = ?').get(examId);
  const submission = db.prepare('SELECT * FROM mock_exam_submissions WHERE exam_id = ? AND student_id = ?').get(examId, request.currentUser.id);
  if (!exam || !submission) { return response.status(404).json({ error: '不存在。' }); }

  const qIds = safeJsonParse(exam.question_ids, []);
  const answers = safeJsonParse(submission.answers, {});
  const details = qIds.map((qId) => {
    const q = db.prepare('SELECT id, title, stem, options, correct_answer, analysis_text FROM questions WHERE id = ?').get(qId);
    if (!q) return null;
    return {
      id: q.id, title: q.title, stem: q.stem,
      options: safeJsonParse(q.options, []),
      correctAnswer: q.correct_answer,
      myAnswer: answers[qId] || '',
      isCorrect: answers[qId] === q.correct_answer,
      analysisText: q.analysis_text
    };
  }).filter(Boolean);

  response.json({
    exam: { title: exam.title, subject: exam.subject, durationMinutes: exam.duration_minutes },
    submission: { score: submission.score, timeSpentMs: submission.time_spent_ms, submittedAt: submission.submitted_at, startedAt: submission.started_at },
    details
  });
});

// ── 刷题热力图 ──
app.get('/api/practice/heatmap', requireStudent, (request, response) => {
  const year = request.query.year || dayjs().format('YYYY');
  const rows = db.prepare(`
    SELECT DATE(created_at) AS date, COUNT(*) AS count
    FROM practice_records WHERE student_id = ? AND strftime('%Y', created_at) = ?
    GROUP BY DATE(created_at) ORDER BY date
  `).all(request.currentUser.id, year);
  const heatmap = {};
  rows.forEach((r) => { heatmap[r.date] = r.count; });
  response.json({ heatmap, year });
});

// ── 随机组卷 ──
app.post('/api/questions/auto-paper', requireAuth, (request, response) => {
  const { subject, count, tags } = request.body;
  const numQ = Math.min(Math.max(Number(count) || 10, 1), 100);
  let query = 'SELECT id FROM questions WHERE 1=1';
  const params = [];
  if (subject) { query += ' AND subject = ?'; params.push(subject); }
  if (tags && tags.length) {
    query += ' AND id IN (SELECT question_id FROM question_tag_relations WHERE tag_id IN (' + tags.map(() => '?').join(',') + '))';
    params.push(...tags);
  }
  query += ' ORDER BY RANDOM() LIMIT ?';
  params.push(numQ);
  const questions = db.prepare(query).all(...params);
  response.json({ questionIds: questions.map((q) => q.id) });
});

// ── 考研倒计时 ──
app.get('/api/exam-countdown', requireAuth, (request, response) => {
  const row = db.prepare('SELECT * FROM exam_countdown WHERE student_id = ?').get(request.currentUser.id);
  response.json({ countdown: row || null });
});

app.post('/api/exam-countdown', requireAuth, (request, response) => {
  const examDate = sanitizeText(request.body.examDate || '');
  const examName = sanitizeText(request.body.examName || '考研');
  if (!examDate) { return response.status(400).json({ error: '请设置考试日期。' }); }
  db.prepare(`
    INSERT INTO exam_countdown (student_id, exam_date, exam_name, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(student_id) DO UPDATE SET exam_date = excluded.exam_date, exam_name = excluded.exam_name
  `).run(request.currentUser.id, examDate, examName, dayjs().toISOString());
  response.json({ ok: true });
});

// ── 习惯追踪 ──
app.get('/api/habits', requireAuth, (request, response) => {
  const habits = db.prepare('SELECT * FROM habit_tracking WHERE student_id = ? ORDER BY created_at DESC').all(request.currentUser.id);
  response.json({ habits: habits.map((h) => ({ ...h, completedDates: safeJsonParse(h.completed_dates, []) })) });
});

app.post('/api/habits', requireAuth, (request, response) => {
  const name = sanitizeText(request.body.name || '');
  const targetDays = Math.max(1, Number(request.body.targetDays) || 7);
  if (!name) { return response.status(400).json({ error: '习惯名不能为空。' }); }
  db.prepare('INSERT INTO habit_tracking (student_id, habit_name, target_days, completed_dates, created_at) VALUES (?, ?, ?, ?, ?)').run(
    request.currentUser.id, name, targetDays, '[]', dayjs().toISOString()
  );
  response.json({ ok: true });
});

app.post('/api/habits/:id/check', requireAuth, (request, response) => {
  const habit = db.prepare('SELECT * FROM habit_tracking WHERE id = ? AND student_id = ?').get(request.params.id, request.currentUser.id);
  if (!habit) { return response.status(404).json({ error: '不存在。' }); }
  const dates = safeJsonParse(habit.completed_dates, []);
  const today = dayjs().format('YYYY-MM-DD');
  if (dates.includes(today)) { return response.json({ ok: true, already: true }); }
  dates.push(today);
  db.prepare('UPDATE habit_tracking SET completed_dates = ? WHERE id = ?').run(JSON.stringify(dates), habit.id);
  response.json({ ok: true });
});

app.delete('/api/habits/:id', requireAuth, (request, response) => {
  db.prepare('DELETE FROM habit_tracking WHERE id = ? AND student_id = ?').run(Number(request.params.id), request.currentUser.id);
  response.json({ ok: true });
});

// ── 直播互动答题 ──
app.post('/api/live-sessions/:id/polls', requireTeacher, (request, response) => {
  const liveId = Number(request.params.id);
  const question = sanitizeText(request.body.question || '');
  const options = request.body.options || [];
  if (!question || options.length < 2) { return response.status(400).json({ error: '缺少参数。' }); }

  const result = db.prepare(
    'INSERT INTO live_polls (live_session_id, question, options, is_active, created_at) VALUES (?, ?, ?, 1, ?)'
  ).run(liveId, question, JSON.stringify(options), dayjs().toISOString());

  // 通过 WebSocket 广播新投票
  broadcastToLive(liveId, { type: 'poll', poll: { id: result.lastInsertRowid, question, options } });
  response.json({ ok: true, pollId: result.lastInsertRowid });
});

app.post('/api/live-sessions/:id/polls/vote', requireAuth, (request, response) => {
  const pollId = Number(request.body.pollId);
  const optionIndex = Number(request.body.optionIndex);
  if (!pollId) { return response.status(400).json({ error: '缺少参数。' }); }

  db.prepare(`
    INSERT INTO live_poll_votes (poll_id, user_id, option_index, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(poll_id, user_id) DO UPDATE SET option_index = excluded.option_index
  `).run(pollId, request.currentUser.id, optionIndex, dayjs().toISOString());
  response.json({ ok: true });
});

app.get('/api/live-sessions/:id/polls/:pollId/results', requireAuth, (request, response) => {
  const poll = db.prepare('SELECT * FROM live_polls WHERE id = ?').get(request.params.pollId);
  if (!poll) { return response.status(404).json({ error: '不存在。' }); }
  const votes = db.prepare('SELECT option_index, COUNT(*) AS cnt FROM live_poll_votes WHERE poll_id = ? GROUP BY option_index').all(request.params.pollId);
  const results = {};
  votes.forEach((v) => { results[v.option_index] = v.cnt; });
  response.json({ poll: { question: poll.question, options: safeJsonParse(poll.options, []) }, results });
});

// 直播 WebSocket 广播辅助
function broadcastToLive(liveId, message) {
  wss.clients.forEach((client) => {
    if (client._liveId === liveId && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

// ── 商城推荐 ──
app.get('/api/products/recommended', requireAuth, (request, response) => {
  const userId = request.currentUser.id;
  // 基于用户做题科目推荐相关资料
  const subjects = db.prepare(`
    SELECT subject, COUNT(*) AS cnt FROM practice_records pr
    JOIN questions q ON q.id = pr.question_id
    WHERE pr.student_id = ? GROUP BY subject ORDER BY cnt DESC LIMIT 3
  `).all(userId);

  let products = [];
  if (subjects.length) {
    const subjectNames = subjects.map((s) => s.subject);
    const placeholders = subjectNames.map(() => '?').join(',');
    products = db.prepare(`
      SELECT * FROM products WHERE (title LIKE '%' || ? || '%' OR description LIKE '%' || ? || '%' OR subject IN (${placeholders})) AND stock > 0
      ORDER BY RANDOM() LIMIT 10
    `).all(subjectNames[0], subjectNames[0], ...subjectNames);
  }

  // 不足则补充热门商品
  if (products.length < 5) {
    const existing = new Set(products.map((p) => p.id));
    const more = db.prepare('SELECT * FROM products WHERE stock > 0 ORDER BY created_at DESC LIMIT 10').all()
      .filter((p) => !existing.has(p.id));
    products = products.concat(more.slice(0, 5 - products.length));
  }

  response.json({ products });
});

// ── 拼团 ──
app.post('/api/group-buys', requireStudent, (request, response) => {
  const productId = Number(request.body.productId);
  const groupPrice = Number(request.body.groupPrice) || 0;
  const targetCount = Math.max(2, Number(request.body.targetCount) || 3);
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) { return response.status(404).json({ error: '商品不存在。' }); }
  if (product.stock < 1) { return response.status(400).json({ error: '库存不足。' }); }

  const price = groupPrice > 0 ? groupPrice : Math.round(product.price * 0.8 * 100) / 100;
  const expiresAt = dayjs().add(24, 'hour').toISOString();

  const result = db.prepare(
    'INSERT INTO group_buys (product_id, initiator_id, target_count, group_price, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(productId, request.currentUser.id, targetCount, price, expiresAt, dayjs().toISOString());

  db.prepare('INSERT INTO group_buy_participants (group_buy_id, student_id, joined_at) VALUES (?, ?, ?)').run(result.lastInsertRowid, request.currentUser.id, dayjs().toISOString());

  response.json({ ok: true, groupBuyId: result.lastInsertRowid });
});

app.post('/api/group-buys/:id/join', requireStudent, (request, response) => {
  const gbId = Number(request.params.id);
  const gb = db.prepare('SELECT * FROM group_buys WHERE id = ?').get(gbId);
  if (!gb) { return response.status(404).json({ error: '拼团不存在。' }); }
  if (gb.status !== 'open') { return response.status(400).json({ error: '拼团已结束。' }); }
  if (dayjs(gb.expires_at).isBefore(dayjs())) { return response.status(400).json({ error: '拼团已过期。' }); }

  const already = db.prepare('SELECT id FROM group_buy_participants WHERE group_buy_id = ? AND student_id = ?').get(gbId, request.currentUser.id);
  if (already) { return response.status(400).json({ error: '已参与。' }); }

  db.prepare('INSERT INTO group_buy_participants (group_buy_id, student_id, joined_at) VALUES (?, ?, ?)').run(gbId, request.currentUser.id, dayjs().toISOString());
  const currentCount = db.prepare('SELECT COUNT(*) AS cnt FROM group_buy_participants WHERE group_buy_id = ?').get(gbId).cnt;

  if (currentCount >= gb.target_count) {
    db.prepare('UPDATE group_buys SET status = ? WHERE id = ?').run('success', gbId);
  }

  response.json({ ok: true, currentCount, targetCount: gb.target_count });
});

app.get('/api/group-buys', requireAuth, (request, response) => {
  const groups = db.prepare(`
    SELECT gb.*, p.title AS product_title, p.image_path FROM group_buys gb
    LEFT JOIN products p ON p.id = gb.product_id
    WHERE gb.status = 'open' AND julianday(gb.expires_at) > julianday('now')
    ORDER BY gb.created_at DESC LIMIT 20
  `).all();
  const result = groups.map((g) => {
    const count = db.prepare('SELECT COUNT(*) AS cnt FROM group_buy_participants WHERE group_buy_id = ?').get(g.id).cnt;
    return { ...g, currentCount: count };
  });
  response.json({ groupBuys: result });
});

// ── 虚拟商品自动发货 ──
app.post('/api/orders/:id/download', requireStudent, (request, response) => {
  const order = db.prepare('SELECT o.*, p.is_virtual, p.virtual_content FROM orders o LEFT JOIN products p ON p.id = o.product_id WHERE o.id = ? AND o.student_id = ?').get(request.params.id, request.currentUser.id);
  if (!order) { return response.status(404).json({ error: '订单不存在。' }); }
  if (!order.is_virtual) { return response.status(400).json({ error: '非虚拟商品。' }); }
  if (order.status !== 'paid' && order.status !== 'delivered') { return response.status(400).json({ error: '订单状态不允许下载。' }); }
  response.json({ content: order.virtual_content });
});

// ── AI 智能功能（接入外部大模型 API 的占位接口） ──
app.post('/api/ai/tutor', requireAuth, async (request, response) => {
  const { question, context } = request.body;
  if (!question) { return response.status(400).json({ error: '请输入问题。' }); }

  // 构建考研辅导提示词
  const systemPrompt = '你是一个专业的考研辅导老师，擅长各科目答疑。请给出详细的解题思路和知识点讲解。';
  const userPrompt = context ? ('背景：' + context + '\n\n问题：' + question) : question;

  try {
    const aiResponse = await callAI(systemPrompt, userPrompt);
    db.prepare('INSERT INTO ai_conversations (user_id, type, prompt, response, created_at) VALUES (?, ?, ?, ?, ?)').run(
      request.currentUser.id, 'tutor', question, aiResponse, dayjs().toISOString()
    );
    response.json({ response: aiResponse });
  } catch (err) {
    console.error('AI tutor error:', err.message);
    response.status(500).json({ error: 'AI 服务暂时不可用。' });
  }
});

app.post('/api/ai/essay-grade', requireAuth, async (request, response) => {
  const { essay, type } = request.body;
  if (!essay) { return response.status(400).json({ error: '请输入作文。' }); }

  const systemPrompt = '你是一个考研英语作文批改专家。请评分（满分20分），指出语法错误，给出修改建议和范文参考。';
  const userPrompt = '作文类型：' + (type || '未知') + '\n\n' + essay;

  try {
    const aiResponse = await callAI(systemPrompt, userPrompt);
    db.prepare('INSERT INTO ai_conversations (user_id, type, prompt, response, created_at) VALUES (?, ?, ?, ?, ?)').run(
      request.currentUser.id, 'essay', essay.substring(0, 500), aiResponse, dayjs().toISOString()
    );
    response.json({ response: aiResponse });
  } catch (err) {
    console.error('AI essay grade error:', err.message);
    response.status(500).json({ error: 'AI 服务暂时不可用。' });
  }
});

app.post('/api/ai/study-plan', requireAuth, async (request, response) => {
  const userId = request.currentUser.id;

  // 收集用户数据
  const stats = db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct FROM practice_records WHERE student_id = ?').get(userId);
  const subjects = db.prepare('SELECT subject, COUNT(*) AS cnt, SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct FROM practice_records pr JOIN questions q ON q.id = pr.question_id WHERE pr.student_id = ? GROUP BY subject').all(userId);
  const streak = db.prepare('SELECT current_streak FROM study_streaks WHERE student_id = ?').get(userId);

  const accuracy = stats.total > 0 ? Math.round(stats.correct / stats.total * 100) : 0;
  const subjectInfo = subjects.map((s) => s.subject + '：正确率 ' + (s.cnt > 0 ? Math.round(s.correct / s.cnt * 100) : 0) + '%，做题 ' + s.cnt + ' 道').join('；');
  const streakDays = streak ? streak.current_streak : 0;

  const systemPrompt = '你是一个考研学习规划师。根据学生的做题数据，生成个性化每日学习计划。';
  const userPrompt = '学生数据：总做题 ' + stats.total + ' 道，总正确率 ' + accuracy + '%，连续学习 ' + streakDays + ' 天。分科目：' + subjectInfo + '。请给出今天的学习计划建议。';

  try {
    const aiResponse = await callAI(systemPrompt, userPrompt);
    db.prepare('INSERT INTO ai_conversations (user_id, type, prompt, response, context, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      userId, 'plan', userPrompt, aiResponse, JSON.stringify({ accuracy, streakDays }), dayjs().toISOString()
    );
    response.json({ response: aiResponse });
  } catch (err) {
    console.error('AI study plan error:', err.message);
    response.status(500).json({ error: 'AI 服务暂时不可用。' });
  }
});

app.post('/api/ai/generate-questions', requireAuth, async (request, response) => {
  if (request.currentUser.role !== 'teacher') { return response.status(403).json({ error: '无权限。' }); }
  const { subject, topic, count, type } = request.body;

  const systemPrompt = '你是一个考研出题专家。请生成标准的考研练习题，格式为 JSON 数组，每题包含 title, stem, options(4个选项的数组), correctAnswer, analysisText。';
  const userPrompt = '科目：' + (subject || '综合') + '，知识点：' + (topic || '综合') + '，数量：' + (count || 5) + '，题型：' + (type || '选择题');

  try {
    const aiResponse = await callAI(systemPrompt, userPrompt);
    db.prepare('INSERT INTO ai_conversations (user_id, type, prompt, response, created_at) VALUES (?, ?, ?, ?, ?)').run(
      request.currentUser.id, 'generate', userPrompt, aiResponse, dayjs().toISOString()
    );
    response.json({ response: aiResponse });
  } catch (err) {
    console.error('AI generate error:', err.message);
    response.status(500).json({ error: 'AI 服务暂时不可用。' });
  }
});

app.post('/api/ai/summary', requireAuth, async (request, response) => {
  const { content, type } = request.body;
  if (!content) { return response.status(400).json({ error: '请提供内容。' }); }

  const systemPrompt = '请对以下内容生成简洁的摘要，突出重点和关键信息。';
  const userPrompt = '内容类型：' + (type || '帖子') + '\n\n' + content.substring(0, 3000);

  try {
    const aiResponse = await callAI(systemPrompt, userPrompt);
    db.prepare('INSERT INTO ai_conversations (user_id, type, prompt, response, created_at) VALUES (?, ?, ?, ?, ?)').run(
      request.currentUser.id, 'summary', content.substring(0, 200), aiResponse, dayjs().toISOString()
    );
    response.json({ response: aiResponse });
  } catch (err) {
    console.error('AI summary error:', err.message);
    response.status(500).json({ error: 'AI 服务暂时不可用。' });
  }
});

// AI 调用辅助函数（支持配置外部大模型 API）
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

// ── 闪卡排行榜 ──
app.get('/api/flashcards/leaderboard', requireAuth, (request, response) => {
  const period = request.query.period || 'week';
  let dateFilter = '';
  if (period === 'week') {
    dateFilter = " AND created_at >= datetime('now', '-7 days')";
  } else if (period === 'month') {
    dateFilter = " AND created_at >= datetime('now', '-30 days')";
  }
  const leaders = db.prepare(`
    SELECT fr.student_id, u.display_name, COUNT(*) AS review_count,
      SUM(CASE WHEN fr.quality >= 3 THEN 1 ELSE 0 END) AS good_count
    FROM flashcard_records fr
    JOIN users u ON u.id = fr.student_id
    WHERE 1=1${dateFilter}
    GROUP BY fr.student_id ORDER BY review_count DESC LIMIT 20
  `).all();
  response.json({ leaderboard: leaders });
});

// BUG-012: API 路由统一返回 JSON 404
app.use('/api', (request, response) => {
  response.status(404).json({ error: '接口不存在。' });
});

app.use((error, request, response, next) => {
  console.error(error);
  if (response.headersSent) {
    next(error);
    return;
  }

  response.status(500).json({ error: '服务器内部错误，请稍后重试。' });
});

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
    process.exit(1);
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
