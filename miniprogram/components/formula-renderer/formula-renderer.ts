Component({
  properties: {
    /** 公式图片地址或 base64 */
    src: {
      type: String,
      value: '',
    },
    /** 公式描述文本（图片加载失败时显示） */
    alt: {
      type: String,
      value: '',
    },
    /** 图片填充模式 */
    mode: {
      type: String,
      value: 'aspectFit',
    },
    /** 自定义样式类 */
    customClass: {
      type: String,
      value: '',
    },
  },

  data: {
    loadError: false,
  },

  methods: {
    onLoad() {
      this.setData({ loadError: false });
    },

    onError() {
      console.error('[FormulaRenderer] 公式图片加载失败', this.data.src);
      this.setData({ loadError: true });
    },

    onPreview() {
      const { src } = this.data;
      if (!src) return;

      wx.previewImage({
        urls: [src],
        current: src,
      });
    },
  },
});
