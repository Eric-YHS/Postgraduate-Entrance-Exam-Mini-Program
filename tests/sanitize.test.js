const { sanitizeText, escapeHtml, stripHtml } = require('../src/utils/sanitize');

describe('sanitize 工具函数', () => {
  test('sanitizeText 应移除危险脚本标签', () => {
    expect(sanitizeText('<script>alert(1)</script>')).not.toContain('<script>');
  });

  test('escapeHtml 应转义 HTML 特殊字符', () => {
    expect(escapeHtml('<div>hello & "world"</div>')).toBe('&lt;div&gt;hello &amp; &quot;world&quot;&lt;/div&gt;');
  });

  test('stripHtml 应移除 HTML 标签并保留文本', () => {
    expect(stripHtml('<p>hello world</p>')).toBe('hello world');
    expect(stripHtml('<script>alert(1)</script>')).toBe('alert(1)');
  });
});
