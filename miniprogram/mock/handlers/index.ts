import { mockLogin, mockGetUserProfile } from './user.handler';
import { mockGetCourses, mockGetCourseDetail, mockGetCourseCategories } from './course.handler';
import {
  mockGetQuestions,
  mockGetQuestionById,
  mockGetWrongQuestions,
  mockMasterWrongQuestion,
} from './question.handler';
import {
  mockGetTopics,
  mockGetTopicById,
  mockCreateTopic,
  mockCreateReply,
  mockToggleFavorite,
  mockGetHashtags,
} from './forum.handler';

/** Mock 处理器注册表 */
export interface MockRegistry {
  [url: string]: (data?: Record<string, unknown>) => unknown;
}

export const mockRegistry: MockRegistry = {
  '/api/auth/login': (data) => mockLogin(String(data?.code || '')),
  '/api/user/profile': () => mockGetUserProfile(),
  '/api/courses': (data) => mockGetCourses(data || {}),
  '/api/courses/detail': (data) => mockGetCourseDetail(String(data?.id || '')),
  '/api/course/categories': () => mockGetCourseCategories(),

  '/api/questions': (data) => mockGetQuestions(data || {}),
  '/api/questions/detail': (data) => mockGetQuestionById(String(data?.id || '')),
  '/api/practice/wrong': (data) => mockGetWrongQuestions(data || {}),
  '/api/practice/wrong/:questionId/master': (data) => mockMasterWrongQuestion(String(data?.questionId || '')),

  // 论坛社区
  '/api/forum/topics': (data) => mockGetTopics(data || {}),
  '/api/forum/topics/create': (data) => mockCreateTopic(data || {}),
  '/api/forum/topics/:id': (data) => mockGetTopicById(String(data?.id || '')),
  '/api/forum/topics/:id/replies': (data) => mockCreateReply(data || {}),
  '/api/forum/topics/:id/favorite': (data) => mockToggleFavorite(data || {}),
  '/api/forum/hashtags': () => mockGetHashtags(),
};

export { mockLogin, mockGetUserProfile } from './user.handler';
export { mockGetCourses, mockGetCourseDetail, mockGetCourseCategories } from './course.handler';
export {
  mockGetQuestions,
  mockGetQuestionById,
  mockGetWrongQuestions,
  mockMasterWrongQuestion,
} from './question.handler';
export {
  mockGetTopics,
  mockGetTopicById,
  mockCreateTopic,
  mockCreateReply,
  mockToggleFavorite,
  mockGetHashtags,
} from './forum.handler';
