export interface PaymentOptions {
  orderId: string;
  courseId?: string;
  title?: string;
  amount?: number;
  onSuccess?: () => void;
  onFail?: (err: unknown) => void;
}

/** 请求预支付参数（Mock 阶段返回模拟参数） */
async function requestPrepay(orderId: string): Promise<{
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: 'RSA' | 'MD5' | 'HMAC-SHA256';
  paySign: string;
}> {
  // Mock 阶段：直接返回模拟参数
  return {
    timeStamp: String(Math.floor(Date.now() / 1000)),
    nonceStr: 'mock_nonce_str_' + orderId,
    package: 'prepay_id=mock_prepay_id_' + orderId,
    signType: 'RSA' as const,
    paySign: 'mock_pay_sign_' + orderId,
  };

  // 真实环境：
  // const res = await post<{
  //   timeStamp: string;
  //   nonceStr: string;
  //   prepayId: string;
  //   signType: string;
  //   paySign: string;
  // }>('/api/orders/prepay', { orderId });
  // return { ...res, package: `prepay_id=${res.prepayId}` };
}

/** 调起微信支付 */
export async function requestPayment(options: PaymentOptions): Promise<void> {
  const { orderId, onSuccess, onFail } = options;

  try {
    const payParams = await requestPrepay(orderId);

    return new Promise((resolve, reject) => {
      wx.requestPayment({
        ...payParams,
        success: () => {
          wx.showToast({ title: '支付成功', icon: 'success' });
          onSuccess?.();
          resolve();
        },
        fail: (err: WechatMiniprogram.GeneralCallbackResult) => {
          console.error('[Payment] 支付失败', err);
          wx.showToast({ title: '支付失败或取消', icon: 'none' });
          onFail?.(err);
          reject(err);
        },
      });
    });
  } catch (err: unknown) {
    console.error('[Payment] 预支付失败', err);
    onFail?.(err);
    throw err;
  }
}
