import { userStore, refreshUserInfo } from '../../../store/user.store';
import type { UserProfile } from '../../../types/user';
import { ONLINE_COURSE_FEATURE_ENABLED } from '../../../config/release';

Page({
  data: {
    user: null as UserProfile | null,
    onlineCoursesVisible: ONLINE_COURSE_FEATURE_ENABLED,
    menuGroups: [
      {
        title: '学习工具',
        items: [
          { icon: '📝', name: '我的题库', path: '/pages/question/practice/practice' },
          { icon: '📚', name: '错题本', path: '/pages/question/wrong-book/wrong-book' },
          { icon: '📅', name: '学习计划', path: '/pages/plan/index/index' },
        ],
      },
      {
        title: '学习支持',
        items: [{ icon: '💬', name: '在线答疑', path: '/pages/support/qa/qa' }],
      },
      {
        title: '系统设置',
        items: [
          { icon: '⚙️', name: '设置', path: '/pages/user/settings/settings' },
          { icon: '❓', name: '帮助与反馈', path: '/pages/user/help/help' },
        ],
      },
    ],
  },

  unsubscribe: null as (() => void) | null,

  onLoad() {
    this.setData({ user: userStore.getState().profile });

    this.unsubscribe = userStore.subscribe((state: { profile: UserProfile | null }) => {
      const user = state.profile;
      this.setData({ user });
    });

    refreshUserInfo();
  },

  onUnload() {
    if (this.unsubscribe) {
      this.unsubscribe();
    }
  },

  onMenuTap(e: WechatMiniprogram.BaseEvent) {
    const path = String(e.currentTarget.dataset.path || '');
    if (!path) return;
    wx.navigateTo({
      url: path,
      fail: () => wx.showToast({ title: '页面打开失败', icon: 'none' }),
    });
  },

  onLevelTap() {
    wx.showModal({
      title: '免费开放',
      content: '当前开放的学习计划、题库和交流功能均免费开放，不设付费入口。',
      showCancel: false,
      confirmText: '知道了',
    });
  },
});
