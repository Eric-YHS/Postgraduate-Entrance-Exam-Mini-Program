import type { Question } from '../../types/question';

/** 政治单选题（默认 radio 模式） */
export const mockPoliticsQuestions: Question[] = [
  {
    id: 'q_politics_001',
    subject: 'politics',
    displayMode: 'radio',
    stem: '马克思主义产生的经济根源是（  ）',
    options: [
      { label: 'A', text: '工业革命' },
      { label: 'B', text: '资本主义社会生产力和生产关系的矛盾运动' },
      { label: 'C', text: '阶级斗争' },
      { label: 'D', text: '资本原始积累' },
    ],
    correctOption: 'B',
    explanation: '马克思主义产生的经济根源是资本主义社会生产力和生产关系的矛盾运动。',
    sourceYear: 2024,
    sourcePaper: '全国卷',
    isRealExam: true,
    difficulty: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'q_politics_002',
    subject: 'politics',
    displayMode: 'radio',
    stem: '毛泽东思想活的灵魂不包括（  ）',
    options: [
      { label: 'A', text: '实事求是' },
      { label: 'B', text: '群众路线' },
      { label: 'C', text: '独立自主' },
      { label: 'D', text: '武装斗争' },
    ],
    correctOption: 'D',
    explanation: '毛泽东思想活的灵魂是实事求是、群众路线、独立自主。',
    sourceYear: 2023,
    sourcePaper: '全国卷',
    isRealExam: true,
    difficulty: 4,
    createdAt: '2026-01-02T00:00:00.000Z',
  },
  {
    id: 'q_politics_003',
    subject: 'politics',
    displayMode: 'radio',
    stem: '新民主主义革命的性质是（  ）',
    options: [
      { label: 'A', text: '无产阶级社会主义革命' },
      { label: 'B', text: '资产阶级民主革命' },
      { label: 'C', text: '农民阶级反封建革命' },
      { label: 'D', text: '民族资产阶级革命' },
    ],
    correctOption: 'B',
    explanation: '新民主主义革命的性质是资产阶级民主革命，但由无产阶级领导。',
    sourceYear: 2022,
    sourcePaper: '全国卷',
    isRealExam: true,
    difficulty: 5,
    createdAt: '2026-01-03T00:00:00.000Z',
  },
];

/** 英语单词题（word 模式） */
export const mockEnglishQuestions: Question[] = [
  {
    id: 'q_english_001',
    subject: 'english',
    displayMode: 'word',
    stem: 'abandon',
    phonetic: '/əˈbændən/',
    options: [
      { label: 'A', text: '放弃，抛弃' },
      { label: 'B', text: 'abbreviate' },
      { label: 'C', text: 'abide' },
      { label: 'D', text: 'absorb' },
    ],
    correctOption: 'A',
    explanation: 'abandon 意为放弃、抛弃。',
    exampleSentence: 'He abandoned his car and ran for help.',
    wordRoot: 'a-（去）+ bandon（管辖权）',
    affix: '前缀 a- 表示“去、离”',
    createdAt: '2026-01-04T00:00:00.000Z',
  },
  {
    id: 'q_english_002',
    subject: 'english',
    displayMode: 'word',
    stem: 'abbreviate',
    phonetic: '/əˈbriːvieɪt/',
    options: [
      { label: 'A', text: '缩写，缩短' },
      { label: 'B', text: 'abandon' },
      { label: 'C', text: 'abide' },
      { label: 'D', text: 'absorb' },
    ],
    correctOption: 'A',
    explanation: 'abbreviate 意为缩写、缩短。',
    exampleSentence: 'The name Robert is often abbreviated to Rob.',
    createdAt: '2026-01-05T00:00:00.000Z',
  },
  {
    id: 'q_english_003',
    subject: 'english',
    displayMode: 'word',
    stem: 'abide',
    phonetic: '/əˈbaɪd/',
    options: [
      { label: 'A', text: '遵守，忍受' },
      { label: 'B', text: 'abandon' },
      { label: 'C', text: 'abbreviate' },
      { label: 'D', text: 'absorb' },
    ],
    correctOption: 'A',
    explanation: 'abide 意为遵守、忍受，常见搭配 abide by。',
    exampleSentence: 'You must abide by the rules of the game.',
    createdAt: '2026-01-06T00:00:00.000Z',
  },
  {
    id: 'q_english_004',
    subject: 'english',
    displayMode: 'word',
    stem: 'absorb',
    phonetic: '/əbˈsɔːrb/',
    options: [
      { label: 'A', text: '吸收，使全神贯注' },
      { label: 'B', text: 'abandon' },
      { label: 'C', text: 'abbreviate' },
      { label: 'D', text: 'abide' },
    ],
    correctOption: 'A',
    explanation: 'absorb 意为吸收、使全神贯注。',
    exampleSentence: 'Plants absorb carbon dioxide from the air.',
    createdAt: '2026-01-07T00:00:00.000Z',
  },
  {
    id: 'q_english_005',
    subject: 'english',
    displayMode: 'word',
    stem: 'abundant',
    phonetic: '/əˈbʌndənt/',
    options: [
      { label: 'A', text: '丰富的，大量的' },
      { label: 'B', text: 'abstract' },
      { label: 'C', text: 'absurd' },
      { label: 'D', text: 'accelerate' },
    ],
    correctOption: 'A',
    explanation: 'abundant 意为丰富的、大量的。',
    exampleSentence: 'The region is abundant in wildlife.',
    createdAt: '2026-01-08T00:00:00.000Z',
  },
  {
    id: 'q_english_006',
    subject: 'english',
    displayMode: 'word',
    stem: 'abstract',
    phonetic: '/ˈæbstrækt/',
    options: [
      { label: 'A', text: '抽象的，摘要' },
      { label: 'B', text: 'abundant' },
      { label: 'C', text: 'absurd' },
      { label: 'D', text: 'accelerate' },
    ],
    correctOption: 'A',
    explanation: 'abstract 作形容词意为抽象的，作名词意为摘要。',
    exampleSentence: 'Truth and beauty are abstract concepts.',
    createdAt: '2026-01-09T00:00:00.000Z',
  },
];

/** 数学公式匹配题（formula 模式） */
export const mockMathQuestions: Question[] = [
  {
    id: 'q_math_001',
    subject: 'math',
    displayMode: 'formula',
    stem: 'sin²x + cos²x = ?',
    options: [
      { label: 'A', text: '1' },
      { label: 'B', text: '0' },
      { label: 'C', text: '2' },
      { label: 'D', text: 'x' },
    ],
    correctOption: 'A',
    explanation: '根据三角函数基本恒等式，sin²x + cos²x = 1。',
    createdAt: '2026-01-10T00:00:00.000Z',
  },
  {
    id: 'q_math_002',
    subject: 'math',
    displayMode: 'formula',
    stem: "导数 (x²)' = ?",
    options: [
      { label: 'A', text: '2x' },
      { label: 'B', text: 'x²' },
      { label: 'C', text: '2' },
      { label: 'D', text: 'x' },
    ],
    correctOption: 'A',
    explanation: "根据幂函数求导法则，(x²)' = 2x。",
    createdAt: '2026-01-11T00:00:00.000Z',
  },
  {
    id: 'q_math_003',
    subject: 'math',
    displayMode: 'formula',
    stem: '∫ 2x dx = ?',
    options: [
      { label: 'A', text: 'x² + C' },
      { label: 'B', text: '2x² + C' },
      { label: 'C', text: 'x + C' },
      { label: 'D', text: '2 + C' },
    ],
    correctOption: 'A',
    explanation: '∫ 2x dx = x² + C，其中 C 为积分常数。',
    createdAt: '2026-01-12T00:00:00.000Z',
  },
];

/** 全部题目 */
export const mockAllQuestions: Question[] = [...mockPoliticsQuestions, ...mockEnglishQuestions, ...mockMathQuestions];

/** 按 ID 索引的题目 */
export const mockQuestionMap: Record<string, Question> = mockAllQuestions.reduce(
  (map, q) => {
    map[q.id] = q;
    return map;
  },
  {} as Record<string, Question>
);
