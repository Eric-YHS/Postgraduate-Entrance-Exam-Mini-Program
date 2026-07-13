import type { UserProfile } from '../../types/user';
import { UserLevel } from '../../types/user';

/** 当前模拟用户使用免费开放身份 */
export const CURRENT_MOCK_USER_LEVEL: UserLevel = UserLevel.FREE;

export const mockUser: UserProfile = {
  id: 'user_001',
  openId: 'mock_openid_001',
  nickname: '考研小白',
  avatarUrl: '/assets/images/avatar-placeholder.svg',
  phone: '13800138000',
  level: CURRENT_MOCK_USER_LEVEL,
  targetSchool: '北京大学',
  targetMajor: '计算机科学与技术',
  createdAt: '2026-01-01T00:00:00.000Z',
};
