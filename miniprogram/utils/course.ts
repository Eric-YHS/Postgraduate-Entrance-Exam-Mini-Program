import type { CourseChapter, CourseDetail, CourseVideo } from '../types/course';

/** 判断某视频是否可以播放 */
export function canPlayVideo(_video: CourseVideo, _course: CourseDetail): boolean {
  return true;
}

/** 获取视频播放前的阻断原因，返回 null 表示可以播放 */
export function getPlayBlockReason(_video: CourseVideo, _course: CourseDetail): string | null {
  return null;
}

/** 获取课程总视频数 */
export function getCourseTotalVideos(course: CourseDetail): number {
  return course.chapters.reduce((sum, chapter) => sum + chapter.videos.length, 0);
}

/** 获取课程总时长（秒） */
export function getCourseTotalDuration(course: CourseDetail): number {
  return course.chapters.reduce((sum, chapter) => sum + chapter.videos.reduce((s, v) => s + (v.duration || 0), 0), 0);
}

/** 获取下一节视频 */
export function getNextVideo(
  course: CourseDetail,
  videoId: string
): { chapter: CourseChapter; video: CourseVideo } | null {
  for (let i = 0; i < course.chapters.length; i++) {
    const chapter = course.chapters[i];
    const index = chapter.videos.findIndex((v) => v.id === videoId);
    if (index >= 0) {
      if (index < chapter.videos.length - 1) {
        return { chapter, video: chapter.videos[index + 1] };
      }
      if (i < course.chapters.length - 1) {
        const nextChapter = course.chapters[i + 1];
        if (nextChapter.videos.length > 0) {
          return { chapter: nextChapter, video: nextChapter.videos[0] };
        }
      }
    }
  }
  return null;
}

/** 获取上一节视频 */
export function getPrevVideo(
  course: CourseDetail,
  videoId: string
): { chapter: CourseChapter; video: CourseVideo } | null {
  for (let i = 0; i < course.chapters.length; i++) {
    const chapter = course.chapters[i];
    const index = chapter.videos.findIndex((v) => v.id === videoId);
    if (index >= 0) {
      if (index > 0) {
        return { chapter, video: chapter.videos[index - 1] };
      }
      if (i > 0) {
        const prevChapter = course.chapters[i - 1];
        if (prevChapter.videos.length > 0) {
          return { chapter: prevChapter, video: prevChapter.videos[prevChapter.videos.length - 1] };
        }
      }
    }
  }
  return null;
}

/** 格式化时长（秒 → mm:ss 或 HH:mm:ss） */
export function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '00:00';

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const pad = (n: number) => String(n).padStart(2, '0');

  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
  }
  return `${pad(minutes)}:${pad(secs)}`;
}
