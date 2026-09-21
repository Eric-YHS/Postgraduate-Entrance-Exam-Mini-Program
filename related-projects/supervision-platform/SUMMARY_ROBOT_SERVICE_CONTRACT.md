# 总结机器人服务接入契约

前端的“总结机器人”只保存供应商、模型、接口地址、服务端密钥引用名、系统提示词与限制词。真实 API Key 必须只存放在服务端环境变量，不能写入浏览器、本地存储或前端代码。

## 调度规则

服务端统一使用 `Asia/Shanghai` 时区调度。每位学生每个自然日最多收到一条总结，并按优先级执行：月总结优先于周总结，周总结优先于日总结。每月最后一天生成月总结并跳过当天周总结和日总结；非月末的每周日 12:00 生成周总结并跳过当天日总结；其他日期在 22:00 生成日总结。

建议使用以下幂等键防止重试、重启或并发调度时重复发送：

`studentId:summaryType:scheduleDate`

## 建议数据表

```ts
type StudentSummary = {
  id: string;
  studentId: string;
  type: 'daily' | 'weekly' | 'monthly';
  scheduleDate: string; // Asia/Shanghai, yyyy-mm-dd
  status: 'queued' | 'generated' | 'sent' | 'failed';
  content: {
    taskFocus: string;
    weakPoints: string;
    examDirection: string;
    progressForecast: string;
  };
  inputRange: { from: string; to: string };
  promptVersion: string;
  generatedAt: string | null;
  deliveredAt: string | null;
  errorMessage: string | null;
};
```

## 推荐接口

`POST /internal/summary-jobs/run` 由定时任务调用。服务端根据当前时间决定日、周、月总结类型，查询学生任务、打卡、自测和错题数据，调用已启用的 `learning_summary` 机器人，经过限制词校验后持久化总结并投递网页通知。

`GET /api/student/me/learning-summaries?type=daily|weekly|monthly` 供学生首页读取已投递的总结。必须从当前安全会话识别学生，不能由前端传入任意 studentId。

`POST /internal/summary-jobs/regenerate` 仅允许有审核权限的教师或管理员调用，用于失败重试或人工确认后的重新生成；必须记录操作者、原因和生成版本。

## 模型调用输入

模型输入仅包含完成任务、待完成任务、自测成绩、错题知识点、报名科目、当前进度与未来计划等必要字段。不要上传手机号、身份证、收货地址、密码、支付信息或教师端配置。模型输出应严格校验为四个字段：`taskFocus`、`weakPoints`、`examDirection`、`progressForecast`。

## 网页端投递

生成成功后，应写入 `StudentSummary`，并可通过 WebSocket/SSE 或下一次首页请求展示。学生端只展示总结正文、类型与送达时间，不展示模型、提示词、接口、密钥或内部日志。
