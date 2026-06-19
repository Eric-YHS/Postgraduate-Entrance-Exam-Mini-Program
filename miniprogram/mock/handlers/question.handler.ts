import type { Question, QuestionQueryParams, WrongBookQueryParams } from '../../types/question';
import type { PaginationData } from '../../types/common';
import { mockAllQuestions, mockQuestionMap } from '../data/questions';

/** 随机打乱数组（Fisher-Yates） */
function shuffle<T>(array: T[]): T[] {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** 为英语单词题动态生成干扰项 */
function enrichWordQuestion(question: Question): Question {
  if (question.displayMode !== 'word') return question;

  const correctOption = question.options.find((o) => o.label === question.correctOption);
  if (!correctOption) return question;

  // 从同 subject 下其他 word 题的正确释义中抽取干扰项
  const distractorPool = mockAllQuestions
    .filter((q) => q.id !== question.id && q.subject === 'english' && q.displayMode === 'word')
    .map((q) => q.options.find((o) => o.label === q.correctOption)?.text)
    .filter((text): text is string => !!text);

  const distractors = shuffle(distractorPool).slice(0, 3);
  const optionTexts = shuffle([correctOption.text, ...distractors]);
  const labels = ['A', 'B', 'C', 'D'];
  const newCorrectIndex = optionTexts.indexOf(correctOption.text);

  return {
    ...question,
    options: optionTexts.map((text, index) => ({
      label: labels[index],
      text,
    })),
    correctOption: labels[newCorrectIndex],
  };
}

/** 查询题目列表 */
export function mockGetQuestions(params: QuestionQueryParams): Promise<PaginationData<Question>> {
  const { subject, displayMode, isRealExam, sourceYear, sourcePaper, difficulty, page = 1, pageSize = 10 } = params;

  let list = [...mockAllQuestions];

  if (subject) {
    list = list.filter((item) => item.subject === subject);
  }

  if (displayMode) {
    list = list.filter((item) => item.displayMode === displayMode);
  }

  if (isRealExam !== undefined) {
    list = list.filter((item) => item.isRealExam === isRealExam);
  }

  if (sourceYear) {
    list = list.filter((item) => item.sourceYear === sourceYear);
  }

  if (sourcePaper) {
    list = list.filter((item) => item.sourcePaper === sourcePaper);
  }

  if (difficulty) {
    list = list.filter((item) => item.difficulty === difficulty);
  }

  // 英语单词题动态生成干扰项
  list = list.map((item) => (item.displayMode === 'word' ? enrichWordQuestion(item) : item));

  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  const paginatedList = list.slice(start, end);

  return Promise.resolve({
    list: paginatedList,
    total: list.length,
    page,
    pageSize,
  });
}

/** 查询单个题目 */
export function mockGetQuestionById(id: string): Promise<Question | null> {
  const question = mockQuestionMap[id] || null;
  if (question && question.displayMode === 'word') {
    return Promise.resolve(enrichWordQuestion(question));
  }
  return Promise.resolve(question);
}

/** 错题本查询（仅返回题目 ID 列表，由业务层结合本地存储组装） */
export function mockGetWrongQuestions(_params: WrongBookQueryParams): Promise<PaginationData<Question>> {
  // Mock 阶段：业务层会在 services/question.service.ts 中结合本地错题本存储过滤
  // 这里返回全部题目作为数据池
  const page = _params.page || 1;
  const pageSize = _params.pageSize || 10;
  const list = mockAllQuestions.map((item) => (item.displayMode === 'word' ? enrichWordQuestion(item) : item));
  const start = (page - 1) * pageSize;
  const end = start + pageSize;

  return Promise.resolve({
    list: list.slice(start, end),
    total: list.length,
    page,
    pageSize,
  });
}

/** 标记错题已掌握（Mock 阶段仅返回成功，实际状态更新由业务层写入本地存储） */
export function mockMasterWrongQuestion(_id: string): Promise<{ success: boolean }> {
  return Promise.resolve({ success: true });
}
