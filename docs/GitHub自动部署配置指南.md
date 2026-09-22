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
| `ci.yml` | `CI` | PR、push 到 main | 后端 `npm test`、`.env.example` 覆盖校验、依赖审计、小程序 typecheck/lint/发布校验、密钥泄漏扫描 |
| `deploy.yml` | `Deploy to Server` | `CI` 成功结束后（仅 main 的 push）+ 手工触发 | rsync 代码 → 备份数据库 → `npm ci --omit=dev` → PM2 重启 → 健康检查 |
| `upload-miniprogram.yml` | `Upload MiniProgram` | push 且改了 `miniprogram/**` | 小程序 typecheck/lint 后用 miniprogram-ci 上传体验版 |

拆开之前，测试和部署共用一条 push 触发的工作流。后果是：服务器缺 `.env`、SSH 抖动这类纯运维问题
会把 `npm test` 也标成红叉，PR 上完全看不出到底是代码坏了还是机器坏了，久了就没人为红叉负责。

两个细节：

- `deploy` 用 `workflow_run` 拿到 CI 的结论，并**显式检出那次运行对应的 commit**（`head_sha`）。
  不锁 SHA 的话，CI 跑的是 A，部署可能拉到已经进来的 B，部署了一段没测试过的代码。
- 部署失败不会影响 PR 检查（反之 CI 绿也不保证部署成功），两者的失败信息各自独立，看日志时先确认是哪一类。

### 部署前的几道卡口

按执行顺序，任何一道不过都会在任何东西被动之前退出（旧进程继续服务）：

| 卡口 | 拦住什么情况 |
| ---- | ------------ |
| 服务器必须有 `.env` | 丢了 `.env` 就带着一堆 `undefined` 配置重启 |
| `SESSION_SECRET` 长度 ≥ 32 | 密钥缺失/过短——每次重启所有人登录态失效 |
| **空库守卫** | 见下方 |
| 微信 `access_token` 能拿到 | AppId/Secret 错、IP 未白名单 |
| `/healthz` + 内容安全接口属于本次 commit | 新进程其实没起来 / 跑的还是旧代码 |

**空库守卫**：每次部署成功后，会把 `users` / `questions` 的行数写进服务器上的
`.deploy-db-stats.json`（这个文件不在仓库里，不会被 rsync 动）。下一次部署时，如果
上次基线里 `users > 0`，而按 `.env` 里的 `DB_PATH` 读到的库却不见了或空了，就直接终止。

**Why:** `.env` 丢了以后 `DB_PATH` 会退回默认值，新进程就在一个新建的空库上启动；
`/healthz` 照样返回 ok，线上却安静地变成“所有用户都不存在”。以前只有备份那一步的
一行警告，很容易滑过去。

**How to apply:** 确实刚重置过数据库（或做了库迁移、换文件）时，用
**Run workflow → 勾选 `允许数据库为空`** 跑一次；基线只在整个部署链路成功后才更新，
中途失败的部署不会把基线冲掉。统计本身出错（比如库文件打不开）只会警告，不会卡部署。

---

## 新代码起不来：自动回滚

`rsync` 是直接覆盖服务器工作目录的。以前新版本启动失败（`/healthz` 60 秒内不返 ok）时，
旧进程已被 `pm2 delete`、旧代码已被覆盖，站点会一直挂到有人上门。

现在 `rsync` 之前会把服务器上当前的代码打包到 `backups/app-before-deploy.tar.gz`（只打代码：
数据库、`public/uploads`、`.cache`、`node_modules`、`.env`、`backups` 本身都不进包），
健康检查失败时：

1. 解包还原代码与 `package-lock.json`；
2. 把 `.deploy-sha` / `.content-security-verified` 写回上一个版本（不让健康接口报一个根本没在跑的 commit）；
3. `npm ci --omit=dev` 后重新 `pm2 start`，再等一次健康检查；
4. 不管回滚成功与否，本次部署在 Actions 里仍是红的，只是线上先恢复到上一个能跑的版本。

日志里会写明回滚到了哪个 commit。看到 `回滚后应用仍未启动` 才需要人工登录服务器看
`pm2 logs study-planner`。首次部署没有快照，日志会提示“没有可回滚的代码”。
- tar 只覆盖同名文件，新版本新增的文件会留在磁盘上，但旧 `src/` 不引用它们，
`npm ci` 也会按旧 `package-lock.json` 重建 `node_modules`。

---

## 配置完成后的效果

3 个密钥全部添加后，页面应该显示如下：

```
SERVER_HOST       (Updated just now)
SERVER_SSH_KEY    (Updated just now)
SERVER_USER       (Updated just now)
```

之后每次你执行 `git push` 到 `main` 分支，GitHub 就会自动：
1. 跑 `CI`（后端测试 + 小程序校验 + 密钥扫描），任一项红就不部署
2. `CI` 成功后通过 SSH 连接服务器，用 rsync 同步这次被测试的那个 commit（不是 `git pull`）
3. 备份 SQLite 数据库、`npm ci --omit=dev`、用 PM2 重启服务
4. 等 `/healthz` 返回 ok，再校验内容安全接口确实属于本次部署
5. 新进程起不来时，自动回滚到上一个版本（见上方「新代码起不来：自动回滚」）

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

