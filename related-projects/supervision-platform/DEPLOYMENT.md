# 上岸督学平台部署说明

## 实际完成范围

当前代码已具备 PostgreSQL 版本化迁移、服务端 Cookie 会话认证、学生注册与改密、登记导入、计划与任务完成记录、自测档案、社区审核，以及入学测评的分发、开始和提交基础接口。服务端使用 Argon2id 保存密码，生产启动要求有效的 `DATABASE_URL` 和至少 32 位的 `SESSION_SECRET`。

这不是完整的生产业务闭环：入学测评尚未具备服务端题库、客观题评分和题目快照；课程、订单、权益、文件上传、AI、知识库等核心模块仍在继续实现。前端在 API 模式下已接入认证，但多数业务界面仍需要逐步迁移出本地演示存储。上线前须以 `DEPLOYMENT_READINESS_MATRIX.md` 的 P0 项为准，不应仅根据页面可打开判断已完成。

## 必填环境变量

项目根目录创建 `.env`，不要把真实值提交到代码仓库：

```dotenv
POSTGRES_DB=shangan
POSTGRES_USER=shangan
POSTGRES_PASSWORD=替换为随机强密码
SESSION_SECRET=替换为至少32位随机字符串
APP_ORIGIN=https://你的正式域名
```

首次创建管理员时，还需要临时提供：

```dotenv
BOOTSTRAP_ADMIN_NAME=管理员姓名
BOOTSTRAP_ADMIN_PHONE=11位手机号
BOOTSTRAP_ADMIN_PASSWORD=至少12位强密码
```

`SESSION_SECRET` 可用 `openssl rand -base64 48` 生成。生产环境必须使用 HTTPS；配置 HTTPS 后 `APP_ORIGIN` 必须是实际的 `https://` 域名。

## 容器部署

```bash
cp .env.example .env
# 填写上面的变量
docker compose up -d --build
```

编排顺序为：PostgreSQL 健康后运行一次性 `migrate` 服务，迁移成功后启动 API，API 的 `/ready` 返回成功后启动 Web。迁移服务退出码非零时，API 不会启动。不要将迁移命令塞进每个 API 容器的启动命令，也不要自动运行管理员初始化。

查看状态：

```bash
docker compose ps
docker compose logs -f migrate api web
curl http://服务器地址/health
curl http://服务器地址/ready
```

`/health` 只表示 API 进程存活；`/ready` 会实际查询 PostgreSQL，适合负载均衡器或发布脚本作为就绪判断。

## 首次初始化管理员

数据库迁移成功后，在服务器上一次性运行：

```bash
docker compose run --rm \
  -e BOOTSTRAP_ADMIN_NAME \
  -e BOOTSTRAP_ADMIN_PHONE \
  -e BOOTSTRAP_ADMIN_PASSWORD \
  api node src/bootstrap-admin.js
```

初始化程序拒绝重复手机号，并将账户设为强制首次改密。完成后应从服务器环境或终端历史中清除临时密码。

## HTTPS 与反向代理

仓库中的 Nginx 配置已包含 API 代理、健康检查入口、基础安全响应头、静态资源缓存和超时限制，但它只监听容器内的 HTTP 80 端口。正式 TLS 证书、443 监听、证书续期和强制 HTTPS 跳转需要在域名与证书准备完成后由部署环境配置。不要在无证书时直接启用 HSTS。

## 数据库备份与恢复

`scripts/backup-db.sh` 使用 `pg_dump` 创建保留 14 天的自定义格式备份。生产环境应通过 cron 或云平台任务每日执行，将备份复制到独立存储，并在正式上线前完成恢复演练。

恢复前必须指定独立的目标数据库，避免覆盖正在服务的生产库：

```bash
createdb "$RESTORE_DATABASE_URL"
RESTORE_DATABASE_URL="$RESTORE_DATABASE_URL" ./scripts/restore-db.sh backups/shangan-<时间戳>.dump
```

`deploy/nginx/https.conf.template` 是外层 TLS 终结反代模板。替换域名和证书路径、确认证书已签发后再挂载；该模板才启用 HSTS 和 HTTP 到 HTTPS 的跳转。

## 上线验收

上线环境中必须验证：容器依赖顺序和迁移失败阻断、`/health` 与 `/ready`、登录登出和改密、角色越权拦截、登记到教师导入、学生计划与任务完成、社区审核、入学测评链接、开始后的固定一小时期限、重复提交幂等、数据库重启后的数据保留，以及备份恢复。

对象存储、支付渠道、AI 模型密钥、短信/微信能力、域名和证书均为外部资源。申请到这些资源后仍需执行对应的代码接入与联调，不能视为仅靠部署自动具备。
