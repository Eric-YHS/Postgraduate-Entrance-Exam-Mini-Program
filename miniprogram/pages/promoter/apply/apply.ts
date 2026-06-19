import { post, get } from '../../../utils/request';

interface ApplyForm {
  name: string;
  contact: string;
  platform: string;
  followerCount: string;
  motivation: string;
}

Page({
  data: {
    form: {
      name: '',
      contact: '',
      platform: '',
      followerCount: '',
      motivation: '',
    } as ApplyForm,
    status: '' as '' | 'pending' | 'approved' | 'rejected',
    loading: false,
    submitting: false,
  },

  async onLoad() {
    this.loadMyApplication();
  },

  async loadMyApplication() {
    this.setData({ loading: true });
    try {
      const res = await get<{ application: { status: string } | null }>('/api/promoter/my-application');
      const status = res.application?.status || '';
      this.setData({ status: status as Page.Data['status'] });
    } catch (err) {
      console.error('[PromoterApply] 获取申请状态失败', err);
    } finally {
      this.setData({ loading: false });
    }
  },

  onNameInput(e: WechatMiniprogram.Input) {
    this.setData({ 'form.name': e.detail.value });
  },

  onContactInput(e: WechatMiniprogram.Input) {
    this.setData({ 'form.contact': e.detail.value });
  },

  onPlatformInput(e: WechatMiniprogram.Input) {
    this.setData({ 'form.platform': e.detail.value });
  },

  onFollowerInput(e: WechatMiniprogram.Input) {
    this.setData({ 'form.followerCount': e.detail.value });
  },

  onMotivationInput(e: WechatMiniprogram.TextArea) {
    this.setData({ 'form.motivation': e.detail.value });
  },

  async onSubmit() {
    const { form, status, submitting } = this.data;
    if (submitting) return;

    if (status === 'pending') {
      wx.showToast({ title: '申请正在审核中', icon: 'none' });
      return;
    }
    if (status === 'approved') {
      wx.showToast({ title: '您已是认证博主', icon: 'none' });
      return;
    }

    const name = form.name.trim();
    const contact = form.contact.trim();
    const platform = form.platform.trim();
    const followerCount = parseInt(form.followerCount, 10) || 0;
    const motivation = form.motivation.trim();

    if (!name) {
      wx.showToast({ title: '请输入姓名', icon: 'none' });
      return;
    }
    if (!contact) {
      wx.showToast({ title: '请输入联系方式', icon: 'none' });
      return;
    }
    if (!platform) {
      wx.showToast({ title: '请输入平台账号', icon: 'none' });
      return;
    }

    this.setData({ submitting: true });
    wx.showLoading({ title: '提交中...', mask: true });

    try {
      await post('/api/promoter/apply', {
        name,
        contact,
        platform,
        follower_count: followerCount,
        motivation,
      });
      wx.hideLoading();
      wx.showToast({ title: '提交成功', icon: 'success' });
      this.setData({ status: 'pending' });
      setTimeout(() => wx.navigateBack(), 1200);
    } catch (err: any) {
      wx.hideLoading();
      console.error('[PromoterApply] 提交失败', err);
      const message = err?.message || err?.data?.message || '提交失败，请稍后重试';
      wx.showToast({ title: message, icon: 'none' });
      this.setData({ submitting: false });
    }
  },
});
