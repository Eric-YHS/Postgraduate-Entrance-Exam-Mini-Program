/** 日志级别 */
export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
}

const ENABLE_LOG = true;

/** 上报日志（Mock 阶段仅打印到控制台） */
function reportLog(level: LogLevel, message: string, data?: unknown): void {
  if (!ENABLE_LOG) return;

  const logData = {
    level,
    message,
    data,
    time: new Date().toISOString(),
    systemInfo: wx.getSystemInfoSync(),
  };

  // 避免 lint 警告，后续接入日志上报服务时使用
  void logData;

  // 开发环境打印到控制台
  switch (level) {
    case LogLevel.DEBUG:
      console.debug('[Logger]', message, data || '');
      break;
    case LogLevel.INFO:
      console.info('[Logger]', message, data || '');
      break;
    case LogLevel.WARN:
      console.warn('[Logger]', message, data || '');
      break;
    case LogLevel.ERROR:
      console.error('[Logger]', message, data || '');
      break;
  }

  // TODO: 生产环境接入日志上报服务（如腾讯云日志服务、Sentry）
  // wx.request({ url: 'https://log.example.com/collect', method: 'POST', data: logData });
}

export const logger = {
  debug: (message: string, data?: unknown) => reportLog(LogLevel.DEBUG, message, data),
  info: (message: string, data?: unknown) => reportLog(LogLevel.INFO, message, data),
  warn: (message: string, data?: unknown) => reportLog(LogLevel.WARN, message, data),
  error: (message: string, data?: unknown) => reportLog(LogLevel.ERROR, message, data),
};

/** 全局错误监听 */
export function setupErrorListener(): void {
  wx.onError((err) => {
    logger.error('运行时错误', err);
  });

  wx.onUnhandledRejection((res) => {
    logger.error('未处理的 Promise 拒绝', res.reason);
  });
}
