---
name: wecom-single-chat-81013
description: 企业微信单聊机器人已能收到消息并生成回复，但部分测试账号收到 81013 错误
metadata:
  type: project
---

企业微信官方回调已正确配置，单聊消息能正常进入 `/api/wecom/callback`、完成解密、调用 freeTutorBot/answerBot 生成回复，并通过 `sendAppMessage` 回发。但发送给某些不在应用可见范围内的成员时会收到 WeCom 错误码 `81013`（`user & party & tag all invalid`），导致用户侧看不到回复。

**Why:** 企业微信应用只能向「可见范围」内的成员发送应用消息。测试账号或新加入的客服账号如果没有被加入应用可见成员，就会触发 81013。

**How to apply:** 在企业微信管理后台 → 应用管理 → 对应自建应用 → 可见范围里，把需要接收机器人回复的成员/部门加进去。对于未绑定系统账号的 WeCom 用户，机器人会走免费答疑流程，但仍要求该用户先进入应用可见范围。
