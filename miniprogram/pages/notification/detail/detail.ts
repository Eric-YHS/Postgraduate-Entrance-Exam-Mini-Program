import {
  formatWxSubscribeError,
  getWxSubscribeDelivery,
  type WxSubscribeDeliveryDetail,
} from '../../../services/wx-subscribe.service';

Page({
  data: {
    loading: true,
    error: '',
    detail: null as WxSubscribeDeliveryDetail | null,
  },

  onLoad(options: Record<string, string | undefined>) {
    const id = Number(options.id);
    if (!Number.isInteger(id) || id <= 0) {
      this.setData({ loading: false, error: '通知编号无效。' });
      return;
    }
    this.loadDelivery(id);
  },

  async loadDelivery(id: number) {
    try {
      const result = await getWxSubscribeDelivery(id);
      this.setData({ loading: false, detail: result.delivery.detail });
    } catch (error) {
      this.setData({ loading: false, error: formatWxSubscribeError(error) });
    }
  },
});
