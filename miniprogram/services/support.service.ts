import { post } from '../utils/request';
import type { SupportAnswer } from '../mock/handlers/support.handler';

export function answerQuestion(question: string): Promise<SupportAnswer> {
  return post<SupportAnswer>('/api/support/answer', { question });
}
