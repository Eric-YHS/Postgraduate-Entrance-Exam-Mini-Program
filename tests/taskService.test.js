const {
  safeJsonParse,
  normalizeWeekdays,
  normalizeStudentIds,
  serializeWeekdays,
  serializeStudentIds,
  formatWeekdaysLabel
} = require('../src/services/taskService');

describe('taskService 工具函数', () => {
  test('normalizeWeekdays 解析数组、字符串和 daily', () => {
    expect(normalizeWeekdays([1, 3, 5])).toEqual([1, 3, 5]);
    expect(normalizeWeekdays('1,3,5')).toEqual([1, 3, 5]);
    expect(normalizeWeekdays('daily')).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(normalizeWeekdays('')).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(normalizeWeekdays([8, -1, 1, 1])).toEqual([1]);
  });

  test('normalizeStudentIds 过滤非法值并去重', () => {
    expect(normalizeStudentIds([3, 1, 2, 2, -1, 0])).toEqual([1, 2, 3]);
    expect(normalizeStudentIds('3,1,2')).toEqual([1, 2, 3]);
    expect(normalizeStudentIds('')).toEqual([]);
  });

  test('serializeWeekdays / serializeStudentIds 输出 JSON 字符串', () => {
    expect(serializeWeekdays([1, 3])).toBe('[1,3]');
    expect(serializeStudentIds([1, 2])).toBe('[1,2]');
  });

  test('formatWeekdaysLabel 格式化星期显示', () => {
    expect(formatWeekdaysLabel([1, 3, 5])).toContain('周一');
    expect(formatWeekdaysLabel([0, 1, 2, 3, 4, 5, 6])).toContain('每天');
  });

  test('safeJsonParse 异常回退', () => {
    expect(safeJsonParse('{"a":1}', {})).toEqual({ a: 1 });
    expect(safeJsonParse('invalid', [])).toEqual([]);
    expect(safeJsonParse(null, {})).toEqual({});
  });
});
