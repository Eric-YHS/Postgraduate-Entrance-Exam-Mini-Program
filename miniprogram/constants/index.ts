import { UserLevel } from '../types/user';

/** 本地存储 Key */
export enum StorageKey {
  TOKEN = 'ky_token',
  REFRESH_TOKEN = 'ky_refresh_token',
  TOKEN_EXPIRES = 'ky_token_expires',
  USER_PROFILE = 'ky_user_profile',
  APP_LAUNCH_COUNT = 'ky_app_launch_count',
}

/** 功能权限码 */
export enum FeatureCode {
  LIVE_WATCH = 'live:watch',
  LIVE_REPLAY = 'live:replay',
  COURSE_TRIAL = 'course:trial',
  COURSE_FULL = 'course:full',
  QUESTION_BANK = 'question:bank',
  FREE_ZONE = 'free:zone',
  PAID_ZONE = 'paid:zone',
  STUDY_PLAN = 'study:plan',
  FORUM_POST = 'forum:post',
  WRONG_BOOK = 'wrong:book',
  TRIAL_ZONE = 'trial:zone',
}

/** 用户等级配置 */
export const USER_LEVEL_CONFIG: Record<UserLevel, { label: string; color: string; bg: string }> = {
  [UserLevel.FREE]: { label: '免费学员', color: '#1D9E75', bg: '#E1F5EE' },
  [UserLevel.TRIAL]: { label: '7天体验', color: '#EF9F27', bg: '#FAEEDA' },
  [UserLevel.PAID]: { label: '付费学员', color: '#E24B4A', bg: '#FCEBEB' },
};

/** 功能权限映射：各等级用户可访问的功能 */
export const FEATURE_PERMISSION_MAP: Record<FeatureCode, UserLevel[]> = {
  [FeatureCode.QUESTION_BANK]: [UserLevel.FREE, UserLevel.TRIAL, UserLevel.PAID],
  [FeatureCode.FREE_ZONE]: [UserLevel.FREE, UserLevel.TRIAL, UserLevel.PAID],
  [FeatureCode.COURSE_TRIAL]: [UserLevel.FREE, UserLevel.TRIAL, UserLevel.PAID],
  [FeatureCode.TRIAL_ZONE]: [UserLevel.TRIAL, UserLevel.PAID],
  [FeatureCode.COURSE_FULL]: [UserLevel.TRIAL, UserLevel.PAID],
  [FeatureCode.PAID_ZONE]: [UserLevel.TRIAL, UserLevel.PAID],
  [FeatureCode.STUDY_PLAN]: [UserLevel.TRIAL, UserLevel.PAID],
  [FeatureCode.WRONG_BOOK]: [UserLevel.TRIAL, UserLevel.PAID],
  [FeatureCode.LIVE_WATCH]: [UserLevel.TRIAL, UserLevel.PAID],
  [FeatureCode.LIVE_REPLAY]: [UserLevel.TRIAL, UserLevel.PAID],
  [FeatureCode.FORUM_POST]: [UserLevel.TRIAL, UserLevel.PAID],
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
