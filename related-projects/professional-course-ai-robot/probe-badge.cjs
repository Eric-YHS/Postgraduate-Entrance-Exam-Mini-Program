// 校徽渲染验证：登录演示学生 → 院校页 → 等待校徽出现 → 截图。
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || '@playwright/test');

const base = process.env.LIVE_BASE || 'https://xiaoeduhub.online/robot';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${base}/student.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#student-login-gate', { timeout: 15000 });
  await page.fill('#auth-phone', '13800000001');
  await page.fill('#auth-password', 'yanban2026');
  await page.click('#auth-submit');
  await page.waitForSelector('#student-login-gate', { state: 'detached', timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.locator('nav.nav [data-page="school"]').first().click();
  let found = false;
  for (let i = 0; i < 45 && !found; i += 1) {
    await page.waitForTimeout(2000);
    found = await page.locator('.school-badge-img').count() > 0;
  }
  // 再等 3 秒确认徽标不会在后续重渲染中被抹掉。
  await page.waitForTimeout(3000);
  const info = await page.evaluate(() => {
    const img = document.querySelector('.school-badge-img');
    return {
      imgFound: Boolean(img),
      stillThere: document.querySelectorAll('.school-badge-img').length,
      imgSrc: img ? img.getAttribute('src') : '',
      imgNatural: img ? `${img.naturalWidth}x${img.naturalHeight}` : '',
      imgVisible: img ? (img.offsetWidth > 0 && img.offsetHeight > 0) : false,
    };
  });
  console.log(JSON.stringify(info));
  await page.screenshot({ path: process.env.SHOT || '_badge_hero.png', clip: { x: 250, y: 60, width: 1100, height: 400 } });
  await browser.close();
  if (!info.imgFound || !info.imgVisible) { console.log('BADGE_MISSING'); process.exit(1); }
  console.log('BADGE_OK');
})().catch((e) => { console.error('FAIL', String(e).split('\n')[0]); process.exit(1); });
