import { StorageKey } from '../constants/storage-keys';
import type { LoginResponse, UserProfile } from '../types/user';
import { mockLogin } from '../mock/handlers/user.handler';
import { USE_MOCK_API } from '../config/runtime';

/** 获取 Token */
export function getToken(): string {
  return wx.getStorageSync(StorageKey.TOKEN) as string;
}

/** 设置 Token */
export function setToken(token: string, expiresIn: number): void {
  wx.setStorageSync(StorageKey.TOKEN, token);
  const expiresAt = Date.now() + expiresIn * 1000;
  wx.setStorageSync(StorageKey.TOKEN_EXPIRES, expiresAt);
}

/** 获取刷新令牌 */
export function getRefreshToken(): string {
  return wx.getStorageSync(StorageKey.REFRESH_TOKEN) as string;
}

/** 设置刷新令牌 */
export function setRefreshToken(token: string): void {
  wx.setStorageSync(StorageKey.REFRESH_TOKEN, token);
}

/** 清除登录态 */
export function clearAuth(): void {
  wx.removeStorageSync(StorageKey.TOKEN);
  wx.removeStorageSync(StorageKey.REFRESH_TOKEN);
  wx.removeStorageSync(StorageKey.TOKEN_EXPIRES);
  wx.removeStorageSync(StorageKey.USER_PROFILE);
}

/** 检查 token 是否过期 */
export function isTokenExpired(): boolean {
  const expiresAt = wx.getStorageSync(StorageKey.TOKEN_EXPIRES) as number;
  if (!expiresAt) return true;
  return Date.now() >= expiresAt - 5 * 60 * 1000; // 提前 5 分钟视为过期
}

/** 检查微信 session 是否有效 */
export function checkSession(): Promise<boolean> {
  return new Promise((resolve) => {
    wx.checkSession({
      success: () => resolve(true),
      fail: () => resolve(false),
    });
  });
}

/** 微信静默登录，获取 code */
export function wxLogin(): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (res) => {
        if (res.code) {
          resolve(res.code);
        } else {
          reject(new Error(res.errMsg || '登录失败'));
        }
      },
      fail: reject,
    });
  });
}

/** 用 code 换取 token（Mock 阶段直接走本地 Mock） */
export async function code2Token(code: string): Promise<LoginResponse> {
  if (USE_MOCK_API) {
    return mockLogin(code);
  }

  // 真实后端接口（预留）
  return new Promise((resolve, reject) => {
    wx.request({
      url: 'https://api.example.com/auth/login',
      method: 'POST',
      data: { code },
      success: (res) => {
        const data = res.data as LoginResponse;
        resolve(data);
      },
      fail: reject,
    });
  });
}

/** 初始化登录态 */
export async function initializeAuth(): Promise<void> {
  const token = getToken();

  if (token && !isTokenExpired()) {
    const sessionValid = await checkSession();
    if (sessionValid) {
      return;
    }
  }

  // token 不存在或过期，重新登录
  try {
    const code = await wxLogin();
    const loginRes = await code2Token(code);
    setToken(loginRes.token, loginRes.expiresIn);
    setRefreshToken(loginRes.refreshToken);
    wx.setStorageSync(StorageKey.USER_PROFILE, loginRes.user);
  } catch (err) {
    console.error('[Auth] 初始化登录失败', err);
    clearAuth();
  }
}

/** 获取用户信息（本地缓存） */
export function getUserProfile(): UserProfile | null {
  return wx.getStorageSync(StorageKey.USER_PROFILE) as UserProfile | null;
}

/** 设置用户信息 */
export function setUserProfile(profile: UserProfile): void {
  wx.setStorageSync(StorageKey.USER_PROFILE, profile);
}
