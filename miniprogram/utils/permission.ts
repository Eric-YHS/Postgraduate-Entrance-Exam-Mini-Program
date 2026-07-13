import { UserLevel } from '../types/user';
import { USER_LEVEL_CONFIG } from '../constants/index';

/** 获取当前用户等级 */
export function getCurrentLevel(): UserLevel {
  return UserLevel.FREE;
}

/** 检查是否拥有某功能权限 */
export function checkPermission(_feature?: string): boolean {
  return true;
}

/** 获取用户等级配置（标签、颜色） */
export function getLevelConfig(level?: UserLevel) {
  void level;
  return USER_LEVEL_CONFIG[UserLevel.FREE];
}

/** 页面级权限守卫：免费模式下始终允许访问 */
export function guardPermission(_feature?: string): boolean {
  return true;
}
