// 共享浏览器环境解析：避免在审计脚本中硬编码个人路径。
// 配置优先级：环境变量 > 常见默认位置 > playwright 默认。
// - PLAYWRIGHT_MODULE_PATH：playwright 所在 node_modules 中的模块路径
// - BROWSER_EXECUTABLE：浏览器可执行文件路径（留空则使用 playwright 自带 chromium）
const fs = require('fs');
const path = require('path');

function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE_PATH) candidates.push(process.env.PLAYWRIGHT_MODULE_PATH);
  candidates.push('playwright');
  candidates.push('playwright-core');
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      // 尝试下一个候选
    }
  }
  throw new Error('未找到 playwright。请 npm install playwright，或设置 PLAYWRIGHT_MODULE_PATH 指向模块。');
}

function detectBrowserExecutable() {
  if (process.env.BROWSER_EXECUTABLE) return process.env.BROWSER_EXECUTABLE;
  const programFiles = [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA].filter(Boolean);
  const relatives = [
    'Microsoft/Edge/Application/msedge.exe',
    'Google/Chrome/Application/chrome.exe',
  ];
  for (const root of programFiles) {
    for (const rel of relatives) {
      const candidate = path.join(root, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined; // 交由 playwright 自带 chromium
}

function resolveBase(defaultPort) {
  return process.env.AUDIT_BASE_URL || `http://127.0.0.1:${defaultPort}`;
}

module.exports = { loadPlaywright, detectBrowserExecutable, resolveBase };
