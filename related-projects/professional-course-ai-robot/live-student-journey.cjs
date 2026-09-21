// 研伴 AI 学生端全流程真实浏览器测试（无 mock，打生产）。
// 需要环境变量 YANBAN_LIVE_ADMIN_TOKEN（管理员令牌，用于中途审批课程）。
const { loadPlaywright, detectBrowserExecutable } = require('./scripts/browser-env.cjs');
const { chromium } = loadPlaywright();
const fs = require('fs');

const base = 'https://xiaoeduhub.online/robot';
const adminToken = process.env.YANBAN_LIVE_ADMIN_TOKEN || '';
const phone = '139' + String(Date.now()).slice(-8);
const password = 'journey-test-2026';
const failures = [];

function report(ok, name, detail = '') {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${!ok && detail ? ' :: ' + String(detail).slice(0, 200) : ''}`);
  if (!ok) failures.push(name);
}

async function adminCall(path, payload, method) {
  const resp = await fetch(`https://xiaoeduhub.online/robot/api${path}`, {
    method: method || (payload ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  return { status: resp.status, body: await resp.json().catch(() => ({})) };
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: detectBrowserExecutable(), args: ['--disable-dev-shm-usage', '--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('pageerror', e => errors.push('page:' + e.message.slice(0, 120)));

  // 1. 注册（限流安全：失败等 65s 重试一次）
  await page.goto(`${base}/student.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#student-login-gate', { timeout: 15000 });
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.click('#auth-switch').catch(() => {});
    await page.fill('#auth-display-name', '全流程验收学员');
    await page.fill('#auth-phone', phone);
    await page.fill('#auth-password', password);
    await page.fill('#auth-password-confirm', password);
    await page.click('#auth-submit');
    const gone = await page.waitForSelector('#student-login-gate', { state: 'detached', timeout: 25000 }).then(() => true).catch(() => false);
    if (gone) break;
    if (attempt === 0) await page.waitForTimeout(65000);
  }
  const entered = await page.evaluate(() => !document.body.classList.contains('student-auth-pending'));
  report(entered, '注册并进入学习空间');

  // 2. 档案（含收货信息）
  await page.locator('nav.nav [data-page="profile"]').first().click();
  await page.waitForSelector('#archive-basic-form', { timeout: 8000 });
  await page.fill('#student-display-name', '全流程验收学员');
  await page.fill('#student-phone', phone);
  await page.fill('#student-wechat', 'journey-wx');
  await page.fill('#student-email', 'journey@test.com');
  await page.fill('#student-shipping-recipient', '小卷');
  await page.fill('#student-shipping-phone', phone);
  await page.fill('#student-shipping-info', '湖北省武汉市洪山区测试路 1 号');
  await page.click('#archive-basic-form button[type="submit"], #archive-basic-form .primary');
  await page.waitForTimeout(1500);
  const profileSaved = await page.evaluate(() => document.querySelector('#student-wechat')?.value === 'journey-wx' && document.querySelector('#student-shipping-info')?.value.includes('测试路'));
  report(profileSaved, '档案保存（含收货信息）且不回写丢失');

  // 3. 申请专业课
  await page.locator('nav.nav [data-page="home"]').first().click();
  await page.waitForTimeout(600);
  const orb = page.locator('#official-course-orb');
  await orb.click();
  await page.waitForTimeout(800);
  const applyVisible = await page.evaluate(() => !!document.querySelector('#apply-school') || !!document.querySelector('#course-application.on'));
  if (applyVisible) {
    await page.fill('#apply-school', '华中师范大学');
    await page.fill('#apply-college', '社会学院');
    if (await page.locator('#apply-major').count()) await page.fill('#apply-major', '社会工作');
    if (await page.locator('#apply-major-code').count()) await page.fill('#apply-major-code', '035200');
    await page.fill('#apply-course-name', '社会工作原理');
    await page.fill('#apply-course-code', '331');
    await page.click('#submit-course-application');
    // 等提交结果落回来再断言
    await page.waitForFunction(() => (document.querySelector('#course-apply-note')?.textContent || '').includes('申请已提交'), { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1000);
  }
  const requested = (await adminCall('/admin/students')).body?.students?.find(s => s.accountPhone === phone || s.phone === phone);
  report(Boolean(requested && requested.permissionRequestStatus === 'pending'), '课程申请进入教师待办', JSON.stringify(requested || {}).slice(0, 120));

  // 4. 教师审批（走管理 API，与教师端同一接口）
  let approved = false;
  if (requested) {
    const res = await adminCall('/admin/students/course-access', { studentId: requested.id, baseCourseEnabled: true });
    approved = res.status === 200 && res.body?.courseAccess?.baseCourseEnabled;
  }
  report(approved, '教师端审批通过');

  // 5. 上传资料
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  await page.locator('nav.nav [data-page="materials"]').first().click();
  await page.waitForTimeout(800);
  const txtPath = 'C:/Users/Eric/AppData/Local/Temp/journey-material.txt';
  fs.writeFileSync(txtPath, '第一章 社会工作概述。社会工作是运用科学方法助人的职业化服务活动，遵循利他主义价值观。其基本要素包括社会工作者、服务对象、价值观、方法和助人活动。\n第二章 社会工作价值观。尊重、接纳、个别化、保密、服务对象自决是核心原则。\n第三章 个案工作。个案工作过程包括接案、预估、计划、介入、评估和结案。\n'.repeat(2), 'utf-8');
  await page.setInputFiles('#text-input', txtPath);
  // 上传+解析是异步的：等行内状态变化，再用教师端详情核实文件确实到了服务端。
  await page.waitForTimeout(15000);
  const bucketText = await page.evaluate(() => document.querySelector('#text-bucket')?.innerText || '');
  let serverSaw = false;
  if (requested) {
    const det = await adminCall(`/admin/students/${requested.id}/detail`);
    serverSaw = (det.body?.documents || []).some(d => (d.name || '').includes('journey-material'));
  }
  report(serverSaw || /已解析|已上传/.test(bucketText), '上传文本资料', bucketText.slice(0, 100) + ' | server:' + serverSaw);

  // 6. 院校画像（学校页）
  await page.locator('nav.nav [data-page="school"]').first().click();
  await page.waitForTimeout(800);
  const genBtn = page.locator('#generate-approved-school-profile');
  if (await genBtn.count()) {
    await genBtn.click();
    await page.waitForTimeout(1500);
  }
  // 画像生成是长任务：等最多 240s
  let portraitReady = false;
  for (let i = 0; i < 48; i++) {
    await page.waitForTimeout(5000);
    portraitReady = await page.evaluate(() => (document.querySelector('#school')?.innerText || '').includes('院校名片') || (document.querySelector('#school')?.innerText || '').includes('TARGET SCHOOL'));
    const failed = await page.evaluate(() => (document.querySelector('#school')?.innerText || '').match(/失败|无法|重试/));
    if (portraitReady || failed) break;
  }
  report(portraitReady, '院校画像生成', '超时或失败');

  // 7. AI 分析
  await page.locator('nav.nav [data-page="materials"]').first().click();
  await page.waitForTimeout(600);
  await page.locator('#analyze').click();
  let analyzed = false;
  for (let i = 0; i < 48; i++) {
    await page.waitForTimeout(5000);
    analyzed = await page.evaluate(() => {
      const text = document.querySelector('#materials')?.innerText || '';
      return text.includes('分析完成') || text.includes('已分析') || text.includes('知识条目');
    });
    const failed = await page.evaluate(() => (document.querySelector('#materials')?.innerText || '').match(/失败|未通过|重试/));
    if (analyzed || failed) break;
  }
  report(analyzed, 'AI 学习分析完成', '超时或失败');

  // 8. 思维导图
  await page.locator('nav.nav [data-page="knowledge"]').first().click();
  await page.waitForTimeout(800);
  await page.locator('#generate-map').click();
  let mapReady = false;
  for (let i = 0; i < 48; i++) {
    await page.waitForTimeout(5000);
    mapReady = await page.evaluate(() => {
      const canvas = document.querySelector('#map-canvas');
      const hasMindElixir = !!document.querySelector('.mind-elixir, #map-canvas svg, .nodebox');
      return hasMindElixir && !(document.querySelector('#map-canvas')?.hidden);
    });
    const failed = await page.evaluate(() => (document.querySelector('#knowledge')?.innerText || '').match(/失败|未通过|重试/));
    if (mapReady || failed) break;
  }
  report(mapReady, '思维导图生成', '超时或失败');

  // 9. 复习规划
  await page.locator('nav.nav [data-page="plan"]').first().click();
  await page.waitForTimeout(600);
  await page.locator('#make-plan').click();
  await page.waitForTimeout(6000);
  const planInfo = await page.evaluate(() => {
    const text = document.querySelector('#plan')?.innerText || '';
    return { hasDays: /周[一二三四五六日]/.test(text) || text.includes('今天'), len: text.length };
  });
  report(planInfo.hasDays, '复习规划生成', JSON.stringify(planInfo));

  // 10. 带背（开始→看答案→会）
  await page.locator('nav.nav [data-page="recite"]').first().click();
  await page.waitForTimeout(800);
  const startBtn = page.locator('#recite-start');
  if (await startBtn.count()) await startBtn.click();
  await page.waitForTimeout(2000);
  const reciteStarted = await page.evaluate(() => document.body.classList.contains('recite-live') || !!(document.querySelector('#recite-stage-prompt')?.textContent || '').trim());
  report(reciteStarted, '带背开始');

  // 11. 刷题（抽题→作答→提交）
  await page.locator('nav.nav [data-page="practice"]').first().click();
  await page.waitForTimeout(800);
  const pickBtn = page.locator('#practice-start');
  if (await pickBtn.count()) await pickBtn.click();
  await page.waitForTimeout(2000);
  const hasQuestion = await page.evaluate(() => !!(document.querySelector('#practice-answer') && (document.querySelector('#practice .question-card') || document.querySelector('#practice-stem') || (document.querySelector('#practice')?.innerText || '').match(/题|答/))));
  report(hasQuestion, '刷题抽题');
  if (hasQuestion) {
    await page.fill('#practice-answer', '这是测试答案：社会工作是助人的职业化服务活动。');
    await page.locator('#practice-submit').click();
    await page.waitForTimeout(4000);
    const graded = await page.evaluate(() => (document.querySelector('#practice')?.innerText || '').match(/分|批改|反馈|命中|漏/));
    report(Boolean(graded), '刷题提交批改');
  }

  // 12. 收信箱
  const inboxState = await page.evaluate(async () => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('收信箱'));
    if (btn) { btn.click(); return 'clicked'; }
    return document.querySelector('#home')?.innerText.includes('通知') ? 'home-entry' : 'none';
  });
  report(inboxState !== 'none', '收信箱入口存在', inboxState);

  console.log('pageerrors:', errors.length ? errors.slice(0, 4) : 'none');
  console.log(`STUDENT_PHONE=${phone}`);
  console.log(failures.length ? `== ${failures.length} 项失败 ==` : '== 学生端全流程通过 ==');
  await browser.close();
  process.exit(failures.length ? 1 : 0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
