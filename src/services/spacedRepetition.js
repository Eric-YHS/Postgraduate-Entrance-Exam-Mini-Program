/**
 * SM-2 间隔重复算法
 * 用于艾宾浩斯记忆曲线的词汇/卡片复习调度
 */

const dayjs = require('dayjs');

/**
 * 计算下一次复习参数
 * @param {number} quality - 复习质量评分 0=Again, 1=Hard, 2=Good, 3=Easy
 * @param {number} easeFactor - 当前难度因子 (>= 1.3)
 * @param {number} interval - 当前间隔天数
 * @param {number} repetitions - 当前连续正确次数
 * @returns {{ easeFactor: number, interval: number, repetitions: number, nextReviewDate: string }}
 */
function calculateNextReview(quality, easeFactor, interval, repetitions) {
  let newEase = easeFactor;
  let newInterval = interval;
  let newRepetitions = repetitions;

  if (quality >= 2) {
    // Good 或 Easy：增加间隔
    newRepetitions += 1;
    if (newRepetitions === 1) {
      newInterval = 1;
    } else if (newRepetitions === 2) {
      newInterval = 6;
    } else {
      newInterval = Math.round(newInterval * newEase);
    }
  } else {
    // Again 或 Hard：重置
    newRepetitions = 0;
    newInterval = 1;
  }

  // 更新难度因子
  newEase = Math.max(
    1.3,
    newEase + (0.1 - (3 - quality) * (0.08 + (3 - quality) * 0.02))
  );

  // 计算下次复习日期（使用 dayjs 统一时区处理）
  const nextReviewDate = dayjs().add(newInterval, 'day').format('YYYY-MM-DD');

  return {
    easeFactor: Math.round(newEase * 100) / 100,
    interval: newInterval,
    repetitions: newRepetitions,
    nextReviewDate
  };
}

/**
 * 获取初始复习参数
 * @returns {{ easeFactor: number, interval: number, repetitions: number, nextReviewDate: string }}
 */
function getInitialReviewParams() {
  return {
    easeFactor: 2.5,
    interval: 0,
    repetitions: 0,
    nextReviewDate: dayjs().format('YYYY-MM-DD')
  };
}

module.exports = {
  calculateNextReview,
  getInitialReviewParams
};
