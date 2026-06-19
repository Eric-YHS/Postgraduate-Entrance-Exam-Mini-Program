import { getCourseDetail } from '../../../services/course.service';
import {
  canPlayVideo,
  formatDuration,
  formatTrialLimit,
  getTrialLimit,
  isTrialVideo,
  isVideoUnlocked,
} from '../../../utils/course';
import { getStudyProgress, saveStudyProgress, markVideoCompleted } from '../../../utils/study-progress';
import type { CourseDetail, CourseVideo, CourseChapter } from '../../../types/course';

// 节流函数
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function throttle<T extends (...args: any[]) => void>(fn: T, delay: number): T {
  let lastTime = 0;
  return function (...args: Parameters<T>) {
    const now = Date.now();
    if (now - lastTime >= delay) {
      lastTime = now;
      fn(...args);
    }
  } as T;
}

Page({
  data: {
    courseId: '',
    videoId: '',
    course: null as CourseDetail | null,
    currentVideo: null as CourseVideo | null,
    currentChapter: null as CourseChapter | null,
    videoUrl: '',
    poster: '',
    totalVideos: 0,
    loading: false,
    error: false,
    currentTime: 0,
    duration: 0,
    showPlaylist: false,
    isTrialMode: false,
    trialLimit: 0,
    trialStopped: false,
  },

  videoContext: null as WechatMiniprogram.VideoContext | null,
  hasLoaded: false,

  onLoad(options) {
    const courseId = options.courseId || '';
    const videoId = options.videoId || '';
    const chapterId = options.chapterId || '';

    this.setData({ courseId, videoId });
    this.videoContext = wx.createVideoContext('courseVideo');
    this.loadCourseAndPlay(courseId, videoId, chapterId);
  },

  async loadCourseAndPlay(courseId: string, videoId: string, chapterId: string) {
    if (!courseId || !videoId) {
      this.setData({ error: true, loading: false });
      return;
    }

    this.setData({ loading: true, error: false });

    try {
      const course = await getCourseDetail(courseId);
      if (!course) {
        this.setData({ loading: false, error: true });
        return;
      }

      const chapter = course.chapters.find((c) => c.id === chapterId);
      const video = chapter?.videos.find((v) => v.id === videoId);

      if (!video) {
        this.setData({ loading: false, error: true });
        wx.showToast({ title: '视频不存在', icon: 'none' });
        return;
      }

      // 权限校验
      if (!canPlayVideo(video, course)) {
        this.setData({ loading: false });
        setTimeout(() => wx.navigateBack(), 1500);
        return;
      }

      // 读取历史进度
      const progress = getStudyProgress(videoId);
      const startTime = progress ? progress.currentTime : 0;

      const totalVideos = course.chapters.reduce((sum, chapter) => sum + chapter.videos.length, 0);

      const isTrialMode = isTrialVideo(video, course);
      const trialLimit = getTrialLimit(video, course);

      this.setData({
        course,
        currentVideo: video,
        currentChapter: chapter || null,
        videoUrl: video.videoUrl,
        poster: course.coverUrl,
        totalVideos,
        loading: false,
        isTrialMode,
        trialLimit,
        trialStopped: false,
      });

      this.hasLoaded = true;

      // 如果有历史进度，seek 到对应位置
      if (startTime > 0 && startTime < video.duration - 5) {
        setTimeout(() => {
          this.videoContext?.seek(startTime);
        }, 500);
      }
    } catch (err) {
      console.error('[VideoPlayer] 加载失败', err);
      this.setData({ loading: false, error: true });
    }
  },

  onReady() {
    this.videoContext = wx.createVideoContext('courseVideo');
  },

  onPlay() {
    console.log('[VideoPlayer] 开始播放');
  },

  onPause() {
    console.log('[VideoPlayer] 暂停播放');
    this.saveProgress();
  },

  onEnded() {
    console.log('[VideoPlayer] 播放结束');
    const { videoId, courseId, duration } = this.data;
    if (videoId && courseId) {
      markVideoCompleted(videoId, courseId, duration || 0);
    }
    wx.showToast({ title: '本节已学完', icon: 'success' });
  },

  onTimeUpdate(e: WechatMiniprogram.VideoTimeUpdate) {
    const { currentTime, duration } = e.detail;
    this.setData({ currentTime, duration });

    // 试看时长限制
    if (this.data.isTrialMode && !this.data.trialStopped && this.data.trialLimit > 0) {
      if (currentTime >= this.data.trialLimit) {
        this.handleTrialLimitReached();
        return;
      }
    }

    this.throttledSave(currentTime, duration, this.data.videoId, this.data.courseId);
  },

  handleTrialLimitReached() {
    this.setData({ trialStopped: true });
    this.videoContext?.pause();
    this.videoContext?.seek(this.data.trialLimit);

    wx.showModal({
      title: '试看结束',
      content: '试看时长已用完，购买课程或开通会员即可观看完整内容',
      confirmText: '去购买',
      cancelText: '知道了',
      success: (res) => {
        if (res.confirm) {
          // TODO: 跳转购买页
          wx.showToast({ title: '购买功能开发中', icon: 'none' });
        }
      },
    });
  },

  throttledSave: throttle((currentTime: number, duration: number, videoId: string, courseId: string) => {
    if (videoId && courseId) {
      saveStudyProgress(videoId, courseId, currentTime, duration);
    }
  }, 5000),

  onError(e: WechatMiniprogram.VideoError) {
    console.error('[VideoPlayer] 播放错误', e.detail.errMsg);
    wx.showToast({ title: '视频播放失败', icon: 'none' });
  },

  onWaiting() {
    console.log('[VideoPlayer] 缓冲中...');
  },

  onFullScreenChange(e: WechatMiniprogram.VideoFullScreenChange) {
    console.log('[VideoPlayer] 全屏状态变化', e.detail.fullScreen);
  },

  onUnload() {
    this.saveProgress();
  },

  saveProgress() {
    const { videoId, courseId, currentTime, duration } = this.data;
    if (videoId && courseId && this.hasLoaded) {
      saveStudyProgress(videoId, courseId, currentTime, duration || 0);
    }
  },

  onRetry() {
    const { courseId, videoId, currentChapter } = this.data;
    this.loadCourseAndPlay(courseId, videoId, currentChapter?.id || '');
  },

  onTogglePlaylist() {
    this.setData({ showPlaylist: !this.data.showPlaylist });
  },

  onSwitchVideo(e: WechatMiniprogram.BaseEvent) {
    const { videoId, chapterId } = e.currentTarget.dataset;
    const { course } = this.data;
    if (!course) return;

    const chapter = course.chapters.find((c) => c.id === chapterId);
    const video = chapter?.videos.find((v) => v.id === videoId);
    if (!video) return;

    if (!canPlayVideo(video, course)) {
      wx.showToast({ title: '该视频需要购买后观看', icon: 'none' });
      return;
    }

    // 保存当前视频进度
    this.saveProgress();

    const isTrialMode = isTrialVideo(video, course);
    const trialLimit = getTrialLimit(video, course);

    // 切换视频
    this.setData({
      videoId,
      currentVideo: video,
      currentChapter: chapter || null,
      videoUrl: video.videoUrl,
      currentTime: 0,
      duration: 0,
      showPlaylist: false,
      isTrialMode,
      trialLimit,
      trialStopped: false,
    });

    // 读取新视频历史进度
    const progress = getStudyProgress(videoId);
    const startTime = progress ? progress.currentTime : 0;
    if (startTime > 0 && startTime < video.duration - 5) {
      setTimeout(() => {
        this.videoContext?.seek(startTime);
      }, 300);
    }
  },

  formatDuration(seconds: number): string {
    return formatDuration(seconds);
  },

  isVideoUnlocked(video: CourseVideo, course: CourseDetail): boolean {
    return isVideoUnlocked(video, course);
  },

  formatTrialTag(video: CourseVideo, course: CourseDetail): string {
    const limit = getTrialLimit(video, course);
    return formatTrialLimit(limit);
  },
});
