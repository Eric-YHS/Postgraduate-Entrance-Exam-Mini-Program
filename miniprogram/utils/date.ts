/** 格式化日期为 YYYY-MM-DD */
export function formatDate(date?: Date | string | number): string {
  const d = date ? new Date(date) : new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 格式化时间为 HH:mm */
export function formatTime(date?: Date | string | number): string {
  const d = date ? new Date(date) : new Date();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/** 格式化日期时间为 YYYY-MM-DD HH:mm */
export function formatDateTime(date?: Date | string | number): string {
  return `${formatDate(date)} ${formatTime(date)}`;
}

/** 获取剩余天数 */
export function getRemainingDays(endTime: string | number | Date): number {
  const end = new Date(endTime).getTime();
  const now = Date.now();
  const diff = end - now;
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

/** 格式化时长（秒 → mm:ss 或 HH:mm:ss） */
export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/** 相对时间描述 */
export function getRelativeTime(date?: Date | string | number): string {
  const d = date ? new Date(date) : new Date();
  const diff = Date.now() - d.getTime();
  const minutes = Math.floor(diff / (1000 * 60));
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  if (hours < 24) return `${hours}小时前`;
  if (days < 30) return `${days}天前`;
  return formatDate(d);
}
