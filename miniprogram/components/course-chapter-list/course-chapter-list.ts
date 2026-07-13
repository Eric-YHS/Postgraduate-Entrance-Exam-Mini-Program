import { formatDuration } from '../../utils/course';
import type { CourseChapter, CourseDetail, CourseVideo } from '../../types/course';

type DisplayVideo = CourseVideo & {
  durationText: string;
  progressPercent: number;
  showProgress: boolean;
  completed: boolean;
};

type DisplayChapter = Omit<CourseChapter, 'videos'> & {
  videos: DisplayVideo[];
};

interface ChapterListData {
  expandedChapters: Record<string, boolean>;
  displayChapters: DisplayChapter[];
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
    displayChapters: [] as DisplayChapter[],
  },

  lifetimes: {
    attached() {
      this.expandFirstChapter();
      this.buildDisplayChapters();
    },
  },

  observers: {
    course() {
      this.expandFirstChapter();
      this.buildDisplayChapters();
    },
    progressMap() {
      this.buildDisplayChapters();
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

    buildDisplayChapters() {
      const { course, progressMap } = this.data as unknown as ChapterListData & ChapterListProperties;
      const displayChapters = (course?.chapters || []).map((chapter) => ({
        ...chapter,
        videos: chapter.videos.map((video) => {
          const progressPercent = progressMap[video.id]?.percent || 0;
          return {
            ...video,
            durationText: formatDuration(video.duration),
            progressPercent,
            showProgress: progressPercent > 0 && progressPercent < 100,
            completed: progressPercent >= 100,
          };
        }),
      }));
      this.setData({ displayChapters });
    },
  },
});
