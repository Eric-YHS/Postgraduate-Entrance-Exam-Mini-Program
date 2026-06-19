import type { Author, Hashtag, MediaAttachment, Reply, Topic } from '../../types/forum';
import { UserLevel } from '../../types/user';
import { mockUser } from './user';

/** 当前模拟用户作为作者 */
export const mockCurrentAuthor: Author = {
  id: mockUser.id,
  nickname: mockUser.nickname,
  avatarUrl: mockUser.avatarUrl,
  level: mockUser.level,
};

/** 其他模拟作者 */
const mockAuthors: Author[] = [
  mockCurrentAuthor,
  {
    id: 'user_002',
    nickname: '学霸学姐',
    avatarUrl: '/assets/images/avatar-placeholder.svg',
    level: UserLevel.PAID,
  },
  {
    id: 'user_003',
    nickname: '数学达人',
    avatarUrl: '/assets/images/avatar-placeholder.svg',
    level: UserLevel.PAID,
  },
];

/** 热门话题标签 */
export const mockHashtags: Hashtag[] = [
  { id: 'tag_001', name: '考研资料', postCount: 128 },
  { id: 'tag_002', name: '英语单词', postCount: 86 },
  { id: 'tag_003', name: '数学公式', postCount: 64 },
  { id: 'tag_004', name: '经验分享', postCount: 52 },
  { id: 'tag_005', name: '择校建议', postCount: 37 },
];

const imagePlaceholder = '/assets/images/cover-placeholder-1.svg';
const videoPlaceholder = '/assets/images/cover-placeholder-2.svg';

const now = new Date();
const daysAgo = (n: number): string => new Date(now.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

/** 创建图片附件 */
function makeImages(count: number): MediaAttachment[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `att_img_${i}`,
    type: 'image',
    url: imagePlaceholder,
  }));
}

/** 创建视频附件 */
function makeVideo(): MediaAttachment {
  return {
    id: 'att_video_001',
    type: 'video',
    url: videoPlaceholder,
  };
}

/** 帖子数据（可变，支持 Mock 发帖） */
export const mockTopics: Topic[] = [
  {
    id: 'topic_001',
    author: mockAuthors[1],
    content:
      '大家英语单词都背到哪里了？我目前每天 80 个新词 + 复习 160，感觉后期会跟不上，有没有更好的节奏建议？#考研资料 #英语单词',
    hashtags: ['考研资料', '英语单词'],
    attachments: [],
    viewCount: 342,
    replyCount: 3,
    likeCount: 28,
    favoritedByMe: false,
    createdAt: daysAgo(2),
    updatedAt: daysAgo(2),
  },
  {
    id: 'topic_002',
    author: mockAuthors[2],
    content:
      '整理了一份数学常用公式卡片，包含极限、导数、积分核心公式，大家可以保存图片。后续会更新线性代数部分。#数学公式',
    hashtags: ['数学公式'],
    attachments: makeImages(3),
    viewCount: 518,
    replyCount: 1,
    likeCount: 76,
    favoritedByMe: true,
    createdAt: daysAgo(3),
    updatedAt: daysAgo(3),
  },
  {
    id: 'topic_003',
    author: mockCurrentAuthor,
    content: '第一次模拟考政治只有 45 分，多选题错了一半，请问大家是怎么提高多选正确率的？求经验分享！#经验分享',
    hashtags: ['经验分享'],
    attachments: [makeVideo()],
    viewCount: 120,
    replyCount: 0,
    likeCount: 5,
    favoritedByMe: false,
    createdAt: daysAgo(5),
    updatedAt: daysAgo(5),
  },
];

/** 回复数据（可变，支持 Mock 回帖 / 楼中楼） */
export const mockReplies: Reply[] = [
  {
    id: 'reply_001',
    topicId: 'topic_001',
    author: mockAuthors[2],
    content: '同求推荐，我现在也是每天背很多，但 retention 感觉不高。',
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
  },
  {
    id: 'reply_002',
    topicId: 'topic_001',
    author: mockAuthors[1],
    content: '建议先背核心 2200，用艾宾浩斯复习表，比盲目加量效果好。',
    replyToId: 'reply_001',
    replyToAuthorName: '数学达人',
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
  },
  {
    id: 'reply_003',
    topicId: 'topic_001',
    author: mockCurrentAuthor,
    content: '谢谢分享，我去试试这个方法！',
    createdAt: daysAgo(0.5),
    updatedAt: daysAgo(0.5),
  },
  {
    id: 'reply_004',
    topicId: 'topic_002',
    author: mockAuthors[0],
    content: '图片很清晰，收藏了，期待线性代数更新。',
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
  },
];

/** 当前用户收藏的话题 ID 集合（可变） */
export const mockFavoritedTopicIds = new Set<string>(['topic_002']);

/** 作者查找辅助 */
export function getMockAuthorById(id: string): Author {
  return mockAuthors.find((a) => a.id === id) || mockAuthors[1];
}

/** 生成 ID 辅助 */
export function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
