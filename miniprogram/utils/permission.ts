import { UserLevel } from '../types/user';
import { FeatureCode, FEATURE_PERMISSION_MAP, USER_LEVEL_CONFIG } from '../constants/index';
import { getUserProfile } from './auth';

/** 获取当前用户等级 */
export function getCurrentLevel(): UserLevel {
  const user = getUserProfile();
  return user?.level || UserLevel.FREE;
}

/** 判断是否为付费用户 */
export function isPaidUser(): boolean {
  return getCurrentLevel() === UserLevel.PAID;
}

/** 判断是否为体验用户（且未过期） */
export function isTrialUser(): boolean {
  const user = getUserProfile();
  if (user?.level !== UserLevel.TRIAL) return false;
  if (!user.trialEndTime) return false;
  return new Date(user.trialEndTime).getTime() > Date.now();
}

/** 判断体验是否已过期 */
export function isTrialExpired(): boolean {
  const user = getUserProfile();
  if (user?.level !== UserLevel.TRIAL) return false;
  if (!user.trialEndTime) return true;
  return new Date(user.trialEndTime).getTime() <= Date.now();
}

/** 检查是否拥有某功能权限 */
export function checkPermission(feature: FeatureCode): boolean {
  const level = getCurrentLevel();

  // 体验用户先检查是否过期
  if (level === UserLevel.TRIAL && isTrialExpired()) {
    return false;
  }

  const allowedLevels = FEATURE_PERMISSION_MAP[feature] || [];
  return allowedLevels.includes(level);
}

/** 获取用户等级配置（标签、颜色） */
export function getLevelConfig(level?: UserLevel) {
  const targetLevel = level || getCurrentLevel();
  return USER_LEVEL_CONFIG[targetLevel];
}

/** 页面级权限守卫：无权限时跳转引导页 */
export function guardPermission(feature: FeatureCode): boolean {
  const hasPermission = checkPermission(feature);
  if (!hasPermission) {
    wx.showModal({
      title: '功能受限',
      content: '该功能需要开通会员或体验权限，是否前往了解？',
      showCancel: true,
      cancelText: '暂不',
      confirmText: '去开通',
      success: (res) => {
        if (res.confirm) {
          // TODO: 跳转到会员开通页
          wx.showToast({
            title: '会员功能开发中',
            icon: 'none',
          });
        }
      },
    });
  }
  return hasPermission;
}
