import type { ListItem } from './common';

/** 学科（公共课） */
export type Subject = 'politics' | 'english' | 'math';

/** 专业方向（专业课） */
export type Major = 'computer' | 'finance' | 'law' | 'education' | 'medicine' | 'art';

/** 课程分类 */
export type CourseCategory = 'public' | 'professional';

/** 课程状态 */
export type CourseStatus = 'published' | 'offline';

/** 课程简要信息 */
export interface CourseSummary extends ListItem {
  title: string;
  coverUrl: string;
  subject?: Subject;
  major?: Major;
  category: CourseCategory;
  teacherName: string;
  isFree: boolean;
  chapterCount: number;
  status: CourseStatus;
}

/** 视频 */
export interface CourseVideo extends ListItem {
  title: string;
  duration: number;
  videoUrl: string;
  order: number;
}

/** 课程分类下的二级分类 */
export interface CourseSubcategory {
  value: string;
  label: string;
}

/** 课程分类分组 */
export interface CourseCategoryGroup {
  value: CourseCategory;
  label: string;
  children: CourseSubcategory[];
}

/** 课程分类响应 */
export interface CourseCategoryResponse {
  categories: CourseCategoryGroup[];
}
export interface CourseChapter extends ListItem {
  title: string;
  order: number;
  videos: CourseVideo[];
}

/** 课程详情 */
export interface CourseDetail extends CourseSummary {
  description: string;
  chapters: CourseChapter[];
}

/** 课程查询参数 */
export interface CourseQueryParams {
  category?: CourseCategory;
  subject?: Subject;
  major?: Major;
  page?: number;
  pageSize?: number;
}

/** 视频播放授权响应 */
export interface VideoAuthResponse {
  videoUrl: string;
  fullDuration: number;
}

/** 视频学习进度 */
export interface VideoProgress {
  videoId: string;
  courseId: string;
  currentTime: number;
  duration: number;
  percent: number;
  updatedAt: string;
}
