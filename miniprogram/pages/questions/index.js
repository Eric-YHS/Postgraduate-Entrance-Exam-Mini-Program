const { request } = require('../../utils/request');
const { ensureLogin } = require('../../utils/auth');

Page({
  data: {
    loading: true,
    questions: [],
    currentQuestion: {},
    currentIndex: 0,
    selectedAnswer: '',
    showAnalysis: false,
    currentResult: null,
    submitting: false,
    // 筛选
    filters: { subject: '', mode: 'all' },
    filterOptions: { subjects: [] },
    showFilter: false,
    modeLabel: '全部',
    // 会话统计
    sessionCorrect: 0,
    sessionAnswered: 0,
    sessionAccuracy: 0,
    sessionComplete: false,
    // 分页
    page: 1,
    totalCount: 0,
    hasMore: true,
    // 全局统计
    stats: { totalAttempts: 0, accuracy: 0 },
    // 练习会话
    currentSessionId: null,
    sessionStartTime: 0
  },

  onShow() {
    if (!ensureLogin()) return;
    // 消费搜索页传来的科目筛选
    const pending = getApp().consumePendingFilter();
    if (pending && pending.subject && pending.subject !== this.data.filters.subject) {
      this.setData({ 'filters.subject': pending.subject });
    }
    this.loadMeta();
    this.loadStats();
    this.loadQuestions(true);
  },

  onPullDownRefresh() {
    this.loadStats();
    this.loadQuestions(true);
    setTimeout(() => wx.stopPullDownRefresh(), 800);
  },

  async loadMeta() {
    try {
      const data = await request({ url: '/api/questions/meta' });
      this.setData({ 'filterOptions.subjects': data.subjects || [] });
    } catch (e) {
      console.warn('题目元数据加载失败:', e);
    }
  },

  async loadStats() {
    try {
      const stats = await request({ url: '/api/practice/stats' });
      this.setData({ stats });
    } catch (e) {
      console.warn('练习统计加载失败:', e);
    }
  },

  async loadQuestions(reset) {
    if (reset) {
      this.setData({ loading: true, page: 1, hasMore: true, questions: [], sessionComplete: false });
    }

    const { subject, mode } = this.data.filters;
    const page = reset ? 1 : this.data.page;
    const params = [`page=${page}`, 'limit=10'];
    if (subject) params.push(`subject=${encodeURIComponent(subject)}`);

    let apiMode = '';
    if (mode === 'random') apiMode = 'random';
    else if (mode === 'untried') apiMode = 'untried';
    if (apiMode) params.push(`mode=${apiMode}`);

    let url = `/api/questions?${params.join('&')}`;

    if (mode === 'favorites') {
      url = '/api/questions/favorites?page=' + page + '&limit=10';
    } else if (mode === 'wrong') {
      url = '/api/practice/wrong?page=' + page + '&limit=10';
    }

    try {
      const data = await request({ url });
      const newQuestions = data.questions || [];
      const questions = reset ? newQuestions : this.data.questions.concat(newQuestions);
      this.setData({
        questions,
        totalCount: data.totalCount || questions.length,
        hasMore: questions.length < (data.totalCount || 9999),
        page,
        loading: false,
        currentIndex: 0,
        selectedAnswer: '',
        showAnalysis: false,
        currentResult: null,
        sessionCorrect: 0,
        sessionAnswered: 0,
        sessionAccuracy: 0,
        sessionComplete: false
      });
      this._updateCurrentQuestion();
      this.startSession();
    } catch (error) {
      this.setData({ loading: false });
      wx.showToast({ title: error.message, icon: 'none' });
    }
  },

  onReachBottom() {
    // 单题模式下不自动加载更多，改为手动翻页加载
  },

  _updateCurrentQuestion() {
    const q = this.data.questions[this.data.currentIndex] || {};
    this.setData({ currentQuestion: q });
  },

  // 筛选交互
  toggleFilter() {
    this.setData({ showFilter: !this.data.showFilter });
  },

  selectSubject(e) {
    const subject = e.currentTarget.dataset.subject;
    this.setData({ 'filters.subject': this.data.filters.subject === subject ? '' : subject, showFilter: false });
    this.loadQuestions(true);
  },

  selectMode(e) {
    const mode = e.currentTarget.dataset.mode;
    const labels = { all: '全部', random: '随机', untried: '未做', favorites: '收藏', wrong: '错题', daily: '每日推荐' };
    this.setData({ 'filters.mode': mode, modeLabel: labels[mode] || mode, showFilter: false });
    this.loadQuestions(true);
  },

  // 收藏
  async toggleFavorite(e) {
    const questionId = e.currentTarget.dataset.id;
    try {
      const result = await request({ url: `/api/questions/${questionId}/favorite`, method: 'POST' });
      const questions = this.data.questions.map(q =>
        q.id === questionId ? { ...q, favorited: result.favorited } : q
      );
      this.setData({ questions });
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' });
    }
  },

  handleRadioChange(event) {
    if (this.data.showAnalysis) return;
    this.setData({ selectedAnswer: event.detail.value });
  },

  async submitAnswer() {
    if (!this.data.selectedAnswer || this.data.submitting) return;

    const question = this.data.questions[this.data.currentIndex];
    if (!question) return;

    this.setData({ submitting: true });
    const timeSpentMs = this.data.sessionStartTime ? Date.now() - this.data.sessionStartTime : 0;

    try {
      const result = await request({
        url: `/api/questions/${question.id}/answer`,
        method: 'POST',
        data: {
          selectedAnswer: this.data.selectedAnswer,
          sessionId: this.data.currentSessionId || '',
          timeSpentMs
        }
      });

      const sessionAnswered = this.data.sessionAnswered + 1;
      const sessionCorrect = this.data.sessionCorrect + (result.result.isCorrect ? 1 : 0);
      const sessionAccuracy = sessionAnswered > 0 ? Math.round(sessionCorrect / sessionAnswered * 100) : 0;

      // 更新当前题目的结果信息
      const questions = this.data.questions.map(q =>
        q.id === question.id ? { ...q, latestRecord: result.result } : q
      );

      this.setData({
        questions,
        showAnalysis: true,
        currentResult: result.result,
        sessionAnswered,
        sessionCorrect,
        sessionAccuracy,
        submitting: false,
        sessionStartTime: Date.now()
      });
      this.loadStats();
    } catch (error) {
      this.setData({ submitting: false });
      wx.showToast({ title: error.message, icon: 'none' });
    }
  },

  nextQuestion() {
    const { currentIndex, questions } = this.data;
    if (currentIndex < questions.length - 1) {
      this.setData({
        currentIndex: currentIndex + 1,
        selectedAnswer: '',
        showAnalysis: false,
        currentResult: null
      });
      this._updateCurrentQuestion();
    } else {
      // 所有题目完成
      this.setData({ sessionComplete: true });
    }
  },

  async addNote(e) {
    const qId = e.currentTarget.dataset.id;
    const res = await new Promise((resolve) => {
      wx.showModal({ title: '添加笔记', content: '请输入你的理解或笔记', editable: true, placeholderText: '记录你对这道题的理解', success: resolve });
    });
    if (!res.confirm || !res.content || !res.content.trim()) return;
    try {
      await request({ url: `/api/questions/${qId}/notes`, method: 'POST', data: { content: res.content.trim() } });
      wx.showToast({ title: '笔记已保存', icon: 'success' });
      const questions = this.data.questions;
      const idx = questions.findIndex(q => q.id === qId);
      if (idx >= 0) { questions[idx].myNote = res.content.trim(); this.setData({ questions }); }
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' });
    }
  },

  restartSession() {
    this.loadQuestions(true);
  },

  reviewWrong() {
    this.setData({ 'filters.mode': 'wrong', modeLabel: '错题' });
    this.loadQuestions(true);
  },

  async startSession() {
    try {
      const data = await request({
        url: '/api/practice/sessions',
        method: 'POST',
        data: { mode: this.data.filters.mode || 'all' }
      });
      this.setData({
        currentSessionId: data.sessionId || data.id,
        sessionStartTime: Date.now()
      });
    } catch (e) {
      console.warn('练习会话创建失败:', e);
    }
  },

  async loadDaily() {
    this.setData({ loading: true, questions: [], showFilter: false });
    try {
      const data = await request({ url: '/api/questions/daily' });
      this.setData({
        questions: data.questions || [],
        loading: false,
        'filters.mode': 'daily',
        modeLabel: '每日推荐',
        totalCount: (data.questions || []).length,
        hasMore: false,
        currentIndex: 0,
        selectedAnswer: '',
        showAnalysis: false,
        currentResult: null,
        sessionCorrect: 0,
        sessionAnswered: 0,
        sessionAccuracy: 0,
        sessionComplete: false
      });
      this._updateCurrentQuestion();
      this.startSession();
    } catch (error) {
      this.setData({ loading: false });
      wx.showToast({ title: error.message, icon: 'none' });
    }
  }
});