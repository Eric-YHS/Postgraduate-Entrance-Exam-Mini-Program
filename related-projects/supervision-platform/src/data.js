export const subjects = [
  { id: 'politics', label: '政治', tint: '#e8f0ff', accent: '#315dbe' },
  { id: 'english', label: '英语', tint: '#ecf8f2', accent: '#18865c' },
  { id: 'math', label: '数学', tint: '#fff5e8', accent: '#b66513' },
  { id: 'major', label: '专业课', tint: '#f5efff', accent: '#7352ba' },
];

export const courses = [
  { id: 'c1', subject: 'politics', title: '政治核心考点精讲', teacher: '林老师', lessons: 36, progress: 42, cover: '哲学与思政方法论' },
  { id: 'c2', subject: 'english', title: '英语阅读高分方法', teacher: '周老师', lessons: 28, progress: 18, cover: '长难句与篇章逻辑' },
  { id: 'c3', subject: 'math', title: '高数基础到强化', teacher: '陈老师', lessons: 54, progress: 31, cover: '函数、极限与积分' },
  { id: 'c4', subject: 'major', title: '专业课导学与真题', teacher: '教研组', lessons: 20, progress: 0, cover: '方向与院校自选' },
];

export const studentProfile = {
  name: '陈同学',
  stage: '基础阶段',
  target: '2027 考研',
  goalSchool: '目标院校待确定',
  major: '计算机相关方向',
};

export const planTemplates = [
  { id: 'p1', title: '四科基础期通用规划', stage: '基础期 · 16 周', subjects: ['政治', '英语', '数学'], tasks: 48, description: '建立稳定节奏，完成核心课程首轮与高频基础训练。' },
  { id: 'p2', title: '英语基础与词汇冲刺', stage: '基础期 · 12 周', subjects: ['英语'], tasks: 36, description: '围绕词汇、长难句、阅读三条主线安排每日任务。' },
  { id: 'p3', title: '跨专业起步规划', stage: '预备期 · 10 周', subjects: ['英语', '专业课'], tasks: 30, description: '面向初学者，先建立专业课知识地图与英语学习习惯。' },
];

export const aiCapabilities = [
  { name: '学情诊断', description: '汇总任务、课程、做题与错题数据，输出可追溯的薄弱项。' },
  { name: '计划建议', description: '基于模板和学生画像生成建议，老师确认后才进入个人计划。' },
  { name: '自测生成', description: '从已学范围与题库中组织测验，并标明每道题的数据来源。' },
  { name: '内容审核', description: '对社区帖子分级预审，保留老师最终审核与申诉处理。' },
];
