const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const mode = process.argv[2];
const supportedModes = new Set(['restricted', 'qualified']);

if (!supportedModes.has(mode)) {
  console.error('用法: node scripts/set-release-mode.js <restricted|qualified>');
  process.exit(1);
}

const manifestPath = path.join(__dirname, 'manifests', `app.${mode}.json`);
const sitemapManifestPath = path.join(__dirname, 'manifests', `sitemap.${mode}.json`);
const appJsonPath = path.join(projectRoot, 'app.json');
const sitemapPath = path.join(projectRoot, 'sitemap.json');
const releaseConfigPath = path.join(projectRoot, 'config', 'release.ts');
const modePath = path.join(__dirname, 'release-mode.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const sitemap = JSON.parse(fs.readFileSync(sitemapManifestPath, 'utf8'));
const courseFeatureEnabled = mode === 'qualified';

fs.writeFileSync(appJsonPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
fs.writeFileSync(sitemapPath, `${JSON.stringify(sitemap, null, 2)}\n`, 'utf8');
fs.writeFileSync(
  releaseConfigPath,
  `/**\n * 无在线教育相关资质期间必须保持为 false。\n * 获得资质后运行 \`npm run mode:qualified\`，恢复课程页面与入口。\n */\nexport const ONLINE_COURSE_FEATURE_ENABLED: boolean = ${courseFeatureEnabled};\n`,
  'utf8'
);
fs.writeFileSync(modePath, `${JSON.stringify({ mode }, null, 2)}\n`, 'utf8');

console.log(`已切换为 ${mode === 'restricted' ? '资质受限' : '资质恢复'}模式。`);
