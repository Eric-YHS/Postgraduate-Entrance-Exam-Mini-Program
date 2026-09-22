import { CONTENT_SECURITY_API_BASE_URL } from '../config/runtime';

const SESSION_STORAGE_KEY = 'ky_wx_subscribe_session';
const SESSION_REFRESH_MARGIN_MS = 60 * 1000;

interface SubscribeSession {
  token: string;
  expiresAt: number;
}

interface ErrorResponse {
  ok?: boolean;
  code?: string;
  error?: string;
}

export interface WxSubscribeConfig {
  ok: boolean;
  configured: boolean;
  templateId: string;
  templateTitle: string;
  templateType: 'long-term';
}

export interface WxSubscribeDeliveryDetail {
  title: string;
  status: string;
  content: string;
  fixedContent: string;
  replacementDate: string;
  number: string;
  tip: string;
  createdAt: string;
}

export interface WxSubscribeDelivery {
  id: number;
  status: string;
  createdAt: string;
  sentAt: string | null;
  detail: WxSubscribeDeliveryDetail;
}

export class WxSubscribeClientError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'WxSubscribeClientError';
    this.code = code;
  }
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
          new WxSubscribeClientError(body.code || `HTTP_${response.statusCode}`, body.error || '微信提醒服务暂不可用。')
        );
      },
      fail: () => reject(new WxSubscribeClientError('NETWORK_ERROR', '无法连接微信提醒服务。')),
    });
  });
}

function getStoredSession(): SubscribeSession | null {
  try {
    const value = wx.getStorageSync(SESSION_STORAGE_KEY) as SubscribeSession | undefined;
    if (value?.token && Number(value.expiresAt) > Date.now() + SESSION_REFRESH_MARGIN_MS) return value;
  } catch {
    // 存储不可用时重新建立会话。
  }
  return null;
}

function clearSession(): void {
  try {
    wx.removeStorageSync(SESSION_STORAGE_KEY);
  } catch {
    // 无需阻断重新登录。
  }
}

function wxLoginCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (result) => {
        if (result.code) resolve(result.code);
        else reject(new WxSubscribeClientError('WX_LOGIN_FAILED', '无法建立微信提醒会话。'));
      },
      fail: () => reject(new WxSubscribeClientError('WX_LOGIN_FAILED', '无法建立微信提醒会话。')),
    });
  });
}

async function createSession(): Promise<SubscribeSession> {
  const code = await wxLoginCode();
  const session = await requestRaw<SubscribeSession & { ok: boolean }>('/api/wx-subscribe/session', {
    data: { code },
  });
  if (!session.token || !session.expiresAt) {
    throw new WxSubscribeClientError('INVALID_SESSION_RESPONSE', '微信提醒会话建立失败。');
  }
  wx.setStorageSync(SESSION_STORAGE_KEY, { token: session.token, expiresAt: session.expiresAt });
  return session;
}

async function ensureSession(forceRefresh = false): Promise<SubscribeSession> {
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
      error instanceof WxSubscribeClientError &&
      ['INVALID_SECURITY_SESSION', 'EXPIRED_SECURITY_SESSION', 'HTTP_401'].includes(error.code)
    ) {
      clearSession();
      return withSession(operation, true);
    }
    throw error;
  }
}

export function getWxSubscribeConfig(): Promise<WxSubscribeConfig> {
  return requestRaw<WxSubscribeConfig>('/api/wx-subscribe/config', { method: 'GET' });
}

export function requestWxSubscribePermission(templateId: string): Promise<'accept' | 'reject' | 'ban'> {
  return new Promise((resolve, reject) => {
    wx.requestSubscribeMessage({
      tmplIds: [templateId],
      success: (result) => {
        const status = (result as unknown as Record<string, string>)[templateId];
        if (status === 'accept' || status === 'reject' || status === 'ban') {
          resolve(status);
          return;
        }
        reject(new WxSubscribeClientError('INVALID_SUBSCRIBE_RESULT', '未获取到有效的订阅结果。'));
      },
      fail: () => reject(new WxSubscribeClientError('SUBSCRIBE_REQUEST_FAILED', '无法调起微信订阅授权。')),
    });
  });
}

export function sendWxSubscribeTest(): Promise<{
  ok: boolean;
  deliveryId: number;
  page: string;
  sentAt: string;
}> {
  return withSession((token) => requestRaw('/api/wx-subscribe/test', { token }));
}

export function getWxSubscribeDelivery(id: number): Promise<{
  ok: boolean;
  delivery: WxSubscribeDelivery;
}> {
  return withSession((token) => requestRaw(`/api/wx-subscribe/deliveries/${id}`, { token, method: 'GET' }));
}

export function formatWxSubscribeError(error: unknown): string {
  if (error instanceof WxSubscribeClientError) return error.message;
  return '微信提醒操作失败，请稍后重试。';
}
