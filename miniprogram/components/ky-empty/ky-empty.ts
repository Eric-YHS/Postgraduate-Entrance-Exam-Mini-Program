Component({
  properties: {
    image: {
      type: String,
      value: '', // 可传入自定义图片地址
    },
    description: {
      type: String,
      value: '暂无数据',
    },
    buttonText: {
      type: String,
      value: '',
    },
  },
  methods: {
    onButtonTap() {
      this.triggerEvent('buttontap');
    },
  },
});
