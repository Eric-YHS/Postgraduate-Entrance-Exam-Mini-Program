---
name: server-app-directory
description: 生产服务器上 Node.js 应用的部署目录
metadata:
  type: project
---

生产服务器（159.75.67.99 / xiaoeduhub.online）上 Node.js 后端实际部署目录为 `/home/ubuntu/kaoyan-xiaochengxu`，而非 `.github/workflows/deploy.yml` 中曾写错的 `/home/ubuntu/study-planner`。

**Why:** 自动部署脚本使用错误目录导致 SSH 登录后的所有命令都失败，应用实际上由手动 tar+scp 部署并初始化 git 后维护。

**How to apply:** 后续任何涉及服务器文件路径的操作（部署脚本、PM2 配置、.env 中的 TRANSFORMERS_CACHE 等）都应使用 `/home/ubuntu/kaoyan-xiaochengxu` 作为根目录。
