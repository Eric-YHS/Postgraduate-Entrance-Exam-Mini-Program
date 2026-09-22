import { getFuturePlans, updatePlanItem, type StudyPlanDay } from '../../../services/plan.service';

Page({
  data: {
    days: [] as StudyPlanDay[],
    loading: true,
    error: '',
    completedCount: 0,
    totalCount: 0,
  },

  onLoad() {
    this.loadPlans();
  },

  onPullDownRefresh() {
    this.loadPlans().finally(() => wx.stopPullDownRefresh());
  },

  async loadPlans() {
    this.setData({ loading: true, error: '' });
    try {
      const result = await getFuturePlans(7);
      this.applyDays(result.days || []);
    } catch (error) {
      console.error('[StudyPlan] 加载未来计划失败', error);
      this.setData({ loading: false, error: '计划加载失败，请稍后重试。' });
    }
  },

  async onToggle(e: WechatMiniprogram.BaseEvent) {
    const id = Number(e.currentTarget.dataset.id);
    const currentStatus = String(e.currentTarget.dataset.status || 'pending');
    if (!Number.isInteger(id)) {
      wx.showToast({ title: '固定任务请在网页端登记', icon: 'none' });
      return;
    }
    const nextStatus = currentStatus === 'completed' ? 'pending' : 'completed';
    try {
      await updatePlanItem(id, nextStatus);
      const days = this.data.days.map((day) => {
        const items = day.items.map((item) =>
          Number(item.id) === id
            ? {
                ...item,
                status: nextStatus as 'pending' | 'completed',
                completedAt: nextStatus === 'completed' ? new Date().toISOString() : null,
              }
            : item
        );
        return { ...day, items, completed: items.filter((item) => item.status === 'completed').length };
      });
      this.applyDays(days);
    } catch (error) {
      console.error('[StudyPlan] 更新计划失败', error);
      wx.showToast({ title: '更新失败，请稍后重试', icon: 'none' });
    }
  },

  applyDays(days: StudyPlanDay[]) {
    this.setData({
      days,
      loading: false,
      error: '',
      completedCount: days.reduce((sum, day) => sum + day.completed, 0),
      totalCount: days.reduce((sum, day) => sum + day.total, 0),
    });
  },
});
