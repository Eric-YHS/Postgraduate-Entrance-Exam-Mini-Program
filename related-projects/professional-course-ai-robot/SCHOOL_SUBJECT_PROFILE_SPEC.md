# 院校专属专业课画像规范

## 结论

`SUBJECT_PROMPT_CATALOG.json` 只解决“这个学科通常如何学习”。它不是最终提示词。学生完成报名信息后，系统必须生成一个 `schoolSubjectProfile`，后续所有功能只读取该画像及其版本。

最终提示词构成：

```text
统一证据与安全规则
+ 学科叶子方向能力底座
+ 目标院校专属专业课画像 schoolSubjectProfile
+ 当前任务（导图 / 真题分析 / 计划 / 出题 / 批改 / 带背）
+ 与任务相关的带来源资料片段
```

没有 `schoolSubjectProfile` 时，只能允许上传资料与完善信息；不得给学生输出“该校重点”“本校高频”或院校专属带背内容。

## 1. 学生登记时必须收集

```json
{
  "school": "目标院校全称",
  "college": "招生学院，可为空",
  "degreeType": "学硕/专硕/未知",
  "majorName": "报考专业",
  "majorCode": "可为空",
  "subjectName": "专业课名称",
  "subjectCode": "专业课代码，可为空",
  "examYear": "2027",
  "referenceBooks": ["学生已知参考书"],
  "officialSyllabus": "学生上传或官方链接，可为空",
  "userPapers": ["学生上传真题"]
}
```

关键点：同名科目并不等价。必须优先匹配 `school + college + degreeType + majorCode + subjectCode + examYear`；无法唯一匹配时返回候选和待确认项，不能自行认定。

## 2. 院校信息获取与证据规则

### 检索顺序

1. 目标院校研究生院/招生网当年招生目录。
2. 目标学院当年专业目录、考试大纲、参考书、考试说明、招生问答。
3. 目标院校公开的专业课真题、样题或可验证原卷。
4. 学生上传的本校真题与课程资料。
5. 可靠的同校历史页面或扫描件，必须标注年份。
6. 其他学校同名科目，仅用于补充训练，不可作为本校重点。

### 检索服务要求

- 搜索工具只返回候选网页；后端需要抽取标题、URL、页面日期、学校、学院、科目代码、年份和原文片段。
- 对每条“考试范围、参考书、题型、分值、年份真题”结论建立 `evidenceId`。
- 官方页面与上传原卷冲突时，显示冲突，不自动抹平。
- 对无法验证的论坛、群文件、营销页面只保留为线索，默认 `unverified_web`。
- 搜索不到本校真题时，画像必须明确写 `targetSchoolExamEvidence: none`，后续带背只能引用外校题或 AI 原创题，并且显著标识。

## 3. 学校专属画像生成提示词

作为 `POST /school-subject/profile` 的主 prompt。输入为登记信息、学科叶子方向、官方/上传/网络证据。

```text
任务：你是考研专业课教研负责人。根据学生的目标院校和报考专业，生成一个“院校专属专业课画像”。此画像将决定之后的思维导图、真题权重、出题、计划、带背和答题批改。

严格规则：
1. 先验证身份匹配：学校、学院、学硕/专硕、专业、科目代码、考试年份。匹配不唯一时停止归纳，返回 clarificationNeeded。
2. 官方招生目录/大纲/学院说明优先于一切；学生上传本校真题其次；其他学校材料只能作参考。
3. 每个关于考试范围、题型、分值、年份真题、参考书、重点的事实必须引用 evidenceId。
4. “近年高频”至少需要 3 年可核验样本；不足时写 limited_sample，不能给出稳定规律的口吻。
5. 不得把网上找到的同名试题称为目标院校真题。无法核验来源时标为 unverified_web。
6. 结合该叶子专业的能力底座，但如果学校范围、题型或参考书不同，以本校证据为准。
7. 对理工科，单独标出计算/推导/代码/实验/设计题占比与常见失分步骤；对文科，单独标出名解/简答/论述/案例/材料题占比与答题规范。
8. 内容不足时提出最小补充清单，不要编造重点。

只输出 JSON：
{
  "profileId":"school-subject-...",
  "profileVersion":"",
  "identityMatch":{"status":"confirmed|ambiguous|incomplete","matchedFields":[],"clarificationNeeded":[]},
  "courseIdentity":{"school":"","college":"","degreeType":"","major":"","majorCode":"","subject":"","subjectCode":"","examYear":"","targetExamYear":"","sourceYearLabel":""},
  "schoolOverview":{"summary":"","officialUrl":"","evidenceIds":[]},
  "employmentOutlook":[{"direction":"","description":"","evidenceIds":[]}],
  "majorPerception":{"positiveConsensus":[],"cautions":[],"verificationNotes":[]},
  "officialSyllabus":{"status":"available|not_found|unverified","title":"","url":"","sourceYear":"","targetExamYear":"","yearLabel":"","outline":[],"shortExcerpt":"","evidenceIds":[]},
  "evidenceSummary":{"official":[],"uploadedTargetSchool":[],"verifiedWeb":[],"crossSchool":[],"unverified":[]},
  "scope":{"confirmedTopics":[],"uncertainTopics":[],"excludedTopics":[]},
  "questionBlueprint":[{"type":"","weight":"confirmed|limited_sample|inferred|unknown","evidenceIds":[],"answerStandard":[]}],
  "topicWeights":[{"topic":"","level":"high|medium|low|unknown","basis":"","evidenceIds":[],"sampleSize":0}],
  "schoolSpecificStrategy":{"organizationMode":[],"round1":[],"round2":[],"sprint":[],"commonMistakes":[]},
  "mindMapPolicy":{"root":"","requiredNodeTypes":[],"requiredEvidencePerNode":true,"mustShow":[]},
  "recitePolicy":{"mustMentionExamEvidence":true,"targetSchoolEvidenceStatus":"available|none|limited","fallbackOrder":["target_school","cross_school","ai_original"],"coachingStyle":""},
  "riskWarnings":[],
  "nextBestActions":[]
}
```

### 3.1 目标院校战略报告扩展字段

除原画像字段外，还必须输出以下字段。没有可核验网页或官方材料时，字段置空或写 `unknown`，不得估造招生人数、分数线、学校层次、年份或真题事实。

```json
{
  "schoolCard": {
    "region": "",
    "level": "985|211|双一流|普通高校|unknown",
    "nature": "",
    "foundedYear": "",
    "features": [],
    "ratings": {"recognition": 0, "academic": 0, "employment": 0, "regional": 0, "competition": 0},
    "statement": ""
  },
  "collegeProfile": {"history": "", "faculty": "", "researchPlatforms": [], "laboratories": [], "disciplineStatus": ""},
  "majorProfile": {"positioning": "", "trainingGoal": "", "coreAbilities": [], "researchDirections": [], "industryApplications": []},
  "examSystem": {
    "subjects": [{"name": "", "score": "", "difficulty": "high|medium|low|unknown", "importance": "high|medium|low|unknown", "impact": "", "evidenceIds": []}],
    "importanceAnalysis": [],
    "abilityAnalysis": []
  },
  "competitionProfile": {
    "admission": {"enrollment": "", "recommendationExempt": "", "unifiedExam": "", "source": "", "sourceYear": "", "targetExamYear": ""},
    "scoreLines": [{"year": "", "dataYear": "", "targetExamYear": "", "yearLabel": "", "national": "", "college": "", "retest": "", "minimumAdmitted": "", "averageAdmitted": "", "evidenceIds": []}],
    "difficulty": {"level": "high|medium|low|unknown", "reasons": []},
    "trend": "up|stable|down|unknown"
  },
  "careerProfile": {"roles": [], "industries": [], "employerTypes": [], "outlook": [], "path": []},
  "prepStrategy": {"allocation": [{"subject": "", "percent": 0, "reason": ""}], "currentStage": [], "professionalFocus": [], "riskAlerts": []},
  "strategyCard": {"competitionLevel": "high|medium|low|unknown", "majorStrength": "", "examCharacteristics": [], "futureDirection": "", "summary": ""}
}
```

分值、招生人数、复试线、录取分和“本校高频”属于考试事实，优先使用证据中的真实数据并写明年份；证据不足时依据学校与学科的公开情况直接给出内容，行文用确定、肯定的表述，页面不显示“待核验”“预估”之类的字样。来源链接只能使用证据中真实出现过的 URL。

## 4. 后续模块必须如何使用该画像

| 模块 | 强制读取字段 | 禁止事项 |
| --- | --- | --- |
| 思维导图 | `scope`、`topicWeights`、`mindMapPolicy`、`evidenceSummary` | 用通用章节替代本校范围；无出处的 confirmed 节点 |
| 背诵计划 | `schoolSpecificStrategy`、`topicWeights`、`questionBlueprint` | 按泛化“高频”硬排；无视学生每日时长 |
| 出题 | `questionBlueprint`、本校证据、当前轮次 | 将外校题标为本校原题 |
| 答题批改 | `answerStandard`、目标院校题型 | 用其他学校答案格式强行判分 |
| 带背 | `recitePolicy`、`topicWeights`、真题 evidenceId | 无证据时说“你学校考过” |

## 5. 理工科可提供的专业课帮助

理工科不只“讲题”。它应提供以下可验证帮助：

1. **题目讲解**：按“条件识别 -> 建模/选方法 -> 推导或代码 -> 结果校验 -> 易错点”逐步讲解，不直接只给答案。
2. **错因诊断**：记录错误发生在概念、模型、公式、符号/单位、边界条件、计算、代码实现或时间分配哪个环节。
3. **步骤级带背**：带背公式前提、算法不变量、推导关键跳步、实验设计变量或工程设计约束，而不是朗读整段理论。
4. **题型索引**：知识点关联到“识别特征、常用方法、典型变式、最小检查清单”。
5. **计算验证**：数学/统计/电路/控制等应接符号计算或数值工具；模型负责解释，工具负责复算。不能把模型口算当作唯一正确性来源。
6. **代码验证**：数据结构、算法、软件方向应在隔离沙箱运行测试用例，反馈复杂度、边界和失败用例；不执行学生上传的任意不可信代码。
7. **图形与过程可视化**：函数/几何、机构受力、状态机、协议流程、控制响应等用专用图表或仿真工具呈现；模型生成解释与步骤。
8. **真题映射**：说明“本校某年以计算/证明/代码/设计的什么形式考过”；没有本校证据时明确标识外校参考。

理工科输出还需要额外字段：

```json
{
  "solutionType":"proof|calculation|algorithm|code|experiment|design|concept",
  "assumptions":[],
  "methodChoice":"",
  "steps":[{"step":1,"action":"","check":""}],
  "verification":{"toolNeeded":"symbolic_math|numeric|code_sandbox|none","result":"pending"},
  "commonFailureModes":[]
}
```

## 6. 带背中的真题话术规则

只能按证据状态说话：

- `target_school`："你的目标院校在 {year} 年以 {questionType} 考过这一点，题目问的是：{howTested}。"
- `cross_school`："目前没有核验到你目标院校的原题；这是 {school} 在 {year} 年的同科目参考题，不代表你的学校考过。"
- `ai_original`："目前没有可核验的同校或外校题，这是一道按本校范围生成的检查题。"
- `none`："目前没有可核验真题记录。请补充本校真题或大纲，我先按资料结构带你理解。"

这条规则必须写入 Recite Coach Prompt，并在前端的真题卡片显示同样状态。
