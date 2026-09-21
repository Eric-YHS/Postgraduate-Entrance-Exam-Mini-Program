// 公共课（上岸平台）真实浏览器冒烟：注册→首用引导→登记→倒计时→商城领取→教师端登录。
const { loadPlaywright, detectBrowserExecutable } = require('E:/花卷交付/专业课AI机器人(1)/专业课AI机器人/scripts/browser-env.cjs');
const { chromium } = loadPlaywright();
const failures = [];
const report = (ok, name, detail = '') => { console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${!ok && detail ? ' :: ' + detail : ''}`); if (!ok) failures.push(name); };

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: detectBrowserExecutable(), args: ['--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message.slice(0, 120)));
  const phone = '137' + String(Date.now()).slice(-8);

  // 1. 注册 → 首用引导
  await page.goto('https://xiaoeduhub.online/student', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('text=创建学生账号', { timeout: 15000 });
  await page.click('text=创建学生账号');
  await page.fill('input[placeholder="请输入昵称"]', '公共课验收');
  await page.fill('input[placeholder="请输入 11 位手机号"]', phone);
  await page.fill('input[type="password"]', 'gonggongke-2026');
  await page.click('button:has-text("完成注册")');
  await page.waitForTimeout(2500);
  const afterReg = await page.evaluate(() => ({
    trialModal: !!document.querySelector('.free-trial-modal'),
    countdown: !!document.querySelector('.exam-countdown-time'),
  }));
  report(afterReg.trialModal, '注册后出现 7 天免费体验弹窗');
  report(!afterReg.countdown, '未登记考试信息前不显示倒计时');

  // 2. 暂不体验 → 首页引导卡片
  const defer = page.locator('button:has-text("暂不体验")');
  if (await defer.count()) await defer.click();
  await page.waitForTimeout(800);
  const guide = await page.evaluate(() => (document.querySelector('.exam-countdown-guide')?.innerText || '').slice(0, 120));
  report(/登记考试信息/.test(guide), '首页两步引导卡片存在', guide);

  // 3. 登记考试信息（年份+勾一门科目）
  const goProfile = page.locator('button:has-text("去「我的」登记考试信息")').first();
  if (await goProfile.count()) await goProfile.click();
  await page.waitForTimeout(1200);
  const yearSelect = page.locator('select').first();
  await yearSelect.selectOption({ index: 1 }).catch(() => {});
  await page.locator('input[type="checkbox"]').first().check().catch(() => {});
  await page.locator('button:has-text("保存")').first().click();
  await page.waitForTimeout(1500);
  await page.goto('https://xiaoeduhub.online/student', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const cd = await page.evaluate(() => ({
    countdown: !!document.querySelector('.exam-countdown-time'),
    label: document.querySelector('.exam-countdown-label')?.textContent || '',
    note: document.querySelector('.exam-countdown-note')?.textContent || '',
  }));
  report(cd.countdown, '登记后倒计时出现');
  report(/暂定/.test(cd.label) && /12 月 20/.test(cd.note), '倒计时带暂定日期与注释', cd.label + ' | ' + cd.note);

  // 4. 商城免费领取
  await page.locator('text=商城').first().click();
  await page.waitForTimeout(1500);
  const freeBtn = page.locator('button:has-text("免费领取")').first();
  report(await freeBtn.count() > 0, '商城有免费课程可领取');
  if (await freeBtn.count()) {
    await freeBtn.click();
    await page.waitForTimeout(2500);
    const toast = await page.evaluate(() => document.body.innerText.includes('已领取') || document.body.innerText.includes('已开通'));
    report(toast, '免费领取成功提示', '');
    await page.locator('text=我的课程').first().click();
    await page.waitForTimeout(1500);
    const mine = await page.evaluate(() => document.body.innerText.includes('测试课程') || document.body.innerText.includes('政治'));
    report(mine, '领取后课程进入我的课程');
  }
  report(errors.length === 0, '学生端无页面错误', errors.slice(0, 3).join('|'));

  // 5. 教师端登录
  const page2 = await browser.newPage();
  await page2.goto('https://xiaoeduhub.online/teacher', { waitUntil: 'domcontentloaded' });
  await page2.waitForTimeout(1500);
  const isTeacherLogin = await page2.evaluate(() => (document.querySelector('.auth-page .eyebrow')?.textContent || document.querySelector('.eyebrow')?.textContent || '').includes('教师端'));
  report(isTeacherLogin, '教师端显示教师端登录');
  await page2.fill('input[inputmode="tel"], input[placeholder*="手机号"]', '13800000001');
  await page2.fill('input[type="password"]', 'QigeTeacher2026!');
  await page2.click('button[type="submit"], button:has-text("登录")');
  await page2.waitForTimeout(2500);
  const inDashboard = await page2.evaluate(() => document.body.innerText.includes('数据看板'));
  report(inDashboard, '教师端登录进入数据看板');

  console.log('STUDENT_PHONE=' + phone);
  console.log(failures.length ? `== ${failures.length} 项失败 ==` : '== 公共课冒烟全部通过 ==');
  await browser.close();
  process.exit(failures.length ? 1 : 0);
})().catch(e => { console.error('FAIL', e.message.slice(0, 200)); process.exit(1); });
