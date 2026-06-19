# 考研督学系统 · 微信小程序端

## 项目简介

考研督学系统的小程序端项目，采用微信原生 + TypeScript + Vant Weapp 技术栈。

## 目录结构

```
kaoyan-mp/
├── app.ts                # 小程序入口
├── app.json              # 全局配置
├── app.wxss              # 全局样式
├── sitemap.json          # 微信索引配置
├── components/           # 公共组件
├── constants/            # 常量
├── mock/                 # 本地 Mock 数据
├── pages/                # 页面
├── services/             # API 服务层
├── store/                # 全局状态
├── types/                # TypeScript 类型
├── utils/                # 工具函数
├── miniprogram_npm/      # npm 构建产物（Vant Weapp 已预置）
├── package.json
├── project.config.json
├── project.private.config.json
└── tsconfig.json
```

## 开发环境

- Node.js >= 18
- 微信开发者工具

## 开始使用

1. 安装依赖

```bash
npm install
```

2. 打开微信开发者工具，选择「导入项目」

3. 选择本目录：`kaoyan-mp`

4. 填入小程序 AppID（或先使用测试号）

5. 点击「编译」开始调试

> Vant Weapp 已预置到 `miniprogram_npm/`，导入后无需先执行「构建 npm」即可运行。如果后续更新了 Vant 版本或新增了 npm 依赖，请在微信开发者工具中点击「工具」->「构建 npm」。

## 可用脚本

```bash
npm run lint         # 代码检查
npm run lint:fix     # 自动修复代码问题
npm run format       # 格式化代码
npm run typecheck    # TypeScript 类型检查
```

## 注意事项

- `project.private.config.json` 为本地配置，不会提交到 Git
- 当前版本仅搭建项目骨架，业务模块将逐步扩展
- 所有接口走本地 Mock，无需后端服务即可独立开发
- 修改 `mock/data/user.ts` 中的 `CURRENT_MOCK_USER_LEVEL` 可切换免费/体验/付费身份
