const fs = require('fs');
const path = require('path');
const {
  db,
  getAgent,
  createUser,
  loginAs
} = require('./helper');
const ai = require('../src/services/ai');

let sequence = 0;
function unique(prefix) {
  sequence += 1;
  return `${prefix}_${Date.now()}_${sequence}`;
}

describe('知识库上传、解析与检索', () => {
  let embeddingSpy;
  let queryEmbeddingSpy;

  beforeEach(() => {
    embeddingSpy = jest.spyOn(ai, 'generateEmbedding').mockResolvedValue([1, 0, 0]);
    queryEmbeddingSpy = jest.spyOn(ai, 'getEmbedding').mockResolvedValue([[1, 0, 0]]);
  });

  afterEach(() => {
    embeddingSpy.mockRestore();
    queryEmbeddingSpy.mockRestore();
  });

  test('原始 XLS 经通用上传加入知识库，可处理、搜索且重复处理不重复分块', async () => {
    const admin = createUser({ username: unique('kb_admin'), password: 'admin123', role: 'admin', displayName: '知识库管理员' });
    const agent = getAgent();
    await loginAs(agent, admin.username, 'admin123');

    const created = await agent.post('/api/admin/knowledge-bases').send({
      title: '考研词汇知识库', description: '表4验收', category: '英语'
    }).expect(200);
    const baseId = Number(created.body.id);
    const workbookPath = path.join(__dirname, '..', '技术要求', '技术要求', '表4.xls');
    const upload = await agent.post('/api/upload').attach('file', workbookPath).expect(200);
    expect(upload.body.data.url).toMatch(/^\/uploads\//);

    const document = await agent.post(`/api/admin/knowledge-bases/${baseId}/documents`).send({
      title: '表4词汇', filePath: upload.body.data.url, fileType: 'xls'
    }).expect(200);
    const docId = Number(document.body.id);
    await agent.post(`/api/admin/knowledge-bases/${baseId}/documents/${docId}/process`).expect(200);
    const firstCount = db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunks WHERE document_id = ?').get(docId).count;
    expect(firstCount).toBeGreaterThan(0);

    const search = await agent.post(`/api/knowledge-bases/${baseId}/test`).send({ question: 'difficult 困难的', topK: 3 }).expect(200);
    expect(search.body.results[0]).toEqual(expect.objectContaining({ documentTitle: '表4词汇' }));
    expect(search.body.results[0].content).toContain('difficult');

    await agent.post(`/api/admin/knowledge-bases/${baseId}/documents/${docId}/process`).expect(200);
    const secondCount = db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunks WHERE document_id = ?').get(docId).count;
    expect(secondCount).toBe(firstCount);

    const detail = await agent.get(`/api/admin/knowledge-bases/${baseId}`).expect(200);
    expect(detail.body.base.title).toBe('考研词汇知识库');
    expect(detail.body.documents[0].chunkCount).toBe(firstCount);
    const list = await agent.get('/api/admin/knowledge-bases').expect(200);
    const listed = list.body.bases.find((item) => Number(item.id) === baseId);
    expect(listed).toEqual(expect.objectContaining({ documentCount: 1, chunkCount: firstCount }));

    const uploadedAbsolute = path.join(__dirname, '..', upload.body.data.url.replace(/^\/uploads\//, 'uploads/'));
    if (fs.existsSync(uploadedAbsolute)) fs.unlinkSync(uploadedAbsolute);
  });

  test('文档引用严格限制在上传根目录，且文档删除必须属于对应知识库', async () => {
    const admin = createUser({ username: unique('kb_scope_admin'), password: 'admin123', role: 'admin', displayName: '知识库管理员' });
    const agent = getAgent();
    await loginAs(agent, admin.username, 'admin123');
    const first = await agent.post('/api/admin/knowledge-bases').send({ title: '库一' }).expect(200);
    const second = await agent.post('/api/admin/knowledge-bases').send({ title: '库二' }).expect(200);
    await agent.post(`/api/admin/knowledge-bases/${first.body.id}/documents`).send({
      title: '越界文件', filePath: path.join(__dirname, '..', 'package.json'), fileType: 'txt'
    }).expect(400);
    await agent.post(`/api/admin/knowledge-bases/${first.body.id}/documents`).send({
      title: '目录穿越', filePath: '/uploads/../package.json', fileType: 'txt'
    }).expect(400);

    const workbookPath = path.join(__dirname, '..', '技术要求', '技术要求', '表4.xls');
    const upload = await agent.post('/api/upload').attach('file', workbookPath).expect(200);
    const document = await agent.post(`/api/admin/knowledge-bases/${first.body.id}/documents`).send({
      title: '归属库一', filePath: upload.body.data.url, fileType: 'xls'
    }).expect(200);
    await agent.delete(`/api/admin/knowledge-bases/${second.body.id}/documents/${document.body.id}`).expect(404);
    expect(db.prepare('SELECT id FROM knowledge_documents WHERE id = ?').get(document.body.id)).toBeTruthy();
  });
});
