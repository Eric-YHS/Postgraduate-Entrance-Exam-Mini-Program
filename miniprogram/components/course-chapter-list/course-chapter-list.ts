import { formatDuration, formatTrialLimit, getTrialLimit, isVideoUnlocked } from '../../utils/course';
import type { CourseDetail, CourseVideo } from '../../types/course';

interface ChapterListData {
  expandedChapters: Record<string, boolean>;
}

interface ChapterListProperties {
  course: CourseDetail | null;
  progressMap: Record<string, { percent: number }>;
}

Component({
  properties: {
    course: {
      type: Object,
      value: undefined,
    },
    progressMap: {
      type: Object,
      value: {},
    },
  },

  data: {
    expandedChapters: {} as Record<string, boolean>,
  },

  lifetimes: {
    attached() {
      this.expandFirstChapter();
    },
  },

  observers: {
    course() {
      this.expandFirstChapter();
    },
  },

  methods: {
    expandFirstChapter() {
      const course = (this.data as unknown as ChapterListData & ChapterListProperties).course;
      if (course?.chapters?.length && Object.keys(this.data.expandedChapters).length === 0) {
        const firstChapterId = course.chapters[0].id;
        this.setData({
          expandedChapters: { [firstChapterId]: true },
        });
      }
    },

    onChapterTap(e: WechatMiniprogram.BaseEvent) {
      const { id } = e.currentTarget.dataset;
      const { expandedChapters } = this.data as ChapterListData;
      this.setData({
        expandedChapters: { ...expandedChapters, [id]: !expandedChapters[id] },
      });
    },

    onVideoTap(e: WechatMiniprogram.BaseEvent) {
      const { videoId, chapterId } = e.currentTarget.dataset;
      this.triggerEvent('videotap', { videoId, chapterId });
    },

    formatDuration(seconds: number): string {
      return formatDuration(seconds);
    },

    formatTrialTag(video: CourseVideo, course: CourseDetail): string {
      return formatTrialLimit(getTrialLimit(video, course));
    },

    isUnlocked(video: CourseVideo, course: CourseDetail): boolean {
      return isVideoUnlocked(video, course);
    },

    getProgressPercent(videoId: string): number {
      const progressMap = (this.data as unknown as ChapterListData & ChapterListProperties).progressMap;
      return progressMap[videoId]?.percent || 0;
    },
  },
});
