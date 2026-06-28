const ci = require('miniprogram-ci');
const path = require('path');
const fs = require('fs');

const APPID = 'wx27fca32a9ddfdc8e';
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PRIVATE_KEY_PATH = path.join(PROJECT_ROOT, `private.${APPID}.key`);

function getVersion() {
  const pkgPath = path.join(PROJECT_ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  return process.argv[2] || pkg.version || '1.0.0';
}

function getDesc() {
  return process.argv[3] || `自动上传 ${new Date().toLocaleString('zh-CN')}`;
}

async function main() {
  if (!fs.existsSync(PRIVATE_KEY_PATH)) {
    console.error(`未找到上传私钥: ${PRIVATE_KEY_PATH}`);
    console.error('请前往微信小程序后台 → 开发管理 → 开发设置 → 小程序代码上传，生成并下载私钥。');
    process.exit(1);
  }

  const project = new ci.Project({
    appid: APPID,
    type: 'miniProgram',
    projectPath: PROJECT_ROOT,
    privateKeyPath: PRIVATE_KEY_PATH,
    ignores: [
      'node_modules/**/*',
      'scripts/**/*',
      `private.${APPID}.key`,
      'package.json',
      'package-lock.json',
      '.gitignore',
      'README.md',
      '.eslintrc.js',
      '.prettierrc',
      'tsconfig.json',
    ],
  });

  const version = getVersion();
  const desc = getDesc();

  console.log(`开始上传小程序... 版本: ${version}, 备注: ${desc}`);

  try {
    const result = await ci.upload({
      project,
      version,
      desc,
      setting: {
        es6: true,
        es7: true,
        minify: true,
        minifyJS: true,
        minifyWXML: true,
        minifyWXSS: true,
        uploadWithSourceMap: true,
      },
      onProgressUpdate: (info) => {
        if (info && typeof info._msg === 'string') {
          console.log(info._msg);
        }
      },
    });

    console.log('上传成功:', result);
  } catch (error) {
    console.error('上传失败:', error.message || error);
    process.exit(1);
  }
}

main();
