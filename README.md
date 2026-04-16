# 研途总控台

围绕"考研规划"主题的全栈学习管理系统，包含 Web 端和微信小程序端。

## 项目概览

一套面向考研辅导场景的在线教学平台，支持三种角色（管理员/教师/学生），覆盖任务规划、课程录播、直播答疑、社区论坛、题库刷题、词汇记忆、资料商城、AI 辅助等完整教学链路。

**技术栈：** Express.js 5 + SQLite (better-sqlite3) + WebSocket + WebRTC + 原生微信小程序

**在线演示：** [xiaoeduhub.online](https://xiaoeduhub.online)

## 目录结构

```
├── src/
│   ├── config.js                 # 环境变量 & 运行时配置
│   ├── db.js                     # SQLite 数据库初始化、迁移、种子数据
│   ├── server.js                 # Express 主服务（路由 + WebSocket + WebRTC 信令）
│   ├── services/
│   │   ├── scheduler.js          # 定时任务（每日任务推送、逾期提醒）
│   │   ├── spacedRepetition.js   # SM-2 间隔重复算法（艾宾浩斯记忆曲线）
│   │   ├── taskService.js        # 任务调度核心逻辑
│   │   └── wxPush.js             # 微信小程序消息推送
│   └── utils/
│       └── sanitize.js           # 输入过滤 & XSS 防护
├── public/
│   ├── admin.html / admin.js     # 管理员后台
│   ├── teacher.html / teacher.js # 教师工作台
│   ├── student.html / student.js # 学生学习台
│   ├── login.js                  # 登录页
│   ├── register.html / register.js # 教师注册
│   ├── forum.html / forum.js     # 论坛社区
│   ├── topic-detail.html / js    # 帖子详情（楼中楼回复）
│   ├── live.html / live.js       # 直播间（WebRTC + 弹幕 + 互动投票）
│   ├── common.js                 # 前端公共工具（fetch、auth、tab 切换）
│   └── styles.css                # 全局样式
├── miniprogram/                  # 微信小程序端（原生开发）
├── templates/                    # Excel/CSV 导入模板
├── deploy/                       # Nginx 配置示例
├── Dockerfile                    # Docker 容器构建
├── docker-compose.yml            # Docker Compose 编排
├── ecosystem.config.cjs          # PM2 进程管理配置
└── package.json
```

## 功能模块

### 管理员后台
- 教师注册审核（批准/拒绝）
- 全平台用户管理（增删改查）
- 批量导入学生/教师账号（Excel/CSV）

### 教师工作台
- **任务规划：** 创建/编辑/删除任务，支持优先级（高/中/低），按学生分配，Excel 批量导入
- **学生管理：** 按学生维度查看任务完成情况，一键发送提醒
- **课程管理：** 网盘式文件夹结构，支持科目分类、子文件夹递归、视频/文件上传
- **直播答疑：** WebRTC 实时音视频推流，WebSocket 聊天，禁言管理
- **题库管理：** 选择题/填空题/判断题/简答题，支持科目、题型、教材、标签多维分类
- **词汇管理：** 闪卡创建（正面/背面/例句/词根/词缀/搭配/音标），Excel 批量导入
- **商城管理：** 商品上下架、库存管理、订单状态流转、虚拟商品自动发货
- **模拟考试：** 创建限时试卷，选择题组卷
- **AI 工具：** AI 辅助生成题目

### 学生学习台
- **今日任务：** 按优先级排序，专注计时器（番茄钟），任务完成打卡
- **考研倒计时：** 自定义考试日期，首页实时显示倒计时天数
- **录播课程：** 网盘式浏览，播放进度自动记忆，课程笔记，评分评价
- **直播答疑：** 实时音视频，弹幕功能，互动投票，直播预约
- **论坛社区：** 发帖/回复/楼中楼嵌套讨论，点赞/赞同/收藏，热门话题排行榜，帖子置顶/精华，话题标签（#话题#），图片九宫格，全文截断展开，用户关注系统，内容举报
- **题库刷题：** 顺序/随机/未做题/错题复习模式，科目+题型+标签筛选，答题卡快速跳题，做题计时，做题报告，题目收藏，做题笔记
- **错题智能复习：** 答错后自动安排 3/7/15 天间隔复习计划
- **模拟考试：** 限时考试，倒计时，交卷统一判分，成绩单报告
- **刷题热力图：** GitHub 风格的年度做题日历
- **随机组卷：** 按科目/标签自动随机组卷
- **词汇记忆：** SM-2 间隔重复算法，翻转/选择题双模式，词根词缀分析，词组搭配，每日目标设置，学习排行榜
- **学习数据统计：** 总览/周报/月报，科目正确率，知识点标签分析，学情报告导出
- **打卡日历：** 学习连续天数（streak），日历视图展示
- **习惯追踪：** 自定义习惯，每日打卡，进度条可视化
- **成就徽章：** 15 个预设成就（连续打卡/做题数/论坛发帖/词汇复习等）
- **资料商城：** 商品浏览，购物车，地址簿管理，拼团购买，虚拟商品自动下载
- **全局搜索：** 搜索帖子/题目/课程，热门搜索推荐，搜索历史
- **通知中心：** 任务提醒/互动消息，未读角标，一键全部已读，浏览器推送
- **AI 智能助手：** AI 答疑、AI 作文批改、AI 学习计划、AI 智能摘要

### 微信小程序端
- 微信一键登录
- 首页任务/提醒/总结
- 课程、论坛、商城、个人中心、直播入口

### 后端核心能力
- **认证：** Session + Bearer Token 双重鉴权，CSRF 防护
- **数据库：** SQLite WAL 模式，自动迁移，每日备份，连接池优化
- **文件上传：** 图片/视频/附件，按模块分目录存储
- **Excel 导入：** 支持 .xlsx/.xls/.csv，UTF-8 / GBK 自动检测
- **定时任务：** node-cron 每日任务推送、逾期提醒、数据库备份
- **安全：** 输入过滤、XSS 防护、密码 bcrypt 加密、登录频率限制、非 root 运行
- **AI 集成：** 可配置外部大模型 API（OpenAI 兼容接口）

## 数据库设计

共 50+ 张数据表，核心包括：

| 模块 | 主要表 |
|------|--------|
| 用户 | `users`, `auth_tokens`, `teacher_applications` |
| 任务 | `tasks`, `task_completions`, `exam_countdown`, `habit_tracking` |
| 课程 | `courses`, `folders`, `folder_items`, `course_progress`, `course_notes`, `course_reviews` |
| 直播 | `live_sessions`, `live_messages`, `live_reservations`, `live_polls`, `live_poll_votes` |
| 论坛 | `forum_topics`, `forum_replies`, `forum_likes`, `forum_favorites`, `forum_endorsements`, `forum_trending`, `content_reports`, `user_follows` |
| 题库 | `questions`, `question_tags`, `question_tag_relations`, `question_notes`, `question_favorites`, `practice_sessions`, `practice_records`, `wrong_review_schedule`, `mock_exams`, `mock_exam_submissions` |
| 词汇 | `flashcards`, `flashcard_records`, `flashcard_goals` |
| 商城 | `products`, `orders`, `shopping_cart`, `address_book`, `product_reviews`, `group_buys`, `group_buy_participants` |
| 系统 | `notifications`, `study_streaks`, `achievements`, `user_achievements`, `search_logs`, `ai_conversations` |

所有表在首次启动时自动创建，新增字段通过 `migrate()` 自动补齐，无需手动执行 SQL。

## 测试账号

| 角色 | 用户名 | 密码 | 说明 |
|------|--------|------|------|
| 管理员 | `admin` | `admin123` | 首次登录需改密 |
| 教师 | `teacher` | `123456` | 首次登录需改密 |
| 学生 | `student1` | `123456` | 张同学 |
| 学生 | `student2` | `123456` | 李同学 |
| 学生 | `student3` | `123456` | 陈同学 |

## 快速开始

### 前置要求

- Node.js >= 18
- npm >= 9

### 本地运行

```bash
# 安装依赖
npm install

# 启动服务
npm start

# 访问
# 首页：http://localhost:3000
# 教师端：http://localhost:3000/teacher
# 学生端：http://localhost:3000/student
# 管理员：http://localhost:3000/admin
# 论坛：http://localhost:3000/forum
```

### Docker 部署

```bash
# 构建并启动
docker compose up -d --build

# 查看日志
docker compose logs -f

# 停止
docker compose down
```

### PM2 部署（生产环境）

```bash
# 安装 PM2
npm install -g pm2

# 启动
npm run pm2:start

# 查看状态
pm2 status

# 查看日志
pm2 logs study-planner

# 停止
npm run pm2:stop
```

## 环境变量

在项目根目录创建 `.env` 文件：

```env
NODE_ENV=production
PORT=3000
SESSION_SECRET=your-secret-key-at-least-32-chars
TOKEN_TTL_DAYS=30
TRUST_PROXY=true
COOKIE_SECURE=true

# 数据库和上传目录
DB_PATH=/app/data/data.sqlite
UPLOAD_DIR=/app/data/uploads

# WebRTC TURN 服务器（可选，提升 NAT 穿透率）
TURN_URL=turn:your-turn-server:3478
TURN_USERNAME=username
TURN_CREDENTIAL=password

# 微信小程序（可选）
WX_APP_ID=your-appid
WX_APP_SECRET=your-secret

# AI 大模型接口（可选，支持 OpenAI 兼容格式）
AI_API_KEY=your-api-key
AI_API_URL=https://api.openai.com/v1/chat/completions
AI_MODEL=gpt-3.5-turbo
```

## Excel 批量导入

项目提供标准化导入模板（`templates/` 目录），支持以下数据类型：

| 模板文件 | 用途 | 关键字段 |
|----------|------|----------|
| `task-import-template.csv` | 批量创建任务 | 学生、任务标题、内容、科目、开始时间、结束时间、周期 |
| `question-import-template.csv` | 批量导入题目 | 标题、科目、题干、选项、正确答案、解析、题型、教材 |
| `flashcard-import-template.csv` | 批量导入闪卡 | 标题、科目、正面内容、背面内容、标签 |
| `user-import-template.csv` | 批量导入用户 | 用户名、密码、角色、姓名、班级 |

支持的文件格式：`.xlsx`、`.xls`、`.csv`（自动识别 UTF-8 / GBK 编码）。

## API 概览

所有 API 以 `/api` 为前缀，需要认证（Cookie Session 或 Bearer Token）。

<details>
<summary>点击展开 API 列表</summary>

### 认证
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/login` | 登录 |
| POST | `/api/auth/logout` | 登出 |
| POST | `/api/auth/register/teacher` | 教师注册申请 |
| GET | `/api/auth/me` | 当前用户信息 |
| POST | `/api/auth/change-password` | 修改密码 |
| POST | `/api/auth/wx-login` | 微信小程序登录 |

### 管理员
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/admin/users` | 用户列表 |
| PUT | `/api/admin/users/:id` | 编辑用户 |
| DELETE | `/api/admin/users/:id` | 删除用户 |
| POST | `/api/users/import` | 批量导入用户 |
| POST | `/api/admin/applications/:id/approve` | 批准教师申请 |
| POST | `/api/admin/applications/:id/reject` | 拒绝教师申请 |

### 任务
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/tasks` | 创建任务 |
| POST | `/api/tasks/import` | 批量导入任务 |
| POST | `/api/tasks/:id/complete` | 完成任务 |
| POST | `/api/tasks/:id/uncomplete` | 取消完成 |
| POST | `/api/tasks/dispatch/daily` | 推送每日任务 |
| POST | `/api/tasks/dispatch/due` | 推送到期提醒 |

### 课程 & 文件
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/folders` | 文件夹列表（支持科目筛选） |
| POST | `/api/folders` | 创建文件夹 |
| POST | `/api/folder-items` | 上传文件/视频 |
| GET | `/api/courses/recent` | 最近观看 |
| GET/POST | `/api/courses/:id/progress` | 播放进度 |
| GET/POST | `/api/courses/:id/notes` | 课程笔记 |
| GET/POST | `/api/courses/:id/reviews` | 课程评价 |

### 直播
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/live-sessions` | 创建直播间 |
| POST | `/api/live-sessions/:id/start` | 开始直播 |
| POST | `/api/live-sessions/:id/end` | 结束直播 |
| POST | `/api/live-sessions/:id/reserve` | 预约直播 |
| POST | `/api/live-sessions/:id/mute` | 禁言用户 |
| POST | `/api/live-sessions/:id/polls` | 创建投票 |
| POST | `/api/live-sessions/:id/polls/vote` | 参与投票 |
| GET | `/api/ice-servers` | WebRTC ICE 配置 |

### 论坛
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/forum/topics` | 帖子列表（支持搜索/排序/标签筛选） |
| POST | `/api/forum/topics` | 发布帖子 |
| GET | `/api/forum/topics/:id` | 帖子详情 |
| POST | `/api/forum/topics/:id/replies` | 回复帖子（支持楼中楼） |
| POST | `/api/forum/topics/:id/like` | 点赞/取消 |
| POST | `/api/forum/topics/:id/favorite` | 收藏/取消 |
| POST | `/api/forum/topics/:id/endorse` | 赞同/取消 |
| POST | `/api/forum/topics/:id/pin` | 置顶/取消 |
| POST | `/api/forum/topics/:id/feature` | 加精/取消 |
| GET | `/api/forum/trending` | 热门话题 |
| GET | `/api/forum/hashtags` | 热门标签 |
| POST | `/api/reports` | 举报内容 |

### 题库 & 练习
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/questions` | 题目列表（支持模式/科目/题型筛选） |
| POST | `/api/questions` | 创建题目 |
| POST | `/api/questions/import` | 批量导入 |
| POST | `/api/questions/:id/answer` | 提交答案 |
| POST | `/api/questions/:id/favorite` | 收藏题目 |
| GET/POST/DELETE | `/api/questions/:id/notes` | 题目笔记 |
| POST | `/api/questions/auto-paper` | 随机组卷 |
| GET | `/api/questions/daily` | 每日推荐 |
| GET | `/api/practice/wrong` | 错题本 |
| GET | `/api/practice/wrong-review` | 错题智能复习 |
| GET | `/api/practice/stats/detailed` | 详细做题统计 |
| GET | `/api/practice/stats/weekly` | 周报 |
| GET | `/api/practice/stats/monthly` | 月报 |
| GET | `/api/practice/heatmap` | 做题热力图 |

### 模拟考试
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/mock-exams` | 考试列表 |
| POST | `/api/mock-exams` | 创建考试 |
| POST | `/api/mock-exams/:id/start` | 开始考试 |
| POST | `/api/mock-exams/:id/submit` | 提交试卷 |
| GET | `/api/mock-exams/:id/result` | 查看成绩 |

### 词汇记忆
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/flashcards` | 闪卡列表（支持科目筛选） |
| POST | `/api/flashcards` | 创建闪卡 |
| GET | `/api/flashcards/due` | 今日待复习 |
| POST | `/api/flashcards/:id/review` | 提交复习评分 |
| GET/POST | `/api/flashcards/goal` | 每日目标 |
| GET | `/api/flashcards/leaderboard` | 学习排行榜 |

### 商城 & 订单
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/products` | 创建商品 |
| GET | `/api/products/recommended` | 推荐商品 |
| GET | `/api/cart` | 购物车 |
| POST | `/api/cart` | 加入购物车 |
| POST | `/api/cart/checkout` | 结算下单 |
| POST | `/api/orders` | 直接下单 |
| POST | `/api/orders/:id/confirm` | 确认收货 |
| POST | `/api/orders/:id/download` | 虚拟商品下载 |
| GET/POST | `/api/products/:id/reviews` | 商品评价 |
| GET/POST/DELETE | `/api/addresses` | 地址管理 |
| POST | `/api/group-buys` | 发起拼团 |
| POST | `/api/group-buys/:id/join` | 参与拼团 |

### 用户 & 社交
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/users/:id/follow` | 关注/取关 |
| GET | `/api/users/:id/follow-status` | 关注状态 |
| GET | `/api/study/streak` | 学习连续天数 |

### 学习数据 & 成就
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/achievements` | 成就列表 |
| POST | `/api/achievements/unlock` | 手动解锁 |
| GET | `/api/exam-countdown` | 考研倒计时 |
| POST | `/api/exam-countdown` | 设置倒计时 |
| GET | `/api/habits` | 习惯列表 |
| POST | `/api/habits` | 创建习惯 |
| POST | `/api/habits/:id/check` | 打卡 |

### AI 智能功能
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/ai/tutor` | AI 答疑 |
| POST | `/api/ai/essay-grade` | AI 作文批改 |
| POST | `/api/ai/study-plan` | AI 学习计划 |
| POST | `/api/ai/generate-questions` | AI 生成题目 |
| POST | `/api/ai/summary` | AI 智能摘要 |

### 搜索 & 通知
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/search` | 全局搜索 |
| GET | `/api/search/hot` | 热门搜索 |
| POST | `/api/notifications/:id/read` | 标记已读 |
| POST | `/api/notifications/read-all` | 全部已读 |
| GET | `/api/notifications/unread-count` | 未读数量 |
| GET | `/api/templates/:type` | 下载导入模板 |

</details>

## 微信小程序

原生微信小程序代码位于 `miniprogram/` 目录。

1. 打开微信开发者工具，导入 `miniprogram/` 目录
2. 在 `project.config.json` 中将 `appid` 替换为你的小程序 AppID
3. 在 `.env` 中配置 `WX_APP_ID` 和 `WX_APP_SECRET`
4. 小程序仅支持学生端功能，教师/管理端通过 Web 访问

## Nginx 反向代理示例

参考 `deploy/nginx.study-planner.conf`，关键配置：

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket
    location /ws {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

## 健康检查

```bash
curl http://localhost:3000/healthz
# 返回: {"ok":true,"env":"production","time":"..."}
```

Docker 内置健康检查（每 30 秒一次）：

```
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget --spider http://localhost:3000/healthz || exit 1
```

## 安全特性

- 密码 bcrypt 加密（salt rounds = 10）
- Session + Bearer Token 双重认证
- CSRF 防护（Origin/Referer 校验）
- 输入过滤 & XSS 防护（`sanitize.js`）
- 登录频率限制
- 文件上传路径鉴权
- Docker 非 root 用户运行
- HTTPS Cookie（`COOKIE_SECURE=true`）
- SQLite WAL 模式 + 定期 checkpoint
- 数据库每日自动备份（保留 7 天）

## License

MIT

