const { chromium } = require('C:/Users/Shi04/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const base = 'http://127.0.0.1:8000';
const auditStudentId = '48922e67-7908-44cc-9b78-483d9bee3d95';

async function auditStudent(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('pageerror', error => errors.push(`page: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  await page.addInitScript((studentId) => {
    localStorage.setItem('yanban-anonymous-student-id', studentId);
  }, auditStudentId);
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
  const pages = await page.locator('[data-page]').evaluateAll(buttons => [...new Set(buttons.map(button => button.dataset.page).filter(Boolean))]);
  const navigation = [];
  for (const name of pages) {
    await page.locator(`[data-page="${name}"]`).first().click();
    await page.waitForTimeout(50);
    navigation.push({ name, opened: await page.locator(`#${name}.on`).count() === 1 });
  }
  await page.close();
  return { page: 'student', navigation, errors };
}

async function auditTeacher(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('pageerror', error => errors.push(`page: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  await page.goto(`${base}/teacher.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  const views = await page.locator('[data-view]').evaluateAll(buttons => [...new Set(buttons.map(button => button.dataset.view).filter(Boolean))]);
  const navigation = [];
  for (const name of views) {
    await page.locator(`[data-view="${name}"]`).first().click();
    await page.waitForTimeout(50);
    navigation.push({ name, opened: await page.locator(`#${name}.on`).count() === 1 });
  }
  await page.close();
  return { page: 'teacher', navigation, errors };
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const result = [await auditStudent(browser), await auditTeacher(browser)];
  await browser.close();
  console.log(JSON.stringify(result));
  if (result.some(item => item.errors.length || item.navigation.some(entry => !entry.opened))) process.exitCode = 1;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

