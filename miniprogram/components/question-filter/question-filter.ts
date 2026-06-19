import type { QuestionSubject, DisplayMode } from '../../types/question';

interface FilterOption<T> {
  value: T;
  label: string;
}

export interface QuestionFilters {
  subject?: QuestionSubject | '';
  displayMode?: DisplayMode | '';
  isRealExam?: boolean | '';
  sourceYear?: number | '';
  sourcePaper?: string;
  difficulty?: number | '';
}

Component({
  properties: {
    filters: {
      type: Object,
      value: {} as QuestionFilters,
    },
    visible: {
      type: Boolean,
      value: false,
    },
  },

  data: {
    localFilters: {} as QuestionFilters,
    subjects: [
      { value: '', label: '全部' },
      { value: 'politics', label: '政治' },
      { value: 'english', label: '英语' },
      { value: 'math', label: '数学' },
    ] as FilterOption<QuestionSubject | ''>[],
    displayModes: [
      { value: '', label: '全部' },
      { value: 'radio', label: '单选' },
      { value: 'word', label: '单词' },
      { value: 'formula', label: '公式' },
    ] as FilterOption<DisplayMode | ''>[],
    realExamOptions: [
      { value: '', label: '全部' },
      { value: true, label: '真题' },
      { value: false, label: '非真题' },
    ] as FilterOption<boolean | ''>[],
    years: [
      { value: '', label: '全部' },
      { value: 2024, label: '2024' },
      { value: 2023, label: '2023' },
      { value: 2022, label: '2022' },
    ] as FilterOption<number | ''>[],
    papers: [
      { value: '', label: '全部' },
      { value: '全国卷', label: '全国卷' },
    ] as FilterOption<string>[],
    difficulties: [
      { value: '', label: '全部' },
      { value: 1, label: '1星' },
      { value: 2, label: '2星' },
      { value: 3, label: '3星' },
      { value: 4, label: '4星' },
      { value: 5, label: '5星' },
    ] as FilterOption<number | ''>[],
  },

  observers: {
    visible(val: boolean) {
      if (val) {
        this.setData({ localFilters: { ...this.data.filters } });
      }
    },
  },

  methods: {
    onClose() {
      this.triggerEvent('close');
    },

    onSubjectTap(e: WechatMiniprogram.BaseEvent) {
      const { value } = e.currentTarget.dataset;
      this.setFilter('subject', value);
    },

    onDisplayModeTap(e: WechatMiniprogram.BaseEvent) {
      const { value } = e.currentTarget.dataset;
      this.setFilter('displayMode', value);
    },

    onRealExamTap(e: WechatMiniprogram.BaseEvent) {
      const { value } = e.currentTarget.dataset;
      this.setFilter('isRealExam', value === '' ? '' : value === 'true');
    },

    onYearTap(e: WechatMiniprogram.BaseEvent) {
      const { value } = e.currentTarget.dataset;
      this.setFilter('sourceYear', value === '' ? '' : Number(value));
    },

    onPaperTap(e: WechatMiniprogram.BaseEvent) {
      const { value } = e.currentTarget.dataset;
      this.setFilter('sourcePaper', value);
    },

    onDifficultyTap(e: WechatMiniprogram.BaseEvent) {
      const { value } = e.currentTarget.dataset;
      this.setFilter('difficulty', value === '' ? '' : Number(value));
    },

    setFilter(key: keyof QuestionFilters, value: unknown) {
      this.setData({
        [`localFilters.${key}`]: value,
      });
    },

    onReset() {
      const empty: QuestionFilters = {};
      this.setData({ localFilters: empty });
      this.triggerEvent('reset');
    },

    onConfirm() {
      this.triggerEvent('confirm', { filters: this.data.localFilters });
    },
  },
});
