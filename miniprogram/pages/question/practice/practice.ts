import { getQuestions, submitAnswer } from '../../../services/question.service';
import { post } from '../../../utils/request';
import type { Question, QuestionSubject, DisplayMode, QuestionOption } from '../../../types/question';
import { SUBJECT_MAP } from '../../../constants/index';

interface QuestionFilters {
  subject?: QuestionSubject | '';
  displayMode?: DisplayMode | '';
  isRealExam?: boolean | '';
  sourceYear?: number | '';
  sourcePaper?: string;
  difficulty?: number | '';
}

type DisplayQuestionOption = QuestionOption & {
  className: string;
  isCorrect: boolean;
  isWrong: boolean;
};

type DisplayQuestion = Omit<Question, 'options'> & {
  difficultyText: string;
  options: DisplayQuestionOption[];
};

function getDifficultyText(level?: number): string {
  if (!level) return '';
  return '★'.repeat(level) + '☆'.repeat(5 - level);
}

function buildDisplayQuestion(question: Question, selectedOption: string, hasAnswered: boolean): DisplayQuestion {
  return {
    ...question,
    difficultyText: getDifficultyText(question.difficulty),
    options: question.options.map((option) => {
      const isCorrect = hasAnswered && option.label === question.correctOption;
      const isWrong = hasAnswered && option.label === selectedOption && option.label !== question.correctOption;
      const isSelected = option.label === selectedOption && !hasAnswered;
      const className = [
        isCorrect ? 'option-item--correct' : '',
        isWrong ? 'option-item--wrong' : '',
        isSelected ? 'option-item--selected' : '',
        hasAnswered ? 'option-item--disabled' : '',
      ]
        .filter(Boolean)
        .join(' ');
      return { ...option, className, isCorrect, isWrong };
    }),
  };
}

Page({
  data: {
    title: '刷题练习',
    subject: '' as QuestionSubject | '',
    displayMode: '' as DisplayMode | '',
    focusId: '',
    questions: [] as Question[],
    currentIndex: 0,
    currentQuestion: null as DisplayQuestion | null,
    selectedOption: '',
    hasAnswered: false,
    isCorrect: false,
    aiExplanation: '',
    loading: false,
    error: false,
    progress: 0,
    total: 0,
    filters: {} as QuestionFilters,
    filterVisible: false,
  },

  onLoad(options: Record<string, string>) {
    const subject = (options.subject || '') as QuestionSubject | '';
    const displayMode = (options.displayMode || '') as DisplayMode | '';
    const focusId = options.focusId || '';
    const title = options.title || this.getDefaultTitle(subject, displayMode);

    const filters: QuestionFilters = { subject, displayMode };
    this.setData({ subject, displayMode, title, focusId, filters });
    this.loadQuestions();
  },

  getDefaultTitle(subject: QuestionSubject | '', displayMode: DisplayMode | ''): string {
    if (subject && displayMode) {
      return `${SUBJECT_MAP[subject] || subject}${this.getModeName(displayMode)}练习`;
    }
    if (subject) {
      return `${SUBJECT_MAP[subject] || subject}练习`;
    }
    if (displayMode) {
      return `${this.getModeName(displayMode)}练习`;
    }
    return '刷题练习';
  },

  getModeName(displayMode: DisplayMode): string {
    const map: Record<DisplayMode, string> = {
      radio: '选择',
      word: '单词',
      formula: '公式',
    };
    return map[displayMode] || '练习';
  },

  async loadQuestions() {
    this.setData({ loading: true, error: false });

    try {
      const params: Record<string, string | number | boolean | undefined> = {
        page: 1,
        pageSize: 20,
      };

      const { filters } = this.data;
      if (filters.subject) {
        params.subject = filters.subject;
      }
      if (filters.displayMode) {
        params.displayMode = filters.displayMode;
      }
      if (filters.isRealExam !== undefined && filters.isRealExam !== '') {
        params.isRealExam = filters.isRealExam;
      }
      if (filters.sourceYear) {
        params.sourceYear = filters.sourceYear;
      }
      if (filters.sourcePaper) {
        params.sourcePaper = filters.sourcePaper;
      }
      if (filters.difficulty) {
        params.difficulty = filters.difficulty;
      }

      const res = await getQuestions(
        params as {
          subject?: QuestionSubject;
          displayMode?: DisplayMode;
          isRealExam?: boolean;
          sourceYear?: number;
          sourcePaper?: string;
          difficulty?: number;
          page: number;
          pageSize: number;
        }
      );

      if (res.list.length === 0) {
        this.setData({ loading: false, questions: [], currentQuestion: null, total: 0, progress: 0 });
        return;
      }

      const focusId = this.data.focusId;
      let currentIndex = 0;
      if (focusId) {
        const foundIndex = res.list.findIndex((q) => q.id === focusId);
        if (foundIndex >= 0) {
          currentIndex = foundIndex;
        } else {
          wx.showToast({ title: '目标题目未找到', icon: 'none' });
        }
      }

      this.setData({
        questions: res.list,
        currentIndex,
        currentQuestion: buildDisplayQuestion(res.list[currentIndex], '', false),
        total: res.list.length,
        progress: Math.round(((currentIndex + 1) / res.list.length) * 100),
        loading: false,
        selectedOption: '',
        hasAnswered: false,
        isCorrect: false,
        aiExplanation: '',
      });
    } catch (err) {
      console.error('[Practice] 加载题目失败', err);
      this.setData({ loading: false, error: true });
    }
  },

  onOptionTap(e: WechatMiniprogram.BaseEvent) {
    if (this.data.hasAnswered) return;

    const { label } = e.currentTarget.dataset;
    const question = this.data.questions[this.data.currentIndex];
    this.setData({
      selectedOption: label,
      currentQuestion: question ? buildDisplayQuestion(question, label, false) : null,
    });
  },

  async onSubmit() {
    const { currentQuestion, selectedOption } = this.data;
    if (!currentQuestion || !selectedOption) return;

    try {
      const result = await submitAnswer(currentQuestion.id, selectedOption);
      this.setData({
        hasAnswered: true,
        isCorrect: result.isCorrect,
        aiExplanation: '',
        currentQuestion: buildDisplayQuestion(this.data.questions[this.data.currentIndex], selectedOption, true),
      });
    } catch (err) {
      console.error('[Practice] 提交答案失败', err);
      wx.showToast({ title: '提交失败', icon: 'none' });
    }
  },

  async onAskAI() {
    const { currentQuestion, aiExplanation } = this.data;
    if (!currentQuestion || aiExplanation) return;

    wx.showLoading({ title: 'AI 思考中', mask: true });
    try {
      const data = await post<{ explanation: string }>('/api/ai/explain-question', {
        question: currentQuestion.stem || '',
      });
      this.setData({ aiExplanation: data.explanation || '暂无讲解' });
    } catch (err) {
      console.error('[Practice] AI 讲解失败', err);
      wx.showToast({ title: 'AI 讲解失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  onNext() {
    const { currentIndex, questions } = this.data;
    const nextIndex = currentIndex + 1;

    if (nextIndex >= questions.length) {
      wx.showToast({ title: '练习完成', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 1500);
      return;
    }

    this.setData({
      currentIndex: nextIndex,
      currentQuestion: buildDisplayQuestion(questions[nextIndex], '', false),
      selectedOption: '',
      hasAnswered: false,
      isCorrect: false,
      aiExplanation: '',
      progress: Math.round(((nextIndex + 1) / questions.length) * 100),
    });
  },

  onRetry() {
    this.loadQuestions();
  },

  onBack() {
    wx.navigateBack();
  },

  onFilterTap() {
    this.setData({ filterVisible: true });
  },

  onFilterClose() {
    this.setData({ filterVisible: false });
  },

  onFilterConfirm(e: WechatMiniprogram.CustomEvent<{ filters: QuestionFilters }>) {
    const filters = e.detail.filters;
    this.setData({ filters, filterVisible: false });
    this.loadQuestions();
  },

  onFilterReset() {
    const filters: QuestionFilters = {};
    this.setData({ filters, filterVisible: false });
    this.loadQuestions();
  },

});
