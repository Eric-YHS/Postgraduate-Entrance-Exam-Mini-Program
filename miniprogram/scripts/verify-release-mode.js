const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const modeConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'release-mode.json'), 'utf8'));
const mode = modeConfig.mode;

if (!['restricted', 'qualified'].includes(mode)) {
  throw new Error(`未知发布模式: ${String(mode)}`);
}

const expectedPath = path.join(__dirname, 'manifests', `app.${mode}.json`);
const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
const actual = JSON.parse(fs.readFileSync(path.join(projectRoot, 'app.json'), 'utf8'));
const expectedSitemap = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifests', `sitemap.${mode}.json`), 'utf8'));
const actualSitemap = JSON.parse(fs.readFileSync(path.join(projectRoot, 'sitemap.json'), 'utf8'));
const releaseConfig = fs.readFileSync(path.join(projectRoot, 'config', 'release.ts'), 'utf8');

if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(`app.json 与 ${mode} 模式清单不一致，请先运行 npm run mode:${mode}`);
}

if (JSON.stringify(actualSitemap) !== JSON.stringify(expectedSitemap)) {
  throw new Error(`sitemap.json 与 ${mode} 模式清单不一致，请先运行 npm run mode:${mode}`);
}

const expectedFlag = mode === 'qualified' ? 'true' : 'false';
if (!releaseConfig.includes(`ONLINE_COURSE_FEATURE_ENABLED: boolean = ${expectedFlag};`)) {
  throw new Error(`config/release.ts 与 ${mode} 模式不一致，请先运行 npm run mode:${mode}`);
}

for (const page of actual.pages || []) {
  for (const extension of ['.ts', '.json', '.wxml', '.wxss']) {
    const filePath = path.join(projectRoot, `${page}${extension}`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`页面文件缺失: ${path.relative(projectRoot, filePath)}`);
    }
  }
}

if (mode === 'restricted') {
  const serialized = JSON.stringify({ app: actual, sitemap: actualSitemap });
  const blockedFragments = ['/course/', '/live/'];
  const leaked = blockedFragments.filter((fragment) => serialized.includes(fragment));

  if (leaked.length > 0) {
    throw new Error(`资质受限模式仍包含受限页面: ${leaked.join(', ')}`);
  }

  if (actual.requiredBackgroundModes?.includes('audio')) {
    throw new Error('资质受限模式不应声明后台音频能力');
  }

  const requiredVisiblePages = [
    'pages/index/index',
    'pages/question/practice/practice',
    'pages/question/wrong-book/wrong-book',
    'pages/forum/index/index',
    'pages/forum/detail/detail',
    'pages/forum/post/post',
    'pages/user/center/center',
    'pages/plan/index/index',
    'pages/support/qa/qa',
    'pages/user/settings/settings',
    'pages/user/help/help',
    'pages/user/content-security/content-security',
  ];
  const missingPages = requiredVisiblePages.filter((page) => !actual.pages.includes(page));
  if (missingPages.length > 0) {
    throw new Error(`不应隐藏的页面缺失: ${missingPages.join(', ')}`);
  }

  const indexWxml = fs.readFileSync(path.join(projectRoot, 'pages', 'index', 'index.wxml'), 'utf8');
  const centerWxml = fs.readFileSync(path.join(projectRoot, 'pages', 'user', 'center', 'center.wxml'), 'utf8');
  const centerTs = fs.readFileSync(path.join(projectRoot, 'pages', 'user', 'center', 'center.ts'), 'utf8');
  const runtimeConfig = fs.readFileSync(path.join(projectRoot, 'config', 'runtime.ts'), 'utf8');
  const uploadSource = fs.readFileSync(path.join(projectRoot, 'utils', 'upload.ts'), 'utf8');
  const postSource = fs.readFileSync(path.join(projectRoot, 'pages', 'forum', 'post', 'post.ts'), 'utf8');
  const detailSource = fs.readFileSync(path.join(projectRoot, 'pages', 'forum', 'detail', 'detail.ts'), 'utf8');
  const securityService = fs.readFileSync(path.join(projectRoot, 'services', 'content-security.service.ts'), 'utf8');
  const securityPage = fs.readFileSync(
    path.join(projectRoot, 'pages', 'user', 'content-security', 'content-security.wxml'),
    'utf8'
  );
  const guardedMarkers = [
    'class="feature-item" wx:if="{{ onlineCoursesVisible }}"',
    'class="recommend-card card" wx:if="{{ onlineCoursesVisible }}"',
    'class="stats-item" wx:if="{{ onlineCoursesVisible }}"',
  ];
  const visibleLeak = guardedMarkers.filter((marker) => !(indexWxml.includes(marker) || centerWxml.includes(marker)));
  if (visibleLeak.length > 0) {
    throw new Error(`在线课程入口缺少隐藏条件: ${visibleLeak.join(', ')}`);
  }

  const placeholderPages = actual.pages.filter((page) => {
    const pageTs = fs.readFileSync(path.join(projectRoot, `${page}.ts`), 'utf8');
    const pageWxml = fs.readFileSync(path.join(projectRoot, `${page}.wxml`), 'utf8');
    return pageTs.includes('开发中') || pageWxml.includes('开发中');
  });
  if (placeholderPages.length > 0) {
    throw new Error(`可见页面仍包含“开发中”占位提示: ${placeholderPages.join(', ')}`);
  }

  const menuPaths = [...centerTs.matchAll(/path:\s*'([^']+)'/g)].map((match) => match[1].replace(/^\//, ''));
  const invalidMenuPaths = menuPaths.filter((page) => !actual.pages.includes(page));
  if (invalidMenuPaths.length > 0) {
    throw new Error(`个人中心菜单指向未注册页面: ${invalidMenuPaths.join(', ')}`);
  }

  if (!runtimeConfig.includes('USE_MOCK_API = true')) {
    throw new Error('当前审核版本必须启用统一 Mock API 模式');
  }
  if (!uploadSource.includes('USE_MOCK_API') || /USE_MOCK\s*=\s*false/.test(uploadSource)) {
    throw new Error('媒体上传未与统一 Mock API 模式保持一致');
  }

  if (!runtimeConfig.includes("CONTENT_SECURITY_API_BASE_URL = 'https://xiaoeduhub.online'")) {
    throw new Error('UGC 内容安全必须配置真实 HTTPS 后端，不能使用 Mock 或占位域名');
  }
  if (!postSource.includes('checkTextContent') || !postSource.includes('checkImageContent')) {
    throw new Error('发帖流程必须调用微信文字及图片内容安全检测');
  }
  if (!detailSource.includes('checkTextContent')) {
    throw new Error('回帖流程必须调用微信文字内容安全检测');
  }
  if (
    !securityService.includes('wx.request') ||
    !securityService.includes('wx.uploadFile') ||
    !securityService.includes('/api/content-security/')
  ) {
    throw new Error('内容安全客户端必须绕过业务 Mock，调用真实后端');
  }
  for (const marker of ['msgSecCheck', 'imgSecCheck', 'mediaCheckAsync', 'errcode', 'trace_id']) {
    if (!securityPage.includes(marker)) {
      throw new Error(`内容安全检测记录页缺少审核核验字段: ${marker}`);
    }
  }
}

console.log(`发布模式校验通过: ${mode}`);
