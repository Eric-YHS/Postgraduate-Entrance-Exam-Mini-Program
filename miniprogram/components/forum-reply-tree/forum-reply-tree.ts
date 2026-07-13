import { formatDateTime } from '../../utils/date';
import type { Reply } from '../../types/forum';

type ReplyView = Reply & {
  displayCreatedAt: string;
};

Component({
  properties: {
    /** 回复列表 */
    replies: { type: Array, value: [] },
    /** 帖子 ID */
    topicId: { type: String, value: '' },
  },

  data: {
    displayReplies: [] as ReplyView[],
  },

  observers: {
    replies(replies: Reply[]) {
      const displayReplies = (replies || []).map((reply) => ({
        ...reply,
        displayCreatedAt: formatDateTime(reply.createdAt),
      }));
      this.setData({ displayReplies });
    },
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
  },
});
