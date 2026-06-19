/**
 * 本地存储 Key 集中管理
 * 避免分散 hard code，减少 Key 冲突风险
 */
export enum StorageKey {
  /** 访问令牌 */
  TOKEN = 'ky_token',
  /** 刷新令牌 */
  REFRESH_TOKEN = 'ky_refresh_token',
  /** 令牌过期时间戳 */
  TOKEN_EXPIRES = 'ky_token_expires',
  /** 用户资料 */
  USER_PROFILE = 'ky_user_profile',
  /** 应用启动次数 */
  APP_LAUNCH_COUNT = 'ky_app_launch_count',
  /** 搜索历史 */
  SEARCH_HISTORY = 'ky_search_history',
  /** 学习进度 */
  STUDY_PROGRESS = 'ky_study_progress',
  /** 学习进度同步标记 */
  STUDY_PROGRESS_SYNCED = 'ky_study_progress_synced',
  /** 错题本 */
  WRONG_BOOK = 'ky_wrong_book',
  /** 练习答题记录 */
  PRACTICE_RECORDS = 'ky_practice_records',
}
