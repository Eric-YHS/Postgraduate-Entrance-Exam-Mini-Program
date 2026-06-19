import { chooseAttachments, chooseImages, chooseVideo } from '../../utils/upload';

Component({
  properties: {
    /** 图片临时路径列表 */
    images: { type: Array, value: [] as string[] },
    /** 视频临时路径 */
    video: { type: String, value: '' },
    /** 附件列表 {name, path, size} */
    attachments: { type: Array, value: [] as Array<{ name: string; path: string; size: number }> },
    /** 最大图片数 */
    maxImages: { type: Number, value: 9 },
    /** 最大视频数（0 表示不发视频） */
    maxVideo: { type: Number, value: 1 },
    /** 最大附件数 */
    maxAttachments: { type: Number, value: 3 },
  },

  methods: {
    async onChooseImage() {
      const images = this.data.images as string[];
      const remain = this.data.maxImages - images.length;
      if (remain <= 0) return;

      try {
        const paths = await chooseImages(remain);
        this.triggerChange({ images: [...images, ...paths] });
      } catch {
        // 用户取消无需处理
      }
    },

    async onChooseVideo() {
      if (!this.data.maxVideo || this.data.video) return;

      try {
        const path = await chooseVideo();
        if (path) {
          this.triggerChange({ video: path });
        }
      } catch {
        // 用户取消无需处理
      }
    },

    async onChooseAttachment() {
      const attachments = this.data.attachments as Array<{ name: string; path: string; size: number }>;
      const remain = this.data.maxAttachments - attachments.length;
      if (remain <= 0) return;

      try {
        const files = await chooseAttachments(remain);
        this.triggerChange({ attachments: [...attachments, ...files] });
      } catch {
        // 用户取消无需处理
      }
    },

    onDeleteImage(e: WechatMiniprogram.BaseEvent) {
      const index = e.currentTarget.dataset.index as number;
      const images = [...(this.data.images as string[])];
      images.splice(index, 1);
      this.triggerChange({ images });
    },

    onDeleteVideo() {
      this.triggerChange({ video: '' });
    },

    onDeleteAttachment(e: WechatMiniprogram.BaseEvent) {
      const index = e.currentTarget.dataset.index as number;
      const attachments = [...(this.data.attachments as Array<{ name: string; path: string; size: number }>)];
      attachments.splice(index, 1);
      this.triggerChange({ attachments });
    },

    onPreviewImage(e: WechatMiniprogram.BaseEvent) {
      const index = e.currentTarget.dataset.index as number;
      const urls = this.data.images as string[];
      wx.previewImage({ urls, current: urls[index] });
    },

    triggerChange(
      changed: Partial<{
        images: string[];
        video: string;
        attachments: Array<{ name: string; path: string; size: number }>;
      }>
    ) {
      this.triggerEvent('change', {
        images: changed.images !== undefined ? changed.images : this.data.images,
        video: changed.video !== undefined ? changed.video : this.data.video,
        attachments: changed.attachments !== undefined ? changed.attachments : this.data.attachments,
      });
    },
  },
});
