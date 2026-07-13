import { getWrongQuestions, masterWrongQuestion } from '../../../services/question.service';
import type { WrongQuestion } from '../../../types/question';
import { SUBJECT_MAP } from '../../../constants/index';
import { formatDateTime } from '../../../utils/date';

type WrongQuestionListItem = WrongQuestion & {
  subjectLabel: string;
  displayTime: string;
};

function toWrongQuestionListItem(question: WrongQuestion, activeTab: 'active' | 'mastered'): WrongQuestionListItem {
  const timestamp = activeTab === 'active' ? question.lastWrongAt : question.masteredAt;
  return {
    ...question,
    subjectLabel: SUBJECT_MAP[question.subject] || question.subject,
    displayTime: timestamp ? formatDateTime(timestamp) : '',
  };
}

Page({
  data: {
    activeTab: 'active' as 'active' | 'mastered',
    questions: [] as WrongQuestionListItem[],
    loading: false,
    error: false,
    page: 1,
    pageSize: 10,
    hasMore: true,
  },

  onLoad() {
    this.loadWrongQuestions(true);
  },

  onPullDownRefresh() {
    this.loadWrongQuestions(true).then(() => {
      wx.stopPullDownRefresh();
    });
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) {
      this.loadWrongQuestions(false);
    }
  },

  async loadWrongQuestions(reset = false) {
    if (this.data.loading) return;

    const page = reset ? 1 : this.data.page;
    this.setData({ loading: true, error: false });

    try {
      const res = await getWrongQuestions({
        includeMastered: this.data.activeTab === 'mastered',
        page,
        pageSize: this.data.pageSize,
      });

      const questionItems = res.list.map((question) => toWrongQuestionListItem(question, this.data.activeTab));
      const questions = reset ? questionItems : [...this.data.questions, ...questionItems];
      const hasMore = questions.length < res.total;

      this.setData({
        questions,
        loading: false,
        page: page + 1,
        hasMore,
      });
    } catch (err) {
      console.error('[WrongBook] 加载错题失败', err);
      this.setData({ loading: false, error: true });
    }
  },

  onTabTap(e: WechatMiniprogram.BaseEvent) {
    const { tab } = e.currentTarget.dataset;
    this.setData({ activeTab: tab }, () => {
      this.loadWrongQuestions(true);
    });
  },

  async onMasterTap(e: WechatMiniprogram.BaseEvent) {
    const { id } = e.currentTarget.dataset;
    const question = this.data.questions.find((q) => q.id === id);
    if (!question) return;

    try {
      await masterWrongQuestion(id);
      wx.showToast({ title: '已标记掌握', icon: 'success' });

      // 从未掌握列表中移除
      if (this.data.activeTab === 'active') {
        this.setData({
          questions: this.data.questions.filter((q) => q.id !== id),
        });
      } else {
        // 更新状态
        this.setData({
          questions: this.data.questions.map((q) => {
            if (q.id !== id) return q;
            const masteredAt = new Date().toISOString();
            return { ...q, isMastered: true, masteredAt, displayTime: formatDateTime(masteredAt) };
          }),
        });
      }
    } catch (err) {
      console.error('[WrongBook] 标记掌握失败', err);
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },

  onRetry() {
    this.loadWrongQuestions(true);
  },

  onQuestionTap(e: WechatMiniprogram.BaseEvent) {
    const { id, subject } = e.currentTarget.dataset;
    wx.navigateTo({
      url: `/pages/question/practice/practice?subject=${subject}&focusId=${id}`,
    });
  },

});
