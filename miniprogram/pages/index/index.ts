import { userStore } from '../../store/user.store';
import { getCourses } from '../../services/course.service';
import type { CourseSummary } from '../../types/course';
import type { UserProfile } from '../../types/user';
import { SUBJECT_MAP } from '../../constants/index';
import { getRemainingDays } from '../../utils/date';

Page({
  data: {
    user: null as UserProfile | null,
    courses: [] as CourseSummary[],
    loading: false,
    trialDays: 0,
  },

  unsubscribe: null as (() => void) | null,

  onLoad() {
    this.setData({ user: userStore.getState().profile });

    this.unsubscribe = userStore.subscribe((state) => {
      this.setData({ user: state.profile });
    });

    this.loadRecommendCourses();
  },

  onUnload() {
    if (this.unsubscribe) {
      this.unsubscribe();
    }
  },

  async loadRecommendCourses() {
    this.setData({ loading: true });
    try {
      const res = await getCourses({ page: 1, pageSize: 4 });
      const trialDays = this.data.user?.trialEndTime ? getRemainingDays(this.data.user.trialEndTime) : 0;
      this.setData({
        courses: res.list,
        trialDays,
        loading: false,
      });
    } catch (err) {
      console.error('[Index] 加载推荐课程失败', err);
      this.setData({ loading: false });
    }
  },

  onCourseTap(e: WechatMiniprogram.BaseEvent) {
    const { id } = e.currentTarget.dataset;
    wx.navigateTo({
      url: `/pages/course/list/list?id=${id}`,
    });
  },

  onMoreCourses() {
    wx.switchTab({
      url: '/pages/course/list/list',
    });
  },

  onQuestionTap() {
    wx.navigateTo({
      url: '/pages/question/practice/practice?subject=politics&displayMode=radio&title=政治刷题',
    });
  },

  onWrongBookTap() {
    wx.navigateTo({
      url: '/pages/question/wrong-book/wrong-book',
    });
  },

  onForumTap() {
    wx.navigateTo({
      url: '/pages/forum/index/index',
    });
  },

  getSubjectName(subject: string): string {
    return SUBJECT_MAP[subject] || subject;
  },

  formatPrice(price: number): string {
    return (price / 100).toFixed(2);
  },
});
