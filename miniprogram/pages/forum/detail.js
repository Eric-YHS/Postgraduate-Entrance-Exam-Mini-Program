const { request, resolveUrl } = require('../../utils/request');
const { ensureLogin } = require('../../utils/auth');

Page({
  data: {
    loading: true,
    topicId: null,
    topic: null,
    replies: [],
    replyContent: '',
    submittingReply: false
  },

  onLoad(options) {
    if (!ensureLogin()) return;
    const topicId = options.id;
    if (!topicId) {
      wx.showToast({ title: '帖子不存在', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1500);
      return;
    }
    this.setData({ topicId });
    this.loadTopic(topicId);
  },

  async loadTopic(topicId) {
    this.setData({ loading: true });
    try {
      const data = await request({ url: `/api/forum/topics/${topicId}` });
      const topic = data.topic || data;
      topic.imageUrls = (topic.imagePaths || []).map(p => resolveUrl(p)).filter(Boolean);
      if (topic.title) {
        wx.setNavigationBarTitle({ title: topic.title });
      }
      this.setData({
        topic,
        replies: topic.replies || [],
        loading: false
      });
    } catch (error) {
      this.setData({ loading: false });
      wx.showToast({ title: error.message || '加载失败', icon: 'none' });
    }
  },

  onReplyInput(e) {
    this.setData({ replyContent: e.detail.value });
  },

  async submitReply() {
    const content = (this.data.replyContent || '').trim();
    if (!content) {
      wx.showToast({ title: '先写点内容', icon: 'none' });
      return;
    }

    this.setData({ submittingReply: true });
    try {
      await request({
        url: `/api/forum/topics/${this.data.topicId}/replies`,
        method: 'POST',
        data: { content }
      });
      wx.showToast({ title: '回复成功', icon: 'success' });
      this.setData({ replyContent: '' });
      this.loadTopic(this.data.topicId);
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' });
    } finally {
      this.setData({ submittingReply: false });
    }
  },

  async toggleLike() {
    const topic = this.data.topic;
    if (!topic) return;

    try {
      const result = await request({
        url: `/api/forum/topics/${topic.id}/like`,
        method: 'POST'
      });
      this.setData({
        'topic.likedByMe': result.liked,
        'topic.likeCount': (topic.likeCount || 0) + (result.liked ? 1 : -1)
      });
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' });
    }
  },

  previewImage(e) {
    const { url, urls } = e.currentTarget.dataset;
    wx.previewImage({ current: url, urls: urls || [url] });
  }
});
