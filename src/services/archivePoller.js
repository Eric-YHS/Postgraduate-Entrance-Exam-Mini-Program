/**
 * 会话存档定时轮询器
 *
 * 定时调用 wecomArchive.pullChatData() 拉取新消息，
 * 解密后交由 archiveDispatcher.processBatch() 处理。
 *
 * 特性：
 *   - 运行锁：防止前次轮询未完成时重叠执行
 *   - 错误重试：连续失败最多 3 次指数退避，超过 10 次暂停 5 分钟
 *   - seq 持久化：进度写入数据库 wecom_archive_sync 表
 *   - 优雅停止：支持 stop() 清理定时器
 */

const { db } = require('../db');
const { isReady, pullChatData, decryptChatMessage, getStatus, updateSeq, incrementErrors, resetErrors, setRunning } = require('./wecomArchive');
const { processBatch, loadBotUserIds } = require('./archiveDispatcher');
const { checkAndExtractAll } = require('./memoryExtractor');
const { checkAndUpdateAll } = require('./memberProfiles');
const config = require('../config');

// ── 状态 ─────────────────────────────────────────────────────────────────
let pollTimer = null;
let running = false;
let consecutiveFailures = 0;
let paused = false;
let pauseUntil = 0;
let maintenanceTimer = null;

const MAX_CONSECUTIVE_FAILURES = 10;
const MAX_RETRIES = 3;
const RETRY_DELAYS = [5, 15, 45]; // 秒，指数退避
const PAUSE_DURATION = 5 * 60 * 1000; // 5 分钟
const MAINTENANCE_INTERVAL = 60 * 60 * 1000; // 每小时记忆维护（提取记忆卡 + 更新画像）

// ── 数据库 seq 读写 ─────────────────────────────────────────────────────

function readSeq() {
  try {
    const row = db.prepare('SELECT seq FROM wecom_archive_sync ORDER BY id DESC LIMIT 1').get();
    return row ? row.seq : 0;
  } catch (err) {
    console.error('[archive-poller] 读取 seq 失败:', err.message);
    return 0;
  }
}

function writeSeq(seq) {
  try {
    db.prepare('UPDATE wecom_archive_sync SET seq = ?, updated_at = ? WHERE id = (SELECT id FROM wecom_archive_sync ORDER BY id DESC LIMIT 1)')
      .run(seq, new Date().toISOString());
  } catch (err) {
    console.error('[archive-poller] 写入 seq 失败:', err.message);
  }
}

// ── 单次轮询 ─────────────────────────────────────────────────────────────

async function tick() {
  if (paused) {
    if (Date.now() < pauseUntil) return;
    // 暂停结束，恢复
    console.log('[archive-poller] 暂停结束，恢复轮询');
    paused = false;
    consecutiveFailures = 0;
  }

  const ready = isReady();
  if (!ready.ok) {
    console.warn(`[archive-poller] 未就绪: ${ready.reason}`);
    return;
  }

  // 运行锁
  if (running) {
    console.warn('[archive-poller] 上一次轮询尚未完成，跳过本次');
    return;
  }

  running = true;
  setRunning(true);

  try {
    // 加载 bot userId 列表（首次）
    loadBotUserIds();

    // 读取当前 seq
    const seq = readSeq();
    console.log(`[archive-poller] 拉取消息: seq=${seq}`);

    // 拉取加密消息
    const result = await pullChatData(seq, 500);

    if (!result) {
      throw new Error('pullChatData 返回为空');
    }

    if (result.errcode !== 0) {
      throw new Error(`GetChatData 错误: errcode=${result.errcode} errmsg=${result.errmsg}`);
    }

    const chatdata = result.chatdata || [];

    if (chatdata.length === 0) {
      // 没有新消息，正常
      console.log('[archive-poller] 无新消息');
      resetErrors();
      return;
    }

    // 解密所有消息
    const decrypted = [];
    let decryptErrors = 0;
    for (const item of chatdata) {
      try {
        const msg = await decryptChatMessage(
          item.encrypt_random_key,
          item.encrypt_chat_msg,
          config.wecomArchivePrivateKey
        );
        if (msg) {
          // 附加 seq 和 msgid 到消息对象
          msg._seq = item.seq;
          msg._msgid = item.msgid;
          decrypted.push(msg);
        } else {
          decryptErrors++;
        }
      } catch (err) {
        decryptErrors++;
        console.error(`[archive-poller] 消息解密失败 [seq=${item.seq}]:`, err.message);
      }
    }

    console.log(
      `[archive-poller] 拉取 ${chatdata.length} 条, ` +
      `解密成功 ${decrypted.length} 条` +
      (decryptErrors > 0 ? `, 解密失败 ${decryptErrors} 条` : '')
    );

    // 处理消息
    if (decrypted.length > 0) {
      const stats = await processBatch(decrypted);
      console.log(
        `[archive-poller] 处理完成: ${stats.processed} 条, ` +
        `回复 ${stats.replied} 条, 错误 ${stats.errors} 条`
      );
    }

    // 更新 seq
    const maxSeq = chatdata.length > 0
      ? Math.max(...chatdata.map((m) => m.seq))
      : seq;
    writeSeq(maxSeq);
    updateSeq(maxSeq);

    // 成功则重置错误计数
    resetErrors();
  } catch (err) {
    console.error(`[archive-poller] 轮询异常: ${err.message}`);
    consecutiveFailures++;
    incrementErrors();

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.error(
        `[archive-poller] 连续失败 ${consecutiveFailures} 次，` +
        `暂停 ${PAUSE_DURATION / 60000} 分钟`
      );
      paused = true;
      pauseUntil = Date.now() + PAUSE_DURATION;
    }
  } finally {
    running = false;
    setRunning(false);
  }
}

// ── 生命周期 ─────────────────────────────────────────────────────────────

/**
 * 启动轮询器
 * @param {number} intervalSeconds - 轮询间隔（秒）
 */
function start(intervalSeconds) {
  if (pollTimer) {
    console.warn('[archive-poller] 已在运行中，跳过重复启动');
    return;
  }

  const ready = isReady();
  if (!ready.ok) {
    console.warn(`[archive-poller] 未就绪，延迟启动: ${ready.reason}`);
    return;
  }

  const intervalMs = (intervalSeconds || 15) * 1000;

  console.log(`[archive-poller] 启动: 间隔 ${intervalSeconds || 15}s`);

  // 立即执行一次
  tick().catch((err) => console.error('[archive-poller] 初始化轮询失败:', err.message));

  // 定时轮询
  pollTimer = setInterval(() => {
    tick().catch((err) => console.error('[archive-poller] 定时轮询失败:', err.message));
  }, intervalMs);

  // 定时记忆维护（提取记忆卡 + 更新成员画像）
  if (!maintenanceTimer) {
    maintenanceTimer = setInterval(async () => {
      try {
        console.log('[archive-poller] 开始记忆维护...');
        await checkAndExtractAll();
        await checkAndUpdateAll();
        console.log('[archive-poller] 记忆维护完成');
      } catch (err) {
        console.error('[archive-poller] 记忆维护失败:', err.message);
      }
    }, MAINTENANCE_INTERVAL);
  }
}

/**
 * 停止轮询器
 */
function stop() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log('[archive-poller] 已停止轮询');
  }
  if (maintenanceTimer) {
    clearInterval(maintenanceTimer);
    maintenanceTimer = null;
  }
}

/**
 * 手动触发一次同步
 * @returns {Promise<{ok:boolean, status:object}>}
 */
async function syncNow() {
  const status = getStatus();

  const ready = isReady();
  if (!ready.ok) {
    return { ok: false, reason: ready.reason, status };
  }

  try {
    await tick();
    return { ok: true, status: getStatus() };
  } catch (err) {
    return { ok: false, reason: err.message, status: getStatus() };
  }
}

/**
 * 获取轮询器状态
 */
function getPollerStatus() {
  return {
    running,
    paused,
    pauseUntil: pauseUntil > 0 ? new Date(pauseUntil).toISOString() : null,
    consecutiveFailures,
    ...getStatus(),
    pollInterval: config.wecomArchivePollInterval,
    enabled: config.wecomArchiveEnabled,
  };
}

// ── 初始化入口 ───────────────────────────────────────────────────────────

/**
 * 初始化并启动归档轮询器（由 server.js 调用）
 * @param {number} intervalSeconds
 */
function initArchivePoller(intervalSeconds) {
  if (!config.wecomArchiveEnabled) {
    console.log('[archive-poller] 会话存档未启用 (WECOM_ARCHIVE_ENABLED=false)，跳过');
    return null;
  }

  const ready = isReady();
  if (!ready.ok) {
    console.warn(`[archive-poller] 会话存档配置不全: ${ready.reason}`);
    console.warn('[archive-poller] 请在管理后台购买功能后配置 .env 中的 WECOM_ARCHIVE_* 变量');
    return null;
  }

  start(intervalSeconds || config.wecomArchivePollInterval || 15);
  return { stop, syncNow, getStatus: getPollerStatus };
}

module.exports = {
  initArchivePoller,
  start,
  stop,
  syncNow,
  getStatus: getPollerStatus,
};
