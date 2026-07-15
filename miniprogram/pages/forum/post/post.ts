import { createTopic } from '../../../services/forum.service';
import {
  checkImageContent,
  checkTextContent,
  formatContentSecurityError,
  type ContentSecurityCheck,
} from '../../../services/content-security.service';
import { auditText } from '../../../utils/content-audit';
import { uploadAttachments, uploadImages, uploadVideo } from '../../../utils/upload';

type SecurityApiItem = {
  name: ContentSecurityCheck['apiName'];
  label: string;
  status: string;
  passed: boolean;
};

const SECURITY_APIS: SecurityApiItem[] = [
  { name: 'msgSecCheck', label: '文字内容安全识别', status: '待检测', passed: false },
  { name: 'imgSecCheck', label: '图片同步安全检测', status: '待检测', passed: false },
  { name: 'mediaCheckAsync', label: '媒体异步安全检测', status: '待检测', passed: false },
];

Page({
  data: {
    content: '',
    images: [] as string[],
    video: '',
    attachments: [] as Array<{ name: string; path: string; size: number }>,
    hashtags: [] as string[],
    hashtagInput: '',
    submitting: false,
    securityStage: '发布前自动调用微信官方内容安全 API',
    securityApis: SECURITY_APIS,
  },

  onContentInput(e: WechatMiniprogram.Input) {
    this.setData({
      content: e.detail.value,
      securityApis: SECURITY_APIS,
      securityStage: '内容已变更，发布时重新检测',
    });
  },

  onMediaChange(
    e: WechatMiniprogram.CustomEvent<{
      images: string[];
      video: string;
      attachments: Array<{ name: string; path: string; size: number }>;
    }>
  ) {
    const { images, video, attachments } = e.detail;
    this.setData({
      images,
      video,
      attachments,
      securityApis: SECURITY_APIS,
      securityStage: '内容已变更，发布时重新检测',
    });
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
      securityApis: SECURITY_APIS,
      securityStage: '内容已变更，发布时重新检测',
    });
  },

  onRemoveHashtag(e: WechatMiniprogram.BaseEvent) {
    const index = e.currentTarget.dataset.index as number;
    const hashtags = [...this.data.hashtags];
    hashtags.splice(index, 1);
    this.setData({ hashtags, securityApis: SECURITY_APIS, securityStage: '内容已变更，发布时重新检测' });
  },

  onOpenSecurityRecords() {
    wx.navigateTo({ url: '/pages/user/content-security/content-security' });
  },

  updateSecurityApi(name: ContentSecurityCheck['apiName'], status: string, passed: boolean) {
    this.setData({
      securityApis: (this.data.securityApis as SecurityApiItem[]).map((item) =>
        item.name === name ? { ...item, status, passed } : item
      ),
    });
  },

  applyChecks(checks: ContentSecurityCheck[]) {
    checks.forEach((check) => {
      const status = check.status === 'submitted' ? '已提交' : check.status === 'passed' ? '已通过' : '未通过';
      this.updateSecurityApi(
        check.apiName,
        `${status} · errcode ${check.errcode}`,
        check.status === 'passed' || check.status === 'submitted'
      );
    });
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

    this.setData({
      submitting: true,
      securityStage: '正在调用 msgSecCheck 检测文字内容',
      securityApis: SECURITY_APIS,
    });
    wx.showLoading({ title: '安全检测中', mask: true });

    try {
      const textResult = await checkTextContent(content.trim());
      this.applyChecks(textResult.checks);
      if (!textResult.allowed) {
        throw new Error('文字内容未通过微信安全检测，请修改后重试。');
      }

      const metadata = [...hashtags.map((tag) => `#${tag}`), ...attachments.map((file) => file.name)].join(' ').trim();
      if (metadata) {
        const metadataResult = await checkTextContent(metadata.slice(0, 1000));
        this.applyChecks(metadataResult.checks);
        if (!metadataResult.allowed) {
          throw new Error('标签或附件名称未通过微信安全检测，请修改后重试。');
        }
      }

      if (images.length === 0) {
        this.updateSecurityApi('imgSecCheck', '无图片', true);
        this.updateSecurityApi('mediaCheckAsync', '无图片', true);
      }
      for (let index = 0; index < images.length; index += 1) {
        this.setData({ securityStage: `正在检测第 ${index + 1}/${images.length} 张图片` });
        const imageResult = await checkImageContent(images[index]);
        this.applyChecks(imageResult.checks);
        if (!imageResult.allowed) {
          throw new Error(`第 ${index + 1} 张图片未通过微信安全检测，请更换后重试。`);
        }
      }

      this.setData({ securityStage: '微信内容安全检测通过，接口返回值已保存' });
      wx.showLoading({ title: '发布中...', mask: true });
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
        // 微信 mediaCheckAsync 不支持视频和任意文档；含此类媒体时进入人工复核状态。
        auditStatus: video || attachments.length > 0 ? 'manual' : audit.status,
      });

      wx.hideLoading();
      wx.showToast({ title: video || attachments.length > 0 ? '已提交审核' : '发布成功', icon: 'success' });
      setTimeout(() => {
        wx.redirectTo({
          url: `/pages/forum/detail/detail?id=${topic.id}`,
        });
      }, 800);
    } catch (err) {
      wx.hideLoading();
      console.error('[ForumPost] 发帖失败', err);
      const message = err instanceof Error ? err.message : formatContentSecurityError(err);
      this.setData({ submitting: false, securityStage: message });
      wx.showModal({
        title: '内容安全检测未通过',
        content: message || '内容安全检测失败，请稍后重试。',
        showCancel: false,
      });
    }
  },
});
