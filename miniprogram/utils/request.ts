import type { RequestOptions, ApiResponse } from '../types/common';
import { getToken } from './auth';
import { mockRegistry } from '../mock/handlers/index';

const USE_MOCK = true;
const BASE_URL = 'https://api.kaoyan.com'; // 真实后端地址（预留）

/** 显示加载提示 */
function showLoading(title = '加载中...'): void {
  wx.showLoading({ title, mask: true });
}

/** 隐藏加载提示 */
function hideLoading(): void {
  wx.hideLoading();
}

/** 处理业务错误 */
function handleBusinessError(code: number, message: string): void {
  if (code === 401) {
    // 未登录或 token 过期，由调用方处理
    return;
  }
  wx.showToast({
    title: message || '请求失败',
    icon: 'none',
    duration: 2000,
  });
}

/** 统一请求封装 */
export function request<T = unknown>(options: RequestOptions): Promise<T> {
  const { url, method = 'GET', data, header = {}, loading = true, retry = true } = options;

  // Mock 拦截
  if (USE_MOCK && mockRegistry[url]) {
    return new Promise((resolve, reject) => {
      if (loading) showLoading();
      setTimeout(() => {
        try {
          const result = mockRegistry[url](data || {});
          if (loading) hideLoading();
          resolve(result as T);
        } catch (err) {
          if (loading) hideLoading();
          reject(err);
        }
      }, 300); // 模拟网络延迟
    });
  }

  return new Promise((resolve, reject) => {
    if (loading) showLoading();

    wx.request({
      url: `${BASE_URL}${url}`,
      method,
      data,
      header: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getToken()}`,
        ...header,
      },
      success: (res) => {
        if (loading) hideLoading();

        const response = res.data as ApiResponse<T>;
        if (res.statusCode >= 200 && res.statusCode < 300) {
          if (response.code === 0) {
            resolve(response.data);
          } else if (response.code === 401 && retry) {
            // token 过期，可在这里触发重新登录后重试
            handleBusinessError(response.code, response.message);
            reject(response);
          } else {
            handleBusinessError(response.code, response.message);
            reject(response);
          }
        } else {
          handleBusinessError(response?.code || res.statusCode, response?.message || '网络请求失败');
          reject(response || res);
        }
      },
      fail: (err) => {
        if (loading) hideLoading();
        wx.showToast({
          title: '网络异常，请稍后重试',
          icon: 'none',
        });
        reject(err);
      },
    });
  });
}

/** GET 请求 */
export function get<T = unknown>(
  url: string,
  data?: Record<string, unknown>,
  options?: Partial<RequestOptions>
): Promise<T> {
  return request<T>({ url, method: 'GET', data, ...options });
}

/** POST 请求 */
export function post<T = unknown>(
  url: string,
  data?: Record<string, unknown>,
  options?: Partial<RequestOptions>
): Promise<T> {
  return request<T>({ url, method: 'POST', data, ...options });
}

/** PUT 请求 */
export function put<T = unknown>(
  url: string,
  data?: Record<string, unknown>,
  options?: Partial<RequestOptions>
): Promise<T> {
  return request<T>({ url, method: 'PUT', data, ...options });
}

/** DELETE 请求 */
export function del<T = unknown>(
  url: string,
  data?: Record<string, unknown>,
  options?: Partial<RequestOptions>
): Promise<T> {
  return request<T>({ url, method: 'DELETE', data, ...options });
}
