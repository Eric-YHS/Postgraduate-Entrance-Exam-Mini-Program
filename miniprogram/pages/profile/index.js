const { request, getBaseUrl } = require('../../utils/request');
const { ensureLogin, getUser, logout } = require('../../utils/auth');

Page({
  data: {
    loading: true,
    user: null,
    baseUrl: '',
    // 学习数据
    streak: { currentStreak: 0, longestStreak: 0, monthDays: 0 },
    overview: { totalAttempts: 0, accuracy: 0, flashcardsLearned: 0, totalSessions: 0, totalTimeSpentMs: 0 },
    subjectAccuracy: [],
    tagAccuracy: [],
    achievements: [],
    calendarDays: [],
    // 原有数据
    summaries: [],
    notifications: [],
    // 热力图
    calendarMonth: '',
    calendarGrid: [],
    // 错误状态
    dashboardError: '',
    // Tab
    activeTab: 'dashboard'
  },

  onShow() {
    if (!ensureLogin()) return;
    this.setData({ user: getUser(), baseUrl: getBaseUrl() });
    this.loadDashboard();
    this.loadOriginalData();
  },

  onPullDownRefresh() {
    this.setData({ loading: true });
    Promise.all([this.loadDashboard(), this.loadOriginalData()]).finally(() => wx.stopPullDownRefresh());
  },

  async loadDashboard() {
    try {
      const [statsData, streakData, achievementsData] = await Promise.all([
        request({ url: '/api/practice/stats/detailed' }),
        request({ url: '/api/study/streak' }),
        request({ url: '/api/achievements' })
      ]);

      this.setData({
        overview: statsData.overview,
        subjectAccuracy: statsData.subjectAccuracy || [],
        tagAccuracy: statsData.tagAccuracy || [],
        streak: streakData,
        achievements: achievementsData.achievements || [],
        calendarDays: streakData.calendarDays || []
      });

      this.buildCalendarGrid();
    } catch (e) {
      this.setData({ dashboardError: e.message || '学习数据加载失败' });
    }
  },

  async loadOriginalData() {
    try {
      const app = getApp();
      const payload = await app.fetchBootstrap();
      this.setData({
        loading: false,
        summaries: payload.summaries || [],
        notifications: payload.notifications || []
      });
    } catch (error) {
      this.setData({ loading: false });
      wx.showToast({ title: error.message, icon: 'none' });
    }
  },

  buildCalendarGrid() {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const firstDayOfWeek = new Date(year, month, 1).getDay();
    const today = now.getDate();
    const activeDays = new Set(this.data.calendarDays.map(d => {
      const parts = d.date.split('-');
      return parseInt(parts[2]);
    }));

    const grid = [];
    // 前面的空白格
    for (let i = 0; i < firstDayOfWeek; i++) {
      grid.push({ day: '', active: false, today: false });
    }
    // 日期格
    for (let d = 1; d <= daysInMonth; d++) {
      grid.push({
        day: d,
        active: activeDays.has(d),
        today: d === today
      });
    }

    const monthNames = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
    this.setData({
      calendarGrid: grid,
      calendarMonth: `${year}年${monthNames[month]}`
    });
  },

  // Tab 切换
  switchTab(e) {
    this.setData({ activeTab: e.currentTarget.dataset.tab });
  },

  retryDashboard() {
    this.setData({ dashboardError: '' });
    this.loadDashboard();
  },

  async handleLogout() {
    wx.showModal({
      title: '退出登录',
      content: '确定要退出当前账号吗？',
      confirmText: '退出',
      confirmColor: '#dc2626',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await request({ url: '/api/auth/logout', method: 'POST' });
        } catch (e) {
          // 忽略
        }
        logout();
      }
    });
  },

  goFlashcards() {
    wx.navigateTo({ url: '/pages/flashcards/index' });
  },

  goStore() {
    wx.navigateTo({ url: '/pages/store/index' });
  },

  goQuestions() {
    wx.switchTab({ url: '/pages/questions/index' });
  },

  goForum() {
    wx.switchTab({ url: '/pages/forum/index' });
  },

  // 格式化时间
  formatTime(ms) {
    if (!ms) return '0分钟';
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    if (hours > 0) return `${hours}小时${minutes > 0 ? minutes + '分钟' : ''}`;
    return `${minutes}分钟`;
  }
});
