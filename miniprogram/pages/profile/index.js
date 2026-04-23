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
    activeTab: 'dashboard',
    reportPeriod: 'weekly',
    reportOffset: 0,
    reportData: null,
    passwordForm: { oldPassword: '', newPassword: '', confirmPassword: '' },
    changingPassword: false,
    calendarYear: 2026,
    calendarMonthIdx: 0,
    unreadCount: 0
  },

  onShow() {
    if (!ensureLogin()) return;
    const now = new Date();
    this.setData({
      user: getUser(),
      baseUrl: getBaseUrl(),
      calendarYear: now.getFullYear(),
      calendarMonthIdx: now.getMonth()
    });
    this.loadDashboard();
    this.loadOriginalData();
    this.loadReport();
    this.loadUnreadCount();
  },

  onPullDownRefresh() {
    this.setData({ loading: true });
    Promise.all([this.loadDashboard(), this.loadOriginalData()]).finally(() => wx.stopPullDownRefresh());
  },

  async loadDashboard() {
    try {
      const [statsData, streakData, achievementsData] = await Promise.all([
        request({ url: '/api/practice/stats/detailed' }),
        request({ url: `/api/study/streak?year=${this.data.calendarYear}&month=${this.data.calendarMonthIdx + 1}` }),
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
    const year = this.data.calendarYear;
    const month = this.data.calendarMonthIdx;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const firstDayOfWeek = new Date(year, month, 1).getDay();
    const now = new Date();
    const isCurrentMonth = year === now.getFullYear() && month === now.getMonth();
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
        today: isCurrentMonth && d === today
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

  // 日历月份切换
  prevMonth() {
    let { calendarYear, calendarMonthIdx } = this.data;
    calendarMonthIdx--;
    if (calendarMonthIdx < 0) { calendarMonthIdx = 11; calendarYear--; }
    this.setData({ calendarYear, calendarMonthIdx });
    this.loadCalendarData(calendarYear, calendarMonthIdx + 1);
  },

  nextMonth() {
    let { calendarYear, calendarMonthIdx } = this.data;
    calendarMonthIdx++;
    if (calendarMonthIdx > 11) { calendarMonthIdx = 0; calendarYear++; }
    this.setData({ calendarYear, calendarMonthIdx });
    this.loadCalendarData(calendarYear, calendarMonthIdx + 1);
  },

  async loadCalendarData(year, month) {
    try {
      const streakData = await request({ url: `/api/study/streak?year=${year}&month=${month}` });
      this.setData({ streak: streakData, calendarDays: streakData.calendarDays || [] });
      this.buildCalendarGrid();
    } catch (e) {
      console.warn('日历数据加载失败:', e);
    }
  },

  // 学习报告
  async loadReport() {
    const { reportPeriod, reportOffset } = this.data;
    try {
      const url = reportPeriod === 'weekly'
        ? `/api/practice/stats/weekly?weekOffset=${reportOffset}`
        : `/api/practice/stats/monthly?monthOffset=${reportOffset}`;
      const data = await request({ url });
      if (data.subjectBreakdown) {
        data.subjectBreakdown = data.subjectBreakdown.map(s => ({
          ...s,
          accuracy: s.total > 0 ? Math.round(s.correct / s.total * 100) : 0
        }));
      }
      if (reportPeriod === 'weekly') {
        data.periodLabel = `${data.weekStart} ~ ${data.weekEnd}`;
      } else {
        data.periodLabel = data.monthLabel || `${data.monthStart || ''} ~ ${data.monthEnd || ''}`;
      }
      this.setData({ reportData: data });
    } catch (e) {
      console.warn('报告加载失败:', e);
    }
  },

  toggleReportPeriod(e) {
    const period = e.currentTarget.dataset.period;
    this.setData({ reportPeriod: period, reportOffset: 0 });
    this.loadReport();
  },

  prevReport() {
    this.setData({ reportOffset: this.data.reportOffset + 1 });
    this.loadReport();
  },

  nextReport() {
    const offset = Math.max(0, this.data.reportOffset - 1);
    this.setData({ reportOffset: offset });
    this.loadReport();
  },

  // 通知管理
  async loadUnreadCount() {
    try {
      const data = await request({ url: '/api/notifications/unread-count' });
      this.setData({ unreadCount: data.count || 0 });
    } catch (e) { /* ignore */ }
  },

  async markNotificationRead(e) {
    const id = e.currentTarget.dataset.id;
    try {
      await request({ url: `/api/notifications/${id}/read`, method: 'POST' });
      const notifications = this.data.notifications.map(n =>
        n.id === id ? { ...n, readAt: new Date().toISOString() } : n
      );
      this.setData({ notifications, unreadCount: Math.max(0, this.data.unreadCount - 1) });
    } catch (e) {
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },

  async markAllRead() {
    try {
      await request({ url: '/api/notifications/read-all', method: 'POST' });
      const notifications = this.data.notifications.map(n => ({ ...n, readAt: n.readAt || new Date().toISOString() }));
      this.setData({ notifications, unreadCount: 0 });
      wx.showToast({ title: '已全部标记已读', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },

  // 修改密码
  handlePasswordInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`passwordForm.${field}`]: e.detail.value });
  },

  async changePassword() {
    const { oldPassword, newPassword, confirmPassword } = this.data.passwordForm;
    if (!oldPassword || !newPassword) { wx.showToast({ title: '请填写完整', icon: 'none' }); return; }
    if (newPassword !== confirmPassword) { wx.showToast({ title: '两次密码不一致', icon: 'none' }); return; }
    if (newPassword.length < 6) { wx.showToast({ title: '密码至少6位', icon: 'none' }); return; }
    this.setData({ changingPassword: true });
    try {
      await request({ url: '/api/auth/change-password', method: 'POST', data: { oldPassword, newPassword } });
      wx.showToast({ title: '密码修改成功', icon: 'success' });
      this.setData({ passwordForm: { oldPassword: '', newPassword: '', confirmPassword: '' } });
    } catch (e) {
      wx.showToast({ title: e.message || '修改失败', icon: 'none' });
    }
    this.setData({ changingPassword: false });
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
