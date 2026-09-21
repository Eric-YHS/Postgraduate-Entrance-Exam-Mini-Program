// 学生端全流程 B 段：登录已开通课程的学员 → 上传 → 画像 → 分析 → 导图 → 计划 → 带背 → 刷题 → 收信箱。
// 需要 JOURNEY_PHONE / JOURNEY_PASSWORD（A 段已注册并审批过的学员）。
const { loadPlaywright, detectBrowserExecutable } = require('./scripts/browser-env.cjs');
const { chromium } = loadPlaywright();
const fs = require('fs');

const base = 'https://xiaoeduhub.online/robot';
const phone = process.env.JOURNEY_PHONE;
const password = process.env.JOURNEY_PASSWORD;
const failures = [];
const report = (ok, name, detail = '') => { console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${!ok && detail ? ' :: ' + String(detail).slice(0, 160) : ''}`); if (!ok) failures.push(name); };

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: detectBrowserExecutable(), args: ['--disable-dev-shm-usage', '--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('pageerror', e => errors.push('page:' + e.message.slice(0, 120)));

  await page.goto(`${base}/student.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#student-login-gate', { timeout: 15000 });
  await page.fill('#auth-phone', phone);
  await page.fill('#auth-password', password);
  await page.click('#auth-submit');
  await page.waitForSelector('#student-login-gate', { state: 'detached', timeout: 20000 });
  await page.waitForTimeout(1500);

  // 上传
  await page.locator('nav.nav [data-page="materials"]').first().click();
  await page.waitForTimeout(800);
  const txtPath = 'C:/Users/Eric/AppData/Local/Temp/journey-material.txt';
  fs.writeFileSync(txtPath, '第一章 社会工作概述。社会工作是运用科学方法助人的职业化服务活动，遵循利他主义价值观。基本要素包括社会工作者、服务对象、价值观、方法和助人活动。\n第二章 社会工作价值观。尊重、接纳、个别化、保密、服务对象自决是核心原则。\n第三章 个案工作。个案工作过程包括接案、预估、计划、介入、评估和结案。\n'.repeat(2), 'utf-8');
  await page.setInputFiles('#text-input', txtPath);
  await page.waitForTimeout(15000);
  const bucket = await page.evaluate(() => document.querySelector('#text-bucket')?.innerText || '');
  report(/已解析|已上传/.test(bucket), '上传文本资料并解析', bucket.replace(/\n/g, '|').slice(0, 100));

  // 画像
  await page.locator('nav.nav [data-page="school"]').first().click();
  await page.waitForTimeout(800);
  const genBtn = page.locator('#generate-approved-school-profile');
  if (await genBtn.count()) await genBtn.click();
  let portraitReady = false;
  for (let i = 0; i < 48; i++) {
    await page.waitForTimeout(5000);
    portraitReady = await page.evaluate(() => (document.querySelector('#school')?.innerText || '').includes('TARGET SCHOOL'));
    if (portraitReady) break;
  }
  report(portraitReady, '院校画像生成');

  // 分析
  await page.locator('nav.nav [data-page="materials"]').first().click();
  await page.waitForTimeout(600);
  await page.locator('#analyze').click();
  let analyzed = false;
  for (let i = 0; i < 48; i++) {
    await page.waitForTimeout(5000);
    analyzed = await page.evaluate(() => {
      const text = document.querySelector('#materials')?.innerText || '';
      return text.includes('知识条目') || text.includes('分析完成');
    });
    if (analyzed) break;
  }
  report(analyzed, 'AI 学习分析完成');

  // 导图
  await page.locator('nav.nav [data-page="knowledge"]').first().click();
  await page.waitForTimeout(800);
  await page.locator('#generate-map').click();
  let mapReady = false;
  for (let i = 0; i < 48; i++) {
    await page.waitForTimeout(5000);
    mapReady = await page.evaluate(() => !!document.querySelector('#map-canvas svg, .mind-elixir, .nodebox') || (document.querySelector('#knowledge')?.innerText || '').includes('已基于'));
    if (mapReady) break;
  }
  report(mapReady, '思维导图生成');

  // 计划
  await page.locator('nav.nav [data-page="plan"]').first().click();
  await page.waitForTimeout(600);
  await page.locator('#make-plan').click();
  await page.waitForTimeout(6000);
  const planText = await page.evaluate(() => (document.querySelector('#plan')?.innerText || ''));
  report(/分钟|任务|周/.test(planText), '复习规划生成', planText.slice(0, 80));

  // 带背
  await page.locator('nav.nav [data-page="recite"]').first().click();
  await page.waitForTimeout(1000);
  const startBtn = page.locator('#recite-start');
  if (await startBtn.count()) await startBtn.click();
  await page.waitForTimeout(2500);
  const reciteOn = await page.evaluate(() => document.body.classList.contains('recite-live') || !!(document.querySelector('#recite-stage-prompt')?.textContent || '').trim());
  report(reciteOn, '带背开始');

  // 刷题
  await page.locator('nav.nav [data-page="practice"]').first().click();
  await page.waitForTimeout(1000);
  const pickBtn = page.locator('#practice-start');
  if (await pickBtn.count()) await pickBtn.click();
  await page.waitForTimeout(2500);
  const hasQuestion = await page.evaluate(() => !!(document.querySelector('#practice-answer') && (document.querySelector('#practice')?.innerText || '').match(/题/)));
  report(hasQuestion, '刷题抽题');
  if (hasQuestion) {
    await page.fill('#practice-answer', '这是测试答案：社会工作是助人的职业化服务活动。');
    await page.locator('#practice-submit').click();
    await page.waitForTimeout(5000);
    const graded = await page.evaluate(() => (document.querySelector('#practice')?.innerText || '').match(/分|批改|反馈|命中|漏/));
    report(Boolean(graded), '刷题提交批改');
  }

  // 收信箱
  await page.locator('nav.nav [data-page="home"]').first().click();
  await page.waitForTimeout(1000);
  const inbox = await page.evaluate(() => document.body.innerText.includes('通知') || document.body.innerText.includes('收信箱'));
  report(inbox, '收信箱/通知入口存在');

  console.log('pageerrors:', errors.length ? errors.slice(0, 4) : 'none');
  console.log(failures.length ? `== ${failures.length} 项失败 ==` : '== B 段全部通过 ==');
  await browser.close();
  process.exit(failures.length ? 1 : 0);
})().catch(e => { console.error('FAIL', e.message.slice(0, 200)); process.exit(1); });
