const { request } = require('../../utils/request');
const { ensureLogin } = require('../../utils/auth');

const SEARCH_HISTORY_KEY = 'search_history';
const MAX_HISTORY = 10;

Page({
  data: {
    keyword: '',
    hotKeywords: [],
    searchHistory: [],
    activeTab: 'all',
    results: { topics: [], questions: [], items: [] },
    searched: false,
    loading: false
  },

  onLoad() {
    this.loadHotKeywords();
    this.loadSearchHistory();
  },

  loadSearchHistory() {
    try {
      const history = wx.getStorageSync(SEARCH_HISTORY_KEY) || [];
      this.setData({ searchHistory: history });
    } catch (e) { /* 忽略 */ }
  },

  saveSearchHistory(keyword) {
    try {
      let history = wx.getStorageSync(SEARCH_HISTORY_KEY) || [];
      history = history.filter(h => h !== keyword);
      history.unshift(keyword);
      if (history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY);
      wx.setStorageSync(SEARCH_HISTORY_KEY, history);
      this.setData({ searchHistory: history });
    } catch (e) { /* 忽略 */ }
  },

  clearSearchHistory() {
    wx.removeStorageSync(SEARCH_HISTORY_KEY);
    this.setData({ searchHistory: [] });
  },

  tapHistory(e) {
    this.setData({ keyword: e.currentTarget.dataset.keyword });
    this.doSearch();
  },

  async loadHotKeywords() {
    try {
      const data = await request({ url: '/api/search/hot' });
      this.setData({ hotKeywords: (data.keywords || []).map(k => k.keyword) });
    } catch (e) { /* 静默 */ }
  },

  handleInput(e) {
    this.setData({ keyword: e.detail.value });
  },

  tapHot(e) {
    this.setData({ keyword: e.currentTarget.dataset.keyword });
    this.doSearch();
  },

  handleConfirm() {
    this.doSearch();
  },

  async doSearch() {
    const keyword = this.data.keyword.trim();
    if (keyword.length < 2) {
      wx.showToast({ title: '至少输入2个字符', icon: 'none' });
      return;
    }

    this.saveSearchHistory(keyword);
    this.setData({ loading: true, searched: true });
    try {
      const data = await request({ url: `/api/search?q=${encodeURIComponent(keyword)}` });
      this.setData({
        results: { topics: data.topics || [], questions: data.questions || [], items: data.items || [] },
        loading: false
      });
    } catch (error) {
      this.setData({ loading: false });
      wx.showToast({ title: error.message, icon: 'none' });
    }
  },

  switchTab(e) {
    this.setData({ activeTab: e.currentTarget.dataset.tab });
  },

  goBack() {
    wx.navigateBack();
  },

  // 直达帖子详情页
  goTopicDetail(e) {
    const topicId = e.currentTarget.dataset.id;
    if (topicId) {
      wx.navigateTo({ url: `/pages/forum/detail?id=${topicId}` });
    }
  },

  // 跳转题库（带科目筛选）
  goQuestion(e) {
    const subject = e.currentTarget.dataset.subject;
    wx.switchTab({ url: '/pages/questions/index' });
  },

  // 直达课程详情页
  goCourseDetail(e) {
    const courseId = e.currentTarget.dataset.id;
    if (courseId) {
      wx.navigateTo({ url: `/pages/courses/detail?id=${courseId}` });
    }
  }
});
