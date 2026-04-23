const { request } = require('../../utils/request');
const { ensureLogin } = require('../../utils/auth');

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
    goalForm: { dailyNew: 20, dailyReview: 50 },
    cardMode: 'flip',
    quizOptions: [],
    quizSelected: '',
    quizAnswered: false,
    quizCorrectAnswer: ''
  },

  onLoad() {
    if (!ensureLogin()) return;
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
        stats: { total: 0, again: 0, hard: 0, good: 0, easy: 0 },
        quizOptions: [],
        quizSelected: '',
        quizAnswered: false,
        quizCorrectAnswer: ''
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
        dailyDone: this.data.dailyDone + 1,
        quizSelected: '',
        quizAnswered: false
      });
      if (!finished && this.data.cardMode === 'quiz') {
        this.generateQuizOptions();
      }
    } catch (error) {
      wx.showToast({ title: error.message || '提交失败', icon: 'none' });
    }
  },

  restart() {
    this.loadDueCards();
  },

  switchMode(e) {
    const mode = e.currentTarget.dataset.mode;
    this.setData({
      cardMode: mode,
      isFlipped: false,
      quizSelected: '',
      quizAnswered: false
    });
    if (mode === 'quiz' && this.data.cards.length && !this.data.finished) {
      this.generateQuizOptions();
    }
  },

  generateQuizOptions() {
    const { cards, currentIndex } = this.data;
    const card = cards[currentIndex];
    if (!card) return;
    const correctAnswer = card.backContent;
    const others = cards.filter((_, i) => i !== currentIndex);
    const shuffled = others.sort(() => Math.random() - 0.5);
    const distractors = [];
    for (let i = 0; i < shuffled.length && distractors.length < 3; i++) {
      if (shuffled[i].backContent && shuffled[i].backContent !== correctAnswer) {
        distractors.push(shuffled[i].backContent);
      }
    }
    while (distractors.length < 3) distractors.push('—');
    const options = [correctAnswer, ...distractors]
      .sort(() => Math.random() - 0.5)
      .map(text => ({ text, border: '#e5e7eb', bg: '#fff' }));
    this.setData({ quizOptions: options, quizCorrectAnswer: correctAnswer });
  },

  selectQuizOption(e) {
    if (this.data.quizAnswered) return;
    const idx = e.currentTarget.dataset.index;
    const selected = this.data.quizOptions[idx].text;
    const options = this.data.quizOptions.map((opt, i) => ({
      ...opt,
      border: i === idx ? '#2563eb' : '#e5e7eb',
      bg: i === idx ? '#eff6ff' : '#fff'
    }));
    this.setData({ quizSelected: selected, quizOptions: options });
  },

  submitQuizAnswer() {
    if (!this.data.quizSelected || this.data.quizAnswered) return;
    const { quizSelected, quizCorrectAnswer, quizOptions } = this.data;
    const isCorrect = quizSelected === quizCorrectAnswer;
    const options = quizOptions.map(opt => {
      if (opt.text === quizCorrectAnswer) return { ...opt, border: '#16a34a', bg: '#f0fdf4' };
      if (opt.text === quizSelected && !isCorrect) return { ...opt, border: '#dc2626', bg: '#fef2f2' };
      return opt;
    });
    this.setData({ quizOptions: options, quizAnswered: true });
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
