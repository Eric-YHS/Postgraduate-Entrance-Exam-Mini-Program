Component({
  properties: {
    title: {
      type: String,
      value: '加载失败',
    },
    message: {
      type: String,
      value: '网络异常，请稍后重试',
    },
    retryText: {
      type: String,
      value: '重新加载',
    },
  },
  methods: {
    onRetry() {
      this.triggerEvent('retry');
    },
  },
});
