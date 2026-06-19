import { get } from '../utils/request';
import { ApiEndpoints } from './api-types';
import type { CourseSummary, CourseDetail, CourseQueryParams, CourseCategoryResponse } from '../types/course';
import type { PaginationData } from '../types/common';

/** 获取课程列表 */
export function getCourses(params: CourseQueryParams): Promise<PaginationData<CourseSummary>> {
  return get<PaginationData<CourseSummary>>(ApiEndpoints.COURSES, params as Record<string, unknown>);
}

/** 获取课程分类（公共课/专业课 + 二级分类） */
export function getCourseCategories(): Promise<CourseCategoryResponse> {
  return get<CourseCategoryResponse>(ApiEndpoints.COURSE_CATEGORIES);
}

/** 获取课程详情 */
export function getCourseDetail(courseId: string): Promise<CourseDetail | null> {
  return get<CourseDetail | null>(ApiEndpoints.COURSE_DETAIL, { id: courseId });
}
