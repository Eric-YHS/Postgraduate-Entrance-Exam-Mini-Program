const { request } = require('../../utils/request');

Page({
  data: {
    loading: false,
    username: '',
    password: '',
    rememberMe: false,
    usernameValid: false,
    passwordValid: false
  },

  onLoad() {
    // BUG-089: 防止 Android 返回键直接退出
    const pages = getCurrentPages();
    if (pages.length <= 1) {
      wx.enableAlertBeforeUnload({
        message: '确定要退出应用吗？'
      });
    }

    // 记住我：恢复上次保存的用户名
    const remembered = wx.getStorageSync('rememberedUsername');
    if (remembered) {
      this.setData({
        username: remembered,
        rememberMe: true,
        usernameValid: true
      });
    }
  },

  handleInput(event) {
    const { field } = event.currentTarget.dataset;
    const allowed = ['username', 'password'];
    if (!allowed.includes(field)) return;
    const value = event.detail.value;
    const updates = { [field]: value };

    if (field === 'username') {
      updates.usernameValid = value.trim().length >= 2;
    }
    if (field === 'password') {
      updates.passwordValid = value.length >= 6;
    }

    this.setData(updates);
  },

  toggleRemember() {
    this.setData({ rememberMe: !this.data.rememberMe });
  },

  showForgotHint() {
    wx.showModal({
      title: '忘记密码',
      content: '请联系老师或管理员重置密码。',
      showCancel: false,
      confirmText: '知道了'
    });
  },

  async wxLogin() {
    if (this.data.loading) return;
    this.setData({ loading: true });

    try {
      const loginResult = await new Promise((resolve, reject) => {
        wx.login({ success: resolve, fail: reject });
      });

      const result = await request({
        url: '/api/auth/wx-login',
        method: 'POST',
        data: { code: loginResult.code }
      });

      this._onLoginSuccess(result);
    } catch (error) {
      wx.showToast({ title: error.message || '登录失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  async accountLogin() {
    const { username, password } = this.data;

    if (!username.trim() || !password.trim()) {
      wx.showToast({ title: '请输入账号和密码', icon: 'none' });
      return;
    }

    if (this.data.loading) return;
    this.setData({ loading: true });

    try {
      const result = await request({
        url: '/api/auth/login',
        method: 'POST',
        data: { username: username.trim(), password }
      });

      // 记住我
      if (this.data.rememberMe) {
        wx.setStorageSync('rememberedUsername', username.trim());
      } else {
        wx.removeStorageSync('rememberedUsername');
      }

      this._onLoginSuccess(result);
    } catch (error) {
      wx.showToast({ title: error.message || '登录失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  _onLoginSuccess(result) {
    wx.setStorageSync('token', result.token);
    wx.setStorageSync('user', result.user);
    const app = getApp();
    if (app && app.clearBootstrapCache) {
      app.clearBootstrapCache();
    }
    wx.reLaunch({ url: '/pages/home/index' });
  }
});
