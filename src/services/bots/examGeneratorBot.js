/**
 * C-09: 自测老师（每半月 AI 出卷）
 * 根据学生错题和薄弱点生成个性化半月自测试卷，支持自动批改和 AI 辅助评分。
 */

const dayjs = require('dayjs');
const ai = require('../ai');
const { logConversation } = require('../botManager');
const { safeJsonParse } = require('../taskService');

// ── 常量 ──

const DEFAULT_QUESTION_COUNT = 15;          // 默认试卷题目数量
const MIN_QUESTION_COUNT = 10;              // 最少题目数量
const MAX_QUESTION_COUNT = 20;              // 最多题目数量
const EXAM_DUE_DAYS = 14;                   // 试卷有效期（半月）
const OBJECTIVE_TYPES = ['single_choice', 'multiple_choice', 'true_false', '判断'];
const SUBJECTIVE_TYPES = ['fill_blank', 'short_answer', 'essay', '填空', '简答', '论述'];

// ── 内部工具 ──

/**
 * 解析 options 字段（支持 JSON 字符串或数组）
 */
function parseOptions(optionsRaw) {
  if (!optionsRaw) return [];
  if (Array.isArray(optionsRaw)) return optionsRaw;
  return safeJsonParse(optionsRaw, []);
}

/**
 * 判断是否为客观题
 */
function isObjectiveQuestion(questionType) {
  if (!questionType) return false;
  const type = String(questionType).toLowerCase();
  return OBJECTIVE_TYPES.some((t) => type.includes(t.toLowerCase()));
}

/**
 * 判断是否为客观题（别名）
 */
function isObjective(questionType) {
  return isObjectiveQuestion(questionType);
}

/**
 * 标准化答案（去除空白、转大写）
 */
function normalizeAnswer(answer) {
  if (answer === null || answer === undefined) return '';
  return String(answer).trim().toUpperCase();
}

/**
 * 对比客观题答案（支持多选逗号分隔）
 */
function compareAnswers(selected, correct) {
  const selectedNorm = normalizeAnswer(selected);
  const correctNorm = normalizeAnswer(correct);

  // 多选题：逗号分隔排序后对比
  if (selectedNorm.includes(',') || correctNorm.includes(',')) {
    const selectedSet = new Set(selectedNorm.split(/[,，]/).map((s) => s.trim()).filter(Boolean));
    const correctSet = new Set(correctNorm.split(/[,，]/).map((s) => s.trim()).filter(Boolean));
    if (selectedSet.size !== correctSet.size) return false;
    for (const item of selectedSet) {
      if (!correctSet.has(item)) return false;
    }
    return true;
  }

  return selectedNorm === correctNorm;
}

/**
 * 生成唯一试卷 ID（时间戳+随机数）
 */
function generateExamId() {
  return `exam_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── 核心功能：生成试卷 ──

/**
 * 分析学生错题和薄弱点
 * @param {Object} db - better-sqlite3 数据库实例
 * @param {number} studentId - 学生 ID
 * @returns {Object} { weakSubjects, weakTypes, wrongQuestions, totalWrong }
 */
function analyzeWeakPoints(db, studentId) {
  // 查询学生错题记录及题目信息
  const wrongRecords = db.prepare(`
    SELECT
      pr.question_id,
      pr.selected_answer,
      q.subject,
      q.question_type,
      q.textbook,
      q.stem,
      q.tag
    FROM practice_records pr
    JOIN questions q ON pr.question_id = q.id
    WHERE pr.student_id = ? AND pr.is_correct = 0
    ORDER BY pr.created_at DESC
    LIMIT 100
  `).all(studentId);

  if (!wrongRecords.length) {
    return { weakSubjects: [], weakTypes: [], wrongQuestions: [], totalWrong: 0 };
  }

  // 统计薄弱科目和题型
  const subjectStats = {};
  const typeStats = {};
  const wrongQuestionIds = [];

  for (const record of wrongRecords) {
    wrongQuestionIds.push(record.question_id);

    const subject = record.subject || '未分类';
    subjectStats[subject] = (subjectStats[subject] || 0) + 1;

    const qType = record.question_type || '未分类';
    typeStats[qType] = (typeStats[qType] || 0) + 1;
  }

  // 按错误频次排序，取前 3 个薄弱科目和题型
  const weakSubjects = Object.entries(subjectStats)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([subject]) => subject);

  const weakTypes = Object.entries(typeStats)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([type]) => type);

  return {
    weakSubjects,
    weakTypes,
    wrongQuestions: wrongQuestionIds,
    totalWrong: wrongRecords.length
  };
}

/**
 * 从题库智能抽取相似题目
 * @param {Object} db
 * @param {number} studentId
 * @param {Object} weakPoints - analyzeWeakPoints 结果
 * @param {number} targetCount - 目标抽取数量
 * @returns {Array<Object>} 题目数组
 */
function pickSimilarQuestions(db, studentId, weakPoints, targetCount) {
  const questions = [];
  const usedIds = new Set(weakPoints.wrongQuestions);

  // 策略 1：优先抽取与错题同科目同题型的题目（排除已做过的）
  if (weakPoints.weakSubjects.length && weakPoints.weakTypes.length) {
    const subjectPlaceholders = weakPoints.weakSubjects.map(() => '?').join(',');
    const typePlaceholders = weakPoints.weakTypes.map(() => '?').join(',');
    const excludedPlaceholders = weakPoints.wrongQuestions.length
      ? weakPoints.wrongQuestions.map(() => '?').join(',')
      : '';

    let sql = `
      SELECT * FROM questions
      WHERE subject IN (${subjectPlaceholders})
        AND question_type IN (${typePlaceholders})
        AND id NOT IN (
          SELECT question_id FROM practice_records WHERE student_id = ?
        )
      ${excludedPlaceholders ? `AND id NOT IN (${excludedPlaceholders})` : ''}
      ORDER BY RANDOM()
      LIMIT ?
    `;

    const params = [
      ...weakPoints.weakSubjects,
      ...weakPoints.weakTypes,
      studentId,
      ...(excludedPlaceholders ? weakPoints.wrongQuestions : []),
      targetCount
    ];

    const similar = db.prepare(sql).all(...params);
    for (const q of similar) {
      if (!usedIds.has(q.id)) {
        questions.push(q);
        usedIds.add(q.id);
      }
    }
  }

  // 策略 2：如果数量不足，从同科目补充
  const remainingCount = targetCount - questions.length;
  if (remainingCount > 0 && weakPoints.weakSubjects.length) {
    const subjectPlaceholders = weakPoints.weakSubjects.map(() => '?').join(',');
    const usedPlaceholders = usedIds.size ? [...usedIds].map(() => '?').join(',') : '';

    let sql = `
      SELECT * FROM questions
      WHERE subject IN (${subjectPlaceholders})
      ${usedPlaceholders ? `AND id NOT IN (${usedPlaceholders})` : ''}
      ORDER BY RANDOM()
      LIMIT ?
    `;

    const params = [
      ...weakPoints.weakSubjects,
      ...(usedPlaceholders ? [...usedIds] : []),
      remainingCount
    ];

    const extra = db.prepare(sql).all(...params);
    for (const q of extra) {
      if (!usedIds.has(q.id)) {
        questions.push(q);
        usedIds.add(q.id);
      }
    }
  }

  // 策略 3：如果还不够，随机抽取任何题目
  const stillRemaining = targetCount - questions.length;
  if (stillRemaining > 0) {
    const usedPlaceholders = usedIds.size ? [...usedIds].map(() => '?').join(',') : '';

    let sql = `
      SELECT * FROM questions
      ${usedPlaceholders ? `WHERE id NOT IN (${usedPlaceholders})` : ''}
      ORDER BY RANDOM()
      LIMIT ?
    `;

    const params = [
      ...(usedPlaceholders ? [...usedIds] : []),
      stillRemaining
    ];

    const fallback = db.prepare(sql).all(...params);
    for (const q of fallback) {
      if (!usedIds.has(q.id)) {
        questions.push(q);
        usedIds.add(q.id);
      }
    }
  }

  return questions;
}

/**
 * 调用 AI 生成新题目（题库不足时）
 * @param {Object} weakPoints
 * @param {number} count
 * @returns {Promise<Array<Object>>} AI 生成的题目
 */
async function generateAIQuestions(weakPoints, count) {
  const subjectsStr = weakPoints.weakSubjects.join('、') || '考研综合';
  const typesStr = weakPoints.weakTypes.join('、') || '单选题、多选题、填空题';

  const systemPrompt = `你是一位资深考研命题专家。请根据学生的薄弱知识点生成高质量的考研模拟题。
输出必须是纯 JSON 数组格式，不要包含任何 Markdown 标记或其他说明文字。
每道题目必须包含以下字段：
- id: 字符串，如 "ai_q_1"
- subject: 科目名称
- question_type: 题型（single_choice/multiple_choice/fill_blank/short_answer/true_false）
- stem: 题干内容
- options: 单选/多选题的选项数组，每项 { key, text }；非选择题则为空数组
- correct_answer: 正确答案
- analysis_text: 详细解析
- score: 分值（默认 5 分）`;

  const prompt = `请为考研学生生成 ${count} 道模拟题。
薄弱科目：${subjectsStr}
薄弱题型：${typesStr}

要求：
1. 题目难度适中偏上，贴合考研真题风格
2. 单选题约 ${Math.ceil(count * 0.4)} 道，多选题约 ${Math.floor(count * 0.2)} 道，填空/简答约 ${Math.floor(count * 0.2)} 道，判断题约 ${Math.floor(count * 0.2)} 道
3. 每道题必须附带详细解析
4. 输出必须是 JSON 数组，可直接被 JSON.parse 解析`;

  try {
    const response = await ai.quickAsk(prompt, systemPrompt, { maxTokens: 4000, temperature: 0.7 });
    // 尝试提取 JSON
    let jsonStr = response.trim();
    // 去除可能的 markdown 代码块
    if (jsonStr.startsWith('```')) {
      const match = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) jsonStr = match[1].trim();
    }
    // 尝试找到 JSON 数组
    const arrayStart = jsonStr.indexOf('[');
    const arrayEnd = jsonStr.lastIndexOf(']');
    if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart) {
      jsonStr = jsonStr.slice(arrayStart, arrayEnd + 1);
    }

    const generated = safeJsonParse(jsonStr, []);
    if (!Array.isArray(generated) || generated.length === 0) {
      console.warn('[examGenerator] AI 生成题目解析失败或返回空数组');
      return [];
    }

    // 标准化 AI 生成的题目字段
    return generated.map((q, index) => ({
      id: `ai_${Date.now()}_${index}`,
      subject: q.subject || subjectsStr.split('、')[0] || '考研综合',
      question_type: q.question_type || 'single_choice',
      stem: q.stem || q.title || '题目内容缺失',
      options: Array.isArray(q.options) ? JSON.stringify(q.options) : (q.options || '[]'),
      correct_answer: String(q.correct_answer || ''),
      analysis_text: q.analysis_text || q.analysis || '暂无解析',
      score: Number(q.score) || 5,
      isAIGenerated: true
    }));
  } catch (err) {
    console.error('[examGenerator] AI 生成题目失败:', err.message);
    return [];
  }
}

/**
 * 为学生生成半月自测试卷
 * @param {Object} db - better-sqlite3 数据库实例
 * @param {number} studentId - 学生 ID
 * @returns {Promise<Object>} exam 对象 { id, title, questionIds, generatedAt, dueAt, status }
 */
async function generateExam(db, studentId) {
  if (!db || !studentId) {
    throw new Error('db 和 studentId 为必填参数');
  }

  // 检查学生是否存在
  const student = db.prepare('SELECT id, display_name FROM users WHERE id = ? AND role = ?').get(studentId, 'student');
  if (!student) {
    throw new Error(`学生 id=${studentId} 不存在或角色不是 student`);
  }

  // 分析薄弱点
  const weakPoints = analyzeWeakPoints(db, studentId);

  // 确定试卷题目数量
  let targetCount = DEFAULT_QUESTION_COUNT;
  if (weakPoints.totalWrong < 5) targetCount = MIN_QUESTION_COUNT;
  if (weakPoints.totalWrong > 30) targetCount = MAX_QUESTION_COUNT;

  // 从题库抽取题目
  let pickedQuestions = pickSimilarQuestions(db, studentId, weakPoints, targetCount);

  // 如果题库不足，调用 AI 生成补充
  const shortfall = targetCount - pickedQuestions.length;
  let aiQuestions = [];
  if (shortfall > 0) {
    console.log(`[examGenerator] 题库不足，需补充 ${shortfall} 道 AI 生成题`);
    aiQuestions = await generateAIQuestions(weakPoints, shortfall);
  }

  const allQuestions = [...pickedQuestions, ...aiQuestions];

  // 如果完全没有题目，生成通用题目
  if (allQuestions.length === 0) {
    console.warn('[examGenerator] 题库为空且 AI 生成失败，生成通用试卷');
    aiQuestions = await generateAIQuestions(
      { weakSubjects: ['考研英语', '考研数学'], weakTypes: ['single_choice'], wrongQuestions: [] },
      MIN_QUESTION_COUNT
    );
    if (aiQuestions.length === 0) {
      throw new Error('无法生成试卷：题库为空且 AI 生成失败');
    }
    allQuestions.push(...aiQuestions);
  }

  // 构建试卷数据
  const now = dayjs();
  const dueAt = now.add(EXAM_DUE_DAYS, 'day').toISOString();
  const generatedAt = now.toISOString();
  const questionIds = allQuestions.map((q) => q.id);
  const questionIdsJson = JSON.stringify(questionIds);

  // 确定试卷标题
  const weakSubjectStr = weakPoints.weakSubjects.slice(0, 2).join('、') || '综合';
  const title = `${student.display_name}的${weakSubjectStr}半月自测（${now.format('MM月DD日')}）`;

  // 存入 ai_exams 表
  const insert = db.prepare(`
    INSERT INTO ai_exams (student_id, title, subject, question_ids, generated_at, due_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const result = insert.run(
    studentId,
    title,
    weakSubjectStr,
    questionIdsJson,
    generatedAt,
    dueAt,
    'pending'
  );

  const examId = result.lastInsertRowid;

  // 记录 AI 对话日志
  try {
    logConversation({
      userId: studentId,
      botCode: 'exam_generator',
      type: 'generate',
      prompt: `生成半月自测试卷：薄弱科目=${weakSubjectStr}, 题目数=${allQuestions.length}`,
      response: JSON.stringify({ examId, questionCount: allQuestions.length, aiGenerated: aiQuestions.length }),
      context: JSON.stringify({ weakPoints, questionIds })
    });
  } catch (logErr) {
    // 日志失败不阻塞主流程
    console.warn('[examGenerator] 记录对话日志失败:', logErr.message);
  }

  return {
    id: examId,
    title,
    questionIds,
    generatedAt,
    dueAt,
    status: 'pending'
  };
}

// ── 核心功能：自动批改 ──

/**
 * 自动批改客观题，AI 辅助批改主观题
 * @param {Object} db
 * @param {number} examId - 考试 ID
 * @param {number} studentId - 学生 ID
 * @param {Object} answers - { questionId: selectedAnswer }
 * @returns {Promise<Object>} { score, total, correctCount, details }
 */
async function gradeSubmission(db, examId, studentId, answers) {
  if (!db || !examId || !studentId || !answers || typeof answers !== 'object') {
    throw new Error('db, examId, studentId, answers 为必填参数');
  }

  // 查询试卷信息
  const exam = db.prepare('SELECT * FROM ai_exams WHERE id = ? AND student_id = ?').get(examId, studentId);
  if (!exam) {
    throw new Error(`试卷 id=${examId} 不存在或不属于该学生`);
  }

  const questionIds = safeJsonParse(exam.question_ids, []);
  if (!questionIds.length) {
    throw new Error('试卷题目列表为空');
  }

  // 查询题目详情
  const placeholders = questionIds.map(() => '?').join(',');
  const questions = db.prepare(`SELECT * FROM questions WHERE id IN (${placeholders})`).all(...questionIds);

  // 构建题目映射（兼容 AI 生成的题目，其 id 可能不在 questions 表中）
  const questionMap = new Map();
  for (const q of questions) {
    questionMap.set(q.id, q);
  }

  // 对于 AI 生成的题目，尝试从 answers 的 key 中推断（AI 题目 id 格式为 ai_...）
  const answerEntries = Object.entries(answers);
  let totalScore = 0;
  let maxTotalScore = 0;
  let correctCount = 0;
  const details = [];

  for (const [questionId, selectedAnswer] of answerEntries) {
    const question = questionMap.get(Number(questionId)) || questionMap.get(questionId);

    if (!question) {
      // AI 生成的题目，尝试从 exam 的上下文或直接用 AI 评分
      details.push({
        questionId,
        selectedAnswer,
        correctAnswer: null,
        isCorrect: null,
        score: 0,
        maxScore: 5,
        isObjective: false,
        aiGraded: true,
        feedback: 'AI 生成题目，无法自动批改'
      });
      maxTotalScore += 5;
      continue;
    }

    const qType = question.question_type || 'single_choice';
    const isObj = isObjective(qType);
    const maxScore = 5; // 每题默认 5 分
    maxTotalScore += maxScore;

    if (isObj) {
      // 客观题直接对比
      const correct = compareAnswers(selectedAnswer, question.correct_answer);
      const score = correct ? maxScore : 0;
      totalScore += score;
      if (correct) correctCount += 1;

      details.push({
        questionId: Number(questionId),
        selectedAnswer,
        correctAnswer: question.correct_answer,
        isCorrect: correct,
        score,
        maxScore,
        isObjective: true,
        aiGraded: false,
        feedback: correct ? '回答正确' : `正确答案：${question.correct_answer}`
      });
    } else {
      // 主观题：调用 AI 评分
      let aiScore = 0;
      let feedback = '';
      try {
        const gradingResult = await gradeSubjectiveQuestion(question, selectedAnswer);
        aiScore = gradingResult.score;
        feedback = gradingResult.feedback;
      } catch (err) {
        console.warn(`[examGenerator] 主观题 AI 评分失败 questionId=${questionId}:`, err.message);
        feedback = 'AI 评分失败，默认得 0 分';
      }

      totalScore += aiScore;
      if (aiScore >= maxScore * 0.6) correctCount += 1; // 主观题得分 >= 60% 视为正确

      details.push({
        questionId: Number(questionId),
        selectedAnswer,
        correctAnswer: question.correct_answer,
        isCorrect: aiScore >= maxScore * 0.6,
        score: aiScore,
        maxScore,
        isObjective: false,
        aiGraded: true,
        feedback
      });
    }
  }

  // 保存提交记录
  const submittedAt = dayjs().toISOString();
  const startedAt = submittedAt; // 简化处理，实际可从前端传入

  const insert = db.prepare(`
    INSERT OR REPLACE INTO ai_exam_submissions
    (exam_id, student_id, answers, score, submitted_at, started_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  insert.run(
    examId,
    studentId,
    JSON.stringify(answers),
    totalScore,
    submittedAt,
    startedAt
  );

  // 更新试卷状态
  db.prepare("UPDATE ai_exams SET status = 'completed' WHERE id = ?").run(examId);

  return {
    score: totalScore,
    total: maxTotalScore,
    correctCount,
    details
  };
}

/**
 * AI 辅助批改主观题
 * @param {Object} question - 题目对象
 * @param {string} studentAnswer - 学生答案
 * @returns {Promise<Object>} { score, feedback }
 */
async function gradeSubjectiveQuestion(question, studentAnswer) {
  const systemPrompt = `你是一位资深考研阅卷老师。请对考生的主观题答案进行评分。
评分标准：
- 满分 10 分
- 答案准确、完整、逻辑清晰：9-10 分
- 答案基本正确但略有遗漏：7-8 分
- 答案部分正确：5-6 分
- 答案有少量相关点：3-4 分
- 答案错误或与题目无关：0-2 分

请输出 JSON 格式：{ "score": 数字, "feedback": "评分理由和改进建议" }`;

  const prompt = `题目：${question.stem}
正确答案/参考答案：${question.correct_answer || '见解析'}
解析：${question.analysis_text || '暂无解析'}

考生答案：${studentAnswer}

请评分并给出反馈。`;

  const response = await ai.quickAsk(prompt, systemPrompt, { maxTokens: 1500, temperature: 0.3 });

  // 尝试解析 JSON
  let result = { score: 0, feedback: '' };
  try {
    let jsonStr = response.trim();
    if (jsonStr.startsWith('```')) {
      const match = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) jsonStr = match[1].trim();
    }
    const jsonStart = jsonStr.indexOf('{');
    const jsonEnd = jsonStr.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd !== -1) {
      jsonStr = jsonStr.slice(jsonStart, jsonEnd + 1);
    }
    const parsed = safeJsonParse(jsonStr, {});
    result.score = Math.max(0, Math.min(10, Number(parsed.score) || 0));
    result.feedback = parsed.feedback || '已评分';
  } catch (_) {
    // 解析失败，尝试从文本中提取数字
    const scoreMatch = response.match(/(\d+(?:\.\d+)?)\s*分/);
    if (scoreMatch) {
      result.score = Math.max(0, Math.min(10, Number(scoreMatch[1])));
    }
    result.feedback = response.slice(0, 200) || 'AI 评分完成';
  }

  // 将 10 分制转换为 5 分制（与客观题统一）
  const normalizedScore = (result.score / 10) * 5;

  return {
    score: Math.round(normalizedScore * 10) / 10,
    feedback: result.feedback
  };
}

// ── 批量功能 ──

/**
 * 为所有付费学员生成试卷（后续可接入权益体系过滤）
 * @param {Object} db
 * @returns {Promise<Object>} { total, success, failed, errors }
 */
async function generateExamForAllPaidStudents(db) {
  if (!db) {
    throw new Error('db 为必填参数');
  }

  // 获取所有 role='student' 的学员
  const students = db.prepare("SELECT id FROM users WHERE role = 'student'").all();

  const results = {
    total: students.length,
    success: 0,
    failed: 0,
    errors: []
  };

  for (const student of students) {
    try {
      await generateExam(db, student.id);
      results.success += 1;
    } catch (err) {
      results.failed += 1;
      results.errors.push({ studentId: student.id, error: err.message });
      console.error(`[examGenerator] 为学生 ${student.id} 生成试卷失败:`, err.message);
    }
  }

  return results;
}

// ── 提醒功能 ──

/**
 * 找出已到期未提交的试卷，记录提醒
 * @param {Object} db
 * @param {number} daysOverdue - 逾期天数阈值
 * @returns {Object} { remindedCount, exams }
 */
function remindOverdueExams(db, daysOverdue = 3) {
  if (!db) {
    throw new Error('db 为必填参数');
  }

  const now = dayjs().toISOString();
  const overdueThreshold = dayjs().subtract(daysOverdue, 'day').toISOString();

  // 查询已到期未提交的试卷
  const overdueExams = db.prepare(`
    SELECT e.*, u.display_name
    FROM ai_exams e
    JOIN users u ON e.student_id = u.id
    WHERE e.status = 'pending'
      AND e.due_at < ?
      AND e.due_at > ?
      AND NOT EXISTS (
        SELECT 1 FROM ai_exam_submissions s
        WHERE s.exam_id = e.id AND s.student_id = e.student_id
      )
  `).all(now, overdueThreshold);

  const remindedExams = [];

  for (const exam of overdueExams) {
    // 记录到 notifications 表
    try {
      const insertNotification = db.prepare(`
        INSERT OR IGNORE INTO notifications
        (student_id, type, title, body, task_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      insertNotification.run(
        exam.student_id,
        'exam_reminder',
        '自测试卷即将过期',
        `你的试卷「${exam.title}」已到期但未提交，请尽快完成。`,
        exam.id,
        now
      );

      remindedExams.push({
        examId: exam.id,
        studentId: exam.student_id,
        studentName: exam.display_name,
        title: exam.title,
        dueAt: exam.due_at
      });
    } catch (err) {
      console.warn(`[examGenerator] 记录提醒失败 examId=${exam.id}:`, err.message);
    }
  }

  // 可选：同时记录到 ai_conversations
  for (const exam of remindedExams) {
    try {
      logConversation({
        userId: exam.studentId,
        botCode: 'exam_generator',
        type: 'generate',
        prompt: '逾期提醒',
        response: `提醒学生完成试卷：${exam.title}`,
        context: JSON.stringify({ examId: exam.examId, dueAt: exam.dueAt })
      });
    } catch (_) {
      // 日志失败不阻塞
    }
  }

  return {
    remindedCount: remindedExams.length,
    exams: remindedExams
  };
}

// ── 导出 ──

module.exports = {
  generateExam,
  gradeSubmission,
  generateExamForAllPaidStudents,
  remindOverdueExams
};
