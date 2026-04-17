App({
  _bootstrapCache: null,
  _bootstrapPromise: null,

  onLaunch() {
    if (!wx.getStorageSync('baseUrl')) {
      wx.setStorageSync('baseUrl', 'https://xiaoeduhub.online');
    }
  },

  getBootstrapCache() {
    return this._bootstrapCache;
  },

  clearBootstrapCache() {
    this._bootstrapCache = null;
    this._bootstrapPromise = null;
    wx.removeStorageSync('bootstrap_cache');
  },

  updateBootstrapCache(partial) {
    if (!this._bootstrapCache) return;
    Object.assign(this._bootstrapCache, partial);
    wx.setStorageSync('bootstrap_cache', this._bootstrapCache);
  },

  fetchBootstrap(forceRefresh) {
    if (!forceRefresh && this._bootstrapPromise) {
      return this._bootstrapPromise;
    }

    if (!forceRefresh && this._bootstrapCache) {
      return Promise.resolve(this._bootstrapCache);
    }

    const token = wx.getStorageSync('token') || '';
    if (!token) {
      return Promise.reject(new Error('未登录'));
    }

    const user = wx.getStorageSync('user');
    const role = (user && user.role) || 'student';
    const bootstrapPath = role === 'teacher' ? '/api/teacher/bootstrap' : '/api/student/bootstrap';

    const baseUrl = wx.getStorageSync('baseUrl') || 'https://xiaoeduhub.online';

    // 网络失败时使用本地缓存兜底
    const localCache = wx.getStorageSync('bootstrap_cache');
    if (!forceRefresh && localCache) {
      // 后台静默更新，先返回缓存
      this._backgroundRefresh(baseUrl, bootstrapPath, token);
      this._bootstrapCache = localCache;
      return Promise.resolve(localCache);
    }

    this._bootstrapPromise = new Promise((resolve, reject) => {
      wx.request({
        url: `${baseUrl}${bootstrapPath}`,
        method: 'GET',
        header: {
          Authorization: `Bearer ${token}`
        },
        success: (response) => {
          if (response.statusCode === 401) {
            this._bootstrapPromise = null;
            this.clearBootstrapCache();
            reject(new Error('登录已过期'));
            const { handleAuthExpired } = require('./utils/request');
            handleAuthExpired();
            return;
          }
          if (response.statusCode >= 200 && response.statusCode < 300) {
            this._bootstrapCache = response.data;
            wx.setStorageSync('bootstrap_cache', response.data);
            resolve(response.data);
          } else {
            this._bootstrapPromise = null;
            reject(new Error(response.data?.error || '服务器开小差了，请稍后重试'));
          }
        },
        fail: () => {
          this._bootstrapPromise = null;
          reject(new Error('网络连接失败，请检查网络后重试'));
        }
      });
    });

    return this._bootstrapPromise;
  },

  // 后台静默刷新数据
  _backgroundRefresh(baseUrl, bootstrapPath, token) {
    wx.request({
      url: `${baseUrl}${bootstrapPath}`,
      method: 'GET',
      header: { Authorization: `Bearer ${token}` },
      success: (response) => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          this._bootstrapCache = response.data;
          wx.setStorageSync('bootstrap_cache', response.data);
        } else if (response.statusCode === 401) {
          // 后台刷新发现 token 过期，清除缓存并跳转登录
          this.clearBootstrapCache();
          const { handleAuthExpired } = require('./utils/request');
          handleAuthExpired();
        }
      },
      fail: () => {}
    });
  },

  // 按模块加载 bootstrap 数据（如 ['courses']、['products','orders']）
  fetchBootstrapModules(modules, forceRefresh) {
    if (!modules || !modules.length) return this.fetchBootstrap(forceRefresh);

    const cacheKey = '_moduleCache_' + modules.sort().join(',');
    if (!forceRefresh && this[cacheKey]) {
      return Promise.resolve(this[cacheKey]);
    }

    const token = wx.getStorageSync('token') || '';
    if (!token) return Promise.reject(new Error('未登录'));

    const user = wx.getStorageSync('user');
    const role = (user && user.role) || 'student';
    const bootstrapPath = role === 'teacher' ? '/api/teacher/bootstrap' : '/api/student/bootstrap';
    const baseUrl = wx.getStorageSync('baseUrl') || 'https://xiaoeduhub.online';
    const url = `${baseUrl}${bootstrapPath}?modules=${modules.join(',')}`;

    const promise = new Promise((resolve, reject) => {
      wx.request({
        url,
        method: 'GET',
        header: { Authorization: `Bearer ${token}` },
        success: (response) => {
          if (response.statusCode === 401) {
            this[cacheKey] = null;
            this.clearBootstrapCache();
            reject(new Error('登录已过期'));
            const { handleAuthExpired } = require('./utils/request');
            handleAuthExpired();
            return;
          }
          if (response.statusCode >= 200 && response.statusCode < 300) {
            this[cacheKey] = response.data;
            resolve(response.data);
          } else {
            this[cacheKey] = null;
            reject(new Error(response.data?.error || '服务器开小差了，请稍后重试'));
          }
        },
        fail: () => {
          this[cacheKey] = null;
          reject(new Error('网络连接失败，请检查网络后重试'));
        }
      });
    });

    this[cacheKey] = promise;
    return promise;
  },

  // 全局临时状态：用于跨页面传递筛选参数（如搜索→题库）
  _pendingFilter: null,

  setPendingFilter(filter) {
    this._pendingFilter = filter;
  },

  consumePendingFilter() {
    const filter = this._pendingFilter;
    this._pendingFilter = null;
    return filter;
  }
});
