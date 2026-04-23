const { request, resolveUrl } = require('../../utils/request');
const { ensureLogin } = require('../../utils/auth');

Page({
  data: {
    loading: true,
    loadError: null,
    courses: [],
    filteredCourses: [],
    recentCourses: [],
    selectedSubject: '',
    subjects: [],
    folders: [],
    folderPath: [],
    currentParentId: null
  },

  onShow() {
    if (!ensureLogin()) return;
    this.loadCourses();
    this.loadRecent();
    this.loadFolders(null);
  },

  onPullDownRefresh() {
    Promise.all([this.loadCourses(true), this.loadRecent()]).finally(() => wx.stopPullDownRefresh());
  },

  async loadCourses(forceRefresh) {
    try {
      const app = getApp();
      const payload = await app.fetchBootstrapModules(['courses'], forceRefresh);
      const courses = (payload.courses || []).map(course => ({
        ...course,
        videoSrc: resolveUrl(course.videoPath || course.video_url) || resolveUrl(course.videoUrl)
      }));
      const subjectSet = new Set(courses.map(c => c.subject).filter(Boolean));
      this.setData({
        loading: false,
        courses,
        filteredCourses: courses,
        subjects: Array.from(subjectSet)
      });
    } catch (error) {
      this.setData({ loading: false, loadError: error.message || '课程加载失败，请重试' });
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
      console.warn('最近观看加载失败:', e);
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

  async loadFolders(parentId) {
    try {
      const params = parentId ? `?parentId=${parentId}` : '';
      const res = await request({ url: `/api/folders${params}` });
      this.setData({
        folders: res.folders || [],
        currentParentId: parentId,
        folderPath: res.path || []
      });
    } catch (_) {
      this.setData({ folders: [], folderPath: [] });
    }
  },

  enterFolder(e) {
    const id = e.currentTarget.dataset.id || null;
    this.loadFolders(id);
  },

  clearFilter() {
    this.setData({ selectedSubject: '', filteredCourses: this.data.courses });
  },

  retry() {
    this.setData({ loadError: null, loading: true });
    this.loadCourses(true);
  },

  goDetail(e) {
    const courseId = e.currentTarget.dataset.id;
    if (!courseId) return;
    wx.navigateTo({ url: `/pages/courses/detail?id=${courseId}` });
  }
});
