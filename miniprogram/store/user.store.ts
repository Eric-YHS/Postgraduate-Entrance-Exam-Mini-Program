import { createStore } from './index';
import { UserLevel } from '../types/user';
import type { UserProfile } from '../types/user';
import { mockGetUserProfile } from '../mock/handlers/user.handler';

interface UserState {
  profile: UserProfile | null;
  isLoading: boolean;
}

const initialState: UserState = {
  profile: null,
  isLoading: false,
};

export const userStore = createStore<UserState>(initialState);

/** 设置用户信息 */
export function setUserProfile(profile: UserProfile): void {
  userStore.setState({ profile });
}

/** 刷新用户信息（从 Mock 或后端获取） */
export async function refreshUserInfo(): Promise<UserProfile | null> {
  userStore.setState({ isLoading: true });
  try {
    const profile = await mockGetUserProfile();
    userStore.setState({ profile, isLoading: false });
    return profile;
  } catch (err) {
    userStore.setState({ isLoading: false });
    console.error('[UserStore] 刷新用户信息失败', err);
    return null;
  }
}

/** 获取当前用户等级 */
export function getCurrentUserLevel(): UserLevel {
  return userStore.getState().profile?.level || UserLevel.FREE;
}

/** 判断当前用户是否已登录 */
export function isLoggedIn(): boolean {
  return userStore.getState().profile !== null;
}
