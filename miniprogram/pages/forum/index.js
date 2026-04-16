const { request, resolveUrl } = require('../../utils/request');
const { ensureLogin } = require('../../utils/auth');

Page({
  data: {
    loading: true,
    topics: [],
    // 筛选和搜索
    searchText: '',
    sortMode: 'latest',
    selectedCategory: '',
    categories: ['阶段复盘', '英语', '数学', '政治', '专业课', '心态调整'],
    // 分页
    offset: 0,
    hasMore: true,
    loadingMore: false
  },

  onShow() {
    if (!ensureLogin()) return;
    this.loadTopics(true);
  },

  onPullDownRefresh() {
    this.loadTopics(true).finally(() => wx.stopPullDownRefresh());
  },

  async loadTopics(reset) {
    if (reset) {
      this.setData({ loading: true, offset: 0, hasMore: true, topics: [] });
    }

    const offset = reset ? 0 : this.data.offset;
    const { searchText, sortMode, selectedCategory } = this.data;
    const params = ['limit=10', `offset=${offset}`];
    if (searchText) params.push(`search=${encodeURIComponent(searchText)}`);
    if (sortMode === 'hot') params.push('sort=hot');
    if (selectedCategory) params.push(`category=${encodeURIComponent(selectedCategory)}`);

    try {
      const data = await request({ url: `/api/forum/topics?${params.join('&')}` });
      const newTopics = (data.topics || []).map(t => ({
        ...t,
        imageUrls: (t.imagePaths || []).map(p => resolveUrl(p)).filter(Boolean),
        replyCount: (t.replies || []).length
      }));
      const topics = reset ? newTopics : this.data.topics.concat(newTopics);
      this.setData({
        topics,
        offset: offset + newTopics.length,
        hasMore: newTopics.length >= 10,
        loading: false,
        loadingMore: false
      });
    } catch (error) {
      this.setData({ loading: false, loadingMore: false });
      wx.showToast({ title: error.message, icon: 'none' });
    }
  },

  onReachBottom() {
    if (this.data.loadingMore || !this.data.hasMore) return;
    this.setData({ loadingMore: true });
    this.loadTopics(false);
  },

  handleSearchInput(e) {
    this.setData({ searchText: e.detail.value });
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => this.loadTopics(true), 500);
  },

  selectCategory(e) {
    const category = e.currentTarget.dataset.category;
    this.setData({ selectedCategory: this.data.selectedCategory === category ? '' : category });
    this.loadTopics(true);
  },

  toggleSort() {
    this.setData({ sortMode: this.data.sortMode === 'latest' ? 'hot' : 'latest' });
    this.loadTopics(true);
  },

  goTopicDetail(e) {
    const topicId = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/forum/detail?id=${topicId}` });
  },

  goNewPost() {
    wx.navigateTo({ url: '/pages/forum/post' });
  }
});
