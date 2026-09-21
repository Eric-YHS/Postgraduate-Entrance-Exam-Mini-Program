const fs = require('fs');
const path = require('path');
const {
  buildConfiguredPrompt,
  humanVoiceIssues,
  matchKeyword,
  matchRestrictedTerms,
  selectCorpus,
  validateBotConfig
} = require('../src/services/robotConfig');
const { completeBotConfig } = require('./requirementsFixtures');

describe('机器人配置规范', () => {
  test('对话和配置审计复用弹窗时会切换标题', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
    const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.js'), 'utf8');
    expect(html).toContain('id="bot-conversations-title"');
    expect(script).toContain("document.getElementById('bot-conversations-title').textContent = '对话记录'");
    expect(script).toContain("document.getElementById('bot-conversations-title').textContent = '配置审计'");
    expect(html).toContain('.admin-menu {');
    expect(html).toContain('min-width: max-content;');
    expect(script).toContain('nav.scrollLeft = Math.max(0, left)');
  });

  test('完整配置通过上线门禁，强制限频和任务格式均被校验', () => {
    const result = validateBotConfig(completeBotConfig());
    expect(result.valid).toBe(true);
    expect(result.checks.find((item) => item.key === 'rate_limits').ok).toBe(true);
    expect(result.checks.find((item) => item.key === 'schedules').ok).toBe(true);

    const invalid = validateBotConfig(completeBotConfig({
      rateLimits: { perBotPerStudentDaily: 2, allBotsPerStudentDaily: 3, startHour: 9, endHour: 21, examSilenceDays: 3 }
    }));
    expect(invalid.valid).toBe(false);
    expect(invalid.checks.find((item) => item.key === 'rate_limits').ok).toBe(false);
  });

  test('关键词按 P0/P1/P2 优先，支持精确、包含和正则', () => {
    const config = completeBotConfig({
      keywords: [
        { priority: 'P2', matchType: 'regex', pattern: '复习.*', category: 'fallback' },
        { priority: 'P1', matchType: 'contains', pattern: '计划', category: 'business' },
        { priority: 'P0', matchType: 'exact', pattern: '复习计划', category: 'handoff' }
      ]
    });
    expect(matchKeyword(config, '复习计划').priority).toBe('P0');
    expect(matchKeyword(config, '我的计划怎么排').priority).toBe('P1');
  });

  test('禁用词、语料检索、四段提示词与真人话术检查可执行', () => {
    const config = completeBotConfig();
    expect(matchRestrictedTerms(config, '你们是不是包过')).toContain('包过');
    expect(selectCorpus({ corpus: [{ title: '阅读方法', category: '英语', content: '阅读训练需要逐句复盘。' }] }, '英语阅读怎么练')).toHaveLength(1);
    expect(buildConfiguredPrompt({ name: '小研', config }, { corpus: [] })).toContain('# 输出规范');
    expect(humanVoiceIssues('亲，加油哦😀😀')).toEqual(expect.arrayContaining(['包含廉价称呼', '包含空泛鼓励', 'emoji 堆砌']));
  });
});
