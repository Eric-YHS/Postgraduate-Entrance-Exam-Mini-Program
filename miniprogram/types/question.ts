import type { ListItem, PaginationParams } from './common';

/** 学科 */
export type QuestionSubject = 'politics' | 'english' | 'math';

/** 题目展示模式 */
export type DisplayMode = 'radio' | 'word' | 'formula';

/** 题目选项 */
export interface QuestionOption {
  /** 选项标签：A/B/C/D */
  label: string;
  /** 选项文本 */
  text: string;
  /** 选项图片（公式题可能使用） */
  imageUrl?: string;
}

/** 题目 */
export interface Question extends ListItem {
  /** 学科 */
  subject: QuestionSubject;
  /** 展示模式 */
  displayMode: DisplayMode;
  /** 题干 */
  stem: string;
  /** 题干图片 */
  stemImageUrl?: string;
  /** 选项列表 */
  options: QuestionOption[];
  /** 正确选项标签，如 'A' */
  correctOption: string;
  /** 解析 */
  explanation: string;

  // ===== word 模式专有字段 =====
  /** 音标 */
  phonetic?: string;
  /** 例句 */
  exampleSentence?: string;
  /** 词根 */
  wordRoot?: string;
  /** 词缀 */
  affix?: string;

  // ===== formula 模式专有字段 =====
  /** 公式题干图片路径 */
  formulaImagePath?: string;

  // ===== 历年真题元数据（A-04 预留） =====
  /** 真题年份 */
  sourceYear?: number;
  /** 试卷编号 */
  sourcePaper?: string;
  /** 难度 1-5 */
  difficulty?: number;
  /** 是否历年真题 */
  isRealExam?: boolean;
}

/** 错题记录项 */
export interface WrongBookItem {
  questionId: string;
  /** 累计做错次数 */
  wrongCount: number;
  /** 最近一次做错时间 */
  lastWrongAt: string;
  /** 是否已掌握 */
  isMastered: boolean;
  /** 掌握时间 */
  masteredAt?: string;
}

/** 错题本中的题目（合并 Question + 错题记录） */
export interface WrongQuestion extends Question {
  wrongCount: number;
  lastWrongAt: string;
  isMastered: boolean;
  masteredAt?: string;
}

/** 练习答题记录 */
export interface PracticeRecord {
  questionId: string;
  selectedOption: string;
  isCorrect: boolean;
  answeredAt: string;
}

/** 题目查询参数 */
export interface QuestionQueryParams extends Partial<PaginationParams> {
  subject?: QuestionSubject;
  displayMode?: DisplayMode;
  isRealExam?: boolean;
  sourceYear?: number;
  sourcePaper?: string;
  difficulty?: number;
}

/** 错题本查询参数 */
export interface WrongBookQueryParams extends Partial<PaginationParams> {
  /** 是否查询已掌握历史，默认 false */
  includeMastered?: boolean;
}

/** 练习提交参数 */
export interface SubmitAnswerParams {
  questionId: string;
  selectedOption: string;
}
