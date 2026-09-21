from playwright.sync_api import sync_playwright
import json
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    page=browser.new_page()
    logs=[]; errs=[]
    page.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto('http://127.0.0.1:8000/student.html', wait_until='networkidle', timeout=30000)
    print('url', page.url)
    print('title', page.title())
    print('pages', page.locator('.page').count())
    print('visible', page.locator('.page.on').get_attribute('id') if page.locator('.page.on').count() else 'none')
    print('buttons', page.locator('nav button').all_text_contents())
    for label in ['复习规划','带背','AI 分析中心','我的档案']:
      try:
        page.get_by_text(label, exact=True).click(timeout=3000)
        page.wait_for_timeout(500)
        print(label, 'visible', page.locator('.page.on').get_attribute('id') if page.locator('.page.on').count() else 'none', 'url',page.url)
      except Exception as e: print(label,'ERR',e)
    print('logs', logs[-20:]); print('errs', errs[-10:])
    browser.close()
