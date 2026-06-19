import type { CourseSummary, CourseDetail, CourseQueryParams, CourseCategoryResponse } from '../../types/course';
import type { PaginationData } from '../../types/common';
import { mockCourseSummaries, mockCourseDetails, mockCourseCategories } from '../data/courses';

function sortChapters(detail: CourseDetail): CourseDetail {
  const chapters = [...detail.chapters].sort((a, b) => a.order - b.order);
  return {
    ...detail,
    chapters: chapters.map((chapter) => ({
      ...chapter,
      videos: [...chapter.videos].sort((a, b) => a.order - b.order),
    })),
  };
}

export function mockGetCourses(params: CourseQueryParams): Promise<PaginationData<CourseSummary>> {
  const { category, subject, major, page = 1, pageSize = 10 } = params;

  let list = [...mockCourseSummaries];

  if (category) {
    list = list.filter((item) => item.category === category);
  }

  if (subject) {
    list = list.filter((item) => item.subject === subject);
  }

  if (major) {
    list = list.filter((item) => item.major === major);
  }

  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  const paginatedList = list.slice(start, end);

  return Promise.resolve({
    list: paginatedList,
    total: list.length,
    page,
    pageSize,
  });
}

export function mockGetCourseDetail(courseId: string): Promise<CourseDetail | null> {
  const detail = mockCourseDetails[courseId] || null;
  return Promise.resolve(detail ? sortChapters(detail) : null);
}

export function mockGetCourseCategories(): Promise<CourseCategoryResponse> {
  return Promise.resolve({ categories: mockCourseCategories });
}
