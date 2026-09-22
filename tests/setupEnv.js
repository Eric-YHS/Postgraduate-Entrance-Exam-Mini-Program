/**
 * Jest 环境预处理（在任何测试模块加载前执行）。
 *
 * 生产容器把时区固定为 Asia/Shanghai（见 Dockerfile / docker-compose.yml 的 TZ），
 * 定时任务的 cron 表达式（如 `30 9 * * 1`）与推送的静默时段（如 8–22 点）也按北京时间书写。
 * CI Runner 默认是 UTC，会让 cron 匹配、静默时段、日期分桶等依赖本地时区的断言随机失败，
 * 因此测试统一固定时区。
 *
 * 注意：这里必须**强制赋值**。Runner 镜像或调用方可能已经预设 TZ=UTC，
 * 用 `process.env.TZ || 'Asia/Shanghai'` 会保留 UTC，导致「quiet_hours」这类难懂的失败。
 * 如需临时改用其它时区，传 TEST_TZ。
 */

const wantedTimeZone = process.env.TEST_TZ || 'Asia/Shanghai';

process.env.TZ = wantedTimeZone;

/** 指定时区相对 UTC 的偏移（分钟），取 getTimezoneOffset() 的符号约定。 */
function expectedOffset(tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(new Date());
  const label = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT+00:00';
  const match = label.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '+' ? -minutes : minutes;
}

if (new Date().getTimezoneOffset() !== expectedOffset(wantedTimeZone)) {
  throw new Error(
    `[tests/setupEnv] 时区未能切换为 ${wantedTimeZone}（当前偏移 ${new Date().getTimezoneOffset()} 分钟，` +
      `期望 ${expectedOffset(wantedTimeZone)} 分钟）。请在运行 jest 前设置环境变量 TZ=${wantedTimeZone}。`,
  );
}
