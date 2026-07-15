import {
  checkImageContent,
  checkTextContent,
  formatContentSecurityError,
  getContentSecurityHistory,
  type ContentSecurityCheck,
} from '../../../services/content-security.service';

type DisplayCheck = ContentSecurityCheck & {
  statusText: string;
  rawJson: string;
  timeText: string;
};

function formatCheck(check: ContentSecurityCheck): DisplayCheck {
  const statusMap: Record<ContentSecurityCheck['status'], string> = {
    passed: '通过',
    submitted: '已提交异步检测',
    review: '需复核',
    rejected: '未通过',
    error: '接口错误',
  };
  return {
    ...check,
    statusText: statusMap[check.status],
    rawJson: JSON.stringify(check.raw || {}, null, 2),
    timeText: check.createdAt ? new Date(check.createdAt).toLocaleString() : '刚刚',
  };
}

Page({
  data: {
    sampleText: '考研学习交流内容安全测试',
    selectedImage: '',
    runningText: false,
    runningImage: false,
    serviceStatus: '正在读取已保存的微信接口返回值...',
    checks: [] as DisplayCheck[],
  },

  onLoad() {
    this.loadHistory();
  },

  onTextInput(e: WechatMiniprogram.Input) {
    this.setData({ sampleText: e.detail.value });
  },

  async loadHistory() {
    try {
      const result = await getContentSecurityHistory(20);
      this.setData({
        checks: result.checks.map(formatCheck),
        serviceStatus: result.checks.length > 0 ? '接口返回值已保存在服务器' : '尚无检测记录，可运行下方示例',
      });
    } catch (error) {
      this.setData({ serviceStatus: formatContentSecurityError(error) });
    }
  },

  async onRunTextCheck() {
    const content = this.data.sampleText.trim();
    if (!content) {
      wx.showToast({ title: '请输入检测文字', icon: 'none' });
      return;
    }
    this.setData({ runningText: true, serviceStatus: '正在调用 msgSecCheck...' });
    try {
      const result = await checkTextContent(content);
      const checks = result.checks.map(formatCheck);
      this.setData({
        runningText: false,
        checks: [...checks, ...this.data.checks],
        serviceStatus: result.allowed ? 'msgSecCheck 调用成功，返回值已保存' : '文字内容未通过检测',
      });
      wx.showToast({
        title: result.allowed ? '文字检测通过' : '文字未通过',
        icon: result.allowed ? 'success' : 'none',
      });
    } catch (error) {
      const message = formatContentSecurityError(error);
      this.setData({ runningText: false, serviceStatus: message });
      wx.showModal({ title: '文字检测失败', content: message, showCancel: false });
    }
  },

  onChooseImageCheck() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: async (result) => {
        const path = result.tempFiles[0]?.tempFilePath;
        if (!path) return;
        this.setData({
          selectedImage: path,
          runningImage: true,
          serviceStatus: '正在调用 imgSecCheck 与 mediaCheckAsync...',
        });
        try {
          const audit = await checkImageContent(path);
          const checks = audit.checks.map(formatCheck);
          this.setData({
            runningImage: false,
            checks: [...checks, ...this.data.checks],
            serviceStatus: audit.allowed ? '两项图片接口调用成功，返回值已保存' : '图片未通过安全检测',
          });
          wx.showToast({
            title: audit.allowed ? '图片检测完成' : '图片未通过',
            icon: audit.allowed ? 'success' : 'none',
          });
        } catch (error) {
          const message = formatContentSecurityError(error);
          this.setData({ runningImage: false, serviceStatus: message });
          wx.showModal({ title: '图片检测失败', content: message, showCancel: false });
        }
      },
    });
  },

  onCopyRaw(e: WechatMiniprogram.BaseEvent) {
    const index = Number(e.currentTarget.dataset.index);
    const rawJson = this.data.checks[index]?.rawJson;
    if (!rawJson) return;
    wx.setClipboardData({ data: rawJson });
  },
});
