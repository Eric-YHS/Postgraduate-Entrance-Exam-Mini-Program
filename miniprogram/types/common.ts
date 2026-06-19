/** 通用 API 响应结构 */
export interface ApiResponse<T = unknown> {
  code: number;
  message: string;
  data: T;
}

/** 分页请求参数 */
export interface PaginationParams {
  page: number;
  pageSize: number;
}

/** 分页响应结构 */
export interface PaginationData<T> {
  list: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** 请求方法 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** 请求配置 */
export interface RequestOptions {
  url: string;
  method?: HttpMethod;
  data?: Record<string, unknown>;
  header?: Record<string, string>;
  loading?: boolean;
  retry?: boolean;
}

/** 通用列表项 */
export interface ListItem {
  id: string;
  createdAt?: string;
  updatedAt?: string;
}
