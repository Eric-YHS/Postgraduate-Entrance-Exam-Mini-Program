import { getHashtags, getTopics, toggleFavorite } from '../../../services/forum.service';
import { formatDateTime } from '../../../utils/date';
import type { Hashtag, Topic } from '../../../types/forum';

type TopicListItem = Topic & {
  displayCreatedAt: string;
};

Page({
  data: {
    topics: [] as TopicListItem[],
    hashtags: [] as Hashtag[],
    activeHashtag: '',
    loading: false,
    error: false,
    page: 1,
    pageSize: 10,
    hasMore: true,
  },

  onLoad() {
    this.loadTopics(true);
    this.loadHashtags();
  },

  onPullDownRefresh() {
    Promise.all([this.loadTopics(true), this.loadHashtags()]).then(() => {
      wx.stopPullDownRefresh();
    });
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) {
      this.loadTopics(false);
    }
  },

  async loadTopics(reset = false) {
    if (this.data.loading) return;

    const page = reset ? 1 : this.data.page;
    this.setData({ loading: true, error: false });

    try {
      const res = await getTopics({
        hashtag: this.data.activeHashtag,
        page,
        pageSize: this.data.pageSize,
      });

      const incomingTopics = res.list.map((topic) => ({
        ...topic,
        displayCreatedAt: formatDateTime(topic.createdAt),
      }));
      const topics = reset ? incomingTopics : [...this.data.topics, ...incomingTopics];
      const hasMore = topics.length < res.total;

      this.setData({
        topics,
        loading: false,
        page: page + 1,
        hasMore,
      });
    } catch (err) {
      console.error('[ForumIndex] 加载帖子失败', err);
      this.setData({ loading: false, error: true });
    }
  },

  async loadHashtags() {
    try {
      const hashtags = await getHashtags();
      this.setData({ hashtags });
    } catch (err) {
      console.error('[ForumIndex] 加载话题失败', err);
    }
  },

  onRetry() {
    this.loadTopics(true);
  },

  onHashtagTap(e: WechatMiniprogram.BaseEvent) {
    const { name } = e.currentTarget.dataset;
    const activeHashtag = this.data.activeHashtag === name ? '' : name;
    this.setData({ activeHashtag }, () => {
      this.loadTopics(true);
    });
  },

  onTopicTap(e: WechatMiniprogram.BaseEvent) {
    const { id } = e.currentTarget.dataset;
    wx.navigateTo({
      url: `/pages/forum/detail/detail?id=${id}`,
    });
  },

  async onFavoriteTap(e: WechatMiniprogram.BaseEvent) {
    const { id } = e.currentTarget.dataset;
    try {
      const result = await toggleFavorite(id);
      const topics = this.data.topics.map((t) => (t.id === id ? { ...t, favoritedByMe: result.favorited } : t));
      this.setData({ topics });
    } catch (err) {
      console.error('[ForumIndex] 收藏失败', err);
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },

  onPostTap() {
    wx.navigateTo({
      url: '/pages/forum/post/post',
    });
  },
});
