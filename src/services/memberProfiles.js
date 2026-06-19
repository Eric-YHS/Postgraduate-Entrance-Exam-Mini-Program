/**
 * 成员画像管理器
 *
 * 从群聊对话中自动提取和更新每个成员的画像：
 *   目标院校、专业、考试类型、弱项科目、学习阶段、偏好风格等
 *
 * 画像采用增量更新：新提取的信息与已有画像合并，confidence 加权
 */

const { db } = require('../db');
const { quickAsk } = require('./ai');
const dayjs = require('dayjs');

// ── 常量 ─────────────────────────────────────────────────────────────────
const MIN_MESSAGES_FOR_PROFILE = 5;   // 至少需要该用户几条消息才能提取画像
const PROFILE_MAX_MESSAGES = 50;      // 提取时最多取多少条消息
const MERGE_CONFIDENCE_THRESHOLD = 0.3; // 低于此 confidence 的字段不覆盖已有值

// ── 触发判断 ─────────────────────────────────────────────────────────────

/**
 * 检查所有群中有哪些用户需要更新画像
 * 由 archivePoller 每小时调用一次
 */
async function checkAndUpdateAll() {
  // 找出所有在群聊中发过言的用户
  const users = db.prepare(`
    SELECT DISTINCT wam.from_user
    FROM wecom_archive_messages wam
    WHERE wam.roomid != '' AND wam.msgtype = 'text' AND wam.content != ''
      AND wam.from_user NOT IN (
        SELECT DISTINCT b.config->>'$.wecomUserId'
        FROM bots b
        WHERE b.config IS NOT NULL AND b.config != ''
      )
  `).all();

  let updated = 0;
  for (const { from_user: wecomUserid } of users) {
    try {
      const result = await updateProfileIfNeeded(wecomUserid);
      if (result) updated++;
    } catch (err) {
      console.error(`[member-profiles] 用户 ${wecomUserid} 画像更新失败:`, err.message);
    }
  }

  if (updated > 0) {
    console.log(`[member-profiles] 本轮更新 ${updated} 个成员画像`);
  }
}

/**
 * 检查并更新单个成员的画像
 */
async function updateProfileIfNeeded(wecomUserid) {
  // 获取已有画像
  const existing = db.prepare(
    'SELECT profile_json, source_msgids, last_extracted_at FROM member_profiles WHERE wecom_userid = ?'
  ).get(wecomUserid);

  const existingProfile = existing ? JSON.parse(existing.profile_json || '{}') : {};
  const extractedMsgids = existing?.source_msgids ? JSON.parse(existing.source_msgids) : [];

  // 查询该用户最新的发言（排除已提取过的）
  let messages;
  if (extractedMsgids.length > 0) {
    const placeholders = extractedMsgids.map(() => '?').join(',');
    messages = db.prepare(`
      SELECT msgid, content FROM wecom_archive_messages
      WHERE from_user = ? AND msgtype = 'text' AND content != ''
        AND msgid NOT IN (${placeholders})
      ORDER BY msgtime_ms DESC
      LIMIT ?
    `).all(wecomUserid, ...extractedMsgids, PROFILE_MAX_MESSAGES);
  } else {
    messages = db.prepare(`
      SELECT msgid, content FROM wecom_archive_messages
      WHERE from_user = ? AND msgtype = 'text' AND content != ''
      ORDER BY msgtime_ms DESC
      LIMIT ?
    `).all(wecomUserid, PROFILE_MAX_MESSAGES);
  }

  // 消息不够，跳过
  if (messages.length < MIN_MESSAGES_FOR_PROFILE) return false;

  // 提取新画像
  const newProfile = await aiExtractProfile(wecomUserid, messages.map((m) => m.content));
  if (!newProfile || Object.keys(newProfile).length === 0) return false;

  // 合并画像
  const merged = mergeProfiles(existingProfile, newProfile);
  const newMsgids = messages.map((m) => m.msgid);
  const allMsgids = [...new Set([...extractedMsgids, ...newMsgids])];
  const now = new Date().toISOString();

  merged.lastUpdated = now;

  db.prepare(`
    INSERT INTO member_profiles (wecom_userid, display_name, profile_json, source_msgids, last_extracted_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(wecom_userid) DO UPDATE SET
      display_name = excluded.display_name,
      profile_json = excluded.profile_json,
      source_msgids = excluded.source_msgids,
      last_extracted_at = excluded.last_extracted_at,
      updated_at = excluded.updated_at
  `).run(
    wecomUserid,
    wecomUserid, // display_name 暂用 userId，后续可从企微 API 获取
    JSON.stringify(merged),
    JSON.stringify(allMsgids),
    now,
    existing?.created_at || now,
    now
  );

  console.log(`[member-profiles] 更新画像: ${wecomUserid} (${Object.keys(merged).filter((k) => k !== 'confidence' && k !== 'lastUpdated').length} 字段)`);
  return true;
}

// ── 画像合并逻辑 ─────────────────────────────────────────────────────────

function mergeProfiles(existing, incoming) {
  const merged = { ...existing };
  const confidence = incoming.confidence || 0.5;

  for (const [key, value] of Object.entries(incoming)) {
    if (key === 'confidence' || key === 'lastUpdated') continue;
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === 'string' && value.trim() === '') continue;

    // 新值 confidence 太低且已有旧值 → 保留旧值
    if (confidence < MERGE_CONFIDENCE_THRESHOLD && merged[key]) continue;

    // 数组合并（如 weakSubjects）
    if (Array.isArray(value) && Array.isArray(merged[key])) {
      merged[key] = [...new Set([...merged[key], ...value])];
    } else {
      merged[key] = value;
    }
  }

  // 合并 confidence（加权平均）
  const oldConf = existing.confidence || 0;
  merged.confidence = Math.round((oldConf * 0.4 + confidence * 0.6) * 100) / 100;

  return merged;
}

// ── AI 提取调用 ──────────────────────────────────────────────────────────

async function aiExtractProfile(wecomUserid, messages) {
  const chatText = messages.slice(0, 20).map((m, i) => `${i + 1}. ${m}`).join('\n');

  const prompt = `根据以下考研群聊中用户 ${wecomUserid} 的发言，提取 ta 的个人学习信息。

发言内容：
${chatText.slice(0, 2000)}

请以 JSON 格式输出（不确定的字段不要填写，confidence 表示你对提取信息的把握程度 0-1）：
{
  "targetSchool": "目标院校名称",
  "targetMajor": "目标专业",
  "examType": "学硕/专硕/未确定",
  "weakSubjects": ["薄弱科目"],
  "studyPhase": "基础阶段/强化阶段/冲刺阶段/未确定",
  "preferredStyle": "喜欢的学习方式",
  "topicsOfInterest": ["关注的知识点"],
  "confidence": 0.7
}`;

  try {
    const raw = await quickAsk(prompt, '', { maxTokens: 400, temperature: 0.1 });
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error(`[member-profiles] AI 提取 ${wecomUserid} 失败:`, err.message);
    return null;
  }
}

// ── 查询接口 ─────────────────────────────────────────────────────────────

/**
 * 查询单个成员画像
 */
function getProfile(wecomUserid) {
  try {
    const row = db.prepare(
      'SELECT profile_json, display_name FROM member_profiles WHERE wecom_userid = ?'
    ).get(wecomUserid);
    if (!row) return null;
    const profile = JSON.parse(row.profile_json || '{}');
    return { ...profile, displayName: row.display_name || wecomUserid };
  } catch (err) {
    return null;
  }
}

module.exports = {
  checkAndUpdateAll,
  updateProfileIfNeeded,
  getProfile,
};
