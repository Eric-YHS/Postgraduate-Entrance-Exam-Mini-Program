const { SYSTEM_RESTRICTED_WORDS } = require('../src/services/robotConfig');

function completeBotConfig(overrides = {}) {
  const corpusText = '这是一条用于机器人专属知识库的完整语料，内容覆盖常见问题、判断依据、处理步骤与下一步追问，确保长度超过五十个中文字符并能直接用于检索回答。';
  return {
    description: '负责拆解考研复习问题并给出可执行建议',
    nickname: '小研',
    avatar: '研',
    positioning: '学科答疑',
    initialNote: '考研答疑与计划辅助',
    style: {
      tone: '中立老师',
      addressStudent: '你',
      selfReference: '小研',
      closingStyle: '简短反问',
      bannedSpeech: '不说廉价称呼、空话和夸大承诺'
    },
    prompts: [{
      id: 'P-01',
      role: '你是考研学习规划老师。',
      context: '读取目标院校、当前阶段、最近任务和薄弱点。',
      task: '先讲本质，再拆成步骤，最后确认卡点。',
      outputRules: '控制在八十到二百五十字，短句、口语化。',
      active: true
    }],
    systemRestrictedWords: [...SYSTEM_RESTRICTED_WORDS],
    customRestrictedWords: [],
    corpus: Array.from({ length: 5 }, (_, index) => ({
      id: `KB-${index + 1}`,
      title: `高频问题 ${index + 1}`,
      category: '通用',
      source: '运营手册',
      content: `${corpusText}${index + 1}`
    })),
    keywords: [
      { id: 'KW-1', priority: 'P0', matchType: 'exact', pattern: '人工', category: 'handoff', response: '这个问题我转给老师。' },
      { id: 'KW-2', priority: 'P1', matchType: 'contains', pattern: '复习计划', category: 'business', response: '把目标和完成情况发我，我来拆今天的任务。' },
      { id: 'KW-3', priority: 'P2', matchType: 'regex', pattern: '.*', category: 'fallback', response: '' }
    ],
    templates: [
      { id: 'TPL-WELCOME', category: 'welcome', name: '欢迎', content: '你好，我是小研。先说说你的目标专业？' },
      { id: 'TPL-HANDOFF', category: 'handoff', name: '转人工', content: '这个问题我转给老师，稍后继续回复你。' },
      { id: 'TPL-PUSH', category: 'guidance', name: '计划提醒', content: '{学员姓名}，今天先完成一项可验收任务，做完后告诉我结果。' }
    ],
    schedules: [{ id: 'JOB-MANUAL', name: '手动计划提醒', triggerType: 'manual', cron: '', templateId: 'TPL-PUSH', audience: 'all', enabled: true }],
    handoffKeywords: ['人工', '老师', '真人', '客服', '转人工', '找老师'],
    routing: [{ pattern: '数学', target: '小数' }],
    fallbackReply: '这个我得查一下。你是想问学习方法、复习安排，还是具体题目？可以再具体点。',
    rateLimits: {
      perBotPerStudentDaily: 1,
      allBotsPerStudentDaily: 3,
      startHour: 9,
      endHour: 21,
      examSilenceDays: 3
    },
    rolloutPercent: 100,
    ...overrides
  };
}

module.exports = { completeBotConfig };
