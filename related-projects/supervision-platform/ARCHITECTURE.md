# 上岸平台数据与 AI 接入契约（第一版）

本文件是前端原型对接后端、题库工具、背单词工具和大模型服务的统一约定。系统采用学生端和教师端共享同一身份、权益、学习事件与审计底座的方式演进。

## 1. 角色与认证

系统固定三类角色：`student`、`manager`、`super_admin`。学生通过账号密码注册和登录；管理人员与超级管理人员只能由超级管理人员创建。第一期不接入短信或微信登录，但认证服务应使用 `identity_provider` 适配器，以便后续新增 `phone_otp`、`wechat_web` 等登录方式。

会话使用服务端安全 Cookie 或短期 access token + 轮换 refresh token。密码使用 Argon2id 哈希保存；管理账号必须支持强制重置密码、登录审计和可选的双因素认证。前端不能保存模型密钥、对象存储密钥、支付密钥或永久登录凭证。

权限建议：管理人员可管理课程、学员、计划、题库、社区审核和查看 AI 结果；超级管理人员额外管理账号权限、系统设置、模型供应商、知识库策略、支付收款码和审计记录。

## 2. 核心实体

`users` 保存身份和基础账户；`student_profiles` 保存考研年份、目标院校、专业、基础情况和学习偏好。`roles`、`user_roles` 保存角色关系；`auth_sessions` 与 `audit_logs` 保存会话和敏感操作审计。

`courses`、`course_categories`、`course_sections`、`media_assets` 保存录播课程。课程使用两层目录：固定一级 `audience` 为 `公开课`、`政治`、`英语`、`数学` 或 `专业课`，二级 `category` 由教师在对应一级目录下维护，例如英语的“语法、阅读、七选五、作文、单词”和政治的“基础、提高”。学生端只展示自己已报名科目的已发布课程，`公开课` 对所有学生可见；二级分类只负责课程归档与展示，不改变报名访问控制。旧版未分类且已发布课程迁移时按 `公开课` 兼容，并在显示层标为“未分类”。已被课程使用的二级分类不得删除；课程删除或转为草稿后，学生端立即移除。视频不直接暴露源地址，而是由服务端按课程权益签发短期播放地址。`products`、`product_items`、`orders`、`payments`、`entitlements` 保存单科、套餐、订单、人工确认支付和访问权益。第一期通过全局 `free_access_enabled=true` 开放课程，但仍创建商品与订单结构，支付改造时不迁移业务数据。

`plan_templates`、`plan_template_versions`、`student_plans`、`plan_tasks`、`task_completions` 保存计划。学生添加通用计划时必须从已发布版本创建自己的计划副本；后续编辑模板只产生新版本，不回写已有学生计划。一对一计划调整只写入对应 `student_plan` 或附加任务，永不修改模板。

`question_banks`、`questions`、`question_versions`、`exams`、`exam_items`、`attempts`、`answers`、`mistake_records` 保存题库、自测、答案和错题。所有 AI 生成题目先处于 `draft` 状态，需老师审核后才能发布。

`posts`、`post_moderation_jobs`、`post_reviews` 保存社区与审核结论。AI 预审只产生风险标签、置信度与依据，最终公开状态由管理人员决定。

## 3. 学习事件与工具接入

所有学生操作统一写入 `learning_events`。事件至少含 `event_id`、`student_id`、`tool_id`、`event_type`、`occurred_at`、`subject`、`knowledge_tags`、`payload` 和 `schema_version`。核心事件包括 `video_started`、`video_completed`、`task_completed`、`question_answered`、`exam_submitted`、`word_reviewed`、`tool_session_completed`。

未来每个小工具都需要注册到 `learning_tools`，并声明名称、版本、支持的事件、所需权限、数据保留策略和回调地址。工具只通过受限服务令牌写入自己的事件类型，不能直接读取或修改其他工具的原始数据。平台的学习画像服务把事件转化为统一指标，例如学习时长、计划完成率、知识点掌握度、错题频次与连续学习天数。

## 4. AI 能力层

AI 请求不由网页直接调用模型，而是由后端 `ai-orchestrator` 统一编排。该服务包含模型供应商适配器、提示词版本、权限检查、知识库检索、工具调用、速率限制、脱敏、成本统计、失败重试和审计。

### 4.1 监管机器人（教师端独立入口）

业务 AI 本质都是「监管机器人」：既要接第三方大模型，也要自定义系统提示词与限制词。教师端侧栏一级入口 **「监管机器人」** 维护全部用途；**系统设置**只保留账号/权限/认证，不再内嵌模型槽位。

不要用一个多模态大模型包办所有事。接入的是**第三方模型 API**（通义 / 智谱 / DeepSeek / OpenAI 兼容 / 自建等），不是平台官方内置模型。每台机器人保存：`provider`、`model`、`endpoint`、`secretRef`（服务端环境变量名）、`enabled`、`systemPrompt`、`restrictionWords[]`。真实 API Key 只存在服务器环境 / 密钥管理服务，不进浏览器、不进前端 localStorage。可随时开/关：关闭后业务入口显示未就绪，配置仍保留。

交互：列表按模态分组展示机器人卡片 → 点击进入**子详情页**配置模型、提示词、限制词 → 保存后返回列表。`isAiSlotReady` 仍以 `enabled + model + secretRef` 判定业务就绪。

当前监管机器人：

| 机器人 id | 名称 | 模态 | 用途 |
| --- | --- | --- | --- |
| `periodic_assessment` | 自测出题机器人 | 纯文本 | 按学员计划生成单词 + 阅读真题句子翻译 |
| `entrance_grading` | 入学批改机器人 | 纯文本 | 入学摸底错题解析与学情建议 |
| `plan_assistant` | 计划助手机器人 | 纯文本 | 任务增补/减量/顺延草案 |
| `learning_report` | 学情诊断机器人 | 纯文本 | 学情诊断与跟进建议 |
| `community_moderation` | 社区预审机器人 | 纯文本 | 帖子风险标签与相关性预审 |
| `document_ocr` | 资料读图机器人 | 读图 | 计划表截图、作业照片文字识别 |
| `handwriting_grade` | 手写批改机器人 | 读图 | 手写翻译/解答照片识别后交文本批改 |
| `question_tutor` | 难题讲解机器人 | 读图 | 学生上传题目图片 → 识别题干并输出分步详解 |
| `embedding` | 知识库向量机器人 | 向量 | 讲义/真题切块 embedding |

学生端只消费业务结果（题目、分数、建议），看不到机器人配置页。部署时服务端按 `job_type` 选择对应机器人配置，注入 `systemPrompt` 与限制词策略后再请求供应商。

`question_tutor` 必须接入**能读图的第三方多模态/VL 模型**（通义 VL、智谱 VL、OpenAI 兼容多模态等）。DeepSeek 官方 Chat/Flash 为纯文本，不能单独接收图片；若要用 DeepSeek 写详解，应走「OCR 机器人识题 + DeepSeek 文本逐步讲解」双机编排。前端原型在机器人未就绪时拦截提交；就绪后先展示结构化分步草案，真实请求由服务端 `ai-orchestrator` 完成，密钥仅存服务端环境变量。

### 4.2 日/周/月自测开通规则

每位学员的 `assessmentPush` 含分项开关：`daily` / `weekly` / `monthly`（总开关 `enabled` 由三者派生）。付费学员（`status === '付费'`）默认三项全开；教师可单项关闭或全部停止。手动关闭后写 `optedOut=true`，不再因付费身份自动重开。体验/新人/测试账号需手动开通。题型按报名学科过滤：英语保留日/周/月的单词与阅读翻译；政治仅日推 5 个选择题，不参与周测/月测；数学日推 5 个公式 + 1 个积分计算题、周测 10 个计算题、月测按本周数学学习内容推送 20 个计算题。各学科在同一学习日可独立出现；同一学科的命中优先级为月测 > 周测 > 日测，未开通的类型不参与推送。

### 4.3 学员每周休息日

每位学员可自选一周中的一天作为休息日，字段为 `restWeekday`（`0`–`6`，与 `Date.getDay()` 一致：0=周日，1=周一…6=周六；**默认 / 未设置 / 取消后均为 `null`，不默认周六**）。设置时写入 `restWeekdaySetAt`（ISO 时间）；取消时两者同时清空。

**生效规则（须提前一天）：** 仅当「当日星期 === restWeekday」且 `restWeekdaySetAt` 的时间戳 **早于当日本地 00:00** 时，`isRestDayToday` 才为 true。当天临时改选休息日 → 当天仍正常推送；从下一个对应星期起才休息。缺少 `restWeekdaySetAt` 的旧数据视为未生效。

生效当日：
- 学生首页与「学习计划 · 今日」不再推送任何学习规划任务；
- 日/周/月自测当日也不推送；
- 页面只展示固定问候：「休息愉快，好好休息。」
- 学生仍可改选或取消休息日；**取消后立即恢复正常推送**。

休息日不改写个人学习日计数与计划副本内容，仅暂停当日推送。

### 4.3.1 任务推送与完成推进

学生端「今日任务」按 **完成进度** 推进，而非固定日历第 1 天：

- 每个解锁计划取「第一个未全部完成的行」作为当前活跃行（`getPlanActiveRowIndex`）。
- **未完成项**：次日继续出现在今日待办（同一 `rowIndex` + 未勾选项）。
- **已完成项**：行内可独立勾选（`taskDone[]`）；整行全部完成后，才推进到下一行新任务。
- 例：某政治阶段行有 5 个分项，4 完成 1 未完成 → 次日仍推送该行（含未完成项）；全部 5 项完成后，再推后续新行。
- 前置计划全部完成后才解锁后继计划；长期/阶段属性与教师端编排仍生效。
- 未来 7 天视图从活跃行起向后展开相对第 2…7 天。

### 4.4 难题逐步讲解（学生上传图片）

入口：学生端「学习工具 → 难题逐步讲解」。学生选择科目、上传题目截图/照片（可选补充说明），系统按 `question_tutor` 槽位生成分步详解。输出结构固定为：审题 → 定位考点与方法 → 分步推导/作答 → 最终答案 → 易错点与复查。不在浏览器保存或发送真实 API Key；`ai_jobs.job_type` 建议使用 `question_tutor`，并保留图片对象存储引用与识别文本快照。

### 4.5 自测档案与「测完不结束」

- **入学自测**：学生刚入学的摸底试卷（题库三套）。测完后成绩、答案、错题与 AI 反馈**归档**，作为学情基线；**不是**测完就结束跟踪。
- **学员管理中的「自测」**（原「入学自测」入口）：统一展示入学摸底 + 日测/周测/月测的成绩与答案汇总。日周月结果写入学员 `assessmentRecords[]`（`type`: daily/weekly/monthly，含 score、wrongQuestions、answers 快照等）。
- 题库页仍可保留「入学自测」试卷管理命名；学员档案侧简称「自测」以免与开通面板混淆。

### 4.6 未来 30 天 · AI 学习智能检测

教师在学员详情设定基础任务后，**完整任务表不被 AI 自动改写**。展开「未来 30 天」时，任务列表**末尾**展示 AI 智能检测：

- 已学知识点的**间隔回顾**（如 3–7 天后提醒回看）；
- 未完成 / 拖欠任务的节奏提醒；
- 自测错题驱动的**薄弱回炉**。

前端原型用规则草案生成建议；上线后由 `plan_assistant` / `learning_report` 槽位刷新。学生端「未来 30 天」视图同样可挂载只读建议（后续）。

每次 AI 任务写入 `ai_jobs`：`job_type`、`student_id`、`requested_by`、`input_snapshot_id`、`provider`、`model`、`prompt_version`、`status`、`output`、`review_status`、`created_at`。系统应保存用于结论的指标快照，而不只保存自然语言结果。老师修改或批准建议后，保存 `human_review` 及修改原因。

第一期能力包括：基于学生画像生成计划草案、生成学情诊断、生成受范围限制的自测草案、辅助主观题批改草案和社区内容预审。所有会影响学习计划、考试结果、内容公开或用户权益的 AI 输出都必须经过规则校验与人工确认，不允许模型直接生效。

知识库采用 `knowledge_documents`、`document_chunks`、`embeddings` 管理。支持资料上传、解析、切块、版本、来源、可见范围和删除。只把有授权范围的资料发送给对应任务，不能默认启用联网检索。

## 5. API 轮廓

认证：`POST /api/auth/register`、`POST /api/auth/login`、`POST /api/auth/refresh`、`POST /api/auth/logout`。管理人员账号由 `POST /api/admin/users` 创建。

学生：`GET /api/me/dashboard`、`GET /api/courses`、`POST /api/course-sections/:id/playback-token`、`GET /api/plans`、`POST /api/plan-templates/:id/apply`、`PATCH /api/tasks/:id/completion`、`POST /api/attempts`、`POST /api/posts`、`POST /api/ai/jobs`。

教师：`GET /api/admin/dashboard`、`GET /api/admin/students`、`POST /api/admin/courses`、`POST /api/admin/media/upload-ticket`、`POST /api/admin/plan-templates`、`POST /api/admin/questions/import`、`POST /api/admin/ai/reviews/:id/approve`、`POST /api/admin/posts/:id/review`、`POST /api/admin/payment-qr`。

所有写操作带幂等键、操作者 ID 与审计日志。导入、媒体转码、文档解析、向量化、AI 任务和报告生成进入队列异步处理，并返回任务状态。
