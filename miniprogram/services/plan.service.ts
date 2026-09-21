import { get, post } from '../utils/request';

export type StudyPlanItem = {
  id: number | string;
  planDate: string;
  subject: string;
  title: string;
  description: string;
  sourceMode: 'manual' | 'semi_auto' | 'full_auto';
  status: 'pending' | 'completed' | 'skipped';
  feedback: string;
  completedAt: string | null;
  legacyTaskId?: number;
};

export type StudyPlanDay = {
  date: string;
  weekday: string;
  items: StudyPlanItem[];
  completed: number;
  total: number;
};

export function getFuturePlans(days = 7): Promise<{ days: StudyPlanDay[] }> {
  return get<{ days: StudyPlanDay[] }>('/api/student/plans', { days }, { loading: false });
}

export function updatePlanItem(id: number, status: StudyPlanItem['status'], feedback = ''): Promise<{ item: StudyPlanItem }> {
  return post<{ item: StudyPlanItem }>('/api/student/plans/update', { id, status, feedback }, { loading: false });
}
