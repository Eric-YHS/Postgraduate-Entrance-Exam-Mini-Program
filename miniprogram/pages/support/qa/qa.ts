import { answerQuestion } from '../../../services/support.service';

Page({
  data: {
    question: '',
    answer: '',
    submitting: false,
    suggestions: ['题库和错题本怎么使用？', '如何安排每天的复习计划？', '报名时间在哪里查询？'],
  },

  onInput(e: WechatMiniprogram.Input) {
    this.setData({ question: e.detail.value });
  },

  onSuggestionTap(e: WechatMiniprogram.BaseEvent) {
    const question = String(e.currentTarget.dataset.question || '');
    this.setData({ question });
    this.submitQuestion(question);
  },

  onSubmit() {
    this.submitQuestion(this.data.question);
  },

  async submitQuestion(rawQuestion: string) {
    const question = rawQuestion.trim();
    if (!question) {
      wx.showToast({ title: '请输入问题', icon: 'none' });
      return;
    }

    this.setData({ submitting: true, answer: '' });
    try {
      const result = await answerQuestion(question);
      this.setData({ answer: result.answer, submitting: false });
    } catch (error) {
      console.error('[SupportQA] 答疑失败', error);
      this.setData({ submitting: false });
      wx.showToast({ title: '暂时无法回答，请稍后重试', icon: 'none' });
    }
  },
});
