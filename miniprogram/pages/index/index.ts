import { userStore } from '../../store/user.store';
import { getCourses } from '../../services/course.service';
import type { CourseSummary } from '../../types/course';
import type { UserProfile } from '../../types/user';
import { COURSE_CATEGORY_MAP, MAJOR_MAP, SUBJECT_MAP } from '../../constants/index';
import { ONLINE_COURSE_FEATURE_ENABLED } from '../../config/release';

type RecommendedCourse = CourseSummary & {
  subjectLabel: string;
};

function getCourseSubjectLabel(course: CourseSummary): string {
  if (course.category === 'professional' && course.major) {
    return MAJOR_MAP[course.major] || course.major;
  }
  if (course.subject) {
    return SUBJECT_MAP[course.subject] || course.subject;
  }
  return COURSE_CATEGORY_MAP[course.category] || course.category;
}

Page({
  data: {
    user: null as UserProfile | null,
    courses: [] as RecommendedCourse[],
    loading: false,
    onlineCoursesVisible: ONLINE_COURSE_FEATURE_ENABLED,
  },

  unsubscribe: null as (() => void) | null,

  onLoad() {
    this.setData({ user: userStore.getState().profile });

    this.unsubscribe = userStore.subscribe((state) => {
      this.setData({ user: state.profile });
    });

    if (ONLINE_COURSE_FEATURE_ENABLED) {
      this.loadRecommendCourses();
    }
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
      this.setData({
        courses: res.list.map((course) => ({
          ...course,
          subjectLabel: getCourseSubjectLabel(course),
        })),
        loading: false,
      });
    } catch (err) {
      console.error('[Index] 加载推荐课程失败', err);
      this.setData({ loading: false });
    }
  },

  onCourseTap(e: WechatMiniprogram.BaseEvent) {
    if (!ONLINE_COURSE_FEATURE_ENABLED) return;
    const { id } = e.currentTarget.dataset;
    wx.navigateTo({
      url: `/pages/course/detail/detail?id=${id}`,
    });
  },

  onMoreCourses() {
    if (!ONLINE_COURSE_FEATURE_ENABLED) return;
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
});
