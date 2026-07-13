import { UserLevel } from '../types/user';

/** 本地存储 Key */
export enum StorageKey {
  TOKEN = 'ky_token',
  REFRESH_TOKEN = 'ky_refresh_token',
  TOKEN_EXPIRES = 'ky_token_expires',
  USER_PROFILE = 'ky_user_profile',
  APP_LAUNCH_COUNT = 'ky_app_launch_count',
}

/** 用户等级配置 */
export const USER_LEVEL_CONFIG: Record<UserLevel, { label: string; color: string; bg: string }> = {
  [UserLevel.FREE]: { label: '免费开放', color: '#1D9E75', bg: '#E1F5EE' },
};

/** 学科映射 */
export const SUBJECT_MAP: Record<string, string> = {
  politics: '政治',
  english: '英语',
  math: '数学',
};

/** 专业方向映射 */
export const MAJOR_MAP: Record<string, string> = {
  computer: '计算机',
  finance: '金融',
  law: '法律',
  education: '教育学',
  medicine: '医学',
  art: '艺术',
};

/** 课程分类映射 */
export const COURSE_CATEGORY_MAP: Record<string, string> = {
  public: '公共课',
  professional: '专业课',
};
