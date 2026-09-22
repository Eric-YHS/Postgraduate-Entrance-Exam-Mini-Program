# GitHub Actions 自动部署配置指南

你需要到 GitHub 仓库的 **Settings → Secrets and variables → Actions** 页面，点击 **"New repository secret"** 按钮，依次添加 3 个密钥。

---

## 第 1 个密钥：SERVER_HOST

填写内容：

| 字段   | 值              |
| ------ | --------------- |
| Name   | `SERVER_HOST`   |
| Secret | `159.75.67.99`  |

填写完成后点击绿色按钮 **"Add secret"** 保存。

---

## 第 2 个密钥：SERVER_USER

再次点击 **"New repository secret"**，填写内容：

| 字段   | 值            |
| ------ | ------------- |
| Name   | `SERVER_USER` |
| Secret | `ubuntu`      |

填写完成后点击 **"Add secret"** 保存。

---

## 第 3 个密钥：SERVER_SSH_KEY

再次点击 **"New repository secret"**，填写内容：

| 字段   | 值               |
| ------ | ---------------- |
| Name   | `SERVER_SSH_KEY` |
| Secret | 见下方私钥内容    |

Secret 栏粘贴服务器上生成的**完整私钥内容**（包括首尾两行），格式如下：

```
-----BEGIN OPENSSH PRIVATE KEY-----
<粘贴你的私钥内容>
-----END OPENSSH PRIVATE KEY-----
```

> **注意**：私钥内容在服务器上通过 `cat ~/.ssh/id_ed25519` 获取，不要泄露给任何人。

填写完成后点击 **"Add secret"** 保存。

---

## （可选）第 4 个密钥：SERVER_DOTENV

| 字段   | 值                                  |
| ------ | ----------------------------------- |
| Name   | `SERVER_DOTENV`                     |
| Secret | 服务器上 `.env` 的完整内容            |

它只在**服务器上 `/home/ubuntu/kaoyan-xiaochengxu/.env` 不存在时**生效：部署前会把这份内容
以 `0600` 写回服务器，然后照常用 `.env.example` 的校验继续部署；服务器上已经有 `.env` 时这一步直接跳过，
所以配了它也不会覆盖手工维护的线上配置。

**Why:** `.env` 被 rsync 排除，只活服务器上。它一旦丢（误删、换机、重装系统），部署会永远停在
「缺少 .env」那一步，而仓库侧无论怎么改都不会变绿——没有 SSH 权限的人完全无法推进。

**How to apply:** 只在新机器首次部署、或线上 `.env` 确实丢了的时候依赖它。日常改动服务器上的配置仍然
直接改 `.env`（改完记得同步回这个 secret，否则下次重建会用旧值）。

---

## 三条工作流的分工

| 文件 | 名字 | 触发 | 干什么 |
| ---- | ---- | ---- | ------ |
| `ci.yml` | `CI` | PR、push 到 main | 后端 `npm test`、`.env.example` 覆盖校验、依赖公告审计、小程序 typecheck/lint/发布校验、密钥泄漏扇描 |
| `deploy.yml` | `Deploy to Server` | `CI` 成功结束后（仅 main 的 push）+ 手工触发 | rsync 代码 → 备份数据库 → `npm ci --omit=dev` → PM2 重启 → 健康检查 |
| `upload-miniprogram.yml` | `Upload MiniProgram` | push 且改了 `miniprogram/**` | 小程序 typecheck/lint 后用 miniprogram-ci 上传体验版 |

拆开之前，测试和部署共用一条 push 触发的工作流。后果是：服务器缺 `.env`、SSH 抖动这类纯运维问题
会把 `npm test` 也标成红叉，PR 上完全看不出到底是代码坏了还是机器坏了，久了就没人为红叉负责。

两个细节：

- `deploy` 用 `workflow_run` 拿到 CI 的结论，并**显式检出那次运行对应的 commit**（`head_sha`）。
  不锁 SHA 的话，CI 跑的是 A，部署可能拉到已经进来的 B，部署了一段没测试过的代码。
- 部署失败不会影响 PR 检查（反之 CI 绿也不保证部署成功），两者的失败信息各自独立，看日志时先确认是哪一类。

---

## 配置完成后的效果

3 个密钥全部添加后，页面应该显示如下：

```
SERVER_HOST       (Updated just now)
SERVER_SSH_KEY    (Updated just now)
SERVER_USER       (Updated just now)
```

之后每次你执行 `git push` 到 `main` 分支，GitHub 就会自动：
1. 跑 `CI`（后端测试 + 小程序校验 + 密钥扇描），任一项红就不部署
2. `CI` 成功后通过 SSH 连接服务器，用 rsync 同步这次被测试的那个 commit（不是 `git pull`）
3. 备份 SQLite 数据库、`npm ci --omit=dev`、用 PM2 重启服务
4. 等 `/healthz` 返回 ok，再校验内容安全接口确实属于本次部署

你可以在仓库的 **Actions** 标签页查看每次自动部署的运行状态。

---

## 测试自动部署

配置完成后，可以用以下命令测试：

```bash
git commit --allow-empty -m "test: trigger auto deploy"
git push origin main
```

然后到 GitHub 仓库的 **Actions** 标签页，先看到一条 `CI` 运行；它成功之后才会出现一条
`Deploy to Server`。不想等代码改动、只想把服务器上现有提交重启一遍，就用
**Actions → Deploy to Server → Run workflow**（手工触发）。

