import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { z } from 'zod';
import { accountSummary, adminAccountPatchSchema, adminAccountSchema, assessmentSubmissionDecision, assistantStudentPatchSchema, companionFinishReason, companionStudyDuration, companionStudyVisibility, courseScopeMatches, decisionForOrderClaim, decisionForOrderReview, gradeEntrancePaper, gradeObjectiveAssessment, isAllowedStateTransition, normalizeCourseScope, normalizeRegistrationSubjects, planTemplateDto, planTemplatePayloadSchema, planTemplateRowDtos, planTemplateSubjectSchema, planTemplateUpdateSchema, questionAnswerShapeIsValid, selfStudentPatchSchema, staffStudentPatchSchema, studentDto, subjectsMatch, taskDayNumber, validateAppOrigin } from './core.js';
import { storage, generateObjectKey, STORAGE_DRIVER_NAME } from './storage.js';
const { Pool } = pg;

const app = Fastify({
  bodyLimit: 2 * 1024 * 1024,
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'req.headers["set-cookie"]',
        'res.headers["set-cookie"]',
        'req.body.password',
        'req.body.currentPassword',
        'req.body.newPassword',
        'req.body.password_hash',
        'password_hash',
        'token',
        'shareToken',
        'session'
      ],
      censor: '[redacted]'
    }
  },
  genReqId: request => {
    const supplied = String(request.headers['x-request-id'] || '').trim();
    return /^[A-Za-z0-9._:-]{1,100}$/.test(supplied) ? supplied : crypto.randomUUID();
  }
});
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const JWT_SECRET = process.env.SESSION_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
const ORIGIN = validateAppOrigin({ origin: process.env.APP_ORIGIN, nodeEnv: process.env.NODE_ENV });
const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 });
const metrics = { requests:0, errors4xx:0, errors5xx:0, totalDurationMs:0, readinessFailures:0 };
const hashToken = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const makeToken = () => crypto.randomBytes(32).toString('base64url');
const json = value => JSON.stringify(value ?? {});
const sha256 = async stream => {
  const hash = crypto.createHash('sha256');
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
};
const providerUrlSchema = z.string().url().refine(value => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
}, 'Provider 地址必须是无凭证的 HTTP(S) URL');
const idempotencyKeySchema = z.string().trim().regex(/^[A-Za-z0-9._:-]{8,200}$/, 'Idempotency-Key 格式不合法');
const idempotencyPrincipal = request => String(
  request.account?.accountId
  || (request.cookies?.exam_session ? `exam:${hashToken(request.cookies.exam_session)}` : `anonymous:${request.ip || 'unknown'}`)
);
const requestHash = (request, principal) => crypto.createHash('sha256').update(JSON.stringify({ principal, method: request.method, url: request.url, body: request.body ?? null })).digest('hex');
const getIdempotencyKey = request => {
  const raw = request.headers['idempotency-key'];
  if (raw === undefined) return null;
  return idempotencyKeySchema.parse(String(raw));
};
const withIdempotency = handler => async (request, reply) => {
  const key = getIdempotencyKey(request);
  if (!key) return handler(request, reply);
  const principal = idempotencyPrincipal(request);
  const hash = requestHash(request, principal);
  const inserted = await pool.query(
    `INSERT INTO idempotency_keys(principal_id,idempotency_key,request_hash) VALUES($1,$2,$3)
     ON CONFLICT(principal_id,idempotency_key) DO NOTHING RETURNING idempotency_key`,
    [principal, key, hash]
  );
  if (!inserted.rowCount) {
    const existing = (await pool.query('SELECT request_hash,status,response_status,response_body FROM idempotency_keys WHERE principal_id=$1 AND idempotency_key=$2', [principal, key])).rows[0];
    if (!existing || existing.request_hash !== hash) throw Object.assign(new Error('Idempotency-Key 已用于其他请求'), { statusCode: 409 });
    if (existing.status === 'processing') throw Object.assign(new Error('相同请求正在处理中，请稍后重试'), { statusCode: 409 });
    reply.code(existing.response_status || 200);
    return existing.response_body;
  }
  try {
    const result = await handler(request, reply);
    const responseStatus = reply.statusCode || 200;
    await pool.query('UPDATE idempotency_keys SET status=\'completed\',response_status=$3,response_body=$4,completed_at=now() WHERE principal_id=$1 AND idempotency_key=$2', [principal, key, responseStatus, json(result)]);
    return result;
  } catch (error) {
    await pool.query('DELETE FROM idempotency_keys WHERE principal_id=$1 AND idempotency_key=$2 AND status=\'processing\'', [principal, key]);
    throw error;
  }
};

await app.register(helmet);
await app.register(cors, { origin: ORIGIN, credentials: true });
await app.register(cookie);
await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024, files: 1 } });
// 所有请求都经 nginx 反向代理，socket IP 恒为 127.0.0.1；
// 必须用 X-Real-IP（nginx 按真实对端写入，客户端无法伪造）做限流键，
// 否则全站用户共享同一个桶，少数活跃用户就会让所有请求 429。
await app.register(rateLimit, {
  max: 300,
  timeWindow: '1 minute',
  keyGenerator: request => {
    const realIp = String(request.headers['x-real-ip'] || '').trim();
    return realIp || request.ip;
  }
});

app.decorateRequest('account', null);
const verifySession = async request => {
  // 学生端与教师端部署在同一域名下，若共用一个 session cookie 会互相覆盖，
  // 表现为一端登录后另一端“掉线/提示没权限”。因此按角色分 cookie 存放，
  // 由前端 X-App-Context 头与路由前缀共同决定本次请求取哪一份凭证；
  // 旧版前端没有该头时回退到 legacy 的 session cookie，行为与之前一致。
  const cookies = request.cookies;
  const appContext = String(request.headers['x-app-context'] || '').trim().toLowerCase();
  const preferAdmin = appContext === 'teacher' || (!appContext && request.url.startsWith('/api/admin'));
  const pickCookie = names => names.map(name => cookies[name]).find(Boolean);
  const token = preferAdmin
    ? pickCookie(['session_admin', 'session', 'session_student'])
    : pickCookie(['session_student', 'session', 'session_admin']);
  if (!token) throw Object.assign(new Error('未登录'), { statusCode: 401 });
  let claims;
  try { claims = jwt.verify(token, JWT_SECRET); } catch { throw Object.assign(new Error('登录已失效'), { statusCode: 401 }); }
  const account = (await pool.query(
    'SELECT id,role,name,phone,student_id,status,must_change_password,session_version FROM accounts WHERE id=$1',
    [claims.accountId]
  )).rows[0];
  const databaseVersion = Number(account?.session_version || 1);
  const tokenSessionVersion = Number(claims.sessionVersion || 1);
  const tokenAuthVersion = claims.authVersion === undefined ? tokenSessionVersion : Number(claims.authVersion);
  if (!account || account.status !== '启用' || tokenSessionVersion !== databaseVersion || tokenAuthVersion !== databaseVersion) {
    throw Object.assign(new Error('登录已失效'), { statusCode: 401 });
  }
  request.account = {
    ...claims,
    accountId: account.id,
    role: account.role,
    studentId: account.student_id,
    status: account.status,
    mustChangePassword: account.must_change_password,
    sessionVersion: databaseVersion,
    authVersion: databaseVersion
  };
};
app.decorate('authBase', verifySession);
app.decorate('auth', async request => {
  await verifySession(request);
  if (request.account.mustChangePassword) {
    throw Object.assign(new Error('请先修改初始密码'), { statusCode: 403 });
  }
});
const requireRoles = roles => async request => { await app.auth(request); if (!roles.includes(request.account.role)) throw Object.assign(new Error('无权访问'), { statusCode: 403 }); };
const requireExamToken = async request => {
  const token = request.cookies.exam_session;
  if (!token) throw Object.assign(new Error('试卷访问凭证缺失'), { statusCode: 401 });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.distributionId !== request.params.id || !payload.shareTokenHash) throw new Error('凭证不匹配');
    const distribution = (await pool.query('SELECT id,share_token_hash,status,submitted_at FROM entrance_distributions WHERE id=$1', [request.params.id])).rows[0];
    if (!distribution || distribution.share_token_hash !== payload.shareTokenHash || distribution.submitted_at || ['已提交','超时自动交卷','已撤销'].includes(distribution.status)) throw new Error('凭证已失效');
  } catch { throw Object.assign(new Error('试卷访问凭证无效或已过期'), { statusCode: 401 }); }
};
const audit = async (accountId, action, type, id, metadata = {}) => pool.query('INSERT INTO audit_logs(actor_account_id,action,entity_type,entity_id,metadata) VALUES($1,$2,$3,$4,$5)', [accountId, action, type, id, json(metadata)]);
const archiveWrongQuestions = async (client, { studentId, assessmentRecordId = null, submissionId = null, subject = '', wrongQuestions = [] }) => {
  if (!Array.isArray(wrongQuestions)) return;
  for (const [index, item] of wrongQuestions.entries()) {
    const snapshot = {
      subject: item.subject || subject || '', number: item.number ?? item.questionNumber ?? index + 1,
      text: item.questionText || item.stem || item.prompt || item.question || '',
      studentAnswer: item.studentAnswer ?? item.answer ?? null,
      correctAnswer: item.correctAnswer ?? null,
      analysis: item.analysis || item.correctMethod || item.knowledgePointExplanation || '',
      knowledgePoint: item.knowledgePoint || item.knowledge_point || ''
    };
    const sourceHash = crypto.createHash('sha256').update(JSON.stringify({ assessmentRecordId, submissionId, snapshot })).digest('hex');
    await client.query(
      `INSERT INTO wrong_question_archives(student_id,assessment_record_id,submission_id,source_hash,subject,question_number,question_text,student_answer,correct_answer,analysis,knowledge_point)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT(student_id,source_hash) DO NOTHING`,
      [studentId,assessmentRecordId,submissionId,sourceHash,snapshot.subject,snapshot.number,snapshot.text,json(snapshot.studentAnswer),json(snapshot.correctAnswer),snapshot.analysis,snapshot.knowledgePoint]
    );
  }
};

const requireStudent = async request => {
  await app.auth(request);
  if (request.account.role !== 'student' || !request.account.studentId) throw Object.assign(new Error('仅学生账号可操作'), { statusCode: 403 });
};
const canAccessStudent = (request, studentId) => request.account.role !== 'student' || String(request.account.studentId) === String(studentId);
const activeAdminGuard = async (client, targetId, { nextStatus, deleting = false } = {}) => {
  const target = (await client.query('SELECT id,role,status FROM accounts WHERE id=$1 FOR UPDATE', [targetId])).rows[0];
  if (!target) throw Object.assign(new Error('账号不存在'), { statusCode:404 });
  if ((deleting || nextStatus === '停用') && target.role === 'admin') {
    const activeAdmins = (await client.query(`SELECT count(*)::int AS count FROM accounts WHERE role='admin' AND status='启用' AND id<>$1`, [targetId])).rows[0].count;
    if (activeAdmins < 1) throw Object.assign(new Error('系统至少需要保留一个启用中的管理员账号'), { statusCode:409 });
  }
  return target;
};
const publicQuestion = question => ({
  id:question.id,
  itemIndex:question.itemIndex,
  subject:question.subject,
  questionType:question.questionType,
  stem:question.stem,
  options:question.options,
  score:question.score,
  knowledgePoint:question.knowledgePoint
});

const aiRobotSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9_-]{2,80}$/, '机器人标识仅允许小写字母、数字、下划线和连字符'),
  name: z.string().trim().min(1).max(120),
  capability: z.enum(['text','vision','embedding']),
  status: z.enum(['disabled','configured','enabled']).default('disabled'),
  providerRef: z.string().trim().regex(/^[A-Za-z0-9._:-]{2,160}$/, 'Provider 引用格式不正确').nullable().optional(),
  systemPrompt: z.string().max(12000).default(''),
  restrictionWords: z.array(z.string().trim().min(1).max(80)).max(100).default([]),
  requiresHumanApproval: z.boolean().default(true),
  allowedTools: z.array(z.string().trim().regex(/^[a-z0-9_-]{2,80}$/)).max(30).default([])
}).strict();
const aiProviderSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9_-]{2,80}$/),
  name: z.string().trim().min(1).max(120),
  capability: z.enum(['text','vision','embedding']),
  baseUrl: providerUrlSchema,
  secretRef: z.string().trim().regex(/^[A-Za-z0-9_:-]{2,160}$/),
  status: z.enum(['disabled','configured','enabled']).default('configured'),
  timeoutMs: z.number().int().min(1000).max(60000).default(10000),
  maxRetries: z.number().int().min(0).max(3).default(1)
}).strict();
const providerEnvKey = secretRef => {
  const key = String(secretRef || '');
  if (!/^[A-Za-z0-9_:-]{2,160}$/.test(key)) return null;
  return process.env[key] || null;
};
// 模型名通过环境变量配置（<secretRef>_MODEL，如 DEEPSEEK_API_KEY_MODEL），避免再迁表；
// 未配置时回退 AI_DEFAULT_MODEL，再回退平台默认文本模型。
const aiProviderModel = secretRef => process.env[`${secretRef}_MODEL`] || process.env.AI_DEFAULT_MODEL || 'deepseek-v4-flash-exp';

// ---- AI 执行器（OpenAI 兼容协议）：让监管机器人任务真正跑起来，而不再只是入队 ----
const callAiProvider = async (provider, messages) => {
  const apiKey = providerEnvKey(provider.secret_ref);
  if (!apiKey) throw Object.assign(new Error('Provider 密钥未配置到服务端环境变量'), { statusCode: 503, code: 'AI_SECRET_MISSING' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(Number(provider.timeout_ms) || 10000, 60000));
  try {
    const response = await fetch(`${String(provider.base_url).replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: aiProviderModel(provider.secret_ref), messages, temperature: 0.3, max_tokens: 8000, stream: false }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || `模型服务返回 ${response.status}`);
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error('模型未返回内容');
    return { text: String(text), usage: data.usage || null, model: data.model || aiProviderModel(provider.secret_ref) };
  } finally { clearTimeout(timer); }
};

const executeAiJob = async jobId => {
  const job = (await pool.query('SELECT * FROM ai_jobs WHERE id=$1', [jobId])).rows[0];
  if (!job || job.status !== 'queued') return;
  const robot = (await pool.query('SELECT * FROM ai_robots WHERE id=$1', [job.robot_id])).rows[0];
  const provider = robot && (await pool.query('SELECT * FROM ai_providers WHERE id=$1', [robot.provider_ref])).rows[0];
  if (!robot || !provider) return;
  await pool.query("UPDATE ai_jobs SET status='running', started_at=now(), updated_at=now() WHERE id=$1", [jobId]);
  const restriction = Array.isArray(robot.restriction_words) && robot.restriction_words.length
    ? `\n\n限制词（必须遵守）：${robot.restriction_words.join('、')}` : '';
  const system = `${robot.system_prompt || '你是考研学习平台的教学机器人。'}${restriction}`;
  const input = job.input && typeof job.input === 'object' ? job.input : {};
  const userContent = typeof input.prompt === 'string' && input.prompt.trim() ? input.prompt.trim()
    : typeof input.text === 'string' && input.text.trim() ? input.text.trim()
    : `请按你的职责处理以下输入并输出结果：\n${JSON.stringify(input, null, 2)}`;
  try {
    const result = await callAiProvider(provider, [{ role: 'system', content: system }, { role: 'user', content: userContent }]);
    await pool.query(
      "UPDATE ai_jobs SET status='completed', output=$1, prompt_version=$2, completed_at=now(), updated_at=now() WHERE id=$3",
      [json({ text: result.text, model: result.model, usage: result.usage }), 'executor-v1', jobId]
    );
  } catch (error) {
    const code = error.name === 'AbortError' ? 'timeout' : (error.code || 'provider_error');
    await pool.query(
      "UPDATE ai_jobs SET status='failed', error_code=$1, output=$2, completed_at=now(), updated_at=now() WHERE id=$3",
      [code, json({ message: error.message || '执行失败' }), jobId]
    );
  }
};
const scheduleAiJob = jobId => setImmediate(() => executeAiJob(jobId).catch(error => console.error('[ai] job execute failed:', error)));

const providerPublic = row => ({
  id:row.id, name:row.name, capability:row.capability, baseUrl:row.base_url,
  // secretRef 只是服务端环境变量名，不返回环境变量对应的实际密钥。
  secretRef:row.secret_ref, secretConfigured:Boolean(row.secret_ref), status:row.status, timeoutMs:row.timeout_ms,
  maxRetries:row.max_retries, lastTestedAt:row.last_tested_at,
  lastTestStatus:row.last_test_status, createdAt:row.created_at, updatedAt:row.updated_at
});

const aiJobSchema = z.object({
  robotId: z.string().trim().regex(/^[a-z0-9_-]{2,80}$/),
  studentId: z.string().uuid().nullable().optional(),
  input: z.record(z.unknown()).default({})
}).strict().superRefine((value, context) => {
  if (Buffer.byteLength(JSON.stringify(value.input), 'utf8') > 64 * 1024) {
    context.addIssue({ code:z.ZodIssueCode.custom, path:['input'], message:'AI 任务输入不能超过 64 KB' });
  }
});

app.get('/api/admin/ai/providers', { preHandler: requireRoles(['admin']) }, async () => {
  const result = await pool.query('SELECT id,name,capability,base_url,secret_ref,status,timeout_ms,max_retries,last_tested_at,last_test_status,created_at,updated_at FROM ai_providers ORDER BY id');
  return result.rows.map(providerPublic);
});
app.put('/api/admin/ai/providers/:id', { preHandler: requireRoles(['admin']) }, withIdempotency(async request => {
  const body = aiProviderSchema.parse({ ...request.body, id:request.params.id });
  const result = await pool.query(
    `INSERT INTO ai_providers(id,name,capability,base_url,secret_ref,status,timeout_ms,max_retries)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,capability=EXCLUDED.capability,base_url=EXCLUDED.base_url,secret_ref=EXCLUDED.secret_ref,status=EXCLUDED.status,timeout_ms=EXCLUDED.timeout_ms,max_retries=EXCLUDED.max_retries,updated_at=now()
     RETURNING id,name,capability,base_url,secret_ref,status,timeout_ms,max_retries,last_tested_at,last_test_status,created_at,updated_at`,
    [body.id,body.name,body.capability,body.baseUrl,body.secretRef,body.status,body.timeoutMs,body.maxRetries]
  );
  await audit(request.account.accountId, '配置 AI Provider', 'ai_provider', body.id, { capability:body.capability, status:body.status });
  return providerPublic(result.rows[0]);
}));
app.post('/api/admin/ai/providers/:id/test', { preHandler: requireRoles(['admin']) }, async request => {
  const id = z.string().regex(/^[a-z0-9_-]{2,80}$/).parse(request.params.id);
  const provider = (await pool.query('SELECT * FROM ai_providers WHERE id=$1', [id])).rows[0];
  if (!provider) throw Object.assign(new Error('Provider 不存在'), { statusCode:404 });
  // 真实连通性测试：向 Provider 发起一次最小补全请求。
  try {
    const result = await callAiProvider(provider, [{ role: 'user', content: '只回复两个字：正常' }]);
    await pool.query("UPDATE ai_providers SET last_tested_at=now(),last_test_status='passed',updated_at=now() WHERE id=$1", [id]);
    await audit(request.account.accountId, '测试 AI Provider', 'ai_provider', id, { status:'passed' });
    return { ok:true, status:'passed', model:result.model, message:'Provider 连通正常，模型已真实响应。' };
  } catch (error) {
    await pool.query("UPDATE ai_providers SET last_tested_at=now(),last_test_status='failed',updated_at=now() WHERE id=$1", [id]);
    await audit(request.account.accountId, '测试 AI Provider', 'ai_provider', id, { status:'failed', reason:error.message });
    throw Object.assign(new Error(`Provider 连通测试失败：${error.message}`), { statusCode:502, code:'AI_PROVIDER_TEST_FAILED' });
  }
});
app.get('/api/admin/ai/robots', { preHandler: requireRoles(['admin','teacher']) }, async () => {
  const result = await pool.query('SELECT id,name,capability,status,provider_ref,system_prompt,restriction_words,requires_human_approval,allowed_tools,created_at,updated_at FROM ai_robots ORDER BY id');
  return result.rows.map(row => ({
    id:row.id, name:row.name, capability:row.capability, status:row.status,
    providerRef:row.provider_ref, systemPrompt:row.system_prompt,
    restrictionWords:row.restriction_words || [], requiresHumanApproval:row.requires_human_approval,
    allowedTools:row.allowed_tools || [], createdAt:row.created_at, updatedAt:row.updated_at
  }));
});
app.put('/api/admin/ai/robots/:id', { preHandler: requireRoles(['admin']) }, withIdempotency(async request => {
  const body = aiRobotSchema.parse({ ...request.body, id:request.params.id });
  if (body.providerRef) {
    const provider = (await pool.query('SELECT capability,status FROM ai_providers WHERE id=$1', [body.providerRef])).rows[0];
    if (!provider) throw Object.assign(new Error('Provider 不存在'), { statusCode:422 });
    if (provider.capability !== body.capability) throw Object.assign(new Error('Provider 能力与机器人类型不匹配'), { statusCode:422 });
    if (body.status === 'enabled' && provider.status !== 'enabled') throw Object.assign(new Error('只有已启用的 Provider 才能启用机器人'), { statusCode:422 });
  }
  const result = await pool.query(
    `INSERT INTO ai_robots(id,name,capability,status,provider_ref,system_prompt,restriction_words,requires_human_approval,allowed_tools)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,capability=EXCLUDED.capability,status=EXCLUDED.status,provider_ref=EXCLUDED.provider_ref,system_prompt=EXCLUDED.system_prompt,restriction_words=EXCLUDED.restriction_words,requires_human_approval=EXCLUDED.requires_human_approval,allowed_tools=EXCLUDED.allowed_tools,updated_at=now()
     RETURNING id,name,capability,status,provider_ref,system_prompt,restriction_words,requires_human_approval,allowed_tools,created_at,updated_at`,
    [body.id,body.name,body.capability,body.status,body.providerRef || null,body.systemPrompt,json(body.restrictionWords),body.requiresHumanApproval,json(body.allowedTools)]
  );
  await audit(request.account.accountId, '配置 AI 机器人', 'ai_robot', body.id, { capability:body.capability, status:body.status, providerRef:body.providerRef || null });
  const row = result.rows[0];
  return { id:row.id, name:row.name, capability:row.capability, status:row.status, providerRef:row.provider_ref, systemPrompt:row.system_prompt, restrictionWords:row.restriction_words || [], requiresHumanApproval:row.requires_human_approval, allowedTools:row.allowed_tools || [], createdAt:row.created_at, updatedAt:row.updated_at };
}));
app.post('/api/ai/jobs', { preHandler: app.auth }, withIdempotency(async request => {
  const body = aiJobSchema.parse(request.body);
  const allowedRoles = ['admin','teacher','student'];
  if (!allowedRoles.includes(request.account.role)) throw Object.assign(new Error('当前账号无权创建 AI 任务'), { statusCode:403 });
  const studentId = body.studentId || (request.account.role === 'student' ? request.account.studentId : null);
  if (request.account.role === 'student' && (!studentId || String(studentId) !== String(request.account.studentId))) {
    throw Object.assign(new Error('学生只能创建自己的 AI 任务'), { statusCode:403 });
  }
  const robot = (await pool.query('SELECT id,status,capability,requires_human_approval,provider_ref FROM ai_robots WHERE id=$1', [body.robotId])).rows[0];
  if (!robot || robot.status !== 'enabled' || !robot.provider_ref) {
    throw Object.assign(new Error('该 AI 机器人尚未完成可用配置'), { statusCode:422 });
  }
  const provider = (await pool.query('SELECT id,capability,status FROM ai_providers WHERE id=$1', [robot.provider_ref])).rows[0];
  if (!provider || provider.status !== 'enabled' || provider.capability !== robot.capability) {
    throw Object.assign(new Error('该 AI 机器人绑定的 Provider 尚未启用或能力不匹配'), { statusCode:422 });
  }
  const row = (await pool.query(
    `INSERT INTO ai_jobs(robot_id,requested_by,student_id,status,input,provider_ref)
     VALUES($1,$2,$3,$4,$5,$6) RETURNING id,robot_id,student_id,status,created_at`,
    [robot.id,request.account.accountId,studentId,robot.requires_human_approval ? 'awaiting_approval' : 'queued',json(body.input),robot.provider_ref]
  )).rows[0];
  await audit(request.account.accountId, '创建 AI 任务', 'ai_job', row.id, { robotId:robot.id, studentId, status:row.status });
  if (row.status === 'queued') scheduleAiJob(row.id);
  return { id:row.id, robotId:row.robot_id, studentId:row.student_id, status:row.status, createdAt:row.created_at, message:robot.requires_human_approval ? '任务已创建，等待人工审核，审核通过后自动执行。' : '任务已进入队列并立即开始执行，可稍后查询结果。' };
}));

app.get('/api/ai/jobs/:id', { preHandler: app.auth }, async request => {
  const id = uuidSchema.parse(request.params.id);
  const row = (await pool.query('SELECT id,robot_id,requested_by,student_id,status,output,error_code,prompt_version,provider_ref,estimated_cost_micros,actual_cost_micros,started_at,completed_at,created_at,updated_at FROM ai_jobs WHERE id=$1', [id])).rows[0];
  if (!row) throw Object.assign(new Error('AI 任务不存在'), { statusCode:404 });
  const staff = ['admin','teacher'].includes(request.account.role);
  if (!staff && String(row.requested_by) !== String(request.account.accountId) && String(row.student_id) !== String(request.account.studentId)) throw Object.assign(new Error('无权读取该 AI 任务'), { statusCode:403 });
  return { id:row.id, robotId:row.robot_id, studentId:row.student_id, status:row.status, output:row.output || null, errorCode:row.error_code, promptVersion:row.prompt_version, providerRef:row.provider_ref, estimatedCostMicros:row.estimated_cost_micros, actualCostMicros:row.actual_cost_micros, startedAt:row.started_at, completedAt:row.completed_at, createdAt:row.created_at, updatedAt:row.updated_at };
});
app.post('/api/admin/ai/jobs/:id/approve', { preHandler: requireRoles(['admin','teacher']) }, async request => {
  const id = uuidSchema.parse(request.params.id);
  const result = (await pool.query("UPDATE ai_jobs SET status='queued',updated_at=now() WHERE id=$1 AND status='awaiting_approval' RETURNING id,status,updated_at", [id])).rows[0];
  if (!result) throw Object.assign(new Error('任务不存在或当前状态不可批准'), { statusCode:409 });
  await audit(request.account.accountId, '批准 AI 任务', 'ai_job', id);
  scheduleAiJob(id);
  return result;
});
app.post('/api/ai/jobs/:id/cancel', { preHandler: app.auth }, async request => {
  const id = uuidSchema.parse(request.params.id);
  const row = (await pool.query('SELECT id,requested_by,student_id,status FROM ai_jobs WHERE id=$1', [id])).rows[0];
  if (!row) throw Object.assign(new Error('AI 任务不存在'), { statusCode:404 });
  const staff = ['admin','teacher'].includes(request.account.role);
  if (!staff && String(row.requested_by) !== String(request.account.accountId)) throw Object.assign(new Error('无权取消该 AI 任务'), { statusCode:403 });
  if (!['queued','awaiting_approval'].includes(row.status)) throw Object.assign(new Error('当前任务状态不可取消'), { statusCode:409 });
  const result = (await pool.query("UPDATE ai_jobs SET status='cancelled',updated_at=now() WHERE id=$1 RETURNING id,status,updated_at", [id])).rows[0];
  await audit(request.account.accountId, '取消 AI 任务', 'ai_job', id);
  return result;
});

app.setErrorHandler((error, request, reply) => {
  const isValidation = error instanceof z.ZodError;
  // Fastify 解析器错误（如 Content-Type 为 application/json 但 body 为空）原文是英文，
  // 直接透出会让用户看不懂，统一映射为可执行的中文提示。
  const isParserError = typeof error?.code === 'string' && error.code.startsWith('FST_ERR_CTP');
  const pgCode = error?.code;
  const mappedStatus = pgCode === '23505' ? 409 : pgCode === '23503' || pgCode === '23514' ? 422 : 500;
  const statusCode = isValidation ? 400 : (error.statusCode && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : mappedStatus);
  const safeCodes = new Set(['AI_EXECUTOR_UNAVAILABLE','STORAGE_UNAVAILABLE','STORAGE_WRITE_FAILED','FILE_TOO_LARGE','UNSUPPORTED_FILE_TYPE','CLIENT_SCORE_FORBIDDEN','ASSESSMENT_UNAVAILABLE','PENDING_REVIEW']);
  const code = isValidation ? 'VALIDATION_ERROR' : (isParserError ? 'INVALID_CONTENT' : (safeCodes.has(error?.code) && statusCode >= 400 ? error.code : statusCode === 401 ? 'AUTH_REQUIRED' : statusCode === 403 ? 'FORBIDDEN' : statusCode === 404 ? 'NOT_FOUND' : statusCode === 409 ? 'CONFLICT' : statusCode === 422 ? 'CONSTRAINT_ERROR' : statusCode === 503 ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_ERROR'));
  const parserMessage = error?.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' ? '请求内容为空，请刷新页面后重试' : '请求格式不正确，请稍后重试';
  const message = isValidation ? '请求参数不合法' : (isParserError ? parserMessage : (statusCode >= 500 && !safeCodes.has(error?.code) ? '服务器暂时无法处理请求' : error.message || '请求失败'));
  const details = isValidation ? error.issues.map(issue => ({ path:issue.path, message:issue.message })) : undefined;
  request.log.error({ requestId:request.id, code, statusCode, errorName:error?.name }, 'request failed');
  reply.header('x-request-id', request.id).code(statusCode).send({ error:message, code, ...(details ? { details } : {}), requestId:request.id });
});
app.addHook('onRequest', async request => { request.startTime = process.hrtime.bigint(); });
app.addHook('onResponse', async (request, reply) => {
  metrics.requests += 1;
  metrics.totalDurationMs += Number(process.hrtime.bigint() - request.startTime) / 1e6;
  if (reply.statusCode >= 500) metrics.errors5xx += 1;
  else if (reply.statusCode >= 400) metrics.errors4xx += 1;
  request.log.info({ requestId:request.id, route:request.routeOptions?.url, statusCode:reply.statusCode, durationMs:Number(process.hrtime.bigint() - request.startTime) / 1e6 }, 'request completed');
});
app.addHook('onSend', async (request, reply) => { reply.header('x-request-id', request.id); });
app.get('/health', async request => ({ ok: true, service: 'shangan-api', requestId:request.id, now: new Date().toISOString() }));
app.get('/ready', async request => {
  try {
    await pool.query('SELECT 1');
    return { ok: true, service: 'shangan-api', requestId:request.id };
  } catch (error) {
    metrics.readinessFailures += 1;
    throw error;
  }
});
app.get('/metrics', { preHandler: requireRoles(['admin']) }, async () => ({
  requests:metrics.requests,
  errors4xx:metrics.errors4xx,
  errors5xx:metrics.errors5xx,
  averageDurationMs:metrics.requests ? Math.round(metrics.totalDurationMs / metrics.requests) : 0,
  readinessFailures:metrics.readinessFailures,
  databasePool:{ total:pool.totalCount, idle:pool.idleCount, waiting:pool.waitingCount }
}));

const phoneSchema = z.string().regex(/^1\d{10}$/, '手机号须为 1 开头的 11 位数字');
const passwordSchema = z.string().min(12, '密码至少需要 12 位').max(128);
const uuidSchema = z.string().uuid('无效 ID');
const loginSchema = z.object({ phone: phoneSchema, password: z.string().min(8).max(128) });
const EXAM_SUBJECTS = ['政治','英语一','英语二','英语三','数学一','数学二','数学三','专业课一','专业课二'];
const examSubjectSchema = z.enum(EXAM_SUBJECTS);
const studentRegistrationSchema = z.object({
  name: z.string().trim().min(1).max(60),
  phone: phoneSchema,
  password: passwordSchema,
  year: z.string().trim().min(1).max(30).default('考研年份待填写'),
  major: z.string().trim().max(160).default(''),
  // 学生自主注册时可跳过，之后仍可在个人资料中补充。
  subjects: z.array(examSubjectSchema).max(9).default([])
});
const changePasswordSchema = z.object({ currentPassword: z.string().min(8).max(128), newPassword: passwordSchema });
const assessmentSchema = z.object({
  assessmentType:z.enum(['entrance','daily','weekly','monthly']),
  subject:z.string().trim().min(1).max(60),
  title:z.string().trim().min(1).max(160),
  courseId:uuidSchema.nullable().optional(),
  questionSetId:uuidSchema.nullable().optional(),
  // 成绩必须由服务端题目快照计算；保留字段仅用于给出明确的拒绝信息。
  score:z.number().min(0).max(100000).nullable().optional(),
  total:z.number().positive().max(100000).nullable().optional(),
  answers:z.record(z.union([z.string().max(2000), z.array(z.string().max(200)).max(20)])).default({}),
  wrongQuestions:z.array(z.object({ number:z.union([z.string(),z.number()]).optional(), subject:z.string().max(60).optional(), knowledgePointExplanation:z.string().max(2000).optional(), correctMethod:z.string().max(2000).optional() })).max(300).default([])
});
const assessmentGradingSchema = z.object({
  objectiveScore:z.number().min(0).max(100000).optional(),
  subjectiveScore:z.number().min(0).max(100000).nullable().optional(),
  gradingStatus:z.enum(['graded','pending_review','partially_graded','已批改','待批改','部分待批改']),
  gradingNote:z.string().trim().max(4000).optional(),
  gradedBy:uuidSchema.optional()
}).strict();
const manualWrongQuestionSchema = z.object({
  subject:z.string().trim().min(1).max(60),
  questionText:z.string().trim().min(1).max(5000),
  analysis:z.string().trim().max(2000).optional(),
  sourceLabel:z.string().trim().max(240).optional()
}).strict();
const questionTypeSchema = z.enum(['single_choice','multiple_choice','true_false','fill_blank','short_answer']);
const entranceQuestionFieldsSchema = z.object({
  subject:z.string().trim().min(1).max(60),
  questionType:questionTypeSchema,
  stem:z.string().trim().min(1).max(10000),
  options:z.array(z.object({ key:z.string().trim().min(1).max(20), text:z.string().trim().min(1).max(1000) })).max(10).default([]),
  correctAnswer:z.union([z.string().trim().max(2000),z.array(z.string().trim().max(200)).min(1).max(10)]),
  score:z.number().positive().max(1000).default(1),
  analysis:z.string().max(5000).optional(),
  knowledgePoint:z.string().max(500).optional(),
  state:z.enum(['草稿','已发布','已归档']).default('草稿')
}).strict();
const entranceQuestionSchema = entranceQuestionFieldsSchema.superRefine((value, ctx) => {
  const needsOptions = ['single_choice','multiple_choice','true_false'].includes(value.questionType);
  if (needsOptions && value.options.length < 2) ctx.addIssue({ code:z.ZodIssueCode.custom, message:'选择题和判断题至少需要两个选项', path:['options'] });
  if (!needsOptions && value.options.length) ctx.addIssue({ code:z.ZodIssueCode.custom, message:'填空题和主观题不能设置选项', path:['options'] });
  if (!questionAnswerShapeIsValid(value)) ctx.addIssue({ code:z.ZodIssueCode.custom, message:'题型与正确答案形状不匹配', path:['correctAnswer'] });
  if (['single_choice','true_false'].includes(value.questionType) && value.options.length && typeof value.correctAnswer === 'string' && !value.options.some(option => option.key === value.correctAnswer)) {
    ctx.addIssue({ code:z.ZodIssueCode.custom, message:'单选题和判断题正确答案必须是选项键', path:['correctAnswer'] });
  }
  if (value.questionType === 'multiple_choice' && value.options.length && Array.isArray(value.correctAnswer) && value.correctAnswer.some(answer => !value.options.some(option => option.key === answer))) {
    ctx.addIssue({ code:z.ZodIssueCode.custom, message:'多选题正确答案必须全部是选项键', path:['correctAnswer'] });
  }
});
const entranceQuestionPatchSchema = entranceQuestionFieldsSchema.partial().strict();
  const assessmentQuestionSetSchema = z.object({
    studentId:uuidSchema.nullable().optional(),
    subject:z.string().trim().min(1).max(60),
    title:z.string().trim().min(1).max(160),
    assessmentType:z.enum(['daily','weekly','monthly']),
    state:z.enum(['草稿','已发布','已归档']).default('草稿'),
    questions:z.array(entranceQuestionSchema).min(1).max(1000)
  }).strict().superRefine((value, ctx) => {
    value.questions.forEach((question, index) => {
      if (question.subject !== value.subject) ctx.addIssue({ code:z.ZodIssueCode.custom, path:['questions',index,'subject'], message:'题目科目必须与题目集一致' });
      if (value.state === '已发布' && question.state !== '已发布') ctx.addIssue({ code:z.ZodIssueCode.custom, path:['questions',index,'state'], message:'已发布题目集只能包含已发布题目' });
    });
  });
  const entrancePaperSchema = z.object({
  id:z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/, '试卷 ID 只能包含字母、数字、下划线或短横线'),
  title:z.string().trim().min(1).max(160),
  durationMinutes:z.number().int().min(1).max(300).default(60),
  state:z.enum(['草稿','已发布','已归档']).default('草稿'),
  questionIds:z.array(uuidSchema).min(1).max(200)
});
const answerValueSchema = z.union([z.string().trim().max(2000), z.array(z.string().trim().max(200)).max(20)]);
const courseScopeSchema = z.object({ school:z.string().trim().max(160).default(''), major:z.string().trim().max(160).default(''), professional:z.string().trim().max(160).default(''), year:z.string().trim().max(30).default('') }).strict();
const courseSchema = z.object({ name:z.string().trim().min(1).max(160), subject:z.string().max(60).optional(), audience:z.string().trim().min(1).max(60).default('公开课'), category:z.string().trim().max(80).optional(), description:z.string().max(10000).optional(), pricing:z.enum(['免费','付费']).default('免费'), price:z.number().min(0).max(1000000).default(0), state:z.enum(['草稿','已发布','已下架']).default('草稿'), scope:courseScopeSchema.default({}) }).refine(value => value.pricing !== '付费' || value.price > 0, '付费课程价格必须大于 0');
const bookSchema = z.object({ subject:z.enum(['政治','英语','数学','专业课','通用']), name:z.string().trim().min(1).max(160), description:z.string().trim().max(2000).nullable().optional() });
const bookRecipientSchema = z.object({ studentId:uuidSchema.nullable().optional(), recipient:z.string().trim().min(1).max(120), phone:z.string().trim().max(40).nullable().optional(), shippingInfo:z.string().trim().max(2000).nullable().optional() });
const productSchema = z.object({ name:z.string().trim().min(1).max(160), category:z.string().trim().max(80).optional(), description:z.string().max(10000).optional(), pricing:z.enum(['免费','付费']).default('免费'), price:z.number().min(0).max(1000000).default(0), state:z.enum(['草稿','已上架','已下架']).default('草稿'), courseIds:z.array(uuidSchema).max(100).default([]), scope:courseScopeSchema.default({}) }).refine(value => value.pricing !== '付费' || value.price > 0, '付费商品价格必须大于 0');
const orderCreateSchema = z.object({ productId:uuidSchema, provider:z.string().trim().max(40).optional() });
const orderReviewSchema = z.object({ status:z.enum(['已支付','已驳回']), reviewNote:z.string().trim().max(1000).optional() });
const companionSubjectSchema = z.enum(['政治','英语','数学']);
const companionBookSchema = z.object({
  subject:companionSubjectSchema,
  name:z.string().trim().min(1).max(160),
  description:z.string().trim().max(2000).default(''),
  courseId:uuidSchema.nullable().optional(),
  state:z.enum(['草稿','已发布','已归档']).default('草稿'),
  companionEnabled:z.boolean().default(true)
}).strict();
const companionQuestionSchema = z.object({
  questionNumber:z.number().int().positive().max(100000),
  stem:z.string().trim().max(10000).default(''),
  durationSeconds:z.number().int().min(60).max(86400).nullable().default(null),
  knowledgePoint:z.string().trim().max(2000).default(''),
  halfHint:z.string().trim().max(4000).default(''),
  answer:z.string().trim().max(10000).default(''),
  analysis:z.string().trim().max(12000).default(''),
  state:z.enum(['草稿','已发布','已归档']).default('已发布')
}).strict();
const companionImportSchema = z.object({
  book:companionBookSchema,
  questions:z.array(companionQuestionSchema).min(1).max(10000)
}).strict().superRefine((value, ctx) => {
  const seen = new Set();
  value.questions.forEach((item, index) => {
    if (seen.has(item.questionNumber)) ctx.addIssue({ code:z.ZodIssueCode.custom, path:['questions', index, 'questionNumber'], message:'同一本书中题号不能重复' });
    seen.add(item.questionNumber);
    if (value.book.companionEnabled && item.durationSeconds === null) {
      ctx.addIssue({ code:z.ZodIssueCode.custom, path:['questions', index, 'durationSeconds'], message:'启用代学计时的每道题都必须配置 60 至 86400 秒的学习时长' });
    }
  });
});
const companionSessionSchema = z.object({ speedMode:z.enum(['基础','适中','合适']).default('合适') }).strict();
const companionSessionFinishSchema = z.object({ action:z.literal('提前结束') }).strict();
app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
  const body = loginSchema.parse(request.body);
  const result = await pool.query('SELECT * FROM accounts WHERE phone=$1 AND status=$2', [body.phone.trim(), '启用']);
  const account = result.rows[0];
  if (!account || !account.password_hash || !(await argon2.verify(account.password_hash, body.password))) {
    throw Object.assign(new Error('手机号或密码不正确'), { statusCode: 401 });
  }
  const sessionVersion = Number(account.session_version || 1);
  const session = { accountId: account.id, role: account.role, studentId: account.student_id, sessionVersion, authVersion: sessionVersion };
  reply.setCookie(account.role === 'student' ? 'session_student' : 'session_admin', jwt.sign(session, JWT_SECRET, { expiresIn: '30d' }), { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 60 * 60 * 24 * 30 });
  await pool.query('UPDATE accounts SET last_login_at=now() WHERE id=$1', [account.id]);
  await audit(account.id, '登录', 'account', account.id);
  return { account: { id: account.id, role: account.role, name: account.name, phone: account.phone, studentId: account.student_id, status: account.status, mustChangePassword: account.must_change_password, sessionVersion: Number(account.session_version || 1), authVersion: Number(account.session_version || 1) } };
});
app.post('/api/auth/logout', { preHandler: app.authBase }, async (request, reply) => {
  reply.clearCookie('session', { path: '/' });
  reply.clearCookie('session_student', { path: '/' });
  reply.clearCookie('session_admin', { path: '/' });
  if (request.account?.accountId) {
    await pool.query('UPDATE accounts SET session_version=session_version+1 WHERE id=$1', [request.account.accountId]);
    await audit(request.account.accountId, '退出登录', 'account', request.account.accountId);
  }
  return { ok: true };
});
app.get('/api/auth/me', { preHandler: app.authBase }, async request => {
  const account = (await pool.query('SELECT id,role,name,phone,student_id,must_change_password,status,session_version FROM accounts WHERE id=$1', [request.account.accountId])).rows[0];
  if (!account || account.status !== '启用') throw Object.assign(new Error('登录已失效'), { statusCode: 401 });
  return { account: { id:account.id, role:account.role, name:account.name, phone:account.phone, studentId:account.student_id, status:account.status, mustChangePassword:account.must_change_password, sessionVersion:Number(account.session_version || 1), authVersion:Number(account.session_version || 1) } };
});
app.post('/api/auth/register', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request, reply) => {
  const body = studentRegistrationSchema.parse(request.body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const duplicate = await client.query('SELECT id FROM accounts WHERE phone=$1 FOR UPDATE', [body.phone]);
    if (duplicate.rowCount) throw Object.assign(new Error('该手机号已注册，请直接登录'), { statusCode: 409 });
    const student = (await client.query("INSERT INTO students(name,year,status,phone,major,stage,evaluation) VALUES($1,$2,'新人',$3,$4,'基础','新注册学员，待老师完善学情档案。') RETURNING *", [body.name, body.year, body.phone, body.major || null])).rows[0];
    const passwordHash = await argon2.hash(body.password, { type: argon2.argon2id });
    const account = (await client.query("INSERT INTO accounts(role,name,phone,password_hash,status,student_id,must_change_password) VALUES('student',$1,$2,$3,'启用',$4,false) RETURNING id,role,name,phone,status,student_id,must_change_password,session_version", [body.name, body.phone, passwordHash, student.id])).rows[0];
    await client.query('UPDATE students SET account_id=$1 WHERE id=$2', [account.id, student.id]);
    for (const subject of normalizeRegistrationSubjects(body.subjects)) {
      // 学员自主提交的是报考意向；报名与功能权限须由老师另行确认。
      await client.query('INSERT INTO student_subjects(student_id,subject,enrolled) VALUES($1,$2,false)', [student.id, subject]);
    }
    await client.query('COMMIT');
    const sessionVersion = Number(account.session_version || 1);
    const session = { accountId: account.id, role: account.role, studentId: account.student_id, sessionVersion, authVersion: sessionVersion };
    reply.setCookie('session_student', jwt.sign(session, JWT_SECRET, { expiresIn: '7d' }), { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 60 * 60 * 24 * 7 });
    await audit(account.id, '学生注册', 'account', account.id, { studentId: student.id });
    return { account: { id: account.id, role: account.role, name: account.name, phone: account.phone, studentId: account.student_id, status: account.status, mustChangePassword: account.must_change_password, sessionVersion, authVersion: sessionVersion } };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});
app.post('/api/auth/change-password', { preHandler: app.authBase }, async (request, reply) => {
  const body = changePasswordSchema.parse(request.body);
  const account = (await pool.query('SELECT password_hash FROM accounts WHERE id=$1', [request.account.accountId])).rows[0];
  if (!account || !account.password_hash || !(await argon2.verify(account.password_hash, body.currentPassword))) throw Object.assign(new Error('当前密码不正确'), { statusCode: 401 });
  const passwordHash = await argon2.hash(body.newPassword, { type: argon2.argon2id });
  const updated = (await pool.query(
    'UPDATE accounts SET password_hash=$1,must_change_password=false,session_version=session_version+1 WHERE id=$2 RETURNING id,role,name,phone,status,student_id,must_change_password,session_version',
    [passwordHash, request.account.accountId]
  )).rows[0];
  if (!updated) throw Object.assign(new Error('账号不存在'), { statusCode:401 });
  const updatedSessionVersion = Number(updated.session_version || 1);
  const sessionVersion = updatedSessionVersion;
  const session = { accountId: updated.id, role: updated.role, studentId: updated.student_id, sessionVersion, authVersion: updatedSessionVersion };
  reply.setCookie(updated.role === 'student' ? 'session_student' : 'session_admin', jwt.sign(session, JWT_SECRET, { expiresIn: '7d' }), { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 60 * 60 * 24 * 7 });
  await audit(request.account.accountId, '修改密码', 'account', request.account.accountId);
  return { ok: true, account: { id: updated.id, role: updated.role, name: updated.name, phone: updated.phone, status: updated.status, studentId: updated.student_id, mustChangePassword: updated.must_change_password, sessionVersion: Number(updated.session_version || 1), authVersion: Number(updated.session_version || 1) }, sessionVersion: Number(updated.session_version || 1), authVersion: Number(updated.session_version || 1) };
});

const registrationSchema = z.object({
  name:z.string().trim().min(1).max(60),
  year:z.string().trim().min(1).max(30),
  phone:phoneSchema,
  email:z.string().trim().email('邮箱格式不正确').max(254).optional(),
  shippingInfo:z.string().trim().max(2000).optional(),
  school:z.string().trim().max(160).optional(),
  major:z.string().trim().max(160).optional(),
  stage:z.string().trim().max(80).default('未开始'),
  evaluation:z.string().trim().max(5000).optional(),
  subjects:z.array(z.string().trim().min(1).max(60)).min(1).max(20)
});
app.post('/api/public/registrations', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async request => {
  const body = registrationSchema.parse(request.body);
  const duplicate = await pool.query("SELECT id FROM registration_applications WHERE phone=$1 AND status='待导入'", [body.phone.trim()]);
  if (duplicate.rowCount) throw Object.assign(new Error('该联系电话已有待审核登记'), { statusCode: 409 });
  const result = await pool.query('INSERT INTO registration_applications(name,year,phone,email,shipping_info,school,major,stage,evaluation,subjects) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,submitted_at,status', [body.name.trim(), body.year.trim(), body.phone.trim(), body.email || null, body.shippingInfo || null, body.school || null, body.major || null, body.stage, body.evaluation || null, json(body.subjects)]);
  return result.rows[0];
});
const registrationFields = 'id,name,year,phone,email,school,major,stage,evaluation,subjects,status,student_type,imported_student_id,submitted_at,imported_at';
app.get('/api/registrations', { preHandler: requireRoles(['admin','teacher','assistant','operator']) }, async () => (await pool.query(`SELECT ${registrationFields} FROM registration_applications ORDER BY submitted_at DESC`)).rows);
app.post('/api/registrations/:id/import', { preHandler: requireRoles(['admin','teacher']) }, async request => {
  const type = z.object({ studentType:z.enum(['免费','新人','体验','付费']) }).parse(request.body).studentType;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const application = (await client.query(`SELECT ${registrationFields} FROM registration_applications WHERE id=$1 FOR UPDATE`, [request.params.id])).rows[0];
    if (!application || application.status !== '待导入') throw Object.assign(new Error('登记不存在或已处理'), { statusCode: 409 });
    const student = (await client.query('INSERT INTO students(name,year,status,phone,email,shipping_info,school,major,stage,evaluation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *', [application.name, application.year, type, application.phone, application.email, application.shipping_info, application.school, application.major || null, application.stage, application.evaluation])).rows[0];
    const applicationSubjects = normalizeRegistrationSubjects(application.subjects);
    for (const subject of applicationSubjects) {
      // 登记导入只保留学生的报考意向；报名/进阶权限仍须由教师逐科确认。
      await client.query('INSERT INTO student_subjects(student_id,subject,enrolled) VALUES($1,$2,false) ON CONFLICT(student_id,subject) DO NOTHING', [student.id, subject]);
    }
    await client.query('UPDATE registration_applications SET status=\'已导入\',student_type=$1,imported_student_id=$2,imported_at=now() WHERE id=$3', [type, student.id, application.id]);
    await client.query('COMMIT');
    await audit(request.account.accountId, '导入登记', 'registration', application.id, { studentId:student.id, studentType:type });
    return { student };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

const studentFields = 'id,account_id,name,year,status,phone,email,wechat_id,shipping_recipient,shipping_phone,shipping_info,school,major,target_score,stage,evaluation,paid_until,created_at,updated_at';
const studentSubjectPreferenceSchema = z.object({
  subject:z.string().trim().min(1).max(60),
  // 仅老师端可提交：报名确认同时是进阶功能的后端权限依据。
  enrolled:z.boolean().optional(),
  targetScore:z.string().trim().max(30).nullable().optional()
}).strict();
const studentPreferenceSchema = z.object({
  subjects: z.array(studentSubjectPreferenceSchema).max(20).optional(),
  restWeekday: z.number().int().min(0).max(6).nullable().optional(),
  assessmentPush: z.record(z.unknown()).optional(),
  planAdjustmentAutomation: z.record(z.unknown()).nullable().optional(),
  taskAdjustmentDraft: z.record(z.unknown()).nullable().optional(),
  taskAdjustmentHistory: z.array(z.record(z.unknown())).max(100).optional()
}).strict().refine(value => Object.keys(value).length > 0, '至少提交一项学习偏好');
const studentPreferencesPayload = async studentId => {
  const [subjects, preferences, studentRow] = await Promise.all([
    pool.query('SELECT subject,enrolled,target_score FROM student_subjects WHERE student_id=$1 ORDER BY subject', [studentId]),
    pool.query('SELECT rest_weekday,rest_weekday_set_at,assessment_push,plan_adjustment_automation,task_adjustment_draft,task_adjustment_history FROM student_learning_preferences WHERE student_id=$1', [studentId]),
    pool.query('SELECT status FROM students WHERE id=$1', [studentId])
  ]);
  const pref = preferences.rows[0] || {};
  return {
    // 学员分组（新人/体验/付费）随报名状态与体验进度实时同步，教师端列表直接读取。
    status: studentRow.rows[0]?.status || null,
    subjects: subjects.rows.map(row => ({ name:row.subject, selected:true, enrolled:row.enrolled, targetScore:row.target_score || '' })),
    restWeekday: pref.rest_weekday ?? null,
    restWeekdaySetAt: pref.rest_weekday_set_at || null,
    assessmentPush: pref.assessment_push || null,
    planAdjustmentAutomation: pref.plan_adjustment_automation || null,
    taskAdjustmentDraft: pref.task_adjustment_draft || null,
    taskAdjustmentHistory: pref.task_adjustment_history || []
  };
};
app.get('/api/students', { preHandler: requireRoles(['admin','teacher','assistant','operator']) }, async () => (await pool.query(`SELECT ${studentFields} FROM students ORDER BY created_at DESC`)).rows.map(studentDto));
app.get('/api/students/:id', { preHandler: app.auth }, async request => {
  const studentId = uuidSchema.parse(request.params.id);
  if (!canAccessStudent(request, studentId)) throw Object.assign(new Error('无权读取该学员档案'), { statusCode:403 });
  const row = (await pool.query(`SELECT ${studentFields} FROM students WHERE id=$1`, [studentId])).rows[0];
  if (!row) throw Object.assign(new Error('学员不存在'), { statusCode:404 });
  return { ...studentDto(row), ...(await studentPreferencesPayload(studentId)) };
});
app.get('/api/students/:id/preferences', { preHandler: app.auth }, async request => {
  const studentId = uuidSchema.parse(request.params.id);
  if (!canAccessStudent(request, studentId)) throw Object.assign(new Error('无权读取该学员学习偏好'), { statusCode:403 });
  return studentPreferencesPayload(studentId);
});
app.patch('/api/students/:id/preferences', { preHandler: app.auth }, withIdempotency(async request => {
  const studentId = uuidSchema.parse(request.params.id);
  const staff = ['admin','teacher'].includes(request.account.role);
  if (!staff && !canAccessStudent(request, studentId)) throw Object.assign(new Error('无权修改该学员学习偏好'), { statusCode:403 });
  if (!staff && request.account.role !== 'student') throw Object.assign(new Error('无权修改该学员学习偏好'), { statusCode:403 });
  const body = studentPreferenceSchema.parse(request.body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (body.subjects) {
      const existingSubjects = await client.query(
        'SELECT subject,enrolled FROM student_subjects WHERE student_id=$1 FOR UPDATE',
        [studentId]
      );
      const existingEnrollment = new Map(existingSubjects.rows.map(item => [item.subject, item.enrolled]));
      await client.query('DELETE FROM student_subjects WHERE student_id=$1', [studentId]);
      for (const item of body.subjects) {
        const enrolled = staff
          ? (item.enrolled ?? existingEnrollment.get(item.subject) ?? false)
          : (existingEnrollment.get(item.subject) ?? false);
        await client.query(
          'INSERT INTO student_subjects(student_id,subject,enrolled,target_score) VALUES($1,$2,$3,$4)',
          [studentId, item.subject, enrolled, item.targetScore || null]
        );
      }
      // 报名状态驱动学员分组：任一科目确认报名后，新人/体验学员立即归入付费学员。
      const anyEnrolled = body.subjects.some(item => (staff
        ? (item.enrolled ?? existingEnrollment.get(item.subject) ?? false)
        : (existingEnrollment.get(item.subject) ?? false)));
      if (anyEnrolled) {
        await client.query("UPDATE students SET status='付费',updated_at=now() WHERE id=$1 AND status IN ('新人','体验')", [studentId]);
      }
    }
    const adjustmentFields = ['planAdjustmentAutomation','taskAdjustmentDraft','taskAdjustmentHistory'].filter(key => body[key] !== undefined);
    if (body.restWeekday !== undefined || body.assessmentPush !== undefined || adjustmentFields.length) {
      const existing = (await client.query('SELECT rest_weekday,rest_weekday_set_at,assessment_push,plan_adjustment_automation,task_adjustment_draft,task_adjustment_history FROM student_learning_preferences WHERE student_id=$1 FOR UPDATE', [studentId])).rows[0] || {};
      const restChanged = body.restWeekday !== undefined && body.restWeekday !== (existing.rest_weekday ?? null);
      const nextRestWeekday = body.restWeekday === undefined ? (existing.rest_weekday ?? null) : body.restWeekday;
      const nextRestWeekdaySetAt = restChanged ? (body.restWeekday === null ? null : new Date()) : (existing.rest_weekday_set_at || null);
      await client.query(
        `INSERT INTO student_learning_preferences(student_id,rest_weekday,rest_weekday_set_at,assessment_push,plan_adjustment_automation,task_adjustment_draft,task_adjustment_history)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(student_id) DO UPDATE SET rest_weekday=EXCLUDED.rest_weekday,rest_weekday_set_at=EXCLUDED.rest_weekday_set_at,assessment_push=EXCLUDED.assessment_push,plan_adjustment_automation=EXCLUDED.plan_adjustment_automation,task_adjustment_draft=EXCLUDED.task_adjustment_draft,task_adjustment_history=EXCLUDED.task_adjustment_history,updated_at=now()`,
        [
          studentId, nextRestWeekday, nextRestWeekdaySetAt,
          json(body.assessmentPush === undefined ? (existing.assessment_push || {}) : body.assessmentPush),
          json(body.planAdjustmentAutomation === undefined ? (existing.plan_adjustment_automation || null) : body.planAdjustmentAutomation),
          json(body.taskAdjustmentDraft === undefined ? (existing.task_adjustment_draft || null) : body.taskAdjustmentDraft),
          json(body.taskAdjustmentHistory === undefined ? (existing.task_adjustment_history || []) : body.taskAdjustmentHistory)
        ]
      );
    }
    // 7 天免费体验驱动学员分组：开启体验立即进入“体验期学员”，体验结束仍未报名则回到“新人”。
    const trialStatus = body.assessmentPush && typeof body.assessmentPush === 'object' && !Array.isArray(body.assessmentPush)
      ? body.assessmentPush.freeTrial?.status : null;
    if (trialStatus === 'active') {
      await client.query("UPDATE students SET status='体验',updated_at=now() WHERE id=$1 AND status='新人'", [studentId]);
    } else if (trialStatus === 'completed') {
      await client.query("UPDATE students SET status='新人',updated_at=now() WHERE id=$1 AND status='体验'", [studentId]);
    }
    await client.query('COMMIT');
    await audit(request.account.accountId, '修改学习偏好', 'student', studentId, { changed:Object.keys(body) });
    return studentPreferencesPayload(studentId);
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));


app.put('/api/students/:id/plan-adjustment-draft', { preHandler: requireRoles(['admin','teacher']) }, withIdempotency(async request => {
  const studentId = uuidSchema.parse(request.params.id);
  const draft = z.record(z.unknown()).nullable().parse(request.body?.draft ?? request.body ?? null);
  const student = (await pool.query('SELECT id FROM students WHERE id=$1', [studentId])).rows[0];
  if (!student) throw Object.assign(new Error('学员不存在'), { statusCode:404 });
  const result = (await pool.query(
    `INSERT INTO student_learning_preferences(student_id,task_adjustment_draft)
     VALUES($1,$2) ON CONFLICT(student_id) DO UPDATE SET task_adjustment_draft=EXCLUDED.task_adjustment_draft,updated_at=now()
     RETURNING student_id,task_adjustment_draft,updated_at`, [studentId,draft === null ? null : json(draft)])
  ).rows[0];
  await audit(request.account.accountId, '保存计划调整草案', 'student', studentId, { hasDraft:Boolean(draft) });
  return { studentId:result.student_id, draft:result.task_adjustment_draft || null, updatedAt:result.updated_at, status:'pending_review' };
}));
app.get('/api/students/:id/plan-adjustment-draft', { preHandler: app.auth }, async request => {
  const studentId = uuidSchema.parse(request.params.id);
  if (!canAccessStudent(request, studentId)) throw Object.assign(new Error('无权访问计划调整草案'), { statusCode:403 });
  const row = (await pool.query('SELECT student_id,task_adjustment_draft,updated_at FROM student_learning_preferences WHERE student_id=$1', [studentId])).rows[0];
  return { studentId, draft:row?.task_adjustment_draft || null, updatedAt:row?.updated_at || null, status:row?.task_adjustment_draft ? 'pending_review' : 'empty' };
});

app.get('/api/admin/accounts', { preHandler: requireRoles(['admin']) }, async request => {
  const query = z.object({ role: z.enum(['admin','teacher','assistant','operator','student']).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).parse(request.query ?? {});
  const params = [];
  const where = query.role ? 'WHERE role=$1' : '';
  if (query.role) params.push(query.role);
  const limit = query.limit || 100;
  params.push(limit);
  const accounts = (await pool.query(`SELECT id,role,name,phone,status,student_id,must_change_password,created_at,last_login_at FROM accounts ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params)).rows;
  const studentIds = accounts.map(item => item.student_id).filter(Boolean);
  const students = studentIds.length
    ? (await pool.query(`SELECT ${studentFields} FROM students WHERE id=ANY($1::uuid[])`, [studentIds])).rows
    : [];
  const studentById = new Map(students.map(student => [String(student.id), student]));
  return accounts.map(account => accountSummary(account, account.student_id ? studentById.get(String(account.student_id)) : null));
});

const staffStudentCreateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  phone: z.string().regex(/^1\d{10}$/, '手机号须为 1 开头的 11 位数字'),
  year: z.string().trim().min(1).max(30),
  status: z.enum(['免费','新人','体验','付费']).default('新人'),
  shippingInfo: z.string().trim().max(2000).nullable().optional(),
  school: z.string().trim().max(160).nullable().optional(),
  major: z.string().trim().max(160).nullable().optional(),
  targetScore: z.string().trim().max(60).nullable().optional(),
  stage: z.string().trim().min(1).max(80).default('基础'),
  evaluation: z.string().trim().max(5000).nullable().optional(),
  subjects: z.array(examSubjectSchema).max(9).default([])
}).strict();

app.post('/api/admin/students', { preHandler: requireRoles(['admin','teacher']) }, withIdempotency(async request => {
  const body = staffStudentCreateSchema.parse(request.body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const duplicate = await client.query('SELECT id FROM accounts WHERE phone=$1 FOR UPDATE', [body.phone]);
    if (duplicate.rowCount) throw Object.assign(new Error('该手机号已注册'), { statusCode:409 });
    const student = (await client.query(
      `INSERT INTO students(name,year,status,phone,shipping_info,school,major,target_score,stage,evaluation)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [body.name,body.year,body.status,body.phone,body.shippingInfo || null,body.school || null,body.major || null,body.targetScore || null,body.stage,body.evaluation || null]
    )).rows[0];
    const tempPassword = crypto.randomBytes(12).toString('base64url');
    const passwordHash = await argon2.hash(tempPassword, { type: argon2.argon2id });
    const account = (await client.query(
      `INSERT INTO accounts(role,name,phone,password_hash,status,student_id,must_change_password)
       VALUES('student',$1,$2,$3,'启用',$4,true)
       RETURNING id,role,name,phone,status,student_id,must_change_password,created_at,last_login_at`,
      [body.name,body.phone,passwordHash,student.id]
    )).rows[0];
    await client.query('UPDATE students SET account_id=$1 WHERE id=$2', [account.id,student.id]);
    for (const subject of [...new Set(body.subjects)]) {
      await client.query('INSERT INTO student_subjects(student_id,subject,enrolled) VALUES($1,$2,false)', [student.id,subject]);
    }
    await client.query('COMMIT');
    await audit(request.account.accountId, '创建学员账号与档案', 'student', student.id, { accountId:account.id });
    return { student: { ...studentDto({ ...student, account_status:'启用' }), subjects: body.subjects.map(name => ({ name, enrolled:true, targetScore:'' })) }, account: accountSummary(account), tempPassword };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));

const staffStudentImportSchema = z.object({
  students: z.array(staffStudentCreateSchema).min(1).max(1000)
}).strict();

app.post('/api/admin/students/import', { preHandler: requireRoles(['admin','teacher']) }, withIdempotency(async request => {
  const body = staffStudentImportSchema.parse(request.body);
  const phones = body.students.map(item => item.phone);
  if (new Set(phones).size !== phones.length) {
    throw Object.assign(new Error('导入数据中存在重复手机号，请先修正后重试'), { statusCode:422 });
  }

  const client = await pool.connect();
  const created = [];
  try {
    await client.query('BEGIN');
    const duplicates = (await client.query('SELECT phone FROM accounts WHERE phone = ANY($1::text[]) FOR UPDATE', [phones])).rows;
    if (duplicates.length) {
      throw Object.assign(new Error(`以下手机号已注册：${duplicates.map(row => row.phone).join('、')}`), { statusCode:409 });
    }

    for (const item of body.students) {
      const student = (await client.query(
        `INSERT INTO students(name,year,status,phone,shipping_info,school,major,target_score,stage,evaluation)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [item.name, item.year, item.status, item.phone, item.shippingInfo || null, item.school || null, item.major || null, item.targetScore || null, item.stage, item.evaluation || null]
      )).rows[0];
      const tempPassword = crypto.randomBytes(12).toString('base64url');
      const passwordHash = await argon2.hash(tempPassword, { type: argon2.argon2id });
      const account = (await client.query(
        `INSERT INTO accounts(role,name,phone,password_hash,status,student_id,must_change_password)
         VALUES('student',$1,$2,$3,'启用',$4,true)
         RETURNING id,role,name,phone,status,student_id,must_change_password,created_at,last_login_at`,
        [item.name, item.phone, passwordHash, student.id]
      )).rows[0];
      await client.query('UPDATE students SET account_id=$1 WHERE id=$2', [account.id, student.id]);
      for (const subject of [...new Set(item.subjects)]) {
        await client.query('INSERT INTO student_subjects(student_id,subject,enrolled) VALUES($1,$2,false)', [student.id, subject]);
      }
      created.push({
        student: { ...studentDto({ ...student, account_status:'启用' }), subjects: [...new Set(item.subjects)].map(name => ({ name, enrolled:true, targetScore:'' })) },
        account: accountSummary(account),
        tempPassword
      });
    }
    await client.query('COMMIT');
    await audit(request.account.accountId, '批量创建学员账号与档案', 'student_import', null, { count:created.length });
    return { count:created.length, created };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/admin/accounts', { preHandler: requireRoles(['admin']) }, withIdempotency(async request => {
  const body = adminAccountSchema.parse(request.body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const duplicate = await client.query('SELECT id FROM accounts WHERE phone=$1 FOR UPDATE', [body.phone]);
    if (duplicate.rowCount) throw Object.assign(new Error('该手机号已注册'), { statusCode: 409 });
    let studentId = null;
    if (body.role === 'student') {
      const student = (await client.query("INSERT INTO students(name,year,status,phone,major,stage,evaluation) VALUES($1,'考研年份待填写','新人',$2,$3,'基础','管理员创建账号，待补全学情档案。') RETURNING *", [body.name, body.phone, null])).rows[0];
      studentId = student.id;
    }
    const tempPassword = body.password || crypto.randomBytes(9).toString('base64url');
    const passwordHash = await argon2.hash(tempPassword, { type: argon2.argon2id });
    const account = (await client.query(
      "INSERT INTO accounts(role,name,phone,password_hash,status,student_id,must_change_password) VALUES($1,$2,$3,$4,'启用',$5,$6) RETURNING id,role,name,phone,status,student_id,must_change_password,created_at,last_login_at",
      [body.role, body.name, body.phone, passwordHash, studentId, body.mustChangePassword ?? true]
    )).rows[0];
    if (studentId) await client.query('UPDATE students SET account_id=$1 WHERE id=$2', [account.id, studentId]);
    await client.query('INSERT INTO audit_logs(actor_account_id,action,entity_type,entity_id,metadata) VALUES($1,$2,$3,$4,$5)', [request.account.accountId,'管理员创建账号','account',account.id,json({ role:body.role, studentId, gavePassword:Boolean(body.password) })]);
    await client.query('COMMIT');
    return { account: accountSummary(account), tempPassword: body.password ? null : tempPassword };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));

app.patch('/api/admin/accounts/:id', { preHandler: requireRoles(['admin']) }, withIdempotency(async request => {
  const accountId = uuidSchema.parse(request.params.id);
  const patch = adminAccountPatchSchema.parse(request.body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = (await client.query('SELECT id,role,name,phone,status,student_id,must_change_password FROM accounts WHERE id=$1 FOR UPDATE', [accountId])).rows[0];
    if (!current) throw Object.assign(new Error('账号不存在'), { statusCode: 404 });
    const resetPassword = patch.resetPassword ? crypto.randomBytes(12).toString('base64url') : null;
    if (patch.password || resetPassword) {
      const passwordHash = await argon2.hash(patch.password || resetPassword, { type: argon2.argon2id });
      await client.query('UPDATE accounts SET password_hash=$1, must_change_password=COALESCE($2,true), session_version=session_version+1 WHERE id=$3', [passwordHash, patch.mustChangePassword, accountId]);
    } else if (patch.mustChangePassword !== undefined) {
      await client.query('UPDATE accounts SET must_change_password=$1 WHERE id=$2', [patch.mustChangePassword, accountId]);
    }
    if (patch.status) {
      await activeAdminGuard(client, accountId, { nextStatus: patch.status });
      await client.query('UPDATE accounts SET status=$1, session_version=session_version+1 WHERE id=$2', [patch.status, accountId]);
    }
    if (patch.name) {
      await client.query('UPDATE accounts SET name=$1 WHERE id=$2', [patch.name, accountId]);
      if (current.student_id) await client.query('UPDATE students SET name=$1 WHERE id=$2', [patch.name, current.student_id]);
    }
    const updated = (await client.query('SELECT id,role,name,phone,status,student_id,must_change_password,created_at,last_login_at FROM accounts WHERE id=$1', [accountId])).rows[0];
    await client.query('INSERT INTO audit_logs(actor_account_id,action,entity_type,entity_id,metadata) VALUES($1,$2,$3,$4,$5)', [request.account.accountId,'管理员修改账号','account',accountId,json({ fields:Object.keys(patch) })]);
    await client.query('COMMIT');
    return { account: accountSummary(updated), tempPassword: resetPassword };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));

app.delete('/api/admin/accounts/:id', { preHandler: requireRoles(['admin']) }, withIdempotency(async request => {
  const accountId = uuidSchema.parse(request.params.id);
  if (request.account.accountId === accountId) throw Object.assign(new Error('当前登录账号不能删除'), { statusCode: 409 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const target = (await client.query('SELECT id,role,student_id FROM accounts WHERE id=$1 FOR UPDATE', [accountId])).rows[0];
    if (!target) throw Object.assign(new Error('账号不存在'), { statusCode: 404 });
    await activeAdminGuard(client, accountId, { deleting: true });
    await client.query('UPDATE students SET account_id=NULL WHERE id=$1', [target.student_id]);
    await client.query('DELETE FROM accounts WHERE id=$1', [accountId]);
    await client.query('INSERT INTO audit_logs(actor_account_id,action,entity_type,entity_id,metadata) VALUES($1,$2,$3,$4,$5)', [request.account.accountId,'管理员删除账号','account',accountId,json({ role:target.role, studentId:target.student_id })]);
    await client.query('COMMIT');
    return { ok: true };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));

app.get('/api/admin/audit-logs', { preHandler: requireRoles(['admin']) }, async request => {
  const query = z.object({
    limit: z.coerce.number().int().min(1).max(500).optional(),
    action: z.string().trim().max(80).optional(),
    entityType: z.string().trim().max(40).optional(),
    actorAccountId: uuidSchema.optional()
  }).parse(request.query ?? {});
  const params = [];
  const filters = [];
  if (query.action) { params.push(query.action); filters.push(`action=$${params.length}`); }
  if (query.entityType) { params.push(query.entityType); filters.push(`entity_type=$${params.length}`); }
  if (query.actorAccountId) { params.push(query.actorAccountId); filters.push(`actor_account_id=$${params.length}`); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const limit = query.limit || 100;
  params.push(limit);
  const result = await pool.query(
    `SELECT id, actor_account_id, action, entity_type, entity_id, metadata, created_at
     FROM audit_logs ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  return result.rows;
});
app.patch('/api/students/:id', { preHandler: app.auth }, withIdempotency(async request => {
  const studentId = uuidSchema.parse(request.params.id);
  const role = request.account.role;
  const privilegedStaff = ['admin','teacher'].includes(role);
  const assistant = role === 'assistant';
  if (!privilegedStaff && !assistant && role !== 'student') throw Object.assign(new Error('当前账号无权修改学员档案'), { statusCode:403 });
  if (!privilegedStaff && !assistant && !canAccessStudent(request, studentId)) throw Object.assign(new Error('无权修改该学员档案'), { statusCode:403 });
  if (assistant && !canAccessStudent(request, studentId)) throw Object.assign(new Error('无权修改该学员档案'), { statusCode:403 });
  const staff = privilegedStaff || assistant;
  const patch = (privilegedStaff
    ? staffStudentPatchSchema
    : assistant
      ? assistantStudentPatchSchema
      : selfStudentPatchSchema
  ).parse(request.body);
  const current = (await pool.query(`SELECT ${studentFields} FROM students WHERE id=$1`, [studentId])).rows[0];
  if (!current) throw Object.assign(new Error('学员不存在'), { statusCode:404 });
  const values = {
    name: patch.name ?? current.name, year: patch.year ?? current.year, status: patch.status ?? current.status,
    email: patch.email === undefined ? current.email : patch.email,
    wechatId: patch.wechatId === undefined ? current.wechat_id : patch.wechatId,
    shippingRecipient: patch.shippingRecipient === undefined ? current.shipping_recipient : patch.shippingRecipient,
    shippingPhone: patch.shippingPhone === undefined ? current.shipping_phone : patch.shippingPhone,
    shippingInfo: patch.shippingInfo === undefined ? current.shipping_info : patch.shippingInfo,
    school: patch.school === undefined ? current.school : patch.school,
    major: patch.major === undefined ? current.major : patch.major,
    targetScore: patch.targetScore === undefined ? current.target_score : patch.targetScore,
    stage: patch.stage ?? current.stage,
    evaluation: patch.evaluation === undefined ? current.evaluation : patch.evaluation,
    paidUntil: patch.paidUntil === undefined ? current.paid_until : patch.paidUntil
  };
  const row = (await pool.query('UPDATE students SET name=$1,year=$2,status=$3,email=$4,wechat_id=$5,shipping_recipient=$6,shipping_phone=$7,shipping_info=$8,school=$9,major=$10,target_score=$11,stage=$12,evaluation=$13,paid_until=$14,updated_at=now() WHERE id=$15 RETURNING *', [values.name,values.year,values.status,values.email,values.wechatId,values.shippingRecipient,values.shippingPhone,values.shippingInfo,values.school,values.major,values.targetScore,values.stage,values.evaluation,values.paidUntil,studentId])).rows[0];
  await audit(request.account.accountId, staff ? '修改学员档案' : '修改本人档案', 'student', studentId, { fields:Object.keys(patch) });
  return studentDto(row);
}));

const orderFields = 'id,student_id,product_id,amount,provider,provider_trade_id,status,created_at,paid_at,reviewed_at,review_note,reviewed_by';
const entitlementFields = 'id,student_id,product_id,course_ids,scope,kind,starts_at,ends_at,status,source,created_at';
const courseFields = 'id,name,subject,audience,category,description,pricing,price,state,scope,created_at,updated_at';
const productFields = 'id,name,category,description,pricing,price,state,course_ids,scope,created_by,created_at,updated_at';
const coursePayload = course => ({
  id:course.id, name:course.name, subject:course.subject, audience:course.audience,
  category:course.category, description:course.description, pricing:course.pricing,
  price:Number(course.price), state:course.state, scope:normalizeCourseScope(course.scope), createdAt:course.created_at,
  updatedAt:course.updated_at
});
const productPayload = product => ({
  id:product.id, name:product.name, category:product.category,
  description:product.description, pricing:product.pricing, price:Number(product.price),
  state:product.state, courseIds:Array.isArray(product.course_ids) ? product.course_ids : [],
  scope:normalizeCourseScope(product.scope), createdAt:product.created_at, updatedAt:product.updated_at
});
const assertCoursePublishable = async (queryable, courseId) => {
  const course = (await queryable.query(
    'SELECT description, pricing, price FROM courses WHERE id=$1', [courseId]
  )).rows[0];
  if (!course) throw Object.assign(new Error('课程不存在'), { statusCode:404 });
  if (!course.description?.trim()) throw Object.assign(new Error('课程必须填写课程说明后才能发布'), { statusCode:422 });
  if (course.pricing === '付费' && Number(course.price) <= 0) throw Object.assign(new Error('付费课程价格必须大于 0'), { statusCode:422 });
};
const assertProductPublishable = async (queryable, product) => {
  if (product.pricing === '付费' && Number(product.price) <= 0) throw Object.assign(new Error('付费商品价格必须大于 0'), { statusCode:422 });
  if (product.pricing === '免费' && Number(product.price) !== 0) throw Object.assign(new Error('免费商品价格必须为 0'), { statusCode:422 });
  if (!Array.isArray(product.courseIds) || product.courseIds.length === 0) throw Object.assign(new Error('商品上架前至少需要绑定一门课程'), { statusCode:422 });
  const courseIds = [...new Set(product.courseIds.map(String))];
  if (courseIds.length !== product.courseIds.length) throw Object.assign(new Error('商品绑定课程不能重复'), { statusCode:422 });
  const result = await queryable.query(
    "SELECT count(*)::int AS count FROM courses WHERE id=ANY($1::uuid[]) AND state='已发布'",
    [courseIds]
  );
  if (result.rows[0].count !== courseIds.length) throw Object.assign(new Error('商品绑定的课程必须全部已发布'), { statusCode:422 });
};
const getStudentContext = async (queryable, studentId) => {
  const student = (await queryable.query('SELECT id,school,major,year FROM students WHERE id=$1', [studentId])).rows[0];
  if (!student) throw Object.assign(new Error('学员不存在'), { statusCode:404 });
  const subjects = (await queryable.query('SELECT subject FROM student_subjects WHERE student_id=$1 AND enrolled=true', [studentId])).rows.map(row => row.subject);
  return { student, subjects };
};
const subjectVariantListSql = "('英语一','英语二','英语三','数学一','数学二','数学三')";
const subjectMatchSql = (column, parameter) => `(${column}=${parameter} OR (${column} IN ${subjectVariantListSql} AND ${parameter} IN ('英语','数学') AND left(${column},2)=${parameter}) OR (${column} NOT IN ${subjectVariantListSql} AND ${parameter} NOT IN ${subjectVariantListSql} AND (${column} LIKE ${parameter} || '一' OR ${column} LIKE ${parameter} || '二' OR ${column} LIKE ${parameter} || '三' OR ${parameter} LIKE ${column} || '一' OR ${parameter} LIKE ${column} || '二' OR ${parameter} LIKE ${column} || '三'))) `;
const assertStudentSubjectEnrollment = async (queryable, studentId, subject) => {
  const value = String(subject || '').trim();
  const row = (await queryable.query(
    `SELECT subject FROM student_subjects
     WHERE student_id=$1 AND enrolled=true AND ${subjectMatchSql('subject', '$2')}
     LIMIT 1`, [studentId, value]
  )).rows[0];
  if (!row) throw Object.assign(new Error('该自测科目未被教师确认报名'), { statusCode:403 });
  return row.subject;
};
const activeEntitlementForCourse = async (queryable, studentId, courseId) => (await queryable.query(
  `SELECT id,student_id,product_id,course_ids,scope,kind,starts_at,ends_at,status,source,created_at
   FROM entitlements
   WHERE student_id=$1 AND status='有效' AND (ends_at IS NULL OR ends_at > now())
     AND course_ids @> $2::jsonb ORDER BY created_at DESC LIMIT 1`,
  [studentId, json([String(courseId)])]
)).rows[0] || null;
const assertStudentCourseAccess = async (queryable, studentId, courseId) => {
  const context = await getStudentContext(queryable, studentId);
  const course = (await queryable.query('SELECT id,state,subject,scope FROM courses WHERE id=$1', [courseId])).rows[0];
  if (!course) throw Object.assign(new Error('课程不存在或无权访问'), { statusCode:404 });
  const entitlement = await activeEntitlementForCourse(queryable, studentId, courseId);
  // 已获得有效权益的学生不受课程下架或 scope 变更影响，仍可在“我的课程”继续学习。
  if (entitlement) return { course, entitlement, context };
  if (course.state !== '已发布') throw Object.assign(new Error('课程不存在或无权访问'), { statusCode:404 });
  throw Object.assign(new Error('尚未获得该课程权益，请先在商城领取或购买'), { statusCode:403 });
};
const assertPublishedCourseBindings = async (queryable, product) => {
  const courseIds = Array.isArray(product?.course_ids) ? [...new Set(product.course_ids.map(String))] : [];
  if (!courseIds.length || courseIds.length !== product.course_ids.length) throw Object.assign(new Error('商品未绑定有效且不重复的课程'), { statusCode:422 });
  const result = await queryable.query('SELECT id,state FROM courses WHERE id=ANY($1::uuid[])', [courseIds]);
  if (result.rows.length !== courseIds.length || result.rows.some(row => row.state !== '已发布')) throw Object.assign(new Error('商品绑定的课程不存在或已下架'), { statusCode:422 });
};
const orderPayload = order => ({
  id:order.id, studentId:order.student_id, productId:order.product_id,
  productName:order.product_name || null, amount:Number(order.amount), provider:order.provider,
  status:order.status, createdAt:order.created_at, paidAt:order.paid_at,
  reviewedAt:order.reviewed_at, reviewNote:order.review_note,
  reviewedBy:order.reviewed_by, studentName:order.student_name
});
const grantEntitlement = async (client, { studentId, productId, courseIds, scope = {}, source }) => {
  const entitlement = (await client.query(
    "INSERT INTO entitlements(student_id,product_id,course_ids,scope,kind,status,source) VALUES($1,$2,$3,$4,'课程权益','有效',$5) ON CONFLICT (student_id,product_id) WHERE status='有效' AND ends_at IS NULL DO UPDATE SET course_ids=EXCLUDED.course_ids,scope=EXCLUDED.scope,source=EXCLUDED.source RETURNING *",
    [studentId, String(productId), json(courseIds), json(normalizeCourseScope(scope)), source]
  )).rows[0];
  return entitlement;
};

app.get('/api/courses', { preHandler: app.auth }, async (request, reply) => {
  // 已发布课程是商城实时数据；禁止中间缓存把教师刚发布的记录延迟到学生端。
  reply.header('Cache-Control', 'private, no-store, max-age=0');
  reply.header('Pragma', 'no-cache');
  if (['admin','teacher','assistant','operator'].includes(request.account.role)) {
    return (await pool.query(`SELECT ${courseFields} FROM courses ORDER BY created_at DESC`)).rows.map(coursePayload);
  }
  // 商城目录对所有学生展示全部已发布课程：报名/领取只影响“开通”，不影响“可见”。
  // 已获得有效权益的课程（含开通后被下架的）一并返回，保证“我的课程”下架后仍可学习。
  const entitled = await pool.query(
    `SELECT DISTINCT course_id FROM entitlements e CROSS JOIN LATERAL jsonb_array_elements_text(e.course_ids) AS course_id
     WHERE e.student_id=$1 AND e.status='有效' AND (e.ends_at IS NULL OR e.ends_at > now())`,
    [request.account.studentId]
  );
  const entitledIds = entitled.rows.map(row => String(row.course_id)).filter(value => /^[0-9a-fA-F-]{36}$/.test(value));
  const result = await pool.query(
    `SELECT ${courseFields} FROM courses WHERE state='已发布' OR id=ANY($1::uuid[]) ORDER BY created_at DESC`,
    [entitledIds]
  );
  return result.rows.map(coursePayload);
});

const bookPayload = row => ({
  id: row.id, subject: row.subject, name: row.name, description: row.description || '',
  fileName: row.file_name || '', mimeType: row.mime_type || '', sizeBytes: Number(row.size_bytes || 0),
  parseStatus: row.parse_status || '未上传', parseError: row.parse_error || '', chunkCount: Number(row.chunk_count || 0),
  createdAt: row.created_at, updatedAt: row.updated_at
});
// ===== 知识库书籍上传与文本提取 =====
const KNOWLEDGE_BOOK_MAX_BYTES = 150 * 1024 * 1024;
const knowledgeBookExtension = (fileName, mimeType) => {
  const extension = path.extname(String(fileName || '')).toLowerCase();
  if (['.pdf', '.txt', '.md'].includes(extension)) return extension;
  if (String(mimeType || '').toLowerCase().includes('pdf')) return '.pdf';
  if (String(mimeType || '').toLowerCase().startsWith('text/')) return '.txt';
  return '';
};
const readStreamToBuffer = async (stream, maxBytes) => {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw Object.assign(new Error('文件超过允许的大小上限'), { statusCode: 422, code: 'FILE_TOO_LARGE' });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};
const PDF_EXTRACT_SCRIPT = fileURLToPath(new URL('../scripts/extract_book_text.py', import.meta.url));
const runPdfTextExtraction = filePath => new Promise((resolve, reject) => {
  const child = spawn(process.env.PYTHON_BIN || 'python3', [PDF_EXTRACT_SCRIPT, filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('PDF 文本提取超时，请检查文件后重试')); }, 120000);
  child.stdout.on('data', chunk => { stdoutBytes += chunk.length; if (stdoutBytes <= 32 * 1024 * 1024) stdout.push(chunk); });
  child.stderr.on('data', chunk => stderr.push(chunk));
  child.on('error', error => { clearTimeout(timer); reject(new Error(`PDF 解析进程启动失败：${error.message}`)); });
  child.on('close', code => {
    clearTimeout(timer);
    if (code === 0) return resolve(Buffer.concat(stdout).toString('utf8'));
    const detail = Buffer.concat(stderr).toString('utf8').trim().slice(0, 300);
    reject(new Error(detail ? `PDF 文本提取失败：${detail}` : 'PDF 文本提取失败，请确认服务器已安装 pdfminer.six 或 pypdf'));
  });
});
const extractKnowledgeBookText = async (objectKey, extension) => {
  if (extension === '.txt' || extension === '.md') {
    const buffer = await readStreamToBuffer(await storage.readObjectStream({ key: objectKey }), KNOWLEDGE_BOOK_MAX_BYTES);
    return buffer.toString('utf8');
  }
  if (extension === '.pdf') {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shangan-book-'));
    try {
      const tempFile = path.join(tempDir, 'book.pdf');
      await fs.writeFile(tempFile, await readStreamToBuffer(await storage.readObjectStream({ key: objectKey }), KNOWLEDGE_BOOK_MAX_BYTES));
      return await runPdfTextExtraction(tempFile);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  throw Object.assign(new Error('知识库暂支持 PDF、TXT 或 Markdown 文件'), { statusCode: 422, code: 'UNSUPPORTED_FILE_TYPE' });
};
const chunkKnowledgeText = (text, size = 1500) => {
  const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  const chunks = [];
  let current = '';
  for (const paragraph of normalized.split(/\n{2,}/)) {
    const piece = paragraph.trim();
    if (!piece) continue;
    if (piece.length > size) {
      if (current) { chunks.push(current); current = ''; }
      for (let index = 0; index < piece.length; index += size) chunks.push(piece.slice(index, index + size));
      continue;
    }
    if (current && `${current}\n\n${piece}`.length > size) { chunks.push(current); current = piece; }
    else current = current ? `${current}\n\n${piece}` : piece;
  }
  if (current) chunks.push(current);
  return chunks.slice(0, 5000);
};
const handleKnowledgeBookUpload = async request => {
  const file = await request.file();
  if (!file) throw Object.assign(new Error('请选择要上传的书籍文件'), { statusCode: 422 });
  const fields = file.fields || {};
  const subjectResult = bookSchema.shape.subject.safeParse(String(fields.subject?.value || '通用'));
  const subject = subjectResult.success ? subjectResult.data : '通用';
  const fileName = String(file.filename || '未命名书籍').replace(/[\\/\0]/g, '_').slice(0, 200);
  const mimeType = String(file.mimetype || '').toLowerCase().split(';', 1)[0].trim();
  const extension = knowledgeBookExtension(fileName, mimeType);
  if (!extension) throw Object.assign(new Error('知识库暂支持 PDF、TXT 或 Markdown 文件'), { statusCode: 422, code: 'UNSUPPORTED_FILE_TYPE' });
  if (file.file.truncated) throw Object.assign(new Error('文件超过 150MB 上限'), { statusCode: 422, code: 'FILE_TOO_LARGE' });
  const name = String(fields.name?.value || '').trim().slice(0, 160) || fileName.replace(/\.[^.]+$/, '') || fileName;
  const description = String(fields.description?.value || '').trim().slice(0, 2000) || null;
  const objectKey = generateObjectKey('books', fileName);
  let stored;
  try {
    stored = await storage.putObject({ key: objectKey, body: file.file, contentType: mimeType || 'application/octet-stream', maxBytes: KNOWLEDGE_BOOK_MAX_BYTES });
  } catch (error) {
    throw Object.assign(new Error(error?.code === 'FILE_TOO_LARGE' ? '文件超过 150MB 上限' : '书籍文件存储失败，请稍后重试'), { statusCode: error?.statusCode || 503, code: error?.code || 'STORAGE_WRITE_FAILED' });
  }
  const book = (await pool.query(
    `INSERT INTO books(subject,name,description,file_name,object_key,mime_type,size_bytes,parse_status,uploaded_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,'解析中',$8) RETURNING *`,
    [subject, name, description, fileName, objectKey, mimeType || null, stored.size, request.account.accountId]
  )).rows[0];
  try {
    const text = await extractKnowledgeBookText(objectKey, extension);
    const chunks = chunkKnowledgeText(text);
    if (!chunks.length) throw new Error('未能从文件中提取到可用文本');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [index, content] of chunks.entries()) {
        await client.query('INSERT INTO book_chunks(book_id,chunk_index,content) VALUES($1,$2,$3)', [book.id, index, content]);
      }
      await client.query("UPDATE books SET parse_status='已解析',parse_error=NULL,chunk_count=$2,updated_at=now() WHERE id=$1", [book.id, chunks.length]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  } catch (error) {
    await pool.query("UPDATE books SET parse_status='解析失败',parse_error=$2,updated_at=now() WHERE id=$1", [book.id, String(error?.message || '解析失败').slice(0, 500)]).catch(() => {});
  }
  await audit(request.account.accountId, '上传知识库书籍', 'book', book.id, { subject, fileName, sizeBytes: stored.size });
  return bookPayload((await pool.query('SELECT * FROM books WHERE id=$1', [book.id])).rows[0]);
};
const bookRecipientPayload = row => ({
  id: row.id, bookId: row.book_id, studentId: row.student_id,
  recipient: row.recipient, phone: row.phone || '', shippingInfo: row.shipping_info || '',
  issuedAt: row.issued_at, createdAt: row.created_at,
  studentName: row.student_name || '', autoAssigned: Boolean(row.auto_assigned)
});
const syncBookSubjectRecipients = async (queryable, bookId) => {
  const book = (await queryable.query('SELECT id,subject FROM books WHERE id=$1 FOR UPDATE', [bookId])).rows[0];
  if (!book) throw Object.assign(new Error('书籍不存在'), { statusCode:404 });
  const subjectMatch = book.subject === '通用'
    ? 'true'
    : "(ss.subject=$1 OR ss.subject LIKE $1 || '一' OR ss.subject LIKE $1 || '二' OR ss.subject LIKE $1 || '三')";
  const enrolledStudents = await queryable.query(
    `SELECT DISTINCT s.id,s.name,s.shipping_recipient,s.shipping_phone,s.shipping_info
     FROM students s JOIN student_subjects ss ON ss.student_id=s.id AND ss.enrolled=true
     WHERE ${subjectMatch}`,
    book.subject === '通用' ? [] : [book.subject]
  );
  for (const student of enrolledStudents.rows) {
    await queryable.query(
      `INSERT INTO book_distribution_students(book_id,student_id,recipient,phone,shipping_info,auto_assigned)
       VALUES($1,$2,$3,$4,$5,true)
       ON CONFLICT (book_id,student_id) WHERE student_id IS NOT NULL DO UPDATE
       SET recipient=CASE WHEN book_distribution_students.auto_assigned THEN EXCLUDED.recipient ELSE book_distribution_students.recipient END,
           phone=CASE WHEN book_distribution_students.auto_assigned THEN EXCLUDED.phone ELSE book_distribution_students.phone END,
           shipping_info=CASE WHEN book_distribution_students.auto_assigned THEN EXCLUDED.shipping_info ELSE book_distribution_students.shipping_info END`,
      [bookId, student.id, student.shipping_recipient || student.name, student.shipping_phone || null, student.shipping_info || null]
    );
  }
  return book;
};

app.get('/api/admin/books', { preHandler: requireRoles(['admin','teacher']) }, async () => {
  const books = (await pool.query('SELECT * FROM books ORDER BY subject,created_at DESC')).rows;
  return books.map(bookPayload);
});
app.post('/api/admin/books', { preHandler: requireRoles(['admin','teacher']) }, async request => {
  // 知识库上传书籍走 multipart；原有的书籍元数据创建（发放管理）仍是 JSON。
  if (request.isMultipart()) return handleKnowledgeBookUpload(request);
  const body = bookSchema.parse(request.body);
  const row = (await pool.query(
    'INSERT INTO books(subject,name,description) VALUES($1,$2,$3) RETURNING *',
    [body.subject, body.name, body.description || null]
  )).rows[0];
  await audit(request.account.accountId, '新建书籍', 'book', row.id, { subject:body.subject });
  return bookPayload(row);
});
app.delete('/api/admin/books/:id', { preHandler: requireRoles(['admin','teacher']) }, async request => {
  const id = uuidSchema.parse(request.params.id);
  const row = (await pool.query('DELETE FROM books WHERE id=$1 RETURNING id,object_key', [id])).rows[0];
  if (!row) throw Object.assign(new Error('书籍不存在'), { statusCode:404 });
  // 文本块随外键级联删除；磁盘文件尽力清理，失败不影响档案删除结果。
  if (row.object_key) await storage.deleteObject({ key: row.object_key }).catch(() => {});
  await audit(request.account.accountId, '删除书籍', 'book', id);
  return { id };
});
app.get('/api/admin/books/:id/recipients', { preHandler: requireRoles(['admin','teacher']) }, async request => {
  const bookId = uuidSchema.parse(request.params.id);
  await syncBookSubjectRecipients(pool, bookId);
  const rows = (await pool.query(
    `SELECT d.*,s.name AS student_name FROM book_distribution_students d
     LEFT JOIN students s ON s.id=d.student_id WHERE d.book_id=$1 ORDER BY d.created_at DESC`, [bookId]
  )).rows;
  return rows.map(bookRecipientPayload);
});
app.post('/api/admin/books/:id/recipients', { preHandler: requireRoles(['admin','teacher']) }, async request => {
  const bookId = uuidSchema.parse(request.params.id);
  const body = bookRecipientSchema.parse(request.body);
  const book = (await pool.query('SELECT id FROM books WHERE id=$1', [bookId])).rows[0];
  if (!book) throw Object.assign(new Error('书籍不存在'), { statusCode:404 });
  const row = (await pool.query(
    `INSERT INTO book_distribution_students(book_id,student_id,recipient,phone,shipping_info)
     VALUES($1,$2,$3,$4,$5) RETURNING *`,
    [bookId, body.studentId || null, body.recipient, body.phone || null, body.shippingInfo || null]
  )).rows[0];
  await audit(request.account.accountId, '添加书籍发放学员', 'book_distribution_student', row.id, { bookId });
  return bookRecipientPayload(row);
});
app.patch('/api/admin/books/:bookId/recipients/:id', { preHandler: requireRoles(['admin','teacher']) }, async request => {
  const bookId = uuidSchema.parse(request.params.bookId);
  const id = uuidSchema.parse(request.params.id);
  const body = z.object({ issued:z.boolean() }).parse(request.body);
  const row = (await pool.query(
    'UPDATE book_distribution_students SET issued_at=CASE WHEN $1 THEN COALESCE(issued_at,now()) ELSE NULL END WHERE id=$2 AND book_id=$3 RETURNING *',
    [body.issued, id, bookId]
  )).rows[0];
  if (!row) throw Object.assign(new Error('发书记录不存在'), { statusCode:404 });
  await audit(request.account.accountId, body.issued ? '标记书籍已发放' : '取消书籍发放标记', 'book_distribution_student', id, { bookId });
  return bookRecipientPayload(row);
});
app.delete('/api/admin/books/:bookId/recipients/:id', { preHandler: requireRoles(['admin','teacher']) }, async request => {
  const bookId = uuidSchema.parse(request.params.bookId);
  const id = uuidSchema.parse(request.params.id);
  const row = (await pool.query('DELETE FROM book_distribution_students WHERE id=$1 AND book_id=$2 RETURNING id', [id, bookId])).rows[0];
  if (!row) throw Object.assign(new Error('发书记录不存在'), { statusCode:404 });
  await audit(request.account.accountId, '删除书籍发放学员', 'book_distribution_student', id, { bookId });
  return { id };
});
app.get('/api/admin/books/shipping-export', { preHandler: requireRoles(['admin','teacher']) }, async (_request, reply) => {
  const rows = (await pool.query(
    `SELECT b.subject,b.name AS book_name,COALESCE(d.recipient,s.shipping_recipient,s.name) AS recipient,
      COALESCE(d.phone,s.shipping_phone,'') AS phone,COALESCE(d.shipping_info,s.shipping_info,'') AS shipping_info,
      CASE WHEN d.issued_at IS NULL THEN '未发放' ELSE '已发放' END AS issued_status
     FROM book_distribution_students d JOIN books b ON b.id=d.book_id
     LEFT JOIN students s ON s.id=d.student_id ORDER BY b.subject,b.name,d.created_at DESC`
  )).rows;
  const csv = ['科目,书籍,收货昵称,联系电话,收货地址,发放状态', ...rows.map(row => [row.subject,row.book_name,row.recipient,row.phone,row.shipping_info,row.issued_status].map(value => `"${String(value || '').replaceAll('"','""')}"`).join(','))].join('\n');
  reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', "attachment; filename*=UTF-8''%E5%AD%A6%E5%91%98%E6%94%B6%E8%B4%A7%E4%BF%A1%E6%81%AF.csv");
  return `﻿${csv}`;
});
app.post('/api/admin/courses', { preHandler: requireRoles(['admin','teacher']) }, withIdempotency(async (request, reply) => {
  const body = courseSchema.parse(request.body);
  if (body.state !== '草稿') {
    throw Object.assign(new Error('课程必须先创建为草稿，再通过发布接口上架'), { statusCode: 422 });
  }
  const result = (await pool.query(
    'INSERT INTO courses(name,subject,audience,category,description,pricing,price,state,scope) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ' + courseFields,
    [body.name,body.subject || null,body.audience,body.category || null,body.description || null,body.pricing,body.price,body.state,json(body.scope)]
  )).rows[0];
  await audit(request.account.accountId, '创建课程', 'course', result.id, { state:body.state, pricing:body.pricing });
  return coursePayload(result);
}));
app.patch('/api/admin/courses/:id', { preHandler: requireRoles(['admin','teacher']) }, withIdempotency(async request => {
  const id = uuidSchema.parse(request.params.id);
  const patch = courseSchema.innerType().partial().parse(request.body);
  const current = (await pool.query(`SELECT ${courseFields} FROM courses WHERE id=$1`, [id])).rows[0];
  if (!current) throw Object.assign(new Error('课程不存在'), { statusCode:404 });
  const merged = courseSchema.parse({ ...coursePayload(current), ...patch });
  if (!isAllowedStateTransition('course', current.state, merged.state)) throw Object.assign(new Error('课程状态变更不符合状态机规则'), { statusCode: 409 });
  if (merged.state === '已发布') await assertCoursePublishable(pool, id);
  const result = (await pool.query(
    'UPDATE courses SET name=$1,subject=$2,audience=$3,category=$4,description=$5,pricing=$6,price=$7,state=$8,scope=$9,updated_at=now() WHERE id=$10 RETURNING ' + courseFields,
    [merged.name,merged.subject || null,merged.audience,merged.category || null,merged.description || null,merged.pricing,merged.price,merged.state,json(merged.scope),id]
  )).rows[0];
  await audit(request.account.accountId, '修改课程', 'course', id, { state:merged.state, pricing:merged.pricing });
  return coursePayload(result);
}));
app.post('/api/admin/courses/:id/publish', { preHandler: requireRoles(['admin','teacher']) }, withIdempotency(async request => {
  const id = uuidSchema.parse(request.params.id);
  const body = z.object({ state:z.enum(['已发布','已下架']) }).parse(request.body);
  const current = (await pool.query('SELECT state FROM courses WHERE id=$1', [id])).rows[0];
  if (!current) throw Object.assign(new Error('课程不存在'), { statusCode:404 });
  if (!isAllowedStateTransition('course', current.state, body.state)) throw Object.assign(new Error('课程状态变更不符合状态机规则'), { statusCode:409 });
  if (body.state === '已发布') await assertCoursePublishable(pool, id);
  const result = (await pool.query('UPDATE courses SET state=$1,updated_at=now() WHERE id=$2 RETURNING ' + courseFields, [body.state,id])).rows[0];
  if (!result) throw Object.assign(new Error('课程不存在'), { statusCode:404 });
  if (body.state === '已下架') {
    // 课程下架必须带走绑定它的商城商品，否则学生端商城仍然展示可领取。
    await pool.query("UPDATE products SET state='已下架',updated_at=now() WHERE state='已上架' AND course_ids @> $1::jsonb", [json([String(id)])]);
  }
  await audit(request.account.accountId, body.state === '已发布' ? '发布课程' : '下架课程', 'course', id);
  return coursePayload(result);
}));

app.get('/api/products', { preHandler: app.auth }, async (request, reply) => {
  // 商品与课程同属学生商城实时内容，禁止缓存返回过期上架状态。
  reply.header('Cache-Control', 'private, no-store, max-age=0');
  reply.header('Pragma', 'no-cache');
  const staff = ['admin','teacher','assistant','operator'].includes(request.account.role);
  const visibleStates = staff ? [] : ['已上架'];
  const result = await pool.query(
    `SELECT ${productFields} FROM products ${visibleStates.length ? 'WHERE state=$1' : ''} ORDER BY created_at DESC`,
    visibleStates
  );
  if (staff) return result.rows.map(productPayload);
  const { student, subjects } = await getStudentContext(pool, request.account.studentId);
  return result.rows.filter(product => courseScopeMatches(student, subjects, product.scope)).map(productPayload);
});
app.post('/api/admin/products', { preHandler: requireRoles(['admin','teacher']) }, withIdempotency(async (request, reply) => {
  const body = productSchema.parse(request.body);
  if (body.state !== '草稿') throw Object.assign(new Error('商品必须先创建为草稿，再通过状态接口上架'), { statusCode:422 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (body.courseIds.length) {
      const count = await client.query("SELECT count(*)::int AS count FROM courses WHERE id=ANY($1::uuid[]) AND state='已发布'", [body.courseIds]);
      if (count.rows[0].count !== body.courseIds.length) throw Object.assign(new Error('商品只能绑定已发布的课程'), { statusCode:422 });
    }
    if (body.state === '已上架') await assertProductPublishable(client, { ...body, courseIds: body.courseIds });
    const product = (await client.query(
      'INSERT INTO products(name,category,description,pricing,price,state,course_ids,scope,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ' + productFields,
      [body.name,body.category || null,body.description || null,body.pricing,body.price,body.state,json(body.courseIds),json(body.scope),request.account.accountId]
    )).rows[0];
    await client.query('INSERT INTO audit_logs(actor_account_id,action,entity_type,entity_id,metadata) VALUES($1,$2,$3,$4,$5)', [request.account.accountId,'创建商品','product',product.id,json({ state:body.state, courseCount:body.courseIds.length })]);
    await client.query('COMMIT');
    return productPayload(product);
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));
app.patch('/api/admin/products/:id', { preHandler: requireRoles(['admin','teacher']) }, withIdempotency(async request => {
  const id = uuidSchema.parse(request.params.id);
  const patch = productSchema.innerType().partial().parse(request.body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = (await client.query(`SELECT ${productFields} FROM products WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!current) throw Object.assign(new Error('商品不存在'), { statusCode:404 });
    const merged = productSchema.parse({ ...productPayload(current), ...patch });
    if (!isAllowedStateTransition('product', current.state, merged.state)) throw Object.assign(new Error('商品状态变更不符合状态机规则'), { statusCode:409 });
    if (merged.courseIds.length) {
      const count = await client.query("SELECT count(*)::int AS count FROM courses WHERE id=ANY($1::uuid[]) AND state='已发布'", [merged.courseIds]);
      if (count.rows[0].count !== merged.courseIds.length) throw Object.assign(new Error('商品只能绑定已发布的课程'), { statusCode:422 });
    }
    if (merged.state === '已上架') await assertProductPublishable(client, merged);
    const product = (await client.query(
      'UPDATE products SET name=$1,category=$2,description=$3,pricing=$4,price=$5,state=$6,course_ids=$7,scope=$8,updated_at=now() WHERE id=$9 RETURNING ' + productFields,
      [merged.name,merged.category || null,merged.description || null,merged.pricing,merged.price,merged.state,json(merged.courseIds),json(merged.scope),id]
    )).rows[0];
    await client.query('INSERT INTO audit_logs(actor_account_id,action,entity_type,entity_id,metadata) VALUES($1,$2,$3,$4,$5)', [request.account.accountId,'修改商品','product',id,json({ state:merged.state, courseCount:merged.courseIds.length })]);
    await client.query('COMMIT');
    return productPayload(product);
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));
app.post('/api/admin/products/:id/state', { preHandler: requireRoles(['admin','teacher']) }, withIdempotency(async request => {
  const id = uuidSchema.parse(request.params.id);
  const body = z.object({ state:z.enum(['已上架','已下架']) }).parse(request.body);
  const current = (await pool.query(`SELECT ${productFields} FROM products WHERE id=$1`, [id])).rows[0];
  if (!current) throw Object.assign(new Error('商品不存在'), { statusCode:404 });
  if (!isAllowedStateTransition('product', current.state, body.state)) throw Object.assign(new Error('商品状态变更不符合状态机规则'), { statusCode:409 });
  if (body.state === '已上架') await assertProductPublishable(pool, productPayload(current));
  const product = (await pool.query('UPDATE products SET state=$1,updated_at=now() WHERE id=$2 RETURNING ' + productFields, [body.state,id])).rows[0];
  await audit(request.account.accountId, body.state === '已上架' ? '上架商品' : '下架商品', 'product', id);
  return productPayload(product);
}));

app.get('/api/students/:id/entitlements', { preHandler: app.auth }, async request => {
  const studentId = uuidSchema.parse(request.params.id);
  if (!canAccessStudent(request, studentId)) throw Object.assign(new Error('无权读取该学员权益'), { statusCode:403 });
  return (await pool.query('SELECT id,student_id,product_id,course_ids,scope,kind,starts_at,ends_at,status,source,created_at FROM entitlements WHERE student_id=$1 ORDER BY created_at DESC', [studentId])).rows.map(item => ({
    id:item.id, studentId:item.student_id, productId:item.product_id,
    courseIds:Array.isArray(item.course_ids) ? item.course_ids : [], scope:normalizeCourseScope(item.scope), kind:item.kind,
    startsAt:item.starts_at, endsAt:item.ends_at, status:item.status,
    source:item.source, createdAt:item.created_at
  }));
});
app.post('/api/orders', { preHandler: requireStudent }, withIdempotency(async (request, reply) => {
  const body = orderCreateSchema.parse(request.body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let product = (await client.query(`SELECT ${productFields} FROM products WHERE id=$1 FOR UPDATE`, [body.productId])).rows[0];
    let sourcedFromCourse = false;
    // 课程可直接在商城领取或购买；统一转换为订单商品，权益写入对应课程 ID。
    if (!product) {
      const course = (await client.query(`SELECT ${courseFields} FROM courses WHERE id=$1 FOR UPDATE`, [body.productId])).rows[0];
      if (course) product = {
        id:course.id, name:course.name, pricing:course.pricing, price:course.price, scope:course.scope,
        state:course.state === '已发布' ? '已上架' : '已下架', course_ids:[String(course.id)]
      };
      sourcedFromCourse = Boolean(course);
    }
    if (!product || product.state !== '已上架') throw Object.assign(new Error('课程或商品不存在、未上架'), { statusCode:422 });
    // 商城课程对所有学生可见，报名状态不影响领取/购买；商品仍按 scope 限定适用范围。
    if (!sourcedFromCourse) {
      const context = await getStudentContext(client, request.account.studentId);
      if (!courseScopeMatches(context.student, context.subjects, product.scope)) {
        throw Object.assign(new Error('该商品暂未对当前学员开放，如有疑问请联系老师'), { statusCode:403 });
      }
    }
    await assertPublishedCourseBindings(client, product);
    const courseIds = Array.isArray(product.course_ids) ? product.course_ids : [];
    const completed = (await client.query(`SELECT ${orderFields} FROM orders WHERE student_id=$1 AND product_id=$2 AND status='已支付' ORDER BY paid_at DESC NULLS LAST,created_at DESC LIMIT 1 FOR UPDATE`, [request.account.studentId,String(product.id)])).rows[0];
    const pending = completed ? null : (await client.query("SELECT id FROM orders WHERE student_id=$1 AND product_id=$2 AND status='待支付' FOR UPDATE", [request.account.studentId,String(product.id)])).rows[0];
    const decision = decisionForOrderClaim({ product, alreadyPaidOrder: completed || null, pendingOrder: pending });
    if (decision.status) throw Object.assign(new Error(decision.message), { statusCode: decision.status });
    if (decision.kind === 'already_paid') {
      const entitlement = (await client.query(`SELECT ${entitlementFields} FROM entitlements WHERE student_id=$1 AND product_id=$2 AND status='有效' AND (ends_at IS NULL OR ends_at > now()) ORDER BY created_at DESC LIMIT 1`, [request.account.studentId,String(product.id)])).rows[0] || null;
      await client.query('COMMIT');
      return { order:orderPayload(decision.order), entitlement, reused:true, requiresManualReview:false };
    }
    if (decision.kind === 'reuse_pending') {
      await client.query('COMMIT');
      return { orderId:decision.orderId, status:decision.orderStatus, reused:true };
    }
    const order = (await client.query(
      `INSERT INTO orders(student_id,product_id,amount,provider,status,paid_at) VALUES($1,$2,$3,$4,$5,CASE WHEN $6 THEN now() ELSE NULL END) RETURNING ${orderFields}`,
      [request.account.studentId,String(product.id),product.price,body.provider || (decision.isFree ? 'free' : 'manual'),decision.orderStatus,decision.isFree]
    )).rows[0];
    let entitlement = null;
    if (decision.isFree) entitlement = await grantEntitlement(client, { studentId:request.account.studentId, productId:product.id, courseIds, scope:product.scope, source:'免费领取订单' });
    await client.query('INSERT INTO audit_logs(actor_account_id,action,entity_type,entity_id,metadata) VALUES($1,$2,$3,$4,$5)', [request.account.accountId,decision.isFree ? '领取免费商品' : '创建购买订单','order',order.id,json({ productId:product.id, amount:Number(product.price) })]);
    await client.query('COMMIT');
    return { order:orderPayload(order), entitlement, requiresManualReview:decision.requiresManualReview };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));
app.get('/api/orders', { preHandler: app.auth }, async request => {
  const staff = ['admin','teacher','assistant','operator'].includes(request.account.role);
  const result = await pool.query(
    `SELECT ${orderFields.split(',').map(field => `o.${field.trim()}`).join(',')},COALESCE(p.name,c.name) AS product_name,s.name AS student_name
     FROM orders o LEFT JOIN products p ON p.id::text=o.product_id
     LEFT JOIN courses c ON c.id::text=o.product_id
     LEFT JOIN students s ON s.id=o.student_id
     ${staff ? '' : 'WHERE o.student_id=$1'} ORDER BY o.created_at DESC`,
    staff ? [] : [request.account.studentId]
  );
  return result.rows.map(orderPayload);
});
app.post('/api/admin/orders/:id/review', { preHandler: requireRoles(['admin','teacher']) }, withIdempotency(async (request, reply) => {
  const orderId = uuidSchema.parse(request.params.id);
  const body = orderReviewSchema.parse(request.body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const order = (await client.query(`SELECT ${orderFields} FROM orders WHERE id=$1 FOR UPDATE`, [orderId])).rows[0];
    const product = order ? (await client.query(`SELECT ${productFields} FROM products WHERE id=$1`, [order.product_id])).rows[0] : null;
    let effectiveProduct = product;
    if (!effectiveProduct && order) {
      const course = (await client.query(`SELECT ${courseFields} FROM courses WHERE id=$1`, [order.product_id])).rows[0];
      if (course) effectiveProduct = { id:course.id, name:course.name, pricing:course.pricing, price:course.price, scope:course.scope, state:course.state === '已发布' ? '已上架' : '已下架', course_ids:[String(course.id)] };
    }
    if (body.status === '已支付') {
      if (effectiveProduct && (effectiveProduct.pricing === '付费' && Number(effectiveProduct.price) <= 0 || effectiveProduct.pricing === '免费' && Number(effectiveProduct.price) !== 0)) {
        throw Object.assign(new Error('订单商品价格配置已失效，无法审核'), { statusCode:422 });
      }
      if (!effectiveProduct || effectiveProduct.state !== '已上架') throw Object.assign(new Error('商品已下架，不能授予新的课程权益'), { statusCode:422 });
      if (Number(order.amount) !== Number(effectiveProduct.price)) throw Object.assign(new Error('订单金额与当前商品金额不一致，不能审核'), { statusCode:422 });
      await assertPublishedCourseBindings(client, effectiveProduct);
    }
    const decision = decisionForOrderReview({ order, product: effectiveProduct, requestedStatus: body.status });
    if (decision.status) throw Object.assign(new Error(decision.message), { statusCode: decision.status });
    if (decision.kind === 'already_reviewed') {
      await client.query('COMMIT');
      return { order:orderPayload(decision.order), alreadyReviewed:true };
    }
    const updated = (await client.query(
      `UPDATE orders SET status=$1,paid_at=CASE WHEN $1='已支付' THEN now() ELSE paid_at END,reviewed_by=$2,reviewed_at=now(),review_note=$3,updated_at=now() WHERE id=$4 RETURNING ${orderFields}`,
      [body.status,request.account.accountId,body.reviewNote || null,decision.order.id]
    )).rows[0];
    let entitlement = null;
    if (decision.approved) entitlement = await grantEntitlement(client, { studentId:order.student_id, productId:effectiveProduct.id, courseIds:Array.isArray(effectiveProduct.course_ids) ? effectiveProduct.course_ids : [], scope:effectiveProduct.scope, source:'人工审核订单' });
    if (order.student_id) await client.query(
      `INSERT INTO student_notifications(student_id,type,title,body,entity_type,entity_id) VALUES($1,'系统通知',$2,$3,'order',$4)`,
      [order.student_id, decision.approved ? '购买申请已通过' : '购买申请被驳回', `「${effectiveProduct.name}」${decision.approved ? '已开通，可在“我的课程”中学习。' : `未通过审核${body.reviewNote ? `：${body.reviewNote}` : '，如有疑问请联系老师。'}`}`, String(order.id)]
    );
    await client.query('INSERT INTO audit_logs(actor_account_id,action,entity_type,entity_id,metadata) VALUES($1,$2,$3,$4,$5)', [request.account.accountId,decision.approved ? '审核订单通过' : '审核订单驳回','order',order.id,json({ productId:effectiveProduct.id, reviewNote:body.reviewNote || null })]);
    await client.query('COMMIT');
    return { order:orderPayload(updated), entitlement, alreadyReviewed:false };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));

app.get('/api/student-notifications', { preHandler: requireStudent }, async request => {
  const limit = z.coerce.number().int().min(1).max(100).optional().parse(request.query?.limit) || 30;
  const rows = (await pool.query('SELECT id,type,title,body,entity_type,entity_id,read_at,created_at FROM student_notifications WHERE student_id=$1 ORDER BY created_at DESC LIMIT $2', [request.account.studentId, limit])).rows;
  return rows.map(row => ({ id:row.id, type:row.type, title:row.title, body:row.body, entityType:row.entity_type, entityId:row.entity_id, readAt:row.read_at, createdAt:row.created_at }));
});
app.post('/api/student-notifications/:id/read', { preHandler: requireStudent }, withIdempotency(async request => {
  const id = uuidSchema.parse(request.params.id);
  const result = (await pool.query('UPDATE student_notifications SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND student_id=$2 RETURNING id,read_at', [id, request.account.studentId])).rows[0];
  if (!result) throw Object.assign(new Error('通知不存在'), { statusCode:404 });
  return { id:result.id, readAt:result.read_at };
}));

// 教师/管理员给学员发私信：与试卷分发、资料更新共用学生通知渠道。
const staffMessageSchema = z.object({
  studentId: uuidSchema,
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(2000)
}).strict();
app.post('/api/admin/messages', { preHandler: requireRoles(['admin','teacher']) }, withIdempotency(async request => {
  const body = staffMessageSchema.parse(request.body);
  const student = (await pool.query('SELECT id,name FROM students WHERE id=$1', [body.studentId])).rows[0];
  if (!student) throw Object.assign(new Error('学员不存在'), { statusCode:404 });
  const row = (await pool.query(
    `INSERT INTO student_notifications(student_id,type,title,body,entity_type,entity_id) VALUES($1,'私信',$2,$3,'account',$4) RETURNING id,created_at`,
    [student.id, body.title, body.body, String(request.account.accountId)]
  )).rows[0];
  await audit(request.account.accountId, '发送私信', 'student_notification', row.id, { studentId: student.id });
  return { id: row.id, studentId: student.id, createdAt: row.created_at, message: `已发送给 ${student.name}` };
}));

const notifyStudentsAboutResource = async (client, { courseId, courseName, fileName, subject, scope = {} }) => {
  const students = (await client.query(
    `SELECT DISTINCT s.id,s.school,s.major,s.year,ss.subject
     FROM students s JOIN student_subjects ss ON ss.student_id=s.id AND ss.enrolled=true
     JOIN entitlements e ON e.student_id=s.id AND e.status='有效' AND (e.ends_at IS NULL OR e.ends_at > now())
       AND e.course_ids @> $1::jsonb
     WHERE $2='' OR ss.subject=$2 OR ss.subject LIKE $2 || '一' OR ss.subject LIKE $2 || '二' OR ss.subject LIKE $2 || '三'`,
    [json([String(courseId)]), String(subject || '').replace(/[一二三]$/, '')]
  )).rows.filter(student => courseScopeMatches(student, [student.subject], scope));
  for (const student of students) {
    await client.query(
      `INSERT INTO student_notifications(student_id,type,title,body,entity_type,entity_id) VALUES($1,'资料更新',$2,$3,'course',$4)`,
      [student.id, '老师上传了新的资料', `${courseName || '你的课程'}${fileName ? `：${fileName}` : ''}`, String(courseId)]
    );
  }
};

const companionBookDto = row => ({
  id:row.id, subject:row.subject, name:row.name, description:row.description || '',
  courseId:row.course_id || null, state:row.state, companionEnabled:Boolean(row.companion_enabled),
  questionCount:Number(row.question_count ?? 0), createdAt:row.created_at, updatedAt:row.updated_at
});
const companionQuestionDto = row => ({ id:row.id, bookId:row.book_id || null, questionNumber:row.question_number, stem:row.stem, durationSeconds:row.duration_seconds, knowledgePoint:row.knowledge_point, halfHint:row.half_hint, answer:row.answer, analysis:row.analysis, state:row.state, createdAt:row.created_at, updatedAt:row.updated_at });
const companionStudentQuestionDto = row => ({ id:row.id, bookId:row.book_id || null, questionNumber:row.question_number, stem:row.stem, durationSeconds:row.duration_seconds });
const getCompanionStudentQuestion = async (studentId, questionId) => {
  const row = (await pool.query(`SELECT q.*,b.subject,b.name book_name,b.course_id FROM companion_study_questions q JOIN companion_study_books b ON b.id=q.book_id WHERE q.id=$2 AND q.state='已发布' AND b.state='已发布' AND b.companion_enabled=true AND EXISTS (SELECT 1 FROM student_subjects ss WHERE ss.student_id=$1 AND ss.enrolled=true AND ${subjectMatchSql('ss.subject', 'b.subject')})`, [studentId, questionId])).rows[0];
  if (!row) throw Object.assign(new Error('题目不存在、未启用代学、尚未发布或不属于你的报考科目'), { statusCode:404 });
  if (row.course_id) await assertStudentCourseAccess(pool, studentId, row.course_id);
  if (!Number.isInteger(Number(row.duration_seconds)) || Number(row.duration_seconds) < 60) {
    throw Object.assign(new Error('该题尚未配置有效的代学计时，暂不能开始计时学习'), { statusCode:422 });
  }
  return row;
};
const companionSessionDto = (session, question, now = Date.now()) => {
  const visibility = companionStudyVisibility({ startedAt:session.started_at, effectiveDurationSeconds:session.effective_duration_seconds, finishedAt:session.finished_at, now });
  return { id:session.id, questionId:session.question_id, courseId:question.course_id || null, startedAt:session.started_at, speedMode:session.speed_mode, effectiveDurationSeconds:session.effective_duration_seconds, finishedAt:session.finished_at, finishReason:session.finish_reason, ...visibility, question:{ id:question.question_id || question.id, questionNumber:question.question_number, stem:question.stem, durationSeconds:question.duration_seconds, subject:question.subject, bookName:question.book_name, ...(visibility.showKnowledgePoint ? { knowledgePoint:question.knowledge_point } : {}), ...(visibility.showHalfHint ? { halfHint:question.half_hint } : {}), ...(visibility.showAnswer ? { answer:question.answer, analysis:question.analysis } : {}) } };
};
const finalizeCompanionSession = async (sessionId, studentId, requestedReason = null) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query(
      `SELECT s.*,q.question_number,q.stem,q.duration_seconds,q.knowledge_point,q.half_hint,q.answer,q.analysis,
              b.subject,b.name book_name,b.id book_id,b.course_id
       FROM companion_study_sessions s
       JOIN companion_study_questions q ON q.id=s.question_id
       JOIN companion_study_books b ON b.id=q.book_id
       WHERE s.id=$1 AND s.student_id=$2 FOR UPDATE`, [sessionId, studentId]
    )).rows[0];
    if (!row) throw Object.assign(new Error('学习会话不存在'), { statusCode:404 });
    if (row.course_id) await assertStudentCourseAccess(client, studentId, row.course_id);
    const finish = companionFinishReason({ startedAt:row.started_at, effectiveDurationSeconds:row.effective_duration_seconds });
    const reason = row.finished_at ? (row.finish_reason || (requestedReason || finish.reason)) : (finish.reason === '到时结束' ? '到时结束' : (requestedReason || '提前结束'));
    if (!row.finished_at) {
      const updated = (await client.query(
        `UPDATE companion_study_sessions SET finished_at=now(),finish_reason=$1 WHERE id=$2 RETURNING *`, [reason, row.id]
      )).rows[0];
      row.finished_at = updated.finished_at;
      row.finish_reason = updated.finish_reason;
    }
    // 既支持首次结束，也能为历史已结束但未落进度的会话补齐幂等记录。
    await client.query(
      `INSERT INTO student_learning_progress(student_id,course_id,resource_type,resource_id,item_id,total_count)
       VALUES($1,$2,'companion_study',$3,$4,1)
       ON CONFLICT(student_id,resource_type,resource_id,item_id) DO UPDATE SET course_id=EXCLUDED.course_id,total_count=GREATEST(student_learning_progress.total_count,EXCLUDED.total_count)`,
      [studentId,row.course_id || null,String(row.book_id),String(row.question_id)]
    );
    await client.query(
      `INSERT INTO learning_events(student_id,event_type,subject,tool_id,event_key,knowledge_tags,payload)
       VALUES($1,'companion_session_finished',$2,'companion_study',$3,$4,$5)
       ON CONFLICT(student_id,event_key) DO NOTHING`,
      [studentId,row.subject,`companion_session:${row.id}`,json([row.knowledge_point].filter(Boolean)),json({ sessionId:row.id, courseId:row.course_id || null, bookId:row.book_id, questionId:row.question_id, finishReason:reason, elapsedSeconds:finish.elapsedSeconds })]
    );
    await client.query('COMMIT');
    return { session:row, question:row };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
};

app.get('/api/admin/question-books', { preHandler: requireRoles(['admin','teacher']) }, async () => (await pool.query(`SELECT b.*,count(q.id)::int question_count FROM companion_study_books b LEFT JOIN companion_study_questions q ON q.book_id=b.id GROUP BY b.id ORDER BY b.subject,b.created_at DESC`)).rows.map(companionBookDto));
app.get('/api/admin/question-books/:id/questions', { preHandler: requireRoles(['admin','teacher']) }, async request => (await pool.query('SELECT * FROM companion_study_questions WHERE book_id=$1 ORDER BY question_number', [uuidSchema.parse(request.params.id)])).rows.map(companionQuestionDto));
app.get('/api/admin/companion-study/books', { preHandler: requireRoles(['admin','teacher']) }, async () => (await pool.query(`SELECT b.*,count(q.id)::int question_count FROM companion_study_books b LEFT JOIN companion_study_questions q ON q.book_id=b.id GROUP BY b.id ORDER BY b.subject,b.created_at DESC`)).rows.map(companionBookDto));
app.get('/api/admin/companion-study/books/:id/questions', { preHandler: requireRoles(['admin','teacher']) }, async request => (await pool.query('SELECT * FROM companion_study_questions WHERE book_id=$1 ORDER BY question_number', [uuidSchema.parse(request.params.id)])).rows.map(companionQuestionDto));
app.post('/api/admin/companion-study/books/import', { preHandler: requireRoles(['admin','teacher']) }, withIdempotency(async request => {
  const body = companionImportSchema.parse(request.body); const client = await pool.connect();
  try { await client.query('BEGIN');
    if (body.book.courseId) {
      // 教师发布内容只绑定已发布课程；学生使用时再校验自己的课程权益。
      const course = (await client.query("SELECT id,state FROM courses WHERE id=$1", [body.book.courseId])).rows[0];
      if (!course || course.state !== '已发布') throw Object.assign(new Error('代学绑定课程不存在或未发布'), { statusCode:422 });
    }
    const book = (await client.query(`INSERT INTO companion_study_books(subject,name,description,course_id,state,companion_enabled,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(subject,name) DO UPDATE SET description=excluded.description,course_id=excluded.course_id,state=excluded.state,companion_enabled=excluded.companion_enabled,updated_at=now() RETURNING *`, [body.book.subject,body.book.name,body.book.description,body.book.courseId || null,body.book.state,body.book.companionEnabled,request.account.accountId])).rows[0];
    for (const item of body.questions) await client.query(`INSERT INTO companion_study_questions(book_id,question_number,stem,duration_seconds,knowledge_point,half_hint,answer,analysis,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(book_id,question_number) DO UPDATE SET stem=excluded.stem,duration_seconds=excluded.duration_seconds,knowledge_point=excluded.knowledge_point,half_hint=excluded.half_hint,answer=excluded.answer,analysis=excluded.analysis,state=excluded.state,updated_at=now()`, [book.id,item.questionNumber,item.stem,item.durationSeconds,item.knowledgePoint,item.halfHint,item.answer,item.analysis,item.state]);
    await client.query('COMMIT'); await audit(request.account.accountId, '批量导入刷题书库', 'question_book', book.id, { subject:book.subject, questionCount:body.questions.length, state:book.state, companionEnabled:body.book.companionEnabled });
    return { book:companionBookDto({...book,question_count:body.questions.length}), importedQuestionCount:body.questions.length };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));
app.patch('/api/admin/companion-study/books/:id', { preHandler: requireRoles(['admin','teacher']) }, withIdempotency(async request => {
  const id=uuidSchema.parse(request.params.id); const patch=companionBookSchema.partial().strict().parse(request.body); if (!Object.keys(patch).length) throw Object.assign(new Error('至少提供一个可更新字段'),{statusCode:422});
  if (patch.courseId) {
    const course = (await pool.query("SELECT id,state FROM courses WHERE id=$1", [patch.courseId])).rows[0];
    if (!course || course.state !== '已发布') throw Object.assign(new Error('代学绑定课程不存在或未发布'), { statusCode:422 });
  }
  const columns={subject:'subject',name:'name',description:'description',courseId:'course_id',state:'state',companionEnabled:'companion_enabled'}; const entries=Object.entries(patch); const values=entries.map(([,value])=>value); const result=await pool.query(`UPDATE companion_study_books SET ${entries.map(([key],i)=>`${columns[key]}=$${i+1}`).join(',')},updated_at=now() WHERE id=$${values.length+1} RETURNING *`,[...values,id]); if (!result.rowCount) throw Object.assign(new Error('书籍不存在'),{statusCode:404}); await audit(request.account.accountId,'修改带背书籍','companion_study_book',id,{fields:entries.map(([key])=>key)}); return companionBookDto(result.rows[0]);
}));
app.patch('/api/admin/companion-study/questions/:id', { preHandler: requireRoles(['admin','teacher']) }, withIdempotency(async request => {
  const id=uuidSchema.parse(request.params.id); const patch=companionQuestionSchema.partial().strict().parse(request.body); if (!Object.keys(patch).length) throw Object.assign(new Error('至少提供一个可更新字段'),{statusCode:422});
  const columns={questionNumber:'question_number',stem:'stem',durationSeconds:'duration_seconds',knowledgePoint:'knowledge_point',halfHint:'half_hint',answer:'answer',analysis:'analysis',state:'state'}; const entries=Object.entries(patch); const values=entries.map(([,value])=>value); const result=await pool.query(`UPDATE companion_study_questions SET ${entries.map(([key],i)=>`${columns[key]}=$${i+1}`).join(',')},updated_at=now() WHERE id=$${values.length+1} RETURNING *`,[...values,id]); if (!result.rowCount) throw Object.assign(new Error('题目不存在'),{statusCode:404}); await audit(request.account.accountId,'修改带背题目','companion_study_question',id,{fields:entries.map(([key])=>key)}); return companionQuestionDto(result.rows[0]);
}));
app.get('/api/companion-study/books', { preHandler: requireStudent }, async request => {
  const rows = (await pool.query(`SELECT b.*,count(q.id)::int question_count FROM companion_study_books b LEFT JOIN companion_study_questions q ON q.book_id=b.id AND q.state='已发布' WHERE b.state='已发布' AND b.companion_enabled=true AND EXISTS (SELECT 1 FROM student_subjects ss WHERE ss.student_id=$1 AND ss.enrolled=true AND ${subjectMatchSql('ss.subject', 'b.subject')}) GROUP BY b.id ORDER BY b.subject,b.name`, [request.account.studentId])).rows;
  const visible = [];
  for (const row of rows) {
    if (row.course_id) {
      try { await assertStudentCourseAccess(pool, request.account.studentId, row.course_id); } catch { continue; }
    }
    visible.push(row);
  }
  return visible.map(companionBookDto);
});
app.get('/api/companion-study/books/:id/questions', { preHandler: requireStudent }, async request => {
  const bookId = uuidSchema.parse(request.params.id);
  const book = (await pool.query(`SELECT b.id,b.course_id FROM companion_study_books b WHERE b.id=$2 AND b.state='已发布' AND b.companion_enabled=true AND EXISTS (SELECT 1 FROM student_subjects ss WHERE ss.student_id=$1 AND ss.enrolled=true AND ${subjectMatchSql('ss.subject', 'b.subject')})`, [request.account.studentId,bookId])).rows[0];
  if (!book) throw Object.assign(new Error('书籍不存在、未启用或不属于你的报考科目'), { statusCode:404 });
  if (book.course_id) await assertStudentCourseAccess(pool, request.account.studentId, book.course_id);
  return (await pool.query(`SELECT q.id,q.book_id,q.question_number,q.stem,q.duration_seconds FROM companion_study_questions q WHERE q.book_id=$1 AND q.state='已发布' ORDER BY q.question_number`, [bookId])).rows.map(companionStudentQuestionDto);
});
app.post('/api/companion-study/questions/:id/sessions', { preHandler: requireStudent }, withIdempotency(async request => {
  const question=await getCompanionStudentQuestion(request.account.studentId,uuidSchema.parse(request.params.id));
  const body=companionSessionSchema.parse(request.body||{});
  const duration=companionStudyDuration(question.duration_seconds,body.speedMode);
  const session=(await pool.query('INSERT INTO companion_study_sessions(student_id,question_id,speed_mode,effective_duration_seconds) VALUES($1,$2,$3,$4) RETURNING *',[request.account.studentId,question.id,body.speedMode,duration])).rows[0];
  await pool.query('INSERT INTO learning_events(student_id,event_type,subject,tool_id,event_key,knowledge_tags,payload) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(student_id,event_key) DO NOTHING', [request.account.studentId,'companion_session_started',question.subject,'companion_study',`companion_session_started:${session.id}`,json([question.knowledge_point].filter(Boolean)),json({ sessionId:session.id, courseId:question.course_id || null, bookId:question.book_id, questionId:question.id })]);
  await audit(request.account.accountId,'开始带背学习','companion_study_session',session.id,{questionId:question.id,speedMode:body.speedMode});
  return companionSessionDto(session,question);
}));
app.get('/api/companion-study/sessions/:id', { preHandler: requireStudent }, async request => {
  const sessionId = uuidSchema.parse(request.params.id);
  const current = (await pool.query('SELECT * FROM companion_study_sessions WHERE id=$1 AND student_id=$2',[sessionId,request.account.studentId])).rows[0];
  if(!current) throw Object.assign(new Error('学习会话不存在'),{statusCode:404});
  const finalized = !current.finished_at && (Date.now() - new Date(current.started_at).getTime()) / 1000 >= Number(current.effective_duration_seconds)
    ? await finalizeCompanionSession(sessionId, request.account.studentId, '到时结束')
    : { session:current };
  const question=finalized.question || await getCompanionStudentQuestion(request.account.studentId,finalized.session.question_id);
  return companionSessionDto(finalized.session,question);
});
app.patch('/api/companion-study/sessions/:id', { preHandler: requireStudent }, withIdempotency(async request => {
  companionSessionFinishSchema.parse(request.body);
  const sessionId = uuidSchema.parse(request.params.id);
  const finalized = await finalizeCompanionSession(sessionId, request.account.studentId, '提前结束');
  const question=finalized.question || await getCompanionStudentQuestion(request.account.studentId,finalized.session.question_id);
  await audit(request.account.accountId,'结束带背学习','companion_study_session',sessionId,{questionId:finalized.session.question_id,finishReason:finalized.session.finish_reason});
  return companionSessionDto(finalized.session,question);
}));

const assessmentQuestionSetDto = (row, { includeAnswers = true } = {}) => ({
  id:row.id, studentId:row.student_id || null, subject:row.subject, title:row.title,
  assessmentType:row.assessment_type, state:row.state,
  questions:includeAnswers ? (row.questions || []) : (row.questions || []).map(question => ({
    itemIndex:question.itemIndex, subject:question.subject, questionType:question.questionType,
    stem:question.stem, options:question.options, score:question.score, knowledgePoint:question.knowledgePoint
  })),
  createdBy:row.created_by || null, createdAt:row.created_at, updatedAt:row.updated_at
});
app.get('/api/admin/assessment-question-sets', { preHandler: requireRoles(['admin','teacher']) }, async request => {
  const query = z.object({ subject:z.string().trim().max(60).optional(), assessmentType:z.enum(['daily','weekly','monthly']).optional(), state:z.enum(['草稿','已发布','已归档']).optional() }).parse(request.query ?? {});
  const params = []; const filters = [];
  for (const [key, column] of [['subject','subject'],['assessmentType','assessment_type'],['state','state']]) {
    if (query[key]) { params.push(query[key]); filters.push(`${column}=$${params.length}`); }
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  return (await pool.query(`SELECT id,student_id,subject,title,assessment_type,state,questions,created_by,created_at,updated_at FROM assessment_question_sets ${where} ORDER BY updated_at DESC`, params)).rows.map(assessmentQuestionSetDto);
});
app.post('/api/admin/assessment-question-sets', { preHandler: requireRoles(['admin','teacher']) }, withIdempotency(async request => {
  const body = assessmentQuestionSetSchema.parse(request.body);
  if (body.studentId) {
    const student = (await pool.query('SELECT id FROM students WHERE id=$1', [body.studentId])).rows[0];
    if (!student) throw Object.assign(new Error('题目集绑定的学员不存在'), { statusCode:404 });
  }
  const snapshots = body.questions.map((question, index) => ({
    itemIndex:index, subject:question.subject, questionType:question.questionType, stem:question.stem,
    options:question.options, correctAnswer:question.correctAnswer, score:question.score,
    analysis:question.analysis || '', knowledgePoint:question.knowledgePoint || '', state:question.state
  }));
  const result = (await pool.query(
    `INSERT INTO assessment_question_sets(student_id,subject,title,assessment_type,state,questions,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [body.studentId || null,body.subject,body.title,body.assessmentType,body.state,json(snapshots),request.account.accountId]
  )).rows[0];
  await audit(request.account.accountId, '创建周期自测题目集', 'assessment_question_set', result.id, { subject:body.subject, assessmentType:body.assessmentType, questionCount:snapshots.length });
  return assessmentQuestionSetDto(result);
}));
app.get('/api/student/assessment-question-sets', { preHandler: requireStudent }, async request => {
  const query = z.object({ subject:z.string().trim().max(60).optional(), assessmentType:z.enum(['daily','weekly','monthly']).optional() }).parse(request.query ?? {});
  const params = [request.account.studentId]; const filters = ["state='已发布'", '(student_id=$1 OR student_id IS NULL)'];
  if (query.assessmentType) { params.push(query.assessmentType); filters.push(`assessment_type=$${params.length}`); }
  const rows = (await pool.query(`SELECT id,student_id,subject,title,assessment_type,state,questions,created_by,created_at,updated_at FROM assessment_question_sets WHERE ${filters.join(' AND ')} ORDER BY updated_at DESC`, params)).rows;
  const subjects = (await pool.query('SELECT subject FROM student_subjects WHERE student_id=$1 AND enrolled=true', [request.account.studentId])).rows.map(row => row.subject);
  return rows
    .filter(row => subjects.some(subject => subjectsMatch(subject, row.subject)))
    .filter(row => !query.subject || subjectsMatch(query.subject, row.subject))
    .map(row => assessmentQuestionSetDto(row, { includeAnswers:false }));
});
app.get('/api/admin/assessment-question-sets/:id', { preHandler: requireRoles(['admin','teacher']) }, async request => {
  const id = uuidSchema.parse(request.params.id);
  const row = (await pool.query('SELECT * FROM assessment_question_sets WHERE id=$1', [id])).rows[0];
  if (!row) throw Object.assign(new Error('题目集不存在'), { statusCode:404 });
  return assessmentQuestionSetDto(row);
});
app.patch('/api/admin/assessment-question-sets/:id', { preHandler: requireRoles(['admin','teacher']) }, withIdempotency(async request => {
  const id = uuidSchema.parse(request.params.id);
  const body = assessmentQuestionSetSchema.innerType().partial().strict().parse(request.body);
  if (!Object.keys(body).length) throw Object.assign(new Error('至少提供一个可更新字段'), { statusCode:422 });
  const current = (await pool.query('SELECT * FROM assessment_question_sets WHERE id=$1', [id])).rows[0];
  if (!current) throw Object.assign(new Error('题目集不存在'), { statusCode:404 });
  const merged = assessmentQuestionSetSchema.parse({
    studentId:current.student_id || null, subject:current.subject, title:current.title, assessmentType:current.assessment_type, state:current.state,
    questions:(Array.isArray(current.questions) ? current.questions : []).map(({ itemIndex: _itemIndex, ...question }) => question), ...body
  });
  if (merged.studentId) {
    const student = (await pool.query('SELECT id FROM students WHERE id=$1', [merged.studentId])).rows[0];
    if (!student) throw Object.assign(new Error('题目集绑定的学员不存在'), { statusCode:404 });
  }
  const snapshots = merged.questions.map((question, index) => ({ itemIndex:index, subject:question.subject, questionType:question.questionType, stem:question.stem, options:question.options, correctAnswer:question.correctAnswer, score:question.score, analysis:question.analysis || '', knowledgePoint:question.knowledgePoint || '', state:question.state }));
  const result = (await pool.query(
    `UPDATE assessment_question_sets SET student_id=$1,subject=$2,title=$3,assessment_type=$4,state=$5,questions=$6,updated_at=now() WHERE id=$7 RETURNING *`,
    [merged.studentId || null,merged.subject,merged.title,merged.assessmentType,merged.state,json(snapshots),id]
  )).rows[0];
  await audit(request.account.accountId, '修改周期自测题目集', 'assessment_question_set', id, { fields:Object.keys(body) });
  return assessmentQuestionSetDto(result);
}));

// 周期自测（日/周/月）主观题教师批改：此前学生提交后主观题永远停留在"待批改"，
// 教师端没有任何入口给主观分。本接口补齐该闭环：写入主观分、合并总分、记录批改人与时间。
app.patch('/api/admin/assessment-records/:id', { preHandler: requireRoles(['admin','teacher']) }, withIdempotency(async request => {
  const id = uuidSchema.parse(request.params.id);
  const body = z.object({
    subjectiveScore: z.number().min(0).max(100000).nullable().optional(),
    gradingNote: z.string().trim().max(4000).optional(),
    gradingStatus: z.enum(['graded','pending_review']).default('graded')
  }).strict().parse(request.body ?? {});
  const record = (await pool.query('SELECT * FROM assessment_records WHERE id=$1', [id])).rows[0];
  if (!record) throw Object.assign(new Error('自测记录不存在'), { statusCode:404 });
  // 主观题满分：有题目集快照按快照中主观题分值合计；无快照按 总分-客观分 兜底。
  let subjectiveTotal = 0;
  if (record.question_set_id) {
    const set = (await pool.query('SELECT questions FROM assessment_question_sets WHERE id=$1', [record.question_set_id])).rows[0];
    if (set) subjectiveTotal = (Array.isArray(set.questions) ? set.questions : [])
      .filter(q => ['short_answer','fill_blank','translation'].includes(q.questionType || q.question_type))
      .reduce((sum, q) => sum + Number(q.score || 0), 0);
  }
  if (!subjectiveTotal && record.total != null) subjectiveTotal = Math.max(0, Number(record.total) - Number(record.objective_score || 0));
  const subjectiveScore = body.subjectiveScore === undefined ? (record.subjective_score === null ? null : Number(record.subjective_score)) : body.subjectiveScore;
  if (subjectiveScore !== null && subjectiveScore > subjectiveTotal) {
    throw Object.assign(new Error(`主观题成绩不能超过主观题满分（${subjectiveTotal} 分）`), { statusCode:422 });
  }
  if (body.gradingStatus === 'graded' && subjectiveScore === null && subjectiveTotal > 0) {
    throw Object.assign(new Error('完成批改前必须填写主观题成绩'), { statusCode:422 });
  }
  const objective = record.objective_score === null ? null : Number(record.objective_score);
  const finalScore = body.gradingStatus === 'graded' ? Number(objective || 0) + Number(subjectiveScore || 0) : objective;
  const gradedAt = body.gradingStatus === 'graded' ? new Date() : null;
  const updated = (await pool.query(
    `UPDATE assessment_records SET score=$1, subjective_score=$2, grading_status=$3, grading_note=$4, graded_by=$5, graded_at=COALESCE($6, graded_at) WHERE id=$7 RETURNING *`,
    [finalScore, subjectiveScore, body.gradingStatus, body.gradingNote ?? record.grading_note, request.account.accountId, gradedAt, id]
  )).rows[0];
  await pool.query('INSERT INTO learning_events(student_id,event_type,subject,payload) VALUES($1,$2,$3,$4)', [record.student_id, 'assessment_graded', record.subject, json({ assessmentRecordId:id, gradingStatus:body.gradingStatus, subjectiveScore })]);
  await audit(request.account.accountId, '批改周期自测主观题', 'assessment_record', id, { gradingStatus:body.gradingStatus, subjectiveScore });
  return { id: updated.id, gradingStatus: updated.grading_status, score: updated.score === null ? null : Number(updated.score), subjectiveScore: updated.subjective_score === null ? null : Number(updated.subjective_score), gradingNote: updated.grading_note || '', gradedAt: updated.graded_at };
}));

app.get('/api/admin/entrance/questions', { preHandler: requireRoles(['admin','teacher']) }, async request => {
  const query = z.object({ subject: z.string().trim().min(1).max(60).optional() }).parse(request.query ?? {});
  const params = query.subject ? [query.subject] : [];
  const result = await pool.query(`SELECT id,subject,question_type,stem,options,score,analysis,knowledge_point,state,created_by,created_at,updated_at FROM entrance_questions ${query.subject ? 'WHERE subject=$1' : ''} ORDER BY created_at DESC`, params);
  return result.rows;
});
app.post('/api/admin/entrance/questions', { preHandler: requireRoles(['admin','teacher']) }, withIdempotency(async (request, reply) => {
  const body = entranceQuestionSchema.parse(request.body);
  if (body.questionType === 'single_choice' && Array.isArray(body.correctAnswer) && body.correctAnswer.length !== 1) throw Object.assign(new Error('单选题必须且只能有一个正确答案'), { statusCode:422 });
  if (body.questionType === 'multiple_choice' && !Array.isArray(body.correctAnswer)) throw Object.assign(new Error('多选题必须使用答案数组'), { statusCode:422 });
  const result = (await pool.query('INSERT INTO entrance_questions(subject,question_type,stem,options,correct_answer,score,analysis,knowledge_point,state,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,subject,question_type,stem,options,score,analysis,knowledge_point,state,created_at', [body.subject,body.questionType,body.stem,json(body.options),json(body.correctAnswer),body.score,body.analysis || null,body.knowledgePoint || null,body.state,request.account.accountId])).rows[0];
  await audit(request.account.accountId, '创建入学测评题目', 'entrance_question', result.id, { subject:body.subject, questionType:body.questionType });
  return result;
}));
app.patch('/api/admin/entrance/questions/:id', { preHandler: requireRoles(['admin','teacher']) }, async request => {
  const id = uuidSchema.parse(request.params.id);
  const body = entranceQuestionPatchSchema.parse(request.body);
  const current = (await pool.query('SELECT * FROM entrance_questions WHERE id=$1', [id])).rows[0];
  if (!current) throw Object.assign(new Error('题目不存在'), { statusCode:404 });
  const merged = entranceQuestionSchema.parse({ subject:current.subject, questionType:current.question_type, stem:current.stem, options:current.options, correctAnswer:current.correct_answer, score:Number(current.score), analysis:current.analysis || undefined, knowledgePoint:current.knowledge_point || undefined, state:current.state, ...body });
  const result = (await pool.query('UPDATE entrance_questions SET subject=$1,question_type=$2,stem=$3,options=$4,correct_answer=$5,score=$6,analysis=$7,knowledge_point=$8,state=$9,updated_at=now() WHERE id=$10 RETURNING id,subject,question_type,stem,options,score,analysis,knowledge_point,state,updated_at', [merged.subject,merged.questionType,merged.stem,json(merged.options),json(merged.correctAnswer),merged.score,merged.analysis || null,merged.knowledgePoint || null,merged.state,id])).rows[0];
  await audit(request.account.accountId, '修改入学测评题目', 'entrance_question', id);
  return result;
});
app.get('/api/admin/entrance/papers', { preHandler: requireRoles(['admin','teacher']) }, async () => (await pool.query('SELECT id,title,state,duration_minutes,created_by,created_at,updated_at FROM entrance_papers ORDER BY created_at DESC')).rows);
app.post('/api/admin/entrance/papers', { preHandler: requireRoles(['admin','teacher']) }, withIdempotency(async (request, reply) => {
  const body = entrancePaperSchema.parse(request.body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const questions = (await client.query('SELECT id,subject,question_type,stem,options,correct_answer,score,analysis,knowledge_point,state FROM entrance_questions WHERE id=ANY($1::uuid[])', [body.questionIds])).rows;
    const byId = new Map(questions.map(question => [String(question.id), question]));
    if (questions.length !== body.questionIds.length || questions.some(question => question.state !== '已发布')) throw Object.assign(new Error('试卷只能引用已发布且存在的题目'), { statusCode:422 });
    if (questions.some(question => !questionAnswerShapeIsValid({ questionType:question.question_type, correctAnswer:question.correct_answer }))) {
      throw Object.assign(new Error('试卷引用的题目正确答案形状不符合题型要求'), { statusCode:422 });
    }
    const paper = (await client.query('INSERT INTO entrance_papers(id,title,state,duration_minutes,created_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,state=EXCLUDED.state,duration_minutes=EXCLUDED.duration_minutes,updated_at=now() RETURNING *', [body.id,body.title,body.state,body.durationMinutes,request.account.accountId])).rows[0];
    await client.query('DELETE FROM entrance_paper_items WHERE paper_id=$1', [body.id]);
    for (const [itemIndex, questionId] of body.questionIds.entries()) {
      const question = byId.get(String(questionId));
      const snapshot = { subject:question.subject, questionType:question.question_type, stem:question.stem, options:question.options, correctAnswer:question.correct_answer, score:Number(question.score), analysis:question.analysis || '', knowledgePoint:question.knowledge_point || '' };
      await client.query('INSERT INTO entrance_paper_items(paper_id,question_id,item_index,question_snapshot) VALUES($1,$2,$3,$4)', [body.id,question.id,itemIndex,json(snapshot)]);
    }
    await client.query('COMMIT');
    await audit(request.account.accountId, '创建入学测评试卷', 'entrance_paper', body.id, { questionCount:body.questionIds.length });
    return paper;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));
app.get('/api/admin/entrance/papers/:id', { preHandler: requireRoles(['admin','teacher']) }, async request => {
  const paperId = z.string().trim().min(1).max(80).parse(request.params.id);
  const paper = (await pool.query('SELECT id,title,state,duration_minutes,created_at,updated_at FROM entrance_papers WHERE id=$1', [paperId])).rows[0];
  if (!paper) throw Object.assign(new Error('试卷不存在'), { statusCode:404 });
  const items = (await pool.query('SELECT item_index,question_id,question_snapshot FROM entrance_paper_items WHERE paper_id=$1 ORDER BY item_index', [paperId])).rows;
  return { ...paper, items:items.map(item => ({ itemIndex:item.item_index, questionId:item.question_id, ...item.question_snapshot })) };
});

const distributionSchema = z.object({ paperId:z.string().trim().min(1).max(80), paperTitle:z.string().trim().min(1).max(160).optional(), studentId:uuidSchema, startDeadlineAt:z.string().datetime().optional() });
// 教师端查看分发与学生提交（自动评分结果随提交即时写入）
app.get('/api/admin/exams/distributions', { preHandler: requireRoles(['admin','teacher']) }, async () => {
  const rows = (await pool.query(
    `SELECT d.id,d.student_id,d.paper_id,d.paper_title,d.assigned_at,d.start_deadline_at,d.started_at,d.exam_deadline_at,d.submitted_at,d.status,s.name AS student_name
     FROM entrance_distributions d JOIN students s ON s.id=d.student_id ORDER BY d.assigned_at DESC LIMIT 1000`
  )).rows;
  return rows.map(row => ({ id:row.id, studentId:row.student_id, studentName:row.student_name, paperId:row.paper_id, paperTitle:row.paper_title, assignedAt:row.assigned_at, startDeadlineAt:row.start_deadline_at, startedAt:row.started_at, examDeadlineAt:row.exam_deadline_at, submittedAt:row.submitted_at, status:row.status }));
});
app.get('/api/admin/exams/submissions', { preHandler: requireRoles(['admin','teacher']) }, async () => {
  const rows = (await pool.query(
    `SELECT s.id,s.distribution_id,s.assessment_record_id,s.answers,s.score,s.total,s.objective_score,s.subjective_score,s.grading_status,s.graded_by,s.grading_note,s.status,s.submitted_at,s.graded_at,s.wrong_questions,s.subject_scores,s.subject_totals,
            d.paper_id,d.paper_title,d.student_id,st.name AS student_name
     FROM entrance_submissions s JOIN entrance_distributions d ON d.id=s.distribution_id JOIN students st ON st.id=d.student_id
     ORDER BY s.submitted_at DESC LIMIT 1000`
  )).rows;
  return rows.map(row => ({
    id:row.id, distributionId:row.distribution_id, assessmentRecordId:row.assessment_record_id || null, paperId:row.paper_id, paperTitle:row.paper_title,
    studentId:row.student_id, studentName:row.student_name, answers:row.answers || {},
    score:row.score === null ? null : Number(row.score), total:row.total === null ? null : Number(row.total),
    objectiveScore:row.objective_score === null ? null : Number(row.objective_score), subjectiveScore:row.subjective_score === null ? null : Number(row.subjective_score),
    gradingStatus:row.grading_status || (row.graded_at ? 'graded' : 'pending_review'), gradingNote:row.grading_note || '', gradedBy:row.graded_by || null,
    status:row.status, submittedAt:row.submitted_at, gradedAt:row.graded_at,
    wrongQuestions:row.wrong_questions || [], subjectScores:row.subject_scores || {}, subjectTotals:row.subject_totals || {}
  }));
});
app.post('/api/admin/exams/distributions/:id/revoke', { preHandler: requireRoles(['admin','teacher']) }, withIdempotency(async request => {
  const distributionId = uuidSchema.parse(request.params.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const distribution = (await client.query(
      `SELECT d.id,d.student_id,d.paper_id,d.paper_title,d.status,d.started_at,d.submitted_at,
              EXISTS (SELECT 1 FROM entrance_submissions s WHERE s.distribution_id=d.id) AS has_submission
       FROM entrance_distributions d WHERE d.id=$1 FOR UPDATE`, [distributionId]
    )).rows[0];
    if (!distribution) throw Object.assign(new Error('试卷分发不存在'), { statusCode:404 });
    if (!['待开始','作答中','已提交','超时自动交卷','已撤销'].includes(distribution.status)) {
      throw Object.assign(new Error('当前试卷状态不可撤回'), { statusCode:409 });
    }
    if (distribution.status === '已撤销') {
      await client.query('COMMIT');
      return { id:distribution.id, status:'已撤销', alreadyRevoked:true };
    }
    const updated = (await client.query(
      `UPDATE entrance_distributions SET status='已撤销',share_token_hash=$1 WHERE id=$2 RETURNING id,student_id,paper_id,paper_title,status,started_at,submitted_at`,
      [hashToken(makeToken()), distribution.id]
    )).rows[0];
    await client.query(
      `INSERT INTO audit_logs(actor_account_id,action,entity_type,entity_id,metadata)
       VALUES($1,'撤回入学测评分发','entrance_distribution',$2,$3)`,
      [request.account.accountId, String(distribution.id), json({ studentId:distribution.student_id, paperId:distribution.paper_id, previousStatus:distribution.status })]
    );
    await client.query(
      `INSERT INTO learning_events(student_id,event_type,subject,tool_id,event_key,payload)
       VALUES($1,'exam_distribution_revoked','入学摸底','entrance_exam',$2,$3)
       ON CONFLICT(student_id,event_key) DO NOTHING`,
      [distribution.student_id, `exam_distribution_revoked:${distribution.id}`, json({ distributionId:distribution.id, paperId:distribution.paper_id, previousStatus:distribution.status })]
    );
    await client.query('COMMIT');
    return { id:updated.id, studentId:updated.student_id, paperId:updated.paper_id, paperTitle:updated.paper_title, status:updated.status, startedAt:updated.started_at, submittedAt:updated.submitted_at, revoked:true, submissionPreserved:Boolean(distribution.has_submission) };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));
app.patch('/api/admin/exams/submissions/:id/grade', { preHandler: requireRoles(['admin','teacher']) }, withIdempotency(async request => {
  const submissionId = uuidSchema.parse(request.params.id);
  const body = assessmentGradingSchema.parse(request.body);
  if (body.gradedBy && String(body.gradedBy) !== String(request.account.accountId)) {
    throw Object.assign(new Error('批改人必须是当前登录教师'), { statusCode:403 });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const submission = (await client.query(
      `SELECT s.*,d.student_id,d.paper_id,d.paper_title FROM entrance_submissions s
       JOIN entrance_distributions d ON d.id=s.distribution_id WHERE s.id=$1 FOR UPDATE`, [submissionId]
    )).rows[0];
    if (!submission) throw Object.assign(new Error('入学测评提交不存在'), { statusCode:404 });
    const items = (await client.query('SELECT item_index,question_snapshot FROM entrance_paper_items WHERE paper_id=$1 ORDER BY item_index', [submission.paper_id])).rows
      .map(item => ({ itemIndex:item.item_index, questionSnapshot:item.question_snapshot }));
    let grading;
    try { grading = gradeObjectiveAssessment(items, submission.answers || {}); }
    catch (error) { throw Object.assign(new Error('题目快照不可用，暂不能完成批改'), { statusCode:503, code:'ASSESSMENT_UNAVAILABLE', cause:error }); }
    if (body.objectiveScore !== undefined && Number(body.objectiveScore) !== Number(grading.objectiveScore)) {
      throw Object.assign(new Error('客观题成绩必须与服务端题目快照评分一致'), { statusCode:422 });
    }
    const subjectiveTotal = Math.max(0, Number(grading.total) - Number(grading.objectiveScore));
    const requestedStatus = body.gradingStatus;
    const normalizedStatus = requestedStatus === '已批改' ? 'graded'
      : requestedStatus === '部分待批改' ? 'partially_graded'
        : requestedStatus === '待批改' ? 'pending_review' : requestedStatus;
    const subjectiveScore = body.subjectiveScore === undefined ? (submission.subjective_score === null ? null : Number(submission.subjective_score)) : body.subjectiveScore;
    if (subjectiveScore !== null && Number(subjectiveScore) > subjectiveTotal) {
      throw Object.assign(new Error('主观题成绩不能超过题目快照中的主观题满分'), { statusCode:422 });
    }
    if (normalizedStatus === 'graded' && subjectiveScore === null && subjectiveTotal > 0) {
      throw Object.assign(new Error('完成批改前必须填写主观题成绩'), { statusCode:422 });
    }
    const finalScore = normalizedStatus === 'pending_review' && subjectiveScore === null
      ? Number(grading.objectiveScore)
      : Number(grading.objectiveScore) + Number(subjectiveScore || 0);
    const gradedAt = normalizedStatus === 'graded' ? new Date() : null;
    const updated = (await client.query(
      `UPDATE entrance_submissions SET objective_score=$1,subjective_score=$2,score=$3,total=$4,grading_status=$5,grading_note=$6,graded_by=$7,graded_at=$8,updated_at=now()
       WHERE id=$9 RETURNING *`,
      [grading.objectiveScore,subjectiveScore,finalScore,grading.total,normalizedStatus,body.gradingNote || null,request.account.accountId,gradedAt,submissionId]
    )).rows[0];
    if (submission.assessment_record_id) {
      await client.query(
        `UPDATE assessment_records SET score=$1,total=$2,objective_score=$3,subjective_score=$4,grading_status=$5,grading_note=$6,graded_by=$7,graded_at=$8
         WHERE id=$9`,
        [finalScore,grading.total,grading.objectiveScore,subjectiveScore,normalizedStatus,body.gradingNote || null,request.account.accountId,gradedAt,submission.assessment_record_id]
      );
    }
    await client.query('INSERT INTO learning_events(student_id,event_type,subject,payload) VALUES($1,$2,$3,$4)', [submission.student_id, 'exam_graded', '入学摸底', json({ submissionId, objectiveScore:grading.objectiveScore, subjectiveScore, total:grading.total, gradingStatus:normalizedStatus })]);
    await client.query('COMMIT');
    await audit(request.account.accountId, '批改入学测评主观题', 'entrance_submission', submissionId, { studentId:submission.student_id, gradingStatus:normalizedStatus, subjectiveScore });
    return { ...updated, gradingStatus:normalizedStatus, objectiveScore:Number(updated.objective_score), subjectiveScore:updated.subjective_score === null ? null : Number(updated.subjective_score), score:Number(updated.score), total:Number(updated.total), gradedBy:updated.graded_by, gradingNote:updated.grading_note || '' };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));
app.post('/api/exams/distributions', { preHandler: requireRoles(['admin','teacher']) }, withIdempotency(async (request, reply) => {
  const body = distributionSchema.parse(request.body);
  const paper = (await pool.query("SELECT id,title,state FROM entrance_papers WHERE id=$1", [body.paperId])).rows[0];
  if (!paper || paper.state !== '已发布') throw Object.assign(new Error('试卷不存在或尚未发布'), { statusCode:422 });
  const student = (await pool.query('SELECT id FROM students WHERE id=$1', [body.studentId])).rows[0];
  if (!student) throw Object.assign(new Error('学员不存在'), { statusCode:404 });
  const token = makeToken(); const assignedAt = new Date(); const deadline = body.startDeadlineAt ? new Date(body.startDeadlineAt) : new Date(assignedAt.getTime() + 7 * 86400000);
  if (deadline <= assignedAt) throw Object.assign(new Error('开始期限必须晚于当前时间'), { statusCode:422 });
  const result = await pool.query('INSERT INTO entrance_distributions(student_id,paper_id,paper_title,share_token_hash,start_deadline_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(student_id,paper_id) DO UPDATE SET share_token_hash=EXCLUDED.share_token_hash,start_deadline_at=EXCLUDED.start_deadline_at,started_at=NULL,exam_deadline_at=NULL,submitted_at=NULL,status=\'待开始\' RETURNING id,student_id,paper_id,paper_title,assigned_at,start_deadline_at,status', [student.id, body.paperId, paper.title, hashToken(token), deadline]);
  await pool.query(`INSERT INTO student_notifications(student_id,type,title,body,entity_type,entity_id) VALUES($1,'系统通知',$2,$3,'entrance_distribution',$4)`, [student.id, '老师给你分发了一份入学摸底试卷', `「${paper.title}」已分发，请在 ${chinaDateKey(deadline)} 前开始作答。`, String(result.rows[0].id)]);
  await audit(request.account.accountId, '分发入学测评', 'entrance_distribution', result.rows[0].id, { studentId:student.id, paperId:body.paperId });
  return { distribution: result.rows[0], shareToken: token };
}));
app.get('/api/student/exam-distributions', { preHandler: requireStudent }, async request => {
  const rows = (await pool.query(`SELECT id,paper_id,paper_title,assigned_at,start_deadline_at,started_at,exam_deadline_at,submitted_at,status
    FROM entrance_distributions WHERE student_id=$1 AND submitted_at IS NULL AND status NOT IN ('已提交','超时自动交卷','已撤销') ORDER BY assigned_at DESC`, [request.account.studentId])).rows;
  return rows.map(row => ({ id:row.id, paperId:row.paper_id, paperTitle:row.paper_title, assignedAt:row.assigned_at, startDeadlineAt:row.start_deadline_at, startedAt:row.started_at, examDeadlineAt:row.exam_deadline_at, status:row.status }));
});
app.post('/api/student/exam-distributions/:id/access', { preHandler: requireStudent }, async request => {
  const distributionId = uuidSchema.parse(request.params.id);
  const distribution = (await pool.query('SELECT id,paper_id,paper_title,student_id,submitted_at,status FROM entrance_distributions WHERE id=$1', [distributionId])).rows[0];
  if (!distribution || String(distribution.student_id) !== String(request.account.studentId)) throw Object.assign(new Error('试卷不存在或无权访问'), { statusCode:404 });
  if (distribution.submitted_at || ['已提交','超时自动交卷','已撤销'].includes(distribution.status)) throw Object.assign(new Error('该试卷已结束，无法再次作答'), { statusCode:410 });
  const token = makeToken();
  await pool.query('UPDATE entrance_distributions SET share_token_hash=$1 WHERE id=$2', [hashToken(token), distribution.id]);
  await audit(request.account.accountId, '学生打开入学自测', 'entrance_distribution', distribution.id);
  return { paperId:distribution.paper_id, paperTitle:distribution.paper_title, shareToken:token };
});

app.get('/api/exams/:paperId/:token', async (request, reply) => {
  const params = z.object({ paperId: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/, '试卷 ID 只能包含字母、数字、下划线或短横线'), token: z.string().trim().min(1).max(200) }).parse(request.params);
  const row = (await pool.query("SELECT d.id,d.paper_id,d.paper_title,d.assigned_at,d.start_deadline_at,d.started_at,d.exam_deadline_at,d.submitted_at,d.status,p.duration_minutes FROM entrance_distributions d JOIN entrance_papers p ON p.id=d.paper_id WHERE d.paper_id=$1 AND d.share_token_hash=$2 AND p.state='已发布'", [params.paperId, hashToken(params.token)])).rows[0];
  if (!row) throw Object.assign(new Error('试卷链接无效'), { statusCode:404 });
  if (row.submitted_at || ['已提交','超时自动交卷','已撤销'].includes(row.status)) throw Object.assign(new Error('该试卷链接已失效'), { statusCode:410 });
  if (!row.started_at && new Date(row.start_deadline_at) <= new Date()) throw Object.assign(new Error('试卷开始期限已结束'), { statusCode:410 });
  const items = (await pool.query('SELECT item_index,question_snapshot FROM entrance_paper_items WHERE paper_id=$1 ORDER BY item_index', [row.paper_id])).rows;
  reply.setCookie('exam_session', jwt.sign({ distributionId:row.id, shareTokenHash:hashToken(params.token) }, JWT_SECRET, { expiresIn:'8d' }), { httpOnly:true, sameSite:'lax', secure:process.env.NODE_ENV === 'production', path:'/api/exams', maxAge:60 * 60 * 24 * 8 });
  return { distribution:row, questions:items.map(item => publicQuestion({ itemIndex:item.item_index, ...item.question_snapshot })) };
});
const distributionFields = 'id,student_id,paper_id,paper_title,share_token_hash,assigned_at,start_deadline_at,started_at,exam_deadline_at,submitted_at,status';
app.post('/api/exams/distributions/:id/start', { preHandler: requireExamToken }, async request => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = (await client.query(`SELECT id,student_id,paper_id,paper_title,assigned_at,start_deadline_at,started_at,exam_deadline_at,submitted_at,status FROM entrance_distributions WHERE id=$1 FOR UPDATE`, [request.params.id])).rows[0];
    if (!current) throw Object.assign(new Error('试卷分发不存在'), { statusCode:404 });
    if (current.submitted_at) throw Object.assign(new Error('试卷已提交'), { statusCode:409 });
    if (current.started_at) { await client.query('COMMIT'); return current; }
    if (new Date(current.start_deadline_at) <= new Date()) throw Object.assign(new Error('开始期限已结束'), { statusCode:410 });
    const paper = (await client.query('SELECT duration_minutes FROM entrance_papers WHERE id=$1', [current.paper_id])).rows[0];
    if (!paper) throw Object.assign(new Error('试卷不存在'), { statusCode:404 });
    const now = new Date(); const deadline = new Date(now.getTime() + Number(paper.duration_minutes) * 60000);
    const result = (await client.query(`UPDATE entrance_distributions SET started_at=$1,exam_deadline_at=$2,status='作答中' WHERE id=$3 RETURNING ${distributionFields}`, [now, deadline, current.id])).rows[0];
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});
app.post('/api/exams/distributions/:id/submit', { preHandler: requireExamToken }, async request => {
  const distributionId = uuidSchema.parse(request.params.id);
  const answers = z.record(answerValueSchema).parse(request.body?.answers || {});
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = (await client.query(`SELECT ${distributionFields} FROM entrance_distributions WHERE id=$1 FOR UPDATE`, [distributionId])).rows[0];
    if (!current) throw Object.assign(new Error('试卷分发不存在'), { statusCode:404 });
    if (current.submitted_at || ['已提交','超时自动交卷','已撤销'].includes(current.status)) throw Object.assign(new Error('试卷已提交或已失效'), { statusCode:409 });
    if (!current.started_at) throw Object.assign(new Error('请先开始答题'), { statusCode:409 });
    const existing = (await client.query('SELECT * FROM entrance_submissions WHERE distribution_id=$1', [current.id])).rows[0];
    if (existing) { await client.query('COMMIT'); return existing; }
    const items = (await client.query('SELECT item_index,question_snapshot FROM entrance_paper_items WHERE paper_id=$1 ORDER BY item_index', [current.paper_id])).rows.map(item => ({ itemIndex:item.item_index, questionSnapshot:item.question_snapshot }));
    if (!items.length) throw Object.assign(new Error('试卷没有可作答题目'), { statusCode:422 });
    let grading;
    try {
      grading = gradeObjectiveAssessment(items, answers);
    } catch (error) {
      throw Object.assign(new Error('试卷题目快照不可用，暂不能评分'), { statusCode:503, code:'ASSESSMENT_UNAVAILABLE', cause:error });
    }
    const timedOut = current.exam_deadline_at && new Date(current.exam_deadline_at) <= new Date();
    const status = timedOut ? '超时自动交卷' : '已提交';
    await client.query('UPDATE entrance_distributions SET submitted_at=now(),status=$1 WHERE id=$2', [status, current.id]);
    const submissionInsert = await client.query(
      `INSERT INTO entrance_submissions(distribution_id,answers,score,total,status,graded_at,objective_score,grading_status,wrong_questions,subject_scores,subject_totals)
       VALUES($1,$2,$3,$4,$5,CASE WHEN $6 THEN now() ELSE NULL END,$3,$7,$8,$9,$10) RETURNING *`,
      [current.id, json(answers), grading.objectiveScore, grading.total, status, grading.reviewStatus === 'graded', grading.reviewStatus === 'graded' ? 'graded' : 'pending_review', json(grading.wrongQuestions), json(grading.subjectScores), json(grading.subjectTotals)]
    );
    const result = submissionInsert.rows[0];
    const assessmentRecord = (await client.query(
      `INSERT INTO assessment_records(student_id,course_id,question_set_id,assessment_type,subject,title,score,total,objective_score,subjective_score,grading_status,answers,wrong_questions,graded_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,CASE WHEN $11='graded' THEN now() ELSE NULL END) RETURNING id`,
      [current.student_id,null,null,'entrance','入学摸底',current.paper_title,grading.objectiveScore,grading.total,grading.objectiveScore,null,grading.reviewStatus,json(answers),json(grading.wrongQuestions)]
    )).rows[0];
    await client.query('UPDATE entrance_submissions SET assessment_record_id=$1 WHERE id=$2', [assessmentRecord.id, result.id]);
    await archiveWrongQuestions(client, { studentId:current.student_id, assessmentRecordId:assessmentRecord.id, submissionId:result.id, subject:'入学摸底', wrongQuestions:grading.wrongQuestions });
    await client.query('INSERT INTO learning_events(student_id,event_type,subject,payload) VALUES($1,$2,$3,$4)', [current.student_id,'exam_submitted','入学摸底',json({ distributionId:current.id, paperId:current.paper_id, score:grading.score, total:grading.total, gradingStatus:grading.gradingStatus })]);
    await client.query('COMMIT');
    return { ...result, gradingStatus:grading.gradingStatus };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '开始日期必须为 YYYY-MM-DD').refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, '开始日期无效');
const planRowSchema = z.object({
  title:z.string().trim().max(160).optional(),
  tasks:z.array(z.string().trim().min(1, '任务内容不能为空').max(1000)).max(30)
}).strict().refine(row => row.tasks.length > 0, '任务行不能没有任务');
const studentPlanSchema = z.object({ courseId:uuidSchema.nullable().optional(), subject:z.string().trim().min(1).max(60), name:z.string().trim().min(1).max(160), taskType:z.enum(['长期','阶段']).default('阶段'), startDay:z.number().int().min(1).max(365).default(1), startDate:dateOnlySchema.nullable().optional(), lane:z.number().int().min(1).max(8).default(1), predecessorPlanId:uuidSchema.nullable().optional(), rows:z.array(planRowSchema).min(1).max(365) }).strict();
const studentPlanStartDateSchema = z.object({ startDate:dateOnlySchema.nullable(), revision:z.number().int().min(1) }).strict();
const studentPlanPatchSchema = studentPlanSchema.extend({ revision:z.number().int().min(1) }).strict();
const studentPlanDeleteSchema = z.object({ revision:z.number().int().min(1).optional() }).strict();
const chinaDateKey = (value = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit' }).format(value);
const assertPlanPredecessorIsAcyclic = async (queryable, { studentId, planId = null, predecessorPlanId }) => {
  if (!predecessorPlanId) return;
  const rows = (await queryable.query(
    'SELECT id,predecessor_plan_id FROM student_plans WHERE student_id=$1 FOR UPDATE', [studentId]
  )).rows;
  const byId = new Map(rows.map(row => [String(row.id), row]));
  if (!byId.has(String(predecessorPlanId))) {
    throw Object.assign(new Error('前置计划不存在或不属于该学员'), { statusCode:422 });
  }
  const seen = new Set();
  let currentId = String(predecessorPlanId);
  while (currentId) {
    if (String(currentId) === String(planId)) {
      throw Object.assign(new Error('前置计划不能形成环路'), { statusCode:422 });
    }
    if (seen.has(currentId)) {
      throw Object.assign(new Error('前置计划链已存在环路'), { statusCode:422 });
    }
    seen.add(currentId);
    const predecessor = byId.get(currentId);
    if (!predecessor) throw Object.assign(new Error('前置计划链包含不属于该学员的计划'), { statusCode:422 });
    currentId = predecessor.predecessor_plan_id ? String(predecessor.predecessor_plan_id) : null;
  }
};
const planTaskDetail = (plan, rowIndex, taskIndex) => {
  const rows = Array.isArray(plan.rows) ? plan.rows : [];
  const row = rows[rowIndex];
  const task = row && Array.isArray(row.tasks) ? row.tasks[taskIndex] : null;
  if (typeof task !== 'string' || !task.trim()) throw Object.assign(new Error('任务不存在或任务内容为空'), { statusCode:404 });
  return { text:task.trim(), startDay:Number(plan.start_day || 1), dayNumber:taskDayNumber(plan.start_day || 1, rowIndex) };
};
const insertPlanTemplateRows = async (client, templateId, rows) => {
  const records = planTemplateRowDtos(rows);
  for (const [index, record] of records.entries()) {
    await client.query('INSERT INTO plan_template_rows(template_id,row_index,title,tasks) VALUES($1,$2,$3,$4)', [templateId, index, record.title, json(record.tasks)]);
  }
  return records;
};
app.get('/api/admin/plan-templates', { preHandler: requireRoles(['admin','teacher']) }, async request => {
  const query = z.object({ subject: planTemplateSubjectSchema.optional() }).parse(request.query ?? {});
  const templates = (await pool.query(
    `SELECT id,subject,name,category,columns,state,created_by,created_at,updated_at FROM plan_templates ${query.subject ? 'WHERE subject=$1' : ''} ORDER BY subject,created_at DESC`,
    query.subject ? [query.subject] : []
  )).rows;
  const rowsByTemplate = new Map();
  if (templates.length) {
    const rows = (await pool.query('SELECT template_id,title,tasks FROM plan_template_rows WHERE template_id=ANY($1::uuid[]) ORDER BY row_index', [templates.map(template => template.id)])).rows;
    for (const row of rows) {
      const key = String(row.template_id);
      if (!rowsByTemplate.has(key)) rowsByTemplate.set(key, []);
      rowsByTemplate.get(key).push(row);
    }
  }
  return { templates: templates.map(template => planTemplateDto(template, rowsByTemplate.get(String(template.id)) || [])) };
});
app.post('/api/admin/plan-templates', { preHandler: requireRoles(['admin','teacher']) }, withIdempotency(async request => {
  const body = planTemplatePayloadSchema.parse(request.body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const template = (await client.query(
      `INSERT INTO plan_templates(subject,name,category,state,columns,created_by) VALUES($1,$2,$3,'已发布',$4,$5) RETURNING *`,
      [body.subject, body.name, body.category, json(body.columns), request.account.accountId]
    )).rows[0];
    const records = await insertPlanTemplateRows(client, template.id, body.rows);
    await client.query('COMMIT');
    await audit(request.account.accountId, '创建复习计划模板', 'plan_template', template.id, { subject: body.subject, rowCount: body.rows.length });
    return { template: planTemplateDto(template, records) };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));
app.put('/api/admin/plan-templates/:id', { preHandler: requireRoles(['admin','teacher']) }, withIdempotency(async request => {
  const id = uuidSchema.parse(request.params.id);
  const body = planTemplateUpdateSchema.parse(request.body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = (await client.query(
      'UPDATE plan_templates SET name=$1,category=$2,columns=$3,updated_at=now() WHERE id=$4 RETURNING *',
      [body.name, body.category, json(body.columns), id]
    )).rows[0];
    if (!updated) throw Object.assign(new Error('复习计划模板不存在'), { statusCode: 404 });
    await client.query('DELETE FROM plan_template_rows WHERE template_id=$1', [id]);
    const records = await insertPlanTemplateRows(client, id, body.rows);
    await client.query('COMMIT');
    await audit(request.account.accountId, '更新复习计划模板', 'plan_template', id, { rowCount: body.rows.length });
    return { template: planTemplateDto(updated, records) };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));
app.delete('/api/admin/plan-templates/:id', { preHandler: requireRoles(['admin','teacher']) }, withIdempotency(async request => {
  const id = uuidSchema.parse(request.params.id);
  const row = (await pool.query('DELETE FROM plan_templates WHERE id=$1 RETURNING id', [id])).rows[0];
  if (!row) throw Object.assign(new Error('复习计划模板不存在'), { statusCode: 404 });
  await audit(request.account.accountId, '删除复习计划模板', 'plan_template', id);
  return { id, deleted: true };
}));

app.get('/api/students/:id/plans', { preHandler: app.auth }, async request => {
  const studentId = uuidSchema.parse(request.params.id);
  if (!canAccessStudent(request, studentId)) throw Object.assign(new Error('无权访问该学员计划'), { statusCode:403 });
  const plans = (await pool.query('SELECT id,student_id,template_id,course_id,subject,name,task_type,start_day,start_date,lane,predecessor_plan_id,rows,revision,created_at,updated_at FROM student_plans WHERE student_id=$1 ORDER BY subject,created_at', [studentId])).rows;
  const ids = plans.map(plan => plan.id);
  const completions = ids.length ? (await pool.query('SELECT student_plan_id,row_index,task_index,completed_at FROM task_completions WHERE student_plan_id=ANY($1::uuid[]) ORDER BY completed_at', [ids])).rows : [];
  return { plans, completions };
});
app.post('/api/students/:id/plans', { preHandler: requireRoles(['admin','teacher']) }, withIdempotency(async (request, reply) => {
  const studentId = uuidSchema.parse(request.params.id);
  const body = studentPlanSchema.parse(request.body);
  const student = (await pool.query('SELECT id FROM students WHERE id=$1', [studentId])).rows[0];
  if (!student) throw Object.assign(new Error('学员不存在'), { statusCode:404 });
  if (body.courseId) {
    const course = (await pool.query("SELECT id,state FROM courses WHERE id=$1", [body.courseId])).rows[0];
    if (!course || course.state !== '已发布') throw Object.assign(new Error('计划绑定的课程不存在或未发布'), { statusCode:422 });
  }
  if (body.predecessorPlanId) {
    const predecessor = (await pool.query('SELECT id FROM student_plans WHERE id=$1 AND student_id=$2', [body.predecessorPlanId, studentId])).rows[0];
    if (!predecessor) throw Object.assign(new Error('前置计划不存在或不属于该学员'), { statusCode:422 });
    await assertPlanPredecessorIsAcyclic(pool, { studentId, predecessorPlanId:body.predecessorPlanId });
  }
  const result = (await pool.query('INSERT INTO student_plans(student_id,course_id,subject,name,task_type,start_day,start_date,lane,predecessor_plan_id,rows) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *', [studentId, body.courseId || null, body.subject, body.name, body.taskType, body.startDay, body.startDate || null, body.lane, body.predecessorPlanId || null, json(body.rows)])).rows[0];
  await audit(request.account.accountId, '创建学员计划', 'student_plan', result.id, { studentId, subject:body.subject, startDate:body.startDate || null });
  return result;
}));
app.patch('/api/students/:id/plans/:planId', { preHandler: requireRoles(['admin','teacher']) }, async request => {
  const studentId = uuidSchema.parse(request.params.id);
  const planId = uuidSchema.parse(request.params.planId);
  const body = studentPlanPatchSchema.parse(request.body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [String(studentId)]);
    if (body.courseId) {
      const course = (await client.query("SELECT id,state FROM courses WHERE id=$1", [body.courseId])).rows[0];
      if (!course || course.state !== '已发布') throw Object.assign(new Error('计划绑定的课程不存在或未发布'), { statusCode:422 });
    }
    const current = (await client.query('SELECT id FROM student_plans WHERE id=$1 AND student_id=$2', [planId, studentId])).rows[0];
    if (!current) throw Object.assign(new Error('计划不存在或不属于该学员'), { statusCode:404 });
    await assertPlanPredecessorIsAcyclic(client, { studentId, planId, predecessorPlanId:body.predecessorPlanId || null });
    const result = (await client.query(
      `UPDATE student_plans SET course_id=$1,subject=$2,name=$3,task_type=$4,start_day=$5,start_date=$6,lane=$7,predecessor_plan_id=$8,rows=$9,revision=revision+1,updated_at=now()
       WHERE id=$10 AND student_id=$11 AND revision=$12 RETURNING *`,
      [body.courseId || null,body.subject,body.name,body.taskType,body.startDay,body.startDate || null,body.lane,body.predecessorPlanId || null,json(body.rows),planId,studentId,body.revision]
    )).rows[0];
    if (!result) throw Object.assign(new Error('计划已被其他人修改，请重新加载后再保存'), { statusCode:409 });
    await client.query('COMMIT');
    await audit(request.account.accountId, '修改学员计划', 'student_plan', planId, { studentId, revision:body.revision, nextRevision:result.revision });
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});
app.delete('/api/students/:id/plans/:planId', { preHandler: requireRoles(['admin','teacher']) }, async request => {
  const studentId = uuidSchema.parse(request.params.id);
  const planId = uuidSchema.parse(request.params.planId);
  const body = studentPlanDeleteSchema.parse(request.body || {});
  const result = (await pool.query(
    'DELETE FROM student_plans WHERE id=$1 AND student_id=$2 AND ($3::int IS NULL OR revision=$3) RETURNING id',
    [planId,studentId,body.revision || null]
  )).rows[0];
  if (!result) throw Object.assign(new Error('计划不存在或版本已变化，请重新加载'), { statusCode:409 });
  await audit(request.account.accountId, '删除学员计划', 'student_plan', planId, { studentId });
  return { id:result.id, deleted:true };
});
app.get('/api/students/:id/plans/:planId/details', { preHandler: app.auth }, async request => {
  const studentId = uuidSchema.parse(request.params.id);
  const planId = uuidSchema.parse(request.params.planId);
  if (!canAccessStudent(request, studentId)) throw Object.assign(new Error('无权访问该计划详情'), { statusCode:403 });
  const plan = (await pool.query('SELECT id,student_id,course_id,subject,name,task_type,start_day,start_date,lane,predecessor_plan_id,rows,revision,created_at,updated_at FROM student_plans WHERE id=$1 AND student_id=$2', [planId,studentId])).rows[0];
  if (!plan) throw Object.assign(new Error('计划不存在'), { statusCode:404 });
  const [completionsResult, eventsResult] = await Promise.all([
    pool.query('SELECT id,row_index,task_index,completed_at FROM task_completions WHERE student_plan_id=$1 ORDER BY row_index,task_index', [planId]),
    pool.query(`SELECT id,event_type,subject,tool_id,event_key,payload,occurred_at,created_at FROM learning_events
                WHERE student_id=$1 AND payload->>'planId'=$2 ORDER BY occurred_at DESC LIMIT 1000`, [studentId, String(planId)])
  ]);
  const completions = completionsResult.rows;
  const events = eventsResult.rows.map(event => ({ id:event.id, eventType:event.event_type, subject:event.subject, toolId:event.tool_id, eventKey:event.event_key, payload:event.payload || {}, occurredAt:event.occurred_at, createdAt:event.created_at }));
  const completionByKey = new Map(completions.map(item => [`${item.row_index}:${item.task_index}`, item]));
  const rows = (Array.isArray(plan.rows) ? plan.rows : []).map((row, rowIndex) => ({
    rowIndex, startDay:Number(plan.start_day || 1), dayNumber:taskDayNumber(plan.start_day || 1, rowIndex), title:row.title || '', tasks:(Array.isArray(row.tasks) ? row.tasks : []).map((task, taskIndex) => {
      if (typeof task !== 'string' || !task.trim()) return null;
      const completion = completionByKey.get(`${rowIndex}:${taskIndex}`);
      return { taskIndex, text:task.trim(), startDay:Number(plan.start_day || 1), dayNumber:taskDayNumber(plan.start_day || 1, rowIndex), completed:Boolean(completion), completedAt:completion?.completed_at || null };
    }).filter(Boolean)
  }));
  return { plan, startDay:Number(plan.start_day || 1), rows, completions, events, totalTasks:rows.reduce((sum,row) => sum + row.tasks.length, 0), completedTasks:completions.length };
});
app.get('/api/plans/:id/tasks/:rowIndex/:taskIndex/details', { preHandler: app.auth }, async request => {
  const planId = uuidSchema.parse(request.params.id);
  const rowIndex = z.coerce.number().int().min(0).parse(request.params.rowIndex);
  const taskIndex = z.coerce.number().int().min(0).parse(request.params.taskIndex);
  const plan = (await pool.query('SELECT id,student_id,course_id,subject,start_day,start_date,rows FROM student_plans WHERE id=$1', [planId])).rows[0];
  if (!plan) throw Object.assign(new Error('计划不存在'), { statusCode:404 });
  if (!canAccessStudent(request, plan.student_id)) throw Object.assign(new Error('无权访问该任务详情'), { statusCode:403 });
  if (plan.course_id && request.account.role === 'student') await assertStudentCourseAccess(pool, request.account.studentId, plan.course_id);
  const task = planTaskDetail(plan, rowIndex, taskIndex);
  const completion = (await pool.query('SELECT id,row_index,task_index,completed_at FROM task_completions WHERE student_plan_id=$1 AND row_index=$2 AND task_index=$3', [planId,rowIndex,taskIndex])).rows[0] || null;
  const events = (await pool.query(`SELECT id,event_type,subject,tool_id,event_key,knowledge_tags,payload,occurred_at,created_at
    FROM learning_events WHERE student_id=$1 AND payload->>'planId'=$2 AND payload->>'rowIndex'=$3 AND payload->>'taskIndex'=$4 ORDER BY occurred_at DESC LIMIT 100`, [plan.student_id,String(planId),String(rowIndex),String(taskIndex)])).rows;
  return { planId, studentId:plan.student_id, subject:plan.subject, task, completion, events:events.map(event => ({ id:event.id, eventType:event.event_type, subject:event.subject, toolId:event.tool_id, eventKey:event.event_key, knowledgeTags:event.knowledge_tags || [], payload:event.payload || {}, occurredAt:event.occurred_at, createdAt:event.created_at })) };
});
app.get('/api/students/:id/plans/:planId/progress', { preHandler: app.auth }, async request => {
  const studentId = uuidSchema.parse(request.params.id);
  const planId = uuidSchema.parse(request.params.planId);
  if (!canAccessStudent(request, studentId)) throw Object.assign(new Error('无权访问该计划进度'), { statusCode:403 });
  const plan = (await pool.query('SELECT id,rows,revision FROM student_plans WHERE id=$1 AND student_id=$2', [planId,studentId])).rows[0];
  if (!plan) throw Object.assign(new Error('计划不存在'), { statusCode:404 });
  const totalTasks = (Array.isArray(plan.rows) ? plan.rows : []).reduce((sum,row) => sum + (Array.isArray(row.tasks) ? row.tasks.filter(Boolean).length : 0), 0);
  const completedTasks = (await pool.query('SELECT count(*)::int AS count FROM task_completions WHERE student_plan_id=$1', [planId])).rows[0].count;
  return { planId, revision:plan.revision, totalTasks, completedTasks, progressPercent:totalTasks ? Math.round((completedTasks / totalTasks) * 100) : 0 };
});
app.patch('/api/students/:id/plans/:planId/start-date', { preHandler: requireRoles(['admin','teacher']) }, withIdempotency(async request => {
  const studentId = uuidSchema.parse(request.params.id);
  const planId = uuidSchema.parse(request.params.planId);
  const body = studentPlanStartDateSchema.parse(request.body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = (await client.query(
      'UPDATE student_plans SET start_date=$1,revision=revision+1,updated_at=now() WHERE id=$2 AND student_id=$3 AND revision=$4 RETURNING *',
      [body.startDate, planId, studentId, body.revision]
    )).rows[0];
    if (!result) throw Object.assign(new Error('任务组合版本已变化，请重新加载后再保存'), { statusCode:409 });
    await client.query('COMMIT');
    await audit(request.account.accountId, '设置任务组合开始日期', 'student_plan', planId, { studentId, startDate:body.startDate, revision:body.revision, nextRevision:result.revision });
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));
app.post('/api/plans/:id/tasks/:rowIndex/:taskIndex/complete', { preHandler: requireStudent }, withIdempotency(async request => {
  const planId = uuidSchema.parse(request.params.id);
  const rowIndex = z.coerce.number().int().min(0).parse(request.params.rowIndex);
  const taskIndex = z.coerce.number().int().min(0).parse(request.params.taskIndex);
  const plan = (await pool.query('SELECT id,student_id,course_id,subject,start_day,start_date,rows FROM student_plans WHERE id=$1', [planId])).rows[0];
  if (!plan || String(plan.student_id) !== String(request.account.studentId)) throw Object.assign(new Error('无权完成该任务'), { statusCode:403 });
  if (plan.course_id) await assertStudentCourseAccess(pool, request.account.studentId, plan.course_id);
  if (plan.start_date && chinaDateKey() < String(plan.start_date)) {
    throw Object.assign(new Error(`该任务组合将于 ${plan.start_date} 开始`), { statusCode:422 });
  }
  const task = planTaskDetail(plan, rowIndex, taskIndex);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = (await client.query('INSERT INTO task_completions(student_plan_id,row_index,task_index) VALUES($1,$2,$3) ON CONFLICT(student_plan_id,row_index,task_index) DO NOTHING RETURNING *', [planId, rowIndex, taskIndex])).rows[0];
    const completion = result || (await client.query('SELECT * FROM task_completions WHERE student_plan_id=$1 AND row_index=$2 AND task_index=$3', [planId,rowIndex,taskIndex])).rows[0];
    if (result) {
      await client.query('INSERT INTO learning_events(student_id,event_type,subject,tool_id,event_key,payload) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(student_id,event_key) DO NOTHING', [request.account.studentId,'task_completed',plan.subject,'student_plan',`task_completed:${completion.id}`,json({ planId,rowIndex,taskIndex,completionId:completion.id,courseId:plan.course_id || null,task:task.text,startDay:task.startDay,dayNumber:task.dayNumber })]);
    }
    await client.query('COMMIT');
    if (result) await audit(request.account.accountId, '完成学习任务', 'task_completion', result.id, { planId, rowIndex, taskIndex, startDay:task.startDay, dayNumber:task.dayNumber });
    return { completed:true, completion, task };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));
app.delete('/api/plans/:id/tasks/:rowIndex/:taskIndex/complete', { preHandler: requireStudent }, withIdempotency(async request => {
  const planId = uuidSchema.parse(request.params.id);
  const rowIndex = z.coerce.number().int().min(0).parse(request.params.rowIndex);
  const taskIndex = z.coerce.number().int().min(0).parse(request.params.taskIndex);
  const plan = (await pool.query('SELECT id,student_id,course_id,subject,start_day,start_date,rows FROM student_plans WHERE id=$1', [planId])).rows[0];
  if (!plan || String(plan.student_id) !== String(request.account.studentId)) throw Object.assign(new Error('无权修改该任务'), { statusCode:403 });
  if (plan.course_id) await assertStudentCourseAccess(pool, request.account.studentId, plan.course_id);
  if (plan.start_date && chinaDateKey() < String(plan.start_date)) {
    throw Object.assign(new Error(`该任务组合将于 ${plan.start_date} 开始`), { statusCode:422 });
  }
  const task = planTaskDetail(plan, rowIndex, taskIndex);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const removed = await client.query('DELETE FROM task_completions WHERE student_plan_id=$1 AND row_index=$2 AND task_index=$3 RETURNING id', [planId,rowIndex,taskIndex]);
    if (removed.rowCount) {
      await client.query('INSERT INTO learning_events(student_id,event_type,subject,tool_id,event_key,payload) VALUES($1,$2,$3,$4,$5,$6)', [request.account.studentId,'task_uncompleted',plan.subject,'student_plan',`task_uncompleted:${removed.rows[0].id}:${Date.now()}`,json({ planId,rowIndex,taskIndex,completionId:removed.rows[0].id,courseId:plan.course_id || null,task:task.text,startDay:task.startDay,dayNumber:task.dayNumber })]);
    }
    await client.query('COMMIT');
    if (removed.rowCount) await audit(request.account.accountId, '撤销学习任务', 'task_completion', removed.rows[0].id, { planId, rowIndex, taskIndex, startDay:task.startDay, dayNumber:task.dayNumber });
    return { completed:false, task };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));

app.get('/api/students/:id/assessments', { preHandler: app.auth }, async request => {
  const studentId = uuidSchema.parse(request.params.id);
  if (!canAccessStudent(request, studentId)) throw Object.assign(new Error('无权访问该学员自测档案'), { statusCode:403 });
  const result = (await pool.query('SELECT id,course_id,question_set_id,assessment_type,subject,title,score,total,objective_score,subjective_score,grading_status,grading_note,graded_by,answers,wrong_questions,submitted_at,graded_at FROM assessment_records WHERE student_id=$1 ORDER BY submitted_at DESC', [studentId])).rows;
  // 客观/主观分项满分：按题目集快照中题型分值合计，供双端档案正确显示"客观分 x/20 · 主观分 y/10"。
  const setIds = [...new Set(result.map(row => row.question_set_id).filter(Boolean))];
  const setMap = {};
  for (const setId of setIds) {
    const set = (await pool.query('SELECT questions FROM assessment_question_sets WHERE id=$1', [setId])).rows[0];
    if (!set) continue;
    const questions = Array.isArray(set.questions) ? set.questions : [];
    const isSubjective = q => ['short_answer','fill_blank','translation'].includes(q.questionType || q.question_type);
    setMap[setId] = {
      subjectiveTotal: questions.filter(isSubjective).reduce((sum, q) => sum + Number(q.score || 0), 0),
      objectiveTotal: questions.filter(q => !isSubjective(q)).reduce((sum, q) => sum + Number(q.score || 0), 0),
      questions
    };
  }
  return result.map(row => {
    // 主观题作答明细：教师批改与学生复盘都需要看到"题目 + 学生原文 + 参考答案"，
    // 此前档案只存 answers 键值对，教师只能盲批。
    const setInfo = setMap[row.question_set_id];
    let subjectiveReview = [];
    if (setInfo) {
      const answers = row.answers && typeof row.answers === 'object' ? row.answers : {};
      subjectiveReview = (setInfo.questions || [])
        .filter(q => ['short_answer','fill_blank','translation'].includes(q.questionType || q.question_type))
        .map(q => ({
          itemIndex: q.itemIndex,
          stem: q.stem || '',
          score: Number(q.score || 0),
          referenceAnswer: typeof q.correctAnswer === 'string' ? q.correctAnswer : (Array.isArray(q.correctAnswer) ? q.correctAnswer.join('；') : ''),
          analysis: q.analysis || '',
          knowledgePoint: q.knowledgePoint || '',
          studentAnswer: String(answers[String(q.itemIndex)] ?? answers[q.itemIndex] ?? '').slice(0, 2000)
        }));
    }
    return {
      ...row,
      score:row.score === null ? null : Number(row.score), total:row.total === null ? null : Number(row.total),
      objectiveScore:row.objective_score === null ? null : Number(row.objective_score), subjectiveScore:row.subjective_score === null ? null : Number(row.subjective_score),
      objectiveTotal:setInfo?.objectiveTotal ?? null, subjectiveTotal:setInfo?.subjectiveTotal ?? null,
      subjectiveReview,
      gradingStatus:row.grading_status || 'pending_review', gradingNote:row.grading_note || '', gradedBy:row.graded_by || null
    };
  });
});
app.post('/api/students/:id/assessments', { preHandler: requireStudent }, withIdempotency(async (request, reply) => {
  const studentId = uuidSchema.parse(request.params.id);
  if (!canAccessStudent(request, studentId)) throw Object.assign(new Error('无权写入该学员自测档案'), { statusCode:403 });
  const body = assessmentSchema.parse(request.body);
  const submissionDecision = assessmentSubmissionDecision(body);
  if (submissionDecision.status === 422) {
    throw Object.assign(new Error(submissionDecision.message), { statusCode:422, code:submissionDecision.code });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assertStudentSubjectEnrollment(client, studentId, body.subject);
    if (body.courseId) await assertStudentCourseAccess(client, studentId, body.courseId);
    let grading = null;
    let reviewStatus = 'pending_review';
    if (body.questionSetId) {
      const questionSet = (await client.query(
        `SELECT id,student_id,subject,assessment_type,state,questions FROM assessment_question_sets
         WHERE id=$1 AND (student_id=$2 OR student_id IS NULL) FOR UPDATE`, [body.questionSetId, studentId]
      )).rows[0];
      if (!questionSet || questionSet.state !== '已发布' || !subjectsMatch(body.subject, questionSet.subject) || questionSet.assessment_type !== body.assessmentType) {
        throw Object.assign(new Error('题目集不存在、未发布或与本次自测不匹配'), { statusCode:422, code:'ASSESSMENT_UNAVAILABLE' });
      }
      try {
        grading = gradeObjectiveAssessment(questionSet.questions, body.answers);
        reviewStatus = grading.reviewStatus;
      } catch (error) {
        throw Object.assign(new Error('正式题库题目不可用，暂不能完成服务端评分'), { statusCode:503, code:'ASSESSMENT_UNAVAILABLE', cause:error });
      }
    } else {
      // 没有正式题库/AI executor 时，不把浏览器演示题或客户端成绩写成真实成绩。
      reviewStatus = 'pending_review';
    }
    const result = (await client.query(
      `INSERT INTO assessment_records(student_id,course_id,question_set_id,assessment_type,subject,title,score,total,objective_score,subjective_score,answers,wrong_questions,grading_status,graded_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,CASE WHEN $13='graded' THEN now() ELSE NULL END) RETURNING *`,
      [studentId, body.courseId || null, body.questionSetId || null, body.assessmentType, body.subject, body.title,
        grading ? grading.score : null, grading ? grading.total : null, grading ? grading.objectiveScore : null, null, json(body.answers), json(grading?.wrongQuestions || []), reviewStatus]
    )).rows[0];
    await archiveWrongQuestions(client, { studentId, assessmentRecordId:result.id, subject:body.subject, wrongQuestions:grading?.wrongQuestions || [] });
    await client.query('INSERT INTO learning_events(student_id,event_type,subject,payload) VALUES($1,$2,$3,$4)', [studentId, 'assessment_submitted', body.subject, json({ assessmentRecordId:result.id, assessmentType:body.assessmentType, questionSetId:body.questionSetId || null, gradingStatus:reviewStatus })]);
    await client.query('INSERT INTO audit_logs(actor_account_id,action,entity_type,entity_id,metadata) VALUES($1,$2,$3,$4,$5)', [request.account.accountId, '提交自测', 'assessment_record', result.id, json({ assessmentType:body.assessmentType, subject:body.subject, gradingStatus:reviewStatus })]);
    await client.query('COMMIT');
    reply.code(202);
    return { ...result, gradingStatus:reviewStatus, reviewStatus, message:grading ? '已按服务端题目快照评分' : '暂无正式题库或 AI executor，已保存为 pending_review，成绩待教师确认' };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

const postSchema = z.object({ title:z.string().trim().min(1).max(120), topic:z.string().trim().min(1).max(40), body:z.string().trim().min(1).max(5000) });
app.post('/api/students/:id/wrong-questions', { preHandler: requireStudent }, withIdempotency(async request => {
  const studentId = uuidSchema.parse(request.params.id);
  if (!canAccessStudent(request, studentId)) throw Object.assign(new Error('无权写入该学员错题'), { statusCode:403 });
  const body = manualWrongQuestionSchema.parse(request.body);
  const sourceHash = crypto.createHash('sha256').update(JSON.stringify({ studentId, subject:body.subject, questionText:body.questionText, sourceLabel:body.sourceLabel || '' })).digest('hex');
  const result = (await pool.query(
    `INSERT INTO wrong_question_archives(student_id,source_hash,subject,question_text,analysis,knowledge_point)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(student_id,source_hash) DO UPDATE SET updated_at=now()
     RETURNING id,student_id,subject,question_text,analysis,knowledge_point,status,review_count,created_at,updated_at`,
    [studentId,sourceHash,body.subject,body.questionText,body.analysis || '',body.sourceLabel || '手动归档']
  )).rows[0];
  await audit(request.account.accountId, '手动归档错题', 'wrong_question', result.id, { studentId, subject:body.subject });
  return result;
}));
app.get('/api/students/:id/wrong-questions', { preHandler: app.auth }, async request => {
  const studentId = uuidSchema.parse(request.params.id);
  if (!canAccessStudent(request, studentId)) throw Object.assign(new Error('无权访问该学员错题'), { statusCode:403 });
  const status = request.query?.status ? z.enum(['active','reviewed','mastered','archived']).parse(request.query.status) : null;
  const subject = request.query?.subject ? z.string().trim().max(60).parse(request.query.subject) : null;
  const result = await pool.query(
    `SELECT id,student_id,assessment_record_id,submission_id,subject,question_number,question_text,student_answer,correct_answer,analysis,knowledge_point,status,review_count,last_reviewed_at,created_at,updated_at
     FROM wrong_question_archives WHERE student_id=$1 AND ($2::text IS NULL OR status=$2) AND ($3::text IS NULL OR subject=$3) ORDER BY created_at DESC LIMIT 500`,
    [studentId,status,subject]
  );
  return result.rows;
});
app.patch('/api/students/:id/wrong-questions/:wrongId', { preHandler: app.auth }, async request => {
  const studentId = uuidSchema.parse(request.params.id);
  const wrongId = uuidSchema.parse(request.params.wrongId);
  if (!canAccessStudent(request, studentId) && !['admin','teacher'].includes(request.account.role)) throw Object.assign(new Error('无权修改该错题'), { statusCode:403 });
  const body = z.object({ status:z.enum(['active','reviewed','mastered','archived']) }).strict().parse(request.body);
  const result = (await pool.query('UPDATE wrong_question_archives SET status=$1,updated_at=now() WHERE id=$2 AND student_id=$3 RETURNING *', [body.status,wrongId,studentId])).rows[0];
  if (!result) throw Object.assign(new Error('错题不存在'), { statusCode:404 });
  await audit(request.account.accountId, '更新错题状态', 'wrong_question', wrongId, { studentId, status:body.status });
  return result;
});
app.post('/api/students/:id/wrong-questions/:wrongId/review', { preHandler: requireStudent }, withIdempotency(async request => {
  const studentId = uuidSchema.parse(request.params.id);
  const wrongId = uuidSchema.parse(request.params.wrongId);
  if (!canAccessStudent(request, studentId)) throw Object.assign(new Error('无权复习该错题'), { statusCode:403 });
  const result = (await pool.query("UPDATE wrong_question_archives SET review_count=review_count+1,last_reviewed_at=now(),status=CASE WHEN status='active' THEN 'reviewed' ELSE status END,updated_at=now() WHERE id=$1 AND student_id=$2 RETURNING *", [wrongId,studentId])).rows[0];
  if (!result) throw Object.assign(new Error('错题不存在'), { statusCode:404 });
  await audit(request.account.accountId, '复习错题', 'wrong_question', wrongId, { studentId });
  return result;
}));

app.get('/api/posts', { preHandler: app.auth }, async request => {
  const includeOwnPending = request.account.role === 'student';
  const result = await pool.query(`SELECT p.id,p.title,p.topic,p.body,p.state,p.review_note,p.created_at,a.name author FROM community_posts p JOIN accounts a ON a.id=p.author_account_id WHERE p.state='已公开' OR ($1 AND p.author_account_id=$2) ORDER BY p.created_at DESC`, [includeOwnPending, request.account.accountId]);
  return result.rows;
});
app.post('/api/posts', { preHandler: app.auth }, withIdempotency(async (request, reply) => {
  const body = postSchema.parse(request.body);
  const result = (await pool.query("INSERT INTO community_posts(author_account_id,title,topic,body) VALUES($1,$2,$3,$4) RETURNING *", [request.account.accountId, body.title, body.topic, body.body])).rows[0];
  await audit(request.account.accountId, '发布社区帖子', 'community_post', result.id);
  return result;
}));
app.post('/api/admin/posts/:id/review', { preHandler: requireRoles(['admin','teacher','assistant']) }, withIdempotency(async (request, reply) => {
  const postId = uuidSchema.parse(request.params.id);
  const body = z.object({ state:z.enum(['已公开','已拒绝']), reviewNote:z.string().max(1000).optional() }).parse(request.body);
  const result = (await pool.query('UPDATE community_posts SET state=$1,review_note=$2,reviewed_by=$3,reviewed_at=now(),updated_at=now() WHERE id=$4 RETURNING *', [body.state, body.reviewNote || null, request.account.accountId, postId])).rows[0];
  if (!result) throw Object.assign(new Error('帖子不存在'), { statusCode:404 });
  await audit(request.account.accountId, '审核社区帖子', 'community_post', postId, { state:body.state });
  return result;
}));

// ===== 学习工具内容库（应用管理）：政治题书 / 英语单词书 / 英语选择题书 / 数学公式定理书 =====
const APPLICATION_TOOLS = ['politics','english_words','english_choice','math_formula','math_theorem'];
const applicationToolSchema = z.enum(APPLICATION_TOOLS);
const applicationBookSchema = z.object({
  tool: applicationToolSchema,
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).default(''),
  state: z.enum(['草稿','已发布','已归档']).default('已发布')
}).strict();
const applicationImportSchema = z.object({
  book: applicationBookSchema,
  items: z.array(z.record(z.unknown())).max(20000).default([])
}).strict().superRefine((value, ctx) => {
  if (Buffer.byteLength(JSON.stringify(value.items), 'utf8') > 8 * 1024 * 1024) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: '单次导入内容不能超过 8 MB' });
  }
});
const applicationBookDto = row => ({
  id: row.id, tool: row.tool, name: row.name, description: row.description || '',
  state: row.state, itemCount: Number(row.item_count ?? 0), createdAt: row.created_at, updatedAt: row.updated_at
});
const applicationItemDto = row => ({ id: row.id, bookId: row.book_id, itemIndex: row.item_index, payload: row.payload || {}, createdAt: row.created_at, updatedAt: row.updated_at });

app.get('/api/admin/application-books', { preHandler: requireRoles(['admin','teacher']) }, async request => {
  const query = z.object({ tool: applicationToolSchema.optional() }).parse(request.query ?? {});
  const params = query.tool ? [query.tool] : [];
  const rows = (await pool.query(
    `SELECT b.*,count(i.id)::int AS item_count FROM application_books b
     LEFT JOIN application_items i ON i.book_id=b.id
     ${query.tool ? 'WHERE b.tool=$1' : ''} GROUP BY b.id ORDER BY b.tool,b.created_at DESC`, params
  )).rows;
  return rows.map(applicationBookDto);
});
app.get('/api/admin/application-books/:id/items', { preHandler: requireRoles(['admin','teacher']) }, async request => {
  const bookId = uuidSchema.parse(request.params.id);
  const book = (await pool.query('SELECT id FROM application_books WHERE id=$1', [bookId])).rows[0];
  if (!book) throw Object.assign(new Error('书籍不存在'), { statusCode: 404 });
  return (await pool.query('SELECT * FROM application_items WHERE book_id=$1 ORDER BY item_index', [bookId])).rows.map(applicationItemDto);
});
app.post('/api/admin/application-books/import', { preHandler: requireRoles(['admin','teacher']) }, withIdempotency(async request => {
  const body = applicationImportSchema.parse(request.body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const book = (await client.query(
      `INSERT INTO application_books(tool,name,description,state,created_by) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(tool,name) DO UPDATE SET description=EXCLUDED.description,state=EXCLUDED.state,updated_at=now() RETURNING *`,
      [body.book.tool, body.book.name, body.book.description, body.book.state, request.account.accountId]
    )).rows[0];
    await client.query('DELETE FROM application_items WHERE book_id=$1', [book.id]);
    for (const [index, payload] of body.items.entries()) {
      await client.query(
        'INSERT INTO application_items(book_id,item_index,payload) VALUES($1,$2,$3)',
        [book.id, index, json(payload)]
      );
    }
    await client.query('COMMIT');
    await audit(request.account.accountId, '导入学习工具内容', 'application_book', book.id, { tool: book.tool, itemCount: body.items.length, state: book.state });
    return { book: applicationBookDto({ ...book, item_count: body.items.length }), importedItemCount: body.items.length };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}));
app.patch('/api/admin/application-books/:id', { preHandler: requireRoles(['admin','teacher']) }, withIdempotency(async request => {
  const id = uuidSchema.parse(request.params.id);
  const patch = applicationBookSchema.partial().strict().parse(request.body);
  if (!Object.keys(patch).length) throw Object.assign(new Error('至少提供一个可更新字段'), { statusCode: 422 });
  const columns = { tool: 'tool', name: 'name', description: 'description', state: 'state' };
  const entries = Object.entries(patch);
  const values = entries.map(([, value]) => value);
  const result = await pool.query(
    `UPDATE application_books SET ${entries.map(([key], i) => `${columns[key]}=$${i + 1}`).join(',')},updated_at=now() WHERE id=$${values.length + 1} RETURNING *`,
    [...values, id]
  );
  if (!result.rowCount) throw Object.assign(new Error('书籍不存在'), { statusCode: 404 });
  await audit(request.account.accountId, '修改学习工具书籍', 'application_book', id, { fields: entries.map(([key]) => key) });
  return applicationBookDto(result.rows[0]);
}));
app.delete('/api/admin/application-books/:id', { preHandler: requireRoles(['admin','teacher']) }, async request => {
  const id = uuidSchema.parse(request.params.id);
  const row = (await pool.query('DELETE FROM application_books WHERE id=$1 RETURNING id', [id])).rows[0];
  if (!row) throw Object.assign(new Error('书籍不存在'), { statusCode: 404 });
  await audit(request.account.accountId, '删除学习工具书籍', 'application_book', id);
  return { id };
});
// 学生端只读已发布书籍。
app.get('/api/application-books', { preHandler: requireStudent }, async request => {
  const query = z.object({ tool: applicationToolSchema.optional() }).parse(request.query ?? {});
  const params = [query.tool || null];
  const rows = (await pool.query(
    `SELECT b.*,count(i.id)::int AS item_count FROM application_books b
     LEFT JOIN application_items i ON i.book_id=b.id
     WHERE b.state='已发布' AND ($1::text IS NULL OR b.tool=$1) GROUP BY b.id ORDER BY b.tool,b.created_at DESC`, params
  )).rows;
  return rows.map(applicationBookDto);
});
app.get('/api/application-books/:id/items', { preHandler: requireStudent }, async request => {
  const bookId = uuidSchema.parse(request.params.id);
  const book = (await pool.query("SELECT id FROM application_books WHERE id=$1 AND state='已发布'", [bookId])).rows[0];
  if (!book) throw Object.assign(new Error('书籍不存在或尚未发布'), { statusCode: 404 });
  return (await pool.query('SELECT * FROM application_items WHERE book_id=$1 ORDER BY item_index', [bookId])).rows.map(applicationItemDto);
});

// ===== 课程附件上传与下载（视频 / 配套资料） =====
const courseAssetDto = async row => {
  const state = row.state || 'ready';
  let url = null;
  let storageAvailable = state === 'ready';
  if (storageAvailable) {
    try {
      url = (await storage.getSignedUrl({ key: row.object_key, expiresInSeconds: 300 })).url;
    } catch {
      storageAvailable = false;
    }
  }
  return {
    id: row.id, courseId: row.course_id, kind: row.kind || 'material', fileName: row.file_name,
    mimeType: row.mime_type, sizeBytes: Number(row.size_bytes || 0), state,
    sha256: row.sha256 || null, failureCode: row.failure_code || null,
    createdAt: row.created_at, archivedAt: row.archived_at || row.deleted_at || null,
    url, storageAvailable
  };
};
const MAX_ASSET_BYTES = 200 * 1024 * 1024;
const allowedAssetMime = mime => {
  const value = String(mime || '').toLowerCase().split(';', 1)[0].trim();
  return value.startsWith('video/') || new Set([
    'application/pdf', 'application/zip', 'application/x-zip-compressed',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-exword', 'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain', 'text/markdown', 'image/jpeg', 'image/png', 'image/webp'
  ]).has(value);
};
const assetKindSchema = z.enum(['video','material']);

app.post('/api/admin/courses/:id/assets', { preHandler: requireRoles(['admin','teacher']) }, async request => {
  const courseId = uuidSchema.parse(request.params.id);
  const course = (await pool.query('SELECT id,name,subject,scope FROM courses WHERE id=$1', [courseId])).rows[0];
  if (!course) throw Object.assign(new Error('课程不存在'), { statusCode: 404 });
  const file = await request.file();
  if (!file) throw Object.assign(new Error('请选择要上传的文件'), { statusCode: 422 });
  const mimeType = String(file.mimetype || '').toLowerCase().split(';', 1)[0].trim();
  if (!allowedAssetMime(mimeType)) throw Object.assign(new Error('不支持的文件类型'), { statusCode: 422, code:'UNSUPPORTED_FILE_TYPE' });
  if (file.file.truncated) throw Object.assign(new Error('文件超过 200MB 上限'), { statusCode: 422, code:'FILE_TOO_LARGE' });
  const rawKind = file.fields?.kind?.value;
  const kind = assetKindSchema.safeParse(rawKind).success ? rawKind : 'material';
  const fileName = String(file.filename || '未命名文件').replace(/[\/\0]/g, '_').slice(0, 200);
  const objectKey = generateObjectKey(`courses/${courseId}`, fileName);
  const pending = (await pool.query(
    `INSERT INTO course_assets(course_id,kind,file_name,object_key,mime_type,state,uploaded_by)
     VALUES($1,$2,$3,$4,$5,'pending',$6) RETURNING *`,
    [courseId, kind, fileName, objectKey, mimeType, request.account.accountId]
  )).rows[0];
  try {
    const stored = await storage.putObject({ key: objectKey, body: file.file, contentType: mimeType, maxBytes:MAX_ASSET_BYTES });
    const row = (await pool.query(
      `UPDATE course_assets SET state='ready',size_bytes=$1,sha256=$2,failure_code=NULL,updated_at=now() WHERE id=$3 RETURNING *`,
      [stored.size, stored.sha256 || null, pending.id]
    )).rows[0];
    await notifyStudentsAboutResource(pool, { courseId, courseName: course.name, subject: course.subject || '', scope:course.scope });
    await audit(request.account.accountId, '上传课程附件', 'course_asset', row.id, { courseId, kind, sizeBytes: stored.size, sha256:stored.sha256 || null });
    return courseAssetDto(row);
  } catch (error) {
    await pool.query(`UPDATE course_assets SET state='blocked',failure_code=$1,updated_at=now() WHERE id=$2`, [error.code || 'STORAGE_WRITE_FAILED', pending.id]).catch(() => {});
    throw Object.assign(new Error('附件存储失败，已记录为失败状态'), { statusCode: error?.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 503, code:'STORAGE_WRITE_FAILED' });
  }
});
app.get('/api/courses/:id/assets', { preHandler: app.auth }, async request => {
  const courseId = uuidSchema.parse(request.params.id);
  const staff = ['admin','teacher','assistant','operator'].includes(request.account.role);
  if (!staff) await assertStudentCourseAccess(pool, request.account.studentId, courseId);
  else {
    const course = (await pool.query('SELECT id,state FROM courses WHERE id=$1', [courseId])).rows[0];
    if (!course) throw Object.assign(new Error('课程不存在'), { statusCode: 404 });
  }
  const rows = (await pool.query("SELECT * FROM course_assets WHERE course_id=$1 AND state <> 'deleted' ORDER BY kind,created_at", [courseId])).rows;
  const assets = [];
  for (const row of rows) assets.push(await courseAssetDto(row));
  return assets;
});
app.delete('/api/admin/course-assets/:id', { preHandler: requireRoles(['admin','teacher']) }, withIdempotency(async request => {
  const id = uuidSchema.parse(request.params.id);
  const row = (await pool.query("UPDATE course_assets SET state='deleted',archived_at=COALESCE(archived_at,now()),deleted_at=COALESCE(deleted_at,now()),updated_at=now() WHERE id=$1 AND state <> 'deleted' RETURNING *", [id])).rows[0];
  if (!row) throw Object.assign(new Error('附件不存在或已归档'), { statusCode: 404 });
  let deleteFailed = false;
  try { await storage.deleteObject({ key: row.object_key }); }
  catch { deleteFailed = true; await pool.query("UPDATE course_assets SET state='blocked',failure_code='OBJECT_DELETE_FAILED',updated_at=now() WHERE id=$1", [id]); }
  await audit(request.account.accountId, '归档课程附件', 'course_asset', id, { courseId: row.course_id, deleteFailed });
  return { id, state: deleteFailed ? 'blocked' : 'deleted', deleteFailed };
}));
// 签名 URL 文件下载：URL 由服务端 HMAC 签发，过期即失效。
app.get('/api/storage/local/:token/*', async (request, reply) => {
  const token = z.string().trim().min(10).max(500).parse(request.params.token);
  const key = String(request.params['*'] || '');
  if (STORAGE_DRIVER_NAME !== 'local') throw Object.assign(new Error('存储驱动不可用'), { statusCode: 404 });
  if (!storage.verifySignedUrl({ token, key })) throw Object.assign(new Error('下载链接无效或已过期'), { statusCode: 403 });
  const stat = await storage.statObject({ key });
  const asset = (await pool.query("SELECT mime_type,file_name,state FROM course_assets WHERE object_key=$1 ORDER BY created_at DESC LIMIT 1", [stat.key])).rows[0];
  if (!asset || asset.state !== 'ready') throw Object.assign(new Error('附件不存在或已归档'), { statusCode:404 });
  reply.header('Content-Type', asset.mime_type || 'application/octet-stream');
  reply.header('Content-Length', String(stat.size));
  if (asset.file_name) reply.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(asset.file_name)}`);
  return reply.send(await storage.readObjectStream({ key: stat.key }));
});

// ===== 学员专属资料采集链接 =====
const intakeLinkPayload = token => ({ url: `${ORIGIN}/intake/${token}`, token });
app.post('/api/admin/students/:id/intake-link', { preHandler: requireRoles(['admin','teacher']) }, async request => {
  const studentId = uuidSchema.parse(request.params.id);
  const student = (await pool.query('SELECT id FROM students WHERE id=$1', [studentId])).rows[0];
  if (!student) throw Object.assign(new Error('学员不存在'), { statusCode: 404 });
  const token = makeToken();
  await pool.query('UPDATE students SET intake_token_hash=$1,updated_at=now() WHERE id=$2', [hashToken(token), studentId]);
  await audit(request.account.accountId, '生成资料采集链接', 'student', studentId);
  return intakeLinkPayload(token);
});
const intakeStudentByToken = async token => {
  const row = (await pool.query('SELECT * FROM students WHERE intake_token_hash=$1', [hashToken(String(token || '').trim())])).rows[0];
  if (!row) throw Object.assign(new Error('采集链接无效或已失效'), { statusCode: 404 });
  return row;
};
app.get('/api/public/intake/:token', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async request => {
  const student = await intakeStudentByToken(request.params.token);
  const subjects = (await pool.query('SELECT subject,enrolled,target_score FROM student_subjects WHERE student_id=$1 ORDER BY subject', [student.id])).rows;
  return {
    student: {
      name: student.name, year: student.year, school: student.school || '',
      targetScore: student.target_score || '', stage: student.stage,
      phone: student.phone || '', email: student.email || '', wechatId: student.wechat_id || '',
      shippingRecipient: student.shipping_recipient || '', shippingPhone: student.shipping_phone || '',
      shippingInfo: student.shipping_info || '', evaluation: student.evaluation || ''
    },
    subjects: subjects.map(row => ({ name: row.subject, enrolled: row.enrolled, targetScore: row.target_score || '' })),
    submittedAt: student.intake_submitted_at || null
  };
});
const intakeUpdateSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  year: z.string().trim().min(1).max(30).optional(),
  school: z.string().trim().max(160).nullable().optional(),
  targetScore: z.string().trim().max(60).nullable().optional(),
  email: z.string().trim().email('邮箱格式不正确').max(254).nullable().optional(),
  wechatId: z.string().trim().max(120).nullable().optional(),
  shippingRecipient: z.string().trim().max(120).nullable().optional(),
  shippingPhone: z.string().trim().max(40).nullable().optional(),
  shippingInfo: z.string().trim().max(2000).nullable().optional(),
  stage: z.string().trim().min(1).max(80).optional(),
  evaluation: z.string().trim().max(5000).nullable().optional(),
  subjects: z.array(z.object({ name: z.string().trim().min(1).max(60), targetScore: z.string().trim().max(30).default('') }).strict()).max(20).optional()
}).strict().refine(value => Object.keys(value).length > 0, '至少填写一项信息');
app.post('/api/public/intake/:token', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async request => {
  const student = await intakeStudentByToken(request.params.token);
  const body = intakeUpdateSchema.parse(request.body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const columns = { name: 'name', year: 'year', school: 'school', targetScore: 'target_score', email: 'email', wechatId: 'wechat_id', shippingRecipient: 'shipping_recipient', shippingPhone: 'shipping_phone', shippingInfo: 'shipping_info', stage: 'stage', evaluation: 'evaluation' };
    const entries = Object.entries(body).filter(([key]) => key !== 'subjects');
    if (entries.length) {
      const values = entries.map(([, value]) => value);
      await client.query(
        `UPDATE students SET ${entries.map(([key], i) => `${columns[key]}=$${i + 1}`).join(',')},intake_submitted_at=now(),updated_at=now() WHERE id=$${values.length + 1}`,
        [...values, student.id]
      );
    } else {
      await client.query('UPDATE students SET intake_submitted_at=now(),updated_at=now() WHERE id=$1', [student.id]);
    }
    if (body.subjects) {
      const existing = (await client.query('SELECT subject,enrolled FROM student_subjects WHERE student_id=$1 FOR UPDATE', [student.id])).rows;
      const enrolled = new Map(existing.map(row => [row.subject, row.enrolled]));
      await client.query('DELETE FROM student_subjects WHERE student_id=$1', [student.id]);
      for (const item of body.subjects) {
        // 采集页只能提交报考意向；是否开通仍以老师确认为准。
        await client.query('INSERT INTO student_subjects(student_id,subject,enrolled,target_score) VALUES($1,$2,$3,$4)', [student.id, item.name, enrolled.get(item.name) ?? false, item.targetScore || null]);
      }
    }
    await client.query('COMMIT');
    return { ok: true, submittedAt: new Date().toISOString() };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

// ===== 学习总结（模板化统计生成，后续接 AI 复用同一表） =====
const summaryTypeSchema = z.enum(['daily','weekly','monthly']);
const SUMMARY_TYPE_LABELS = { daily: '每日', weekly: '每周', monthly: '每月' };
const SUMMARY_PERIOD_LABELS = { daily: '今日', weekly: '本周', monthly: '本月' };
const summaryRange = (type, dateText) => {
  const base = dateText ? new Date(`${dateText}T00:00:00+08:00`) : new Date();
  if (Number.isNaN(base.getTime())) throw Object.assign(new Error('日期无效'), { statusCode: 422 });
  const china = new Date(base.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const start = new Date(china); start.setHours(0, 0, 0, 0);
  if (type === 'weekly') start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  if (type === 'monthly') start.setDate(1);
  const end = new Date(start);
  if (type === 'daily') end.setDate(end.getDate() + 1);
  if (type === 'weekly') end.setDate(end.getDate() + 7);
  if (type === 'monthly') end.setMonth(end.getMonth() + 1);
  const offset = china.getTime() - base.getTime();
  return {
    scheduleDate: chinaDateKey(start),
    startUtc: new Date(start.getTime() - offset),
    endUtc: new Date(end.getTime() - offset)
  };
};
const summaryDto = row => ({
  id: row.id, studentId: row.student_id, type: row.type, typeLabel: SUMMARY_TYPE_LABELS[row.type] || row.type,
  scheduleDate: row.schedule_date, status: row.status, content: row.content || {},
  inputRange: row.input_range || {}, promptVersion: row.prompt_version,
  generatedAt: row.generated_at, deliveredAt: row.delivered_at, createdAt: row.created_at
});
const generateStudentSummary = async (studentId, type, dateText) => {
  const range = summaryRange(type, dateText);
  const [completed, assessments, wrongs] = await Promise.all([
    pool.query(
      `SELECT count(*)::int AS count FROM task_completions tc JOIN student_plans p ON p.id=tc.student_plan_id
       WHERE p.student_id=$1 AND tc.completed_at>=$2 AND tc.completed_at<$3`,
      [studentId, range.startUtc, range.endUtc]
    ),
    pool.query(
      `SELECT subject,title,score,total FROM assessment_records
       WHERE student_id=$1 AND submitted_at>=$2 AND submitted_at<$3 ORDER BY submitted_at`,
      [studentId, range.startUtc, range.endUtc]
    ),
    pool.query(
      'SELECT count(*)::int AS count FROM wrong_question_archives WHERE student_id=$1 AND created_at>=$2 AND created_at<$3',
      [studentId, range.startUtc, range.endUtc]
    )
  ]);
  const completedCount = completed.rows[0].count;
  const wrongCount = wrongs.rows[0].count;
  const lines = [];
  lines.push(`${SUMMARY_PERIOD_LABELS[type]}（${range.scheduleDate} 起）共完成 ${completedCount} 项学习任务。`);
  if (assessments.rows.length) {
    for (const item of assessments.rows) {
      lines.push(`自测「${item.title}」（${item.subject}）：${item.score ?? '未评分'}${item.total ? ` / ${item.total}` : ''} 分。`);
    }
  } else {
    lines.push('本期暂未提交自测成绩。');
  }
  lines.push(wrongCount ? `新增错题 ${wrongCount} 道，记得及时复习巩固。` : '本期没有新增错题，继续保持。');
  const content = {
    text: lines.join('\n'), lines,
    stats: { completedTasks: completedCount, assessments: assessments.rows, newWrongQuestions: wrongCount },
    taskFocus: `${SUMMARY_PERIOD_LABELS[type]}完成 ${completedCount} 项学习任务${assessments.rows.length ? `，参加 ${assessments.rows.length} 次自测` : ''}。`,
    weakPoints: wrongCount ? `本期新增错题 ${wrongCount} 道，建议优先复习错题涉及的知识点。` : '本期没有新增错题，继续保持当前的复习节奏。',
    examDirection: assessments.rows.length
      ? `自测成绩：${assessments.rows.map(item => `${item.subject} ${item.score ?? '未评分'}${item.total ? `/${item.total}` : ''} 分`).join('；')}。`
      : '本期暂未提交自测成绩，建议按计划完成日/周/月测检验复习效果。',
    progressForecast: completedCount > 0 ? '任务完成稳定，按当前节奏继续推进即可。' : '本期任务完成较少，建议先保证每日基础任务按时完成。'
  };
  return { range, content };
};
app.post('/api/students/:id/summaries/run', { preHandler: requireRoles(['admin','teacher']) }, withIdempotency(async request => {
  const studentId = uuidSchema.parse(request.params.id);
  const body = z.object({ type: summaryTypeSchema, date: dateOnlySchema.optional() }).strict().parse(request.body);
  const student = (await pool.query('SELECT id FROM students WHERE id=$1', [studentId])).rows[0];
  if (!student) throw Object.assign(new Error('学员不存在'), { statusCode: 404 });
  const { range, content } = await generateStudentSummary(studentId, body.type, body.date);
  const row = (await pool.query(
    `INSERT INTO student_summaries(student_id,type,schedule_date,status,content,input_range,generated_at)
     VALUES($1,$2,$3,'generated',$4,$5,now())
     ON CONFLICT(student_id,type,schedule_date) DO UPDATE SET status='generated',content=EXCLUDED.content,input_range=EXCLUDED.input_range,generated_at=now(),error_message=NULL
     RETURNING *`,
    [studentId, body.type, range.scheduleDate, json(content), json({ start: range.startUtc, end: range.endUtc })]
  )).rows[0];
  await audit(request.account.accountId, '生成学习总结', 'student_summary', row.id, { studentId, type: body.type, scheduleDate: range.scheduleDate });
  return summaryDto(row);
}));
app.get('/api/students/:id/summaries', { preHandler: app.auth }, async request => {
  const studentId = uuidSchema.parse(request.params.id);
  if (!canAccessStudent(request, studentId)) throw Object.assign(new Error('无权读取该学员学习总结'), { statusCode: 403 });
  const query = z.object({ type: summaryTypeSchema.optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).parse(request.query ?? {});
  // 首次查看时自动生成本期总结，保证学生端“学习回顾”不为空。
  const existing = (await pool.query('SELECT count(*)::int AS count FROM student_summaries WHERE student_id=$1', [studentId])).rows[0].count;
  if (!existing) {
    for (const type of ['daily','weekly','monthly']) {
      const { range, content } = await generateStudentSummary(studentId, type);
      await pool.query(
        `INSERT INTO student_summaries(student_id,type,schedule_date,status,content,input_range,generated_at)
         VALUES($1,$2,$3,'generated',$4,$5,now()) ON CONFLICT(student_id,type,schedule_date) DO NOTHING`,
        [studentId, type, range.scheduleDate, json(content), json({ start: range.startUtc, end: range.endUtc })]
      );
    }
  }
  const params = [studentId];
  let where = 'WHERE student_id=$1';
  if (query.type) { params.push(query.type); where += ` AND type=$${params.length}`; }
  params.push(query.limit || 30);
  const rows = (await pool.query(`SELECT * FROM student_summaries ${where} ORDER BY schedule_date DESC LIMIT $${params.length}`, params)).rows;
  return rows.map(summaryDto);
});

// ===== 学习工具完成进度（刷题 / 背词 / 背公式 / 代学） =====
const learningProgressSchema = z.object({
  resourceType: z.enum(['politics','english_words','english_choice','math_formulas','math_theorem','companion_study']),
  resourceId: z.string().trim().min(1).max(120),
  itemId: z.string().trim().min(1).max(120),
  courseId: uuidSchema.nullable().optional(),
  totalCount: z.number().int().min(0).max(1000000).default(0)
}).strict();
const learningProgressDto = row => ({
  resourceType: row.resource_type, resourceId: row.resource_id, itemId: row.item_id,
  courseId: row.course_id || null, totalCount: row.total_count, completedOn: row.completed_on, createdAt: row.created_at
});
app.post('/api/students/:id/learning-progress', { preHandler: requireStudent }, withIdempotency(async request => {
  const studentId = uuidSchema.parse(request.params.id);
  if (!canAccessStudent(request, studentId)) throw Object.assign(new Error('无权写入该学员学习进度'), { statusCode: 403 });
  const body = learningProgressSchema.parse(request.body);
  if (body.courseId) await assertStudentCourseAccess(pool, studentId, body.courseId);
  if (body.resourceType === 'companion_study') {
    const question = await getCompanionStudentQuestion(studentId, body.itemId);
    if (String(question.book_id) !== String(body.resourceId)) throw Object.assign(new Error('学习进度题目不属于指定书籍'), { statusCode:422 });
  } else {
    const book = (await pool.query("SELECT id FROM application_books WHERE id=$1 AND state='已发布'", [body.resourceId])).rows[0];
    const item = book ? (await pool.query('SELECT id FROM application_items WHERE id=$1 AND book_id=$2', [body.itemId, body.resourceId])).rows[0] : null;
    if (!book || !item) throw Object.assign(new Error('学习进度的书籍或题目不存在、未发布或不属于该书'), { statusCode:422 });
  }
  const row = (await pool.query(
    `INSERT INTO student_learning_progress(student_id,course_id,resource_type,resource_id,item_id,total_count)
     VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(student_id,resource_type,resource_id,item_id) DO UPDATE SET course_id=COALESCE(EXCLUDED.course_id,student_learning_progress.course_id),total_count=GREATEST(student_learning_progress.total_count,EXCLUDED.total_count) RETURNING *`,
    [studentId, body.courseId || null, body.resourceType, body.resourceId, body.itemId, body.totalCount]
  )).rows[0];
  await pool.query('INSERT INTO learning_events(student_id,event_type,subject,tool_id,event_key,payload) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(student_id,event_key) DO NOTHING', [studentId,'learning_item_completed',null,body.resourceType,`learning_item_completed:${body.resourceType}:${body.resourceId}:${body.itemId}`,json({ resourceType:body.resourceType, resourceId:body.resourceId, itemId:body.itemId, courseId:body.courseId || null, totalCount:body.totalCount })]);
  return { recorded: Boolean(row), progress: row ? learningProgressDto(row) : null };
}));
app.get('/api/students/:id/learning-events', { preHandler: app.auth }, async request => {
  const studentId = uuidSchema.parse(request.params.id);
  if (!canAccessStudent(request, studentId)) throw Object.assign(new Error('无权读取该学员学习事件'), { statusCode:403 });
  const query = z.object({ eventType:z.string().trim().max(80).optional(), limit:z.coerce.number().int().min(1).max(1000).optional() }).parse(request.query ?? {});
  const params = [studentId]; let where = 'WHERE student_id=$1';
  if (query.eventType) { params.push(query.eventType); where += ` AND event_type=$${params.length}`; }
  params.push(query.limit || 200);
  const rows = (await pool.query(`SELECT id,event_type,subject,tool_id,event_key,knowledge_tags,payload,occurred_at,created_at FROM learning_events ${where} ORDER BY occurred_at DESC LIMIT $${params.length}`, params)).rows;
  return rows.map(row => ({ id:row.id, eventType:row.event_type, subject:row.subject, toolId:row.tool_id, eventKey:row.event_key, knowledgeTags:row.knowledge_tags || [], payload:row.payload || {}, occurredAt:row.occurred_at, createdAt:row.created_at }));
});
app.get('/api/students/:id/learning-progress', { preHandler: app.auth }, async request => {
  const studentId = uuidSchema.parse(request.params.id);
  if (!canAccessStudent(request, studentId)) throw Object.assign(new Error('无权读取该学员学习进度'), { statusCode: 403 });
  const query = z.object({ resourceType: z.string().trim().max(60).optional(), resourceId: z.string().trim().max(120).optional() }).parse(request.query ?? {});
  const params = [studentId];
  let where = 'WHERE student_id=$1';
  if (query.resourceType) { params.push(query.resourceType); where += ` AND resource_type=$${params.length}`; }
  if (query.resourceId) { params.push(query.resourceId); where += ` AND resource_id=$${params.length}`; }
  const rows = (await pool.query(`SELECT * FROM student_learning_progress ${where} ORDER BY created_at DESC LIMIT 5000`, params)).rows;
  return rows.map(learningProgressDto);
});

const shutdown = async signal => {
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await pool.end();
    process.exit(0);
  } catch (error) {
    app.log.error(error, 'shutdown failed');
    process.exit(1);
  }
};
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

// 执行器是进程内异步执行：服务重启时把上次卡在 running 的 AI 任务标记失败，
// 避免任务永远停留在"执行中"（学生与教师端会永久等待）。
(async () => {
  try {
    const recovered = await pool.query("UPDATE ai_jobs SET status='failed', error_code='executor_restart', completed_at=now(), updated_at=now() WHERE status='running'");
    if (recovered.rowCount) app.log.warn({ recovered: recovered.rowCount }, 'stale running AI jobs marked failed on boot');
  } catch (error) { app.log.warn(error, 'ai job boot recovery skipped'); }
})();

app.listen({ port:Number(process.env.PORT || 4000), host:'0.0.0.0' }).catch(error => { app.log.error(error); process.exit(1); });
