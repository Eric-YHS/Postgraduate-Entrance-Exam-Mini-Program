const { request } = require('../../utils/request');

Page({
  data: {
    loading: true,
    cards: [],
    currentIndex: 0,
    isFlipped: false,
    finished: false,
    stats: { total: 0, again: 0, hard: 0, good: 0, easy: 0 },
    // 每日目标
    goal: { daily_new: 20, daily_review: 50 },
    dailyDone: 0,
    showGoalPanel: false,
    goalForm: { dailyNew: 20, dailyReview: 50 }
  },

  onLoad() {
    this.loadGoal();
    this.loadDueCards();
  },

  onPullDownRefresh() {
    this.loadDueCards().finally(() => wx.stopPullDownRefresh());
  },

  async loadGoal() {
    try {
      const result = await request({ url: '/api/flashcards/goal' });
      const goal = result.goal || { daily_new: 20, daily_review: 50 };
      this.setData({
        goal,
        goalForm: { dailyNew: goal.daily_new, dailyReview: goal.daily_review }
      });
    } catch (e) {
      // 静默处理
    }
  },

  async loadDueCards() {
    this.setData({ loading: true });
    try {
      const result = await request({ url: '/api/flashcards/due' });
      this.setData({
        loading: false,
        cards: result.flashcards || [],
        currentIndex: 0,
        isFlipped: false,
        finished: false,
        stats: { total: 0, again: 0, hard: 0, good: 0, easy: 0 }
      });
    } catch (error) {
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  flipCard() {
    if (!this.data.isFlipped) {
      this.setData({ isFlipped: true });
    }
  },

  async rateCard(event) {
    const quality = Number(event.currentTarget.dataset.quality);
    const { cards, currentIndex, stats } = this.data;
    const card = cards[currentIndex];

    try {
      await request({
        url: `/api/flashcards/${card.id}/review`,
        method: 'POST',
        data: { quality }
      });

      const newStats = { ...stats, total: stats.total + 1 };
      if (quality === 0) newStats.again++;
      else if (quality === 1) newStats.hard++;
      else if (quality === 2) newStats.good++;
      else newStats.easy++;

      const nextIndex = currentIndex + 1;
      const finished = nextIndex >= cards.length;

      this.setData({
        currentIndex: nextIndex,
        isFlipped: false,
        finished,
        stats: newStats,
        dailyDone: this.data.dailyDone + 1
      });
    } catch (error) {
      wx.showToast({ title: error.message || '提交失败', icon: 'none' });
    }
  },

  restart() {
    this.loadDueCards();
  },

  // 目标设置
  toggleGoalPanel() {
    this.setData({ showGoalPanel: !this.data.showGoalPanel });
  },

  handleGoalInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`goalForm.${field}`]: Number(e.detail.value) || 0 });
  },

  async saveGoal() {
    try {
      await request({
        url: '/api/flashcards/goal',
        method: 'POST',
        data: {
          dailyNew: this.data.goalForm.dailyNew,
          dailyReview: this.data.goalForm.dailyReview
        }
      });
      wx.showToast({ title: '目标已保存', icon: 'success' });
      this.setData({
        goal: { daily_new: this.data.goalForm.dailyNew, daily_review: this.data.goalForm.dailyReview },
        showGoalPanel: false
      });
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' });
    }
  }
});
