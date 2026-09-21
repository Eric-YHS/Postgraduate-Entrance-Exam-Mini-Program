# 研伴 AI 本地原型

## 启动

1. 生产环境通过进程或容器环境注入模型服务配置（不要把真实密钥提交到项目目录）。本地开发如需读取项目根目录 `.env`，必须显式设置 `YANBAN_LOAD_ENV_FILE=1`；服务端默认不读取 `.env`，避免误加载开发者凭据。服务端支持 OpenAI-compatible `chat/completions` 接口。
2. 启动 API：

```powershell
python server.py
```

3. 另开一个终端启动网页与本地 API 代理：

```powershell
python local_proxy_server.py --port 4173
```

本地网页和 API 都通过 `http://127.0.0.1:4173` 这个单一入口访问：网页服务器会在 WSL 内将同源 `/api` 请求转发到本机 API 的 8000 端口。因此 Windows 浏览器不再需要直接跨 WSL 访问 8000，也不需要 CORS 配置。生产环境同样由 Nginx 提供同源 `/api` 反向代理，浏览器不会直接访问 API 的 8000 端口。

4. 打开学生端 `http://127.0.0.1:4173/student.html`，或打开教师端 `http://127.0.0.1:4173/teacher.html`。

## 推荐的 WSL 长期启动方式

项目源码仍只有一份，保留在 G 盘。WSL 直接使用：

```text
/mnt/g/1、专科考研/10、小程序/专业课AI机器人
```

不要在 WSL 内复制第二份项目。SQLite、上传文件、索引和运行日志使用 WSL 本地目录
`/home/syt418/.local/share/yanban-ai/data`，避免在 Windows 挂载盘使用 SQLite WAL 时出现
`disk I/O error`。

从 Windows PowerShell 启动：

```powershell
wsl -d Ubuntu -- bash "/mnt/g/1、专科考研/10、小程序/专业课AI机器人/start-local-wsl.sh"
```

脚本会通过 WSL 的 `tmux` 托管 API（8000）和网页服务（4173），关闭当前 PowerShell 或
Codex 执行窗口后服务仍会继续运行。

查看服务状态：

```powershell
wsl -d Ubuntu -- bash "/mnt/g/1、专科考研/10、小程序/专业课AI机器人/check-local-wsl.sh"
```

停止项目服务：

```powershell
wsl -d Ubuntu -- bash "/mnt/g/1、专科考研/10、小程序/专业课AI机器人/stop-local-wsl.sh"
```

不要同时使用 `start-local.ps1` 和 `start-local-wsl.sh`，否则会争用 8000、4173 端口。

## 中转站模型接入

网页不会直接调用中转站。学生浏览器只请求同源 `/api`，Nginx 再将请求转发给 `server.py`，因此中转站 Key 不会暴露给学生。开发时也可以通过 `YANBAN_PLATFORM_API` 指向本地 API。

在 `.env` 填写默认中转站即可让资料分析、院校画像、导图、出题、计划、批改和带背都走该中转站：

```env
YANBAN_LLM_BASE_URL=https://你的中转站域名/v1
YANBAN_LLM_API_KEY=中转站分配的密钥
YANBAN_LLM_MODEL=中转站展示的模型 ID
```

有些中转站要求完整地址，可将 `YANBAN_LLM_BASE_URL` 填为以 `/chat/completions` 结尾的地址。服务端会同时兼容两种写法。可选的 `YANBAN_VISION_*` 和 `YANBAN_SEARCH_*` 可分别指定扫描件视觉模型和带真实联网工具的搜索模型；不填写时自动回退到默认中转站。

注意：模型本身回答了“搜索结果”不代表真实联网。院校一次性网页检索仍需要中转站明确提供可调用的搜索工具，或配置 `TAVILY_API_KEY`；普通 `chat/completions` 模型不能凭模型名获得实时网页访问权限。

## 如何验证模型真的生效

网页右上角点击“功能自测”。它会真实调用一次模型并检查返回的 JSON，同时显示：

- 服务端是否读到 `YANBAN_LLM_BASE_URL`、`YANBAN_LLM_API_KEY`、`YANBAN_LLM_MODEL`；
- 上传文件是否已保存到 `data/uploads` 并解析成文本块，扫描件是否仍在等待 OCR；
- 院校画像的一次性搜索会话是否已经 `webSearchLocked=true`。自测不会再次联网搜索；
- 资料分析、思维导图、出题、计划、代背是否满足前置条件。

只有“真实模型调用”为“通过”，才说明模型接口可用。随后按“选择专业课和院校 → 上传文本资料/考试试卷 → 开始 AI 学习 → 生成功能”的顺序验证业务链路。若自测显示缺少环境变量，先填写 `.env` 后重启 `server.py`，再重新测试。

专业课选择现在按“专业大类 → 一级学科 → 二级/三级方向 → 具体考试科目”建立。每个课程空间拥有独立的院校画像、资料索引、计划和带背队列；“加开第二门专业课”会创建独立计费位（状态为 `addon_pending`）。支付成功后必须由服务端 entitlement 校验将其置为 `addon_active`，前端不应自行解锁，且两门课的资料不会混在一起。

## 学生端与老师端

- 学生端 `student.html` 只显示学习功能和当前专业课的导图、计划、答题复盘、带背历史；不显示模型、密钥、搜索和服务诊断信息。
- 首次打开学生端会生成临时匿名学习标识。建档、资料上传、资料分析、导图、计划、答题复盘和带背反馈会写入 `data/yanban.sqlite3`；正式登录接入后，用真实用户 ID 替换该临时标识即可。
- 老师端 `teacher.html` 是独立页面。在 `.env` 配置 `YANBAN_ADMIN_TOKEN` 后，以管理员令牌登录，可查看学生学习天数、行为数、上传资料数、学习态度、院校专业课知识库聚合，并导出学生档案 CSV。

## Public deployment checklist

Before exposing the service to students, set `YANBAN_LOCAL_TEST_MODE=0` and use a long, unique `YANBAN_ADMIN_TOKEN`. Keep `YANBAN_HOST=127.0.0.1` when Nginx or another reverse proxy runs on the same server; only use `0.0.0.0` when the firewall and HTTPS configuration are ready. Model and Tavily keys remain server-side and must never be placed in either HTML file.
- 老师端的“系统配置”可更新服务端模型地址、模型名称和可选密钥。已有密钥不会回显，密钥字段留空时保持原值；学生浏览器不会获得中转站密钥。
- 管理接口：`GET /api/admin/overview`、`GET /api/admin/students`、`GET /api/admin/students/export`、`GET /api/admin/students/{id}/detail`、`GET /api/admin/students/{id}/task-supervision`、`GET /api/admin/knowledge-base`、`GET/POST /api/admin/settings`、`POST /api/admin/analysis/rerun`、`GET /api/admin/paper-materials`、`POST /api/admin/paper-materials/status`，均需要管理员令牌。

## 真正的工作流

1. 学生选择专业课，并登记目标院校、报考专业、学院、科目代码和考试年份。
2. 上传文本资料和考试试卷。API 提取 PDF/Word/TXT/Markdown 的文本并分块索引。
3. 保存登记信息后自动执行一次“院校专属画像”检索。服务端优先使用上传资料与官方/本校证据；配置 `TAVILY_API_KEY` 后才会补充联网检索候选。检索结果和证据会写入画像。
4. 画像生成后 `webSearchLocked=true`，后续分析、导图、计划、训练与带背只使用画像、已保存证据和大模型，不再访问搜索 API。修改院校或考试年份后才允许生成新的搜索会话。

## 组件边界

- `server.py`：文件解析、索引、院校画像、模型调用和 API。
- `SCHOOL_SUBJECT_PROFILE_SPEC.md`：院校专属画像和理工科能力规范。
- `SUBJECT_PROMPT_CATALOG.json`：学科叶子方向能力底座，不能替代院校画像。
- `PROMPT_SPEC.md`：统一证据规则和功能 prompt。

扫描 PDF 和图片上传后会显示“待 OCR”，不会假装已经读取。接入 OCR 服务后，应先把 OCR 文本写入同一文档索引，再允许它进入模型分析。
