const { loadPlaywright, detectBrowserExecutable, resolveBase } = require('./scripts/browser-env.cjs');
const { chromium } = loadPlaywright();

const base = resolveBase(4173);
const auditStudentId = process.env.AUDIT_STUDENT_ID || '48922e67-7908-44cc-9b78-483d9bee3d95';
const viewports = [
  { name: 'desktop-1440', width: 1440, height: 960 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'mobile-390', width: 390, height: 844 },
];

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(`page: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

async function checkViewport(page, viewport) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.waitForTimeout(200);
  return page.evaluate(() => ({
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
  }));
}

async function auditStudent(browser, viewport) {
  const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
  const errors = watchErrors(page);
  await page.addInitScript((studentId) => {
    localStorage.setItem('yanban-anonymous-student-id', studentId);
    // 导航/布局验收需要一个已登录会话；凭证只存在于此浏览器上下文，不进入任何仓库或截图。
    localStorage.setItem('yanban-student-session-token', 'predeploy-audit-session');
  }, auditStudentId);
  await page.route('**/api/auth/student/me', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      ok: true,
      studentId: auditStudentId,
      profile: { studentId: auditStudentId, displayName: '浏览器验收', examYear: '2027' },
      courseAccess: { baseCourseEnabled: true },
    }),
  }));
  await page.route('**/api/students/**', async route => {
    const request = route.request();
    if (request.method() !== 'POST') return route.continue();
    if (new URL(request.url()).pathname.endsWith('/bootstrap')) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        ok: true,
        profile: { studentId: auditStudentId, displayName: '浏览器验收', examYear: '2027' },
        courseAccess: { baseCourseEnabled: true },
        taskSupervision: { enabled: false },
        selfTest: { enabled: true },
        pricing: {},
        contact: {},
      }) });
    }
    return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.goto(`${base}/student.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  const pages = await page.locator('nav.nav [data-page]').evaluateAll(buttons => [...new Set(buttons.map(button => button.dataset.page).filter(Boolean))]);
  const navigation = [];
  for (const name of pages) {
    try {
      await page.locator(`nav.nav [data-page="${name}"]`).first().click({ timeout: 5000 });
      await page.waitForTimeout(50);
      navigation.push({ name, opened: await page.locator(`#${name}.on`).count() === 1 });
    } catch (error) {
      navigation.push({ name, opened: false, error: String(error).split('\n')[0].slice(0, 160) });
    }
  }
  const layout = await checkViewport(page, viewport);
  await page.close();
  return { page: 'student', viewport: viewport.name, navigation, layout, errors };
}

async function auditTeacher(browser, viewport) {
  const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
  const errors = watchErrors(page);
  await page.goto(`${base}/teacher.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  const views = await page.locator('nav.nav [data-view]').evaluateAll(buttons => [...new Set(buttons.map(button => button.dataset.view).filter(Boolean))]);
  const navigation = [];
  for (const name of views) {
    try {
      await page.locator(`nav.nav [data-view="${name}"]`).first().click({ timeout: 5000 });
      await page.waitForTimeout(50);
      navigation.push({ name, opened: await page.locator(`#${name}.on`).count() === 1 });
    } catch (error) {
      navigation.push({ name, opened: false, error: String(error).split('\n')[0].slice(0, 160) });
    }
  }
  const layout = await checkViewport(page, viewport);
  await page.close();
  return { page: 'teacher', viewport: viewport.name, navigation, layout, errors };
}

(async () => {
  const executablePath = detectBrowserExecutable();
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const result = [];
  for (const viewport of viewports) {
    result.push(await auditStudent(browser, viewport));
    result.push(await auditTeacher(browser, viewport));
  }
  await browser.close();
  console.log(JSON.stringify(result, null, 1));
  const failed = result.some(item =>
    item.errors.length ||
    item.layout.horizontalOverflow ||
    item.navigation.some(entry => !entry.opened));
  if (failed) process.exitCode = 1;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
