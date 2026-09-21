const GUIDE_DATA = {
  student: {
    roleLabel: '学生端',
    title: '学生端使用指导',
    intro: '从每天的任务执行，到刷题、课程、总结和复盘，这里按实际操作顺序列出学生端全部功能。建议先完成“今日任务”闭环，再体验题库与学习数据。',
    home: '/student',
    quickStart: [
      ['确认账号与提醒', '进入设置检查账号信息，并允许浏览器通知。'],
      ['完成一项任务', '勾选子任务、设置提醒或启动专注计时。'],
      ['做题并复盘', '完成一道题，查看解析、错题和笔记。'],
      ['提交学习总结', '记录完成情况，等待老师点评。']
    ],
    troubleshooting: [
      '页面没有数据时，先确认老师是否已创建任务、上传课程或录入题目。',
      '功能提示“需要升级权益”时，联系老师或管理员检查账号套餐与解锁科目。',
      '提醒没有弹出时，到“设置”重新检查浏览器通知权限和任务提醒时间。',
      '操作失败时保留页面提示文字和发生时间，再反馈给老师或管理员。'
    ],
    sections: [
      {
        id: 'student-tasks-guide', title: '今日任务', entry: '顶部导航 > 今日任务',
        summary: '查看老师安排和系统生成的今日计划，逐项完成、设置提醒，并用专注计时记录学习时长。',
        prerequisite: '老师已为你创建任务或生成学习计划。',
        steps: ['打开“今日任务”，先看任务时间、科目、优先级和完成标准。', '有子任务时逐条勾选；完成全部内容后点击任务完成。', '需要延后提醒时设置新的提醒时间，系统会在指定时间继续提醒。', '需要连续学习时启动专注计时，结束后系统会记录本次专注时长。'],
        done: '任务显示为已完成，首页完成数量和连续学习数据随之更新。',
        notes: ['未完成任务可能进入次日计划调整依据。', '不要只勾选任务，学习中遇到的问题应在总结或题目笔记中记录。']
      },
      {
        id: 'student-questions-guide', title: '题库刷题', entry: '顶部导航 > 题库刷题',
        summary: '按科目、题型、书本和知识点筛题，支持随机组卷、错题复习、收藏、笔记和 AI 解析。',
        prerequisite: '老师已录入或导入题目；部分科目需要对应权益。',
        steps: ['先选择科目和筛选条件，再加载题目；不知道从哪里开始可使用随机组卷。', '选择答案并提交，立即查看正误、正确答案和解析。', '对不理解的题使用 AI 解析，并把自己的卡点写入题目笔记。', '进入错题复习重新作答，真正掌握后点击“标记为掌握”。', '常用题目可以收藏，后续通过收藏列表集中查看。'],
        done: '答题记录、正确率、错题状态和笔记均已保存，并能在学习数据中看到变化。'
      },
      {
        id: 'student-courses-guide', title: '录播课程', entry: '顶部导航 > 录播课程',
        summary: '浏览课程目录、播放录播内容、记录进度、写课程笔记并提交评价。',
        prerequisite: '老师已创建课程文件夹并上传内容；账号拥有课程访问权益。',
        steps: ['进入课程目录，按分类或文件夹找到需要学习的内容。', '打开视频或资料后从上次进度继续学习。', '学习过程中保存笔记，关键内容可回到课程笔记集中查看。', '完成后提交评价；“最近观看”可快速回到尚未学完的内容。'],
        done: '课程进度、最近观看记录、笔记和评价均能重新读取。'
      },
      {
        id: 'student-summary-guide', title: '学习总结', entry: '顶部导航 > 学习总结',
        summary: '提交每日复盘，记录完成情况、薄弱点和次日需要补的内容，并查看历史总结与老师点评。',
        steps: ['选择总结日期。', '写清今天完成了什么、哪里卡住、明天准备怎么调整。', '需要时上传图片或附件作为学习证据。', '提交后在历史总结中确认记录，并留意老师点评。'],
        done: '历史总结列表出现当天记录，老师端能够查看并点评。'
      },
      {
        id: 'student-live-guide', title: '直播答疑', entry: '更多 > 直播答疑',
        summary: '查看即将开始或正在进行的直播，提前预约并在开播后进入直播间。',
        prerequisite: '老师已创建直播场次。',
        steps: ['查看直播主题、老师、开始时间和当前状态。', '尚未开始时点击预约，开播时接收提醒。', '直播进行中点击进入，允许浏览器使用麦克风或摄像头。', '结束后返回列表确认场次状态。'],
        done: '预约成功会显示提示；直播中可以正常进入房间并交流。'
      },
      {
        id: 'student-flashcards-guide', title: '词汇记忆', entry: '更多 > 词汇记忆',
        summary: '按间隔重复计划复习词汇卡片，设置每日目标并查看学习连续天数和排行榜。',
        prerequisite: '老师已创建或导入词汇卡片。',
        steps: ['设置每天计划复习的卡片数量。', '依次查看卡片正面，作答后翻到背面核对。', '按实际掌握程度选择反馈，系统会计算下一次复习时间。', '查看连续学习日历和周排行榜，确认目标完成情况。'],
        done: '当天复习数量增加，卡片进入新的复习周期。'
      },
      {
        id: 'student-stats-guide', title: '学习数据', entry: '更多 > 学习数据',
        summary: '查看做题、正确率、科目分布、周月趋势、年度热力图和学习报告。',
        steps: ['先看总做题量、正确率和薄弱科目。', '切换周报、月报，对比不同时间段趋势。', '查看年度热力图确认学习是否连续。', '需要汇报时打开学习报告并使用浏览器截图保存。'],
        done: '能够指出当前最弱科目、最近趋势和下一步复习重点。'
      },
      {
        id: 'student-checkin-guide', title: '打卡与习惯', entry: '更多 > 打卡日历',
        summary: '查看学习连续记录，创建可重复执行的学习习惯并每日打卡。',
        steps: ['在打卡日历查看已有学习记录。', '创建习惯时填写清晰名称和目标天数。', '完成当天习惯后点击打卡。', '不再使用的习惯可以删除，避免影响日常清单。'],
        done: '当天日历和习惯状态均显示已完成，连续天数得到更新。'
      },
      {
        id: 'student-achievements-guide', title: '成就徽章', entry: '更多 > 成就徽章',
        summary: '查看任务、刷题、专注和连续学习过程中已经解锁或尚未解锁的成就。',
        steps: ['打开成就列表查看每枚徽章的条件。', '按条件完成任务、刷题或专注学习。', '出现解锁提示后回到列表确认状态。'],
        done: '对应徽章显示已解锁并记录解锁时间。'
      },
      {
        id: 'student-search-guide', title: '全局搜索', entry: '更多 > 全局搜索',
        summary: '用关键词同时查找课程、题目、论坛内容和其他可访问资料。',
        steps: ['输入至少两个字符的关键词。', '在结果中按内容类型识别来源。', '点击结果进入对应课程、题目或论坛内容。', '也可以查看热门搜索词，快速发现常用内容。'],
        done: '能够从搜索结果直接打开目标内容。'
      },
      {
        id: 'student-forum-guide', title: '论坛交流', entry: '更多 > 论坛交流',
        summary: '浏览学习讨论、发布主题、回复同学并查看具体帖子。',
        steps: ['从“论坛交流”进入社区。', '先搜索或浏览已有主题，避免重复提问。', '发布时使用清晰标题并写明背景、问题和已尝试的方法。', '进入帖子查看回复并继续讨论。'],
        done: '主题或回复发布成功，并能从论坛列表重新打开。'
      },
      {
        id: 'student-store-guide', title: '资料商城', entry: '更多 > 资料商城',
        summary: '浏览资料与课程商品，管理购物车和收货地址，提交订单、下载数字商品、申请退款和评价。',
        steps: ['先查看商品说明、价格、库存和类型。', '实物商品先新增收货地址，再加入购物车结算；数字商品无需物流地址。', '在“我的订单”查看状态，数字商品可从已支付订单下载。', '收到实物后确认收货；符合条件时提交退款申请或评价。'],
        done: '订单出现在列表中，状态、下载或物流操作与商品类型一致。',
        notes: ['支付功能未启用时，系统会按当前测试或人工处理流程记录订单。']
      },
      {
        id: 'student-daily-guide', title: '每日推荐', entry: '更多 > 每日推荐',
        summary: '查看系统每天推荐的题目和学习内容，用于没有明确任务时快速开始。',
        steps: ['打开每日推荐查看当天内容。', '进入推荐题目完成作答。', '结合错题与任务安排决定是否继续同类练习。'],
        done: '当天推荐已完成，相关答题记录进入学习统计。'
      },
      {
        id: 'student-settings-guide', title: '设置', entry: '右上角账号菜单 > 设置',
        summary: '查看账号信息、修改密码并检查今日提醒和浏览器通知权限。',
        steps: ['核对显示姓名、班级和账号角色。', '首次使用时点击通知权限检查，并允许浏览器发送提醒。', '修改密码时填写旧密码，并设置至少 6 位的新密码。', '查看今日提醒，确认任务提醒是否已经生成。'],
        done: '账号信息正确，通知权限可用，新密码可以重新登录。'
      }
    ]
  },
  teacher: {
    roleLabel: '教师端',
    title: '教师端使用指导',
    intro: '教师端围绕“安排任务、跟踪学生、提供内容、组织答疑”展开。建议先准备学生和基础内容，再创建任务，最后从学生视角验证接收与完成情况。',
    home: '/teacher',
    quickStart: [
      ['检查学生列表', '确认测试学生已登录并出现在学生管理中。'],
      ['创建今日任务', '选择学生、时间和完成标准。'],
      ['触发提醒', '发送每日总任务或到点提醒。'],
      ['检查反馈', '查看任务完成、学习总结并进行点评。']
    ],
    troubleshooting: [
      '学生列表为空时，先让测试学生完成首次登录；教师端当前没有手工新建学生入口。',
      '任务无法创建时，检查标题、开始结束时间，以及是否选择了有效学生。',
      '课程、题目或词卡为空时，先在对应管理页面创建基础数据。',
      '提醒发送失败时，检查学生是否绑定企业微信、订阅消息或有效站内通知渠道。'
    ],
    sections: [
      {
        id: 'teacher-tasks-guide', title: '任务规划', entry: '顶部导航 > 任务规划',
        summary: '手动创建学习任务、批量导入计划、配置子任务和提醒，并查看任务执行情况。',
        prerequisite: '学生账号已经存在并出现在学生列表中。',
        steps: ['填写任务标题、开始和结束时间。', '在高级设置中选择科目、优先级、完成标准和子任务。', '选择接收任务的学生后创建任务。', '批量任务使用表格导入，导入后检查成功和跳过数量。', '需要立即验证推送时，分别触发每日总任务提醒和到点提醒。'],
        done: '任务出现在列表中，目标学生端能看到任务并完成子任务。'
      },
      {
        id: 'teacher-students-guide', title: '学生管理', entry: '顶部导航 > 学生管理',
        summary: '查看已有学生的任务完成情况、练习正确率、最近总结和风险状态，并发送人工提醒。',
        prerequisite: '学生目前需要先通过微信小程序首次登录创建账号；此页面暂不支持手工新建学生。',
        steps: ['从学生列表查看今日完成数量、正确率和状态。', '点击学生卡片进入详情，查看近期任务、练习和总结。', '对有未完成任务的学生点击提醒。', '结合风险提醒决定是否调整次日任务或人工沟通。'],
        done: '能够查看学生详情；提醒操作返回成功提示。',
        notes: ['“新建/邀请学生”不是当前教师端已有功能，这一限制会在页面中明确显示。']
      },
      {
        id: 'teacher-summaries-guide', title: '学习总结点评', entry: '更多 > 学习总结',
        summary: '集中查看学生提交的每日总结、图片和附件，并给出老师点评。',
        steps: ['按学生和日期查看总结。', '阅读完成情况、薄弱点和附件证据。', '填写具体点评，指出下一步动作而不是只写鼓励话。', '提交后确认点评出现在学生端历史总结中。'],
        done: '点评保存成功，学生可以查看。'
      },
      {
        id: 'teacher-courses-guide', title: '录播课程管理', entry: '顶部导航 > 录播课程',
        summary: '创建课程文件夹、上传视频或资料、维护目录，并查看学生使用的同一内容结构。',
        steps: ['先创建按科目或阶段命名的文件夹。', '选择文件夹并上传课程文件，填写清晰标题。', '在列表中检查文件位置和可访问状态。', '删除前确认内容不再被任务或学生使用。'],
        done: '学生端能够在录播课程中打开新内容。'
      },
      {
        id: 'teacher-live-guide', title: '直播答疑', entry: '顶部导航 > 直播答疑',
        summary: '创建直播场次，管理待开始、直播中和已结束状态，并进入直播房间。',
        steps: ['填写主题、开始时间和说明后创建直播间。', '开播前让学生预约。', '到时间后点击开始并进入直播间。', '结束时点击结束，避免场次长期保持直播中。'],
        done: '直播状态按待开始、进行中、已结束正确变化，学生可以预约和进入。'
      },
      {
        id: 'teacher-questions-guide', title: '题库管理', entry: '更多 > 题库管理',
        summary: '维护标签、书本、知识点和题目，支持录入题干、答案、解析和关联分类。',
        steps: ['先在标签、书本和知识点管理中建立分类。', '录入题目时选择科目、题型、来源和难度。', '填写题干、选项、正确答案与解析，并关联标签。', '保存后到学生端按相同条件筛选并作答验证。'],
        done: '题目可被学生检索、作答，答案和解析显示正确。'
      },
      {
        id: 'teacher-flashcards-guide', title: '词汇卡片管理', entry: '更多 > 词汇管理',
        summary: '单条创建或通过表格批量导入词汇卡片，维护正反面、例句、词根词缀和音频。',
        steps: ['少量内容使用创建卡片，填写标题、正面和背面。', '词汇内容可补充音标、例句、词根词缀、搭配和标签。', '大量内容使用批量导入，并核对成功和跳过数量。', '到学生端完成一次复习，确认卡片内容和调度正常。'],
        done: '卡片出现在教师列表和学生复习队列中。'
      },
      {
        id: 'teacher-store-guide', title: '资料商城管理', entry: '更多 > 资料商城',
        summary: '创建商品、维护库存和价格，并处理学生订单状态。',
        steps: ['创建商品时填写标题、说明、价格、库存和交付类型。', '上架后到学生端确认商品展示。', '学生下单后在订单列表更新处理、发货等状态。', '数字商品需确认下载内容已经配置。'],
        done: '商品可购买，订单状态变化会同步到学生端。'
      },
      {
        id: 'teacher-exams-guide', title: '模拟考试', entry: '更多 > 模拟考试',
        summary: '从题库题目创建模拟考试，也可以先用 AI 生成候选题目再组织试卷。',
        prerequisite: '题库中已有可用题目，或 AI 服务配置正常。',
        steps: ['填写考试标题并选择或填写题目 ID。', '需要新题时使用 AI 生成，审核题干、答案和解析后再使用。', '创建考试并检查题目顺序。', '从考试列表进入并完成一次测试。'],
        done: '考试出现在列表中，题目、答案和提交结果完整。'
      },
      {
        id: 'teacher-forum-guide', title: '论坛社区', entry: '更多 > 论坛社区',
        summary: '查看学生讨论并以教师身份回复，必要时处理错误学习信息。',
        steps: ['进入论坛浏览最新主题。', '打开需要答复的帖子并阅读完整上下文。', '回复时给出可执行建议和资料出处。', '发现违规内容时联系管理员处理。'],
        done: '教师回复可以在帖子中正常显示。'
      },
      {
        id: 'teacher-settings-guide', title: '设置', entry: '右上角账号菜单 > 设置',
        summary: '核对教师账号与班级信息、修改密码，并查看教师端操作说明。',
        steps: ['确认显示姓名、账号和班级。', '修改密码时填写旧密码和至少 6 位新密码。', '重新登录验证新密码。'],
        done: '账号资料显示正确，新密码可用。'
      }
    ]
  },
  admin: {
    roleLabel: '管理员端',
    title: '管理员端使用指导',
    intro: '管理员端负责全局数据、内容、账号、机器人和外部渠道。建议先完成基础配置与测试账号，再逐步验证内容、任务、消息和机器人闭环。',
    home: '/admin',
    quickStart: [
      ['检查系统配置', '确认站点、AI、微信和企业微信配置状态。'],
      ['准备测试账号', '审核教师并确认至少一个学生账号可用。'],
      ['准备基础内容', '录入课程、题目、知识库和消息模板。'],
      ['验证渠道闭环', '测试学生任务、客服消息、周报与审计记录。']
    ],
    troubleshooting: [
      '先看浏览器提示和接口返回，再查看服务器日志中的同一时间点错误。',
      '外部渠道失败时依次检查功能开关、凭据、可信 IP、回调地址和账号权限。',
      '机器人不能上线时，按上线检查逐项补齐 Prompt、语料、关键词、模板和推送位。',
      '修改生产配置后使用最小测试账号验证，不要直接对全体用户发送。'
    ],
    sections: [
      {
        id: 'admin-dashboard-guide', title: '数据看板', entry: '左侧菜单 > 数据看板',
        summary: '查看用户、课程、收入、任务、做题和新增学员等核心指标及 7 天、30 天趋势。',
        steps: ['先看顶部总量指标确认数据是否正常。', '切换最近 7 天和 30 天趋势，检查异常波动。', '结合新增学员、收入、完成率、做题量和课程学习趋势定位问题。', '发现异常后进入对应管理模块查看明细。'],
        done: '能够从一个异常指标追到具体业务数据。'
      },
      {
        id: 'admin-content-guide', title: '内容管理', entry: '左侧菜单 > 内容管理',
        summary: '维护课程、分类、文件夹及其他面向学生的基础内容。',
        steps: ['先创建公共课或专业课分类。', '按科目和阶段建立内容目录。', '上传课程或资料并检查标题和访问范围。', '使用学生测试账号确认内容可见和可打开。'],
        done: '内容结构清晰，学生端可以按分类访问。'
      },
      {
        id: 'admin-students-guide', title: '学员管理', entry: '左侧菜单 > 学员管理',
        summary: '搜索和筛选已有学员，查看学习档案、权益、任务、课程进度和复习计划。',
        prerequisite: '学员账号已经存在；当前列表页不提供手工新建学生。',
        steps: ['按姓名、用户名或权益等级筛选学员。', '进入详情查看学习数据、总结、课程进度和权益。', '需要时创建或调整专属复习计划。', '回到学生端确认任务和权益变化。'],
        done: '学员详情完整，计划和权益修改对目标账号生效。'
      },
      {
        id: 'admin-questions-guide', title: '题库管理', entry: '左侧菜单 > 题库管理',
        summary: '统一查看、编辑和维护题目及分类信息，保证学生刷题数据来源可靠。',
        steps: ['按科目、题型或关键词筛选题目。', '检查题干、选项、答案、解析、来源和标签。', '修改后保存，并用学生账号完成一次作答。', '批量资料导入后重点抽查答案与中文编码。'],
        done: '题目检索、作答、解析和错题记录均正常。'
      },
      {
        id: 'admin-knowledge-guide', title: '知识库与语料库', entry: '左侧菜单 > 知识库/语料库',
        summary: '创建全局知识库、上传资料并维护机器人专属语料，让回答先检索资料再调用模型。',
        steps: ['按业务创建知识库并选择分类。', '上传文档后等待解析完成，检查文档数量和状态。', '为机器人补充至少 5 条高频专属语料。', '使用真实问题测试命中结果和回答引用是否合理。'],
        done: '知识库文档可检索，机器人回答能使用相关资料。'
      },
      {
        id: 'admin-messages-guide', title: '消息模板', entry: '左侧菜单 > 消息模板管理',
        summary: '维护欢迎、提醒、转人工、兜底和反馈等消息模板，统一实际推送话术。',
        steps: ['按使用场景创建模板并命名。', '填写真人化短句，避免空泛鼓励和不合规承诺。', '检查变量占位符与实际发送数据一致。', '用测试学生发送一次，核对最终文本。'],
        done: '模板保存成功，测试发送内容和变量替换正确。'
      },
      {
        id: 'admin-forum-guide', title: '论坛管理', entry: '左侧菜单 > 论坛管理',
        summary: '查看论坛内容，处理不当主题和回复，维持社区内容质量。',
        steps: ['按时间和内容查看主题。', '打开主题核对完整上下文。', '处理违规、广告或错误信息。', '用普通账号确认处理结果。'],
        done: '被处理内容的状态和前台展示一致。'
      },
      {
        id: 'admin-robot-roles-guide', title: '机器人角色', entry: '左侧菜单 > 机器人管理 > 机器人',
        summary: '创建和配置机器人角色，完成上线门禁、灰度、手动推送、对话记录与配置审计。',
        steps: ['新建机器人并填写名称、昵称、定位和说明。', '完成说话风格、四段 Prompt、禁用词、语料、关键词、模板、推送位和转人工词。', '运行上线检查，逐条修复未通过项。', '先对测试账号手动推送，再进行 10% 或 50% 灰度。', '查看对话记录、违规事件和配置审计，确认后再全量上线。'],
        done: '机器人通过全部门禁，测试对话符合角色和安全要求。'
      },
      {
        id: 'admin-student-profile-guide', title: '学员登记与计划', entry: '机器人管理 > 学员档案与计划',
        summary: '为已有站内学生或企业微信 UserID 生成表1登记链接，并维护表2计划模板和次日计划。',
        prerequisite: '已有站内学生 ID，或者能确定企业微信 UserID。',
        steps: ['输入站内学生 ID 或企业微信 UserID，生成登记链接。', '复制链接并发给目标学生填写基本情况。', '刷新列表确认提交状态和档案字段。', '保存计划模板，再分别测试半自动和全自动次日计划。'],
        done: '档案显示已提交，计划模板和次日计划均能读取。'
      },
      {
        id: 'admin-wecom-groups-guide', title: '企业微信群', entry: '机器人管理 > 企业微信群',
        summary: '读取企业通讯录、创建群聊、添加成员并分配默认机器人和群内角色。',
        prerequisite: '企业微信应用凭据有效，服务器出口 IP 已加入可信 IP。',
        steps: ['先同步企业通讯录，确认成员可读取。', '创建测试群并选择成员。', '配置默认机器人、是否全量回复和消息合并等待时间。', '在群内发送连续消息，检查合并回复和转人工。'],
        done: '群创建成功，成员、机器人分配和回复策略按配置生效。'
      },
      {
        id: 'admin-wecom-kf-guide', title: '微信客服', entry: '机器人管理 > 微信客服',
        summary: '同步微信客服账号、生成接待链接、分配机器人，并管理客户会话中的 AI 与人工接管。',
        prerequisite: '微信客服已授权给企业自建应用，回调 Token/AES Key 和可信 IP 正确。',
        steps: ['同步客服账号，确认名称和 open_kfid。', '为客服账号分配默认机器人并开启自动回复。', '用普通微信打开接待链接发送文字、图片或语音。', '检查消息合并、AI 回复、人工接管和恢复自动回复。'],
        done: '客户消息可同步，机器人能回复，人工接管后 AI 会停止响应。'
      },
      {
        id: 'admin-robot-operations-guide', title: '工单与机器人运营', entry: '机器人管理 > 工单池 / 运营面板',
        summary: '查看转人工工单、违规次数、待回复、灰度批次和机器人运行状态。',
        steps: ['优先处理 P0 转人工工单。', '查看触发原因、学生和原始消息。', '完成人工处理后更新工单状态。', '定期检查违规、待回复和错误趋势，必要时暂停机器人。'],
        done: '高优先级工单得到处理，机器人没有持续积压或重复错误。'
      },
      {
        id: 'admin-entrepreneurship-guide', title: '创业板块', entry: '左侧菜单 > 创业板块',
        summary: '查看和处理推广或创业相关申请及运营记录。',
        steps: ['按状态筛选申请。', '查看申请人资料和提交内容。', '按实际审核规则更新状态并记录原因。', '复查列表和相关用户状态。'],
        done: '申请状态和处理意见均已保存。'
      },
      {
        id: 'admin-refunds-guide', title: '退款审核', entry: '左侧菜单 > 退款审核',
        summary: '审核学生提交的订单退款请求并记录处理结果。',
        steps: ['按待审核状态查看退款申请。', '核对订单、商品、支付与申请原因。', '批准或拒绝时填写清晰处理说明。', '用学生账号检查退款状态变化。'],
        done: '退款记录、订单状态和学生端显示一致。'
      },
      {
        id: 'admin-settings-guide', title: '系统设置与账号', entry: '左侧菜单 > 系统设置',
        summary: '维护站点配置、用户账号、教师注册审核和生产运行参数。',
        steps: ['在站点配置中只修改明确理解的选项。', '在用户管理中搜索、编辑或停用账号，并检查角色权限。', '审核教师注册申请，确认姓名、班级和用户名后批准。', '修改生产配置后用最小测试账号验证，并查看审计或日志。'],
        done: '配置保存后功能正常，教师审批会创建可登录账号。',
        notes: ['密钥、SMTP 密码、企业微信 Secret 等应保存在服务器环境变量中，不要写入页面或提交到 Git。']
      }
    ]
  }
};

function guideEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function searchableText(section) {
  return [section.title, section.entry, section.summary, section.prerequisite, section.done]
    .concat(section.steps || [], section.notes || [])
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function renderQuickStart(items) {
  document.getElementById('guide-quickstart-list').innerHTML = items.map(([title, detail]) => `
    <li><strong>${guideEscape(title)}</strong><span>${guideEscape(detail)}</span></li>
  `).join('');
}

function renderGuideSections(sections) {
  const sectionRoot = document.getElementById('guide-sections');
  const tocRoot = document.getElementById('guide-toc-list');

  sectionRoot.innerHTML = sections.map((section, index) => `
    <section class="guide-module" id="${guideEscape(section.id)}" data-guide-search="${guideEscape(searchableText(section))}">
      <div class="guide-module-header">
        <span class="guide-module-index">${String(index + 1).padStart(2, '0')}</span>
        <div>
          <div class="guide-module-title-row">
            <h2>${guideEscape(section.title)}</h2>
            <span class="guide-entry">${guideEscape(section.entry)}</span>
          </div>
          <p class="guide-module-summary">${guideEscape(section.summary)}</p>
        </div>
      </div>
      <div class="guide-module-body">
        ${section.prerequisite ? `
          <div class="guide-prerequisites">
            <strong>开始前</strong>
            <p>${guideEscape(section.prerequisite)}</p>
          </div>
        ` : ''}
        <div class="guide-step-block">
          <h3>操作步骤</h3>
          <ol class="guide-steps">${section.steps.map((step) => `<li>${guideEscape(step)}</li>`).join('')}</ol>
        </div>
        <div class="guide-done">
          <strong>完成标志</strong>
          <p>${guideEscape(section.done)}</p>
        </div>
        ${section.notes?.length ? `<ul class="guide-notes">${section.notes.map((note) => `<li>${guideEscape(note)}</li>`).join('')}</ul>` : ''}
      </div>
    </section>
  `).join('');

  tocRoot.innerHTML = sections.map((section, index) => `
    <a href="#${guideEscape(section.id)}" data-guide-toc="${guideEscape(section.id)}">
      <span class="guide-toc-index">${String(index + 1).padStart(2, '0')}</span>
      <span>${guideEscape(section.title)}</span>
    </a>
  `).join('');
}

function bindGuideSearch(total) {
  const input = document.getElementById('guide-search');
  const clearButton = document.getElementById('guide-search-clear');
  const status = document.getElementById('guide-search-status');
  const empty = document.getElementById('guide-empty');

  function applySearch() {
    const query = input.value.trim().toLowerCase();
    let visible = 0;
    document.querySelectorAll('.guide-module').forEach((section) => {
      const matches = !query || section.dataset.guideSearch.includes(query);
      section.hidden = !matches;
      const toc = document.querySelector(`[data-guide-toc="${section.id}"]`);
      if (toc) toc.hidden = !matches;
      if (matches) visible += 1;
    });
    empty.hidden = visible !== 0;
    status.textContent = query ? `找到 ${visible} 个相关功能` : `显示全部 ${total} 个功能`;
  }

  input.addEventListener('input', applySearch);
  clearButton.addEventListener('click', () => {
    input.value = '';
    input.focus();
    applySearch();
  });
  applySearch();
}

function observeGuideSections() {
  if (!('IntersectionObserver' in window)) return;
  const observer = new IntersectionObserver((entries) => {
    const visible = entries
      .filter((entry) => entry.isIntersecting && !entry.target.hidden)
      .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (!visible) return;
    document.querySelectorAll('[data-guide-toc]').forEach((link) => {
      link.classList.toggle('active', link.dataset.guideToc === visible.target.id);
    });
  }, { rootMargin: '-90px 0px -70% 0px', threshold: 0 });
  document.querySelectorAll('.guide-module').forEach((section) => observer.observe(section));
}

async function initGuide() {
  const auth = await ensureAuth(['student', 'teacher', 'admin', 'customer_service']);
  if (!auth) return;

  const guideRole = auth.user.role === 'customer_service' ? 'admin' : auth.user.role;
  const guide = GUIDE_DATA[guideRole];
  if (!guide) {
    location.href = '/';
    return;
  }

  const roleLabel = auth.user.role === 'customer_service' ? '客服端（管理员后台）' : guide.roleLabel;
  document.title = `${roleLabel}使用指导｜研途总控台`;
  document.getElementById('guide-role-label').textContent = `${roleLabel} · ${auth.user.displayName || auth.user.username}`;
  document.getElementById('guide-kicker').textContent = `${roleLabel} · 当前系统操作手册`;
  document.getElementById('guide-title').textContent = guide.title;
  document.getElementById('guide-intro').textContent = guide.intro;
  document.getElementById('guide-module-count').textContent = String(guide.sections.length);
  document.getElementById('guide-home-link').href = guide.home;
  document.getElementById('guide-brand-link').href = guide.home;
  document.getElementById('guide-troubleshooting').innerHTML = guide.troubleshooting
    .map((item) => `<li>${guideEscape(item)}</li>`).join('');

  renderQuickStart(guide.quickStart);
  renderGuideSections(guide.sections);
  bindGuideSearch(guide.sections.length);
  observeGuideSections();
  document.getElementById('guide-logout-button').addEventListener('click', logout);
  document.getElementById('guide-root').hidden = false;
}

initGuide();
