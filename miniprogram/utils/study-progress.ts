import { getStorageSync, setStorageSync } from './storage';
import { StorageKey } from '../constants/storage-keys';

export interface StudyProgressItem {
  currentTime: number;
  duration: number;
  percent: number;
  updatedAt: string;
}

type StudyProgressMap = Record<string, StudyProgressItem>;

const PROGRESS_KEY = StorageKey.STUDY_PROGRESS;

/** 获取全部学习进度 */
function getAllProgress(): StudyProgressMap {
  return getStorageSync<StudyProgressMap>(PROGRESS_KEY) || {};
}

/** 保存全部学习进度 */
function saveAllProgress(progress: StudyProgressMap): void {
  setStorageSync(PROGRESS_KEY, progress);
}

/** 获取某视频的学习进度 */
export function getStudyProgress(videoId: string): StudyProgressItem | null {
  const all = getAllProgress();
  return all[videoId] || null;
}

/** 保存学习进度 */
export function saveStudyProgress(videoId: string, courseId: string, currentTime: number, duration: number): void {
  const all = getAllProgress();
  const percent = duration > 0 ? Math.min(100, Math.floor((currentTime / duration) * 100)) : 0;

  all[videoId] = {
    currentTime: Math.floor(currentTime),
    duration: Math.floor(duration),
    percent,
    updatedAt: new Date().toISOString(),
  };

  saveAllProgress(all);

  // TODO: 标记为未同步，待网络恢复时批量上报后端
  void courseId;
}

/** 标记视频已完成 */
export function markVideoCompleted(videoId: string, courseId: string, duration: number): void {
  saveStudyProgress(videoId, courseId, duration, duration);
}

/** 获取某课程下多个视频的学习进度 */
export function getCourseProgress(videoIds: string[]): Record<string, StudyProgressItem> {
  const all = getAllProgress();
  const result: Record<string, StudyProgressItem> = {};
  for (const id of videoIds) {
    if (all[id]) {
      result[id] = all[id];
    }
  }
  return result;
}

/** 获取课程整体学习进度百分比 */
export function getCourseOverallProgress(videoIds: string[]): number {
  if (videoIds.length === 0) return 0;
  const progressMap = getCourseProgress(videoIds);
  const totalPercent = videoIds.reduce((sum, id) => {
    return sum + (progressMap[id]?.percent || 0);
  }, 0);
  return Math.floor(totalPercent / videoIds.length);
}
