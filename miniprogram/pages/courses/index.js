const { request, resolveUrl } = require('../../utils/request');
const { ensureLogin } = require('../../utils/auth');

Page({
  data: {
    loading: true,
    courses: [],
    filteredCourses: [],
    recentCourses: [],
    selectedSubject: '',
    subjects: []
  },

  onShow() {
    if (!ensureLogin()) return;
    this.loadCourses();
    this.loadRecent();
  },

  onPullDownRefresh() {
    Promise.all([this.loadCourses(true), this.loadRecent()]).finally(() => wx.stopPullDownRefresh());
  },

  async loadCourses(forceRefresh) {
    try {
      const app = getApp();
      const payload = await app.fetchBootstrap(forceRefresh);
      const courses = (payload.courses || []).map(course => ({
        ...course,
        videoSrc: resolveUrl(course.videoPath) || resolveUrl(course.videoUrl)
      }));
      const subjectSet = new Set(courses.map(c => c.subject).filter(Boolean));
      this.setData({
        loading: false,
        courses,
        filteredCourses: courses,
        subjects: Array.from(subjectSet)
      });
    } catch (error) {
      this.setData({ loading: false });
      wx.showToast({ title: error.message, icon: 'none' });
    }
  },

  async loadRecent() {
    try {
      const data = await request({ url: '/api/courses/recent' });
      const recentCourses = (data.items || []).map(item => ({
        ...item,
        videoSrc: resolveUrl(item.video_path) || resolveUrl(item.video_url),
        progress: item.duration_seconds > 0 ? Math.round((item.position_seconds / item.duration_seconds) * 100) : 0
      }));
      this.setData({ recentCourses });
    } catch (e) {
      // 静默处理
    }
  },

  selectSubject(e) {
    const subject = e.currentTarget.dataset.subject;
    const selectedSubject = this.data.selectedSubject === subject ? '' : subject;
    const filteredCourses = selectedSubject
      ? this.data.courses.filter(c => c.subject === selectedSubject)
      : this.data.courses;
    this.setData({ selectedSubject, filteredCourses });
  },

  goDetail(e) {
    const courseId = e.currentTarget.dataset.id;
    if (!courseId) return;
    wx.navigateTo({ url: `/pages/courses/detail?id=${courseId}` });
  }
});
