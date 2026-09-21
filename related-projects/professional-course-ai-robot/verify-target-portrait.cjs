const { loadPlaywright, detectBrowserExecutable, resolveBase } = require('./scripts/browser-env.cjs');
const { chromium } = loadPlaywright();

(async () => {
  const executablePath = detectBrowserExecutable();
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // 截图验收需要已登录会话，否则登录门会遮住目标院校报告。
  await page.addInitScript(() => {
    localStorage.setItem('yanban-anonymous-student-id', 'target-portrait-audit');
    localStorage.setItem('yanban-student-session-token', 'target-portrait-audit-session');
  });
  await page.route('**/api/auth/student/me', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, studentId: 'target-portrait-audit', profile: { studentId: 'target-portrait-audit', displayName: '画像验收', examYear: '2026' }, courseAccess: { baseCourseEnabled: true } }),
  }));
  await page.route('**/api/students/**', route => route.fulfill({
    contentType: 'application/json',
    body: '{"ok":true,"courseAccess":{"baseCourseEnabled":true},"profile":{"displayName":"画像验收"},"taskSupervision":{"enabled":false},"pricing":{},"contact":{}}',
  }));
  await page.goto(`${resolveBase(4173)}/student.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2600);
  await page.evaluate(() => {
    appState.courseAccess = { baseCourseEnabled: true };
    appState.subject = 'Audit Course';
    appState.target = { school: 'Audit University', college: 'Audit College', major: 'Audit Major', subjectCode: '999', examYear: '2026' };
    appState.schoolSubjectProfile = {
      courseIdentity: { school: 'Audit University', college: 'Audit College', major: 'Audit Major', subject: 'Audit Course', subjectCode: '999', examYear: '2026' },
      schoolCard: { region: 'South China', level: 'University', nature: 'Public', foundedYear: '1927', features: ['Applied science', 'Regional practice'], ratings: { recognition: 3, academic: 3, employment: 4, regional: 4, competition: 3 }, statement: 'A focused target for applied study and long-term professional growth.' },
      collegeProfile: { history: 'College summary.', faculty: 'Faculty resources.', researchPlatforms: ['Research platform'] },
      majorProfile: { positioning: 'Professional positioning.', coreAbilities: ['Analysis', 'Application'], researchDirections: ['Direction A', 'Direction B'], industryApplications: ['Industry A'] },
      examSystem: { subjects: [{ name: 'Audit Course', score: '150', difficulty: 'medium', importance: 'high', impact: 'Rank impact.' }], abilityAnalysis: ['Theory', 'Application'], importanceAnalysis: ['Core score driver'] },
      officialSyllabus: { title: 'Exam syllabus', shortExcerpt: 'Official syllabus interpretation.', outline: ['Foundation', 'Core', 'Applied'] },
      scope: { confirmedTopics: ['Foundation'], uncertainTopics: ['Books to verify'] },
      topicWeights: [{ topic: 'Key topic', level: 'high', basis: 'Evidence pending' }],
      questionBlueprint: [{ type: 'Short answer', answerStandard: ['Clear structure'] }],
      competitionProfile: { admission: { enrollment: 'Verify', recommendationExempt: 'Verify', unifiedExam: 'Verify' }, scoreLines: [], difficulty: { level: 'medium', reasons: ['Official data pending'] } },
      careerProfile: { roles: ['Role A'], industries: ['Industry A'], path: ['Master', 'Career'] },
      prepStrategy: { allocation: [{ subject: 'Professional', percent: 40 }, { subject: 'English', percent: 25 }, { subject: 'Politics', percent: 20 }], currentStage: ['Build framework'], professionalFocus: ['Core concepts'], riskAlerts: ['Verify evidence'] },
      strategyCard: { competitionLevel: 'medium', majorStrength: 'Applied advantage', examCharacteristics: ['Foundation', 'Application'], futureDirection: 'Professional pathway', summary: 'Turn the target into work completed today.' },
      webSearch: { status: 'completed' }, generationWarnings: ['Official figures still require verification.'],
    };
    renderSchoolPage();
    go('school');
    document.querySelector('#profile-onboarding')?.remove();
  });
  await page.screenshot({ path: 'target-portrait-audit.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  await page.screenshot({ path: 'target-portrait-mobile-audit.png', fullPage: true });
  const result = await page.evaluate(() => { const card=document.querySelector('.target-card'); const grid=card?.parentElement; return { report: Boolean(document.querySelector('.target-report')), cards: document.querySelectorAll('.target-card').length, exam: document.querySelectorAll('.exam-card').length, renderer: typeof renderSchoolPage, access: appState.courseAccess, schoolHtml: document.querySelector('#school-page-content')?.innerHTML.slice(0, 300), reportHeight: Math.round(document.querySelector('.target-report')?.getBoundingClientRect().height || 0), horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth, cardStyle: card ? {height:getComputedStyle(card).height,minHeight:getComputedStyle(card).minHeight,alignSelf:getComputedStyle(card).alignSelf} : null, gridStyle:grid ? {height:getComputedStyle(grid).height,gridAutoRows:getComputedStyle(grid).gridAutoRows,alignItems:getComputedStyle(grid).alignItems} : null, tallestCards: [...document.querySelectorAll('.target-card')].map(card => ({classes:card.className,height:Math.round(card.getBoundingClientRect().height)})).sort((a,b)=>b.height-a.height).slice(0,4) }; });
  console.log(JSON.stringify({ result, errors }));
  await browser.close();
})().catch(error => { console.error(error); process.exitCode = 1; });
