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
  },

  onShow() {
    this.setData({ storageSize: getStorageSizeLabel() });
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
      content: '练习进度、错题和学习计划默认保存在当前设备。发布帖子时，只有你主动选择的内容和媒体会用于发布。',
      showCancel: false,
      confirmText: '知道了',
    });
  },
});
