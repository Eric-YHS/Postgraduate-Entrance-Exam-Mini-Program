import { checkPermission, guardPermission } from './permission';
import { FeatureCode } from '../constants/index';
import type { CourseChapter, CourseDetail, CourseVideo } from '../types/course';

/** 判断某视频是否可以播放 */
export function canPlayVideo(video: CourseVideo, course: CourseDetail): boolean {
  // 免费课程：全部可播放
  if (course.isFree) return true;

  // 已购买课程：全部可播放
  if (course.isPurchased) return true;

  // 试看视频：需要试看权限
  if (video.isTrial) {
    return checkPermission(FeatureCode.COURSE_TRIAL);
  }

  // 完整视频：需要完整权限（无权限时会弹窗）
  return guardPermission(FeatureCode.COURSE_FULL);
}

/** 获取视频播放前的阻断原因，返回 null 表示可以播放 */
export function getPlayBlockReason(video: CourseVideo, course: CourseDetail): string | null {
  if (course.isFree || course.isPurchased) return null;
  if (video.isTrial) return null;
  return '该视频需要购买课程或开通会员后观看';
}

/** 判断是否为试看视频 */
export function isTrialVideo(video: CourseVideo, course: CourseDetail): boolean {
  if (course.isFree || course.isPurchased) return false;
  return video.isTrial;
}

/** 获取试看限制时长（秒），未限制返回 0 */
export function getTrialLimit(video: CourseVideo, course: CourseDetail): number {
  if (!isTrialVideo(video, course)) return 0;
  return video.trialDuration || 0;
}

/** 格式化试看时长提示 */
export function formatTrialLimit(seconds: number): string {
  if (seconds <= 0) return '可试看';
  if (seconds < 60) return `试看 ${seconds} 秒`;
  return `试看 ${Math.floor(seconds / 60)} 分钟`;
}

/** 判断视频是否已被试看/完整解锁 */
export function isVideoUnlocked(video: CourseVideo, course: CourseDetail): boolean {
  if (course.isFree || course.isPurchased) return true;
  return video.isTrial;
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

/** 格式化价格（分 → 元） */
export function formatPrice(price: number): string {
  return (price / 100).toFixed(2);
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
