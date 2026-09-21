import { get, post } from '../utils/request';

export type VocabularyCard = {
  id: number;
  word: string;
  meaning: string;
  mnemonic: string;
  phonetic: string;
  nextReviewDate: string;
};

export function getVocabularyCards(): Promise<{ cards: VocabularyCard[] }> {
  return get<{ cards: VocabularyCard[] }>('/api/student/vocabulary', undefined, { loading: false });
}

export function reviewVocabularyCard(id: number, quality: 0 | 1 | 2 | 3): Promise<{ nextReviewDate: string }> {
  return post<{ nextReviewDate: string }>('/api/student/vocabulary/review', { id, quality }, { loading: false });
}
