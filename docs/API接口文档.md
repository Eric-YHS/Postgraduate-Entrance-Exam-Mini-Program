# 研途总控台 — API 接口文档

> 最后更新：2026-04-13

---

## 认证方式

- **Session Cookie**：Web 端登录后自动携带
- **Bearer Token**：请求头 `Authorization: Bearer <token>` 或 `X-Auth-Token` 头
- **URL Token**：`?token=<token>` 参数（用于小程序 web-view 等场景）

---

## 一、认证接口

### POST /api/auth/login
用户名密码登录。

**请求体：**
```json
{ "username": "teacher", "password": "123456" }
```

**响应：**
```json
{ "user": { "id": 1, "username": "teacher", "role": "teacher", "displayName": "王老师", "className": "2027考研冲刺班" }, "token": "...", "expiresInDays": 30 }
```

### POST /api/auth/register/teacher
提交教师注册申请。

**请求体：**
```json
{ "username": "newteacher", "password": "123456", "displayName": "李老师", "className": "2027考研冲刺班", "motivation": "教授考研英语" }
```

### GET /api/auth/me
获取当前用户信息和 Token。

### POST /api/auth/logout
退出登录，清除所有 Token。

---

## 二、管理后台（admin）

### GET /api/admin/bootstrap
管理员初始数据（申请列表 + 用户列表 + 统计）。需 admin 权限。

### POST /api/admin/applications/:id/approve
批准教师注册申请。

### POST /api/admin/applications/:id/reject
拒绝教师注册申请。

### GET /api/admin/users?role=teacher&search=关键词
获取用户列表，支持 role 筛选和 search 搜索。

### PUT /api/admin/users/:id
编辑用户信息（displayName, className, role）。

### DELETE /api/admin/users/:id
删除用户（不能删除管理员）。

### POST /api/users/import
批量导入用户（管理员），需上传 Excel/CSV 文件。

---

## 三、教师端接口

### GET /api/teacher/bootstrap
教师初始数据（任务、总结、课程、直播、论坛、题目、商品、订单）。

### GET /api/teacher/students/overview
全部学生概览（今日任务完成率、最近总结、练习统计）。

### GET /api/teacher/students/:id/overview
单个学生详情（今日任务含完成状态、最近总结、练习统计）。

### POST /api/tasks
创建任务。

**请求体：**
```json
{ "title": "英语阅读精读", "subject": "考研英语", "startTime": "07:30", "endTime": "08:20", "weekdays": "周一,周三", "studentIds": [2, 3] }
```

### POST /api/tasks/import
批量导入任务（上传 Excel/CSV）。

### POST /api/tasks/:id/complete
学生标记任务完成。

### POST /api/tasks/:id/uncomplete
学生取消任务完成标记。

---

## 四、文件夹/网盘

### GET /api/folders?parentId=1
获取文件夹内容（子文件夹 + 文件项）。parentId 省略则为根目录。

**响应：**
```json
{ "path": [{"id": 1, "name": "考研数学"}], "folders": [...], "items": [...] }
```

### POST /api/folders
创建文件夹。

**请求体：** `{ "name": "线性代数", "parentId": 1 }`

### PUT /api/folders/:id
重命名/移动文件夹。

### DELETE /api/folders/:id
删除文件夹（级联删除子内容）。

### POST /api/folder-items
上传文件到文件夹（multipart/form-data）。

### DELETE /api/folder-items/:id
删除文件。

---

## 五、论坛

### POST /api/forum/topics
发帖（支持 multipart/form-data 上传图片/视频/附件）。

**表单字段：** title, content, category, links (JSON 数组字符串), images[], videos[], attachments[]

### POST /api/forum/topics/:id/replies
回复帖子（同样支持上传）。

---

## 六、题库

### POST /api/questions
创建题目（支持视频解析上传）。

**表单字段：** title, subject, questionType, textbook, stem, optionA-D, correctAnswer, analysisText, analysisVideoUrl, analysisVideo

### GET /api/questions/tags
获取所有标签。

### POST /api/questions/tags
创建标签。`{ "name": "张宇高数18讲", "category": "textbook" }`

### DELETE /api/questions/tags/:id
删除标签。

### POST /api/questions/:id/tags
设置题目标签。`{ "tagIds": [1, 2, 3] }`

### POST /api/questions/import
批量导入题目。

### POST /api/questions/:id/answer
学生作答。`{ "selectedAnswer": "B" }`

---

## 七、词汇记忆

### GET /api/flashcards
获取所有词汇卡片。`?subject=考研英语` 按科目筛选。

### GET /api/flashcards/due
获取今日待复习卡片（学生）。

### POST /api/flashcards
创建词汇卡片（教师）。

**请求体：**
```json
{ "title": "abandon", "subject": "考研英语", "frontContent": "to give up completely", "backContent": "放弃; 抛弃", "tags": ["高频词汇"] }
```

### POST /api/flashcards/:id/review
提交复习结果。`{ "quality": 2 }` (0=Again, 1=Hard, 2=Good, 3=Easy)

### POST /api/flashcards/import
批量导入词汇卡片。

---

## 八、练习会话

### POST /api/practice/sessions
开始练习。`{ "sessionType": "subject", "subjectFilter": "考研英语" }`

### POST /api/practice/sessions/:id/end
结束练习。`{ "totalQuestions": 20, "correctCount": 16 }`

### GET /api/practice/stats
练习统计（总题数、正确率、已学词汇数）。

### GET /api/practice/wrong
错题列表。

---

## 九、直播

### POST /api/live-sessions
创建直播间。

### POST /api/live-sessions/:id/start
开始直播。

### POST /api/live-sessions/:id/end
结束直播。

### GET /api/live-sessions/:id
获取直播详情和聊天记录。

---

## 十、商城

### POST /api/products
创建商品（教师）。

### POST /api/orders
下单（学生）。`{ "productId": 1, "quantity": 2, "shippingAddress": "..." }`

---

## 十一、通知

### POST /api/notifications/:id/read
标记通知已读。

### POST /api/tasks/dispatch/daily
手动触发每日任务摘要推送。

### POST /api/tasks/dispatch/due
手动触发任务到期提醒。

---

## 十二、模板下载

### GET /api/templates/:type
下载 Excel 模板。type 可选：task, question, user, flashcard。

---

## 错误响应格式

所有错误返回统一格式：
```json
{ "error": "错误描述信息" }
```

常见状态码：
- `400` 请求参数错误
- `401` 未登录
- `403` 无权限
- `404` 资源不存在
- `500` 服务器内部错误
