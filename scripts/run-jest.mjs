#!/usr/bin/env node
/**
 * 测试启动器：在启动 Jest **进程**之前把时区固定为 Asia/Shanghai。
 *
 * 只在测试代码里写 `process.env.TZ = 'Asia/Shanghai'` 并不可靠：Jest 的 node/jsdom
 * 测试环境运行在独立的 vm context 中，Date/Intl 的默认时区在 context 创建时就已经解析，
 * 之后再改环境变量不会生效（CI Runner 是 UTC，于是「静默时段 8-22 点」之类断言会偶发失败）。
 * 因此统一通过这里启动，让所有 worker 从进程启动就带上正确时区。
 *
 * 需要临时换时区（复现问题）时用 TEST_TZ，例如：TEST_TZ=UTC npm test
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const timeZone = process.env.TEST_TZ || 'Asia/Shanghai';
const jestBin = require.resolve('jest/bin/jest');

const result = spawnSync(process.execPath, [jestBin, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, TZ: timeZone },
});

if (result.error) {
  console.error('[run-jest] 启动 Jest 失败：', result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
