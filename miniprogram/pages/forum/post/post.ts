import { createTopic } from '../../../services/forum.service';
import { auditText } from '../../../utils/content-audit';
import { uploadAttachments, uploadImages, uploadVideo } from '../../../utils/upload';

Page({
  data: {
    content: '',
    images: [] as string[],
    video: '',
    attachments: [] as Array<{ name: string; path: string; size: number }>,
    hashtags: [] as string[],
    hashtagInput: '',
    submitting: false,
  },

  onContentInput(e: WechatMiniprogram.Input) {
    this.setData({ content: e.detail.value });
  },

  onMediaChange(
    e: WechatMiniprogram.CustomEvent<{
      images: string[];
      video: string;
      attachments: Array<{ name: string; path: string; size: number }>;
    }>
  ) {
    const { images, video, attachments } = e.detail;
    this.setData({ images, video, attachments });
  },

  onHashtagInput(e: WechatMiniprogram.Input) {
    this.setData({ hashtagInput: e.detail.value });
  },

  onHashtagConfirm() {
    const input = this.data.hashtagInput.trim().replace(/^#/, '');
    if (!input) return;
    if (this.data.hashtags.includes(input)) {
      this.setData({ hashtagInput: '' });
      return;
    }
    if (this.data.hashtags.length >= 5) {
      wx.showToast({ title: '最多 5 个标签', icon: 'none' });
      return;
    }
    this.setData({
      hashtags: [...this.data.hashtags, input],
      hashtagInput: '',
    });
  },

  onRemoveHashtag(e: WechatMiniprogram.BaseEvent) {
    const index = e.currentTarget.dataset.index as number;
    const hashtags = [...this.data.hashtags];
    hashtags.splice(index, 1);
    this.setData({ hashtags });
  },

  async onSubmit() {
    const { content, hashtags, images, video, attachments } = this.data;

    if (!content.trim()) {
      wx.showToast({ title: '请输入正文', icon: 'none' });
      return;
    }

    const audit = auditText(content.trim());
    if (!audit.passed) {
      wx.showModal({
        title: '内容未通过审核',
        content: `包含敏感词：${audit.hitWords.join('、')}`,
        showCancel: false,
      });
      return;
    }

    this.setData({ submitting: true });
    wx.showLoading({ title: '发布中...', mask: true });

    try {
      const [imageResults, videoResult, attachmentResults] = await Promise.all([
        uploadImages(images),
        video ? uploadVideo(video) : Promise.resolve(null),
        uploadAttachments(attachments),
      ]);

      const topic = await createTopic({
        content: content.trim(),
        hashtags,
        images: imageResults.map((r) => r.url),
        video: videoResult?.url,
        attachments: attachmentResults.map((r) => ({
          name: r.name || '',
          path: r.url,
          size: r.size || 0,
        })),
        auditStatus: audit.status,
      });

      wx.hideLoading();
      wx.showToast({ title: '发布成功', icon: 'success' });
      setTimeout(() => {
        wx.redirectTo({
          url: `/pages/forum/detail/detail?id=${topic.id}`,
        });
      }, 800);
    } catch (err) {
      wx.hideLoading();
      console.error('[ForumPost] 发帖失败', err);
      wx.showToast({ title: '发布失败', icon: 'none' });
      this.setData({ submitting: false });
    }
  },
});
