const dayjs = require('dayjs');

function safeJsonParse(value, fallback) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function normalizeWeekdays(rawWeekdays) {
  if (Array.isArray(rawWeekdays)) {
    return [...new Set(rawWeekdays.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0 && value <= 6))].sort();
  }

  if (typeof rawWeekdays === 'string') {
    const trimmed = rawWeekdays.trim();

    if (!trimmed || trimmed === 'everyday' || trimmed === 'daily') {
      return [0, 1, 2, 3, 4, 5, 6];
    }

    return normalizeWeekdays(trimmed.split(/[，,\s|/]+/));
  }

  return [0, 1, 2, 3, 4, 5, 6];
}

function serializeWeekdays(weekdays) {
  return JSON.stringify(normalizeWeekdays(weekdays));
}

function normalizeStudentIds(rawStudentIds) {
  if (Array.isArray(rawStudentIds)) {
    return [...new Set(rawStudentIds.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0))].sort((left, right) => left - right);
  }

  if (typeof rawStudentIds === 'string') {
    const trimmed = rawStudentIds.trim();
    if (!trimmed) {
      return [];
    }

    return normalizeStudentIds(trimmed.split(/[，,\s|/]+/));
  }

  return [];
}

function serializeStudentIds(studentIds) {
  return JSON.stringify(normalizeStudentIds(studentIds));
}

function normalizeTaskRow(row) {
  const weekdays = safeJsonParse(row.weekdays, normalizeWeekdays(row.weekdays));
  const studentIds = safeJsonParse(row.student_ids, normalizeStudentIds(row.student_ids));

  return {
    ...row,
    weekdays: normalizeWeekdays(weekdays),
    studentIds: normalizeStudentIds(studentIds)
  };
}

function getAllTasks(db) {
  return db
    .prepare(
      `
        SELECT tasks.*, users.display_name AS teacher_name
        FROM tasks
        LEFT JOIN users ON users.id = tasks.created_by
        ORDER BY tasks.start_time ASC, tasks.created_at DESC
      `
    )
    .all()
    .map(normalizeTaskRow);
}

function taskMatchesStudent(task, studentId) {
  return task.studentIds.includes(Number(studentId));
}

function taskMatchesDate(task, dateString) {
  const day = dayjs(dateString).day();
  return task.weekdays.includes(day);
}

function getTasksForStudentOnDate(db, studentId, dateString) {
  return getAllTasks(db)
    .filter((task) => taskMatchesStudent(task, studentId) && taskMatchesDate(task, dateString))
    .sort((left, right) => left.start_time.localeCompare(right.start_time));
}

function getStudentsByIds(db, studentIds) {
  const ids = normalizeStudentIds(studentIds);

  if (!ids.length) {
    return [];
  }

  const placeholder = ids.map(() => '?').join(',');
  return db
    .prepare(`SELECT id, display_name, username, class_name FROM users WHERE role = 'student' AND id IN (${placeholder}) ORDER BY display_name ASC`)
    .all(...ids);
}

function formatWeekdaysLabel(weekdays) {
  const labels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const normalized = normalizeWeekdays(weekdays);

  if (normalized.length === 7) {
    return '每天';
  }

  return normalized.map((value) => labels[value]).join(' / ');
}

module.exports = {
  formatWeekdaysLabel,
  getAllTasks,
  getStudentsByIds,
  getTasksForStudentOnDate,
  normalizeStudentIds,
  normalizeTaskRow,
  normalizeWeekdays,
  safeJsonParse,
  serializeStudentIds,
  serializeWeekdays,
  taskMatchesDate,
  taskMatchesStudent
};
