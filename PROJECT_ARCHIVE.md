# 项目资料总览

本仓库汇总“考研小程序”及其配套服务的可维护源码与部署资料。

## 目录

- 仓库根目录：原考研小程序、Node.js 服务端、企业微信机器人及管理页面。
- `miniprogram/`：微信小程序客户端。
- `related-projects/supervision-platform/`：考研督学平台（学生端、教师端及独立服务端）。
- `related-projects/professional-course-ai-robot/`：专业课 AI 机器人。
- `related-projects/wechat-ai-assistant/`：收到的微信 AI 助手 1.2.0 Windows 分发包。

## 归档原则

仓库保留源码、依赖清单、数据库迁移、测试、设计和部署文档。以下内容不进入公开仓库：真实 `.env`、上传私钥、账号表、运行数据库、用户上传、日志、缓存、`node_modules`、构建缓存、微信原始数据库及含私人信息的聊天原文。

这些排除项不是构建源码的一部分；部署时应根据各项目的 `.env.example` 配置环境变量，并重新安装依赖与构建。
