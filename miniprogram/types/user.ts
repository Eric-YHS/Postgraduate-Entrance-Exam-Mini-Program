import type { ListItem } from './common';

/** 用户等级 */
export enum UserLevel {
  FREE = 'free',
  TRIAL = 'trial',
  PAID = 'paid',
}

/** 用户资料 */
export interface UserProfile extends ListItem {
  openId: string;
  unionId?: string;
  nickname: string;
  avatarUrl: string;
  phone?: string;
  level: UserLevel;
  trialEndTime?: string;
  targetSchool?: string;
  targetMajor?: string;
  purchasedCourses: string[];
}

/** 用户登录响应 */
export interface LoginResponse {
  token: string;
  expiresIn: number;
  refreshToken: string;
  user: UserProfile;
}

/** 微信用户信息（授权获取） */
export interface WechatUserInfo {
  nickName: string;
  avatarUrl: string;
  gender: number;
  province: string;
  city: string;
  country: string;
}
