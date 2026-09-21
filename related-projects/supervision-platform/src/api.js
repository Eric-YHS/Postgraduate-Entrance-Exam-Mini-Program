const VITE_ENV = (typeof import.meta !== 'undefined' && import.meta.env) ? import.meta.env : {};
const API_BASE = (VITE_ENV.VITE_API_BASE_URL || '').replace(/\/$/, '');

const createRequestKey = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'NETWORK_ERROR', details = null, requestId = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

const isWriteMethod = method => !['GET', 'HEAD', 'OPTIONS'].includes(String(method || 'GET').toUpperCase());

/**
 * The browser client is deliberately the only place that owns request policy:
 * cookies are always sent, writes are retry-safe, and 401s invalidate the UI
 * session instead of letting stale local state look authenticated.
 */
export const apiRequest = async (path, options = {}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15000);
  const { timeoutMs: _timeoutMs, signal, suppressAuthExpired, headers: suppliedHeaders = {}, ...requestOptions } = options;
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  const method = String(requestOptions.method || 'GET').toUpperCase();
  const bodyIsFormData = typeof FormData !== 'undefined' && requestOptions.body instanceof FormData;
  // 写请求即使不带参数也必须提交 JSON 对象：Content-Type 是 application/json
  // 而 body 为空时，Fastify 会直接以 400 拒绝该请求。
  if (!bodyIsFormData && isWriteMethod(method) && requestOptions.body == null) requestOptions.body = '{}';
  // 学生端(/student)与教师端(/teacher)同域部署，登录凭证按角色分 cookie 存放；
  // 告诉后端当前页面身份，后端才能从多份凭证里取出属于本端的那一份。
  const appContext = typeof window !== 'undefined' && window.location?.pathname?.startsWith('/student') ? 'student'
    : typeof window !== 'undefined' && (window.location?.pathname?.startsWith('/teacher') || window.location?.pathname?.startsWith('/admin')) ? 'teacher' : '';
  const headers = {
    Accept: 'application/json',
    ...(appContext ? { 'X-App-Context': appContext } : {}),
    ...(bodyIsFormData ? {} : { 'Content-Type': 'application/json' }),
    ...(isWriteMethod(method) ? {
      'X-Requested-With': 'XMLHttpRequest',
      'Idempotency-Key': suppliedHeaders['Idempotency-Key'] || suppliedHeaders['idempotency-key'] || createRequestKey(),
    } : {}),
    ...suppliedHeaders,
  };
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...requestOptions,
      credentials: 'include',
      method,
      signal: signal || controller.signal,
      headers,
      body: bodyIsFormData || typeof requestOptions.body === 'string' || requestOptions.body == null
        ? requestOptions.body
        : JSON.stringify(requestOptions.body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const apiError = new ApiError(payload.error || `请求失败（${response.status}）`, {
        status: response.status,
        code: payload.code || 'HTTP_ERROR',
        details: payload.details || null,
        requestId: payload.requestId || response.headers.get('x-request-id') || '',
      });
      if (typeof window !== 'undefined') {
        if (response.status === 401 && !suppressAuthExpired) {
          window.dispatchEvent(new CustomEvent('shangan:auth-expired', { detail: apiError }));
        } else if (response.status >= 500) {
          window.dispatchEvent(new CustomEvent('shangan:api-error', { detail: apiError }));
        }
      }
      throw apiError;
    }
    return payload;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(error.name === 'AbortError' ? '请求超时，请稍后重试' : '网络连接失败，请检查网络后重试', {
      code: error.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR',
    });
  } finally {
    clearTimeout(timeout);
  }
};

export const isApiConfigured = () => Boolean(VITE_ENV.VITE_API_BASE_URL || VITE_ENV.PROD);

export const resolveApiUrl = value => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw, API_BASE || (typeof window !== 'undefined' ? window.location.origin : undefined)).href;
  } catch {
    return raw;
  }
};

// Keep role-sensitive payload construction in one place. The ordinary teacher
// workflow edits the student archive directly; it must never fall through to
// the admin-only account PATCH endpoint.
export const buildStudentProfilePatch = (draft = {}, role = 'teacher') => {
  const base = {
    name: String(draft.name || '').trim(),
    year: String(draft.year || '').trim() || undefined,
    email: String(draft.email || '').trim() || null,
    shippingInfo: String(draft.shippingInfo || '').trim() || null,
    school: String(draft.school || '').trim() || null,
    targetScore: String(draft.targetScore || '').trim() || null,
  };
  if (role === 'student') return base;
  return {
    ...base,
    status: draft.status,
    wechatId: String(draft.wechatId || '').trim() || null,
    shippingRecipient: String(draft.shippingRecipient || '').trim() || null,
    shippingPhone: String(draft.shippingPhone || '').trim() || null,
    stage: String(draft.stage || '').trim() || undefined,
    evaluation: String(draft.evaluation || '').trim() || null,
    paidUntil: draft.paidUntil ?? undefined,
  };
};

export const getSessionAuthVersion = (account, fallback = null) => {
  const nested = account?.account && typeof account.account === 'object' ? account.account : {};
  const candidate = account?.sessionVersion ?? account?.session_version ?? account?.authVersion ?? account?.auth_version
    ?? nested.sessionVersion ?? nested.session_version ?? nested.authVersion ?? nested.auth_version;
  if (candidate !== undefined && candidate !== null && candidate !== '' && Number.isFinite(Number(candidate))) return Number(candidate);
  if (fallback !== undefined && fallback !== null && fallback !== '' && Number.isFinite(Number(fallback))) return Number(fallback);
  return null;
};

export const COMPANION_STUDY_RESOURCE_TYPE = 'companion_study';

/** Build the only payload accepted for a periodic self-assessment. Scores are
 * server-owned and are deliberately never copied from a client calculation. */
export const buildAssessmentSubmissionPayload = ({
  assessmentType, subject, title, answers = {}, questionSetId = null, courseId = null,
} = {}) => {
  const payload = {
    assessmentType: String(assessmentType || '').trim(),
    subject: String(subject || '').trim(),
    title: String(title || '').trim(),
    answers: answers && typeof answers === 'object' && !Array.isArray(answers) ? answers : {},
    wrongQuestions: [],
  };
  if (courseId) payload.courseId = courseId;
  // Only a server-issued UUID can identify a formal question set. Otherwise
  // the API stores the answer draft as pending_review/unavailable.
  if (questionSetId && /^[0-9a-f-]{36}$/i.test(String(questionSetId))) payload.questionSetId = String(questionSetId);
  return payload;
};

export const getAssessmentSubmissionState = ({ questionSetId } = {}) => (
  questionSetId && /^[0-9a-f-]{36}$/i.test(String(questionSetId)) ? 'ready' : 'pending_review'
);

export const normalizeSubjectCategory = value => {
  const text = String(value || '').trim();
  if (text.includes('政治')) return '政治';
  if (text.includes('英语')) return '英语';
  if (text.includes('数学')) return '数学';
  if (text.includes('专业')) return '专业课';
  return text || '未分类';
};

/** Keep plan identity fields opaque. In particular, UUIDs must never pass
 * through Number(), which would silently turn them into NaN or truncate them. */
export const buildStudentPlanPayload = (plan = {}, { includeRevision = false } = {}) => {
  const startDate = plan.startDate ?? plan.start_date;
  const payload = {
    courseId: plan.courseId || plan.course_id || null,
    subject: String(plan.subject || '').trim(),
    name: String(plan.name || '').trim(),
    taskType: plan.taskType || plan.task_type || '阶段',
    startDay: Math.max(1, Math.min(365, Number(plan.startDay ?? plan.start_day) || 1)),
    startDate: startDate ? String(startDate).slice(0, 10) : null,
    lane: Math.max(1, Math.min(8, Number(plan.lane) || 1)),
    predecessorPlanId: plan.predecessorPlanId || plan.predecessor_plan_id || null,
    // 服务端 planRowSchema 拒绝空任务格与空行；模板允许留空格子，这里先压实再提交。
    rows: (Array.isArray(plan.rows) ? plan.rows : []).map(row => ({
      title: String(row?.title || row?.day || '').slice(0, 160),
      tasks: Array.isArray(row?.tasks) ? row.tasks.map(task => String(task || '').trim().slice(0, 1000)).filter(Boolean) : [],
    })).filter(row => row.tasks.length > 0),
  };
  if (includeRevision && plan.revision !== undefined && plan.revision !== null) {
    payload.revision = Number(plan.revision);
  }
  return payload;
};

export const normalizeMultipleChoiceAnswer = value => {
  const values = Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
  return [...new Set(values.flatMap(item => String(item).split(/[,，、\s]+/).map(part => part.trim()).filter(Boolean)))].sort();
};

export const answersMatch = (actual, expected, multiple = false) => {
  if (!multiple) return String(actual ?? '').trim() === String(expected ?? '').trim();
  const left = normalizeMultipleChoiceAnswer(actual);
  const right = normalizeMultipleChoiceAnswer(expected);
  return left.length === right.length && left.every((item, index) => item === right[index]);
};
