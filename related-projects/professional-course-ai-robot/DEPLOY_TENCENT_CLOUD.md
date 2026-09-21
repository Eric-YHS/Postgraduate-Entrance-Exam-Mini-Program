# 研伴 AI 腾讯云部署指南

本项目以 Docker Compose 部署：Nginx 提供静态网页和同源 `/api` 反向代理，Python 服务只在内部网络监听。学生端和教师端不再需要写入服务器 IP 或 `localhost`。

## 上线前资源

准备已备案域名、腾讯云安全组（只开放 80/443）、服务器（建议 2 核 4 GB 起）、模型服务密钥，以及用于定期备份的 COS 或其他异地存储。生产环境必须使用独立且强随机的 `YANBAN_ADMIN_TOKEN`；不要复用测试密钥。

## 安装和配置

在 Ubuntu 22.04/24.04 服务器安装 Docker Engine 与 Docker Compose 插件。将项目上传至服务器后，复制配置模板：

```bash
cp .env.example .env
```

生产 `.env` 最少需要设置：

```env
YANBAN_HOST=0.0.0.0
YANBAN_PORT=8000
YANBAN_LOCAL_TEST_MODE=0
YANBAN_ADMIN_TOKEN=替换为至少32位随机字符串
YANBAN_CORS_ORIGINS=https://你的域名
YANBAN_RATE_LIMIT_PER_MINUTE=120
YANBAN_LLM_BASE_URL=https://你的模型中转站/v1
YANBAN_LLM_API_KEY=你的密钥
YANBAN_LLM_MODEL=实际模型ID
TAVILY_API_KEY=可选，仅院校资料不足时使用
```

执行构建和启动：

```bash
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1/api/health
```

访问 `http://服务器IP/student.html` 验证健康接口后，再配置域名。不要在域名和 HTTPS 配好前开放教师端给非管理员使用。

## HTTPS 与域名

将域名 A 记录解析到服务器公网 IP。推荐由宿主机 Nginx/Caddy 或腾讯云负载均衡终止 TLS，并将请求代理到 Compose 的 80 端口；证书可以使用腾讯云 SSL 证书或 Certbot。启用 HTTPS 后，将 `YANBAN_CORS_ORIGINS` 固定为最终 HTTPS 域名并重启服务：

```bash
docker compose up -d
```

## 备份与恢复

当前业务数据、上传资料和 SQLite 数据库都在 `./data` 持久化卷。每天低峰期先执行 SQLite 在线备份，再上传到 COS；不要直接复制正在写入的 WAL 数据库文件。

```bash
mkdir -p backups
sqlite3 data/yanban.sqlite3 ".backup 'backups/yanban-$(date +%F).sqlite3'"
tar -czf backups/uploads-$(date +%F).tar.gz data/uploads
```

至少保留 7 个每日备份，并定期在隔离目录恢复一次以验证可用性。用户与资料增多后，应迁移到托管 MySQL/PostgreSQL 和对象存储；这属于容量演进，不是当前部署的功能阻塞。

## 上线验收

确认 `YANBAN_LOCAL_TEST_MODE=0`、管理员令牌已替换、浏览器只访问 HTTPS、`/api/health` 可用、学生未登录时不能读取或写入其他 `studentId` 数据、教师接口无令牌返回 401、上传 100 MB 以上文件被拒绝、模型密钥不在 HTML 源码或浏览器网络请求中。也应完成一次登录、上传、分析、计划、带背、刷题、退出/重新登录和管理员查看学生记录的端到端回归。

## 当前边界

SQLite 和项目本地上传目录适合首版小规模服务，不能替代高可用数据库和对象存储。短信、支付、生产 OCR、真实 LLM/联网搜索调用依赖外部账号和密钥；未配置时系统会返回明确的不可用状态，不能被视为已开通的生产功能。
