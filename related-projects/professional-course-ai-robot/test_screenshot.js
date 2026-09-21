const pwPath = 'C:/Users/Shi04/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright';
const { chromium } = require(pwPath);
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:4173/student.html');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);
  // Dismiss personal info modal by filling name
  if (await page.locator('#profile-onboarding').count() > 0) {
    await page.fill('#profile-onboarding input[name="displayName"]', '测试同学');
    await page.click('#profile-onboarding button[type="submit"]');
    await page.waitForTimeout(1500);
  }
  // Force first-course approved and open extra modal
  await page.evaluate(() => {
    appState.courseAccess.baseCourseEnabled = true;
    appState.studentProfile.examYear = '2027';
    openExtraCourseRequest();
  });
  await page.waitForTimeout(800);
  // Fill the 6 fields
  await page.fill('#extra-apply-school', '测试大学B');
  await page.fill('#extra-apply-college', '测试学院B');
  await page.fill('#extra-apply-major', '测试专业B');
  await page.fill('#extra-apply-major-code', '200000');
  await page.fill('#extra-apply-course-name', '测试科目B');
  await page.fill('#extra-apply-subject-code', '202');
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'debug_extra_filled.png', fullPage: false });
  await browser.close();
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
