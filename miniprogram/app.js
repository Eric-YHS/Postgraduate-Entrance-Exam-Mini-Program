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
            wx.removeStorageSync('token');
            wx.removeStorageSync('user');
            this._bootstrapPromise = null;
            reject(new Error('登录已过期'));
            wx.showToast({ title: '登录已过期，请重新登录', icon: 'none', duration: 2000 });
            setTimeout(() => {
              wx.reLaunch({ url: '/pages/login/index' });
            }, 1500);
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
        }
      },
      fail: () => {}
    });
  }
});
