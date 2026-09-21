// 本轮改动双端验证：教师端登录卡隐藏/资料搜索+编号+下载；学生端信封图标/新页面/带背按钮。
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || '@playwright/test');

const base = process.env.LIVE_BASE || 'https://xiaoeduhub.online/robot';
const adminToken = process.env.YANBAN_LIVE_ADMIN_TOKEN || '';
const results = [];
const report = (ok, name, detail = '') => { results.push({ ok, name }); console.log(`${ok ? '[PASS]' : '[FAIL]'}`, name, detail); };

(async () => {
  const browser = await chromium.launch();

  // ===== 教师端 =====
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 120)));
    await page.goto(`${base}/teacher.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#admin-token-input', { timeout: 15000 });
    await page.fill('#admin-token-input', adminToken);
    await page.click('#admin-login-button');
    await page.waitForTimeout(2500);
    const cardHidden = await page.evaluate(() => {
      const panel = document.querySelector('#admin-auth-panel');
      return panel ? getComputedStyle(panel).display === 'none' : true;
    });
    report(cardHidden, '教师端登录后登录卡隐藏');
    const exitBtn = await page.locator('#admin-auth-exit').count();
    report(exitBtn > 0, '教师端退出登录小按钮出现');

    // 资料管理页
    await page.locator('[data-view="courses"]').first().click();
    await page.waitForTimeout(2500);
    const searchCount = await page.locator('#knowledge-search').count();
    report(searchCount > 0, '资料管理搜索框存在');
    if (searchCount > 0) {
      await page.fill('#knowledge-search', '华中师范大学');
      await page.waitForTimeout(1200);
      const bodyText = await page.evaluate(() => document.body.innerText);
      report(bodyText.includes('社会工作原理'), '搜索"华中师范大学"能过滤出对应资料');
      await page.fill('#knowledge-search', '315');
      await page.waitForTimeout(1200);
      const t2 = await page.evaluate(() => document.body.innerText);
      report(t2.includes('315'), '搜索编号 315 能过滤出化学（农）资料');
      await page.fill('#knowledge-search', '');
      await page.waitForTimeout(800);
    }
    const dlCount = await page.locator('.doc-download').count();
    report(dlCount > 0, `资料下载按钮存在（${dlCount} 个）`);
    const codeShown = await page.evaluate(() => document.body.innerText.includes('编号'));
    report(codeShown, '专业课编号列已显示');
    report(errors.length === 0, '教师端无页面错误', errors.join(';'));
    await page.close();
  }

  // ===== 学生端 =====
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 120)));
    await page.goto(`${base}/student.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#student-login-gate', { timeout: 15000 });
    await page.fill('#auth-phone', '13800000001');
    await page.fill('#auth-password', 'yanban2026');
    await page.click('#auth-submit');
    await page.waitForSelector('#student-login-gate', { state: 'detached', timeout: 20000 });
    await page.waitForTimeout(2500);

    const navPages = await page.locator('.nav [data-page], nav.nav [data-page]').evaluateAll(ns => [...new Set(ns.map(n => n.dataset.page))]);
    report(navPages.includes('selftests') && navPages.includes('summaries'), `左侧栏含自测记录/学习总结（${navPages.join(',')}）`);

    for (const name of ['selftests', 'summaries']) {
      await page.locator(`.nav [data-page="${name}"], nav.nav [data-page="${name}"]`).first().click();
      await page.waitForTimeout(600);
      const on = await page.locator(`#${name}.on`).count();
      report(on === 1, `页面 #${name} 可打开`);
    }

    // 带背页按钮
    await page.locator('.nav [data-page="recite"], nav.nav [data-page="recite"]').first().click();
    await page.waitForTimeout(800);
    const oldBtn = await page.locator('#recite-settings-open').count();
    report(oldBtn === 0, '带背页重复按钮已删除');

    // 信封图标
    const bell = await page.locator('.inbox-fab, #inbox-fab, [class*="inbox"][class*="fab"], button:has-text("✉")').count();
    report(bell > 0, '右下角信封图标存在');
    if (bell > 0) {
      await page.locator('.inbox-fab, #inbox-fab, [class*="inbox"][class*="fab"], button:has-text("✉")').first().click();
      await page.waitForTimeout(1500);
      const panelInfo = await page.evaluate(() => {
        const texts = document.body.innerText;
        return {
          noRawType: !texts.includes('analysis_failed'),
          hasCnTitle: texts.includes('学习分析未完成') || texts.includes('课程申请'),
          noIsoTime: !/T\d{2}:\d{2}:\d{2}\.\d+\+00:00/.test(texts),
        };
      });
      report(panelInfo.noRawType && panelInfo.hasCnTitle, '通知标题已中文化');
      report(panelInfo.noIsoTime, '通知时间已格式化');
    }
    report(errors.length === 0, '学生端无页面错误', errors.join(';'));
    await page.screenshot({ path: process.env.SHOT || '_round5_check.png' });
    await page.close();
  }

  await browser.close();
  const failed = results.filter(r => !r.ok);
  console.log(`== ${results.length - failed.length}/${results.length} PASS ==`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', String(e).split('\n')[0]); process.exit(1); });
