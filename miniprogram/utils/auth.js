function getToken() {
  return wx.getStorageSync('token') || '';
}

function getUser() {
  return wx.getStorageSync('user') || null;
}

function ensureLogin() {
  if (getToken()) {
    return true;
  }

  // BUG-089: 使用 redirectTo 而非 reLaunch，保留页面栈防止返回键直接退出
  const pages = getCurrentPages();
  if (pages.length > 0) {
    const currentPath = pages[pages.length - 1].route;
    if (currentPath !== 'pages/login/index') {
      wx.redirectTo({ url: '/pages/login/index' });
    }
  } else {
    wx.reLaunch({ url: '/pages/login/index' });
  }
  return false;
}

function logout() {
  const app = getApp();
  if (app && app.clearBootstrapCache) {
    app.clearBootstrapCache();
  }
  wx.removeStorageSync('token');
  wx.removeStorageSync('user');
  // BUG-089: 使用 redirectTo 保持页面栈，避免返回键直接退出
  wx.redirectTo({
    url: '/pages/login/index'
  });
}

module.exports = {
  ensureLogin,
  getToken,
  getUser,
  logout
};
