import type { CourseSummary, CourseDetail, CourseCategoryGroup } from '../../types/course';

export const mockCourseSummaries: CourseSummary[] = [
  {
    id: 'course_001',
    title: '2026 考研政治公开课',
    coverUrl: '/assets/images/cover-placeholder-1.svg',
    subject: 'politics',
    category: 'public',
    teacherName: '张老师',
    isFree: true,
    chapterCount: 5,
    status: 'published',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'course_002',
    title: '2026 考研英语一学习专题',
    coverUrl: '/assets/images/cover-placeholder-2.svg',
    subject: 'english',
    category: 'public',
    teacherName: '李老师',
    isFree: true,
    chapterCount: 2,
    status: 'published',
    createdAt: '2026-01-02T00:00:00.000Z',
  },
  {
    id: 'course_003',
    title: '考研数学公式学习专题',
    coverUrl: '/assets/images/cover-placeholder-3.svg',
    subject: 'math',
    category: 'public',
    teacherName: '王老师',
    isFree: true,
    chapterCount: 2,
    status: 'published',
    createdAt: '2026-01-03T00:00:00.000Z',
  },
  {
    id: 'course_004',
    title: '计算机专业课学习专题',
    coverUrl: '/assets/images/cover-placeholder-4.svg',
    major: 'computer',
    category: 'professional',
    teacherName: '陈老师',
    isFree: true,
    chapterCount: 2,
    status: 'published',
    createdAt: '2026-01-04T00:00:00.000Z',
  },
  {
    id: 'course_005',
    title: '金融专硕知识专题',
    coverUrl: '/assets/images/cover-placeholder-5.svg',
    major: 'finance',
    category: 'professional',
    teacherName: '刘老师',
    isFree: true,
    chapterCount: 2,
    status: 'published',
    createdAt: '2026-01-05T00:00:00.000Z',
  },
  {
    id: 'course_006',
    title: '法律硕士知识专题',
    coverUrl: '/assets/images/cover-placeholder-6.svg',
    major: 'law',
    category: 'professional',
    teacherName: '赵老师',
    isFree: true,
    chapterCount: 2,
    status: 'published',
    createdAt: '2026-01-06T00:00:00.000Z',
  },
];

export const mockCourseDetails: Record<string, CourseDetail> = {
  course_001: {
    ...mockCourseSummaries[0],
    description: '整理考研政治马原、毛中特、史纲、思修四大模块，配套真题练习与复习要点。',
    chapters: [
      {
        id: 'chapter_001',
        title: '第一章 马克思主义基本原理概论',
        order: 1,
        videos: [
          {
            id: 'video_001',
            title: '1.1 马克思主义是关于无产阶级和人类解放的科学',
            duration: 1200,
            videoUrl:
              'https://wxsnsdy.tc.qq.com/105/20210/snsdyvideodownload?filekey=30280201010421301f0201690402534804102ca905ce620b1241b726bc41dcff44e00204012882540400&bizid=1023&hy=SH&fileparam=302c020101042530230204136ffd93020457e3c4ff02024ef202031e8d7f02030f42400204045a320a0201000400',
            order: 1,
          },
          {
            id: 'video_002',
            title: '1.2 世界的物质性及其发展规律',
            duration: 1500,
            videoUrl:
              'https://wxsnsdy.tc.qq.com/105/20210/snsdyvideodownload?filekey=30280201010421301f0201690402534804102ca905ce620b1241b726bc41dcff44e00204012882540400&bizid=1023&hy=SH&fileparam=302c020101042530230204136ffd93020457e3c4ff02024ef202031e8d7f02030f42400204045a320a0201000400',
            order: 2,
          },
          {
            id: 'video_003',
            title: '1.3 认识的本质及其发展规律',
            duration: 1800,
            videoUrl:
              'https://wxsnsdy.tc.qq.com/105/20210/snsdyvideodownload?filekey=30280201010421301f0201690402534804102ca905ce620b1241b726bc41dcff44e00204012882540400&bizid=1023&hy=SH&fileparam=302c020101042530230204136ffd93020457e3c4ff02024ef202031e8d7f02030f42400204045a320a0201000400',
            order: 3,
          },
        ],
      },
      {
        id: 'chapter_002',
        title: '第二章 毛泽东思想和中国特色社会主义理论体系概论',
        order: 2,
        videos: [
          {
            id: 'video_004',
            title: '2.1 毛泽东思想及其历史地位',
            duration: 1600,
            videoUrl:
              'https://wxsnsdy.tc.qq.com/105/20210/snsdyvideodownload?filekey=30280201010421301f0201690402534804102ca905ce620b1241b726bc41dcff44e00204012882540400&bizid=1023&hy=SH&fileparam=302c020101042530230204136ffd93020457e3c4ff02024ef202031e8d7f02030f42400204045a320a0201000400',
            order: 1,
          },
          {
            id: 'video_005',
            title: '2.2 新民主主义革命理论',
            duration: 2000,
            videoUrl:
              'https://wxsnsdy.tc.qq.com/105/20210/snsdyvideodownload?filekey=30280201010421301f0201690402534804102ca905ce620b1241b726bc41dcff44e00204012882540400&bizid=1023&hy=SH&fileparam=302c020101042530230204136ffd93020457e3c4ff02024ef202031e8d7f02030f42400204045a320a0201000400',
            order: 2,
          },
        ],
      },
    ],
  },
  course_002: {
    ...mockCourseSummaries[1],
    description: '整理考研英语一阅读理解、完形填空、翻译、写作等题型的学习方法。',
    chapters: [
      {
        id: 'chapter_003',
        title: '第一章 阅读理解方法论',
        order: 1,
        videos: [
          {
            id: 'video_006',
            title: '1.1 题型分类与解题步骤',
            duration: 1300,
            videoUrl:
              'https://wxsnsdy.tc.qq.com/105/20210/snsdyvideodownload?filekey=30280201010421301f0201690402534804102ca905ce620b1241b726bc41dcff44e00204012882540400&bizid=1023&hy=SH&fileparam=302c020101042530230204136ffd93020457e3c4ff02024ef202031e8d7f02030f42400204045a320a0201000400',
            order: 1,
          },
          {
            id: 'video_007',
            title: '1.2 主旨大意题技巧',
            duration: 1400,
            videoUrl:
              'https://wxsnsdy.tc.qq.com/105/20210/snsdyvideodownload?filekey=30280201010421301f0201690402534804102ca905ce620b1241b726bc41dcff44e00204012882540400&bizid=1023&hy=SH&fileparam=302c020101042530230204136ffd93020457e3c4ff02024ef202031e8d7f02030f42400204045a320a0201000400',
            order: 2,
          },
        ],
      },
    ],
  },
  course_003: {
    ...mockCourseSummaries[2],
    description: '汇总考研数学核心公式，配套推导与应用例题。',
    chapters: [
      {
        id: 'chapter_004',
        title: '第一章 高等数学',
        order: 1,
        videos: [
          {
            id: 'video_008',
            title: '1.1 极限公式汇总',
            duration: 900,
            videoUrl:
              'https://wxsnsdy.tc.qq.com/105/20210/snsdyvideodownload?filekey=30280201010421301f0201690402534804102ca905ce620b1241b726bc41dcff44e00204012882540400&bizid=1023&hy=SH&fileparam=302c020101042530230204136ffd93020457e3c4ff02024ef202031e8d7f02030f42400204045a320a0201000400',
            order: 1,
          },
          {
            id: 'video_009',
            title: '1.2 导数公式汇总',
            duration: 800,
            videoUrl:
              'https://wxsnsdy.tc.qq.com/105/20210/snsdyvideodownload?filekey=30280201010421301f0201690402534804102ca905ce620b1241b726bc41dcff44e00204012882540400&bizid=1023&hy=SH&fileparam=302c020101042530230204136ffd93020457e3c4ff02024ef202031e8d7f02030f42400204045a320a0201000400',
            order: 2,
          },
        ],
      },
    ],
  },
  course_004: {
    ...mockCourseSummaries[3],
    description: '围绕计算机考研专业课整理，覆盖数据结构、操作系统、计算机网络等核心科目。',
    chapters: [
      {
        id: 'chapter_005',
        title: '第一章 数据结构基础',
        order: 1,
        videos: [
          {
            id: 'video_010',
            title: '1.1 线性表与链表',
            duration: 1500,
            videoUrl:
              'https://wxsnsdy.tc.qq.com/105/20210/snsdyvideodownload?filekey=30280201010421301f0201690402534804102ca905ce620b1241b726bc41dcff44e00204012882540400&bizid=1023&hy=SH&fileparam=302c020101042530230204136ffd93020457e3c4ff02024ef202031e8d7f02030f42400204045a320a0201000400',
            order: 1,
          },
          {
            id: 'video_011',
            title: '1.2 栈与队列',
            duration: 1400,
            videoUrl:
              'https://wxsnsdy.tc.qq.com/105/20210/snsdyvideodownload?filekey=30280201010421301f0201690402534804102ca905ce620b1241b726bc41dcff44e00204012882540400&bizid=1023&hy=SH&fileparam=302c020101042530230204136ffd93020457e3c4ff02024ef202031e8d7f02030f42400204045a320a0201000400',
            order: 2,
          },
        ],
      },
    ],
  },
  course_005: {
    ...mockCourseSummaries[4],
    description: '整理金融专硕考研专业课知识，包括货币银行学、国际金融、投资学等内容。',
    chapters: [
      {
        id: 'chapter_006',
        title: '第一章 货币银行学',
        order: 1,
        videos: [
          {
            id: 'video_012',
            title: '1.1 货币与货币制度',
            duration: 1600,
            videoUrl:
              'https://wxsnsdy.tc.qq.com/105/20210/snsdyvideodownload?filekey=30280201010421301f0201690402534804102ca905ce620b1241b726bc41dcff44e00204012882540400&bizid=1023&hy=SH&fileparam=302c020101042530230204136ffd93020457e3c4ff02024ef202031e8d7f02030f42400204045a320a0201000400',
            order: 1,
          },
          {
            id: 'video_013',
            title: '1.2 利率决定理论',
            duration: 1500,
            videoUrl:
              'https://wxsnsdy.tc.qq.com/105/20210/snsdyvideodownload?filekey=30280201010421301f0201690402534804102ca905ce620b1241b726bc41dcff44e00204012882540400&bizid=1023&hy=SH&fileparam=302c020101042530230204136ffd93020457e3c4ff02024ef202031e8d7f02030f42400204045a320a0201000400',
            order: 2,
          },
        ],
      },
    ],
  },
  course_006: {
    ...mockCourseSummaries[5],
    description: '法律硕士考研专业课知识整理，涵盖法理学、宪法学、民法学、刑法学等核心内容。',
    chapters: [
      {
        id: 'chapter_007',
        title: '第一章 法理学',
        order: 1,
        videos: [
          {
            id: 'video_014',
            title: '1.1 法的本质与特征',
            duration: 1700,
            videoUrl:
              'https://wxsnsdy.tc.qq.com/105/20210/snsdyvideodownload?filekey=30280201010421301f0201690402534804102ca905ce620b1241b726bc41dcff44e00204012882540400&bizid=1023&hy=SH&fileparam=302c020101042530230204136ffd93020457e3c4ff02024ef202031e8d7f02030f42400204045a320a0201000400',
            order: 1,
          },
          {
            id: 'video_015',
            title: '1.2 法律关系',
            duration: 1600,
            videoUrl:
              'https://wxsnsdy.tc.qq.com/105/20210/snsdyvideodownload?filekey=30280201010421301f0201690402534804102ca905ce620b1241b726bc41dcff44e00204012882540400&bizid=1023&hy=SH&fileparam=302c020101042530230204136ffd93020457e3c4ff02024ef202031e8d7f02030f42400204045a320a0201000400',
            order: 2,
          },
        ],
      },
    ],
  },
};

export const mockCourseCategories: CourseCategoryGroup[] = [
  {
    value: 'public',
    label: '公共课',
    children: [
      { value: '', label: '全部' },
      { value: 'politics', label: '政治' },
      { value: 'english', label: '英语' },
      { value: 'math', label: '数学' },
    ],
  },
  {
    value: 'professional',
    label: '专业课',
    children: [
      { value: '', label: '全部' },
      { value: 'computer', label: '计算机' },
      { value: 'finance', label: '金融' },
      { value: 'law', label: '法律' },
      { value: 'education', label: '教育学' },
      { value: 'medicine', label: '医学' },
      { value: 'art', label: '艺术' },
    ],
  },
];
