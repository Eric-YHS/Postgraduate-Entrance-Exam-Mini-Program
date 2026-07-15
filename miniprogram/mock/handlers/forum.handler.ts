import type { PaginationData } from '../../types/common';
import type { CreateReplyParams, CreateTopicParams, Reply, Topic } from '../../types/forum';
import { hasSensitiveWords } from '../../utils/content-audit';
import {
  generateId,
  mockCurrentAuthor,
  mockFavoritedTopicIds,
  mockHashtags,
  mockReplies,
  mockTopics,
} from '../data/forum';

function paginate<T>(list: T[], page: number, pageSize: number): PaginationData<T> {
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  return {
    list: list.slice(start, end),
    total: list.length,
    page,
    pageSize,
  };
}

function enrichTopic(topic: Topic): Topic {
  return {
    ...topic,
    favoritedByMe: mockFavoritedTopicIds.has(topic.id),
  };
}

function groupReplies(topicId: string): Reply[] {
  const topicReplies = mockReplies.filter((r) => r.topicId === topicId);
  const topLevel = topicReplies.filter((r) => !r.replyToId);
  const children = topicReplies.filter((r) => r.replyToId);

  return topLevel.map((reply) => ({
    ...reply,
    children: children.filter((c) => c.replyToId === reply.id),
  }));
}

/** 获取帖子列表 */
export function mockGetTopics(data: Record<string, unknown>): Promise<PaginationData<Topic>> {
  const page = Number(data.page || 1);
  const pageSize = Number(data.pageSize || 10);
  const hashtag = String(data.hashtag || '');
  const keyword = String(data.keyword || '');

  // 待人工复核或未通过的内容不会进入公开列表。
  let list = mockTopics.filter((topic) => !topic.auditStatus || topic.auditStatus === 'passed').map(enrichTopic);

  if (hashtag) {
    list = list.filter((t) => t.hashtags.includes(hashtag));
  }

  if (keyword) {
    list = list.filter((t) => t.content.includes(keyword) || t.hashtags.some((h) => h.includes(keyword)));
  }

  list = list.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());

  return Promise.resolve(paginate(list, page, pageSize));
}

/** 获取帖子详情 */
export function mockGetTopicById(id: string): Promise<Topic & { replies: Reply[] }> {
  const topic = mockTopics.find((t) => t.id === id);
  if (!topic) {
    return Promise.reject(new Error('帖子不存在'));
  }

  topic.viewCount += 1;
  const replies = groupReplies(id);
  topic.replyCount = replies.length + replies.reduce((sum, r) => sum + (r.children?.length || 0), 0);

  return Promise.resolve({
    ...enrichTopic(topic),
    attachments: topic.attachments,
    replies,
  });
}

/** 发帖 */
export function mockCreateTopic(data: Record<string, unknown>): Promise<Topic> {
  const params = data as unknown as CreateTopicParams;

  if (!params.content || !params.content.trim()) {
    return Promise.reject(new Error('帖子内容不能为空'));
  }

  if (hasSensitiveWords(params.content)) {
    return Promise.reject(new Error('内容包含敏感词，请修改后重试'));
  }

  const attachments: Topic['attachments'] = [];
  if (params.images?.length) {
    params.images.forEach((url, index) => {
      attachments.push({ id: generateId(`img_${index}`), type: 'image', url });
    });
  }
  if (params.video) {
    attachments.push({ id: generateId('video'), type: 'video', url: params.video });
  }
  if (params.attachments?.length) {
    params.attachments.forEach((file) => {
      attachments.push({
        id: generateId('file'),
        type: 'attachment',
        url: file.path,
        name: file.name,
        size: file.size,
      });
    });
  }

  // 更新话题标签计数
  params.hashtags?.forEach((name) => {
    const tag = mockHashtags.find((h) => h.name === name);
    if (tag) tag.postCount += 1;
  });

  const topic: Topic = {
    id: generateId('topic'),
    author: mockCurrentAuthor,
    content: params.content.trim(),
    hashtags: params.hashtags || [],
    attachments,
    viewCount: 0,
    replyCount: 0,
    likeCount: 0,
    favoritedByMe: false,
    auditStatus: params.auditStatus || 'passed',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  mockTopics.unshift(topic);
  return Promise.resolve(topic);
}

/** 回帖 / 楼中楼回复 */
export function mockCreateReply(data: Record<string, unknown>): Promise<Reply> {
  const params = data as unknown as CreateReplyParams & { id: string };
  const topicId = params.id;
  const topic = mockTopics.find((t) => t.id === topicId);

  if (!topic) {
    return Promise.reject(new Error('帖子不存在'));
  }

  if (!params.content || !params.content.trim()) {
    return Promise.reject(new Error('回复内容不能为空'));
  }

  if (hasSensitiveWords(params.content)) {
    return Promise.reject(new Error('内容包含敏感词，请修改后重试'));
  }

  let replyToAuthorName: string | undefined;
  if (params.replyToId) {
    const parent = mockReplies.find((r) => r.id === params.replyToId);
    if (!parent) {
      return Promise.reject(new Error('回复对象不存在'));
    }
    if (parent.replyToId) {
      return Promise.reject(new Error('仅支持二级回复'));
    }
    replyToAuthorName = parent.author.nickname;
  }

  const reply: Reply = {
    id: generateId('reply'),
    topicId,
    author: mockCurrentAuthor,
    content: params.content.trim(),
    replyToId: params.replyToId,
    replyToAuthorName,
    auditStatus: 'passed',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  mockReplies.push(reply);
  topic.replyCount += 1;

  return Promise.resolve(reply);
}

/** 切换收藏 */
export function mockToggleFavorite(data: Record<string, unknown>): Promise<{ favorited: boolean }> {
  const id = String(data.id || '');
  const topic = mockTopics.find((t) => t.id === id);
  if (!topic) {
    return Promise.reject(new Error('帖子不存在'));
  }

  if (mockFavoritedTopicIds.has(id)) {
    mockFavoritedTopicIds.delete(id);
    return Promise.resolve({ favorited: false });
  }

  mockFavoritedTopicIds.add(id);
  return Promise.resolve({ favorited: true });
}

/** 获取热门话题标签 */
export function mockGetHashtags(): Promise<typeof mockHashtags> {
  const sorted = [...mockHashtags].sort((a, b) => b.postCount - a.postCount);
  return Promise.resolve(sorted);
}
