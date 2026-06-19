import { formatDateTime } from '../../utils/date';

Component({
  properties: {
    /** 回复列表 */
    replies: { type: Array, value: [] },
    /** 帖子 ID */
    topicId: { type: String, value: '' },
  },

  methods: {
    onReplyTap(e: WechatMiniprogram.BaseEvent) {
      const { id, name } = e.currentTarget.dataset;
      this.triggerEvent('reply', {
        topicId: this.data.topicId,
        replyId: id,
        replyToAuthorName: name,
      });
    },

    formatTime(date: string): string {
      return formatDateTime(date);
    },
  },
});
