const { answerWithOfficialModels } = require('../officialAnswerEngine');
const {
  appendProfileInvite,
  decorateReply,
  enrichConfiguredReply,
  finalizeConfiguredReply,
  prepareConfiguredReply
} = require('../configuredBotRuntime');

/**
 * 运行由管理后台配置的群聊角色机器人。
 * 角色、语气、模型参数都来自 bots.config，无需新增一套代码。
 */
async function handleConfiguredGroupBot({
  bot,
  message,
  groupContext = '',
  externalUserId = '',
  studentId = null
}) {
  if (!bot || !message) {
    throw new Error('bot 和 message 为必填参数');
  }

  let prepared = prepareConfiguredReply({
    bot,
    message,
    channel: 'wecom_group',
    externalUserId,
    studentId,
    contextText: groupContext
  });
  if (prepared.immediateReply) {
    return decorateReply(bot, prepared.config, appendProfileInvite(prepared, prepared.immediateReply));
  }
  prepared = await enrichConfiguredReply({ bot, prepared, message, contextText: groupContext });

  const reply = await answerWithOfficialModels({
    message,
    systemPrompt: prepared.systemPrompt,
  });

  const finalReply = finalizeConfiguredReply({
    bot,
    config: prepared.config,
    reply,
    channel: 'wecom_group',
    externalUserId,
    studentId
  });
  return decorateReply(bot, prepared.config, appendProfileInvite(prepared, finalReply));
}

module.exports = {
  handleConfiguredGroupBot,
};
