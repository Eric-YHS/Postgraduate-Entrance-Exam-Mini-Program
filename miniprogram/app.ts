import { userStore, refreshUserInfo } from './store/user.store';
import { initializeAuth } from './utils/auth';

App({
  globalData: {
    userStore,
  },

  onLaunch() {
    console.log('[App] 小程序启动');
    this.initialize();
  },

  onShow() {
    // 每次展示时刷新用户信息
    refreshUserInfo().catch((err: unknown) => {
      console.warn('[App] 刷新用户信息失败', err);
    });
  },

  async initialize() {
    try {
      // 初始化登录态
      await initializeAuth();
      console.log('[App] 登录态初始化完成');
    } catch (err: unknown) {
      console.error('[App] 初始化失败', err);
    }
  },
});
