const dayjs = require('dayjs');
const { quickAsk } = require('../ai');
const { getBotByCode, logConversation } = require('../botManager');
const { sendAppMessage } = require('../wecom');
const { getUserEntitlement, computeEffectiveTier } = require('../entitlements');

const BOT_CODE = 'planner';

// ── 内部辅助：获取学员企业微信 userId ──

function getStudent(db, studentId) {
  const columns = db.prepare("PRAGMA table_info(users)").all();
  const hasWecomUserid = columns.some(c => c.name === 'wecom_userid');

  if (hasWecomUserid) {
    return db.prepare('SELECT id, display_name, wecom_userid FROM users WHERE id = ?').get(studentId);
  }
  return db.prepare('SELECT id, display_name, NULL as wecom_userid FROM users WHERE id = ?').get(studentId);
}

function getStudentName(db, studentId) {
  const row = db.prepare('SELECT display_name FROM users WHERE id = ?').get(studentId);
  return row ? row.display_name : '同学';
}

// ── 数据收集：任务完成率 ──

function getTaskStats(db, studentId, weekStart, weekEnd) {
  const tasks = db.prepare(`
    SELECT t.id, t.title, t.subject, t.weekdays, t.student_ids
    FROM tasks t
    WHERE t.student_ids LIKE ?
  `).all(`%"${studentId}"%`);

  let total = 0;
  let completed = 0;

  for (const task of tasks) {
    const weekdays = safeJsonParse(task.weekdays, [0, 1, 2, 3, 4, 5, 6]);
    for (let d = 0; d < 7; d++) {
      const date = dayjs(weekStart).add(d, 'day').format('YYYY-MM-DD');
      const dayOfWeek = dayjs(date).day();
      if (!weekdays.includes(dayOfWeek)) continue;

      total++;
      const comp = db.prepare(
        'SELECT completed_at FROM task_completions WHERE task_id = ? AND student_id = ? AND task_date = ?'
      ).get(task.id, studentId, date);
      if (comp && comp.completed_at) completed++;
    }
  }

  return { total, completed, rate: total > 0 ? Math.round((completed / total) * 100) : 0 };
}

// ── 数据收集：做题数与正确率 ──

function getPracticeStats(db, studentId, weekStart, weekEnd) {
  const startIso = dayjs(weekStart).startOf('day').toISOString();
  const endIso = dayjs(weekEnd).endOf('day').toISOString();

  const total = db.prepare(`
    SELECT COUNT(*) as cnt FROM practice_records
    WHERE student_id = ? AND created_at >= ? AND created_at <= ?
  `).get(studentId, startIso, endIso);

  const correct = db.prepare(`
    SELECT COUNT(*) as cnt FROM practice_records
    WHERE student_id = ? AND is_correct = 1 AND created_at >= ? AND created_at <= ?
  `).get(studentId, startIso, endIso);

  const totalCount = total.cnt || 0;
  const correctCount = correct.cnt || 0;

  return {
    total: totalCount,
    correct: correctCount,
    rate: totalCount > 0 ? Math.round((correctCount / totalCount) * 100) : 0
  };
}

// ── 数据收集：错题标签分布 ──

function getWrongTagDistribution(db, studentId, weekStart, weekEnd) {
  const startIso = dayjs(weekStart).startOf('day').toISOString();
  const endIso = dayjs(weekEnd).endOf('day').toISOString();

  const rows = db.prepare(`
    SELECT qt.name, COUNT(*) as cnt
    FROM practice_records pr
    JOIN questions q ON pr.question_id = q.id
    JOIN question_tag_relations qtr ON q.id = qtr.question_id
    JOIN question_tags qt ON qtr.tag_id = qt.id
    WHERE pr.student_id = ? AND pr.is_correct = 0
      AND pr.created_at >= ? AND pr.created_at <= ?
    GROUP BY qt.name
    ORDER BY cnt DESC
    LIMIT 10
  `).all(studentId, startIso, endIso);

  return rows || [];
}

// ── 数据收集：自测成绩 ──

function getExamStats(db, studentId, weekStart, weekEnd) {
  const startIso = dayjs(weekStart).startOf('day').toISOString();
  const endIso = dayjs(weekEnd).endOf('day').toISOString();

  const rows = db.prepare(`
    SELECT exam_id, score, time_spent_ms, submitted_at
    FROM ai_exam_submissions
    WHERE student_id = ? AND submitted_at >= ? AND submitted_at <= ?
    ORDER BY submitted_at DESC
  `).all(studentId, startIso, endIso);

  return rows || [];
}

// ── 数据收集：答疑记录 ──

function getConversationStats(db, studentId, weekStart, weekEnd) {
  const startIso = dayjs(weekStart).startOf('day').toISOString();
  const endIso = dayjs(weekEnd).endOf('day').toISOString();

  const total = db.prepare(`
    SELECT COUNT(*) as cnt FROM ai_conversations
    WHERE user_id = ? AND created_at >= ? AND created_at <= ?
  `).get(studentId, startIso, endIso);

  return { total: total.cnt || 0 };
}

// ── 数据收集：学习时长（基于 practice_sessions） ──

function getStudyDuration(db, studentId, weekStart, weekEnd) {
  const startIso = dayjs(weekStart).startOf('day').toISOString();
  const endIso = dayjs(weekEnd).endOf('day').toISOString();

  const rows = db.prepare(`
    SELECT started_at, ended_at, time_spent_ms
    FROM practice_sessions
    WHERE student_id = ? AND started_at >= ? AND started_at <= ?
  `).all(studentId, startIso, endIso);

  let totalMinutes = 0;
  for (const row of rows) {
    if (row.time_spent_ms) {
      totalMinutes += Math.round(row.time_spent_ms / 60000);
    } else if (row.ended_at) {
      const start = dayjs(row.started_at);
      const end = dayjs(row.ended_at);
      totalMinutes += end.diff(start, 'minute');
    }
  }

  return totalMinutes;
}

// ── 数据收集：连续学习天数 ──

function getStudyStreak(db, studentId) {
  const row = db.prepare(`
    SELECT current_streak, longest_streak, last_study_date
    FROM study_streaks
    WHERE student_id = ?
  `).get(studentId);

  return row || { current_streak: 0, longest_streak: 0, last_study_date: null };
}

// ── 核心：生成学情周报 ──

/**
 * 整合多维度学习数据，生成学情周报与调整建议
 * @param {Database} db
 * @param {number} studentId
 * @param {string} weekStart - 周报起始日期 (YYYY-MM-DD)
 * @returns {Promise<{mastered: Array<string>, weakPoints: Array<string>, nextWeekPlan: Array<string>, suggestions: Array<string>}>}
 */
async function generateWeeklyReport(db, studentId, weekStart) {
  const weekEnd = dayjs(weekStart).add(6, 'day').format('YYYY-MM-DD');
  const studentName = getStudentName(db, studentId);

  // 收集各维度数据
  const taskStats = getTaskStats(db, studentId, weekStart, weekEnd);
  const practiceStats = getPracticeStats(db, studentId, weekStart, weekEnd);
  const wrongTags = getWrongTagDistribution(db, studentId, weekStart, weekEnd);
  const examStats = getExamStats(db, studentId, weekStart, weekEnd);
  const convStats = getConversationStats(db, studentId, weekStart, weekEnd);
  const studyDuration = getStudyDuration(db, studentId, weekStart, weekEnd);
  const streak = getStudyStreak(db, studentId);

  // 构建 Prompt
  const systemPrompt = `你是一位资深考研规划师，擅长根据学生的学习数据生成个性化周报。请用中文输出，结构清晰，语言亲切专业。`;

  const userPrompt = `请为学员「${studentName}」生成 ${weekStart} 至 ${weekEnd} 的学情周报：

【本周数据概览】
1. 任务完成：${taskStats.completed}/${taskStats.total} 项，完成率 ${taskStats.rate}%
2. 学习时长：约 ${studyDuration} 分钟
3. 做题统计：${practiceStats.total} 道，正确 ${practiceStats.correct} 道，正确率 ${practiceStats.rate}%
4. 自测考试：${examStats.length} 次${examStats.length > 0 ? '，最新得分 ' + (examStats[0].score || 'N/A') + ' 分' : ''}
5. AI答疑：${convStats.total} 次提问
6. 连续学习：当前 ${streak.current_streak} 天，最长 ${streak.longest_streak} 天

${wrongTags.length > 0 ? '【错题标签分布】\n' + wrongTags.map(t => `- ${t.name}: ${t.cnt} 道`).join('\n') : '【错题标签分布】\n本周暂无错题记录'}

请按以下 JSON 格式输出（不要包含 markdown 代码块标记）：
{
  "mastered": ["已掌握的知识点1", "已掌握的知识点2"],
  "weakPoints": ["薄弱点1", "薄弱点2"],
  "nextWeekPlan": ["下周计划1", "下周计划2"],
  "suggestions": ["具体建议1", "具体建议2"]
}

要求：
- mastered: 基于高正确率科目或任务完成情况，总结 2-4 个已掌握点
- weakPoints: 基于错题标签和低正确率，总结 2-4 个薄弱点
- nextWeekPlan: 给出 3-5 条下周具体可执行计划
- suggestions: 给出 2-3 条学习方法和心态调整建议`;

  let aiResponse;
  try {
    aiResponse = await quickAsk(userPrompt, systemPrompt, { maxTokens: 2000, temperature: 0.5 });
  } catch (err) {
    console.error(`[plannerBot] AI 生成周报失败 studentId=${studentId}:`, err.message);
    // 降级：返回基础统计
    return {
      mastered: ['本周坚持学习，保持良好习惯'],
      weakPoints: wrongTags.length > 0 ? wrongTags.slice(0, 3).map(t => `${t.name} 相关题型`) : ['需增加练习量'],
      nextWeekPlan: [
        `完成 ${taskStats.total - taskStats.completed > 0 ? taskStats.total - taskStats.completed : 0} 项待完成任务`,
        `刷题 ${Math.max(20, practiceStats.total)} 道，目标正确率 80%`,
        '每日保持至少 1 小时有效学习'
      ],
      suggestions: ['保持规律作息', '错题及时复盘', '遇到难点及时答疑']
    };
  }

  // 解析 AI 返回的 JSON
  let report;
  try {
    const cleaned = aiResponse.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    report = JSON.parse(cleaned);
  } catch (parseErr) {
    console.error(`[plannerBot] AI 响应解析失败 studentId=${studentId}:`, parseErr.message);
    // 尝试正则提取
    const masteredMatch = aiResponse.match(/已掌握[：:]\s*([^\n]+)/g);
    const weakMatch = aiResponse.match(/薄弱[点项][：:]\s*([^\n]+)/g);
    report = {
      mastered: masteredMatch ? masteredMatch.map(m => m.replace(/.*?[：:]\s*/, '')) : ['本周学习表现良好'],
      weakPoints: weakMatch ? weakMatch.map(m => m.replace(/.*?[：:]\s*/, '')) : ['需针对性加强练习'],
      nextWeekPlan: ['继续保持每日学习节奏', '重点攻克错题知识点', '适当增加模拟测试'],
      suggestions: ['制定详细每日计划', '定期回顾错题', '保持积极心态']
    };
  }

  // 记录对话
  logConversation({
    userId: studentId,
    botCode: BOT_CODE,
    type: 'planner',
    prompt: userPrompt.slice(0, 500),
    response: JSON.stringify(report)
  });

  return report;
}

// ── 保存报告到数据库 ──

/**
 * 将报告存入 study_reports 表
 * 兼容现有 schema（无 week_start / suggestions / data_json 列时降级保存到 content）
 * @param {Database} db
 * @param {number} studentId
 * @param {string} weekStart
 * @param {Object} report
 * @returns {Object} { id: number }
 */
function saveReport(db, studentId, weekStart, report) {
  const now = dayjs().toISOString();
  const content = JSON.stringify(report);
  const suggestions = Array.isArray(report.suggestions) ? report.suggestions.join('\n') : String(report.suggestions || '');

  // 检查 schema 是否包含 week_start 列
  const columns = db.prepare("PRAGMA table_info(study_reports)").all();
  const hasWeekStart = columns.some(c => c.name === 'week_start');
  const hasDataJson = columns.some(c => c.name === 'data_json');
  const hasSuggestions = columns.some(c => c.name === 'suggestions');

  if (hasWeekStart && hasDataJson && hasSuggestions) {
    // 新 schema
    const existing = db.prepare(
      'SELECT id FROM study_reports WHERE student_id = ? AND week_start = ?'
    ).get(studentId, weekStart);

    if (existing) {
      db.prepare(`
        UPDATE study_reports
        SET data_json = ?, suggestions = ?, created_at = ?
        WHERE id = ?
      `).run(content, suggestions, now, existing.id);
      return { id: existing.id };
    }

    const result = db.prepare(`
      INSERT INTO study_reports (student_id, week_start, data_json, suggestions, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(studentId, weekStart, content, suggestions, now);

    return { id: result.lastInsertRowid };
  }

  // 兼容旧 schema：report_type + content
  const existing = db.prepare(
    'SELECT id FROM study_reports WHERE student_id = ? AND report_type = ? AND created_at >= ? AND created_at <= ?'
  ).get(studentId, 'weekly', dayjs(weekStart).startOf('day').toISOString(), dayjs(weekStart).add(6, 'day').endOf('day').toISOString());

  if (existing) {
    db.prepare(`
      UPDATE study_reports
      SET content = ?, created_at = ?
      WHERE id = ?
    `).run(content, now, existing.id);
    return { id: existing.id };
  }

  const result = db.prepare(`
    INSERT INTO study_reports (student_id, report_type, content, generated_by, created_at)
    VALUES (?, 'weekly', ?, 'ai', ?)
  `).run(studentId, content, now);

  return { id: result.lastInsertRowid };
}

// ── 批量生成：所有付费学员 ──

/**
 * 为所有付费学员生成上周报告
 * @param {Database} db
 * @returns {Promise<Array<{studentId: number, success: boolean, reportId?: number, error?: string}>>}
 */
async function generateReportsForAllPaidStudents(db) {
  const lastMonday = dayjs().startOf('week').add(1, 'day').subtract(7, 'day').format('YYYY-MM-DD');

  // 仅对付费且未过期学员生成周报
  const students = db.prepare(`
    SELECT u.id
    FROM users u
    JOIN user_entitlements e ON u.id = e.student_id
    WHERE u.role = 'student'
      AND e.tier = 'paid'
      AND (e.paid_until IS NULL OR e.paid_until >= datetime('now'))
    ORDER BY u.id ASC
  `).all();

  const results = [];

  for (const student of students) {
    try {
      const report = await generateWeeklyReport(db, student.id, lastMonday);
      const saved = saveReport(db, student.id, lastMonday, report);
      results.push({ studentId: student.id, success: true, reportId: saved.id });
    } catch (err) {
      console.error(`[plannerBot] 生成周报失败 studentId=${student.id}:`, err.message);
      results.push({ studentId: student.id, success: false, error: err.message });
    }
  }

  return results;
}

// ── 发送报告摘要给学员 ──

/**
 * 通过企微应用消息发送报告摘要
 * @param {Database} db
 * @param {number} studentId
 * @param {Object} report
 * @returns {Promise<{sent: boolean, channel?: string, reason?: string}>}
 */
async function sendReportToUser(db, studentId, report) {
  const student = getStudent(db, studentId);
  if (!student) {
    return { sent: false, reason: 'student_not_found' };
  }

  if (!student.wecom_userid) {
    return { sent: false, reason: 'no_wecom_userid' };
  }

  const mastered = Array.isArray(report.mastered) ? report.mastered : [];
  const weakPoints = Array.isArray(report.weakPoints) ? report.weakPoints : [];
  const nextWeekPlan = Array.isArray(report.nextWeekPlan) ? report.nextWeekPlan : [];

  const message = `📊 本周学情周报

✅ 已掌握：
${mastered.map(m => `• ${m}`).join('\n')}

⚠️ 薄弱点：
${weakPoints.map(w => `• ${w}`).join('\n')}

📋 下周计划：
${nextWeekPlan.map((p, i) => `${i + 1}. ${p}`).join('\n')}

加油！坚持就是胜利！💪`;

  try {
    await sendAppMessage({
      touser: student.wecom_userid,
      msgtype: 'text',
      text: { content: message }
    });

    logConversation({
      userId: studentId,
      botCode: BOT_CODE,
      type: 'planner',
      prompt: 'send_weekly_report',
      response: message
    });

    return { sent: true, channel: 'wecom' };
  } catch (err) {
    console.error(`[plannerBot] 发送周报失败 studentId=${studentId}:`, err.message);
    return { sent: false, reason: 'wecom_error', error: err.message };
  }
}

// ── 内部工具 ──

function safeJsonParse(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

// ── 导出 ──

module.exports = {
  generateWeeklyReport,
  saveReport,
  generateReportsForAllPaidStudents,
  sendReportToUser
};
