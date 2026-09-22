import type { VocabularyCard } from '../../services/vocabulary.service';

let cards: VocabularyCard[] = [
  {
    id: 1,
    word: 'difficult',
    meaning: '困难的',
    mnemonic: 'di-弟弟，f-拐杖，i-烟，c-弯月，u-杯子；用画面把拼写串起来。',
    phonetic: '/ˈdɪfɪkəlt/',
    nextReviewDate: '',
  },
  {
    id: 2,
    word: 'approach',
    meaning: '方法；接近',
    mnemonic: 'ap + pro + ach，先记“接近”，再扩展到解决问题的方法。',
    phonetic: '/əˈprəʊtʃ/',
    nextReviewDate: '',
  },
  {
    id: 3,
    word: 'significant',
    meaning: '重要的；显著的',
    mnemonic: 'sign（标志）+ ific + ant：有明显标志，所以是显著的。',
    phonetic: '/sɪɡˈnɪfɪkənt/',
    nextReviewDate: '',
  },
];

export function mockGetVocabularyCards(): { cards: VocabularyCard[] } {
  return { cards };
}

export function mockReviewVocabularyCard(data: Record<string, unknown>): { nextReviewDate: string } {
  const id = Number(data.id);
  const date = new Date();
  date.setDate(date.getDate() + (Number(data.quality) >= 2 ? 3 : 1));
  const nextReviewDate = date.toISOString().slice(0, 10);
  cards = cards.filter((card) => card.id !== id);
  return { nextReviewDate };
}
