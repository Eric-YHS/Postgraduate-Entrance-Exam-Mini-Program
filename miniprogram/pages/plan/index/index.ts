type PlanItem = {
  id: string;
  content: string;
  completed: boolean;
  createdAt: number;
};

const STORAGE_KEY = 'ky_study_plan_items';

Page({
  data: {
    inputValue: '',
    items: [] as PlanItem[],
    completedCount: 0,
  },

  onLoad() {
    try {
      const stored = wx.getStorageSync(STORAGE_KEY) as PlanItem[] | undefined;
      const items = Array.isArray(stored)
        ? stored.filter(
            (item) =>
              item &&
              typeof item.id === 'string' &&
              typeof item.content === 'string' &&
              typeof item.completed === 'boolean'
          )
        : [];
      this.updateItems(items);
    } catch (error) {
      console.warn('[StudyPlan] 读取计划失败', error);
      this.updateItems([]);
    }
  },

  onInput(e: WechatMiniprogram.Input) {
    this.setData({ inputValue: e.detail.value });
  },

  onAdd() {
    const content = this.data.inputValue.trim();
    if (!content) {
      wx.showToast({ title: '请输入计划内容', icon: 'none' });
      return;
    }

    const items = [
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        content,
        completed: false,
        createdAt: Date.now(),
      },
      ...this.data.items,
    ];
    this.setData({ inputValue: '' });
    this.updateItems(items);
  },

  onToggle(e: WechatMiniprogram.BaseEvent) {
    const id = String(e.currentTarget.dataset.id || '');
    const items = this.data.items.map((item) => (item.id === id ? { ...item, completed: !item.completed } : item));
    this.updateItems(items);
  },

  onDelete(e: WechatMiniprogram.BaseEvent) {
    const id = String(e.currentTarget.dataset.id || '');
    this.updateItems(this.data.items.filter((item) => item.id !== id));
  },

  updateItems(items: PlanItem[]) {
    this.setData({
      items,
      completedCount: items.filter((item) => item.completed).length,
    });
    try {
      wx.setStorageSync(STORAGE_KEY, items);
    } catch (error) {
      console.warn('[StudyPlan] 保存计划失败', error);
      wx.showToast({ title: '保存失败，请稍后重试', icon: 'none' });
    }
  },
});
