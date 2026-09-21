import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { planTemplateDto, planTemplatePayloadSchema, planTemplateRowDto, planTemplateRowDtos, planTemplateRowRecord, planTemplateSubjectSchema, planTemplateUpdateSchema } from '../src/core.js';

const readIndex = () => fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const PLAN_TEMPLATE_SUBJECTS_FROM_SCHEMA = () => planTemplateSubjectSchema.options;

test('plan template schema restricts subjects to the four template categories', () => {
  assert.deepEqual(PLAN_TEMPLATE_SUBJECTS_FROM_SCHEMA(), ['政治', '英语', '数学', '专业课']);
  assert.equal(planTemplateSubjectSchema.parse('政治'), '政治');
  assert.throws(() => planTemplateSubjectSchema.parse('物理'));
  assert.throws(() => planTemplateSubjectSchema.parse('英语一'));
});

test('plan template payload validates create shape and trims fields', () => {
  const parsed = planTemplatePayloadSchema.parse({
    subject: '数学',
    name: '  高数基础 30 天  ',
    category: '基础',
    columns: ['任务1', '任务2'],
    rows: [
      { day: ' 第一天 ', tasks: [' 极限导论 ', ''], note: ' 基础概念 ' },
      { day: '第二天', tasks: ['极限计算'] }
    ]
  });
  assert.equal(parsed.name, '高数基础 30 天');
  assert.deepEqual(parsed.rows[0], { day: '第一天', tasks: ['极限导论', ''], note: '基础概念' });
  assert.equal(parsed.rows[1].note, '');
  assert.throws(() => planTemplatePayloadSchema.parse({ subject: '数学', name: '', category: '基础' }));
  assert.throws(() => planTemplatePayloadSchema.parse({ subject: '数学', name: 'x', category: '基础', extra: true }));
});

test('plan template update schema forbids subject changes', () => {
  const parsed = planTemplateUpdateSchema.parse({ name: '改名', category: '冲刺', columns: [], rows: [] });
  assert.equal(parsed.subject, undefined);
  assert.throws(() => planTemplateUpdateSchema.parse({ name: '改名', category: '冲刺', subject: '英语' }));
});

test('plan template rows round-trip day/tasks/note through the jsonb record', () => {
  const rows = [
    { day: '第一天', tasks: ['马原导论', ''], note: '基础概念', attachments: [{ id: 'local-only' }] },
    { day: '第二天', tasks: ['史纲时间线'], note: '' }
  ];
  const records = planTemplateRowDtos(rows);
  assert.equal(records.length, 2);
  assert.deepEqual(records[0], { title: '第一天', tasks: { tasks: ['马原导论', ''], note: '基础概念' } });
  const dtos = records.map(planTemplateRowDto);
  assert.deepEqual(dtos[0], { day: '第一天', tasks: ['马原导论', ''], note: '基础概念' });
  assert.deepEqual(dtos[1], { day: '第二天', tasks: ['史纲时间线'], note: '' });
  assert.equal(planTemplateRowRecord(rows[0], 5).rowIndex, 5);
});

test('plan template row dto tolerates legacy array-shaped tasks payloads', () => {
  assert.deepEqual(planTemplateRowDto({ title: '第三天', tasks: ['单词 80 个'] }), { day: '第三天', tasks: ['单词 80 个'], note: '' });
  assert.deepEqual(planTemplateRowDto({ title: null, tasks: null }), { day: '', tasks: [], note: '' });
});

test('plan template dto exposes id/subject/name/category/columns/rows', () => {
  const dto = planTemplateDto(
    { id: 't1', subject: '政治', name: '政治复习计划', category: '基础', columns: ['任务1'], state: '已发布', created_at: 'c', updated_at: 'u' },
    [{ title: '第一天', tasks: { tasks: ['马原导论'], note: 'n' } }]
  );
  assert.deepEqual(dto, {
    id: 't1', subject: '政治', name: '政治复习计划', category: '基础',
    columns: ['任务1'], rows: [{ day: '第一天', tasks: ['马原导论'], note: 'n' }],
    state: '已发布', createdAt: 'c', updatedAt: 'u'
  });
});

test('plan template admin routes enforce staff roles and idempotent writes', async () => {
  const source = await readIndex();
  for (const route of [
    "app.get('/api/admin/plan-templates'",
    "app.post('/api/admin/plan-templates'",
    "app.put('/api/admin/plan-templates/:id'",
    "app.delete('/api/admin/plan-templates/:id'"
  ]) {
    assert.ok(source.includes(route), `缺少路由 ${route}`);
  }
  const block = source.slice(source.indexOf("app.get('/api/admin/plan-templates'"));
  const planBlock = block.slice(0, block.indexOf("app.get('/api/students/:id/plans'"));
  assert.equal(planBlock.match(/requireRoles\(\['admin','teacher'\]\)/g).length, 4, '四个接口都必须限定 admin+teacher');
  assert.equal(planBlock.match(/withIdempotency\(async request/g).length, 3, 'POST/PUT/DELETE 必须走幂等');
  assert.equal(planBlock.match(/statusCode: 404/g).length, 2, 'PUT/DELETE 必须对不存在的模板返回 404');
});

test('plan template routes implement the create-list-update-delete lifecycle in transactions', async () => {
  const source = await readIndex();
  assert.match(source, /SELECT id,subject,name,category,columns,state,created_by,created_at,updated_at FROM plan_templates/);
  assert.match(source, /SELECT template_id,title,tasks FROM plan_template_rows WHERE template_id=ANY\(\$1::uuid\[\]\) ORDER BY row_index/);
  assert.match(source, /INSERT INTO plan_templates\(subject,name,category,state,columns,created_by\) VALUES\(\$1,\$2,\$3,'已发布',\$4,\$5\)/);
  assert.match(source, /INSERT INTO plan_template_rows\(template_id,row_index,title,tasks\) VALUES\(\$1,\$2,\$3,\$4\)/);
  assert.match(source, /UPDATE plan_templates SET name=\$1,category=\$2,columns=\$3,updated_at=now\(\) WHERE id=\$4/);
  assert.match(source, /DELETE FROM plan_template_rows WHERE template_id=\$1/);
  assert.match(source, /DELETE FROM plan_templates WHERE id=\$1 RETURNING id/);
  assert.match(source, /'创建复习计划模板', 'plan_template'/);
  assert.match(source, /'更新复习计划模板', 'plan_template'/);
  assert.match(source, /'删除复习计划模板', 'plan_template'/);
});

test('migration 028 adds the columns jsonb column to plan_templates', async () => {
  const migration = await fs.readFile(new URL('../db/migrations/028_plan_template_columns.sql', import.meta.url), 'utf8');
  assert.match(migration, /ALTER TABLE plan_templates ADD COLUMN IF NOT EXISTS columns jsonb NOT NULL DEFAULT '\[\]'::jsonb/);
});
