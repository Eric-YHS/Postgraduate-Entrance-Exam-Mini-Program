# 部署前可完成事项与执行表

更新时间：2026-08-12

| 编号 | 事项 | 类型 | 当前状态 | 本阶段动作 | 外部依赖 |
|---|---|---|---|---|---|
| P0-01 | 生产环境 Secret 校验 | 后端/安全 | 已完成 | 启动时拒绝缺失或少于 32 位的 SESSION_SECRET | 无 |
| P0-02 | 数据库版本化迁移 | 数据库/部署 | 已完成 | migration history、顺序执行、事务和 advisory lock | 无 |
| P0-03 | 初始管理员创建 | 后端/运维 | 已完成 | 一次性 bootstrap 命令，密码仅通过环境变量传入并使用 Argon2id | 部署时需提供账号密码 |
| P0-04 | 数据库 readiness | 后端/部署 | 已完成 | `/ready` 查询数据库，Compose 以健康检查编排服务 | 无 |
| P0-05 | 入学试卷开始幂等 | 后端/考试 | 已完成 | 重复开始不重置截止时间，使用行锁 | 无 |
| P0-06 | 入学试卷提交幂等 | 后端/考试 | 已完成 | 事务、行锁、唯一约束和重复提交返回原结果 | 无 |
| P0-07 | 入学试卷服务端评分模型 | 后端/题库 | 部分完成 | 已实现题目、试卷、快照、脱敏公开试题和客观题服务端计分；主观题人工/AI 批改及前端切换仍待完成 | 无 |
| P0-08 | 服务端认证接入前端 | 前端/后端 | 已完成 | 登录、登出、会话恢复改用 HttpOnly Cookie | 无 |
| P0-09 | 生产关闭 localStorage 业务回退 | 前端/安全 | 已完成 | `isApiConfigured()` 门控的 teachers / students / content / applications / reviewPlans / entranceState 写入；API 模式下不再写本地业务存储 | 无 |
| P0-10 | 核心数据服务端持久化 | 前后端/数据库 | 部分完成 | 已建计划、任务、自测、社区、订单、权益、课程、商品、入学测评和分发 API；前端课程交易、报名和测评的范围仍待迁移 | 无 |
| P0-11 | 角色与权限统一 | 后端/安全 | 已完成 | `requireRoles` / `requireStudent` / `canAccessStudent` 统一决策；DTO 与权限字段一致 | 无 |
| P0-12 | 后端请求校验 | 后端/安全 | 已完成 | 所有 body / params / query 入参走 Zod；UUID / 长度 / 枚举 / 时间已约束 | 无 |
| P0-13 | 审计日志覆盖 | 后端/安全 | 已完成 | 登录、注册、改密、登记导入、学员档案、课程、商品、订单、入学测评、计划、任务（完成/撤销）、自测、社区发帖与审核、admin 账号管护均写入 audit_logs，并提供 `/api/admin/audit-logs` 列表 | 无 |
| P1-01 | 课程、计划、任务 API | 后端/业务 | 部分完成 | 课程 / 商品 / 订单 / 权益 / 计划 / 任务 / 自测 API 与 DTO 完整；前端范围移出 localStorage 仍待继续 | 无 |
| P1-02 | 自测档案与日周月测试 API | 后端/业务 | 部分完成 | assessment_records 接口可用；前端日周月测试仍需要从 localStorage 切到 API | 无 |
| P1-03 | 课程文件持久化 | 后端/业务 | 部分完成 | `server/src/storage.js` 提供适配层与本地驱动，支持 put / stat / read / delete / 签名 URL；s3 / oss / cos 驱动待申请到真实对象存储后接入 | 需对象存储 |
| P1-04 | 订单、权益和支付流程 | 后端/业务 | 部分完成 | 已实现课程、商品、订单、权益与人工审核 API；订单和权益事务幂等，金额从服务端商品读取；纯函数 `decisionForOrderClaim/decisionForOrderReview` 已抽离并做单元测试；自动支付回调与前端切换待完成 | 自动支付需申请支付渠道 |
| P1-05 | 社区与审核 API | 后端/业务 | 部分完成 | 帖子创建与审核 API 与权限完成；前端社区模块仍待迁移 | AI 审核需模型服务 |
| P1-06 | AI 编排与机器人配置 API | 后端/AI | 未完成 | AI jobs、模型配置、审计、人工确认 | 需申请模型服务和 API Key |
| P1-07 | 知识库与向量检索 | 后端/AI | 未完成 | 文档、切片、embedding、检索接口 | 需对象存储/embedding 服务 |
| P1-08 | 文件安全 | 后端/安全 | 未完成 | MIME/大小限制、权限校验、删除清理、扫描接口 | 扫描服务可选 |
| P1-09 | 自动化测试 | 测试 | 部分完成 | `verify-predeploy.sh` 跑前端构建 + 后端语法 + 单元测试 + 脚本 sh -n；订单/权益/admin accounts 纯函数 12 项测试通过；本地数据库集成测试需要在部署或 CI 环境接入 | 部署或 CI 数据库 |
| P1-10 | 备份恢复验证 | 部署/运维 | 部分完成 | `backup-db.sh` / `restore-db.sh` / `backup-restore-test.sh` 已写好；`ALLOW_DESTRUCTIVE_RESTORE` 守护；演练需在部署环境执行 | 需部署环境执行 |
| P1-11 | HTTPS 与安全响应头 | 部署/运维 | 部分完成 | `default.conf` 含 nosniff/X-Frame/Permissions-Policy；`https.conf.template` 支持 443 + HSTS + 跳转；正式证书需挂域名后替换 | 需域名/证书 |
| P1-12 | 监控告警 | 部署/运维 | 部分完成 | `/health` / `/ready` / `/metrics`（admin 守护，PG pool 状态、4xx/5xx、平均耗时）已就绪；告警通道需部署监控平台 | 需部署监控平台 |
| P1-13 | 结构化日志 | 后端/可观测 | 已完成 | Fastify logger 增加 redact 配置：password / cookie / token / shareToken / session 字段脱敏 | 无 |
| P1-14 | 管理员账号管理 API | 后端/业务 | 已完成 | `/api/admin/accounts` 列表（带角色过滤与 limit）、POST 创建、PATCH 状态/密码/姓名、DELETE 删除；前端设置页在 API 模式下切换到这些接口 | 无 |
| EXT-01 | 云服务器、域名、HTTPS 证书 | 外部资源 | 未申请 | 由部署方提供 | 需要用户申请 |
| EXT-02 | PostgreSQL 生产实例或 Docker 主机 | 外部资源 | 未部署 | 由部署方提供 | 需要用户部署 |
| EXT-03 | 对象存储 | 外部资源 | 未申请 | 由部署方提供 | 需要用户申请 |
| EXT-04 | 支付渠道 | 外部资源 | 未申请 | 由部署方提供 | 需要用户申请 |
| EXT-05 | AI 模型供应商与密钥 | 外部资源 | 未申请 | 由部署方提供 | 需要用户申请 |
| EXT-06 | 短信/微信登录 | 外部资源 | 首发可不做 | 未接入时隐藏入口 | 按产品范围决定 |

## 执行规则

P0 项必须在面向真实多用户上线前完成。P1 项中涉及课程文件、支付、AI、监控和备份的部分，需要代码和外部资源共同完成。EXT 项不是代码问题，必须由部署方申请或提供，但拿到资源后仍需要完成对应接入和联调。

## 当前可执行自动化验证

```bash
bash scripts/verify-predeploy.sh   # 前端构建 + 后端语法 + 单元测试 + 脚本语法
bash scripts/verify-deployment.sh http://服务器  # 部署后冒烟
```

`verify-predeploy.sh` 当前在仓库内即可运行；`verify-deployment.sh` 需在部署完成后运行。
