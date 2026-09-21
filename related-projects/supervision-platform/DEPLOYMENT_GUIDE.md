# 前端部署集成手册

> 更新日期：2026-08-12
> 范围：本轮完成的 11 处前端写操作接入服务端 + 4 处挂载数据拉取 + 1 处审计日志查看组件

## 1. 本轮新增的前端 ↔ 后端连接

### 1.1 写操作（11 项）

| 业务 | 前端入口 | HTTP | 路径 | 关键字段 |
|---|---|---|---|---|
| 学员档案编辑（教师视角） | `Students.saveProfile` | PATCH | `/api/students/:id` + `/api/admin/accounts/:id` | name、phone、examYear、targetSchool、major、status、subjects、freeAccess 等 |
| 新建学员（教师视角） | `Students.saveStudentProfile` | POST + PATCH | `/api/admin/accounts` + `/api/students/:studentId` | 手机号、初始临时密码、姓名；返回临时密码需教师告知 |
| 停用/恢复学员 | `Students.removeStudent` / `restoreStudent` | PATCH | `/api/admin/accounts/:id` | status: '停用' / '启用' |
| 重置学员密码 | `Students.resetStudentPassword` | PATCH | `/api/admin/accounts/:id` | password、mustChangePassword=true |
| 创建课程 | `Content.createCourse` | POST | `/api/admin/courses` | title、subject、audience、description、price、tags、status |
| 发布/取消课程 | `Content.publish` | POST | `/api/admin/courses/:id/publish` | action: 'publish' / 'unpublish' |
| 创建商品 | `Content.createProduct` | POST | `/api/admin/products` | name、type、price、description、coverImageUrl、items[] |
| 切换商品上下架 | `Content.toggleProductState` | POST | `/api/admin/products/:id/state` | active: true / false |
| 审核订单 | `Content.approveOrder` / `rejectOrder` | POST | `/api/admin/orders/:id/review` | decision: 'approve' / 'reject'、reviewNote |
| 学员提交购买申请 | `StudentStore.submitPurchaseRequest` | POST | `/api/orders` | items[]、note、couponCode |
| 学员提交日/周/月自测 | `PeriodicAssessmentPage.submit` | POST | `/api/students/:id/assessments` | type、subject、score、answers、wrongQuestions、duration |
| 学员切换今日任务 | `StudentHome.toggleTaskItem` | POST/DELETE | `/api/plans/:id/tasks/:rowIndex/:taskIndex/complete` | isCorrect 字段（POST 体） |
| 学员发帖 | `Community.submitPost` | POST | `/api/posts` | title、content、tags、attachments |
| 审核帖子 | `Moderation.review` | POST | `/api/admin/posts/:id/review` | decision: 'approve' / 'reject'、reason |
| 教师分配计划 | `Students.assignPlan` | POST | `/api/students/:id/plans` | templateId、templateVersionId、rows[]、startDate |
| 教师分发试卷 | `QuestionBank.distributePaper` | POST | `/api/exams/distributions` | paperId、studentIds[]；返回 shareToken，前端拼接 `${origin}/exam/${slug}/?token=${token}&sid=${studentId}` |

### 1.2 挂载时拉取（4 项）

登录后挂载阶段新增 4 个 `useEffect`，在 `/api/auth/me` 之后按角色拉取：

| 数据 | 触发条件 | HTTP | 路径 |
|---|---|---|---|
| 学员列表 | `account?.role !== 'student'` | GET | `/api/students` |
| 课程 + 商品列表 | `account?.role !== 'student'` | GET | `/api/courses` + `/api/products` |
| 订单列表 | `account?.role !== 'student'` | GET | `/api/orders` |
| 帖子列表 | 任意已登录用户 | GET | `/api/posts` |

所有挂载拉取均含 `if (account?.role === 'student') return;` 守卫，避免学生端无谓请求。

### 1.3 新增 UI 组件：审计日志查看

- 路径：教师/超级管理员「系统设置」页最末（条件渲染：`isAdmin && apiMode`）
- 文件：`src/App.jsx` 内嵌 `AuditLogsPanel` 组件
- 功能：
  - 筛选：操作类型、实体类型、limit（50/100/200/500）
  - 数据源：`GET /api/admin/audit-logs?limit=&action=&entityType=`
  - CSV 导出（前端 Blob 下载）
  - 列：时间 / 操作 / 实体 / 操作人 / 详情

## 2. 仍保留 localStorage 的字段（按用户决定）

以下字段无后端 schema，前端继续走 localStorage：

- 学生本地学习进度（progress / taskCheckins / assignedPlans）
- 每周休息日（restWeekday）
- 自测推送偏好（assessmentPush 中 optOut 状态）
- 计划自动调整偏好（planAdjustmentAutomation）
- 草稿与历史（taskAdjustmentDraft / taskAdjustmentHistory）
- 身份证、收货地址（idCard / shippingInfo）
- 入学测评 Token（intakeToken）

未来如需云端持久化，需后端补齐 `/api/students/:id/preferences`、`/api/students/:id/rest-day`、`/api/students/:id/shipping-info` 等接口。

## 3. API 模式门控

- `isApiConfigured()`：`VITE_API_BASE_URL` 任意值或 `import.meta.env.PROD` 即视为已配置
- `apiRequest(path, options)`：
  - 始终 `credentials: 'include'` 走 HttpOnly Cookie
  - 401 自动派发 `shangan:auth-expired` 事件
  - 5xx 自动派发 `shangan:api-error` 事件
  - 默认 15s 超时
  - `Content-Type: application/json` 自动序列化 body

## 4. 数据归一化器

所有服务端返回 → 前端展示统一经过 normalize 函数：

- `normalizeStudentFromServer(raw)`
- `normalizeCourse(raw)`
- `normalizeProduct(raw)`
- `normalizeOrder(raw)`

这些函数将后端 snake_case / camelCase 统一映射到前端原有字段名，避免业务组件因命名改动而崩溃。题库与 AI 配置因暂无后端接口，仍按本地结构使用。

## 5. 仍待补齐的后端接口

### 5.1 AI 监管机器人 / 模型管理（任务 #33，未完成）

当前完全走 localStorage。需后端实现：

- `GET /api/ai/slots` — 列出全部机器人配置（含 model / provider / systemPrompt / restrictionWords）
- `PUT /api/ai/slots/:id` — 更新单条机器人配置
- `POST /api/ai/slots/:id/test` — 探测连通性（仅检查 secretRef 是否存在）

### 5.2 教师数据看板（任务 #34，未完成）

当前为前端本地聚合。需后端实现：

- `GET /api/admin/dashboard?range=7d|30d|90d`
  - 返回：学员活跃数、计划完成率、自测提交分布、订单状态分布、风险学员

### 5.3 对象存储驱动（EXT-03，未完成）

`server/src/storage.js` 已抽象 `put / stat / read / delete / signUrl`，目前只实现 `local` 驱动。需在申请到外部资源后补齐：

- `s3.js` — AWS S3 / 兼容协议
- `oss.js` — 阿里云 OSS
- `cos.js` — 腾讯云 COS

每个驱动导出与 `local.js` 相同的接口；`storage.js` 按 `STORAGE_DRIVER` 环境变量加载。

## 6. 部署后回归清单

部署完成后，建议按以下顺序验证（本轮新增的功能点）：

1. **挂载数据可见**
   - 管理员登录后，学员列表、课程列表、商品列表、订单列表、社区帖子均能从服务端拉取（断网时应回退到空态）
   - 学生登录后，学员列表等管理页不应发请求

2. **写操作生效**
   - 新建学员 → 服务端创建账号 → 临时密码提示
   - 学员档案修改 → 服务端 `PATCH` 成功 → 刷新页面仍生效
   - 创建课程 → 服务端 `POST /api/admin/courses` 成功 → 列表显示新草稿
   - 发布课程 → 学生端能看到（若 `audience` 包含）
   - 创建商品 / 上下架 / 审核订单 三项链路
   - 学员购买 → 创建订单（待审）
   - 学员完成今日任务 → 勾选持久化
   - 学员提交日测 → assessment_records 写入
   - 学员发帖 → 帖子列表可见
   - 教师审核 → 帖子状态变化
   - 教师分配计划 → 学生端计划副本出现
   - 教师分发试卷 → 分享链接 `${origin}/exam/${slug}/?token=${token}&sid=${studentId}` 可访问

3. **审计日志**
   - 设置页「审计日志」可见
   - 筛选按 action / entityType 工作
   - CSV 导出可下载且格式正确

4. **回退路径**
   - 若后端未配置（`VITE_API_BASE_URL` 为空且 `PROD=false`），前端所有写操作回退到 localStorage
   - 挂载拉取不触发，`isApiConfigured()` 仍正确返回 false

## 7. 构建产物

当前 `vite build` 输出：

```
CSS: ~141.95 kB
JS:  ~1.128 MB
```

构建命令：

```bash
npm run build
```

构建结果位于 `dist/`，容器编排由 `docker compose` 拉起 `web` 服务时挂载。

## 8. 与既有部署文档的关系

- `DEPLOYMENT.md` — 通用部署说明（环境变量、Compose、HTTPS、备份）
- `DEPLOYMENT_READINESS_MATRIX.md` — P0/P1/EXT 三级事项表
- `ARCHITECTURE.md` — 数据与 AI 接入契约
- `SUMMARY_ROBOT_SERVICE_CONTRACT.md` — 监管机器人服务契约
- **本文件** — 前端 API 集成进展（本轮新增 11+4+1）

新启动部署时建议同时阅读 `DEPLOYMENT.md` 与本文件。