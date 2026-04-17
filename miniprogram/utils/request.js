const DEFAULT_BASE_URL = 'https://xiaoeduhub.online';

function getBaseUrl() {
  return wx.getStorageSync('baseUrl') || DEFAULT_BASE_URL;
}

function getToken() {
  return wx.getStorageSync('token') || '';
}

// 友好错误提示映射
const ERROR_MESSAGES = {
  400: '请求参数有误',
  401: '登录已过期，请重新登录',
  403: '没有权限执行此操作',
  404: '请求的资源不存在',
  429: '操作太频繁，请稍后再试',
  500: '服务器开小差了，请稍后重试',
  502: '服务器正在维护，请稍后重试',
  503: '服务器暂时无法访问，请稍后重试'
};

// 处理 401 登录过期（防抖：只触发一次）
let _authExpiredHandling = false;
function handleAuthExpired() {
  if (_authExpiredHandling) return;
  _authExpiredHandling = true;
  wx.removeStorageSync('token');
  wx.removeStorageSync('user');
  const app = getApp();
  if (app && app.clearBootstrapCache) {
    app.clearBootstrapCache();
  }
  wx.showToast({ title: '登录已过期，请重新登录', icon: 'none', duration: 2000 });
  setTimeout(() => {
    _authExpiredHandling = false;
    wx.reLaunch({ url: '/pages/login/index' });
  }, 1500);
}

function request({ url, method = 'GET', data = {}, header = {} }) {
  const token = getToken();
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${getBaseUrl()}${url}`,
      method,
      data,
      header: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...header
      },
      success: (response) => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response.data);
          return;
        }

        // 401 登录过期自动跳转
        if (response.statusCode === 401) {
          handleAuthExpired();
          reject(new Error('登录已过期'));
          return;
        }

        const friendlyMsg = ERROR_MESSAGES[response.statusCode] || response.data?.error || '请求失败';
        reject(new Error(friendlyMsg));
      },
      fail: () => {
        reject(new Error('网络连接失败，请检查网络后重试'));
      }
    });
  });
}

function uploadFile({ url, filePath, name, formData = {} }) {
  const token = getToken();
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: `${getBaseUrl()}${url}`,
      filePath,
      name,
      formData,
      header: token ? { Authorization: `Bearer ${token}` } : {},
      success: (response) => {
        let payload;
        try { payload = JSON.parse(response.data || '{}'); } catch { payload = {}; }
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(payload);
          return;
        }

        if (response.statusCode === 401) {
          handleAuthExpired();
          reject(new Error('登录已过期'));
          return;
        }

        reject(new Error(payload.error || '上传失败'));
      },
      fail: () => {
        reject(new Error('上传失败，请检查网络或服务器配置'));
      }
    });
  });
}

function resolveUrl(relativePath) {
  if (!relativePath) return '';
  if (/^https?:\/\//.test(relativePath)) return relativePath;
  const baseUrl = getBaseUrl();
  const token = wx.getStorageSync('token') || '';
  const separator = relativePath.includes('?') ? '&' : '?';
  return `${baseUrl}${relativePath}${token ? `${separator}token=${token}` : ''}`;
}

module.exports = {
  getBaseUrl,
  request,
  resolveUrl,
  uploadFile,
  handleAuthExpired,
  ERROR_MESSAGES
};
