import { getVocabularyCards, reviewVocabularyCard, type VocabularyCard } from '../../../services/vocabulary.service';

Page({
  data: {
    cards: [] as VocabularyCard[],
    current: null as VocabularyCard | null,
    revealed: false,
    loading: true,
    reviewed: 0,
  },

  onLoad() {
    this.loadCards();
  },

  onPullDownRefresh() {
    this.loadCards().finally(() => wx.stopPullDownRefresh());
  },

  async loadCards() {
    this.setData({ loading: true });
    try {
      const result = await getVocabularyCards();
      const cards = result.cards || [];
      this.setData({ cards, current: cards[0] || null, revealed: false, loading: false });
    } catch (error) {
      console.error('[Vocabulary] 加载失败', error);
      this.setData({ loading: false });
      wx.showToast({ title: '词汇加载失败', icon: 'none' });
    }
  },

  reveal() {
    this.setData({ revealed: true });
  },

  async rate(e: WechatMiniprogram.BaseEvent) {
    const current = this.data.current;
    if (!current) return;
    const quality = Number(e.currentTarget.dataset.quality) as 0 | 1 | 2 | 3;
    try {
      await reviewVocabularyCard(current.id, quality);
      const cards = this.data.cards.slice(1);
      this.setData({ cards, current: cards[0] || null, revealed: false, reviewed: this.data.reviewed + 1 });
    } catch (error) {
      console.error('[Vocabulary] 复习记录失败', error);
      wx.showToast({ title: '记录失败，请重试', icon: 'none' });
    }
  },
});
