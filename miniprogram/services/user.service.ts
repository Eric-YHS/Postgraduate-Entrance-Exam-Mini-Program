import { get } from '../utils/request';
import { ApiEndpoints } from './api-types';
import type { UserProfile } from '../types/user';

/** 获取当前用户信息 */
export function getUserProfile(): Promise<UserProfile> {
  return get<UserProfile>(ApiEndpoints.USER_PROFILE);
}
