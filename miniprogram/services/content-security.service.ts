import { CONTENT_SECURITY_API_BASE_URL } from '../config/runtime';

const SESSION_STORAGE_KEY = 'ky_content_security_session';
const SESSION_REFRESH_MARGIN_MS = 60 * 1000;

export interface ContentSecurityCheck {
  apiName: 'msgSecCheck' | 'imgSecCheck' | 'mediaCheckAsync';
  status: 'passed' | 'submitted' | 'review' | 'rejected' | 'error';
  errcode: number;
  errmsg: string;
  suggestion: string;
  label: number | null;
  traceId: string;
  raw: Record<string, unknown>;
  requestId?: string;
  contentType?: string;
  createdAt?: string;
}

export interface ContentSecurityResult {
  ok: boolean;
  allowed: boolean;
  requestId: string;
  saved: boolean;
  checks: ContentSecurityCheck[];
}

interface SecuritySession {
  token: string;
  expiresAt: number;
}

interface ErrorResponse {
  ok?: boolean;
  code?: string;
  error?: string;
}

export class ContentSecurityClientError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ContentSecurityClientError';
    this.code = code;
  }
}

function getStoredSession(): SecuritySession | null {
  try {
    const value = wx.getStorageSync(SESSION_STORAGE_KEY) as SecuritySession | undefined;
    if (value?.token && Number(value.expiresAt) > Date.now() + SESSION_REFRESH_MARGIN_MS) return value;
  } catch {
    // 存储不可用时重新建立短期会话。
  }
  return null;
}

function clearSession(): void {
  try {
    wx.removeStorageSync(SESSION_STORAGE_KEY);
  } catch {
    // 无需阻断后续重新登录。
  }
}

function wxLoginCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (result) => {
        if (result.code) resolve(result.code);
        else reject(new ContentSecurityClientError('WX_LOGIN_FAILED', '无法建立内容安全会话，请重试。'));
      },
      fail: () => reject(new ContentSecurityClientError('WX_LOGIN_FAILED', '无法建立内容安全会话，请重试。')),
    });
  });
}

function requestRaw<T>(
  path: string,
  options: { data?: Record<string, unknown>; token?: string; method?: 'GET' | 'POST' } = {}
): Promise<T> {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${CONTENT_SECURITY_API_BASE_URL}${path}`,
      method: options.method || 'POST',
      data: options.data,
      header: {
        'Content-Type': 'application/json',
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      success: (response) => {
        const body = (response.data || {}) as T & ErrorResponse;
        if (response.statusCode >= 200 && response.statusCode < 300 && body.ok !== false) {
          resolve(body);
          return;
        }
        reject(
          new ContentSecurityClientError(
            body.code || `HTTP_${response.statusCode}`,
            body.error || '内容安全检测服务暂不可用，请稍后重试。'
          )
        );
      },
      fail: () => {
        reject(new ContentSecurityClientError('NETWORK_ERROR', '无法连接内容安全检测服务，请检查网络后重试。'));
      },
    });
  });
}

async function createSession(): Promise<SecuritySession> {
  const code = await wxLoginCode();
  const session = await requestRaw<SecuritySession & { ok: boolean }>('/api/content-security/session', {
    data: { code },
  });
  if (!session.token || !session.expiresAt) {
    throw new ContentSecurityClientError('INVALID_SESSION_RESPONSE', '内容安全会话建立失败，请重试。');
  }
  wx.setStorageSync(SESSION_STORAGE_KEY, { token: session.token, expiresAt: session.expiresAt });
  return session;
}

async function ensureSession(forceRefresh = false): Promise<SecuritySession> {
  if (!forceRefresh) {
    const stored = getStoredSession();
    if (stored) return stored;
  }
  clearSession();
  return createSession();
}

async function withSession<T>(operation: (token: string) => Promise<T>, retried = false): Promise<T> {
  const session = await ensureSession(retried);
  try {
    return await operation(session.token);
  } catch (error) {
    if (
      !retried &&
      error instanceof ContentSecurityClientError &&
      ['INVALID_SECURITY_SESSION', 'EXPIRED_SECURITY_SESSION', 'HTTP_401'].includes(error.code)
    ) {
      clearSession();
      return withSession(operation, true);
    }
    throw error;
  }
}

function getImageInfo(path: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    wx.getImageInfo({
      src: path,
      success: (result) => resolve({ width: result.width, height: result.height }),
      fail: () => resolve(null),
    });
  });
}

async function compressImage(path: string, quality: number): Promise<string> {
  const info = await getImageInfo(path);
  const scale = info ? Math.min(1, 750 / info.width, 1334 / info.height) : 1;
  const resizeOptions =
    info && scale < 1
      ? {
          compressedWidth: Math.max(1, Math.floor(info.width * scale)),
          compressedHeight: Math.max(1, Math.floor(info.height * scale)),
        }
      : {};

  return new Promise((resolve) => {
    wx.compressImage({
      src: path,
      quality,
      ...resizeOptions,
      success: (result) => resolve(result.tempFilePath || path),
      fail: () => resolve(path),
    });
  });
}

function uploadImageRaw(filePath: string, token: string): Promise<ContentSecurityResult> {
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: `${CONTENT_SECURITY_API_BASE_URL}/api/content-security/image`,
      filePath,
      name: 'media',
      header: { Authorization: `Bearer ${token}` },
      success: (response) => {
        let body: (ContentSecurityResult & ErrorResponse) | null = null;
        try {
          body = JSON.parse(response.data) as ContentSecurityResult & ErrorResponse;
        } catch {
          reject(new ContentSecurityClientError('INVALID_IMAGE_RESPONSE', '图片安全检测返回无效数据。'));
          return;
        }
        if (response.statusCode >= 200 && response.statusCode < 300 && body.ok !== false) {
          resolve(body);
          return;
        }
        reject(
          new ContentSecurityClientError(
            body.code || `HTTP_${response.statusCode}`,
            body.error || '图片安全检测失败，请更换图片后重试。'
          )
        );
      },
      fail: () => reject(new ContentSecurityClientError('NETWORK_ERROR', '无法上传图片进行安全检测。')),
    });
  });
}

export function checkTextContent(content: string): Promise<ContentSecurityResult> {
  return withSession((token) =>
    requestRaw<ContentSecurityResult>('/api/content-security/text', {
      data: { content },
      token,
    })
  );
}

export async function checkImageContent(path: string): Promise<ContentSecurityResult> {
  const compressed = await compressImage(path, 45);
  try {
    return await withSession((token) => uploadImageRaw(compressed, token));
  } catch (error) {
    if (error instanceof ContentSecurityClientError && error.code === 'IMAGE_TOO_LARGE') {
      const smaller = await compressImage(path, 20);
      return withSession((token) => uploadImageRaw(smaller, token));
    }
    throw error;
  }
}

export function getContentSecurityHistory(limit = 20): Promise<{ ok: boolean; checks: ContentSecurityCheck[] }> {
  return withSession((token) =>
    requestRaw<{ ok: boolean; checks: ContentSecurityCheck[] }>('/api/content-security/history', {
      data: { limit },
      token,
    })
  );
}

export function formatContentSecurityError(error: unknown): string {
  if (error instanceof ContentSecurityClientError) return error.message;
  return '内容安全检测失败，请稍后重试。';
}
