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

  wx.reLaunch({ url: '/pages/login/index' });
  return false;
}

function logout() {
  const app = getApp();
  if (app && app.clearBootstrapCache) {
    app.clearBootstrapCache();
  }
  wx.removeStorageSync('token');
  wx.removeStorageSync('user');
  wx.reLaunch({ url: '/pages/login/index' });
}

module.exports = {
  ensureLogin,
  getToken,
  getUser,
  logout
};
