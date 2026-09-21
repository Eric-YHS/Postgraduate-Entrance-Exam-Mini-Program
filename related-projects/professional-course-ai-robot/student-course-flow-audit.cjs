const { loadPlaywright, detectBrowserExecutable, resolveBase } = require('./scripts/browser-env.cjs');
const { chromium } = loadPlaywright();

const base = `${resolveBase(5173)}/student.html`;
const studentId = 'student-course-flow-audit';

function apiPayload() {
  return {
    ok: true,
    profile: { studentId, displayName: '测试同学', examYear: '' },
    courseAccess: {
      baseCourseEnabled: false,
      extraCourseEnabled: false,
      requestStatus: 'not_requested',
      extraRequestStatus: 'not_requested',
    },
    taskSupervision: { enabled: false },
    selfTest: { enabled: true },
    pricing: {},
    contact: {},
    workspace: {},
  };
}

async function setState(page, overrides) {
  await page.evaluate((state) => {
    Object.assign(appState, state);
    saveLocalWorkspace();
    renderAll();
  }, overrides);
  await page.waitForTimeout(80);
}

(async () => {
  const executablePath = detectBrowserExecutable();
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.addInitScript((id) => {
    localStorage.setItem('yanban-anonymous-student-id', id);
    localStorage.setItem('yanban-student-session-token', 'course-flow-audit-session');
    localStorage.removeItem('yanban-study-workspace-v2');
  }, studentId);
  await page.route('**/api/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    // 会话校验需要顶层 studentId；其余接口保持原有的静态载荷。
    if (pathname.endsWith('/auth/student/me')) {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ...apiPayload(), studentId }),
      });
    }
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(apiPayload()),
    });
  });
  await page.goto(base, { waitUntil: 'networkidle' });

  // 首页课程入口以 #official-course-orb 为准：第二门未提交时引导申请，
  // 已提交/已开通时必须指向院校学习页而不是继续显示申请入口。
  await setState(page, {
    courseSlots: [{ id: 'course-1', title: '专业课 1', subject: '课程一', target: {}, billingStatus: 'included' }],
    activeCourseId: 'course-1',
    courseAccess: {
      baseCourseEnabled: true,
      extraCourseEnabled: false,
      requestStatus: 'approved',
      extraRequestStatus: 'not_requested',
    },
  });
  const orb = page.locator('#official-course-orb');
  await orb.waitFor({ state: 'attached', timeout: 10000 });
  const pendingSecondText = await orb.innerText();
  if (!pendingSecondText.includes('第二门')) {
    throw new Error(`第二门未提交时首页操作不正确：${pendingSecondText}`);
  }
  await orb.click();
  await page.waitForSelector('#extra-course-modal', { timeout: 5000 });
  await page.locator('#extra-course-modal .modal-head button').first().click();
  await page.waitForSelector('#extra-course-modal', { state: 'detached', timeout: 5000 });

  await setState(page, {
    courseSlots: [
      { id: 'course-1', title: '专业课 1', subject: '课程一', target: {}, billingStatus: 'included' },
      { id: 'course-2', title: '专业课 2', subject: '课程二', target: {}, billingStatus: 'addon_requested' },
    ],
    courseAccess: {
      baseCourseEnabled: true,
      extraCourseEnabled: false,
      requestStatus: 'approved',
      extraRequestStatus: 'pending',
    },
  });
  const bothSubmittedText = await orb.innerText();
  if (bothSubmittedText.includes('生成第二门')) {
    throw new Error(`第二门已提交时首页仍显示申请入口：${bothSubmittedText}`);
  }
  await orb.click();
  await page.waitForTimeout(150);
  if (await page.locator('#school.on').count() !== 1) {
    throw new Error('第二门已提交时没有进入院校学习入口。');
  }

  await page.locator('[data-page="profile"]').first().click();
  await page.waitForSelector('#student-exam-year');
  await page.locator('#student-exam-year').fill('2026');
  await page.locator('#archive-basic-form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await page.waitForTimeout(120);
  const state = await page.evaluate(() => ({
    examYear: appState.target?.examYear,
    years: (appState.courseSlots || []).map(course => course.target?.examYear),
  }));
  if (state.examYear !== '2026' || state.years.some(year => year !== '2026')) {
    throw new Error(`考试年份没有同步到全部专业课：${JSON.stringify(state)}`);
  }
  if (errors.length) throw new Error(`页面错误：${errors.join(' | ')}`);
  await browser.close();
  console.log('student course flow audit: PASS');
})().catch(async error => {
  console.error(error);
  process.exitCode = 1;
});
