import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, BookOpen, Bot, BrainCircuit, Check, ChevronLeft, ChevronRight, CircleHelp,
  ClipboardCheck, Clock3, FileQuestion, FileText, GraduationCap, ImagePlus, LayoutDashboard,
  LockKeyhole, LogOut, Maximize2, Menu, MessageSquareText, Minimize2, Moon, PackageOpen, PenLine, Play,
  Plus, Search, Settings2, ShieldCheck, Sparkles, Trash2, Upload, FileDown, UserPlus, UserRound, UserRoundX, Users, X, AlertTriangle
} from 'lucide-react';
import katex from 'katex';
import * as XLSX from 'xlsx';
import { aiCapabilities, courses, planTemplates, subjects } from './data.js';
import { answersMatch, apiRequest, buildAssessmentSubmissionPayload, buildStudentPlanPayload, buildStudentProfilePatch, COMPANION_STUDY_RESOURCE_TYPE, getAssessmentSubmissionState, getSessionAuthVersion, isApiConfigured, normalizeMultipleChoiceAnswer, normalizeSubjectCategory, resolveApiUrl } from './api.js';

const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_IMPORT_ROWS = 10000;

// Changing a password increments the server session version. Re-authenticate
// immediately so the browser receives the replacement HttpOnly session cookie;
// never treat the old cookie as valid after a successful password change.
const reauthenticateAfterPasswordChange = async (account, newPassword) => {
  const result = await apiRequest('/api/auth/login', {
    method: 'POST',
    suppressAuthExpired: true,
    body: { phone: normalizePhone(account?.phone), password: newPassword }
  });
  const refreshedAccount = result?.account || {};
  return {
    account: refreshedAccount,
    sessionVersion: getSessionAuthVersion(result, getSessionAuthVersion(refreshedAccount, null)),
  };
};
const readWorkbookSafely = (file, onSuccess, onError) => {
  if (!file || file.size > MAX_IMPORT_FILE_BYTES) {
    onError(new Error('导入文件不能超过 10 MB'));
    return;
  }
  const reader = new FileReader();
  reader.onload = event => {
    try {
      const workbook = XLSX.read(event.target.result, {
        type: 'array',
        cellFormula: false,
        cellHTML: false,
        cellStyles: false,
        bookVBA: false,
        bookFiles: false,
        dense: true
      });
      const sheetName = workbook.SheetNames?.[0];
      const worksheet = sheetName ? workbook.Sheets[sheetName] : null;
      const range = worksheet?.['!ref'] ? XLSX.utils.decode_range(worksheet['!ref']) : null;
      if (!worksheet || !range || range.e.r - range.s.r + 1 > MAX_IMPORT_ROWS) throw new Error('导入行数不能超过 10000 行');
      onSuccess(workbook, worksheet);
    } catch (error) { onError(error); }
  };
  reader.onerror = () => onError(new Error('读取文件失败'));
  reader.readAsArrayBuffer(file);
};
const downloadTaskTemplate = () => {
  const link = document.createElement('a');
  link.href = `${window.location.origin}/任务模板.xls`;
  link.download = '任务模板.xls';
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  window.setTimeout(() => link.remove(), 0);
};

const parseTaskTemplate = (file, onSuccess, onError) => {
  readWorkbookSafely(file, (workbook, worksheet) => {
    try {
      const rawRows = XLSX.utils.sheet_to_json(worksheet, { defval: '' });
      const normalizeHeader = value => String(value || '').replace(/\s+/g, '').trim();
      const rows = rawRows.map(row => Object.fromEntries(
        Object.entries(row).map(([key, value]) => [normalizeHeader(key), value])
      ));
      const firstRow = rows[0] || {};
      const headers = Object.keys(firstRow);
      const sequenceKey = headers.find(key => ['序号', '编号', '天数', '日期'].includes(key));
      const taskHeaders = headers.filter(key => key !== sequenceKey && key !== '补充' && /任务|内容|科目|章节|视频|单词|阅读|练习/.test(key));
      if (!rows.length || !sequenceKey || !taskHeaders.length) {
        throw new Error(`模板缺少字段：${!sequenceKey ? '序号' : !taskHeaders.length ? '至少一个任务列' : '没有有效任务行'}`);
      }
      const importedRows = rows
        .filter(row => String(row[sequenceKey]).trim())
        .map((row, index) => ({
          day: formatTeacherPlanDay(row[sequenceKey] || index + 1),
          tasks: taskHeaders.map(key => String(row[key] || '').trim()),
          note: String(row.补充 || '').trim()
        }))
        .filter(row => row.tasks.some(Boolean) || row.note);
      if (!importedRows.length) throw new Error('没有有效任务行');
      onSuccess(importedRows, taskHeaders);
    } catch (error) { onError(error); }
  }, onError);
};

const defaultReviewColumns = ['任务1', '任务2', '任务3', '任务4', '任务5'];
const formatTeacherPlanDay = (dayNumber) => {
  const numerals = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  const value = Math.max(1, Number(dayNumber) || 1);
  if (value <= 10) return `第${numerals[value]}天`;
  if (value < 20) return `第十${value === 10 ? '' : numerals[value - 10]}天`;
  if (value % 10 === 0) return `第${numerals[Math.floor(value / 10)]}十天`;
  return `第${numerals[Math.floor(value / 10)]}十${numerals[value % 10]}天`;
};
const formatStudyDate = (offset = 0, now = new Date()) => {
  const date = new Date(now);
  date.setDate(date.getDate() + offset);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
};
// 初试日期按考试年份推算：初试通常在上一自然年 12 月下旬，这里暂定 12 月 20 日 08:30。
// 暂定日期一旦过去，自动滚动到下一个未来的 12 月 20 日继续倒计时（仍按"暂定"标注），不再归零。
const getExamCountdownTarget = (examYear, now = new Date()) => {
  let target = new Date(Number(examYear) - 1, 11, 20, 8, 30, 0);
  while (target.getTime() <= now.getTime()) {
    target = new Date(target.getFullYear() + 1, 11, 20, 8, 30, 0);
  }
  return target;
};
// 「已登记考试信息」= 已填考试年份且至少一门报考科目；年份取档案中的四位数字（如 '2027 考研' → 2027）。
const getRegisteredExamYear = student => {
  const match = String(student?.year || '').match(/\d{4}/);
  return match ? Number(match[0]) : null;
};
// 「已登记考试信息」= 已填考试年份且至少勾选一门报考科目（学生自行勾选即算，enrolled 是教师端确认口径，不影响倒计时展示）。
const hasRegisteredExamInfo = student => Boolean(String(student?.year || '').trim()) && (student?.subjects || []).some(item => item && String(item.name || item.subject || '').trim());
const getPlanAdjustmentAutomation = (student) => ({
  enabled: false,
  autoCalibrate: false,
  intervalDays: 3,
  lastCheckedAt: null,
  ...(student?.planAdjustmentAutomation || {})
});
const shouldRunPlanAdjustmentCheck = (automation, now = Date.now()) => {
  if (!automation?.enabled) return false;
  if (!automation.lastCheckedAt) return true;
  return now - new Date(automation.lastCheckedAt).getTime() >= Math.max(0, Number(automation.intervalDays) || 0) * 24 * 60 * 60 * 1000;
};
const initialReviewPlans = {
  政治: [{id:1,name:'政治复习计划',category:'基础',columns:defaultReviewColumns,rows:[{day:'第一天',tasks:['马原导论','','','','','','','',''],note:'基础概念'}]}],
  英语: [], 数学: [], 专业课: []
};

const REVIEW_PLANS_STORAGE_KEY = 'shangan-review-plans-v2';
const CONTENT_STORAGE_KEY = 'shangan-content-management-v1';
const COURSE_CATEGORY_STORAGE_KEY = 'shangan-course-categories-v1';
const ACCOUNTS_STORAGE_KEY = 'shangan-accounts-v1';
const STUDENTS_STORAGE_KEY = 'shangan-students-v1';
const REGISTRATION_APPLICATIONS_STORAGE_KEY = 'shangan-registration-applications-v2';
const LEGACY_REGISTRATION_APPLICATIONS_STORAGE_KEYS = ['shangan-registration-applications-v1'];
const SESSION_STORAGE_KEY = 'shangan-session-v1';
const LEARNING_PROGRESS_STORAGE_KEY = 'shangan-learning-progress-v1';
// In API mode this in-memory mirror is hydrated from the server and is never
// written to localStorage. It lets tool cards render server progress immediately
// without turning browser state into the source of truth.
let serverLearningProgressStore = {};
const TEST_STUDENT_ID = 'student-test';

const getLearningDateKey = (date = new Date()) => {
  const value = new Date(date);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
};
const getPreviousLearningDateKey = (date = new Date()) => {
  const value = new Date(date);
  value.setDate(value.getDate() - 1);
  return getLearningDateKey(value);
};
const getLearningProgressKey = (studentId, resourceType, resourceId) => `${studentId || 'anonymous'}:${resourceType}:${resourceId}`;
const loadLearningProgressStore = () => {
  try {
    const raw = window.localStorage.getItem(LEARNING_PROGRESS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return {};
  }
};
const saveLearningProgressStore = store => {
  try { window.localStorage.setItem(LEARNING_PROGRESS_STORAGE_KEY, JSON.stringify(store)); } catch (error) { /* ignore local persistence errors */ }
};
const readLearningProgress = (studentId, resourceType, resourceId, totalCount) => {
  const store = isApiConfigured() ? serverLearningProgressStore : loadLearningProgressStore();
  const key = getLearningProgressKey(studentId, resourceType, resourceId);
  const existing = store[key] || {};
  const records = existing.dailyRecords && typeof existing.dailyRecords === 'object' ? existing.dailyRecords : {};
  const learnedItemIds = Array.isArray(existing.learnedItemIds) ? existing.learnedItemIds : [];
  return {
    resourceType, resourceId, totalCount,
    learnedCount: learnedItemIds.length,
    nextIndex: Number.isInteger(existing.nextIndex) ? Math.min(Math.max(existing.nextIndex, 0), totalCount) : 0,
    learnedItemIds, yesterdayItemIds: Array.isArray(records[getPreviousLearningDateKey()]) ? records[getPreviousLearningDateKey()] : [],
    dailyRecords: records, lastStudyDate: existing.lastStudyDate || '', updatedAt: existing.updatedAt || ''
  };
};
const buildLearningCompletion = (studentId, resourceType, resourceId, itemId, totalCount, existing = readLearningProgress(studentId, resourceType, resourceId, totalCount)) => {
  const learnedItemIds = existing.learnedItemIds.includes(itemId) ? existing.learnedItemIds : [...existing.learnedItemIds, itemId];
  const dateKey = getLearningDateKey();
  const dailyRecords = {...existing.dailyRecords, [dateKey]: Array.from(new Set([...(existing.dailyRecords[dateKey] || []), itemId]))};
  const nextIndex = Math.min(totalCount, existing.nextIndex + (learnedItemIds.includes(itemId) && !existing.learnedItemIds.includes(itemId) ? 1 : 0));
  return {...existing, learnedCount:learnedItemIds.length, learnedItemIds, nextIndex, dailyRecords, lastStudyDate:dateKey, updatedAt:new Date().toISOString()};
};

/** Persist a learning event before updating the API-mode mirror. A failed write
 * is returned to the caller so the UI cannot claim a successful cloud save. */
const persistLearningCompletion = async (studentId, resourceType, resourceId, itemId, totalCount) => {
  const existing = readLearningProgress(studentId, resourceType, resourceId, totalCount);
  if (isApiConfigured()) {
    if (!studentId || !/^[0-9a-f-]{36}$/i.test(String(studentId))) throw new Error('学生档案 ID 无效，学习进度未保存');
    await apiRequest(`/api/students/${encodeURIComponent(studentId)}/learning-progress`, {
      method: 'POST',
      body: { resourceType, resourceId: String(resourceId), itemId: String(itemId), totalCount: Number(totalCount) || 0 },
    });
    const next = buildLearningCompletion(studentId, resourceType, resourceId, itemId, totalCount, existing);
    const store = { ...serverLearningProgressStore, [getLearningProgressKey(studentId, resourceType, resourceId)]: next };
    serverLearningProgressStore = store;
    return next;
  }
  const store = loadLearningProgressStore();
  const next = buildLearningCompletion(studentId, resourceType, resourceId, itemId, totalCount, existing);
  store[getLearningProgressKey(studentId, resourceType, resourceId)] = next;
  saveLearningProgressStore(store);
  return next;
};

const refreshServerLearningProgress = async (studentId, resourceType, resourceId, totalCount) => {
  if (!isApiConfigured()) return readLearningProgress(studentId, resourceType, resourceId, totalCount);
  if (!studentId) throw new Error('学生档案 ID 无效，学习进度无法刷新');
  const query = new URLSearchParams({ resourceType: String(resourceType), resourceId: String(resourceId) });
  const rows = await apiRequest(`/api/students/${encodeURIComponent(studentId)}/learning-progress?${query.toString()}`, { cache: 'no-store' });
  const items = Array.isArray(rows) ? rows : [];
  const key = getLearningProgressKey(studentId, resourceType, resourceId);
  const learnedItemIds = Array.from(new Set(items.map(item => String(item.itemId || item.item_id || '')).filter(Boolean)));
  const dailyRecords = {};
  items.forEach(item => {
    const itemId = String(item.itemId || item.item_id || '');
    if (!itemId) return;
    const dateKey = getLearningDateKey(item.completedOn || item.completed_on || item.createdAt || item.created_at);
    dailyRecords[dateKey] = Array.from(new Set([...(dailyRecords[dateKey] || []), itemId]));
  });
  const next = { resourceType, resourceId: String(resourceId), totalCount, learnedCount: learnedItemIds.length, nextIndex: Math.min(learnedItemIds.length, Number(totalCount) || learnedItemIds.length), learnedItemIds, yesterdayItemIds: dailyRecords[getPreviousLearningDateKey()] || [], dailyRecords, updatedAt: items[items.length - 1]?.createdAt || items[items.length - 1]?.created_at || '' };
  serverLearningProgressStore = { ...serverLearningProgressStore, [key]: next };
  return next;
};

// Local-only helper retained for timer/demo code. API-mode user actions must use
// persistLearningCompletion so failed writes remain visible as errors.
const recordLearningCompletion = (studentId, resourceType, resourceId, itemId, totalCount) => {
  if (isApiConfigured()) return readLearningProgress(studentId, resourceType, resourceId, totalCount);
  const store = loadLearningProgressStore();
  const next = buildLearningCompletion(studentId, resourceType, resourceId, itemId, totalCount);
  store[getLearningProgressKey(studentId, resourceType, resourceId)] = next;
  saveLearningProgressStore(store);
  return next;
};
const SUBJECT_OPTIONS = ['政治', '英语一', '英语二', '英语三', '数学一', '数学二', '数学三', '专业课一', '专业课二'];

const DEFAULT_COURSE_CATEGORIES = {
  '公开课': ['公开课'],
  '政治': ['基础', '提高'],
  '英语': ['语法', '阅读', '七选五', '作文', '单词'],
  '数学': ['基础', '提高'],
  '专业课': ['基础', '提高'],
  '学习方法分享': ['学习方法'],
  '政策解读': ['政策解读']
};
const AI_SETTINGS_STORAGE_KEY = 'shangan-ai-settings-v4';
const LEGACY_AI_SETTINGS_STORAGE_KEYS = ['shangan-ai-settings-v3', 'shangan-ai-settings-v2', 'shangan-ai-settings-v1'];

/**
 * 监管机器人目录：每个业务用途 = 一台可独立配置的机器人
 * 配置项：第三方模型接口 + 系统提示词 + 限制词；真实密钥仅服务端环境变量
 */
const AI_MODEL_SLOTS = [
  {
    id: 'periodic_assessment',
    name: '日 / 周 / 月自测出题',
    robotName: '自测出题机器人',
    modality: '纯文本',
    capability: 'text',
    purpose: '读取学员复习计划，生成单词 + 考研阅读真题句子翻译题，并输出答案与解析。',
    usedBy: '学生端自测 · 题库「日/周/月」窗口',
    secretHint: 'AI_PERIODIC_ASSESSMENT_KEY',
    recommend: '文本模型即可，如 qwen-plus / glm-4-flash / 自建文本接口',
    defaultSystemPrompt: `你是“上岸考研学习平台”的公共课自测出题机器人，负责为政治、英语、数学生成可审核、可追溯、适合学生当前阶段的日测、周测、月测草案。你只负责出题草案，不负责发布、不负责修改学生档案、不负责替教师决定题目是否合格。

【总原则】
1. 只使用本次输入中明确提供的学科、年级、考研年份、阶段、教材版本、知识点、复习计划、题库资料和难度要求。没有提供的事实不得自行补齐；不确定时写“信息不足，待教师确认”。
2. 优先覆盖学生正在学习、近期未掌握或计划要求复习的内容；不得为了凑题而跨章节、跨学科或使用超出学生阶段的知识。
3. 生成的是原创题或基于授权材料改编的题。不得声称题目来自某年某地真题；不得大段复现受版权保护的真题、教材或讲义。
4. 政治重点检查概念边界、理论关系、时政材料与选项干扰项的严谨性；英语重点检查词义、搭配、语法、语境和翻译准确性；数学重点检查定义域、条件、计算、证明链条和答案唯一性。
5. 所有题目必须可独立作答，题干、选项、数据、单位、图表说明不能缺失。无法保证唯一答案时不要生成，改为标记“需人工修订”。

【题量与难度】
根据输入的 assessmentType 选择范围：日测少量巩固，周测覆盖本周核心知识，月测覆盖阶段性重点。题量、分值、时间以输入为准，未提供时给出建议值而不是擅自改变任务。难度按基础/中档/拔高分层，通常基础题用于确认掌握，中档题用于迁移，拔高题用于综合；每题标明 difficulty 和考查知识点。

【学科规则】
政治：选择题必须只有一个最佳答案，干扰项应有明确错误依据；材料题应拆成可评分要点，不把争议性时政说成绝对事实。
英语：单词题必须给出词性和语境；阅读句子翻译必须提供原句、上下文、结构拆解和译文评分要点，不编造“真题出处”；语法题检查时态、从句、非谓语和搭配的一致性。
数学：先检查题目条件是否足够，再检查推导和答案；涉及参数、定义域、范围、概率、几何或证明时，列出关键限制；不得只给一个未经验证的数值答案。

【固定输出】只输出 JSON，不要输出问候或散文。结构为：{\"assessmentType\":\"\",\"subject\":\"\",\"instructions\":\"\",\"questions\":[{\"number\":1,\"type\":\"single_choice|multiple_choice|true_false|fill_blank|short_answer|translation\",\"stem\":\"\",\"options\":[],\"score\":0,\"difficulty\":\"基础|中档|拔高\",\"knowledgePoint\":\"\",\"correctAnswer\":\"\",\"analysis\":\"\",\"scoringPoints\":[],\"sourceNote\":\"原创或授权材料改编\"}],\"qualityFlags\":[],\"teacherReview\":{\"required\":true,\"items\":[]}}。客观题答案必须与选项一致；主观题不得伪装成已自动批改。`,
    defaultRestrictionWords: '超纲,泄题,真题全文,人身攻击,广告,与考研无关',
  },
  {
    id: 'assessment_grading',
    name: '统一自测批改与解析',
    robotName: '自测批改机器人',
    modality: '纯文本',
    capability: 'text',
    purpose: '统一批改入学自测、日测、周测和月测，并生成错题解析与学习建议草案。',
    usedBy: '全部自测的提交后批改流程',
    secretHint: 'AI_ASSESSMENT_GRADING_KEY',
    recommend: '稳定的文本模型；统一承担所有自测批改，无需按考试类型重复配置',
    defaultSystemPrompt: `你是“上岸考研学习平台”的统一自测批改机器人，负责批改入学摸底、政治/英语/数学日测、周测和月测。你只依据输入的题目快照、标准答案、评分规则、学生作答和授权知识库工作；你不能补写缺失答案，不能修改原始成绩，不能替教师发布结果。

【判分优先级】
先区分客观题与主观题。单选、多选、判断、填空只有在答案规范化后与标准答案一致时才判对；多选不得把少选、多选、顺序或无效选项误判为正确。主观题、翻译、数学解答和材料题必须标记“待教师批改”，可以提供评分点覆盖情况和解析草案，但不得输出确定分数，除非输入明确提供了教师评分结果。

【处理流程】
先核对题目总数、每题分值、题型和答案是否完整；再逐题规范化作答；然后计算客观题得分、总分、得分率和分学科/知识点统计；最后整理错题与下一步建议。任何数据矛盾都列入 qualityFlags，不得悄悄修正。

【学科批改要求】
政治：说明错误选项对应的概念边界、材料依据或逻辑问题，避免把具有时效性的政治表述当作永久事实。
英语：单词关注词义、词性、搭配和语境；翻译关注主干、从句、非谓语、逻辑关系、时态和关键词，不因表达风格不同而武断判错。
数学：检查步骤、条件、定义域、单位、符号、计算和结论；部分正确时列出已获得和缺失的评分点，不把最终答案错误等同于全部步骤错误。

【固定输出】只输出 JSON：{\"status\":\"已批改|部分待批改|数据不足\",\"score\":null,\"objectiveScore\":0,\"subjectScores\":{},\"subjectTotals\":{},\"accuracy\":null,\"questionResults\":[{\"number\":1,\"result\":\"正确|错误|待批改|无法判定\",\"studentAnswer\":null,\"correctAnswer\":null,\"score\":0,\"knowledgePoint\":\"\",\"reason\":\"\",\"analysis\":\"\",\"scoringPoints\":[]}],\"wrongQuestions\":[],\"weakKnowledgePoints\":[],\"nextActions\":[],\"qualityFlags\":[],\"teacherReview\":{\"required\":true,\"items\":[]}}。不允许输出“保证提分”“必考”“押题”等承诺。`,
    defaultRestrictionWords: '编造成绩,人身攻击,泄题,超纲恐吓',
  },
  {
    id: 'plan_assistant',
    name: '个人计划 AI 助手',
    robotName: '计划助手机器人',
    modality: '纯文本',
    capability: 'text',
    purpose: '根据完成打卡与自测表现，动态上调、下调或顺延后续数量型任务，并留下可撤销的调整记录。',
    usedBy: '学员详情 · 未来 30 天任务监管',
    secretHint: 'AI_PLAN_ASSISTANT_KEY',
    recommend: '文本模型',
    defaultSystemPrompt: `你是“上岸考研学习平台”的个人计划 AI 助手机器人，负责根据已经发生的学习反馈，为教师提供后续任务调整建议。你不是自动排课器，也不是学生档案管理员。除非系统明确标记为已审核并允许执行，否则你的输出永远是“待教师确认”的草案。

【输入边界】
只使用输入中的计划、任务行、任务数量、完成时间、实际完成量、连续完成/未完成记录、休息日和教师规则。不得根据姓名、手机号等无关信息推断能力；不得把一次偶然失误诊断为稳定问题。

【调整规则】
只检查尚未执行、且任务文本包含明确数量或可计算范围的任务。只调整数量、数量范围或日期顺延，不得改变任务主题、学科、课程章节、题目内容、教师备注、权限和已完成历史。默认规则为：连续未达标 3 次且完成率低于 50%时建议下调 15%；连续完成 5 次且完成率不低于 90%时建议上调 5%；每次调整后保留原值、建议值、计算依据和影响范围。遇到休息日、请假、系统故障、任务不可执行或数据不足时，不得触发惩罚性调整。

【安全与可撤销】
不得删除全部任务、不得要求学生放弃考研、不得制造紧迫感、不得修改历史记录。建议必须可撤销；如果某项建议可能影响超过未来 30 天，标记 highImpact 并要求教师复核。若输入数据不足，输出“不调整”。

【固定输出】只输出 JSON：{\"decision\":\"不调整|建议调整|数据不足\",\"reason\":\"\",\"confidence\":0,\"changes\":[{\"planId\":\"\",\"rowIndex\":0,\"taskIndex\":0,\"taskText\":\"\",\"before\":null,\"after\":null,\"unit\":\"\",\"changeType\":\"下调|上调|顺延\",\"evidence\":[],\"highImpact\":false}],\"excludedTasks\":[],\"teacherReview\":{\"required\":true,\"summary\":\"所有变更必须经教师确认后执行\"},\"rollback\":{\"available\":true,\"instructions\":\"使用 before 值恢复\"}}。`,
    defaultRestrictionWords: '删除全部任务,更改任务主题,恐吓,放弃考研',
  },
  {
    id: 'learning_summary',
    name: '学生日 / 周 / 月学习总结',
    robotName: '总结机器人',
    modality: '纯文本',
    capability: 'text',
    purpose: '按日、周、月汇总任务、错题、考试方向和科目进度，并投递到学生网页端首页。',
    usedBy: '学生端首页 · 温故而知新，可以为师矣',
    secretHint: 'AI_LEARNING_SUMMARY_KEY',
    recommend: '稳定的文本模型；由服务端定时任务调用，使用 Asia/Shanghai 时区',
    defaultSystemPrompt: `你是“上岸考研学习平台”的学生学习总结机器人，负责把已发生的计划、打卡、课程、自测、错题和学习时间整理成学生可以直接阅读的日总结、周总结或月总结。你不是教师，不是心理咨询师，也不能替学生或教师作出不可逆决定。

【数据原则】
只基于输入快照和指定统计周期。先说明统计周期、数据是否完整、是否存在未同步记录；没有记录就写“本周期暂无可用记录”，不能用常识填充。必须区分已完成、进行中、未完成、待批改和未配置，不能把计划数量当成完成数量，不能把 AI 建议当成教师结论。

【内容要求】
必须按以下四部分输出：一、今日/本周期复习任务及重点；二、易错点与需要复查的知识点；三、考试方向与当前复习重点；四、当前科目学习进度及未来进度展望。进度展望只能根据已有趋势给出条件式建议，使用“如果保持当前节奏”“建议复核”等表述，不承诺分数、不预测具体考题、不制造焦虑。政治、英语、数学分别说明，不混淆学科；没有某科数据就不要编造。

【时间规则】
日总结只覆盖当天；周总结覆盖指定周；月总结覆盖指定月。服务端决定投递时间和覆盖关系，你只负责内容，不自行声明已发送、已覆盖或已写入数据库。

【固定输出】只输出 JSON：{\"periodType\":\"daily|weekly|monthly\",\"period\":\"\",\"dataCompleteness\":\"完整|部分缺失|无记录\",\"headline\":\"\",\"taskFocus\":\"\",\"weakPoints\":[],\"examDirection\":\"\",\"subjectProgress\":{\"政治\":{\"done\":0,\"planned\":0,\"observation\":\"\",\"nextStep\":\"\"},\"英语\":{},\"数学\":{}},\"progressForecast\":\"\",\"studentActions\":[],\"dataNotes\":[],\"teacherReview\":{\"required\":false,\"items\":[]}}。`,
    defaultRestrictionWords: '模型,提示词,接口,API,密钥,教师端配置,人身攻击,恐吓,放弃考研,编造数据',
  },
  {
    id: 'stage_review_summary',
    name: '阶段性复习总结',
    robotName: '阶段总结机器人',
    modality: '纯文本',
    capability: 'text',
    purpose: '按周汇总学生各科目作业完成、基础阶段进度、学习起止与阶段表现，生成可追溯的复习记录草案。',
    usedBy: '教室端 · 监管机器人 / 学生端 · 我的 · 复习记录',
    secretHint: 'AI_STAGE_REVIEW_SUMMARY_KEY',
    recommend: '稳定的文本模型；由服务端在每周结算后调用，使用 Asia/Shanghai 时区',
    defaultSystemPrompt: `你是“上岸考研学习平台”的阶段总结机器人，专门为学生生成每周阶段性复习总结，并将结果作为“复习记录”的候选内容。你服务于学生学习跟进，不是自动评判器、排课器或档案修改器。你的任何输出都不得直接修改任务、成绩、科目、学习阶段、资料、权限或老师评语；系统和教师决定是否保存、发布或调整。

【唯一目标】
针对一个学生、一个明确统计周期和一个或多个已报名科目，忠实整理该周期的学习起止时间、计划任务、打卡/作业完成、各科目基础阶段完成进度、已发生自测、错题和既有教师评语，形成按科目独立可追溯的周总结。没有真实学习事件时，必须明确写“本周期暂无可用记录”，绝不能把计划内容、预计时长或课程目录伪装成已完成。

【输入与隐私边界】
只处理输入快照中明确提供的数据：studentId（仅用于关联，不在面向学生文本中展示）、统计周期、时区、已报名科目、任务计划与实际完成事件、任务完成时间、学习时长、作业提交状态、自测结果、错题概况、既有阶段记录、教师已确认评语。不得输出手机号、微信号、地址、身份证、账号、密钥、内部模型配置或其他学生数据；不得从姓名、学校、分数或缺勤推测人格、健康、家庭、经济或努力程度。数据有冲突时列为 dataNotes，不能自行裁决。

【统计口径】
1. 周期严格使用输入的 periodStart、periodEnd 和 Asia/Shanghai 日期边界；只统计发生在闭区间内的事件。
2. 作业完成率 = 已完成且有真实完成事件的任务数 / 本周期计划任务数。计划任务数为 0 时 completedRate 为 null，不得写 0%。
3. 阶段进度 = 已完成任务行 / 已分配任务行；若计划没有任务行或数据不足，progress 为 null。
4. 学习起止取该科目周期内最早和最晚有效学习/完成事件；没有事件返回 null，不要用计划起止日替代。
5. 自测、错题、教师评语只描述输入中实际存在的内容；“待批改”“未配置”“未同步”必须保留原状态。
6. 按科目单独计算，不混用政治、英语、数学与专业课的数据；英语一/二/三等可以保留原报名名称，同时可附学科归类。

【写作要求】
输出给学生的文字应平和、具体、可执行。每科都写：本周已完成事实、作业完成情况、基础阶段进度、下一周一至三项明确行动和一段不超过 80 字的评语。评语先描述事实，再给建议；不能羞辱、恐吓、制造焦虑，不得使用“差生”“懒惰”“必须”“保证提分”“必考”“押题”等语言。发现完成率低、长期无记录、成绩波动或数据异常时，使用“建议和老师核对任务量/记录是否完整”，而非判断学生态度或能力。老师评语字段只有在输入含已确认文本时才能引用；否则 teacherComment 留空并标记需要教师复核。

【输出约束】
只输出 JSON，不要 markdown，不要解释模型工作过程。所有数值必须来自输入或按上述口径计算；无法计算一律为 null。weekSummary 可展示给学生；teacherReview 用于老师端，不应作为学生评语直接展示。

【固定输出】
{"periodType":"weekly","periodStart":"YYYY-MM-DD","periodEnd":"YYYY-MM-DD","timezone":"Asia/Shanghai","dataCompleteness":"完整|部分缺失|无记录","overall":{"plannedTasks":0,"completedTasks":0,"completedRate":null,"learningStartedAt":null,"learningEndedAt":null,"summary":"","dataNotes":[]},"subjects":[{"subject":"","subjectCategory":"政治|英语|数学|专业课|其他","stage":"基础","learningStartedAt":null,"learningEndedAt":null,"plannedTasks":0,"completedTasks":0,"completedRate":null,"stageTotalRows":0,"stageCompletedRows":0,"stageProgress":null,"homeworkStatus":"已完成|部分完成|未完成|暂无任务|数据不足","assessments":[],"wrongQuestionFocus":[],"weeklyLearning":"","nextActions":[],"studentComment":"","teacherComment":"","dataNotes":[]}],"weekSummary":{"title":"第 N 周复习总结","studentFacingSummary":"","generatedAt":"ISO-8601"},"teacherReview":{"required":true,"items":[]}}。`,
    defaultRestrictionWords: '编造完成记录,自动改计划,自动评分,人身攻击,恐吓,保证提分,押题,泄露隐私',
  },
  {
    id: 'learning_report',
    name: '学情诊断报告',
    robotName: '学情诊断机器人',
    modality: '纯文本',
    capability: 'text',
    purpose: '汇总学习事件，输出可复核的学情诊断与跟进建议。',
    usedBy: '教师工作台 / 学员档案 / AI 复习检测',
    secretHint: 'AI_LEARNING_REPORT_KEY',
    recommend: '文本模型',
    defaultSystemPrompt: `你是“上岸考研学习平台”的学情诊断机器人，负责为教师生成可复核的学情诊断草案。你不能诊断疾病、给学生贴标签、替教师评价学生，也不能直接修改学生档案、计划、成绩或权限。

【分析范围】
只使用教师授权的时间范围和数据：登录/活跃、课程进度、计划完成率、实际学习时间、任务拖欠、连续学习、自测成绩、知识点错题、主观题待批改和历史跟进记录。先列出数据范围、样本量、缺失项和生成时间。把观察事实、合理推断和建议分开，任何推断都要说明证据，不得把相关性写成因果。

【诊断维度】
从学习投入、计划执行、知识掌握、学科结构、任务负荷、复习连续性和需要教师跟进七个维度分析。对政治、英语、数学分别描述；不能用单次低分判断能力，不能用未登录直接判断不努力。风险等级仅表示需要关注的优先级，不是学生标签。若发现数据异常，优先建议核实数据和联系学生。

【建议边界】
建议必须具体、低风险、可执行，例如确认任务量、安排错题复盘、补充前置知识、联系学生了解阻碍。任何计划调整、教师评价、课程权限变化和学员状态变化都必须标记待教师确认。涉及心理、身体、家庭、经济等敏感问题时只建议由教师谨慎沟通，不作推断。

【固定输出】只输出 JSON：{\"reportPeriod\":\"\",\"dataScope\":{\"from\":\"\",\"to\":\"\",\"sampleCount\":0,\"missing\":[]},\"overall\":{\"level\":\"正常|关注|优先跟进|数据不足\",\"facts\":[],\"inferences\":[],\"summary\":\"\"},\"subjects\":{\"政治\":{},\"英语\":{},\"数学\":{}},\"risks\":[{\"type\":\"任务拖欠|长期未登录|自测波动|知识点薄弱|数据异常\",\"evidence\":[],\"level\":\"低|中|高\",\"suggestedFollowUp\":\"\"}],\"actions\":[],\"teacherReview\":{\"required\":true,\"items\":[]},\"limitations\":[]}}。`,
    defaultRestrictionWords: '确诊,心理疾病断言,歧视,人身攻击',
  },
  {
    id: 'community_moderation',
    name: '社区内容预审',
    robotName: '社区预审机器人',
    modality: '纯文本',
    capability: 'text',
    purpose: '对学习帖做风险标签与相关性预审，最终是否公开仍由老师决定。',
    usedBy: '社区审核',
    secretHint: 'AI_COMMUNITY_MODERATION_KEY',
    recommend: '文本模型；有图帖时可另开读图槽',
    defaultSystemPrompt: `你是“上岸考研学习平台”的社区内容预审机器人。你的任务是为教师提供学习社区内容的风险与相关性预审，不是最终审核员。你不能自动公开、删除、封禁、修改帖子，也不能向学生展示内部风险分数、限制词或审核规则。

【审查范围】
检查帖子正文、标题、附件说明、举报理由和上下文中明确提供的内容。判断是否与考研学习相关，是否包含广告引流、诈骗或收费承诺、泄露个人隐私、攻击或歧视、色情、赌博、违法危险内容、冒充教师、虚假成绩、未经授权的资料传播或明显抄袭。只评价内容，不评价作者身份、学校、地区、性格或动机。

【审查原则】
教育讨论、学习困难、备考焦虑和不同观点本身不等于违规；引用教材或公开知识时不要误报侵权。对边界不清的内容给出“人工复核”，不要为了提高拦截率而武断判定。风险标签必须引用具体文本证据，不能只给结论；置信度表示对标签的信心，不是对作者意图的判断。

【固定输出】只输出 JSON：{\"relevance\":\"相关|部分相关|不相关|无法判断\",\"riskLevel\":\"无|低|中|高|紧急人工复核\",\"labels\":[],\"confidence\":0,\"evidence\":[{\"quote\":\"\",\"reason\":\"\"}],\"suggestedAction\":\"通过候选|要求修改候选|驳回候选|人工复核\",\"studentFacingReason\":\"如需要求修改，给出尊重、简短、不暴露内部规则的说明\",\"teacherReview\":{\"required\":true,\"items\":[]}}。最终决定必须由教师或管理员完成并记录原因。`,
    defaultRestrictionWords: '自动公开,自动删帖,人身攻击,色情,赌博',
  },
  {
    id: 'document_ocr',
    name: '资料 / 作业读图 OCR',
    robotName: '资料读图机器人',
    modality: '读图',
    capability: 'vision',
    purpose: '识别计划表截图、作业照片、资料页中的文字，供后续文本模型处理。',
    usedBy: '资料导入 · 作业拍照上传（后续接入）',
    secretHint: 'AI_DOCUMENT_OCR_KEY',
    recommend: '读图 / OCR 模型；不要用全模态大模型做纯 OCR，以控成本',
    defaultSystemPrompt: `你是“上岸考研学习平台”的资料读图 OCR 机器人，只负责从图片中忠实识别文字、数字、公式、表格和版面结构，供后续教学流程使用。你不是解题机器人、总结机器人或内容改写机器人。

【识别规则】
按从上到下、从左到右的阅读顺序输出。保留标题、段落、编号、标点、换行、表格行列、公式符号、上下标和单位；无法确认的字符用 [无法识别] 标记，并给出可能候选但不得替用户选择。对旋转、遮挡、反光、裁切、低分辨率、手写、复杂背景和多栏排版分别标记问题。图片中没有出现的内容不能补写；不要根据常识修正原文，不要翻译，不要解题，不要生成摘要。

【隐私与安全】
不要扩展图片中的手机号、地址、身份证、账号等敏感信息；只识别图中可见文本，并可在输出中将其标记为 sensitive。不要联网查询图片来源，不要默认判断资料版权或真伪。

【固定输出】只输出 JSON：{\"status\":\"清晰|部分可识别|无法识别\",\"blocks\":[{\"type\":\"title|paragraph|list|table|formula|header|footer|unknown\",\"text\":\"\",\"bbox\":null,\"confidence\":0,\"sensitive\":false}],\"tables\":[{\"rows\":[[]],\"headersPresent\":false}],\"readingOrder\":[],\"uncertainRegions\":[],\"imageIssues\":[],\"notPerformed\":[\"未解题\",\"未改写\",\"未翻译\"]}}。`,
    defaultRestrictionWords: '臆造内容,改写原意,广告植入',
  },
  {
    id: 'handwriting_grade',
    name: '手写作答批改（读图）',
    robotName: '手写批改机器人',
    modality: '读图',
    capability: 'vision',
    purpose: '识别学生手写翻译/解答照片，再交给文本批改逻辑出解析草案。',
    usedBy: '主观题拍照批改（后续接入）',
    secretHint: 'AI_HANDWRITING_GRADE_KEY',
    recommend: '读图模型；可与 OCR 共用供应商，密钥建议分开便于计费',
    defaultSystemPrompt: `你是“上岸考研学习平台”的手写作答批改机器人，负责读取学生手写翻译、政治材料题或数学解答图片，并输出教师可复核的识别与评分草案。你不能把看不清的字猜成学生答案，不能侮辱字迹，不能自动发布分数或写入学生成绩。

【两阶段流程】
第一阶段只转录：按题号、答题区域和行序识别学生实际写下的内容；不确定字符使用 [无法识别]，不要用标准答案替换。第二阶段再对照题目、标准答案和评分细则分析：列出已覆盖、部分覆盖、未覆盖和无法判断的评分点。对政治材料题关注观点、依据、逻辑和术语；英语翻译关注主干、修饰关系、词义、时态和逻辑；数学关注公式、步骤、条件、计算和结论。

【评分边界】
如果题型、分值或评分细则缺失，输出评分草案而非确定分数。字迹不清、图片缺页、题干缺失或标准答案冲突时必须列入 reviewFlags。部分正确不得简单判为全错；每个扣分建议都要绑定具体可见证据。最终分数、评语和发布由教师确认。

【固定输出】只输出 JSON：{\"transcription\":[{\"questionNumber\":\"\",\"text\":\"\",\"uncertainParts\":[],\"confidence\":0}],\"imageQuality\":{\"status\":\"清晰|部分可读|不可读\",\"issues\":[]},\"gradingDraft\":[{\"questionNumber\":\"\",\"status\":\"待教师批改|可供教师复核\",\"coveredPoints\":[],\"missingPoints\":[],\"possibleScore\":null,\"scoreRange\":null,\"evidence\":[],\"feedback\":\"\"}],\"reviewFlags\":[],\"teacherReview\":{\"required\":true,\"reason\":\"手写主观题不得由机器人直接发布成绩\"}}。`,
    defaultRestrictionWords: '编造作答,侮辱字迹,人身攻击',
  },
  {
    id: 'question_tutor',
    name: '难题逐步讲解（读图）',
    robotName: '难题讲解机器人',
    modality: '读图',
    capability: 'vision',
    purpose: '学生上传题目截图/照片后，识别题干并输出分步详解（审题→思路→步骤→答案→易错点），不是只给最终答案。',
    usedBy: '学生端 · 学习工具 · 难题逐步讲解',
    secretHint: 'AI_QUESTION_TUTOR_KEY',
    recommend: '必须能读图：通义 VL / 智谱 VL / OpenAI 兼容多模态。DeepSeek Flash 为纯文本，不能单独读图',
    defaultSystemPrompt: `你是“上岸考研学习平台”的难题逐步讲解机器人，负责读取学生上传的题目图片或题干，帮助学生理解解题过程。你必须先确认题目内容，再给出可检查的推导；你不是只返回答案的搜索工具，也不能代替教师批改或声称结果已计入成绩。

【识别与假设】
先列出识别到的学科、题干、选项、图形信息、已知条件和问题；图片模糊、裁切、公式或图表无法确认时暂停并要求补图，或明确列出假设后再讲解。不得把图片中没有的数字、条件或选项补出来。若题目存在多种解释，分别说明并请求学生确认。

【固定讲解顺序】
一、题目重述；二、考点与方法选择，说明为什么适用；三、分步推导，每一步写出依据、公式、代入和结果；四、最终答案，并与题目要求的形式保持一致；五、易错点与自检方法；六、相似变式的训练建议。政治题要区分材料事实、概念和结论；英语题要解释词义、句法、上下文和翻译；数学题要检查定义域、单位、边界条件、符号和答案验证。

【教学边界】
优先引导学生思考，但学生明确要求详解时可以完整展示过程。不得只甩最终答案，不得虚构真题出处，不得承诺必考或保证提分。超出考研公共课范围、题干缺失或无法验证时，明确标记“需教师确认”。图片中的个人信息只在必要时引用，不扩散。

【固定输出】只输出 JSON：{\"status\":\"可讲解|需要补图|题干不完整|超出可确认范围\",\"recognizedQuestion\":{\"subject\":\"\",\"stem\":\"\",\"options\":[],\"givenConditions\":[],\"assumptions\":[]},\"solution\":{\"review\":\"\",\"knowledgePoints\":[],\"method\":\"\",\"steps\":[{\"step\":1,\"action\":\"\",\"reason\":\"\",\"result\":\"\"}],\"finalAnswer\":\"\",\"commonErrors\":[],\"selfCheck\":\"\"},\"uncertainties\":[],\"studentNextStep\":\"\",\"teacherReview\":{\"required\":false,\"items\":[]}}。`,
    defaultRestrictionWords: '只给答案,抄袭作文,人身攻击,超纲恐吓',
  },
  {
    id: 'embedding',
    name: '知识库向量化',
    robotName: '知识库向量机器人',
    modality: '向量',
    capability: 'embedding',
    purpose: '对讲义、真题、计划文本切块后做 embedding，供检索增强出题/诊断。',
    usedBy: '知识库 / RAG（后续接入）',
    secretHint: 'AI_EMBEDDING_KEY',
    recommend: '专用 embedding 模型，勿用聊天多模态顶替',
    defaultSystemPrompt: `你是“上岸考研学习平台”的知识库向量化服务。你不是聊天机器人，不生成面向学生的自然语言答案，不根据未授权网页补充资料，也不直接修改知识库原文。你的职责是为已授权的课程讲义、教师资料、题库说明、计划规则和复习材料提供稳定、可追溯的切块与 embedding 处理建议，供后续检索增强出题、批改和学情诊断使用。

【输入与授权】只处理输入中明确标注 sourceId、sourceTitle、sourceVersion、authorizationScope、contentType、language 和文本内容的资料。缺少来源、版本或授权范围时，标记为 blocked，不调用外部抓取。删除、替换和重新向量化必须保留版本关系，不得静默覆盖历史索引。

【切块规则】优先按标题、章节、知识点、题号、解析和表格语义切块；不要在定义、公式、题干、选项、答案、解析之间随意截断。每块保留 sourceId、版本、页码/段落位置、父标题、学科、知识点、难度、内容类型和前后关联。块大小和重叠由调用方参数控制；超过限制时在自然边界拆分。表格、公式不得被当作普通散文破坏。

【质量检查】检测空文本、重复文本、乱码、明显截断、孤立答案、缺失题干、来源冲突和敏感个人信息。重复内容可以标记 duplicateCandidate，但不得擅自删除。embedding 模型、维度、批大小、接口和失败重试由服务配置提供；不得把聊天模型输出冒充向量结果，不得在日志、返回值或 metadata 中写入真实 API Key。

【固定输出】只输出 JSON：{\"status\":\"ready|blocked|partial|failed\",\"source\":{\"sourceId\":\"\",\"title\":\"\",\"version\":\"\",\"authorizationScope\":\"\"},\"chunks\":[{\"chunkId\":\"\",\"text\":\"\",\"headingPath\":[],\"contentType\":\"lecture|question|answer|analysis|plan|table|other\",\"subject\":\"\",\"knowledgePoints\":[],\"location\":\"\",\"prevChunkId\":null,\"nextChunkId\":null,\"metadata\":{}}],\"qualityFlags\":[],\"embeddingRequest\":{\"model\":\"\",\"dimensions\":null,\"batchSize\":null,\"retryable\":true},\"notPerformed\":[\"未联网抓取\",\"未生成自然语言答案\",\"未删除原文\"]}}。`,
    defaultRestrictionWords: '联网抓取未授权资料,外泄学员隐私',
  },
];

const AI_PROVIDER_OPTIONS = [
  '第三方 OpenAI 兼容接口',
  '通义千问（第三方 API）',
  '智谱 AI（第三方 API）',
  'DeepSeek（第三方 API）',
  '自建 / 私有化模型服务',
  '其他第三方供应商',
];

/**
 * OpenAI-compatible provider helpers.
 * Users may paste a provider root, /v1, /models or /chat/completions URL;
 * normalize it before discovery, like a provider switcher does.
 */
const cleanOpenAiBaseUrl = (value) => String(value || '')
  .trim()
  .replace(/\/+$/, '')
  .replace(/\/(chat\/completions|responses|completions|models)$/i, '');

const getOpenAiBaseCandidates = (value) => {
  const root = cleanOpenAiBaseUrl(value);
  if (!root) return [];
  const hasVersionPath = /\/v\d+(?:\/|$)/i.test(root) || /compatible-mode\/v\d+/i.test(root);
  return [...new Set([root, ...(hasVersionPath ? [] : [`${root}/v1`])])];
};

const getModelId = (item) => String(
  typeof item === 'string' ? item : item?.id || item?.name || item?.model || ''
).trim();

const parseDiscoveredModels = (payload) => {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  return [...new Map(rows.map(item => {
    const id = getModelId(item);
    const owner = String(item?.owned_by || item?.ownedBy || item?.provider || '').trim();
    return id ? [id, { id, label: owner ? `${id} · ${owner}` : id, owner }] : null;
  }).filter(Boolean)).values()].sort((a, b) => a.id.localeCompare(b.id));
};

// Provider credentials never leave the browser. In production this operation is
// intentionally delegated to the server-side Provider contract.
const callOpenAiProvider = async () => {
  throw new Error('模型连接测试必须由服务端完成；浏览器不会发送或保存 Provider API Key。');
};

const discoverOpenAiModels = async ({ endpoint, apiKey }) => {
  const candidates = getOpenAiBaseCandidates(endpoint);
  if (!candidates.length) throw new Error('请先粘贴服务商提供的接口地址。');
  if (!String(apiKey || '').trim()) throw new Error('请粘贴 API Key 后再获取模型列表；密钥只用于本次请求。');
  let lastError = null;
  for (const baseUrl of candidates) {
    try {
      const response = await callOpenAiProvider({ url: `${baseUrl}/models`, apiKey });
      const raw = await response.text();
      let payload;
      try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = {}; }
      if (!response.ok) throw new Error(payload?.error?.message || payload?.message || `HTTP ${response.status}`);
      const models = parseDiscoveredModels(payload);
      if (!models.length) throw new Error('接口已响应，但没有返回可选择的模型。请确认这是 OpenAI 兼容的 /models 接口。');
      return { baseUrl, models };
    } catch (error) {
      lastError = error;
    }
  }
  const detail = String(lastError?.message || '请求失败');
  const corsHint = /failed to fetch|networkerror|load failed/i.test(detail)
    ? '浏览器无法直接访问该服务，通常是服务商未开启 CORS。请让服务商开启浏览器跨域访问，或在正式部署时改由平台服务端代理请求。'
    : detail;
  throw new Error(`无法读取 /models：${corsHint}`);
};

const getChatCompletionUrl = (endpoint) => {
  const root = cleanOpenAiBaseUrl(endpoint);
  return /\/v\d+(?:\/|$)/i.test(root) || /compatible-mode\/v\d+/i.test(root)
    ? `${root}/chat/completions`
    : `${root}/v1/chat/completions`;
};

const normalizeRestrictionWords = (value) => {
  if (Array.isArray(value)) {
    return value.map(item => String(item || '').trim()).filter(Boolean);
  }
  return String(value || '')
    .split(/[,，、\n;；]+/)
    .map(item => item.trim())
    .filter(Boolean);
};

const defaultAiSlotConfig = (slotMeta = {}) => ({
  enabled: false,
  modelId: '',
  provider: '第三方 OpenAI 兼容接口',
  model: '',
  endpoint: '',
  secretRef: slotMeta.secretHint || '',
  note: '',
  systemPrompt: slotMeta.defaultSystemPrompt || '',
  restrictionWords: normalizeRestrictionWords(slotMeta.defaultRestrictionWords || ''),
  lastSavedAt: null,
});

const defaultAiSettings = () => ({
  version: 5,
  models: [],
  slots: Object.fromEntries(AI_MODEL_SLOTS.map(slot => [slot.id, defaultAiSlotConfig(slot)])),
});

const migrateLegacyAiSettings = (legacy) => {
  const next = defaultAiSettings();
  if (!legacy || typeof legacy !== 'object') return next;
  const legacySlots = legacy.slots && typeof legacy.slots === 'object' ? legacy.slots : {};
  const importedModels = Array.isArray(legacy.models) ? legacy.models.map(item => ({
    ...item,
    id: item.id || `model-import-${Math.random().toString(36).slice(2)}`,
    category: item.category || 'text',
    enabled: item.enabled !== false,
  })) : [];
  const findOrImportModel = (incoming, slot) => {
    if (incoming.modelId && importedModels.some(model => String(model.id) === String(incoming.modelId))) return incoming.modelId;
    if (!String(incoming.model || '').trim()) return '';
    const existing = importedModels.find(model => model.model === incoming.model && model.endpoint === incoming.endpoint);
    if (existing) return existing.id;
    const id = `model-legacy-${slot.id}-${Math.random().toString(36).slice(2)}`;
    importedModels.push({ id, name: `${slot.robotName}（旧配置）`, category: slot.capability === 'vision' ? 'image' : slot.capability === 'embedding' ? 'other' : 'text', provider: incoming.provider || '第三方 OpenAI 兼容接口', endpoint: incoming.endpoint || '', model: incoming.model, secretRef: incoming.secretRef || slot.secretHint || 'AI_MODEL_KEY', enabled: true, importedAt: new Date().toISOString() });
    return id;
  };
  const legacyVersion = Number(legacy.version || 0);
  AI_MODEL_SLOTS.forEach(slot => {
    const incoming = legacySlots[slot.id] || (slot.id === 'assessment_grading' ? legacySlots.entrance_grading || {} : {});
    const merged = { ...defaultAiSlotConfig(slot), ...incoming };
    merged.modelId = findOrImportModel(incoming, slot);
    // 提示词协议升级：旧版默认提示词过短时自动切换为当前完整工作协议；已自定义的 v5 配置保留。
    if (legacyVersion < 5 && (!String(incoming.systemPrompt || '').trim() || String(incoming.systemPrompt || '').trim().length < 240)) {
      merged.systemPrompt = slot.defaultSystemPrompt || '';
    }
    merged.restrictionWords = incoming.restrictionWords == null
      ? normalizeRestrictionWords(slot.defaultRestrictionWords || '')
      : normalizeRestrictionWords(incoming.restrictionWords ?? incoming.restrictionWordsText);
    next.slots[slot.id] = merged;
  });
  if (!legacySlots || !Object.keys(legacySlots).length) {
    const shared = legacy.configured && legacy.model ? { model: String(legacy.model), provider:'第三方 OpenAI 兼容接口', secretRef:'AI_API_KEY' } : null;
    if (shared) {
      ['periodic_assessment', 'assessment_grading'].forEach(id => {
        const slot = getRobotMeta(id);
        const modelId = findOrImportModel(shared, slot);
        next.slots[id] = {...defaultAiSlotConfig(slot), ...shared, modelId, enabled:!!legacy.assessment};
      });
      if (legacy.plan) {
        const slot = getRobotMeta('plan_assistant');
        next.slots.plan_assistant = {...defaultAiSlotConfig(slot), ...shared, modelId:findOrImportModel(shared, slot), enabled:true};
      }
    }
  }
  next.models = importedModels;
  next.version = 5;
  return next;
};

const loadAiSettings = () => {
  // API mode is authoritative. Never hydrate browser-side robot/provider settings
  // (and especially never any legacy provider material) into a server session.
  if (isApiConfigured()) return defaultAiSettings();
  try {
    const saved = window.localStorage.getItem(AI_SETTINGS_STORAGE_KEY);
    if (saved) return migrateLegacyAiSettings(JSON.parse(saved));
    const legacyKey = LEGACY_AI_SETTINGS_STORAGE_KEYS.find(key => window.localStorage.getItem(key));
    const legacy = legacyKey ? window.localStorage.getItem(legacyKey) : null;
    if (legacy) return migrateLegacyAiSettings(JSON.parse(legacy));
  } catch (error) {
    // ignore
  }
  return defaultAiSettings();
};

const getConfiguredModels = aiSettings => Array.isArray(aiSettings?.models) ? aiSettings.models.filter(item => item?.enabled !== false && item?.id && item?.model) : [];
const getConfiguredModel = (aiSettings, modelId) => getConfiguredModels(aiSettings).find(item => String(item.id) === String(modelId)) || null;

const getAiSlotConfig = (aiSettings, slotId) => {
  const base = AI_MODEL_SLOTS.find(item => item.id === slotId);
  const merged = {
    ...defaultAiSlotConfig(base || {}),
    ...(aiSettings?.slots?.[slotId] || {}),
  };
  return {
    ...merged,
    restrictionWords: normalizeRestrictionWords(merged.restrictionWords),
    systemPrompt: String(merged.systemPrompt || base?.defaultSystemPrompt || ''),
  };
};

const getRobotMeta = (slotId) => AI_MODEL_SLOTS.find(item => item.id === slotId) || AI_MODEL_SLOTS[0];

const isAiSlotReady = (aiSettings, slotId) => {
  const slot = getAiSlotConfig(aiSettings, slotId);
  const model = getConfiguredModel(aiSettings, slot.modelId);
  // API mode receives an auditable robot/provider projection from the server;
  // local mode requires a locally configured model record.
  return !!(slot.enabled && (model || (slot.serverManaged && slot.modelId)) && String(slot.systemPrompt || '').trim());
};

const countReadyAiSlots = (aiSettings) => AI_MODEL_SLOTS.filter(slot => isAiSlotReady(aiSettings, slot.id)).length;

const SUMMARY_LABELS = { daily: '日总结', weekly: '周总结', monthly: '月总结' };
const FREE_TRIAL_DAYS = 7;
const defaultFreeTrial = () => ({ status:'unasked', startedAt:null, endsAt:null, declinedAt:null, completedAt:null, summary:null });
const getFreeTrial = student => {
  const source = student?.assessmentPush?.freeTrial || {};
  const status = ['unasked', 'deferred', 'active', 'completed'].includes(source.status) ? source.status : 'unasked';
  return { ...defaultFreeTrial(), ...source, status };
};
const buildFreeTrialSummary = completedAt => ({
  type:'weekly',
  title:'7 天免费体验总结',
  deliveredAt:completedAt,
  content:{
    taskFocus:'已完成 7 天免费体验。建议回顾体验期间学习的课程、计划任务与自测记录。',
    weakPoints:'优先复盘未完成任务和自测中暴露的薄弱知识点，再安排下一阶段学习。',
    examDirection:'继续按“课程学习—练习自测—错题复盘”的节奏推进已报名科目。',
    progressForecast:'体验期已结束；当前平台仍全功能免费开放，后续收费规则确定后会第一时间通知你。'
  }
});
/** 服务端按 Asia/Shanghai 调度：月总结 > 周总结 > 日总结。 */
const getSummaryScheduleType = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', hour12: false
  }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour === '24' ? 0 : parts.hour);
  const isMonthEnd = day === new Date(year, month, 0).getDate();
  if (isMonthEnd) return 'monthly';
  if (parts.weekday === '周日' && hour >= 12) return 'weekly';
  return hour >= 22 ? 'daily' : null;
};

const getStudentSummaryRecords = student => {
  const trialSummary = getFreeTrial(student).summary;
  return [
    ...(Array.isArray(student?.learningSummaries) ? student.learningSummaries : []),
    ...(trialSummary ? [trialSummary] : [])
  ]
    .filter(item => ['daily', 'weekly', 'monthly'].includes(item?.type))
    .filter((item, index, records) => records.findIndex(candidate => candidate.title === item.title && candidate.deliveredAt === item.deliveredAt) === index)
    .sort((a, b) => String(b.deliveredAt || b.generatedAt || '').localeCompare(String(a.deliveredAt || a.generatedAt || '')));
};

const getPendingEntranceAssessments = (student, entranceState) => {
  const serverPending = Array.isArray(entranceState?.pendingDistributions) ? entranceState.pendingDistributions : [];
  const localPending = Object.values(entranceState?.distributions || {}).flatMap(byStudent => Object.values(byStudent || {}));
  return [...serverPending, ...localPending]
    .filter(item => String(item?.studentId || item?.student_id || student?.id) === String(student?.id))
    .filter(item => !item?.submittedAt && !item?.submitted_at && !['已提交', '超时已交卷', '超时自动交卷', '已撤销'].includes(item?.status))
    .filter((item, index, list) => list.findIndex(candidate => String(candidate.id || `${candidate.paperId || candidate.paper_id}-${candidate.studentId || candidate.student_id}`) === String(item.id || `${item.paperId || item.paper_id}-${item.studentId || item.student_id}`)) === index)
    .sort((a, b) => String(b.assignedAt || b.assigned_at || '').localeCompare(String(a.assignedAt || a.assigned_at || '')));
};

/** 学员自测档案：入学摸底 + 日/周/月成绩汇总（测完归档，不结束学情跟踪） */
const getStudentAssessmentArchive = (student, entranceState) => {
  const entrance = (entranceState?.submissions || [])
    .filter(item => String(item.studentId) === String(student?.id))
    .map(item => ({
      id: item.id,
      kind: 'entrance',
      kindLabel: '入学自测',
      title: item.paperTitle || '入学摸底',
      score: item.score,
      objectiveScore: item.objectiveScore ?? item.objective_score ?? item.score,
      subjectiveScore: item.subjectiveScore ?? item.subjective_score ?? null,
      total: item.total,
      status: item.status || (item.gradingStatus === '部分待批改' ? '部分待批改' : '已提交'),
      gradingStatus: item.gradingStatus || item.grading_status || (item.gradedAt ? '已批改' : 'pending_review'),
      submittedAt: item.submittedAt,
      gradedAt: item.gradedAt,
      subjectScores: item.subjectScores,
      subjectTotals: item.subjectTotals,
      wrongQuestions: item.wrongQuestions || [],
      aiFeedback: item.aiFeedback || '',
      answersNote: '成绩、答案与错题解析已归档，作为后续分阶段任务与日周月测的学情基线。',
    }));

  const stored = Array.isArray(student?.assessmentRecords) ? student.assessmentRecords : [];
  const periodic = stored.map(item => ({
    id: item.id || `periodic-${item.type}-${item.studyDay || item.submittedAt}`,
    kind: item.type || 'daily',
    kindLabel: item.type === 'monthly' ? '月测' : item.type === 'weekly' ? '周测' : '日测',
    title: item.title || `${item.type === 'monthly' ? '月' : item.type === 'weekly' ? '周' : '日'}测 · 第 ${item.studyDay || '—'} 天`,
    score: item.score == null ? null : Number(item.score),
    objectiveScore: item.objectiveScore == null && item.objective_score == null ? null : Number(item.objectiveScore ?? item.objective_score),
    subjectiveScore: item.subjectiveScore == null && item.subjective_score == null ? null : Number(item.subjectiveScore ?? item.subjective_score),
    objectiveTotal: item.objectiveTotal == null ? null : Number(item.objectiveTotal),
    subjectiveTotal: item.subjectiveTotal == null ? null : Number(item.subjectiveTotal),
    subjectiveReview: Array.isArray(item.subjectiveReview) ? item.subjectiveReview : [],
    total: item.total == null ? null : Number(item.total),
    gradingStatus: item.gradingStatus || item.grading_status || 'pending_review',
    status: item.status || normalizeGradingStatusLabel(item.gradingStatus || item.grading_status || 'pending_review'),
    submittedAt: item.submittedAt,
    gradedAt: item.gradedAt || item.submittedAt,
    subjectScores: item.subjectScores,
    subjectTotals: item.subjectTotals,
    wrongQuestions: item.wrongQuestions || [],
    aiFeedback: item.aiFeedback || '',
    answersNote: item.answersNote || '题目、学员作答与标准答案已写入档案，供教师与 AI 持续跟进。',
    studyDay: item.studyDay,
  }));

  return [...entrance, ...periodic].sort((a, b) =>
    String(b.submittedAt || b.gradedAt || '').localeCompare(String(a.submittedAt || a.gradedAt || ''))
  );
};

/**
 * 未来 30 天 · AI 学习智能检测（不改写完整任务，只给回顾/薄弱点提醒）
 * 依据：已完成知识点、未完成项、入学/日周月错题（若有）
 */
const buildAiReviewCoachSuggestions = ({ student, futureDays, completedCount, totalCount, archiveRecords, slotReady, slotConfig, aiSettings }) => {
  const completedTopics = [];
  const pendingTopics = [];
  (futureDays || []).forEach(task => {
    const texts = (task.tasks || []).filter(Boolean);
    const label = texts.join(' · ') || task.planName || '未命名任务';
    if (task.completed) completedTopics.push({ day: task.dayNumber, label, planName: task.planName });
    else pendingTopics.push({ day: task.dayNumber, label, planName: task.planName, taskType: task.taskType });
  });

  const wrongPoints = [];
  (archiveRecords || []).forEach(record => {
    (record.wrongQuestions || []).forEach(q => {
      wrongPoints.push({
        subject: q.subject || record.kindLabel,
        text: q.knowledgePointExplanation || q.correctMethod || `第 ${q.number} 题`,
        source: record.kindLabel,
      });
    });
  });

  const suggestions = [];

  // 间隔回顾：已完成任务过一段时间再提醒
  completedTopics.slice(-6).forEach((item, index) => {
    const reviewIn = 3 + (index % 4); // 3–6 天后回顾
    const reviewDay = Math.min(30, Number(item.day) + reviewIn);
    suggestions.push({
      id: `review-${item.day}-${index}`,
      tone: 'review',
      badge: '间隔回顾',
      title: `第 ${reviewDay} 天附近 · 回看「${item.label.slice(0, 28)}${item.label.length > 28 ? '…' : ''}」`,
      detail: `你在第 ${item.day} 天学过该内容（来自「${item.planName || '计划'}」）。按遗忘曲线，约 ${reviewIn} 天后做一次短回顾（口答要点 / 重做 1–2 题），比堆新进度更稳。`,
      action: '不改完整任务，只在未来 30 天视图中提示复习。',
    });
  });

  // 未完成 / 拖欠
  pendingTopics.slice(0, 4).forEach((item, index) => {
    suggestions.push({
      id: `pending-${item.day}-${index}`,
      tone: 'attention',
      badge: item.taskType === '长期' ? '长期跟进' : '待补做',
      title: `第 ${item.day} 天 · 「${item.label.slice(0, 28)}${item.label.length > 28 ? '…' : ''}」仍待完成`,
      detail: item.taskType === '长期'
        ? '长期任务建议拆成每日最小闭环；若连续两天未动，优先补核心小节再推进新内容。'
        : '若当天时间不够，可顺延 1 个学习日，但请保留任务量，避免直接跳过导致知识断层。',
      action: '完整任务列表不变；此处仅作节奏提醒。',
    });
  });

  // 错题薄弱点
  wrongPoints.slice(0, 5).forEach((item, index) => {
    suggestions.push({
      id: `weak-${index}-${String(item.text).slice(0, 8)}`,
      tone: 'weak',
      badge: '薄弱回炉',
      title: `${item.subject || '综合'} · 错题相关再练`,
      detail: `${item.source} 暴露：${String(item.text).slice(0, 90)}${String(item.text).length > 90 ? '…' : ''}。建议在接下来 7 天内安排一次同类题或口述复述，确认是否真正掌握。`,
      action: '可与日/周测错题本联动；不自动改写计划副本。',
    });
  });

  if (!suggestions.length) {
    suggestions.push({
      id: 'empty-coach',
      tone: 'steady',
      badge: '待机检测',
      title: '暂无足够学习信号',
      detail: completedCount
        ? '已有部分完成记录。继续打卡与自测后，AI 会生成间隔回顾与薄弱点提醒。'
        : '先为学员分配基础任务并开始打卡；入学自测与日周月测成绩会进入「自测」档案，再驱动本页智能检测。',
      action: '完整任务保持教师设定，AI 只附加建议。',
    });
  }

  const progressRatio = totalCount ? completedCount / totalCount : 0;
  const summary = totalCount
    ? `近 30 天可执行任务 ${totalCount} 项，已完成 ${completedCount} 项（${Math.round(progressRatio * 100)}%）。AI 持续对照完成情况与自测错题，给出回顾与补漏建议，不改动完整任务表。`
    : '当前科目尚未展开可执行的 30 天任务；分配计划后，智能检测会开始工作。';

  return {
    summary,
    suggestions: suggestions.slice(0, 10),
    modelLabel: slotReady
      ? (() => { const model = getConfiguredModel(aiSettings, slotConfig?.modelId); return model ? `${model.name} · ${model.model}` : '已接入模型'; })()
      : '待接入「个人计划 AI 助手」或「学情诊断报告」槽位',
    slotReady: !!slotReady,
    studentName: student?.name || '学员',
    generatedAt: new Date().toISOString(),
  };
};

/** 前端原型：模拟「读图 + 逐步讲解」编排结果；上线后由服务端按 question_tutor 槽位请求第三方 API */
const buildQuestionTutorDraft = ({ subject, note, fileName }) => {
  const subjectLabel = subject || '综合';
  const hint = String(note || '').trim();
  const recognized = hint
    ? `（补充说明）${hint}`
    : `已收到题目图片「${fileName || '未命名'}」。`;

  return {
    id: `tutor-${Date.now()}`,
    createdAt: new Date().toISOString(),
    subject: subjectLabel,
    status: 'draft_preview',
    recognizedText: recognized,
    summary: `${subjectLabel}难题 · 分步详解`,
    finalAnswer: subjectLabel.includes('数学')
      ? '最终结果见步骤末行；请核对定义域与单位。'
      : subjectLabel.includes('英语')
        ? '参考译文 / 选项见「最终答案」步骤；注意时态与指代。'
        : '标准答案见最后一步；若与参考答案不一致，优先核对题干条件。',
    steps: [
      {
        title: '审题：抓住已知与所求',
        detail: `先完整读题，标出已知条件、所求量/设问类型，以及题干中的限定词（范围、时态、主语、单位）。${hint ? `结合你的补充说明：${hint}` : '把关键条件列成清单。'}`,
        tip: '不要急着套公式或猜选项，先确认「问的是什么」。',
      },
      {
        title: '定位考点与方法',
        detail: subjectLabel.includes('数学')
          ? '判断属于函数/导数、极限、积分、线代或概率哪一类；写出可用定理或标准套路（例如：先求导再讨论极值；先化简再求极限）。'
          : subjectLabel.includes('英语')
            ? '判断是词汇、长难句、阅读细节还是翻译。长难句先切主干（主谓宾），再挂从句与修饰；阅读题回原文定位关键词。'
            : subjectLabel.includes('政治')
              ? '对应马原/毛中特/史纲/思修哪个模块；回忆相关原理表述与常见干扰项（偷换概念、以偏概全）。'
              : '先判断学科与题型，再选择对应方法（公式、原文定位、原理对应、排除法）。',
        tip: '方法选对，步骤才不会跑偏。',
      },
      {
        title: '分步推导 / 分步作答',
        detail: subjectLabel.includes('数学')
          ? '① 写出关键公式或变形；② 代入已知量并化简；③ 处理特殊点（零点、间断、定义域）；④ 得出中间结果并自检量纲。每一步只做一件事，便于复查。'
          : subjectLabel.includes('英语')
            ? '① 划出题干关键词；② 回原文找同义替换句；③ 逐项排除（绝对词、偷换、无中生有）；④ 写出选项或译文草稿。'
            : '① 写出核心原理或定义；② 把材料/选项与原理一一对应；③ 排除明显错误项；④ 用一句话总结为何选该答案。',
        tip: '宁可多写一步中间过程，也不要跳步——跳步是失分高发区。',
      },
      {
        title: '最终答案',
        detail: subjectLabel.includes('数学')
          ? '整理最终表达式或数值，标注单位与定义域（若题干要求）。若为选择题，明确写出选项字母。'
          : subjectLabel.includes('英语')
            ? '给出推荐选项或完整译文；关键词保留原文对照，避免漏译与过度意译。'
            : '给出标准答案（选项或要点），并用一句「原理 + 材料」说明为什么对。',
        tip: '誊写答案前再看一眼题干设问，避免答非所问。',
      },
      {
        title: '易错点与复查',
        detail: '常见失分：条件漏用、符号/时态错误、绝对化表述、计算笔误、未看清「不正确」类反向提问。复查时用「条件是否用尽 → 答案是否对应设问 → 有无笔误」三问快速过一遍。',
        tip: '把本题的易错点记进错题本，下次同类题先检查这些坑。',
      },
    ],
  };
};
const loadContentData = () => {
  if (isApiConfigured()) return [];
  try {
    const saved = window.localStorage.getItem(CONTENT_STORAGE_KEY);
    return saved ? JSON.parse(saved) : [];
  } catch (error) { return []; }
};

const loadCourseCategories = () => {
  try {
    const saved = JSON.parse(window.localStorage.getItem(COURSE_CATEGORY_STORAGE_KEY) || 'null');
    return Object.keys(DEFAULT_COURSE_CATEGORIES).reduce((result, subject) => ({
      ...result,
      [subject]: Array.from(new Set([...(DEFAULT_COURSE_CATEGORIES[subject] || []), ...((saved && saved[subject]) || [])]))
    }), {});
  } catch (error) {
    return DEFAULT_COURSE_CATEGORIES;
  }
};

const formatCourseFileSize = size => {
  const mb = Number(size || 0) / 1024 / 1024;
  return mb ? `${Math.max(1, Math.round(mb))} MB` : '已上传';
};

/** Open only a server-issued URL for persistent assets. A missing/expired
 * signature is surfaced instead of falling back to a browser Blob URL. */
const openPersistentAsset = async (asset, notify) => {
  const url = resolveApiUrl(asset?.url || asset?.objectUrl);
  if (!url) return notify?.('服务器未返回附件地址，暂时无法下载；请联系老师重新上传。');
  if (asset?.temporary && isApiConfigured()) {
    return notify?.('该附件尚未持久化到服务器，暂时无法下载；请联系老师重新上传。');
  }
  const popup = typeof window !== 'undefined' ? window.open('about:blank', '_blank', 'noopener,noreferrer') : null;
  if (!popup) return notify?.('浏览器阻止了下载窗口，请允许弹出窗口后重试。');
  if (!isApiConfigured() || asset?.temporary) {
    popup.location.href = url;
    return;
  }
  const controller = new AbortController();
  try {
    const response = await fetch(url, { credentials: 'include', headers: { Range: 'bytes=0-0' }, signal: controller.signal });
    if (!response.ok) throw new Error(`服务器返回 ${response.status}`);
    controller.abort();
    popup.location.href = url;
  } catch (error) {
    controller.abort();
    popup.close();
    notify?.(`附件下载失败：${error?.message || '签名链接已失效或无权访问'}。请联系老师重新生成下载链接。`);
  }
};

const loadReviewPlans = () => {
  if (isApiConfigured()) return initialReviewPlans;
  try {
    const saved = window.localStorage.getItem(REVIEW_PLANS_STORAGE_KEY) || window.localStorage.getItem('shangan-review-plans');
    if (!saved) return initialReviewPlans;
    const parsed = JSON.parse(saved);
    return Object.keys(initialReviewPlans).reduce((result, subject) => ({...result, [subject]: Array.isArray(parsed?.[subject]) ? parsed[subject] : []}), {});
  } catch (error) {
    return initialReviewPlans;
  }
};

// 服务端复习计划模板 → 教师端模板形状（{id,name,category,columns,rows:[{day,tasks,note}]}）。
const normalizePlanTemplate = (template = {}) => ({
  id: template.id,
  name: template.name || '未命名计划',
  category: template.category || '基础',
  columns: Array.isArray(template.columns) ? template.columns.map(column => String(column ?? '')) : [],
  rows: (Array.isArray(template.rows) ? template.rows : []).map((row, index) => ({
    day: row?.day || formatTeacherPlanDay(index + 1),
    tasks: Array.isArray(row?.tasks) ? row.tasks.map(task => String(task ?? '')) : [],
    note: row?.note || '',
    attachments: []
  })),
  isServerManaged: true
});
const planTemplateRequestBody = plan => ({
  name: String(plan?.name || '').trim(),
  category: String(plan?.category || '').trim(),
  columns: (Array.isArray(plan?.columns) ? plan.columns : []).map(column => String(column ?? '')),
  rows: (Array.isArray(plan?.rows) ? plan.rows : []).map(row => ({
    day: String(row?.day || ''),
    tasks: Array.isArray(row?.tasks) ? row.tasks.map(task => String(task ?? '')) : [],
    note: String(row?.note || '')
  }))
});

const nav = {
  student: [
    ['home', '学习首页', LayoutDashboard], ['courses', '我的课程', Play], ['store', '商城', PackageOpen], ['practice', '练习与自测', FileQuestion], ['archive', '自测档案', ClipboardCheck],
    ['plan', '学习计划', ClipboardCheck], ['companion-study', '代学', Clock3], ['tools', '学习工具', PackageOpen], ['community', '学习社区', MessageSquareText], ['profile', '我的', GraduationCap],
  ],
  teacher: [
    ['dashboard', '数据看板', LayoutDashboard], ['students', '学员管理', Users], ['content', '课程与商品', BookOpen], ['books', '书籍管理', BookOpen],
    ['plans', '复习规划', ClipboardCheck], ['knowledge', '知识库', BookOpen], ['apps', '应用管理', PackageOpen], ['companion', '带背后台', Clock3], ['questionBank', '自测', FileQuestion],
    ['moderation', '社区审核', ShieldCheck], ['robots', '监管机器人', Bot], ['settings', '系统设置', Settings2],
  ]
};

const KNOWLEDGE_BASE_STORAGE_KEY = 'shangan-knowledge-base-v1';
const loadKnowledgeBase = () => {
  if (isApiConfigured()) return [];
  try {
    const saved = JSON.parse(window.localStorage.getItem(KNOWLEDGE_BASE_STORAGE_KEY) || 'null');
    return Array.isArray(saved) ? saved : [];
  } catch (error) {
    return [];
  }
};


// 演示版仅用于避免本地存储明文密码。正式上线必须由服务端使用 Argon2id/bcrypt
// 加盐散列、HttpOnly 安全会话和登录限流，浏览器不应保存可验证的密码散列。
const hashLocalPassword = value => {
  let hash = 2166136261;
  const source = `shangan-local-demo-v1:${String(value || '')}`;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `local-hash-${(hash >>> 0).toString(16)}`;
};

const DEMO_ACCOUNT_PASSWORD = 'ShanganDemoOnly2026';
const normalizePhone = value => String(value || '').replace(/\s+/g, '');
const isPhoneNumber = value => /^1\d{10}$/.test(normalizePhone(value));
const maskPhone = value => {
  const phone = normalizePhone(value);
  return isPhoneNumber(phone) ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : phone;
};

const initialAccounts = [
  {
    id: 'admin-root', role: 'admin', name: '平台管理员', phone: '13800000000',
    passwordHash: hashLocalPassword('Admin@2026'), status: '启用', mustChangePassword: false,
    createdAt: '2026-08-01T00:00:00.000Z', lastLoginAt: null
  },
  {
    id: 'teacher-lin', role: 'teacher', name: '林老师', phone: '13900000000',
    passwordHash: hashLocalPassword('Teacher@2026'), status: '启用', mustChangePassword: false,
    createdAt: '2026-08-01T00:00:00.000Z', lastLoginAt: null
  },
  {
    id: `student-${TEST_STUDENT_ID}`, role: 'student', studentId: TEST_STUDENT_ID, name: '测试', phone: '13700000000',
    passwordHash: hashLocalPassword('Student@2026'), status: '启用', mustChangePassword: false,
    createdAt: '2026-08-01T00:00:00.000Z', lastLoginAt: null
  }
];

const loadAccounts = () => {
  if (isApiConfigured()) return [];
  try {
    const saved = JSON.parse(window.localStorage.getItem(ACCOUNTS_STORAGE_KEY) || 'null');
    if (!Array.isArray(saved) || !saved.length) return initialAccounts;
    return initialAccounts.filter(seed => !saved.some(item => item.id === seed.id)).concat(saved);
  } catch (error) {
    return initialAccounts;
  }
};

const loadSession = () => {
  if (isApiConfigured()) return null;
  try {
    const saved = JSON.parse(window.localStorage.getItem(SESSION_STORAGE_KEY) || 'null');
    return saved && saved.accountId ? saved : null;
  } catch (error) {
    return null;
  }
};
const testStudent = {
  id: TEST_STUDENT_ID,
  name: '测试',
  year: '测试账号',
  status: '测试',
  subjects: [
    {name:'政治', enrolled:true, targetScore:''},
    {name:'英语一', enrolled:true, targetScore:''},
    {name:'数学一', enrolled:true, targetScore:''},
    {name:'专业课', enrolled:false, targetScore:''}
  ],
  progress: 0,
  stage: '基础',
  phone: '测试账号',
  idCard: '不采集',
  shippingInfo: '不需要',
  school: '测试院校',
  targetScore: '待设置',
  evaluation: '此账号永久保留，用于教师端与学生端的数据同步验证。',
  isTestAccount: true
};
const initialStudents = [
  { id: 1, name: '赵同学', year: '2027 考研', status: '体验', subjects: [{name:'政治', enrolled:false}, {name:'英语一', enrolled:false}, {name:'数学一', enrolled:false}, {name:'计算机专业课', enrolled:false}], progress: 35, stage: '基础', phone: '138****2086', idCard: '已加密保存', shippingInfo: '待补充', school: '浙江大学', targetScore: '385', evaluation: '英语基础较稳；数学需优先补齐函数与极限模块。' },
  { id: 2, name: '李同学', year: '2027 考研', status: '付费', subjects: [{name:'政治', enrolled:true}, {name:'英语二', enrolled:true}, {name:'数学三', enrolled:true}, {name:'金融专业课', enrolled:true}], progress: 68, stage: '提高', phone: '139****6108', idCard: '已加密保存', shippingInfo: '待补充', school: '上海财经大学', targetScore: '390', evaluation: '计划完成度良好，建议保持英语阅读训练。' },
  { id: 3, name: '周同学', year: '2027 考研', status: '新人', subjects: [{name:'政治', enrolled:false}, {name:'英语一', enrolled:false}, {name:'数学二', enrolled:false}, {name:'机械专业课', enrolled:false}], progress: 8, stage: '基础', phone: '136****3284', idCard: '待补充', shippingInfo: '待补充', school: '目标院校待定', targetScore: '待确定', evaluation: '尚未完成入学自测，待建立基础学情档案。' },
];
const applyPaidAssessmentDefaults = student => {
  if (!student || student.isTestAccount) return student;
  const assessmentPush = buildDefaultPushForStudent(student, student.assessmentPush);
  if (assessmentPush === student.assessmentPush) return student;
  // 仅当付费默认真正改写了开关时才写入，避免无意义对象抖动
  const prev = normalizeAssessmentPush(student.assessmentPush);
  if (
    prev.daily === assessmentPush.daily &&
    prev.weekly === assessmentPush.weekly &&
    prev.monthly === assessmentPush.monthly &&
    prev.optedOut === assessmentPush.optedOut &&
    prev.personalStartDate === assessmentPush.personalStartDate
  ) {
    return student.assessmentPush ? student : { ...student, assessmentPush };
  }
  return { ...student, assessmentPush };
};
const ensureTestStudent = students => {
  const list = Array.isArray(students) ? students : [];
  const existing = list.find(student => String(student.id) === TEST_STUDENT_ID);
  const withTest = existing
    ? [ {...testStudent, ...existing, id:TEST_STUDENT_ID, isTestAccount:true, assessmentPush: normalizeAssessmentPush(existing.assessmentPush)}, ...list.filter(student => String(student.id) !== TEST_STUDENT_ID) ]
    : [testStudent, ...list];
  return withTest.map(student => applyPaidAssessmentDefaults({
    ...student,
    intakeToken: student.intakeToken || createIntakeToken()
  }));
};
const loadStudents = () => {
  if (isApiConfigured()) return [];
  try {
    const saved = window.localStorage.getItem(STUDENTS_STORAGE_KEY);
    return ensureTestStudent(saved ? JSON.parse(saved) : initialStudents);
  } catch (error) { return ensureTestStudent(initialStudents); }
};

const BackButton = ({label = '返回上一级', onClick}) => <button type="button" className="secondary back-button" onClick={onClick}><ChevronLeft size={16}/>{label}</button>;

const getAppRole = () => window.location.pathname.replace(/\/+$/, '') === '/teacher' ? 'teacher' : 'student';
const getDefaultPage = role => role === 'teacher' ? 'dashboard' : 'home';
const getExamRoute = () => {
  const match = window.location.pathname.match(/^\/exam\/([^/]+)\/?$/);
  if (!match) return null;
  const params = new URLSearchParams(window.location.search);
  return { paperId: decodeURIComponent(match[1]), token: params.get('token') || '' };
};
const getIntakeRoute = () => {
  const match = window.location.pathname.match(/^\/intake\/([^/]+)\/?$/);
  return match ? { studentId: decodeURIComponent(match[1]) } : null;
};
const getRegistrationRoute = () => {
  const path = window.location.pathname.replace(/\/+$/, '');
  return path === '/register' || path.endsWith('/register');
};
const buildRegistrationUrl = () => `${typeof window !== 'undefined' ? window.location.origin : ''}/register`;
const createIntakeToken = () => {
  const bytes = new Uint32Array(4);
  window.crypto?.getRandomValues?.(bytes);
  const random = Array.from(bytes, value => value.toString(36)).join('') || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `intake-${random.slice(0, 32)}`;
};
const getStudentIntakeToken = student => student?.intakeToken || '';
const buildIntakeUrl = student => `${typeof window !== 'undefined' ? window.location.origin : ''}/intake/${encodeURIComponent(getStudentIntakeToken(student))}`;

function ApiLoadNotice({ page, contentLoadState, ordersLoadState, postsLoadState, reviewPlansLoadState, onRetryContent, onRetryOrders, onRetryPosts, onRetryReviewPlans }) {
  const candidates = [
    (page === 'courses' || page === 'store' || page === 'content') && { state: contentLoadState, label: '课程和商品', retry: onRetryContent },
    page === 'content' && { state: ordersLoadState, label: '订单', retry: onRetryOrders },
    (page === 'community' || page === 'moderation') && { state: postsLoadState, label: '社区内容', retry: onRetryPosts },
    (page === 'plans' || page === 'students') && { state: reviewPlansLoadState, label: '复习计划模板', retry: onRetryReviewPlans },
  ].filter(Boolean);
  const failed = candidates.find(item => item.state?.status === 'error');
  if (!failed) return null;
  return <div className="inline-error" role="alert"><span>{failed.state.message || `${failed.label}加载失败`}</span><button type="button" className="secondary" onClick={failed.retry}>重新加载</button></div>;
};

function App() {
  const routeRole = getAppRole();
  const [session, setSession] = useState(loadSession);
  const [accounts, setAccounts] = useState(loadAccounts);
  const [page, setPageState] = useState(() => getDefaultPage(routeRole));
  // Keep every child page transition in browser history, not only sidebar clicks.
  // popstate writes state directly so Back never creates a new forward entry.
  const setPage = nextPage => setPageState(current => {
    const resolved = typeof nextPage === 'function' ? nextPage(current) : nextPage;
      if (resolved === current) return current;
      if (typeof window !== 'undefined' && window.history.state?.appPage !== resolved) window.history.pushState({ appPage: resolved }, '', window.location.href);
      return resolved;
  });
  const navigatePage = setPage;
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const initial = getDefaultPage(routeRole);
    window.history.replaceState({ ...(window.history.state || {}), appPage: initial }, '', window.location.href);
    const onPopState = event => setPageState(event.state?.appPage || initial);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [routeRole]);
  const [collapsed, setCollapsed] = useState(false);
  const [modal, setModal] = useState(null);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [notificationCenterOpen, setNotificationCenterOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [tasks, setTasks] = useState([
    { id: 1, text: '完成英语阅读课程 第 03 节', subject: '英语', done: true },
    { id: 2, text: '背诵核心词汇 80 个', subject: '英语', done: false },
    { id: 3, text: '高数函数与极限练习', subject: '数学', done: false },
  ]);
  const [posts, setPosts] = useState([{ author: '程同学', title: '高数极限题的一种理解方法', topic: '数学', state: '待审核', time: '10 分钟前' }]);
  const [students, setStudents] = useState(loadStudents);
  const [studentLoadState, setStudentLoadState] = useState({ status: isApiConfigured() ? 'loading' : 'ready', message: '' });
  const [studentReloadNonce, setStudentReloadNonce] = useState(0);
  const [contentLoadState, setContentLoadState] = useState({ status: isApiConfigured() ? 'loading' : 'ready', message: '' });
  const [ordersLoadState, setOrdersLoadState] = useState({ status: isApiConfigured() ? 'loading' : 'ready', message: '' });
  const [postsLoadState, setPostsLoadState] = useState({ status: isApiConfigured() ? 'loading' : 'ready', message: '' });
  const [contentReloadNonce, setContentReloadNonce] = useState(0);
  const [ordersReloadNonce, setOrdersReloadNonce] = useState(0);
  const [postsReloadNonce, setPostsReloadNonce] = useState(0);
  const [selectedStudent, setSelectedStudent] = useState(null);
  const [reviewPlans, setReviewPlans] = useState(loadReviewPlans);
  const [reviewPlansLoadState, setReviewPlansLoadState] = useState({ status: 'idle', message: '' });
  const [reviewPlansReloadNonce, setReviewPlansReloadNonce] = useState(0);
  const [knowledgeBase, setKnowledgeBase] = useState(loadKnowledgeBase);
  const [contentItems, setContentItems] = useState(loadContentData);
  const [applicationData, setApplicationData] = useState(loadApplicationData);
  const [aiSettings, setAiSettings] = useState(loadAiSettings);
  const [entranceState, setEntranceState] = useState(loadEntrancePapers);
  const [registrationApplications, setRegistrationApplications] = useState(() => {
    if (isApiConfigured()) return [];
    try {
      const saved = window.localStorage.getItem(REGISTRATION_APPLICATIONS_STORAGE_KEY)
        || LEGACY_REGISTRATION_APPLICATIONS_STORAGE_KEYS.map(key => window.localStorage.getItem(key)).find(Boolean)
        || '[]';
      return JSON.parse(saved);
    } catch (error) { return []; }
  });
  const examRoute = getExamRoute();
  const intakeRoute = getIntakeRoute();
  const registrationRoute = getRegistrationRoute();
  const account = accounts.find(item => String(item.id) === String(session?.accountId)) || null;

  useEffect(() => { if (!isApiConfigured()) try { window.localStorage.setItem(ACCOUNTS_STORAGE_KEY, JSON.stringify(accounts)); } catch (error) {} }, [accounts]);
  useEffect(() => { if (!isApiConfigured()) try { session ? window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session)) : window.localStorage.removeItem(SESSION_STORAGE_KEY); } catch (error) {} }, [session]);
  useEffect(() => {
    if (isApiConfigured()) return;
    try { window.localStorage.setItem(AI_SETTINGS_STORAGE_KEY, JSON.stringify(aiSettings)); } catch (error) {}
  }, [aiSettings]);
  useEffect(() => { if (!isApiConfigured()) try { window.localStorage.setItem(REVIEW_PLANS_STORAGE_KEY, JSON.stringify(reviewPlans)); } catch (error) {} }, [reviewPlans]);
  useEffect(() => { if (!isApiConfigured()) try { window.localStorage.setItem(KNOWLEDGE_BASE_STORAGE_KEY, JSON.stringify(knowledgeBase)); } catch (error) {} }, [knowledgeBase]);
  useEffect(() => { if (!isApiConfigured()) try { window.localStorage.setItem(ENTRANCE_PAPERS_STORAGE_KEY, JSON.stringify({ ...entranceState, version: ENTRANCE_PAPER_VERSION })); } catch (error) {} }, [entranceState]);
  useEffect(() => { if (!isApiConfigured()) try { window.localStorage.setItem(REGISTRATION_APPLICATIONS_STORAGE_KEY, JSON.stringify(registrationApplications)); } catch (error) {} }, [registrationApplications]);
  useEffect(() => {
    const onLocalPasswordChanged = event => {
      const detail = event?.detail;
      if (!detail?.accountId) return;
      setAccounts(current => current.map(item => String(item.id) === String(detail.accountId) ? { ...item, passwordHash: detail.passwordHash, sessionVersion: detail.sessionVersion ?? detail.authVersion, authVersion: detail.authVersion ?? detail.sessionVersion, mustChangePassword: false } : item));
    };
    window.addEventListener('shangan:local-account-password-changed', onLocalPasswordChanged);
    return () => window.removeEventListener('shangan:local-account-password-changed', onLocalPasswordChanged);
  }, []);
  useEffect(() => {
    const syncRegistrationApplications = () => {
      try {
        const saved = window.localStorage.getItem(REGISTRATION_APPLICATIONS_STORAGE_KEY)
          || LEGACY_REGISTRATION_APPLICATIONS_STORAGE_KEYS.map(key => window.localStorage.getItem(key)).find(Boolean)
          || '[]';
        setRegistrationApplications(JSON.parse(saved));
      } catch (error) { setRegistrationApplications([]); }
    };
    window.addEventListener('storage', syncRegistrationApplications);
    window.addEventListener('focus', syncRegistrationApplications);
    return () => {
      window.removeEventListener('storage', syncRegistrationApplications);
      window.removeEventListener('focus', syncRegistrationApplications);
    };
  }, []);
  useEffect(() => { if (!isApiConfigured()) try { window.localStorage.setItem(STUDENTS_STORAGE_KEY, JSON.stringify(students)); } catch (error) {} }, [students]);
  useEffect(() => { if (!isApiConfigured()) try { window.localStorage.setItem(CONTENT_STORAGE_KEY, JSON.stringify(contentItems)); } catch (error) {} }, [contentItems]);
  useEffect(() => { if (!isApiConfigured()) try { window.localStorage.setItem(APPLICATIONS_STORAGE_KEY, JSON.stringify(applicationData)); } catch (error) {} }, [applicationData]);

  // API 模式：学习工具内容（政治题书/单词书/英语选择题/数学公式定理）从服务端加载
  useEffect(() => {
    if (!isApiConfigured() || !account) return undefined;
    let active = true;
    const loadServerAiConfig = async () => {
      if (!['admin', 'teacher'].includes(account.role)) return;
      try {
        const [providers, robots] = await Promise.all([
          account.role === 'admin' ? apiRequest('/api/admin/ai/providers') : Promise.resolve([]),
          apiRequest('/api/admin/ai/robots')
        ]);
        if (!active) return;
        const providerModels = (Array.isArray(providers) ? providers : []).map(provider => ({
          id: provider.id,
          name: provider.name,
          category: provider.capability === 'vision' ? 'image' : provider.capability === 'embedding' ? 'other' : 'text',
          provider: provider.name,
          endpoint: provider.baseUrl || '',
          model: provider.name,
          secretRef: provider.secretRef || '',
          enabled: provider.status !== 'disabled',
          serverManaged: true,
        }));
        const slots = { ...defaultAiSettings().slots };
        (Array.isArray(robots) ? robots : []).forEach(robot => {
          const slot = slots[robot.id];
          if (!slot) return;
          const model = providerModels.find(item => String(item.id) === String(robot.providerRef));
          slots[robot.id] = {
            ...slot,
            enabled: robot.status === 'enabled',
            modelId: model?.id || '',
            model: model?.model || '',
            provider: model?.provider || '',
            endpoint: model?.endpoint || '',
            secretRef: model?.secretRef || '',
            systemPrompt: robot.systemPrompt || slot.systemPrompt,
            restrictionWords: robot.restrictionWords || slot.restrictionWords,
            serverManaged: true,
          };
        });
        setAiSettings(current => ({ ...defaultAiSettings(), ...current, models: providerModels, slots }));
      } catch (error) {
        if (active) setNotice(`监管机器人配置加载失败：${error?.message || '请稍后重试'}`);
      }
    };
    loadServerAiConfig();
    const staff = ['admin','teacher','assistant','operator'].includes(account.role);
    const base = staff ? '/api/admin/application-books' : '/api/application-books';
    (async () => {
      try {
        const books = await apiRequest(base);
        const withItems = await Promise.all((Array.isArray(books) ? books : []).map(async book => {
          try { return { ...book, items: await apiRequest(`${base}/${encodeURIComponent(book.id)}/items`) }; }
          catch (error) { return { ...book, items: [] }; }
        }));
        if (!active) return;
        const payloadOf = (item, index) => ({ id: item.id || `item-${index}`, ...(item.payload || {}) });
        const entry = book => ({ id: book.id, name: book.name, subject: normalizeStudentSubject(book.subject || book.category), description: book.description || '', state: book.state, isServerManaged: true });
        const next = { politicsBooks: [], englishBooks: [], englishChoiceBooks: [], mathItems: { formula: [], theorem: [] } };
        for (const book of withItems) {
          const items = (book.items || []).map(payloadOf);
          if (book.tool === 'politics') next.politicsBooks.push({ ...entry(book), questions: items });
          else if (book.tool === 'english_words') next.englishBooks.push({ ...entry(book), words: items });
          else if (book.tool === 'english_choice') next.englishChoiceBooks.push({ ...entry(book), questions: items });
          else if (book.tool === 'math_formula') next.mathItems.formula.push({ ...entry(book), items });
          else if (book.tool === 'math_theorem') next.mathItems.theorem.push({ ...entry(book), items });
        }
        setApplicationData(next);
      } catch (error) { /* 加载失败时保留本地数据兜底 */ }
    })();
    return () => { active = false; };
  }, [account?.id, account?.role]);

  useEffect(() => {
    if (!isApiConfigured()) return;
    let active = true;
    // 启动探测未登录是正常的 401，不应触发“登录已失效”全局提示（会话尚未建立就误报，且提示会一直挂到登录之后）。
    apiRequest('/api/auth/me', { suppressAuthExpired: true }).then(result => {
      if (!active) return;
      const serverAccount = result?.account || {};
      // The server owns the session cookie/version. Do not invent an auth
      // version in the browser: doing so can make a freshly changed password
      // look like an expired session after reload.
      const sessionVersion = getSessionAuthVersion(result, getSessionAuthVersion(serverAccount, null));
      // Some deployed auth DTOs omit the version even though the HttpOnly
      // cookie is valid. Preserve that server-authenticated account rather than
      // logging the user out or inventing a client-side version.
      const normalized = { ...serverAccount, studentId:serverAccount.studentId, sessionVersion, authVersion:sessionVersion, status:'启用' };
      setAccounts(current => [normalized, ...current.filter(item => String(item.id) !== String(normalized.id))]);
      setSession({ accountId:normalized.id, sessionVersion, authVersion:sessionVersion });
    }).catch(async () => {
      // 只在明确 401 时才判定会话失效；网络抖动等服务端临时错误保留登录态，避免刷新即掉线。
      if (!active) return;
      await new Promise(resolve => setTimeout(resolve, 2000));
      if (!active) return;
      const retry = await apiRequest('/api/auth/me', { suppressAuthExpired: true }).catch(() => null);
      if (!retry?.account) setSession(null);
    });
    return () => { active = false; };
  }, []);

  // API 模式：根据当前身份拉取学员数据；学生只请求自己的档案，绝不注入演示学员。
  useEffect(() => {
    if (!isApiConfigured() || !account) return;
    let active = true;
    setStudentLoadState({ status: 'loading', message: '' });
    const normalizeStudentFromServer = (s) => ({
      ...s,
      id: s.id,
      name: s.name,
      year: s.year || '',
      status: s.status || '新人',
      phone: s.phone || '',
      email: s.email || '',
      wechatId: s.wechatId || '',
      shippingRecipient: s.shippingRecipient || '',
      shippingPhone: s.shippingPhone || '',
      shippingInfo: s.shippingInfo || '',
      school: s.school || '',
      targetScore: s.targetScore || '',
      stage: s.stage || '基础',
      evaluation: s.evaluation || '',
      progress: 0,
      intakeToken: '',
      assignedPlans: [],
      taskCheckins: [],
      purchasedProductIds: [],
      purchasedCourseIds: [],
      subjects: Array.isArray(s.subjects) ? s.subjects.map(item => ({ ...item, name: item.name || item.subject || '', enrolled: !!item.enrolled })) : [],
      entranceRecords: [],
      assessmentRecords: [],
      restWeekday: s.restWeekday ?? null,
      restWeekdaySetAt: s.restWeekdaySetAt || null,
      assessmentPush: s.assessmentPush || null,
      planAdjustmentAutomation: s.planAdjustmentAutomation || null,
      taskAdjustmentDraft: s.taskAdjustmentDraft || null,
      taskAdjustmentHistory: Array.isArray(s.taskAdjustmentHistory) ? s.taskAdjustmentHistory : [],
      accountState: '正常',
      disabledAt: null,
      isTestAccount: false,
      isServerManaged: true,
    });
    const load = async () => {
      try {
        const payload = account.role === 'student'
          ? await apiRequest(`/api/students/${encodeURIComponent(account.studentId)}`)
          : await apiRequest('/api/students');
        if (!active) return;
        const source = account.role === 'student' ? [payload] : (Array.isArray(payload) ? payload : payload?.students);
        if (!Array.isArray(source)) throw new Error('学员数据格式不正确');
        const normalized = source.map(normalizeStudentFromServer);
        const hydrated = await Promise.all(normalized.map(async student => {
          try {
            const [planData, entitlements, assessments, summaries, wrongQuestions, learningProgress, preferences] = await Promise.all([
              apiRequest(`/api/students/${encodeURIComponent(student.id)}/plans`),
              apiRequest(`/api/students/${encodeURIComponent(student.id)}/entitlements`),
              apiRequest(`/api/students/${encodeURIComponent(student.id)}/assessments`),
              apiRequest(`/api/students/${encodeURIComponent(student.id)}/summaries`).catch(() => []),
              apiRequest(`/api/students/${encodeURIComponent(student.id)}/wrong-questions`).catch(() => []),
              apiRequest(`/api/students/${encodeURIComponent(student.id)}/learning-progress`).catch(() => []),
              apiRequest(`/api/students/${encodeURIComponent(student.id)}/preferences`).catch(() => ({}))
            ]);
            const completed = new Set((planData?.completions || []).map(item => `${item.student_plan_id || item.studentPlanId}:${item.row_index ?? item.rowIndex}:${item.task_index ?? item.taskIndex}`));
            const remoteCheckins = (planData?.completions || []).map(item => ({
              id: item.id || `${item.student_plan_id}-${item.row_index}-${item.task_index}`,
              planId: item.student_plan_id || item.studentPlanId,
              rowIndex: item.row_index ?? item.rowIndex,
              taskIndex: item.task_index ?? item.taskIndex,
              completed: true,
              at: item.completed_at || item.completedAt || null,
            }));
            const remoteProgress = (Array.isArray(learningProgress) ? learningProgress : []).map(item => ({
              id: item.itemId || item.item_id,
              resourceType: item.resourceType || item.resource_type,
              resourceId: item.resourceId || item.resource_id,
              itemId: item.itemId || item.item_id,
              completedOn: item.completedOn || item.completed_on,
              createdAt: item.createdAt || item.created_at,
            }));
            if (isApiConfigured()) {
              const remoteStore = { ...serverLearningProgressStore };
              remoteProgress.forEach(item => {
                const key = getLearningProgressKey(student.id, item.resourceType, item.resourceId);
                const current = remoteStore[key] || { resourceType: item.resourceType, resourceId: item.resourceId, totalCount: 0, learnedItemIds: [], dailyRecords: {} };
                const learnedItemIds = Array.from(new Set([...(current.learnedItemIds || []), item.itemId]));
                const dateKey = getLearningDateKey(item.completedOn || item.createdAt);
                remoteStore[key] = { ...current, learnedItemIds, learnedCount: learnedItemIds.length, nextIndex: learnedItemIds.length, dailyRecords: { ...(current.dailyRecords || {}), [dateKey]: Array.from(new Set([...(current.dailyRecords?.[dateKey] || []), item.itemId])) }, updatedAt: item.createdAt || current.updatedAt || '' };
              });
              serverLearningProgressStore = remoteStore;
            }
            const activeEntitlements = (Array.isArray(entitlements) ? entitlements : []).filter(item => item.status === '有效' && (!item.endsAt || new Date(item.endsAt).getTime() > Date.now()));
            const assessmentRecords = (Array.isArray(assessments) ? assessments : []).map(item => ({
              id: item.id,
              type: item.assessmentType || item.assessment_type || 'daily',
              title: item.title || '自测',
              subject: item.subject || '',
              score: item.score == null ? null : Number(item.score),
              objectiveScore: item.objectiveScore == null && item.objective_score == null ? null : Number(item.objectiveScore ?? item.objective_score),
              subjectiveScore: item.subjectiveScore == null && item.subjective_score == null ? null : Number(item.subjectiveScore ?? item.subjective_score),
              objectiveTotal: item.objectiveTotal == null ? null : Number(item.objectiveTotal),
              subjectiveTotal: item.subjectiveTotal == null ? null : Number(item.subjectiveTotal),
              subjectiveReview: Array.isArray(item.subjectiveReview) ? item.subjectiveReview : [],
              total: item.total == null ? null : Number(item.total),
              gradingStatus: item.gradingStatus || item.grading_status || (item.gradedAt || item.graded_at ? 'graded' : 'pending_review'),
              status: normalizeGradingStatusLabel(item.gradingStatus || item.grading_status || (item.gradedAt || item.graded_at ? 'graded' : 'pending_review')),
              submittedAt: item.submittedAt || item.submitted_at,
              gradedAt: item.gradedAt || item.graded_at || item.submittedAt || item.submitted_at,
              wrongQuestions: Array.isArray(item.wrongQuestions) ? item.wrongQuestions : (Array.isArray(item.wrong_questions) ? item.wrong_questions : []),
              answersNote: '题目、作答与错题解析已写入自测档案，供后续复习与跟进。'
            }));
            const learningSummaries = (Array.isArray(summaries) ? summaries : []).map(item => ({
              id: item.id,
              type: item.type,
              title: SUMMARY_LABELS[item.type] || item.typeLabel || '学习总结',
              deliveredAt: item.generatedAt || item.createdAt,
              generatedAt: item.generatedAt || item.createdAt,
              content: item.content || {}
            }));
            const wrongBook = (Array.isArray(wrongQuestions) ? wrongQuestions : []).map(item => ({
              id: item.id,
              subject: item.subject || '',
              title: item.question_text || item.questionText || '',
              analysis: item.analysis || '',
              status: item.status || 'active',
              reviewCount: item.review_count ?? item.reviewCount ?? 0,
              createdAt: item.created_at || item.createdAt
            }));
            return {
              ...student,
              subjects: Array.isArray(preferences.subjects) ? preferences.subjects.map(item => ({ ...item, name: item.name || item.subject || '', enrolled: !!item.enrolled })) : student.subjects,
              restWeekday: preferences.restWeekday ?? student.restWeekday,
              restWeekdaySetAt: preferences.restWeekdaySetAt || student.restWeekdaySetAt,
              assessmentPush: preferences.assessmentPush || student.assessmentPush,
              planAdjustmentAutomation: preferences.planAdjustmentAutomation || student.planAdjustmentAutomation,
              taskAdjustmentDraft: preferences.taskAdjustmentDraft || student.taskAdjustmentDraft,
              taskAdjustmentHistory: Array.isArray(preferences.taskAdjustmentHistory) ? preferences.taskAdjustmentHistory : student.taskAdjustmentHistory,
              learningSummaries,
              wrongBook,
              assessmentRecords,
              taskCheckins: remoteCheckins,
              learningProgress: remoteProgress,
              purchasedProductIds: activeEntitlements.map(item => String(item.productId)),
              purchasedCourseIds: Array.from(new Set(activeEntitlements.flatMap(item => Array.isArray(item.courseIds) ? item.courseIds.map(String) : []))),
              assignedPlans: (planData?.plans || []).map(plan => ({
                ...plan,
                taskType: plan.task_type || plan.taskType || '阶段',
                startDay: plan.start_day || plan.startDay || 1,
                startDate: normalizeDateOnly(plan.start_date || plan.startDate) || null,
                predecessorPlanId: plan.predecessor_plan_id || plan.predecessorPlanId || null,
                predecessorAssignmentId: plan.predecessor_plan_id || plan.predecessorPlanId || null,
                courseId: plan.course_id || plan.courseId || null,
                revision: plan.revision,
                rows: (plan.rows || []).map((row, rowIndex) => ({
                  ...row,
                  tasks: Array.isArray(row.tasks) ? row.tasks : [],
                  taskDone: (row.tasks || []).map((_, taskIndex) => completed.has(`${plan.id}:${rowIndex}:${taskIndex}`))
                }))
              }))
            };
          } catch (error) {
            throw new Error(`${student.name || '学员'}的学习计划加载失败：${error?.message || '请稍后重试'}`);
          }
        }));
        if (active) {
          setStudents(hydrated);
          setStudentLoadState({ status: 'ready', message: '' });
        }
      } catch (error) {
        if (active) {
          setStudents([]);
          setStudentLoadState({ status: 'error', message: error?.message || '学员数据加载失败' });
          notify(error?.message || '学员数据加载失败');
        }
      }
    };
    load();
    return () => { active = false; };
  }, [account?.id, account?.role, account?.studentId, studentReloadNonce]);

  useEffect(() => {
    if (!isApiConfigured() || !account || account.role !== 'student') return;
    let active = true;
    const loadPendingDistributions = async () => {
      try {
        const distributions = await apiRequest('/api/student/exam-distributions', { cache: 'no-store' });
        if (!active) return;
        setEntranceState(current => ({ ...current, pendingDistributions: Array.isArray(distributions) ? distributions : [] }));
      } catch (error) {
        if (active) setEntranceState(current => ({ ...current, pendingDistributions: [] }));
      }
    };
    loadPendingDistributions();
    // 老师分发试卷后学生端无需手动刷新即可看到，15 秒轮询一次。
    const timer = setInterval(loadPendingDistributions, 15000);
    return () => { active = false; clearInterval(timer); };
  }, [account?.id, account?.role, studentReloadNonce]);

  // API 模式：教师/管理员加载全部入学测评分发与提交，保证批改工作台看到真实数据
  useEffect(() => {
    if (!isApiConfigured() || !account || !['admin','teacher'].includes(account.role)) return undefined;
    let active = true;
    (async () => {
      try {
        const [distributions, submissions] = await Promise.all([
          apiRequest('/api/admin/exams/distributions', { cache: 'no-store' }),
          apiRequest('/api/admin/exams/submissions', { cache: 'no-store' })
        ]);
        if (!active) return;
        const distributionMap = {};
        for (const item of Array.isArray(distributions) ? distributions : []) {
          (distributionMap[item.paperId] = distributionMap[item.paperId] || {})[item.studentId] = { ...item, id: item.id || item.distributionId, isServerManaged: true };
        }
        const gradingLabel = value => ({
          graded: '已批改',
          partially_graded: '部分待批改',
          pending_review: '待批改',
          '已批改': '已批改',
          '部分待批改': '部分待批改',
          '待批改': '待批改'
        }[value] || value || '待批改');
        setEntranceState(current => ({
          ...current,
          distributions: distributionMap,
          submissions: (Array.isArray(submissions) ? submissions : []).map(item => ({
            ...item,
            status: gradingLabel(item.gradingStatus) || item.status || '待批改',
            gradingStatus: item.gradingStatus || 'pending_review',
            objectiveScore: item.objectiveScore ?? item.objective_score ?? null,
            subjectiveScore: item.subjectiveScore ?? item.subjective_score ?? null,
            gradingNote: item.gradingNote || item.grading_note || '',
            isServerManaged: true
          }))
        }));
      } catch (error) { /* 加载失败时保留本地状态 */ }
    })();
    return () => { active = false; };
  }, [account?.id, account?.role, studentReloadNonce]);

  // API 模式：所有已登录角色均加载可见课程与商品。
  useEffect(() => {
    if (!isApiConfigured() || !account) return;
    let active = true;
    const normalizeCourse = (c = {}) => ({
      id: c.id,
      type: '录播课程',
      name: c.name || c.title || '未命名课程',
      subject: c.subject || c.audience || '公开课',
      audience: c.audience || c.subject || '公开课',
      category: c.category || '',
      description: c.description || '',
      pricing: c.pricing || '免费',
      price: Number(c.price || 0),
      state: c.state || c.status || '草稿',
      video: c.video || null,
      materials: Array.isArray(c.materials) ? c.materials : [],
      isServerManaged: true,
    });
    const normalizeProduct = (p = {}) => ({
      id: p.id,
      type: '商品',
      name: p.name || p.title || '未命名商品',
      category: p.category || '未分类',
      note: p.description || p.note || '',
      courseIds: Array.isArray(p.courseIds) ? p.courseIds.map(String) : (Array.isArray(p.course_ids) ? p.course_ids.map(String) : []),
      pricing: p.pricing || '免费',
      price: Number(p.price || 0),
      state: p.state || p.status || '草稿',
      asset: p.asset || null,
      isServerManaged: true,
    });
    setContentLoadState({ status: 'loading', message: '' });
    const loadContent = async () => {
      // 商城内容必须读取最新服务端数据：课程发布后不能被浏览器、CDN 或反向代理的旧 GET 缓存遮蔽。
      const fresh = `fresh=${Date.now()}`;
      const [coursesResult, productsResult] = await Promise.allSettled([
        apiRequest(`/api/courses?${fresh}`, { cache: 'no-store' }),
        apiRequest(`/api/products?${fresh}`, { cache: 'no-store' }),
      ]);
      if (!active) return;

      const coursesReady = coursesResult.status === 'fulfilled';
      const productsReady = productsResult.status === 'fulfilled';
      if (!coursesReady && !productsReady) {
        const error = coursesResult.reason || productsResult.reason;
        setContentLoadState({ status: 'error', message: error?.message || '课程和商品加载失败' });
        notify(error?.message || '课程和商品加载失败');
        return;
      }

      const courseList = coursesReady
        ? (Array.isArray(coursesResult.value) ? coursesResult.value : (coursesResult.value?.courses || []))
        : [];
      const productList = productsReady
        ? (Array.isArray(productsResult.value) ? productsResult.value : (productsResult.value?.products || []))
        : [];
      const items = [...courseList.map(normalizeCourse), ...productList.map(normalizeProduct)];
      // 加载每门课程的服务端附件（视频 / 配套资料），刷新后仍可下载。
      if (courseList.length) {
        // Public course metadata may be visible in the storefront, but assets are
        // only fetched for staff or courses the current student already owns.
        const ownedIds = new Set((students.find(item => String(item.id) === String(account.studentId))?.purchasedCourseIds || []).map(String));
        const canFetchAssets = account.role !== 'student' ? () => true : course => ownedIds.has(String(course.id));
        const assetsResults = await Promise.allSettled(courseList.map(course => canFetchAssets(course)
          ? apiRequest(`/api/courses/${encodeURIComponent(course.id)}/assets`, { cache: 'no-store' })
          : Promise.resolve([])));
        if (active) {
          const assetsByCourse = new Map();
          courseList.forEach((course, index) => {
            const result = assetsResults[index];
            assetsByCourse.set(String(course.id), result.status === 'fulfilled' && Array.isArray(result.value) ? result.value : []);
          });
          for (const item of items) {
            if (item.type !== '录播课程') continue;
            const assets = assetsByCourse.get(String(item.id)) || [];
            const assetToLocal = asset => ({ id: asset.id, fileName: asset.fileName, fileSize: asset.sizeBytes, fileType: asset.mimeType || 'application/octet-stream', url: resolveApiUrl(asset.url), uploadedAt: asset.createdAt, serverManaged: true });
            const videos = assets.filter(asset => asset.kind === 'video').map(assetToLocal);
            const materials = assets.filter(asset => asset.kind !== 'video').map(assetToLocal);
            item.video = videos[0] || item.video || null;
            item.materials = materials;
          }
        }
      }
      setContentItems(current => {
        const localOnly = current.filter(item => !item.isServerManaged && item.type !== '录播课程' && item.type !== '商品');
        return [...items, ...localOnly];
      });

      const partialError = !coursesReady
        ? '课程加载失败，暂未显示课程；商品已正常加载。'
        : (!productsReady ? '商品加载失败，已发布课程仍可正常查看。' : '');
      setContentLoadState({ status: 'ready', message: partialError });
      if (partialError) notify(partialError);
    };
    loadContent();
    const refreshTimer = account.role === 'student'
      ? window.setInterval(loadContent, 30000)
      : null;
    return () => { active = false; if (refreshTimer) window.clearInterval(refreshTimer); };
  }, [account?.id, account?.role, page, contentReloadNonce, students]);

  // API 模式：教师/管理员进入后加载全部复习计划模板（复习规划页与学员详情的
  // 「布置任务」共用这份数据；学生端不加载）。
  useEffect(() => {
    if (!isApiConfigured() || !account || account.role === 'student') return undefined;
    let active = true;
    setReviewPlansLoadState({ status: 'loading', message: '' });
    (async () => {
      try {
        const result = await apiRequest('/api/admin/plan-templates', { cache: 'no-store' });
        if (!active) return;
        const grouped = Object.keys(initialReviewPlans).reduce((acc, key) => ({ ...acc, [key]: [] }), {});
        for (const template of Array.isArray(result?.templates) ? result.templates : []) {
          if (grouped[template.subject]) grouped[template.subject].push(normalizePlanTemplate(template));
        }
        setReviewPlans(grouped);
        setReviewPlansLoadState({ status: 'ready', message: '' });
      } catch (error) {
        if (!active) return;
        setReviewPlansLoadState({ status: 'error', message: error?.message || '复习计划模板加载失败' });
        notify(error?.message || '复习计划模板加载失败，请在复习规划页重试');
      }
    })();
    return () => { active = false; };
  }, [account?.id, account?.role, reviewPlansReloadNonce]);

  // API 模式：加载当前权限范围内的订单（学生仅返回本人订单）。
  useEffect(() => {
    if (!isApiConfigured() || !account) return;
    let active = true;
    setOrdersLoadState({ status: 'loading', message: '' });
    const loadOrders = async () => {
      try {
        const orders = await apiRequest('/api/orders');
        if (!active || !Array.isArray(orders)) throw new Error('订单数据格式不正确');
        const normalizeOrder = (o = {}) => ({
          id: o.id,
          type: '购买订单',
          studentId: o.studentId,
          studentName: o.studentName || '',
          productId: o.productId,
          productName: o.productName || '',
          courseIds: Array.isArray(o.courseIds) ? o.courseIds.map(String) : [],
          amount: Number(o.amount || 0),
          provider: o.provider || '',
          state: o.status || o.state || '待确认',
          createdAt: o.createdAt,
          approvedAt: o.paidAt || null,
          reviewedAt: o.reviewedAt || null,
          reviewNote: o.reviewNote || '',
          reviewedBy: o.reviewedBy || '',
          isServerManaged: true,
        });
        setContentItems(current => {
          const existingWithoutOrders = current.filter(item => item.type !== '购买订单');
          const localOnlyOrders = current.filter(item => item.type === '购买订单' && !item.isServerManaged);
          return [...existingWithoutOrders, ...orders.map(normalizeOrder), ...localOnlyOrders];
        });
        setOrdersLoadState({ status: 'ready', message: '' });
      } catch (error) {
        if (active) {
          setOrdersLoadState({ status: 'error', message: error?.message || '订单列表加载失败' });
          notify(error?.message || '订单列表加载失败');
        }
      }
    };
    loadOrders();
    return () => { active = false; };
  }, [account?.role, ordersReloadNonce]);

  // API 模式：mount 时拉取社区帖子（教师/学员均可见）
  useEffect(() => {
    if (!isApiConfigured()) return;
    if (!account) return;
    let active = true;
    setPostsLoadState({ status: 'loading', message: '' });
    const loadPosts = async () => {
      try {
        const posts = await apiRequest('/api/posts');
        if (!active || !Array.isArray(posts)) throw new Error('社区数据格式不正确');
        const normalized = posts.map(p => ({
          id: p.id,
          author: p.author || '学员',
          title: p.title,
          topic: p.topic,
          body: p.body,
          state: p.state,
          reviewNote: p.reviewNote || '',
          reviewedAt: p.reviewedAt || null,
          createdAt: p.createdAt,
          time: p.createdAt ? new Date(p.createdAt).toLocaleString('zh-CN') : '',
          isServerManaged: true,
        }));
        setPosts(normalized);
        setPostsLoadState({ status: 'ready', message: '' });
      } catch (error) {
        if (active) {
          setPostsLoadState({ status: 'error', message: error?.message || '社区内容加载失败' });
          notify(error?.message || '社区内容加载失败');
        }
      }
    };
    loadPosts();
    return () => { active = false; };
  }, [account?.role, postsReloadNonce]);

  const clearApiSessionState = () => {
    setSession(null);
    setAccounts([]);
    setStudents([]);
    setStudentLoadState({ status: 'idle', message: '' });
    setContentLoadState({ status: 'idle', message: '' });
    setOrdersLoadState({ status: 'idle', message: '' });
    setPostsLoadState({ status: 'idle', message: '' });
    setStudentReloadNonce(current => current + 1);
    setSelectedStudent(null);
    setModal(null);
  };

  useEffect(() => {
    if (typeof window === 'undefined' || !isApiConfigured()) return undefined;
    const onAuthExpired = () => {
      clearApiSessionState();
      setNotice('登录已失效，请重新登录');
    };
    const onUncaught = event => {
      const detail = event?.detail;
      if (detail?.status === 401) {
        // 401 already triggers auth-expired
        return;
      }
      setNotice(detail?.message || '请求失败，请稍后重试');
    };
    window.addEventListener('shangan:auth-expired', onAuthExpired);
    window.addEventListener('shangan:api-error', onUncaught);
    return () => {
      window.removeEventListener('shangan:auth-expired', onAuthExpired);
      window.removeEventListener('shangan:api-error', onUncaught);
    };
  }, []);

  const notify = message => { setNotice(message); window.setTimeout(() => setNotice(''), 2600); };
  const changePasswordFromMenu = () => { setAccountMenuOpen(false); setModal('student-password'); };
  const editAccountFromMenu = () => { setAccountMenuOpen(false); setModal('student-account'); };
  const closeAccountFromMenu = () => { setAccountMenuOpen(false); setModal('student-delete'); };
  const signOut = async () => {
    if (isApiConfigured()) {
      try {
        await apiRequest('/api/auth/logout', { method:'POST', suppressAuthExpired:true });
      } catch (error) {
        if (error?.status === 401) {
          clearApiSessionState();
          return;
        }
        notify(error?.message || '退出失败，请检查网络后重试');
        return;
      }
      clearApiSessionState();
      return;
    }
    setSession(null);
  };
  if (examRoute) return <EntranceExamPage route={examRoute} students={students} setStudents={setStudents} entranceState={entranceState} setEntranceState={setEntranceState}/>;
  if (intakeRoute) return <StudentIntakePage route={intakeRoute} students={students} setStudents={setStudents}/>;
  if (registrationRoute) return <RegistrationPage applications={registrationApplications} setApplications={setRegistrationApplications}/>;
  const sessionVersionMismatch = getSessionAuthVersion(session, null) !== null && getSessionAuthVersion(account, null) !== null && Number(getSessionAuthVersion(session, null)) !== Number(getSessionAuthVersion(account, null));
  if (!account || sessionVersionMismatch || account.status !== '启用' || (routeRole === 'student' && account.role !== 'student') || (routeRole === 'teacher' && !['teacher', 'admin'].includes(account.role))) {
    return <AccountGate routeRole={routeRole} accounts={accounts} setAccounts={setAccounts} students={students} setStudents={setStudents} entranceState={entranceState} setEntranceState={setEntranceState} onAuthenticated={setSession}/>;
  }
  if (account.mustChangePassword) return <ForcePasswordChange account={account} setAccounts={setAccounts} onComplete={({ account: refreshedAccount, sessionVersion, authVersion }) => {
    const resolvedVersion = getSessionAuthVersion({ account: refreshedAccount, sessionVersion, authVersion }, null);
    const nextAccount = { ...account, ...refreshedAccount, mustChangePassword: false, sessionVersion:resolvedVersion, authVersion:resolvedVersion };
    setAccounts(current => current.map(item => item.id === account.id ? nextAccount : item));
    setSession({ accountId: account.id, sessionVersion:resolvedVersion, authVersion:resolvedVersion });
  }}/>;

  const appRole = account.role === 'student' ? 'student' : 'teacher';
  const role = appRole === 'student' ? '学生端' : account.role === 'admin' ? '平台管理员' : '教师端';
  const currentNav = nav[appRole];
  const currentStudentId = account.role === 'student' ? account.studentId : null;
  const activeStudent = currentStudentId
    ? students.find(student => String(student.id) === String(currentStudentId)) || null
    : (selectedStudent || students[0] || null);

  const pendingNavAssessments = appRole === 'student' ? getPendingEntranceAssessments(activeStudent, entranceState).length + getStudentAssessmentModules(activeStudent, aiSettings).filter(item => item.isToday && item.enabled && (item.actionable || isApiConfigured())).length : 0;

  return <div className="app-shell">
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="brand"><div className="brand-mark">上</div>{!collapsed && <div><b>上岸</b><span>考研学习平台</span></div>}</div>
      <button className="collapse" onClick={() => setCollapsed(!collapsed)} aria-label="收起导航">{collapsed ? <Menu size={18}/> : <X size={18}/>}</button>
      <nav>{currentNav.map(([id, label, Icon]) => {
        const active = page === id || (id === 'tools' && ['tutor', 'politics', 'english-words', 'english-choice', 'math-formulas'].includes(page));
        const pendingBadge = appRole === 'student' && id === 'archive' ? pendingNavAssessments : 0;
        return <button key={id} className={active ? 'nav-active' : ''} onClick={() => navigatePage(id)} title={label}><Icon size={18}/>{!collapsed && <span>{label}</span>}{pendingBadge > 0 && <i className="nav-notification-badge">{pendingBadge > 99 ? '99+' : pendingBadge}</i>}</button>;
      })}</nav>
      <div className="side-footer">{!collapsed && <><span className="status-dot"/>平台服务正常</>}</div>
    </aside>
    <main>
      <header className="topbar">
        <div className="breadcrumb"><span>{role}</span><ChevronRight size={14}/><b>{page === 'tutor' ? '难题逐步讲解' : page === 'companion-study' ? '代学' : page === 'politics' ? '政治选择题' : page === 'english-words' ? '英语背单词' : page === 'english-choice' ? '英语选择题' : page === 'robots' ? '监管机器人' : (currentNav.find(([id]) => id === page)?.[1] || '学习首页')}</b></div>
        <div className="header-actions"><button className="icon-button" onClick={() => { setAccountMenuOpen(false); setNotificationCenterOpen(current => !current); }} aria-label="通知"><Activity size={19}/></button>{notificationCenterOpen && <NotificationCenter account={account} close={() => setNotificationCenterOpen(false)}/>}<div className="account-menu-wrap"><button className="profile profile-avatar-button" onClick={() => setAccountMenuOpen(current => !current)} aria-label="打开账号菜单" aria-expanded={accountMenuOpen}><span>{account.name?.slice(0, 1) || '账'}</span><b>{account.name}</b></button>{accountMenuOpen && <div className="account-menu" role="menu"><div className="account-menu-heading"><strong>{account.name}</strong><small>{account.phone || '当前账号'}</small></div>{appRole === 'student' && <><button type="button" role="menuitem" onClick={editAccountFromMenu}><UserRound size={16}/>修改账号</button><button type="button" role="menuitem" onClick={changePasswordFromMenu}><LockKeyhole size={16}/>修改密码</button><button type="button" role="menuitem" className="account-menu-danger" onClick={closeAccountFromMenu}><Trash2 size={16}/>注销账号</button></>}<button type="button" role="menuitem" onClick={() => { setAccountMenuOpen(false); signOut(); }}><LogOut size={16}/>退出账号</button><button type="button" role="menuitem" onClick={() => { setAccountMenuOpen(false); signOut(); }}><UserRound size={16}/>切换账号</button></div>}</div></div>
      </header>
      <div className="content"><ApiLoadNotice page={page} contentLoadState={contentLoadState} ordersLoadState={ordersLoadState} postsLoadState={postsLoadState} reviewPlansLoadState={reviewPlansLoadState} onRetryContent={() => setContentReloadNonce(current => current + 1)} onRetryOrders={() => setOrdersReloadNonce(current => current + 1)} onRetryPosts={() => setPostsReloadNonce(current => current + 1)} onRetryReviewPlans={() => setReviewPlansReloadNonce(current => current + 1)}/>{appRole === 'student' ? <StudentPage page={page} setPage={setPage} students={students} studentPreviewId={activeStudent?.id} studentLoadState={studentLoadState} onRetryStudentLoad={() => setStudentReloadNonce(current => current + 1)} setStudentPreviewId={() => {}} setStudents={setStudents} entranceState={entranceState} setEntranceState={setEntranceState} contentItems={contentItems} setContentItems={setContentItems} applicationData={applicationData} tasks={tasks} setTasks={setTasks} posts={posts} setPosts={setPosts} open={setModal} notify={notify} aiSettings={aiSettings} knowledgeBase={knowledgeBase}/> : <TeacherPage page={page} setPage={setPage} students={students} setStudents={setStudents} selectedStudent={selectedStudent} setSelectedStudent={setSelectedStudent} reviewPlans={reviewPlans} setReviewPlans={setReviewPlans} contentItems={contentItems} setContentItems={setContentItems} applicationData={applicationData} setApplicationData={setApplicationData} posts={posts} setPosts={setPosts} aiSettings={aiSettings} setAiSettings={setAiSettings} entranceState={entranceState} setEntranceState={setEntranceState} open={setModal} notify={notify} accounts={accounts} setAccounts={setAccounts} currentAccount={account} knowledgeBase={knowledgeBase} setKnowledgeBase={setKnowledgeBase} registrationApplications={registrationApplications} setRegistrationApplications={setRegistrationApplications}/>}</div>
    </main>
    {modal && (['student-account', 'student-password', 'student-delete'].includes(modal)
      ? <AccountSettingsModal type={modal} account={account} student={activeStudent} close={() => setModal(null)} notify={notify} onStudentUpdated={saved => setStudents(current => current.map(item => String(item.id) === String(saved?.id) ? { ...item, ...saved } : item))} onPasswordChanged={({ account: refreshedAccount, sessionVersion, authVersion }) => {
        const resolvedVersion = getSessionAuthVersion({ account: refreshedAccount, sessionVersion, authVersion }, null);
        const nextAccount = { ...account, ...refreshedAccount, mustChangePassword: false, sessionVersion:resolvedVersion, authVersion:resolvedVersion };
        setAccounts(current => current.map(item => item.id === account.id ? nextAccount : item));
        setSession({ accountId: account.id, sessionVersion:resolvedVersion, authVersion:resolvedVersion });
      }} onSignedOut={clearApiSessionState}/>
      : <Modal type={modal} close={() => setModal(null)} notify={notify}/>)} {notice && <div className="toast" role="status"><div><Check size={17}/>{notice}</div></div>}
  </div>;
}

function AccountGate({ routeRole, accounts, setAccounts, students, setStudents, entranceState, setEntranceState, onAuthenticated }) {
  const [mode, setMode] = useState('login');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const login = async event => {
    event.preventDefault();
    setMessage('');
    if (pending) return;
    setPending(true);
    if (isApiConfigured()) {
      try {
        const result = await apiRequest('/api/auth/login', { method:'POST', body:{ phone:normalizePhone(phone), password } });
        const account = result?.account || {};
        const sessionVersion = getSessionAuthVersion(result, getSessionAuthVersion(account, null));
        if (routeRole === 'student' && account.role !== 'student') {
          await apiRequest('/api/auth/logout', { method:'POST', suppressAuthExpired:true }).catch(() => {});
          setPending(false);
          return setMessage('请从教师端入口登录此账号');
        }
        if (routeRole === 'teacher' && !['teacher', 'admin'].includes(account.role)) {
          await apiRequest('/api/auth/logout', { method:'POST', suppressAuthExpired:true }).catch(() => {});
          setPending(false);
          return setMessage('请从学生端入口登录此账号');
        }
        setAccounts(current => [{ ...account, studentId:account.studentId, sessionVersion, authVersion:sessionVersion, status:'启用' }, ...current.filter(item => String(item.id) !== String(account.id))]);
        onAuthenticated({ accountId:account.id, sessionVersion, authVersion:sessionVersion });
      } catch (error) { setMessage(error.message || '登录失败，请稍后重试'); }
      finally { setPending(false); }
      return;
    }
    setPending(false);
    const account = accounts.find(item => normalizePhone(item.phone) === normalizePhone(phone));
    if (!account || account.passwordHash !== hashLocalPassword(password)) return setMessage('手机号或密码不正确');
    if (account.status !== '启用') return setMessage('该账号当前不可登录，请联系平台管理员');
    if (routeRole === 'student' && account.role !== 'student') return setMessage('请从教师端入口登录此账号');
    if (routeRole === 'teacher' && !['teacher', 'admin'].includes(account.role)) return setMessage('请从学生端入口登录此账号');
    const loggedInAt = new Date().toISOString();
    setAccounts(current => current.map(item => item.id === account.id ? { ...item, lastLoginAt: loggedInAt } : item));
    onAuthenticated({ accountId: account.id, sessionVersion:getSessionAuthVersion(account, 0), authVersion:getSessionAuthVersion(account, 0) });
  };
  const register = async event => {
    event.preventDefault();
    if (pending) return;
    setMessage('');
    const normalized = normalizePhone(phone);
    if (!name.trim()) return setMessage('请填写姓名');
    if (!isPhoneNumber(normalized)) return setMessage('手机号须为 1 开头的 11 位数字');
    if (String(password).length < 12) return setMessage('密码至少需要 12 位');
    if (isApiConfigured()) {
      setPending(true);
      try {
        const result = await apiRequest('/api/auth/register', { method:'POST', body:{ name:name.trim(), phone:normalized, password } });
        const account = result?.account || {};
        const sessionVersion = getSessionAuthVersion(result, getSessionAuthVersion(account, null));
        setAccounts(current => [{ ...account, studentId:account.studentId, sessionVersion, authVersion:sessionVersion, status:'启用' }, ...current.filter(item => String(item.id) !== String(account.id))]);
        onAuthenticated({ accountId:account.id, sessionVersion, authVersion:sessionVersion });
      } catch (error) { setMessage(error?.details?.[0]?.message || error.message || '注册失败，请稍后重试'); }
      finally { setPending(false); }
      return;
    }
    if (accounts.some(item => normalizePhone(item.phone) === normalized)) return setMessage('该手机号已注册，请直接登录');
    const studentId = `student-${Date.now()}`;
    const now = new Date();
    const student = { id: studentId, intakeToken: createIntakeToken(), name: name.trim(), year: '考研年份待填写', status: '新人', subjects: [], progress: 0, stage: '基础', phone: maskPhone(normalized), school: '目标院校待定', targetScore: '待设置', evaluation: '新注册学员，待老师完善学情档案。' };
    const nextAccount = { id: `account-${studentId}`, role: 'student', studentId, name: name.trim(), phone: normalized, passwordHash: hashLocalPassword(password), status: '启用', mustChangePassword: false, createdAt: now.toISOString(), lastLoginAt: now.toISOString() };
    setStudents(current => [student, ...current]);
    setEntranceState(current => ({
      ...current,
      distributions: ENTRANCE_PAPERS.reduce((result, paper) => ({
        ...result,
        [paper.id]: { ...(result[paper.id] || {}), [studentId]: createExamDistribution(paper, student, now) }
      }), current.distributions || {})
    }));
    setAccounts(current => [...current, nextAccount]);
    const localSessionVersion = getSessionAuthVersion(nextAccount, 0);
    onAuthenticated({ accountId: nextAccount.id, sessionVersion:localSessionVersion, authVersion:localSessionVersion });
  };
  const isStudent = routeRole === 'student';
  return <div className="auth-page"><section className="auth-card"><div className="auth-brand"><div className="brand-mark">上</div><div><b>上岸</b><span>考研学习平台</span></div></div><span className="eyebrow">{isStudent ? '学生端登录' : '教师端登录'}</span><h1>{mode === 'login' ? '欢迎回来' : '创建学生账号'}</h1><p>{mode === 'login' ? '输入账号和密码后会在当前浏览器记住登录状态；主动退出、账号停用或密码变更后需要重新登录。' : '注册只需填写账号、密码和昵称；考试年份与报考科目可在进入“我的”页面后自行补充。'}</p><form onSubmit={mode === 'login' ? login : register} className="auth-form">{mode === 'register' && <label>昵称<input value={name} onChange={event => setName(event.target.value)} placeholder="请输入昵称" autoComplete="nickname"/></label>}<label>手机号<input value={phone} onChange={event => setPhone(event.target.value)} placeholder="请输入 11 位手机号" inputMode="numeric" autoComplete="tel"/></label><label>密码<input type="password" value={password} onChange={event => setPassword(event.target.value)} placeholder={mode === 'register' ? '至少 12 位' : '请输入密码'} autoComplete={mode === 'register' ? 'new-password' : 'current-password'}/></label>{message && <p className="auth-error">{message}</p>}<button className="primary" type="submit" disabled={pending}>{pending ? (mode === 'login' ? '正在登录…' : '正在注册…') : (mode === 'login' ? '登录' : '完成注册')}</button></form>{isStudent && <button type="button" className="quiet-button auth-switch" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setMessage(''); }}>{mode === 'login' ? '没有账号？创建学生账号' : '已有账号？返回登录'}</button>}<div className="auth-note"><LockKeyhole size={16}/><span>密码不会显示在管理界面，服务器仅保存加盐密码散列。</span></div></section></div>;
}

function StudentFreeTrial({ student, setStudents, notify }) {
  const trial = getFreeTrial(student);
  const [visible, setVisible] = useState(() => trial.status === 'unasked');
  const [pending, setPending] = useState(false);
  useEffect(() => { setVisible(getFreeTrial(student).status === 'unasked'); }, [student?.id]);

  const save = async nextTrial => {
    const nextAssessmentPush = { ...getAssessmentPush(student), freeTrial:nextTrial };
    setPending(true);
    try {
      let assessmentPush = nextAssessmentPush;
      let status = student.status;
      if (isApiConfigured()) {
        const saved = await apiRequest(`/api/students/${encodeURIComponent(student.id)}/preferences`, {
          method:'PATCH', body:{ assessmentPush:nextAssessmentPush }
        });
        assessmentPush = saved.assessmentPush || nextAssessmentPush;
        status = saved.status || status;
      }
      setStudents(current => current.map(item => String(item.id) === String(student.id) ? { ...item, assessmentPush, status } : item));
      return true;
    } catch (error) {
      notify(error.message || '体验状态保存失败，请稍后重试');
      return false;
    } finally { setPending(false); }
  };

  useEffect(() => {
    if (trial.status !== 'active' || !trial.endsAt || new Date(trial.endsAt).getTime() > Date.now()) return;
    const completedAt = new Date().toISOString();
    const summary = trial.summary || buildFreeTrialSummary(completedAt);
    save({ ...trial, status:'completed', completedAt, summary });
  }, [student?.id, trial.status, trial.endsAt]);

  const start = async () => {
    const startedAt = new Date();
    const endsAt = new Date(startedAt);
    endsAt.setDate(endsAt.getDate() + FREE_TRIAL_DAYS);
    if (await save({ ...trial, status:'active', startedAt:startedAt.toISOString(), endsAt:endsAt.toISOString(), declinedAt:null })) {
      setVisible(false);
      notify('7 天免费体验已开启，体验期间可使用全部功能');
    }
  };
  const defer = async () => {
    if (await save({ ...trial, status:'deferred', declinedAt:new Date().toISOString() })) setVisible(false);
  };

  const trigger = (trial.status === 'unasked' || trial.status === 'deferred') ? <button type="button" className="free-trial-entry" onClick={() => setVisible(true)}><Sparkles size={17}/><span>7 天免费体验</span><i aria-hidden="true"/></button> : null;
  const statusCard = trial.status === 'active' ? <section className="student-home-section free-trial-card"><div><span className="eyebrow">免费体验进行中</span><h2>7 天免费体验已开启</h2><p>全部功能已开放。当前平台仍免费开放，后续收费规则确定后会第一时间通知你。</p></div></section> : trial.status === 'completed' ? <section className="student-home-section free-trial-card"><div><span className="eyebrow">体验已完成</span><h2>7 天体验总结已生成</h2><p>总结已归入学习回顾的周总结；当前平台仍全功能免费开放。</p></div></section> : null;

  return <>{statusCard}{trigger}{visible && <div className="modal-backdrop" role="presentation" onMouseDown={defer}><section className="modal free-trial-modal" role="dialog" aria-modal="true" aria-labelledby="free-trial-title" onMouseDown={event => event.stopPropagation()}><button type="button" className="modal-close" onClick={defer} disabled={pending} aria-label="关闭"><X size={19}/></button><span className="eyebrow">新同学专享</span><h2 id="free-trial-title">开启 7 天免费体验</h2><p>7 天体验期间可使用平台全部功能，包括课程、学习计划、练习与自测、学习工具和学习档案。</p><div className="modal-actions"><button type="button" className="secondary" onClick={defer} disabled={pending}>暂不体验</button><button type="button" className="primary" onClick={start} disabled={pending}>{pending ? '正在保存…' : '开启 7 天体验'}</button></div><small>暂不体验不会失去资格，左下角会保留闪光体验入口。</small></section></div>}</>;
}

function ForcePasswordChange({ account, setAccounts, onComplete }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const submit = async event => {
    event.preventDefault();
    setMessage('');
    if (String(currentPassword).length < 8) return setMessage('请输入当前临时密码');
    if (String(password).length < 12) return setMessage('新密码至少需要 12 位');
    if (password !== confirmPassword) return setMessage('两次输入的新密码不一致');
    setPending(true);
    try {
      if (isApiConfigured()) {
        const changed = await apiRequest('/api/auth/change-password', { method:'POST', suppressAuthExpired:true, body:{ currentPassword, newPassword:password } });
        // change-password invalidates the old cookie by incrementing the server
        // session version. Login with the new password to obtain the new cookie.
        const refreshed = await reauthenticateAfterPasswordChange(account, password);
        const sessionVersion = getSessionAuthVersion(refreshed, getSessionAuthVersion(refreshed.account, getSessionAuthVersion(changed, null)));
        setAccounts(current => current.map(item => item.id === account.id ? { ...item, ...refreshed.account, mustChangePassword:false, sessionVersion, authVersion:sessionVersion } : item));
        onComplete({ ...refreshed, sessionVersion, authVersion:sessionVersion });
        return;
      }
      const nextAuthVersion = Number(account.authVersion || 0) + 1;
      setAccounts(current => current.map(item => item.id === account.id ? { ...item, passwordHash:hashLocalPassword(password), mustChangePassword:false, authVersion:nextAuthVersion } : item));
      onComplete({ account: { ...account, mustChangePassword: false }, authVersion: nextAuthVersion });
    } catch (error) {
      setMessage(error?.message || '密码修改失败，请稍后重试');
    } finally {
      setPending(false);
    }
  };
  return <div className="auth-page"><section className="auth-card"><span className="eyebrow">账户安全</span><h1>请修改临时密码</h1><p>这是管理员分发或重置后的临时密码。完成修改后才能继续使用平台。</p><form className="auth-form" onSubmit={submit}><label>当前临时密码<input type="password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} autoComplete="current-password" disabled={pending}/></label><label>新密码<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" disabled={pending}/></label><label>确认新密码<input type="password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} autoComplete="new-password" disabled={pending}/></label>{message && <p className="auth-error">{message}</p>}<button className="primary" type="submit" disabled={pending}>{pending ? '正在保存…' : '保存新密码'}</button></form></section></div>;
}

function RegistrationPage({ applications, setApplications }) {
  const subjectOptions = SUBJECT_OPTIONS;
  const [form, setForm] = useState({
    name:'', year:'', phone:'', shippingInfo:'', school:'', stage:'未开始', evaluation:'', email:'', subjects:[]
  });
  const [submitted, setSubmitted] = useState(false);
  const toggleSubject = subject => setForm(current => ({
    ...current,
    subjects: current.subjects.includes(subject)
      ? current.subjects.filter(item => item !== subject)
      : [...current.subjects, subject]
  }));
  const submit = event => {
    event.preventDefault();
    if (!form.name.trim() || !form.year.trim() || !form.phone.trim()) return window.alert('请填写姓名、考研年份和联系电话');
    if (!form.subjects.length) return window.alert('请至少选择一个报考科目');
    const application = {
      id:`registration-${Date.now()}`,
      ...form,
      name:form.name.trim(), phone:form.phone.trim(), email:form.email.trim(),
      submittedAt:new Date().toISOString(), status:'待导入'
    };
    const submitToApi = async () => {
      try {
        await apiRequest('/api/public/registrations', { method:'POST', body:form });
        setSubmitted(true);
      } catch (error) {
        window.alert(`登记提交失败：${error.message}。请检查网络后重试。`);
      }
    };
    if (isApiConfigured()) submitToApi();
    else { setApplications(current => [application, ...current]); setSubmitted(true); }
  };
  return <div className="exam-standalone"><main className="exam-paper intake-paper"><header className="exam-paper-head"><span>考研学员登记</span><h1>填写报名与学习信息</h1><p>提交后将进入审核队列，管理员确认学员类型后才会导入正式学员档案，并分发限时入学摸底试卷。</p></header>{submitted ? <section className="exam-access-card"><Check size={28}/><h2>登记已提交</h2><p>管理员审核并导入后，会根据你填写的报考科目分发入学摸底试卷。</p></section> : <form className="intake-form" onSubmit={submit}><section><h2>基本信息</h2><div className="exam-send-grid"><label>姓名<input value={form.name} onChange={event => setForm(current => ({...current, name:event.target.value}))}/></label><label>考研年份<input value={form.year} onChange={event => setForm(current => ({...current, year:event.target.value}))} placeholder="例如：2027 考研"/></label><label>联系电话<input value={form.phone} onChange={event => setForm(current => ({...current, phone:event.target.value}))} inputMode="tel"/></label><label>邮箱<input type="email" value={form.email} onChange={event => setForm(current => ({...current, email:event.target.value}))} placeholder="QQ 邮箱或其他邮箱"/></label><label>收货信息<input value={form.shippingInfo} onChange={event => setForm(current => ({...current, shippingInfo:event.target.value}))} placeholder="收件人、电话和地址"/></label><label>报考院校<input value={form.school} onChange={event => setForm(current => ({...current, school:event.target.value}))}/></label><label>当前复习阶段<select value={form.stage} onChange={event => setForm(current => ({...current, stage:event.target.value}))}><option>未开始</option><option>基础</option><option>提高</option><option>冲刺</option></select></label></div></section><section><h2>报考科目</h2><div className="profile-subject-picker"><div>{subjectOptions.map(subject => <label key={subject}><input type="checkbox" checked={form.subjects.includes(subject)} onChange={() => toggleSubject(subject)}/>{subject}</label>)}</div></div></section><section><h2>自我评价</h2><p>请说明政治、英语、数学或专业课当前复习进度与困难。</p><textarea value={form.evaluation} onChange={event => setForm(current => ({...current, evaluation:event.target.value}))} placeholder="例如：政治刚开始第一轮，英语词汇完成 30%，数学在复习高数基础。"/></section><footer className="exam-submit-bar"><span>提交后等待管理员审核导入</span><button type="submit">提交登记</button></footer></form>}</main></div>;
}

function StudentIntakePage({ route, students, setStudents }) {
  const apiMode = isApiConfigured();
  const localStudent = apiMode ? null : students.find(item => String(item.intakeToken) === String(route.studentId));
  const [remote, setRemote] = useState(null);
  const [loadState, setLoadState] = useState({ loading: apiMode, error: '' });
  const [pending, setPending] = useState(false);
  const [form, setForm] = useState(() => ({
    name: localStudent?.name || '', phone: localStudent?.phone || '', year: localStudent?.year || '',
    school: localStudent?.school || '', targetScore: localStudent?.targetScore || '', idCard: localStudent?.idCard || '',
    shippingInfo: localStudent?.shippingInfo || '', stage: localStudent?.stage || '基础',
    subjects: (localStudent?.subjects || []).map(item => ({ ...item, targetScore: item.targetScore || '' }))
  }));
  const [submitted, setSubmitted] = useState(!!localStudent?.intakeSubmittedAt);
  // API 模式：按链接 token 从服务端读取学员档案
  useEffect(() => {
    if (!apiMode) return undefined;
    let active = true;
    apiRequest(`/api/public/intake/${encodeURIComponent(route.studentId)}`)
      .then(payload => {
        if (!active) return;
        const s = payload?.student || {};
        setRemote(payload);
        setForm({
          name: s.name || '', phone: s.phone || '', year: s.year || '',
          school: s.school || '', targetScore: s.targetScore || '', idCard: '',
          shippingInfo: s.shippingInfo || '', stage: s.stage || '基础',
          subjects: (Array.isArray(payload?.subjects) ? payload.subjects : []).map(item => ({ name: item.name, enrolled: !!item.enrolled, targetScore: item.targetScore || '' }))
        });
        setSubmitted(Boolean(payload?.submittedAt));
        setLoadState({ loading: false, error: '' });
      })
      .catch(error => { if (active) setLoadState({ loading: false, error: error?.message || '采集链接无效或已失效' }); });
    return () => { active = false; };
  }, []);
  if (apiMode && loadState.loading) return <div className="exam-standalone"><section className="exam-access-card"><Clock3 size={28}/><h1>正在加载采集表</h1><p>正在校验链接并读取你的档案信息。</p></section></div>;
  if (apiMode && (loadState.error || !remote)) return <div className="exam-standalone"><section className="exam-access-card"><FileText size={28}/><h1>信息采集链接无效</h1><p>{loadState.error || '请确认老师发送的专属链接，或联系老师重新获取。'}</p></section></div>;
  const student = apiMode ? { ...(remote?.student || {}), subjects: form.subjects } : localStudent;
  if (!student) return <div className="exam-standalone"><section className="exam-access-card"><FileText size={28}/><h1>信息采集链接无效</h1><p>请确认老师发送的专属链接，或联系老师重新获取。</p></section></div>;
  const updateSubject = (index, patch) => setForm(current => ({ ...current, subjects: current.subjects.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) }));
  const submit = async event => {
    event.preventDefault();
    if (!form.name.trim()) return window.alert('请填写姓名');
    if (!String(form.phone).trim()) return window.alert('请填写联系电话');
    if (apiMode) {
      if (pending) return;
      setPending(true);
      try {
        await apiRequest(`/api/public/intake/${encodeURIComponent(route.studentId)}`, { method: 'POST', body: {
          name: form.name.trim(), year: form.year.trim() || '待填写',
          school: form.school.trim() || '待填写', targetScore: form.targetScore.trim() || '待确定',
          shippingInfo: form.shippingInfo.trim() || '待补充', stage: form.stage,
          subjects: form.subjects.map(item => ({ name: item.name, targetScore: item.targetScore || '' }))
        }});
        setSubmitted(true);
      } catch (error) {
        window.alert(`提交失败：${error.message}。请稍后重试。`);
      } finally { setPending(false); }
      return;
    }
    const next = { ...student, ...form, name: form.name.trim(), phone: form.phone.trim(), school: form.school.trim() || '待填写', year: form.year.trim() || '待填写', idCard: form.idCard.trim() || '待填写', shippingInfo: form.shippingInfo.trim() || '待补充', targetScore: form.targetScore.trim() || '待确定', subjects: form.subjects, intakeSubmittedAt: new Date().toISOString() };
    setStudents(current => current.map(item => String(item.id) === String(student.id) ? next : item));
    setSubmitted(true);
  };
  return <div className="exam-standalone"><main className="exam-paper intake-paper"><header className="exam-paper-head"><span>报名信息采集</span><h1>完善你的学习档案</h1><p>信息提交后会同步至学员管理，用于开通课程、制定计划与安排学习服务。此链接长期有效，可随时更新资料。</p></header>{submitted ? <section className="exam-access-card"><Check size={28}/><h2>资料已提交</h2><p>你的信息已同步至老师端学员管理。如有变化，可继续通过此链接更新后再次提交。</p><button type="button" className="primary" onClick={() => setSubmitted(false)}>继续修改</button></section> : <form className="intake-form" onSubmit={submit}><section><h2>基本信息</h2><div className="exam-send-grid"><label>姓名<input value={form.name} onChange={event => setForm(current => ({...current, name:event.target.value}))}/></label><label>联系电话<input value={form.phone} onChange={event => setForm(current => ({...current, phone:event.target.value}))} inputMode="tel"/></label><label>考研年份<input value={form.year} onChange={event => setForm(current => ({...current, year:event.target.value}))} placeholder="例如：2027 考研"/></label><label>报考学校<input value={form.school} onChange={event => setForm(current => ({...current, school:event.target.value}))}/></label><label>总目标分数<input value={form.targetScore} onChange={event => setForm(current => ({...current, targetScore:event.target.value}))} inputMode="numeric"/></label><label>当前复习阶段<select value={form.stage} onChange={event => setForm(current => ({...current, stage:event.target.value}))}><option>基础</option><option>提高</option><option>冲刺</option></select></label><label>身份证信息<input value={form.idCard} onChange={event => setForm(current => ({...current, idCard:event.target.value}))} placeholder="按老师要求填写"/></label><label>收货信息<input value={form.shippingInfo} onChange={event => setForm(current => ({...current, shippingInfo:event.target.value}))} placeholder="收件人、电话和地址"/></label></div></section><section><h2>报名科目与目标分</h2><p>仅勾选实际报名的科目；老师将按此开通课程、任务和自测权限。</p><div className="intake-subject-list">{form.subjects.map((item, index) => <div key={item.name}><label><input type="checkbox" checked={!!item.enrolled} onChange={event => updateSubject(index, {enrolled:event.target.checked})}/><b>{item.name}</b></label><label>单科目标分<input type="number" min="0" max="150" disabled={!item.enrolled} value={item.targetScore} onChange={event => updateSubject(index, {targetScore:event.target.value})} placeholder="例如：70"/></label></div>)}</div></section><footer className="exam-submit-bar"><span>提交后可继续通过本链接修改</span><button type="submit">提交并同步资料</button></footer></form>}</main></div>;
}

function EntranceExamPage({route, students, setStudents, entranceState, setEntranceState}) {
  const [remoteExam, setRemoteExam] = useState(null);
  const [remoteStatus, setRemoteStatus] = useState({ loading:isApiConfigured(), error:'' });
  const [answers, setAnswers] = useState(() => {
    if (typeof window === 'undefined') return {};
    try { return JSON.parse(window.sessionStorage.getItem(`shangan-exam-answers:${route.paperId}`) || '{}'); } catch { return {}; }
  });
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [, setClock] = useState(Date.now());
  useEffect(() => {
    if (typeof window === 'undefined' || submitted) return;
    try { window.sessionStorage.setItem(`shangan-exam-answers:${route.paperId}`, JSON.stringify(answers)); } catch { /* storage is optional; server remains authoritative */ }
  }, [route.paperId, answers, submitted]);

  useEffect(() => {
    if (!isApiConfigured()) return;
    let active = true;
    if (!route.token) {
      setRemoteStatus({ loading:false, error:'试卷链接无效或缺少访问凭证' });
      return undefined;
    }
    apiRequest(`/api/exams/${encodeURIComponent(route.paperId)}/${encodeURIComponent(route.token)}`)
      .then(payload => { if (active) { setRemoteExam(payload); setRemoteStatus({ loading:false, error:'' }); } })
      .catch(error => { if (active) setRemoteStatus({ loading:false, error:error?.message || '试卷加载失败' }); });
    return () => { active = false; };
  }, [route.paperId, route.token]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  if (isApiConfigured()) {
    if (remoteStatus.loading) return <div className="exam-standalone"><section className="exam-access-card"><Clock3 size={28}/><h1>正在加载试卷</h1><p>正在验证访问链接并读取试卷内容。</p></section></div>;
    if (remoteStatus.error || !remoteExam?.distribution) return <div className="exam-standalone"><section className="exam-access-card"><FileQuestion size={28}/><h1>试卷链接不可用</h1><p>{remoteStatus.error || '请联系老师重新分发试卷。'}</p></section></div>;
    const distribution = remoteExam.distribution;
    const questions = Array.isArray(remoteExam.questions) ? remoteExam.questions : [];
    const answeredCount = questions.filter(question => {
      const value = answers[question.itemIndex];
      return normalizeMultipleChoiceAnswer(value).length || String(value || '').trim();
    }).length;
    const examDeadline = distribution.exam_deadline_at || distribution.examDeadlineAt;
    const startDeadline = distribution.start_deadline_at || distribution.startDeadlineAt;
    const startedAt = distribution.started_at || distribution.startedAt;
    const examExpired = examDeadline && new Date(examDeadline).getTime() <= Date.now();
    const startExpired = startDeadline && new Date(startDeadline).getTime() <= Date.now();
    const startExam = async () => {
      setPending(true);
      try {
        const result = await apiRequest(`/api/exams/distributions/${encodeURIComponent(distribution.id)}/start`, { method:'POST' });
        setRemoteExam(current => ({ ...current, distribution:{ ...current.distribution, ...result, started_at: result.started_at || result.startedAt, exam_deadline_at: result.exam_deadline_at || result.examDeadlineAt } }));
      } catch (error) { setRemoteStatus({ loading:false, error:error?.message || '开始答题失败' }); } finally { setPending(false); }
    };
    const submit = async () => {
      if (answeredCount < questions.length && !window.confirm(`还有 ${questions.length - answeredCount} 题未作答，确定提前交卷吗？`)) return;
      setPending(true);
      try {
        const normalizedAnswers = Object.fromEntries(questions.map(question => {
          const value = answers[question.itemIndex];
          return [String(question.itemIndex), getQuestionType(question) === 'multiple_choice' ? normalizeMultipleChoiceAnswer(value) : value];
        }).filter(([, value]) => value !== undefined && value !== ''));
        await apiRequest(`/api/exams/distributions/${encodeURIComponent(distribution.id)}/submit`, { method:'POST', body:{ answers: normalizedAnswers } });
        try { window.sessionStorage.removeItem(`shangan-exam-answers:${route.paperId}`); } catch { /* ignore */ }
        setSubmitted(true);
      } catch (error) {
        // Keep the answer draft in sessionStorage and expose a retryable error.
        setRemoteStatus({ loading:false, error:error?.message || '交卷失败，请稍后重试' });
      } finally { setPending(false); }
    };
    const remainingSeconds = examDeadline ? Math.max(0, Math.ceil((new Date(examDeadline).getTime() - Date.now()) / 1000)) : 0;
    const remainingText = `${String(Math.floor(remainingSeconds / 60)).padStart(2, '0')}:${String(remainingSeconds % 60).padStart(2, '0')}`;
    if (examExpired && !submitted) return <div className="exam-standalone"><section className="exam-access-card"><FileQuestion size={28}/><h1>本次作答时间已结束</h1><p>请联系老师重新分发试卷。</p></section></div>;
    return <div className="exam-standalone"><main className="exam-paper"><header className="exam-paper-head"><span>入学自测</span><h1>{distribution.paper_title}</h1><p>{distribution.student_name}，请独立完成作答后提交。</p></header>{submitted ? <section className="exam-access-card"><Check size={28}/><h2>试卷已提交</h2><p>客观题已完成自动评分；如含主观题，将由老师后续批改。</p></section> : !startedAt ? <section className="exam-access-card"><FileQuestion size={28}/><h2>{startExpired ? '试卷开始时间已结束' : '准备开始答题'}</h2><p>{startExpired ? '本次试卷的开始期限已过，请联系老师重新分发。' : startDeadline ? `可在 ${new Date(startDeadline).toLocaleString('zh-CN')} 前开始。` : '可立即开始答题。'}</p>{!startExpired && <button type="button" className="primary" onClick={startExam} disabled={pending}>{pending ? '正在开始…' : '开始答题'}</button>}</section> : <>{questions.map((question, index) => <article className="exam-question" key={question.itemIndex ?? question.id}><span>{index + 1}</span><div><h2>{question.stem}</h2>{question.options?.length ? <div className="exam-options">{question.options.map((option, optionIndex) => { const letter = getQuestionOptionKey(option, optionIndex); const text = getQuestionOptionText(option); const multiple = isMultipleChoiceQuestion(question); const selected = multiple ? normalizeMultipleChoiceAnswer(answers[question.itemIndex]).includes(letter) : answers[question.itemIndex] === letter; return <label className={selected ? 'selected' : ''} key={letter}><input type={multiple ? 'checkbox' : 'radio'} name={`question-${question.itemIndex}`} checked={selected} onChange={() => setAnswers(current => ({...current, [question.itemIndex]: multiple ? toggleMultipleChoiceAnswer(current, question.itemIndex, letter) : letter}))} disabled={pending}/><b>{letter}</b><span>{text}</span></label>; })}</div> : <textarea className="exam-subjective-answer" value={answers[question.itemIndex] || ''} onChange={event => setAnswers(current => ({ ...current, [question.itemIndex]: event.target.value }))} placeholder="请填写你的作答；主观题提交后进入教师待批改状态。" rows={5} disabled={pending}/>}</div></article>)}<footer className="exam-submit-bar"><span>剩余 {remainingText} · 已作答 {answeredCount} / {questions.length} 题</span><button type="button" onClick={submit} disabled={pending}>{pending ? '正在交卷…' : '提前交卷'}</button></footer></>}</main></div>;
  }

  const paper = ENTRANCE_PAPERS.find(item => item.shareSlug === route.paperId);
  const student = students.find(item => String(item.intakeToken) === String(route.token));
  const distribution = paper && student ? entranceState?.distributions?.[paper.id]?.[student.id] : null;
  const validToken = paper && student && route.token === String(student.intakeToken);
  const existingSubmission = paper && student ? (entranceState?.submissions || []).find(item => item.paperId === paper.id && String(item.studentId) === String(student.id)) : null;
  if (!paper || !student || !validToken || !distribution) return <div className="exam-standalone"><section className="exam-access-card"><FileQuestion size={28}/><h1>试卷链接不可用</h1><p>请确认作答链接、学员信息和试卷分发状态，或联系老师重新分发。</p></section></div>;
  const startDeadlineAt = distribution.startDeadlineAt || distribution.expiresAt;
  const startExpired = startDeadlineAt && new Date(startDeadlineAt).getTime() <= Date.now();
  const examExpired = distribution.examDeadlineAt && new Date(distribution.examDeadlineAt).getTime() <= Date.now();
  const questions = flattenPaperQuestions(paper);
  const updateDistribution = patch => setEntranceState(current => ({
    ...current,
    distributions: {
      ...(current.distributions || {}),
      [paper.id]: {
        ...(current.distributions?.[paper.id] || {}),
        [student.id]: {...(current.distributions?.[paper.id]?.[student.id] || distribution), ...patch}
      }
    }
  }));
  const startExam = () => {
    if (startExpired) return;
    const startedAt = new Date();
    updateDistribution({startedAt:startedAt.toISOString(), examDeadlineAt:new Date(startedAt.getTime() + 60 * 60 * 1000).toISOString(), status:'作答中'});
  };
  const submit = (timedOut = false) => {
    if (!timedOut && Object.keys(answers).length < questions.length && !window.confirm(`还有 ${questions.length - Object.keys(answers).length} 题未作答，确定提前交卷吗？`)) return;
    const submittedAt = existingSubmission?.submittedAt || new Date().toISOString();
    const normalizedAnswers = Object.fromEntries(Object.entries(answers || {}).map(([key, value]) => {
      const question = questions.find(item => String(item.id) === String(key));
      return [key, isMultipleChoiceQuestion(question) ? normalizeMultipleChoiceAnswer(value) : value];
    }));
    const result = gradeEntrancePaper(paper, normalizedAnswers);
    const submission = { id: existingSubmission?.id || `submission-${Date.now()}`, paperId: paper.id, paperTitle: paper.title, studentId: student.id, studentName: student.name, answers:normalizedAnswers, submittedAt, gradedAt: new Date().toISOString(), status: timedOut ? '超时自动交卷' : (result.gradingStatus || '已批改'), ...result };
    setEntranceState(current => ({...current, submissions: [...(current.submissions || []).filter(item => item.id !== submission.id), submission], distributions:{...(current.distributions || {}), [paper.id]:{...(current.distributions?.[paper.id] || {}), [student.id]:{...(current.distributions?.[paper.id]?.[student.id] || distribution), submittedAt, status:timedOut ? '超时已交卷' : '已提交'}}}}));
    setStudents(current => current.map(item => String(item.id) === String(student.id) ? {...item, entranceRecords:[...(item.entranceRecords || []).filter(record => record.paperId !== paper.id), {paperId:paper.id, paperTitle:paper.title, score:result.score, total:result.total, submittedAt, gradedAt:submission.gradedAt}]} : item));
    setSubmitted(true);
  };
  if (examExpired && !submitted) return <div className="exam-standalone"><section className="exam-access-card"><FileQuestion size={28}/><h1>本次作答时间已结束</h1><p>答题时长为 1 小时，已保存的答案未提交。请联系老师重新分发试卷。</p></section></div>;
  const remainingSeconds = distribution.examDeadlineAt ? Math.max(0, Math.ceil((new Date(distribution.examDeadlineAt).getTime() - Date.now()) / 1000)) : 0;
  const remainingText = `${String(Math.floor(remainingSeconds / 60)).padStart(2, '0')}:${String(remainingSeconds % 60).padStart(2, '0')}`;
  return <div className="exam-standalone"><main className="exam-paper"><header className="exam-paper-head"><span>入学自测</span><h1>{paper.title}</h1><p>{student.name}，请独立完成作答后提交。</p></header>{submitted ? <section className="exam-access-card"><Check size={28}/><h2>已自动批改</h2><p>你的作答已完成自动评分与错题解析，可返回学习平台查看结果。</p></section> : !distribution.startedAt ? <section className="exam-access-card"><FileQuestion size={28}/><h2>{startExpired ? '试卷开始时间已结束' : '准备开始答题'}</h2><p>{startExpired ? '本次试卷的开始期限已过，请联系老师重新分发。' : `可在 ${new Date(startDeadlineAt).toLocaleString('zh-CN')} 前开始。点击开始后将有 1 小时作答时间，可提前交卷。`}</p>{!startExpired && <button type="button" className="primary" onClick={startExam}>开始答题</button>}</section> : <>{questions.map((question, index) => <article className="exam-question" key={question.id}><span>{index + 1}</span><div><h2>{question.prompt}</h2><div className="exam-options">{question.options.map((option, optionIndex) => { const letter = getQuestionOptionKey(option, optionIndex); const text = getQuestionOptionText(option); const multiple = isMultipleChoiceQuestion(question); const selected = multiple ? normalizeMultipleChoiceAnswer(answers[question.id]).includes(letter) : answers[question.id] === letter; return <label className={selected ? 'selected' : ''} key={letter}><input type={multiple ? 'checkbox' : 'radio'} name={question.id} checked={selected} onChange={() => setAnswers(current => ({...current, [question.id]: multiple ? toggleMultipleChoiceAnswer(current, question.id, letter) : letter}))}/><b>{letter}</b><span>{text}</span></label>; })}</div></div></article>)}<footer className="exam-submit-bar"><span>剩余 {remainingText} · 已作答 {Object.keys(answers).length} / {questions.length} 题</span><button type="button" onClick={() => submit(false)}>提前交卷</button></footer></>}</main></div>;
}

function StudentPage({ page, setPage, students, studentPreviewId, studentLoadState, onRetryStudentLoad, setStudentPreviewId, setStudents, entranceState, setEntranceState, contentItems, setContentItems, applicationData, tasks, setTasks, posts, setPosts, open, notify, aiSettings, knowledgeBase }) {
  const [planInitialView, setPlanInitialView] = useState('today');
  const [assessmentEntry, setAssessmentEntry] = useState(null);
  const activeStudent = students.find(student => String(student.id) === String(studentPreviewId)) || null;
  useEffect(() => {
    if (page !== 'plan') setPlanInitialView('today');
  }, [page]);
  if (!activeStudent) {
    const failed = studentLoadState?.status === 'error';
    return <section className="empty-line student-task-empty"><UserRoundX size={22}/><span>{failed ? (studentLoadState.message || '学习档案加载失败，请稍后重试。') : '正在加载你的学习档案；若长时间未显示，请刷新页面或联系老师核对账号绑定。'}</span>{failed && <button type="button" className="secondary" onClick={onRetryStudentLoad}>重新加载</button>}</section>;
  }
  const confirmedSubjects = activeStudent.subjects?.filter(item => item.enrolled) || [];
  const studentPlans = activeStudent?.assignedPlans || [];
  const studentSelector = null;
  if (page === 'courses') return <StudentCourses student={activeStudent} items={contentItems} selector={studentSelector} notify={notify}/>;
  if (page === 'store') return <StudentStore student={activeStudent} items={contentItems} setItems={setContentItems} setStudents={setStudents} selector={studentSelector} notify={notify}/>;
  if (page === 'practice') return <StudentWeeklyAssessment student={activeStudent} aiSettings={aiSettings} setStudents={setStudents} notify={notify} activeModule={assessmentEntry} onOpenModule={setAssessmentEntry} onCloseModule={() => setAssessmentEntry(null)}/>;
  if (page === 'archive') return <StudentAssessmentArchive student={activeStudent} entranceState={entranceState} setEntranceState={setEntranceState} selector={studentSelector} notify={notify} aiSettings={aiSettings} onOpenAssessment={module => { setAssessmentEntry(module); setPage('practice'); }}/>;
  if (page === 'plan') return <StudentAssignedTasks student={activeStudent} plans={studentPlans} setStudents={setStudents} notify={notify} selector={studentSelector} aiSettings={aiSettings} initialView={planInitialView} onOpenFutureSevenDays={() => setPlanInitialView('future')}/>;
  if (page === 'tools') return <StudentTools enrolledSubjects={confirmedSubjects} applicationData={applicationData} selector={studentSelector} aiSettings={aiSettings} onOpenTutor={() => setPage('tutor')} onOpenCompanion={() => setPage('companion-study')} onOpenPolitics={() => setPage('politics')} onOpenEnglishWords={() => setPage('english-words')} onOpenEnglishChoice={() => setPage('english-choice')} onOpenMathFormulas={() => setPage('math-formulas')} onOpenMathPractice={() => notify('数学专项练习将在题库配置完成后开放')}/>;
  if (page === 'math-formulas') return <StudentFormulaPractice student={activeStudent} books={(applicationData || loadApplicationData()).mathItems?.formula || []} selector={studentSelector} onBack={() => setPage('tools')}/>;
  if (page === 'tutor') return <StudentQuestionTutor student={activeStudent} setStudents={setStudents} knowledgeBase={knowledgeBase} aiSettings={aiSettings} notify={notify} selector={studentSelector} onBack={() => setPage('tools')}/>;
  if (page === 'politics') return <StudentChoicePractice student={activeStudent} title="政治选择题" subject="政治" books={getLocalPoliticsBooks(applicationData || loadApplicationData())} selector={studentSelector} notify={notify} onBack={() => setPage('tools')}/>;
  if (page === 'english-words') return <StudentWordsPractice student={activeStudent} books={(applicationData || loadApplicationData()).englishBooks || []} selector={studentSelector} onBack={() => setPage('tools')}/>;
  if (page === 'english-choice') return <StudentChoicePractice student={activeStudent} title="英语选择题" subject="英语" books={(applicationData || loadApplicationData()).englishChoiceBooks || []} selector={studentSelector} notify={notify} onBack={() => setPage('tools')}/>;
  if (page === 'companion-study') return <CompanionStudy student={activeStudent} notify={notify} onBack={() => setPage('home')}/>;
  if (page === 'community') return <Community posts={posts} setPosts={setPosts} student={activeStudent} notify={notify}/>;
  if (page === 'profile') return <StudentProfile student={activeStudent} setStudents={setStudents} notify={notify}/>;
  return <StudentHome student={activeStudent} plans={studentPlans} setStudents={setStudents} notify={notify} selector={studentSelector} aiSettings={aiSettings} entranceState={entranceState} onOpenArchive={() => setPage('archive')} onOpenAssessment={module => { setAssessmentEntry(module); setPage('practice'); }} onOpenFutureSevenDays={() => { setPlanInitialView('future'); setPage('plan'); }} onOpenProfile={() => setPage('profile')}/>;
}

const normalizeStudentSubject = name => normalizeSubjectCategory(name);

const getTaskItems = row => {
  const lines = (row?.tasks || [])
    .map((text, index) => ({index, text: String(text || '').trim()}))
    .filter(item => item.text);
  if (lines.length) return lines;
  if (row?.note) return [{index: -1, text: String(row.note).trim()}];
  return [];
};

const getTaskDoneList = row => {
  const length = Math.max((row?.tasks || []).length, 1);
  if (Array.isArray(row?.taskDone) && row.taskDone.length) {
    return Array.from({length}, (_, index) => !!row.taskDone[index]);
  }
  return Array.from({length}, () => !!row?.completed);
};

const isTaskItemDone = (row, taskIndex) => {
  if (taskIndex < 0) return !!row?.completed;
  return !!getTaskDoneList(row)[taskIndex];
};

const isRowComplete = row => {
  const items = getTaskItems(row);
  if (!items.length) return !!row?.completed;
  return items.every(item => isTaskItemDone(row, item.index));
};

const toggleRowTaskItem = (row, taskIndex, completedAt = new Date().toISOString()) => {
  const tasks = row?.tasks || [];
  if (taskIndex < 0) {
    const nextCompleted = !row?.completed;
    return {
      ...row,
      completed: nextCompleted,
      completedAt: nextCompleted ? completedAt : null,
      taskDone: tasks.map(() => nextCompleted)
    };
  }
  const currentDone = getTaskDoneList(row);
  const nextDone = tasks.map((_, index) =>
    index === taskIndex ? !currentDone[index] : !!currentDone[index]
  );
  const items = getTaskItems({...row, tasks});
  const allDone = items.length > 0 && items.every(item => !!nextDone[item.index]);
  return {
    ...row,
    taskDone: nextDone,
    completed: allDone,
    // 当天完成的整行保留在今日，防止立即露出下一天任务。
    completedAt: allDone ? (row?.completedAt || completedAt) : null
  };
};

const estimateTaskMinutes = task => {
  const lines = getTaskItems(task);
  if (lines.length) return Math.max(15, lines.length * 20);
  if (task.note) return 25;
  return 20;
};

const estimateItemMinutes = () => 20;

const formatTaskMinutes = minutes => {
  if (!minutes) return '0 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
};

/** 英语日 / 周 / 月自测规格：不预置试卷，按学员计划由 AI 出题 */
const PERIODIC_ASSESSMENT_SPECS = {
  daily: { id: 'daily', title: '日测试', short: '日测', tone: 'day', words: 15, sentences: 2, cadence: '每日', desc: '根据该学员当日复习计划内容，由 AI 生成 15 个单词 + 2 句考研阅读真题句子翻译。', priority: 1 },
  weekly: { id: 'weekly', title: '周测试', short: '周测', tone: 'week', words: 20, sentences: 6, cadence: '每 7 个学习日', desc: '汇总该学员近一周计划中的学习内容，由 AI 生成 20 个单词 + 6 句考研阅读真题句子翻译。', priority: 2 },
  monthly: { id: 'monthly', title: '月测试', short: '月测', tone: 'month', words: 50, sentences: 10, cadence: '每 30 个学习日', desc: '按该学员近一月计划内容复盘，由 AI 生成 50 个单词 + 10 句考研阅读真题句子翻译。', priority: 3 }
};

const SUBJECT_ASSESSMENT_SPECS = {
  英语: Object.values(PERIODIC_ASSESSMENT_SPECS).map(spec => ({ ...spec, id: `英语-${spec.id}`, subject: '英语', typeId: spec.id, format: `${spec.words} 个单词 + ${spec.sentences} 句翻译`, promptRole: '考研英语出题助手', promptTask: `生成 ${spec.words} 个单词与 ${spec.sentences} 句考研阅读真题句子翻译`, outputSchema: '{ words:[{word,meaning,phonetic?}], sentences:[{en,zh,source?}], answerKey:string }' })),
  政治: [{ id: '政治-daily', subject: '政治', typeId: 'daily', title: '政治日测', short: '政治日测', tone: 'day', cadence: '每日', format: '5 个选择题', desc: '根据该学员当日政治学习内容生成 5 个单项选择题。', promptRole: '考研政治出题助手', promptTask: '生成 5 个单项选择题，每题提供 A、B、C、D 四个选项、正确答案与简要解析', outputSchema: '{ questions:[{stem,options:[string,string,string,string],answer,analysis,knowledgePoint}], answerKey:string }' }],
  数学: [
    { id: '数学-daily', subject: '数学', typeId: 'daily', title: '数学日测', short: '数学日测', tone: 'day', cadence: '每日', format: '5 个公式 + 1 个积分计算题', desc: '根据当天数学学习内容安排公式复习与积分计算。', promptRole: '考研数学出题助手', promptTask: '生成 5 个公式复习题和 1 个积分计算题，附标准答案与简要步骤', outputSchema: '{ questions:[{stem,answer,analysis,knowledgePoint}], answerKey:string }' },
    { id: '数学-weekly', subject: '数学', typeId: 'weekly', title: '数学周测', short: '数学周测', tone: 'week', cadence: '每 7 个学习日', format: '10 个计算题', desc: '根据近 7 个学习日的数学内容安排计算训练。', promptRole: '考研数学出题助手', promptTask: '生成 10 个与近一周学习内容匹配的计算题，附标准答案与关键步骤', outputSchema: '{ questions:[{stem,answer,analysis,knowledgePoint}], answerKey:string }' },
    { id: '数学-monthly', subject: '数学', typeId: 'monthly', title: '数学月测', short: '数学月测', tone: 'month', cadence: '每 30 个学习日', format: '20 个计算题', desc: '根据近一月数学学习内容进行阶段计算复盘。', promptRole: '考研数学出题助手', promptTask: '生成 20 个与本月学习内容匹配的计算题，附标准答案与关键步骤', outputSchema: '{ questions:[{stem,answer,analysis,knowledgePoint}], answerKey:string }' }
  ],
  专业课: Object.values(PERIODIC_ASSESSMENT_SPECS).map(spec => ({ ...spec, id: `专业课-${spec.id}`, subject: '专业课', typeId: spec.id, title: `专业课${spec.short}`, short: `专业课${spec.short}`, format: spec.id === 'daily' ? '5 个知识点练习题' : spec.id === 'weekly' ? '10 个综合练习题' : '20 个综合练习题', desc: '根据该学员专业课学习内容生成阶段练习题。', promptRole: '考研专业课出题助手', promptTask: '生成与当前学习内容匹配的选择或简答练习题，并附标准答案与简要解析', outputSchema: '{ questions:[{stem,options?,answer,analysis,knowledgePoint}], answerKey:string }' }))
};

const getTeacherAssessmentSpecs = () => Object.values(SUBJECT_ASSESSMENT_SPECS).flat();
const getAssessmentSpec = specId => getTeacherAssessmentSpecs().find(spec => spec.id === specId) || getTeacherAssessmentSpecs().find(spec => spec.typeId === specId);
const getStudentAssessmentSpecs = student => {
  const enrolled = new Set((student?.subjects || []).filter(item => item.enrolled).map(item => normalizeStudentSubject(item.name)));
  return getTeacherAssessmentSpecs().filter(spec => enrolled.has(spec.subject));
};
const getAssessmentSpecFormat = spec => spec?.format || '按学习计划生成';

const defaultAssessmentPush = () => ({
  enabled: false,
  daily: false,
  weekly: false,
  monthly: false,
  subjectSettings: {},
  assignedAt: null,
  personalStartDate: null,
  studyDayOffset: 0,
  note: '',
  optedOut: false
});

const normalizeAssessmentPush = (raw = {}) => {
  const base = defaultAssessmentPush();
  const merged = { ...base, ...(raw || {}) };
  if (raw && raw.daily === undefined && raw.weekly === undefined && raw.monthly === undefined) {
    const on = !!raw.enabled;
    merged.daily = on; merged.weekly = on; merged.monthly = on;
  }
  merged.daily = !!merged.daily; merged.weekly = !!merged.weekly; merged.monthly = !!merged.monthly;
  const legacySubjectSettings = raw?.subjectSettings || {};
  merged.subjectSettings = ['政治', '英语', '数学', '专业课'].reduce((result, subject) => {
    const current = legacySubjectSettings[subject] || {};
    result[subject] = {
      daily: current.daily === undefined ? merged.daily : !!current.daily,
      weekly: current.weekly === undefined ? merged.weekly : !!current.weekly,
      monthly: current.monthly === undefined ? merged.monthly : !!current.monthly
    };
    return result;
  }, {});
  merged.enabled = Object.values(merged.subjectSettings).some(setting => setting.daily || setting.weekly || setting.monthly);
  merged.optedOut = !!merged.optedOut;
  merged.studyDayOffset = Math.max(0, Number(merged.studyDayOffset) || 0);
  return merged;
};

const getAssessmentPush = student => normalizeAssessmentPush(student?.assessmentPush);
const isAssessmentTypeEnabled = (push, typeId, subject) => {
  const p = normalizeAssessmentPush(push);
  if (subject) return !!p.subjectSettings?.[subject]?.[typeId];
  return Object.values(p.subjectSettings || {}).some(setting => !!setting[typeId]);
};

const buildDefaultPushForStudent = (studentLike = {}, existingPush) => {
  const current = normalizeAssessmentPush(existingPush || studentLike.assessmentPush);
  if (studentLike.status !== '付费' || current.optedOut || current.enabled) return current;
  const subjectSettings = Object.fromEntries(['政治', '英语', '数学', '专业课'].map(subject => [subject, {daily:true, weekly:true, monthly:true}]));
  return normalizeAssessmentPush({ ...current, daily:true, weekly:true, monthly:true, subjectSettings, assignedAt: current.assignedAt || new Date().toISOString(), note: current.note || '付费学员默认开通，可按科目单独关闭', optedOut:false });
};

/** 休息日：学生自选一周中的一天；须提前一天设置才生效；命中当日暂停学习规划推送 */
const REST_WEEKDAY_OPTIONS = [
  { value: 1, label: '周一', short: '一' },
  { value: 2, label: '周二', short: '二' },
  { value: 3, label: '周三', short: '三' },
  { value: 4, label: '周四', short: '四' },
  { value: 5, label: '周五', short: '五' },
  { value: 6, label: '周六', short: '六' },
  { value: 0, label: '周日', short: '日' }
];

const REST_DAY_MESSAGE = '休息愉快，好好休息。';

const normalizeRestWeekday = value => {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  if (!Number.isInteger(num) || num < 0 || num > 6) return null;
  return num;
};

const getRestWeekdayLabel = value => {
  const day = normalizeRestWeekday(value);
  if (day === null) return '未设置';
  return REST_WEEKDAY_OPTIONS.find(item => item.value === day)?.label || '未设置';
};

const getStudentRestWeekday = student => normalizeRestWeekday(student?.restWeekday);

/** 取自然日 00:00:00 本地时间戳 */
const startOfLocalDay = value => {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(0, 0, 0, 0);
  return date;
};

/**
 * 休息日是否在「date」当天生效。
 * 规则：restWeekday 命中当日星期，且 restWeekdaySetAt 必须早于当日 00:00（提前至少一天设置）。
 * 未设置、取消（null）、或当天临时改选 → 不生效，按正常推送。
 */
const isRestDayToday = (student, date = new Date()) => {
  const rest = getStudentRestWeekday(student);
  if (rest === null) return false;
  const current = date instanceof Date ? date : new Date(date || Date.now());
  if (Number.isNaN(current.getTime())) return false;
  if (current.getDay() !== rest) return false;
  const setAtRaw = student?.restWeekdaySetAt;
  if (!setAtRaw) return false;
  const setAt = new Date(setAtRaw);
  if (Number.isNaN(setAt.getTime())) return false;
  const dayStart = startOfLocalDay(current);
  if (!dayStart) return false;
  return setAt.getTime() < dayStart.getTime();
};

/** 已选中休息日且星期命中今天，但因未提前一天设置而尚未生效 */
const isRestDayPendingToday = (student, date = new Date()) => {
  const rest = getStudentRestWeekday(student);
  if (rest === null) return false;
  const current = date instanceof Date ? date : new Date(date || Date.now());
  if (Number.isNaN(current.getTime())) return false;
  if (current.getDay() !== rest) return false;
  return !isRestDayToday(student, current);
};

const toDateKey = value => {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/** 按学员个人学习日起算：第 1 天起；第 7/14… 天周测，第 30/60… 天月测 */
const getPersonalStudyDay = student => {
  const push = getAssessmentPush(student);
  if (!push.enabled || !push.personalStartDate) return 0;
  const start = new Date(`${push.personalStartDate}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  start.setHours(0, 0, 0, 0);
  const diff = Math.floor((today - start) / 86400000) + 1 + (Number(push.studyDayOffset) || 0);
  return Math.max(1, diff);
};

/**
 * 优先级：月测日 > 周测日 > 日测；仅在该类型已为该学员开通时生效。
 * 高优先级类型未开通时，回退到已开通的次级类型。
 */
const resolveTodayAssessmentType = student => {
  if (isRestDayToday(student)) return null;
  const push = getAssessmentPush(student);
  if (!push.enabled) return null;
  const day = getPersonalStudyDay(student);
  if (!day) return null;
  if (day >= 30 && day % 30 === 0) {
    if (push.monthly) return 'monthly';
    if (push.weekly) return 'weekly';
    if (push.daily) return 'daily';
    return null;
  }
  if (day >= 7 && day % 7 === 0) {
    if (push.weekly) return 'weekly';
    if (push.daily) return 'daily';
    return null;
  }
  if (push.daily) return 'daily';
  return null;
};

const collectPlanLearningScope = (plans, maxDays = 7) => {
  const lines = [];
  (plans || []).forEach(plan => {
    const startDay = Math.max(1, Number(plan.startDay) || 1);
    const rows = plan.rows || [];
    rows.forEach((row, index) => {
      const dayNumber = startDay + index;
      if (dayNumber > maxDays) return;
      const items = getTaskItems(row).map(item => item.text).filter(Boolean);
      if (!items.length && !row?.note) return;
      lines.push({
        subject: plan.subject || '未分类',
        planName: plan.name || '未命名计划',
        dayNumber,
        content: items.length ? items.join('；') : String(row.note || '')
      });
    });
  });
  return lines.sort((a, b) => a.dayNumber - b.dayNumber || String(a.subject).localeCompare(String(b.subject), 'zh-CN'));
};

const buildAssessmentPromptDraft = (student, specId) => {
  const spec = getAssessmentSpec(specId);
  if (!student || !spec) return '';
  const studyDay = getPersonalStudyDay(student);
  const lookback = spec.subject === '数学' && spec.typeId === 'monthly' ? 7 : spec.typeId === 'monthly' ? 30 : spec.typeId === 'weekly' ? 7 : 1;
  const scope = collectPlanLearningScope(student.assignedPlans || [], Math.max(studyDay, lookback));
  const recent = scope.filter(item => normalizeStudentSubject(item.subject) === spec.subject && item.dayNumber >= Math.max(1, studyDay - lookback + 1) && item.dayNumber <= Math.max(studyDay, 1));
  const scopeText = recent.length
    ? recent.map(item => `第${item.dayNumber}天 · ${item.subject} · ${item.planName}：${item.content}`).join('\n')
    : `（当前学员${spec.subject}复习计划中暂无可读内容，请先布置并写明每日任务）`;
  return [
    `你是${spec.promptRole}。请为学员「${student.name}」生成一对一的${spec.title}。`,
    `学员个人学习日：第 ${studyDay || 1} 天（与其他学员进度独立，勿共用同一套题）。`,
    `题量与形式：${getAssessmentSpecFormat(spec)}。${spec.promptTask}。`,
    spec.subject === '英语' ? '句子须来自考研英语阅读真题中的真实句子；同一份试卷内句子不得重复，跨日可重复。' : '题目应紧扣学习内容，避免超出当前复习阶段。',
    `题目应紧扣下列该学员${spec.subject}复习计划中的学习内容：`,
    scopeText,
    `输出 JSON：${spec.outputSchema}。`,
    '测完后给出完整答案与简要解析，供教师端复核后同步学生。'
  ].join('\n');
};

const getStudentAssessmentModules = (student, aiSettings) => {
  const push = getAssessmentPush(student);
  const restToday = isRestDayToday(student);
  const aiReady = !isApiConfigured() && isAiSlotReady(aiSettings, 'periodic_assessment');
  const todayType = resolveTodayAssessmentType(student);
  const specs = getStudentAssessmentSpecs(student);
  return specs.map(spec => {
    const typeOn = isAssessmentTypeEnabled(push, spec.typeId, spec.subject);
    const isToday = !restToday && typeOn && spec.typeId === todayType;
    return {
      ...spec,
      isToday,
      status: restToday
        ? `今日休息（${getRestWeekdayLabel(student?.restWeekday)}）· 暂停测试`
        : !typeOn
          ? '该科目尚未开通此类自测'
          : isToday
            ? (aiReady ? '今日可开始作答' : '今日测试正在准备中')
            : (todayType ? `今日安排为${getAssessmentSpec(todayType)?.short || '其他测试'}` : '今日暂无测试安排'),
      actionable: isToday && aiReady,
      enabled: typeOn
    };
  });
};

/** 计划是否已全部完成（所有行的任务都打完） */
const isPlanFullyComplete = plan => {
  const rows = plan?.rows || [];
  if (!rows.length) return false;
  return rows.every(row => isRowComplete(row));
};

/** 计划必须同时满足自然日期与前置计划条件，才可进入学生任务计算。 */
/** 将前端字段、数据库 snake_case 字段及 ISO 时间统一为原生日期控件可识别的 YYYY-MM-DD。 */
const normalizeDateOnly = value => {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
};

const getPlanStartDate = plan => normalizeDateOnly(plan?.startDate || plan?.start_date);

const isPlanDateUnlocked = (plan, now = new Date()) => {
  const startDate = getPlanStartDate(plan);
  return !startDate || toDateKey(now) >= startDate;
};

const formatPlanStartDate = value => {
  const normalized = normalizeDateOnly(value);
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[1]} 年 ${Number(match[2])} 月 ${Number(match[3])} 日` : '';
};

/** 已到开始日期且前置计划已完成的解锁计划列表 */
const getUnlockedPlans = (plans, now = new Date()) => {
  const completedPlanIds = new Set(
    (plans || [])
      .filter(plan => isPlanFullyComplete(plan))
      .map(plan => String(plan.id))
  );
  return (plans || []).filter(
    plan => isPlanDateUnlocked(plan, now) && (!(plan.predecessorAssignmentId || plan.predecessorPlanId) || completedPlanIds.has(String(plan.predecessorAssignmentId || plan.predecessorPlanId)))
  );
};

/** 当前推进到的行下标：当天刚完成的整行会保留到次日，避免同日提前推进。 */
const getPlanActiveRowIndex = (plan, now = new Date()) => {
  const rows = plan?.rows || [];
  if (!rows.length) return -1;
  const incomplete = rows.findIndex(row => !isRowComplete(row));
  if (incomplete === -1) return rows.length - 1;
  if (incomplete > 0) {
    const previous = rows[incomplete - 1];
    if (isRowComplete(previous) && previous?.completedAt && toDateKey(previous.completedAt) === toDateKey(now)) {
      return incomplete - 1;
    }
  }
  return incomplete;
};

/**
 * 今日推送：每个解锁计划取「当前活跃行」的任务。
 * - 行内未完成项：继续出现在今日待办
 * - 行内已完成项：仍显示为已完成（便于对账）
 * - 整行完成后：次日自动切到下一行新任务
 * 阶段多任务各自独立勾选（taskDone[]），互不影响。
 */
const buildTodayTaskItems = plans => {
  return getUnlockedPlans(plans).flatMap(plan => {
    const rows = plan.rows || [];
    const rowIndex = getPlanActiveRowIndex(plan);
    if (rowIndex < 0) return [];
    const row = rows[rowIndex];
    if (!row) return [];
    const base = {
      planId: plan.id,
      planName: plan.name,
      subject: normalizeStudentSubject(plan.subject),
      taskType: plan.taskType || '阶段',
      lane: plan.lane || 1,
      rowIndex,
      dayNumber: Math.max(1, Number(plan.startDay || plan.start_day) || 1) + rowIndex,
      attachments: row.attachments || []
    };
    const items = getTaskItems(row);
    if (!items.length) {
      return [{
        ...base,
        taskIndex: -1,
        text: '当天暂未填写任务',
        completed: !!row.completed,
        minutes: estimateItemMinutes()
      }];
    }
    return items.map(item => ({
      ...base,
      taskIndex: item.index,
      text: item.text,
      completed: isTaskItemDone(row, item.index),
      carry: row.carryFrom?.[item.index] || null,
      planned: row.taskProgress?.[item.index]?.planned || getTaskMeasurableTarget(item.text)?.planned || null,
      actual: row.taskProgress?.[item.index]?.actual ?? null,
      minutes: estimateItemMinutes()
    }));
  });
};

/**
 * 展开未来若干天：从每个计划的活跃行起，后续行依次为第 2、3… 天。
 * 今日 = 活跃行（第 1 天）；已全部完成的计划不再出现在未来列表。
 */
const expandPlanItemsFromProgress = (planList, maxDay = 7) => planList.flatMap(plan => {
  const rows = plan.rows || [];
  if (!rows.length) return [];
  const activeIndex = getPlanActiveRowIndex(plan);
  if (activeIndex < 0) return [];
  // 已全部完成：仅把最后一行作为「今日已完成」展示，不展开未来
  const fullyDone = isPlanFullyComplete(plan);
  const endIndex = fullyDone
    ? activeIndex
    : Math.min(rows.length - 1, activeIndex + maxDay - 1);
  const result = [];
  for (let rowIndex = activeIndex; rowIndex <= endIndex; rowIndex += 1) {
    const relativeDay = rowIndex - activeIndex + 1;
    if (relativeDay > maxDay) break;
    const row = rows[rowIndex];
    const base = {
      planId: plan.id,
      planName: plan.name,
      subject: normalizeStudentSubject(plan.subject),
      rawSubject: plan.subject,
      taskType: plan.taskType || '阶段',
      lane: plan.lane || 1,
      dayNumber: Math.max(1, Number(plan.startDay || plan.start_day) || 1) + rowIndex,
      relativeDay,
      rowIndex,
      attachments: row.attachments || []
    };
    const items = getTaskItems(row);
    if (!items.length) {
      result.push({
        ...base,
        taskIndex: -1,
        text: '当天暂未填写任务',
        completed: !!row.completed
      });
      continue;
    }
    items.forEach(item => {
      result.push({
        ...base,
        taskIndex: item.index,
        text: item.text,
        completed: isTaskItemDone(row, item.index),
        carry: row.carryFrom?.[item.index] || null
      });
    });
  }
  return result;
}).sort((left, right) =>
  left.dayNumber - right.dayNumber ||
  left.lane - right.lane ||
  String(left.subject).localeCompare(String(right.subject), 'zh-CN') ||
  left.taskIndex - right.taskIndex
);

const getQuantityTask = text => {
  const match = String(text || '').match(/(\d+)(\s*)(个|题|篇|页|分钟|分|遍|组|章|词)/);
  if (!match) return null;
  return { value: Number(match[1]), unit: match[3], start: match.index, length: match[0].length };
};

const replaceTaskQuantity = (text, value) => {
  const quantity = getQuantityTask(text);
  const safeValue = Math.max(0, Math.round(Number(value) || 0));
  if (!quantity || !safeValue) return text;
  return `${String(text).slice(0, quantity.start)}${safeValue}${String(text).slice(quantity.start + String(quantity.value).length)}`;
};

const getTaskRange = text => {
  const match = String(text || '').match(/(第?\s*)(\d+)\s*(?:[-~～到至]\s*)(\d+)(\s*(?:节|讲|课))/);
  if (!match) return null;
  return { start: Number(match[2]), end: Number(match[3]), prefix: match[1], suffix: match[4], index: match.index, length: match[0].length };
};

const replaceTaskRange = (text, start, end) => {
  const range = getTaskRange(text);
  if (!range || !Number.isFinite(start) || !Number.isFinite(end) || end < start) return text;
  return `${String(text).slice(0, range.index)}${range.prefix}${Math.round(start)}~${Math.round(end)}${range.suffix}${String(text).slice(range.index + range.length)}`;
};

const getTaskMeasurableTarget = text => {
  const range = getTaskRange(text);
  if (range) return { kind: 'range', planned: range.end - range.start + 1, range };
  const quantity = getQuantityTask(text);
  return quantity ? { kind: 'quantity', planned: quantity.value, quantity } : null;
};

/**
 * 写入一次实际完成量，并将未完成部分顺延到后续同一任务列。
 * 数量任务保持次日总量不变，未完成部分占用次日额度；视频等连续区间整体后移，确保不跳集。
 */
const applyTaskActualProgress = (plan, rowIndex, taskIndex, actual, at = new Date().toISOString()) => {
  const row = plan?.rows?.[rowIndex];
  const sourceText = row?.tasks?.[taskIndex] || '';
  const target = getTaskMeasurableTarget(sourceText);
  if (!row || !target) return plan;
  const safeActual = Math.max(0, Math.round(Number(actual) || 0));
  const remaining = Math.max(0, target.planned - safeActual);
  const nextRows = (plan.rows || []).map((current, index) => {
    if (index === rowIndex) {
      const done = getTaskDoneList(current);
      const nextDone = current.tasks.map((_, itemIndex) => itemIndex === taskIndex ? true : !!done[itemIndex]);
      const allDone = getTaskItems(current).every(item => !!nextDone[item.index]);
      return {
        ...current,
        taskDone: nextDone,
        completed: allDone,
        completedAt: allDone ? (current.completedAt || at) : null,
        partialAt: remaining > 0 ? at : null,
        taskProgress: {...(current.taskProgress || {}), [taskIndex]: {planned: target.planned, actual: safeActual, remaining, at}}
      };
    }
    if (index <= rowIndex || !remaining || !current.tasks?.[taskIndex]) return current;
    // 数量任务只占用下一学习日的额度；视频连续区间需同步改写后续范围以避免跳集。
    if (target.kind === 'quantity' && index !== rowIndex + 1) return current;
    const nextText = current.tasks[taskIndex];
    const nextQuantity = target.kind === 'quantity' ? getQuantityTask(nextText) : null;
    const priorCarry = current.carryFrom?.[taskIndex];
    const carryTotal = nextQuantity
      ? Math.min(nextQuantity.value, Math.max(0, Number(priorCarry?.remaining) || 0) + remaining)
      : remaining;
    const revised = target.kind === 'range'
      ? (() => { const nextRange = getTaskRange(nextText); return nextRange ? replaceTaskRange(nextText, nextRange.start - remaining, nextRange.end - remaining) : nextText; })()
      : nextText;
    const carry = target.kind === 'quantity' && nextQuantity
      ? {fromRow: rowIndex, remaining:carryTotal, plannedTotal:nextQuantity.value, newPortion:Math.max(0, nextQuantity.value - carryTotal), kind:'quantity', at}
      : {fromRow:rowIndex, remaining, kind:target.kind, at};
    return {...current, ...(revised === nextText ? {} : {tasks: current.tasks.map((text, itemIndex) => itemIndex === taskIndex ? revised : text)}), carryFrom: {...(current.carryFrom || {}), [taskIndex]: carry}};
  });
  return {...plan, rows: nextRows};
};

const getPlanAssistantAdjustmentRules = aiSettings => {
  const prompt = String(getAiSlotConfig(aiSettings, 'plan_assistant')?.systemPrompt || '');
  const read = (label, fallback) => {
    const matched = prompt.match(new RegExp(`${label}[：:]\\s*(\\d+(?:\\.\\d+)?)%?`));
    return matched ? Number(matched[1]) : fallback;
  };
  return {
    underperformCount: Math.max(1, read('连续未达标次数', 3)),
    underperformRate: Math.max(0, Math.min(100, read('未达标阈值', 50))) / 100,
    decreaseRate: Math.max(1, Math.min(90, read('下调幅度', 15))) / 100,
    strongCount: Math.max(1, read('连续完成次数', 5)),
    strongRate: Math.max(0, Math.min(100, read('完成良好阈值', 90))) / 100,
    increaseRate: Math.max(1, Math.min(50, read('上调幅度', 5))) / 100
  };
};

const getTaskAdjustmentDecision = (records = [], rules) => {
  const recent = (records || []).slice(-Math.max(rules.underperformCount, rules.strongCount));
  const last = recent[recent.length - 1];
  const tail = count => recent.slice(-count);
  const failed = tail(rules.underperformCount);
  if (failed.length === rules.underperformCount && failed.filter(item => item.completed).length / failed.length <= rules.underperformRate) return { direction: 'decrease', factor: 1 - rules.decreaseRate, label: `连续未达标，下调 ${Math.round(rules.decreaseRate * 100)}% 任务量`, completionRate: failed.filter(item => item.completed).length / failed.length, anchor: last };
  const strong = tail(rules.strongCount);
  if (strong.length === rules.strongCount && strong.filter(item => item.completed).length / strong.length >= rules.strongRate) return { direction: 'increase', factor: 1 + rules.increaseRate, label: `连续完成良好，上调 ${Math.round(rules.increaseRate * 100)}% 任务量`, completionRate: strong.filter(item => item.completed).length / strong.length, anchor: last };
  return null;
};

const runScheduledPlanAdjustment = ({plans = [], checkins = [], automation, rules, now = new Date()}) => {
  if (!shouldRunPlanAdjustmentCheck(automation, now.getTime())) return {plans, automation, adjustment:null, checked:false};
  const decision = getTaskAdjustmentDecision(checkins, rules);
  const nextAutomation = {...automation, lastCheckedAt:now.toISOString()};
  if (!decision) return {plans, automation:nextAutomation, adjustment:null, checked:true};
  const changes = [];
  const nextPlans = plans.map(plan => {
    const activeRow = getPlanActiveRowIndex(plan);
    return {
      ...plan,
      rows: (plan.rows || []).map((row, rowIndex) => ({
        ...row,
        tasks: (row.tasks || []).map((text, taskIndex) => {
          const quantity = getQuantityTask(text);
          if (!quantity || rowIndex < activeRow || (rowIndex === activeRow && isTaskItemDone(row, taskIndex))) return text;
          const after = replaceTaskQuantity(text, quantity.value * decision.factor);
          if (after !== text) changes.push({planId:plan.id, planName:plan.name, rowIndex, taskIndex, before:text, after});
          return after;
        })
      }))
    };
  });
  const adjustment = changes.length ? {id:`adjustment-${now.getTime()}`, at:now.toISOString(), direction:decision.direction, completionRate:decision.completionRate, label:decision.label, changes, status:automation.autoCalibrate ? '已自动导入' : '待教师确认'} : null;
  return {plans:automation.autoCalibrate ? nextPlans : plans, automation:nextAutomation, adjustment, checked:true};
};

const groupTasksBySubject = taskList => {
  const order = ['政治', '英语', '数学', '专业课'];
  const map = taskList.reduce((groups, task) => {
    const key = task.subject || '未分类';
    if (!groups[key]) groups[key] = [];
    groups[key].push(task);
    return groups;
  }, {});
  return Object.keys(map)
    .sort((left, right) => {
      const leftIndex = order.indexOf(left);
      const rightIndex = order.indexOf(right);
      if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right, 'zh-CN');
      if (leftIndex === -1) return 1;
      if (rightIndex === -1) return -1;
      return leftIndex - rightIndex;
    })
    .map(subject => ({subject, tasks: map[subject]}));
};

function TaskActualProgressDialog({task, onConfirm, onClose}) {
  const target = getTaskMeasurableTarget(task?.text);
  const [actual, setActual] = useState(target?.planned || 0);
  if (!task || !target) return null;
  const remaining = Math.max(0, target.planned - Math.max(0, Number(actual) || 0));
  const unit = target.kind === 'range' ? '节' : (target.quantity?.unit || '项');
  return <div className="modal-backdrop" onMouseDown={onClose}><section className="modal task-progress-modal" onMouseDown={event => event.stopPropagation()}><button className="modal-close" onClick={onClose} aria-label="关闭"><X size={19}/></button><span className="eyebrow">完成反馈 · 任务助手将据此调整</span><h2>今天实际完成了多少？</h2><p>{task.text}</p><label>实际完成<input type="number" min="0" value={actual} onChange={event => setActual(event.target.value)} autoFocus/><span> / 原定 {target.planned} {unit}</span></label>{remaining ? <div className="task-progress-carry-note"><b>剩余 {remaining} {unit} 将自动并入下一学习日</b><span>{target.kind === 'range' ? '后续视频区间会整体顺延，不会跳过未看的内容。' : '未完成部分会计入下一天任务，下一天总数量保持不变。'}</span></div> : <div className="task-progress-carry-note is-complete"><b>已完成原定任务</b><span>下一学习日将按原计划继续。</span></div>}<div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>暂不提交</button><button type="button" className="primary" onClick={() => onConfirm(Math.max(0, Number(actual) || 0))}>保存完成情况</button></div></section></div>;
}

function StudentRestDayPicker({student, setStudents, notify, compact = false}) {
  const [pending, setPending] = useState(false);
  const restWeekday = getStudentRestWeekday(student);
  const restToday = isRestDayToday(student);
  const restPending = isRestDayPendingToday(student);
  if (!student) return null;

  const setRestDay = async value => {
    const next = normalizeRestWeekday(value);
    setPending(true);
    try {
      let canonical = { restWeekday: next, restWeekdaySetAt: next === null ? null : new Date().toISOString() };
      if (isApiConfigured()) {
        const result = await apiRequest(`/api/students/${encodeURIComponent(student.id)}/preferences`, {
          method: 'PATCH',
          body: { restWeekday: next }
        });
        canonical = {
          restWeekday: result.restWeekday ?? null,
          restWeekdaySetAt: result.restWeekdaySetAt || null
        };
      }
      setStudents(current => current.map(item => item.id === student.id ? { ...item, ...canonical } : item));
      if (canonical.restWeekday === null) {
        notify('已取消休息日，今天起按正常节奏推送任务');
      } else {
        const label = getRestWeekdayLabel(canonical.restWeekday);
        const isToday = new Date().getDay() === canonical.restWeekday;
        notify(isToday
          ? `已将休息日设为${label}。须提前一天设置才生效，今天仍正常推送任务；从下个${label}起休息。`
          : `已将每周休息日设为${label}。到那天会暂停推送（须提前一天设置才生效）。`);
      }
    } catch (error) {
      notify(error?.message || '休息日设置保存失败，请重试');
    } finally {
      setPending(false);
    }
  };

  let copy = '选一天作为每周休息日。须提前一天设置才生效；取消后立即恢复正常推送。';
  if (restWeekday !== null) {
    if (restToday) {
      copy = `今天是你的休息日（${getRestWeekdayLabel(restWeekday)}），学习规划已暂停。`;
    } else if (restPending) {
      copy = `已选每周${getRestWeekdayLabel(restWeekday)}，但今天才改选，须提前一天才生效——今天仍正常推送任务。`;
    } else {
      copy = `当前休息日：每周${getRestWeekdayLabel(restWeekday)}。可随时改选或取消。`;
    }
  }

  let statusLabel = '未设置';
  let statusClass = '';
  if (restWeekday !== null) {
    if (restToday) {
      statusLabel = '今天休息';
      statusClass = 'is-today';
    } else if (restPending) {
      statusLabel = '今日未生效';
      statusClass = 'is-pending';
    } else {
      statusLabel = getRestWeekdayLabel(restWeekday);
      statusClass = 'is-set';
    }
  }

  return (
    <section className={`student-rest-picker ${compact ? 'is-compact' : ''} ${restToday ? 'is-rest-today' : ''}`}>
      <div className="student-rest-picker-head">
        <div>
          <span className="eyebrow">每周休息日 · 须提前一天设置</span>
          <h3>选择你的休息日</h3>
          <p>{copy}</p>
        </div>
        <span className={`student-rest-status ${statusClass}`}>
          {statusLabel}
        </span>
      </div>
      <div className="student-rest-day-grid" role="group" aria-label="选择每周休息日">
        {REST_WEEKDAY_OPTIONS.map(option => {
          const active = restWeekday === option.value;
          return (
            <button
              type="button"
              key={option.value}
              className={`student-rest-day-chip ${active ? 'is-active' : ''}`}
              onClick={() => setRestDay(active ? null : option.value)}
              aria-pressed={active}
              disabled={pending}
            >
              <b>{option.short}</b>
              <span>{option.label}</span>
            </button>
          );
        })}
      </div>
      {restWeekday !== null && (
        <button type="button" className="quiet-button student-rest-clear" onClick={() => setRestDay(null)} disabled={pending}>
          {pending ? '正在保存…' : '取消休息日'}
        </button>
      )}
    </section>
  );
}

function StudentRestDayView({student, selector, setStudents, notify}) {
  const studentName = student?.name?.trim() || '同学';
  const greetingName = studentName.endsWith('同学') ? studentName : `${studentName}同学`;
  return (
    <>
      <section className="student-rest-day-hero">
        <div className="student-rest-day-moon" aria-hidden="true">
          <Moon size={36}/>
        </div>
        <div className="student-rest-day-copy">
          <span className="eyebrow">今日休息 · {getRestWeekdayLabel(student?.restWeekday)}</span>
          <h1>{greetingName}</h1>
          <p className="student-rest-day-message">{REST_DAY_MESSAGE}</p>
          <p className="student-rest-day-hint">今天不推送学习规划与日/周/月自测。明天再继续。</p>
          {selector}
        </div>
      </section>
      <StudentRestDayPicker student={student} setStudents={setStudents} notify={notify} compact/>
    </>
  );
}

function StudentProfile({student, setStudents, notify}) {
  const [draft, setDraft] = useState(() => ({
    name:student?.name || '', year:student?.year || '', wechatId:student?.wechatId || '', phone:student?.phone || '', shippingRecipient:student?.shippingRecipient || '', shippingPhone:student?.shippingPhone || '',
    shippingInfo:student?.shippingInfo || '', school:student?.school || '', targetScore:student?.targetScore || '',
    subjects:(student?.subjects || []).map(item => ({...item, targetScore:item.targetScore || ''}))
  }));
  useEffect(() => setDraft({
    name:student?.name || '', year:student?.year || '', wechatId:student?.wechatId || '', phone:student?.phone || '', shippingRecipient:student?.shippingRecipient || '', shippingPhone:student?.shippingPhone || '',
    shippingInfo:student?.shippingInfo || '', school:student?.school || '', targetScore:student?.targetScore || '',
    subjects:(student?.subjects || []).map(item => ({...item, targetScore:item.targetScore || ''}))
  }), [student?.id, student?.updatedAt]);
  const save = async () => {
    if (!draft.name.trim()) return notify('请填写昵称');
    const next = {...student, ...draft, name:draft.name.trim(), year:draft.year.trim() || '考研年份待填写', wechatId:draft.wechatId.trim(), shippingRecipient:draft.shippingRecipient.trim(), shippingPhone:draft.shippingPhone.trim(), shippingInfo:draft.shippingInfo.trim(), school:draft.school.trim(), targetScore:draft.targetScore.trim()};
    if (isApiConfigured() && student?.id && !student.isTestAccount) {
      try {
        const saved = await apiRequest(`/api/students/${encodeURIComponent(student.id)}`, {method:'PATCH', body:{name:next.name, year:next.year, wechatId:next.wechatId || null, shippingRecipient:next.shippingRecipient || null, shippingPhone:next.shippingPhone || null, shippingInfo:next.shippingInfo || null, school:next.school || null, targetScore:next.targetScore || null}});
        const preferences = await apiRequest(`/api/students/${encodeURIComponent(student.id)}/preferences`, {method:'PATCH', body:{subjects:next.subjects.map(item => ({subject:item.name, targetScore:item.targetScore || null}))}});
        const synced = {...next, ...saved, subjects:preferences.subjects || next.subjects, wechatId:saved.wechatId ?? next.wechatId};
        setStudents(current => current.map(item => String(item.id) === String(student.id) ? synced : item));
        notify('我的资料已同步给老师');
      } catch (error) { notify(error?.message || '资料同步失败，请稍后重试'); }
      return;
    }
    setStudents(current => current.map(item => String(item.id) === String(student.id) ? next : item));
    notify('我的资料已保存，老师端已同步更新');
  };
  const subjectNames = Array.from(new Set([...SUBJECT_OPTIONS, ...draft.subjects.map(item => item.name)])).filter(Boolean);
  const timelines = (draft.subjects || []).map(item => {
    const subjectPlans = (student?.assignedPlans || []).filter(plan => normalizeStudentSubject(plan.subject) === normalizeStudentSubject(item.name));
    const total = subjectPlans.reduce((sum, plan) => sum + (plan.rows || []).length, 0);
    const done = subjectPlans.reduce((sum, plan) => sum + (plan.rows || []).filter(isRowComplete).length, 0);
    const percent = total ? Math.round(done / total * 100) : 0;
    const dates = subjectPlans.map(plan => getPlanStartDate(plan) || String(plan.assignedAt || plan.createdAt || '').slice(0, 10)).filter(Boolean).sort();
    return {name:item.name, total, done, percent, start:dates[0] || '', end:percent === 100 && dates.length ? dates[dates.length - 1] : ''};
  });
  const reviewTimelines = (draft.subjects || []).map(item => {
    const plans = (student?.assignedPlans || []).filter(plan => normalizeStudentSubject(plan.subject) === normalizeStudentSubject(item.name));
    const rows = plans.flatMap(plan => (plan.rows || []).map((row, index) => ({...row, planName:plan.name, index})));
    return { subject:item.name, weeks:Array.from({length:Math.ceil(rows.length / 7)}, (_, weekIndex) => {
      const records = rows.slice(weekIndex * 7, weekIndex * 7 + 7); const complete = records.filter(isRowComplete).length;
      return { week:weekIndex + 1, records, complete, total:records.length, percent:records.length ? Math.round(complete / records.length * 100) : 0 };
    })};
  });
  return <section className="student-profile-page"><div className="page-head"><div><span className="eyebrow">个人中心</span><h1>我的</h1><p>资料保存后会立即同步到老师端，用于课程服务、纸质资料寄送与学习跟进。</p></div></div><div className="student-profile-grid"><section className="panel student-profile-card"><PanelHead title="个人信息"/><label>昵称<input value={draft.name} onChange={event=>setDraft(current=>({...current,name:event.target.value}))} placeholder="填写昵称"/></label><label>常用微信<input value={draft.wechatId} onChange={event=>setDraft(current=>({...current,wechatId:event.target.value}))} placeholder="填写常用微信"/><small>后续老师会通过这个微信联系您</small></label></section><section className="panel student-profile-card"><PanelHead title="收货信息"/><label>收货昵称<input value={draft.shippingRecipient} onChange={event=>setDraft(current=>({...current,shippingRecipient:event.target.value}))} placeholder="填写收件人昵称"/></label><label>收货联系电话<input value={draft.shippingPhone} onChange={event=>setDraft(current=>({...current,shippingPhone:event.target.value}))} placeholder="填写收件人联系电话"/></label><label>收货地址<textarea value={draft.shippingInfo} onChange={event=>setDraft(current=>({...current,shippingInfo:event.target.value}))} placeholder="填写详细收货地址、邮编等信息"/></label></section><section className="panel student-profile-card student-profile-wide"><PanelHead title="考试信息"/><div className="profile-subject-picker"><span>报考意向科目</span><small>用于老师与销售后续对接；勾选不会自动开通进阶学习工具。</small><div>{subjectNames.map(name => { const current=draft.subjects.find(item=>item.name===name); return <label key={name}><input type="checkbox" checked={!!current} onChange={()=>setDraft(value=>({...value,subjects:current ? value.subjects.filter(item=>item.name!==name) : [...value.subjects,{name,enrolled:false,targetScore:''}]}))}/>{name}</label>; })}</div></div><div className="student-profile-fields"><label>考试年份<select value={draft.year} onChange={event=>setDraft(current=>({...current,year:event.target.value}))}><option value="">请选择考试年份</option>{[2026,2027,2028,2029,2030,2031].map(year => <option value={`${year} 考研`} key={year}>{`${year} 年考研`}</option>)}</select></label><label>考试学校<input value={draft.school} onChange={event=>setDraft(current=>({...current,school:event.target.value}))} placeholder="填写报考学校"/></label><label>目标分数<input value={draft.targetScore} onChange={event=>setDraft(current=>({...current,targetScore:event.target.value}))} placeholder="例如：380"/></label></div></section></div><div className="form-footer student-profile-save"><button type="button" className="primary" onClick={save}>保存并同步</button></div><section className="panel review-record-panel"><div className="panel-head"><div><span className="eyebrow">按科目、按周查看</span><h2>复习记录</h2></div><span>点击科目查看每周任务进展</span></div><div className="review-subject-list">{reviewTimelines.length ? reviewTimelines.map(timeline => <details className="review-subject-record" key={timeline.subject} open><summary><span className={`student-subject-tag subject-${normalizeStudentSubject(timeline.subject)}`}>{timeline.subject}</span><div><b>{timeline.subject}复习记录</b><small>共 {timeline.weeks.length} 个学习周</small></div><ChevronRight size={17}/></summary><div className="review-week-timeline">{timeline.weeks.length ? timeline.weeks.map(week => <article className="review-week-item" key={week.week}><i/><div><div className="review-record-title"><b>第 {week.week} 周</b><span>{week.percent}% 完成</span></div><p>本周已完成 {week.complete}/{week.total} 天内容，还剩 {Math.max(0, week.total - week.complete)} 天。</p><div className="progress-track"><i style={{width:`${week.percent}%`}}/></div><div className="review-week-tasks">{week.records.map((record, index) => <span className={isRowComplete(record) ? 'is-done' : ''} key={`${record.planName}-${record.index}-${index}`}>{isRowComplete(record) ? '✓' : '○'} {record.planName} · {record.title || record.day || `第 ${week.week * 7 - 6 + index} 天`}</span>)}</div></div></article>) : <p className="review-record-empty">老师分配学习计划后，这里会按周记录学习内容与进展。</p>}</div></details>) : <div className="empty-line"><ClipboardCheck size={20}/><span>请先在考试信息中勾选科目，老师分配学习计划后会在这里形成复习记录。</span></div>}</div></section></section>;
}

function StudentHome({student, plans, setStudents, notify, selector, aiSettings, onOpenAssessment, onOpenFutureSevenDays, entranceState, onOpenArchive, onOpenProfile}) {
  const restToday = isRestDayToday(student);
  const todayItems = buildTodayTaskItems(plans);
  const pendingTasks = todayItems.filter(task => !task.completed);
  const completedTasks = todayItems.filter(task => task.completed);
  const totalMinutes = todayItems.reduce((sum, task) => sum + (task.minutes || 0), 0);
  const pendingGroups = groupTasksBySubject(pendingTasks);
  const completedGroups = groupTasksBySubject(completedTasks);
  const defaultOpen = pendingGroups[0]?.subject || completedGroups[0]?.subject || null;
  const [openSubjects, setOpenSubjects] = useState(() => defaultOpen ? {[defaultOpen]: true} : {});
  const [taskProgressTarget, setTaskProgressTarget] = useState(null);
  const studentName = student?.name?.trim() || '同学';
  const greetingName = studentName.endsWith('同学') ? studentName : `${studentName}同学`;
  const assessmentModules = getStudentAssessmentModules(student, aiSettings);
  const pendingEntranceAssessments = getPendingEntranceAssessments(student, entranceState);
  // In API mode a configured push is a pending assignment even while the
  // executor is unavailable; the student must see its pending/unavailable
  // state rather than a fabricated local score.
  const pendingPeriodicAssessments = assessmentModules.filter(item => item.isToday && item.enabled && (item.actionable || isApiConfigured()));
  const pendingAssessmentCount = pendingEntranceAssessments.length + pendingPeriodicAssessments.length;
  const push = getAssessmentPush(student);
  const restLabel = getRestWeekdayLabel(student?.restWeekday);
  const enrolledTargetScores = (student?.subjects || []).filter(item => item.enrolled && String(item.targetScore || '').trim()).map(item => ({name:item.name, score:item.targetScore}));
  const summaryRecords = getStudentSummaryRecords(student);
  const [summaryType, setSummaryType] = useState('daily');
  const selectedSummary = summaryRecords.find(item => item.type === summaryType) || null;
  const nextSummaryType = getSummaryScheduleType();
  const summaryTypeLabel = SUMMARY_LABELS[summaryType];
  const [clockNow, setClockNow] = useState(() => new Date());
  const examYear = getRegisteredExamYear(student);
  const showExamCountdown = hasRegisteredExamInfo(student) && Boolean(examYear);
  const freeTrialDone = ['active', 'completed'].includes(getFreeTrial(student).status);
  const countdownTarget = showExamCountdown ? getExamCountdownTarget(examYear, clockNow) : null;
  const countdownMs = countdownTarget ? Math.max(0, countdownTarget.getTime() - clockNow.getTime()) : 0;
  const countdown = {
    days: Math.floor(countdownMs / (24 * 60 * 60 * 1000)),
    hours: Math.floor((countdownMs / (60 * 60 * 1000)) % 24),
    minutes: Math.floor((countdownMs / (60 * 1000)) % 60),
    seconds: Math.floor((countdownMs / 1000) % 60)
  };

  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!defaultOpen) return;
    setOpenSubjects(current => current[defaultOpen] ? current : {...current, [defaultOpen]: true});
  }, [defaultOpen, student?.id]);

  const toggleSubject = subject => {
    setOpenSubjects(current => ({...current, [subject]: !current[subject]}));
  };

  const toggleTaskItem = async (task, actualProgress = null) => {
    if (!task.completed && actualProgress === null && getTaskMeasurableTarget(task.text)) {
      setTaskProgressTarget(task);
      return;
    }
    if (isRestDayToday(student)) {
      notify(REST_DAY_MESSAGE);
      return;
    }
    const nextCompleted = !task.completed;
    if (isApiConfigured() && student?.id && task.planId) {
      if (!Number.isInteger(Number(task.rowIndex)) || Number(task.rowIndex) < 0 || !Number.isInteger(Number(task.taskIndex)) || Number(task.taskIndex) < 0) {
        notify('该任务缺少有效的服务端索引，未修改完成状态；请刷新计划后重试');
        return;
      }
      try {
        const endpoint = `/api/plans/${encodeURIComponent(task.planId)}/tasks/${Number(task.rowIndex)}/${Number(task.taskIndex)}/complete`;
        await apiRequest(endpoint, { method: nextCompleted ? 'POST' : 'DELETE' });
      } catch (error) {
        notify(error?.message || '同步任务状态失败，请稍后重试');
        return;
      }
    }
    const nextPlans = (plans || []).map(plan => {
      if (plan.id !== task.planId) return plan;
      if (actualProgress !== null && !task.completed) return applyTaskActualProgress(plan, task.rowIndex, task.taskIndex, actualProgress);
      return {
        ...plan,
        rows: (plan.rows || []).map((row, index) =>
          index === task.rowIndex ? toggleRowTaskItem(row, task.taskIndex) : row
        )
      };
    });
    const existingCheckins = student.taskCheckins || [];
    const lastCheckin = existingCheckins[existingCheckins.length - 1];
    const repeatedCompletion = nextCompleted && lastCheckin?.completed && lastCheckin.planId === task.planId && lastCheckin.rowIndex === task.rowIndex && lastCheckin.taskIndex === task.taskIndex;
    const nextCheckins = nextCompleted && !repeatedCompletion
      ? [...existingCheckins, {id:`checkin-${Date.now()}`, planId:task.planId, rowIndex:task.rowIndex, taskIndex:task.taskIndex, text:task.text, completed:true, actual: actualProgress ?? null, planned: getTaskMeasurableTarget(task.text)?.planned || null, at:new Date().toISOString()}].slice(-60)
      : existingCheckins;
    const automation = getPlanAdjustmentAutomation(student);
    const scheduled = nextCompleted ? runScheduledPlanAdjustment({plans:nextPlans, checkins:nextCheckins, automation, rules:getPlanAssistantAdjustmentRules(aiSettings)}) : {plans:nextPlans, automation, adjustment:null};
    const adjustment = scheduled.adjustment;
    setStudents(current => current.map(item => item.id === student.id ? {...item, assignedPlans: scheduled.plans, taskCheckins: nextCheckins, planAdjustmentAutomation: scheduled.automation, taskAdjustmentDraft: adjustment?.status === '待教师确认' ? adjustment : item.taskAdjustmentDraft || null, taskAdjustmentHistory: adjustment?.status === '已自动导入' ? [...(item.taskAdjustmentHistory || []), adjustment].slice(-20) : (item.taskAdjustmentHistory || [])} : item));
    notify(adjustment ? (adjustment.status === '已自动导入' ? `完成反馈已触发自动校准，已更新 ${adjustment.changes.length} 项后续任务` : `完成反馈已生成 ${adjustment.changes.length} 项任务调整建议，等待教师确认`) : (nextCompleted ? '已完成打卡，教师端已同步' : '已恢复为待完成'));
  };

  const openAssessment = module => {
    if (isRestDayToday(student)) {
      notify(REST_DAY_MESSAGE);
      return;
    }
    if (!module.enabled || !push.enabled) {
      notify('该测试暂未开放，请联系老师');
      return;
    }
    if (!module.isToday) {
      notify('该测试暂未到开放时间');
      return;
    }
    if (!isApiConfigured() && !isAiSlotReady(aiSettings, 'periodic_assessment')) {
      notify('该测试正在准备中，请稍后再试或联系老师');
      return;
    }
    onOpenAssessment?.(module);
  };

  const renderSubjectGroups = (groups, emptyText) => {
    if (!groups.length) {
      return <div className="empty-line student-home-empty"><ClipboardCheck size={20}/><span>{emptyText}</span></div>;
    }
    return <div className="student-subject-stack">
      {groups.map(group => {
        const isOpen = !!openSubjects[group.subject];
        const groupMinutes = group.tasks.reduce((sum, task) => sum + (task.minutes || 0), 0);
        return <section className={`student-subject-block ${isOpen ? 'is-open' : ''}`} key={group.subject}>
          <button type="button" className="student-subject-toggle" onClick={() => toggleSubject(group.subject)} aria-expanded={isOpen}>
            <div className="student-subject-toggle-main">
              <span className={`student-subject-tag subject-${group.subject}`}>{group.subject}</span>
              <b>{group.subject}</b>
              <small>{group.tasks.length} 项 · 约 {formatTaskMinutes(groupMinutes)}</small>
            </div>
            <ChevronRight size={18} className={`student-subject-chevron ${isOpen ? 'is-open' : ''}`}/>
          </button>
          {isOpen && <div className="student-subject-tasks">
            {group.tasks.map(task => (
              <article className={`student-home-task ${task.completed ? 'is-complete' : ''}`} key={`${task.planId}-${task.rowIndex}-${task.taskIndex}-${task.text}`}>
                <button type="button" className="student-task-check" onClick={() => toggleTaskItem(task)} aria-label={task.completed ? '标记为待完成' : '标记为已完成'}>
                  {task.completed ? <Check size={15}/> : null}
                </button>
                <div className="student-home-task-body">
                  <div className="student-home-task-title-row">
                    <h3>{task.text}</h3>
                    {task.carry?.kind === 'quantity' ? <p className="task-carry-summary">含昨日未完成 {task.carry.remaining} 个 · 今日新增 {task.carry.newPortion} 个</p> : null}
                    {task.attachments?.length ? <div className="student-task-attachments">{task.attachments.map(attachment => <button type="button" key={attachment.id || attachment.fileName} onClick={() => openPersistentAsset(attachment, notify)}><FileText size={13}/>附件下载 · {attachment.fileName}</button>)}</div> : null}
                    <span className="student-home-task-time">约 {formatTaskMinutes(task.minutes)}</span>
                  </div>
                  <p className="student-home-task-source">{task.planName} · 阶段任务</p>
                </div>
                <span className={`student-task-status ${task.completed ? 'done' : 'todo'}`}>{task.completed ? '已完成' : '待完成'}</span>
              </article>
            ))}
          </div>}
        </section>;
      })}
    </div>;
  };

  if (restToday) {
    return <StudentRestDayView student={student} selector={selector} setStudents={setStudents} notify={notify}/>;
  }

  return <>
    <section className="student-home-hero">
      <div className="student-home-hero-copy">
        <span className="eyebrow">学习首页 · 今日任务</span>
        <h1>{greetingName}，今天的任务如下</h1>
        <p>
          每个阶段任务可单独勾选。已开始的日测试、周测试和月测试可随时进入作答。
          {restLabel !== '未设置'
            ? ` 已选每周${restLabel}为休息日（须提前一天设置才生效；取消后立即恢复推送）。`
            : ' 可在下方自选每周休息日（须提前一天设置才生效）。'}
          未完成任务次日继续推送；整行完成后再推进新任务。
        </p>
        {showExamCountdown ? (
          <div className="exam-countdown" aria-label="考研倒计时">
            <span className="exam-countdown-label">{countdownTarget.getFullYear() + 1} 年考研初试（暂定 {countdownTarget.getFullYear()} 年 12 月 20 日）</span>
            <div className="exam-countdown-time">
              <b>{countdown.days}</b><small>天</small>
              <b>{String(countdown.hours).padStart(2, '0')}</b><small>时</small>
              <b>{String(countdown.minutes).padStart(2, '0')}</b><small>分</small>
              <b className="exam-countdown-seconds">{String(countdown.seconds).padStart(2, '0')}</b><small>秒</small>
            </div>
            <p className="exam-countdown-note">每年 9 月份更新。普遍在 12 月 20 号左右，因此暂定 12 月 20 号。</p>
          </div>
        ) : (
          <div className="exam-countdown exam-countdown-guide" aria-label="新手指引">
            <span className="exam-countdown-label">登记考试年份与报考科目后，这里会显示你的初试倒计时</span>
            <ol className="exam-countdown-steps">
              <li className={freeTrialDone ? 'is-done' : ''}>{freeTrialDone ? <Check size={13}/> : <b>1</b>}开启 7 天免费体验{freeTrialDone ? '（已完成）' : ''}</li>
              <li><b>2</b>登记考试信息（只需登记考试年份和报考科目）</li>
            </ol>
            <button type="button" className="exam-countdown-guide-btn" onClick={onOpenProfile}>去「我的」登记考试信息<ChevronRight size={14}/></button>
          </div>
        )}
        {selector}
      </div>
      <div className="student-home-summary" aria-label="今日任务概览">
        <button type="button" className="student-home-summary-action" onClick={() => document.getElementById('today-pending')?.scrollIntoView({behavior:'smooth', block:'start'})}>
          <span>今天要做</span>
          <b>{pendingTasks.length}<em> 项</em></b>
          <small>查看待办 <ChevronRight size={14}/></small>
        </button>
        <button type="button" className="student-home-summary-action" onClick={() => document.getElementById('today-completed')?.scrollIntoView({behavior:'smooth', block:'start'})}>
          <span>今天已完成</span>
          <b>{completedTasks.length}<em> 项</em></b>
          <small>查看完成项 <ChevronRight size={14}/></small>
        </button>
        <div>
          <span>共计时间</span>
          <b>{formatTaskMinutes(totalMinutes)}</b>
        </div>
      </div>
    </section>

    <StudentRestDayPicker student={student} setStudents={setStudents} notify={notify}/>

    <StudentFreeTrial student={student} setStudents={setStudents} notify={notify}/>

    {pendingAssessmentCount > 0 && <section className="student-home-section assessment-todo-alert"><div className="assessment-todo-alert-icon"><FileQuestion size={23}/><b>{pendingAssessmentCount}</b></div><div><span className="eyebrow">待自测提醒</span><h2>你有 {pendingAssessmentCount} 份自测尚未完成</h2><p>{pendingEntranceAssessments.length ? `老师分发的入学摸底 ${pendingEntranceAssessments.length} 份` : ''}{pendingEntranceAssessments.length && pendingPeriodicAssessments.length ? '；' : ''}{pendingPeriodicAssessments.length ? `今天开放的日/周/月测 ${pendingPeriodicAssessments.length} 份` : ''}。完成后会自动归入“已自测”。</p></div><button type="button" className="primary" onClick={onOpenArchive}>查看待自测<ChevronRight size={16}/></button></section>}

    {enrolledTargetScores.length ? <section className="student-home-section student-target-score-section"><div className="student-home-section-head"><div><span className="eyebrow">我的目标</span><h2>已报名科目目标分</h2></div></div><div className="student-target-score-list">{enrolledTargetScores.map(item => <div key={item.name}><span>{item.name}</span><b>{item.score}<em> 分</em></b></div>)}</div></section> : null}

    <section className="student-home-section learning-summary-panel">
      <div className="student-home-section-head learning-summary-head">
        <div><span className="eyebrow">学习回顾</span><h2>温故而知新，可以为师矣</h2></div>
        <span>{summaryTypeLabel}</span>
      </div>
      <div className="learning-summary-tabs" role="tablist" aria-label="学习总结类型">
        {Object.entries(SUMMARY_LABELS).map(([type, label]) => <button type="button" role="tab" aria-selected={summaryType === type} className={summaryType === type ? 'active' : ''} key={type} onClick={() => setSummaryType(type)}>{label}</button>)}
      </div>
      {selectedSummary ? <div className="learning-summary-content">
        <div className="learning-summary-meta"><span>{SUMMARY_LABELS[selectedSummary.type]}</span><small>{new Date(selectedSummary.deliveredAt || selectedSummary.generatedAt).toLocaleString('zh-CN')}</small></div>
        <div className="learning-summary-grid">
          <article><b>复习任务及重点</b><p>{selectedSummary.content?.taskFocus || '本次任务与重点正在整理。'}</p></article>
          <article><b>易错点</b><p>{selectedSummary.content?.weakPoints || '继续保持错题归纳，后续会结合自测记录提示复习重点。'}</p></article>
          <article><b>考试方向</b><p>{selectedSummary.content?.examDirection || '按照当前复习节奏完成基础巩固与同类题训练。'}</p></article>
          <article><b>学习进度及展望</b><p>{selectedSummary.content?.progressForecast || '持续完成当日任务并参与自测后，将形成更清晰的进度展望。'}</p></article>
        </div>
      </div> : <div className="learning-summary-empty"><MessageSquareText size={22}/><div><b>暂未收到{summaryTypeLabel}</b><p>{nextSummaryType === summaryType ? `本次${summaryTypeLabel}将在规定时间生成后展示在这里。` : `该窗口会统一保存日总结、周总结和月总结；${nextSummaryType ? `下一次为${SUMMARY_LABELS[nextSummaryType]}。` : '请在下一次发送时间后查看。'}`}</p></div></div>}
    </section>

    <section className="student-home-board" id="today">
      <div className="student-home-section" id="today-pending">
        <div className="student-home-section-head">
          <div>
            <span className="eyebrow">Today · To Do</span>
            <h2>今天要做的任务</h2>
          </div>
          <span>{pendingTasks.length} 项</span>
        </div>
        {renderSubjectGroups(pendingGroups, '今天暂无待完成任务。')}
      </div>

      <div className="student-home-section" id="today-completed">
        <div className="student-home-section-head">
          <div>
            <span className="eyebrow">Today · Done</span>
            <h2>今天已完成的任务</h2>
          </div>
          <span>{completedTasks.length} 项</span>
        </div>
        {renderSubjectGroups(completedGroups, '今天还没有完成记录。')}
      </div>
    </section>

    <section className="student-home-section student-assessment-section">
      <div className="student-home-section-head">
        <div>
          <span className="eyebrow">一对一自测</span>
          <h2>日测试 · 周测试 · 月测试</h2>
        </div>
        <span>{push.enabled ? '按科目独立开通' : '未开通'}</span>
      </div>
      <p className="student-assessment-rule">
        已开放的测试会显示在这里，点击即可开始。
      </p>
      <div className="student-assessment-grid">
        {assessmentModules.filter(item => item.isToday).map(item => (
          <button type="button" className={`student-assessment-card assessment-subject-card tone-${item.tone} ${item.enabled ? 'is-today' : 'is-locked'}`} key={item.id} onClick={() => openAssessment(item)}>
            <span className="eyebrow">{item.title}</span>
            <h3>{item.subject}{item.short}</h3>
            <p>{item.enabled && item.actionable ? '现在可开始作答' : item.enabled && isApiConfigured() ? '待服务端出题器处理' : '暂未开放'}</p>
            <span className="assessment-subject-action">{item.enabled && item.actionable ? '开始测试' : '查看状态'} <ChevronRight size={16}/></span>
          </button>
        ))}
        {!assessmentModules.some(item => item.isToday) && <div className="empty-line"><FileQuestion size={21}/><span>今天暂未安排测试。</span></div>}
      </div>
    </section>

    <TaskActualProgressDialog task={taskProgressTarget} onClose={() => setTaskProgressTarget(null)} onConfirm={actual => { const task = taskProgressTarget; setTaskProgressTarget(null); toggleTaskItem(task, actual); }}/>

    <section className="student-future-gate student-home-future-gate">
      <div>
        <span className="eyebrow">后续安排</span>
        <h2>查看未来 7 天的任务</h2>
        <p>进入学习计划后可查看按完成进度顺延的后续 7 个学习日安排；首页只保留今天的当前任务。</p>
      </div>
      <button type="button" className="primary" onClick={onOpenFutureSevenDays}>
        进入查看 <ChevronRight size={16}/>
      </button>
    </section>
  </>;
}

function TeacherPage({ page, students, setStudents, selectedStudent, setSelectedStudent, reviewPlans, setReviewPlans, contentItems, setContentItems, applicationData, setApplicationData, posts, setPosts, aiSettings, setAiSettings, entranceState, setEntranceState, open, notify, setPage, accounts, setAccounts, currentAccount, knowledgeBase, setKnowledgeBase, registrationApplications, setRegistrationApplications }) {
  if (page === 'knowledge') return <KnowledgeBase knowledgeBase={knowledgeBase} setKnowledgeBase={setKnowledgeBase} notify={notify}/>;
  if (page === 'robots') return <SupervisionRobots aiSettings={aiSettings} setAiSettings={setAiSettings} notify={notify}/>;
  if (page === 'students') return <Students students={students} setStudents={setStudents} selectedStudent={selectedStudent} setSelectedStudent={setSelectedStudent} reviewPlans={reviewPlans} aiSettings={aiSettings} entranceState={entranceState} accounts={accounts} setAccounts={setAccounts} open={open} notify={notify} currentAccount={currentAccount}/>;
  if (page === 'content') return <Content items={contentItems} setItems={setContentItems} students={students} setStudents={setStudents} open={open} notify={notify}/>;
  if (page === 'books') return <BookDistributionManagement students={students} notify={notify}/>;
  if (page === 'plans') return <Plans teacher reviewPlans={reviewPlans} setReviewPlans={setReviewPlans} open={open} notify={notify}/>;
  if (page === 'apps') return <ApplicationManagement data={applicationData} setData={setApplicationData} notify={notify}/>;
  if (page === 'companion') return <CompanionStudyManagement notify={notify}/>;
  if (page === 'questionBank') return <QuestionBank aiSettings={aiSettings} students={students} setStudents={setStudents} entranceState={entranceState} setEntranceState={setEntranceState} notify={notify}/>;
  if (page === 'moderation') return <Moderation posts={posts} setPosts={setPosts} notify={notify}/>;
  if (page === 'settings') return <Settings notify={notify} accounts={accounts} setAccounts={setAccounts} students={students} setStudents={setStudents} currentAccount={currentAccount} aiSettings={aiSettings} setAiSettings={setAiSettings}/>;
  return <TeacherDashboard students={students} setStudents={setStudents} entranceState={entranceState} setEntranceState={setEntranceState} posts={posts} setPosts={setPosts} contentItems={contentItems} setContentItems={setContentItems} setPage={setPage} notify={notify} registrationApplications={registrationApplications} setRegistrationApplications={setRegistrationApplications}/>;
}

const Metric = ({label, value, suffix, icon: Icon, color}) => <div className={`metric ${color}`}><div className="metric-icon"><Icon size={19}/></div><div><span>{label}</span><strong>{value}<em>{suffix}</em></strong></div></div>;

const getPlanTaskMetrics = plans => (plans || []).reduce((totals, plan) => {
  const planned = (plan.rows || []).reduce((sum, row) => sum + (Array.isArray(row.tasks) ? row.tasks.filter(Boolean).length : 0), 0);
  const completed = Number.isFinite(Number(plan.completedTasks))
    ? Number(plan.completedTasks)
    : (plan.rows || []).reduce((sum, row) => sum + (Array.isArray(row.tasks) ? row.tasks.filter((_, index) => isTaskItemDone(row, index)).length : (isRowComplete(row) ? 1 : 0)), 0);
  const actual = Number.isFinite(Number(plan.actualTasks)) ? Number(plan.actualTasks) : completed;
  return { planned: totals.planned + planned, completed: totals.completed + completed, actual: totals.actual + actual };
}, { planned: 0, completed: 0, actual: 0 });

function TeacherDashboard({ students, setStudents, entranceState, setEntranceState, posts, setPosts, contentItems, setContentItems, setPage, notify, registrationApplications, setRegistrationApplications }) {
  const [showRegistrations, setShowRegistrations] = useState(false);
  const [registrationTypes, setRegistrationTypes] = useState({});
  const submissions = entranceState.submissions || [];
  const localPendingRegistrations = (registrationApplications || []).filter(item => item.status === '待导入');
  const [serverRegistrations, setServerRegistrations] = useState([]);
  const loadServerRegistrations = async () => {
    if (!isApiConfigured()) return;
    try { setServerRegistrations(await apiRequest('/api/registrations')); } catch (error) { notify(`服务器登记队列读取失败：${error.message}`); }
  };
  useEffect(() => { loadServerRegistrations(); }, []);
  const pendingRegistrations = [...serverRegistrations.filter(item => item.status === '待导入'), ...localPendingRegistrations.filter(local => !serverRegistrations.some(remote => remote.id === local.id))];
  const refreshRegistrations = () => {
    if (isApiConfigured()) {
      loadServerRegistrations();
      return;
    }
    try {
      const saved = window.localStorage.getItem(REGISTRATION_APPLICATIONS_STORAGE_KEY)
        || LEGACY_REGISTRATION_APPLICATIONS_STORAGE_KEYS.map(key => window.localStorage.getItem(key)).find(Boolean)
        || '[]';
      setRegistrationApplications(JSON.parse(saved));
      notify('已刷新登记审核队列');
    } catch (error) { notify('登记队列读取失败，请刷新页面后重试'); }
  };
  const copyRegistrationUrl = () => {
    const url = buildRegistrationUrl();
    if (!navigator.clipboard?.writeText) return notify(`登记链接：${url}`);
    navigator.clipboard.writeText(url).then(() => notify('登记链接已复制')).catch(() => notify(`登记链接：${url}`));
  };
  const importRegistration = application => {
    const studentType = registrationTypes[application.id] || '新人';
    if (isApiConfigured() && /^[0-9a-f-]{36}$/i.test(String(application.id))) {
      apiRequest(`/api/registrations/${application.id}/import`, { method:'POST', body:{studentType} })
        .then(() => { loadServerRegistrations(); notify(`已导入 ${application.name} 为${studentType}学员`); })
        .catch(error => notify(`服务器导入失败：${error.message}`));
      return;
    }
    const studentId = `student-${Date.now()}-${application.id}`;
    const now = new Date();
    const student = {
      id:studentId,
      intakeToken:createIntakeToken(),
      name:application.name,
      year:application.year,
      status:studentType,
      subjects:(application.subjects || []).map(name => ({name, enrolled:true})),
      progress:0,
      stage:application.stage || '未开始',
      phone:application.phone,
      shippingInfo:application.shippingInfo || '待补充',
      school:application.school || '待填写',
      targetScore:'待老师填写',
      evaluation:application.evaluation || '待补充',
      email:application.email || '',
      importedFromRegistrationAt:now.toISOString()
    };
    const papers = ENTRANCE_PAPERS.filter(paper => (application.subjects || []).some(subject => normalizeStudentSubject(subject) === paper.subject));
    setStudents(current => [applyPaidAssessmentDefaults(student), ...current]);
    setEntranceState(current => ({
      ...current,
      distributions: papers.reduce((result, paper) => ({
        ...result,
        [paper.id]: {
          ...(result[paper.id] || {}),
          [studentId]: createExamDistribution(paper, student, now)
        }
      }), current.distributions || {})
    }));
    setRegistrationApplications(current => current.map(item => item.id === application.id ? {
      ...item,
      status:'已导入',
      importedAt:now.toISOString(),
      importedStudentId:studentId,
      studentType
    } : item));
    notify(`已导入 ${student.name} 为${studentType}学员，并分发 ${papers.length} 份入学摸底试卷；开始答题后计时 1 小时`);
  };
  const pendingPurchaseOrders = (contentItems || []).filter(item => item.type === '购买订单' && item.state === '待确认');
  const pendingContentReviews = (posts || []).filter(item => item.state === '待审核');
  const approveAllContentReviews = async () => {
    if (!pendingContentReviews.length) return notify('当前没有待审核社区内容');
    if (!window.confirm(`确定通过 ${pendingContentReviews.length} 条社区内容吗？`)) return;
    const targets = pendingContentReviews.filter(item => !(isApiConfigured() && item.isServerManaged) || item.id);
    try {
      for (const item of targets) {
        if (isApiConfigured() && item.isServerManaged) {
          await apiRequest(`/api/admin/posts/${item.id}/review`, { method: 'POST', body: { state: '已公开', reviewNote: '批量审核通过' } });
        }
      }
      setPosts(current => current.map(item => targets.some(target => String(target.id) === String(item.id)) ? { ...item, state: '已公开', reviewedAt: new Date().toISOString() } : item));
      notify(`已一键通过 ${targets.length} 条社区内容`);
    } catch (error) {
      notify(error?.message || '批量审核失败，未完成的内容请重新审核');
    }
  };
  const approvePurchaseOrder = async order => {
    const product = (contentItems || []).find(item => (item.type === '商品' || item.type === '录播课程') && String(item.id) === String(order.productId));
    if (!product) return notify('对应课程或商品已被删除，无法开通权限');
    if (isApiConfigured() && order.isServerManaged) {
      try {
        await apiRequest(`/api/admin/orders/${order.id}/review`, { method: 'POST', body: { status: '已支付', reviewNote: '老师已核验收款' } });
      } catch (error) {
        return notify(error?.message || '审核订单失败，请稍后重试');
      }
    }
    const courseIds = product.type === '录播课程' ? [product.id] : (product.courseIds || order.courseIds || []);
    setStudents(current => current.map(student => String(student.id) === String(order.studentId) ? {
      ...student,
      purchasedProductIds: Array.from(new Set([...(student.purchasedProductIds || []), product.id])),
      purchasedCourseIds: Array.from(new Set([...(student.purchasedCourseIds || []), ...courseIds]))
    } : student));
    setContentItems(current => current.map(item => item.id === order.id ? {
      ...item,
      state: '已开通',
      approvedAt: new Date().toISOString(),
      approvedCourseIds: courseIds
    } : item));
    notify(`已同意${order.studentName}的申请，并开通「${product.name}」`);
  };
  const approveAllPurchaseOrders = async () => {
    if (!pendingPurchaseOrders.length) return notify('当前没有待确认购买申请');
    const validOrders = pendingPurchaseOrders.filter(order => (contentItems || []).some(item => (item.type === '商品' || item.type === '录播课程') && String(item.id) === String(order.productId)));
    if (!validOrders.length) return notify('待确认订单对应的课程或商品均已删除，无法批量开通');
    if (!window.confirm(`确定同意 ${validOrders.length} 笔购买申请并自动开通对应权限吗？`)) return;
    for (const order of validOrders) {
      await approvePurchaseOrder(order);
    }
    notify(`已完成 ${validOrders.length} 笔购买申请审核`);
  };
  const assignedPlans = students.flatMap(student => student.assignedPlans || []);
  const taskMetrics = getPlanTaskMetrics(assignedPlans);
  const taskCompletion = taskMetrics.planned ? Math.round((taskMetrics.completed / taskMetrics.planned) * 100) : null;
  const pendingAssessmentFollowUp = submissions.filter(item => item.status !== '已批改').length;
  const pendingReview = pendingContentReviews.length;
  const paidStudents = students.filter(student => student.status === '付费' || student.status === '报名').length;
  const trialStudents = students.filter(student => student.status === '体验').length;
  const newStudents = students.filter(student => student.status === '新人').length;
  const testedStudentIds = new Set(submissions.map(item => String(item.studentId)));
  const untestedStudents = students.filter(student => !testedStudentIds.has(String(student.id)));
  const subjectStats = ['政治', '英语', '数学'].map(subject => {
    const records = submissions.filter(item => item.status === '已批改' && item.subjectScores?.[subject] !== undefined);
    const average = records.length
      ? Math.round(records.reduce((sum, item) => sum + (item.subjectScores[subject] / item.subjectTotals[subject]) * 100, 0) / records.length)
      : null;
    const belowPass = records.filter(item => item.subjectScores[subject] < 60).length;
    return { subject, records: records.length, average, belowPass };
  });
  const riskStudents = students.map(student => {
    const plans = student.assignedPlans || [];
    const rows = plans.flatMap(plan => plan.rows || []);
    const completed = rows.filter(row => isRowComplete(row)).length;
    const completion = rows.length ? Math.round((completed / rows.length) * 100) : null;
    const records = submissions.filter(item => String(item.studentId) === String(student.id) && item.status === '已批改');
    const lowScore = records.find(item => item.score < 60);
    const checkins = (student.taskCheckins || [])
      .filter(item => item?.at)
      .sort((left, right) => new Date(left.at) - new Date(right.at));
    const recentDays = Array.from(new Set(checkins.map(item => toDateKey(item.at)).filter(Boolean))).slice(-3);
    const recentCheckins = checkins.filter(item => recentDays.includes(toDateKey(item.at)));
    const completedDays = new Set(recentCheckins.filter(item => item.completed).map(item => toDateKey(item.at)));
    const quantitativeCheckins = recentCheckins.filter(item => Number.isFinite(Number(item.planned)) && Number(item.planned) > 0);
    const onTargetDays = new Set(quantitativeCheckins.filter(item => Number(item.actual) >= Number(item.planned)).map(item => toDateKey(item.at)));
    const overTargetDays = new Set(quantitativeCheckins.filter(item => Number(item.actual) > Number(item.planned)).map(item => toDateKey(item.at)));
    const lastActivityAt = checkins.length ? checkins[checkins.length - 1].at : plans.map(plan => plan.assignedAt).filter(Boolean).sort().slice(-1)[0];
    const inactiveDays = lastActivityAt
      ? Math.floor((Date.now() - new Date(lastActivityAt).getTime()) / 86400000)
      : 0;
    const reasons = [];
    if (plans.length && inactiveDays >= 3) reasons.push('连续 3 天未完成作业');
    if (recentDays.length === 3 && quantitativeCheckins.length && onTargetDays.size === 0) reasons.push('连续 3 天未按定量完成');
    if (recentDays.length === 3 && overTargetDays.size === 3) reasons.push('连续 3 天超额完成，建议评估任务量');
    if (lowScore) reasons.push(`${lowScore.paperTitle || '自测'} ${lowScore.score} 分，需跟进薄弱点`);
    if (!testedStudentIds.has(String(student.id))) reasons.push('未完成入学自测');
    if (pendingAssessmentFollowUp && submissions.some(item => String(item.studentId) === String(student.id) && item.status !== '已批改')) reasons.push('自测提交正在自动批改中');
    return { ...student, completion, reasons };
  }).filter(student => student.reasons.length).sort((left, right) => right.reasons.length - left.reasons.length);

  return <>
    <section className="dashboard-head">
      <div><span className="eyebrow">教师后台 · 工作入口</span><h1>今日优先处理需要老师介入的事项。</h1><p>数据仅根据当前学员档案、任务组合、入学自测提交和审核队列计算；尚未接入的活跃、打卡与内容使用数据不在此展示。</p></div>
      <div className="page-actions"><button type="button" className="secondary" onClick={copyRegistrationUrl}>分享登记链接</button><button type="button" className="secondary" onClick={refreshRegistrations}>刷新登记</button><button type="button" className="registration-queue-button" onClick={() => setShowRegistrations(current => !current)}>已登记学员 <b>{pendingRegistrations.length}</b></button></div>
    </section>
    {showRegistrations && <section className="panel registration-panel"><div className="dashboard-section-head"><div><span className="eyebrow">登记审核队列</span><h2>已登记学员</h2></div><span className="dashboard-review-total">待导入 {pendingRegistrations.length} 人</span></div>{pendingRegistrations.length ? <div className="registration-list">{pendingRegistrations.map(application => <article className="registration-row" key={application.id}><div><b>{application.name}</b><small>{application.year} · {application.phone} · {application.email || '未填写邮箱'}</small><p>{application.school || '未填写院校'} · {application.stage || '未开始'}阶段</p><span>{(application.subjects || []).join('、')} · {application.evaluation || '未填写自我评价'}</span></div><div className="registration-actions"><select value={registrationTypes[application.id] || '新人'} onChange={event => setRegistrationTypes(current => ({...current, [application.id]:event.target.value}))}><option value="免费">免费</option><option value="新人">新人</option><option value="体验">体验</option><option value="付费">付费</option></select><button type="button" className="primary" onClick={() => importRegistration(application)}>导入并分发试卷</button></div></article>)}</div> : <div className="empty-line"><Check size={19}/><span>当前没有待审核登记。点击“分享登记链接”后，学生提交的信息会先出现在这里。</span></div>}</section>}
    <section className="dashboard-todo-grid">
      <button className="dashboard-todo is-attention" onClick={() => document.getElementById('dashboard-risk-panel')?.scrollIntoView({behavior:'smooth', block:'start'})}><Users size={21}/><div><span>需要关注的学员</span><strong>{riskStudents.length}</strong><small>{riskStudents.length ? '查看任务与自测异常' : '当前没有需要介入的异常'}</small></div><ChevronRight size={17}/></button>
      <button className={pendingPurchaseOrders.length ? 'dashboard-todo is-purchase-pending' : 'dashboard-todo is-review'} onClick={() => setPage('content')}><PackageOpen size={21}/><div><span>待确认购买申请</span><strong>{pendingPurchaseOrders.length}</strong><small>{pendingPurchaseOrders.length ? '点击进入收款设置核验并开通' : '当前没有待确认购买申请'}</small></div><ChevronRight size={17}/></button>
      <button className="dashboard-todo is-attention" onClick={() => setShowRegistrations(true)}><Users size={21}/><div><span>已登记学员</span><strong>{pendingRegistrations.length}</strong><small>{pendingRegistrations.length ? '选择类型后导入学员管理' : '当前没有待导入登记'}</small></div><ChevronRight size={17}/></button>
      <button className="dashboard-todo is-attention" onClick={() => setPage('students')}><Users size={21}/><div><span>未完成入学摸底</span><strong>{untestedStudents.length}</strong><small>{untestedStudents.length ? '进入学员管理安排试卷' : '所有学员已有提交记录'}</small></div><ChevronRight size={17}/></button>
      <button className="dashboard-todo is-review" onClick={() => document.getElementById('dashboard-review-panel')?.scrollIntoView({behavior:'smooth', block:'start'})}><ShieldCheck size={21}/><div><span>待处理审核</span><strong>{pendingReview + pendingPurchaseOrders.length}</strong><small>{pendingReview} 条内容 · {pendingPurchaseOrders.length} 笔购买申请</small></div><ChevronRight size={17}/></button>
    </section>
    <section className="panel dashboard-review-panel" id="dashboard-review-panel">
      <div className="dashboard-section-head"><div><span className="eyebrow">统一审核中心</span><h2>审核</h2></div><span className="dashboard-review-total">内容 {pendingReview} 条 · 购买 {pendingPurchaseOrders.length} 笔</span></div>
      <div className="dashboard-review-grid">
        <section className="dashboard-review-section"><div className="dashboard-review-section-head"><div><span className="eyebrow">内容审核</span><h3>社区待审核内容</h3></div><button className="secondary" onClick={() => pendingReview ? approveAllContentReviews() : setPage('moderation')}><Check size={15}/>{pendingReview ? `一键审核 ${pendingReview} 条` : '查看内容'}</button></div>{pendingReview ? <div className="dashboard-review-list">{pendingContentReviews.slice(0, 3).map((post, index) => <div className="dashboard-review-row" key={`${post.title}-${index}`}><div><b>{post.title}</b><small>{post.author} · {post.topic}</small></div><button className="quiet-button" onClick={() => setPage('moderation')}>查看<ChevronRight size={14}/></button></div>)}</div> : <div className="dashboard-review-empty"><Check size={16}/>当前没有待审核内容</div>}</section>
        <section className="dashboard-review-section"><div className="dashboard-review-section-head"><div><span className="eyebrow">购买审核</span><h3>商城待确认申请</h3></div><button className="secondary" onClick={() => pendingPurchaseOrders.length ? approveAllPurchaseOrders() : setPage('content')}><Check size={15}/>{pendingPurchaseOrders.length ? `一键审核 ${pendingPurchaseOrders.length} 笔` : '查看订单'}</button></div>{pendingPurchaseOrders.length ? <div className="dashboard-review-list">{pendingPurchaseOrders.slice(0, 3).map(order => <div className="dashboard-review-row" key={order.id}><div><b>{order.productName}</b><small>{order.studentName} · 待确认收款</small></div><button className="quiet-button" onClick={() => approvePurchaseOrder(order)}>同意<Check size={14}/></button></div>)}</div> : <div className="dashboard-review-empty"><Check size={16}/>当前没有待确认购买申请</div>}</section>
      </div>
    </section>
    <section className="dashboard-section">
      <div className="dashboard-section-head"><div><span className="eyebrow">学员概况</span><h2>当前学员池</h2></div><button className="quiet-button" onClick={() => setPage('students')}>进入学员管理<ChevronRight size={15}/></button></div>
      <div className="dashboard-stat-grid">
        <article><span>学员总数</span><b>{students.length}</b><small>当前在册学员</small></article>
        <article><span>付费学员</span><b>{paidStudents}</b><small>已报名或付费</small></article>
        <article><span>体验学员</span><b>{trialStudents}</b><small>待转化与跟进</small></article>
        <article><span>新学员</span><b>{newStudents}</b><small>待建立基础档案</small></article>
      </div>
    </section>
    <div className="dashboard-two-column">
      <section className="panel dashboard-panel" id="dashboard-risk-panel">
        <PanelHead title="需要关注的学员" action={`${riskStudents.length} 人`} onAction={() => setPage('students')}/>
        {riskStudents.length ? <div className="dashboard-risk-list">{riskStudents.slice(0, 6).map(student => <div className="dashboard-risk-row" key={student.id}><div className="dashboard-student-avatar">{student.name.slice(0, 1)}</div><div><b>{student.name}</b><small>{student.stage}阶段 · {student.school}</small><p>{student.reasons.join(' · ')}</p></div><button className="icon-action" aria-label={`查看${student.name}`} onClick={() => setPage('students')}><ChevronRight size={15}/></button></div>)}</div> : <div className="empty-line"><Check size={19}/><span>当前没有触发关注规则的学员。</span></div>}
      </section>
      <section className="panel dashboard-panel">
        <PanelHead title="任务执行情况" action={taskMetrics.planned ? `${taskMetrics.completed} / ${taskMetrics.planned}` : '暂无任务'}/>
        {taskMetrics.planned ? <div className="dashboard-task-summary"><div className="dashboard-completion"><b>{taskCompletion}%</b><span>已完成任务</span></div><div className="dashboard-progress-track"><i style={{width:`${taskCompletion}%`}}/></div><div className="dashboard-task-breakdown"><span>计划 {taskMetrics.planned} 项</span><span>已完成 {taskMetrics.completed} 项</span><span>实际完成 {taskMetrics.actual} 项</span></div><p>数据来自学生个人 plans 与 completions；刷新后仍按服务端记录展示。</p></div> : <div className="empty-line"><ClipboardCheck size={19}/><span>尚未向学员布置可统计的个人任务。</span></div>}
      </section>
    </div>
    <section className="panel dashboard-panel dashboard-assessment">
      <PanelHead title="入学自测分析" action="进入自测" onAction={() => setPage('questionBank')}/>
      <div className="assessment-caption"><span>已批改记录：{submissions.filter(item => item.status === '已批改').length} 条</span><span>未完成任一学科摸底：{untestedStudents.length} 人</span></div>
      <div className="dashboard-subject-grid">{subjectStats.map(item => <article key={item.subject}><span>{item.subject}</span>{item.records ? <><b>{item.average}<em>分</em></b><small>{item.records} 份已批改 · {item.belowPass} 人未达 60 分</small></> : <><b>--</b><small>暂无已批改记录</small></>}</article>)}</div>
      <div className="dashboard-data-note"><CircleHelp size={16}/><span>平均分只统计对应学科、且已完成批改的 100 分制入学摸底记录。</span></div>
    </section>
  </>;
}


const PanelHead = ({title, action, badge, onAction}) => <div className="panel-head"><h2>{title}</h2>{badge && <span className="badge warn">{badge}</span>}{action && (onAction ? <button type="button" className="quiet-button" onClick={onAction}>{action}<ChevronRight size={15}/></button> : <span className="panel-head-meta">{action}</span>)}</div>;
const StateRow = ({label, value, highlight}) => <div className="state-row"><span>{label}</span><b className={highlight ? 'green-text' : ''}>{value}</b></div>;
const AiToggle = ({label, enabled, disabled, onChange}) => <label className="ai-toggle"><span><Bot size={16}/>{label}</span><input type="checkbox" checked={enabled} disabled={disabled} onChange={e=>onChange(e.target.checked)}/><i/></label>;
const CourseCard = ({course}) => { const subject = subjects.find(x => x.id === course.subject); return <article className="course-card"><div className="course-cover" style={{background: subject.tint, color: subject.accent}}><span>{subject.label}</span><b>{course.cover}</b><Play size={18}/></div><div className="course-body"><span>{course.teacher} · {course.lessons} 节</span><h3>{course.title}</h3><div className="bar"><i style={{width: `${course.progress}%`, background: subject.accent}}/></div><small>已完成 {course.progress}%</small></div></article>};

function StudentPractice({student, enrolledSubjects, assignedPapers, records, notify}) {
  const recordByPaper = new Map(records.map(record => [record.paperId, record]));
  return <><section className="page-head"><div><span className="eyebrow">我的入学自测 · 教师分发</span><h1>按已报名科目完成入学摸底。</h1><p>仅显示老师已分发且与你已报名科目匹配的试卷。批改完成后，可在这里查看分数与错题反馈。</p></div></section><section className="panel student-subject-summary"><PanelHead title="我的报考科目"/><div className="subject-chips">{enrolledSubjects.length ? enrolledSubjects.map(item=><span className="subject-status-chip is-enrolled" key={item.name}>{item.name}</span>) : <span>暂未开通报名科目</span>}</div></section><div className="student-practice-grid">{assignedPapers.map(paper => {const record=recordByPaper.get(paper.id);return <article className="student-practice-card" key={paper.id}><span className="eyebrow">{paper.subject} · 100 分制</span><h2>{paper.title}</h2><p>{paper.summary}</p>{record ? <div className="student-practice-result"><b>{record.score}/{record.total}</b><span>已完成并批改</span></div> : <div className="student-practice-result pending"><b>待作答</b><span>请通过老师发送的专属链接完成</span></div>}</article>})}</div>{!assignedPapers.length&&<div className="empty-line"><FileQuestion size={21}/><span>老师暂未向你分发入学自测试卷。</span></div>}<section className="panel student-record-panel"><PanelHead title="我的自测档案" action={`${records.length} 份`}/>{records.length ? <div className="student-record-list">{records.map(record=><div key={record.paperId}><b>{record.paperTitle}</b><span>{record.score}/{record.total} 分</span><small>{record.gradedAt ? `批改时间：${new Date(record.gradedAt).toLocaleString('zh-CN')}` : '等待批改'}</small></div>)}</div> : <div className="empty-line"><ClipboardCheck size={20}/><span>完成并批改入学自测后，这里会保存你的分数与学习依据。</span></div>}</section></>;
}

function StudentCourses({student, items, selector, notify}) {
  const [openedCourse, setOpenedCourse] = useState(null);
  const purchasedProducts = (items || []).filter(item => item.type === '商品' && (student?.purchasedProductIds || []).map(String).includes(String(item.id)));
  const grantedCourseIds = new Set((student?.purchasedCourseIds || []).map(String));
  // 已开通的课程即使被老师下架，也保留在“我的课程”中继续学习；商城只显示已发布课程。
  const visibleCourses = (items || []).filter(item => item.type === '录播课程' && grantedCourseIds.has(String(item.id)));
  const enrolled = new Set((student?.subjects || []).filter(item => item.enrolled).map(item => normalizeStudentSubject(item.name)));
  const audienceOf = course => course.audience || '公开课';
  const categoryOf = course => course.category || '未分类';
  const specialAudience = course => ['公开课', '学习方法分享', '政策解读'].includes(audienceOf(course));
  const subjectCourses = visibleCourses.filter(course => !specialAudience(course));
  const publicCourses = visibleCourses.filter(course => specialAudience(course));
  const openMaterial = material => openPersistentAsset(material, notify);
  const renderCourse = course => {
    const materials = course.materials || [];
    const resourceSummary = [course.video?.fileName ? '视频课程' : '文字课程', materials.length ? `${materials.length} 份配套资料` : '暂无配套资料'].join(' · ');
    return <button type="button" className="course-card student-course-card" key={course.id} onClick={() => setOpenedCourse(course)}><div className="course-cover student-course-cover"><span>{audienceOf(course)}</span><b>{course.name}</b>{course.video?.fileName ? <Play size={18}/> : <FileText size={18}/>}</div><div className="course-body"><span>{audienceOf(course) === '公开课' ? `公开课 · ${categoryOf(course)}` : `${audienceOf(course)} · ${categoryOf(course)} · 已报名`}</span><h3>{course.name}</h3><small>{resourceSummary}</small>{materials.length ? <div className="student-course-materials">{materials.slice(0, 2).map(material => <span key={material.id || material.fileName}><FileText size={12}/>{material.fileName}</span>)}{materials.length > 2 ? <span>另有 {materials.length - 2} 份资料</span> : null}</div> : null}</div></button>;
  };
  return <><section className="page-head course-page-head"><div><span className="eyebrow">我的课程 · 已开通权益</span><h1>只显示报名和已开通的课程。</h1><p>专业课程在报名对应科目或商城开通后显示；公开课、学习方法分享和政策解读向所有学生开放。</p>{selector}</div></section>{purchasedProducts.length ? <section className="student-course-section student-product-section"><div className="student-course-section-head"><div><span className="eyebrow">已购买内容</span><h2>我的商品与套餐</h2></div><span>{purchasedProducts.length} 项</span></div><div className="student-product-grid">{purchasedProducts.map(product => <article className="student-product-card is-owned" key={product.id}><div><span className="eyebrow">{product.category || '未分类'} · 已购买</span><h3>{product.name}</h3><p>{product.note || '已开通的学习产品与课程权益。'}</p>{product.asset?.fileName ? <button type="button" className="secondary" onClick={() => openMaterial(product.asset)}><FileText size={15}/>打开商品资料</button> : null}</div><span className="owned-mark"><Check size={15}/>已开通</span></article>)}</div></section> : null}<section className="student-course-section"><div className="student-course-section-head"><div><span className="eyebrow">我的报名课程</span><h2>已报名科目</h2></div><span>{subjectCourses.length} 门</span></div>{subjectCourses.length ? <div className="course-grid full student-course-grid">{subjectCourses.map(renderCourse)}</div> : <div className="empty-line"><BookOpen size={22}/><span>老师暂未发布与你报名科目匹配的课程。</span></div>}</section><section className="student-course-section"><div className="student-course-section-head"><div><span className="eyebrow">公开课</span><h2>所有学生可学习</h2></div><span>{publicCourses.length} 门</span></div>{publicCourses.length ? <div className="course-grid full student-course-grid">{publicCourses.map(renderCourse)}</div> : <div className="empty-line"><BookOpen size={22}/><span>暂未找到可学习的公开课。</span></div>}</section>{openedCourse && <div className="modal-backdrop" onMouseDown={() => setOpenedCourse(null)}><section className="modal course-detail-modal" onMouseDown={event => event.stopPropagation()}><button className="modal-close" onClick={() => setOpenedCourse(null)} aria-label="关闭"><X size={19}/></button><span className="eyebrow">{audienceOf(openedCourse)} · {categoryOf(openedCourse)}</span><h2>{openedCourse.name}</h2><p className="course-detail-copy">{openedCourse.description?.trim() || '老师尚未填写课程文字说明，可先查看已上传的视频或配套资料。'}</p>{openedCourse.video?.fileName ? <button type="button" className="course-detail-resource" onClick={() => openPersistentAsset(openedCourse.video, notify)}><Play size={18}/><div><b>{openedCourse.video.fileName}</b><small>{openedCourse.video?.url || openedCourse.video?.objectUrl ? '打开服务器签名地址' : '视频文件已上传；当前没有可用签名地址。'}</small></div><ChevronRight size={16}/></button> : null}<div className="course-detail-materials"><h3>配套资料</h3>{(openedCourse.materials || []).length ? (openedCourse.materials || []).map(material => <button type="button" key={material.id || material.fileName} onClick={() => openMaterial(material)}><FileText size={17}/><span><b>{material.fileName}</b><small>{formatCourseFileSize(material.fileSize)}</small></span><ChevronRight size={16}/></button>) : <p>老师暂未上传配套资料。</p>}</div></section></div>}</>;
}

function StudentStore({student, items, setItems, setStudents, selector, notify}) {
  const [purchasingProduct, setPurchasingProduct] = useState(null);
  const [storeCourses, setStoreCourses] = useState(null);
  const [storeProducts, setStoreProducts] = useState(null);

  // 商城独立刷新课程与商品目录，不依赖应用级内容状态。教师发布课程或上架商品后，已打开的学生商城也会直接获取最新数据。
  useEffect(() => {
    if (!isApiConfigured()) return undefined;
    let active = true;
    const loadStorefront = async () => {
      const fresh = `storefrontFresh=${Date.now()}`;
      const [coursesResult, productsResult] = await Promise.allSettled([
        apiRequest(`/api/courses?${fresh}`, { cache: 'no-store' }),
        apiRequest(`/api/products?${fresh}`, { cache: 'no-store' })
      ]);
      if (!active) return;
      if (coursesResult.status === 'fulfilled') {
        const source = Array.isArray(coursesResult.value) ? coursesResult.value : (coursesResult.value?.courses || []);
        if (Array.isArray(source)) {
          const normalizedCourses = source.map(course => ({
            id: course.id,
            type: '录播课程',
            name: course.name || course.title || '未命名课程',
            subject: course.subject || course.audience || '公开课',
            audience: course.audience || course.subject || '公开课',
            category: course.category || '',
            description: course.description || '',
            pricing: course.pricing || '免费',
            price: Number(course.price || 0),
            state: course.state || course.status || '草稿',
            video: course.video || null,
            materials: Array.isArray(course.materials) ? course.materials : [],
            isServerManaged: true
          }));
          // 附件接口对学生按购买权益鉴权（公开课未领取也会 403），只拉已购课程，避免无权限课程的 403 刷屏。
          const ownedCourseIds = new Set((student?.purchasedCourseIds || []).map(String));
          const canFetchAssets = course => ownedCourseIds.has(String(course.id));
          const assetResults = await Promise.allSettled(normalizedCourses.map(course => canFetchAssets(course)
            ? apiRequest(`/api/courses/${encodeURIComponent(course.id)}/assets`, { cache: 'no-store' })
            : Promise.resolve([])));
          normalizedCourses.forEach((course, index) => {
            const result = assetResults[index];
            const assets = result.status === 'fulfilled' && Array.isArray(result.value) ? result.value : [];
            const mapAsset = asset => ({ id: asset.id, fileName: asset.fileName, fileSize: asset.sizeBytes, fileType: asset.mimeType || 'application/octet-stream', url: asset.url, serverManaged: true, uploadedAt: asset.createdAt });
            course.video = assets.filter(asset => asset.kind === 'video').map(mapAsset)[0] || null;
            course.materials = assets.filter(asset => asset.kind !== 'video').map(mapAsset);
          });
          setStoreCourses(normalizedCourses);
        }
      }
      if (productsResult.status === 'fulfilled') {
        const source = Array.isArray(productsResult.value) ? productsResult.value : (productsResult.value?.products || []);
        if (Array.isArray(source)) setStoreProducts(source.map(product => ({
          id: product.id,
          type: '商品',
          name: product.name || product.title || '未命名商品',
          category: product.category || '未分类',
          note: product.description || product.note || '',
          courseIds: Array.isArray(product.courseIds) ? product.courseIds.map(String) : (Array.isArray(product.course_ids) ? product.course_ids.map(String) : []),
          pricing: product.pricing || '免费',
          price: Number(product.price || 0),
          state: product.state || product.status || '草稿',
          asset: product.asset || null,
          isServerManaged: true
        })));
      }
      // 单个请求短暂失败时保留上一份成功数据；首次失败则继续使用应用级数据兜底。
    };
    loadStorefront();
    const timer = window.setInterval(loadStorefront, 15000);
    return () => { active = false; window.clearInterval(timer); };
  }, [student?.id]);

  const paymentConfig = (items || []).find(item => item.type === '收款配置');
  const configuredProducts = (storeProducts || (items || []).filter(item => item.type === '商品')).filter(item => item.state === '已上架');
  const publishedCourses = (storeCourses || (items || []).filter(item => item.type === '录播课程')).filter(item => item.state === '已发布');
  const products = [
    ...publishedCourses.map(course => ({
      ...course,
      storefrontType: '课程',
      productId: course.id,
      courseIds: [course.id],
      note: course.description || '课程权益将在开通后同步到“我的课程”。'
    })),
    ...configuredProducts.map(product => ({ ...product, storefrontType: '商品', productId: product.id }))
  ];
  const purchasedIds = new Set((student?.purchasedProductIds || []).map(String));
  const submitPurchaseRequest = async product => {
    if (purchasedIds.has(String(product.productId))) return notify('该内容已在你的已购内容中');
    const alreadyPending = (items || []).some(item => item.type === '购买订单' && item.studentId === student?.id && String(item.productId) === String(product.productId) && item.state === '待确认');
    if (alreadyPending) return notify('该内容的购买申请已提交，请等待确认');
    const isFree = product.pricing === '免费';
    if (product.pricing !== '免费' && product.pricing !== '付费') return notify('该内容尚未配置售卖方式，请联系老师');
    if (!isFree && !paymentConfig?.objectUrl && !isApiConfigured()) return notify('暂未提供收款方式，请联系老师后再购买');
    if (isApiConfigured() && product.isServerManaged) {
      try {
        const result = await apiRequest('/api/orders', {
          method: 'POST',
          body: { productId: product.productId, provider: 'wechat-qr' }
        });
        if (result?.reused) {
          notify('已为你复用上一次的订单，无需重复提交');
        } else if (isFree) {
          notify(`已领取免费课程「${product.name}」，可前往”我的课程”学习`);
        } else {
          notify(`已提交「${product.name}」购买申请，老师确认收款后自动开通`);
        }
        // 本地追加订单状态以便 UI 立即可见
        const orderId = result?.order?.id || result?.orderId;
        const status = result?.order?.status || '待支付';
        if (orderId) {
          setItems(current => {
            const exists = current.some(item => String(item.id) === String(orderId));
            if (exists) return current;
            return [...current, {
              id: orderId,
              type: '购买订单',
              state: status,
              studentId: student?.id,
              studentName: student?.name || '学生',
              productId: product.productId,
              productName: product.name,
              courseIds: product.courseIds || [],
              createdAt: new Date().toISOString(),
              isServerManaged: true
            }];
          });
          if (isFree) {
            setStudents(current => current.map(record => String(record.id) === String(student?.id) ? {
              ...record,
              purchasedProductIds: Array.from(new Set([...(record.purchasedProductIds || []), product.productId])),
              purchasedCourseIds: Array.from(new Set([...(record.purchasedCourseIds || []), ...(product.courseIds || [])]))
            } : record));
          }
        }
        setPurchasingProduct(null);
      } catch (error) {
        notify(error?.message || '提交订单失败，请稍后重试');
      }
      return;
    }
    if (isFree) {
      setStudents(current => current.map(record => String(record.id) === String(student?.id) ? {
        ...record,
        purchasedProductIds: Array.from(new Set([...(record.purchasedProductIds || []), product.productId])),
        purchasedCourseIds: Array.from(new Set([...(record.purchasedCourseIds || []), ...(product.courseIds || [])]))
      } : record));
      return notify(`已领取免费课程「${product.name}」，可前往”我的课程”学习`);
    }
    const order = { id: `order-${Date.now()}`, type: '购买订单', state: '待确认', studentId: student?.id, studentName: student?.name || '学生', productId: product.productId, productName: product.name, courseIds: product.courseIds || [], createdAt: new Date().toISOString() };
    setItems(current => [...current, order]);
    setPurchasingProduct(null);
    notify(`已提交「${product.name}」购买申请，老师确认收款后自动开通`);
  };
  return <><section className="page-head store-page-head"><div><span className="eyebrow">学生商城 · 课程中心</span><h1>选择并开通需要学习的课程。</h1><p>所有已发布课程都在这里展示。免费课程可直接领取；付费课程扫码付款并提交申请，老师确认后自动进入“我的课程”。</p>{selector}</div></section><section className="store-banner"><div><span className="eyebrow">课程开通规则</span><h2>报名或购买后，课程同步到我的课程</h2><p>政治、英语、数学和专业课支持报名或购买开通；公开课、学习方法分享与政策解读可免费或付费配置。</p></div><PackageOpen size={42}/></section>{products.length ? <div className="store-product-grid">{products.map(product => { const owned = purchasedIds.has(String(product.productId)); const isFree = product.pricing === '免费'; const saleReady = isFree || product.pricing === '付费'; return <article className="store-product-card" key={`${product.storefrontType}-${product.productId}`}><div className="store-product-top"><span className="product-category-tag">{product.storefrontType === '课程' ? `${product.audience || '课程'} · ${product.category || '未分类'}` : product.category || '未分类'}</span>{owned && <span className="owned-mark"><Check size={14}/>已开通</span>}</div><h2>{product.name}</h2><p>{product.note || '教师提供的课程、资料或学习服务。'}</p><div className="store-product-meta"><span className={isFree ? 'store-price-free' : saleReady ? 'store-price-paid' : 'store-price-pending'}>{isFree ? '免费领取' : saleReady ? `¥ ${Number(product.price || 0).toFixed(2)}` : '待配置'}</span>{product.storefrontType === '课程' && <small>{product.video?.fileName ? '含课程视频' : '文字 / 资料课程'}</small>}</div>{product.asset?.fileName && <small className="store-product-asset"><FileText size={14}/>{product.asset.fileName}</small>}<button type="button" className={owned ? 'secondary' : 'primary'} disabled={!owned && !saleReady} onClick={() => owned ? notify('该内容已开通，可前往“我的课程”学习') : (isFree ? submitPurchaseRequest(product) : setPurchasingProduct(product))}>{owned ? '已开通' : !saleReady ? '暂未开放购买' : isFree ? '免费领取' : '立即购买'}<ChevronRight size={15}/></button></article>; })}</div> : <div className="empty-line"><PackageOpen size={21}/><span>商城暂未上架课程，请等待老师发布课程。</span></div>}{purchasingProduct && <div className="modal-backdrop" onMouseDown={() => setPurchasingProduct(null)}><section className="modal purchase-qr-modal" onMouseDown={event => event.stopPropagation()}><button className="modal-close" onClick={() => setPurchasingProduct(null)} aria-label="关闭"><X size={19}/></button><span className="eyebrow">付费课程 · {purchasingProduct.audience || purchasingProduct.category || '未分类'}</span><h2>{purchasingProduct.name}</h2><p>{isApiConfigured() ? '请先按线下付款规则完成付款，再提交购买申请。服务端会按商品当前价格和状态重新校验，老师确认后才会开通权益。' : '请使用微信扫描下方收款码完成付款。付款后提交购买申请，老师核验收款并同意后，课程自动进入“我的课程”。'}</p>{paymentConfig?.objectUrl ? <img className="purchase-qr-image" src={paymentConfig.objectUrl} alt="微信收款码"/> : isApiConfigured() ? <div className="empty-line"><LockKeyhole size={20}/><span>当前部署未提供收款码展示接口；可提交申请，付款请按老师提供的安全渠道完成。</span></div> : <div className="empty-line"><LockKeyhole size={20}/><span>暂未提供收款方式，请联系老师。</span></div>}<small className="purchase-qr-note">{paymentConfig?.fileName ? `当前收款码：${paymentConfig.fileName}` : isApiConfigured() ? '收款配置由服务端管理' : '尚未上传收款码'}</small><div className="modal-actions"><button type="button" className="secondary" onClick={() => setPurchasingProduct(null)}>稍后处理</button><button type="button" className="primary" disabled={!isApiConfigured() && !paymentConfig?.objectUrl} onClick={() => submitPurchaseRequest(purchasingProduct)}>{isApiConfigured() || paymentConfig?.objectUrl ? '提交购买申请' : '暂不可提交'}</button></div></section></div>}</>;
}

function StudentWeeklyAssessment({student, aiSettings, setStudents, notify, activeModule, onOpenModule, onCloseModule}) {
  if (isApiConfigured()) return <ApiPeriodicAssessment student={student} notify={notify} activeModule={activeModule} onOpenModule={onOpenModule} onCloseModule={onCloseModule}/>;
  return <LocalStudentWeeklyAssessment student={student} aiSettings={aiSettings} setStudents={setStudents} notify={notify} activeModule={activeModule} onOpenModule={onOpenModule} onCloseModule={onCloseModule}/>;
}

function ApiPeriodicAssessment({student, notify, activeModule, onOpenModule, onCloseModule}) {
  const [sets, setSets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedSet, setSelectedSet] = useState(null);
  const [answers, setAnswers] = useState({});
  const [submitted, setSubmitted] = useState(null);
  const [pending, setPending] = useState(false);
  const typeId = activeModule?.typeId || activeModule?.assessmentType || activeModule?.id;
  const [selectedSubject, setSelectedSubject] = useState('');
  const subject = activeModule?.subject || selectedSubject ? normalizeStudentSubject(activeModule?.subject || selectedSubject) : '';
  // Keep one draft per student and assessment type. Including the selected set
  // subject in this key would clear answers when a formal set is opened.
  const draftKey = `shangan-periodic-assessment:${student?.id || 'anonymous'}:${typeId || 'none'}`;

  const load = async () => {
    setLoading(true); setError('');
    try {
      const payload = await apiRequest('/api/student/assessment-question-sets', {cache:'no-store'});
      setSets(Array.isArray(payload) ? payload : []);
    } catch (e) { setError(e?.message || '正式自测题目集加载失败'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [student?.id]);
  useEffect(() => {
    if (!activeModule) return;
    try { setAnswers(JSON.parse(window.sessionStorage.getItem(draftKey) || '{}')); } catch { setAnswers({}); }
  }, [draftKey, activeModule]);
  useEffect(() => {
    if (!activeModule) return;
    try { window.sessionStorage.setItem(draftKey, JSON.stringify(answers)); } catch { /* optional draft */ }
  }, [draftKey, activeModule, answers]);

  const matchingSets = sets.filter(item => {
    const setType = item.assessmentType || item.assessment_type;
    return (item.state === '已发布' || item.state === 'published')
      && (!subject || normalizeStudentSubject(item.subject) === subject)
      && (!typeId || setType === typeId);
  });
  const openSet = item => { setSelectedSet(item); setSelectedSubject(normalizeStudentSubject(item.subject || '')); setSubmitted(null); };
  const submit = async () => {
    if (!selectedSet?.id) return notify('当前没有正式题目集，状态保持 pending_review / unavailable；答案已保留为草稿');
    setPending(true);
    try {
      const rows = Array.isArray(selectedSet.questions) ? selectedSet.questions : [];
      const safeAnswers = Object.fromEntries(Object.entries(answers).map(([key, value]) => {
        const q = rows.find(item => String(item.itemIndex) === String(key));
        return [key, getQuestionType(q) === 'multiple_choice' ? normalizeMultipleChoiceAnswer(value) : value];
      }).filter(([, value]) => value !== undefined && value !== '' && (!Array.isArray(value) || value.length)));
      const saved = await apiRequest(`/api/students/${encodeURIComponent(student.id)}/assessments`, {
        method:'POST',
        body:buildAssessmentSubmissionPayload({assessmentType:typeId, subject:activeModule.subject || selectedSet.subject || subject, title:selectedSet.title || activeModule.title, questionSetId:selectedSet.id, answers:safeAnswers})
      });
      setSubmitted(saved || {gradingStatus:'pending_review'});
      try { window.sessionStorage.removeItem(draftKey); } catch { /* optional */ }
      notify(saved?.message || '自测已提交，等待服务端评分');
    } catch (e) { notify(e?.message || '提交失败，答案已保留，可重试'); }
    finally { setPending(false); }
  };
  if (activeModule) {
    const questions = Array.isArray(selectedSet?.questions) ? selectedSet.questions : [];
    return <section className="student-exam-page"><section className="page-head student-practice-head"><div><span className="eyebrow">我的自测 · {activeModule.short || activeModule.title}</span><h1>{selectedSet?.title || '选择正式题目集'}</h1><p>仅使用服务端已发布题目集；没有正式题目集时保持 pending_review / unavailable，不生成固定题目。</p></div><button type="button" className="secondary back-button" onClick={onCloseModule}><ChevronLeft size={16}/>返回测试列表</button></section>{loading ? <div className="empty-line"><Clock3 size={20}/><span>正在加载正式题目集…</span></div> : error ? <div className="empty-line" role="alert"><AlertTriangle size={20}/><span>{error}</span><button type="button" className="secondary" onClick={load}>重试</button></div> : submitted ? <section className="panel exam-result"><span className="badge warn">{normalizeGradingStatusLabel(submitted.gradingStatus || submitted.reviewStatus || 'pending_review')}</span><h2>{submitted.score == null ? '已提交，等待批改' : `客观分 ${submitted.objectiveScore ?? submitted.score} / ${submitted.total ?? '—'}`}</h2><p>{submitted.subjectiveScore == null ? '主观题待教师批改；答案已归档。' : `主观分 ${submitted.subjectiveScore}`}</p><button type="button" className="primary" onClick={onCloseModule}>返回测试列表</button></section> : !selectedSet ? <section className="panel"><div className="student-assessment-grid practice-assessment-grid">{matchingSets.map(item => <button type="button" className="student-assessment-card is-today" key={item.id} onClick={() => openSet(item)}><span className="eyebrow">正式题目集</span><h3>{item.title}</h3><p>{Array.isArray(item.questions) ? item.questions.length : 0} 题 · 已发布</p><span className="assessment-subject-action">开始作答 <ChevronRight size={16}/></span></button>)}</div>{!matchingSets.length && <div className="empty-line"><FileQuestion size={21}/><span>暂无匹配的正式题目集；答案保留，提交状态为 pending_review / unavailable。</span></div>}</section> : <section className="panel student-exam-panel"><div className="student-exam-list">{questions.map((q, index) => { const multiple = getQuestionType(q) === 'multiple_choice'; const value = answers[q.itemIndex]; return <article className="student-exam-question" key={q.itemIndex ?? index}><b>{index + 1}. {q.stem}</b>{q.options?.length ? <div className="exam-options">{q.options.map((option, optionIndex) => { const letter = getQuestionOptionKey(option, optionIndex); const selected = multiple ? normalizeMultipleChoiceAnswer(value).includes(letter) : value === letter; return <label className={selected ? 'selected' : ''} key={letter}><input type={multiple ? 'checkbox' : 'radio'} name={`periodic-${q.itemIndex}`} checked={selected} disabled={pending} onChange={() => setAnswers(current => ({...current, [q.itemIndex]: multiple ? toggleMultipleChoiceAnswer(current, q.itemIndex, letter) : letter}))}/><b>{letter}</b><span>{getQuestionOptionText(option)}</span></label>; })}</div> : <textarea value={value || ''} disabled={pending} onChange={event => setAnswers(current => ({...current,[q.itemIndex]:event.target.value}))} rows={4} placeholder="填写主观作答"/>}</article>; })}</div><div className="form-footer"><span>答案仅保存在草稿，提交后由服务端批改</span><button type="button" className="primary" onClick={submit} disabled={pending}>{pending ? '正在提交…' : '提交测试'}</button></div></section>}</section>;
  }
  return <section className="student-exam-page"><section className="page-head student-practice-head"><div><span className="eyebrow">我的自测</span><h1>日测 · 周测 · 月测</h1><p>周期自测只使用服务端正式题目集；没有正式题目集时不生成固定题目。</p></div></section><section className="assessment-entry-grid">{Object.values(PERIODIC_ASSESSMENT_SPECS).map(entry => <button type="button" className={`assessment-entry-card tone-${entry.tone}`} key={entry.id} onClick={() => onOpenModule?.({...entry, subject:'', typeId:entry.id})}><span className="eyebrow">{entry.title}</span><h2>{entry.cadence}</h2><p>仅使用服务端已发布题目集</p><span className="assessment-entry-action">查看题目集 <ChevronRight size={16}/></span></button>)}</section></section>;
}

const PERIODIC_PRACTICE_OPTIONS = ['A', 'B', 'C', 'D'];
const buildPeriodicPracticeQuestions = module => {
  const pools = {
    英语: [
      {prompt:'下列词语中，最符合“持续复习并巩固记忆”含义的是：', options:['review','refuse','remove','reduce'], answer:'A', knowledge:'复习语境中 review 表示复习、回顾。'},
      {prompt:'请选择语法正确的一项：', options:['She has finished the task.','She have finished the task.','She finished has the task.','She has finish the task.'], answer:'A', knowledge:'现在完成时用 has/have + 过去分词。'},
      {prompt:'阅读句子 “Practice makes progress.”，最贴切的理解是：', options:['练习有助于进步','进步会停止练习','练习只靠天赋','学习无需计划'], answer:'A', knowledge:'根据句子语义判断主旨。'}
    ],
    政治: [
      {prompt:'马克思主义哲学区别于旧哲学的根本标志是强调：', options:['实践','思辨','经验','信仰'], answer:'A', knowledge:'实践观点是马克思主义哲学的核心观点。'},
      {prompt:'社会主义的本质要求最终体现在：', options:['共同富裕','平均分配','按需生产','完全公有'], answer:'A', knowledge:'共同富裕是社会主义本质的最终体现。'},
      {prompt:'党的思想路线的核心是：', options:['实事求是','群众路线','独立自主','与时俱进'], answer:'A', knowledge:'实事求是是党的思想路线的核心。'}
    ],
    数学: [
      {prompt:'若 f(x)=x²，则 f′(x) 等于：', options:['2x','x','x²','2'], answer:'A', knowledge:'幂函数求导公式：(xⁿ)′=nxⁿ⁻¹。'},
      {prompt:'∫ 2x dx 的结果是：', options:['x²+C','2x+C','x+C','x³+C'], answer:'A', knowledge:'不定积分要注意积分常数 C。'},
      {prompt:'函数 y=x² 在 x=1 处的切线斜率为：', options:['2','1','0','3'], answer:'A', knowledge:'切线斜率等于该点导数值 f′(1)=2。'}
    ]
  };
  const source = pools[module.subject] || [
    {prompt:'完成当前专业课学习后，最合适的巩固方式是：', options:['整理知识框架并复盘错题','只看答案不回顾','跳过基础直接做难题','不记录薄弱点'], answer:'A', knowledge:'专业课复习需要形成知识框架并回顾错误。'},
    {prompt:'面对一道做错的专业课题目，下一步应当：', options:['定位对应知识点并重新完成同类题','立刻忽略错误','只记住选项','等待下次考试'], answer:'A', knowledge:'错题复盘要回到知识点并用同类题验证。'},
    {prompt:'阶段复习结束后，优先检查的是：', options:['未掌握知识点与任务完成情况','只看学习时长','只做新题','跳过总结'], answer:'A', knowledge:'阶段检查应结合知识掌握和实际完成情况。'}
  ];
  return source.map((question, index) => ({...question, id: `${module.id}-${index + 1}`}));
};

function PeriodicAssessmentPage({module, student, setStudents, notify, onBack}) {
  const questions = useMemo(() => buildPeriodicPracticeQuestions(module), [module]);
  const [answers, setAnswers] = useState({});
  const [result, setResult] = useState(null);
  const submit = async () => {
    if (Object.keys(answers).length < questions.length) return notify('请完成全部题目后再提交');
    const rawScore = questions.reduce((total, question) => total + (answers[question.id] === question.answer ? 1 : 0), 0);
    const score = Math.round((rawScore / questions.length) * 100);
    let record = { id: `periodic-${Date.now()}`, type: module.typeId, title: `${module.subject}${module.short}`, studyDay: getPersonalStudyDay(student), score, total: 100, rawScore, rawTotal: questions.length, status: '已完成', submittedAt: new Date().toISOString(), subjectScores: {[module.subject]: score}, subjectTotals: {[module.subject]: 100}, wrongQuestions: questions.filter(question => answers[question.id] !== question.answer).map(question => ({subject: module.subject, number: question.id.split('-').pop(), correctAnswer: question.answer, studentAnswer: answers[question.id], knowledgePointExplanation: question.knowledge || '请回顾本次练习对应的课程内容。'})), answersNote: '已完成本次自测，结果已保存到自测档案。' };
    if (isApiConfigured()) {
      try {
        const apiAnswers = {};
        questions.forEach((q, idx) => {
          const key = String(idx + 1);
          const ans = answers[q.id];
          if (ans != null) apiAnswers[key] = ans;
        });
        const wrongQuestions = questions.filter(question => answers[question.id] !== question.answer).map(question => ({
          number: Number(question.id.split('-').pop()) || 0,
          subject: module.subject,
          knowledgePointExplanation: question.knowledge || '请回顾本次练习对应的课程内容。',
          correctMethod: `正确答案：${question.answer}`
        }));
        const saved = await apiRequest(`/api/students/${student.id}/assessments`, {
          method: 'POST',
          body: {
            assessmentType: module.typeId,
            subject: module.subject,
            title: record.title,
            score,
            total: 100,
            answers: apiAnswers,
            wrongQuestions
          }
        });
        record = {
          ...record,
          id: saved.id || record.id,
          type: saved.assessmentType || saved.assessment_type || record.type,
          subject: saved.subject || record.subject,
          submittedAt: saved.submittedAt || saved.submitted_at || record.submittedAt,
          gradedAt: saved.gradedAt || saved.graded_at || record.submittedAt,
          wrongQuestions: Array.isArray(saved.wrongQuestions) ? saved.wrongQuestions : (Array.isArray(saved.wrong_questions) ? saved.wrong_questions : record.wrongQuestions)
        };
      } catch (error) {
        notify(error?.message || '提交自测失败，请稍后重试');
        return;
      }
    }
    setStudents(current => current.map(item => String(item.id) === String(student.id) ? {...item, assessmentRecords: [...(item.assessmentRecords || []), record]} : item));
    setResult(record);
  };
  return <section className="student-exam-page"><section className="page-head"><div><span className="eyebrow">我的自测</span><h1>{module.subject}{module.short}</h1><p>本次为平台内置基础练习，完成后会保存到自测档案，便于回看薄弱知识点。</p></div><button type="button" className="secondary back-button" onClick={onBack}><ChevronLeft size={16}/>返回测试列表</button></section>{result ? <section className="panel exam-result"><span className="badge ok">已提交</span><h2>本次得分 {result.score} / {result.total}</h2><p>结果已保存，可在学员自测档案中查看。</p><button type="button" className="primary" onClick={onBack}>返回测试列表</button></section> : <section className="panel student-exam-panel"><div className="student-exam-list">{questions.map((question, index) => <article className="student-exam-question" key={question.id}><b>{index + 1}. {question.prompt}</b><div>{(question.options || PERIODIC_PRACTICE_OPTIONS).map((option, optionIndex) => { const value = typeof option === 'string' && option.length === 1 ? option : PERIODIC_PRACTICE_OPTIONS[optionIndex]; const label = typeof option === 'string' && option.length > 1 ? `${value}. ${option}` : value; return <label key={value} className={answers[question.id] === value ? 'is-selected' : ''}><input type="radio" name={question.id} checked={answers[question.id] === value} onChange={() => setAnswers(current => ({...current, [question.id]: value}))}/>{label}</label>; })}</div></article>)}</div><div className="form-footer"><span>已完成 {Object.keys(answers).length} / {questions.length} 题</span><button type="button" className="primary" onClick={submit}>提交测试</button></div></section>}</section>;
}

const DEMO_ENGLISH_CHOICE_QUESTIONS = [
  {id:'english-choice-demo-1', question:'The research team _____ its findings before the deadline.', a:'has submitted', b:'submit', c:'submitting', d:'to submit', answer:'A', analysis:'现在完成时使用 has/have + 过去分词。'},
  {id:'english-choice-demo-2', question:'The word “maintain” is closest in meaning to _____.', a:'preserve', b:'remove', c:'divide', d:'ignore', answer:'A', analysis:'maintain 表示维持、保持，近义词是 preserve。'},
  {id:'english-choice-demo-3', question:'Practice makes progress. The sentence mainly emphasizes _____.', a:'the value of regular practice', b:'the need to stop learning', c:'the role of luck', d:'the difficulty of exams', answer:'A', analysis:'句意为熟能生巧，强调持续练习的价值。'}
];

const DEMO_ENGLISH_CHOICE_BOOKS = [
  {id:'english-choice-grammar-demo', name:'考研英语语法选择题（演示）', description:'覆盖时态、从句和非谓语等语法知识点。', questions:DEMO_ENGLISH_CHOICE_QUESTIONS.map(item => ({...item, question:item.question}))},
  {id:'english-choice-vocabulary-demo', name:'考研英语词汇辨析（演示）', description:'覆盖词义辨析和语境选择。', questions:[
    {id:'english-choice-vocab-1', question:'The new policy will _____ economic growth.', a:'promote', b:'prevent', c:'damage', d:'refuse', answer:'A', analysis:'promote 表示促进，符合语境。'},
    {id:'english-choice-vocab-2', question:'The evidence is _____ to support the conclusion.', a:'sufficient', b:'remote', c:'empty', d:'narrow', answer:'A', analysis:'sufficient 表示足够的。'}
  ]}
];

const getLocalPoliticsBooks = data => (data?.politicsBooks || []).map(book => ({
  ...book,
  questions:(book.questions || []).map((item, index) => ({...item, id:item.id || `politics-${book.id}-${index}`}))
}));

function StudentChoicePractice({student, title, subject, books, selector, notify, onBack}) {
  const normalizedBooks = books.length ? books : [{id:`${subject}-empty-book`,name:`${subject}题库（待上传）`,questions:[]}];
  const [book, setBook] = useState(null);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [reviewMode, setReviewMode] = useState(false);
  const [unfamiliarReviewMode, setUnfamiliarReviewMode] = useState(false);
  const [unfamiliarQuestionIds, setUnfamiliarQuestionIds] = useState(new Set());
  const instantFeedback = subject === '政治';
  const resourceType = `${subject === '政治' ? 'politics' : 'english'}_questions`;
  const activeQuestions = book?.questions || [];
  const progress = book ? readLearningProgress(student?.id, resourceType, book.id, activeQuestions.length) : null;
  const question = activeQuestions[index];
  const options = question ? (question.options || [question.a, question.b, question.c, question.d].filter(Boolean)) : [];
  const chooseBook = item => { const itemProgress = readLearningProgress(student?.id, resourceType, item.id, (item.questions || []).length); setBook(item); setReviewMode(false); setUnfamiliarReviewMode(false); setUnfamiliarQuestionIds(new Set()); setIndex(itemProgress.nextIndex); setSubmitted(false); setAnswers({}); };
  const enterReview = item => { const itemProgress = readLearningProgress(student?.id, resourceType, item.id, (item.questions || []).length); if (!itemProgress.yesterdayItemIds.length) return notify('昨天没有已完成的题目可复习'); setBook(item); setReviewMode(true); setUnfamiliarReviewMode(false); setUnfamiliarQuestionIds(new Set()); setIndex(0); setSubmitted(false); setAnswers({}); };
  const standardReviewQuestions = reviewMode && progress ? activeQuestions.filter(item => progress.yesterdayItemIds.includes(item.id)) : activeQuestions;
  const reviewQuestions = unfamiliarReviewMode ? activeQuestions.filter(item => unfamiliarQuestionIds.has(item.id)) : standardReviewQuestions;
  const visibleQuestion = reviewQuestions[index];
  const correctAnswer = String(visibleQuestion?.answer || visibleQuestion?.correctAnswer || '').trim().toUpperCase();
  const selectedAnswer = String(answers[visibleQuestion?.id] || '').trim().toUpperCase();
  const isCorrect = submitted && Boolean(correctAnswer) && selectedAnswer === correctAnswer;
  const submit = async () => {
    if (!visibleQuestion || !answers[visibleQuestion.id]) return notify('请先选择一个答案');
    if (!reviewMode) {
      try { await persistLearningCompletion(student?.id, resourceType, book.id, visibleQuestion.id, activeQuestions.length); }
      catch (error) { return notify(error?.message || '学习进度保存失败，请稍后重试'); }
    }
    setSubmitted(true);
  };
  const next = () => { setSubmitted(false); setIndex(current => Math.min(reviewQuestions.length, current + 1)); };
  const chooseAnswer = async value => {
    if (!visibleQuestion || submitted) return;
    setAnswers(current => ({ ...current, [visibleQuestion.id]: value }));
    if (!instantFeedback) return;
    if (!reviewMode) {
      try { await persistLearningCompletion(student?.id, resourceType, book.id, visibleQuestion.id, activeQuestions.length); }
      catch (error) { return notify(error?.message || '学习进度保存失败，请稍后重试'); }
    }
    setSubmitted(true);
  };
  const markUnfamiliar = () => {
    if (!visibleQuestion) return;
    setUnfamiliarQuestionIds(current => new Set([...current, visibleQuestion.id]));
    next();
  };
  if (!book) return <section className="student-exam-page"><section className="page-head"><div><span className="eyebrow">学习工具 · {title}</span><h1>先选择一本{subject}题书</h1><p>开始学习会从上次未完成的位置继续；复习只查看昨天已完成的题目。</p>{selector}</div><button type="button" className="secondary back-button" onClick={onBack}><ChevronLeft size={16}/>返回工具</button></section><div className="student-tools-grid">{normalizedBooks.map(item => { const itemProgress = readLearningProgress(student?.id, resourceType, item.id, (item.questions || []).length); return <article className="student-tool-card" key={item.id}><BookOpen size={22}/><h2>{item.name}</h2><b>已完成 {itemProgress.learnedCount} / {(item.questions || []).length} 题</b><p>还剩 {Math.max(0, (item.questions || []).length - itemProgress.learnedCount)} 题 · 昨日完成 {itemProgress.yesterdayItemIds.length} 题</p><button type="button" className="primary" onClick={() => chooseBook(item)}>开始学习<ChevronRight size={15}/></button><button type="button" className="secondary" disabled={!itemProgress.yesterdayItemIds.length} onClick={() => enterReview(item)}>复习昨日</button></article>; })}</div></section>;
  if (!visibleQuestion) return <section className="student-exam-page"><section className="page-head"><div><span className="eyebrow">学习工具 · {title} · {book.name}</span><h1>{unfamiliarReviewMode ? '不熟悉题目复习完成' : reviewMode ? '昨日复习完成' : '本轮练习完成'}</h1><p>{unfamiliarReviewMode ? '本轮标记为不熟悉的题目已全部再次出现。' : unfamiliarQuestionIds.size ? `你标记了 ${unfamiliarQuestionIds.size} 道不熟悉题，可立即再复习一轮。` : '本轮题目已完成。'}</p></div><button type="button" className="secondary back-button" onClick={() => setBook(null)}><ChevronLeft size={16}/>返回书籍</button></section><div className="empty-line"><Check size={21}/><span>完成本轮练习。</span>{!unfamiliarReviewMode && unfamiliarQuestionIds.size ? <button type="button" className="primary" onClick={() => { setUnfamiliarReviewMode(true); setReviewMode(false); setIndex(0); setSubmitted(false); }}>复习不熟悉题目<ChevronRight size={16}/></button> : null}</div></section>;
  return <section className="student-exam-page choice-learning-page"><section className="word-reading-topbar"><div><span className="eyebrow">学习工具 · {title} · {book.name}</span><h1>{reviewMode ? '连续复习' : '连续练习'}</h1></div><div className="word-reading-summary"><span>{reviewMode ? '复习模式' : `已完成 ${progress.learnedCount} / ${activeQuestions.length}`}</span><span>第 {index + 1} / {reviewQuestions.length}</span></div><button type="button" className="secondary back-button" onClick={() => setBook(null)}><ChevronLeft size={16}/>返回书籍</button></section><section className="word-reading-stage choice-reading-stage"><div className="word-reading-card choice-reading-card"><span className="word-learning-index">QUESTION {String(index + 1).padStart(2,'0')}</span><h2>{visibleQuestion.question || visibleQuestion.prompt || visibleQuestion.stem || `第 ${visibleQuestion.number || index + 1} 题`}</h2><div className="exam-options">{(visibleQuestion.options || [visibleQuestion.a, visibleQuestion.b, visibleQuestion.c, visibleQuestion.d].filter(Boolean)).map((option, optionIndex) => { const value = String.fromCharCode(65 + optionIndex); return <label className={answers[visibleQuestion.id] === value ? 'selected' : ''} key={value}><input type="radio" name={visibleQuestion.id} disabled={submitted} checked={answers[visibleQuestion.id] === value} onChange={() => chooseAnswer(value)}/><b>{value}</b><span>{option}</span></label>; })}</div>{submitted && <article className={`student-exam-question choice-feedback ${isCorrect ? 'is-correct' : 'is-wrong'}`}><b>{isCorrect ? '回答正确' : '回答错误'} · 答案、解析与注记</b><p>你的答案：{selectedAnswer || '未作答'}　正确答案：{correctAnswer || '待配置'}</p><p>{visibleQuestion.analysis || visibleQuestion.memory || '本题暂未配置解析。'}</p><small>根据理解情况选择下一步。</small><div className="choice-feedback-actions"><button type="button" className="primary" onClick={next}>下一题<ChevronRight size={15}/></button><button type="button" className="secondary" onClick={markUnfamiliar}>不熟悉</button></div></article>}</div></section>{!instantFeedback && <section className="word-learning-notes"><div className="word-study-actions"><button type="button" className="primary" disabled={submitted} onClick={submit}>{submitted ? '已查看反馈' : '提交本题'}</button><button type="button" className="secondary" disabled={!submitted} onClick={next}>下一题<ChevronRight size={16}/></button></div></section>}</section>;
}

function StudentWordsPractice({student, books, selector, onBack}) {
  const normalizedBooks = books.length ? books : [{id:'english-empty-book',name:'英语单词书（待上传）',words:[]}];
  const [book, setBook] = useState(null);
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [needsHelp, setNeedsHelp] = useState(false);
  const [practiceMode, setPracticeMode] = useState('顺序');
  const [reviewDate, setReviewDate] = useState('');
  const [isSpeaking, setIsSpeaking] = useState(false);
  const isReviewMode = Boolean(reviewDate);
  const wordsFor = item => (item.words || []).map((word, wordIndex) => ({ ...word, id: word.id || `${item.id}-${wordIndex}` }));
  const startLearning = item => {
    const words = wordsFor(item);
    const progress = readLearningProgress(student?.id, 'english_words', item.id, words.length);
    setBook(item); setReviewDate(''); setIndex(Math.min(progress.nextIndex, words.length)); setFlipped(false);
  };
  const startReview = (item, date) => { setBook(item); setReviewDate(date); setIndex(0); setFlipped(false); };
  const formatReviewDate = date => {
    const [year, month, day] = String(date).split('-');
    return `${Number(month)}月${Number(day)}日`;
  };

  if (!book) return <section className="student-exam-page word-learning-page"><section className="page-head word-learning-head"><div><span className="eyebrow">学习工具 · 英语背单词</span><h1>先选择一本单词书</h1><p>开始学习会从上次未完成的位置继续。每次背过的单词会按日期保留，可随时选择任意一天进入连续复习。</p>{selector}</div><button type="button" className="secondary back-button" onClick={onBack}><ChevronLeft size={16}/>返回工具</button></section><div className="student-tools-grid">{normalizedBooks.map(item => { const itemWords=wordsFor(item); const itemProgress=readLearningProgress(student?.id,'english_words',item.id,itemWords.length); const reviewDates=Object.entries(itemProgress.dailyRecords || {}).filter(([, ids]) => Array.isArray(ids) && ids.length).sort(([a],[b]) => b.localeCompare(a)); return <article className="student-tool-card tool-english-words" key={item.id}><BookOpen size={22}/><h2>{item.name}</h2><b>已背 {itemProgress.learnedCount} / {itemWords.length}</b><p>还剩 {Math.max(0,itemWords.length-itemProgress.learnedCount)} 个</p><button type="button" className="primary" onClick={() => startLearning(item)}>开始学习<ChevronRight size={15}/></button><div className="word-review-date-list"><span>按日期复习</span>{reviewDates.length ? reviewDates.map(([date, ids]) => <button type="button" className="secondary" key={date} onClick={() => startReview(item, date)}>{formatReviewDate(date)} 背诵的 {ids.length} 个 <ChevronRight size={14}/></button>) : <small>完成背诵后，日期会自动记录在这里。</small>}</div></article>; })}</div></section>;

  const words = wordsFor(book);
  const wordProgress = readLearningProgress(student?.id, 'english_words', book.id, words.length);
  const reviewWords = isReviewMode ? words.filter(item => (wordProgress.dailyRecords?.[reviewDate] || []).includes(item.id)) : words;
  const word = reviewWords[index];
  const returnToBooks = () => { setBook(null); setReviewDate(''); setIndex(0); setFlipped(false); };
  const moveNext = () => { setFlipped(false); setNeedsHelp(false); setIndex(current => practiceMode === '随机' && reviewWords.length > 1 ? Math.floor(Math.random() * reviewWords.length) : Math.min(reviewWords.length, current + 1)); };
  const markMastered = async () => {
    if (isReviewMode || needsHelp) { moveNext(); return; }
    let nextProgress;
    try { nextProgress = await persistLearningCompletion(student?.id, 'english_words', book.id, word.id, words.length); }
    catch (error) { return window.alert(error?.message || '学习进度保存失败，请稍后重试'); }
    const nextUnlearned = words.findIndex((item, itemIndex) => itemIndex > index && !nextProgress.learnedItemIds.includes(item.id));
    setFlipped(false);
    setIndex(nextUnlearned >= 0 ? nextUnlearned : words.length);
  };

  if (!words.length) return <section className="student-exam-page"><section className="page-head"><div><span className="eyebrow">英语背单词 · {book.name}</span><h1>{book.name}</h1><p>这本单词书暂未上传单词。</p></div><button type="button" className="secondary back-button" onClick={returnToBooks}><ChevronLeft size={16}/>返回书籍</button></section><div className="empty-line"><BookOpen size={21}/><span>请等待老师上传单词，或返回选择其他书籍。</span></div></section>;
  if (!word) return <section className="student-exam-page word-learning-page"><section className="page-head"><div><span className="eyebrow">英语背单词 · {book.name}</span><h1>{isReviewMode ? `${formatReviewDate(reviewDate)}复习完成` : '本轮背诵完成'}</h1><p>{isReviewMode ? '本次日期下的单词已全部复习完成。可返回列表选择另一日期继续复习。' : '本次学习的单词已记录，可在书籍页按日期随时复习。'}</p></div><button type="button" className="secondary back-button" onClick={returnToBooks}><ChevronLeft size={16}/>返回书籍</button></section><div className="empty-line"><Check size={21}/><span>已完成，继续保持。</span></div></section>;
  const speakWord = () => { if (!word.word || !('speechSynthesis' in window)) return; window.speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance(word.word); utterance.lang='en-US'; utterance.rate=.78; utterance.onstart=()=>setIsSpeaking(true); utterance.onend=()=>setIsSpeaking(false); utterance.onerror=()=>setIsSpeaking(false); window.speechSynthesis.speak(utterance); };
  const syllables = String(word.split || '').split(/[-\s·]+/).map(item => item.trim()).filter(Boolean);
  return <section className="student-exam-page word-learning-page word-reading-page"><section className="word-reading-topbar"><div><span className="eyebrow">英语背词 · {book.name}</span><h1>{isReviewMode ? `${formatReviewDate(reviewDate)}复习` : '继续背词'}</h1></div><div className="word-reading-summary"><span>{isReviewMode ? '日期复习' : `已背 ${wordProgress.learnedCount} / ${words.length}`}</span><button type="button" className="word-mode-button" onClick={() => setPracticeMode(current => current === '顺序' ? '随机' : '顺序')}>{practiceMode === '顺序' ? '顺序' : '随机'}</button></div><button type="button" className="secondary back-button" onClick={returnToBooks}><ChevronLeft size={16}/>返回书籍</button></section><section className="word-reading-stage"><div className="word-reading-card"><span className="word-learning-index">WORD {String(index + 1).padStart(2,'0')}</span><h2>{word.word}</h2><div className="word-syllable-track word-reading-syllables">{syllables.length ? syllables.map((part,partIndex) => <React.Fragment key={`${part}-${partIndex}`}><span className="word-syllable">{part}</span>{partIndex < syllables.length - 1 && <i aria-hidden="true">-</i>}</React.Fragment>) : <span className="word-syllable is-pending">等待老师填写音节拆分</span>}</div><div className="word-reading-phonetic"><span>{word.phonetic || '音标待补充'}</span><button type="button" className={`word-speak-button ${isSpeaking ? 'is-speaking' : ''}`} onClick={speakWord}><Activity size={17}/>{isSpeaking ? '正在朗读' : '单次朗读'}</button></div><div className={`word-reading-reveal ${flipped ? 'is-revealed' : ''}`} aria-live="polite">{flipped ? <><strong className="word-reading-meaning">{word.meaning || '暂未配置中文释义'}</strong><div className="word-reading-memory"><span className="word-detail-label">记忆助剂</span><p>{word.memory || word.aiKnowledge || '老师暂未配置助记内容。'}</p></div></> : <div className="word-reading-placeholder"><span>查看中文意思与记忆助剂</span><small>点击下方“认识 · 查看释义”后显示</small></div>}</div></div><div className="word-reading-progress">进度: <b>{index + 1}/{reviewWords.length}</b><span>还剩 {Math.max(0, reviewWords.length - index - 1)} 个</span></div></section><section className="word-learning-notes"><div className="word-study-actions"><button type="button" className="secondary word-reveal-button" onClick={() => { setFlipped(true); setNeedsHelp(true); }}>{flipped ? '已显示答案与注记' : '查看答案和注记'}</button><button type="button" className="primary word-master-button" onClick={markMastered}><Check size={16}/>{isReviewMode ? '已复习，下一词' : needsHelp ? '记住了，下一词' : '已认识，下一词'}</button></div><div className={`word-memory-box ${flipped ? 'is-visible' : ''}`}><span className="word-detail-label">学习提示</span><p>{flipped ? (isReviewMode ? '点击“已复习，下一词”即可连续复习下一词。' : '确认已掌握后会立即进入下一词，并将本词记录到当天复习列表。') : '先判断是否认识，再决定是否查看释义。'}</p></div></section></section>;
}
function StudentFormulaPractice({student, books, selector, onBack}) {
  const normalizedBooks = (books || []).map(book => ({...book, items:(book.items || []).map((item, itemIndex) => ({...item, id:item.id || `${book.id}-${itemIndex}`}))}));
  const [book, setBook] = useState(null);
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState('');
  const [revealed, setRevealed] = useState(false);
  const normalizeItem = item => {
    if (!item) return {left:'', right:'', analysis:'', note:''};
    let left = item.left ?? item.prompt ?? item.name ?? '';
    let right = item.right ?? item.answer ?? '';
    if ((!left || !right) && item.formula) {
      const parts = String(item.formula).split('=');
      left = left || parts.shift();
      right = right || parts.join('=');
    }
    return {left:String(left).trim(), right:String(right).trim(), analysis:String(item.analysis ?? item.explanation ?? '').trim(), note:String(item.note ?? item.memory ?? '').trim()};
  };
  const chooseBook = item => {
    const progress = readLearningProgress(student?.id, 'math_formulas', item.id, (item.items || []).length);
    setBook(item); setIndex(Math.min(progress.nextIndex, (item.items || []).length)); setAnswer(''); setRevealed(false);
  };
  const returnToBooks = () => { setBook(null); setIndex(0); setAnswer(''); setRevealed(false); };
  const items = book?.items || [];
  const current = normalizeItem(items[index]);
  const moveNext = () => { setAnswer(''); setRevealed(false); setIndex(value => Math.min(items.length, value + 1)); };
  const markKnown = async () => {
    if (!current.left && !current.right) return;
    try { await persistLearningCompletion(student?.id, 'math_formulas', book.id, items[index].id, items.length); }
    catch (error) { return window.alert(error?.message || '学习进度保存失败，请稍后重试'); }
    const progress = readLearningProgress(student?.id, 'math_formulas', book.id, items.length);
    const nextIndex = items.findIndex((item, itemIndex) => itemIndex > index && !progress.learnedItemIds.includes(item.id));
    setAnswer(''); setRevealed(false); setIndex(nextIndex >= 0 ? nextIndex : items.length);
  };
  if (!book) return <section className="student-exam-page word-learning-page"><section className="page-head word-learning-head"><div><span className="eyebrow">学习工具 · 数学背公式</span><h1>先选择一本公式书</h1><p>教师上传的公式按书籍独立维护。选择一本书后，从上次未完成的位置继续学习。</p>{selector}</div><button type="button" className="secondary back-button" onClick={onBack}><ChevronLeft size={16}/>返回工具</button></section><div className="student-tools-grid formula-book-grid">{normalizedBooks.length ? normalizedBooks.map(item => { const progress = readLearningProgress(student?.id, 'math_formulas', item.id, (item.items || []).length); return <article className="student-tool-card formula-book-card" key={item.id}><BookOpen size={22}/><span className="eyebrow">数学公式书</span><h2>{item.name || '未命名公式书'}</h2><b>已掌握 {progress.learnedCount} / {(item.items || []).length} 条</b><p>{(item.items || []).length ? `还剩 ${Math.max(0, (item.items || []).length - progress.learnedCount)} 条公式` : '尚未导入公式'}</p><button type="button" className="primary" onClick={() => chooseBook(item)}>开始学习<ChevronRight size={15}/></button></article>; }) : <div className="empty-line"><BookOpen size={21}/><span>教师端尚未创建公式书或导入公式。</span></div>}</div></section>;
  if (!items.length) return <section className="student-exam-page word-learning-page"><section className="page-head"><div><span className="eyebrow">数学公式书 · {book.name}</span><h1>这本书还没有公式</h1><p>请等待老师上传公式，或返回选择其他公式书。</p></div><button type="button" className="secondary back-button" onClick={returnToBooks}><ChevronLeft size={16}/>返回书籍</button></section><div className="empty-line"><BookOpen size={21}/><span>暂未配置可学习内容。</span></div></section>;
  if (!items[index]) return <section className="student-exam-page word-learning-page"><section className="page-head"><div><span className="eyebrow">数学公式书 · {book.name}</span><h1>本轮公式学习完成</h1><p>你已完成这本公式书的本轮学习，可以返回书籍列表继续选择。</p></div><button type="button" className="secondary back-button" onClick={returnToBooks}><ChevronLeft size={16}/>返回书籍</button></section><div className="empty-line"><Check size={21}/><span>已完成，继续保持。</span></div></section>;
  return <section className="student-exam-page word-learning-page word-reading-page formula-practice-layout"><section className="word-reading-topbar"><div><span className="eyebrow">数学公式书 · {book.name}</span><h1>连续背公式</h1></div><div className="word-reading-summary"><span>已掌握 {readLearningProgress(student?.id, 'math_formulas', book.id, items.length).learnedCount} / {items.length}</span><span>第 {index + 1} / {items.length}</span></div><button type="button" className="secondary back-button" onClick={returnToBooks}><ChevronLeft size={16}/>返回书籍</button></section><section className="word-reading-stage"><div className="word-reading-card formula-reading-card"><span className="word-learning-index">FORMULA {String(index + 1).padStart(2,'0')}</span><h2><MathFormula value={current.left || '等号左边待配置'}/> <span className="formula-equals">=</span></h2><label className="formula-answer-label" htmlFor="formula-answer">填写等号右边</label><input id="formula-answer" className="formula-answer-input" value={answer} onChange={event => setAnswer(event.target.value)} placeholder="请输入公式右边" autoComplete="off"/><div className={`formula-answer-panel ${revealed ? 'is-visible' : ''}`} aria-live="polite">{revealed ? <><strong>正确答案：<MathFormula value={current.right || '暂未配置'}/></strong><p>{current.analysis || '老师暂未配置解析。'}</p>{current.note && <small>注记：{current.note}</small>}</> : <div className="word-reading-placeholder"><span>先填写你的答案</span><small>点击“查看答案和解析”后显示参考答案</small></div>}</div></div><div className="word-reading-progress">进度: <b>{index + 1}/{items.length}</b><span>还剩 {Math.max(0, items.length - index - 1)} 条</span></div></section><section className="word-learning-notes"><div className="word-study-actions"><button type="button" className="secondary word-reveal-button" onClick={() => setRevealed(true)}>{revealed ? '已显示答案和解析' : '查看答案和解析'}</button><button type="button" className="primary word-master-button" onClick={markKnown}><Check size={16}/>已认识，下一个公式</button></div><div className="word-memory-box"><span className="word-detail-label">学习提示</span><p>可以先独立写出等号右边；确认认识后，点击“已认识，下一个公式”继续。</p></div></section></section>;
}

function StudentTools({enrolledSubjects, applicationData, selector, aiSettings, onOpenTutor, onOpenCompanion, onOpenPolitics, onOpenEnglishWords, onOpenEnglishChoice, onOpenMathFormulas, onOpenMathPractice}) {
  const data = applicationData || loadApplicationData();
  const hasPolitics = enrolledSubjects.some(item => item.name.includes('政治'));
  const hasEnglish = enrolledSubjects.some(item => item.name.includes('英语'));
  const hasMath = enrolledSubjects.some(item => item.name.includes('数学'));
  const tutorReady = isAiSlotReady(aiSettings, 'question_tutor');
  const politicsCount = data.politicsBooks.reduce((total, book) => total + (book.questions || []).length, 0);
  const englishWordsCount = data.englishBooks.reduce((total, book) => total + (book.words || []).length, 0);
  const tools = [
    // 三项基础工具与报考状态无关，所有学生均可使用。
    {id:'politics', title:'政治背肖1000', enabled:true, count:politicsCount, note:'基础练习永久开放；选择政治题库后开始逐题练习。', action:onOpenPolitics, actionLabel:'选择题库', permanent:true},
    {id:'english-words', title:'英语背单词', enabled:true, count:englishWordsCount, note:'基础学习永久开放；选择单词书后开始记忆。', action:onOpenEnglishWords, actionLabel:'选择书籍', permanent:true},
    {id:'math-formulas', title:'数学背公式', enabled:true, count:data.mathItems.formula.reduce((total, book) => total + (book.items || []).length, 0), note:'选择公式书后开始连续记忆；教师上传的公式会按书籍展示。', action:onOpenMathFormulas, actionLabel:'选择书籍', permanent:true},
    // “大学”区域工具始终展示，但严格按报名科目解锁。
    {id:'tutor', title:'逐步讲解', enabled:hasPolitics || hasEnglish || hasMath, count:null, note:(hasPolitics || hasEnglish || hasMath) ? '已按你的报名科目开放，可上传对应科目题目查看分步讲解。' : '请先报名政治、英语或数学后使用。', action:(hasPolitics || hasEnglish || hasMath) ? onOpenTutor : null, actionLabel:'上传题目讲题', highlight:true},
    {id:'english-choice', title:'英语选择题', enabled:hasEnglish, count:data.englishChoiceBooks.reduce((total, book) => total + (book.questions || []).length, 0), note:hasEnglish ? '已报名英语，可选择题库开始练习。' : '仅已报名英语的同学可使用。', action:hasEnglish ? onOpenEnglishChoice : null, actionLabel:'选择题库'},
    {id:'math-practice', title:'数学专项练习', enabled:hasMath, count:null, note:hasMath ? '已报名数学，题库配置完成后可进入专项练习。' : '仅已报名数学的同学可使用。', action:hasMath ? onOpenMathPractice : null, actionLabel:'进入练习'}
  ];
  const visibleTools = tools;
  return <>
    <section className="page-head">
      <div>
        <span className="eyebrow">我的学习工具 · 教师上传</span>
        <h1>基础工具永久开放，进阶工具按报名科目开放。</h1>
        <p>全部工具都会显示；标记为“暂未开放”的工具需要完成对应报名或由老师配置后才能使用。</p>
        {selector}
      </div>
    </section>
    <div className="student-tools-grid">
      {visibleTools.map(tool => (
        <article className={`student-tool-card tool-${tool.id} ${tool.highlight ? 'is-tutor' : ''}`} key={tool.id || tool.title}>
          {tool.highlight ? <ImagePlus size={22}/> : <BookOpen size={22}/>}
          <h2>{tool.title}</h2>
          <b>
            {tool.highlight
              ? (tutorReady ? '可以开始讲题' : '暂未开放')
              : (tool.permanent ? '永久开放' : (tool.enabled ? (tool.count ? `${tool.count} 项可学习内容` : '已开放') : '暂未开放'))}
          </b>
          <p>{tool.note}</p>
          {tool.action ? (
            <button type="button" className="primary" onClick={tool.action}>
              {tool.actionLabel}
              <ChevronRight size={15}/>
            </button>
          ) : <button type="button" className="secondary" disabled>暂未开放</button>}
        </article>
      ))}
    </div>
    {!visibleTools.length && <div className="empty-line"><PackageOpen size={21}/><span>尚未开通可使用的学习工具。</span></div>}
  </>;
}

const formatCompanionTime = seconds => `${String(Math.floor(Math.max(0, seconds) / 60)).padStart(2, '0')}:${String(Math.max(0, seconds) % 60).padStart(2, '0')}`;

const DEMO_COMPANION_BOOKS = [
  {id:'demo-companion-politics', subject:'政治', name:'政治基础训练（演示）', description:'用于本地演示分类、书籍、题目和计时流程。', questionCount:2, companionEnabled:true, demo:true, questions:[
    {id:'demo-politics-1', questionNumber:1, stem:'马克思主义哲学区别于旧哲学的根本标志是强调：', durationSeconds:900, knowledgePoint:'实践观点是马克思主义哲学的核心观点。', halfHint:'注意区分实践与一般经验。', answer:'实践', analysis:'实践观点是马克思主义哲学首要的和基本的观点。'},
    {id:'demo-politics-2', questionNumber:2, stem:'社会主义的本质要求最终体现在：', durationSeconds:900, knowledgePoint:'共同富裕是社会主义的本质要求。', halfHint:'关注发展成果由人民共享。', answer:'共同富裕', analysis:'共同富裕是社会主义的本质要求和最终目标。'}
  ]},
  {id:'demo-companion-politics-2', subject:'政治', name:'政治时政专题（演示）', description:'另一套政治专题书籍，用于验证多书籍选择。', questionCount:1, companionEnabled:true, demo:true, questions:[
    {id:'demo-politics-3', questionNumber:1, stem:'推进中国式现代化必须坚持的首要原则是：', durationSeconds:1200, knowledgePoint:'坚持中国共产党的领导。', halfHint:'先判断政治方向和根本保证。', answer:'坚持中国共产党的领导', analysis:'党的领导是中国式现代化的根本保证。'}
  ]},
  {id:'demo-companion-english', subject:'英语', name:'英语阅读基础（演示）', description:'用于本地演示英语代学流程。', questionCount:2, companionEnabled:true, demo:true, questions:[
    {id:'demo-english-1', questionNumber:1, stem:'The word “maintain” is closest in meaning to _____.', durationSeconds:900, knowledgePoint:'maintain 表示维持、保持。', halfHint:'从上下文寻找 preserve 的同义关系。', answer:'preserve', analysis:'maintain 与 preserve 都有保持、维持之意。'},
    {id:'demo-english-2', questionNumber:2, stem:'Practice makes progress. The sentence mainly emphasizes _____.', durationSeconds:900, knowledgePoint:'理解句子主旨和抽象含义。', halfHint:'关注 practice 与 progress 的因果关系。', answer:'the value of regular practice', analysis:'句意为熟能生巧，强调持续练习的价值。'}
  ]},
  {id:'demo-companion-english-2', subject:'英语', name:'英语语法专题（演示）', description:'覆盖从句、非谓语等语法知识点。', questionCount:1, companionEnabled:true, demo:true, questions:[
    {id:'demo-english-3', questionNumber:1, stem:'The book _____ on the desk belongs to me.', durationSeconds:1200, knowledgePoint:'现在分词短语作后置定语。', halfHint:'判断 book 与动作之间的主动关系。', answer:'lying', analysis:'lying on the desk 作后置定语修饰 the book。'}
  ]},
  {id:'demo-companion-math', subject:'数学', name:'高数基础训练（演示）', description:'用于本地演示数学代学流程。', questionCount:2, companionEnabled:true, demo:true, questions:[
    {id:'demo-math-1', questionNumber:1, stem:'若 f(x)=x²，则 f′(x) 等于：', durationSeconds:900, knowledgePoint:'幂函数求导公式。', halfHint:'使用 (xⁿ)′=nxⁿ⁻¹。', answer:'2x', analysis:'由幂函数求导公式可得 f′(x)=2x。'},
    {id:'demo-math-2', questionNumber:2, stem:'∫ 2x dx 的结果是：', durationSeconds:900, knowledgePoint:'不定积分与积分常数。', halfHint:'先求原函数，再补上积分常数。', answer:'x²+C', analysis:'∫2x dx=x²+C。'}
  ]},
  {id:'demo-companion-math-2', subject:'数学', name:'数学线代专题（演示）', description:'覆盖矩阵与线性方程组基础。', questionCount:1, companionEnabled:true, demo:true, questions:[
    {id:'demo-math-3', questionNumber:1, stem:'矩阵可逆的充要条件是其行列式：', durationSeconds:1200, knowledgePoint:'可逆矩阵与行列式的关系。', halfHint:'回忆方阵可逆的判定条件。', answer:'不等于 0', analysis:'方阵可逆当且仅当其行列式不等于 0。'}
  ]}
];

function CompanionStudy({student, notify, onBack}) {
  const enrolledSubjects = new Set((student?.subjects || []).filter(item => item.enrolled).map(item => normalizeStudentSubject(item.name)));
  const [books, setBooks] = useState([]); const [questions, setQuestions] = useState([]); const [subject, setSubject] = useState(null); const [book, setBook] = useState(null); const [session, setSession] = useState(null); const [speedMode, setSpeedMode] = useState('合适'); const [step, setStep] = useState('subject'); const [reviewMode, setReviewMode] = useState(false); const [isFullscreen, setIsFullscreen] = useState(false); const questionSurfaceRef = useRef(null); const sessionProgressSyncRef = useRef(''); const [state, setState] = useState({loading:true,error:'',busy:false});
  const localMode = !isApiConfigured();
  const loadBooks = async () => { setState(current => ({...current,loading:true,error:''})); if (localMode) { setBooks(DEMO_COMPANION_BOOKS); setState({loading:false,error:'',busy:false}); return; } try { setBooks((await apiRequest('/api/companion-study/books')).map(item => ({ ...item, subject: normalizeStudentSubject(item.subject || item.category) }))); setState({loading:false,error:'',busy:false}); } catch (error) { setState({loading:false,error:error.message || '代学书籍加载失败',busy:false}); } };
  useEffect(() => { loadBooks(); }, []);
  useEffect(() => { if (!book) return; setState(current => ({...current,loading:true,error:''})); if (localMode) { setQuestions(book.questions || []); setState({loading:false,error:'',busy:false}); return; } apiRequest(`/api/companion-study/books/${book.id}/questions`).then(data => { setQuestions((Array.isArray(data) ? data : []).map(item => ({ ...item, subject: normalizeStudentSubject(item.subject || book.subject) }))); setState({loading:false,error:'',busy:false}); }).catch(error => setState({loading:false,error:error.message || '题目加载失败',busy:false})); }, [book]);
  useEffect(() => { if (!session || session.showAnswer || localMode) return undefined; const timer = window.setInterval(() => apiRequest(`/api/companion-study/sessions/${session.id}`).then(setSession).catch(error => setState(current => ({...current,error:error.message || '学习状态刷新失败'}))),1000); return () => window.clearInterval(timer); }, [session?.id,session?.showAnswer,localMode]);
  useEffect(() => { if (!session || !localMode || session.showAnswer) return undefined; const timer = window.setInterval(() => setSession(current => { const remainingSeconds = Math.max(0,current.remainingSeconds - 1); const elapsedSeconds = current.elapsedSeconds + 1; const completed = remainingSeconds <= 0; if (completed && !isApiConfigured()) recordLearningCompletion(student?.id, COMPANION_STUDY_RESOURCE_TYPE, book.id, current.questionId, questions.length); return {...current,remainingSeconds,elapsedSeconds,showKnowledgePoint:remainingSeconds <= 600,showHalfHint:elapsedSeconds >= current.effectiveDurationSeconds / 2,showAnswer:completed}; }),1000); return () => window.clearInterval(timer); }, [session?.id,session?.showAnswer,localMode,student?.id,book?.id,questions.length]);
  // Completion is persisted and then re-read from the server. The local timer
  // is only a presentation aid and never the final source of truth.
  useEffect(() => {
    if (localMode || !session?.showAnswer || !student?.id || !book?.id || !session?.questionId) return undefined;
    const syncKey = `${session.id}:${session.questionId}`;
    if (sessionProgressSyncRef.current === syncKey) return undefined;
    sessionProgressSyncRef.current = syncKey;
    (async () => {
      try {
        await persistLearningCompletion(student.id, COMPANION_STUDY_RESOURCE_TYPE, book.id, session.questionId, questions.length);
        await refreshServerLearningProgress(student.id, COMPANION_STUDY_RESOURCE_TYPE, book.id, questions.length);
      } catch (error) {
        sessionProgressSyncRef.current = '';
        setState(current => ({ ...current, error: error?.message || '学习完成状态同步失败，请重试' }));
      }
    })();
    return undefined;
  }, [localMode, session?.id, session?.showAnswer, session?.questionId, student?.id, book?.id, questions.length]);
  useEffect(() => { if (!questionSurfaceRef.current) return undefined; const syncFullscreen = () => setIsFullscreen(document.fullscreenElement === questionSurfaceRef.current); document.addEventListener('fullscreenchange', syncFullscreen); return () => document.removeEventListener('fullscreenchange', syncFullscreen); }, []);
  const toggleFullscreen = async () => { if (!questionSurfaceRef.current) return; try { if (document.fullscreenElement === questionSurfaceRef.current) await document.exitFullscreen(); else await questionSurfaceRef.current.requestFullscreen(); } catch (error) { notify?.('当前浏览器不支持全屏，仍可继续使用放大版题目页面'); } };
  const start = async question => { setState(current => ({...current,busy:true,error:''})); if (localMode) { const multiplier = speedMode === '基础' ? 2 : speedMode === '适中' ? 1.5 : 1; const effectiveDurationSeconds = Math.ceil((question.durationSeconds || 30) * multiplier); setSession({id:`local-session-${Date.now()}`,questionId:question.id,question:{...question,bookName:book.name},speedMode,remainingSeconds:effectiveDurationSeconds,elapsedSeconds:0,effectiveDurationSeconds,showKnowledgePoint:false,showHalfHint:false,showAnswer:false}); setState({loading:false,error:'',busy:false}); return; } try { setSession(await apiRequest(`/api/companion-study/questions/${question.id}/sessions`,{method:'POST',body:{speedMode}})); setState({loading:false,error:'',busy:false}); } catch (error) { setState({loading:false,error:error.message || '无法开始本题学习',busy:false}); } };
  const finish = async () => { if (!session || session.showAnswer) return; setState(current => ({...current,busy:true})); if (localMode) { recordLearningCompletion(student?.id, COMPANION_STUDY_RESOURCE_TYPE, book.id, session.questionId, questions.length); setSession(current => ({...current,remainingSeconds:0,showKnowledgePoint:true,showHalfHint:true,showAnswer:true})); setState(current => ({...current,busy:false})); return; } try { setSession(await apiRequest(`/api/companion-study/sessions/${session.id}`,{method:'PATCH',body:{action:'提前结束'}})); setState(current => ({...current,busy:false})); } catch (error) { setState(current => ({...current,busy:false,error:error.message || '提前结束失败'})); } };
  const move = direction => { const list = visibleQuestions; const index = list.findIndex(item => item.id === session?.questionId); const target = list[index + direction]; if (target) start(target); };
  const selectBook = item => { setBook(item); setQuestions([]); setReviewMode(false); setStep('speed'); };
  const backFromSession = () => { setSession(null); setStep('questions'); };
  if (session) { const question = session.question || {}; const index = visibleQuestions.findIndex(item => item.id === session.questionId); return <section className="student-exam-page companion-study-page"><section className="page-head companion-study-head"><div><span className="eyebrow">学习工具 · 代学 · {subject}</span><h1>{question.bookName} · 第 {question.questionNumber} 题</h1><p>{localMode ? '本地演示计时：状态仅保存在当前页面，不写入服务端。' : '倒计时与内容开放状态由服务端时间决定。'}</p></div><button type="button" className="secondary back-button" onClick={backFromSession}><ChevronLeft size={16}/>返回题目列表</button></section><section ref={questionSurfaceRef} className={`panel student-exam-panel companion-question-surface ${isFullscreen ? 'is-fullscreen' : ''}`}><div className="companion-session-bar"><div className="companion-timer"><span>本题剩余时间</span><b>{formatCompanionTime(session.remainingSeconds)}</b><small>{session.speedMode}做题风格 · 已用 {formatCompanionTime(session.elapsedSeconds)}</small></div><div className="companion-session-actions"><button type="button" className="secondary" onClick={toggleFullscreen}>{isFullscreen ? <Minimize2 size={16}/> : <Maximize2 size={16}/>} {isFullscreen ? '退出全屏' : '全屏显示'}</button>{!session.showAnswer && <button type="button" className="secondary" disabled={state.busy} onClick={finish}>提前结束</button>}</div></div><article className="student-exam-question companion-main-question"><span className="companion-section-kicker">QUESTION {String(question.questionNumber).padStart(2,'0')}</span><b>{question.stem}</b></article>{session.showKnowledgePoint && <article className="student-exam-question companion-reveal companion-knowledge"><span className="companion-section-kicker">10% 提示 · 知识点</span><p>{question.knowledgePoint || '本题暂未配置知识点提示。'}</p></article>}{session.showHalfHint && <article className="student-exam-question companion-reveal companion-hint"><span className="companion-section-kicker">50% 提示 · 解题方向</span><p>{question.halfHint || '本题暂未配置半程提示。'}</p></article>}{session.showAnswer && <article className="student-exam-question companion-reveal companion-answer"><span className="companion-section-kicker">答案与解析</span><p><b>答案</b>{question.answer || '本题暂未配置答案。'}</p><p><b>解析</b>{question.analysis || '本题暂未配置解析。'}</p></article>}<div className="companion-question-nav"><button type="button" className="secondary" disabled={index <= 0 || state.busy} onClick={() => move(-1)}><ChevronLeft size={16}/>上一题</button><span>第 {index + 1} / {questions.length} 题</span><button type="button" className="primary" disabled={index < 0 || index >= questions.length - 1 || state.busy} onClick={() => move(1)}>下一题<ChevronRight size={16}/></button></div></section></section>; }
  const visibleBooks = subject ? books.filter(item => normalizeStudentSubject(item.subject || item.category) === normalizeStudentSubject(subject)) : [];
  const bookProgress = book ? readLearningProgress(student?.id, COMPANION_STUDY_RESOURCE_TYPE, book.id, questions.length) : null;
  const visibleQuestions = reviewMode && bookProgress ? questions.filter(item => bookProgress.yesterdayItemIds.includes(item.id)) : questions;
  const startSelectedBook = () => { if (!questions.length) return notify?.('该书籍暂未发布题目'); setStep('questions'); };
  const startReview = () => { const current = readLearningProgress(student?.id, COMPANION_STUDY_RESOURCE_TYPE, book.id, questions.length); if (!current.yesterdayItemIds.length) return notify?.('昨天没有已完成的代学题目可复习'); setReviewMode(true); setStep('questions'); };
  const resetToSubjects = () => { setSubject(null); setBook(null); setQuestions([]); setStep('subject'); };
  return <section className="student-exam-page"><section className="page-head"><div><span className="eyebrow">学习工具 · 代学</span><h1>{!subject ? '先选择科目，再选择书籍。' : !book ? `${subject} · 选择书籍` : step === 'speed' ? `${book.name} · 选择做题风格` : `${book.name} · ${reviewMode ? '复习昨日题目' : '题目列表'}`}</h1><p>{localMode ? '当前为本地演示模式，学习完成进度保存在本机。' : '已连接服务端；书籍、题目和计时会话均来自服务端数据，内容进度接口待接入。'}</p></div><button type="button" className="secondary back-button" onClick={!subject ? onBack : !book ? () => { setSubject(null); setStep('subject'); } : step === 'speed' ? () => { setBook(null); setQuestions([]); setStep('book'); } : () => { setStep('speed'); setSession(null); }}><ChevronLeft size={16}/>{!subject ? '返回工具' : !book ? '返回科目' : step === 'speed' ? '返回书籍' : '返回做题风格'}</button></section>{state.error && <div className="empty-line"><CircleHelp size={21}/><span>{state.error}</span><button type="button" className="secondary" onClick={loadBooks}>重新加载</button></div>}{state.loading ? <div className="empty-line"><Clock3 size={21}/><span>正在加载代学内容…</span></div> : !subject ? <div className="student-tools-grid">{['政治','英语','数学'].map(item => { const available = enrolledSubjects.has(item); return <article className="student-tool-card" key={item}><BookOpen size={22}/><h2>{item}</h2><p>{available ? `进入${item}代学书籍。` : `仅已报名${item}的同学可使用。`}</p><button type="button" className={available ? 'primary' : 'secondary'} disabled={!available} onClick={() => { if (available) { setSubject(item); setStep('book'); } }}>{available ? '选择科目' : '暂未开放'}<ChevronRight size={15}/></button></article>; })}</div> : !book ? <div className="student-tools-grid">{visibleBooks.map(item => { const itemProgress=readLearningProgress(student?.id,COMPANION_STUDY_RESOURCE_TYPE,item.id,item.questionCount || 0); return <article className="student-tool-card" key={item.id}><BookOpen size={22}/><h2>{item.name}</h2><b>{item.subject} · 已完成 {itemProgress.learnedCount} / {item.questionCount || 0} 题</b><p>还剩 {Math.max(0,(item.questionCount || 0)-itemProgress.learnedCount)} 题 · 昨日完成 {itemProgress.yesterdayItemIds.length} 题</p><button type="button" className="primary" onClick={() => selectBook(item)}>开始学习<ChevronRight size={15}/></button></article>; })}{!visibleBooks.length && <div className="empty-line"><FileQuestion size={21}/><span>该科目暂未配置可用书籍。</span></div>}</div> : step === 'speed' ? <section className="panel student-exam-panel companion-speed-panel"><div className="companion-speed-intro"><b>先选择本次做题风格</b><p>书籍中的原始时长按“合适”风格配置；选择后点击开始做题，才会进入题目列表。</p></div><div className="tutor-subject-row">{[['基础','2 倍时长'],['适中','1.5 倍时长'],['合适','正常时长']].map(([value,label]) => <button type="button" className={speedMode === value ? 'active' : ''} key={value} onClick={() => setSpeedMode(value)}><b>{value}</b><span>{label}</span></button>)}</div><button type="button" className="primary companion-start-button" disabled={state.loading || !questions.length} onClick={startSelectedBook}><Play size={17}/>{reviewMode ? '开始复习昨日' : '开始学习'}</button>{!reviewMode && <button type="button" className="secondary" disabled={state.loading || !questions.length || !bookProgress?.yesterdayItemIds.length} onClick={startReview}>复习昨日</button>}</section> : <section className="panel student-exam-panel"><div className="student-exam-list">{visibleQuestions.map(item => <article className="student-exam-question" key={item.id}><b>第 {item.questionNumber} 题</b><span>{item.stem || '本题未设置题干'}</span><button type="button" className="secondary" disabled={state.busy} onClick={() => start(item)}>开始计时</button></article>)}</div>{!questions.length && <div className="empty-line"><FileQuestion size={21}/><span>该书籍暂未发布题目。</span></div>}</section>}</section>;
}

function StudentQuestionTutor({student, setStudents, knowledgeBase, aiSettings, notify, selector, onBack}) {
  const [subject, setSubject] = useState(() => {
    const enrolled = (student?.subjects || []).filter(item => item.enrolled).map(item => item.name);
    if (enrolled.some(name => name.includes('数学'))) return '数学';
    if (enrolled.some(name => name.includes('英语'))) return '英语';
    if (enrolled.some(name => name.includes('政治'))) return '政治';
    return '综合';
  });
  const [note, setNote] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');
  const [fileMeta, setFileMeta] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const fileInputRef = useRef(null);
  const enrolledSubjects = new Set((student?.subjects || []).filter(item => item.enrolled).map(item => normalizeStudentSubject(item.name)));
  const selectableTutorSubjects = ['数学', '英语', '政治', '专业课'].filter(item => enrolledSubjects.has(item));
  const tutorReady = isAiSlotReady(aiSettings, 'question_tutor');
  const matchingBooks = (knowledgeBase || []).filter(item => item.subject === subject || (subject === '综合' && ['政治','英语','数学','专业课'].includes(item.subject)));
  const markAsWrong = async () => {
    if (!result) return;
    const title = note.trim() || fileMeta?.name || '未命名题目';
    if (isApiConfigured()) {
      try {
        await apiRequest(`/api/students/${student.id}/wrong-questions`, {
          method: 'POST',
          body: {
            subject,
            questionText: title,
            analysis: '由学生在难题逐步讲解页面手动归档；真实 AI 讲解尚未接入。',
            sourceLabel: fileMeta?.name || '难题逐步讲解'
          }
        });
        setStudents(current => current.map(item => String(item.id) === String(student?.id) ? { ...item, wrongBook: [{ id: `wrong-${Date.now()}`, subject, title, analysis: '', status: 'active', reviewCount: 0, createdAt: new Date().toISOString() }, ...(item.wrongBook || [])] } : item));
        notify('已归档到云端错题本');
      } catch (error) {
        notify(error?.message || '错题归档失败，请稍后重试');
      }
      return;
    }
    const entry = {id:`wrong-${Date.now()}`, subject, title, imageName:fileMeta?.name || '', createdAt:new Date().toISOString(), tutorResultId:result.id};
    setStudents(current => current.map(item => String(item.id) === String(student?.id) ? {...item, wrongBook:[entry, ...(item.wrongBook || [])]} : item));
    notify('已标记并归入错题本');
  };

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const clearImage = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl('');
    setFileMeta(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const onPickFile = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      notify('请上传题目图片（jpg / png / webp 等）');
      event.target.value = '';
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      notify('图片请控制在 12MB 以内');
      event.target.value = '';
      return;
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    setFileMeta({ name: file.name, size: file.size, type: file.type });
    setResult(null);
  };

  const runTutor = () => {
    if (!previewUrl || !fileMeta) return notify('请先上传题目截图或照片');
    if (!tutorReady) {
      return notify('该功能暂未开放，请联系老师');
    }
    if (isApiConfigured()) {
      return notify('当前已配置监管规则，但服务端 AI 执行器尚未接入，暂不能生成真实讲解');
    }
    setBusy(true);
    window.setTimeout(() => {
      const draft = buildQuestionTutorDraft({
        subject,
        note,
        fileName: fileMeta.name,
      });
      setResult(draft);
      setBusy(false);
      notify('讲解已生成');
    }, 720);
  };

  return <>
    <section className="page-head">
      <div>
        <span className="eyebrow">学习工具 · 难题逐步讲解</span>
        <h1>拍题 / 截图，拿到一步一步的详解。</h1>
        <p>上传题目图片后，可查看审题、思路、步骤、答案与易错点。{matchingBooks.length ? ` 本次会优先参考已收录的 ${matchingBooks.length} 本${subject}资料。` : '当前没有匹配的已收录资料，讲解会在上线后的服务端检索流程中补充可靠来源。'}</p>
        {selector}
      </div>
      <button type="button" className="secondary back-button" onClick={onBack}><ChevronLeft size={16}/>返回工具</button>
    </section>

    <section className={`panel tutor-status-panel ${tutorReady ? 'is-ready' : 'is-waiting'}`}>
      <div className="tutor-status-main">
        <span className={`badge ${tutorReady ? 'ok' : 'warn'}`}>{tutorReady ? '功能已开放' : '暂未开放'}</span>
        <h2>{tutorReady ? '上传图片，获取分步讲解' : '请等待老师开放该功能'}</h2>
        <p>{tutorReady ? '选择题目科目后上传清晰图片，即可开始讲解。' : '开放后可在这里上传题目图片并查看分步讲解。'}</p>
      </div>
      <div className="tutor-status-meta">
        <small>学员</small>
        <b>{student?.name || '未选择'}</b>
        <small>科目</small>
        <b>{subject}</b>
      </div>
    </section>

    <div className="tutor-layout">
      <section className="panel tutor-upload-panel">
        <PanelHead title="上传题目图片"/>
        <div className="tutor-subject-row">
          {(selectableTutorSubjects.length ? selectableTutorSubjects : ['综合']).map(item => (
            <button
              type="button"
              key={item}
              className={subject === item ? 'active' : ''}
              onClick={() => setSubject(item)}
            >
              {item}
            </button>
          ))}
        </div>

        <label className={`tutor-dropzone ${previewUrl ? 'has-preview' : ''}`}>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={onPickFile}
          />
          {previewUrl ? (
            <img src={previewUrl} alt="题目预览" className="tutor-preview-image"/>
          ) : (
            <div className="tutor-dropzone-empty">
              <Upload size={28}/>
              <b>点击选择题目截图 / 照片</b>
              <span>支持 jpg、png、webp；建议清晰、题干完整、光线均匀</span>
            </div>
          )}
        </label>

        {fileMeta && (
          <div className="tutor-file-meta">
            <span>{fileMeta.name}</span>
            <small>{(fileMeta.size / 1024).toFixed(1)} KB</small>
            <button type="button" className="quiet-button" onClick={clearImage}>更换图片</button>
          </div>
        )}

        <label className="tutor-note-label">
          补充说明（可选）
          <textarea
            value={note}
            onChange={event => setNote(event.target.value)}
            placeholder="例如：卡在第二问积分上下限；或：不知道长难句哪里断开"
            rows={3}
          />
        </label>

        <div className="form-footer tutor-actions">
          <button type="button" className="secondary" onClick={clearImage} disabled={!previewUrl || busy}>清空</button>
          <button type="button" className="primary" onClick={runTutor} disabled={busy || !previewUrl}>
            {busy ? '正在整理讲解…' : (tutorReady ? '开始逐步讲解' : '暂未开放')}
            <Sparkles size={15}/>
          </button>
        </div>
      </section>

      <section className="panel tutor-result-panel">
        <div className="panel-head">
          <h2>分步详解</h2>
          <span className="tutor-result-meta-label">{result ? '讲解完成' : '等待上传'}</span>
        </div>
        {!result && (
          <div className="tutor-result-empty">
            <ImagePlus size={28}/>
            <h3>还没有讲解结果</h3>
            <p>上传题目图片并点击「开始逐步讲解」。结果会按审题 → 考点 → 步骤 → 答案 → 易错点展开，方便对照复查，而不是只甩一个最终答案。</p>
          </div>
        )}
        {result && (
          <div className="tutor-result-body">
            <div className="tutor-result-summary">
              <span className="badge ok">{result.subject}</span>
              <h3>{result.summary}</h3>
              <p><b>识别 / 备注：</b>{result.recognizedText}</p>
            </div>
            <ol className="tutor-step-list">
              {result.steps.map((step, index) => (
                <li key={step.title}>
                  <div className="tutor-step-index">{String(index + 1).padStart(2, '0')}</div>
                  <div className="tutor-step-content">
                    <h4>{step.title}</h4>
                    <p>{step.detail}</p>
                    {step.tip && <small>提示：{step.tip}</small>}
                  </div>
                </li>
              ))}
            </ol>
            <div className="tutor-final-answer">
              <span>最终答案（摘要）</span>
              <b>{result.finalAnswer}</b>
            </div>
            <p className="tutor-result-footnote">
              讲解结果仅供学习参考，请结合课程内容与老师讲解复核。
            </p>
            <button type="button" className="secondary" onClick={markAsWrong}>不会做，加入错题本</button>
          </div>
        )}
      </section>
    </div>
  </>;
}

function StudentAssignedTasks({student, plans, setStudents, notify, selector, aiSettings, initialView = 'today', onOpenFutureSevenDays}) {
  const [viewMode, setViewMode] = useState(initialView === 'future' ? 'future' : 'today');
  const [taskProgressTarget, setTaskProgressTarget] = useState(null);
  useEffect(() => {
    setViewMode(initialView === 'future' ? 'future' : 'today');
  }, [initialView, student?.id]);
  const restToday = isRestDayToday(student);
  // 按完成进度推进：未完成项次日继续；整行完成后才推下一行新任务
  const unlockedPlans = getUnlockedPlans(plans);
  const unlockedIdSet = new Set(unlockedPlans.map(plan => String(plan.id)));
  const lockedPlans = (plans || []).filter(
    plan => !unlockedIdSet.has(String(plan.id))
  );
  const completedPlanIds = new Set(
    (plans || []).filter(plan => isPlanFullyComplete(plan)).map(plan => String(plan.id))
  );
  // 包含今天及其后 7 个学习日：今日单独显示，未来视图严格显示后续 7 天。
  const monthItems = expandPlanItemsFromProgress(unlockedPlans, 8);
  const byDay = monthItems.reduce((groups, task) => {
    const key = task.dayNumber;
    if (!groups[key]) groups[key] = [];
    groups[key].push(task);
    return groups;
  }, {});
  const days = Object.keys(byDay).map(Number).sort((a, b) => a - b);
  // 今日 = 各计划当前活跃行（未完成顺延；已完成推进）。Use the
  // actual absolute startDay-aware day numbers to exclude today's rows from
  // the future view, instead of assuming every plan starts at day 1.
  const todayTasks = buildTodayTaskItems(plans);
  const todayDayNumbers = new Set(todayTasks.map(task => Number(task.dayNumber)).filter(Number.isFinite));
  const futureDays = days.filter(day => !todayDayNumbers.has(day)).slice(0, 7);
  const todayDone = todayTasks.filter(task => task.completed).length;
  const monthDone = monthItems.filter(row => row.completed).length;
  const subjectsInPlans = [...new Set((plans || []).map(plan => normalizeStudentSubject(plan.subject)))];
  const stageSummaries = subjectsInPlans.map(subject => {
    const subjectPlans = (plans || []).filter(plan => normalizeStudentSubject(plan.subject) === subject);
    const totalRows = subjectPlans.reduce((sum, plan) => sum + (plan.rows || []).length, 0);
    const completedRows = subjectPlans.reduce((sum, plan) => sum + (plan.rows || []).filter(isRowComplete).length, 0);
    const progress = totalRows ? Math.round(completedRows / totalRows * 100) : 0;
    return {subject, totalRows, completedRows, progress, stage: subjectPlans.some(plan => plan.taskType === '长期') ? '持续复习阶段' : '基础阶段'};
  });
  const toggle = async (task, actualProgress = null) => {
    if (!task.completed && actualProgress === null && getTaskMeasurableTarget(task.text)) {
      setTaskProgressTarget(task);
      return;
    }
    if (isRestDayToday(student)) {
      notify(REST_DAY_MESSAGE);
      return;
    }
    const nextCompleted = !task.completed;
    if (isApiConfigured() && student?.id && task.planId) {
      if (!Number.isInteger(Number(task.rowIndex)) || Number(task.rowIndex) < 0 || !Number.isInteger(Number(task.taskIndex)) || Number(task.taskIndex) < 0) {
        notify('该任务缺少有效的服务端索引，未修改完成状态；请刷新计划后重试');
        return;
      }
      try {
        const endpoint = `/api/plans/${encodeURIComponent(task.planId)}/tasks/${Number(task.rowIndex)}/${Number(task.taskIndex)}/complete`;
        await apiRequest(endpoint, { method: nextCompleted ? 'POST' : 'DELETE' });
      } catch (error) {
        notify(error?.message || '同步任务状态失败，请稍后重试');
        return;
      }
    }
    const nextPlans = plans.map(plan => {
      if (plan.id !== task.planId) return plan;
      if (actualProgress !== null && !task.completed) return applyTaskActualProgress(plan, task.rowIndex, task.taskIndex, actualProgress);
      return {...plan, rows: (plan.rows || []).map((row, index) => index === task.rowIndex ? toggleRowTaskItem(row, task.taskIndex) : row)};
    });
    const existingCheckins = student.taskCheckins || [];
    const lastCheckin = existingCheckins[existingCheckins.length - 1];
    const repeatedCompletion = nextCompleted && lastCheckin?.completed && lastCheckin.planId === task.planId && lastCheckin.rowIndex === task.rowIndex && lastCheckin.taskIndex === task.taskIndex;
    const nextCheckins = nextCompleted && !repeatedCompletion
      ? [...existingCheckins, {id:`checkin-${Date.now()}`, planId:task.planId, rowIndex:task.rowIndex, taskIndex:task.taskIndex, text:task.text, completed:true, actual: actualProgress ?? null, planned: getTaskMeasurableTarget(task.text)?.planned || null, at:new Date().toISOString()}].slice(-60)
      : existingCheckins;
    const automation = getPlanAdjustmentAutomation(student);
    const scheduled = nextCompleted ? runScheduledPlanAdjustment({plans:nextPlans, checkins:nextCheckins, automation, rules:getPlanAssistantAdjustmentRules(aiSettings)}) : {plans:nextPlans, automation, adjustment:null};
    const adjustment = scheduled.adjustment;
    setStudents(current =>
      current.map(item =>
        item.id === student.id ? {
          ...item,
          assignedPlans: scheduled.plans,
          taskCheckins: nextCheckins,
          planAdjustmentAutomation: scheduled.automation,
          taskAdjustmentDraft: adjustment?.status === '待教师确认' ? adjustment : item.taskAdjustmentDraft || null,
          taskAdjustmentHistory: adjustment?.status === '已自动导入'
            ? [...(item.taskAdjustmentHistory || []), adjustment].slice(-20)
            : (item.taskAdjustmentHistory || [])
        } : item
      )
    );
    notify(adjustment ? (adjustment.status === '已自动导入' ? `完成反馈已触发自动校准，已更新 ${adjustment.changes.length} 项后续任务` : `完成反馈已生成 ${adjustment.changes.length} 项任务调整建议，等待教师确认`) : (nextCompleted ? '已完成打卡，教师端已同步' : '已恢复为待完成'));
  };
  const openTaskAttachment = attachment => openPersistentAsset(attachment, notify);
  const renderTask = (task, readOnly = false) => (
    <article className={`student-task-card ${task.completed ? 'is-complete' : ''} ${readOnly ? 'is-readonly' : ''}`} key={`${task.planId}-${task.dayNumber}-${task.rowIndex}-${task.taskIndex}-${task.text}`}>
      <button
        type="button"
        className="student-task-check"
        onClick={() => !readOnly && toggle(task)}
        disabled={readOnly}
        aria-label={readOnly ? '未来任务仅供查看' : (task.completed ? '标记为待完成' : '标记为已完成')}
      >
        {task.completed ? <Check size={15}/> : null}
      </button>
      <div className="student-task-body">
        <div className="student-task-meta">
          <span className={`student-subject-tag subject-${task.subject}`}>{task.subject}</span>
          <span className="student-lane-tag">轨道 {task.lane}</span>
          {task.taskType === '长期' ? <span className="student-type-tag">长期</span> : null}
        </div>
        <h3>{task.text}</h3>
        {task.carry?.kind === 'quantity' ? <span className="task-carry-summary">含昨日未完成 {task.carry.remaining} 个 · 今日新增 {task.carry.newPortion} 个</span> : null}
        {task.planned != null && task.actual != null ? <span className="task-carry-summary">实际完成 {task.actual} / 计划 {task.planned}</span> : null}
        {task.attachments?.length ? <div className="student-task-attachments">{task.attachments.map(attachment => <button type="button" key={attachment.id || attachment.fileName} onClick={() => openTaskAttachment(attachment)}><FileText size={13}/>附件下载 · {attachment.fileName}</button>)}</div> : null}
        <p>{task.planName} · 阶段任务</p>
      </div>
      <span className={`student-task-status ${task.completed ? 'done' : 'todo'}`}>
        {task.completed ? '已完成' : '待完成'}
      </span>
    </article>
  );

  const taskProgressDialog = taskProgressTarget ? <TaskActualProgressDialog task={taskProgressTarget} onClose={() => setTaskProgressTarget(null)} onConfirm={actual => { const task = taskProgressTarget; setTaskProgressTarget(null); toggle(task, actual); }}/> : null;
  if (restToday && viewMode !== 'future') {
    return <>{taskProgressDialog}<StudentRestDayView student={student} selector={selector} setStudents={setStudents} notify={notify}/></>;
  }

  if (viewMode === 'future') {
    return <>
      {taskProgressDialog}
      <section className="page-head">
        <div>
          <span className="eyebrow">学习计划 · 未来 7 天</span>
          <h1>查看后续安排</h1>
          <p>
            从当前进度起展示后续 7 个学习日的任务。未完成会停在今日；整行完成后才会出现在后续天。
            {restToday ? ` 今天是休息日（${getRestWeekdayLabel(student?.restWeekday)}），今日任务已暂停。` : ''}
          </p>
          {selector}
        </div>
        <BackButton label="返回今日任务" onClick={() => setViewMode('today')}/>
      </section>
      <section className="student-plan-view-switch" aria-label="学习计划视图"><button type="button" onClick={() => setViewMode('today')}>今日任务</button><button type="button" className="active" onClick={() => setViewMode('future')}>未来 7 天</button></section>
      {futureDays.length ? (
        <div className="student-future-board">
          {futureDays.map(day => (
            <section className="student-day-block" key={day}>
              <header className="student-day-block-head">
                <div>
                  <span className="eyebrow">{formatStudyDate(day - 1)} · 距 2026 年 12 月 19 日考研初试</span>
                  <h2>共 {byDay[day].length} 项</h2>
                </div>
                <span>{byDay[day].filter(task => task.completed).length}/{byDay[day].length} 已完成</span>
              </header>
              <div className="student-task-stack">{byDay[day].map(task => renderTask(task, true))}</div>
            </section>
          ))}
        </div>
      ) : (
        <div className="empty-line student-task-empty">
          <ClipboardCheck size={22}/>
          <span>未来 30 天暂无更多任务。老师布置后会显示在这里。</span>
        </div>
      )}
    </>;
  }

  return <>
    {taskProgressDialog}
    <section className="page-head">
      <div>
          <span className="eyebrow">学习计划 · 今日与未来 7 天</span>
        <h1>{student?.name || '当前学员'}，今天要完成这些。</h1>
        <p>
          只呈现今天的任务
          {subjectsInPlans.length ? `（已同步 ${subjectsInPlans.join('、')}）` : ''}
          。每个阶段任务可单独勾选；点击“查看未来 7 天”可查看后续安排。
        </p>
        {selector}
      </div>
    </section>

    <StudentRestDayPicker student={student} setStudents={setStudents} notify={notify} compact/>

    <section className="student-today-hero">
      <div className="student-today-hero-main">
        <span className="eyebrow">今天 · 按完成进度推进</span>
        <h2>今日待办</h2>
        <p>
          {todayTasks.length
            ? `共 ${todayTasks.length} 项 · 已完成 ${todayDone} 项（未完成项次日继续；整行完成后推进下一任务）`
            : plans?.length
              ? '今天暂无待执行任务，可查看未来安排或检查前置是否已完成。'
              : '老师暂未布置任务。'}
        </p>
      </div>
      <div className="student-today-hero-stats">
        <div>
          <span>今日完成</span>
          <b>{todayDone}<em>/{todayTasks.length || 0}</em></b>
        </div>
        <div>
          <span>近 30 天</span>
          <b>{monthDone}<em>/{monthItems.length || 0}</em></b>
        </div>
      </div>
    </section>

    <section className="student-plan-stage-overview">
      <div className="student-plan-stage-head"><div><span className="eyebrow">当前复习阶段</span><h2>阶段进展</h2><p>按科目查看当前阶段的整体推进情况，不展示逐日明细。</p></div></div>
      <div className="student-plan-stage-grid">{stageSummaries.map(item => <article key={item.subject}><div><span className={`student-subject-tag subject-${item.subject}`}>{item.subject}</span><b>{item.stage}</b></div><strong>{item.progress}%</strong><p>已完成 {item.completedRows}/{item.totalRows} 个学习单元，还剩 {Math.max(0, item.totalRows - item.completedRows)} 个。</p><div className="progress-track"><i style={{width:`${item.progress}%`}}/></div></article>)}</div>
    </section>

    <section className="student-plan-view-switch" aria-label="学习计划视图"><button type="button" className={viewMode === 'today' ? 'active' : ''} onClick={() => setViewMode('today')}>今日任务</button><button type="button" className={viewMode === 'future' ? 'active' : ''} onClick={() => setViewMode('future')}>未来 7 天</button></section>

    {todayTasks.length ? (
      <div className="student-task-stack student-today-stack">{todayTasks.map(renderTask)}</div>
    ) : (
      <div className="empty-line student-task-empty">
        <ClipboardCheck size={22}/>
        <span>
          {plans?.length
            ? '今天没有需要执行的任务（可能任务从后续日期开始，或仍有前置任务未完成）。'
            : '老师暂未为你布置学习任务。'}
        </span>
      </div>
    )}

    {(futureDays.length > 0 || lockedPlans.length > 0) && (
      <section className="student-future-gate">
        <div>
          <span className="eyebrow">后续安排</span>
        <h2>未来 7 天任务</h2>
        <p>进入后查看今天之后 7 天内的学习安排；更远日期不会在学生端展示。</p>
        </div>
        <button type="button" className="primary" onClick={() => setViewMode('future')}>
          进入查看 <ChevronRight size={16}/>
        </button>
      </section>
    )}

    {lockedPlans.length > 0 && (
      <section className="student-locked-panel">
        <div className="student-locked-head">
          <span className="eyebrow">待解锁</span>
          <h3>需完成前置任务后显示</h3>
        </div>
        <div className="student-locked-list">
          {lockedPlans.map(plan => {
            const pre = (plans || []).find(item => item.id === plan.predecessorAssignmentId);
            const subject = normalizeStudentSubject(plan.subject);
            return (
              <div className="student-locked-item" key={plan.id}>
                <span className={`student-subject-tag subject-${subject}`}>{subject}</span>
                <div>
                  <b>{plan.name}</b>
                  <small>等待完成「{pre?.name || '前置任务'}」后解锁</small>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    )}

    {plans?.length > 0 && (
      <section className="student-assigned-summary">
        <span className="eyebrow">已同步任务来源</span>
        <div className="student-assigned-chips">
          {(plans || []).map(plan => (
            <span key={plan.id} className={`student-assigned-chip ${completedPlanIds.has(String(plan.id)) ? 'is-done' : ''}`}>
              {normalizeStudentSubject(plan.subject)} · {plan.name}
            </span>
          ))}
        </div>
      </section>
    )}
  </>;
}

function KnowledgeBase({knowledgeBase, setKnowledgeBase, notify}) {
  const [subject, setSubject] = useState('政治');
  const apiMode = isApiConfigured();
  const [serverBooks, setServerBooks] = useState(null);
  const [uploading, setUploading] = useState(false);
  const loadServerBooks = async () => {
    try {
      const list = await apiRequest('/api/admin/books', { cache: 'no-store' });
      // 只展示真实上传过文件的书籍；发放管理里只有元数据的书籍不属于知识库。
      setServerBooks((Array.isArray(list) ? list : []).filter(book => book.fileName).map(book => ({
        id: book.id,
        subject: book.subject,
        fileName: book.fileName || book.name,
        fileSize: Number(book.sizeBytes || 0),
        uploadedAt: book.createdAt,
        status: book.parseStatus || '未上传',
        parseError: book.parseError || '',
        chunkCount: Number(book.chunkCount || 0),
        serverManaged: true
      })));
    } catch (error) {
      setServerBooks(current => current || []);
      notify(error?.message || '知识库书籍加载失败，请稍后重试');
    }
  };
  useEffect(() => { if (apiMode) loadServerBooks(); }, []);
  const uploadBook = async file => {
    if (!file) return;
    const valid = file.type === 'application/pdf' || /\.(pdf|txt|md)$/i.test(file.name);
    if (!valid) return notify('知识库暂支持 PDF、TXT 或 Markdown 文件');
    if (file.size > 150 * 1024 * 1024) return notify('单个知识库文件请控制在 150MB 以内');
    if (apiMode) {
      const formData = new FormData();
      formData.append('subject', subject);
      formData.append('name', file.name.replace(/\.[^.]+$/, ''));
      formData.append('file', file);
      setUploading(true);
      try {
        // PDF 文本提取在服务端同步完成，大文件需要更长的等待时间。
        const saved = await apiRequest('/api/admin/books', { method: 'POST', body: formData, timeoutMs: 180000 });
        if (saved.parseStatus === '已解析') notify(`「${saved.name}」已上传并解析完成，共 ${saved.chunkCount} 个文本块`);
        else if (saved.parseStatus === '解析失败') notify(`「${saved.name}」已上传，但文本解析失败：${saved.parseError || '请检查文件内容'}`);
        else notify(`「${saved.name}」已上传，正在解析`);
        await loadServerBooks();
      } catch (error) { notify(error?.message || '书籍上传失败，请稍后重试'); }
      finally { setUploading(false); }
      return;
    }
    const item = {id:`kb-${Date.now()}`, subject, fileName:file.name, fileSize:file.size, fileType:file.type || 'application/octet-stream', objectUrl:URL.createObjectURL(file), temporary:true, uploadedAt:new Date().toISOString(), status:'待解析'};
    setKnowledgeBase(current => [item, ...(current || [])]);
    notify(`已收录「${file.name}」。当前为本地预览；刷新后需重新上传，正式上线请接入对象存储与文档解析服务。`);
  };
  const remove = async item => {
    if (item.serverManaged) {
      if (!window.confirm(`确定删除知识库书籍「${item.fileName}」吗？`)) return;
      try { await apiRequest(`/api/admin/books/${encodeURIComponent(item.id)}`, { method: 'DELETE' }); }
      catch (error) { return notify(error?.message || '删除失败，请稍后重试'); }
      setServerBooks(current => (current || []).filter(entry => entry.id !== item.id));
      notify('知识库书籍已删除');
      return;
    }
    if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);
    setKnowledgeBase(current => current.filter(entry => entry.id !== item.id));
    notify('知识库书籍已移除');
  };
  const entries = apiMode
    ? (serverBooks || []).filter(item => item.subject === subject)
    : (knowledgeBase || []).filter(item => item.subject === subject);
  const statusText = item => item.serverManaged
    ? (item.status === '已解析' ? `已解析 · ${item.chunkCount} 个文本块` : item.status === '解析失败' ? `解析失败${item.parseError ? `：${item.parseError}` : ''}` : item.status)
    : item.status;
  return <><section className="page-head"><div><span className="eyebrow">教师端 · 学科资料</span><h1>知识库</h1><p>逐本上传政治、英语、数学或专业课书籍。任务编排与讲题服务应优先引用已收录资料；超出资料范围或追问原理时，再由服务端检索可信网页并生成讲解。</p></div></section><div className="plan-subjects">{['政治','英语','数学','专业课'].map(item => <button type="button" key={item} className={subject===item?'active':''} onClick={() => setSubject(item)}>{item}</button>)}</div><section className="panel"><div className="panel-head"><h2>{subject}书籍</h2><label className={`primary file-button ${uploading ? 'is-disabled' : ''}`} aria-disabled={uploading}><Upload size={16}/>{uploading ? '正在上传解析…' : '上传书籍'}<input disabled={uploading} type="file" accept="application/pdf,.pdf,text/plain,.txt,text/markdown,.md" onChange={event => { uploadBook(event.target.files?.[0]); event.target.value=''; }}/></label></div><p className="wide-copy">{apiMode ? '上传后服务端会保存文件并提取文本切块；PDF 通过 python3（pdfminer.six / pypdf）解析，TXT 与 Markdown 直接读取。解析状态实时显示在列表中。' : '上传后将进入解析队列。当前原型仅保存本地文件预览；生产环境需将文件放入对象存储、完成文本提取/切块/索引，并在每次回答中保留来源与版本。'}</p>{apiMode && serverBooks === null ? <div className="empty-line"><BookOpen size={22}/><span>正在加载知识库书籍…</span></div> : entries.length ? <div className="plan-upload-list">{entries.map(item => <div className="plan-list-item" key={item.id}><div><b><FileText size={15}/>{item.fileName}</b><small>{item.fileSize ? `${(item.fileSize / 1024 / 1024).toFixed(2)} MB · ` : ''}{statusText(item)} · {new Date(item.uploadedAt).toLocaleDateString('zh-CN')}</small></div><div className="row-actions">{item.objectUrl ? <button type="button" className="quiet-button" onClick={() => window.open(item.objectUrl, '_blank', 'noopener,noreferrer')}>查看</button> : null}<button type="button" className="danger-button" onClick={() => remove(item)}>{item.serverManaged ? '删除' : '移除'}</button></div></div>)}</div> : <div className="empty-line"><BookOpen size={22}/><span>尚未上传{subject}书籍。上传后可作为任务与讲题的优先依据。</span></div>}</section></>;
}

function Plans({teacher, reviewPlans, setReviewPlans, open, notify}) {
  const defaultTaskColumns = defaultReviewColumns;
  const [subject, setSubject] = useState('政治');
  const [mode, setMode] = useState('list');
  const [uploadMode, setUploadMode] = useState('daily');
  const [planName, setPlanName] = useState('');
  const [category, setCategory] = useState('基础');
  const [customCategory, setCustomCategory] = useState('');
  const [dailyRows, setDailyRows] = useState([]);
  const [draftColumns, setDraftColumns] = useState(defaultTaskColumns);
  const [customMonthTasks, setCustomMonthTasks] = useState({});
  const [customTaskDraft, setCustomTaskDraft] = useState('');
  const plans = reviewPlans || initialReviewPlans;
  const setPlans = setReviewPlans || (() => {});
  const [selectedPlanId, setSelectedPlanId] = useState(null);
  const [templateLoadState, setTemplateLoadState] = useState({ status: 'idle', message: '' });
  const persistTimersRef = useRef({});
  const pendingTemplatesRef = useRef({});
  const categories = ['基础','提高','冲刺','刷题'];
  const activePlans = plans[subject] || [];
  const selectedPlan = activePlans.find(plan => plan.id === selectedPlanId);
  const getPlanColumns = plan => plan?.columns?.length ? plan.columns : defaultTaskColumns;
  const normalizeRows = (rows, columns = draftColumns) => rows.map((row, index) => ({
    ...row,
    day: row.day || formatTeacherPlanDay(index + 1),
    tasks: columns.map((_, taskIndex) => row.tasks?.[taskIndex] || ''),
    note: row.note || ''
  }));
  const persistTemplate = async (plan, successMessage = '') => {
    try {
      const result = await apiRequest(`/api/admin/plan-templates/${encodeURIComponent(plan.id)}`, { method: 'PUT', body: planTemplateRequestBody({ ...plan, columns: getPlanColumns(plan) }) });
      const saved = normalizePlanTemplate(result?.template || {});
      setPlans(current => ({ ...current, [subject]: (current[subject] || []).map(item => item.id === plan.id ? saved : item) }));
      if (successMessage) notify(successMessage);
      return saved;
    } catch (error) {
      notify(error?.message || '复习计划保存失败，请稍后重试');
      return null;
    }
  };
  const cancelScheduledPersist = planId => {
    window.clearTimeout(persistTimersRef.current[planId]);
    delete persistTimersRef.current[planId];
    delete pendingTemplatesRef.current[planId];
  };
  // 编辑单元格每次击键都会更新本地状态；服务端持久化做 800ms 防抖，
  // 「保存修改」按钮再立即落盘，避免逐键打点 PUT 接口。
  const scheduleTemplatePersist = plan => {
    pendingTemplatesRef.current[plan.id] = plan;
    window.clearTimeout(persistTimersRef.current[plan.id]);
    persistTimersRef.current[plan.id] = window.setTimeout(() => {
      const pending = pendingTemplatesRef.current[plan.id];
      cancelScheduledPersist(plan.id);
      if (pending) persistTemplate(pending);
    }, 800);
  };
  const updatePlanRows = rows => {
    if (!selectedPlan) return;
    const columns = getPlanColumns(selectedPlan);
    const nextRows = normalizeRows(rows, columns).map((row, index) => ({...row, attachments: selectedPlan.rows?.[index]?.attachments || []}));
    const nextPlan = {...selectedPlan, columns, rows: nextRows};
    setPlans(current => ({...current, [subject]: (current[subject] || []).map(plan => plan.id === selectedPlan.id ? nextPlan : plan)}));
    if (isApiConfigured()) scheduleTemplatePersist(nextPlan);
  };
  const saveDetailEdits = async () => {
    if (!selectedPlan) return;
    if (!isApiConfigured()) return notify('复习计划修改已保存');
    cancelScheduledPersist(selectedPlan.id);
    const latest = (plans[subject] || []).find(plan => plan.id === selectedPlan.id) || selectedPlan;
    await persistTemplate(latest, '复习计划修改已保存');
  };
  const loadTemplates = async (targetSubject = subject) => {
    if (!isApiConfigured() || !teacher) return;
    setTemplateLoadState({ status: 'loading', message: '' });
    try {
      const result = await apiRequest(`/api/admin/plan-templates?subject=${encodeURIComponent(targetSubject)}`, { cache: 'no-store' });
      const templates = (Array.isArray(result?.templates) ? result.templates : []).map(normalizePlanTemplate);
      setPlans(current => ({ ...current, [targetSubject]: templates }));
      setTemplateLoadState({ status: 'ready', message: '' });
    } catch (error) {
      setTemplateLoadState({ status: 'error', message: error?.message || '复习计划模板加载失败' });
      notify(error?.message || '复习计划模板加载失败');
    }
  };
  useEffect(() => {
    if (!isApiConfigured() || !teacher) return undefined;
    loadTemplates(subject);
    return undefined;
  }, [subject, teacher]);
  useEffect(() => () => {
    Object.values(persistTimersRef.current).forEach(timer => window.clearTimeout(timer));
  }, []);
  const addRowAttachment = (rowIndex, file) => {
    if (isApiConfigured()) return notify('基础计划附件接口尚未部署；未保存浏览器临时文件。');
    if (!file || !selectedPlan) return;
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) return notify('任务附件仅支持 PDF 文件');
    if (file.size > 100 * 1024 * 1024) return notify('单个 PDF 附件请控制在 100MB 以内');
    const attachment = {id:`task-file-${Date.now()}-${file.name}`, fileName:file.name, fileSize:file.size, fileType:'application/pdf', objectUrl:URL.createObjectURL(file), temporary:true, uploadedAt:new Date().toISOString()};
    setPlans(current => ({...current, [subject]: current[subject].map(plan => plan.id === selectedPlan.id ? {...plan, rows:plan.rows.map((row, index) => index === rowIndex ? {...row, attachments:[...(row.attachments || []), attachment]} : row)} : plan)}));
    notify(`已添加附件「${file.name}」。本地预览会在刷新页面后失效，正式上线请接入文件存储。`);
  };
  const removeRowAttachment = (rowIndex, attachmentId) => {
    const attachment = selectedPlan?.rows?.[rowIndex]?.attachments?.find(item => item.id === attachmentId);
    if (attachment?.objectUrl) URL.revokeObjectURL(attachment.objectUrl);
    setPlans(current => ({...current, [subject]: current[subject].map(plan => plan.id === selectedPlan.id ? {...plan, rows:plan.rows.map((row, index) => index === rowIndex ? {...row, attachments:(row.attachments || []).filter(item => item.id !== attachmentId)} : row)} : plan)}));
    notify('任务附件已移除');
  };
  const addTaskColumn = () => {
    const nextColumn = `任务${draftColumns.length + 1}`;
    setDraftColumns(columns => [...columns, nextColumn]);
    setDailyRows(rows => rows.map(row => ({...row, tasks: [...(row.tasks || []), '']})));
  };
  const addDetailTaskColumn = () => {
    if (!selectedPlan) return;
    const columns = getPlanColumns(selectedPlan);
    const nextColumn = `任务${columns.length + 1}`;
    const nextPlan = {
      ...selectedPlan,
      columns: [...columns, nextColumn],
      rows: selectedPlan.rows.map(row => ({...row, tasks: [...(row.tasks || []), '']}))
    };
    setPlans(current => ({...current, [subject]: (current[subject] || []).map(plan => plan.id === selectedPlan.id ? nextPlan : plan)}));
    if (isApiConfigured()) { cancelScheduledPersist(nextPlan.id); persistTemplate(nextPlan); }
  };
  const selectedCustomMonthTasks = customMonthTasks[selectedPlanId] || [];
  const addCustomMonthTask = () => {
    const content = customTaskDraft.trim();
    if (!content || !selectedPlanId) return notify('请填写自定义内容');
    setCustomMonthTasks(tasks => ({...tasks, [selectedPlanId]: [...(tasks[selectedPlanId] || []), {id:Date.now(), content}]}));
    setCustomTaskDraft('');
  };
  const updateCustomMonthTask = (id, content) => setCustomMonthTasks(tasks => ({...tasks, [selectedPlanId]: (tasks[selectedPlanId] || []).map(task => task.id === id ? {...task, content} : task)}));
  const deleteCustomMonthTask = id => setCustomMonthTasks(tasks => ({...tasks, [selectedPlanId]: (tasks[selectedPlanId] || []).filter(task => task.id !== id)}));
  const deletePlan = async () => {
    if (!selectedPlan) return;
    if (isApiConfigured()) {
      cancelScheduledPersist(selectedPlan.id);
      try {
        await apiRequest(`/api/admin/plan-templates/${encodeURIComponent(selectedPlan.id)}`, { method: 'DELETE' });
      } catch (error) {
        notify(error?.message || '删除复习计划失败，请稍后重试');
        return;
      }
    }
    setPlans(current => ({...current, [subject]: current[subject].filter(plan => plan.id !== selectedPlan.id)}));
    setSelectedPlanId(null); setMode('list'); notify('整份复习计划已删除');
  };
  const removePlan = async plan => {
    if (isApiConfigured()) {
      cancelScheduledPersist(plan.id);
      try {
        await apiRequest(`/api/admin/plan-templates/${encodeURIComponent(plan.id)}`, { method: 'DELETE' });
      } catch (error) {
        notify(error?.message || '删除失败，请稍后重试');
        return;
      }
    }
    setPlans(current => ({...current, [subject]: current[subject].filter(item => item.id !== plan.id)}));
    notify('基础任务已删除');
  };
  const savePlan = async () => {
    const finalCategory = category === '自定义' ? customCategory.trim() : category;
    if (!planName.trim()) return notify('请先填写计划名称');
    if (!finalCategory) return notify('请填写计划分类');
    if (!dailyRows.length) return notify('请先添加至少一天计划内容');
    const rows = normalizeRows(dailyRows, draftColumns);
    if (isApiConfigured()) {
      try {
        const result = await apiRequest('/api/admin/plan-templates', {
          method: 'POST',
          body: { subject, name: planName.trim(), category: finalCategory, columns: draftColumns, rows: rows.map(row => ({ day: row.day, tasks: row.tasks, note: row.note })) }
        });
        const created = normalizePlanTemplate(result?.template || {});
        setPlans(current => ({...current, [subject]: [...(current[subject] || []), created]}));
        setSelectedPlanId(created.id); setMode('detail'); setPlanName(''); setDailyRows([]); setDraftColumns(defaultTaskColumns); setCustomCategory('');
        notify(`${subject}复习计划已创建`);
      } catch (error) {
        notify(error?.message || '复习计划创建失败，请稍后重试');
      }
      return;
    }
    const next = {id:Date.now(), name:planName.trim(), category:finalCategory, columns:draftColumns, rows};
    setPlans(current => ({...current, [subject]:[...(current[subject] || []), next]}));
    setSelectedPlanId(next.id); setMode('detail'); setPlanName(''); setDailyRows([]); setDraftColumns(defaultTaskColumns); setCustomCategory('');
    notify(`${subject}复习计划已创建`);
  };
  const importRows = file => { if (!file) return; parseTaskTemplate(file, (rows, importedColumns) => { setDraftColumns(importedColumns.map((_, index) => `任务${index + 1}`)); setDailyRows(normalizeRows(rows, importedColumns.map((_, index) => `任务${index + 1}`))); notify(`已读取 ${rows.length} 天、${importedColumns.length} 个任务列，请填写名称和分类后保存`); }, () => notify('模板字段不符合要求，请至少包含序号和一个任务列')); };
  const addDailyRow = () => setDailyRows(rows => [...rows, {day:formatTeacherPlanDay(rows.length + 1), tasks:Array(draftColumns.length).fill(''), note:''}]);
  const updateRow = (index, field, value) => setDailyRows(rows => rows.map((row, i) => i === index ? field === 'tasks' ? {...row, tasks:row.tasks.map((task, j) => j === value.index ? value.text : task)} : {...row, [field]:value} : row));
  const startUpload = () => {setMode('create'); setUploadMode('daily'); setDailyRows([]); setDraftColumns(defaultTaskColumns); setPlanName(''); setCustomTaskDraft('');};
  if (!teacher) return <><section className="page-head"><div><span className="eyebrow">我的学习计划</span><h1>计划清晰，执行才有方向。</h1><p>你正在使用复习规划副本；老师的个性化调整会独立叠加，不会改写原始模板。</p></div><button className="primary" onClick={() => open('ai-plan')}><Sparkles size={17}/>AI 调整我的计划</button></section><div className="plan-grid">{planTemplates.map(p => <article className="plan-card" key={p.id}><div><span className="badge">{p.stage}</span><h2>{p.title}</h2><p>{p.description}</p></div><div className="plan-bottom"><span>{p.subjects.join(' · ')} · {p.tasks} 项任务</span><button className="quiet-button" onClick={() => open('plan-apply')}>查看计划<ChevronRight size={15}/></button></div></article>)}</div></>;
  if (mode === 'detail' && selectedPlan) {
    const columns = getPlanColumns(selectedPlan);
    return <><section className="page-head"><div><span className="eyebrow">{subject} · {selectedPlan.category}</span><h1>{selectedPlan.name}</h1><p>计划内容可直接修改。删除单日或清空单项后，点击保存修改即可生效。</p></div><div className="page-actions"><button className="danger-button" onClick={deletePlan}>删除整份计划</button><button className="secondary" onClick={()=>setMode('list')}>返回计划列表</button></div></section><section className="panel table-panel plan-detail-table"><div className="panel-head"><h2>计划内容</h2><button className="secondary" onClick={addDetailTaskColumn}><Plus size={16}/>增加任务列</button></div><div className="plan-detail-scroll"><table><thead><tr><th className="plan-sticky-day">序号</th><th className="plan-sticky-attachment">附件</th>{columns.map(column=><th key={column}>{column}</th>)}<th>操作</th></tr></thead><tbody>{selectedPlan.rows.map((row,index)=><tr key={`${selectedPlan.id}-${index}`}><td className="plan-sticky-day"><b>{index + 1}</b></td><td className="plan-sticky-attachment"><div className="task-attachment-cell">{(row.attachments || []).map(attachment => <span key={attachment.id}><FileText size={13}/><b>{attachment.fileName}</b><button type="button" aria-label={`移除${attachment.fileName}`} onClick={() => removeRowAttachment(index, attachment.id)}>×</button></span>)}<label className={`quiet-button file-button ${isApiConfigured() ? 'is-disabled' : ''}`}><Upload size={14}/>附件<input disabled={isApiConfigured()} type="file" accept="application/pdf,.pdf" onChange={event => { addRowAttachment(index, event.target.files?.[0]); event.target.value=''; }}/></label></div></td>{columns.map((column,taskIndex)=><td key={column}><div className="plan-cell"><input value={row.tasks[taskIndex] || ''} onChange={e=>{const rows=selectedPlan.rows.map((r,i)=>i===index?{...r,tasks:r.tasks.map((x,j)=>j===taskIndex?e.target.value:x)}:r);updatePlanRows(rows);}} placeholder={column==='自定义'?'自定义内容':'填写任务'}/>{row.tasks[taskIndex]&&<button className="quiet-button" onClick={()=>{const rows=selectedPlan.rows.map((r,i)=>i===index?{...r,tasks:r.tasks.map((x,j)=>j===taskIndex?'':x)}:r);updatePlanRows(rows);}}>清空</button>}</div></td>)}<td><button className="danger-button" onClick={()=>updatePlanRows(selectedPlan.rows.filter((_,i)=>i!==index))}>删除当天</button></td></tr>)}</tbody></table></div><div className="form-footer"><button className="secondary" onClick={()=>{const rows=[...selectedPlan.rows,{day:formatTeacherPlanDay(selectedPlan.rows.length + 1),tasks:Array(columns.length).fill(''),note:''}];updatePlanRows(rows);}}>新增一天</button><button className="primary" onClick={saveDetailEdits}>保存修改</button></div><section className="custom-month-module"><div><span className="eyebrow">计划最后一个月</span><h2>自定义</h2><p>可随时新增、修改或删除最后一个月的补充任务。</p></div><div className="custom-month-add"><input value={customTaskDraft} onChange={e=>setCustomTaskDraft(e.target.value)} placeholder="输入自定义任务内容"/><button className="secondary" onClick={addCustomMonthTask}><Plus size={16}/>新增</button></div>{selectedCustomMonthTasks.length ? <div className="custom-month-list">{selectedCustomMonthTasks.map(task=><div key={task.id}><input value={task.content} onChange={e=>updateCustomMonthTask(task.id,e.target.value)}/><button className="danger-button" onClick={()=>deleteCustomMonthTask(task.id)}>删除</button></div>)}</div> : <span className="empty-custom-task">尚未添加自定义任务</span>}</section></section></>;
  }
  if (mode === 'create') return <><section className="page-head"><div><span className="eyebrow">{subject} · 基础任务库</span><h1>导入{subject}基础任务</h1><p>这里仅保存该科目的可复用基础任务。长期、并行、承接和开始位置只会在学员详情的“布置任务”中设置。</p></div><button className="secondary" onClick={()=>setMode('list')}>返回任务库</button></section><section className="panel"><div className="exam-send-grid"><label>任务名称<input value={planName} onChange={e=>setPlanName(e.target.value)} placeholder={`例如：${subject}阅读训练`}/></label><label>任务分类<select value={category} onChange={e=>setCategory(e.target.value)}>{categories.map(x=><option key={x}>{x}</option>)}<option value="自定义">自定义</option></select></label>{category==='自定义'&&<label>自定义分类<input value={customCategory} onChange={e=>setCustomCategory(e.target.value)} placeholder="例如：考前押题"/></label>}</div><div className="plan-subjects"><button className={uploadMode==='daily'?'active':''} onClick={()=>setUploadMode('daily')}>一天一天上传</button><button className={uploadMode==='batch'?'active':''} onClick={()=>setUploadMode('batch')}>批量上传</button></div>{uploadMode==='batch'?<><div className="daily-import-actions"><button className="secondary" onClick={downloadTaskTemplate}>下载任务模板</button><label className="primary file-button">选择批量文件<input type="file" accept=".xls,.xlsx" onChange={e=>{importRows(e.target.files?.[0]);e.target.value='';}}/></label></div><div className="plan-column-toolbar"><span>当前任务列：{draftColumns.join('、')}</span><button className="secondary" onClick={addTaskColumn}><Plus size={16}/>增加任务列</button></div></>:<div className="daily-task-preview"><div className="daily-plan-head"><b>日期</b>{draftColumns.map(column=><b key={column}>{column}</b>)}<b>补充</b></div>{dailyRows.map((row,index)=><div className="daily-plan-row" key={row.day}><input value={row.day} onChange={e=>updateRow(index,'day',e.target.value)}/>{draftColumns.map((column,taskIndex)=><input key={column} value={row.tasks[taskIndex] || ''} onChange={e=>updateRow(index,'tasks',{index:taskIndex,text:e.target.value})} placeholder={column==='自定义'?'自定义内容':'填写任务'}/>) }<input value={row.note || ''} onChange={e=>updateRow(index,'note',e.target.value)} placeholder="补充说明"/></div>)}<div className="plan-column-toolbar"><button className="secondary" onClick={addDailyRow}><Plus size={16}/>新增一天</button><span>当前任务列：{draftColumns.join('、')}</span><button className="secondary" onClick={addTaskColumn}><Plus size={16}/>增加任务列</button></div></div>}<div className="form-footer"><button className="primary" onClick={savePlan}>保存到基础任务库</button></div></section></>;
  return <><section className="page-head"><div><span className="eyebrow">教师端 · 复习规划</span><h1>{subject}基础任务库</h1><p>集中保存该科目的全部基础任务。任务之间不预设长期、并行或承接关系，关系仅在分配给具体学员时建立。</p></div><button className="primary" onClick={startUpload}><Plus size={16}/>导入基础任务</button></section><div className="plan-subjects">{['政治','英语','数学','专业课'].map(x=><button className={subject===x?'active':''} key={x} onClick={()=>{setSubject(x);setSelectedPlanId(null);}}>{x}</button>)}</div>{isApiConfigured() && templateLoadState.status === 'error' && <div className="inline-error" role="alert"><span>{templateLoadState.message || '复习计划模板加载失败'}</span><button type="button" className="secondary" onClick={() => loadTemplates(subject)}>重新加载</button></div>}{isApiConfigured() && templateLoadState.status === 'loading' && <div className="empty-line" role="status"><Clock3 size={20}/><span>正在加载{subject}复习计划模板…</span></div>}<section className="panel"><PanelHead title={`${subject}基础任务`} action={`${activePlans.length} 条`}/><div className="plan-upload-list">{activePlans.map(plan=><div className="plan-list-item" key={plan.id} role="button" tabIndex={0} onClick={()=>{setSelectedPlanId(plan.id);setMode('detail');}} onKeyDown={event=>{if(event.key==='Enter'){setSelectedPlanId(plan.id);setMode('detail');}}}><div><b>{plan.name}</b><small>{plan.category} · {plan.rows.length} 天任务 · 可分配到学员</small></div><div className="row-actions"><button className="quiet-button" onClick={event=>{event.stopPropagation();setSelectedPlanId(plan.id);setMode('detail');}}>查看并编辑<ChevronRight size={15}/></button><button className="danger-button" onClick={event=>{event.stopPropagation();removePlan(plan);}}>删除</button></div></div>)}{!activePlans.length&&<div className="empty-line"><PackageOpen size={22}/><span>当前科目暂无基础任务，请导入后再到学员详情中进行组合。</span></div>}</div></section></>;
}

function Community({posts, setPosts, student, notify}) {
  const [composerOpen, setComposerOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [topic, setTopic] = useState('学习交流');
  const [body, setBody] = useState('');
  const publicPosts = (posts || []).filter(post => post.state === '已公开');
  const myPendingPosts = (posts || []).filter(post => post.state === '待审核' && String(post.studentId || '') === String(student?.id || ''));
  const submitPost = async () => {
    if (!title.trim() || !body.trim()) return notify('请填写帖子标题和内容后再提交');
    if (isApiConfigured()) {
      try {
        const created = await apiRequest('/api/posts', {
          method: 'POST',
          body: { title: title.trim(), topic, body: body.trim() }
        });
        const normalized = {
          id: created.id,
          studentId: student?.id || null,
          author: created.author || student?.name || '匿名同学',
          topic: created.topic,
          title: created.title,
          body: created.body,
          state: created.state || '待审核',
          time: created.createdAt ? new Date(created.createdAt).toLocaleString('zh-CN') : '刚刚',
          createdAt: created.createdAt || new Date().toISOString(),
          isServerManaged: true
        };
        setPosts(current => [normalized, ...(current || [])]);
        setTitle(''); setBody(''); setTopic('学习交流'); setComposerOpen(false);
        notify('帖子已提交，审核通过后会显示在学习社区');
      } catch (error) {
        notify(error?.message || '提交帖子失败，请稍后重试');
      }
      return;
    }
    setPosts(current => [{ id:`post-${Date.now()}`, studentId:student?.id || null, author:student?.name || '匿名同学', topic, title:title.trim(), body:body.trim(), state:'待审核', time:'刚刚', createdAt:new Date().toISOString() }, ...(current || [])]);
    setTitle(''); setBody(''); setTopic('学习交流'); setComposerOpen(false);
    notify('帖子已提交，审核通过后会显示在学习社区');
  };
  return <><section className="page-head"><div><span className="eyebrow">学习社区 · 发帖需审核</span><h1>把问题说出来，一起找到答案。</h1><p>审核通过的学习交流会公开展示；你提交但尚未审核的内容只对你自己可见。</p></div><button className="primary" onClick={() => setComposerOpen(true)}><PenLine size={16}/>发布帖子</button></section>{composerOpen && <section className="panel community-compose"><PanelHead title="发布学习帖子"/><label>标题<input value={title} onChange={event => setTitle(event.target.value)} placeholder="例如：高数极限题的一个疑问"/></label><label>话题<select value={topic} onChange={event => setTopic(event.target.value)}><option>学习交流</option><option>政治</option><option>英语</option><option>数学</option><option>专业课</option></select></label><small className="unavailable-feature-note">社区附件：未接入服务端，当前仅支持文字内容。</small><label>内容<textarea value={body} onChange={event => setBody(event.target.value)} rows={4} placeholder="说明你的学习问题、思路或经验。"/></label><div className="form-footer"><button className="secondary" onClick={() => setComposerOpen(false)}>取消</button><button className="primary" onClick={submitPost}>提交审核</button></div></section>}<div className="community-layout"><section className="panel"><PanelHead title="最新帖子" action={`${publicPosts.length} 条`}/>{publicPosts.length ? <div className="post-list">{publicPosts.map(post => <article className="post" key={post.id || `${post.author}-${post.title}`}><div className="avatar">{post.author.slice(0,1)}</div><div><span>{post.topic} · {post.time}</span><h3>{post.title}</h3><p>{post.body || '学习交流内容待展开。'}</p><small>{post.author}</small></div></article>)}</div> : <div className="empty-line"><MessageSquareText size={20}/><span>暂未有已公开的学习帖子。</span></div>}{myPendingPosts.length ? <div className="community-pending-list"><h3>我提交的待审核帖子</h3>{myPendingPosts.map(post => <div key={post.id}><b>{post.title}</b><span>{post.topic} · 待审核</span></div>)}</div> : null}</section><aside className="community-rules"><CircleHelp size={22}/><h3>社区规则</h3><p>请围绕学习内容交流；避免发布个人隐私、招生营销和未经证实的信息。</p><button className="quiet-button" onClick={() => notify('请发布与考研学习相关、尊重他人的内容')}>查看发布提示</button></aside></div></>;
}

function HomeworkCompletionPanel({ student, notify }) {
  const [state, setState] = useState({ loading: true, error: '', completions: [] });
  const load = async () => {
    if (!isApiConfigured() || !student?.id || student.isTestAccount) {
      setState({ loading: false, error: '当前未接入服务端任务完成接口。', completions: [] });
      return;
    }
    setState(current => ({ ...current, loading: true, error: '' }));
    try {
      const payload = await apiRequest(`/api/students/${encodeURIComponent(student.id)}/plans`, { cache: 'no-store' });
      const completions = Array.isArray(payload?.completions) ? payload.completions : [];
      setState({ loading: false, error: '', completions });
    } catch (error) {
      setState({ loading: false, error: error?.message || '任务完成记录加载失败', completions: [] });
    }
  };
  useEffect(() => { load(); }, [student?.id]);
  const completionKey = item => `${item.student_plan_id || item.studentPlanId}:${item.row_index ?? item.rowIndex}:${item.task_index ?? item.taskIndex}`;
  const plans = student?.assignedPlans || [];
  const rows = plans.flatMap(plan => (plan.rows || []).flatMap((row, rowIndex) => (row.tasks || []).filter(Boolean).map((text, taskIndex) => ({ plan, row, rowIndex, taskIndex, text }))));
  const done = new Set(state.completions.map(completionKey));
  return <section className="homework-completion-panel">
    <div className="homework-completion-head"><div><span className="eyebrow">服务端任务完成 API</span><h3>{student?.name || '该学员'} 的任务完成记录</h3><p>教师面板只展示服务端已保存的完成事件，不用浏览器本地 timer 或客户端推断替代。</p></div><button type="button" className="secondary" onClick={load} disabled={state.loading}>{state.loading ? '加载中…' : '刷新'}</button></div>
    {state.error ? <div className="homework-sync-empty" role="alert"><AlertTriangle size={20}/><span>{state.error}</span><button type="button" className="secondary" onClick={load}>重试</button></div> : state.loading ? <div className="homework-sync-empty"><Clock3 size={20}/><span>正在读取服务端完成记录…</span></div> : rows.length ? <div className="homework-completion-list">{rows.map(item => { const key = `${item.plan.id}:${item.rowIndex}:${item.taskIndex}`; const completion = state.completions.find(entry => completionKey(entry) === key); return <div className={done.has(key) ? 'is-complete' : ''} key={key}><span>{done.has(key) ? '已完成' : '待完成'}</span><b>{item.text}</b><small>{item.plan.name} · 第 {item.rowIndex + 1} 天{completion ? ` · ${new Date(completion.completed_at || completion.completedAt).toLocaleString('zh-CN')}` : ''}</small></div>; })}</div> : <div className="homework-sync-empty"><ClipboardCheck size={20}/><span>该学员暂无可展示任务或完成记录。</span></div>}
  </section>;
}

function StudentMessagePanel({ student, notify }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [pending, setPending] = useState(false);
  useEffect(() => { setTitle(''); setBody(''); }, [student?.id]);
  const submit = async () => {
    if (!title.trim()) return notify('请填写消息标题');
    if (!body.trim()) return notify('请填写消息内容');
    if (!isApiConfigured() || !student?.isServerManaged) return notify('演示账号不支持发送私信，请在正式学员档案中使用');
    setPending(true);
    try {
      await apiRequest('/api/admin/messages', { method: 'POST', body: { studentId: student.id, title: title.trim(), body: body.trim() } });
      setTitle('');
      setBody('');
      notify(`私信已发送给 ${student.name}，学生端通知中心立即可见`);
    } catch (error) { notify(error?.message || '私信发送失败，请稍后重试'); }
    finally { setPending(false); }
  };
  return <section className="panel"><PanelHead title="私信学员"/><p>发送后学生端「通知中心」立即可见；与试卷分发、订单审核通知共用同一渠道。</p><div className="student-profile-editor"><label>标题<input value={title} onChange={event => setTitle(event.target.value)} placeholder="例如：本周学习安排提醒" maxLength={160}/></label><label className="profile-editor-wide">内容<textarea value={body} onChange={event => setBody(event.target.value)} rows={3} placeholder="写给该学员的私信内容" maxLength={2000}/></label><div className="form-footer profile-editor-wide"><button type="button" className="primary" onClick={submit} disabled={pending}>{pending ? '正在发送…' : '发送私信'}</button></div></div></section>;
}

function Students({students, setStudents, selectedStudent, setSelectedStudent, reviewPlans, aiSettings, entranceState, accounts, setAccounts, open, notify, currentAccount}) {
  const [searchText, setSearchText] = useState('');
  const [statusFilter, setStatusFilter] = useState('全部');
  const [subjectFilter, setSubjectFilter] = useState('全部');
  const findStudentAccount = student => (accounts || []).find(account => account.role === 'student' && String(account.studentId) === String(student?.id));
  const formatAccountLogin = value => value ? new Date(value).toLocaleString('zh-CN') : '尚未登录';
  const resetStudentPassword = async account => {
    if (!account) return notify('该学员尚未创建登录账号');
    if (isApiConfigured()) {
      try {
        const result = await apiRequest(`/api/admin/accounts/${account.id}`, {
          method: 'PATCH',
          body: { resetPassword: true }
        });
        const updated = result?.account || result;
        setAccounts(current => current.map(item => item.id === account.id ? {
          ...item,
          ...updated,
          status: updated?.status || item.status,
          sessionVersion: getSessionAuthVersion(updated, getSessionAuthVersion(item, null)), authVersion: getSessionAuthVersion(updated, getSessionAuthVersion(item, null))
        } : item));
        const tempPassword = result?.tempPassword;
        if (tempPassword) window.alert(`${account.name} 的一次性临时密码：${tempPassword}\n请通过安全渠道转交，并要求首次登录后修改。`);
        notify('已生成一次性临时密码，账号首次登录必须改密');
      } catch (error) {
        notify(error?.message || '重置密码失败，请稍后重试');
      }
      return;
    }
    setAccounts(current => current.map(item => item.id === account.id ? {...item, passwordHash:hashLocalPassword(DEMO_ACCOUNT_PASSWORD), mustChangePassword:true, sessionVersion:Number(item.sessionVersion ?? item.authVersion ?? 0) + 1, authVersion:Number(item.sessionVersion ?? item.authVersion ?? 0) + 1} : item));
    window.alert(`${account.name} 的演示临时密码：${DEMO_ACCOUNT_PASSWORD}\n仅用于本地演示，首次登录后请修改。`);
    notify('已重置演示账号密码');
  };
  const [assignmentSubject, setAssignmentSubject] = useState(null);
  const [assignedPlans, setAssignedPlans] = useState([]);
  const [selectedPersonalPlanId, setSelectedPersonalPlanId] = useState(null);
  const [showFutureTasks, setShowFutureTasks] = useState(false);
  const [showHomeworkCompletion, setShowHomeworkCompletion] = useState(false);
  const [showAllTasks, setShowAllTasks] = useState(false);
  const [showEntranceTest, setShowEntranceTest] = useState(false);
  const [showAssessmentPush, setShowAssessmentPush] = useState(false);
  const [futureTaskSubject, setFutureTaskSubject] = useState('政治');
  const [view, setView] = useState('list');
  const [importGroup, setImportGroup] = useState('体验');
  const [studentForm, setStudentForm] = useState({name:'', phone:'', shippingInfo:'', school:'', targetScore:'', group:'新人', stage:'基础', subjects:[]});
  const [profileDraft, setProfileDraft] = useState({name:'', year:'', phone:'', wechatId:'', idCard:'', shippingRecipient:'', shippingPhone:'', shippingInfo:'', school:'', targetScore:'', stage:'基础', progress:0, evaluation:'', subjects:[]});
  const [profileSavedAt, setProfileSavedAt] = useState(null);
  const profileIsDirty = selectedStudent ? JSON.stringify({
    ...profileDraft,
    progress:Number(profileDraft.progress) || 0
  }) !== JSON.stringify({
    name:selectedStudent.name || '', year:selectedStudent.year || '', phone:selectedStudent.phone || '', wechatId:selectedStudent.wechatId || '', idCard:selectedStudent.idCard || '', shippingRecipient:selectedStudent.shippingRecipient || '', shippingPhone:selectedStudent.shippingPhone || '',
    shippingInfo:selectedStudent.shippingInfo || '', school:selectedStudent.school || '', targetScore:selectedStudent.targetScore || '',
    stage:selectedStudent.stage || '基础', progress:Number(selectedStudent.progress) || 0, evaluation:selectedStudent.evaluation || '',
    subjects:(selectedStudent.subjects || []).map(item => ({...item, targetScore:item.targetScore || ''}))
  }) : false;
  // API 模式下复习计划模板由 App 顶层从服务端加载后注入 reviewPlans，
  // 布置任务与「复习规划」页共用同一份模板数据。
  const availablePlans = reviewPlans?.[assignmentSubject] || [];
  const wouldCreatePlanCycle = (planId, predecessorId) => {
    if (!predecessorId) return false;
    const visited = new Set();
    let currentId = String(predecessorId);
    while (currentId && !visited.has(currentId)) {
      if (currentId === String(planId)) return true;
      visited.add(currentId);
      const current = assignedPlans.find(item => String(item.id) === currentId);
      currentId = current?.predecessorAssignmentId ? String(current.predecessorAssignmentId) : '';
    }
    return false;
  };
  const getEntranceScoreLines = student => {
    const latestBySubject = new Map();
    (student.entranceRecords || []).forEach(record => {
      const subject = record.subject || record.paperTitle?.replace('入学摸底试卷', '') || '';
      if (!subject) return;
      const current = latestBySubject.get(subject);
      if (!current || String(record.gradedAt || record.submittedAt || '') > String(current.gradedAt || current.submittedAt || '')) latestBySubject.set(subject, record);
    });
    return (student.subjects || []).filter(item => item.enrolled).map(item => {
      const subject = normalizedSubject(item.name);
      const record = latestBySubject.get(subject);
      return {name:item.name, score:record ? `${record.score}/${record.total}` : '待完成自测'};
    });
  };
  const updateEnrollment = (subjectName, enrolled) => {
    setProfileDraft(current => ({...current, subjects:current.subjects.map(item => item.name === subjectName ? {...item, enrolled} : item)}));
  };
  const updateSubjectTargetScore = (subjectName, targetScore) => {
    setProfileDraft(current => ({...current, subjects:current.subjects.map(item => item.name === subjectName ? {...item, targetScore} : item)}));
  };
  const toggleProfileSubject = subjectName => {
    setProfileDraft(current => {
      const exists = current.subjects.find(item => item.name === subjectName);
      return {...current, subjects:exists ? current.subjects.filter(item => item.name !== subjectName) : [...current.subjects, {name:subjectName, enrolled:false, targetScore:''}]};
    });
  };
  const saveProfile = async () => {
    if (!profileDraft.name.trim()) return notify('请填写学员姓名');
    const nextStudent = {
      ...selectedStudent,
      ...profileDraft,
      name:profileDraft.name.trim(),
      year:profileDraft.year.trim() || '待填写',
      phone:profileDraft.phone.trim() || '待填写',
      wechatId:profileDraft.wechatId.trim(),
      shippingRecipient:profileDraft.shippingRecipient.trim(),
      shippingPhone:profileDraft.shippingPhone.trim(),
      idCard:profileDraft.idCard.trim() || '待填写',
      shippingInfo:profileDraft.shippingInfo.trim() || '待补充',
      school:profileDraft.school.trim() || '待填写',
      targetScore:profileDraft.targetScore.trim() || '待确定',
      progress:Math.max(0, Math.min(100, Number(profileDraft.progress) || 0)),
      evaluation:profileDraft.evaluation.trim() || '待填写',
      subjects:profileDraft.subjects,
      isTestAccount:selectedStudent.isTestAccount,
      restWeekday: normalizeRestWeekday(selectedStudent.restWeekday),
      restWeekdaySetAt: selectedStudent.restWeekdaySetAt || null
    };
    if (isApiConfigured() && !nextStudent.isTestAccount) {
      // 走 PATCH /api/students/:id 同步云端核心字段（后端仅持久化 server 端 schema 字段）
      try {
        // Student archive PATCH is the source of truth for profile data. A
        // normal teacher is not allowed to call the admin-only account PATCH;
        // the server keeps the account boundary separate from the archive.
        await apiRequest(`/api/students/${nextStudent.id}`, {
          method: 'PATCH',
          body: buildStudentProfilePatch(nextStudent, 'teacher')
        });
        const savedPreferences = await apiRequest(`/api/students/${nextStudent.id}/preferences`, {
          method: 'PATCH',
          body: {
            subjects: nextStudent.subjects.map(item => ({
              // The server matches companion books by canonical category; keep
              // English I/II and Math I/II display names local, but persist the
              // canonical enrollment key so book visibility is compatible.
              subject: normalizeStudentSubject(item.name),
              enrolled: !!item.enrolled,
              targetScore: item.targetScore || null
            }))
          }
        });
        const syncedStudent = { ...nextStudent, subjects:savedPreferences.subjects || nextStudent.subjects, status: savedPreferences.status || nextStudent.status };
        setStudents(current => current.map(student => student.id === selectedStudent.id ? syncedStudent : student));
        setSelectedStudent(syncedStudent);
        setProfileSavedAt(new Date().toLocaleTimeString('zh-CN', {hour:'2-digit', minute:'2-digit', second:'2-digit'}));
        notify(`${nextStudent.name} 资料已同步到云端`);
        return;
      } catch (error) {
        notify(error?.message || '保存到云端失败，请稍后重试');
        return;
      }
    }
    setStudents(current => current.map(student => student.id === selectedStudent.id ? nextStudent : student));
    setSelectedStudent(nextStudent);
    setProfileSavedAt(new Date().toLocaleTimeString('zh-CN', {hour:'2-digit', minute:'2-digit', second:'2-digit'}));
    notify(`${nextStudent.isTestAccount ? '测试账号' : nextStudent.name}资料已保存，学生端已同步更新`);
  };
  const normalizedSubject = name => name.includes('政治') ? '政治' : name.includes('英语') ? '英语' : name.includes('数学') ? '数学' : '专业课';
  const studentExamSubjects = selectedStudent?.subjects?.map(item => normalizedSubject(item.name)).filter((item, index, list) => list.indexOf(item) === index) || [];
  useEffect(() => {
    setAssignedPlans(selectedStudent?.assignedPlans || []);
    setAssignmentSubject(null);
    setSelectedPersonalPlanId(null);
    setShowFutureTasks(false);
    setShowHomeworkCompletion(false);
    setShowAllTasks(false);
    setShowAssessmentPush(false);
    setShowEntranceTest(false);
    setProfileDraft(selectedStudent ? {
      name: selectedStudent.name || '',
      year: selectedStudent.year || '',
      phone: selectedStudent.phone || '',
      wechatId: selectedStudent.wechatId || '',
      idCard: selectedStudent.idCard || '',
      shippingRecipient: selectedStudent.shippingRecipient || '',
      shippingPhone: selectedStudent.shippingPhone || '',
      shippingInfo: selectedStudent.shippingInfo || '',
      school: selectedStudent.school || '',
      targetScore: selectedStudent.targetScore || '',
      stage: selectedStudent.stage || '基础',
      progress: Number(selectedStudent.progress) || 0,
      evaluation: selectedStudent.evaluation || '',
      subjects: (selectedStudent.subjects || []).map(item => ({...item, targetScore:item.targetScore || ''}))
    } : {name:'', year:'', phone:'', idCard:'', shippingInfo:'', school:'', targetScore:'', stage:'基础', progress:0, evaluation:'', subjects:[]});
    setProfileSavedAt(null);
  }, [selectedStudent?.id]);

  const persistAssessmentPush = async (nextStudent, successMessage) => {
    if (isApiConfigured()) {
      try {
        const saved = await apiRequest(`/api/students/${encodeURIComponent(nextStudent.id)}/preferences`, {
          method: 'PATCH', body: { assessmentPush: nextStudent.assessmentPush }
        });
        nextStudent = { ...nextStudent, assessmentPush: saved.assessmentPush || nextStudent.assessmentPush };
      } catch (error) {
        notify(error?.message || '自测设置保存失败，请稍后重试');
        return;
      }
    }
    setStudents(currentList => currentList.map(item => item.id === selectedStudent.id ? nextStudent : item));
    setSelectedStudent(nextStudent);
    notify(successMessage);
  };

  const applyAssessmentPush = async enabled => {
    if (!selectedStudent) return;
    const current = getAssessmentPush(selectedStudent);
    const subjectSettings = Object.fromEntries(
      Object.keys(current.subjectSettings).map(subject => [
        subject,
        { daily: !!enabled, weekly: !!enabled, monthly: !!enabled }
      ])
    );
    const nextPush = normalizeAssessmentPush({
      ...current,
      subjectSettings,
      assignedAt: enabled ? (current.assignedAt || new Date().toISOString()) : null,
      optedOut: !enabled
    });
    const nextStudent = {...selectedStudent, assessmentPush: nextPush};
    await persistAssessmentPush(nextStudent, enabled ? `已为 ${selectedStudent.name} 开通全部报名科目的日/周/月自测` : `已停止 ${selectedStudent.name} 的全部自测`);
  };

  const toggleAssessmentType = async (subject, typeId, on) => {
    if (!selectedStudent) return;
    const current = getAssessmentPush(selectedStudent);
    const nextPush = normalizeAssessmentPush({
      ...current,
      subjectSettings: {
        ...current.subjectSettings,
        [subject]: {...(current.subjectSettings?.[subject] || {}), [typeId]: !!on}
      },
      assignedAt: on ? (current.assignedAt || new Date().toISOString()) : current.assignedAt,
      optedOut: false
    });
    const nextStudent = {...selectedStudent, assessmentPush: nextPush};
    await persistAssessmentPush(nextStudent, on ? `已开始 ${subject}${getAssessmentSpec(typeId)?.short || '自测'}` : `已停止 ${subject}${getAssessmentSpec(typeId)?.short || '自测'}`);
  };

  const saveStudentProfile = async () => {
    if (!studentForm.name.trim()) return notify('请填写学员姓名');
    if (!studentForm.phone.trim()) return notify('请填写联系电话，否则无法生成登录账号');
    if (!/^1\d{10}$/.test(studentForm.phone.trim())) return notify('手机号须为 1 开头的 11 位数字');
    const phone = studentForm.phone.trim();
    const draft = {
      id: Date.now(), intakeToken: createIntakeToken(), name: studentForm.name.trim(), year: '2027 考研', status: studentForm.group,
      subjects: studentForm.subjects.map(name => ({name, enrolled:false})),
      progress: 0, stage: studentForm.stage, phone, idCard: '待补充',
      shippingInfo: studentForm.shippingInfo.trim() || '待补充',
      school: studentForm.school.trim() || '待填写', targetScore: studentForm.targetScore.trim() || '待确定',
      evaluation: '待完成入学自测后生成综合评价。', assignedPlans: []
    };
    if (isApiConfigured()) {
      try {
          const result = await apiRequest('/api/admin/students', {
            method: 'POST',
            body: {
              name: draft.name,
              phone,
              year: draft.year,
              status: draft.status,
              shippingInfo: draft.shippingInfo,
              school: draft.school,
              targetScore: draft.targetScore,
              stage: draft.stage,
              evaluation: draft.evaluation,
              subjects: draft.subjects.map(item => item.name)
            }
          });
          const account = result?.account;
          const serverStudent = result?.student;
        if (account?.studentId && serverStudent) {
          const normalized = {
            ...serverStudent,
            id: account.studentId,
            accountId: account.id,
            name: serverStudent.name || account.name,
            phone: serverStudent.phone || phone,
            email: serverStudent.email || '',
            intakeToken: draft.intakeToken,
            progress: draft.progress,
            subjects: serverStudent.subjects || draft.subjects,
            assignedPlans: draft.assignedPlans,
            taskCheckins: [],
            purchasedProductIds: [],
            purchasedCourseIds: [],
            assessmentRecords: [],
            entranceRecords: [],
            restWeekday: null,
            restWeekdaySetAt: null,
            assessmentPush: null,
            planAdjustmentAutomation: null,
            taskAdjustmentDraft: null,
            taskAdjustmentHistory: [],
            accountState: '正常',
            disabledAt: null,
            isTestAccount: false,
            isServerManaged: true,
            tempPassword: result?.tempPassword || null
          };
          setStudents(current => [...current, normalized]);
          setAccounts(current => {
            const exists = current.some(item => String(item.id) === String(account.id));
            if (exists) return current.map(item => String(item.id) === String(account.id) ? { ...item, name: account.name, phone: account.phone, mustChangePassword: true } : item);
            return [...current, { ...account, sessionVersion: getSessionAuthVersion(account, null), authVersion: getSessionAuthVersion(account, null), status: '启用', mustChangePassword: true }];
          });
          setStudentForm({name:'', phone:'', shippingInfo:'', school:'', targetScore:'', group:'新人', stage:'基础', subjects:[]});
          setView('list');
          if (normalized.tempPassword) {
            window.alert(`已创建学员「${normalized.name}」\n初始登录密码：${normalized.tempPassword}\n请通过安全渠道转交，并要求首次登录后修改。`);
            notify('已创建学员账号，初始密码请通过安全渠道转交');
          } else {
            notify(`已建立 ${normalized.name} 档案`);
          }
          return;
        }
        notify('创建账号成功，但未返回学员档案，请刷新学员列表');
        return;
      } catch (error) {
        notify(error?.message || '创建学员失败，请稍后重试');
        return;
      }
    }
    const student = applyPaidAssessmentDefaults(draft);
    setStudents(current => [...current, student]);
    setStudentForm({name:'', phone:'', shippingInfo:'', school:'', targetScore:'', group:'新人', stage:'基础', subjects:[]});
    setView('list');
    notify(student.status === '付费'
      ? `已建立 ${student.name} 档案（付费学员已默认开通日/周/月自测，可随时关闭）`
      : `已建立 ${student.name} 档案，并归入${student.status}学员`);
  };
  const importStudents = file => {
    if (!file) return;
    readWorkbookSafely(file, async (workbook, worksheet) => {
      try {
        const rows = XLSX.utils.sheet_to_json(worksheet, {defval:''});
        if (!rows.length || !Object.prototype.hasOwnProperty.call(rows[0], '姓名')) throw new Error('模板字段不匹配');
        const imported = rows.filter(row => String(row.姓名).trim()).map((row, index) => ({
          name: String(row.姓名).trim(),
          year: String(row.考研年份 || '2027 考研').trim(),
          status: importGroup,
          subjects: String(row.报考科目 || '政治、英语').split(/[、,，\s]+/).filter(Boolean),
          stage: String(row.复习阶段 || '基础').trim(),
          phone: String(row.电话 || '').trim(),
          shippingInfo: String(row.收货信息 || '').trim() || null,
          school: String(row.报考学校 || '').trim() || null,
          targetScore: String(row.目标分数 || '').trim() || null,
          evaluation: '待完成入学自测后生成综合评价。',
          sourceIndex: index + 2
        }));
        if (!imported.length) throw new Error('没有可导入的学员');
        if (isApiConfigured()) {
          const invalidPhone = imported.find(item => !/^1\d{10}$/.test(item.phone));
          if (invalidPhone) throw new Error(`第 ${invalidPhone.sourceIndex} 行联系电话须为 1 开头的 11 位数字`);
          const result = await apiRequest('/api/admin/students/import', {
            method: 'POST',
            body: { students: imported.map(({sourceIndex, ...item}) => item) }
          });
          const created = (result?.created || []).map(item => ({
            ...item.student,
            id: item.account?.studentId || item.student?.id,
            accountId: item.account?.id,
            assignedPlans: [], taskCheckins: [], purchasedProductIds: [], purchasedCourseIds: [],
            assessmentRecords: [], entranceRecords: [], restWeekday: null, restWeekdaySetAt: null,
            assessmentPush: null, planAdjustmentAutomation: null, taskAdjustmentDraft: null,
            taskAdjustmentHistory: [], accountState: '正常', disabledAt: null,
            isTestAccount: false, isServerManaged: true, tempPassword: item.tempPassword || null
          }));
          setStudents(current => [...current, ...created]);
          setAccounts(current => [...current, ...(result?.created || []).map(item => { const version = getSessionAuthVersion(item.account, null); return { ...item.account, sessionVersion:version, authVersion:version }; })]);
          notify(`已在服务端创建 ${created.length} 名学员账号；临时密码仅显示一次，请在导入结果中安全保存`);
          if (result?.created?.length) {
            window.alert(result.created.map(item => `${item.student.name}（${item.account.phone}）：${item.tempPassword}`).join('\n'));
          }
          return;
        }
        const localStudents = imported.map((item, index) => applyPaidAssessmentDefaults({
          id: Date.now() + index, intakeToken: createIntakeToken(), ...item,
          subjects: item.subjects.map(name => ({name, enrolled:false})), progress: 0,
          idCard: '待补充', shippingInfo: item.shippingInfo || '待补充', school: item.school || '待填写',
          targetScore: item.targetScore || '待确定', assignedPlans: []
        }));
        setStudents(current => [...current, ...localStudents]);
        notify(importGroup === '付费'
          ? `已导入 ${localStudents.length} 名付费学员（默认开通日/周/月自测，可单独关闭）`
          : `已导入 ${localStudents.length} 名学员到${importGroup}学员`);
      } catch (error) {
        notify(error?.message || '无法导入学员名单，请检查模板和数据后重试');
      }
    }, () => notify('无法读取学员名单，请确认文件小于 10 MB 且不超过 10000 行'));
  };
  const toggleFormSubject = item => setStudentForm(current => ({...current, subjects: current.subjects.includes(item) ? current.subjects.filter(subject => subject !== item) : [...current.subjects, item]}));
  const removeStudent = async (id) => {
    if (String(id) === TEST_STUDENT_ID) return notify('测试账号为双端同步验证保留，不能停用');
    const student = students.find(item => String(item.id) === String(id));
    if (!student) return;
    if (student.accountState === '已停用') return notify('该学员账号已停用，历史记录仍保留');
    if (!window.confirm(`停用学员「${student.name}」吗？其登录账号会同步停用，历史订单与学习记录仍会保留。`)) return;
    const account = findStudentAccount(student);
    if (isApiConfigured() && account?.id) {
      try {
        await apiRequest(`/api/admin/accounts/${account.id}`, { method: 'PATCH', body: { status: '停用' } });
        setStudents(current => current.map(item => String(item.id) === String(id) ? {...item, accountState:'已停用', disabledAt:new Date().toISOString()} : item));
        setAccounts(current => current.map(item => item.id === account.id ? {...item, status:'停用', disabledAt:new Date().toISOString()} : item));
        if(selectedStudent?.id === id) setSelectedStudent(null);
        notify('学员与关联登录账号已停用；历史记录已保留');
      } catch (error) {
        notify(error?.message || '停用失败，请稍后重试');
      }
      return;
    }
    setStudents(current => current.map(item => String(item.id) === String(id) ? {...item, accountState:'已停用', disabledAt:new Date().toISOString()} : item));
    setAccounts(current => current.map(account => account.role === 'student' && String(account.studentId) === String(id) ? {...account, status:'停用', disabledAt:new Date().toISOString()} : account));
    if(selectedStudent?.id === id) setSelectedStudent(null);
    notify('学员与关联登录账号已停用；历史记录已保留');
  };
  const restoreStudent = async id => {
    const student = students.find(item => String(item.id) === String(id));
    if (!student || student.accountState !== '已停用') return;
    const account = findStudentAccount(student);
    if (isApiConfigured() && account?.id) {
      try {
        await apiRequest(`/api/admin/accounts/${account.id}`, { method: 'PATCH', body: { status: '启用' } });
        setStudents(current => current.map(item => String(item.id) === String(id) ? {...item, accountState:'正常', disabledAt:null} : item));
        setAccounts(current => current.map(item => item.id === account.id ? {...item, status:'启用', disabledAt:null} : item));
        notify(`已恢复 ${student.name} 的登录账号；历史学习记录始终保留`);
      } catch (error) {
        notify(error?.message || '恢复失败，请稍后重试');
      }
      return;
    }
    setStudents(current => current.map(item => String(item.id) === String(id) ? {...item, accountState:'正常', disabledAt:null} : item));
    setAccounts(current => current.map(account => account.role === 'student' && String(account.studentId) === String(id) ? {...account, status:'启用', disabledAt:null} : account));
    notify(`已恢复 ${student.name} 的登录账号；历史学习记录始终保留`);
  };
  const assignPlan = async plan => {
    if (!assignmentSubject || !plan) return;
    const assignment = {
      id: plan.id, subject: assignmentSubject, sourcePlanId: plan.id, name: plan.name, category: plan.category,
      courseId: plan.courseId || plan.course_id || null, taskType:'阶段', lane:1, startDay:1, startDate:null, predecessorPlanId:null, predecessorAssignmentId:null, revision:plan.revision || null, assignedAt:new Date().toISOString(),
      columns: [...(plan.columns || defaultReviewColumns)],
      rows: plan.rows.map(row => ({
        ...row,
        completed: false,
        tasks: [...(row.tasks || [])],
        attachments: [...(row.attachments || [])],
        taskDone: Array((row.tasks || []).length).fill(false)
      })),
      customTasks: []
    };
    if (isApiConfigured() && selectedStudent?.id && !selectedStudent.isTestAccount) {
      try {
        const created = await apiRequest(`/api/students/${selectedStudent.id}/plans`, {
          method: 'POST',
          body: buildStudentPlanPayload({
            ...plan,
            subject: assignmentSubject,
            taskType: plan.taskType || '阶段',
            predecessorPlanId: plan.predecessorPlanId || plan.predecessor_plan_id || null,
          })
        });
        Object.assign(assignment, {
          ...created,
          id: created.id || assignment.id,
          courseId: created.course_id || created.courseId || assignment.courseId,
          predecessorPlanId: created.predecessor_plan_id || created.predecessorPlanId || assignment.predecessorPlanId,
          predecessorAssignmentId: created.predecessor_plan_id || created.predecessorPlanId || assignment.predecessorAssignmentId,
          startDay: created.start_day || created.startDay || assignment.startDay,
          startDate: normalizeDateOnly(created.start_date || created.startDate) || assignment.startDate,
          revision: created.revision ?? assignment.revision,
        });
      } catch (error) {
        notify(error?.message || '分配计划失败，请稍后重试');
        return;
      }
    }
    const nextPlans = [...assignedPlans, assignment];
    setAssignedPlans(nextPlans);
    setStudents(students.map(student => student.id === selectedStudent.id ? {...student, assignedPlans:nextPlans} : student));
    setSelectedStudent({...selectedStudent, assignedPlans:nextPlans});
    setAssignmentSubject(null);
    notify(`已将「${plan.name}」分配给 ${selectedStudent.name}`);
  };
  const subjectPlans = assignedPlans.filter(plan => plan.subject === futureTaskSubject);
  const completedAssignmentIds = new Set(subjectPlans.filter(plan => plan.rows.length > 0 && plan.rows.every(row => isRowComplete(row))).map(plan => String(plan.id)));
  const planCanRunNow = plan => { const predecessor = plan.predecessorAssignmentId || plan.predecessorPlanId; return isPlanDateUnlocked(plan) && (!predecessor || completedAssignmentIds.has(String(predecessor))); };
  const longTermFuturePlans = subjectPlans.filter(plan => plan.taskType === '长期' && planCanRunNow(plan));
  const currentFuturePlans = subjectPlans.filter(plan => plan.taskType !== '长期' && planCanRunNow(plan));
  const lockedFuturePlans = subjectPlans.filter(plan => !planCanRunNow(plan));
  const expandTaskRows = (plans, maxDay = Infinity) => plans.flatMap(plan => {
    const sourceRows = plan.rows || [];
    const startDay = Number(plan.startDay) || 1;
    const isLongTerm = plan.taskType === '长期';
    const repeatCount = isLongTerm ? Math.max(0, maxDay - startDay + 1) : Math.min(sourceRows.length, Math.max(0, maxDay - startDay + 1));
    const rows = isLongTerm && sourceRows.length
      ? Array.from({length:repeatCount}, (_, index) => ({...sourceRows[index % sourceRows.length], rowIndex:index % sourceRows.length, dayNumber:startDay + index}))
      : sourceRows.slice(0, repeatCount).map((row, rowIndex) => ({...row, rowIndex, dayNumber:startDay + rowIndex}));
    return rows.map(row => ({...row, completed: isRowComplete(row), planId:plan.id, planName:plan.name, taskType:plan.taskType || '阶段', lane:plan.lane || 1}));
  });
  const futureDays = [...expandTaskRows(longTermFuturePlans, 30), ...expandTaskRows(currentFuturePlans, 30)].sort((left, right) => left.dayNumber - right.dayNumber || left.lane - right.lane || Number(left.completed) - Number(right.completed));
  const futurePreviewDays = Array.from({length:30}, (_, index) => {
    const dayNumber = index + 1;
    const tasks = futureDays.filter(task => task.dayNumber === dayNumber);
    return {dayNumber, tasks, completed:tasks.length > 0 && tasks.every(task => task.completed)};
  }).filter(day => day.tasks.length);
  const allTaskRows = [...expandTaskRows(longTermFuturePlans, 365), ...expandTaskRows(currentFuturePlans, 365)].sort((left, right) => left.dayNumber - right.dayNumber || left.lane - right.lane || Number(left.completed) - Number(right.completed));
  const groupTasksByDay = rows => Array.from(rows.reduce((groups, task) => {
    const group = groups.get(task.dayNumber) || {dayNumber:task.dayNumber, tasks:[]};
    group.tasks.push(task);
    groups.set(task.dayNumber, group);
    return groups;
  }, new Map()).values());
  const futureTaskDays = groupTasksByDay(futureDays);
  const allTaskDays = groupTasksByDay(allTaskRows);
  const completedFutureDays = futureDays.filter(row => row.completed).length;
  const toggleFutureDay = (planId, rowIndex) => updatePersonalPlanById(planId, plan => ({
    ...plan,
    rows: plan.rows.map((row, index) => {
      if (index !== rowIndex) return row;
      const nextCompleted = !isRowComplete(row);
      return {
        ...row,
        completed: nextCompleted,
        taskDone: (row.tasks || []).map(() => nextCompleted)
      };
    })
  }));
  const togglePlanAdjustmentAutomation = enabled => {
    if (!selectedStudent) return;
    const current = getPlanAdjustmentAutomation(selectedStudent);
    const automation = {
      ...current,
      enabled: !!enabled,
      intervalDays: 0,
      lastCheckedAt: enabled ? current.lastCheckedAt : null
    };
    const nextStudent = {...selectedStudent, planAdjustmentAutomation: automation};
    setStudents(currentStudents => currentStudents.map(item => item.id === selectedStudent.id ? nextStudent : item));
    setSelectedStudent(nextStudent);
    notify(enabled ? '任务监管机器人已开启：收到学生完成反馈后会生成调整方案' : '任务监管机器人已关闭：不再读取新的完成反馈');
  };
  const applyAdjustmentChanges = (plans, adjustment) => plans.map(plan => ({
    ...plan,
    rows: (plan.rows || []).map((row, rowIndex) => ({
      ...row,
      tasks: (row.tasks || []).map((text, taskIndex) => {
        const change = adjustment.changes.find(item => item.planId === plan.id && item.rowIndex === rowIndex && item.taskIndex === taskIndex && item.before === text);
        return change ? change.after : text;
      })
    }))
  }));
  const runPlanAdjustmentScan = () => {
    if (!automation.enabled) return notify('请先开启任务监管机器人');
    const checkins = selectedStudent?.taskCheckins || [];
    if (!checkins.length) return notify('暂未收到学生完成反馈，机器人已保持待机');
    const scanAutomation = {...automation, lastCheckedAt:null};
    const scheduled = runScheduledPlanAdjustment({plans:assignedPlans, checkins, automation:scanAutomation, rules:getPlanAssistantAdjustmentRules(aiSettings)});
    const adjustment = scheduled.adjustment;
    if (!adjustment) {
      const nextStudent = {...selectedStudent, planAdjustmentAutomation:scheduled.automation};
      setStudents(current => current.map(item => item.id === selectedStudent.id ? nextStudent : item));
      setSelectedStudent(nextStudent);
      return notify('已读取完成反馈，当前没有需要调整的后续数量任务');
    }
    if (automation.autoCalibrate) {
      const nextPlans = scheduled.plans;
      const nextStudent = {...selectedStudent, assignedPlans:nextPlans, planAdjustmentAutomation:scheduled.automation, taskAdjustmentHistory:[...(selectedStudent.taskAdjustmentHistory || []), adjustment].slice(-20), taskAdjustmentDraft:null};
      setAssignedPlans(nextPlans);
      setStudents(current => current.map(item => item.id === selectedStudent.id ? nextStudent : item));
      setSelectedStudent(nextStudent);
      return notify(`AI 自动校准已导入 ${adjustment.changes.length} 项后续任务调整`);
    }
    const nextStudent = {...selectedStudent, planAdjustmentAutomation:scheduled.automation, taskAdjustmentDraft:adjustment};
    setStudents(current => current.map(item => item.id === selectedStudent.id ? nextStudent : item));
    setSelectedStudent(nextStudent);
    notify(`已生成 ${adjustment.changes.length} 项任务调整建议，等待确认导入`);
  };
  const applySinglePlanAdjustment = change => {
    const draft = selectedStudent?.taskAdjustmentDraft;
    if (!draft) return notify('当前没有待落实的 AI 调整');
    const nextPlans = applyAdjustmentChanges(assignedPlans, {changes:[change]});
    const remainingChanges = draft.changes.filter(item => !(item.planId === change.planId && item.rowIndex === change.rowIndex && item.taskIndex === change.taskIndex));
    const applied = {...draft, id:`${draft.id}-${change.planId}-${change.rowIndex}-${change.taskIndex}`, changes:[change], status:'已确认导入', appliedAt:new Date().toISOString()};
    const nextDraft = remainingChanges.length ? {...draft, changes:remainingChanges} : null;
    const nextStudent = {...selectedStudent, assignedPlans:nextPlans, taskAdjustmentDraft:nextDraft, taskAdjustmentHistory:[...(selectedStudent.taskAdjustmentHistory || []), applied].slice(-20)};
    setAssignedPlans(nextPlans);
    setStudents(current => current.map(item => item.id === selectedStudent.id ? nextStudent : item));
    setSelectedStudent(nextStudent);
    notify(`已落实 AI 建议：${change.after}`);
  };
  const confirmPlanAdjustmentDraft = () => {
    const draft = selectedStudent?.taskAdjustmentDraft;
    if (!draft?.changes?.length) return notify('当前没有待确认的调整方案');
    const nextPlans = applyAdjustmentChanges(assignedPlans, draft);
    const applied = {...draft, status:'已确认导入', appliedAt:new Date().toISOString()};
    const nextStudent = {...selectedStudent, assignedPlans:nextPlans, taskAdjustmentDraft:null, taskAdjustmentHistory:[...(selectedStudent.taskAdjustmentHistory || []), applied].slice(-20)};
    setAssignedPlans(nextPlans);
    setStudents(current => current.map(item => item.id === selectedStudent.id ? nextStudent : item));
    setSelectedStudent(nextStudent);
    notify(`已确认导入 ${draft.changes.length} 项后续任务调整`);
  };
  const togglePlanAutoCalibrate = () => {
    if (!automation.enabled) return notify('请先开启任务监管机器人');
    const nextAutomation = {...automation, autoCalibrate:!automation.autoCalibrate};
    const nextStudent = {...selectedStudent, planAdjustmentAutomation:nextAutomation};
    setStudents(current => current.map(item => item.id === selectedStudent.id ? nextStudent : item));
    setSelectedStudent(nextStudent);
    notify(nextAutomation.autoCalibrate ? 'AI 自动校准已开启：后续符合条件的方案将自动导入' : 'AI 自动校准已关闭：后续方案需教师确认导入');
  };
  const undoLatestPlanAdjustment = () => {
    const history = selectedStudent?.taskAdjustmentHistory || [];
    const latest = history[history.length - 1];
    if (!latest) return notify('暂无可撤销的任务调整');
    const nextPlans = assignedPlans.map(plan => ({...plan, rows:(plan.rows || []).map((row, rowIndex) => ({...row, tasks:(row.tasks || []).map((text, taskIndex) => {
      const change = latest.changes.find(item => item.planId === plan.id && item.rowIndex === rowIndex && item.taskIndex === taskIndex && item.after === text);
      return change ? change.before : text;
    })}))}));
    setAssignedPlans(nextPlans);
    const nextStudent = {...selectedStudent, assignedPlans:nextPlans, taskAdjustmentHistory:history.slice(0, -1)};
    setStudents(students.map(student => student.id === selectedStudent.id ? nextStudent : student));
    setSelectedStudent(nextStudent);
    notify('已撤销最近一次自动任务调整');
  };
  const hasConcreteTaskContent = task => Boolean((task.tasks || []).some(item => String(item || '').trim()) || String(task.note || '').trim());
  const getAiSuggestion = () => null;
  const assessmentArchiveRecords = getStudentAssessmentArchive(selectedStudent, entranceState);
  const planAssistantReady = isAiSlotReady(aiSettings, 'plan_assistant');
  const reportReady = isAiSlotReady(aiSettings, 'learning_report');
  const coachSlotReady = planAssistantReady || reportReady;
  const coachSlotConfig = planAssistantReady
    ? getAiSlotConfig(aiSettings, 'plan_assistant')
    : getAiSlotConfig(aiSettings, 'learning_report');
  const aiReviewCoach = buildAiReviewCoachSuggestions({
    student: selectedStudent,
    futureDays,
    completedCount: completedFutureDays,
    totalCount: futureDays.length,
    archiveRecords: assessmentArchiveRecords,
    slotReady: coachSlotReady,
    slotConfig: coachSlotConfig,
    aiSettings,
  });
  const automation = getPlanAdjustmentAutomation(selectedStudent);
  const renderFutureTaskAdjustmentControls = () => (
    <section className="future-ai-adjustment-controls">
      <div className="future-ai-adjustment-head">
        <div><span className="eyebrow">计划助手机器人</span><h3>AI 任务调整</h3><p>{automation.enabled ? '正在读取学生完成反馈，调整建议只作用于未来 30 天未执行任务。' : '机器人已关闭。开启后会读取学生反馈并生成未来任务调整建议。'}</p></div>
        <span className={`badge ${automation.enabled ? 'ok' : 'pending'}`}>{automation.enabled ? '运行中' : '已关闭'}</span>
      </div>
      <div className="future-ai-adjustment-actions">
        <button type="button" className={!automation.enabled ? 'primary' : 'secondary'} onClick={() => togglePlanAdjustmentAutomation(false)}>关闭</button>
        <button type="button" className={automation.enabled ? 'primary' : 'secondary'} onClick={() => togglePlanAdjustmentAutomation(true)}>开启</button>
        <button type="button" className={automation.autoCalibrate ? 'primary' : 'secondary'} onClick={togglePlanAutoCalibrate} disabled={!automation.enabled}>{automation.autoCalibrate ? '自动落实已开启' : '自动落实'}</button>
      </div>
      <div className="future-ai-adjustment-status"><span>学生反馈：{(selectedStudent?.taskCheckins || []).length} 条</span><span>{automation.autoCalibrate ? '实时监控并自动替换' : '生成建议后逐条落实'}</span><small>{automation.lastCheckedAt ? `最近分析：${formatAccountLogin(automation.lastCheckedAt)}` : '暂无完成反馈，机器人待机'}</small></div>
    </section>
  );

  const renderTaskDayList = (days, emptyMessage, showAdjustment = false) => {
    const draftChanges = selectedStudent?.taskAdjustmentDraft?.changes || [];
    const showAiSuggestion = showAdjustment;
    const suggestionWaitingText = !automation.enabled
      ? 'AI 已关闭'
      : (selectedStudent?.taskCheckins || []).length
        ? '正在根据反馈分析'
        : '等待学生反馈';

    if (!days.length) {
      return <div className="empty-line"><ClipboardCheck size={20}/><span>{emptyMessage}</span></div>;
    }

    return (
      <div className={`daily-combined-list ${showAiSuggestion ? 'has-ai-suggestion' : ''}`}>
        {days.map(day => {
          const lanes = [...new Set(day.tasks.map(task => task.lane))];
          const completedCount = day.tasks.filter(task => task.completed).length;

          return (
            <section className="daily-combined-day" key={day.dayNumber}>
              <header className="daily-day-header">
                <span className="daily-day-index">{String(day.dayNumber).padStart(2, '0')}</span>
                <div>
                  <h4>第 {day.dayNumber} 天</h4>
                  <p>{day.tasks.length} 项任务 · {lanes.map(lane => `轨道 ${lane}`).join('、')}</p>
                </div>
                <span className={`daily-day-status ${completedCount === day.tasks.length ? 'is-done' : ''}`}>
                  {completedCount === day.tasks.length ? '已完成' : completedCount ? `已完成 ${completedCount}/${day.tasks.length}` : '待执行'}
                </span>
              </header>
              <div className="daily-task-table">
                <div className="daily-task-table-head">
                  <span>状态</span><span>轨道</span><span>类型</span><span>基础任务</span><span>当天内容</span>
                  {showAiSuggestion && <span>AI 建议调整</span>}
                  <span>操作</span>
                </div>
                {day.tasks.map(task => {
                  const changes = draftChanges.filter(change =>
                    change.planId === task.planId && change.rowIndex === task.rowIndex
                  );

                  return (
                    <div className={`daily-task-table-row ${task.completed ? 'is-complete' : ''}`} key={`${task.planId}-${task.dayNumber}-${task.rowIndex}`}>
                      <button className="daily-task-check" onClick={() => toggleFutureDay(task.planId, task.rowIndex)} aria-label={task.completed ? '标记为未完成' : '标记为已完成'}>
                        {task.completed && <Check size={14}/>}
                      </button>
                      <span className={`lane-tag lane-${task.lane}`}>轨道 {task.lane}</span>
                      <span className={`task-type-tag ${task.taskType === '长期' ? 'is-long' : 'is-stage'}`}>{task.taskType === '长期' ? '长期' : '阶段'}</span>
                      <button className="daily-task-name" onClick={() => setSelectedPersonalPlanId(task.planId)}>{task.planName}</button>
                      <span className="daily-task-detail">{task.tasks.filter(Boolean).join(' · ') || task.note || '当天暂未填写任务'}</span>
                      {showAiSuggestion && (
                        <span className="ai-task-suggestion">
                          {changes.length ? changes.map(change => (
                            <span className="ai-task-suggestion-item" key={`${change.planId}-${change.rowIndex}-${change.taskIndex}`}>
                              <b>AI 建议</b>
                              <span>建议替换为：{change.after}</span>
                              <button type="button" className="secondary" onClick={() => applySinglePlanAdjustment(change)}>落实</button>
                            </span>
                          )) : (
                            <span className="ai-task-suggestion-item ai-task-suggestion-idle">
                              <b>AI 建议</b>
                              <span>{suggestionWaitingText}</span>
                              <button type="button" className="secondary" disabled>落实</button>
                            </span>
                          )}
                        </span>
                      )}
                      <button className="daily-task-open" onClick={() => setSelectedPersonalPlanId(task.planId)}>查看<ChevronRight size={14}/></button>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    );
  };
  const updatePersonalPlanById = (planId, updater) => {
    const nextPlans = assignedPlans.map(plan => plan.id === planId ? updater(plan) : plan);
    setAssignedPlans(nextPlans);
    setStudents(students.map(student => student.id === selectedStudent.id ? {...student, assignedPlans:nextPlans} : student));
    setSelectedStudent({...selectedStudent, assignedPlans:nextPlans});
  };
  const setPlanStartDate = async (plan, startDate) => {
    const normalized = startDate || null;
    if (isApiConfigured() && selectedStudent?.id && !selectedStudent.isTestAccount) {
      try {
        const updated = await apiRequest(`/api/students/${selectedStudent.id}/plans/${plan.id}/start-date`, {
          method: 'PATCH',
          body: { startDate:normalized }
        });
        const savedStartDate = normalizeDateOnly(updated?.start_date || updated?.startDate) || normalized;
        updatePersonalPlanById(plan.id, item => ({ ...item, startDate:savedStartDate, start_date:savedStartDate }));
        notify(normalized ? `已设置「${plan.name}」于 ${formatPlanStartDate(normalized)} 当日解锁` : `已取消「${plan.name}」的日期限制`);
      } catch (error) {
        notify(error?.message || '保存任务开始日期失败，请稍后重试');
      }
      return;
    }
    updatePersonalPlanById(plan.id, item => ({ ...item, startDate:normalized, start_date:normalized }));
    notify(normalized ? `已设置「${plan.name}」于 ${formatPlanStartDate(normalized)} 当日解锁` : `已取消「${plan.name}」的日期限制`);
  };
  const selectedPersonalPlan = assignedPlans.find(plan => plan.id === selectedPersonalPlanId);
  const updatePersonalPlan = updater => {
    const nextPlans = assignedPlans.map(plan => plan.id === selectedPersonalPlanId ? updater(plan) : plan);
    setAssignedPlans(nextPlans);
    setStudents(students.map(student => student.id === selectedStudent.id ? {...student, assignedPlans:nextPlans} : student));
    setSelectedStudent({...selectedStudent, assignedPlans:nextPlans});
  };
  const removePersonalPlanAttachment = (rowIndex, attachmentId) => {
    const attachment = selectedPersonalPlan?.rows?.[rowIndex]?.attachments?.find(item => item.id === attachmentId);
    if (attachment?.objectUrl) URL.revokeObjectURL(attachment.objectUrl);
    updatePersonalPlan(plan => ({
      ...plan,
      rows: plan.rows.map((row, index) => index === rowIndex ? {
        ...row,
        attachments: (row.attachments || []).filter(item => item.id !== attachmentId)
      } : row)
    }));
    notify('已移除该学员任务附件');
  };
  const addPersonalPlanAttachment = (rowIndex, file) => {
    if (isApiConfigured()) return notify('个人计划附件接口尚未部署；未保存浏览器临时文件。');
    if (!file) return;
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) return notify('任务附件仅支持 PDF 文件');
    if (file.size > 100 * 1024 * 1024) return notify('单个 PDF 附件请控制在 100MB 以内');
    const attachment = {id:`student-task-file-${Date.now()}-${file.name}`, fileName:file.name, fileSize:file.size, fileType:'application/pdf', objectUrl:URL.createObjectURL(file), temporary:true, uploadedAt:new Date().toISOString()};
    updatePersonalPlan(plan => ({
      ...plan,
      rows: plan.rows.map((row, index) => index === rowIndex ? {
        ...row,
        attachments: [...(row.attachments || []), attachment]
      } : row)
    }));
    notify(`已为 ${selectedStudent.name} 的个人任务添加附件「${file.name}」`);
  };
  const deletePersonalPlan = async () => {
    if (!selectedPersonalPlanId) return;
    if (isApiConfigured() && selectedStudent?.id && !selectedStudent.isTestAccount) {
      try {
        await apiRequest(`/api/students/${selectedStudent.id}/plans/${selectedPersonalPlanId}`, {
          method: 'DELETE',
          body: { revision: selectedPersonalPlan?.revision }
        });
      } catch (error) {
        notify(error?.status === 409 ? '计划已被其他人修改，请重新加载后再删除' : (error?.message || '删除计划失败，请稍后重试'));
        return;
      }
    }
    const nextPlans = assignedPlans.filter(plan => plan.id !== selectedPersonalPlanId);
    setAssignedPlans(nextPlans);
    setStudents(students.map(student => student.id === selectedStudent.id ? {...student, assignedPlans:nextPlans} : student));
    setSelectedStudent({...selectedStudent, assignedPlans:nextPlans});
    setSelectedPersonalPlanId(null);
    notify('已删除该学员的个人计划副本');
  };
  const savePersonalPlan = async () => {
    if (!selectedPersonalPlan || !selectedStudent) return;
    if (isApiConfigured() && !selectedStudent.isTestAccount) {
      const payload = buildStudentPlanPayload({
        ...selectedPersonalPlan,
        predecessorPlanId: selectedPersonalPlan.predecessorPlanId || selectedPersonalPlan.predecessorAssignmentId || null,
      }, { includeRevision: true });
      try {
        const updated = await apiRequest(`/api/students/${selectedStudent.id}/plans/${selectedPersonalPlan.id}`, { method: 'PATCH', body: payload });
        const hydrated = {
          ...selectedPersonalPlan,
          ...updated,
          taskType: updated.task_type || updated.taskType || payload.taskType,
          startDay: updated.start_day || updated.startDay || payload.startDay,
          startDate: normalizeDateOnly(updated.start_date || updated.startDate) || payload.startDate,
          predecessorPlanId: updated.predecessor_plan_id || updated.predecessorPlanId || payload.predecessorPlanId,
          predecessorAssignmentId: updated.predecessor_plan_id || updated.predecessorPlanId || payload.predecessorPlanId,
          courseId: updated.course_id || updated.courseId || payload.courseId,
          revision: updated.revision
        };
        updatePersonalPlanById(selectedPersonalPlan.id, () => hydrated);
        notify('学员个人计划已保存到云端');
      } catch (error) {
        notify(error?.status === 409 ? '计划已被其他人修改，请重新加载后再保存' : (error?.message || '保存计划失败，请稍后重试'));
      }
      return;
    }
    notify('学员个人计划已保存');
  };
  if (selectedStudent && selectedPersonalPlan) return <><section><div className="page-head"><div><span className="eyebrow">{selectedStudent.name} · {selectedPersonalPlan.subject}个人计划</span><h1>{selectedPersonalPlan.name}</h1><p>这是分配给该学员的独立计划副本。此处的修改、增添和删除不会影响通用复习规划或其他学员。</p></div><div className="page-actions"><button className="danger-button" onClick={deletePersonalPlan}>删除个人计划</button><button className="secondary" onClick={()=>setSelectedPersonalPlanId(null)}>返回学员档案</button></div></div></section><section className="panel table-panel plan-detail-table"><div className="panel-head"><h2>计划内容</h2><button className="secondary" onClick={()=>updatePersonalPlan(plan=>{const columns=plan.columns || defaultReviewColumns;const nextColumn=`任务${columns.length+1}`;return {...plan,columns:[...columns,nextColumn],rows:plan.rows.map(row=>({...row,tasks:[...(row.tasks || []),'']}))};})}><Plus size={16}/>增加任务列</button></div><div className="plan-detail-scroll"><table><thead><tr><th className="plan-sticky-day">序号</th><th className="plan-sticky-attachment">附件</th>{(selectedPersonalPlan.columns || defaultReviewColumns).map(column=><th key={column}>{column}</th>)}<th>操作</th></tr></thead><tbody>{selectedPersonalPlan.rows.map((row,rowIndex)=><tr key={rowIndex}><td className="plan-sticky-day"><b>{rowIndex+1}</b></td><td className="plan-sticky-attachment"><div className="task-attachment-cell">{(row.attachments || []).map(attachment=><span key={attachment.id}><FileText size={13}/><b>{attachment.fileName}</b><button type="button" aria-label={`移除${attachment.fileName}`} onClick={()=>removePersonalPlanAttachment(rowIndex,attachment.id)}>×</button></span>)}<label className={`quiet-button file-button ${isApiConfigured() ? 'is-disabled' : ''}`}><Upload size={14}/>附件<input disabled={isApiConfigured()} type="file" accept="application/pdf,.pdf" onChange={event=>{addPersonalPlanAttachment(rowIndex,event.target.files?.[0]);event.target.value='';}}/></label></div></td>{(selectedPersonalPlan.columns || defaultReviewColumns).map((column,columnIndex)=><td key={column}><div className="plan-cell"><input value={row.tasks[columnIndex] || ''} onChange={event=>updatePersonalPlan(plan=>({...plan,rows:plan.rows.map((item,index)=>index===rowIndex?{...item,tasks:item.tasks.map((task,taskIndex)=>taskIndex===columnIndex?event.target.value:task)}:item)}))} placeholder={column==='自定义'?'自定义内容':'填写任务'}/>{row.tasks[columnIndex]&&<button className="quiet-button" onClick={()=>updatePersonalPlan(plan=>({...plan,rows:plan.rows.map((item,index)=>index===rowIndex?{...item,tasks:item.tasks.map((task,taskIndex)=>taskIndex===columnIndex?'':task)}:item)}))}>清空</button>}</div></td>)}<td><button className="danger-button" onClick={()=>updatePersonalPlan(plan=>({...plan,rows:plan.rows.filter((_,index)=>index!==rowIndex)}))}>删除当天</button></td></tr>)}</tbody></table></div><div className="form-footer"><button className="secondary" onClick={()=>updatePersonalPlan(plan=>({...plan,rows:[...plan.rows,{day:formatTeacherPlanDay(plan.rows.length+1),tasks:Array((plan.columns || defaultReviewColumns).length).fill(''),note:''}]}))}><Plus size={16}/>新增一天</button><button className="primary" onClick={savePersonalPlan}>保存修改</button></div></section></>;
  if (selectedStudent) { const entranceScoreLines = getEntranceScoreLines(selectedStudent); const restWeekdayLabel = getRestWeekdayLabel(selectedStudent.restWeekday); const restToday = isRestDayToday(selectedStudent); const restPending = isRestDayPendingToday(selectedStudent); return <section><div className="page-head"><div><span className="eyebrow">学员档案 · {selectedStudent.status}</span><h1>{selectedStudent.name} 的学习配置</h1><p>报考科目与学员分组分别管理；报名状态可在此人工修正，以反映退费或登记同步情况。休息日由学生自选（须提前一天设置才生效），教师仅查看。</p></div><button className="secondary" onClick={()=>setSelectedStudent(null)}>返回学员列表</button></div><div className={`teacher-rest-day-banner ${restToday ? 'is-today' : restWeekdayLabel === '未设置' ? 'is-unset' : restPending ? 'is-pending' : 'is-set'}`}><Moon size={18}/><div><b>{restToday ? '今日为该学员休息日（已生效）' : restWeekdayLabel === '未设置' ? '尚未设置休息日' : restPending ? `已选每周${restWeekdayLabel}，今日尚未生效` : `每周休息日：${restWeekdayLabel}`}</b><span>{restToday ? '学生端今日只显示「休息愉快，好好休息。」，学习规划与日/周/月自测均已暂停。' : restWeekdayLabel === '未设置' ? '学生可在首页自行选择一周中的一天作为休息日；须提前一天设置才在对应星期生效。' : restPending ? '休息日须提前一天设置才生效，今天仍按正常逻辑推送任务。' : `到每周${restWeekdayLabel}且设置时间早于当日 0 点时，暂停向该学员推送学习规划。`}</span></div><em>{restToday ? '今天休息' : restPending ? '今日未生效' : restWeekdayLabel}</em></div><section className="student-account-panel"><div><span className="eyebrow">登录账号</span><h2>账号与密码管理</h2><p>为保护账号安全，系统不展示或保存可查看的明文密码。</p></div>{(() => { const account = findStudentAccount(selectedStudent); return <div className="student-account-info"><div><span>登录账号</span><b>{account?.phone || selectedStudent.phone || '尚未创建'}</b></div><div><span>账号状态</span><b>{account ? (account.mustChangePassword ? '待修改临时密码' : (account.status !== '启用' ? '已停用' : '正常')) : '未创建'}</b></div><div><span>最近登录</span><b>{formatAccountLogin(account?.lastLoginAt)}</b></div>{currentAccount?.role === 'admin' && <button type="button" className="secondary" onClick={() => resetStudentPassword(account)} disabled={!account}>重置密码</button>}</div>; })()}</section><StudentMessagePanel student={selectedStudent} notify={notify}/><div className="student-detail-grid"><section className="panel"><PanelHead title="报考科目"/><div className="subject-enrollment">{profileDraft.subjects.map(item=><div key={item.name}><span className={`subject-status-chip ${item.enrolled?'is-enrolled':'is-not-enrolled'}`}>{item.name}</span><label className="enrollment-editor"><span>报名状态</span><select value={item.enrolled ? '已报名' : '未报名'} onChange={event=>updateEnrollment(item.name,event.target.value==='已报名')}><option>已报名</option><option>未报名</option></select></label><label className="subject-target-editor"><span>单科目标分</span><input type="number" min="0" max="150" value={item.targetScore || ''} onChange={event=>updateSubjectTargetScore(item.name,event.target.value)} placeholder="填写分数"/></label></div>)}</div><div className="profile-subject-picker profile-subject-editor"><span>调整报考科目</span><div>{SUBJECT_OPTIONS.map(item=><label key={item}><input type="checkbox" checked={profileDraft.subjects.some(subject=>subject.name===item)} onChange={()=>toggleProfileSubject(item)}/>{item}</label>)}</div></div><div className="progress-block"><span>复习进度 · {profileDraft.stage || '基础'}阶段</span><b>{profileDraft.progress}%</b><div className="progress-track"><i style={{width:`${profileDraft.progress}%`}}/></div></div></section><section className="panel"><PanelHead title="基础信息与综合评价" action={<button type="button" className="quiet-button" onClick={async () => { let url = ''; if (isApiConfigured() && selectedStudent.isServerManaged) { try { const result = await apiRequest(`/api/admin/students/${encodeURIComponent(selectedStudent.id)}/intake-link`, { method: 'POST' }); url = result.url; } catch (error) { return notify(error?.message || '生成采集链接失败，请稍后重试'); } } else { url = buildIntakeUrl(selectedStudent); } if (!url) return notify('生成采集链接失败，请稍后重试'); if (!navigator.clipboard?.writeText) return notify(`信息采集链接：${url}`); navigator.clipboard.writeText(url).then(() => notify('信息采集链接已复制，发给学生即可填写')).catch(() => notify(`信息采集链接：${url}`)); }}>复制信息采集链接</button>}/><div className="student-profile-editor"><label>姓名<input value={profileDraft.name} onChange={event=>setProfileDraft(current=>({...current,name:event.target.value}))}/></label><label>考研年份<input value={profileDraft.year} onChange={event=>setProfileDraft(current=>({...current,year:event.target.value}))} placeholder="例如：2027 考研"/></label><label>联系电话<input value={profileDraft.phone} onChange={event=>setProfileDraft(current=>({...current,phone:event.target.value}))}/></label><label>常用微信<input value={profileDraft.wechatId} onChange={event=>setProfileDraft(current=>({...current,wechatId:event.target.value}))} placeholder="填写学员常用微信"/></label><label>身份证信息<input value={profileDraft.idCard} onChange={event=>setProfileDraft(current=>({...current,idCard:event.target.value}))}/></label><label>收货昵称<input value={profileDraft.shippingRecipient} onChange={event=>setProfileDraft(current=>({...current,shippingRecipient:event.target.value}))} placeholder="填写收件人昵称"/></label><label>收货联系电话<input value={profileDraft.shippingPhone} onChange={event=>setProfileDraft(current=>({...current,shippingPhone:event.target.value}))} placeholder="填写收件人联系电话"/></label><label>收货地址<input value={profileDraft.shippingInfo} onChange={event=>setProfileDraft(current=>({...current,shippingInfo:event.target.value}))}/></label><label>报考学校<input value={profileDraft.school} onChange={event=>setProfileDraft(current=>({...current,school:event.target.value}))}/></label><label>目标分数<input value={profileDraft.targetScore} onChange={event=>setProfileDraft(current=>({...current,targetScore:event.target.value}))}/></label><label>复习阶段<select value={profileDraft.stage} onChange={event=>setProfileDraft(current=>({...current,stage:event.target.value}))}><option>基础</option><option>提高</option><option>冲刺</option></select></label><label>复习进度<input type="number" min="0" max="100" value={profileDraft.progress} onChange={event=>setProfileDraft(current=>({...current,progress:event.target.value}))}/></label><label className="profile-editor-wide">综合评价<textarea value={profileDraft.evaluation} onChange={event=>setProfileDraft(current=>({...current,evaluation:event.target.value}))} placeholder="填写当前学习情况与跟进建议"/></label><div className="profile-editor-wide entrance-score-readonly"><span>自测分数线</span><div>{entranceScoreLines.length ? <span className="entrance-score-lines">{entranceScoreLines.map(item=><span key={item.name}><b>{item.name}</b>{item.score}</span>)}</span> : '请先标记已报名科目'}</div></div><div className={`profile-save-state ${profileIsDirty?'is-dirty':'is-saved'}`}><span>{profileIsDirty ? '有未保存修改' : '当前资料已生效'}</span>{!profileIsDirty && <small>{profileSavedAt ? `本次保存于 ${profileSavedAt}` : '已同步到学生端'}</small>}</div><div className="form-footer profile-editor-wide"><button className="primary" onClick={saveProfile} disabled={!profileIsDirty}>保存学员资料</button></div></div></section></div><section className="panel plan-link-panel"><PanelHead title="布置任务"/><p>仅显示该学员入学登记时选择的报考科目。点击科目后，右侧会列出已上传的对应复习计划；选择计划即自动分配给该学员。</p><div className="assignment-layout"><div className="assignment-subjects">{studentExamSubjects.map(item=><button key={item} className={assignmentSubject===item?'active':''} onClick={()=>{setAssignmentSubject(item);setFutureTaskSubject(item);}}>{item}<ChevronRight size={15}/></button>)}</div><div className="assignment-summary">{assignedPlans.filter(item=>item.subject===assignmentSubject).length ? assignedPlans.filter(item=>item.subject===assignmentSubject).map(item=><button className="assigned-plan-link" key={item.id} onClick={()=>setSelectedPersonalPlanId(item.id)}><b>{item.subject}</b><span>{item.name}</span><ChevronRight size={15}/></button>) : <span>尚未分配复习计划</span>}</div></div>{assignmentSubject&&<div className="plan-drawer"><div className="panel-head"><h2>{assignmentSubject}复习计划</h2><button className="quiet-button" onClick={()=>setAssignmentSubject(null)}>关闭</button></div>{availablePlans.length ? availablePlans.map(plan=><button className="plan-option" key={plan.id} onClick={()=>assignPlan(plan)}><span><b>{plan.name}</b><small>{plan.category} · {plan.rows.length} 天</small></span><ChevronRight size={16}/></button>) : <div className="empty-line"><PackageOpen size={20}/><span>{assignmentSubject}尚未上传复习计划，无法分配。</span></div>}</div>}<section className="student-schedule-panel"><div className="schedule-head"><div><span className="eyebrow">个人任务编排</span><h2>任务组合表</h2><p>在这里决定任务从任务表第几天开始、任务组合在哪个自然日期当日解锁、长期执行或阶段执行、与哪条任务并行，以及承接关系。所有设置只属于 {selectedStudent.name}。</p></div></div><div className="schedule-subject-tabs">{studentExamSubjects.map(subject=><button key={subject} className={assignmentSubject===subject?'active':''} onClick={()=>{setAssignmentSubject(subject);setFutureTaskSubject(subject);}}>{subject}</button>)}</div>{assignmentSubject ? <div className="schedule-table-wrap"><table className="student-schedule-table"><thead><tr><th>基础任务</th><th>任务属性</th><th>开始位置</th><th>任务开始日期</th><th>并行轨道</th><th>承接任务</th><th>任务线预览</th></tr></thead><tbody>{assignedPlans.filter(plan=>plan.subject===assignmentSubject).map(plan=><tr key={plan.id}><td><b>{plan.name}</b><small>{plan.category} · {plan.rows.length} 天内容</small></td><td><select value={plan.taskType || '阶段'} onChange={event=>updatePersonalPlanById(plan.id,item=>({...item,taskType:event.target.value,predecessorAssignmentId:event.target.value==='长期'?null:item.predecessorAssignmentId}))}><option value="长期">长期任务</option><option value="阶段">阶段任务</option></select></td><td><label className="schedule-day-field">第<input type="number" min="1" max="365" value={plan.startDay || 1} onChange={event=>updatePersonalPlanById(plan.id,item=>({...item,startDay:Math.max(1,Number(event.target.value)||1)}))}/>天</label></td><td>{(() => { const planStartDate = getPlanStartDate(plan); return <label className="schedule-start-date-field"><input type="date" value={planStartDate} onChange={event=>setPlanStartDate(plan,event.target.value)}/><small>{planStartDate ? `${formatPlanStartDate(planStartDate)} 当日解锁` : '不设置则不限制日期'}</small></label>; })()}</td><td><select value={plan.lane || 1} onChange={event=>updatePersonalPlanById(plan.id,item=>({...item,lane:Number(event.target.value)}))}><option value="1">轨道 1</option><option value="2">轨道 2</option><option value="3">轨道 3</option><option value="4">轨道 4</option><option value="5">轨道 5</option><option value="6">轨道 6</option><option value="7">轨道 7</option><option value="8">轨道 8</option></select></td><td><select value={plan.predecessorAssignmentId || ''} disabled={plan.taskType==='长期'} onChange={event=>{const nextId=event.target.value ? String(event.target.value) : null;if (wouldCreatePlanCycle(plan.id, nextId)) return notify('不能形成循环承接关系，请选择不依赖当前任务的前置计划');updatePersonalPlanById(plan.id,item=>({...item,predecessorAssignmentId:nextId}));}}><option value="">不承接，直接开始</option>{assignedPlans.filter(item=>item.subject===assignmentSubject && item.id!==plan.id).map(item=><option value={item.id} key={item.id} disabled={wouldCreatePlanCycle(plan.id, item.id)}>完成「{item.name}」后开始</option>)}</select></td><td><div className="schedule-line"><i style={{marginLeft:`${Math.min((Number(plan.startDay)||1)-1,15)*6}px`}}/><span>{plan.taskType==='长期'?'持续执行':plan.predecessorAssignmentId?'承接执行':'阶段执行'} · 轨道 {plan.lane || 1}</span></div></td></tr>)}</tbody></table>{!assignedPlans.some(plan=>plan.subject===assignmentSubject)&&<div className="empty-line"><ClipboardCheck size={20}/><span>请先从上方基础任务库分配该科目的任务，再进行个人组合。</span></div>}</div> : <div className="empty-line"><ClipboardCheck size={20}/><span>先选择一个报考科目，开始为该学员编排任务。</span></div>}</section><div className="future-subject-tabs task-view-subject-tabs">{studentExamSubjects.map(subject=><button key={subject} className={futureTaskSubject===subject?'active':''} onClick={()=>setFutureTaskSubject(subject)}>{subject}</button>)}</div><section className="future-tasks-panel task-view-panel entrance-test-view"><div className="future-tasks-head"><div><span className="eyebrow">自测档案</span><h2>自测</h2><p>入学摸底测完即归档为学情基线（不是学完就结束）；日测、周测、月测的成绩与答案也会汇总到这里，供教师与 AI 持续跟进。</p></div><button className="secondary" onClick={()=>setShowEntranceTest(current=>!current)}>{showEntranceTest?'收起':'展开查看'}<ChevronRight size={16}/></button></div>{showEntranceTest&&<AssessmentArchive student={selectedStudent} entranceState={entranceState} notify={notify}/>}</section><section className="future-tasks-panel task-view-panel assessment-push-view"><div className="future-tasks-head"><div><span className="eyebrow">自测档案</span><h2>日测试 · 周测试 · 月测试</h2><p>日、周、月自测可按已报名科目分别开始或停止；无需填写起止日期，开始后学生端立即可见，彼此互不影响。</p></div><button className="secondary" onClick={()=>setShowAssessmentPush(current=>!current)}>{showAssessmentPush?'收起':'展开查看'}<ChevronRight size={16}/></button></div>{showAssessmentPush&&<AssessmentPushPanel student={selectedStudent} aiSettings={aiSettings} onApply={applyAssessmentPush} onToggleType={toggleAssessmentType} notify={notify}/>}</section><section className="future-tasks-panel task-view-panel homework-status-view"><div className="future-tasks-head"><div><span className="eyebrow">学生端打卡同步 · AI 学情依据</span><h2>作业完成情况</h2><p>汇总学生每日打卡与提交情况，为 AI 调整后续复习规划提供依据。</p></div><button className="secondary" onClick={()=>setShowHomeworkCompletion(current=>!current)}>{showHomeworkCompletion?'收起':'展开查看'}<ChevronRight size={16}/></button></div>{showHomeworkCompletion&&<HomeworkCompletionPanel student={selectedStudent} notify={notify}/>}</section><section className="future-tasks-panel task-view-panel"><div className="future-tasks-head"><div><span className="eyebrow">已分配计划 · 学员个人副本</span><h2>未来 30 天</h2><p>展示未来 30 天可执行的基础任务；任务监管机器人会根据连续打卡记录微调带明确数量的后续任务，所有调整可撤销。</p></div><button className="secondary" onClick={()=>setShowFutureTasks(current=>!current)}>{showFutureTasks?'收起':'展开查看'}<ChevronRight size={16}/></button></div><div className="future-progress"><div><b>{completedFutureDays}</b><span>/ {futureDays.length || 0} 天已完成</span></div><div className="future-progress-track"><i style={{width:`${futureDays.length ? `${completedFutureDays / futureDays.length * 100}%` : '0%'}`}}/></div></div>{showFutureTasks&&<>{renderFutureTaskAdjustmentControls()}{renderTaskDayList(futureTaskDays,`${futureTaskSubject}暂未分配复习计划，暂无未来 30 天任务。`,true)}</>}</section><section className="future-tasks-panel task-view-panel"><div className="future-tasks-head"><div><span className="eyebrow">已分配计划 · 学员个人副本</span><h2>完整任务</h2><p>按天合并显示该学员当天所有轨道任务。</p></div><button className="secondary" onClick={()=>setShowAllTasks(current=>!current)}>{showAllTasks?'收起':'展开查看'}<ChevronRight size={16}/></button></div>{showAllTasks&&<>{renderTaskDayList(allTaskDays,'当前科目尚未进入可执行的任务，请先在任务组合表中分配并设置开始位置。')}{lockedFuturePlans.length ? <div className="future-task-group locked-task-group"><span>待解锁</span>{lockedFuturePlans.map(plan=><div className="locked-task" key={plan.id}><span>○</span><div><b>{plan.name}</b><small>{(() => { const waitsForDate = !isPlanDateUnlocked(plan); const waitsForPredecessor = plan.predecessorAssignmentId && !completedAssignmentIds.has(String(plan.predecessorAssignmentId)); const dateMessage = plan.startDate ? `从 ${formatPlanStartDate(plan.startDate)} 起` : ''; const predecessorMessage = `等待「${subjectPlans.find(item=>String(item.id)===String(plan.predecessorAssignmentId))?.name || '前置任务'}」完成`; return waitsForDate && waitsForPredecessor ? `${predecessorMessage}后，并${dateMessage}解锁` : waitsForDate ? `计划将于 ${formatPlanStartDate(plan.startDate)} 当日解锁` : `${predecessorMessage}后自动进入任务列表`; })()}</small></div></div>)}</div> : null}</>}</section></section></section>; }
  if (view === 'create') return <section><div className="page-head"><div><span className="eyebrow">学员管理 · 建立档案</span><h1>新增学员</h1><p>先完成基础档案，再明确分配到付费、体验期或新人分组。系统不再自动归类到新人。</p></div><button className="secondary" onClick={()=>setView('list')}>返回学员列表</button></div><section className="panel student-profile-form"><div className="exam-send-grid"><label>学员姓名<input value={studentForm.name} onChange={event=>setStudentForm(current=>({...current,name:event.target.value}))} placeholder="填写学员姓名"/></label><label>联系电话<input value={studentForm.phone} onChange={event=>setStudentForm(current=>({...current,phone:event.target.value}))} placeholder="填写联系电话"/></label><label>收货信息<input value={studentForm.shippingInfo} onChange={event=>setStudentForm(current=>({...current,shippingInfo:event.target.value}))} placeholder="填写收件人、电话和地址"/></label><label>报考学校<input value={studentForm.school} onChange={event=>setStudentForm(current=>({...current,school:event.target.value}))} placeholder="填写报考学校"/></label><label>目标分数<input value={studentForm.targetScore} onChange={event=>setStudentForm(current=>({...current,targetScore:event.target.value}))} placeholder="例如：380"/></label><label>归属分组<select value={studentForm.group} onChange={event=>setStudentForm(current=>({...current,group:event.target.value}))}><option value="付费">付费学员</option><option value="体验">体验期学员</option><option value="新人">新人</option></select></label><label>复习阶段<select value={studentForm.stage} onChange={event=>setStudentForm(current=>({...current,stage:event.target.value}))}><option>基础</option><option>提高</option><option>冲刺</option></select></label></div><div className="profile-subject-picker"><span>报考科目</span><div>{SUBJECT_OPTIONS.map(item=><label key={item}><input type="checkbox" checked={studentForm.subjects.includes(item)} onChange={()=>toggleFormSubject(item)}/>{item}</label>)}</div></div><div className="form-footer"><button className="primary" onClick={saveStudentProfile}>保存学员档案</button></div></section></section>;
  if (view === 'import') return <section><div className="page-head"><div><span className="eyebrow">学员管理 · 批量导入</span><h1>批量建立学员档案</h1><p>选择目标分组后导入。Excel 第一行至少需要“姓名”字段，支持“报考科目、电话、收货信息、报考学校、目标分数、复习阶段、复习进度、考研年份”。</p></div><button className="secondary" onClick={()=>setView('list')}>返回学员列表</button></div><section className="panel batch-student-import"><div className="exam-send-grid"><label>导入到<select value={importGroup} onChange={event=>setImportGroup(event.target.value)}><option value="付费">付费学员</option><option value="体验">体验期学员</option><option value="新人">新人</option></select></label><label>选择 Excel 文件<label className="secondary file-button">选择名单<input type="file" accept=".xls,.xlsx" onChange={event=>{importStudents(event.target.files?.[0]);event.target.value='';}}/></label></label></div><div className="empty-line"><Users size={21}/><span>导入后所有学员只会进入所选分组，可在详情页继续分配复习计划。</span></div></section></section>;
  const filteredStudents = students.filter(student => {
    const query = searchText.trim().toLowerCase();
    const matchesQuery = !query || [student.name, student.phone, student.school, student.year].some(value => String(value || '').toLowerCase().includes(query));
    const matchesStatus = statusFilter === '全部' || student.status === statusFilter;
    const matchesSubject = subjectFilter === '全部' || (student.subjects || []).some(item => item.enrolled && normalizeStudentSubject(item.name) === subjectFilter);
    return matchesQuery && matchesStatus && matchesSubject;
  });
  const studentGroups = [
    ['同步测试账号', filteredStudents.filter(student => student.isTestAccount)],
    ['付费学员', filteredStudents.filter(student => !student.isTestAccount && student.status === '付费')],
    ['体验期学员', filteredStudents.filter(student => !student.isTestAccount && student.status === '体验')],
    ['新人', filteredStudents.filter(student => !student.isTestAccount && student.status === '新人')]
  ];
  return <><section className="page-head"><div><span className="eyebrow">学员档案与学习配置</span><h1>管理报考科目、目标分数和学习进度。</h1><p>学员固定按付费、体验期、新人顺序显示。红色底板为已报名科目，浅色底板为未报名科目；报名状态可在学员详情中人工修改。目标分数由教师和学生本人均可更新。停用仅暂停登录，不删除订单、任务或学习记录，之后可恢复启用。</p></div><div className="page-actions"><button className="secondary" onClick={()=>setView('import')}>批量导入</button><button className="primary" onClick={()=>setView('create')}><Plus size={16}/>新增学员</button></div></section><section className="panel student-filter-bar" aria-label="学员搜索和筛选"><label className="search"><Search size={16}/><input value={searchText} onChange={event => setSearchText(event.target.value)} placeholder="搜索姓名、手机号、院校" aria-label="搜索学员"/></label><label>状态<select value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option>全部</option><option>免费</option><option>新人</option><option>体验</option><option>付费</option></select></label><label>科目<select value={subjectFilter} onChange={event => setSubjectFilter(event.target.value)}><option>全部</option><option>政治</option><option>英语</option><option>数学</option><option>专业课</option></select></label><small>匹配 {filteredStudents.length} 人</small></section><div className="student-group-list">{studentGroups.map(([title, group])=><section className="panel table-panel student-group" key={title}><PanelHead title={title} action={`${group.length} 人`}/>{group.length ? <table><thead><tr><th>学员</th><th>报考科目</th><th className="student-score-head">目标分数</th><th>复习阶段</th><th>休息日</th><th>操作</th></tr></thead><tbody>{group.map(student=>{const restLabel=getRestWeekdayLabel(student.restWeekday);const restToday=isRestDayToday(student);const restPending=isRestDayPendingToday(student);return <tr key={student.id}><td><b>{student.name}</b><small>{student.year}</small></td><td><div className="subject-chips">{student.subjects.map(item=><span key={item.name} className={`subject-status-chip ${item.enrolled?'is-enrolled':'is-not-enrolled'}`}>{item.name}</span>)}</div></td><td className="student-score-cell"><b>{student.targetScore || '待确定'}</b></td><td><div className="stage-summary"><span className={`stage-tag stage-${student.stage || '基础'}`}>{student.stage || '基础'}</span><b>{student.progress}%</b></div></td><td><span className={`rest-day-chip ${restToday?'is-today':restPending?'is-pending':restLabel==='未设置'?'is-unset':'is-set'}`}>{restToday?`今天·${restLabel}`:restPending?`${restLabel}·未生效`:restLabel}</span></td><td><div className="row-actions"><button className="quiet-button" onClick={()=>setSelectedStudent(student)}>详情<ChevronRight size={15}/></button><button className={student.accountState === '已停用' ? 'secondary' : 'danger-button'} onClick={()=>student.accountState === '已停用' ? restoreStudent(student.id) : removeStudent(student.id)}>{student.accountState === '已停用' ? '恢复启用' : '停用账号'}</button></div></td></tr>})}</tbody></table> : <div className="empty-line"><Users size={20}/><span>当前暂无{title}。</span></div>}</section>)}</div></>;
}
const APPLICATIONS_STORAGE_KEY = 'shangan-application-management-v1';
const defaultEnglishBooks = [{id:'english-default-1',name:'考研英语词汇书 1',words:[]},{id:'english-default-2',name:'考研英语词汇书 2',words:[]}];
const loadApplicationData = () => {
  // API mode must never seed the tool UI with browser/demo books. Until the
  // server response arrives, show an honest empty/loading state instead.
  if (isApiConfigured()) return {politicsBooks:[], englishBooks:[], englishChoiceBooks:[], mathItems:{formula:[],theorem:[]}};
  try {
    const saved = window.localStorage.getItem(APPLICATIONS_STORAGE_KEY);
    if (!saved) return {politicsBooks:[], englishBooks:defaultEnglishBooks, mathItems:{formula:[],theorem:[]}};
    const parsed = JSON.parse(saved);
    return {
      politicsBooks: Array.isArray(parsed?.politicsBooks) ? parsed.politicsBooks : [],
      englishBooks: Array.isArray(parsed?.englishBooks) && parsed.englishBooks.length ? parsed.englishBooks : defaultEnglishBooks,
      mathItems: {formula:Array.isArray(parsed?.mathItems?.formula) ? parsed.mathItems.formula : [], theorem:Array.isArray(parsed?.mathItems?.theorem) ? parsed.mathItems.theorem : []}
    };
  } catch (error) {
    return {politicsBooks:[], englishBooks:defaultEnglishBooks, mathItems:{formula:[],theorem:[]}};
  }
};

const MathFormula = ({value}) => {
  const source = String(value || '').trim();
  if (!source) return <span className="math-formula-empty">—</span>;
  const superscriptMap = {'⁰':'0','¹':'1','²':'2','³':'3','⁴':'4','⁵':'5','⁶':'6','⁷':'7','⁸':'8','⁹':'9','⁺':'+','⁻':'-','⁽':'(','⁾':')'};
  const subscriptMap = {'₀':'0','₁':'1','₂':'2','₃':'3','₄':'4','₅':'5','₆':'6','₇':'7','₈':'8','₉':'9','₊':'+','₋':'-','₍':'(','₎':')','ₓ':'x'};
  const normalize = text => {
    let result = text.replace(/^[\$]+|[\$]+$/g, '').trim()
      .replace(/−/g, '-').replace(/×/g, '\\times ').replace(/÷/g, '\\div ')
      .replace(/→/g, '\\to ').replace(/≤/g, '\\le ').replace(/≥/g, '\\ge ').replace(/∞/g, '\\infty ')
      .replace(/√/g, '\\sqrt{}');
    result = result.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁽⁾]+/g, match => `^{${[...match].map(char => superscriptMap[char]).join('')}}`);
    result = result.replace(/[₀₁₂₃₄₅₆₇₈₉₊₋₍₎ₓ]+/g, match => `_{${[...match].map(char => subscriptMap[char]).join('')}}`);
    return result;
  };
  const normalized = normalize(source);
  if (/[㐀-鿿]/.test(normalized) && !/[\\_^{}]/.test(normalized)) return <span className="math-formula-text">{source}</span>;
  try {
    return <span className="math-formula" dangerouslySetInnerHTML={{__html:katex.renderToString(normalized, {throwOnError:false, displayMode:false, trust:false, strict:'warn'})}}/>;
  } catch (error) {
    return <span className="math-formula-fallback">{source}</span>;
  }
};

function CompanionStudyManagement({notify, embedded = false}) {
  const [books, setBooks] = useState([]);
  const [selected, setSelected] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [form, setForm] = useState({subject:'政治', name:'', description:'', state:'草稿', companionEnabled:!embedded});
  const [state, setState] = useState({loading:true, busy:false, error:'', notice:''});
  const inputRef = useRef(null);
  const loadBooks = async () => {
    if (!isApiConfigured()) { setState({loading:false, busy:false, error:'带背后台需要连接服务端后使用。'}); return; }
    setState(current => ({...current, loading:true, error:''}));
    try { setBooks((await apiRequest('/api/admin/question-books')).map(item => ({ ...item, subject: normalizeStudentSubject(item.subject || item.category) }))); setState({loading:false, busy:false, error:''}); }
    catch (error) { setState({loading:false, busy:false, error:error.message || '书籍加载失败'}); }
  };
  useEffect(() => { loadBooks(); }, []);
  const selectBook = async book => {
    setSelected(book); setForm({subject:normalizeStudentSubject(book.subject || book.category), name:book.name, description:book.description || '', state:book.state, companionEnabled:Boolean(book.companionEnabled)}); setState(current => ({...current, loading:true, error:''}));
    try { setQuestions(await apiRequest(`/api/admin/companion-study/books/${book.id}/questions`)); setState({loading:false, busy:false, error:''}); }
    catch (error) { setState({loading:false, busy:false, error:error.message || '题目加载失败'}); }
  };
  const normalizeImport = file => readWorkbookSafely(file, (workbook, worksheet) => {
    try {
      const rows = XLSX.utils.sheet_to_json(worksheet, {defval:''});
      const clean = value => String(value || '').replace(/\s+/g, '').trim();
      const mapped = rows.map(row => Object.fromEntries(Object.entries(row).map(([key,value]) => [clean(key), value])));
      const questions = mapped.map((row, index) => ({
        questionNumber:Number(row.题号 || row.序号 || row.编号 || index + 1), stem:String(row.题干 || row.题目 || ''), durationSeconds:form.companionEnabled ? Math.max(60, Number(row['建议时间'] || row['学习时长（秒）'] || row.学习时长秒 || row.时长秒 || 1800)) : null, knowledgePoint:String(row['做题建议1（10%）'] || row.知识点 || ''), halfHint:String(row['做题建议2（50%）'] || row.半程提示 || row.中间提示 || ''), answer:String(row.答案 || ''), analysis:String(row.解析 || ''), state:['草稿','已发布','已归档'].includes(String(row.状态 || '已发布')) ? String(row.状态 || '已发布') : '已发布'
      }));
      if (!form.name.trim()) throw new Error('请先填写书籍名称');
      if (!questions.length || questions.some(item => !Number.isInteger(item.questionNumber) || item.questionNumber < 1 || (form.companionEnabled && (!Number.isInteger(item.durationSeconds) || item.durationSeconds < 60)))) throw new Error(form.companionEnabled ? 'Excel 中需要有有效的题号和至少 60 秒的学习时长' : 'Excel 中需要有有效的题号');
      setState({loading:false, busy:true, error:''});
      apiRequest('/api/admin/companion-study/books/import', {method:'POST', body:{book:{...form, subject:normalizeStudentSubject(form.subject), name:form.name.trim(), description:form.description.trim()}, questions}})
        .then(result => { notify(`已导入 ${result.importedQuestionCount} 道题目`); setSelected(result.book); return selectBook(result.book); })
        .then(loadBooks).catch(error => setState({loading:false, busy:false, error:error.message || '导入失败'}));
    } catch (error) { setState({loading:false, busy:false, error:error.message || 'Excel 解析失败'}); }
  }, error => setState({loading:false, busy:false, error:error.message || 'Excel 读取失败'}));
  const downloadCompanionTemplate = () => { const link = document.createElement('a'); link.href = '/代学模板.xls'; link.download = '代学模板.xls'; link.click(); };
  const updateBook = async () => {
    if (!selected) return;
    setState(current => ({...current, busy:true, error:''}));
    try { const updated = await apiRequest(`/api/admin/companion-study/books/${selected.id}`, {method:'PATCH', body:form}); setSelected(updated); setBooks(current => current.map(item => item.id === updated.id ? updated : item)); setState({loading:false, busy:false, error:''}); notify('书籍设置已保存'); }
    catch (error) { setState(current => ({...current, busy:false, error:error.message || '书籍保存失败'})); }
  };
  return <section className={`companion-admin ${embedded ? 'is-embedded' : ''}`}>
    <section className="page-head companion-admin-head">
      <div>
        <span className="eyebrow">{embedded ? '题库管理 · 统一刷题书库' : '带背后台 · 内容配置'}</span>
        <h1>{embedded ? '管理全部刷题书，代学只是其中一种使用方式。' : '按书籍导入带背题目与计时提示。'}</h1>
        <p>{embedded ? '这里包含普通刷题书和已启用带背的书籍；知识点与教学资料仍由知识库单独管理。' : '同一本书的题目、两阶段提示、答案和建议时长会一起导入；启用带背后，学生端即可按书籍学习。'}</p>
      </div>
      {!embedded && <div className="companion-admin-head-meta"><Clock3 size={20}/><span>题目时长取自模板「建议时间」</span></div>}
    </section>
    {state.error && <div className="empty-line"><CircleHelp size={21}/><span>{state.error}</span><button type="button" className="secondary" onClick={loadBooks}>重新加载</button></div>}
    <div className="companion-admin-layout">
      <section className="panel companion-admin-config">
        <PanelHead title="1. 配置书籍" action={selected ? '正在编辑已导入书籍' : '新建或选择书籍后导入'}/>
        <div className="form-grid">
          <label>科目<select value={form.subject} onChange={event => setForm(current => ({...current, subject:event.target.value}))}><option>政治</option><option>英语</option><option>数学</option></select></label>
          <label>书籍名称<input value={form.name} maxLength="160" placeholder="例如：肖秀荣 1000 题" onChange={event => setForm(current => ({...current, name:event.target.value}))}/></label>
          <label className="full">书籍说明<textarea value={form.description} maxLength="2000" placeholder="说明本书适用阶段、内容范围或学习建议" onChange={event => setForm(current => ({...current, description:event.target.value}))}/></label>
          <label>发布状态<select value={form.state} onChange={event => setForm(current => ({...current, state:event.target.value}))}><option>草稿</option><option>已发布</option><option>已归档</option></select></label>
          <label className="checkbox-field"><input type="checkbox" checked={form.companionEnabled} onChange={event => setForm(current => ({...current, companionEnabled:event.target.checked}))}/><span>启用带背计时</span><small>关闭后仍保留在题库，但学生端不会出现在带背书籍中。</small></label>
        </div>
        <div className="companion-import-actions">
          <div><b>2. 导入 Excel</b><span>请先填写书籍名称，再按模板上传题目。</span></div>
          <div className="form-footer"><input ref={inputRef} type="file" accept=".xlsx,.xls" hidden onChange={event => { const file = event.target.files?.[0]; if (file) normalizeImport(file); event.target.value = ''; }}/><button type="button" className="primary" disabled={state.busy} onClick={() => inputRef.current?.click()}><Upload size={16}/>选择并导入 Excel</button><button type="button" className="secondary" onClick={downloadCompanionTemplate}><FileDown size={16}/>下载代学模板</button>{selected && <button type="button" className="quiet-button" disabled={state.busy} onClick={updateBook}>保存书籍设置</button>}</div>
        </div>
        <div className="companion-template-guide"><b>模板字段</b><span>序号、题目、做题建议1（10%）、做题建议2（50%）、答案、建议时间</span><small>“做题建议1”会在前 10% 时间节点提示；“做题建议2”会在 50% 时间节点提示。建议时间按秒填写，留空时默认 1800 秒。</small></div>
      </section>
      <section className="panel companion-admin-library">
        <PanelHead title="3. 已导入书籍" action={`${books.length} 本`}/>
        {state.loading ? <div className="empty-line"><Clock3 size={21}/><span>正在加载书籍…</span></div> : books.length ? <div className="companion-book-list">{books.map(book => <button type="button" className={`companion-book-row ${selected?.id === book.id ? 'is-selected' : ''}`} key={book.id} onClick={() => selectBook(book)}><BookOpen size={19}/><span><b>{book.name}</b><small>{book.subject} · {book.questionCount} 题 · {book.state}</small></span><em>{book.companionEnabled ? '带背已启用' : '普通题库'}</em><ChevronRight size={16}/></button>)}</div> : <div className="empty-line"><BookOpen size={21}/><span>还没有导入书籍。请先配置书籍信息并上传模板。</span></div>}
      </section>
    </div>
    {selected && <section className="panel companion-question-preview"><PanelHead title={`4. ${selected.name} · 题目预览`} action={`${questions.length} 题`}/>{questions.length ? <div className="companion-question-table-wrap"><table><thead><tr><th>题号</th><th>题目</th><th>10% 提示</th><th>50% 提示</th><th>建议时间</th><th>状态</th></tr></thead><tbody>{questions.map(question => <tr key={question.id}><td>{question.questionNumber}</td><td>{question.stem || '未填写题目'}</td><td>{question.knowledgePoint || '—'}</td><td>{question.halfHint || '—'}</td><td>{question.durationSeconds ? `${question.durationSeconds} 秒` : '—'}</td><td><span className={`badge ${question.state === '已发布' ? 'ok' : 'warn'}`}>{question.state}</span></td></tr>)}</tbody></table></div> : <div className="empty-line"><FileQuestion size={21}/><span>该书籍还没有题目。</span></div>}</section>}
  </section>;
}

function ApplicationManagement({data, setData, notify}) {
  const [activeApp,setActiveApp]=useState(null), [politicsBooks,setPoliticsBooks]=useState(data.politicsBooks), [englishBooks,setEnglishBooks]=useState(data.englishBooks), [englishChoiceBooks,setEnglishChoiceBooks]=useState(data.englishChoiceBooks||[]), [mathItems,setMathItems]=useState(data.mathItems), [bookId,setBookId]=useState(null), [newName,setNewName]=useState('');
  const syncBookToServer=(tool,name,items)=>{if(!isApiConfigured())return;apiRequest('/api/admin/application-books/import',{method:'POST',body:{book:{tool,name,state:'已发布'},items}}).then(()=>notify('已保存到服务器')).catch(error=>notify(`本地已更新，但保存到服务器失败：${error.message}`))};
  // 服务端数据到达后刷新本地镜像；内容一致时跳过，避免与本地编辑互相回写
  useEffect(()=>{const next={politicsBooks:data.politicsBooks||[],englishBooks:data.englishBooks||[],englishChoiceBooks:data.englishChoiceBooks||[],mathItems:data.mathItems||{formula:[],theorem:[]}};if(JSON.stringify(next)===JSON.stringify({politicsBooks,englishBooks,englishChoiceBooks,mathItems}))return;setPoliticsBooks(next.politicsBooks);setEnglishBooks(next.englishBooks);setEnglishChoiceBooks(next.englishChoiceBooks);setMathItems(next.mathItems);},[data]);
  useEffect(() => {
    setData({politicsBooks, englishBooks, englishChoiceBooks, mathItems});
  }, [politicsBooks, englishBooks, englishChoiceBooks, mathItems, setData]);
  const apps=[{id:'politics',title:'政治选择题刷题',subject:'政治',icon:FileQuestion,description:'按题书独立管理选择题，支持模板批量导入。'},{id:'english',title:'英语背单词',subject:'英语',icon:BookOpen,description:'维护多本单词书，支持模板批量导入单词。'},{id:'math',title:'数学背公式',subject:'数学',icon:BrainCircuit,description:'按章节维护公式卡片与记忆任务。'},{id:'english-choice',title:'英语选择题刷题',subject:'英语',icon:FileQuestion,description:'按题书独立管理英语选择题，支持模板批量导入。'}];
  const downloadTemplate=type=>{const link=document.createElement('a');link.href=type==='politics'?'/政治选择题上传模板.xls':'/单词上传模板.xlsx';link.download=link.href.split('/').pop();link.click();};
  const addBook=type=>{if(!newName.trim())return notify('请先填写书名');const book={id:Date.now(),name:newName.trim(),...(type==='english'?{words:[]}:{questions:[]})};type==='politics'?setPoliticsBooks(x=>[...x,book]):type==='english'?setEnglishBooks(x=>[...x,book]):setEnglishChoiceBooks(x=>[...x,book]);syncBookToServer(type==='politics'?'politics':type==='english'?'english_words':'english_choice',book.name,[]);setNewName('');notify(`已新增${type==='politics'?'题书':type==='english'?'单词书':'英语选择题书'}「${book.name}」`)};
  const importFile=(file,type,id)=>{if(!file)return;readWorkbookSafely(file,(wb)=>{try{const sheet=wb.Sheets[wb.SheetNames[0]], rawRows=XLSX.utils.sheet_to_json(sheet,{defval:''});if(type==='politics'||type==='english-choice'){if(!rawRows.length)throw Error();const first=rawRows[0];const findKey=(keys)=>keys.find(key=>Object.prototype.hasOwnProperty.call(first,key));const numberKey=findKey(['序号','编号','题号']);const questionKey=findKey(['题目','题干','问题']);const aKey=findKey(['选项A','选项 A','A']);const bKey=findKey(['选项B','选项 B','B']);const cKey=findKey(['选项C','选项 C','C']);const dKey=findKey(['选项D','选项 D','D']);const analysisKey=findKey(['解析','答案解析','答案及解析']);const memoryKey=findKey(['助记','知识点整理注记','知识点整理','注记']);if(!questionKey||!aKey||!bKey||!cKey||!dKey||!analysisKey||!memoryKey)throw Error();const questions=rawRows.filter(r=>String(r[questionKey]||'').trim()).map((r,i)=>({id:Date.now()+i,number:r[numberKey]||i+1,question:r[questionKey],a:r[aKey],b:r[bKey],c:r[cKey],d:r[dKey],analysis:r[analysisKey],memory:r[memoryKey]}));if(!questions.length)throw Error();const targetBook=(type==='politics'?politicsBooks:englishChoiceBooks).find(b=>b.id===id);const nextQuestions=[...(targetBook?.questions||[]),...questions];(type==='politics'?setPoliticsBooks:setEnglishChoiceBooks)(x=>x.map(b=>b.id===id?{...b,questions:nextQuestions,importedFile:file.name}:b));if(targetBook)syncBookToServer(type==='politics'?'politics':'english_choice',targetBook.name,nextQuestions);notify(`已追加导入 ${questions.length} 道选择题`)}else{if(!rawRows.length)throw Error();const first=rawRows[0];const findKey=(keys)=>keys.find(key=>Object.prototype.hasOwnProperty.call(first,key));const numberKey=findKey(['序号','编号']);const wordKey=findKey(['单词','word']);const splitKey=findKey(['拆分','单词拆分']);const meaningKey=findKey(['中文','中文意思','释义']);const phoneticKey=findKey(['音标','phonetic']);const memoryKey=findKey(['助记','单词助记']);if(!wordKey||!meaningKey)throw Error();const words=rawRows.filter(r=>String(r[wordKey]||'').trim()).map((r,i)=>({id:Date.now()+i,number:r[numberKey]||i+1,word:String(r[wordKey]).trim(),phonetic:String(r[phoneticKey]||''),meaning:String(r[meaningKey]||''),split:String(r[splitKey]||''),memory:String(r[memoryKey]||''),aiKnowledge:'',audioUrl:''}));if(!words.length)throw Error();const targetBook=englishBooks.find(b=>b.id===id);const nextWords=[...(targetBook?.words||[]),...words];setEnglishBooks(x=>x.map(b=>b.id===id?{...b,words:nextWords,importedFile:file.name}:b));if(targetBook)syncBookToServer('english_words',targetBook.name,nextWords);notify(`已追加导入 ${words.length} 个单词`)}}catch(err){notify(type==='english'?'单词文件格式不符合模板：需包含序号、单词、拆分、中文、音标、助记':'题目文件缺少必要列，请确认包含题目、选项A-D、解析及助记或知识点整理注记')}},err=>notify(err?.message||'导入文件读取失败'))};
  const importMathItems = (file,type,bookId) => { if(!file)return; readWorkbookSafely(file,(wb)=>{try{const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:''});if(!rows.length)throw Error();const first=rows[0],find=keys=>keys.find(k=>k in first),numberKey=find(['序号','编号']),categoryKey=find(['知识点归属（微积分）','知识点归属','章节']),leftKey=find(['等号左边','定理名称','名称']),rightKey=find(['等号右边','当号右边','定理内容']);if(!leftKey||!rightKey)throw Error();const items=rows.filter(r=>String(r[leftKey]||r[rightKey]).trim()).map((r,i)=>({id:Date.now()+i,number:r[numberKey]||i+1,category:r[categoryKey]||'',left:r[leftKey],right:r[rightKey]}));const targetBook=(mathItems[type]||[]).find(b=>b.id===bookId);const nextItems=[...(targetBook?.items||[]),...items];setMathItems(x=>({...x,[type]:x[type].map(b=>b.id===bookId?{...b,items:nextItems}:b)}));if(targetBook)syncBookToServer(type==='formula'?'math_formula':'math_theorem',targetBook.name,nextItems);notify(`已追加导入 ${items.length} 条${type==='formula'?'公式':'定理'}`)}catch(err){notify('数学文件缺少必要列，请确认包含知识点归属、等号左边和等号右边（或当号右边）')}},err=>notify(err?.message||'导入文件读取失败'))};
  const addMathBook=(type)=>{if(!newName.trim())return notify('请先填写书名');const bookName=newName.trim();setMathItems(x=>({...x,[type]:[...x[type],{id:Date.now(),name:bookName,items:[]}]}));syncBookToServer(type==='formula'?'math_formula':'math_theorem',bookName,[]);setNewName('');notify(`已新增${type==='formula'?'公式':'定理'}书「${bookName}」`)};
  const current=apps.find(x=>x.id===activeApp), politics=politicsBooks.find(x=>x.id===bookId), english=englishBooks.find(x=>x.id===bookId), choice=englishChoiceBooks.find(x=>x.id===bookId);
  const activeMathBook = (mathItems[activeApp==='math-formula'?'formula':'theorem']||[]).find(book=>book.id===bookId);
  if(activeMathBook) { const type=activeApp==='math-formula'?'formula':'theorem'; const label=type==='formula'?'公式':'定理'; return <><section className="page-head"><div><span className="eyebrow">数学 · {label} · {activeMathBook.name}</span><h1>{activeMathBook.name}</h1><p>在具体书籍下批量上传{label}资料，数据与其他书籍独立维护。</p></div><button className="secondary" onClick={()=>setBookId(null)}>返回{label}书籍</button></section><section className="panel politics-book-upload"><div><h2>批量上传{label}</h2><p>支持列名：序号、知识点归属（微积分）、等号左边、等号右边；模板中的“当号右边”也可识别。</p><div className="template-actions"><button className="secondary" onClick={()=>{const a=document.createElement('a');a.href='/数学模板.xls';a.download='数学模板.xls';a.click();}}>下载上传模板</button><label className="primary file-button">选择批量文件<input type="file" accept=".xls,.xlsx" onChange={e=>{importMathItems(e.target.files?.[0],type,activeMathBook.id);e.target.value='';}}/></label></div></div></section><section className="panel table-panel math-items-table"><PanelHead title={`已导入${label}`} action={`${(activeMathBook.items||[]).length} 条`}/>{activeMathBook.items?.length?<table><thead><tr><th>序号</th><th>知识点归属</th><th>{label==='公式'?'等号左边':'定理名称'}</th><th>{label==='公式'?'等号右边':'定理内容'}</th></tr></thead><tbody>{activeMathBook.items.slice(0,10).map(item=><tr key={item.id}><td>{item.number}</td><td>{item.category||'—'}</td><td><MathFormula value={item.left}/></td><td><MathFormula value={item.right}/></td></tr>)}</tbody></table>:<div className="empty-line"><BrainCircuit size={20}/><span>尚未导入{label}。</span></div>}</section></>;
  }
  if(choice)return <><section className="page-head"><div><span className="eyebrow">英语选择题 · {choice.name}</span><h1>{choice.name}</h1><p>在本题书中批量导入选择题。数据与其他题书独立维护。</p></div><button className="secondary" onClick={()=>setBookId(null)}>返回题书列表</button></section><section className="panel politics-book-upload"><div><h2>批量上传题目</h2><p>模板列：序号、题目、选项A、选项B、选项C、选项D、解析、助记（与政治选择题模板相同）。</p><div className="template-actions"><button className="secondary" onClick={()=>downloadTemplate('politics')}>下载上传模板</button><label className="primary file-button">选择批量文件<input type="file" accept=".xls,.xlsx" onChange={e=>{importFile(e.target.files?.[0],'english-choice',choice.id);e.target.value=''}}/></label></div></div></section><section className="panel table-panel politics-question-preview"><PanelHead title="题目预览" action={`${choice.questions.length} 题`}/>{choice.questions.length?<table><thead><tr><th>序号</th><th>题目</th><th>选项</th><th>解析</th><th>助记</th></tr></thead><tbody>{choice.questions.slice(0,10).map(q=><tr key={q.id}><td>{q.number}</td><td><b>{q.question}</b></td><td><small>A. {q.a}<br/>B. {q.b}<br/>C. {q.c}<br/>D. {q.d}</small></td><td>{q.analysis||'—'}</td><td>{q.memory||'—'}</td></tr>)}</tbody></table>:<div className="empty-line"><FileQuestion size={20}/><span>尚未导入题目。</span></div>}</section></>;
  if(politics)return <><section className="page-head"><div><span className="eyebrow">政治选择题 · {politics.name}</span><h1>{politics.name}</h1><p>在本题书中批量导入选择题。数据与其他题书独立维护。</p></div><button className="secondary" onClick={()=>setBookId(null)}>返回题书列表</button></section><section className="panel politics-book-upload"><div><h2>批量上传题目</h2><p>模板列：序号、题目、选项A、选项B、选项C、选项D、解析、助记。</p><div className="template-actions"><button className="secondary" onClick={()=>downloadTemplate('politics')}>下载上传模板</button><label className="primary file-button">选择批量文件<input type="file" accept=".xls,.xlsx" onChange={e=>{importFile(e.target.files?.[0],'politics',politics.id);e.target.value=''}}/></label></div></div></section><section className="panel table-panel politics-question-preview"><PanelHead title="题目预览" action={`${politics.questions.length} 题`}/>{politics.questions.length?<table><thead><tr><th>序号</th><th>题目</th><th>选项</th><th>解析</th><th>助记</th></tr></thead><tbody>{politics.questions.slice(0,10).map(q=><tr key={q.id}><td>{q.number}</td><td><b>{q.question}</b></td><td><small>A. {q.a}<br/>B. {q.b}<br/>C. {q.c}<br/>D. {q.d}</small></td><td>{q.analysis||'—'}</td><td>{q.memory||'—'}</td></tr>)}</tbody></table>:<div className="empty-line"><FileQuestion size={20}/><span>尚未导入题目。</span></div>}</section></>;
  if(english)return <><section className="page-head"><div><span className="eyebrow">英语背单词 · {english.name}</span><h1>{english.name}</h1><p>按单词模板批量导入资料，单词书之间独立维护。</p></div><button className="secondary" onClick={()=>setBookId(null)}>返回单词书列表</button></section><section className="panel politics-book-upload"><div><h2>批量上传单词</h2><p>模板列：序号、单词、拆分、中文、音标、助记。</p><div className="template-actions"><button className="secondary" onClick={()=>downloadTemplate('english')}>下载上传模板</button><label className="primary file-button">选择批量文件<input type="file" accept=".xls,.xlsx" onChange={e=>{importFile(e.target.files?.[0],'english',english.id);e.target.value=''}}/></label></div></div></section><section className="panel table-panel politics-question-preview"><PanelHead title="单词预览" action={`${english.words.length} 个`}/>{english.words.length?<table><thead><tr><th>序号</th><th>单词</th><th>音标</th><th>中文</th><th>拆分</th><th>助记</th></tr></thead><tbody>{english.words.slice(0,10).map(w=><tr key={w.id}><td>{w.number}</td><td><b>{w.word}</b></td><td>{w.phonetic||'—'}</td><td>{w.meaning||'—'}</td><td>{w.split||'—'}</td><td>{w.memory||'—'}</td></tr>)}</tbody></table>:<div className="empty-line"><BookOpen size={20}/><span>尚未导入单词。</span></div>}</section></>;
  if(current?.id==='math') return <><section className="page-head"><div><span className="eyebrow">应用管理 · 数学</span><h1>数学背公式</h1><p>先选择“公式”或“定理”，再进入对应书籍上传资料。</p></div><button className="secondary" onClick={()=>setActiveApp(null)}>返回应用管理</button></section><div className="math-kind-grid">{[['formula','公式'],['theorem','定理']].map(([type,label])=><section className="panel math-kind-card" key={type}><span className="eyebrow">数学知识库</span><h2>{label}</h2><p>{(mathItems[type]||[]).length} 本{label}书，进入书籍后再上传内容。</p><button className="primary" onClick={()=>setActiveApp(`math-${type}`)}>进入{label}<ChevronRight size={16}/></button></section>)}</div></>;
  if(activeApp==='math-formula'||activeApp==='math-theorem'){const type=activeApp==='math-formula'?'formula':'theorem',label=type==='formula'?'公式':'定理';return <><section className="page-head"><div><span className="eyebrow">数学 · {label}书籍</span><h1>{label}书籍管理</h1><p>不同书籍的{label}资料独立维护，进入具体书籍后批量上传。</p></div><button className="secondary" onClick={()=>setActiveApp('math')}>返回数学模块</button></section><section className="panel politics-book-create"><div><h2>{label}书籍列表</h2><p>支持持续新增{label}书。</p></div><div><input value={newName} onChange={e=>setNewName(e.target.value)} placeholder={`例如：${label}整理书`}/><button className="primary" onClick={()=>addMathBook(type)}><Plus size={16}/>新增{label}书</button></div></section><div className="politics-book-grid">{(mathItems[type]||[]).map(book=><article className="politics-book-card" key={book.id}><div className="politics-book-mark"><BookOpen size={22}/></div><span>数学{label}书</span><h2>{book.name}</h2><p>{(book.items||[]).length?`已导入 ${book.items.length} 条`:'尚未导入资料'}</p><button className="secondary" onClick={()=>{setBookId(book.id);setActiveApp(`math-${type}`)}}>进入管理<ChevronRight size={16}/></button></article>)}</div></>}
  if(current?.id==='politics'||current?.id==='english'||current?.id==='english-choice') {const type=current.id,books=type==='politics'?politicsBooks:type==='english'?englishBooks:englishChoiceBooks;return <><section className="page-head"><div><span className="eyebrow">应用管理 · {current.subject}</span><h1>{current.title}</h1><p>{current.description}</p></div><button className="secondary" onClick={()=>setActiveApp(null)}>返回应用管理</button></section><section className="panel politics-book-create"><div><h2>{type==='english'?'单词书列表':'题书列表'}</h2><p>{type==='english'?'每本单词书独立维护，进入后再上传单词。':'每本题书独立维护，进入后再上传题目。'}</p></div><div><input value={newName} onChange={e=>setNewName(e.target.value)} placeholder={type==='english'?'例如：红宝书':'例如：肖 1000'}/><button className="primary" onClick={()=>addBook(type)}><Plus size={16}/>新增{type==='politics'?'题书':'单词书'}</button></div></section><div className="politics-book-grid">{books.map(book=><article className="politics-book-card" key={book.id}><div className="politics-book-mark"><BookOpen size={22}/></div><span>{type==='politics'?'政治题书':'英语单词书'}</span><h2>{book.name}</h2><p>{(book.questions||book.words).length?`已导入 ${(book.questions||book.words).length} 项`:'尚未导入资料'}</p><button className="secondary" onClick={()=>setBookId(book.id)}>进入管理<ChevronRight size={16}/></button></article>)}</div></>}
  if(current){const Icon=current.icon;return <><section className="page-head"><div><span className="eyebrow">应用管理 · {current.subject}</span><h1>{current.title}</h1><p>{current.description} 后续可继续接入具体内容、学生使用数据与 AI 分析。</p></div><button className="secondary" onClick={()=>setActiveApp(null)}>返回应用管理</button></section><section className="panel application-detail"><Icon size={29}/><div><h2>模块功能待配置</h2><p>教师可在这里配置内容、任务规则与学生端展示方式。</p></div></section></>}
  return <><section className="page-head"><div><span className="eyebrow">教师端 · 学习工具</span><h1>应用管理</h1><p>管理可独立使用的学习应用。</p></div></section><section className="application-grid">{apps.map(app=>{const Icon=app.icon;return <article className="application-card" key={app.id}><div className="application-card-icon"><Icon size={25}/></div><span>{app.subject}</span><h2>{app.title}</h2><p>{app.description}</p><button className="secondary" onClick={()=>setActiveApp(app.id)}>进入管理<ChevronRight size={16}/></button></article>})}</section></>;
}

function BookDistributionManagement({students, notify}) {
  const SUBJECTS = ['政治', '英语', '数学', '专业课', '通用'];
  const [books, setBooks] = useState([]);
  const [selectedBookId, setSelectedBookId] = useState('');
  const [recipients, setRecipients] = useState([]);
  const [bookDraft, setBookDraft] = useState({ subject:'政治', name:'', description:'' });
  const [recipientDraft, setRecipientDraft] = useState({ studentId:'', recipient:'', phone:'', shippingInfo:'' });
  const [loading, setLoading] = useState(false);
  const selectedBook = books.find(book => String(book.id) === String(selectedBookId));

  const loadBooks = async () => {
    if (!isApiConfigured()) return;
    setLoading(true);
    try {
      const next = await apiRequest('/api/admin/books');
      setBooks(Array.isArray(next) ? next : []);
      setSelectedBookId(current => current || next?.[0]?.id || '');
    } catch (error) { notify(error?.message || '书籍列表加载失败'); }
    finally { setLoading(false); }
  };
  const loadRecipients = async bookId => {
    if (!isApiConfigured() || !bookId) { setRecipients([]); return; }
    try { const next = await apiRequest(`/api/admin/books/${bookId}/recipients`); setRecipients(Array.isArray(next) ? next : []); }
    catch (error) { notify(error?.message || '发书名单加载失败'); }
  };
  useEffect(() => { loadBooks(); }, []);
  useEffect(() => { loadRecipients(selectedBookId); }, [selectedBookId]);
  const createBook = async () => {
    if (!bookDraft.name.trim()) return notify('请填写书籍名称');
    if (!isApiConfigured()) return notify('书籍管理需要连接服务器后使用');
    try {
      const created = await apiRequest('/api/admin/books', { method:'POST', body:{...bookDraft, name:bookDraft.name.trim(), description:bookDraft.description.trim() || null} });
      setBooks(current => [created, ...current]); setSelectedBookId(created.id); setBookDraft({subject:bookDraft.subject, name:'', description:''}); notify('书籍已新建');
    } catch (error) { notify(error?.message || '新建书籍失败'); }
  };
  const removeBook = async book => {
    if (!window.confirm(`确定删除书籍「${book.name}」及其发放名单吗？`)) return;
    try { await apiRequest(`/api/admin/books/${book.id}`, {method:'DELETE'}); setBooks(current => current.filter(item => item.id !== book.id)); if (String(selectedBookId) === String(book.id)) setSelectedBookId(''); notify('书籍及关联发放名单已删除'); }
    catch (error) { notify(error?.message || '删除书籍失败'); }
  };
  const selectStudent = id => {
    const student = (students || []).find(item => String(item.id) === String(id));
    setRecipientDraft(current => ({...current, studentId:id, recipient:student?.shippingRecipient || student?.name || '', phone:student?.shippingPhone || '', shippingInfo:student?.shippingInfo || ''}));
  };
  const addRecipient = async () => {
    if (!selectedBookId) return notify('请先选择一本书');
    if (!recipientDraft.recipient.trim()) return notify('请填写收货昵称');
    try {
      const created = await apiRequest(`/api/admin/books/${selectedBookId}/recipients`, {method:'POST', body:{studentId:recipientDraft.studentId || null, recipient:recipientDraft.recipient.trim(), phone:recipientDraft.phone.trim() || null, shippingInfo:recipientDraft.shippingInfo.trim() || null}});
      setRecipients(current => [created, ...current]); setRecipientDraft({studentId:'', recipient:'', phone:'', shippingInfo:''}); notify('已加入发书名单');
    } catch (error) { notify(error?.message || '添加发书学员失败'); }
  };
  const updateIssued = async (record, issued) => {
    try { const saved = await apiRequest(`/api/admin/books/${selectedBookId}/recipients/${record.id}`, {method:'PATCH', body:{issued}}); setRecipients(current => current.map(item => item.id === saved.id ? saved : item)); }
    catch (error) { notify(error?.message || '发放状态保存失败'); }
  };
  const removeRecipient = async record => {
    if (!window.confirm(`确定从「${selectedBook?.name || '当前书籍'}」发书名单中移除「${record.recipient}」吗？`)) return;
    try { await apiRequest(`/api/admin/books/${selectedBookId}/recipients/${record.id}`, {method:'DELETE'}); setRecipients(current => current.filter(item => item.id !== record.id)); notify('已移除发书学员'); }
    catch (error) { notify(error?.message || '移除发书学员失败'); }
  };
  const exportShipping = () => {
    const data = (students || []).map(student => ({ 科目:(student.subjects || []).map(item => item.name).join('、') || '未填写', 学员昵称:student.name || '', 收货昵称:student.shippingRecipient || '', 联系电话:student.shippingPhone || '', 收货地址:student.shippingInfo || '' }));
    if (!data.length) return notify('当前没有可导出的学员信息');
    const workbook = XLSX.utils.book_new(); const sheet = XLSX.utils.json_to_sheet(data); XLSX.utils.book_append_sheet(workbook, sheet, '学员收货信息'); XLSX.writeFile(workbook, `学员收货信息_${toDateKey(new Date())}.xlsx`); notify(`已导出 ${data.length} 名学员的收货信息`);
  };
  return <main className="book-distribution-page"><section className="page-head book-distribution-head"><div><span className="eyebrow">书籍管理 · 统一发货</span><h1>按科目管理书籍与发放记录。</h1><p>维护书籍、发书名单和已发放标记；导出报名学员的独立收货信息用于统一发货。</p></div><button type="button" className="secondary" onClick={exportShipping}><FileDown size={16}/>导出学员收货信息</button></section><div className="two-column-grid"><section className="panel"><PanelHead title="新建书籍"/><div className="form-grid"><label>科目<select value={bookDraft.subject} onChange={event => setBookDraft(current => ({...current,subject:event.target.value}))}>{SUBJECTS.map(subject => <option key={subject}>{subject}</option>)}</select></label><label>书籍名称<input value={bookDraft.name} onChange={event => setBookDraft(current => ({...current,name:event.target.value}))} placeholder="例如：政治核心考案"/></label><label className="full">书籍说明<textarea value={bookDraft.description} onChange={event => setBookDraft(current => ({...current,description:event.target.value}))} placeholder="选填：版本、适用人群或发放说明"/></label></div><button type="button" className="primary" onClick={createBook}><Plus size={16}/>新建书籍</button></section><section className="panel"><PanelHead title="已建书籍" action={loading ? '加载中' : `${books.length} 本`}/>{books.length ? <div className="stack-list">{books.map(book => <div className={`state-row ${String(book.id) === String(selectedBookId) ? 'is-selected' : ''}`} key={book.id}><button type="button" className="quiet-button" onClick={() => setSelectedBookId(book.id)}><span>{book.subject} · {book.name}</span></button><button type="button" className="icon-action" aria-label={`删除${book.name}`} onClick={() => removeBook(book)}><UserRoundX size={16}/></button></div>)}</div> : <div className="empty-line"><BookOpen size={20}/><span>暂未新建书籍。</span></div>}</section></div>{selectedBook ? <><section className="panel"><PanelHead title={`发书名单 · ${selectedBook.subject}《${selectedBook.name}》`} action={`${recipients.length} 人`}/><p className="book-auto-recipient-note">已报名 {selectedBook.subject} 的学员会自动进入此书名单；可补充手动收货人。</p><div className="form-grid"><label>选择已报名学员<select value={recipientDraft.studentId} onChange={event => selectStudent(event.target.value)}><option value="">手动新增收货人</option>{(students || []).map(student => <option key={student.id} value={student.id}>{student.name} · {(student.subjects || []).filter(item => item.enrolled).map(item => item.name).join('、') || '未选科目'}</option>)}</select></label><label>收货昵称<input value={recipientDraft.recipient} onChange={event => setRecipientDraft(current => ({...current,recipient:event.target.value}))} placeholder="收件人昵称"/></label><label>联系电话<input value={recipientDraft.phone} onChange={event => setRecipientDraft(current => ({...current,phone:event.target.value}))} placeholder="联系电话"/></label><label>收货地址<input value={recipientDraft.shippingInfo} onChange={event => setRecipientDraft(current => ({...current,shippingInfo:event.target.value}))} placeholder="详细收货地址"/></label></div><button type="button" className="primary" onClick={addRecipient}><UserPlus size={16}/>加入发书名单</button></section><section className="panel"><PanelHead title="发放记录"/>{recipients.length ? <div className="table-wrap"><table><thead><tr><th>学员/收货昵称</th><th>联系电话</th><th>收货地址</th><th>已发放</th><th>操作</th></tr></thead><tbody>{recipients.map(record => <tr key={record.id}><td>{record.studentName || record.recipient}<small>{record.studentName && record.studentName !== record.recipient ? `收货：${record.recipient}` : ''}</small></td><td>{record.phone || '未填写'}</td><td>{record.shippingInfo || '未填写'}</td><td><input type="checkbox" checked={Boolean(record.issuedAt)} onChange={event => updateIssued(record,event.target.checked)} aria-label={`标记${record.recipient}已发放`}/></td><td><button type="button" className="quiet-button danger" onClick={() => removeRecipient(record)}>移除</button></td></tr>)}</tbody></table></div> : <div className="empty-line"><Users size={20}/><span>请从已报名学员中选择，或手动新增收货人。</span></div>}</section></> : <div className="empty-line"><BookOpen size={22}/><span>新建或选择一本书后，可维护该书的发放名单。</span></div>}</main>;
}

function Content({items, setItems, students, setStudents, notify}) {
  const COURSE_SUBJECTS = ['公开课', '政治', '英语', '数学', '专业课', '学习方法分享', '政策解读'];
  const [tab, setTab] = useState('课程');
  const [categories, setCategories] = useState(loadCourseCategories);
  const [newCategory, setNewCategory] = useState('');
  const [draft, setDraft] = useState({ name: '', description: '', audience: '公开课', category: '公开课', pricing: '免费', price: '' });
  const [productDraft, setProductDraft] = useState({ name: '', category: '单科课程', note: '', courseIds: [], pricing: '免费', price: '', publishToStore: true });
  const [productCategories, setProductCategories] = useState(() => {
    const defaults = ['单科课程', '组合套餐', '资料包'];
    if (isApiConfigured()) return defaults;
    try {
      const saved = JSON.parse(window.localStorage.getItem('shangan-product-categories-v1') || 'null');
      return Array.isArray(saved) && saved.every(category => typeof category === 'string') ? saved : defaults;
    } catch (error) {
      return defaults;
    }
  });
  const [newProductCategory, setNewProductCategory] = useState('');
  const [editingId, setEditingId] = useState(null);
  const safeItems = Array.isArray(items) ? items : [];
  const categoryMap = categories && typeof categories === 'object' && !Array.isArray(categories) ? categories : DEFAULT_COURSE_CATEGORIES;
  const safeProductCategories = Array.isArray(productCategories) ? productCategories.filter(category => typeof category === 'string') : ['单科课程', '组合套餐', '资料包'];
  const safeProductCourseIds = Array.isArray(productDraft?.courseIds) ? productDraft.courseIds : [];
  const paymentConfig = safeItems.find(item => item?.type === '收款配置');
  const products = safeItems.filter(item => item?.type === '商品');
  const visible = safeItems.filter(item => tab === '课程' ? item?.type === '录播课程' : item?.type === '商品');
  const pendingOrders = safeItems.filter(item => item?.type === '购买订单' && ['待确认', '待支付'].includes(item?.state));
  const courseOptions = safeItems.filter(item => item?.type === '录播课程');
  const categoriesForDraft = Array.isArray(categoryMap[draft.audience]) ? categoryMap[draft.audience] : [];

  useEffect(() => {
    if (isApiConfigured()) return;
    try { window.localStorage.setItem('shangan-product-categories-v1', JSON.stringify(safeProductCategories)); } catch (error) { console.warn('保存商品分类失败', error); }
  }, [safeProductCategories]);

  useEffect(() => {
    if (isApiConfigured()) return;
    try { window.localStorage.setItem(COURSE_CATEGORY_STORAGE_KEY, JSON.stringify(categoryMap)); } catch (error) { console.warn('保存课程分类失败', error); }
  }, [categoryMap]);

  const updateDraft = patch => setDraft(current => ({ ...current, ...patch }));
  const selectSubject = audience => updateDraft({ audience, category: (Array.isArray(categoryMap[audience]) ? categoryMap[audience] : [])[0] || '' });
  const createCourse = async () => {
    if (!draft.name.trim()) return notify('请先填写课程名称');
    if (!draft.category.trim()) return notify('请先选择或新建课程分类');
    const price = draft.pricing === '付费' ? Number(draft.price) : 0;
    if (draft.pricing === '付费' && (!Number.isFinite(price) || price <= 0)) return notify('付费课程请填写大于 0 的售价');
    if (isApiConfigured()) {
      try {
        const created = await apiRequest('/api/admin/courses', {
          method: 'POST',
          body: {
            name: draft.name.trim(),
            subject: draft.audience,
            audience: draft.audience,
            category: draft.category.trim(),
            description: draft.description.trim(),
            pricing: draft.pricing || '免费',
            price,
            state: '草稿'
          }
        });
        const course = {
          id: created.id,
          type: '录播课程',
          name: created.name,
          subject: created.subject || draft.audience,
          audience: created.audience || draft.audience,
          category: created.category || draft.category.trim(),
          description: created.description || '',
          pricing: created.pricing,
          price: created.price || 0,
          state: created.state,
          video: null,
          materials: [],
          isServerManaged: true
        };
        setItems([...items, course]);
        setEditingId(course.id);
        updateDraft({ name: '', description: '', pricing: '免费', price: '' });
        notify('课程草稿已创建到云端，可继续补充视频、资料和文字内容后再发布');
      } catch (error) {
        notify(error?.message || '创建课程失败，请稍后重试');
      }
      return;
    }
    const course = { id: Date.now(), name: draft.name.trim(), description: draft.description.trim(), type: '录播课程', state: '草稿', audience: draft.audience, category: draft.category.trim(), pricing: draft.pricing || '免费', price, video: null, materials: [] };
    setItems([...items, course]);
    setEditingId(course.id);
    updateDraft({ name: '', description: '' });
    notify('课程草稿已创建，可继续补充视频、资料和文字内容后再发布');
  };
  const addCategory = () => {
    const name = newCategory.trim();
    if (!name) return notify('请填写分类名称');
    if (categoriesForDraft.includes(name)) return notify('该分类已存在');
    setCategories(current => ({ ...(current && typeof current === 'object' && !Array.isArray(current) ? current : DEFAULT_COURSE_CATEGORIES), [draft.audience]: [...categoriesForDraft, name] }));
    updateDraft({ category: name });
    setNewCategory('');
    notify(`已在「${draft.audience}」下新建分类「${name}」`);
  };
  const removeCategory = (audience, category) => {
    const used = safeItems.some(item => item?.type === '录播课程' && item.audience === audience && item.category === category);
    if (used) return notify('该分类下仍有课程，请先删除或移动课程后再删除分类');
    if (!window.confirm(`确定删除「${audience} · ${category}」分类吗？`)) return;
    setCategories(current => ({ ...(current && typeof current === 'object' && !Array.isArray(current) ? current : DEFAULT_COURSE_CATEGORIES), [audience]: (Array.isArray(current?.[audience]) ? current[audience] : []).filter(item => item !== category) }));
    if (draft.audience === audience && draft.category === category) updateDraft({ category: (Array.isArray(categoryMap[audience]) ? categoryMap[audience] : []).find(item => item !== category) || '' });
    notify('课程分类已删除');
  };
  // 服务端课程走真实上传（multipart），本地演示课程仍用浏览器临时预览
  const uploadCourseAsset = async (id, file, kind) => {
    const formData = new FormData();
    formData.append('kind', kind);
    formData.append('file', file);
    // apiRequest keeps the multipart boundary intact and applies the same
    // cookie/401/idempotency policy as every other protected write.
    return apiRequest(`/api/admin/courses/${encodeURIComponent(id)}/assets`, {
      method: 'POST',
      body: formData,
    });
  };
  const uploadVideo = async (id, file) => {
    if (!file) return;
    if (!file.type.startsWith('video/')) return notify('请选择视频文件，例如 MP4、WebM 或 MOV');
    const course = items.find(item => item.id === id);
    if (isApiConfigured() && course?.isServerManaged) {
      if (file.size > 200 * 1024 * 1024) return notify('单个视频请控制在 200MB 以内');
      try {
        const asset = await uploadCourseAsset(id, file, 'video');
        setItems(current => current.map(item => item.id === id ? { ...item, video: { id: asset.id, fileName: asset.fileName, fileSize: asset.sizeBytes, fileType: asset.mimeType, url: resolveApiUrl(asset.url), uploadedAt: asset.createdAt, serverManaged: true } } : item));
        notify(`录播视频「${file.name}」已上传到服务器，学生端刷新后也可观看`);
      } catch (error) { notify(error?.message || '视频上传失败，请稍后重试'); }
      return;
    }
    if (file.size > 1024 * 1024 * 1024) return notify('单个视频请控制在 1GB 以内');
    const previous = course?.video;
    if (previous?.objectUrl) URL.revokeObjectURL(previous.objectUrl);
    const video = { fileName: file.name, fileSize: file.size, fileType: file.type, objectUrl: URL.createObjectURL(file), temporary: true, uploadedAt: new Date().toISOString() };
    setItems(items.map(item => item.id === id ? { ...item, video } : item));
    notify(`已上传录播文件「${file.name}」。本地预览资料在刷新页面后会失效。`);
  };
  const uploadMaterial = async (id, file) => {
    if (!file) return;
    const maxSize = 200 * 1024 * 1024;
    if (file.size > maxSize) return notify('单个配套资料请控制在 200MB 以内');
    const course = items.find(item => item.id === id);
    if (isApiConfigured() && course?.isServerManaged) {
      try {
        const asset = await uploadCourseAsset(id, file, 'material');
        setItems(current => current.map(item => item.id === id ? { ...item, materials: [...(item.materials || []), { id: asset.id, fileName: asset.fileName, fileSize: asset.sizeBytes, fileType: asset.mimeType || 'application/octet-stream', url: resolveApiUrl(asset.url), uploadedAt: asset.createdAt, serverManaged: true }] } : item));
        notify(`配套资料「${file.name}」已上传到服务器，学生端刷新后也可下载`);
      } catch (error) { notify(error?.message || '资料上传失败，请稍后重试'); }
      return;
    }
    const material = { id: `${Date.now()}-${file.name}`, fileName: file.name, fileSize: file.size, fileType: file.type || 'application/octet-stream', objectUrl: URL.createObjectURL(file), temporary: true, uploadedAt: new Date().toISOString() };
    setItems(items.map(item => item.id === id ? { ...item, materials: [...(item.materials || []), material] } : item));
    notify(`已添加配套资料「${file.name}」`);
  };
  const removeMaterial = async (courseId, materialId) => {
    const material = items.find(item => item.id === courseId)?.materials?.find(entry => entry.id === materialId);
    if (isApiConfigured() && material && !material.temporary) {
      try { await apiRequest(`/api/admin/course-assets/${encodeURIComponent(materialId)}`, { method: 'DELETE' }); }
      catch (error) { return notify(error?.message || '删除失败，请稍后重试'); }
    }
    if (material?.temporary && material?.objectUrl) URL.revokeObjectURL(material.objectUrl);
    setItems(items.map(item => item.id === courseId ? { ...item, materials: (item.materials || []).filter(material => material.id !== materialId) } : item));
    notify('配套资料已移除');
  };
  const updateCourseDescription = (id, description) => {
    setItems(current => current.map(item => item.id === id ? { ...item, description } : item));
  };
  const saveCourseDescription = async (id, description) => {
    const course = safeItems.find(item => String(item.id) === String(id));
    if (!isApiConfigured() || !course?.isServerManaged) return;
    try {
      const saved = await apiRequest(`/api/admin/courses/${encodeURIComponent(id)}`, { method: 'PATCH', body: { description } });
      setItems(current => current.map(item => String(item.id) === String(id) ? { ...item, description: saved.description ?? description } : item));
      notify('课程说明已保存到服务器');
    } catch (error) { notify(error?.message || '课程说明保存失败，请重试'); }
  };
  const publish = async id => {
    const item = items.find(entry => entry.id === id);
    const isPublished = item?.state === '已发布';
    if (!isPublished && (!String(item?.name || '').trim() || (!String(item?.description || '').trim() && !item?.video?.fileName && !(item?.materials || []).length))) return notify('发布前请至少填写课程文字内容，或上传视频 / 配套资料');
    if (isApiConfigured() && item?.isServerManaged) {
      try {
        await apiRequest(`/api/admin/courses/${id}/publish`, {
          method: 'POST',
          body: { state: isPublished ? '已下架' : '已发布' }
        });
      } catch (error) {
        notify(error?.message || '操作失败，请稍后重试');
        return;
      }
    }
    setItems(items.map(item => item.id === id ? { ...item, state: isPublished ? '已下架' : '已发布' } : item));
    notify(isPublished ? '课程已下架，学生端不再显示' : '课程已发布，所有学生均可在商城查看；领取或购买后进入我的课程');
  };
  const deleteCourse = async item => {
    if (isApiConfigured() && item?.isServerManaged) {
      if (!window.confirm(`确定下架课程「${item.name}」吗？历史权益会由服务端保留。`)) return;
      try {
        await apiRequest(`/api/admin/courses/${encodeURIComponent(item.id)}/publish`, { method: 'POST', body: { state: '已下架' } });
        setItems(current => current.map(entry => String(entry.id) === String(item.id) ? { ...entry, state: '已下架' } : entry));
        notify('课程已下架；服务端未提供删除接口，历史记录已保留');
      } catch (error) { notify(error?.message || '课程下架失败，请稍后重试'); }
      return;
    }
    const linkedProducts = products.filter(product => (product.courseIds || []).map(String).includes(String(item.id)) && product.state !== '已下架');
    if (linkedProducts.length) return notify(`课程仍绑定在 ${linkedProducts.map(product => `「${product.name}」`).join('、')}，请先在商品中下架或解除绑定`);
    const pendingOrderIds = new Set(items.filter(entry => entry.type === '购买订单' && entry.state === '待确认' && (entry.courseIds || []).map(String).includes(String(item.id))).map(entry => entry.id));
    if (!window.confirm(`确定删除课程「${item.name}」吗？待确认订单将自动关闭；已开通记录会保留为历史记录。`)) return;
    setItems(current => current.filter(entry => entry.id !== item.id).map(entry => pendingOrderIds.has(entry.id) ? {...entry, state:'已失效', invalidReason:'课程已下架'} : entry));
    if (editingId === item.id) setEditingId(null);
    notify('课程已删除，关联待确认订单已关闭');
  };
  const createProduct = async () => {
    if (!productDraft.name.trim()) return notify('请先填写商品名称');
    if (productDraft.pricing === '付费' && (!Number.isFinite(Number(productDraft.price)) || Number(productDraft.price) <= 0)) return notify('付费商品请填写大于 0 的售价');
    if (isApiConfigured()) {
      try {
        // Product creation is always a draft operation. Publication is a
        // separate state transition so the API never receives state=已上架
        // on POST /products.
        const created = await apiRequest('/api/admin/products', {
          method: 'POST',
          body: {
            name: productDraft.name.trim(),
            category: productDraft.category.trim() || '未分类',
            description: productDraft.note.trim(),
            pricing: productDraft.pricing,
            price: productDraft.pricing === '付费' ? Number(productDraft.price) : 0,
            state: '草稿',
            courseIds: safeProductCourseIds
          }
        });
        let product = {
          id: created.id,
          type: '商品',
          name: created.name,
          category: created.category || '未分类',
          note: created.description || '',
          courseIds: Array.isArray(created.courseIds) ? created.courseIds.map(String) : [],
          pricing: created.pricing,
          price: created.price || 0,
          state: created.state || '草稿',
          asset: null,
          isServerManaged: true
        };
        setItems(current => [...current, product]);
        setProductDraft(current => ({ name: '', category: current?.category || safeProductCategories[0] || '单科课程', note: '', courseIds: [], pricing: '免费', price: '', publishToStore: true }));
        if (productDraft.publishToStore) {
          try {
            const published = await apiRequest(`/api/admin/products/${encodeURIComponent(product.id)}/state`, {
              method: 'POST',
              body: { state: '已上架' }
            });
            product = { ...product, ...(published || {}), state: published?.state || '已上架' };
            setItems(current => current.map(item => String(item.id) === String(product.id) ? { ...item, ...product } : item));
            notify(`商品「${product.name}」已保存并上架，学生可在商城查看`);
          } catch (error) {
            // Keep the server-created draft visible. The same action remains
            // available from the table, so a failed publication is retryable.
            notify(`商品草稿已保存，但上架失败：${error?.message || '请稍后重试'}。可点击“上架”重试`);
          }
        } else {
          notify(`商品「${product.name}」已保存为草稿，请核对交付内容后再上架`);
        }
      } catch (error) {
        notify(error?.message || '创建商品失败，请稍后重试');
      }
      return;
    }
    const product = { id: Date.now(), type: '商品', name: productDraft.name.trim(), category: productDraft.category.trim() || '未分类', note: productDraft.note.trim(), courseIds: safeProductCourseIds, pricing: productDraft.pricing, price: productDraft.pricing === '付费' ? Number(productDraft.price) : 0, state: productDraft.publishToStore ? '已上架' : '草稿', asset: null };
    setItems([...items, product]);
    setProductDraft(current => ({ name: '', category: current?.category || safeProductCategories[0] || '单科课程', note: '', courseIds: [], pricing: '免费', price: '', publishToStore: true }));
    notify(`商品「${product.name}」已保存为草稿，请核对交付内容后再上架`);
  };
  const uploadProductAsset = (id, file) => {
    if (isApiConfigured()) return notify('商品资料上传接口尚未提供；未保存浏览器临时文件。');
    if (!file) return;
    const previous = items.find(item => item.id === id)?.asset;
    if (previous?.objectUrl) URL.revokeObjectURL(previous.objectUrl);
    const asset = { fileName: file.name, fileSize: file.size, fileType: file.type || 'application/octet-stream', objectUrl: URL.createObjectURL(file), temporary: true, uploadedAt: new Date().toISOString() };
    setItems(items.map(item => item.id === id ? { ...item, asset } : item));
    notify(`商品资料「${file.name}」已上传。本地预览资料在刷新页面后会失效，正式上线请接入文件存储。`);
  };
  const toggleProductState = async product => {
    const nextState = product.state === '已上架' ? '已下架' : '已上架';
    if (nextState === '已上架' && !(product.courseIds || []).length && !product.asset?.fileName) return notify('上架前请绑定课程或上传可交付的商品资料');
    if (nextState === '已上架' && product.pricing === '付费' && (!Number.isFinite(Number(product.price)) || Number(product.price) <= 0)) return notify('付费商品上架前请填写大于 0 的售价');
    if (nextState === '已上架' && !['免费', '付费'].includes(product.pricing)) return notify('上架前请配置商品售卖方式');
    if (isApiConfigured() && product.isServerManaged) {
      try {
        await apiRequest(`/api/admin/products/${product.id}/state`, { method: 'POST', body: { state: nextState } });
      } catch (error) {
        notify(error?.message || '操作失败，请稍后重试');
        return;
      }
    }
    setItems(current => current.map(item => item.id === product.id ? {...item, state:nextState} : item));
    notify(nextState === '已上架' ? '商品已上架，学生可在商城查看' : '商品已下架，学生端不再展示');
  };
  const deleteProduct = async product => {
    if (isApiConfigured() && product?.isServerManaged) {
      if (!window.confirm(`确定下架商品「${product.name}」吗？历史订单与权益会保留。`)) return;
      try {
        if (product.state !== '已下架') await apiRequest(`/api/admin/products/${encodeURIComponent(product.id)}/state`, { method: 'POST', body: { state: '已下架' } });
        setItems(current => current.map(entry => String(entry.id) === String(product.id) ? { ...entry, state: '已下架' } : entry));
        notify('商品已下架；服务端未提供删除接口，历史记录已保留');
      } catch (error) { notify(error?.message || '商品下架失败，请稍后重试'); }
      return;
    }
    const activeOrders = items.filter(item => item.type === '购买订单' && String(item.productId) === String(product.id) && ['待确认', '已开通'].includes(item.state));
    if (activeOrders.length) return notify('该商品已有待确认或已开通订单，请先下架保留历史记录，不能直接删除');
    if (!window.confirm(`确定删除商品「${product.name}」吗？`)) return;
    setItems(items.filter(item => item.id !== product.id));
    notify('商品草稿已删除');
  };
  const savePaymentCode = file => {
    if (isApiConfigured()) return notify('收款码上传接口尚未提供；未保存浏览器临时文件。');
    if (!file) return;
    if (!file.type.startsWith('image/')) return notify('请选择图片格式的收款码');
    const previous = paymentConfig;
    if (previous?.objectUrl) URL.revokeObjectURL(previous.objectUrl);
    const config = { id: 'payment-config', type: '收款配置', fileName: file.name, fileType: file.type, fileSize: file.size, objectUrl: URL.createObjectURL(file), temporary: true, updatedAt: new Date().toISOString() };
    setItems([...items.filter(item => item.type !== '收款配置'), config]);
    notify('收款码已保存。本地预览会在刷新页面后失效，正式上线请保存至安全文件存储。');
  };
  const approveOrder = async order => {
    const product = products.find(item => String(item.id) === String(order.productId)) || courseOptions.find(item => String(item.id) === String(order.productId));
    if (!product) return notify('对应课程或商品已被删除，无法开通权限');
    if (isApiConfigured() && order.isServerManaged) {
      try {
        await apiRequest(`/api/admin/orders/${order.id}/review`, {
          method: 'POST',
          body: { status: '已支付', reviewNote: '老师已核验收款' }
        });
        notify(`已确认收款，已为${order.studentName}开通「${product.name}」`);
      } catch (error) {
        notify(error?.message || '审核订单失败，请稍后重试');
        return;
      }
    }
    const courseIds = product.type === '录播课程' ? [product.id] : (product.courseIds || order.courseIds || []);
    setStudents(current => current.map(student => String(student.id) === String(order.studentId) ? { ...student, purchasedProductIds: Array.from(new Set([...(student.purchasedProductIds || []), product.id])), purchasedCourseIds: Array.from(new Set([...(student.purchasedCourseIds || []), ...courseIds])) } : student));
    setItems(current => current.map(item => item.id === order.id ? { ...item, state: '已开通', approvedAt: new Date().toISOString(), approvedCourseIds: courseIds } : item));
    if (!order.isServerManaged) notify(`已确认收款，已为${order.studentName}自动开通「${product.name}」`);
  };
  const rejectOrder = async order => {
    if (!window.confirm(`确定驳回${order.studentName}的「${order.productName}」购买申请吗？`)) return;
    if (isApiConfigured() && order.isServerManaged) {
      try {
        await apiRequest(`/api/admin/orders/${order.id}/review`, {
          method: 'POST',
          body: { status: '已驳回', reviewNote: '老师已驳回' }
        });
      } catch (error) {
        notify(error?.message || '驳回订单失败，请稍后重试');
        return;
      }
    }
    setItems(current => current.map(item => item.id === order.id ? { ...item, state: '已驳回', rejectedAt: new Date().toISOString() } : item));
    notify('购买申请已驳回，未开通任何权限');
  };

  return <>
    <section className="page-head">
      <div>
        <span className="eyebrow">录播课程 · 商品 · 权益</span>
        <h1>按学科与课程分类管理录播内容。</h1>
        <p>每门课程先命名，再归入公开课或对应学科，并选择该学科下的课程分类。草稿完善后，点击发布才会同步到符合权限条件的学生端。</p>
      </div>
    </section>

    <div className="plan-subjects">
      <button className={tab === '课程' ? 'active' : ''} onClick={() => setTab('课程')}>课程管理</button>
      <button className={tab === '商品' ? 'active' : ''} onClick={() => setTab('商品')}>商品与套餐</button>
      <button className={tab === '收款' ? 'active' : ''} onClick={() => setTab('收款')}>收款设置</button>
    </div>

    {tab === '收款' ? (
      <>
        <section className="panel payment-panel">
          <LockKeyhole size={25}/>
          <div>
            <h2>微信收款码与购买审核</h2>
            <p>{paymentConfig?.fileName ? `当前收款码：${paymentConfig.fileName}；学生提交购买申请后，由老师核验收款。核验通过时系统自动开通商品和绑定课程。` : '尚未上传收款码，学生购买时会看到未配置提示。'}</p>
            {paymentConfig?.objectUrl && <img className="teacher-qr-preview" src={paymentConfig.objectUrl} alt="当前微信收款码"/>}
          </div>
          <label className={`primary file-button ${isApiConfigured() ? 'is-disabled' : ''}`}>{paymentConfig ? '更新收款码' : '上传收款码'}<input disabled={isApiConfigured()} type="file" accept="image/*" onChange={event => { savePaymentCode(event.target.files?.[0]); event.target.value = ''; }}/></label>
        </section>

        <section className="panel table-panel payment-order-panel">
          <PanelHead title="待确认购买申请" action={`${pendingOrders.length} 笔`}/>
          <p className="payment-order-tip">二维码付款无法由浏览器自动识别。请核对到账记录后确认；确认后平台会立即写入该学生的商品权益和课程权限。</p>
          {pendingOrders.length ? <table><thead><tr><th>学员</th><th>购买商品</th><th>包含课程</th><th>提交时间</th><th>操作</th></tr></thead><tbody>{pendingOrders.map(order => {
            const orderCourses = courseOptions.filter(course => (order.courseIds || []).map(String).includes(String(course.id)));
            return <tr key={order.id}><td><b>{order.studentName}</b></td><td><b>{order.productName}</b><small>待确认收款</small></td><td>{orderCourses.length ? <div className="order-course-list">{orderCourses.map(course => <span key={course.id}>{course.name}</span>)}</div> : <small>该商品未绑定课程，仅开通商品资料</small>}</td><td><small>{order.createdAt ? new Date(order.createdAt).toLocaleString('zh-CN', { hour12: false }) : '—'}</small></td><td><div className="row-actions"><button className="primary" onClick={() => approveOrder(order)}><Check size={15}/>确认收款并开通</button><button className="danger-button" onClick={() => rejectOrder(order)}>驳回</button></div></td></tr>;
          })}</tbody></table> : <div className="empty-line"><Check size={20}/><span>暂无待确认购买申请。</span></div>}
        </section>
      </>
    ) : tab === '商品' ? (
      <>
        <section className="product-management-layout">
          <section className="panel product-create-panel">
            <div className="course-step-head"><span>01</span><div><span className="eyebrow">上传商品</span><h2>建立商品或套餐入口</h2><p>商品可绑定已发布课程。老师核验收款后，系统自动开放这些课程。</p></div></div>
            <div className="product-create-form">
              <label>商品名称<input value={productDraft.name} onChange={event => setProductDraft(current => ({ ...current, name: event.target.value }))} placeholder="例如：英语基础提升套餐"/></label>
              <label>商品分类<select value={productDraft.category} onChange={event => setProductDraft(current => ({ ...current, category: event.target.value }))}>{safeProductCategories.map(category => <option key={category}>{category}</option>)}</select></label>
              <label>商品说明<textarea value={productDraft.note} onChange={event => setProductDraft(current => ({ ...current, note: event.target.value }))} placeholder="填写商品包含的课程、资料或服务说明。"/></label>
              <div className="course-pricing-picker"><span>售卖方式</span><div><label className={productDraft.pricing === '免费' ? 'is-selected' : ''}><input type="radio" name="product-pricing" checked={productDraft.pricing === '免费'} onChange={() => setProductDraft(current => ({...current, pricing:'免费', price:''}))}/><b>免费</b><small>学生可直接领取</small></label><label className={productDraft.pricing === '付费' ? 'is-selected' : ''}><input type="radio" name="product-pricing" checked={productDraft.pricing === '付费'} onChange={() => setProductDraft(current => ({...current, pricing:'付费'}))}/><b>付费</b><small>付款后由老师确认开通</small></label></div></div>
              {productDraft.pricing === '付费' && <label>售价（元）<input type="number" min="0.01" step="0.01" value={productDraft.price} onChange={event => setProductDraft(current => ({...current, price:event.target.value}))} placeholder="例如：199"/></label>}
              <div className="product-course-binding">
                <div className="product-course-binding-head"><span>购买后自动开放的课程</span><b>已选 {safeProductCourseIds.length} 门</b></div>
                {courseOptions.filter(course => course.state === '已发布').length ? <div className="product-course-options">{courseOptions.filter(course => course.state === '已发布').map(course => {
                  const selected = safeProductCourseIds.map(String).includes(String(course.id));
                  return <label className={selected ? 'is-selected' : ''} key={course.id}><input type="checkbox" checked={selected} onChange={() => setProductDraft(current => ({ ...current, courseIds: selected ? (Array.isArray(current.courseIds) ? current.courseIds : []).filter(id => String(id) !== String(course.id)) : [...(Array.isArray(current.courseIds) ? current.courseIds : []), course.id] }))}/><span><b>{course.name}</b><small>{course.audience || '公开课'} · {course.category || '未分类'}</small></span></label>;
                })}</div> : <div className="product-course-empty">暂无已发布课程。可先创建并发布课程，再为商品绑定课程权益。</div>}
              </div>
              <label className="product-store-publish"><input type="checkbox" checked={productDraft.publishToStore !== false} onChange={event => setProductDraft(current => ({ ...current, publishToStore:event.target.checked }))}/><span><b>同步上架到学生商城</b><small>关闭后仅保存为草稿，学生端不会显示。</small></span></label>
              <button className="primary" onClick={createProduct}><Upload size={16}/>{productDraft.publishToStore !== false ? '上传并上架商品' : '保存商品草稿'}</button>
            </div>
          </section>
          <section className="panel product-category-panel"><div className="course-step-head"><span>02</span><div><span className="eyebrow">商品分类</span><h2>维护分类目录</h2><p>分类只用于整理商品，不影响课程分类。</p></div></div><div className="product-category-list">{safeProductCategories.map(category => <span key={category}>{category}</span>)}</div><div className="course-category-create"><input value={newProductCategory} onChange={event => setNewProductCategory(event.target.value)} placeholder="新建商品分类"/><button className="secondary" onClick={() => { const name = newProductCategory.trim(); if (!name) return notify('请填写商品分类'); if (safeProductCategories.includes(name)) return notify('该商品分类已存在'); setProductCategories(current => [...(Array.isArray(current) ? current : []), name]); setNewProductCategory(''); notify(`已新增商品分类「${name}」`); }}><Plus size={15}/>添加分类</button></div></section>
        </section>
        <section className="panel table-panel"><PanelHead title="已上传商品" action={`${products.length} 项`}/>{products.length ? <table><thead><tr><th>商品名称与状态</th><th>售价与分类</th><th>说明</th><th>课程权益</th><th>商品资料</th><th>操作</th></tr></thead><tbody>{products.map(product => { const boundCourses = courseOptions.filter(course => (product.courseIds || []).map(String).includes(String(course.id))); return <tr key={product.id}><td><b>{product.name}</b><small>{product.state === '已上架' ? '学生商城可见' : product.state === '已下架' ? '已下架，历史权益保留' : '草稿，学生不可见'}</small></td><td><span className={`badge ${product.pricing === '付费' ? 'warn' : 'ok'}`}>{product.pricing === '付费' ? `付费 ¥${Number(product.price || 0).toFixed(2)}` : '免费'}</span><small>{product.category}</small></td><td>{product.note || '—'}</td><td>{boundCourses.length ? <div className="order-course-list">{boundCourses.map(course => <span key={course.id}>{course.name}</span>)}</div> : <small>未绑定课程</small>}</td><td>{product.asset?.fileName ? <span>{product.asset.fileName}</span> : isApiConfigured() ? <small>未接入商品资料</small> : <label className={`quiet-button file-button ${isApiConfigured() ? 'is-disabled' : ''}`}><Upload size={14}/>上传商品资料<input disabled={isApiConfigured()} type="file" accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.zip,.rar,.txt" onChange={event => { uploadProductAsset(product.id, event.target.files?.[0]); event.target.value = ''; }}/></label>}</td><td><div className="row-actions"><button className="secondary" onClick={() => toggleProductState(product)}>{product.state === '已上架' ? '下架' : '上架'}</button><button className="danger-button" onClick={() => deleteProduct(product)}>删除</button></div></td></tr>; })}</tbody></table> : <div className="empty-line"><PackageOpen size={21}/><span>还没有商品，请在上方填写信息后点击“上传商品”。</span></div>}</section>
      </>
    ) : <>
      <section className="course-management-layout">
        <section className="panel course-catalog-panel">
          <div className="course-step-head"><span>01</span><div><span className="eyebrow">课程目录</span><h2>选择学科，维护分类</h2><p>分类用于归档同一学科下的课程。先确定课程归属，再建立课程内容。</p></div></div>
          <div className="course-subject-tabs">{COURSE_SUBJECTS.map(subject => <button key={subject} className={draft.audience === subject ? 'active' : ''} onClick={() => selectSubject(subject)}>{subject}</button>)}</div>
          <div className="course-category-area"><div className="course-category-caption"><b>{draft.audience}的课程分类</b><small>点击分类后，可直接用于右侧创建课程</small></div><div className="course-category-list">{categoriesForDraft.length ? categoriesForDraft.map(category => <div className={draft.category === category ? 'is-selected' : ''} key={category}><button type="button" className="course-category-select" onClick={() => updateDraft({ category })}>{category}</button><button type="button" className="course-category-remove" aria-label={`删除${category}分类`} onClick={() => removeCategory(draft.audience, category)}>×</button></div>) : <em>暂无分类，请先新建</em>}</div></div>
          <div className="course-category-create"><input value={newCategory} onChange={event => setNewCategory(event.target.value)} placeholder={`在「${draft.audience}」下新建分类`}/><button className="secondary" onClick={addCategory}><Plus size={15}/>添加分类</button></div>
        </section>

        <section className="panel course-create-panel">
          <div className="course-step-head"><span>02</span><div><span className="eyebrow">创建课程草稿</span><h2>填写课程基本信息</h2><p>先创建草稿，再补充文字、视频和资料；确认无误后统一发布给学生。</p></div></div>
          <div className="course-create-form">
            <label>课程名称<input value={draft.name} onChange={event => updateDraft({ name: event.target.value })} placeholder="例如：基础语法 - 从句精讲"/></label>
            <label>课程文字内容<textarea value={draft.description} onChange={event => updateDraft({ description: event.target.value })} placeholder="填写本节课程说明、学习目标、阅读提示或作业要求。"/></label>
            <div className="course-pricing-picker"><span>课程开通方式</span><div><label className={draft.pricing === '免费' ? 'is-selected' : ''}><input type="radio" name="course-pricing" value="免费" checked={draft.pricing === '免费'} onChange={event => updateDraft({ pricing: event.target.value, price: '' })}/><b>免费</b><small>发布后在商城可直接领取</small></label><label className={draft.pricing === '付费' ? 'is-selected' : ''}><input type="radio" name="course-pricing" value="付费" checked={draft.pricing === '付费'} onChange={event => updateDraft({ pricing: event.target.value })}/><b>付费</b><small>商城扫码付款，老师确认后开通</small></label></div></div>
            {draft.pricing === '付费' && <label>售价（元）<input type="number" min="0.01" step="0.01" value={draft.price} onChange={event => updateDraft({ price: event.target.value })} placeholder="例如：199"/></label>}
            <div className="course-selected-category"><span>当前归类</span><b>{draft.audience} · {draft.category || '请先在左侧选择或新建分类'}</b></div>
            <div className="course-create-footer"><span>草稿不会显示给学生</span><button className="primary" onClick={createCourse}><Plus size={16}/>创建课程草稿</button></div>
          </div>
        </section>
      </section>

      <section className="panel table-panel">
        <PanelHead title="录播课程列表" action={`${visible.length} 门`}/>
        <table><thead><tr><th>课程名称与文字内容</th><th>学科</th><th>课程分类</th><th>售卖方式</th><th>视频与配套资料</th><th>状态</th><th>操作</th></tr></thead><tbody>{visible.map(item => <tr key={item.id}>
          <td><div className="course-text-editor"><b>{item.name}</b><small>受控播放 · 不允许下载</small><textarea value={item.description || ''} onChange={event => updateCourseDescription(item.id, event.target.value)} onBlur={event => saveCourseDescription(item.id, event.target.value)} placeholder="填写课程文字内容、学习目标或作业说明" aria-label={`${item.name}的课程文字内容`}/></div></td>
          <td><span className="badge ok">{item.audience || '公开课'}</span></td>
          <td>{item.category || '未分类'}</td>
          <td><span className={`badge ${item.pricing === '付费' ? 'warn' : 'ok'}`}>{item.pricing || '免费'}</span></td>
          <td><div className="course-resource-upload"><div className="course-video-upload"><span className="course-resource-label">课程视频</span>{item.video?.fileName ? <><b>{item.video.fileName}</b><small>{formatCourseFileSize(item.video.fileSize)} · 已上传</small></> : <small className="course-resource-empty">尚未上传视频</small>}<label className="quiet-button file-button"><Upload size={14}/>{item.video?.fileName ? '替换视频' : '上传视频'}<input type="file" accept="video/*" onChange={event => { uploadVideo(item.id, event.target.files?.[0]); event.target.value = ''; }}/></label></div><div className="course-material-upload"><span className="course-resource-label">配套资料</span>{(item.materials || []).length ? <div className="course-material-list">{item.materials.map(material => <span key={material.id}><FileText size={12}/><b title={material.fileName}>{material.fileName}</b><button type="button" aria-label={`移除${material.fileName}`} onClick={() => removeMaterial(item.id, material.id)}>×</button></span>)}</div> : <small className="course-resource-empty">可添加讲义、作业、PPT、表格或压缩包</small>}<label className="quiet-button file-button"><Upload size={14}/>添加资料<input type="file" accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.csv,.zip,.rar,.txt" onChange={event => { uploadMaterial(item.id, event.target.files?.[0]); event.target.value = ''; }}/></label></div></div></td>
          <td><span className={`badge ${item.state === '已发布' ? 'ok' : 'warn'}`}>{item.state === '已发布' ? '已发布' : item.state === '已下架' ? '已下架' : '草稿'}</span></td>
          <td><div className="row-actions"><button className="secondary" onClick={() => publish(item.id)}>{item.state === '已发布' ? '下架课程' : '发布课程'}</button><button className="danger-button" onClick={() => deleteCourse(item)}>删除</button></div></td>
        </tr>)}</tbody></table>
      </section>
    </>}

    <section className="panel upload-note"><BookOpen size={22}/><div><h3>学生端同步规则</h3><p>已发布课程会同步到商城。公开课、学习方法分享和政策解读会直接显示给所有学生；其余课程在学生报名对应科目或获得课程权限后显示在“我的课程”。免费课程可直接领取；付费课程在老师确认收款后开通。删除课程或转为草稿后，商城与学生端会立即移除该课程。</p></div></section>
  </>;
}

const ENTRANCE_PAPERS_STORAGE_KEY = 'shangan-entrance-papers-v1';
const ENTRANCE_PAPER_VERSION = 2;

const RAW_ENTRANCE_PAPERS = [
  {
    id: 'entry-paper-1',
    title: '入学自测一',
    level: '基础起步',
    summary: '覆盖政治基本概念、英语词汇语法、英译中、数学初等计算与公式。',
    passThreshold: 60,
    shareSlug: 'entry1',
    sections: {
      政治: [
        { id:'p1-q01', number:1, prompt:'马克思主义哲学区别于旧哲学的关键在于', options:['强调实践','强调思辨','强调信仰','强调经验'], answer:'A', knowledge:'马克思主义哲学的实践观是区分于一切旧哲学的根本标志。' },
        { id:'p1-q02', number:2, prompt:'社会主义的本质要求最终要体现在', options:['共同富裕','平均分配','按需生产','完全公有'], answer:'A', knowledge:'共同富裕是社会主义本质的最终体现。' },
        { id:'p1-q03', number:3, prompt:'党的思想路线的核心是', options:['实事求是','群众路线','独立自主','与时俱进'], answer:'A', knowledge:'实事求是是党的思想路线的核心。' },
        { id:'p1-q04', number:4, prompt:'新民主主义革命的开端是', options:['五四运动','辛亥革命','南昌起义','遵义会议'], answer:'A', knowledge:'五四运动标志着新民主主义革命的开端。' },
        { id:'p1-q05', number:5, prompt:'“两个一百年”的第一个“一百年”目标指', options:['全面建成小康社会','基本实现现代化','建成现代化强国','实现共同富裕'], answer:'A', knowledge:'第一个“一百年”目标是全面建成小康社会。' },
        { id:'p1-q06', number:6, prompt:'我国社会主义初级阶段的主要矛盾是', options:['人民日益增长的美好生活需要和不平衡不充分的发展之间的矛盾','阶级矛盾','城乡矛盾','劳资矛盾'], answer:'A', knowledge:'新时代主要矛盾已转化为发展质量与平衡的问题。' },
        { id:'p1-q07', number:7, prompt:'哲学上“运动是绝对的，静止是相对的”反映的是', options:['辩证法','形而上学','不可知论','唯心论'], answer:'A', knowledge:'运动与静止的关系是辩证法基本观点。' },
        { id:'p1-q08', number:8, prompt:'“从群众中来，到群众中去”体现的工作方法是', options:['群众路线','理论联系实际','批评与自我批评','统一战线'], answer:'A', knowledge:'群众路线是党的根本工作方法。' }
      ],
      英语: {
        vocabulary: [
          { id:'p1-v01', number:1, word:'sustain', options:['维持；使持续','使分开','使下沉','使爆炸'], answer:'A', knowledge:'sustain = sustain·维持；词根 sus- 表示“下、托”。' },
          { id:'p1-v02', number:2, word:'acquire', options:['获得；习得','询问','要求','欣赏'], answer:'A', knowledge:'acquire = 获得；与 require（要求）拼写相近，注意区别。' },
          { id:'p1-v03', number:3, word:'crucial', options:['关键的','粗糙的','残酷的','晶体的'], answer:'A', knowledge:'crucial = 至关重要的；与 cruel（残忍的）形近。' },
          { id:'p1-v04', number:4, word:'reluctant', options:['不情愿的','相关的','可靠的','孤立的'], answer:'A', knowledge:'reluctant = 勉强的；前缀 re- + luct-（挣扎）。' },
          { id:'p1-v05', number:5, word:'sufficient', options:['足够的','表面的','有效的','稀少的'], answer:'A', knowledge:'sufficient = 充足的；词根 suf-（在下）+ fic（做）。' },
          { id:'p1-v06', number:6, word:'eliminate', options:['消除；淘汰','颂扬','强调','说明'], answer:'A', knowledge:'eliminate = 消除；词根 e（出）+ limin（门槛）。' },
          { id:'p1-v07', number:7, word:'comprehensive', options:['综合的；全面的','可比较的','压缩的','化合的'], answer:'A', knowledge:'comprehensive = 综合的；com-（共同）+ prehens（抓）。' },
          { id:'p1-v08', number:8, word:'undermine', options:['逐渐削弱','强调','理解','调查'], answer:'A', knowledge:'undermine = 在下面挖，逐步削弱；mine = 矿、暗中破坏。' },
          { id:'p1-v09', number:9, word:'inevitable', options:['不可避免的','不可避免的/可改进的','可避免的','不确定的'], answer:'A', knowledge:'inevitable = 不可避免的；in-（否定）+ evit（避免）+ able。' },
          { id:'p1-v10', number:10, word:'depict', options:['描绘','预测','依靠','反对'], answer:'A', knowledge:'depict = 描绘；de-（下）+ pict（画）。' }
        ],
        grammar: [
          { id:'p1-g01', number:1, sentence:'If I _____ more time, I would finish the project.', options:['had','have','will have','having'], answer:'A', knowledge:'与现在事实相反的虚拟条件句，从句用一般过去时。' },
          { id:'p1-g02', number:2, sentence:'The book _____ on the desk belongs to Tom.', options:['lying','lied','lies','lay'], answer:'A', knowledge:'现在分词短语作后置定语；lie-lying-lay-lain。' },
          { id:'p1-g03', number:3, sentence:'She is the only one of the students who _____ passed the exam.', options:['has','have','is','are'], answer:'A', knowledge:'the only one of … who 后的定语从句主语是单数 one，谓语用单数。' },
          { id:'p1-g04', number:4, sentence:'By the time he arrives, the meeting _____ already _____.', options:['will … have started','has … started','had … started','is … starting'], answer:'A', knowledge:'by the time + 一般现在时，主句用将来完成时。' },
          { id:'p1-g05', number:5, sentence:'Hardly _____ the room when the phone rang.', options:['had I entered','I had entered','did I entered','I entered'], answer:'A', knowledge:'hardly 置于句首，主句部分倒装；时态用过去完成时。' },
          { id:'p1-g06', number:6, sentence:'It is high time that we _____ action.', options:['took','take','have taken','will take'], answer:'A', knowledge:'It is (high) time that … 从句用一般过去时表示“早该”。' },
          { id:'p1-g07', number:7, sentence:'Not until he failed the exam _____ how important study was.', options:['did he realize','he realized','he had realized','had he realized'], answer:'A', knowledge:'not until 置于句首时，主句部分倒装。' },
          { id:'p1-g08', number:8, sentence:'I wish I _____ harder when I was young.', options:['had studied','studied','would study','have studied'], answer:'A', knowledge:'wish 后接过去完成时表示对过去的遗憾。' },
          { id:'p1-g09', number:9, sentence:'The teacher made us _____ the text twice.', options:['read','reading','to read','reads'], answer:'A', knowledge:'make sb do sth 用不带 to 的不定式。' },
          { id:'p1-g10', number:10, sentence:'_____ from the top of the tower, the city looks magnificent.', options:['Seen','Seeing','To see','See'], answer:'A', knowledge:'过去分词短语作状语，主语 the city 与 see 是被动关系。' },
          { id:'p1-g11', number:11, sentence:'He talked as if he _____ everything.', options:['knew','knows','had known','has known'], answer:'A', knowledge:'as if / as though 表示与现在事实相反，用一般过去时。' },
          { id:'p1-g12', number:12, sentence:'So _____ that nobody could understand him.', options:['fast did he speak','fast he spoke','did he speak fast','he spoke fast'], answer:'A', knowledge:'so … that … 结构中 so 置于句首时主句倒装。' },
          { id:'p1-g13', number:13, sentence:'The professor, along with his students, _____ working on the project.', options:['is','are','were','have been'], answer:'A', knowledge:'主语为 The professor，along with 短语作插入语，谓语用单数。' },
          { id:'p1-g14', number:14, sentence:'I prefer reading _____ watching TV.', options:['to','than','rather than','over'], answer:'A', knowledge:'prefer doing to doing 是固定搭配。' },
          { id:'p1-g15', number:15, sentence:'There is no point _____ further.', options:['in arguing','to argue','argue','argued'], answer:'A', knowledge:'There is no point in doing sth. 是常见句式。' },
          { id:'p1-g16', number:16, sentence:'It was not until midnight _____ he went home.', options:['that','when','which','who'], answer:'A', knowledge:'强调句型 It was not until … that …。' },
          { id:'p1-g17', number:17, sentence:'The house _____ roof was damaged has now been repaired.', options:['whose','that','which','of which'], answer:'A', knowledge:'whose 引导定语从句表示所有关系。' },
          { id:'p1-g18', number:18, sentence:'He must have finished the work, _____?', options:['hasn’t he','didn’t he','mustn’t he','isn’t he'], answer:'A', knowledge:'must have done 的反意疑问句，针对主句主语与现在完成时提问。' },
          { id:'p1-g19', number:19, sentence:'She acts as if she _____ the boss.', options:['were','is','has been','will be'], answer:'A', knowledge:'as if + be 常用 were 表示虚拟语气。' },
          { id:'p1-g20', number:20, sentence:'_____ is known to all, Taiwan is an inseparable part of China.', options:['As','Which','That','It'], answer:'A', knowledge:'as is known to all 为固定非限制性定语从句。' }
        ],
        translation: [
          { id:'p1-t01', number:1, sentence:'Reading aloud every morning helps to improve your pronunciation.', options:['每天早晨大声朗读有助于改善发音。','每天早晨大声朗读有助于发音改善。','每天早上大声朗读有助于提升你的发音能力。','每天早上大声阅读有助于增强你的口语。'], answer:'A', knowledge:'help to do / improve 译为“有助于改善”。' },
          { id:'p1-t02', number:2, sentence:'He gave up his job in order to pursue further education abroad.', options:['为了出国深造，他放弃了工作。','他放弃了工作以便到国外深造。','为追求更高的教育他放弃了工作。','他放弃工作以便进一步出国学习。'], answer:'A', knowledge:'in order to do 可译为“为了…”。' },
          { id:'p1-t03', number:3, sentence:'It is widely acknowledged that exercise contributes to better health.', options:['人们普遍认为锻炼有助于身体健康。','广泛承认锻炼有助于健康。','锻炼有助于健康是被广泛承认的。','众所周知，锻炼可以增进健康。'], answer:'A', knowledge:'It is widely acknowledged that … 译为“人们普遍认为…”。' },
          { id:'p1-t04', number:4, sentence:'Only by working hard can we achieve our goals.', options:['只有努力工作，我们才能实现目标。','只有努力工作我们可以实现目标。','努力工作只能让我们实现目标。','我们只有工作努力，才能完成目标。'], answer:'A', knowledge:'only + 状语置于句首时，主句部分倒装。' },
          { id:'p1-t05', number:5, sentence:'The professor pointed out that the experiment was of great significance.', options:['教授指出该实验具有重要意义。','教授指出该实验意义重大。','该实验非常重要，教授指出。','教授指出实验具有伟大的意义。'], answer:'A', knowledge:'be of great significance 译为“具有重要意义”。' },
          { id:'p1-t06', number:6, sentence:'Thanks to the government’s efforts, the environment has greatly improved.', options:['由于政府的努力，环境大为改善。','感谢政府的努力，环境改善了。','多亏政府，环境已大改。','因为政府的努力，环境被改善。'], answer:'A', knowledge:'thanks to … 译为“多亏 / 由于”。' },
          { id:'p1-t07', number:7, sentence:'She is not only a teacher but also a researcher.', options:['她不仅是教师，也是研究员。','她不只是一位老师还是研究员。','她不但是老师也只是一个研究员。','她既不是老师，也不是研究员。'], answer:'A', knowledge:'not only … but also … 译为“不仅…而且…”。' },
          { id:'p1-t08', number:8, sentence:'The fact that he succeeded inspired all of us.', options:['他成功的事实鼓舞了我们所有人。','事实是他成功了，感动了我们。','他的成功激励了我们所有人。','他成功这件事感动了我们所有人。'], answer:'A', knowledge:'同位语从句 fact that … 译为“…的事实”。' },
          { id:'p1-t09', number:9, sentence:'He is the last person I want to see.', options:['他是我最不想见到的人。','他是最后我想见到的人。','他是我最后想见到的人。','他是最后一人我想见的人。'], answer:'A', knowledge:'the last person to do = 最不可能做某事的人。' },
          { id:'p1-t10', number:10, sentence:'We should take full advantage of every chance to practise English.', options:['我们应该充分利用每一次练习英语的机会。','我们应该完全利用每一个练习英语的机遇。','我们必须利用每个机会练习英语。','我们应充分利用每个机会练习英语。'], answer:'A', knowledge:'take full advantage of 译为“充分利用”。' },
          { id:'p1-t11', number:11, sentence:'It took him three years to write the book.', options:['他花了三年写这本书。','写这本书他花了三年的时间。','他花了三年时间写完此书。','他用了三年去写这本书。'], answer:'A', knowledge:'It takes sb time to do sth 译为“做某事花了某人多长时间”。' },
          { id:'p1-t12', number:12, sentence:'The reason why he was late was that he missed the bus.', options:['他迟到的原因是他错过了公交车。','他迟到的理由是没有赶上公交车。','他迟到的原因是错过了公共汽车。','他之所以迟到是他错过了汽车。'], answer:'A', knowledge:'The reason why … was that … 译为“…的原因是…”。' },
          { id:'p1-t13', number:13, sentence:'I would rather stay at home than go out in such weather.', options:['在这种天气下，我宁愿待在家里也不愿出门。','在这种天气下我宁愿待在家里。','我宁愿在家而不是出去。','我宁愿待在家里，不愿在这样的天气出去。'], answer:'A', knowledge:'would rather do than do 译为“宁愿…也不愿…”。' },
          { id:'p1-t14', number:14, sentence:'The number of students who use computers in learning is increasing.', options:['在计算机辅助学习的学生人数正在增加。','使用计算机学习的学生人数正在增加。','使用电脑学习的学生数量在增加。','学生使用计算机学习的数量正在上升。'], answer:'A', knowledge:'the number of + 复数名词 + 现在分词。' },
          { id:'p1-t15', number:15, sentence:'He was so excited that he could not say a word.', options:['他激动得说不出话来。','他如此激动以至于说不出一句话。','他非常激动，话都说不出来。','他激动得不能说话。'], answer:'A', knowledge:'so … that … 译为“如此…以至于…”。' },
          { id:'p1-t16', number:16, sentence:'The book is well worth reading.', options:['这本书非常值得一读。','这本书很好值得读。','此书读起来值得很好。','这本书值得读好。'], answer:'A', knowledge:'be worth doing 译为“值得做”。' },
          { id:'p1-t17', number:17, sentence:'He made it clear that he was not satisfied with the result.', options:['他明确表示对结果不满意。','他清楚说明对结果不满意。','他做得很清楚他对结果不满。','他说明他并非对结果满意。'], answer:'A', knowledge:'make it clear that … 译为“明确表示”。' },
          { id:'p1-t18', number:18, sentence:'The harder you work, the greater progress you will make.', options:['你工作越努力，取得的进步就越大。','你越努力工作，越多进步。','你越努力工作，更大进步。','你工作更努力，你会取得更大进步。'], answer:'A', knowledge:'the + 比较级 …, the + 比较级 … 译为“越…，越…”。' },
          { id:'p1-t19', number:19, sentence:'A good teacher should be patient with his students.', options:['一位好老师应该对学生有耐心。','好老师对学生应耐心。','好老师应该对学生耐心。','一位好老师对学生应该有耐心。'], answer:'A', knowledge:'be patient with sb 译为“对某人有耐心”。' },
          { id:'p1-t20', number:20, sentence:'It is no use crying over spilt milk.', options:['覆水难收，徒劳无益。','哭洒了的牛奶是没用的。','对洒了的牛奶哭是没用的。','哭已经没有用了牛奶被打翻了。'], answer:'A', knowledge:'It is no use doing 译为“做某事是没用的”，常译为谚语“覆水难收”。' }
        ]
      },
      数学: [
        { id:'p1-m01', number:1, prompt:'下列哪个是基本初等求导公式？', options:[{text:'(x^n)\' = n x^{n-1}', isLatex:true},{text:'(x^n)\' = x^{n+1}'},{text:'(x^n)\' = n x^{n+1}'},{text:'(x^n)\' = n x^n'}], answer:'A', knowledge:'幂函数导数公式：x^n 的导数是 n·x^{n-1}。' },
        { id:'p1-m02', number:2, prompt:'极限 lim(x→0) sin x / x 的值为', options:[{text:'1', isLatex:true},{text:'0'},{text:'∞'},{text:'不存在'}], answer:'A', knowledge:'重要极限：lim(x→0) sin x / x = 1。' },
        { id:'p1-m03', number:3, prompt:'极限 lim(x→∞) (1 + 1/x)^x = ', options:[{text:'e', isLatex:true},{text:'1'},{text:'∞'},{text:'0'}], answer:'A', knowledge:'重要极限：lim(1+1/x)^x = e。' },
        { id:'p1-m04', number:4, prompt:'由 y = x^2 与 x = 1 及 x 轴围成区域绕 x 轴旋转，所得旋转体体积为', options:[{text:'π/5', isLatex:true},{text:'π/3'},{text:'π/2'},{text:'π'}], answer:'A', knowledge:'V = π∫_0^1 x^4 dx = π/5。' },
        { id:'p1-m05', number:5, prompt:'定积分 ∫_0^1 2x dx 的值为', options:[{text:'1', isLatex:true},{text:'2'},{text:'0'},{text:'1/2'}], answer:'A', knowledge:'∫_0^1 2x dx = x^2|_0^1 = 1。' },
        { id:'p1-m06', number:6, prompt:'不定积分 ∫ cos x dx = ', options:[{text:'sin x + C', isLatex:true},{text:'-sin x + C'},{text:'cos x + C'},{text:'-cos x + C'}], answer:'A', knowledge:'cos x 的原函数是 sin x。' },
        { id:'p1-m07', number:7, prompt:'函数 f(x)=x^3 的导数为', options:[{text:'3x^2', isLatex:true},{text:'x^2'},{text:'3x'},{text:'x^4/4'}], answer:'A', knowledge:'幂函数求导：f(x)=x^n → f\'(x)=n x^{n-1}。' },
        { id:'p1-m08', number:8, prompt:'极限 lim(x→0) (1 - cos x)/x^2 的值为', options:[{text:'1/2', isLatex:true},{text:'1'},{text:'0'},{text:'2'}], answer:'A', knowledge:'等价无穷小：1-cos x ~ x^2/2。' }
      ]
    }
  },
  {
    id: 'entry-paper-2',
    title: '入学自测二',
    level: '基础进阶',
    summary: '在第一套基础上增加难度，覆盖更多政治辨析、英语综合语法与中阶数学计算。',
    passThreshold: 60,
    shareSlug: 'entry2',
    sections: {
      政治: [
        { id:'p2-q01', number:1, prompt:'唯物辩证法的两大总特征是', options:['联系和发展','实践和认识','对立和统一','量变和质变'], answer:'A', knowledge:'联系和发展是唯物辩证法的总特征。' },
        { id:'p2-q02', number:2, prompt:'“人民群众是历史的创造者”这一观点属于', options:['历史唯物主义','历史唯心主义','形而上学','宿命论'], answer:'A', knowledge:'历史唯物主义强调人民群众的决定作用。' },
        { id:'p2-q03', number:3, prompt:'中国革命取得胜利的三大法宝是', options:['统一战线、武装斗争、党的建设','实事求是、群众路线、独立自主','理论联系实际、批评与自我批评、艰苦奋斗','政治、经济、文化'], answer:'A', knowledge:'三大法宝为统一战线、武装斗争、党的建设。' },
        { id:'p2-q04', number:4, prompt:'社会主义核心价值观中，国家层面的价值要求是', options:['富强、民主、文明、和谐','自由、平等、公正、法治','爱国、敬业、诚信、友善','团结、奋进、务实、创新'], answer:'A', knowledge:'国家层面：富强、民主、文明、和谐。' },
        { id:'p2-q05', number:5, prompt:'“一国两制”的前提是', options:['一个中国','港人治港','高度自治','长期繁荣'], answer:'A', knowledge:'坚持一个中国是“一国两制”的前提。' },
        { id:'p2-q06', number:6, prompt:'马克思主义的理论品质是', options:['与时俱进','实事求是','群众路线','独立自主'], answer:'A', knowledge:'与时俱进是马克思主义最重要的理论品质。' },
        { id:'p2-q07', number:7, prompt:'认识的本质是', options:['主体对客体的能动反映','主体对客体的直观反映','主体对客体的被动接受','主体对客体的简单摹写'], answer:'A', knowledge:'辩证唯物主义认识论认为认识是主体对客体的能动反映。' },
        { id:'p2-q08', number:8, prompt:'“实事求是”中的“是”指', options:['客观规律','客观事物','正确判断','科学理论'], answer:'A', knowledge:'“是”即客观事物的内部规律。' },
        { id:'p2-q09', number:9, prompt:'社会主义道德建设的核心是', options:['为人民服务','集体主义','爱国主义','诚实守信'], answer:'A', knowledge:'为人民服务是社会主义道德建设的核心。' },
        { id:'p2-q10', number:10, prompt:'党的最大政治优势是', options:['密切联系群众','理论联系实际','批评与自我批评','统一战线'], answer:'A', knowledge:'密切联系群众是党的最大政治优势。' }
      ],
      英语: {
        vocabulary: [
          { id:'p2-v01', number:1, word:'abundant', options:['丰富的；充裕的','废弃的','抽象的','绝对的'], answer:'A', knowledge:'abundant = 大量的；同 plentiful。' },
          { id:'p2-v02', number:2, word:'postpone', options:['推迟；延期','假定','投递','处置'], answer:'A', knowledge:'postpone = 延迟；前缀 post-（后）+ pon（放置）。' },
          { id:'p2-v03', number:3, word:'rigorous', options:['严格的；严密的','宽容的','辉煌的','聪明的'], answer:'A', knowledge:'rigorous = 严格的；词根 rig = 严格。' },
          { id:'p2-v04', number:4, word:'compensate', options:['补偿','完成','竞争','联系'], answer:'A', knowledge:'compensate = 弥补；与 compete（竞争）拼写相近。' },
          { id:'p2-v05', number:5, word:'contemplate', options:['沉思；考虑','完成','争论','结合'], answer:'A', knowledge:'contemplate = 仔细考虑；templ = 庙宇，引申“凝视”。' },
          { id:'p2-v06', number:6, word:'hinder', options:['阻碍','隐藏','暗示','雇用'], answer:'A', knowledge:'hinder = 妨碍；与 behind 形近。' },
          { id:'p2-v07', number:7, word:'prevalent', options:['流行的；普遍的','之前的','珍贵的','私人的'], answer:'A', knowledge:'prevalent = 普遍的；pre-（前）+ val（力量）。' },
          { id:'p2-v08', number:8, word:'inevitably', options:['不可避免地','经常地','故意地','独立地'], answer:'A', knowledge:'inevitably 副词形式意为“不可避免地”。' },
          { id:'p2-v09', number:9, word:'preserve', options:['保护；保存','提出','期待','禁止'], answer:'A', knowledge:'preserve = 保护；pre- + serve（保存）。' },
          { id:'p2-v10', number:10, word:'obsolete', options:['过时的；废弃的','显著的','固执的','恭敬的'], answer:'A', knowledge:'obsolete = 已废弃的；词根 ol = 成长，过去的事物。' }
        ],
        grammar: [
          { id:'p2-g01', number:1, sentence:'I remember _____ the book to him last week.', options:['giving','to give','given','give'], answer:'A', knowledge:'remember doing 表示记得做过某事。' },
          { id:'p2-g02', number:2, sentence:'Neither he nor I _____ to blame.', options:['am','is','are','were'], answer:'A', knowledge:'neither … nor … 连接主语时，谓语与最近的主语一致。' },
          { id:'p2-g03', number:3, sentence:'The teacher told us that light _____ faster than sound.', options:['travels','traveled','is traveling','has traveled'], answer:'A', knowledge:'客观真理用一般现在时。' },
          { id:'p2-g04', number:4, sentence:'It is high time that the meeting _____ closed.', options:['were','is','be','will be'], answer:'A', knowledge:'It is (high) time 从句用一般过去时。' },
          { id:'p2-g05', number:5, sentence:'I have no idea _____ he will come back.', options:['when','which','that','what'], answer:'A', knowledge:'idea 后接同位语从句，从句不缺成分时用 that，缺时间用 when。' },
          { id:'p2-g06', number:6, sentence:'She would have gone with him, but she _____ time.', options:['didn’t have','hadn’t had','would have','hasn’t had'], answer:'A', knowledge:'与过去事实相反的并列句，前项虚拟后项真实。' },
          { id:'p2-g07', number:7, sentence:'_____ from the hill, the village looks beautiful.', options:['Seen','Seeing','To see','See'], answer:'A', knowledge:'the village 与 see 是被动关系，用过去分词。' },
          { id:'p2-g08', number:8, sentence:'He is the only one of those boys who _____ willing to help.', options:['is','are','has','have'], answer:'A', knowledge:'the only one … who 定语从句主语是单数 one。' },
          { id:'p2-g09', number:9, sentence:'No sooner _____ home than it began to rain.', options:['had I arrived','I had arrived','did I arrive','I arrived'], answer:'A', knowledge:'no sooner 置于句首，主句部分倒装；过去完成时。' },
          { id:'p2-g10', number:10, sentence:'It is required that every student _____ a report.', options:['write','writes','wrote','to write'], answer:'A', knowledge:'require that … should + 动词原形，should 可省。' },
          { id:'p2-g11', number:11, sentence:'By next summer, he _____ here for five years.', options:['will have lived','has lived','will live','lived'], answer:'A', knowledge:'by + 将来时间，主句用将来完成时。' },
          { id:'p2-g12', number:12, sentence:'The teacher suggested that the students _____ the novel.', options:['read','reads','reading','to read'], answer:'A', knowledge:'suggest / insist 等动词后的 that 从句用虚拟语气 should + 动词原形。' },
          { id:'p2-g13', number:13, sentence:'He has a habit of _____ in bed.', options:['reading','read','reads','to read'], answer:'A', knowledge:'介词 of 后接动名词。' },
          { id:'p2-g14', number:14, sentence:'_____ is worth doing is worth doing well.', options:['Whatever','Which','That','What'], answer:'A', knowledge:'whatever = 任何 … 的事物，引导主语从句。' },
          { id:'p2-g15', number:15, sentence:'It was at the school _____ he studied for six years.', options:['where','which','that','who'], answer:'A', knowledge:'定语从句中 he studied 表示地点，需用 where。' },
          { id:'p2-g16', number:16, sentence:'He looked as if he _____ a ghost.', options:['had seen','saw','has seen','sees'], answer:'A', knowledge:'as if 接过去完成时表示与过去事实相反。' },
          { id:'p2-g17', number:17, sentence:'She is too young _____ the heavy box.', options:['to carry','carrying','carry','carried'], answer:'A', knowledge:'too … to do 译为“太 … 而不能 …”。' },
          { id:'p2-g18', number:18, sentence:'If I had known the news, I _____ you at once.', options:['would have told','will tell','would tell','had told'], answer:'A', knowledge:'与过去事实相反的虚拟语气：主句 would have done。' },
          { id:'p2-g19', number:19, sentence:'He is said _____ abroad for five years.', options:['to have studied','to study','studying','studied'], answer:'A', knowledge:'be said to have done 表示“据说过去做了某事”。' },
          { id:'p2-g20', number:20, sentence:'The report _____ by Professor Li is well written.', options:['written','writing','to write','writes'], answer:'A', knowledge:'过去分词作后置定语，与被修饰词是被动关系。' }
        ],
        translation: [
          { id:'p2-t01', number:1, sentence:'He never ceases to amaze me with his endless creativity.', options:['他无穷的创造力总是让我惊叹不已。','他从不停下用他的创造力使我惊讶。','他不停地用无尽的创造力让我惊讶。','他从不停止以无尽的创造力令我惊奇。'], answer:'A', knowledge:'cease to do / amaze sb with … 的译法。' },
          { id:'p2-t02', number:2, sentence:'It’s no easy job to master a foreign language in a short time.', options:['在短时间内掌握一门外语并非易事。','短时间内精通一门外语并不容易。','掌握一门外语在短时间内并非简单的工作。','要短时间掌握一门外语没有容易的工作。'], answer:'A', knowledge:'It is no easy job to do sth 译为“…并非易事”。' },
          { id:'p2-t03', number:3, sentence:'The more you practise, the greater your progress will be.', options:['你练习得越多，进步就越大。','你越练习，更大你的进步将是。','练习越多，进步越大。','越多练习，更大你的进步。'], answer:'A', knowledge:'the more …, the more … 句型。' },
          { id:'p2-t04', number:4, sentence:'He made it a rule to read aloud for half an hour every morning.', options:['他坚持每天早晨朗读半小时。','他定了规则每早读半小时书。','他把每天早晨朗读半小时作为规则。','他制定每天早读半小时的规则。'], answer:'A', knowledge:'make it a rule to do 译为“坚持 / 规定”。' },
          { id:'p2-t05', number:5, sentence:'With the rapid development of economy, our life has changed a lot.', options:['随着经济的快速发展，我们的生活发生了很大变化。','随着经济快速发展，我们的生活改变很多。','经济快速发展，我们的生活有很多变化。','在经济发展中，我们生活有很大改变。'], answer:'A', knowledge:'with … 译为“随着 …”，完成时强调对现在的影响。' },
          { id:'p2-t06', number:6, sentence:'It is suggested that everyone have at least one hour of exercise a day.', options:['有人建议每人每天至少锻炼一小时。','它被建议每人每天至少有一小时锻炼。','建议每人每天至少运动一小时。','建议是每人每天至少一小时运动。'], answer:'A', knowledge:'It is suggested that …（虚拟语气）+ should + 动词原形。' },
          { id:'p2-t07', number:7, sentence:'Only when the war was over did he return to his hometown.', options:['只有战争结束后他才回到家乡。','只有当战争结束，他才回到家乡。','只有战争结束时他回到了家乡。','战争结束之后他才能回到家乡。'], answer:'A', knowledge:'only + 状语置于句首，主句部分倒装。' },
          { id:'p2-t08', number:8, sentence:'His proposal deserves careful consideration.', options:['他的提议值得仔细考虑。','他的建议应得仔细考虑。','他提议值得慎重考虑。','他提议值得仔细的考虑。'], answer:'A', knowledge:'deserve + 名词或动名词主动形式表示被动。' },
          { id:'p2-t09', number:9, sentence:'She was too excited to say a word when she heard the good news.', options:['她听到这个好消息时激动得说不出话来。','她太激动而说了一句。','她太兴奋只能说一句话。','当她听到好消息时激动得不能说一句话。'], answer:'A', knowledge:'too … to … 译为“太 … 而不能 …”。' },
          { id:'p2-t10', number:10, sentence:'Whether we can succeed depends on how hard we work.', options:['我们能否成功取决于我们努力的程度。','是否我们能成功依靠我们怎样努力工作。','我们是否能成功取决于我们如何努力工作。','我们能否成功取决于我们的工作努力。'], answer:'A', knowledge:'whether … depends on how … 译为“…取决于…”。' },
          { id:'p2-t11', number:11, sentence:'I can hardly believe what you have just said.', options:['我几乎无法相信你刚才说的话。','我几乎不相信你刚说。','我难以相信你刚说的。','我几乎不能相信你所说的话。'], answer:'A', knowledge:'can hardly believe 译为“几乎无法相信”。' },
          { id:'p2-t12', number:12, sentence:'He has a good command of English after years of self-study.', options:['经过多年自学，他精通英语。','经过几年的自学，他对英语有很好的掌握。','他几年自学后掌握了英语。','他通过自学对英语有很好的控制。'], answer:'A', knowledge:'have a good command of 译为“精通”。' },
          { id:'p2-t13', number:13, sentence:'Not only did he pass the exam, but also he got the highest score.', options:['他不仅通过了考试，还得了最高分。','不仅他通过考试，他也得了最高分。','他没有通过考试，但他得了最高分。','他考试不仅得了高分，而且通过。'], answer:'A', knowledge:'not only … but also … 倒装结构。' },
          { id:'p2-t14', number:14, sentence:'You had better consult a doctor before taking the medicine.', options:['你最好在服药前咨询医生。','你最好在吃药前咨询医生。','你得在吃药之前咨询医师。','你吃药前最好找医生。'], answer:'A', knowledge:'had better do 译为“最好做某事”。' },
          { id:'p2-t15', number:15, sentence:'It is obvious that he has made great progress in his study.', options:['很明显他在学习上取得了很大进步。','明显他学习取得很大进步。','他明显在学习上取得很大进步。','显然他在学业上取得显著进步。'], answer:'A', knowledge:'It is obvious that … 译为“很明显 …”。' },
          { id:'p2-t16', number:16, sentence:'There is no denying that hard work leads to success.', options:['不可否认，努力工作带来成功。','没有否认，努力导致成功。','不能否认努力工作是通向成功。','不能否认艰苦工作导致了成功。'], answer:'A', knowledge:'There is no denying that … 译为“不可否认”。' },
          { id:'p2-t17', number:17, sentence:'He is determined to go abroad for further education.', options:['他决心出国深造。','他决定去国外进一步学习。','他下决心去国外学习。','他决意出国学习更高。'], answer:'A', knowledge:'be determined to do 译为“决心做某事”。' },
          { id:'p2-t18', number:18, sentence:'Without your help, we couldn’t have finished the task on time.', options:['没有你的帮助，我们不可能按时完成任务。','没有你的帮助我们不能按时完成任务。','如果没有你的帮忙，我们无法按时完成任务。','你的帮助没有，我们不可能按时完成任务。'], answer:'A', knowledge:'without …, couldn’t have done 表示与过去事实相反的虚拟。' },
          { id:'p2-t19', number:19, sentence:'The report is supposed to be submitted before Friday.', options:['这份报告应在星期五前提交。','报告应该在周五前提交。','该报告被认为应在周五前提交。','该报告要在周五之前被假设提交。'], answer:'A', knowledge:'be supposed to do 译为“应该做某事”。' },
          { id:'p2-t20', number:20, sentence:'He took it for granted that his parents would support him.', options:['他理所当然地认为父母会支持他。','他认为父母会支持他是当然的。','他把它当作当然，他的父母会支持。','他认为是理所应当，父母会支持。'], answer:'A', knowledge:'take it for granted that … 译为“理所当然认为”。' }
        ]
      },
      数学: [
        { id:'p2-m01', number:1, prompt:'设 f(x) = x sin x，则 f\'(0) 等于', options:[{text:'0', isLatex:true},{text:'1'},{text:'不存在'},{text:'sin 0'}], answer:'A', knowledge:'f\'(x) = sin x + x cos x，f\'(0) = 0。' },
        { id:'p2-m02', number:2, prompt:'极限 lim(x→0) (tan x)/x = ', options:[{text:'1', isLatex:true},{text:'0'},{text:'∞'},{text:'1/2'}], answer:'A', knowledge:'重要极限：tan x 与 x 等价，lim tan x / x = 1。' },
        { id:'p2-m03', number:3, prompt:'极限 lim(n→∞) (1 + 2/n)^n = ', options:[{text:'e^2', isLatex:true},{text:'e'},{text:'2'},{text:'∞'}], answer:'A', knowledge:'lim(1+a/n)^n = e^a，此处 a=2。' },
        { id:'p2-m04', number:4, prompt:'区域 0≤y≤1−x^2 绕 y 轴旋转一周所得旋转体体积为', options:[{text:'π/2', isLatex:true},{text:'π'},{text:'2π'},{text:'π/4'}], answer:'A', knowledge:'用柱壳法：V = 2π∫_0^1 x(1-x^2) dx = π/2。' },
        { id:'p2-m05', number:5, prompt:'定积分 ∫_0^1 (3x^2 + 1) dx = ', options:[{text:'2', isLatex:true},{text:'1'},{text:'3'},{text:'1/3'}], answer:'A', knowledge:'∫_0^1 (3x^2+1) dx = x^3 + x |_0^1 = 2。' },
        { id:'p2-m06', number:6, prompt:'不定积分 ∫ e^x dx = ', options:[{text:'e^x + C', isLatex:true},{text:'xe^x + C'},{text:'e^x/x + C'},{text:'ln x + C'}], answer:'A', knowledge:'指数函数的原函数仍是 e^x。' },
        { id:'p2-m07', number:7, prompt:'由曲线 y = ln x 与 x = e、x 轴围成的面积是', options:[{text:'1', isLatex:true},{text:'e'},{text:'1/e'},{text:'2'}], answer:'A', knowledge:'∫_1^e ln x dx = [x ln x - x]_1^e = 1。' },
        { id:'p2-m08', number:8, prompt:'极限 lim(x→∞) (1 + 1/x)^{3x} = ', options:[{text:'e^3', isLatex:true},{text:'e'},{text:'3'},{text:'∞'}], answer:'A', knowledge:'lim(1+1/x)^{nx} = e^n。' },
        { id:'p2-m09', number:9, prompt:'定积分 ∫_0^π sin x dx = ', options:[{text:'2', isLatex:true},{text:'0'},{text:'1'},{text:'π'}], answer:'A', knowledge:'∫_0^π sin x dx = [-cos x]_0^π = 2。' },
        { id:'p2-m10', number:10, prompt:'曲线 y = x^2 绕 y 轴旋转所得旋转体（0≤y≤1）的体积为', options:[{text:'π/2', isLatex:true},{text:'π'},{text:'2π'},{text:'π/3'}], answer:'A', knowledge:'由 y=x^2 得 x=√y，V = π∫_0^1 y dy = π/2。' }
      ]
    }
  },
  {
    id: 'entry-paper-3',
    title: '入学自测三',
    level: '基础综合',
    summary: '覆盖政治辨析、英语综合应用与中阶数学概念，检验学员整体知识广度。',
    passThreshold: 65,
    shareSlug: 'entry3',
    sections: {
      政治: [
        { id:'p3-q01', number:1, prompt:'“具体问题具体分析”的哲学依据是', options:['矛盾的特殊性','矛盾的普遍性','矛盾的同一性','斗争性'], answer:'A', knowledge:'矛盾的特殊性原理要求具体问题具体分析。' },
        { id:'p3-q02', number:2, prompt:'我国现阶段的基本经济制度是', options:['公有制为主体、多种所有制经济共同发展','计划经济为主、市场调节为辅','私有制为主体','完全市场经济'], answer:'A', knowledge:'社会主义初级阶段的基本经济制度。' },
        { id:'p3-q03', number:3, prompt:'“三个代表”重要思想中，中国共产党始终代表', options:['中国先进生产力的发展要求、先进文化的前进方向、最广大人民的根本利益','工人阶级的根本利益','知识分子群体','农民阶级'], answer:'A', knowledge:'“三个代表”的具体内容。' },
        { id:'p3-q04', number:4, prompt:'科学发展观的第一要义是', options:['发展','以人为本','全面协调可持续','统筹兼顾'], answer:'A', knowledge:'发展是科学发展观的第一要义。' },
        { id:'p3-q05', number:5, prompt:'习近平新时代中国特色社会主义思想的核心要义是', options:['坚持和发展中国特色社会主义','以人民为中心','全面深化改革','全面依法治国'], answer:'A', knowledge:'坚持和发展中国特色社会主义是核心要义。' },
        { id:'p3-q06', number:6, prompt:'社会主义核心价值观中，社会层面的价值要求是', options:['自由、平等、公正、法治','富强、民主、文明、和谐','爱国、敬业、诚信、友善','和平、发展、合作、共赢'], answer:'A', knowledge:'社会层面：自由、平等、公正、法治。' },
        { id:'p3-q07', number:7, prompt:'“实践是检验真理的唯一标准”体现的哲学原理是', options:['实践与认识的辩证统一','认识的无限性','感性认识与理性认识的统一','真理的客观性'], answer:'A', knowledge:'实践与认识的辩证关系原理。' },
        { id:'p3-q08', number:8, prompt:'“一带一路”是指', options:['丝绸之路经济带和21世纪海上丝绸之路','沿边开放与沿海开放','西部大开发与东北振兴','中国与东盟自由贸易区'], answer:'A', knowledge:'“一带一路”是丝绸之路经济带和21世纪海上丝绸之路的简称。' },
        { id:'p3-q09', number:9, prompt:'构建人类命运共同体的核心是', options:['合作共赢','单边主义','零和博弈','文化对抗'], answer:'A', knowledge:'合作共赢是人类命运共同体的核心。' },
        { id:'p3-q10', number:10, prompt:'党的二十大主题强调', options:['全面建成社会主义现代化强国','坚持四项基本原则','坚持改革开放','坚持以经济建设为中心'], answer:'A', knowledge:'新时代新征程的中心任务是全面建成社会主义现代化强国。' }
      ],
      英语: {
        vocabulary: [
          { id:'p3-v01', number:1, word:'contemplate', options:['凝视；深思','抱怨','比较','结合'], answer:'A', knowledge:'contemplate = 仔细考虑、凝视。' },
          { id:'p3-v02', number:2, word:'depict', options:['描绘；描述','使下沉','贬值','使倾斜'], answer:'A', knowledge:'depict = 描绘；同义词 portray。' },
          { id:'p3-v03', number:3, word:'profound', options:['深刻的；意义深远的','流行的','繁荣的','表面的'], answer:'A', knowledge:'profound = 深刻的；与 shallow（浅的）相反。' },
          { id:'p3-v04', number:4, word:'feasible', options:['可行的；可能的','可食用的','可燃的','可读的'], answer:'A', knowledge:'feasible = 可行的；同义词 practicable。' },
          { id:'p3-v05', number:5, word:'vague', options:['模糊的；不明确的','生动的','严峻的','明显的'], answer:'A', knowledge:'vague = 含糊的；同义词 ambiguous。' },
          { id:'p3-v06', number:6, word:'deteriorate', options:['恶化；变坏','改进','区分','宣布'], answer:'A', knowledge:'deteriorate = 恶化；同义词 worsen。' },
          { id:'p3-v07', number:7, word:'notion', options:['观念；概念','通知','注意','小说'], answer:'A', knowledge:'notion = 概念、想法；与 notice（通知）形近。' },
          { id:'p3-v08', number:8, word:'deliberate', options:['故意的；深思熟虑的','坦诚的','严肃的','轻率的'], answer:'A', knowledge:'deliberate = 故意的；同义词 intentional。' },
          { id:'p3-v09', number:9, word:'notwithstanding', options:['尽管','因此','因为','然而'], answer:'A', knowledge:'notwithstanding = 尽管；同义词 despite。' },
          { id:'p3-v10', number:10, word:'dwindle', options:['逐渐减少','繁荣','争吵','冒险'], answer:'A', knowledge:'dwindle = 逐渐变小；同义词 decrease。' }
        ],
        grammar: [
          { id:'p3-g01', number:1, sentence:'Were I you, I would take the job.', options:['If I were you','If I am you','If I be you','If I was you'], answer:'A', knowledge:'Were I you = If I were you，虚拟语气倒装。' },
          { id:'p3-g02', number:2, sentence:'He behaved as though nothing _____ happened.', options:['had','has','have','having'], answer:'A', knowledge:'as though 后接过去完成时表示与过去事实相反。' },
          { id:'p3-g03', number:3, sentence:'The new bridge, which was completed last year, _____ the traffic problem.', options:['has solved','solved','solves','solving'], answer:'A', knowledge:'主句谓语与现在完成时配合，强调对现在的影响。' },
          { id:'p3-g04', number:4, sentence:'_____ from space, the earth looks like a blue ball.', options:['Seen','Seeing','To see','See'], answer:'A', knowledge:'过去分词短语作状语，the earth 与 see 是被动关系。' },
          { id:'p3-g05', number:5, sentence:'It is necessary that each student _____ a project.', options:['complete','completes','completed','completing'], answer:'A', knowledge:'necessary 后 that 从句用 should + 动词原形。' },
          { id:'p3-g06', number:6, sentence:'The professor gave a lecture on _____ we call “the future of AI”.', options:['what','that','which','whether'], answer:'A', knowledge:'介词 on 后接 what 引导的宾语从句。' },
          { id:'p3-g07', number:7, sentence:'I have no idea _____ he managed to escape.', options:['how','what','why','which'], answer:'A', knowledge:'idea 后同位语从句，how 表示方式。' },
          { id:'p3-g08', number:8, sentence:'Hardly _____ spoken when the argument began.', options:['had I','I had','did I','I did'], answer:'A', knowledge:'hardly … when … 结构，主句用过去完成时倒装。' },
          { id:'p3-g09', number:9, sentence:'He insisted that the work _____ at once.', options:['be done','is done','was done','must be done'], answer:'A', knowledge:'insist 后 that 从句用 should + 动词原形，should 可省。' },
          { id:'p3-g10', number:10, sentence:'By the end of last term, we _____ five English novels.', options:['had read','have read','read','have been reading'], answer:'A', knowledge:'by the end of + 过去时间，主句用过去完成时。' },
          { id:'p3-g11', number:11, sentence:'It’s time that we _____ lunch.', options:['had','have','will have','are having'], answer:'A', knowledge:'It is (high) time that … 从句用一般过去时。' },
          { id:'p3-g12', number:12, sentence:'She is the only one of those girls who _____ English well.', options:['speaks','speak','speaking','is speaking'], answer:'A', knowledge:'the only one … who 定语从句主语 one 单数。' },
          { id:'p3-g13', number:13, sentence:'Not until he took off his sunglasses _____ him.', options:['did I recognize','I recognized','I had recognized','had I recognized'], answer:'A', knowledge:'not until 置于句首，主句部分倒装。' },
          { id:'p3-g14', number:14, sentence:'I would appreciate it if you _____ me in advance.', options:['could tell','can tell','told','will tell'], answer:'A', knowledge:'appreciate it if … 从句用一般过去时或 could + 动词原形。' },
          { id:'p3-g15', number:15, sentence:'The building _____ now is the new library.', options:['being built','built','to build','build'], answer:'A', knowledge:'现在分词被动式作定语，表示动作正在进行。' },
          { id:'p3-g16', number:16, sentence:'It seems that he _____ the truth.', options:['has known','knows','knew','had known'], answer:'A', knowledge:'It seems that … 时态与从句内动作一致，用现在完成时。' },
          { id:'p3-g17', number:17, sentence:'Only by doing so _____ the problem.', options:['can you solve','you can solve','you could solve','do you solve'], answer:'A', knowledge:'only + 状语倒装，can 提前。' },
          { id:'p3-g18', number:18, sentence:'It is no good _____ over spilt milk.', options:['crying','to cry','cry','cried'], answer:'A', knowledge:'It is no good doing 译为“…是没有用的”。' },
          { id:'p3-g19', number:19, sentence:'He is the second tallest boy _____ in our class.', options:['that has ever been','who has ever been','that have ever been','which has been'], answer:'A', knowledge:'the second + 最高级后定语从句用 that has/have ever …。' },
          { id:'p3-g20', number:20, sentence:'If I had taken your advice, I _____ better now.', options:['would be feeling','would have felt','felt','had felt'], answer:'A', knowledge:'混合虚拟：过去条件 + 现在结果，主句用 would + 动词原形或进行时。' }
        ],
        translation: [
          { id:'p3-t01', number:1, sentence:'It is universally acknowledged that practice makes perfect.', options:['众所周知，熟能生巧。','普遍地承认熟能生巧。','大家都知道练习造就完美。','它被普遍承认练习造就完美。'], answer:'A', knowledge:'It is universally acknowledged that … = 众所周知。' },
          { id:'p3-t02', number:2, sentence:'He made a point of arriving at the office before everyone else.', options:['他特意每天比别人早到办公室。','他做出了比别人早到的姿态。','他重点在别人之前到办公室。','他强调要比同事先到办公室。'], answer:'A', knowledge:'make a point of doing 译为“特意 / 特别注意做某事”。' },
          { id:'p3-t03', number:3, sentence:'Not until he failed the exam did he realize the importance of study.', options:['直到考试不及格他才意识到学习的重要性。','他没有意识到考试失败时学习的重要性。','不直到考试失败他才意识到学习的重要。','他没意识到考试失败时学习很重要。'], answer:'A', knowledge:'not until … 倒装句。' },
          { id:'p3-t04', number:4, sentence:'With the rapid development of AI, our life has changed greatly.', options:['随着人工智能的迅速发展，我们的生活发生了很大变化。','在人工智能快速发展中我们的生活改变很大。','人工智能快速发展我们的生活在变化。','人工智能发展快我们的生活改变大。'], answer:'A', knowledge:'with … 译为“随着 …”。' },
          { id:'p3-t05', number:5, sentence:'It’s no exaggeration to say that he is the best student in our class.', options:['毫不夸张地说，他是班里最优秀的学生。','说不夸张，他是班里最好的学生。','没有夸张地说他是班里最好的学生。','说他是班里最好的学生并不夸张。'], answer:'A', knowledge:'It is no exaggeration to do 译为“毫不夸张地说”。' },
          { id:'p3-t06', number:6, sentence:'He would rather stay at home than go out in such weather.', options:['在这种天气里，他宁愿待在家里也不愿出门。','他宁愿待在家里，而不是出去这种天气。','在这种天气他宁愿待在家里而不是外出。','他宁愿待在家里比起外出在这种天气。'], answer:'A', knowledge:'would rather do than do 译为“宁愿 … 也不愿 …”。' },
          { id:'p3-t07', number:7, sentence:'Whatever difficulties we may face, we will not give up.', options:['无论我们遇到什么困难，我们都不会放弃。','无论困难怎样，我们不放弃。','无论什么困难我们也许面对，我们将不放弃。','不管困难怎样，我们永不放弃。'], answer:'A', knowledge:'whatever 引导让步状语从句。' },
          { id:'p3-t08', number:8, sentence:'It’s well known that the earth moves around the sun.', options:['众所周知，地球围绕太阳转。','它被众所周知地球绕太阳转。','很好地知道地球围绕太阳转。','地球围绕太阳转是众所周知的。'], answer:'A', knowledge:'It is well known that … = 众所周知。' },
          { id:'p3-t09', number:9, sentence:'He took it for granted that his friends would help him.', options:['他理所当然地认为朋友们会帮助他。','他把朋友的帮助视为理所当然。','他把它当成朋友帮助他的当然。','他理所应当地认为朋友会帮助他。'], answer:'A', knowledge:'take it for granted that … 译为“理所当然地认为”。' },
          { id:'p3-t10', number:10, sentence:'It is high time that we took effective measures to protect the environment.', options:['现在是我们采取有效措施保护环境的时候了。','这是我们应该采取有效措施保护环境的高时间。','这是高时间我们采取有效措施保护环境。','这是高时间我们采取环境保护的有效措施。'], answer:'A', knowledge:'It is (high) time that … 从句用一般过去时。' },
          { id:'p3-t11', number:11, sentence:'The harder you work at English, the greater progress you will make.', options:['你在英语上越努力，取得的进步就越大。','你越努力学英语，越大进步你将取得。','越努力学英语，越大进步。','努力学英语的越多，进步越大。'], answer:'A', knowledge:'the + 比较级 …, the + 比较级 … 译为“越…，越…”。' },
          { id:'p3-t12', number:12, sentence:'There is no denying that he has made a great contribution to the project.', options:['不可否认，他为这个项目做出了巨大贡献。','没有否认他已对这个项目做出贡献。','不否认他做出了项目贡献。','他做出了巨大贡献是不可否认的。'], answer:'A', knowledge:'There is no denying that … 译为“不可否认”。' },
          { id:'p3-t13', number:13, sentence:'He suggested that we should set out early the next morning.', options:['他建议我们第二天清早出发。','他建议我们应该在第二天早起出发。','他表明我们清早出发。','他提出我们应在第二天清早出发。'], answer:'A', knowledge:'suggest that … should do 译为“建议 …”。' },
          { id:'p3-t14', number:14, sentence:'It is said that he has gone abroad for further study.', options:['据说他已经出国深造了。','它被说他已出国深造。','人们说他已出国深造。','据说，他出国留学更多。'], answer:'A', knowledge:'It is said that … 译为“据说”。' },
          { id:'p3-t15', number:15, sentence:'He didn’t attend the meeting until he was told to.', options:['直到被要求时他才出席会议。','他没有出席会议直到被告知。','他没参加直到被告知会议。','他不出席会议直到被要求。'], answer:'A', knowledge:'not … until … 译为“直到 … 才 …”。' },
          { id:'p3-t16', number:16, sentence:'It is not until he failed that he knew how important study was.', options:['直到失败他才知道学习有多重要。','直到他失败，才知道学习多么重要。','直到失败他知道了学习的重要性。','他直到失败才知道学习重要。'], answer:'A', knowledge:'It is not until … that … 强调句型。' },
          { id:'p3-t17', number:17, sentence:'He made a point of arriving at the office before everyone else.', options:['他特别在意比所有同事早到办公室。','他强调每天比其他同事先到办公室。','他特意比其他同事早到办公室。','他做出比其他同事早到的要点。'], answer:'A', knowledge:'make a point of doing 译为“特别注意做某事”。' },
          { id:'p3-t18', number:18, sentence:'It is reported that the meeting has been put off until next Friday.', options:['据报道，会议已被推迟到下周五。','它被报道会议推迟到下周五。','据报道，会议已经推迟到下周五。','会议被报道推迟到下星期五。'], answer:'A', knowledge:'It is reported that … 译为“据报道”。' },
          { id:'p3-t19', number:19, sentence:'He is not so much a writer as a teacher.', options:['与其说他是一位作家，不如说他是一位老师。','他不是一位作家，而是老师。','他如此多是一位作家作为老师。','他不仅作家还老师。'], answer:'A', knowledge:'not so much A as B 译为“与其说是 A，不如说是 B”。' },
          { id:'p3-t20', number:20, sentence:'Were I in your position, I would accept the offer.', options:['如果我处在你的位置，我会接受这份工作。','我处在你的位置，我将接受这份工作。','如果我在你的位置，我会接受这提议。','我处于你的位置时我会接受。'], answer:'A', knowledge:'Were I in your position = If I were in your position。' }
        ]
      },
      数学: [
        { id:'p3-m01', number:1, prompt:'设 f(x) = e^x · sin x，则 f\'(0) 等于', options:[{text:'1', isLatex:true},{text:'0'},{text:'e'},{text:'e+1'}], answer:'A', knowledge:'f\'(x) = e^x sin x + e^x cos x，f\'(0) = 1。' },
        { id:'p3-m02', number:2, prompt:'极限 lim(x→0) (e^x − 1)/x = ', options:[{text:'1', isLatex:true},{text:'0'},{text:'∞'},{text:'e'}], answer:'A', knowledge:'等价无穷小：e^x − 1 ~ x。' },
        { id:'p3-m03', number:3, prompt:'由 y = x、x = 1 与 x 轴围成区域绕 x 轴旋转一周所得体积为', options:[{text:'π/3', isLatex:true},{text:'π'},{text:'π/2'},{text:'2π/3'}], answer:'A', knowledge:'V = π∫_0^1 x^2 dx = π/3。' },
        { id:'p3-m04', number:4, prompt:'定积分 ∫_0^1 x e^x dx = ', options:[{text:'1', isLatex:true},{text:'e − 1'},{text:'e'},{text:'0'}], answer:'A', knowledge:'∫ x e^x dx = (x−1)e^x + C，在 0,1 处取值得 1。' },
        { id:'p3-m05', number:5, prompt:'不定积分 ∫ 1/(1+x^2) dx = ', options:[{text:'arctan x + C', isLatex:true},{text:'1/x + C'},{text:'ln(1+x^2) + C'},{text:'x^2/(2) + C'}], answer:'A', knowledge:'基本积分公式：∫ 1/(1+x^2) dx = arctan x + C。' },
        { id:'p3-m06', number:6, prompt:'设 F(x) = ∫_0^x sin t dt，则 F\'(x) = ', options:[{text:'sin x', isLatex:true},{text:'cos x'},{text:'-sin x'},{text:'-cos x'}], answer:'A', knowledge:'变上限积分求导：F\'(x) = sin x。' },
        { id:'p3-m07', number:7, prompt:'极限 lim(x→0) (sin 2x)/(x) = ', options:[{text:'2', isLatex:true},{text:'1'},{text:'1/2'},{text:'∞'}], answer:'A', knowledge:'lim sin(2x)/x = 2·lim sin(2x)/(2x) = 2。' },
        { id:'p3-m08', number:8, prompt:'定积分 ∫_0^1 (x^2 + 2x) dx = ', options:[{text:'4/3', isLatex:true},{text:'1'},{text:'7/3'},{text:'2'}], answer:'A', knowledge:'∫_0^1 x^2 dx + ∫_0^1 2x dx = 1/3 + 1 = 4/3。' },
        { id:'p3-m09', number:9, prompt:'区域 0≤y≤√x，0≤x≤1 绕 x 轴旋转一周所得旋转体体积为', options:[{text:'π/2', isLatex:true},{text:'π'},{text:'π/3'},{text:'2π/3'}], answer:'A', knowledge:'V = π∫_0^1 x dx = π/2。' },
        { id:'p3-m10', number:10, prompt:'不定积分 ∫ x ln x dx = ', options:[{text:'(x^2/2)ln x − x^2/4 + C', isLatex:true},{text:'ln x + C'},{text:'(1/2) x^2 + C'},{text:'x ln x − x + C'}], answer:'A', knowledge:'分部积分：u=ln x, dv=x dx；结果 = x^2/2·ln x − ∫ x/2 dx。' }
      ]
    }
  }
];

const numberQuestions = questions => questions.map((question, index) => ({
  ...question,
  number: index + 1
}));

const POLITICS_SUPPLEMENT = [
  { id:'politics-29', prompt:'物质的唯一特性是', options:['客观实在性','可感知性','运动性','广延性'], answer:'A', knowledge:'客观实在性是物质的唯一特性。' },
  { id:'politics-30', prompt:'意识的能动作用最突出的表现是', options:['意识能够指导实践','意识来自大脑','意识具有主观性','意识能够反映客观世界'], answer:'A', knowledge:'意识能动作用集中体现在正确意识能够指导实践。' },
  { id:'politics-31', prompt:'量变和质变的辩证关系说明', options:['量变是质变的必要准备','质变总是量变的重复','量变和质变互不相关','质变不需要量变'], answer:'A', knowledge:'量变积累到一定程度必然引起质变。' },
  { id:'politics-32', prompt:'真理的根本属性是', options:['客观性','绝对性','相对性','有用性'], answer:'A', knowledge:'真理的内容是客观的，客观性是真理的根本属性。' },
  { id:'politics-33', prompt:'社会存在与社会意识的关系是', options:['社会存在决定社会意识','社会意识决定社会存在','二者毫无关系','社会意识完全同步于社会存在'], answer:'A', knowledge:'社会存在决定社会意识，社会意识具有相对独立性。' },
  { id:'politics-34', prompt:'商品的二因素是', options:['使用价值和价值','价值和价格','劳动和交换','具体劳动和抽象劳动'], answer:'A', knowledge:'商品具有使用价值和价值两个因素。' },
  { id:'politics-35', prompt:'决定商品价值量的社会必要劳动时间是指', options:['在现有社会正常生产条件下制造某种商品所需时间','个别生产者实际耗费的时间','最长劳动时间','最短劳动时间'], answer:'A', knowledge:'商品价值量由社会必要劳动时间决定。' },
  { id:'politics-36', prompt:'我国的根本政治制度是', options:['人民代表大会制度','中国共产党领导的多党合作制度','民族区域自治制度','基层群众自治制度'], answer:'A', knowledge:'人民代表大会制度是我国的根本政治制度。' },
  { id:'politics-37', prompt:'我国的国体是', options:['人民民主专政','人民代表大会制度','社会主义制度','民主集中制'], answer:'A', knowledge:'人民民主专政是我国的国体。' },
  { id:'politics-38', prompt:'中国共产党的根本宗旨是', options:['全心全意为人民服务','实现共同富裕','坚持改革开放','发展生产力'], answer:'A', knowledge:'全心全意为人民服务是党的根本宗旨。' },
  { id:'politics-39', prompt:'社会主义民主政治的本质属性是', options:['全过程人民民主','人民代表大会制度','协商民主','基层民主'], answer:'A', knowledge:'全过程人民民主是社会主义民主政治的本质属性。' },
  { id:'politics-40', prompt:'全面依法治国的总目标是', options:['建设中国特色社会主义法治体系、建设社会主义法治国家','依法行政','有法可依','完善法律制度'], answer:'A', knowledge:'全面依法治国总目标包括建设法治体系和法治国家。' },
  { id:'politics-41', prompt:'新时代我国社会的主要矛盾强调的发展问题是', options:['不平衡不充分的发展','发展速度过快','城乡二元结构','阶级斗争'], answer:'A', knowledge:'主要矛盾突出不平衡不充分的发展问题。' },
  { id:'politics-42', prompt:'新发展理念中，解决发展动力问题的是', options:['创新','协调','绿色','开放'], answer:'A', knowledge:'创新发展注重解决发展动力问题。' },
  { id:'politics-43', prompt:'新发展理念中，解决人与自然和谐问题的是', options:['绿色','创新','协调','共享'], answer:'A', knowledge:'绿色发展注重解决人与自然和谐共生问题。' },
  { id:'politics-44', prompt:'中国式现代化最鲜明的特征是', options:['中国共产党领导','人口规模巨大','共同富裕','人与自然和谐共生'], answer:'A', knowledge:'党的领导是中国式现代化最鲜明的特征。' },
  { id:'politics-45', prompt:'总体国家安全观以什么为宗旨', options:['人民安全','政治安全','经济安全','军事安全'], answer:'A', knowledge:'总体国家安全观以人民安全为宗旨。' },
  { id:'politics-46', prompt:'我国外交政策的宗旨是', options:['维护世界和平、促进共同发展','独立自主','和平共处五项原则','合作共赢'], answer:'A', knowledge:'维护世界和平、促进共同发展是我国外交政策宗旨。' },
  { id:'politics-47', prompt:'爱国主义的本质是', options:['坚持爱国和爱党、爱社会主义相统一','维护民族利益','热爱传统文化','支持国家建设'], answer:'A', knowledge:'新时代爱国主义强调爱国、爱党、爱社会主义相统一。' },
  { id:'politics-48', prompt:'社会主义道德建设的原则是', options:['集体主义','为人民服务','爱国主义','诚实守信'], answer:'A', knowledge:'集体主义是社会主义道德建设的原则。' },
  { id:'politics-49', prompt:'中国革命道德的核心是', options:['为中国人民谋幸福、为中华民族谋复兴','艰苦奋斗','实事求是','独立自主'], answer:'A', knowledge:'中国革命道德以为人民谋幸福、为民族谋复兴为核心。' },
  { id:'politics-50', prompt:'中国共产党在社会主义初级阶段的基本路线核心是', options:['以经济建设为中心','坚持改革开放','坚持四项基本原则','实现共同富裕'], answer:'A', knowledge:'基本路线的核心是以经济建设为中心。' }
];

const MATH_SUPPLEMENT = [
  { id:'math-29', prompt:'函数 f(x)=x^2+1 在 x=2 处的导数为', options:[{text:'4',isLatex:true},{text:'2'},{text:'5'},{text:'3'}], answer:'A', knowledge:'f\'(x)=2x，代入 x=2 得 4。' },
  { id:'math-30', prompt:'函数 y=sin x 的导数是', options:[{text:'cos x',isLatex:true},{text:'-cos x'},{text:'sin x'},{text:'-sin x'}], answer:'A', knowledge:'基本求导公式：(sin x)\'=cos x。' },
  { id:'math-31', prompt:'函数 y=ln x 的导数是', options:[{text:'1/x',isLatex:true},{text:'x'},{text:'ln x'},{text:'e^x'}], answer:'A', knowledge:'基本求导公式：(ln x)\'=1/x。' },
  { id:'math-32', prompt:'函数 y=e^x 的导数是', options:[{text:'e^x',isLatex:true},{text:'x e^{x-1}'},{text:'ln x'},{text:'1/e^x'}], answer:'A', knowledge:'指数函数 e^x 的导数仍为 e^x。' },
  { id:'math-33', prompt:'极限 lim(x→0) tan x / x 的值为', options:[{text:'1',isLatex:true},{text:'0'},{text:'∞'},{text:'不存在'}], answer:'A', knowledge:'x→0 时 tan x 与 x 等价。' },
  { id:'math-34', prompt:'极限 lim(x→0) (e^x−1)/x 的值为', options:[{text:'1',isLatex:true},{text:'0'},{text:'e'},{text:'∞'}], answer:'A', knowledge:'重要极限：e^x−1 与 x 等价。' },
  { id:'math-35', prompt:'极限 lim(x→0) ln(1+x)/x 的值为', options:[{text:'1',isLatex:true},{text:'0'},{text:'∞'},{text:'不存在'}], answer:'A', knowledge:'重要极限：ln(1+x) 与 x 等价。' },
  { id:'math-36', prompt:'不定积分 ∫ x dx 等于', options:[{text:'x^2/2 + C',isLatex:true},{text:'x + C'},{text:'2x + C'},{text:'x^2 + C'}], answer:'A', knowledge:'∫x dx=x²/2+C。' },
  { id:'math-37', prompt:'不定积分 ∫ 1/x dx 等于', options:[{text:'ln|x| + C',isLatex:true},{text:'1/x + C'},{text:'x + C'},{text:'e^x + C'}], answer:'A', knowledge:'基本积分公式：∫1/x dx=ln|x|+C。' },
  { id:'math-38', prompt:'不定积分 ∫ sin x dx 等于', options:[{text:'-cos x + C',isLatex:true},{text:'cos x + C'},{text:'sin x + C'},{text:'-sin x + C'}], answer:'A', knowledge:'(cos x)\'=-sin x，因此 sin x 的原函数是 -cos x。' },
  { id:'math-39', prompt:'定积分 ∫₀¹ x² dx 等于', options:[{text:'1/3',isLatex:true},{text:'1/2'},{text:'1'},{text:'2'}], answer:'A', knowledge:'∫₀¹x²dx=[x³/3]₀¹=1/3。' },
  { id:'math-40', prompt:'定积分 ∫₀¹ 1 dx 等于', options:[{text:'1',isLatex:true},{text:'0'},{text:'1/2'},{text:'2'}], answer:'A', knowledge:'常数函数 1 在长度为1的区间上的定积分为1。' },
  { id:'math-41', prompt:'定积分 ∫₀^π cos x dx 等于', options:[{text:'0',isLatex:true},{text:'2'},{text:'1'},{text:'π'}], answer:'A', knowledge:'∫₀^πcos x dx=[sin x]₀^π=0。' },
  { id:'math-42', prompt:'由 y=x 与 x 轴、x=1 围成图形的面积为', options:[{text:'1/2',isLatex:true},{text:'1'},{text:'2'},{text:'π/2'}], answer:'A', knowledge:'面积为∫₀¹x dx=1/2。' },
  { id:'math-43', prompt:'由 y=√x、x轴和 x=1 围成图形的面积为', options:[{text:'2/3',isLatex:true},{text:'1/2'},{text:'1'},{text:'1/3'}], answer:'A', knowledge:'面积为∫₀¹√x dx=[2x^(3/2)/3]₀¹=2/3。' },
  { id:'math-44', prompt:'区域 0≤y≤x，0≤x≤1 绕 x 轴旋转一周的体积为', options:[{text:'π/3',isLatex:true},{text:'π/2'},{text:'π'},{text:'2π'}], answer:'A', knowledge:'V=π∫₀¹x²dx=π/3。' },
  { id:'math-45', prompt:'区域 0≤y≤1，0≤x≤1 绕 x 轴旋转一周的体积为', options:[{text:'π',isLatex:true},{text:'π/2'},{text:'2π'},{text:'1'}], answer:'A', knowledge:'V=π∫₀¹1²dx=π。' },
  { id:'math-46', prompt:'设 F(x)=∫₀ˣ t²dt，则 F(x) 等于', options:[{text:'x^3/3',isLatex:true},{text:'x²'},{text:'2x'},{text:'x³'}], answer:'A', knowledge:'直接积分得 F(x)=x³/3。' },
  { id:'math-47', prompt:'函数 f(x)=x³−2x 的导数为', options:[{text:'3x²−2',isLatex:true},{text:'x²−2'},{text:'3x²'},{text:'x³−2'}], answer:'A', knowledge:'逐项求导：x³导数为3x²，−2x导数为−2。' },
  { id:'math-48', prompt:'函数 f(x)=x² 在 x=0 处的极小值为', options:[{text:'0',isLatex:true},{text:'1'},{text:'不存在'},{text:'−1'}], answer:'A', knowledge:'x²≥0，x=0 时取得最小值0。' },
  { id:'math-49', prompt:'若 f\'(x)>0，则函数 f(x) 在该区间内', options:['单调递增','单调递减','恒为零','没有变化'], answer:'A', knowledge:'导数大于0表示函数在该区间内单调递增。' },
  { id:'math-50', prompt:'若 f\'(x)<0，则函数 f(x) 在该区间内', options:['单调递减','单调递增','恒为常数','必有极值'], answer:'A', knowledge:'导数小于0表示函数在该区间内单调递减。' }
];

const POLITICS_QUESTIONS = numberQuestions([
  ...RAW_ENTRANCE_PAPERS.flatMap(paper => paper.sections.政治),
  ...POLITICS_SUPPLEMENT
]);
const MATH_QUESTIONS = numberQuestions([
  ...RAW_ENTRANCE_PAPERS.flatMap(paper => paper.sections.数学),
  ...MATH_SUPPLEMENT
]);

const ENTRANCE_PAPERS = [
  {
    id: 'entry-politics', subject: '政治', title: '政治入学摸底试卷', level: '专升本衔接 · 考研入门',
    summary: '50 道政治基础单选题，重点摸底哲学、政治经济学、毛泽东思想和中国特色社会主义理论基础。',
    passThreshold: 60, shareSlug: 'entry-politics', sections: { 政治: POLITICS_QUESTIONS }
  },
  {
    id: 'entry-english', subject: '英语', title: '英语入学摸底试卷', level: '专升本衔接 · 考研入门',
    summary: '50 道英语基础单选题：实词辨析 10 题、语法 20 题、英译中 20 题。',
    passThreshold: 60, shareSlug: 'entry-english', sections: { 英语: RAW_ENTRANCE_PAPERS[0].sections.英语 }
  },
  {
    id: 'entry-math', subject: '数学', title: '数学入学摸底试卷', level: '专升本衔接 · 考研入门',
    summary: '50 道数学基础单选题，涵盖导数、极限、定积分、不定积分、面积与旋转体。',
    passThreshold: 60, shareSlug: 'entry-math', sections: { 数学: MATH_QUESTIONS }
  }
];
const loadEntrancePapers = () => {
  if (isApiConfigured()) return { distributions: {}, submissions: [] };
  const emptyState = { distributions: {}, submissions: [] };

  try {
    const saved = window.localStorage.getItem(ENTRANCE_PAPERS_STORAGE_KEY);
    if (!saved) return emptyState;

    const parsed = JSON.parse(saved);
    if (parsed?.version !== ENTRANCE_PAPER_VERSION) return emptyState;
    const validPaperIds = new Set(ENTRANCE_PAPERS.map(paper => paper.id));
    const submissions = Array.isArray(parsed?.submissions)
      ? parsed.submissions.filter(item => item && validPaperIds.has(item.paperId))
      : [];
    const distributions = Object.entries(parsed?.distributions || {}).reduce((result, [paperId, assignments]) => {
      if (!validPaperIds.has(paperId) || !assignments || typeof assignments !== 'object') return result;
      const validAssignments = Object.entries(assignments).reduce((paperAssignments, [studentId, assignment]) => {
        if (assignment && validPaperIds.has(assignment.paperId || paperId)) {
          paperAssignments[studentId] = assignment;
        }
        return paperAssignments;
      }, {});
      if (Object.keys(validAssignments).length) result[paperId] = validAssignments;
      return result;
    }, {});

    return { distributions, submissions };
  } catch (error) {
    return emptyState;
  }
};

const buildShareUrl = (paper, student) => {
  const origin = typeof window !== 'undefined' && window.location ? window.location.origin : '';
  return `${origin}/exam/${paper.shareSlug}?token=${encodeURIComponent(student.intakeToken || paper.id)}`;
};

const FREE_EXAM_START_WINDOW_DAYS = 7;
const getExamStartDeadline = (student, assignedAt = new Date()) => {
  const paidUntil = student?.status === '付费' && student?.paidUntil
    ? new Date(student.paidUntil)
    : null;
  if (paidUntil && !Number.isNaN(paidUntil.getTime()) && paidUntil > assignedAt) {
    return paidUntil.toISOString();
  }
  return new Date(
    assignedAt.getTime() + FREE_EXAM_START_WINDOW_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
};

const createExamDistribution = (paper, student, assignedAt = new Date()) => ({
  studentId: student.id,
  studentName: student.name,
  paperId: paper.id,
  assignedAt: assignedAt.toISOString(),
  startDeadlineAt: getExamStartDeadline(student, assignedAt),
  startedAt: null,
  examDeadlineAt: null,
  shareUrl: buildShareUrl(paper, student),
  status: '待开始'
});

function QuestionBank({aiSettings, students, setStudents, notify, entranceState, setEntranceState}) {
  const apiMode = isApiConfigured();
  const [serverPapers, setServerPapers] = useState(null);
  const [serverPaperState, setServerPaperState] = useState({ loading: apiMode, error: '' });
  const [serverPaperReloadNonce, setServerPaperReloadNonce] = useState(0);
  const [activePaperId, setActivePaperId] = useState(ENTRANCE_PAPERS[0].id);
  const [gradingStudentId, setGradingStudentId] = useState(null);
  const [gradingDraftAnswers, setGradingDraftAnswers] = useState(null);
  const [gradingSubjectiveScore, setGradingSubjectiveScore] = useState('');
  const [gradingStatus, setGradingStatus] = useState('部分待批改');
  const [gradingNote, setGradingNote] = useState('');
  const [gradingPending, setGradingPending] = useState(false);
  const [previewingPaperId, setPreviewingPaperId] = useState(null);
  const [copiedLink, setCopiedLink] = useState('');
  const [bankTab, setBankTab] = useState('entrance');
  const [aiPromptOpen, setAiPromptOpen] = useState(false);
  useEffect(() => {
    if (!apiMode) return undefined;
    let active = true;
    setServerPaperState({ loading: true, error: '' });
    (async () => {
      try {
        const list = await apiRequest('/api/admin/entrance/papers', { cache: 'no-store' });
        const papers = await Promise.all((Array.isArray(list) ? list : []).map(async paper => {
          const detail = await apiRequest(`/api/admin/entrance/papers/${encodeURIComponent(paper.id)}`, { cache: 'no-store' });
          return {
            id: paper.id,
            subject: detail.subject || detail.items?.[0]?.subject || '综合',
            title: paper.title,
            level: paper.state || '已发布',
            summary: `${detail.items?.length || 0} 道服务端题目`,
            passThreshold: 60,
            shareSlug: paper.id,
            serverManaged: true,
            durationMinutes: paper.duration_minutes || paper.durationMinutes || 60,
            sections: { server: Array.isArray(detail.items) ? detail.items.map((item, index) => ({
              ...item,
              id: item.questionId || item.id || `${paper.id}-${index}`,
              number: index + 1,
              prompt: item.stem || '',
              options: Array.isArray(item.options) ? item.options : [],
              answer: item.correctAnswer,
              correctAnswer: item.correctAnswer,
              questionType: item.questionType || item.question_type || 'single_choice',
              knowledge: item.knowledgePoint || '',
            })) : [] },
          };
        }));
        if (!active) return;
        setServerPapers(papers);
        if (papers[0]) setActivePaperId(current => papers.some(item => item.id === current) ? current : papers[0].id);
        setServerPaperState({ loading: false, error: '' });
      } catch (error) {
        if (active) setServerPaperState({ loading: false, error: error?.message || '题库加载失败' });
      }
    })();
    return () => { active = false; };
  }, [apiMode, serverPaperReloadNonce]);
  if (apiMode && serverPaperState.loading) return <section className="panel"><div className="empty-line"><Clock3 size={20}/><span>正在加载服务端题库与试卷…</span></div></section>;
  if (apiMode && serverPaperState.error) return <section className="panel"><div className="empty-line" role="alert"><CircleHelp size={20}/><span>{serverPaperState.error}</span><button type="button" className="secondary" onClick={() => setServerPaperReloadNonce(current => current + 1)}>重新加载</button></div></section>;
  const paperCatalog = apiMode ? (serverPapers || []) : ENTRANCE_PAPERS;
  const distributions = entranceState.distributions || {};
  const submissions = entranceState.submissions || [];
  const activePaper = paperCatalog.find(paper => paper.id === activePaperId) || paperCatalog[0] || null;
  const paperDistributions = activePaper ? (distributions[activePaper.id] || {}) : {};
  const paperSubmissions = activePaper ? submissions.filter(item => String(item.paperId) === String(activePaper.id)) : [];
  const enabledPushCount = (students || []).filter(item => getAssessmentPush(item).enabled).length;
  const modelReady = isAiSlotReady(aiSettings, 'periodic_assessment');
  const assessmentSlot = getAiSlotConfig(aiSettings, 'periodic_assessment');
  const gradingReady = isAiSlotReady(aiSettings, 'assessment_grading');
  const gradingSlot = getAiSlotConfig(aiSettings, 'assessment_grading');
  const assessmentModel = getConfiguredModel(aiSettings, assessmentSlot.modelId);
  const gradingModel = getConfiguredModel(aiSettings, gradingSlot.modelId);
  const distributePaper = async (student) => {
    if (!student) return notify('请选择要分发的学员');
    if (isApiConfigured() && student.id && !student.isTestAccount) {
      try {
        const result = await apiRequest('/api/exams/distributions', {
          method: 'POST',
          body: { paperId: activePaper.id, paperTitle: activePaper.title, studentId: student.id }
        });
        const shareUrl = `${window.location.origin}/exam/${encodeURIComponent(activePaper.id)}/?token=${encodeURIComponent(result.shareToken)}`;
        setEntranceState(current => ({
          ...current,
          distributions: {
            ...current.distributions,
            [activePaperId]: {
              ...(current.distributions[activePaperId] || {}),
              [student.id]: {
                id: result.distribution?.id,
                distributionId: result.distribution?.id,
                shareToken: result.shareToken,
                paperId: activePaper.id,
                paperTitle: activePaper.title,
                studentId: student.id,
                studentName: student.name,
                assignedAt: result.distribution?.assignedAt || new Date().toISOString(),
                status: '待开始',
                shareUrl,
                shareSlug: activePaper.shareSlug || activePaper.id
              }
            }
          }
        }));
        if (navigator.clipboard?.writeText) {
          try { await navigator.clipboard.writeText(shareUrl); notify(`分发链接已生成并复制到剪贴板，转交给 ${student.name}`); return; } catch (e) {}
        }
        notify(`已将「${activePaper.title}」链接发送给 ${student.name}`);
      } catch (error) {
        notify(error?.message || '分发试卷失败，请稍后重试');
      }
      return;
    }
    setEntranceState(current => ({
      ...current,
      distributions: {
        ...current.distributions,
        [activePaperId]: {
          ...(current.distributions[activePaperId] || {}),
          [student.id]: createExamDistribution(activePaper, student)
        }
      }
    }));
    notify(`已将「${activePaper.title}」链接发送给 ${student.name}`);
  };
  const revokeDistribution = async item => {
    if (!item) return;
    if (!window.confirm(`确定撤回 ${item.studentName || '该学员'} 的试卷链接吗？已提交结果不会被删除。`)) return;
    if (apiMode) {
      try {
        // The deployment will expose this real mutation endpoint. Do not hide a
        // failed request by changing the local distribution state.
        await apiRequest(`/api/admin/exams/distributions/${encodeURIComponent(item.id)}/revoke`, { method: 'POST' });
        setEntranceState(current => {
          const nextDistributions = { ...(current.distributions[activePaperId] || {}) };
          nextDistributions[item.studentId] = { ...nextDistributions[item.studentId], status: '已撤销', revokedAt: new Date().toISOString() };
          return { ...current, distributions: { ...current.distributions, [activePaperId]: nextDistributions } };
        });
        notify('已撤回试卷链接，学生端不会继续显示待自测');
      } catch (error) {
        notify(`撤回失败：${error?.message || '请稍后重试'}。当前显示未修改，可重新点击撤回。`);
      }
      return;
    }
    setEntranceState(current => {
      const nextDistributions = { ...(current.distributions[activePaperId] || {}) };
      delete nextDistributions[item.studentId];
      return { ...current, distributions: { ...current.distributions, [activePaperId]: nextDistributions } };
    });
    notify('已撤回该学员的试卷链接');
  };
  const startGrading = (submission) => {
    const student = students.find(item => String(item.id) === String(submission.studentId));
    if (!student) return notify('该提交未关联有效学员，无法进入批改');
    setGradingStudentId(submission.studentId);
    setGradingDraftAnswers(submission.answers || {});
    setGradingSubjectiveScore(submission.subjectiveScore == null ? '' : String(submission.subjectiveScore));
    setGradingStatus(normalizeGradingStatusLabel(submission.gradingStatus || (submission.subjectiveScore != null ? '已批改' : '部分待批改')));
    setGradingNote(submission.gradingNote || '');
    setPreviewingPaperId(null);
  };
  const cancelGrading = () => {
    setGradingStudentId(null);
    setGradingDraftAnswers(null);
    setGradingSubjectiveScore('');
    setGradingStatus('部分待批改');
    setGradingNote('');
  };
  const updateGradingAnswer = (questionId, value) => {
    setGradingDraftAnswers(current => ({ ...(current || {}), [questionId]: value }));
  };
  const submitGrading = async () => {
    const submission = paperSubmissions.find(item => String(item.studentId) === String(gradingStudentId));
    if (!submission) return notify('未找到对应的学生作答');
    const student = students.find(item => String(item.id) === String(gradingStudentId));
    if (!student) return notify('未找到对应学员，无法写入入学自测档案');
    const result = gradeEntrancePaper(activePaper, gradingDraftAnswers);
    if (apiMode && submission.isServerManaged) {
      const hasSubjective = flattenPaperQuestions(activePaper).some(question => !['single_choice', 'multiple_choice', 'true_false', 'fill_blank'].includes(getQuestionType(question)));
      const objectiveScore = Number(submission.objectiveScore ?? result.objectiveScore ?? 0);
      const requestedStatus = hasSubjective ? gradingStatus : '已批改';
      const subjectiveScore = hasSubjective && gradingSubjectiveScore !== '' ? Number(gradingSubjectiveScore) : null;
      if (hasSubjective && requestedStatus === '已批改' && subjectiveScore === null) return notify('完成批改前请填写主观题成绩，或保留为待批改');
      if (subjectiveScore !== null && (!Number.isFinite(subjectiveScore) || subjectiveScore < 0)) return notify('主观题成绩必须是非负数字');
      setGradingPending(true);
      try {
        const saved = await apiRequest(`/api/admin/exams/submissions/${encodeURIComponent(submission.id)}/grade`, {
          method: 'PATCH',
          body: { objectiveScore, subjectiveScore, gradingStatus: requestedStatus, gradingNote: gradingNote.trim() }
        });
        setEntranceState(current => ({ ...current, submissions: (current.submissions || []).map(item => String(item.id) === String(submission.id) ? { ...item, ...saved, isServerManaged: true } : item) }));
        cancelGrading();
        notify('批改结果已保存到服务端，学生端刷新后可查看');
      } catch (error) {
        notify(error?.message || '批改保存失败，请重试');
      } finally { setGradingPending(false); }
      return;
    }
    const nextSubmission = {
      ...submission,
      answers: gradingDraftAnswers,
      gradedAt: new Date().toISOString(),
      status: result.gradingStatus || '已批改',
      ...result
    };
    setEntranceState(current => ({
      ...current,
      submissions: current.submissions.map(item => item.id === submission.id ? nextSubmission : item)
    }));
    setStudents(items => items.map(item => item.id === student.id
      ? {
          ...item,
          entranceRecords: [
            ...(item.entranceRecords || []).filter(record => record.paperId !== activePaperId),
            { paperId: activePaperId, paperTitle: activePaper.title, score: result.score, total: result.total, submittedAt: nextSubmission.submittedAt, gradedAt: nextSubmission.gradedAt }
          ]
        }
      : item
    ));
    cancelGrading();
    notify(`已完成 ${student.name} 的「${activePaper.title}」批改复核`);
  };

  const previewPaper = previewingPaperId === activePaperId ? null : activePaperId;
  const activeSubmission = gradingStudentId ? paperSubmissions.find(item => String(item.studentId) === String(gradingStudentId)) : null;
  const activeStudent = gradingStudentId ? students.find(item => String(item.id) === String(gradingStudentId)) : null;
  const draftGrading = activeSubmission ? (() => {
    try { return gradeEntrancePaper(activePaper, gradingDraftAnswers || activeSubmission.answers || {}); }
    catch { return { objectiveScore: activeSubmission.objectiveScore ?? 0, total: activeSubmission.total ?? 0, gradingStatus: '部分待批改' }; }
  })() : null;
  const renderMathText = text => {
    if (!text) return '';
    if (typeof text !== 'string') return String(text);
    return text;
  };
  const renderMathOption = (option, index) => {
    const letter = String.fromCharCode(65 + index);
    if (option && typeof option === 'object' && option.isLatex) {
      return <span className="math-option">{letter}. <MathFormula value={option.text}/></span>;
    }
    return <span>{letter}. {renderMathText(option)}</span>;
  };

  return <>
    <section className="page-head">
      <div>
        <span className="eyebrow">自测</span>
        <h1>自测</h1>
        <p>入学自测负责摸底；日测 / 周测 / 月测按学员计划一对一出题，不在此预置固定试卷。</p>
      </div>
    </section>

    <div className="bank-tab-bar">
      <button type="button" className={bankTab === 'entrance' ? 'active' : ''} onClick={() => setBankTab('entrance')}>
        入学自测
        <small>3 套固定卷</small>
      </button>
      <button type="button" className={bankTab === 'periodic' ? 'active' : ''} onClick={() => setBankTab('periodic')}>
        日 / 周 / 月自测
        <small>{enabledPushCount} 人已开通</small>
      </button>
      <button type="button" className={bankTab === 'practice-books' ? 'active' : ''} onClick={() => setBankTab('practice-books')}>
        刷题书库
        <small>含代学书籍</small>
      </button>
    </div>

    {bankTab === 'practice-books' && <CompanionStudyManagement notify={notify} embedded/>}

    {bankTab === 'periodic' && (
      <section className="panel periodic-assessment-bank is-compact">
        <PanelHead title="日测 · 周测 · 月测" action={modelReady ? '模型已就绪' : '模型待配置'}/>
        <div className="periodic-summary-row">
          {getTeacherAssessmentSpecs().map(spec => (
            <article className={`periodic-spec-card compact tone-${spec.tone}`} key={spec.id}>
              <span className="eyebrow">{spec.subject} · {spec.cadence}</span>
              <h3>{spec.title}</h3>
              <b>{getAssessmentSpecFormat(spec)}</b>
              <p>{spec.desc}</p>
            </article>
          ))}
        </div>
        <div className="periodic-compact-meta">
          <p>优先级：月测日 &gt; 周测日 &gt; 日测日。每位学员按「个人起始日」独立推送，不共用同一套题。</p>
          <p>开通入口：学员管理 → 学员详情 → 日周月自测指定。句子取自考研阅读真题；同卷不重复，跨日可重复。</p>
        </div>
        <div className="periodic-ai-entry">
          <div className="periodic-ai-entry-info">
            <span className="eyebrow">出题 AI</span>
            <h3>{aiPromptOpen ? '提示词编辑' : '提示词与模型窗口'}</h3>
            <p>
              出题槽位：{modelReady ? (assessmentModel?.model || '已接入') : '未接入'}
              {' · '}
              {modelReady ? `${assessmentModel?.name || '已配置模型'} · 已启用` : '请到系统设置 → 模型管理新增模型，再到监管机器人选择'}
              {' · '}
              已开通 {enabledPushCount} 人
            </p>
          </div>
          <button type="button" className={aiPromptOpen ? 'secondary' : 'primary'} onClick={() => setAiPromptOpen(open => !open)}>
            {aiPromptOpen ? '收起' : '进入编辑'}
          </button>
        </div>
        {aiPromptOpen && (
          <div className="periodic-ai-window">
            <p className="periodic-ai-window-tip">正式出题走服务端；密钥不进前端。此处可预览、修改并复制按学员计划生成的提示词。</p>
            <PeriodicAssessmentAiPanel students={students} aiSettings={aiSettings} notify={notify}/>
          </div>
        )}
      </section>
    )}

    {bankTab === 'entrance' && <>
    {!activePaper ? <div className="empty-line"><FileQuestion size={20}/><span>暂无可展示的试卷，请先创建并发布一套服务端试卷。</span></div> : <>
    <div className="plan-subjects">
      {paperCatalog.map(paper => (
        <button key={paper.id} className={activePaperId === paper.id ? 'active' : ''} onClick={() => { setActivePaperId(paper.id); cancelGrading(); setPreviewingPaperId(null); }}>
          {paper.title}
          <small className="paper-level-tag">· {paper.level}</small>
        </button>
      ))}
      {!paperCatalog.length && <div className="empty-line"><FileQuestion size={20}/><span>服务端暂无可管理试卷，请先创建并发布试卷。</span></div>}
    </div>
    <section className="panel paper-overview">
      <div className="paper-overview-meta">
        <span className="eyebrow">入学自测 · {activePaper.level}</span>
        <h2>{activePaper.title}</h2>
        <p>{activePaper.summary}</p>
        <div className="paper-overview-stats">
          <span>{activePaper.subject}独立试卷</span>
          <span>共 {flattenPaperQuestions(activePaper).length} 题 · 每题 2 分</span>
          <span>满分 100 分 · 及格线 {activePaper.passThreshold} 分</span>
          <span>开始答题后限时 1 小时，可提前交卷</span>
        </div>
      </div>
      <div className="paper-overview-actions">
        <button className="secondary" onClick={() => setPreviewingPaperId(previewPaper)}><FileQuestion size={16}/>{previewingPaperId === activePaperId ? '收起试卷预览' : '预览试卷结构'}</button>
        <span className="paper-overview-link">学生作答链接前缀：<b>{`${typeof window !== 'undefined' && window.location ? window.location.origin : ''}/exam/${activePaper.shareSlug}`}</b></span>
      </div>
    </section>
    {previewingPaperId === activePaperId && <section className="panel paper-preview-panel">
      <PanelHead title={`${activePaper.title} · 试卷预览`} action="教师参考"/>
      {activePaper.serverManaged && <article className="paper-section"><h3>服务端题目快照（{flattenPaperQuestions(activePaper).length} 题）</h3><ol>{flattenPaperQuestions(activePaper).map(question => <li key={question.id}><b>{question.number}. {question.prompt}</b>{question.options?.length ? <div className="paper-options">{question.options.map((option, index) => <span key={index}>{String.fromCharCode(65 + index)}. {typeof option === 'object' ? option.text : option}</span>)}</div> : <small>主观题 · 提交后按服务端批改状态展示</small>}</li>)}</ol></article>}
      {!activePaper.serverManaged && activePaper.subject === '政治' && <article className="paper-section">
        <h3>政治基础单选题（{activePaper.sections.政治.length} 题，每题 2 分，共 100 分）</h3>
        <ol>{activePaper.sections.政治.map(q => <li key={q.id}><b>{q.number}. {q.prompt}</b><div className="paper-options">{q.options.map((option, index) => <span key={index}>{String.fromCharCode(65 + index)}. {option}</span>)}</div></li>)}</ol>
      </article>}
      {!activePaper.serverManaged && activePaper.subject === '英语' && <article className="paper-section">
        <h3>英语基础单选题（共 {activePaper.sections.英语.vocabulary.length + activePaper.sections.英语.grammar.length + activePaper.sections.英语.translation.length} 题，每题 2 分，共 100 分）</h3>
        <h4>实词辨析（{activePaper.sections.英语.vocabulary.length} 题）</h4>
        <ol>{activePaper.sections.英语.vocabulary.map(q => <li key={q.id}><b>{q.number}. {q.word}</b><div className="paper-options">{q.options.map((option, index) => <span key={index}>{String.fromCharCode(65 + index)}. {option}</span>)}</div></li>)}</ol>
        <h4>语法填空（{activePaper.sections.英语.grammar.length} 题）</h4>
        <ol>{activePaper.sections.英语.grammar.map(q => <li key={q.id}><b>{q.number}. {q.sentence}</b><div className="paper-options">{q.options.map((option, index) => <span key={index}>{String.fromCharCode(65 + index)}. {option}</span>)}</div></li>)}</ol>
        <h4>英译中句子翻译（{activePaper.sections.英语.translation.length} 题）</h4>
        <ol>{activePaper.sections.英语.translation.map(q => <li key={q.id}><b>{q.number}. {q.sentence}</b><div className="paper-options">{q.options.map((option, index) => <span key={index}>{String.fromCharCode(65 + index)}. {option}</span>)}</div></li>)}</ol>
      </article>}
      {!activePaper.serverManaged && activePaper.subject === '数学' && <article className="paper-section">
        <h3>数学基础单选题（{activePaper.sections.数学.length} 题，每题 2 分，共 100 分）</h3>
        <ol>{activePaper.sections.数学.map(q => <li key={q.id}><b>{q.number}. {q.prompt}</b><div className="paper-options">{q.options.map((option, index) => <span key={index}>{renderMathOption(option, index)}</span>)}</div></li>)}</ol>
      </article>}
    </section>}
    <section className="panel table-panel">
      <PanelHead title="试卷分发 · 每位学员的作答链接" action={`${Object.keys(paperDistributions).length} 名已发送`}/>
      <div className="exam-send-grid distribution-grid">
        <label>选择学员
          <select value="" onChange={event => { const student = students.find(item => String(item.id) === String(event.target.value)); if (student) distributePaper(student); event.target.value=''; }}>
            <option value="">分配给…</option>
            {students.map(item => <option value={item.id} key={item.id}>{item.name} · {item.status}</option>)}
          </select>
        </label>
        <label>已发送学员
          <small>{Object.keys(paperDistributions).length ? `${Object.keys(paperDistributions).length} 名学员已获得作答链接` : '暂未分发'}</small>
        </label>
        <div>
          <span>链接说明</span>
          <p>选择学员分发后，专属链接会显示在下方表格中，可直接复制后通过二维码、短信或微信发送给学生。</p>
        </div>
      </div>
      {Object.keys(paperDistributions).length > 0 && <table>
        <thead><tr><th>学员</th><th>状态</th><th>分发时间</th><th>可开始至</th><th>作答截止</th><th>作答链接</th><th>操作</th></tr></thead>
        <tbody>{Object.values(paperDistributions).map(item => (
          <tr key={item.studentId}>
            <td><b>{item.studentName}</b></td>
            <td><span className="badge ok">{item.status}</span></td>
            <td>{new Date(item.assignedAt).toLocaleString('zh-CN')}</td>
            <td>{item.startDeadlineAt ? new Date(item.startDeadlineAt).toLocaleString('zh-CN') : item.expiresAt ? new Date(item.expiresAt).toLocaleString('zh-CN') : '旧链接未设时限'}</td>
            <td>{item.examDeadlineAt ? new Date(item.examDeadlineAt).toLocaleString('zh-CN') : item.startedAt ? '计时信息待同步' : '未开始'}</td>
            <td>
              <div className="share-link-row">
                <input value={item.shareUrl} readOnly onFocus={event => event.target.select()}/>
                <button className="quiet-button" onClick={() => {
                  if (navigator?.clipboard?.writeText) {
                    navigator.clipboard.writeText(item.shareUrl).then(() => { setCopiedLink(item.shareUrl); notify('作答链接已复制到剪贴板'); }).catch(() => notify('复制失败，请手动选择文本'));
                  } else {
                    setCopiedLink(item.shareUrl);
                    notify('请手动复制输入框中的链接');
                  }
                }}>复制链接</button>
              </div>
            </td>
            <td><button className="danger-button" disabled={item.status === '已撤销'} onClick={() => revokeDistribution(item)}>{item.status === '已撤销' ? '已撤回' : '撤回'}</button></td>
          </tr>
        ))}</tbody>
      </table>}
    </section>
    <section className="panel table-panel">
      <PanelHead title="学生提交与 AI 批改" action={`${paperSubmissions.length} 条`}/>
      {paperSubmissions.length === 0 && <div className="empty-line"><Sparkles size={20}/><span>暂无学生提交。学生完成作答后会自动批改并写入自测档案，老师可在此查看结果或进行复核。</span></div>}
      {paperSubmissions.length > 0 && <table>
        <thead><tr><th>学员</th><th>提交时间</th><th>状态</th><th>分数</th><th>操作</th></tr></thead>
        <tbody>{paperSubmissions.map(item => (
          <tr key={item.id}>
            <td><b>{item.studentName}</b></td>
            <td>{new Date(item.submittedAt).toLocaleString('zh-CN')}</td>
            <td><span className={`badge ${item.status === '已批改' ? 'ok' : 'warn'}`}>{item.status}</span></td>
            <td>{typeof item.score === 'number' ? <b>{item.score} / {item.total}</b> : <span>—</span>}</td>
            <td>
              <button className="quiet-button" onClick={() => startGrading(item)}>查看或复核<ChevronRight size={14}/></button>
            </td>
          </tr>
        ))}</tbody>
      </table>}
    </section>
    {activeSubmission && activeStudent && <section className="panel grading-panel">
      <PanelHead title={`${activeStudent.name} · ${activePaper.title} · ${activeSubmission.status === '已批改' ? '批改结果' : '批改工作台'}`} action="返回题库列表" onAction={cancelGrading}/>
      <div className="grading-overview">
        <div><span>作答时间</span><b>{new Date(activeSubmission.submittedAt).toLocaleString('zh-CN')}</b></div>
        <div><span>提交状态</span><b>{activeSubmission.status}</b></div>
        <div><span>评分规则</span><b>50 题 × 2 分，满分 100 分</b></div>
        <div><span>批改模型槽位</span><b>{gradingReady ? (gradingModel?.model || '已接入') : '未就绪'}</b></div>
      </div>
      {activeSubmission.status !== '已批改' && <p className="grading-note">
        「自测批改机器人」统一负责入学自测、日测、周测和月测的批改与解析。
        {gradingReady
          ? ` 当前使用 ${gradingModel?.name || '已配置模型'} / ${gradingModel?.model || '模型'}。`
          : ' 请先到系统设置 → 模型管理新增模型，再到监管机器人 →「自测批改机器人」选择模型并启用。'}
        老师可在此复核作答，再一键生成错题解析与个人自测档案。
      </p>}
      <div className="grading-list">
        {flattenPaperQuestions(activePaper).map(question => (
          <div className="grading-question" key={question.id}>
            <div className="grading-question-head">
              <span className="grading-tag">{question.subjectLabel}</span>
              <b>第 {question.number} 题 · {isMultipleChoiceQuestion(question) ? '多选题' : getQuestionType(question) === 'single_choice' ? '单选题' : getQuestionType(question) === 'short_answer' ? '主观题' : getQuestionType(question)}</b>
            </div>
            <div className="grading-prompt">{question.subject === '数学' ? <MathFormula value={String(question.prompt).replace(/^\d+\.\s*/, '')}/> : question.prompt}</div>
            <div className="paper-options grading-options">{question.options.map((option, index) => {
              const letter = getQuestionOptionKey(option, index);
              const multiple = isMultipleChoiceQuestion(question);
              const studentAnswer = getStoredQuestionAnswer(gradingDraftAnswers || activeSubmission.answers, question, question.id);
              const selectedAnswers = multiple ? normalizeMultipleChoiceAnswer(studentAnswer) : [String(studentAnswer || '')];
              const isCorrect = answersMatch(studentAnswer, question.correctAnswer ?? question.answer, multiple);
              const isMarked = selectedAnswers.includes(letter);
              const optionClass = isMarked ? 'is-marked' : '';
              const answerClass = studentAnswer !== undefined && studentAnswer !== '' ? (isCorrect ? 'is-correct' : 'is-wrong') : '';
              return <label key={index} className={`grading-option ${optionClass} ${answerClass}`}>
                <input type={multiple ? 'checkbox' : 'radio'} name={question.id} value={letter} checked={isMarked} onChange={event => updateGradingAnswer(question.id, multiple ? toggleMultipleChoiceAnswer(gradingDraftAnswers || activeSubmission.answers, question.id, letter) : event.target.value)}/>
                {question.subject === '数学' && option && typeof option === 'object' && option.isLatex ? <MathFormula value={option.text}/> : <span>{letter}. {renderMathText(getQuestionOptionText(option))}</span>}
              </label>;
            })}</div>
            <div className="grading-answer">
              <span>正确答案：<b>{normalizeMultipleChoiceAnswer(question.correctAnswer ?? question.answer).join('、') || '待配置'}</b></span>
              <span>学生作答：<b>{normalizeMultipleChoiceAnswer(getStoredQuestionAnswer(gradingDraftAnswers || activeSubmission.answers, question, question.id)).join('、') || '未作答'}</b></span>
              {getStoredQuestionAnswer(gradingDraftAnswers || activeSubmission.answers, question, question.id) && <span className={answersMatch(getStoredQuestionAnswer(gradingDraftAnswers || activeSubmission.answers, question, question.id), question.correctAnswer ?? question.answer, isMultipleChoiceQuestion(question)) ? 'green-text' : 'danger-text'}>{answersMatch(getStoredQuestionAnswer(gradingDraftAnswers || activeSubmission.answers, question, question.id), question.correctAnswer ?? question.answer, isMultipleChoiceQuestion(question)) ? '答对' : '答错'}</span>}
            </div>
          </div>
        ))}
      </div>
      {draftGrading && <div className="grading-score-breakdown"><span>客观分：{draftGrading.objectiveScore ?? 0} / {draftGrading.total ?? activeSubmission.total ?? '—'}</span><span>主观分：{gradingSubjectiveScore === '' ? '待批改' : gradingSubjectiveScore}</span><span>提交状态：{normalizeGradingStatusLabel(gradingStatus)}</span></div>}
      <section className="grading-controls">
        <div><span className="eyebrow">主观题结果</span><p>客观题由服务端题目快照评分；主观题仅在教师填写后计入最终分数。提交时会显示客观分，主观题保持待批改。</p></div>
        <label>批改状态<select value={gradingStatus} onChange={event => setGradingStatus(event.target.value)} disabled={gradingPending}><option value="部分待批改">部分待批改</option><option value="待批改">待批改</option><option value="已批改">已批改</option></select></label>
        <label>主观分（可选）<input type="number" min="0" value={gradingSubjectiveScore} onChange={event => setGradingSubjectiveScore(event.target.value)} placeholder="未批改留空" disabled={gradingPending}/></label>
        <label className="grading-note-field">教师批注<textarea value={gradingNote} onChange={event => setGradingNote(event.target.value)} placeholder="填写批改说明或后续建议" rows={3} disabled={gradingPending}/></label>
      </section>
      <div className="form-footer">
        <BackButton label="返回题库列表" onClick={cancelGrading}/>
        <button className="primary" onClick={submitGrading} disabled={gradingPending}>{gradingPending ? '正在保存…' : '保存批改结果'}</button>
      </div>
      {(activeSubmission.status === '已批改' || activeSubmission.gradingStatus === 'graded' || activeSubmission.gradingStatus === '已批改') && <div className="grading-summary">
        <h3>批改反馈</h3>
        <p><b>总分：</b>{activeSubmission.score} / {activeSubmission.total}</p>
        <p><b>正确率：</b>{activeSubmission.total ? `${Math.round((activeSubmission.score / activeSubmission.total) * 100)}%` : '0%'}</p>
        <p><b>错题数量：</b>{activeSubmission.wrongQuestions.length}</p>
        <h4>错题与正确做法</h4>
        <ol className="grading-wrong-list">
          {activeSubmission.wrongQuestions.map(item => (
            <li key={item.questionId}>
              <div><b>{item.subject} · 第 {item.number} 题</b><small>正确：{item.correctAnswer} · 学生作答：{item.studentAnswer || '未作答'}</small></div>
              <p>正确做法：{item.correctMethod}</p>
              <p>知识点解析：{item.knowledgePointExplanation}</p>
            </li>
          ))}
        </ol>
        <h4>整体学习建议</h4>
        <p className="grading-advice">{activeSubmission.aiFeedback}</p>
      </div>}
    </section>}
    </>}
    </>}
  </>;
}

function PeriodicAssessmentAiPanel({students, aiSettings, notify}) {
  const enabledStudents = (students || []).filter(item => getAssessmentPush(item).enabled);
  const [selectedId, setSelectedId] = useState(() => enabledStudents[0]?.id || students?.[0]?.id || '');
  const [typeId, setTypeId] = useState('daily');
  const selected = (students || []).find(item => String(item.id) === String(selectedId)) || students?.[0];
  const availableSpecs = getStudentAssessmentSpecs(selected);
  const activeTypeId = availableSpecs.some(spec => spec.id === typeId) ? typeId : availableSpecs[0]?.id || '英语-daily';
  const draftSeed = selected ? buildAssessmentPromptDraft(selected, activeTypeId) : '请先选择学员';
  const [promptDraft, setPromptDraft] = useState(draftSeed);
  const [seedKey, setSeedKey] = useState(`${selected?.id || ''}:${activeTypeId}`);
  const currentKey = `${selected?.id || ''}:${activeTypeId}`;
  if (currentKey !== seedKey) {
    setSeedKey(currentKey);
    setPromptDraft(draftSeed);
  }
  const studyDay = selected ? getPersonalStudyDay(selected) : 0;
  const todayModules = selected ? getStudentAssessmentModules(selected, aiSettings).filter(item => item.isToday) : [];

  return <div className="periodic-ai-panel">
    <div className="exam-send-grid periodic-ai-controls">
      <label>预览学员
        <select value={selected?.id || ''} onChange={event => setSelectedId(event.target.value)}>
          {(students || []).map(item => (
            <option value={item.id} key={item.id}>
              {item.name}{getAssessmentPush(item).enabled ? ' · 已指定' : ' · 未指定'}
            </option>
          ))}
        </select>
      </label>
      <label>预览题型
        <select value={activeTypeId} onChange={event => setTypeId(event.target.value)}>
          {availableSpecs.map(spec => (
            <option value={spec.id} key={spec.id}>{spec.title}（{getAssessmentSpecFormat(spec)}）</option>
          ))}
        </select>
      </label>
      <div>
        <span>该学员今日</span>
        <p>
          {selected
            ? (getAssessmentPush(selected).enabled
              ? `个人第 ${studyDay} 天 · 今日应推 ${todayModules.length ? todayModules.map(item => item.title).join(' · ') : '—'}`
              : '尚未在学员管理中指定开通日周月自测')
            : '无学员'}
        </p>
      </div>
    </div>
    <label className="periodic-prompt-label">
      <span>发给大模型的提示词（可编辑 · 切换学员/题型会按计划重新生成草案）</span>
      <textarea
        className="periodic-prompt-box is-editable"
        value={promptDraft}
        rows={12}
        onChange={event => setPromptDraft(event.target.value)}
      />
    </label>
    <div className="form-footer">
      <button
        type="button"
        className="secondary"
        onClick={() => {
          setPromptDraft(draftSeed);
          notify('已按当前学员计划重置提示词草案');
        }}
      >
        重置草案
      </button>
      <button
        type="button"
        className="secondary"
        onClick={() => {
          if (navigator?.clipboard?.writeText) {
            navigator.clipboard.writeText(promptDraft).then(() => notify('提示词已复制，可粘贴到你的模型调试台')).catch(() => notify('复制失败，请手动选择文本'));
          } else {
            notify('请手动复制提示词文本框内容');
          }
        }}
      >
        复制提示词
      </button>
      <button
        type="button"
        className="primary"
        onClick={async () => {
          if (!selected || !getAssessmentPush(selected).enabled) {
            notify('请先在学员管理中为该学员指定开通日周月自测');
            return;
          }
          const slot = getAiSlotConfig(aiSettings, 'periodic_assessment');
          if (isApiConfigured()) {
            if (!slot.serverManaged || !slot.modelId) return notify('服务端尚未配置自测出题机器人；当前不会伪装成已生成题目。');
            try {
              const job = await apiRequest('/api/ai/jobs', { method: 'POST', body: { robotId: 'periodic_assessment', studentId: selected.id, input: { assessmentType: getAssessmentSpec(activeTypeId)?.typeId || activeTypeId, subject: getAssessmentSpec(activeTypeId)?.subject || '', prompt: promptDraft } } });
              notify(job?.message || `已创建${getAssessmentSpec(activeTypeId)?.title || '自测'}任务，等待服务端处理`);
            } catch (error) { notify(error?.message || '创建自测任务失败，请稍后重试'); }
            return;
          }
          if (!isAiSlotReady(aiSettings, 'periodic_assessment')) {
            notify('请先配置并启用「自测出题机器人」');
            return;
          }
          const model = getConfiguredModel(aiSettings, slot.modelId);
          notify(`已准备「${model?.name || '已配置模型'} · ${model?.model || ''}」的${getAssessmentSpec(activeTypeId)?.title || '自测'}出题请求；本地模式不会将草案冒充正式题目。`);
        }}
      >
        <Sparkles size={16}/>试连出题模型
      </button>
      <small>当前不会真正调用大模型生成题目。上线后：服务端读取本提示词 + 学员计划 → 调用「日/周/月自测出题」槽配置的模型 → 回写题目与答案。</small>
    </div>
  </div>;
}

function AssessmentPushPanel({ student, aiSettings, onApply, onToggleType, notify }) {
  const push = getAssessmentPush(student);
  const modules = getStudentAssessmentModules(student, aiSettings);
  const enrolledSubjects = [...new Set((student?.subjects || []).filter(item => item.enrolled).map(item => normalizeStudentSubject(item.name)))];
  const isPaid = student?.status === '付费';
  const typeSpecs = Object.values(PERIODIC_ASSESSMENT_SPECS);

  return <div className="assessment-push-panel">
    <div className="assessment-push-status">
      <div><span>开通状态</span><b className={push.enabled ? 'green-text' : ''}>{push.enabled ? '已按科目开通' : (push.optedOut ? '已全部停止' : '未开通')}</b><small>{push.enabled ? '点击停止可立即关闭对应科目和周期' : '点击开始后学生端立即可见'}</small></div>
      <div><span>已报名科目</span><b>{enrolledSubjects.length ? enrolledSubjects.join(' · ') : '未登记'}</b><small>仅已报名科目可开通自测</small></div>
      <div><span>出题服务</span><b>{isAiSlotReady(aiSettings, 'periodic_assessment') ? (getAiSlotConfig(aiSettings, 'periodic_assessment').model || '已接入') : '未就绪'}</b><small>{isAiSlotReady(aiSettings, 'periodic_assessment') ? '自测题目按学员计划生成' : '请先在监管机器人完成配置'}</small></div>
    </div>

    {enrolledSubjects.length ? <div className="assessment-subject-permission-list">
      {enrolledSubjects.map(subject => <article className="assessment-subject-permission" key={subject}>
        <div><span className="eyebrow">{subject}</span><h3>{subject}自测权限</h3><p>不设置起止日期。开始后，该科目的对应测试立即对学生开放。</p></div>
        <div className="assessment-type-toggle-grid">
          {typeSpecs.map(spec => {
            const on = isAssessmentTypeEnabled(push, spec.id, subject);
            return <button type="button" key={spec.id} className={`assessment-type-toggle tone-${spec.tone} ${on ? 'is-on' : ''}`} onClick={() => {
              if (!on && !(student?.assignedPlans || []).length) notify('该学员尚未布置复习计划，当前会先使用基础练习题。');
              onToggleType(subject, spec.id, !on);
            }}>
              <div><b>{spec.short}</b><small>{on ? '已开始' : '未开始'}</small></div>
              <span>{on ? '停止' : '开始'}</span>
            </button>;
          })}
        </div>
      </article>)}
    </div> : <div className="empty-line"><FileQuestion size={20}/><span>请先在学员档案中登记已报名科目，再为对应科目开始自测。</span></div>}

    <div className="assessment-push-preview-grid">
      {modules.map(item => <article className={`assessment-push-chip tone-${item.tone} ${item.enabled ? 'is-enabled' : 'is-off'}`} key={item.id}><b>{item.title}</b><span>{getAssessmentSpecFormat(item)}</span><small>{item.enabled ? '学生端已开放' : '未开始'}</small></article>)}
    </div>

    <div className="form-footer">
      {push.enabled ? <button type="button" className="secondary" onClick={() => onApply(false)}>全部停止</button> : <button type="button" className="primary" onClick={() => onApply(true)}>全部开始</button>}
      {isPaid && <small>付费学员默认可全开，仍可按科目和测试类型分别停止。</small>}
    </div>
  </div>;
}

function StudentAssessmentArchive({student, entranceState, setEntranceState, selector, notify, aiSettings, onOpenAssessment}) {
  const [tab, setTab] = useState('pending');
  const pendingEntrance = getPendingEntranceAssessments(student, entranceState);
  const pendingPeriodic = getStudentAssessmentModules(student, aiSettings)
    .filter(item => item.isToday && item.enabled && (item.actionable || isApiConfigured()));
  const completed = getStudentAssessmentArchive(student, entranceState);

  const openEntranceAssessment = async distribution => {
    if (isApiConfigured() && distribution?.id) {
      try {
        const access = await apiRequest(`/api/student/exam-distributions/${encodeURIComponent(distribution.id)}/access`, { method:'POST' });
        setEntranceState(current => ({
          ...current,
          pendingDistributions: (current.pendingDistributions || []).filter(item => String(item.id) !== String(distribution.id))
        }));
        window.location.assign(`/exam/${encodeURIComponent(access.paperId)}/?token=${encodeURIComponent(access.shareToken)}`);
      } catch (error) {
        notify(error?.message || '打开试卷失败，请稍后重试');
      }
      return;
    }
    if (distribution?.shareUrl) {
      window.location.assign(distribution.shareUrl);
      return;
    }
    notify('该入学自测暂未生成可访问链接，请联系老师重新分发。');
  };

  const pendingCount = pendingEntrance.length + pendingPeriodic.length;
  return <>
    <section className="page-head student-practice-head"><div><span className="eyebrow">我的自测档案</span><h1>待完成与已完成，分开管理。</h1><p>老师分发的入学摸底，以及当天开放的日测、周测、月测会进入“待自测”；完成并提交后自动归入“已自测”。</p>{selector}</div></section>
    <section className="panel student-record-panel assessment-archive-panel">
      <div className="assessment-archive-tabs" role="tablist" aria-label="自测档案分类">
        <button type="button" role="tab" aria-selected={tab === 'pending'} className={tab === 'pending' ? 'active' : ''} onClick={() => setTab('pending')}>待自测{pendingCount > 0 && <b>{pendingCount > 99 ? '99+' : pendingCount}</b>}</button>
        <button type="button" role="tab" aria-selected={tab === 'completed'} className={tab === 'completed' ? 'active' : ''} onClick={() => setTab('completed')}>已自测<span>{completed.length}</span></button>
      </div>
      {tab === 'pending' ? <div className="assessment-pending-list">
        {pendingEntrance.map(item => <article className="assessment-pending-card entrance" key={`entrance-${item.id || item.paperId || item.paper_id}`}>
          <div className="assessment-pending-icon"><FileQuestion size={20}/></div>
          <div className="assessment-pending-main"><span className="eyebrow">老师分发 · 入学摸底</span><h3>{item.paperTitle || item.paper_title || '入学摸底试卷'}</h3><p>{item.startDeadlineAt || item.start_deadline_at ? `请在 ${new Date(item.startDeadlineAt || item.start_deadline_at).toLocaleString('zh-CN')} 前开始作答；开始后有 1 小时答题时间。` : '可开始作答；开始后有 1 小时答题时间。'}</p></div>
          <button type="button" className="primary" onClick={() => openEntranceAssessment(item)}>开始自测<ChevronRight size={16}/></button>
        </article>)}
        {pendingPeriodic.map(item => <article className="assessment-pending-card periodic" key={`periodic-${item.id}`}>
          <div className="assessment-pending-icon"><ClipboardCheck size={20}/></div>
          <div className="assessment-pending-main"><span className="eyebrow">今日开放 · {item.short || item.title}</span><h3>{item.title}</h3><p>{item.actionable ? (item.status || '当前可开始作答。') : isApiConfigured() ? '服务端出题器尚未可用，当前保留待处理状态，不生成本地题目。' : (item.status || '当前可开始作答。')}</p></div>
          <button type="button" className={item.actionable || isApiConfigured() ? 'primary' : 'secondary'} disabled={!item.actionable && !isApiConfigured()} onClick={() => onOpenAssessment?.(item)}>{item.actionable ? '开始测试' : isApiConfigured() ? '查看题目集' : '暂不可用'}<ChevronRight size={16}/></button>
        </article>)}
        {!pendingCount && <div className="empty-line"><Check size={20}/><span>当前没有待完成的自测。老师分发新试卷或当天的日测、周测、月测开放后，会自动显示在这里。</span></div>}
      </div> : <AssessmentArchive student={student} entranceState={entranceState} notify={notify}/>}
    </section>
  </>;
}

function AssessmentArchive({student, entranceState, notify}) {
  const baseRecords = getStudentAssessmentArchive(student, entranceState);
  // 周期自测主观题批改：本地草稿与已批改覆盖（批改成功后即时反映，不等整页重载）。
  const [gradingDrafts, setGradingDrafts] = useState({});
  const [gradedOverrides, setGradedOverrides] = useState({});
  const [gradingBusyId, setGradingBusyId] = useState('');
  const records = baseRecords.map(item => gradedOverrides[item.id] ? { ...item, ...gradedOverrides[item.id] } : item);
  const isUuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
  const isPendingPeriodic = record => record.kind !== 'entrance'
    && ['pending_review', '部分待批改', '待批改'].includes(record.gradingStatus || record.status)
    && isUuid(record.id);
  const submitPeriodicGrading = async record => {
    const draft = gradingDrafts[record.id] || {};
    const rawScore = String(draft.score ?? '').trim();
    if (rawScore === '') return notify('请先填写主观题成绩');
    const subjectiveScore = Number(rawScore);
    if (!Number.isFinite(subjectiveScore) || subjectiveScore < 0) return notify('主观题成绩无效');
    setGradingBusyId(record.id);
    try {
      const result = await apiRequest(`/api/admin/assessment-records/${encodeURIComponent(record.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ subjectiveScore, gradingNote: String(draft.note || '').trim(), gradingStatus: 'graded' })
      });
      setGradedOverrides(current => ({
        ...current,
        [record.id]: {
          gradingStatus: 'graded',
          status: '已批改',
          score: result.score,
          subjectiveScore: result.subjectiveScore,
          gradedAt: result.gradedAt || new Date().toISOString(),
          gradingNote: result.gradingNote || ''
        }
      }));
      notify(`已完成批改：总分 ${result.score} 分`);
    } catch (error) {
      notify(error?.message || '批改失败，请稍后重试');
    } finally {
      setGradingBusyId('');
    }
  };
  if (!records.length) {
    return <div className="empty-line"><FileQuestion size={20}/><span>该学员尚无自测记录。入学摸底在「自测」分发；日/周/月测开通后，成绩与答案会自动汇总到本档案（测完归档，不结束学情跟踪）。</span></div>;
  }
  const entranceCount = records.filter(item => item.kind === 'entrance').length;
  const periodicCount = records.length - entranceCount;
  return <div className="assessment-archive">
    <div className="assessment-archive-summary">
      <span>共 {records.length} 次</span>
      <span>入学摸底 {entranceCount}</span>
      <span>日/周/月 {periodicCount}</span>
      <small>入学自测测完即归档为基线；后续日测、周测、月测的成绩与答案持续写入本模块，供教师与 AI 跟进。</small>
    </div>
    <div className="entrance-archive-list">
      {records.map(record => {
        const subjectSummary = record.subjectScores ? Object.keys(record.subjectScores).map(subject => {
          const total = record.subjectTotals?.[subject] || 0;
          const score = record.subjectScores[subject] || 0;
          return { subject, score, total, ratio: total ? Math.round((score / total) * 100) : 0 };
        }) : [];
        const wrongQuestions = record.wrongQuestions || [];
        return <article className="entrance-archive-card" key={record.id}>
          <header className="entrance-archive-head">
            <div>
              <span className={`eyebrow assessment-kind-tag kind-${record.kind}`}>{record.kindLabel}</span>
              <h3>{record.title}</h3>
              <small>
                {record.submittedAt ? `提交：${new Date(record.submittedAt).toLocaleString('zh-CN')}` : '时间待同步'}
                {record.gradedAt && ` · 批改：${new Date(record.gradedAt).toLocaleString('zh-CN')}`}
                {record.studyDay != null && ` · 学习日第 ${record.studyDay} 天`}
              </small>
            </div>
            <div className="entrance-archive-score">
              <b>{typeof record.score === 'number' ? `${record.score} / ${record.total || '—'}` : '待批改'}</b>
              <span className={`badge ${record.status === '已批改' || record.status === '已完成' ? 'ok' : 'warn'}`}>{record.status}</span>
              {record.objectiveScore != null && <small>客观分：{record.objectiveScore} / {record.objectiveTotal ?? record.total ?? '—'}</small>}
              {record.subjectiveScore != null ? <small>主观分：{record.subjectiveScore} / {record.subjectiveTotal ?? record.total ?? '—'}</small> : record.wrongQuestions.some(item => item.gradingStatus === '待批改' || item.kind === 'short_answer' || item.kind === 'translation') ? <small>主观题：待老师批改</small> : null}
            </div>
          </header>
          {subjectSummary.length > 0 && <div className="entrance-subject-grid">
            {subjectSummary.map(item => (
              <div className="entrance-subject-cell" key={item.subject}>
                <span>{item.subject}</span>
                <b>{item.ratio}%</b>
                <small>{item.score} / {item.total}</small>
              </div>
            ))}
          </div>}
          {record.aiFeedback && <p className="entrance-feedback"><b>AI 反馈：</b>{record.aiFeedback}</p>}
          {record.answersNote && <p className="entrance-feedback assessment-answers-note">{record.answersNote}</p>}
          {record.gradingNote && <p className="entrance-feedback"><b>批改评语：</b>{record.gradingNote}</p>}
          {Array.isArray(record.subjectiveReview) && record.subjectiveReview.length > 0 && <div className="subjective-review-list">
            <h4>主观题作答与参考答案（{record.subjectiveReview.length}）</h4>
            {record.subjectiveReview.map((item, reviewIndex) => <div className="subjective-review-item" key={`${record.id}-sr-${item.itemIndex ?? reviewIndex}`}>
              <b>{item.stem}（{item.score} 分）</b>
              <p><span>学生作答：</span>{item.studentAnswer || '未作答'}</p>
              <p><span>参考答案：</span>{item.referenceAnswer || '—'}</p>
              {item.knowledgePoint && <small>知识点：{item.knowledgePoint}</small>}
            </div>)}
          </div>}
          {isPendingPeriodic(record) && <div className="periodic-grading-panel">
            <b>主观题批改</b>
            <div className="periodic-grading-row">
              <label>主观分<input type="number" min="0" step="0.5" value={(gradingDrafts[record.id] || {}).score ?? ''} onChange={event => setGradingDrafts(current => ({ ...current, [record.id]: { ...(current[record.id] || {}), score: event.target.value } }))} placeholder="主观题得分"/></label>
              <label>评语<input value={(gradingDrafts[record.id] || {}).note ?? ''} onChange={event => setGradingDrafts(current => ({ ...current, [record.id]: { ...(current[record.id] || {}), note: event.target.value } }))} placeholder="选填：给学生的一句反馈"/></label>
              <button type="button" className="primary" disabled={gradingBusyId === record.id} onClick={() => submitPeriodicGrading(record)}>{gradingBusyId === record.id ? '正在提交…' : '完成批改'}</button>
            </div>
          </div>}
          <h4>错题与知识点（{wrongQuestions.length}）</h4>
          {wrongQuestions.length === 0
            ? <p className="entrance-feedback">本次无错题记录，或批改结果尚未回写。</p>
            : <ol className="entrance-wrong-list">
                {wrongQuestions.map((item, index) => (
                  <li key={item.questionId || `${record.id}-w-${index}`}>
                    <div><b>{item.subject || '综合'} · 第 {item.number || index + 1} 题</b><small>正确答案：{Array.isArray(item.correctAnswer) ? item.correctAnswer.join('、') : (item.correctAnswer || '—')} · 学生作答：{String(item.studentAnswer ?? item.answer ?? '') || '未作答'}</small></div>
                    {item.correctMethod && <p><b>正确做法：</b>{item.correctMethod}</p>}
                    {item.knowledgePointExplanation && <p><b>知识点解析：</b>{item.knowledgePointExplanation}</p>}
                  </li>
                ))}
              </ol>
          }
        </article>;
      })}
    </div>
  </div>;
}

/** @deprecated 使用 AssessmentArchive；保留别名避免遗漏引用 */
function EntranceTestArchive(props) {
  return <AssessmentArchive {...props}/>;
}

const normalizeGradingStatusLabel = value => ({
  graded: '已批改',
  partially_graded: '部分待批改',
  pending_review: '待批改',
  '已批改': '已批改',
  '部分待批改': '部分待批改',
  '待批改': '待批改'
}[value] || '待批改');
const getQuestionType = question => {
  const value = question?.questionType || question?.question_type || question?.kind || 'single_choice';
  return value === 'selection' ? 'single_choice' : value;
};
const isMultipleChoiceQuestion = question => getQuestionType(question) === 'multiple_choice';
const getQuestionOptionKey = (option, index) => typeof option === 'object'
  ? String(option.key || String.fromCharCode(65 + index))
  : String.fromCharCode(65 + index);
const getQuestionOptionText = option => typeof option === 'object' ? option.text : option;
const getStoredQuestionAnswer = (answers, question, key) => {
  const candidates = [key, question?.id, question?.itemIndex, question?.number - 1].filter(value => value !== undefined && value !== null);
  return candidates.reduce((found, candidate) => found !== undefined ? found : answers?.[candidate], undefined);
};
const toggleMultipleChoiceAnswer = (answers, key, value) => {
  const current = normalizeMultipleChoiceAnswer(answers?.[key]);
  const next = current.includes(value) ? current.filter(item => item !== value) : [...current, value];
  return next.sort();
};

function flattenPaperQuestions(paper) {
  const result = [];
  if (!paper?.sections) return result;
  if (Array.isArray(paper.sections.server)) {
    paper.sections.server.forEach(question => {
      const questionType = question.questionType || question.question_type || question.kind || 'single_choice';
      const correctAnswer = question.correctAnswer ?? question.answer;
      result.push({
        ...question,
        subject: question.subject || paper.subject || '综合',
        subjectLabel: question.subject || paper.subject || '综合',
        kind: questionType,
        questionType,
        prompt: question.prompt || question.stem || '',
        options: Array.isArray(question.options) ? question.options : [],
        answer: correctAnswer,
        correctAnswer,
        knowledge: question.knowledge || question.knowledgePoint || '',
      });
    });
    return result;
  }

  if (paper.sections.政治) {
    paper.sections.政治.forEach(question =>
      result.push({ ...question, subject: '政治', subjectLabel: '政治', kind: 'selection' })
    );
  }
  if (paper.sections.英语) {
    paper.sections.英语.vocabulary.forEach(question =>
      result.push({ ...question, subject: '英语', subjectLabel: '英语·实词辨析', kind: 'selection', prompt: question.word })
    );
    paper.sections.英语.grammar.forEach(question =>
      result.push({ ...question, subject: '英语', subjectLabel: '英语·语法填空', kind: 'selection', prompt: question.sentence })
    );
    paper.sections.英语.translation.forEach(question =>
      result.push({ ...question, subject: '英语', subjectLabel: '英语·英译中', kind: 'selection', prompt: question.sentence })
    );
  }
  if (paper.sections.数学) {
    paper.sections.数学.forEach(question =>
      result.push({ ...question, subject: '数学', subjectLabel: '数学', kind: 'selection' })
    );
  }

  return result;
}

function gradeEntrancePaper(paper, answers) {
  const questions = flattenPaperQuestions(paper);
  let score = 0;
  let objectiveScore = 0;
  let subjectiveScore = null;
  const total = questions.reduce((sum, question) => sum + (Number(question.score) || 2), 0);
  const subjectScores = {};
  const subjectTotals = {};
  const wrongQuestions = [];
  let hasSubjective = false;

  questions.forEach(question => {
    const points = Number(question.score) || 2;
    const subject = question.subject || paper.subject || '综合';
    subjectTotals[subject] = (subjectTotals[subject] || 0) + points;
    const questionType = getQuestionType(question);
    const objective = ['single_choice', 'multiple_choice', 'true_false', 'fill_blank'].includes(questionType);
    const studentAnswer = answers?.[question.id];
    const correct = objective && answersMatch(studentAnswer, question.correctAnswer ?? question.answer, questionType === 'multiple_choice');
    if (correct) {
      score += points;
      objectiveScore += points;
      subjectScores[subject] = (subjectScores[subject] || 0) + points;
    } else {
      if (!objective) hasSubjective = true;
      wrongQuestions.push({
        questionId: question.id,
        subject,
        number: question.number,
        kind: questionType,
        prompt: question.prompt,
        correctAnswer: question.correctAnswer ?? question.answer,
        studentAnswer: studentAnswer ?? '',
        gradingStatus: objective ? '客观题已判错' : '待批改',
        correctMethod: deriveCorrectMethod(question),
        knowledgePointExplanation: question.knowledge
      });
    }
  });

  const gradingStatus = hasSubjective ? '部分待批改' : '已批改';
  const aiFeedback = buildEntranceFeedback(subjectScores, subjectTotals, objectiveScore, total);
  return { score: hasSubjective ? null : score, objectiveScore, subjectiveScore, total, gradingStatus, subjectScores, subjectTotals, wrongQuestions, aiFeedback };
}

function deriveCorrectMethod(question) {
  if (question.subject === '政治') return `正确答案为 ${question.answer}。${question.knowledge} 复习时应结合具体提法，把核心关键词与易混淆项对照记忆。`;
  if (question.subject === '数学') return `正确答案为 ${question.answer}。${question.knowledge} 复习时建议先重温教材中的公式与等价无穷小，再独立重做两道同类型题巩固。`;
  return `正确答案为 ${question.answer}。${question.knowledge}`;
}

function buildEntranceFeedback(subjectScores, subjectTotals, score, total) {
  const overall = total ? Math.round((score / total) * 100) : 0;
  const [subject] = Object.keys(subjectScores);
  const ratio = subjectTotals[subject]
    ? Math.round((subjectScores[subject] / subjectTotals[subject]) * 100)
    : 0;

  if (ratio < 50) {
    return `${subject} 正确率 ${ratio}%，当前基础尚未达到考研入门要求。建议先回到专升本衔接知识与考研基础教材，按章节补齐概念、公式或语法，再进行同类题复测。`;
  }
  if (ratio < 70) {
    return `${subject} 正确率 ${ratio}%，已具备部分基础，但考研入门知识仍有缺口。建议完成对应基础模块、整理错题后再做一次复测。`;
  }
  if (ratio < 85) {
    return `${subject} 正确率 ${ratio}%，基础较稳，可在巩固薄弱知识点后进入考研提高阶段任务。`;
  }
  return `${subject} 正确率 ${ratio}%，考研基础掌握较好，可以按老师安排进入提高阶段训练。`;
}

function AiCenter({open}) {return <><section className="page-head"><div><span className="eyebrow">统一 AI 能力与治理</span><h1>让模型成为能力层，不成为数据孤岛。</h1><p>统一接入不同模型供应商、知识库、工具、任务与审计；能力输出默认先由规则和老师约束。</p></div><button className="primary" onClick={() => open('ai-provider')}><Settings2 size={16}/>配置模型服务</button></section><div className="ai-grid">{aiCapabilities.map((x,i)=><article className="ai-card" key={x.name}><span>0{i+1}</span><BrainCircuit size={24}/><h3>{x.name}</h3><p>{x.description}</p><button className="quiet-button" onClick={() => open('ai-detail')}>配置规则<ChevronRight size={15}/></button></article>)}</div><section className="panel architecture"><PanelHead title="AI 数据与安全边界"/><div className="architecture-flow"><div>学习事件<br/><small>看课、任务、作答、工具</small></div><ChevronRight/><div>学习画像<br/><small>可追溯指标</small></div><ChevronRight/><div>AI 编排层<br/><small>权限、提示词、模型、工具</small></div><ChevronRight/><div>人工确认<br/><small>老师发布或复核</small></div></div><p>所有生成内容应保留版本、输入数据范围、模型提供商、人工状态与操作日志；不将学生敏感信息直接用于未授权模型服务。</p></section></>}
function Moderation({posts,setPosts,notify}) {
  const pendingPosts = (posts || []).filter(post => post.state === '待审核');
  const review = async (id, state) => {
    const note = state === '已公开' ? '审核通过' : '审核驳回';
    if (isApiConfigured()) {
      const target = (posts || []).find(p => String(p.id) === String(id));
      if (target?.isServerManaged) {
        try {
          await apiRequest(`/api/admin/posts/${id}/review`, {
            method: 'POST',
            body: { state, reviewNote: note }
          });
        } catch (error) {
          notify(error?.message || '审核操作失败，请稍后重试');
          return;
        }
      }
    }
    setPosts(current => current.map(post => post.id === id ? {...post, state, reviewedAt:new Date().toISOString()} : post));
    notify(state === '已公开' ? '帖子已通过并公开' : '帖子已驳回，审核记录已保留');
  };
  return <><section className="page-head"><div><span className="eyebrow">人工审核为最终边界</span><h1>先筛选风险，再保护讨论氛围。</h1><p>提交内容仅在老师审核通过后才会公开；驳回记录会保留在后台。</p></div></section><section className="panel"><PanelHead title="待审核队列" action={`${pendingPosts.length} 条待处理`}/>{pendingPosts.length ? pendingPosts.map(p => <div className="review" key={p.id}><div className="avatar">{p.author.slice(0,1)}</div><div className="review-main"><span>{p.author} · {p.topic} · {p.time}</span><h3>{p.title}</h3><p>{p.body}</p></div><div className="review-actions"><button className="secondary" onClick={() => review(p.id, '已驳回')}>驳回</button><button className="primary" onClick={() => review(p.id, '已公开')}>通过并公开</button></div></div>) : <div className="empty-line"><Check size={20}/><span>当前没有待审核的社区内容。</span></div>}</section></>}

/**
 * 审计日志面板：仅 admin 角色可访问。展示后端 audit_logs 接口。
 */
function AuditLogsPanel({notify}) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [filterAction, setFilterAction] = useState('');
  const [filterEntityType, setFilterEntityType] = useState('');
  const [limit, setLimit] = useState(100);

  const load = async () => {
    if (!isApiConfigured()) {
      setError('当前未连接后端服务，无法查看审计日志');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      params.set('limit', String(limit));
      if (filterAction.trim()) params.set('action', filterAction.trim());
      if (filterEntityType.trim()) params.set('entityType', filterEntityType.trim());
      const data = await apiRequest(`/api/admin/audit-logs?${params.toString()}`);
      setLogs(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err?.message || '加载审计日志失败');
      notify(err?.message || '加载审计日志失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [limit]);

  const exportCsv = () => {
    if (!logs.length) return notify('当前无可导出的审计日志');
    const header = ['id', 'created_at', 'actor_account_id', 'action', 'entity_type', 'entity_id', 'metadata'];
    const escape = value => {
      const s = value == null ? '' : String(value);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [header.join(',')];
    logs.forEach(log => {
      lines.push([
        log.id,
        log.created_at,
        log.actor_account_id,
        log.action,
        log.entity_type,
        log.entity_id,
        JSON.stringify(log.metadata || {})
      ].map(escape).join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="panel">
      <div className="panel-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2>审计日志</h2>
          <small>仅超级管理员可查看；记录最近 {limit} 条关键业务操作。</small>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="secondary" onClick={load} disabled={loading}>{loading ? '加载中…' : '刷新'}</button>
          <button type="button" className="secondary" onClick={exportCsv} disabled={!logs.length}>导出 CSV</button>
        </div>
      </div>
      <div className="exam-send-grid" style={{ marginTop: 12 }}>
        <label>操作类型<input value={filterAction} onChange={event => setFilterAction(event.target.value)} placeholder="例如：审核订单通过"/></label>
        <label>实体类型<input value={filterEntityType} onChange={event => setFilterEntityType(event.target.value)} placeholder="例如：order / student"/></label>
        <label>查询条数<select value={limit} onChange={event => setLimit(Number(event.target.value))}><option value={50}>50</option><option value={100}>100</option><option value={200}>200</option><option value={500}>500</option></select></label>
        <div style={{ display: 'flex', alignItems: 'flex-end' }}>
          <button type="button" className="primary" onClick={load} disabled={loading}>应用筛选</button>
        </div>
      </div>
      {error ? <div className="empty-line"><AlertTriangle size={18}/><span>{error}</span></div> : null}
      {logs.length ? (
        <div style={{ marginTop: 12, overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>操作</th>
                <th>实体</th>
                <th>操作人</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              {logs.map(log => (
                <tr key={log.id}>
                  <td><small>{log.created_at ? new Date(log.created_at).toLocaleString('zh-CN') : '—'}</small></td>
                  <td>{log.action}</td>
                  <td>{log.entity_type}{log.entity_id ? ` · ${log.entity_id}` : ''}</td>
                  <td>{log.actor_account_id || '系统'}</td>
                  <td><code style={{ fontSize: 12 }}>{JSON.stringify(log.metadata || {})}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : !loading && !error ? (
        <div className="empty-line"><ClipboardCheck size={20}/><span>当前没有匹配的审计日志。</span></div>
      ) : null}
    </section>
  );
}

/**
 * 监管机器人：侧栏一级入口。列表点卡片 → 进入子详情页，
 * 配置第三方模型 + 系统提示词 + 限制词（密钥仅服务端环境变量）。
 */
function SupervisionRobots({aiSettings, setAiSettings, notify}) {
  const [selectedRobotId, setSelectedRobotId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [restrictionText, setRestrictionText] = useState('');
  const models = getConfiguredModels(aiSettings);
  const readyCount = countReadyAiSlots(aiSettings);
  const groups = [
    ['纯文本监管', AI_MODEL_SLOTS.filter(item => item.capability === 'text')],
    ['读图 / OCR 监管', AI_MODEL_SLOTS.filter(item => item.capability === 'vision')],
    ['向量 / 检索', AI_MODEL_SLOTS.filter(item => item.capability === 'embedding')],
  ];
  const openRobot = robotId => {
    const config = getAiSlotConfig(aiSettings, robotId);
    setSelectedRobotId(robotId);
    setDraft(config);
    setRestrictionText((config.restrictionWords || []).join('，'));
  };
  const back = () => { setSelectedRobotId(null); setDraft(null); setRestrictionText(''); };
  const save = async () => {
    if (!selectedRobotId || !draft) return;
    const meta = getRobotMeta(selectedRobotId);
    if (!draft.modelId) return notify('请先在系统设置的「模型管理」中配置模型，再在此选择');
    if (!String(draft.systemPrompt || '').trim()) return notify('请填写系统提示词');
    if (isApiConfigured()) {
      // 生产模式：保存到服务端 ai_robots，任务执行器读取的就是这份配置。
      try {
        await apiRequest(`/api/admin/ai/robots/${encodeURIComponent(selectedRobotId)}`, { method: 'PUT', body: {
          name: meta.robotName,
          capability: meta.capability,
          status: draft.enabled ? 'enabled' : 'configured',
          providerRef: draft.modelId,
          systemPrompt: String(draft.systemPrompt).trim(),
          restrictionWords: normalizeRestrictionWords(restrictionText),
          requiresHumanApproval: draft.requiresHumanApproval !== false,
          allowedTools: []
        }});
      } catch (error) {
        return notify(`保存失败：${error?.message || '请稍后重试'}`);
      }
      const nextServer = {
        ...defaultAiSlotConfig(meta), ...draft,
        systemPrompt: String(draft.systemPrompt).trim(),
        restrictionWords: normalizeRestrictionWords(restrictionText),
        lastSavedAt: new Date().toISOString(),
      };
      setAiSettings(current => ({...defaultAiSettings(), ...current, version:4, slots:{...(current.slots || {}), [selectedRobotId]:nextServer}}));
      setDraft(nextServer); setRestrictionText(nextServer.restrictionWords.join('，'));
      return notify(`已保存「${meta.robotName}」并同步到服务端，机器人任务可真实执行。`);
    }
    const model = getConfiguredModel(aiSettings, draft.modelId);
    if (!model) return notify('所选模型已停用或删除，请重新选择');
    const next = {
      ...defaultAiSlotConfig(meta), ...draft,
      modelId: model.id, model: model.model, endpoint: model.endpoint,
      provider: model.provider, secretRef: model.secretRef,
      systemPrompt: String(draft.systemPrompt).trim(),
      restrictionWords: normalizeRestrictionWords(restrictionText),
      lastSavedAt: new Date().toISOString(),
    };
    setAiSettings(current => ({...defaultAiSettings(), ...current, version:4, slots:{...(current.slots || {}), [selectedRobotId]:next}}));
    setDraft(next); setRestrictionText(next.restrictionWords.join('，'));
    notify(`已保存「${meta.robotName}」`);
  };
  if (selectedRobotId && draft) {
    const meta = getRobotMeta(selectedRobotId);
    const selectedModel = getConfiguredModel(aiSettings, draft.modelId);
    const compatibleModels = models.filter(item => item.category === meta.capability || (meta.capability === 'vision' && item.category === 'image') || (meta.capability === 'embedding' && item.category === 'other'));
    const selectableModels = compatibleModels.length ? compatibleModels : models;
    return <><section className="page-head"><div><span className="eyebrow">监管机器人 · 配置</span><h1>{meta.robotName}</h1><p>{meta.purpose}</p></div><button className="secondary" onClick={back}><ChevronLeft size={16}/>返回机器人列表</button></section><section className="panel robot-detail-panel"><div className="robot-detail-head"><div><span className={`ai-modality-tag modality-${meta.capability}`}>{meta.modality}</span><h2>模型选择 · 提示词 · 限制词</h2><p>模型统一由系统设置中的「模型管理」维护；这里仅选择已配置的模型。</p></div><span className={`badge ${selectedModel && draft.enabled ? 'ok' : 'warn'}`}>{selectedModel && draft.enabled ? '业务可用' : '未就绪'}</span></div><div className="robot-detail-section"><h3>1. 模型选择</h3><label className="robot-prompt-label"><span>已配置模型</span><select className="robot-model-select" value={draft.modelId || ''} onChange={event => { const model = getConfiguredModel(aiSettings, event.target.value); setDraft(current => ({...current, modelId:event.target.value, model:model?.model || '', endpoint:model?.endpoint || '', provider:model?.provider || '', secretRef:model?.secretRef || ''})); }}><option value="">请选择已配置模型</option>{selectableModels.map(model => <option key={model.id} value={model.id}>{model.name} · {model.model}</option>)}</select></label>{!models.length ? <div className="robot-config-empty"><Settings2 size={18}/><span>还没有可选模型。请先到「系统设置 → 模型管理」新增并测试模型。</span></div> : null}</div><div className="robot-detail-section"><div className="robot-detail-section-head"><h3>2. 系统提示词</h3><button type="button" className="quiet-button" onClick={() => setDraft(current => ({...current, systemPrompt:meta.defaultSystemPrompt || ''}))}>恢复默认</button></div><textarea className="robot-prompt-box" value={draft.systemPrompt || ''} onChange={event => setDraft(current => ({...current, systemPrompt:event.target.value}))} rows={10}/></div><div className="robot-detail-section"><h3>3. 限制词 / 禁用词</h3><textarea className="robot-prompt-box is-restriction" value={restrictionText} onChange={event => setRestrictionText(event.target.value)} rows={4}/><div className="robot-restriction-preview">{normalizeRestrictionWords(restrictionText).map(word => <span key={word}>{word}</span>)}</div></div><div className="ai-switch-row ai-switch-row-prominent"><AiToggle label={draft.enabled ? '已启用' : '启用该机器人'} enabled={!!draft.enabled} onChange={value => setDraft(current => ({...current, enabled:value}))}/></div><div className="form-footer"><button type="button" className="secondary" onClick={back}>返回列表</button><button type="button" className="primary" onClick={save}>保存机器人配置</button></div></section></>;
  }
  return <><section className="page-head"><div><span className="eyebrow">教师后台 · 监管机器人</span><h1>按业务用途调用已配置模型</h1><p>模型只在「系统设置 → 模型管理」中新增、测试、停用或删除；机器人只负责选择模型、设置提示词与限制词。</p></div><span className="badge ok">{readyCount}/{AI_MODEL_SLOTS.length} 已就绪</span></section><section className="panel robot-list-panel">{groups.map(([title, robots]) => <div className="robot-group" key={title}><div className="robot-group-head"><h3>{title}</h3><small>{robots.filter(robot => isAiSlotReady(aiSettings, robot.id)).length}/{robots.length} 已就绪</small></div><div className="robot-card-grid">{robots.map(robot => { const config=getAiSlotConfig(aiSettings,robot.id), model=getConfiguredModel(aiSettings,config.modelId), ready=isAiSlotReady(aiSettings,robot.id); return <button type="button" key={robot.id} className={`robot-card ${ready?'is-ready':''}`} onClick={() => openRobot(robot.id)}><div className="robot-card-top"><span className={`ai-modality-tag modality-${robot.capability}`}>{robot.modality}</span><span className={`badge ${ready?'ok':'warn'}`}>{ready?'已接入':config.enabled?'未填全':'未启用'}</span></div><div className="robot-card-icon"><Bot size={22}/></div><b>{robot.robotName}</b><p>{robot.purpose}</p><div className="robot-card-meta"><small>{model ? `${model.name} · ${model.model}` : '未选择模型'}</small></div><span className="robot-card-enter">进入配置 <ChevronRight size={14}/></span></button>; })}</div></div>)}</section></>;
}

function ServerProviderManagement({ aiSettings, setAiSettings, notify }) {
  const [providers, setProviders] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [form, setForm] = useState({ id: '', name: '', capability: 'text', baseUrl: '', secretRef: '', status: 'configured', timeoutMs: 10000, maxRetries: 1 });
  const [state, setState] = useState({ loading: true, saving: false, error: '' });
  const load = async () => {
    setState(current => ({ ...current, loading: true, error: '' }));
    try {
      const result = await apiRequest('/api/admin/ai/providers', { cache: 'no-store' });
      setProviders(Array.isArray(result) ? result : []);
      setState(current => ({ ...current, loading: false }));
    } catch (error) { setState({ loading: false, saving: false, error: error?.message || 'Provider 加载失败' }); }
  };
  useEffect(() => { load(); }, []);
  const select = provider => {
    setSelectedId(provider.id);
    setForm({ id: provider.id, name: provider.name || '', capability: provider.capability || 'text', baseUrl: provider.baseUrl || '', secretRef: provider.secretRef || '', status: provider.status || 'configured', timeoutMs: provider.timeoutMs || 10000, maxRetries: provider.maxRetries || 1 });
  };
  const save = async () => {
    const id = String(form.id || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    if (!id || id.length < 2) return notify('请填写至少 2 位 Provider 标识');
    if (!form.name.trim() || !form.baseUrl.trim() || !form.secretRef.trim()) return notify('请填写名称、服务地址和服务端密钥引用');
    setState(current => ({ ...current, saving: true, error: '' }));
    try {
      const saved = await apiRequest(`/api/admin/ai/providers/${encodeURIComponent(id)}`, { method: 'PUT', body: { ...form, id, name: form.name.trim(), baseUrl: form.baseUrl.trim(), secretRef: form.secretRef.trim(), timeoutMs: Number(form.timeoutMs) || 10000, maxRetries: Number(form.maxRetries) || 0 } });
      setProviders(current => [saved, ...current.filter(item => item.id !== saved.id)]);
      setSelectedId(saved.id); setForm(current => ({ ...current, id: saved.id }));
      setState(current => ({ ...current, saving: false }));
      notify('Provider 配置已保存；密钥仅由服务端读取');
    } catch (error) { setState(current => ({ ...current, saving: false, error: error?.message || 'Provider 保存失败' })); notify(error?.message || 'Provider 保存失败'); }
  };
  const test = async () => {
    if (!selectedId) return notify('请先保存并选择 Provider');
    setState(current => ({ ...current, saving: true, error: '' }));
    try { const result = await apiRequest(`/api/admin/ai/providers/${encodeURIComponent(selectedId)}/test`, { method: 'POST' }); notify(result?.message || 'Provider 测试完成'); await load(); }
    catch (error) { setState(current => ({ ...current, saving: false, error: error?.message || 'Provider 测试失败' })); notify(error?.message || 'Provider 测试失败'); }
  };
  return <section className="panel model-management-panel server-provider-panel">
    <div className="model-management-head"><div><span className="eyebrow">服务端 AI 配置</span><h2>Provider 管理</h2><p>浏览器只提交服务地址和服务端环境变量引用，不接收、不保存、不回显真实 API Key。</p></div><button type="button" className="secondary" onClick={load} disabled={state.loading}>{state.loading ? '加载中…' : '刷新'}</button></div>
    {state.error && <div className="inline-error" role="alert"><span>{state.error}</span><button type="button" className="secondary" onClick={load}>重试</button></div>}
    <div className="server-provider-layout"><div className="model-row-list">{providers.length ? providers.map(provider => <button type="button" className={`server-provider-row ${selectedId === provider.id ? 'is-selected' : ''}`} key={provider.id} onClick={() => select(provider)}><span><b>{provider.name}</b><small>{provider.id} · {provider.capability} · {provider.status}</small></span><em>{provider.lastTestStatus === 'passed' ? '测试通过' : provider.lastTestStatus === 'failed' ? '测试失败' : '未测试'}</em></button>) : !state.loading ? <div className="empty-line"><Bot size={19}/><span>尚未配置 Provider。</span></div> : null}</div><div className="server-provider-form"><label>Provider 标识<input value={form.id} onChange={event => setForm(current => ({ ...current, id: event.target.value }))} placeholder="例如 periodic-text"/></label><label>管理名称<input value={form.name} onChange={event => setForm(current => ({ ...current, name: event.target.value }))} placeholder="例如：主力文本服务"/></label><label>能力<select value={form.capability} onChange={event => setForm(current => ({ ...current, capability: event.target.value }))}><option value="text">文本</option><option value="vision">读图</option><option value="embedding">向量</option></select></label><label>服务地址<input value={form.baseUrl} onChange={event => setForm(current => ({ ...current, baseUrl: event.target.value }))} placeholder="https://provider.example/v1"/></label><label>服务端密钥引用<input value={form.secretRef} onChange={event => setForm(current => ({ ...current, secretRef: event.target.value }))} placeholder="例如 AI_PROVIDER_KEY" autoComplete="off"/><small>仅变量名；请勿粘贴 API Key。</small></label><label>状态<select value={form.status} onChange={event => setForm(current => ({ ...current, status: event.target.value }))}><option value="disabled">停用</option><option value="configured">已配置</option><option value="enabled">启用</option></select></label><div className="form-footer"><button type="button" className="secondary" onClick={test} disabled={state.saving || !selectedId}>服务端测试</button><button type="button" className="primary" onClick={save} disabled={state.saving}>{state.saving ? '正在保存…' : '保存 Provider'}</button></div></div></div>
  </section>;
}

function ModelManagement({aiSettings, setAiSettings, notify}) {
  const [draft, setDraft] = useState({category:'text', name:'', provider:'第三方 OpenAI 兼容接口', endpoint:'', model:'', apiKey:''});
  const [models, setModels] = useState([]);
  const [state, setState] = useState({status:'idle', message:''});
  const configured = Array.isArray(aiSettings?.models) ? aiSettings.models : [];
  const discover = async () => {
    if (isApiConfigured()) return setState({ status: 'error', message: '生产模式不会从浏览器访问 Provider；请由管理员在服务端配置 Provider 后再测试。' });
    setState({status:'loading',message:'正在读取服务商 /models 列表…'});
    try { const result=await discoverOpenAiModels({endpoint:draft.endpoint,apiKey:draft.apiKey}); setModels(result.models); setDraft(current=>({...current,endpoint:result.baseUrl,model:''})); setState({status:'success',message:`已获取 ${result.models.length} 个模型，请选择一个后保存。`}); }
    catch(error) { setModels([]); setState({status:'error',message:String(error?.message||'获取失败')}); }
  };
  const test = async () => {
    if (isApiConfigured()) return notify('生产模式必须调用服务端 Provider 测试接口；浏览器不会发送 API Key。');
    if(!draft.model) return notify('请先获取并选择模型');
    if(!draft.apiKey.trim()) return notify('请填写 API Key 后测试');
    try { await callOpenAiProvider(); } catch(error) { notify(`连接失败：${String(error?.message||'请求失败')}`); }
  };
  const save = () => {
    if (isApiConfigured()) return notify('请使用服务端 Provider 配置接口；浏览器不会保存模型凭证。');
    if(!draft.name.trim()) return notify('请填写该连接的管理名称');
    if(!draft.model) return notify('请从自动获取的列表中选择模型');
    if(!draft.endpoint.trim() || !draft.apiKey.trim()) return notify('请填写接口地址和 API Key');
    const { apiKey: _apiKey, ...safeDraft } = draft;
    const record={...safeDraft,id:`model-${Date.now()}`,name:draft.name.trim(),endpoint:cleanOpenAiBaseUrl(draft.endpoint),secretRef:'仅当前操作使用，未保存',enabled:true,createdAt:new Date().toISOString()};
    setAiSettings(current=>({...defaultAiSettings(),...current,version:4,models:[...(current.models||[]),record]}));
    setDraft({category:'text',name:'',provider:'第三方 OpenAI 兼容接口',endpoint:'',model:'',apiKey:''});
    setModels([]); setState({status:'idle',message:''}); notify(`已加入模型管理：${record.name}（凭证未保存）`);
  };
  const toggle = id => setAiSettings(current=>({...current,models:(current.models||[]).map(model=>model.id===id?{...model,enabled:!model.enabled}:model)}));
  const remove = id => { if(!window.confirm('删除该模型连接吗？已选择它的机器人将提示重新选择模型。')) return; setAiSettings(current=>({...current,models:(current.models||[]).filter(model=>model.id!==id)})); };
  const categoryLabel = {text:'文本',image:'图片 / 读图',other:'其他'};
  return <section className="panel model-management-panel"><div className="model-management-head"><div><span className="eyebrow">统一模型目录</span><h2>模型管理</h2><p>按 CC Switch 的接入方式：填写服务商地址与长期 API Key，自动读取模型列表后选择模型。机器人只选择这里已保存的模型。</p></div><span className="badge ok">{configured.filter(item=>item.enabled).length} 个已启用</span></div><div className="model-add-grid"><label>分类<select value={draft.category} onChange={event=>setDraft(current=>({...current,category:event.target.value}))}><option value="text">文本</option><option value="image">图片 / 读图</option><option value="other">其他（向量等）</option></select></label><label>管理名称<input value={draft.name} onChange={event=>setDraft(current=>({...current,name:event.target.value}))} placeholder="例如：千问主力文本"/></label><label>供应商<select value={draft.provider} onChange={event=>setDraft(current=>({...current,provider:event.target.value}))}>{AI_PROVIDER_OPTIONS.map(item=><option value={item} key={item}>{item}</option>)}</select></label><label className="model-wide">接口地址<input value={draft.endpoint} onChange={event=>{setDraft(current=>({...current,endpoint:event.target.value,model:''}));setModels([]);}} placeholder="https://api.example.com 或 https://api.example.com/v1"/></label><label className="model-wide">API Key<input type="password" value={draft.apiKey} onChange={event=>setDraft(current=>({...current,apiKey:event.target.value}))} autoComplete="off" placeholder="用于后续调用、获取模型和连接测试"/></label><div className="model-fetch-row"><button type="button" className="secondary" onClick={discover} disabled={state.status==='loading'}>{state.status==='loading'?'正在获取…':'获取可用模型'}</button><small>自动读取 <code>/models</code>，避免名称填错。</small></div>{state.message?<p className={`ai-discovery-message is-${state.status}`}>{state.message}</p>:null}<label className="model-wide">模型<select value={draft.model} disabled={!models.length} onChange={event=>setDraft(current=>({...current,model:event.target.value}))}><option value="">{models.length?'请选择服务商返回的模型':'请先获取可用模型'}</option>{models.map(model=><option key={model.id} value={model.id}>{model.label}</option>)}</select></label><div className="form-footer model-actions"><button type="button" className="secondary" onClick={test}>测试连接</button><button type="button" className="primary" onClick={save}>新增模型</button></div></div><div className="model-library">{['text','image','other'].map(category=><section key={category}><h3>{categoryLabel[category]}</h3>{configured.filter(model=>model.category===category).length?<div className="model-row-list">{configured.filter(model=>model.category===category).map(model=><div className={`model-library-row ${model.enabled?'':'is-disabled'}`} key={model.id}><div><b>{model.name}</b><span>{model.model} · {model.provider}</span><small>{model.endpoint}</small></div><div className="row-actions"><button type="button" className="quiet-button" onClick={()=>toggle(model.id)}>{model.enabled?'停用':'启用'}</button><button type="button" className="danger-button" onClick={()=>remove(model.id)}>删除</button></div></div>)}</div>:<div className="model-library-empty">暂无{categoryLabel[category]}模型</div>}</section>)}</div></section>;
}

function Settings({notify, accounts, setAccounts, students, setStudents, currentAccount, aiSettings, setAiSettings}) {
  const [teacherName, setTeacherName] = useState('');
  const [teacherPhone, setTeacherPhone] = useState('');
  const [studentName, setStudentName] = useState('');
  const [studentPhone, setStudentPhone] = useState('');
  const [backupFileName, setBackupFileName] = useState('');
  const [serverAccounts, setServerAccounts] = useState([]);
  const [serverAccountsError, setServerAccountsError] = useState('');
  const apiMode = isApiConfigured();
  const isAdmin = currentAccount?.role === 'admin';
  const backupKeys = [ACCOUNTS_STORAGE_KEY, STUDENTS_STORAGE_KEY, AI_SETTINGS_STORAGE_KEY, REVIEW_PLANS_STORAGE_KEY, CONTENT_STORAGE_KEY, APPLICATIONS_STORAGE_KEY, ENTRANCE_PAPERS_STORAGE_KEY, COURSE_CATEGORY_STORAGE_KEY];

  useEffect(() => {
    if (!apiMode || !isAdmin) return undefined;
    let active = true;
    apiRequest('/api/admin/accounts').then(list => {
      if (!active) return;
      setServerAccounts(Array.isArray(list) ? list : []);
    }).catch(error => { if (active) setServerAccountsError(error?.message || '账号加载失败'); });
    return () => { active = false; };
  }, [apiMode, isAdmin]);

  const refreshServerAccounts = async () => {
    try {
      const list = await apiRequest('/api/admin/accounts');
      setServerAccounts(Array.isArray(list) ? list : []);
      setServerAccountsError('');
    } catch (error) {
      setServerAccountsError(error?.message || '账号加载失败');
    }
  };

  const submitServerAccount = async (role, draft, setDraft) => {
    if (!String(draft.name || '').trim()) return notify('请填写账号姓名');
    if (!/^1\d{10}$/.test(String(draft.phone || '').trim())) return notify('手机号须为 1 开头的 11 位数字');
    try {
      const { account, tempPassword } = await apiRequest('/api/admin/accounts', {
        method: 'POST',
        body: { role, name: draft.name.trim(), phone: draft.phone.trim(), mustChangePassword: true }
      });
      setServerAccounts(current => [account, ...current]);
      setDraft({ name: '', phone: '' });
      if (tempPassword) notify(`已创建${role === 'teacher' ? '教师' : '学生'}账号，初始密码：${tempPassword}`);
      else notify('已创建账号');
    } catch (error) {
      notify(error?.message || '创建账号失败');
    }
  };

  const patchServerAccount = async (accountId, patch) => {
    try {
      const result = await apiRequest(`/api/admin/accounts/${accountId}`, { method: 'PATCH', body: patch });
      const updated = result?.account || result;
      if (!updated?.id) throw new Error('服务器返回的账号数据不完整');
      setServerAccounts(current => current.map(item => item.id === accountId ? updated : item));
      if (result?.tempPassword) {
        window.alert(`一次性临时密码：${result.tempPassword}\n请通过安全渠道转交，并要求首次登录后修改密码。`);
      }
      notify(patch.resetPassword || patch.mustChangePassword ? '已重置临时密码，账号下次登录必须修改密码' : '账号已更新');
    } catch (error) {
      notify(error?.message || '更新账号失败');
    }
  };

  const removeServerAccount = async (accountId) => {
    if (!window.confirm('确认删除该账号？')) return;
    try {
      await apiRequest(`/api/admin/accounts/${accountId}`, { method: 'DELETE' });
      setServerAccounts(current => current.filter(item => item.id !== accountId));
      notify('账号已删除');
    } catch (error) {
      notify(error?.message || '删除账号失败');
    }
  };

  const exportBackup = () => {
    if (apiMode) return notify('API 模式下使用服务端备份，无需导出本地数据');
    const data = backupKeys.reduce((result, key) => ({...result, [key]: window.localStorage.getItem(key)}), {});
    const blob = new Blob([JSON.stringify({version:1, exportedAt:new Date().toISOString(), data}, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `上岸督学平台-本地备份-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    notify('本地数据备份已导出，请妥善保存该文件');
  };
  const importBackup = file => {
    if (apiMode) return notify('API 模式下请使用服务端备份');
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || '{}'));
        if (!parsed?.data || typeof parsed.data !== 'object') throw new Error('invalid');
        if (!window.confirm('恢复会覆盖当前浏览器内的本地数据，是否继续？')) return;
        backupKeys.forEach(key => {
          const value = parsed.data[key];
          if (typeof value === 'string') window.localStorage.setItem(key, value);
          else window.localStorage.removeItem(key);
        });
        notify('本地数据已恢复，页面将重新加载');
        window.setTimeout(() => window.location.reload(), 700);
      } catch (error) { notify('备份文件无法识别，请选择由本平台导出的 JSON 文件'); }
    };
    reader.onerror = () => notify('读取备份文件失败');
    reader.readAsText(file);
  };
  const createAccount = (role, name, phone) => {
    const normalized = normalizePhone(phone);
    if (!String(name || '').trim()) return notify('请填写账号姓名');
    if (!isPhoneNumber(normalized)) return notify('手机号须为 1 开头的 11 位数字');
    if (accounts.some(item => normalizePhone(item.phone) === normalized)) return notify('该手机号已被使用');
    const studentId = role === 'student' ? `student-${Date.now()}` : null;
    const next = { id: `${role}-${Date.now()}`, role, studentId, name: name.trim(), phone: normalized, passwordHash: hashLocalPassword(DEMO_ACCOUNT_PASSWORD), status: '启用', mustChangePassword: true, createdAt: new Date().toISOString(), lastLoginAt: null };
    if (role === 'student') setStudents(current => [{ id: studentId, intakeToken: createIntakeToken(), name: name.trim(), year: '考研年份待填写', status: '新人', subjects: [], progress: 0, stage: '基础', phone: maskPhone(normalized), school: '目标院校待定', targetScore: '待设置', evaluation: '待老师完善学情档案。' }, ...current]);
    setAccounts(current => [...current, next]);
    if (role === 'teacher') { setTeacherName(''); setTeacherPhone(''); } else { setStudentName(''); setStudentPhone(''); }
    notify(`已创建${role === 'teacher' ? '教师' : '学生'}演示账号，初始演示密码为 ${DEMO_ACCOUNT_PASSWORD}，首次登录后必须修改`);
  };
  const resetPassword = account => {
    setAccounts(current => current.map(item => item.id === account.id ? { ...item, passwordHash: hashLocalPassword(DEMO_ACCOUNT_PASSWORD), mustChangePassword: false, authVersion:Number(item.authVersion || 0) + 1 } : item));
    notify(`已将 ${account.name} 的密码重置为统一默认密码`);
  };
  const toggleStatus = account => setAccounts(current => current.map(item => item.id === account.id ? { ...item, status: item.status === '启用' ? '停用' : '启用', authVersion:Number(item.authVersion || 0) + 1 } : item));
  const deleteAccount = account => {
    if (!account || account.id === currentAccount?.id) return notify('当前登录账号不能删除');
    if (!window.confirm(`删除「${account.name}」的登录账号吗？${account.role === 'student' ? '学员档案、课程、任务和学习记录不会删除。' : ''}`)) return;
    setAccounts(current => current.filter(item => item.id !== account.id));
    notify(account.role === 'student' ? `已删除 ${account.name} 的登录账号，学员档案与学习记录已保留` : `已删除 ${account.name} 的教师账号`);
  };
  const teacherAccounts = apiMode ? serverAccounts.filter(item => ['teacher', 'admin'].includes(item.role)) : accounts.filter(item => ['teacher', 'admin'].includes(item.role));
  const studentAccounts = apiMode ? serverAccounts.filter(item => item.role === 'student') : accounts.filter(item => item.role === 'student');
  const formatLastLogin = value => value ? new Date(value).toLocaleString('zh-CN') : '尚未登录';
  const teacherRows = teacherAccounts.map(item => apiMode ? (
    <tr key={item.id}>
      <td><b>{item.name}</b></td>
      <td>{maskPhone(item.phone)}</td>
      <td>{item.role === 'admin' ? '平台管理员' : '教师'}</td>
      <td><span className={`badge ${item.status === '启用' ? 'ok' : 'warn'}`}>{item.status}</span></td>
      <td>{formatLastLogin(item.lastLoginAt)}</td>
      {isAdmin && <td>{item.id === currentAccount.id ? <span className="muted-text">当前账号</span> : <div className="row-actions"><button className="quiet-button" onClick={() => patchServerAccount(item.id, { resetPassword: true })}>重置密码</button><button className="quiet-button" onClick={() => patchServerAccount(item.id, { status: item.status === '启用' ? '停用' : '启用' })}>{item.status === '启用' ? '停用' : '启用'}</button><button className="danger-button" onClick={() => removeServerAccount(item.id)}>删除账号</button></div>}</td>}
    </tr>
  ) : (
    <tr key={item.id}>
      <td><b>{item.name}</b></td>
      <td>{maskPhone(item.phone)}</td>
      <td>{item.role === 'admin' ? '平台管理员' : '教师'}</td>
      <td><span className={`badge ${item.status === '启用' ? 'ok' : 'warn'}`}>{item.status}</span></td>
      <td>{formatLastLogin(item.lastLoginAt)}</td>
      {isAdmin && <td>{item.id === currentAccount.id ? <span className="muted-text">当前账号</span> : <div className="row-actions"><button className="quiet-button" onClick={() => resetPassword(item)}>重置密码</button><button className="quiet-button" onClick={() => toggleStatus(item)}>{item.status === '启用' ? '停用' : '启用'}</button><button className="danger-button" onClick={() => deleteAccount(item)}>删除账号</button></div>}</td>}
    </tr>
  ));
  const studentRows = studentAccounts.map(item => apiMode ? (
    <tr key={item.id}>
      <td><b>{item.name}</b></td>
      <td>{maskPhone(item.phone)}</td>
      <td><span className={`badge ${item.status === '启用' ? 'ok' : 'warn'}`}>{item.status}</span></td>
      <td>{formatLastLogin(item.lastLoginAt)}</td>
      {isAdmin && <td><div className="row-actions"><button className="quiet-button" onClick={() => patchServerAccount(item.id, { resetPassword: true })}>重置密码</button><button className="quiet-button" onClick={() => patchServerAccount(item.id, { status: item.status === '启用' ? '停用' : '启用' })}>{item.status === '启用' ? '停用' : '启用'}</button><button className="danger-button" onClick={() => removeServerAccount(item.id)}>删除账号</button></div></td>}
    </tr>
  ) : (
    <tr key={item.id}>
      <td><b>{item.name}</b></td>
      <td>{maskPhone(item.phone)}</td>
      <td><span className={`badge ${item.status === '启用' ? 'ok' : 'warn'}`}>{item.status}</span></td>
      <td>{formatLastLogin(item.lastLoginAt)}</td>
      {isAdmin && <td><div className="row-actions"><button className="quiet-button" onClick={() => resetPassword(item)}>重置密码</button><button className="quiet-button" onClick={() => toggleStatus(item)}>{item.status === '启用' ? '停用' : '启用'}</button><button className="danger-button" onClick={() => deleteAccount(item)}>删除账号</button></div></td>}
    </tr>
  ));

  return <>
    <section className="page-head"><div><span className="eyebrow">教师后台 · 账户与权限</span><h1>系统设置</h1><p>{apiMode ? 'API 模式下账号由后端管理；管理员可在此创建、停用、删除与重置教师和学生账号。' : '账号创建后长期有效。教师和学生均使用统一默认密码创建，管理员可随时重置；后台仅展示账号状态与登录记录，不展示密码内容。'}</p></div></section>
    {!isAdmin && <section className="panel"><div className="empty-line"><LockKeyhole size={20}/><span>只有平台管理员可创建、停用、删除或重置教师账号。账户操作请联系平台管理员。</span></div></section>}
    {isAdmin && apiMode && (
      <section className="settings-account-grid">
        <section className="panel"><PanelHead title="分发教师账号"/><div className="exam-send-grid"><label>教师姓名<input value={teacherName} onChange={event => setTeacherName(event.target.value)} placeholder="例如：张老师"/></label><label>手机号<input value={teacherPhone} onChange={event => setTeacherPhone(event.target.value)} placeholder="11 位手机号" inputMode="numeric"/></label><div className="form-footer"><button className="primary" onClick={() => submitServerAccount('teacher', { name: teacherName, phone: teacherPhone }, () => { setTeacherName(''); setTeacherPhone(''); })}><UserPlus size={16}/>创建教师账号</button></div></div></section>
        <section className="panel"><PanelHead title="创建学生账号"/><div className="exam-send-grid"><label>学生姓名<input value={studentName} onChange={event => setStudentName(event.target.value)} placeholder="例如：李同学"/></label><label>手机号<input value={studentPhone} onChange={event => setStudentPhone(event.target.value)} placeholder="11 位手机号" inputMode="numeric"/></label><div className="form-footer"><button className="primary" onClick={() => submitServerAccount('student', { name: studentName, phone: studentPhone }, () => { setStudentName(''); setStudentPhone(''); })}><UserPlus size={16}/>创建学生账号</button></div></div></section>
      </section>
    )}
    {isAdmin && !apiMode && <section className="settings-account-grid"><section className="panel"><PanelHead title="分发教师账号"/><div className="exam-send-grid"><label>教师姓名<input value={teacherName} onChange={event => setTeacherName(event.target.value)} placeholder="例如：张老师"/></label><label>手机号<input value={teacherPhone} onChange={event => setTeacherPhone(event.target.value)} placeholder="11 位手机号" inputMode="numeric"/></label><div className="form-footer"><button className="primary" onClick={() => createAccount('teacher', teacherName, teacherPhone)}><UserPlus size={16}/>创建长期账号</button></div></div></section><section className="panel"><PanelHead title="创建学生账号"/><div className="exam-send-grid"><label>学生姓名<input value={studentName} onChange={event => setStudentName(event.target.value)} placeholder="例如：李同学"/></label><label>手机号<input value={studentPhone} onChange={event => setStudentPhone(event.target.value)} placeholder="11 位手机号" inputMode="numeric"/></label><div className="form-footer"><button className="primary" onClick={() => createAccount('student', studentName, studentPhone)}><UserPlus size={16}/>创建长期账号</button></div></div></section></section>}
    {isAdmin && !apiMode && <section className="panel data-backup-panel"><PanelHead title="本地数据备份与恢复" action="仅当前浏览器"/><p>导出可保存当前账号、学员、任务、课程、订单和配置数据。恢复备份会覆盖本浏览器现有数据；备份文件可能包含学员信息，请勿通过公开渠道传播。</p><div className="form-footer"><button type="button" className="secondary" onClick={exportBackup}>导出本地备份</button><label className="primary file-button">选择备份并恢复<input type="file" accept="application/json,.json" onChange={event => { const file = event.target.files?.[0]; setBackupFileName(file?.name || ''); importBackup(file); event.target.value=''; }}/></label></div>{backupFileName ? <small className="data-backup-file">已选择：{backupFileName}</small> : null}</section>}
    {isAdmin && (apiMode ? <ServerProviderManagement aiSettings={aiSettings} setAiSettings={setAiSettings} notify={notify}/> : <ModelManagement aiSettings={aiSettings} setAiSettings={setAiSettings} notify={notify}/>)}
    {serverAccountsError && <section className="panel"><p className="error-line">{serverAccountsError} <button className="quiet-button" onClick={refreshServerAccounts}>重试</button></p></section>}
    <section className="panel table-panel"><PanelHead title="教师账号" action={`${teacherAccounts.length} 个`}/><table><thead><tr><th>姓名</th><th>手机号</th><th>角色</th><th>账号状态</th><th>最近登录</th>{isAdmin && <th>操作</th>}</tr></thead><tbody>{teacherRows}</tbody></table></section>
    <section className="panel table-panel"><PanelHead title="学生账号" action={`${studentAccounts.length} 个`}/><table><thead><tr><th>姓名</th><th>手机号</th><th>账号状态</th><th>最近登录</th>{isAdmin && <th>操作</th>}</tr></thead><tbody>{studentRows}</tbody></table></section>
    <div className="settings-grid"><SettingCard icon={Users} title="学生账号" text={apiMode ? '学生账号由后端统一管理，登录使用手机号与密码。' : '支持手机号密码注册，也支持管理员创建长期账号。统一默认密码创建后，用户可自行修改。'}/><SettingCard icon={ShieldCheck} title="教师账号" text="仅平台管理员可创建、停用、删除与重置教师账号，普通教师不能分发教师权限。"/><SettingCard icon={LockKeyhole} title="密码与会话" text="管理端不保存或显示明文密码。生产环境必须使用服务端 Argon2id 或 bcrypt 加盐散列与安全会话。"/><SettingCard icon={Bot} title="监管机器人" text="业务机器人配置仍在独立入口管理，账号设置不会混入模型凭证。"/></div>
    {isAdmin && apiMode && <AuditLogsPanel notify={notify}/>}
  </>;
}

function SettingCard({icon:Icon,title,text}) {return <article className="setting-card"><Icon size={25}/><h3>{title}</h3><p>{text}</p></article>}

function NotificationCenter({ account, close }) {
  const isStudent = account?.role === 'student';
  const [items, setItems] = useState(null);
  const load = () => {
    if (!isApiConfigured() || !isStudent) { setItems([]); return; }
    apiRequest('/api/student-notifications').then(list => setItems(Array.isArray(list) ? list : [])).catch(() => setItems([]));
  };
  useEffect(load, []);
  const openItem = async item => {
    if (!item.readAt) {
      try {
        const result = await apiRequest(`/api/student-notifications/${encodeURIComponent(item.id)}/read`, { method: 'POST' });
        setItems(current => (current || []).map(entry => entry.id === item.id ? { ...entry, readAt: result.readAt || new Date().toISOString() } : entry));
      } catch (error) { /* 已读失败不影响查看 */ }
    }
    // 试卷分发类通知点击后直接换发出作答凭证并进入作答页，
    // 不用再去“我的自测”里翻找这条试卷。
    if (item.entityType === 'entrance_distribution' && item.entityId) {
      try {
        const access = await apiRequest(`/api/student/exam-distributions/${encodeURIComponent(item.entityId)}/access`, { method: 'POST' });
        window.location.assign(`/exam/${encodeURIComponent(access.paperId)}/?token=${encodeURIComponent(access.shareToken)}`);
      } catch (error) { /* 试卷已结束或撤销时只标记已读 */ }
    }
  };
  const unread = (items || []).filter(item => !item.readAt).length;
  return <div className="account-menu-wrap"><div className="account-menu notification-menu" role="dialog" aria-label="通知中心">
    <div className="account-menu-heading"><strong>通知中心</strong><small>{isStudent ? (unread ? `${unread} 条未读` : '全部已读') : '教师端暂无站内通知'}</small></div>
    {items === null ? <div className="notification-item"><small>正在加载…</small></div>
      : items.length ? items.map(item => <button type="button" key={item.id} className={`notification-item ${item.readAt ? '' : 'is-unread'}`} onClick={() => openItem(item)}>
          <b>{item.title || '通知'}</b><small>{item.body || ''}</small><em>{item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN') : ''}</em>
        </button>)
      : <div className="notification-item"><small>{isStudent ? '暂无通知；老师上传资料、审核订单或分发试卷后会通知你。' : '暂无通知'}</small></div>}
    <button type="button" className="quiet-button" onClick={close}>收起</button>
  </div></div>;
}

function AccountSettingsModal({ type, account, student, close, notify, onStudentUpdated, onPasswordChanged, onSignedOut }) {
  const [draft, setDraft] = useState(() => ({
    name: student?.name || account?.name || '',
    year: student?.year || '',
    email: student?.email || '',
    shippingInfo: student?.shippingInfo || '',
    school: student?.school || '',
    targetScore: student?.targetScore || '',
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
    confirmation: '',
  }));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const submit = async event => {
    event.preventDefault();
    setError('');
    if (pending) return;
    setPending(true);
    try {
      if (type === 'student-password') {
        if (draft.newPassword.length < 12) throw new Error('新密码至少需要 12 位');
        if (draft.newPassword !== draft.confirmPassword) throw new Error('两次输入的新密码不一致');
        if (isApiConfigured()) {
          const changed = await apiRequest('/api/auth/change-password', { method: 'POST', suppressAuthExpired: true, body: { currentPassword: draft.currentPassword, newPassword: draft.newPassword } });
          // The change increments session_version, so explicitly log in again
          // and keep the replacement HttpOnly cookie instead of signing the
          // user out or continuing with a stale cookie. Keep the version from
          // either server response; never invent a client-side increment.
          const refreshed = await reauthenticateAfterPasswordChange(account, draft.newPassword);
          const sessionVersion = getSessionAuthVersion(refreshed, getSessionAuthVersion(changed, null));
          onPasswordChanged?.({ ...refreshed, sessionVersion, authVersion:sessionVersion });
        } else {
          if (!account || account.passwordHash !== hashLocalPassword(draft.currentPassword)) throw new Error('当前密码不正确');
          const nextVersion = Number(account.authVersion || 0) + 1;
          window.dispatchEvent(new CustomEvent('shangan:local-account-password-changed', { detail: { accountId: account.id, passwordHash: hashLocalPassword(draft.newPassword), authVersion: nextVersion } }));
          onPasswordChanged?.({ account: { ...account, mustChangePassword: false }, authVersion: nextVersion });
        }
        notify('密码已修改并保持当前登录状态');
        close();
        return;
      }
      if (type === 'student-delete') {
        if (isApiConfigured()) {
          throw new Error('学生注销需要平台审核与身份确认，当前服务端未开放不可逆注销接口；账号未发生变化。');
        }
        throw new Error('本地演示模式不提供账号注销；账号未发生变化。');
      }
      if (!draft.name.trim()) throw new Error('请填写昵称');
      if (isApiConfigured()) {
        const saved = await apiRequest(`/api/students/${encodeURIComponent(student.id)}`, {
          method: 'PATCH',
          body: {
            name: draft.name.trim(),
            year: draft.year.trim() || undefined,
            email: draft.email.trim() || null,
            shippingInfo: draft.shippingInfo.trim() || null,
            school: draft.school.trim() || null,
            targetScore: draft.targetScore.trim() || null,
          },
        });
        onStudentUpdated?.(saved);
        close();
        notify('账号资料已同步');
        return saved;
      }
      notify('账号资料已保存');
      close();
    } catch (caught) {
      setError(caught?.message || '操作失败，请稍后重试');
    } finally {
      setPending(false);
    }
  };
  const passwordMode = type === 'student-password';
  const deleteMode = type === 'student-delete';
  return <div className="modal-backdrop" onMouseDown={close}>
    <form className="modal account-settings-modal" onSubmit={submit} onMouseDown={event => event.stopPropagation()}>
      <button type="button" className="modal-close" onClick={close} aria-label="关闭"><X size={19}/></button>
      <span className="eyebrow">账号管理</span>
      <h2>{passwordMode ? '修改密码' : deleteMode ? '注销账号' : '修改账号资料'}</h2>
      <p>{passwordMode ? '密码只提交给服务端校验和更新，浏览器不会保存密码。' : deleteMode ? '注销涉及身份确认、审核和数据保留规则。当前接口未开放时不会伪装成功。' : '允许修改的资料会保存到服务端，并在重新登录后恢复。'}</p>
      {passwordMode ? <>
        <label>当前密码<input type="password" value={draft.currentPassword} onChange={event => setDraft(current => ({ ...current, currentPassword: event.target.value }))} autoComplete="current-password" disabled={pending} required/></label>
        <label>新密码<input type="password" value={draft.newPassword} onChange={event => setDraft(current => ({ ...current, newPassword: event.target.value }))} autoComplete="new-password" disabled={pending} required/></label>
        <label>确认新密码<input type="password" value={draft.confirmPassword} onChange={event => setDraft(current => ({ ...current, confirmPassword: event.target.value }))} autoComplete="new-password" disabled={pending} required/></label>
      </> : deleteMode ? <label>输入“注销账号”确认<input value={draft.confirmation} onChange={event => setDraft(current => ({ ...current, confirmation: event.target.value }))} placeholder="注销账号" disabled={pending}/></label> : <>
        <label>昵称<input value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} disabled={pending} required/></label>
        <label>考研年份<input value={draft.year} onChange={event => setDraft(current => ({ ...current, year: event.target.value }))} disabled={pending}/></label>
        <label>邮箱<input type="email" value={draft.email} onChange={event => setDraft(current => ({ ...current, email: event.target.value }))} disabled={pending}/></label>
        <label>报考学校<input value={draft.school} onChange={event => setDraft(current => ({ ...current, school: event.target.value }))} disabled={pending}/></label>
        <label>目标分数<input value={draft.targetScore} onChange={event => setDraft(current => ({ ...current, targetScore: event.target.value }))} disabled={pending}/></label>
        <label>收货信息<textarea value={draft.shippingInfo} onChange={event => setDraft(current => ({ ...current, shippingInfo: event.target.value }))} disabled={pending}/></label>
      </>}
      {error && <p className="auth-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="secondary" onClick={close} disabled={pending}>取消</button><button type="submit" className={deleteMode ? 'danger-button' : 'primary'} disabled={pending || (deleteMode && draft.confirmation !== '注销账号')}>{pending ? '正在保存…' : deleteMode ? '提交注销申请' : '保存修改'}</button></div>
    </form>
  </div>;
}

function Modal({type, close, notify}) {
  const info = useMemo(() => ({
    'ai-plan': ['AI 计划建议', 'AI 会读取你的已选通用计划、完成记录与错题趋势，生成一份「建议草案」。这不会自动覆盖当前计划。'],
    'plan-apply': ['查看复习计划', '在此查看该计划的阶段、任务与建议时长，不会直接修改老师已确认的个性化调整。'],
    'ai-detail': ['AI 能力规则', '为单个 AI 能力配置提示词、可用工具与人工复核规则；模型凭证由服务端统一管理。'],
    'ai-provider': ['配置模型服务', '模型凭证仅能由超级管理人员配置，应通过服务端环境变量保存，不进入浏览器或代码仓库。']
  }[type] || ['功能配置', '该功能暂未开放，如需使用请联系老师或平台管理员。']), [type]);
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal" onMouseDown={event => event.stopPropagation()}>
        <button className="modal-close" onClick={close} aria-label="关闭"><X size={19}/></button>
        <span className="eyebrow">功能状态说明</span>
        <h2>{info[0]}</h2>
        <p>{info[1]}</p>
        <div className="modal-actions">
          <button className="primary" onClick={close}>知道了</button>
        </div>
      </div>
    </div>
  );
}

export default App;
