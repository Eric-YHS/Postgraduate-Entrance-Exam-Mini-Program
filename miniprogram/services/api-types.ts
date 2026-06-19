/** API 接口路径枚举 */
export const ApiEndpoints = {
  AUTH_LOGIN: '/api/auth/login',
  USER_PROFILE: '/api/user/profile',
  COURSES: '/api/courses',
  COURSE_DETAIL: '/api/courses/detail',
  COURSE_CATEGORIES: '/api/course/categories',
  QUESTIONS: '/api/questions',
  QUESTION_DETAIL: '/api/questions/detail',
  WRONG_QUESTIONS: '/api/practice/wrong',
  MASTER_WRONG_QUESTION: '/api/practice/wrong/:questionId/master',

  // 论坛社区
  FORUM_TOPICS: '/api/forum/topics',
  FORUM_TOPIC_CREATE: '/api/forum/topics/create',
  FORUM_TOPIC_DETAIL: '/api/forum/topics/:id',
  FORUM_REPLIES: '/api/forum/topics/:id/replies',
  FORUM_FAVORITE: '/api/forum/topics/:id/favorite',
  FORUM_HASHTAGS: '/api/forum/hashtags',
} as const;
