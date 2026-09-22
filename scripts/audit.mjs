#!/usr/bin/env node
/**
 * npm audit 包装脚本。
 *
 * 直接跑 `npm audit` 在这个仓库里永远是红的，于是 CI 只能挂 continue-on-error，
 * 而一条永远不失败的检查等于没有检查：真正需要升级的公告会淹没在长期噪音里。
 *
 * 这里的规则：
 *  1. 默认只审计生产依赖（`--omit=dev`）。部署执行的是 `npm ci --omit=dev`，
 *     开发依赖（jest / glob / browserslist 之类）的 CVE 不会进入线上进程。
 *  2. 只有 KNOWN 里逐个确认过、并且写清理由的公告才允许放过；
 *     任何新出现的 high / critical 都会让 CI 真正失败。
 *  3. `--all` 可以把开发依赖一起打出来（只作参考，不影响退出码）。
 *
 * 用法：npm run audit        生产依赖 + 白名单校验（CI 用）
 *       npm run audit --all  连开发依赖一起看
 */
import { spawnSync } from 'node:child_process';

/**
 * 已知且暂时无法通过 npm 升级修掉的公告。
 * 每一项都必须写清「为什么不能修」和「什么时候可以摘掉」，否则就是自欺欺人。
 */
const KNOWN = new Map([
  [
    'xlsx',
    'SheetJS 从 0.18.5 之后不再往 npm 发包（公告范围是 *），修复版只在 cdn.sheetjs.com 上；' +
      '换数据源会同时改变 .xls/.xlsx 的解析行为，需要单独回归知识库导入。',
  ],
  [
    '@xenova/transformers',
    '本地向量模型运行时，npm 上的 2.17.2 已是最新；npm audit 给的“修复”是退回 1.4.2（API 不兼容）。',
  ],
  ['onnx-proto', '来自 @xenova/transformers 的传递依赖，跟随上游。'],
  ['onnxruntime-web', '来自 @xenova/transformers 的传递依赖，跟随上游（服务端只用到 node 后端）。'],
  ['protobufjs', '来自 @xenova/transformers 的传递依赖，跟随上游。'],
  ['sharp', '来自 @xenova/transformers 的可选图像依赖，服务端不解析用户上传图像。'],
]);

const includeDev = process.argv.includes('--all');
const auditArgs = ['audit', '--json', ...(includeDev ? [] : ['--omit=dev'])];

const result = spawnSync('npm', auditArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
let report;
try {
  report = JSON.parse(result.stdout);
} catch (_) {
  console.error('[audit] 无法解析 npm audit 输出：\n' + (result.stdout || '') + (result.stderr || ''));
  process.exit(1);
}

const findings = Object.entries(report.vulnerabilities || {})
  .filter(([, info]) => ['high', 'critical'].includes(info.severity))
  .map(([name, info]) => ({ name, severity: info.severity, direct: info.isDirect, range: info.range }));

const unexpected = findings.filter((item) => !KNOWN.has(item.name));
const accepted = findings.filter((item) => KNOWN.has(item.name));

const label = includeDev ? '全部依赖' : '生产依赖';
console.log(`[audit] ${label}：high/critical 共 ${findings.length} 项（白名单 ${accepted.length} 项，新增 ${unexpected.length} 项）`);
for (const item of accepted) {
  console.log(`  已知 ${item.severity.padEnd(8)} ${item.name} (${item.range})\n         ${KNOWN.get(item.name)}`);
}
for (const item of unexpected) {
  console.error(`  新增 ${item.severity.padEnd(8)} ${item.name} (${item.range}) ${item.direct ? '直接依赖' : '传递依赖'}`);
}

if (unexpected.length) {
  console.error(
    '\n[audit] 存在未登记的 high/critical 公告。能升级就升级；确认无法修复的，' +
      '在 scripts/audit.mjs 的 KNOWN 里补一行并写清理由。',
  );
  process.exit(1);
}
console.log('[audit] 通过');
