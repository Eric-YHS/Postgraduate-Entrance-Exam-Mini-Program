// 一次性生成脚本：从前端 src/App.jsx 中提取 3 套入学摸底试卷（entry-politics / entry-english / entry-math，
// 每套 50 道单选题），生成 db/migrations/020_seed_entrance.sql，保证“分发试卷”开箱可用。
// 用法：在 server 目录执行 `node scripts/generate-entrance-seed.mjs`。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSource = fs.readFileSync(path.resolve(serverRoot, '../src/App.jsx'), 'utf8');

const startMarker = 'const RAW_ENTRANCE_PAPERS = [';
const endMarker = 'const loadEntrancePapers';
const start = appSource.indexOf(startMarker);
const end = appSource.indexOf(endMarker);
if (start < 0 || end < 0 || end <= start) throw new Error('未能在 App.jsx 中定位试卷数据块');
const block = appSource.slice(start, end);

// 数据块为纯字面量与辅助函数（numberQuestions / POLITICS_SUPPLEMENT / MATH_SUPPLEMENT / ENTRANCE_PAPERS）。
const ENTRANCE_PAPERS = new Function(`${block}\nreturn ENTRANCE_PAPERS;`)();
if (!Array.isArray(ENTRANCE_PAPERS) || ENTRANCE_PAPERS.length !== 3) throw new Error('试卷数据解析失败');

// 与前端 flattenPaperQuestions 一致：英语按 实词辨析/语法/英译中 三段展开。
const flattenPaperQuestions = paper => {
  const result = [];
  if (paper.sections.政治) paper.sections.政治.forEach(question => result.push({ ...question, subject: '政治', prompt: question.prompt }));
  if (paper.sections.英语) {
    paper.sections.英语.vocabulary.forEach(question => result.push({ ...question, subject: '英语', prompt: question.word, knowledgePoint: '实词辨析' }));
    paper.sections.英语.grammar.forEach(question => result.push({ ...question, subject: '英语', prompt: question.sentence, knowledgePoint: '语法填空' }));
    paper.sections.英语.translation.forEach(question => result.push({ ...question, subject: '英语', prompt: question.sentence, knowledgePoint: '英译中' }));
  }
  if (paper.sections.数学) paper.sections.数学.forEach(question => result.push({ ...question, subject: '数学', prompt: question.prompt }));
  return result;
};

// 确定性 UUID：同一试卷同一题序多次生成结果一致，配合 ON CONFLICT 保证迁移可安全重放。
const questionUuid = (paperId, itemIndex) => {
  const hex = crypto.createHash('md5').update(`shangan-entrance-seed:${paperId}:${itemIndex}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const sqlText = value => `'${String(value ?? '').replace(/'/g, "''")}'`;
const sqlJson = value => `${sqlText(JSON.stringify(value))}::jsonb`;

const lines = [
  '-- 入学摸底试卷种子：与前端 src/App.jsx 内置的 3 套试卷（entry-politics / entry-english / entry-math）一致，',
  '-- 由 server/scripts/generate-entrance-seed.mjs 生成；题目 ID 为确定性 UUID，可安全重复执行。',
  ''
];

for (const paper of ENTRANCE_PAPERS) {
  const questions = flattenPaperQuestions(paper);
  if (questions.length !== 50) throw new Error(`试卷 ${paper.id} 题目数为 ${questions.length}，预期 50`);
  lines.push(`INSERT INTO entrance_papers(id,title,state,duration_minutes) VALUES(${sqlText(paper.id)},${sqlText(paper.title)},'已发布',60)`);
  lines.push(`  ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,state=EXCLUDED.state,duration_minutes=EXCLUDED.duration_minutes,updated_at=now();`);
  questions.forEach((question, itemIndex) => {
    const id = questionUuid(paper.id, itemIndex);
    const options = (question.options || []).map((text, optionIndex) => ({ key: String.fromCharCode(65 + optionIndex), text: String(text) }));
    const snapshot = {
      subject: question.subject,
      questionType: 'single_choice',
      stem: String(question.prompt || ''),
      options,
      correctAnswer: String(question.answer || 'A'),
      score: 2,
      analysis: String(question.knowledge || ''),
      knowledgePoint: String(question.knowledgePoint || question.knowledge || '')
    };
    lines.push(`INSERT INTO entrance_questions(id,subject,question_type,stem,options,correct_answer,score,analysis,knowledge_point,state) VALUES(${sqlText(id)},${sqlText(snapshot.subject)},'single_choice',${sqlText(snapshot.stem)},${sqlJson(options)},${sqlJson(snapshot.correctAnswer)},2,${sqlText(snapshot.analysis)},${sqlText(snapshot.knowledgePoint)},'已发布')`);
    lines.push(`  ON CONFLICT(id) DO UPDATE SET subject=EXCLUDED.subject,stem=EXCLUDED.stem,options=EXCLUDED.options,correct_answer=EXCLUDED.correct_answer,score=EXCLUDED.score,analysis=EXCLUDED.analysis,knowledge_point=EXCLUDED.knowledge_point,state=EXCLUDED.state,updated_at=now();`);
    lines.push(`INSERT INTO entrance_paper_items(paper_id,question_id,item_index,question_snapshot) VALUES(${sqlText(paper.id)},${sqlText(id)},${itemIndex},${sqlJson(snapshot)})`);
    lines.push(`  ON CONFLICT(paper_id,item_index) DO UPDATE SET question_id=EXCLUDED.question_id,question_snapshot=EXCLUDED.question_snapshot;`);
  });
  lines.push('');
}

const target = path.resolve(serverRoot, 'db/migrations/020_seed_entrance.sql');
fs.writeFileSync(target, `${lines.join('\n')}\n`);
console.log(`已生成 ${target}（${ENTRANCE_PAPERS.map(paper => `${paper.id}:50 题`).join('，')}）`);
