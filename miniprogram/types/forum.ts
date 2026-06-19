import type { ListItem, PaginationParams } from './common';
import type { UserLevel } from './user';

/** 内容审核状态 */
export type AuditStatus = 'pending' | 'passed' | 'rejected' | 'manual';

/** 附件类型 */
export type AttachmentType = 'image' | 'video' | 'attachment';

/** 媒体附件 */
export interface MediaAttachment {
  /** 附件 ID */
  id: string;
  /** 附件类型 */
  type: AttachmentType;
  /** 访问地址（Mock 阶段使用本地临时路径或占位图） */
  url: string;
  /** 文件名（附件专用） */
  name?: string;
  /** 文件大小，单位字节（附件专用） */
  size?: number;
}

/** 作者信息 */
export interface Author {
  /** 用户 ID */
  id: string;
  /** 昵称 */
  nickname: string;
  /** 头像 */
  avatarUrl: string;
  /** 等级 */
  level: UserLevel;
}

/** 话题标签 */
export interface Hashtag extends ListItem {
  /** 标签名，如 #考研资料 */
  name: string;
  /** 帖子数 */
  postCount: number;
}

/** 帖子 */
export interface Topic extends ListItem {
  /** 作者 */
  author: Author;
  /** 正文内容 */
  content: string;
  /** 关联标签名列表 */
  hashtags: string[];
  /** 媒体附件 */
  attachments: MediaAttachment[];
  /** 浏览数 */
  viewCount: number;
  /** 回复数 */
  replyCount: number;
  /** 点赞数 */
  likeCount: number;
  /** 当前用户是否已收藏 */
  favoritedByMe: boolean;
  /** 审核状态 */
  auditStatus?: AuditStatus;
}

/** 回复 */
export interface Reply extends ListItem {
  /** 所属帖子 ID */
  topicId: string;
  /** 回复作者 */
  author: Author;
  /** 回复内容 */
  content: string;
  /** 回复对象回复 ID（楼中楼） */
  replyToId?: string;
  /** 回复对象作者昵称 */
  replyToAuthorName?: string;
  /** 二级回复列表 */
  children?: Reply[];
  /** 审核状态 */
  auditStatus?: AuditStatus;
}

/** 帖子列表查询参数 */
export interface TopicQueryParams extends Partial<PaginationParams> {
  /** 按话题标签筛选 */
  hashtag?: string;
  /** 关键词搜索 */
  keyword?: string;
}

/** 发帖参数 */
export interface CreateTopicParams {
  /** 正文 */
  content: string;
  /** 标签名列表 */
  hashtags: string[];
  /** 图片本地临时路径列表 */
  images: string[];
  /** 视频本地临时路径 */
  video?: string;
  /** 附件列表 */
  attachments: Array<{ name: string; path: string; size: number }>;
  /** 前端预审核状态 */
  auditStatus?: AuditStatus;
}

/** 发回复参数 */
export interface CreateReplyParams {
  /** 回复内容 */
  content: string;
  /** 回复目标回复 ID，为空则回复帖子 */
  replyToId?: string;
  /** 前端预审核状态 */
  auditStatus?: AuditStatus;
}
