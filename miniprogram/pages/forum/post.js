const { request } = require('../../utils/request');
const { ensureLogin } = require('../../utils/auth');

Page({
  data: {
    title: '',
    category: '',
    content: '',
    categories: ['阶段复盘', '英语', '数学', '政治', '专业课', '心态调整'],
    submitting: false
  },

  onLoad() {
    if (!ensureLogin()) return;
  },

  handleInput(event) {
    const field = event.currentTarget.dataset.field;
    const allowedFields = ['title', 'category', 'content'];
    if (!allowedFields.includes(field)) return;
    this.setData({ [field]: event.detail.value });
  },

  selectCategory(e) {
    this.setData({ category: e.currentTarget.dataset.cat });
  },

  async submitTopic() {
    const trimmedTitle = String(this.data.title || '').trim();
    const trimmedContent = String(this.data.content || '').trim();
    if (!trimmedTitle || !trimmedContent) {
      wx.showToast({ title: '标题和内容不能为空', icon: 'none' });
      return;
    }

    this.setData({ submitting: true });
    try {
      const result = await request({
        url: '/api/forum/topics',
        method: 'POST',
        data: {
          title: trimmedTitle,
          category: this.data.category || '阶段复盘',
          content: trimmedContent
        }
      });

      wx.showToast({ title: '帖子已发布', icon: 'success' });

      // 跳转到帖子详情页
      const topicId = result.topic?.id || result.id;
      if (topicId) {
        setTimeout(() => {
          wx.navigateTo({ url: `/pages/forum/detail?id=${topicId}` });
        }, 800);
      } else {
        setTimeout(() => wx.navigateBack(), 800);
      }
    } catch (error) {
      this.setData({ submitting: false });
      wx.showToast({ title: error.message, icon: 'none' });
    }
  },

  goBack() {
    wx.navigateBack();
  }
});
