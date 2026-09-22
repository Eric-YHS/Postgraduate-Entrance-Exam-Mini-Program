import type { StudyPlanDay, StudyPlanItem } from '../../services/plan.service';

const subjects = ['英语', '数学', '政治', '专业课'];
const now = new Date();

function dateAt(offset: number): string {
  const date = new Date(now);
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

let days: StudyPlanDay[] = Array.from({ length: 7 }, (_, offset) => {
  const date = dateAt(offset);
  const items: StudyPlanItem[] = subjects.map((subject, index) => ({
    id: offset * 10 + index + 1,
    planDate: date,
    subject,
    title: offset === 0 ? `${subject}今日核心任务` : `${subject}阶段计划`,
    description: offset === 0 ? '完成后晚间登记，明日任务会按结果微调。' : '计划可能根据前一日完成情况调整。',
    sourceMode: offset < 2 ? 'semi_auto' : 'full_auto',
    status: 'pending',
    feedback: '',
    completedAt: null,
  }));
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(`${date}T00:00:00`).getDay()];
  return { date, weekday, items, completed: 0, total: items.length };
});

export function mockGetFuturePlans(): { days: StudyPlanDay[] } {
  return { days };
}

export function mockUpdatePlanItem(data: Record<string, unknown>): { item: StudyPlanItem } {
  const id = Number(data.id);
  const status = String(data.status || 'pending') as StudyPlanItem['status'];
  let updated: StudyPlanItem | null = null;
  days = days.map((day) => {
    const items = day.items.map((item) => {
      if (Number(item.id) !== id) return item;
      updated = {
        ...item,
        status,
        feedback: String(data.feedback || ''),
        completedAt: status === 'completed' ? new Date().toISOString() : null,
      };
      return updated;
    });
    return {
      ...day,
      items,
      completed: items.filter((item) => item.status === 'completed').length,
      total: items.length,
    };
  });
  if (!updated) throw new Error('计划项不存在');
  return { item: updated };
}
