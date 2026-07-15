/** 当前审核版本使用本地 Mock，所有 API 与媒体上传必须保持一致。 */
export const USE_MOCK_API = true;

/** 切换真实服务时填写已配置为微信合法域名的 HTTPS 地址。 */
export const API_BASE_URL = 'https://api.kaoyan.com';

/** UGC 内容安全始终调用真实后端，不允许被业务 Mock 绕过。 */
export const CONTENT_SECURITY_API_BASE_URL = 'https://xiaoeduhub.online';
