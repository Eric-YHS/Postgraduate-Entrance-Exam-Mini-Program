/**
 * Jest 环境预处理（在任何测试模块加载前执行）。
 *
 * 生产容器把时区固定为 Asia/Shanghai（见 Dockerfile / docker-compose.yml 的 TZ），
 * 定时任务的 cron 表达式（如 `30 9 * * 1`）也按北京时间书写。CI Runner 默认使用 UTC，
 * 会让 cron 匹配、日期分桶等依赖本地时区的断言随机失败，因此测试统一固定时区。
 *
 * 设置 process.env.TZ 会重置 V8 的时区缓存（Node 16+），所以必须放在 setupFiles
 * 而不是测试文件内部，确保 dayjs / Date 首次使用前就已生效。
 */

process.env.TZ = process.env.TZ || 'Asia/Shanghai';
