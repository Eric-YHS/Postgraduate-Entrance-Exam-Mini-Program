// 最终回归：学生端三处修复 + 教师端学习产出注入。
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || '@playwright/test');

const base = 'https://xiaoeduhub.online/robot';
const adminToken = process.env.YANBAN_LIVE_ADMIN_TOKEN || '';
const results = [];
const report = (ok, name, detail = '') => { results.push(ok); console.log(ok ? '[PASS]' : '[FAIL]', name, detail); };

(async () => {
  const browser = await chromium.launch();

  // 学生端
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${base}/student.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#student-login-gate', { timeout: 15000 });
    await page.fill('#auth-phone', '13800000001');
    await page.fill('#auth-password', 'yanban2026');
    await page.click('#auth-submit');
    await page.waitForSelector('#student-login-gate', { state: 'detached', timeout: 20000 });
    await page.waitForTimeout(2500);
    const home = await page.evaluate(() => document.body.innerText);
    report(!/发货：\d{4}-\d{2}-\d{2}T/.test(home), '收信箱物流时间已格式化');
    // 院校页 unknown 兜底
    await page.locator('nav.nav [data-page="school"]').first().click();
    await page.waitForTimeout(2000);
    const schoolText = await page.evaluate(() => document.querySelector('#school')?.innerText || '');
    report(!/\bunknown\b/i.test(schoolText), '院校页不再出现 unknown', (schoolText.match(/待评估/) || [])[0] || '');
    await page.screenshot({ path: 'E:/花卷交付/_check_screenshots/final-student-school.png' });
    await page.close();
    // 移动端底栏
    const mp = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await mp.goto(`${base}/student.html`, { waitUntil: 'domcontentloaded' });
    await mp.waitForSelector('#student-login-gate', { timeout: 15000 });
    await mp.fill('#auth-phone', '13800000001');
    await mp.fill('#auth-password', 'yanban2026');
    await mp.click('#auth-submit');
    await mp.waitForSelector('#student-login-gate', { state: 'detached', timeout: 20000 });
    await mp.waitForTimeout(2000);
    const clipped = await mp.evaluate(() => {
      const bad = [];
      document.querySelectorAll('.nav button').forEach(b => {
        if (b.scrollHeight > b.clientHeight + 2) bad.push(b.textContent.trim());
      });
      return bad;
    });
    report(clipped.length === 0, '移动端底栏文字不再被裁切', clipped.join(','));
    await mp.screenshot({ path: 'E:/花卷交付/_check_screenshots/final-student-mobile.png' });
    await mp.close();
  }

  // 教师端：学习产出注入仍正常 + 登录卡隐藏 + 编号显示
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${base}/teacher.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#admin-token-input', { timeout: 15000 });
    await page.fill('#admin-token-input', adminToken);
    await page.click('#admin-login-button');
    await page.waitForTimeout(2500);
    const hidden = await page.evaluate(() => {
      const p = document.querySelector('#admin-auth-panel');
      return p ? getComputedStyle(p).display === 'none' : true;
    });
    report(hidden, '教师端登录卡隐藏');
    // 打开 验收体验账号 学习详情
    await page.locator('[data-view="students"]').first().click();
    await page.waitForTimeout(2000);
    const clicked = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('tr')];
      const row = rows.find(r => (r.textContent || '').includes('验收体验账号'));
      if (!row) return false;
      const btn = [...row.querySelectorAll('button')].find(b => b.textContent.includes('学习详情'));
      if (!btn) return false;
      btn.click();
      return true;
    });
    report(clicked, '找到并打开验收体验账号的学习详情');
    await page.waitForTimeout(2500);
    let groups = [];
    for (let i = 0; i < 8; i += 1) {
      groups = await page.evaluate(() => [...document.querySelectorAll('.learning-content-group summary')].map(s => s.textContent.trim()));
      if (groups.length) break;
      await page.waitForTimeout(1500);
    }
    report(groups.some(g => g.includes('题库')), '学习产出分组渲染（题库等）', groups.join(' | '));
    await page.screenshot({ path: 'E:/花卷交付/_check_screenshots/final-teacher-detail.png' });
    await page.close();
  }

  await browser.close();
  console.log(`== ${results.filter(Boolean).length}/${results.length} PASS ==`);
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error('FATAL', String(e).split('\n')[0]); process.exit(2); });
