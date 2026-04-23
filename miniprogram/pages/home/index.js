const { request, uploadFile, getBaseUrl } = require('../../utils/request');
const { ensureLogin, getUser } = require('../../utils/auth');

Page({
  data: {
    loading: false,
    user: null,
    today: '',
    tasks: [],
    tasksCompleted: 0,
    notifications: [],
    unreadCount: 0,
    summaries: [],
    liveSessions: [],
    nearestLive: null,
    recentCourseTitle: '',
    summaryContent: '',
    summaryDate: '',
    summarySubmitted: false,
    submittingSummary: false,
    selectedImages: [],
    selectedFiles: [],
    expandSupplement: false,
    lastUpdateTime: '',
    pageError: ''
  },

  onShow() {
    if (!ensureLogin()) return;
    this.setData({ user: getUser() });
    this.loadData();
  },

  onPullDownRefresh() {
    this.loadData(true).finally(() => wx.stopPullDownRefresh());
  },

  async loadData(forceRefresh) {
    this.setData({ loading: true });
    try {
      const app = getApp();
      const payload = await app.fetchBootstrap(forceRefresh);

      const tasks = payload.todaysTasks || [];
      const notifications = payload.notifications || [];
      const summaries = payload.summaries || [];
      const liveSessions = payload.liveSessions || [];

      tasks.forEach(t => {
        if (t.subtasks) t.subtasksCompleted = t.subtasks.filter(st => st.completed).length;
      });
      const tasksCompleted = tasks.filter(t => t.completedAt).length;
      const unreadCount = notifications.filter(n => !n.readAt).length;

      // 找到最近的直播（进行中 > 即将开始 > 已结束取最新）
      let nearestLive = null;
      const liveOnes = liveSessions.filter(s => s.status === 'live');
      const upcomingOnes = liveSessions.filter(s => s.status !== 'ended' && s.status !== 'live');
      if (liveOnes.length) nearestLive = liveOnes[0];
      else if (upcomingOnes.length) nearestLive = upcomingOnes[0];

      // 判断今日总结是否已提交
      const today = payload.today || '';
      const summarySubmitted = summaries.some(s => s.taskDate === today);

      // 最近课程标题（从 bootstrap 中获取 recentCourses，如果没有就留空）
      const recentCourses = payload.recentCourses || [];
      const recentCourseTitle = recentCourses.length ? `${recentCourses[0].title} (${recentCourses[0].progress || 0}%)` : '';

      const now = new Date();
      const lastUpdateTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

      this.setData({
        today,
        tasks,
        tasksCompleted,
        notifications,
        unreadCount,
        summaries,
        liveSessions,
        nearestLive,
        summarySubmitted,
        recentCourseTitle,
        summaryDate: today,
        lastUpdateTime
      });
    } catch (error) {
      this.setData({
        loading: false,
        pageError: error.message || '加载失败，请下拉刷新重试'
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  retryPage() {
    this.setData({ pageError: '', loading: true });
    this.loadData(true);
  },

  handleSummaryInput(event) {
    const { field } = event.currentTarget.dataset;
    const allowedFields = ['summaryDate', 'summaryContent'];
    if (!allowedFields.includes(field)) return;
    this.setData({ [field]: event.detail.value });
  },

  chooseImages() {
    wx.chooseMedia({
      count: 6,
      mediaType: ['image'],
      success: (result) => {
        const newPaths = result.tempFiles.map(f => f.tempFilePath);
        this.setData({ selectedImages: [...this.data.selectedImages, ...newPaths] });
      },
      fail: (err) => {
        if (err.errMsg && !err.errMsg.includes('cancel')) {
          wx.showToast({ title: '选择图片失败', icon: 'none' });
        }
      }
    });
  },

  chooseFiles() {
    wx.chooseMessageFile({
      count: 4,
      type: 'file',
      success: (result) => {
        const newPaths = result.tempFiles.map(item => item.path);
        this.setData({ selectedFiles: [...this.data.selectedFiles, ...newPaths] });
      },
      fail: (err) => {
        if (err.errMsg && !err.errMsg.includes('cancel')) {
          wx.showToast({ title: '选择文件失败', icon: 'none' });
        }
      }
    });
  },

  async submitSummary() {
    if (this.data.submittingSummary) return;
    try {
      const { summaryDate, summaryContent, selectedImages, selectedFiles } = this.data;
      const hasContent = (summaryContent || '').trim().length > 0;
      const hasFiles = selectedImages.length > 0 || selectedFiles.length > 0;
      if (!hasContent && !hasFiles) {
        wx.showToast({ title: '请填写总结内容或选择文件', icon: 'none' });
        return;
      }

      this.setData({ submittingSummary: true });

      if (hasFiles) {
        const allFiles = [
          ...selectedImages.map(p => ({ path: p, name: 'images' })),
          ...selectedFiles.map(p => ({ path: p, name: 'attachments' }))
        ];

        await uploadFile({
          url: '/api/summaries',
          filePath: allFiles[0].path,
          name: allFiles[0].name,
          formData: { taskDate: summaryDate, content: summaryContent }
        });

        for (let i = 1; i < allFiles.length; i++) {
          await uploadFile({
            url: '/api/summaries',
            filePath: allFiles[i].path,
            name: allFiles[i].name,
            formData: { taskDate: summaryDate }
          });
        }
      } else {
        await request({
          url: '/api/summaries',
          method: 'POST',
          data: { taskDate: summaryDate, content: summaryContent }
        });
      }

      wx.showToast({ title: '总结已提交', icon: 'success' });
      const today = this.data.today;
      const newSummary = { taskDate: today, content: summaryContent, imagePaths: [], attachmentPaths: [], updatedAt: new Date().toISOString() };
      const summaries = [newSummary, ...this.data.summaries];
      this.setData({
        summaryContent: '',
        summaryDate: today,
        selectedImages: [],
        selectedFiles: [],
        summarySubmitted: true,
        summaries
      });
      const app = getApp();
      app.updateBootstrapCache({ summaries });
    } catch (error) {
      if (error.message) {
        wx.showToast({ title: error.message, icon: 'none' });
      }
    } finally {
      this.setData({ submittingSummary: false });
    }
  },

  openLive(event) {
    const liveId = event.currentTarget.dataset.id;
    if (!liveId) {
      wx.showToast({ title: '直播信息异常', icon: 'none' });
      return;
    }
    const token = require('../../utils/auth').getToken();
    wx.setStorageSync('liveToken', token);
    const liveUrl = `${getBaseUrl()}/live/${liveId}`;
    wx.navigateTo({ url: `/pages/live-webview/index?src=${encodeURIComponent(liveUrl)}` });
  },

  markNotificationRead(event) {
    const notificationId = event.currentTarget.dataset.id;
    request({ url: `/api/notifications/${notificationId}/read`, method: 'POST' })
      .then(() => {
        const notifications = this.data.notifications.map(n =>
          n.id === notificationId ? { ...n, readAt: new Date().toISOString() } : n
        );
        const unreadCount = notifications.filter(n => !n.readAt).length;
        this.setData({ notifications, unreadCount });
        // 局部更新缓存
        const app = getApp();
        app.updateBootstrapCache({ notifications });
      })
      .catch((error) => {
        if (error.message) wx.showToast({ title: error.message, icon: 'none' });
      });
  },

  async markAllRead() {
    try {
      await request({ url: '/api/notifications/read-all', method: 'POST' });
      wx.showToast({ title: '已全部标为已读', icon: 'success' });
      const notifications = this.data.notifications.map(n => ({ ...n, readAt: n.readAt || new Date().toISOString() }));
      this.setData({ notifications, unreadCount: 0 });
      const app = getApp();
      app.updateBootstrapCache({ notifications });
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' });
    }
  },

  async toggleTaskComplete(e) {
    const { id, completed } = e.currentTarget.dataset;
    try {
      const url = completed ? `/api/tasks/${id}/uncomplete` : `/api/tasks/${id}/complete`;
      await request({ url, method: 'POST' });
      await this.refreshTasks();
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' });
    }
  },

  async toggleSubtask(e) {
    const { id, completed } = e.currentTarget.dataset;
    try {
      const url = completed ? `/api/subtasks/${id}/uncomplete` : `/api/subtasks/${id}/complete`;
      const method = completed ? 'DELETE' : 'POST';
      await request({ url, method });
      await this.refreshTasks();
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' });
    }
  },

  async refreshTasks() {
    try {
      const res = await request({ url: '/api/student/bootstrap' });
      const tasks = res.todaysTasks || [];
      tasks.forEach(t => {
        if (t.subtasks) t.subtasksCompleted = t.subtasks.filter(st => st.completed).length;
      });
      const tasksCompleted = tasks.filter(t => t.completedAt).length;
      this.setData({ tasks, tasksCompleted });
      const app = getApp();
      app.updateBootstrapCache({ todaysTasks: tasks });
    } catch (_) {
      wx.showToast({ title: '刷新失败，请下拉重试', icon: 'none' });
    }
  },

  toggleSupplement() {
    this.setData({ expandSupplement: !this.data.expandSupplement });
  },

  async setReminder(e) {
    const { taskId } = e.currentTarget.dataset;
    const time = e.detail.value;
    if (!time || !taskId) return;
    try {
      await request({ url: `/api/tasks/${taskId}/remind-time`, method: 'POST', data: { time } });
      wx.showToast({ title: '提醒已设为 ' + time, icon: 'success' });
      await this.refreshTasks();
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' });
    }
  },

  scrollToTasks() {
    wx.pageScrollTo({ selector: '#task-section', duration: 300 });
  },

  scrollToSummary() {
    wx.pageScrollTo({ selector: '#summary-section', duration: 300 });
  },

  goCourses() { wx.switchTab({ url: '/pages/courses/index' }); },
  goForum() { wx.switchTab({ url: '/pages/forum/index' }); },
  goQuestions() { wx.switchTab({ url: '/pages/questions/index' }); },
  goStore() { wx.navigateTo({ url: '/pages/store/index' }); },
  goProfile() { wx.switchTab({ url: '/pages/profile/index' }); },
  goFlashcards() { wx.navigateTo({ url: '/pages/flashcards/index' }); },
  goSearch() { wx.navigateTo({ url: '/pages/search/index' }); }
});
