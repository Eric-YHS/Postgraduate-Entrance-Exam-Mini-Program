/**
 * 输入净化工具
 *
 * 策略：存储时只做 trim（不做 HTML 转义，避免双重编码 BUG-017），
 * XSS 防护由前端渲染时使用 escapeHtml() 完成。
 * 仅对 WebSocket 聊天等直接广播的字段使用服务端转义。
 */

const HTML_ENTITIES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
  '`': '&#x60;'
};

const HTML_ENTITY_RE = /[&<>"'`]/g;

/**
 * 转义 HTML 特殊字符（包含反引号，修复 BUG-042）
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(HTML_ENTITY_RE, (ch) => HTML_ENTITIES[ch]);
}

/**
 * 净化字符串字段：仅 trim，不转义
 * 用于存储到数据库的纯文本字段。XSS 防护在前端渲染时处理。
 * @param {*} value - 原始输入值
 * @returns {string}
 */
function sanitizeText(value) {
  return String(value || '').trim();
}

/**
 * 剥离 HTML 标签，防止存储型 XSS
 * 用于论坛帖子、题目内容、教师注册等用户输入的存储净化。
 * @param {*} value - 原始输入值
 * @returns {string}
 */
function stripHtml(value) {
  return String(value || '').replace(/<[^>]*>/g, '').trim();
}

module.exports = {
  escapeHtml,
  sanitizeText,
  stripHtml
};
