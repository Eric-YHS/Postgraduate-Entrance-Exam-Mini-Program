---
name: github-actions-ssh-key-issue
description: GitHub Actions 部署工作流失败原因：SERVER_SSH_KEY secret 需重新配置
metadata:
  type: project
---

`.github/workflows/deploy.yml` 的 SSH host key fingerprint 已更新为服务器当前公钥（ed25519），部署目录也已修正，但 Deploy via SSH 步骤仍然立即失败，说明问题不在 fingerprint/路径，而在 `secrets.SERVER_SSH_KEY` 这个 GitHub secret 本身（可能为空、格式错误、带 passphrase 或不是对应服务器 ubuntu 用户的私钥）。

**Why:** 手动 SSH 部署已验证服务器网络、用户、端口均正常；只有 Actions 使用的 secret key 无法通过认证。

**How to apply:** 需要在 GitHub 仓库 Settings → Secrets and variables → Actions 中检查并重新设置 `SERVER_SSH_KEY`、`SERVER_HOST`、`SERVER_USER`。正确设置后，工作流才能自动部署。
