import { get, post } from '../utils/request';
import { ApiEndpoints } from './api-types';
import type { CreateReplyParams, CreateTopicParams, Hashtag, Reply, Topic, TopicQueryParams } from '../types/forum';
import type { PaginationData } from '../types/common';

/** 获取帖子列表 */
export function getTopics(params: TopicQueryParams = {}): Promise<PaginationData<Topic>> {
  return get<PaginationData<Topic>>(ApiEndpoints.FORUM_TOPICS, params as Record<string, unknown>);
}

/** 获取帖子详情 */
export function getTopicById(id: string): Promise<Topic & { replies: Reply[] }> {
  return get<Topic & { replies: Reply[] }>(ApiEndpoints.FORUM_TOPIC_DETAIL, { id });
}

/** 发帖 */
export function createTopic(data: CreateTopicParams): Promise<Topic> {
  return post<Topic>(ApiEndpoints.FORUM_TOPIC_CREATE, data as unknown as Record<string, unknown>);
}

/** 回帖 / 楼中楼回复 */
export function createReply(topicId: string, params: CreateReplyParams): Promise<Reply> {
  return post<Reply>(ApiEndpoints.FORUM_REPLIES, {
    id: topicId,
    ...params,
  } as Record<string, unknown>);
}

/** 切换收藏状态 */
export function toggleFavorite(topicId: string): Promise<{ favorited: boolean }> {
  return post<{ favorited: boolean }>(ApiEndpoints.FORUM_FAVORITE, { id: topicId });
}

/** 获取热门话题标签 */
export function getHashtags(): Promise<Hashtag[]> {
  return get<Hashtag[]>(ApiEndpoints.FORUM_HASHTAGS);
}
