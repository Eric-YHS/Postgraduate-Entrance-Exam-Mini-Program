# 考研督学系统 · 微信小程序端

## 项目定位

本目录 `miniprogram/` 是「考研督学系统」的微信小程序端实现，采用微信原生框架 + TypeScript + Vant Weapp 技术栈。它是父仓库 `Postgraduate-Entrance-Exam-Mini-Program` 的一个子目录，与后端服务（`src/`、`public/` 等）共同组成完整项目。

## 已完成模块

当前已实现《开发任务 A：内容与交互完善》中除 A-10 直播外的全部内容：

| 任务 | 说明 |
|------|------|
| A-01 | 英语单词题型（音标、例句、词根、词缀、动态干扰项） |
| A-02 | 数学公式匹配题型（公式图片占位组件 `formula-renderer`） |
| A-03 | 错题本「已掌握」移除 |
| A-04 | 历年真题元数据扩展（年份/试卷/难度筛选与标签展示） |
| A-05 | 论坛楼中楼回复 |
| A-06 | 图片/视频/附件上传（`utils/upload.ts`、`media-uploader`） |
| A-07 | 论坛收藏 |
| A-08 | 热门话题标签 |
| A-09 | 论坛 AI 自动审核（本地敏感词 Trie + `auditStatus` 预留） |
| A-11 | 课程章节制管理 |
| A-12 | 课程免费开放（全部视频可直接学习） |
| A-13 | 课程分类公共课/专业课分栏 |

> A-10（直播）不在当前规划内。

## 目录结构

```
miniprogram/
├── app.ts                      # 小程序入口
├── app.json                    # 全局页面/TabBar/配置
├── app.wxss                    # 全局样式与 CSS 变量
├── sitemap.json                # 微信索引配置
├── project.config.json         # 微信开发者工具项目配置
├── project.private.config.json # 本地私有配置（不提交）
├── components/                 # 公共组件与业务组件
│   ├── course-chapter-list/    # 课程章节列表
│   ├── formula-renderer/       # 公式图片渲染
│   ├── forum-reply-tree/       # 论坛回复树
│   ├── ky-loading/             # 加载、空态、错误、安全区组件
│   ├── media-uploader/         # 图片/视频/附件上传
│   └── question-filter/        # 真题筛选面板
├── constants/                  # 业务常量
├── mock/                       # 本地 Mock 数据与处理器
├── pages/                      # 页面
│   ├── course/                 # 课程列表/详情/播放
│   ├── forum/                  # 论坛首页/详情/发帖
│   ├── index/                  # 首页
│   ├── question/               # 刷题/错题本
│   └── user/                   # 用户中心
├── services/                   # API 封装（基于 utils/request）
├── store/                      # 全局状态（用户态）
├── types/                      # TypeScript 类型定义
├── utils/                      # 工具函数
│   ├── content-audit.ts        # 内容审核
│   ├── course.ts               # 课程/视频辅助
│   ├── permission.ts           # 功能开放状态
│   ├── upload.ts               # 媒体上传
│   └── wrong-book.ts           # 错题本本地存储
├── miniprogram_npm/            # npm 构建产物（Vant Weapp）
├── package.json
├── tsconfig.json
└── .eslintrc.js / .prettierrc  # 代码规范
```

## 开发环境

- Node.js >= 18
- 微信开发者工具（建议最新稳定版）
- Git

## 本地启动

1. 在父仓库根目录执行

```bash
cd miniprogram
npm install
```

2. 打开「微信开发者工具」->「导入项目」

3. 选择本目录 `miniprogram/`

4. 填入小程序 AppID，或使用测试号

5. 点击「编译」开始调试

> `miniprogram_npm/` 已预置 Vant Weapp，导入后通常无需先「构建 npm」。若新增/升级 npm 依赖，请在微信开发者工具中点击「工具」->「构建 npm」。

## Mock 说明

- 当前接口默认走本地 Mock（`mock/handlers/`）
- `mock/data/user.ts` 默认提供免费开放身份
- 切换为真实后端时，在 `utils/request.ts` 中调整 `USE_MOCK` 或 `BASE_URL` 即可

## 在线课程资质开关

当前发布状态为 `restricted`：只隐藏在线课程列表、课程详情和视频播放链路；题库、错题本、论坛、个人中心等其它功能继续开放。当前已开放功能全部免费，不设购买或会员入口。

课程源码仍保留在 `pages/course/`，发布模式清单保留在 `scripts/manifests/`。获得在线教育相关资质后，可一键恢复：

```bash
npm run mode:qualified
npm run verify:release
```

需要重新隐藏课程时执行：

```bash
npm run mode:restricted
npm run verify:release
```

`npm run upload` 会先执行发布模式校验，防止误把课程页或后台音频能力上传到资质受限版本，也会防止题库、论坛、个人中心等应保留页面被误隐藏。

## 代码规范

提交前必须执行：

```bash
npm run typecheck    # TypeScript 类型检查
npm run lint         # ESLint 检查
npm run lint:fix     # 自动修复可修复的问题
npm run format       # Prettier 格式化（如配置）
```

两者均通过后再推送。

## 协作与推送流程

本目录位于父仓库 `Postgraduate-Entrance-Exam-Mini-Program` 的 `main` 分支中。请按以下流程协作：

### 1. 克隆父仓库

```bash
git clone git@github.com:Eric-YHS/Postgraduate-Entrance-Exam-Mini-Program.git
cd Postgraduate-Entrance-Exam-Mini-Program
```

### 2. 创建功能分支

不要直接在 `main` 分支上开发：

```bash
git checkout -b feature/your-module-name
```

### 3. 在 `miniprogram/` 下开发

所有小程序端改动都在 `miniprogram/` 目录内完成。

### 4. 提交前检查

```bash
cd miniprogram
npm run typecheck
npm run lint
```

### 5. 提交并推送到远程

```bash
cd ..
git add miniprogram/
git commit -m "feat: 你的改动描述"
git push origin feature/your-module-name
```

### 6. 发起 Pull Request

在 GitHub 上从 `feature/your-module-name` 向 `main` 发起 PR，由仓库所有者或协作者 Review 后合并。

## 后端对接约定

- 接口路径统一在 `services/api-types.ts` 中维护
- 类型定义在 `types/*.ts` 中维护
- Mock 处理器在 `mock/handlers/*.handler.ts` 中实现，结构与真实接口保持一致
- 切换真实后端时，优先保证字段名、请求/响应结构与 Mock 一致，以减少前端改动

## 注意事项

- `project.private.config.json` 为本地私有配置，已加入 `.gitignore`，不要提交
- 提交前务必跑 `typecheck` + `lint`
- 修改公共组件或公共类型时，注意检查所有引用页面是否受影响
- 上传类功能依赖微信小程序 API，真机调试时需配置合法域名或使用开发者工具「不校验合法域名」
- 当前所有学习功能均免费开放，新增功能应保持一致

## 联系人

如有疑问，请在父仓库提交 Issue 或在项目共创群中沟通。
