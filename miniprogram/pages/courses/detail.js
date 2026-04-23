const { request, resolveUrl } = require('../../utils/request');
const { ensureLogin } = require('../../utils/auth');

Page({
  data: {
    loading: true,
    courseId: null,
    course: null,
    playPosition: 0,
    progressPercent: 0,
    progressText: '加载中',
    notes: [],
    noteContent: '',
    savingNote: false,
    _lastSave: 0,
    _duration: 0
  },

  onLoad(options) {
    if (!ensureLogin()) return;
    const courseId = options.id;
    if (!courseId) {
      wx.showToast({ title: '课程不存在', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1500);
      return;
    }
    this.setData({ courseId });
    this.loadCourse(courseId);
    this.loadProgress(courseId);
    this.loadNotes(courseId);
  },

  async loadCourse(courseId) {
    try {
      const course = await request({ url: `/api/courses/${courseId}` });
      course.videoSrc = resolveUrl(course.videoPath) || resolveUrl(course.videoUrl);
      wx.setNavigationBarTitle({ title: course.title || '课程详情' });
      this.setData({ course, loading: false });
    } catch (error) {
      this.setData({ loading: false });
      wx.showToast({ title: error.message, icon: 'none' });
    }
  },

  async loadProgress(courseId) {
    try {
      const data = await request({ url: `/api/courses/${courseId}/progress` });
      const position = data.positionSeconds || 0;
      const duration = data.durationSeconds || 0;
      const percent = duration > 0 ? Math.round(position / duration * 100) : 0;
      this.setData({
        playPosition: position,
        _duration: duration,
        progressPercent: percent,
        progressText: percent > 0 ? `${percent}% 已观看` : '未开始'
      });
    } catch (e) {
      console.warn('进度加载失败:', e);
    }
  },

  async loadNotes(courseId) {
    try {
      const data = await request({ url: `/api/courses/${courseId}/notes` });
      this.setData({ notes: data.notes || [] });
    } catch (e) {
      console.warn('笔记加载失败:', e);
    }
  },

  onTimeUpdate(e) {
    const { currentTime, duration } = e.detail;
    if (!duration) return;

    const now = Date.now();
    if (this.data._lastSave && now - this.data._lastSave < 30000) return;

    const courseId = this.data.courseId;
    if (!courseId) return;

    this._lastSave = now;
    const percent = Math.round(currentTime / duration * 100);
    this.setData({ progressPercent: percent, progressText: `${percent}% 已观看` });

    request({
      url: `/api/courses/${courseId}/progress`,
      method: 'POST',
      data: {
        positionSeconds: Math.floor(currentTime),
        durationSeconds: Math.floor(duration)
      }
    }).catch(() => {});
  },

  onVideoEnded() {
    this.setData({ progressPercent: 100, progressText: '已完成' });
    const courseId = this.data.courseId;
    if (courseId) {
      request({
        url: `/api/courses/${courseId}/progress`,
        method: 'POST',
        data: { positionSeconds: Math.floor(this.data._duration), durationSeconds: Math.floor(this.data._duration) }
      }).catch(() => {});
    }
  },

  onVideoPlay() {},

  onNoteInput(e) {
    this.setData({ noteContent: e.detail.value });
  },

  async saveNote() {
    const content = (this.data.noteContent || '').trim();
    if (!content) {
      wx.showToast({ title: '请输入笔记内容', icon: 'none' });
      return;
    }

    this.setData({ savingNote: true });
    try {
      await request({
        url: `/api/courses/${this.data.courseId}/notes`,
        method: 'POST',
        data: { content }
      });
      wx.showToast({ title: '笔记已保存', icon: 'success' });
      this.setData({ noteContent: '' });
      this.loadNotes(this.data.courseId);
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' });
    } finally {
      this.setData({ savingNote: false });
    }
  }
});
