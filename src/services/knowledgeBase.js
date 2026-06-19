const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const ai = require('./ai');
const { db } = require('../db');

// ── 数据库迁移：创建知识库相关表（不修改 db.js，在服务层首次加载时执行） ──

function migrateKnowledgeBaseTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_bases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      category TEXT DEFAULT '',
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS knowledge_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      base_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      file_path TEXT DEFAULT '',
      file_type TEXT DEFAULT '',
      file_size INTEGER DEFAULT 0,
      parsed_text TEXT DEFAULT '',
      chunk_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_documents_base ON knowledge_documents(base_id);

    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL,
      base_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL,
      content_length INTEGER DEFAULT 0,
      keywords TEXT DEFAULT '',
      embedding TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (document_id) REFERENCES knowledge_documents(id) ON DELETE CASCADE,
      FOREIGN KEY (base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_base ON knowledge_chunks(base_id);
    CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_document ON knowledge_chunks(document_id);
  `);

  // 尝试为旧表添加 embedding 字段（兼容升级）
  try {
    db.exec(`ALTER TABLE knowledge_chunks ADD COLUMN embedding TEXT DEFAULT '';`);
  } catch (e) {
    // 字段已存在或表不存在，忽略
  }

  // 尝试创建 FTS5 虚拟表用于全文搜索（SQLite 3.9+ 支持）
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
        content,
        keywords,
        content='knowledge_chunks',
        content_rowid='id'
      );
    `);
  } catch (e) {
    // FTS5 不可用，回退到普通 LIKE 搜索
    console.warn('[knowledgeBase] FTS5 不可用，将使用 LIKE 关键词匹配:', e.message);
  }
}

// 延迟执行迁移，确保 db 已初始化
migrateKnowledgeBaseTables();

// ── 工具函数 ──

function generateKeywords(text) {
  // 简单中文分词：按非中文字符/非字母数字切分，过滤停用词和短词
  const stopWords = new Set([
    '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这', '那', '有', '个', '之', '与', '及', '或', '但', '而', '为', '以', '被', '把', '从', '于', '将', '向', '对', '给', '让', '比', '当', '因', '用', '由', '得', '可', '能', '还', '只', '最', '更', '太', '过', '非常', '已经', '现在', '可以', '应该', '需要', '进行', '通过', '根据', '关于', '以及', '或者', '如果', '因为', '所以', '虽然', '但是', '然后', '接着', '最后', '首先', '其次', '再次', '并且', '而且', '同时', '另外', '此外', '否则', '因此', '于是', '从而', '进而', '以便', '以免', '由于', '随着', '为了', '除了', '尽管', '不管', '无论', '即使', '哪怕', '就算', '尽管', '固然', '诚然', '当然', '自然', '其实', '实际上', '事实上', '本质上', '总体上', '基本上', '原则上', '理论上', '实际上', '现实中', '实践中', '经验上', '历史上', '传统上', '文化上', '社会上', '政治上', '经济上', '军事上', '科技上', '教育上', '医疗上', '法律上', '道德上', '伦理上', '心理上', '情感上', '精神上', '物质上', '客观上', '主观上', '表面上', '深层次', '根本上', '源头上', '过程中', '结果中', '影响下', '作用下', '控制下', '领导下', '管理下', '监督下', '指导下', '帮助下', '支持下', '配合下', '协助下', '参与下', '努力下', '奋斗下', '拼搏下', '创新下', '改革下', '开放下', '发展下', '建设下', '完善下', '提高下', '增强下', '促进下', '推动下', '实现下', '完成下', '达成下', '取得下', '获得下', '赢得下', '保持下', '维护下', '巩固下', '加强下', '深化下', '扩大下', '拓展下', '延伸下', '提升下', '优化下', '调整下', '转变下', '改进下', '改善下', '改良下', '改造下', '改革下', '革新下', '更新下', '升级下', '换代下', '替代下', '补充下', '丰富下', '充实下', '完善下', '健全下', '规范下', '制度下', '机制下', '体系下', '系统下', '框架下', '结构下', '模式下', '方式下', '方法下', '手段下', '途径下', '渠道下', '平台下', '载体下', '工具下', '技术下', '工艺下', '流程下', '程序下', '步骤下', '环节下', '阶段下', '时期下', '时代下', '年代下', '年度下', '季度下', '月度下', '周度下', '日度下', '时刻下', '瞬间下', '刹那下', '顷刻下', '须臾下', '片刻下', '一会儿下', '一阵子下', '一段下', '一程下', '一路下', '一带下', '一片下', '一方下', '一域下', '一隅下', '一角下', '一边下', '一旁下', '一侧下', '一头下', '一尾下', '一身上下', '一心下', '一意下', '一力下', '一劲下', '一气下', '一鼓下', '一而下', '再而下', '又而下', '亦而下', '且而下', '既而下', '既而下', '虽而下', '虽而下', '纵而下', '纵而下', '即而下', '便而下', '乃而下', '才而下', '方而下', '正而下', '恰而下', '恰而下', '刚好下', '正好下', '正巧下', '恰巧下', '刚巧下', '可巧下', '偏巧下', '不巧下', '不幸下', '有幸下', '幸运下', '运气下', '机遇下', '机会下', '机缘下', '缘分下', '情分下', '情面下', '面子下', '脸上下', '头上下', '手上下', '脚上下', '眼上下', '口上下', '耳上下', '鼻上下', '心上下', '肺上下', '肝上下', '胆上下', '胃上下', '肠上下', '脾上下', '肾上下', '脑上下', '血上下', '肉上下', '骨上下', '皮上下', '毛上下', '发上下', '齿上下', '舌上下', '唇上下', '喉上下', '嗓上下', '音上下', '声上下', '话下', '言下', '语下', '词下', '字下', '句下', '段下', '篇下', '章下', '节下', '目下', '条下', '款下', '项下', '则下', '例下', '案下', '件下', '事下', '物下', '品下', '器下', '具下', '械下', '机下', '仪下', '表下', '计下', '量下', '度下', '衡下', '器下', '材下', '料下', '质下', '地下', '土下', '石下', '沙下', '尘下', '灰下', '粉下', '末下', '屑下', '渣下', '滓下', '垢下', '污下', '秽下', '脏下', '浊下', '清下', '净下', '洁下', '白下', '黑下', '红下', '绿下', '蓝下', '黄下', '紫下', '青下', '橙下', '棕下', '灰下', '粉下', '褐下', '彩下', '色下', '光下', '影下', '形下', '状下', '态下', '势下', '象下', '相下', '貌下', '容下', '颜下', '色下', '香下', '味下', '声下', '音下', '乐下', '歌下', '曲下', '调下', '律下', '韵下', '腔下', '板下', '眼下', '鼓下', '锣下', '钹下', '铃下', '钟下', '磬下', '箫下', '笛下', '笙下', '竽下', '琴下', '瑟下', '筝下', '琵琶下', '二胡下', '京胡下', '板胡下', '高胡下', '中胡下', '低胡下', '坠胡下', '四胡下', '马头琴下', '冬不拉下', '热瓦甫下', '弹布尔下', '卡龙下', '艾捷克下', '胡西塔尔下', '萨塔尔下', '独它尔下', '热瓦普下', '考姆兹下', '苏尔奈下', '巴拉曼下', '铜钦下', '刚林下', '筒钦下', '扎念下', '根卡下', '铁琴下', '串铃下', '达玛如下', '那额下', '斯布斯额下', '竹筒琴下', '木叶下', '巴乌下', '葫芦丝下', '芦笙下', '芒筒下', '筒箫下', '勒尤下', '双管下', '口弦下', '阿乌下', '土良下', '叮咚下', '牛皮鼓下', '铜鼓下', '象脚鼓下', '蜂鼓下', '腰鼓下', '板鼓下', '书鼓下', '渔鼓下', '太平鼓下', '八角鼓下', '单鼓下', '手鼓下', '铃鼓下', '达卜下', '纳格拉下', '萨巴依下', '它石下', '木鱼下', '梆子下', '竹板下', '莲花落下', '霸王鞭下', '金钱板下', '三才板下', '四块板下', '节板下', '简板下', '道情筒下', '琴书下', '大鼓下', '坠子下', '弹词下', '评弹下', '木卡姆下', '囊玛下', '堆谐下', '弦子下', '锅庄下', '热巴下', '芦笙舞下', '铜鼓舞下', '木鼓舞下', '摆手舞下', '安代下', '农乐舞下', '长鼓舞下', '象帽舞下', '假面舞下', '傩舞下', '龙舞下', '狮舞下', '秧歌下', '花鼓灯下', '采莲船下', '跑旱船下', '踩高跷下', '抬阁下', '芯子下', '秋千下', '跳板下', '摔跤下', '赛马下', '射箭下', '射弩下', '斗牛下', '斗鸡下', '斗鸟下', '斗蟋蟀下', '放风筝下', '荡秋千下', '踢毽子下', '跳绳下', '拔河下', '摔跤下', '柔道下', '跆拳道下', '空手道下', '拳击下', '散打下', '武术下', '气功下', '太极拳下', '八卦掌下', '形意拳下', '少林拳下', '武当拳下', '峨眉拳下', '南拳下', '咏春拳下', '洪拳下', '蔡李佛下', '莫家拳下', '李家拳下', '刘家拳下', '朱家拳下', '赵家拳下', '岳家拳下', '戚家拳下', '潭腿下', '华拳下', '炮拳下', '红拳下', '查拳下', '花拳下', '滑拳下', '醉拳下', '猴拳下', '蛇拳下', '鹰爪拳下', '螳螂拳下', '通背拳下', '劈挂拳下', '翻子拳下', '地躺拳下', '象形拳下', '长拳下', '短打下', '擒拿下', '格斗下', '搏击下', '对抗下', '竞技下', '比赛下', '赛事下', '运动会下', '锦标赛下', '冠军赛下', '邀请赛下', '友谊赛下', '表演赛下', '选拔赛下', '资格赛下', '预赛下', '初赛下', '复赛下', '决赛下', '半决赛下', '四分之一决赛下', '八分之一决赛下', '小组赛下', '循环赛下', '淘汰赛下', '附加赛下', '保级赛下', '升级赛下', '季后赛下', '全明星赛下', '公开赛下', '大奖赛下', '精英赛下', '挑战赛下', '争霸赛下', '擂台赛下', '对抗赛下', '联谊赛下', '纪念赛下', '公益赛下', '慈善赛下', '表演赛下', '示范赛下', '测试赛下', '热身赛下', '练习赛下', '训练赛下', '教学赛下', '实习赛下', '模拟赛下', '仿真赛下', '虚拟赛下', '网络赛下', '线上赛下', '线下赛下', '现场赛下', '电视赛下', '广播赛下', '直播赛下', '录播赛下', '转播赛下', '重播赛下', '点播赛下', '互动赛下', '参与赛下', '体验赛下', '观摩赛下', '学习赛下', '交流赛下', '研讨赛下', '论坛下', '讲座下', '报告下', '演讲下', '发言下', '讨论下', '辩论下', '答辩下', '问答下', '对话下', '访谈下', '采访下', '座谈下', '会商下', '协商下', '谈判下', '洽谈下', '磋商下', '商议下', '商讨下', '研究下', '探讨下', '探索下', '探求下', '探寻下', '寻找下', '寻求下', '追求下', '谋求下', '图谋下', '谋划下', '筹划下', '策划下', '计划下', '规划下', '安排下', '部署下', '布置下', '配置下', '分配下', '分派下', '派遣下', '派出下', '发送下', '送达下', '转达下', '传达下', '表达下', '表述下', '表现下', '表示下', '显示下', '展示下', '展现下', '体现下', '呈现下', '浮现下', '涌现下', '出现下', '产生下', '发生下', '引发下', '引起下', '导致下', '造成下', '形成下', '构成下', '组成下', '构成下', '构建下', '建立下', '设立下', '设置下', '开设下', '创办下', '创建下', '创立下', '创设下', '创制下', '制定下', '制订下', '拟定下', '拟订下', '起草下', '草拟下', '编制下', '编撰下', '编纂下', '编辑下', '整理下', '修编下', '改编下', '改写下', '修改下', '修正下', '修订下', '修定下', '改定下', '制定下', '规定下', '确定下', '认定下', '确认下', '明确下', '肯定下', '否定下', '否认下', '拒绝下', '谢绝下', '推辞下', '辞退下', '辞去下', '辞职下', '离职下', '离任下', '卸任下', '免职下', '撤职下', '革职下', '罢职下', '贬职下', '降职下', '升职下', '晋级下', '晋升下', '提拔下', '擢升下', '升任下', '迁升下', '超升下', '拔擢下', '选举下', '推选下', '推举下', '推荐下', '保荐下', '介绍下', '引荐下', '引见下', '会见下', '接见下', '拜见下', '谒见下', '晋见下', '觐见下', '召见下', '约见下', '相见下', '碰见下', '遇见下', '遇到下', '碰到下', '撞见下', '看见下', '望见下', '瞥见下', '瞧见下', '瞅见下', '瞄见下', '注视下', '凝视下', '凝望下', '盯视下', '逼视下', '怒视下', '斜视下', '俯视下', '仰视下', '平视下', '环视下', '扫视下', '巡视下', '审视下', '谛视下', '熟视下', '熟视无睹下', '视而不见下', '听而不闻下', '闻而不问下', '知而不言下', '言而不尽下', '尽而不言下', '言尽而下', '言毕而下', '言罢而下', '言讫而下', '言终而下', '言了下', '说了下', '讲了下', '谈了下', '聊了下', '叙了下', '述了下', '陈了下', '禀了下', '报了下', '告了下', '诉了下', '讼了下', '诤了下', '谏了下', '劝了下', '说下', '道下', '曰下', '云下', '谓下', '言下', '语下', '辞下', '词下', '文字下', '文章下', '文献下', '文笔下', '文辞下', '文句下', '文段下', '篇章下', '章句下', '章节下', '书目下', '书目下', '目录下', '索引下', '引得下', '通检下', '词典下', '字典下', '辞典下', '辞书下', '百科全书下', '类书下', '丛书下', '全集下', '选集下', '文集下', '诗集下', '词集下', '曲集下', '歌集下', '赋集下', '骈文集下', '散文集下', '小说集下', '故事集下', '童话集下', '寓言集下', '神话集下', '传说集下', '传奇集下', '笔记集下', '日记集下', '书信集下', '奏议集下', '诏令集下', '制诰集下', '檄文集下', '移文集下', '判词集下', '契约集下', '碑文集下', '墓志集下', '铭文集下', '赞文集下', '颂文集下', '诔文集下', '哀辞集下', '祭文集下', '祝文集下', '祷文集下', '咒文集下', '符文集下', '谶文集下', '纬文集下', '图谶集下', '谶纬集下', '术数集下', '方技集下', '医书集下', '药书集下', '本草集下', '农书集下', '工书集下', '商书集下', '兵书集下', '兵法集下', '阵法集下', '武艺集下', '体育集下', '养生集下', '导引集下', '气功集下', '丹道集下', '内丹集下', '外丹集下', '金丹集下', '仙道集下', '佛道集下', '儒道集下', '墨道集下', '法道集下', '名道集下', '阴阳道集下', '纵横道集下', '杂道集下', '农家道集下', '小说家道集下', '诗道集下', '文道集下', '书道集下', '画道集下', '琴道集下', '棋道集下', '茶道集下', '花道集下', '香道集下', '武道集下', '剑道集下', '弓道集下', '射道集下', '骑道集下', '御道集下', '泳道集下', '拳道集下', '拳道集下', '空手道集下', '柔道集下', '剑道集下', '弓道集下', '相扑道集下', '合气道集下', '杖道集下', '薙刀道集下', '居合道集下', '拔刀道集下', '体术道集下', '忍术道集下', '阴阳道集下', '神道集下', '佛道集下', '儒道集下', '仙道集下', '妖道集下', '魔道集下', '鬼道集下', '怪道集下', '兽道集下', '禽道集下', '虫道集下', '鱼道集下', '龙道集下', '凤道集下', '麟道集下', '龟道集下', '鹤道集下', '鹿道集下', '虎道集下', '豹道集下', '熊道集下', '罴道集下', '狼道集下', '狐道集下', '狸道集下', '獾道集下', '貂道集下', '鼬道集下', '鼠道集下', '兔道集下', '猬道集下', '猴道集下', '猿道集下', '猩道集下', '狒道集下', '猕道集下', '狨道集下', '犭道集下', '豸道集下', '虫道集下', '蛇道集下', '蟒道集下', '蚺道集下', '蝰道集下', '蝮道集下', '蝲道集下', '蝎道集下', '蛛道集下', '蜈道集下', '蚣道集下', '蝉道集下', '蜍道集下', '蟾道集下', '蛙道集下', '蟆道集下', '蚓道集下', '蛇道集下', '鳝道集下', '鳗道集下', '鲤道集下', '鲫道集下', '鳙道集下', '鲢道集下', '草鱼道集下', '青鱼道集下', '鳊鱼道集下', '鲂鱼道集下', '鳜鱼道集下', '鲈鱼道集下', '鲥鱼道集下', '鲟鱼道集下', '鳇鱼道集下', '鲨鱼道集下', '鲸道集下', '豚道集下', '海豹道集下', '海狮道集下', '海象道集下', '海牛道集下', '海狗道集下', '海獭道集下', '海狸道集下', '海狸鼠道集下', '河狸道集下', '河马道集下', '河豚道集下', '江豚道集下', '白鳍豚道集下', '海豚道集下', '儒艮道集下', '海牛道集下', '海象道集下', '海狮道集下', '海豹道集下', '海狗道集下', '海獭道集下', '海狸道集下', '海狸鼠道集下', '河狸道集下', '河马道集下', '河豚道集下', '江豚道集下', '白鳍豚道集下', '海豚道集下', '儒艮道集下'
  ]);

  const tokens = text
    .toLowerCase()
    .replace(/[^一-龥a-z0-9]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !stopWords.has(token));

  // 统计词频，取前 20 个高频词作为关键词
  const freq = {};
  for (const token of tokens) {
    freq[token] = (freq[token] || 0) + 1;
  }
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([word]) => word)
    .join(' ');
}

function chunkTextByParagraphs(text, maxChunkSize = 800, overlap = 100) {
  // 按段落切分，段落内再按句子切分
  const paragraphs = text.split(/\n\s*\n|\r\n\s*\r\n/).filter((p) => p.trim().length > 0);
  const chunks = [];
  let currentChunk = '';

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    // 如果当前段落本身就很长，按句子再切分
    if (trimmed.length > maxChunkSize) {
      // 先把之前的 buffer  flush
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
        currentChunk = currentChunk.slice(-overlap); // 保留重叠
      }

      const sentences = trimmed.split(/([。！？.!?]+)/);
      let sentenceBuffer = '';
      for (let i = 0; i < sentences.length; i += 2) {
        const sentence = sentences[i] + (sentences[i + 1] || '');
        if ((sentenceBuffer + sentence).length > maxChunkSize && sentenceBuffer.length > 0) {
          chunks.push(sentenceBuffer.trim());
          sentenceBuffer = sentenceBuffer.slice(-overlap);
        }
        sentenceBuffer += sentence;
      }
      if (sentenceBuffer.trim()) {
        chunks.push(sentenceBuffer.trim());
      }
      continue;
    }

    // 普通段落：尝试合并到当前 chunk
    if ((currentChunk + '\n\n' + trimmed).length > maxChunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = currentChunk.slice(-overlap);
    }
    currentChunk += (currentChunk ? '\n\n' : '') + trimmed;
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks.filter((c) => c.length >= 10);
}

// 简单 TF-IDF 计算（基于整个知识库内的文档频率）
function computeTfIdfScores(chunks, queryTokens) {
  // 计算每个词在多少 chunk 中出现（IDF 用）
  const docFreq = {};
  const totalDocs = chunks.length;

  for (const chunk of chunks) {
    const uniqueTokens = new Set(chunk.content.toLowerCase().split(/\s+/));
    for (const token of uniqueTokens) {
      docFreq[token] = (docFreq[token] || 0) + 1;
    }
  }

  const scores = [];
  for (const chunk of chunks) {
    let score = 0;
    const contentLower = chunk.content.toLowerCase();
    const tokens = contentLower.split(/\s+/);
    const tokenFreq = {};
    for (const t of tokens) {
      tokenFreq[t] = (tokenFreq[t] || 0) + 1;
    }

    for (const qToken of queryTokens) {
      const tf = tokenFreq[qToken] || 0;
      const df = docFreq[qToken] || 1;
      const idf = Math.log(totalDocs / df) + 1;
      score += tf * idf;

      // 标题和关键词匹配加分
      if (chunk.documentTitle && chunk.documentTitle.toLowerCase().includes(qToken)) {
        score += 5 * idf;
      }
      if (chunk.keywords && chunk.keywords.toLowerCase().includes(qToken)) {
        score += 3 * idf;
      }
    }

    // 额外：如果 chunk 内容包含完整查询短语，大幅加分
    if (contentLower.includes(queryTokens.join(' '))) {
      score += 10;
    }

    scores.push({ chunk, score });
  }

  return scores.sort((a, b) => b.score - a.score);
}

// ── 核心 API ──

function createKnowledgeBase(title, description, category, createdBy) {
  if (!title || !title.trim()) {
    throw new Error('知识库标题不能为空');
  }
  const now = dayjs().toISOString();
  const result = db
    .prepare('INSERT INTO knowledge_bases (title, description, category, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(title.trim(), description || '', category || '', createdBy, now);
  return result.lastInsertRowid;
}

function getKnowledgeBase(id) {
  return db.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(id) || null;
}

function listKnowledgeBases(createdBy) {
  if (createdBy) {
    return db
      .prepare('SELECT * FROM knowledge_bases WHERE created_by = ? ORDER BY created_at DESC')
      .all(createdBy);
  }
  return db.prepare('SELECT * FROM knowledge_bases ORDER BY created_at DESC').all();
}

function deleteKnowledgeBase(id) {
  // 级联删除由外键约束处理
  db.prepare('DELETE FROM knowledge_bases WHERE id = ?').run(id);
  return true;
}

function parseDocument(filePath, fileType) {
  const ext = (fileType || path.extname(filePath) || '').toLowerCase().replace(/^\./, '');

  // txt / md / json / csv / js / ts / py / html / css / xml / yaml / yml
  const textExts = ['txt', 'md', 'markdown', 'json', 'csv', 'js', 'ts', 'py', 'html', 'htm', 'css', 'xml', 'yaml', 'yml', 'log', 'ini', 'conf', 'config', 'sh', 'bat', 'ps1', 'sql', 'c', 'cpp', 'h', 'hpp', 'java', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'scala', 'r', 'm', 'matlab', 'lua', 'pl', 'pm', 't', 'tex', 'bib'];

  if (textExts.includes(ext)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      // 简单去除 markdown 标记
      if (ext === 'md' || ext === 'markdown') {
        return raw
          .replace(/!\[.*?\]\(.*?\)/g, '') // 图片
          .replace(/\[.*?\]\(.*?\)/g, '$1') // 链接
          .replace(/#{1,6}\s+/g, '') // 标题
          .replace(/(\*\*|__)(.*?)\1/g, '$2') // 粗体
          .replace(/(\*|_)(.*?)\1/g, '$2') // 斜体
          .replace(/`{1,3}.*?`{1,3}/gs, '') // 代码
          .replace(/```[\s\S]*?```/g, '') // 代码块
          .replace(/\|/g, ' ') // 表格
          .replace(/-{3,}/g, '') // 分隔线
          .replace(/>\s?/g, '') // 引用
          .replace(/-\s+|\*\s+|\d+\.\s+/g, '') // 列表
          .trim();
      }
      return raw;
    } catch (e) {
      console.error('[knowledgeBase] 读取文本文件失败:', filePath, e.message);
      return '';
    }
  }

  // docx: 使用简单的 unzip + xml 解析（无需外部依赖）
  if (ext === 'docx') {
    try {
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(filePath);
      const documentXml = zip.readAsText('word/document.xml');
      // 提取 <w:t> 标签中的文本
      const texts = [];
      const regex = /<w:t[^>]*>([^<]*)<\/w:t>/g;
      let match;
      while ((match = regex.exec(documentXml)) !== null) {
        texts.push(match[1]);
      }
      return texts.join('');
    } catch (e) {
      console.error('[knowledgeBase] 解析 docx 失败:', filePath, e.message);
      return '';
    }
  }

  // pdf: 使用 pdf-parse（如果已安装）
  if (ext === 'pdf') {
    try {
      const pdfParse = require('pdf-parse');
      const dataBuffer = fs.readFileSync(filePath);
      const data = pdfParse(dataBuffer);
      return data.text || '';
    } catch (e) {
      console.error('[knowledgeBase] 解析 pdf 失败（请安装 pdf-parse）:', filePath, e.message);
      return '';
    }
  }

  // doc: 旧版 doc 解析较复杂，提示待实现
  if (ext === 'doc') {
    console.warn('[knowledgeBase] .doc 格式解析暂未实现，请转换为 .docx 或 .txt 后上传');
    return '';
  }

  console.warn('[knowledgeBase] 不支持的文件类型:', ext);
  return '';
}

function uploadDocument(baseId, title, filePath, fileType) {
  const base = getKnowledgeBase(baseId);
  if (!base) {
    throw new Error('知识库不存在');
  }
  if (!title || !title.trim()) {
    throw new Error('文档标题不能为空');
  }
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('文件不存在');
  }

  const stats = fs.statSync(filePath);
  const now = dayjs().toISOString();
  const result = db
    .prepare('INSERT INTO knowledge_documents (base_id, title, file_path, file_type, file_size, parsed_text, chunk_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(baseId, title.trim(), filePath, fileType || path.extname(filePath), stats.size, '', 0, now);

  return result.lastInsertRowid;
}

async function chunkDocument(documentId, text) {
  const doc = db.prepare('SELECT * FROM knowledge_documents WHERE id = ?').get(documentId);
  if (!doc) {
    throw new Error('文档不存在');
  }

  const chunks = chunkTextByParagraphs(text, 800, 100);
  if (!chunks.length) {
    // 更新文档 parsed_text 为空
    db.prepare('UPDATE knowledge_documents SET parsed_text = ?, chunk_count = 0 WHERE id = ?').run('', documentId);
    return 0;
  }

  const now = dayjs().toISOString();
  const insertChunk = db.prepare(`
    INSERT INTO knowledge_chunks (document_id, base_id, chunk_index, content, content_length, keywords, embedding, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // 预先生成所有 chunk 的 embedding（并行请求）
  const embeddings = await Promise.all(
    chunks.map((content) => ai.generateEmbedding(content).catch((err) => {
      console.warn('[knowledgeBase] embedding 生成失败:', err.message);
      return null;
    }))
  );

  // 使用事务批量插入
  const insertMany = db.transaction((chunkList) => {
    for (let i = 0; i < chunkList.length; i++) {
      const content = chunkList[i];
      const keywords = generateKeywords(content);
      const embedding = embeddings[i] ? JSON.stringify(embeddings[i]) : '';
      insertChunk.run(documentId, doc.base_id, i, content, content.length, keywords, embedding, now);
    }
  });

  insertMany(chunks);

  // 更新文档的 parsed_text 和 chunk_count
  db.prepare('UPDATE knowledge_documents SET parsed_text = ?, chunk_count = ? WHERE id = ?').run(text, chunks.length, documentId);

  // 如果 FTS5 可用，同步数据
  try {
    const ftsExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_chunks_fts'").get();
    if (ftsExists) {
      // 先删除旧数据
      db.prepare('DELETE FROM knowledge_chunks_fts WHERE rowid IN (SELECT id FROM knowledge_chunks WHERE document_id = ?)').run(documentId);
      // 插入新数据
      const allChunks = db.prepare('SELECT id, content, keywords FROM knowledge_chunks WHERE document_id = ?').all(documentId);
      const insertFts = db.prepare('INSERT INTO knowledge_chunks_fts (rowid, content, keywords) VALUES (?, ?, ?)');
      const insertFtsMany = db.transaction((rows) => {
        for (const row of rows) {
          insertFts.run(row.id, row.content, row.keywords);
        }
      });
      insertFtsMany(allChunks);
    }
  } catch (e) {
    // FTS 同步失败不影响主流程
    console.warn('[knowledgeBase] FTS5 同步失败:', e.message);
  }

  return chunks.length;
}

function searchChunks(baseId, query, topK = 5) {
  if (!query || !query.trim()) {
    return [];
  }

  const queryText = query.trim().toLowerCase();
  const queryTokens = queryText
    .replace(/[^一-龥a-z0-9]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);

  if (!queryTokens.length) {
    // 如果分词后没有有效 token，尝试直接用原始查询
    queryTokens.push(queryText);
  }

  // 先尝试 FTS5 搜索
  let chunkRows = [];
  try {
    const ftsExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_chunks_fts'").get();
    if (ftsExists) {
      const ftsQuery = queryTokens.map((t) => `"${t}"`).join(' OR ');
      chunkRows = db.prepare(`
        SELECT kc.*, kd.title as document_title
        FROM knowledge_chunks_fts
        JOIN knowledge_chunks kc ON kc.id = knowledge_chunks_fts.rowid
        JOIN knowledge_documents kd ON kd.id = kc.document_id
        WHERE knowledge_chunks_fts MATCH ? AND kc.base_id = ?
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, baseId, topK * 2);
    }
  } catch (e) {
    // FTS 搜索失败，回退到 LIKE
    console.warn('[knowledgeBase] FTS5 搜索失败，回退到 LIKE:', e.message);
  }

  // 如果 FTS 没有结果或不可用，使用 LIKE 匹配
  if (!chunkRows.length) {
    const conditions = queryTokens.map(() => '(kc.content LIKE ? OR kc.keywords LIKE ? OR kd.title LIKE ?)').join(' OR ');
    const params = [];
    for (const token of queryTokens) {
      const like = `%${token}%`;
      params.push(like, like, like);
    }
    params.push(baseId);

    chunkRows = db.prepare(`
      SELECT kc.*, kd.title as document_title
      FROM knowledge_chunks kc
      JOIN knowledge_documents kd ON kd.id = kc.document_id
      WHERE (${conditions}) AND kc.base_id = ?
      ORDER BY kc.created_at DESC
      LIMIT ?
    `).all(...params, topK * 3);
  }

  if (!chunkRows.length) {
    return [];
  }

  // 计算 TF-IDF 分数并排序
  const chunks = chunkRows.map((row) => ({
    id: row.id,
    documentId: row.document_id,
    baseId: row.base_id,
    chunkIndex: row.chunk_index,
    content: row.content,
    contentLength: row.content_length,
    keywords: row.keywords,
    documentTitle: row.document_title,
    createdAt: row.created_at
  }));

  const scored = computeTfIdfScores(chunks, queryTokens);
  return scored.slice(0, topK).map((s) => ({
    ...s.chunk,
    score: Math.round(s.score * 100) / 100
  }));
}

function getDocumentChunks(documentId) {
  return db
    .prepare('SELECT * FROM knowledge_chunks WHERE document_id = ? ORDER BY chunk_index ASC')
    .all(documentId);
}

function deleteDocument(documentId) {
  db.prepare('DELETE FROM knowledge_documents WHERE id = ?').run(documentId);
  return true;
}

function getKnowledgeBaseStats(baseId) {
  const docCount = db.prepare('SELECT COUNT(*) as count FROM knowledge_documents WHERE base_id = ?').get(baseId).count;
  const chunkCount = db.prepare('SELECT COUNT(*) as count FROM knowledge_chunks WHERE base_id = ?').get(baseId).count;
  const totalSize = db.prepare('SELECT COALESCE(SUM(file_size), 0) as total FROM knowledge_documents WHERE base_id = ?').get(baseId).total;
  return { documentCount: docCount, chunkCount, totalSize };
}

/**
 * 计算两个向量的余弦相似度
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * 向量语义搜索：对 query 生成 embedding，与知识库 chunks 的 embedding 计算余弦相似度
 * 如果向量检索失败或没有向量数据，自动回退到关键词搜索
 * @param {number} baseId
 * @param {string} query
 * @param {number} topK
 * @returns {Promise<Array>}
 */
async function searchByVector(baseId, query, topK = 5) {
  if (!query || !query.trim()) {
    return [];
  }

  const trimmedQuery = query.trim();

  // 1. 查询该知识库下所有带 embedding 的 chunks
  const rows = db.prepare(`
    SELECT kc.id, kc.document_id, kc.base_id, kc.chunk_index, kc.content, kc.content_length, kc.keywords, kc.embedding, kd.title as document_title
    FROM knowledge_chunks kc
    JOIN knowledge_documents kd ON kd.id = kc.document_id
    WHERE kc.base_id = ? AND kc.embedding IS NOT NULL AND kc.embedding != ''
  `).all(baseId);

  // 2. 如果没有向量数据，直接回退到关键词搜索
  if (!rows.length) {
    return searchChunks(baseId, trimmedQuery, topK);
  }

  // 3. 获取查询向量
  let queryEmbedding;
  try {
    const embeddings = await ai.getEmbedding(trimmedQuery);
    queryEmbedding = embeddings && embeddings[0] ? embeddings[0] : null;
  } catch (e) {
    console.warn('[knowledgeBase] 获取查询 embedding 失败，回退到关键词搜索:', e.message);
    return searchChunks(baseId, trimmedQuery, topK);
  }

  if (!queryEmbedding) {
    return searchChunks(baseId, trimmedQuery, topK);
  }

  // 4. 计算每个 chunk 的相似度
  const scored = [];
  for (const row of rows) {
    try {
      const chunkEmbedding = JSON.parse(row.embedding);
      if (!Array.isArray(chunkEmbedding) || chunkEmbedding.length === 0) continue;
      const score = cosineSimilarity(queryEmbedding, chunkEmbedding);
      if (score > 0) {
        scored.push({
          id: row.id,
          documentId: row.document_id,
          baseId: row.base_id,
          chunkIndex: row.chunk_index,
          content: row.content,
          contentLength: row.content_length,
          keywords: row.keywords,
          documentTitle: row.document_title,
          createdAt: row.created_at,
          score: Math.round(score * 1000) / 1000
        });
      }
    } catch (e) {
      // 单个 chunk 解析失败，跳过
    }
  }

  // 5. 按相似度排序并取 Top-K
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

module.exports = {
  createKnowledgeBase,
  getKnowledgeBase,
  listKnowledgeBases,
  deleteKnowledgeBase,
  uploadDocument,
  parseDocument,
  chunkDocument,
  searchChunks,
  searchByVector,
  getDocumentChunks,
  deleteDocument,
  getKnowledgeBaseStats
};
