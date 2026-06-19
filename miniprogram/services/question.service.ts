import { get } from '../utils/request';
import { ApiEndpoints } from './api-types';
import type { Question, QuestionQueryParams, WrongBookQueryParams, WrongQuestion } from '../types/question';
import type { PaginationData, PaginationParams } from '../types/common';
import {
  getActiveWrongItems,
  getMasteredItems,
  masterWrongQuestion as masterWrongQuestionLocal,
  recordWrongQuestion,
  getWrongBookItem,
} from '../utils/wrong-book';

/** 获取题目列表 */
export function getQuestions(params: QuestionQueryParams): Promise<PaginationData<Question>> {
  return get<PaginationData<Question>>(ApiEndpoints.QUESTIONS, params as Record<string, unknown>);
}

/** 获取单个题目 */
export function getQuestionById(id: string): Promise<Question | null> {
  return get<Question | null>(ApiEndpoints.QUESTION_DETAIL, { id });
}

/** 获取错题本列表（结合本地存储的错题记录） */
export async function getWrongQuestions(params: WrongBookQueryParams = {}): Promise<PaginationData<WrongQuestion>> {
  const { includeMastered = false, page = 1, pageSize = 10 } = params;

  const localItems = includeMastered ? [...getActiveWrongItems(), ...getMasteredItems()] : getActiveWrongItems();

  const sortedItems = localItems.sort((a, b) => new Date(b.lastWrongAt).getTime() - new Date(a.lastWrongAt).getTime());

  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  const paginatedItems = sortedItems.slice(start, end);

  const questionPromises = paginatedItems.map((item) => getQuestionById(item.questionId));
  const questions = await Promise.all(questionPromises);

  const list: WrongQuestion[] = [];
  for (let i = 0; i < paginatedItems.length; i++) {
    const question = questions[i];
    const item = paginatedItems[i];
    if (question) {
      list.push({
        ...question,
        wrongCount: item.wrongCount,
        lastWrongAt: item.lastWrongAt,
        isMastered: item.isMastered,
        masteredAt: item.masteredAt,
      });
    }
  }

  return {
    list,
    total: sortedItems.length,
    page,
    pageSize,
  };
}

/** 标记错题已掌握 */
export async function masterWrongQuestion(questionId: string): Promise<void> {
  masterWrongQuestionLocal(questionId);
  await get(ApiEndpoints.MASTER_WRONG_QUESTION, { questionId });
}

/** 提交答案并记录对错 */
export async function submitAnswer(
  questionId: string,
  selectedOption: string
): Promise<{ isCorrect: boolean; question: Question | null }> {
  const question = await getQuestionById(questionId);
  if (!question) {
    return { isCorrect: false, question: null };
  }

  const isCorrect = question.correctOption === selectedOption;
  if (!isCorrect) {
    recordWrongQuestion(questionId);
  }

  return { isCorrect, question };
}

/** 判断某题是否已在错题本中 */
export function isQuestionWrong(questionId: string): boolean {
  return !!getWrongBookItem(questionId) && !getWrongBookItem(questionId)?.isMastered;
}

/** 分页参数辅助 */
export function createPaginationParams(page = 1, pageSize = 10): PaginationParams {
  return { page, pageSize };
}
