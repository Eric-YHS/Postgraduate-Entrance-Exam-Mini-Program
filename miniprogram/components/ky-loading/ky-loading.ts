Component({
  properties: {
    type: {
      type: String,
      value: 'circular', // circular / spinner
    },
    size: {
      type: String,
      value: '40rpx',
    },
    color: {
      type: String,
      value: '#1D4E89',
    },
    text: {
      type: String,
      value: '加载中...',
    },
    textColor: {
      type: String,
      value: '#999999',
    },
    fullscreen: {
      type: Boolean,
      value: false,
    },
  },
});
