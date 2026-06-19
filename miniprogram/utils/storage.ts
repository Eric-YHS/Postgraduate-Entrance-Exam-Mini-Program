import { StorageKey } from '../constants/storage-keys';

interface StorageItem<T> {
  value: T;
  expiresAt?: number;
}

/** 同步设置本地存储，支持过期时间（毫秒） */
export function setStorageSync<T>(key: StorageKey, value: T, ttl?: number): void {
  const item: StorageItem<T> = { value };
  if (ttl && ttl > 0) {
    item.expiresAt = Date.now() + ttl;
  }
  wx.setStorageSync(key, item);
}

/** 同步获取本地存储，自动判断是否过期 */
export function getStorageSync<T>(key: StorageKey): T | null {
  const item = wx.getStorageSync(key) as StorageItem<T> | undefined;
  if (!item) return null;

  if (item.expiresAt && Date.now() > item.expiresAt) {
    wx.removeStorageSync(key);
    return null;
  }

  return item.value;
}

/** 异步设置本地存储 */
export function setStorage<T>(
  key: StorageKey,
  value: T,
  ttl?: number
): Promise<WechatMiniprogram.GeneralCallbackResult> {
  const item: StorageItem<T> = { value };
  if (ttl && ttl > 0) {
    item.expiresAt = Date.now() + ttl;
  }
  return new Promise((resolve, reject) => {
    wx.setStorage({
      key,
      data: item,
      success: resolve,
      fail: reject,
    });
  });
}

/** 异步获取本地存储 */
export function getStorage<T>(key: StorageKey): Promise<T | null> {
  return new Promise((resolve, _reject) => {
    wx.getStorage({
      key,
      success: (res) => {
        const item = res.data as StorageItem<T> | undefined;
        if (!item) {
          resolve(null);
          return;
        }
        if (item.expiresAt && Date.now() > item.expiresAt) {
          wx.removeStorage({ key });
          resolve(null);
          return;
        }
        resolve(item.value);
      },
      fail: () => resolve(null),
    });
  });
}

/** 移除指定 key */
export function removeStorage(key: StorageKey): void {
  wx.removeStorageSync(key);
}

/** 清空用户相关存储 */
export function clearUserStorage(): void {
  wx.removeStorageSync(StorageKey.TOKEN);
  wx.removeStorageSync(StorageKey.REFRESH_TOKEN);
  wx.removeStorageSync(StorageKey.TOKEN_EXPIRES);
  wx.removeStorageSync(StorageKey.USER_PROFILE);
  wx.removeStorageSync(StorageKey.SEARCH_HISTORY);
}
