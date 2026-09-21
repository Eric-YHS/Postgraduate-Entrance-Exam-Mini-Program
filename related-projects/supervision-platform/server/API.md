# API Contract

All authenticated browser requests use the HttpOnly `session` cookie and must send `credentials: 'include'`. API errors use `{ "error": "...", "requestId": "..." }`; every response includes the `X-Request-Id` header. In production, `APP_ORIGIN` is required and must be an HTTPS origin.

## Idempotent write requests

For protected create/review operations, clients should provide an `Idempotency-Key` request header containing 8–200 URL-safe characters. The browser API client generates one for non-GET/HEAD requests unless the caller supplies one. Keys are scoped to the authenticated principal: reusing the same key with the same method, URL and body by the same principal returns the original completed response; reusing it for a different request, or while the original request is still processing, returns `409`. Current server coverage includes course/product creation, order creation/review, question/paper creation, exam distribution, student-plan creation, assessment submission, community posting and moderation. The key is a retry safeguard, not an authorization bypass; all normal permission checks still apply.

## Public and authentication

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/health` | public | Process health check |
| GET | `/ready` | public | PostgreSQL readiness check |
| POST | `/api/auth/login` | public | Log in and issue session cookie |
| POST | `/api/auth/register` | public | Register a student account |
| POST | `/api/auth/logout` | signed in | Clear session cookie |
| GET | `/api/auth/me` | signed in | Read session identity |
| POST | `/api/auth/change-password` | signed in | Change password |

## Registrations and student archives

| Method | Path | Permission | Purpose |
|---|---|---|---|
| POST | `/api/public/registrations` | public | Submit registration application |
| GET | `/api/registrations` | admin/teacher/assistant/operator | Read registration queue |
| POST | `/api/registrations/:id/import` | admin/teacher | Import application into an archive |
| GET | `/api/students` | admin/teacher/assistant/operator | List student DTOs |
| GET | `/api/students/:id` | staff or student owner | Read one student DTO |
| PATCH | `/api/students/:id` | staff or student owner | Update student archive; students may only change name, email, shippingInfo, school, targetScore |
| GET | `/api/students/:id/preferences` | staff or student owner | Read enrolled subjects and learning preferences |
| PATCH | `/api/students/:id/preferences` | student owner, admin, or teacher | Update enrolled subjects, weekly rest day, or assessment push preferences; staff changes are audited |
| GET | `/api/students/:id/entitlements` | staff or student owner | Read active and historic entitlements |
| POST | `/api/admin/students` | admin or teacher | Atomically create one student account, student profile, enrolled subjects, and a one-time temporary password; returned password is shown once |
| POST | `/api/admin/students/import` | admin or teacher | Atomically create 1–1000 student accounts from normalized rows; duplicate or invalid rows roll back the whole batch and each temporary password is returned once |
| GET | `/api/admin/accounts` | admin | List accounts and bind student DTOs |
| POST | `/api/admin/accounts` | admin | Create a teacher/assistant/operator/student account |
| PATCH | `/api/admin/accounts/:id` | admin | Update account status, name, password, mustChangePassword, or request a server-generated one-time reset password |
| DELETE | `/api/admin/accounts/:id` | admin | Delete an account; cannot delete the currently signed-in account |
| GET | `/api/admin/audit-logs` | admin | Read paginated audit logs for compliance |

Staff PATCH fields are `name`, `year`, `status`, `email`, `shippingInfo`, `school`, `targetScore`, `stage`, `evaluation`, and `paidUntil`. All PATCH requests reject unknown fields and require at least one field. Student DTO keys use camelCase, including `accountId`, `shippingInfo`, `targetScore`, `paidUntil`, `createdAt`, and `updatedAt`.

## AI registry and jobs

These endpoints define auditable configuration and job records only. They do not accept provider API keys, invoke an external model, or permit an AI result to change orders, entitlements, final grades, publication state, or community review state.

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/api/admin/ai/robots` | admin/teacher | List server-side robot registry entries without secrets |
| PUT | `/api/admin/ai/robots/:id` | admin | Create or update robot capability, Provider reference, prompt, restriction words, allowed-tool list, and human-approval rule |
| POST | `/api/ai/jobs` | admin/teacher/student | Create a bounded AI job record; students may only bind their own student ID. A robot must be enabled and refer to an externally configured Provider before a job may be queued. |

A configured robot is not evidence that model inference is connected. Until a separate server-side Provider executor, secret reference resolver, structured-output validator, cost collector, timeout/retry policy, and approval-to-execution flow are implemented and verified, jobs remain `queued` or `awaiting_approval` and are not executed.

## AI Provider、机器人与任务

| 方法 | 路径 | 权限 | 目的 |
|---|---|---|---|
| GET | `/api/admin/ai/providers` | admin | 读取 Provider 元数据；不返回密钥 |
| PUT | `/api/admin/ai/providers/:id` | admin | 保存 Provider 地址、能力、secretRef 和超时策略；不接收 API Key |
| POST | `/api/admin/ai/providers/:id/test` | admin | 服务端读取 secretRef 对应环境变量并测试 `/models`；只返回脱敏诊断 |
| GET | `/api/admin/ai/robots` | admin/teacher | 读取监管机器人配置 |
| PUT | `/api/admin/ai/robots/:id` | admin | 保存机器人并校验 Provider 能力和启用状态 |
| POST | `/api/ai/jobs` | admin/teacher/student | 创建有界 AI 任务；当前只进入队列或待审批，不执行模型 |
| GET | `/api/ai/jobs/:id` | 创建者/教师/admin | 查询任务状态和脱敏结果 |
| POST | `/api/admin/ai/jobs/:id/approve` | admin/teacher | 将待审批任务转为 queued |
| POST | `/api/ai/jobs/:id/cancel` | 创建者/教师/admin | 取消 queued 或 awaiting_approval 任务 |

Provider 的 `secretRef` 只作为服务端环境变量名或密钥管理引用。浏览器不得提交、保存或读取 API Key。Provider 测试不回显密钥、请求头或完整敏感 URL。真实模型 Worker、重试队列、结构化输出校验和成本结算尚未接入。

## 课程资源与本地存储

当前 `course_assets` 已有元数据和迁移基础，但课程资源上传、签名访问和云对象存储适配仍需单独完成；在资源接口未部署前，前端不得把浏览器 Blob URL 当作持久资源。


| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/api/courses` | signed in | List visible courses |
| POST | `/api/admin/courses` | admin/teacher | Create course |
| PATCH | `/api/admin/courses/:id` | admin/teacher | Update course |
| POST | `/api/admin/courses/:id/publish` | admin/teacher | Publish or remove course |
| GET | `/api/products` | signed in | List products visible to caller |
| POST | `/api/admin/products` | admin/teacher | Create product |
| PATCH | `/api/admin/products/:id` | admin/teacher | Update product |
| POST | `/api/admin/products/:id/state` | admin/teacher | Set product state |
| POST | `/api/orders` | student | Claim free item or create manually reviewed order |
| GET | `/api/orders` | signed in | Read own orders or all orders for staff |
| POST | `/api/admin/orders/:id/review` | admin/teacher | Approve or reject pending order |

## Companion study

The companion-study bank is independent from knowledge-base materials, entrance questions, periodic assessments, and wrong-question archives. It may only be populated through the staff contract below; there is no implicit merging or reuse path.

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/api/admin/companion-study/books` | admin/teacher | List all independent companion-study books and counts |
| GET | `/api/admin/companion-study/books/:id/questions` | admin/teacher | Read full question configuration, including answers and analysis |
| POST | `/api/admin/companion-study/books/import` | admin/teacher | Transactionally upsert one book and up to 10,000 questions; idempotent and audited |
| PATCH | `/api/admin/companion-study/books/:id` | admin/teacher | Update book metadata and state |
| PATCH | `/api/admin/companion-study/questions/:id` | admin/teacher | Update a question's duration, staged hints, answer, analysis, or state |
| GET | `/api/companion-study/books` | student | List only published books matching the student's enrolled subjects |
| GET | `/api/companion-study/books/:id/questions` | student | List only published question IDs, numbers, stems, and configured base duration |
| POST | `/api/companion-study/questions/:id/sessions` | student | Start a server-timed session with `基础` (2x), `适中` (1.5x), or `合适` (1x) speed mode |
| GET | `/api/companion-study/sessions/:id` | session owner | Read authoritative remaining time and currently unlocked staged content |
| PATCH | `/api/companion-study/sessions/:id` | session owner | `{ "action": "提前结束" }`; persist completion and unlock answer/analysis |

Student book and question-list payloads never expose `knowledgePoint`, `halfHint`, `answer`, or `analysis`. Session reads unlock the knowledge point only in the final 600 seconds, the half hint at 50% elapsed time, and answer/analysis only on expiry or after persisted early finish.

## Entrance assessments

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/api/admin/entrance/questions` | admin/teacher | List question bank |
| POST | `/api/admin/entrance/questions` | admin/teacher | Create question |
| PATCH | `/api/admin/entrance/questions/:id` | admin/teacher | Update question |
| GET | `/api/admin/entrance/papers` | admin/teacher | List papers |
| POST | `/api/admin/entrance/papers` | admin/teacher | Create or replace paper and snapshots |
| GET | `/api/admin/entrance/papers/:id` | admin/teacher | Read paper and snapshots |
| POST | `/api/exams/distributions` | admin/teacher | Distribute published paper and return share token |
| GET | `/api/exams/:paperId/:token` | public token | Resolve exam link and issue exam-session cookie |
| POST | `/api/exams/distributions/:id/start` | exam-session cookie | Start one timed attempt |
| POST | `/api/exams/distributions/:id/submit` | exam-session cookie | Submit answers; objective questions are scored server-side |

## Plans, assessments, community

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/api/students/:id/plans` | staff or student owner | Read plans and completions; plan records expose `start_day` (task-table starting position) and optional `start_date` (calendar unlock date) |
| POST | `/api/students/:id/plans` | admin/teacher | Create student plan; `startDay` remains the task-table starting position and optional `startDate` is a `YYYY-MM-DD` date that unlocks on that date |
| PATCH | `/api/students/:id/plans/:planId` | admin/teacher | Replace one student plan with optimistic `revision` conflict protection |
| DELETE | `/api/students/:id/plans/:planId` | admin/teacher | Delete one student plan; optional `revision` prevents deleting a newer version |
| PATCH | `/api/students/:id/plans/:planId/start-date` | admin/teacher | Set or clear one task combination's calendar unlock date; changes are audited |
| GET | `/api/students/:id/plans/:planId/progress` | staff or student owner | Read task totals and persisted completion progress |
| GET | `/api/students/:id/wrong-questions` | staff or student owner | Read archived wrong questions by optional subject/status |
| POST | `/api/students/:id/wrong-questions` | student owner | Manually archive a student-marked question; duplicate source snapshots reuse the existing archive row |
| PATCH | `/api/students/:id/wrong-questions/:wrongId` | student owner/admin/teacher | Update archive review status |
| POST | `/api/students/:id/wrong-questions/:wrongId/review` | student owner | Record a review event and increment archive review count |
| POST | `/api/plans/:id/tasks/:rowIndex/:taskIndex/complete` | plan owner | Mark task complete; server rejects a request before the plan's `start_date` in Asia/Shanghai |
| DELETE | `/api/plans/:id/tasks/:rowIndex/:taskIndex/complete` | plan owner | Undo task completion; server rejects changes before the plan's `start_date` in Asia/Shanghai |
| GET | `/api/students/:id/assessments` | staff or student owner | Read assessment archive |
| POST | `/api/students/:id/assessments` | student owner | Add self-assessment |
| GET | `/api/posts` | signed in | Read public posts and own pending posts |
| POST | `/api/posts` | signed in | Submit community post |
| POST | `/api/admin/posts/:id/review` | admin/teacher/assistant | Publish or reject post |
