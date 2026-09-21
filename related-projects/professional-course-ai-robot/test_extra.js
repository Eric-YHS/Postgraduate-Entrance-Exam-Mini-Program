const pwPath = 'C:/Users/Shi04/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright';
const { chromium } = require(pwPath);
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(`[ERR] ${m.text()}`); });
  page.on('pageerror', e => errors.push(`[PAGE_ERR] ${e.message}`));
  page.on('response', r => {
    if (r.url().includes('/api/students/extra-course-request')) {
      errors.push(`[api ${r.status()}] ${r.url()}`);
    }
  });
  await page.goto('http://127.0.0.1:4173/student.html');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  // Force state: pretend first course is approved so second-course modal can open
  await page.evaluate(() => {
    appState.courseAccess.baseCourseEnabled = true;
    appState.studentProfile.examYear = '2027';
  });
  // Trigger second-course modal
  await page.evaluate(() => { openExtraCourseRequest(); });
  await page.waitForTimeout(500);

  // Snapshot second course modal
  const modalInfo = await page.evaluate(() => {
    const modal = document.querySelector('#extra-course-modal');
    if (!modal) return null;
    const inputs = [...modal.querySelectorAll('input, textarea, select')].map(i => ({ id: i.id, name: i.name, type: i.type, placeholder: i.placeholder, required: i.required, tag: i.tagName }));
    const html = modal.innerHTML;
    const hasPayment = /payment|paymentReference|paymentNote|priceLabel|付款单号/.test(html);
    const hasPreview = !!modal.querySelector('#extra-course-preview-step') || !!modal.querySelector('#extra-course-preview');
    const buttons = [...modal.querySelectorAll('button')].map(b => ({ text: b.textContent.trim(), type: b.type, id: b.id }));
    const introText = modal.querySelector('.modal-body p')?.textContent || '';
    return { inputs, hasPayment, hasPreview, buttons, introText };
  });
  console.log('=== SECOND COURSE MODAL ===');
  console.log(JSON.stringify(modalInfo, null, 2));

  // Compare to first course
  console.log('\n=== FIRST COURSE INPUT IDS (for reference) ===');
  await page.evaluate(() => {
    const modal = document.querySelector('#extra-course-modal');
    if (modal) modal.remove();
    appState.courseAccess.baseCourseEnabled = false;
    go('course-application');
  });
  await page.waitForTimeout(300);
  const firstInputs = await page.evaluate(() => {
    return [...document.querySelectorAll('#course-application input')].map(i => i.id);
  });
  console.log(JSON.stringify(firstInputs));

  // Cleanup and screenshot
  await page.evaluate(() => { go('home'); openExtraCourseRequest(); });
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'debug_extra_modal.png', fullPage: false });
  console.log('\n=== ERRORS ===');
  errors.forEach(e => console.log(e));
  await browser.close();
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
