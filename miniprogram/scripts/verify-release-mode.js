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
  ];
  const missingPages = requiredVisiblePages.filter((page) => !actual.pages.includes(page));
  if (missingPages.length > 0) {
    throw new Error(`不应隐藏的页面缺失: ${missingPages.join(', ')}`);
  }

  const indexWxml = fs.readFileSync(path.join(projectRoot, 'pages', 'index', 'index.wxml'), 'utf8');
  const centerWxml = fs.readFileSync(path.join(projectRoot, 'pages', 'user', 'center', 'center.wxml'), 'utf8');
  const guardedMarkers = [
    'class="feature-item" wx:if="{{ onlineCoursesVisible }}"',
    'class="recommend-card card" wx:if="{{ onlineCoursesVisible }}"',
    'class="stats-item" wx:if="{{ onlineCoursesVisible }}"',
  ];
  const visibleLeak = guardedMarkers.filter((marker) => !(indexWxml.includes(marker) || centerWxml.includes(marker)));
  if (visibleLeak.length > 0) {
    throw new Error(`在线课程入口缺少隐藏条件: ${visibleLeak.join(', ')}`);
  }
}

console.log(`发布模式校验通过: ${mode}`);
