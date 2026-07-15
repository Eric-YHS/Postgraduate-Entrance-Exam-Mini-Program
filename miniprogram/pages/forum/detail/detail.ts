import { createReply, getTopicById, toggleFavorite } from '../../../services/forum.service';
import { checkTextContent, formatContentSecurityError } from '../../../services/content-security.service';
import { formatDateTime } from '../../../utils/date';
import { auditText } from '../../../utils/content-audit';
import type { Reply, Topic } from '../../../types/forum';

type TopicDetail = Topic & { replies: Reply[] };
type TopicDetailView = TopicDetail & {
  displayCreatedAt: string;
  videoAttachment: Topic['attachments'][number] | null;
  fileAttachments: Topic['attachments'];
};

Page({
  data: {
    topic: null as TopicDetailView | null,
    loading: false,
    error: false,
    replyContent: '',
    replyTarget: null as { replyId: string; authorName: string } | null,
    submitting: false,
    replySecurityStatus: '回复发送前将调用 msgSecCheck',
  },

  topicId: '',

  onLoad(options: Record<string, string>) {
    this.topicId = options.id || '';
    this.loadTopic();
  },

  onPullDownRefresh() {
    this.loadTopic().then(() => {
      wx.stopPullDownRefresh();
    });
  },

  async loadTopic() {
    if (!this.topicId) return;

    this.setData({ loading: true, error: false });
    try {
      const topic = await getTopicById(this.topicId);
      const topicView: TopicDetailView = {
        ...topic,
        displayCreatedAt: formatDateTime(topic.createdAt),
        videoAttachment: topic.attachments.find((attachment) => attachment.type === 'video') || null,
        fileAttachments: topic.attachments.filter((attachment) => attachment.type === 'attachment'),
      };
      this.setData({ topic: topicView, loading: false });
    } catch (err) {
      console.error('[ForumDetail] 加载帖子详情失败', err);
      this.setData({ loading: false, error: true });
    }
  },

  async onFavoriteTap() {
    if (!this.data.topic) return;
    try {
      const result = await toggleFavorite(this.data.topic.id);
      this.setData({ 'topic.favoritedByMe': result.favorited });
    } catch (err) {
      console.error('[ForumDetail] 收藏失败', err);
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },

  onReplyToTopic() {
    this.setData({ replyTarget: null });
  },

  onReplyToReply(e: WechatMiniprogram.CustomEvent<{ replyId: string; replyToAuthorName: string }>) {
    const { replyId, replyToAuthorName } = e.detail;
    this.setData({
      replyTarget: { replyId, authorName: replyToAuthorName },
    });
  },

  onReplyInput(e: WechatMiniprogram.Input) {
    this.setData({ replyContent: e.detail.value, replySecurityStatus: '内容已变更，发送时重新检测' });
  },

  onCancelTarget() {
    this.setData({ replyTarget: null });
  },

  async onSubmitReply() {
    const { topic, replyContent, replyTarget } = this.data;
    if (!topic || !replyContent.trim()) return;

    const audit = auditText(replyContent.trim());
    if (!audit.passed) {
      wx.showModal({
        title: '内容未通过审核',
        content: `包含敏感词：${audit.hitWords.join('、')}`,
        showCancel: false,
      });
      return;
    }

    this.setData({ submitting: true });
    try {
      this.setData({ replySecurityStatus: '正在调用 msgSecCheck...' });
      const securityResult = await checkTextContent(replyContent.trim());
      if (!securityResult.allowed) {
        throw new Error('回复内容未通过微信安全检测，请修改后重试。');
      }
      await createReply(topic.id, {
        content: replyContent.trim(),
        replyToId: replyTarget?.replyId,
        auditStatus: 'passed',
      });
      wx.showToast({ title: '回复成功', icon: 'success' });
      this.setData({
        replyContent: '',
        replyTarget: null,
        submitting: false,
        replySecurityStatus: 'msgSecCheck 已通过，返回值已保存',
      });
      this.loadTopic();
    } catch (err) {
      console.error('[ForumDetail] 回复失败', err);
      const message = err instanceof Error ? err.message : formatContentSecurityError(err);
      this.setData({ submitting: false, replySecurityStatus: message });
      wx.showModal({ title: '内容安全检测未通过', content: message, showCancel: false });
    }
  },

  onRetry() {
    this.loadTopic();
  },

  onPreviewImage(e: WechatMiniprogram.BaseEvent) {
    const topic = this.data.topic;
    if (!topic) return;
    const urls = topic.attachments.filter((a) => a.type === 'image').map((a) => a.url);
    const index = e.currentTarget.dataset.index as number;
    wx.previewImage({ urls, current: urls[index] });
  },
});
