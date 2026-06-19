import { userStore, refreshUserInfo } from '../../../store/user.store';
import { UserLevel } from '../../../types/user';
import type { UserProfile } from '../../../types/user';
import { getRemainingDays } from '../../../utils/date';

Page({
  data: {
    user: null as UserProfile | null,
    trialDays: 0,
    menuGroups: [
      {
        title: '学习工具',
        items: [
          { icon: '📝', name: '我的题库', path: '' },
          { icon: '📚', name: '错题本', path: '' },
          { icon: '📅', name: '学习计划', path: '' },
        ],
      },
      {
        title: '我的服务',
        items: [
          { icon: '🛒', name: '我的订单', path: '' },
          { icon: '💬', name: '在线答疑', path: '' },
          { icon: '🎯', name: '创业宣传', path: '' },
        ],
      },
      {
        title: '系统设置',
        items: [
          { icon: '⚙️', name: '设置', path: '' },
          { icon: '❓', name: '帮助与反馈', path: '' },
        ],
      },
    ],
  },

  unsubscribe: null as (() => void) | null,

  onLoad() {
    this.setData({ user: userStore.getState().profile });

    this.unsubscribe = userStore.subscribe((state: { profile: UserProfile | null }) => {
      const user = state.profile;
      const trialDays = user?.level === UserLevel.TRIAL && user?.trialEndTime ? getRemainingDays(user.trialEndTime) : 0;
      this.setData({ user, trialDays });
    });

    refreshUserInfo();
  },

  onUnload() {
    if (this.unsubscribe) {
      this.unsubscribe();
    }
  },

  onMenuTap(e: WechatMiniprogram.BaseEvent) {
    const { name } = e.currentTarget.dataset;
    wx.showToast({
      title: `${name} 开发中`,
      icon: 'none',
    });
  },

  onLevelTap() {
    wx.showModal({
      title: '会员权益',
      content: '开通会员即可解锁全部课程、专属学习计划和 AI 督学服务。',
      showCancel: false,
      confirmText: '知道了',
    });
  },
});
