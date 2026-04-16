Page({
  data: {
    src: ''
  },

  onLoad(options) {
    let src = decodeURIComponent(options.src || '');
    // BUG-013: URL 白名单校验，防止加载任意外部站点
    const baseUrl = wx.getStorageSync('baseUrl') || 'https://xiaoeduhub.online';
    if (!src.startsWith(baseUrl)) {
      wx.showToast({ title: '非法链接', icon: 'none' });
      return;
    }
    const token = wx.getStorageSync('liveToken') || '';
    if (src && token) {
      const separator = src.includes('?') ? '&' : '?';
      src += `${separator}token=${encodeURIComponent(token)}`;
    }
    // BUG-204: 延迟清除 Token，确保 web-view 加载完成后再清除
    setTimeout(() => {
      wx.removeStorageSync('liveToken');
    }, 5000);
    this.setData({ src });
  }
});
