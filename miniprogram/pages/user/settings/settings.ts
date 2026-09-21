import {
  formatWxSubscribeError,
  getWxSubscribeConfig,
  requestWxSubscribePermission,
  sendWxSubscribeTest,
} from '../../../services/wx-subscribe.service';

const STUDY_STORAGE_KEYS = [
  'ky_study_progress',
  'ky_study_progress_synced',
  'ky_wrong_book',
  'ky_practice_records',
  'ky_study_plan_items',
];

function getStorageSizeLabel(): string {
  try {
    const info = wx.getStorageInfoSync();
    if (info.currentSize < 1024) return `${info.currentSize} KB`;
    return `${(info.currentSize / 1024).toFixed(2)} MB`;
  } catch {
    return '未知';
  }
}

Page({
  data: {
    storageSize: '0 KB',
    version: '0.1.0',
    subscribeTemplateId: '',
    subscribeReady: false,
    subscribeRunning: false,
    subscribeStatus: '正在读取微信提醒状态',
  },

  onShow() {
    this.setData({ storageSize: getStorageSizeLabel() });
    this.loadSubscribeConfig();
  },

  async loadSubscribeConfig() {
    try {
      const config = await getWxSubscribeConfig();
      this.setData({
        subscribeTemplateId: config.templateId,
        subscribeReady: config.configured && Boolean(config.templateId),
        subscribeStatus: config.configured ? '长期订阅测试已就绪' : '服务器尚未完成微信提醒配置',
      });
    } catch (error) {
      this.setData({
        subscribeReady: false,
        subscribeStatus: formatWxSubscribeError(error),
      });
    }
  },

  async onSubscribeTest() {
    if (!this.data.subscribeReady || !this.data.subscribeTemplateId || this.data.subscribeRunning) {
      wx.showToast({ title: this.data.subscribeStatus, icon: 'none' });
      return;
    }
    this.setData({ subscribeRunning: true, subscribeStatus: '等待微信授权' });
    try {
      const status = await requestWxSubscribePermission(this.data.subscribeTemplateId);
      if (status !== 'accept') {
        const message = status === 'ban' ? '该模板已被禁止，请在小程序设置中重新开启。' : '你没有同意接收测试消息。';
        this.setData({ subscribeRunning: false, subscribeStatus: message });
        wx.showModal({ title: '未开启微信提醒', content: message, showCancel: false });
        return;
      }
      this.setData({ subscribeStatus: '正在发送测试消息' });
      await sendWxSubscribeTest();
      this.setData({ subscribeRunning: false, subscribeStatus: '测试消息已发送至服务通知' });
      wx.showModal({
        title: '发送成功',
        content: '请在微信“服务通知”中查看“存折更换”测试消息。',
        showCancel: false,
      });
    } catch (error) {
      const message = formatWxSubscribeError(error);
      this.setData({ subscribeRunning: false, subscribeStatus: message });
      wx.showModal({ title: '发送失败', content: message, showCancel: false });
    }
  },

  onOpenPermissions() {
    wx.openSetting({
      fail: () => {
        wx.showModal({
          title: '权限管理',
          content: '当前没有需要单独授权的系统权限。',
          showCancel: false,
        });
      },
    });
  },

  onClearStudyData() {
    wx.showModal({
      title: '清理本地学习数据',
      content: '将清除练习进度、错题记录和学习计划，不影响账号信息。确定继续吗？',
      confirmText: '确认清理',
      confirmColor: '#E24B4A',
      success: (result) => {
        if (!result.confirm) return;
        STUDY_STORAGE_KEYS.forEach((key) => wx.removeStorageSync(key));
        this.setData({ storageSize: getStorageSizeLabel() });
        wx.showToast({ title: '清理完成', icon: 'success' });
      },
    });
  },

  onPrivacy() {
    wx.showModal({
      title: '隐私与数据',
      content:
        '练习进度、错题和学习计划默认保存在当前设备。发布帖子或回复时，你主动提交的文字和图片会发送至微信官方内容安全接口进行检测，接口返回值会保存用于安全核验。',
      showCancel: false,
      confirmText: '知道了',
    });
  },

  onContentSecurity() {
    wx.navigateTo({ url: '/pages/user/content-security/content-security' });
  },
});
