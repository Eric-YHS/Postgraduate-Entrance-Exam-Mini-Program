const dayjs = require('dayjs');
const { getTasksForStudentOnDate } = require('./taskService');

const SUBJECTS = ['英语', '数学', '政治', '专业课'];

function serializePlanItem(row) {
  return {
    id: Number(row.id),
    studentId: Number(row.student_id),
    planDate: row.plan_date,
    subject: row.subject,
    title: row.title,
    description: row.description || '',
    sourceMode: row.source_mode,
    sourcePlanId: row.source_plan_id,
    status: row.status,
    feedback: row.feedback || '',
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function legacyTasksForDate(db, studentId, date) {
  return getTasksForStudentOnDate(db, studentId, date).map((task) => {
    const completion = db.prepare(`
      SELECT completed_at FROM task_completions
      WHERE task_id = ? AND student_id = ? AND task_date = ?
    `).get(task.id, studentId, date);
    return {
      id: `task-${task.id}`,
      studentId,
      planDate: date,
      subject: task.subject,
      title: task.title,
      description: task.description || '',
      sourceMode: task.plan_type === 'personal' ? 'semi_auto' : 'manual',
      sourcePlanId: null,
      status: completion?.completed_at ? 'completed' : 'pending',
      feedback: '',
      completedAt: completion?.completed_at || null,
      legacyTaskId: task.id,
      startTime: task.start_time,
      endTime: task.end_time
    };
  });
}

function getPlanDays(db, studentId, { startDate = dayjs().format('YYYY-MM-DD'), days = 7 } = {}) {
  const safeDays = Math.min(31, Math.max(1, Number(days) || 7));
  const result = [];
  for (let offset = 0; offset < safeDays; offset += 1) {
    const date = dayjs(startDate).add(offset, 'day').format('YYYY-MM-DD');
    const rows = db.prepare(`
      SELECT * FROM study_plan_items WHERE student_id = ? AND plan_date = ? ORDER BY subject ASC, id ASC
    `).all(studentId, date).map(serializePlanItem);
    const legacy = legacyTasksForDate(db, studentId, date);
    const items = [...rows, ...legacy];
    result.push({
      date,
      weekday: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][dayjs(date).day()],
      items,
      completed: items.filter((item) => item.status === 'completed').length,
      total: items.length
    });
  }
  return result;
}

function replacePlanForDate(db, { studentId, planDate, sourceMode, items, createdBy = null }) {
  const mode = ['manual', 'semi_auto', 'full_auto'].includes(sourceMode) ? sourceMode : 'manual';
  const date = dayjs(planDate).format('YYYY-MM-DD');
  const now = dayjs().toISOString();
  const insert = db.prepare(`
    INSERT INTO study_plan_items
      (student_id, plan_date, subject, title, description, source_mode, source_plan_id, status, feedback, completed_at, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', '', NULL, ?, ?, ?)
  `);
  const transaction = db.transaction(() => {
    db.prepare(`
      DELETE FROM study_plan_items
      WHERE student_id = ? AND plan_date = ? AND status = 'pending'
    `).run(studentId, date);
    return (items || []).filter((item) => String(item.title || '').trim()).map((item) => {
      const result = insert.run(
        studentId,
        date,
        String(item.subject || '考研规划').trim(),
        String(item.title).trim(),
        String(item.description || '').trim(),
        mode,
        Number(item.sourcePlanId) || null,
        createdBy,
        now,
        now
      );
      return Number(result.lastInsertRowid);
    });
  });
  return transaction();
}

function parseExtraTasks(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function templateTasks(template, profile) {
  if (!template) return [];
  const score = (value) => value === null || value === undefined || value === '' ? '' : `目标 ${value} 分；`;
  const tasks = [
    template.english_long_task && { subject: '英语', title: template.english_long_task, description: `${score(template.english_target_score)}英语长期任务` },
    template.english_stage_task && { subject: '英语', title: template.english_stage_task, description: `${score(template.english_target_score)}英语阶段任务` },
    template.math_task && { subject: '数学', title: template.math_task, description: `${score(template.business1_target_score)}数学/业务课一任务` },
    template.politics_task && { subject: '政治', title: template.politics_task, description: `${score(template.politics_target_score)}政治任务` },
    template.professional_task && { subject: '专业课', title: template.professional_task, description: `${score(template.business2_target_score)}专业/业务课二任务` }
  ].filter(Boolean);
  for (const item of parseExtraTasks(template.extra_tasks_json)) {
    if (typeof item === 'string' && item.trim()) tasks.push({ subject: '额外任务', title: item.trim(), description: '' });
    else if (item && String(item.title || '').trim()) tasks.push({
      subject: String(item.subject || '额外任务').trim(),
      title: String(item.title).trim(),
      description: String(item.description || '').trim()
    });
  }
  const targetSchool = template.target_school || profile?.target_school;
  return tasks.map((item) => ({
    ...item,
    description: `${item.description || ''}${targetSchool ? `目标院校：${targetSchool}` : ''}`.replace(/；目标院校/, '；目标院校')
  }));
}

function buildDefaultTasks(profile, previousItems = [], template = null) {
  const incomplete = previousItems.filter((item) => item.status !== 'completed');
  const configured = templateTasks(template, profile);
  if (incomplete.length) {
    return [...incomplete.map((item) => ({
      subject: item.subject,
      title: `回炉：${item.title}`,
      description: item.feedback ? `昨日反馈：${item.feedback}` : '先完成昨日未完成内容，再进入新任务。',
      sourcePlanId: Number(item.id) || null
    })), ...configured];
  }
  if (configured.length) return configured;
  const stage = profile?.current_stage || '基础';
  const weak = String(profile?.weakest_english_section || '').trim();
  return SUBJECTS.map((subject) => {
    if (subject === '英语') {
      return { subject, title: `${stage}阶段英语任务`, description: weak ? `优先补强：${weak}` : '完成词汇、阅读或语法中的一项核心训练。' };
    }
    return { subject, title: `${stage}阶段${subject}任务`, description: `围绕目标院校 ${profile?.target_school || '待定'} 完成今日可验收任务。` };
  });
}

function adjustNextDayPlan(db, { studentId, sourceMode = 'semi_auto', baseItems = [], createdBy = null, fromDate = dayjs().format('YYYY-MM-DD') }) {
  const today = dayjs(fromDate).format('YYYY-MM-DD');
  const nextDate = dayjs(today).add(1, 'day').format('YYYY-MM-DD');
  const previousItems = db.prepare(`
    SELECT * FROM study_plan_items WHERE student_id = ? AND plan_date = ? ORDER BY id ASC
  `).all(studentId, today).map(serializePlanItem);
  const profile = db.prepare('SELECT * FROM student_profiles WHERE user_id = ?').get(studentId);
  const template = db.prepare('SELECT * FROM student_plan_templates WHERE student_id = ?').get(studentId);
  let items = Array.isArray(baseItems) ? baseItems.filter((item) => item && item.title) : [];
  if (sourceMode === 'semi_auto') {
    const carry = previousItems.filter((item) => item.status !== 'completed').map((item) => ({
      subject: item.subject,
      title: `补做：${item.title}`,
      description: item.feedback ? `根据反馈微调：${item.feedback}` : item.description,
      sourcePlanId: item.id
    }));
    const baseline = items.length ? items : templateTasks(template, profile);
    items = [...carry, ...baseline].slice(0, 12);
  } else if (sourceMode === 'full_auto') {
    items = buildDefaultTasks(profile, previousItems, template).slice(0, 12);
  }
  const ids = replacePlanForDate(db, { studentId, planDate: nextDate, sourceMode, items, createdBy });
  return { planDate: nextDate, itemIds: ids, items };
}

function updatePlanStatus(db, { itemId, studentId, status, feedback = '' }) {
  if (!['pending', 'completed', 'skipped'].includes(status)) throw new Error('任务状态无效');
  const row = db.prepare('SELECT * FROM study_plan_items WHERE id = ? AND student_id = ?').get(itemId, studentId);
  if (!row) return null;
  const now = dayjs().toISOString();
  db.prepare(`
    UPDATE study_plan_items
    SET status = ?, feedback = ?, completed_at = ?, updated_at = ?
    WHERE id = ? AND student_id = ?
  `).run(status, String(feedback || '').slice(0, 500), status === 'completed' ? now : null, now, itemId, studentId);
  return serializePlanItem(db.prepare('SELECT * FROM study_plan_items WHERE id = ?').get(itemId));
}

module.exports = {
  adjustNextDayPlan,
  buildDefaultTasks,
  getPlanDays,
  replacePlanForDate,
  serializePlanItem,
  templateTasks,
  updatePlanStatus
};
