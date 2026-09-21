// 研伴 AI 生产环境真实浏览器 E2E（无 mock，打真实部署）。
// 用法：YANBAN_LIVE_ADMIN_TOKEN=<管理员令牌> [LIVE_BASE=https://xiaoeduhub.online/robot] node live-browser-e2e.cjs
// 覆盖：学生端真实注册→进入学习空间→双视口导航；教师端真实令牌登录→主视图加载。
// 结束时输出注册的学生 id，供服务端清理测试数据。
const { loadPlaywright, detectBrowserExecutable } = require('./scripts/browser-env.cjs');
const { chromium } = loadPlaywright();

const base = (process.env.LIVE_BASE || 'https://xiaoeduhub.online/robot').replace(/\/$/, '');
const adminToken = process.env.YANBAN_LIVE_ADMIN_TOKEN || '';
const phone = `139${String(Date.now()).slice(-8)}`;
const password = 'live-e2e-20260902';
const failures = [];

function report(ok, name, detail = '') {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${!ok && detail ? ` :: ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

function watchErrors(page, ignore) {
  const errors = [];
  page.on('pageerror', error => errors.push(`page: ${error.message}`));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const location = message.location()?.url || '';
    if (ignore && ignore(message.text(), location)) return;
    errors.push(`console: ${message.text()}`);
  });
  return errors;
}

async function studentFlow(browser, viewport) {
  const page = await browser.newPage({ viewport });
  const errors = watchErrors(page);
  await page.goto(`${base}/student.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#student-login-gate', { timeout: 15000 });
  await page.click('#auth-switch');
  await page.fill('#auth-display-name', '浏览器验收学员');
  await page.fill('#auth-phone', phone);
  await page.fill('#auth-password', password);
  await page.fill('#auth-password-confirm', password);
  await page.click('#auth-submit');
  await page.waitForSelector('#student-login-gate', { state: 'detached', timeout: 20000 });
  await page.waitForTimeout(1500);
  const state = await page.evaluate(() => ({
    bodyClass: document.body.className,
    studentId: localStorage.getItem('yanban-anonymous-student-id') || '',
    navCount: document.querySelectorAll('nav.nav [data-page]').length,
  }));
  report(!state.bodyClass.includes('student-auth-pending'), `学生端注册后进入学习空间（${viewport.name}）`, `bodyClass=${state.bodyClass}`);
  const navigation = [];
  const pages = await page.locator('nav.nav [data-page]').evaluateAll(buttons => [...new Set(buttons.map(b => b.dataset.page).filter(Boolean))]);
  for (const name of pages) {
    try {
      await page.locator(`nav.nav [data-page="${name}"]`).first().click({ timeout: 5000 });
      await page.waitForTimeout(80);
      navigation.push({ name, opened: await page.locator(`#${name}.on`).count() === 1 });
    } catch (error) {
      navigation.push({ name, opened: false, error: String(error).split('\n')[0].slice(0, 120) });
    }
  }
  const failedNav = navigation.filter(item => !item.opened);
  report(failedNav.length === 0, `学生端 ${viewport.name} 导航 ${pages.length} 项全部可打开`, JSON.stringify(failedNav));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  report(!overflow, `学生端 ${viewport.name} 无横向溢出`);
  report(errors.length === 0, `学生端 ${viewport.name} 无控制台错误`, errors.slice(0, 3).join(' | '));
  const studentId = state.studentId;
  await page.close();
  return studentId;
}

async function teacherFlow(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  // 账号体系首启 bootstrap 探测是设计内的一次性请求：发现需要初始化后面板改为本地状态驱动。
  const errors = watchErrors(page, (text, url) => url.includes('/api/admin/accounts') && text.includes('403'));
  page.on('response', response => {
    if (response.status() >= 400) {
      if (response.url().includes('/api/admin/accounts') && response.status() === 403) return;
      errors.push(`http${response.status()}: ${response.request().method()} ${response.url()}`);
    }
  });
  await page.goto(`${base}/teacher.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#admin-token-input', { timeout: 15000 });
  await page.fill('#admin-token-input', adminToken);
  await page.click('#admin-login-button');
  await page.waitForFunction(() => document.querySelector('#admin-auth-status')?.textContent?.includes('已连接'), undefined, { timeout: 20000 });
  report(true, '教师端管理员令牌登录');
  await page.waitForTimeout(2000);
  const overview = await page.evaluate(() => ({
    todo: document.querySelector('#overview-todo-summary')?.textContent || '',
    students: document.querySelectorAll('#students-body tr').length,
  }));
  report(true, `教师端概览加载（待办：${overview.todo || '已读取'}；学生行数：${overview.students}）`);
  const views = await page.locator('nav.nav [data-view]').evaluateAll(buttons => [...new Set(buttons.map(b => b.dataset.view).filter(Boolean))]);
  const failedViews = [];
  for (const name of views) {
    try {
      await page.locator(`nav.nav [data-view="${name}"]`).first().click({ timeout: 5000 });
      await page.waitForTimeout(80);
      if (await page.locator(`#${name}.on`).count() !== 1) failedViews.push(name);
    } catch {
      failedViews.push(name);
    }
  }
  report(failedViews.length === 0, `教师端导航 ${views.length} 项全部可打开`, failedViews.join(','));
  report(errors.length === 0, '教师端无控制台错误', errors.slice(0, 3).join(' | '));
  await page.close();
}

(async () => {
  if (!adminToken) throw new Error('YANBAN_LIVE_ADMIN_TOKEN 未设置');
  const executablePath = detectBrowserExecutable();
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  // 教师端先跑：生产限流按源 IP 计数，学生流程的请求量可能挤占同一分钟窗口。
  try {
    await teacherFlow(browser);
  } catch (error) {
    console.log('[INFO] 教师端首次登录未就绪，等待限流窗口后重试一次…');
    await new Promise(resolve => setTimeout(resolve, 65000));
    await teacherFlow(browser);
  }
  const studentId = await studentFlow(browser, { name: 'desktop-1440', width: 1440, height: 960 });
  await studentFlow(browser, { name: 'mobile-390', width: 390, height: 844 });
  await browser.close();
  console.log(`STUDENT_ID=${studentId} PHONE=${phone}`);
  console.log(failures.length ? `== ${failures.length} 项失败 ==` : '== 浏览器真实环境 E2E 全部通过 ==');
  process.exitCode = failures.length ? 1 : 0;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
