const { answerWithOfficialModels } = require('../officialAnswerEngine');
const {
  appendProfileInvite,
  decorateReply,
  enrichConfiguredReply,
  finalizeConfiguredReply,
  prepareConfiguredReply
} = require('../configuredBotRuntime');

/**
 * 运行管理后台配置的微信客服角色。
 * 微信客服是一对一会话，提示词与群聊机器人分开，避免把客户称为“群成员”。
 */
async function handleConfiguredKfBot({
  bot,
  message,
  conversationContext = '',
  externalUserId = '',
  studentId = null
}) {
  if (!bot || !message) throw new Error('bot 和 message 为必填参数');

  let prepared = prepareConfiguredReply({
    bot,
    message,
    channel: 'wecom_kf',
    externalUserId,
    studentId,
    contextText: conversationContext
  });
  if (prepared.immediateReply) {
    return decorateReply(bot, prepared.config, appendProfileInvite(prepared, prepared.immediateReply));
  }
  prepared = await enrichConfiguredReply({ bot, prepared, message, contextText: conversationContext });

  const reply = await answerWithOfficialModels({
    message,
    systemPrompt: prepared.systemPrompt,
  });

  const finalReply = finalizeConfiguredReply({
    bot,
    config: prepared.config,
    reply,
    channel: 'wecom_kf',
    externalUserId,
    studentId
  });
  return decorateReply(bot, prepared.config, appendProfileInvite(prepared, finalReply));
}

module.exports = {
  handleConfiguredKfBot,
};
