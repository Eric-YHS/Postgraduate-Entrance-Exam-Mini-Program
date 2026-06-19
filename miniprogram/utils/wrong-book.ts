import { getStorageSync, setStorageSync } from './storage';
import { StorageKey } from '../constants/storage-keys';
import type { WrongBookItem } from '../types/question';

const WRONG_BOOK_KEY = StorageKey.WRONG_BOOK;

/** 获取全部错题本记录 */
function getAllItems(): Record<string, WrongBookItem> {
  return getStorageSync<Record<string, WrongBookItem>>(WRONG_BOOK_KEY) || {};
}

/** 保存全部错题本记录 */
function saveAllItems(items: Record<string, WrongBookItem>): void {
  setStorageSync(WRONG_BOOK_KEY, items);
}

/** 记录一次错题 */
export function recordWrongQuestion(questionId: string): void {
  const items = getAllItems();
  const existing = items[questionId];

  items[questionId] = {
    questionId,
    wrongCount: (existing?.wrongCount || 0) + 1,
    lastWrongAt: new Date().toISOString(),
    isMastered: false,
  };

  saveAllItems(items);
}

/** 标记错题为已掌握 */
export function masterWrongQuestion(questionId: string): void {
  const items = getAllItems();
  const existing = items[questionId];
  if (!existing) return;

  items[questionId] = {
    ...existing,
    isMastered: true,
    masteredAt: new Date().toISOString(),
  };

  saveAllItems(items);
}

/** 取消已掌握（重新加入错题本） */
export function unmasterWrongQuestion(questionId: string): void {
  const items = getAllItems();
  const existing = items[questionId];
  if (!existing) return;

  items[questionId] = {
    ...existing,
    isMastered: false,
    masteredAt: undefined,
  };

  saveAllItems(items);
}

/** 获取单个错题记录 */
export function getWrongBookItem(questionId: string): WrongBookItem | null {
  const items = getAllItems();
  return items[questionId] || null;
}

/** 获取全部错题记录 */
export function getAllWrongBookItems(): WrongBookItem[] {
  return Object.values(getAllItems());
}

/** 获取未掌握的错题 */
export function getActiveWrongItems(): WrongBookItem[] {
  return getAllWrongBookItems().filter((item) => !item.isMastered);
}

/** 获取已掌握历史 */
export function getMasteredItems(): WrongBookItem[] {
  return getAllWrongBookItems().filter((item) => item.isMastered);
}

/** 清空错题本 */
export function clearWrongBook(): void {
  setStorageSync(WRONG_BOOK_KEY, {});
}
