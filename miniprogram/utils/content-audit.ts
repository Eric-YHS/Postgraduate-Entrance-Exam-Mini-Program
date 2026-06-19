import type { AuditStatus } from '../types/forum';
import { post } from './request';

interface TrieNode {
  children: Record<string, TrieNode>;
  isEnd: boolean;
}

/** 基础敏感词库（本地兜底，后续可替换为云端 security.msgSecCheck） */
const DEFAULT_SENSITIVE_WORDS = ['傻逼', '他妈的', '草泥马', '垃圾', '骗子', '色情', '赌博', '毒品', '枪支', '诈骗'];

/** 构建 Trie 树 */
function buildTrie(words: string[]): TrieNode {
  const root: TrieNode = { children: {}, isEnd: false };
  for (const word of words) {
    if (!word) continue;
    let node = root;
    for (const char of word) {
      if (!node.children[char]) {
        node.children[char] = { children: {}, isEnd: false };
      }
      node = node.children[char];
    }
    node.isEnd = true;
  }
  return root;
}

const trieRoot = buildTrie(DEFAULT_SENSITIVE_WORDS);

/** 检测文本中是否包含敏感词 */
export function hasSensitiveWords(text: string): boolean {
  return auditText(text).hitWords.length > 0;
}

/** 审核文本，返回命中的敏感词列表 */
export function auditText(text: string): { passed: boolean; hitWords: string[]; status: AuditStatus } {
  if (!text) {
    return { passed: true, hitWords: [], status: 'passed' };
  }

  const hitWords: string[] = [];
  const chars = Array.from(text);

  for (let i = 0; i < chars.length; i++) {
    let node = trieRoot;
    let matched = '';
    for (let j = i; j < chars.length; j++) {
      const char = chars[j];
      if (!node.children[char]) break;
      node = node.children[char];
      matched += char;
      if (node.isEnd && !hitWords.includes(matched)) {
        hitWords.push(matched);
      }
    }
  }

  const passed = hitWords.length === 0;
  return {
    passed,
    hitWords,
    status: passed ? 'passed' : 'rejected',
  };
}

/** 异步云端审核：先本地 Trie 匹配，再调用后端 sensitive_words 表审核 */
export async function cloudAuditText(
  text: string
): Promise<{ passed: boolean; hitWords: string[]; status: AuditStatus }> {
  // 先走本地审核
  const local = auditText(text);
  if (!local.passed) return local;

  // 调用后端 /api/content/audit
  try {
    const result = await post<{ passed: boolean; hitWords: string[]; status: AuditStatus }>(
      '/api/content/audit',
      { text }
    );
    if (result) return result;
  } catch (err) {
    console.warn('[cloudAudit] 云端审核请求失败，回退到本地结果:', err);
  }

  return local;
}
