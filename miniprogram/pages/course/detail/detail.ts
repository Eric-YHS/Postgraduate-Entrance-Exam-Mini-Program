import { getCourseDetail } from '../../../services/course.service';
import { getCourseProgress } from '../../../utils/study-progress';
import type { CourseDetail } from '../../../types/course';

Page({
  data: {
    courseId: '',
    detail: null as CourseDetail | null,
    progressMap: {} as Record<string, { percent: number }>,
    loading: false,
    error: false,
  },

  onLoad(options) {
    const courseId = options.id || '';
    this.setData({ courseId });
    this.loadCourseDetail(courseId);
  },

  async loadCourseDetail(courseId: string) {
    if (!courseId) {
      this.setData({ error: true, loading: false });
      return;
    }

    this.setData({ loading: true, error: false });

    try {
      const detail = await getCourseDetail(courseId);
      if (!detail) {
        this.setData({ loading: false, error: true });
        return;
      }

      const videoIds = detail.chapters.flatMap((chapter) => chapter.videos.map((v) => v.id));
      const progressMap = getCourseProgress(videoIds);

      this.setData({
        detail,
        progressMap,
        loading: false,
      });
    } catch (err) {
      console.error('[CourseDetail] 加载课程详情失败', err);
      this.setData({ loading: false, error: true });
    }
  },

  onRetry() {
    this.loadCourseDetail(this.data.courseId);
  },

  onVideoTap(e: WechatMiniprogram.CustomEvent) {
    const { videoId, chapterId } = e.detail as { videoId: string; chapterId: string };
    const { detail } = this.data;
    if (!detail) return;

    const chapter = detail.chapters.find((c) => c.id === chapterId);
    const video = chapter?.videos.find((v) => v.id === videoId);
    if (!video) return;

    wx.navigateTo({
      url: `/pages/course/video/video?courseId=${detail.id}&videoId=${videoId}&chapterId=${chapterId}`,
    });
  },

  onStartLearning() {
    const { detail } = this.data;
    if (!detail?.chapters.length) return;

    const firstChapter = detail.chapters[0];
    const firstVideo = firstChapter.videos[0];
    if (!firstVideo) return;

    wx.navigateTo({
      url: `/pages/course/video/video?courseId=${detail.id}&videoId=${firstVideo.id}&chapterId=${firstChapter.id}`,
    });
  },
});
