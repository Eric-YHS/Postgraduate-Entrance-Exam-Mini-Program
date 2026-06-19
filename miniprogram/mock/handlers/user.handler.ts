import type { LoginResponse, UserProfile } from '../../types/user';
import { mockUser } from '../data/user';

export function mockLogin(code: string): Promise<LoginResponse> {
  return Promise.resolve({
    token: `mock_token_${code.slice(0, 8)}`,
    refreshToken: `mock_refresh_${code.slice(0, 8)}`,
    expiresIn: 7200,
    user: mockUser,
  });
}

export function mockGetUserProfile(): Promise<UserProfile> {
  return Promise.resolve(mockUser);
}
