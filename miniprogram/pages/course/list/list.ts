import { getCourses, getCourseCategories } from '../../../services/course.service';
import type {
  CourseSummary,
  CourseCategory,
  Subject,
  Major,
  CourseCategoryGroup,
  CourseSubcategory,
} from '../../../types/course';
import { COURSE_CATEGORY_MAP, SUBJECT_MAP, MAJOR_MAP } from '../../../constants/index';
import { formatPrice } from '../../../utils/course';

Page({
  data: {
    activeCategory: 'public' as CourseCategory,
    activeSubFilter: '',
    categories: [] as CourseCategoryGroup[],
    subFilters: [] as CourseSubcategory[],
    courses: [] as CourseSummary[],
    loading: false,
    error: false,
    page: 1,
    pageSize: 10,
    hasMore: true,
  },

  onLoad() {
    this.loadCategories();
    this.loadCourses(true);
  },

  onPullDownRefresh() {
    Promise.all([this.loadCategories(), this.loadCourses(true)]).then(() => {
      wx.stopPullDownRefresh();
    });
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) {
      this.loadCourses(false);
    }
  },

  async loadCategories() {
    try {
      const res = await getCourseCategories();
      this.setData({ categories: res.categories });
      this.buildSubFilters();
    } catch (err) {
      console.error('[CourseList] 加载分类失败', err);
    }
  },

  buildSubFilters() {
    const group = this.data.categories.find((c) => c.value === this.data.activeCategory);
    this.setData({ subFilters: group?.children || [] });
  },

  async loadCourses(reset = false) {
    if (this.data.loading) return;

    const page = reset ? 1 : this.data.page;
    this.setData({ loading: true, error: false });

    try {
      const params: Record<string, string | number | undefined> = {
        category: this.data.activeCategory,
        page,
        pageSize: this.data.pageSize,
      };

      if (this.data.activeCategory === 'public' && this.data.activeSubFilter) {
        params.subject = this.data.activeSubFilter;
      }

      if (this.data.activeCategory === 'professional' && this.data.activeSubFilter) {
        params.major = this.data.activeSubFilter;
      }

      const res = await getCourses(
        params as { category: CourseCategory; subject?: Subject; major?: Major; page: number; pageSize: number }
      );

      const courses = reset ? res.list : [...this.data.courses, ...res.list];
      const hasMore = courses.length < res.total;

      this.setData({
        courses,
        loading: false,
        page: page + 1,
        hasMore,
      });
    } catch (err) {
      console.error('[CourseList] 加载课程失败', err);
      this.setData({ loading: false, error: true });
    }
  },

  onCategoryTap(e: WechatMiniprogram.BaseEvent) {
    const { value } = e.currentTarget.dataset;
    this.setData({ activeCategory: value, activeSubFilter: '' }, () => {
      this.buildSubFilters();
      this.loadCourses(true);
    });
  },

  onSubFilterTap(e: WechatMiniprogram.BaseEvent) {
    const { value } = e.currentTarget.dataset;
    this.setData({ activeSubFilter: value }, () => {
      this.loadCourses(true);
    });
  },

  onRetry() {
    this.loadCourses(true);
  },

  onCourseTap(e: WechatMiniprogram.BaseEvent) {
    const { id } = e.currentTarget.dataset;
    wx.navigateTo({
      url: `/pages/course/detail/detail?id=${id}`,
    });
  },

  formatPrice(price: number): string {
    return formatPrice(price);
  },

  getCategoryName(category: string): string {
    return COURSE_CATEGORY_MAP[category] || category;
  },

  getSubjectName(subject: string): string {
    return SUBJECT_MAP[subject] || subject;
  },

  getMajorName(major: string): string {
    return MAJOR_MAP[major] || major;
  },

  getCourseTag(item: CourseSummary): string {
    if (item.category === 'public' && item.subject) {
      return this.getSubjectName(item.subject);
    }
    if (item.category === 'professional' && item.major) {
      return this.getMajorName(item.major);
    }
    return this.getCategoryName(item.category);
  },
});
