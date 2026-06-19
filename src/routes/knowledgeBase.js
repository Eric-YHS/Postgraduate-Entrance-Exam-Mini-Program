const dayjs = require('dayjs');

module.exports = function registerKnowledgeBaseRoutes(app, shared) {
  const { db, requireAdmin } = shared;

  // 列出所有知识库
  app.get('/api/admin/knowledge-bases', requireAdmin, (request, response) => {
    try {
      const rows = db.prepare(`
        SELECT kb.*, users.display_name AS creator_name
        FROM knowledge_bases kb
        LEFT JOIN users ON users.id = kb.created_by
        ORDER BY kb.created_at DESC
      `).all();
      response.json({
        knowledgeBases: rows.map((row) => ({
          id: row.id,
          title: row.title,
          description: row.description,
          category: row.category,
          createdBy: row.created_by,
          creatorName: row.creator_name,
          createdAt: row.created_at
        }))
      });
    } catch (error) {
      console.error('列出知识库失败:', error);
      response.status(500).json({ error: '列出知识库失败。' });
    }
  });

  // 创建知识库
  app.post('/api/admin/knowledge-bases', requireAdmin, (request, response) => {
    try {
      const { title, description, category } = request.body;
      if (!title || !title.trim()) {
        return response.status(400).json({ error: '知识库标题不能为空。' });
      }
      const now = dayjs().toISOString();
      const result = db.prepare(
        'INSERT INTO knowledge_bases (title, description, category, created_by, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(title.trim(), description || '', category || '', request.currentUser.id, now);
      response.json({ id: result.lastInsertRowid, title, description, category, createdAt: now });
    } catch (error) {
      console.error('创建知识库失败:', error);
      response.status(500).json({ error: '创建知识库失败。' });
    }
  });

  // 获取单个知识库详情（含文档列表）
  app.get('/api/admin/knowledge-bases/:id', requireAdmin, (request, response) => {
    try {
      const id = Number(request.params.id);
      const base = db.prepare(`
        SELECT kb.*, users.display_name AS creator_name
        FROM knowledge_bases kb
        LEFT JOIN users ON users.id = kb.created_by
        WHERE kb.id = ?
      `).get(id);
      if (!base) {
        return response.status(404).json({ error: '知识库不存在。' });
      }
      const documents = db.prepare(
        'SELECT id, title, file_path, file_type, file_size, chunk_count, created_at FROM knowledge_documents WHERE base_id = ? ORDER BY created_at DESC'
      ).all(id);
      response.json({
        id: base.id,
        title: base.title,
        description: base.description,
        category: base.category,
        createdBy: base.created_by,
        creatorName: base.creator_name,
        createdAt: base.created_at,
        documents: documents.map((doc) => ({
          id: doc.id,
          title: doc.title,
          filePath: doc.file_path,
          fileType: doc.file_type,
          fileSize: doc.file_size,
          chunkCount: doc.chunk_count,
          createdAt: doc.created_at
        }))
      });
    } catch (error) {
      console.error('获取知识库详情失败:', error);
      response.status(500).json({ error: '获取知识库详情失败。' });
    }
  });

  // 更新知识库
  app.put('/api/admin/knowledge-bases/:id', requireAdmin, (request, response) => {
    try {
      const id = Number(request.params.id);
      const { title, description, category } = request.body;
      const existing = db.prepare('SELECT id FROM knowledge_bases WHERE id = ?').get(id);
      if (!existing) {
        return response.status(404).json({ error: '知识库不存在。' });
      }
      db.prepare(
        'UPDATE knowledge_bases SET title = ?, description = ?, category = ? WHERE id = ?'
      ).run(title || '', description || '', category || '', id);
      response.json({ success: true });
    } catch (error) {
      console.error('更新知识库失败:', error);
      response.status(500).json({ error: '更新知识库失败。' });
    }
  });

  // 删除知识库（级联删除文档和 chunks）
  app.delete('/api/admin/knowledge-bases/:id', requireAdmin, (request, response) => {
    try {
      const id = Number(request.params.id);
      const existing = db.prepare('SELECT id FROM knowledge_bases WHERE id = ?').get(id);
      if (!existing) {
        return response.status(404).json({ error: '知识库不存在。' });
      }
      db.prepare('DELETE FROM knowledge_bases WHERE id = ?').run(id);
      response.json({ success: true });
    } catch (error) {
      console.error('删除知识库失败:', error);
      response.status(500).json({ error: '删除知识库失败。' });
    }
  });

  // 上传文档到知识库
  app.post('/api/admin/knowledge-bases/:id/documents', requireAdmin, (request, response) => {
    try {
      const baseId = Number(request.params.id);
      const { title, filePath, fileType } = request.body;
      if (!title || !title.trim()) {
        return response.status(400).json({ error: '文档标题不能为空。' });
      }
      const base = db.prepare('SELECT id FROM knowledge_bases WHERE id = ?').get(baseId);
      if (!base) {
        return response.status(404).json({ error: '知识库不存在。' });
      }
      const now = dayjs().toISOString();
      const result = db.prepare(
        'INSERT INTO knowledge_documents (base_id, title, file_path, file_type, file_size, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(baseId, title.trim(), filePath || '', fileType || '', 0, now);
      response.json({ id: result.lastInsertRowid, baseId, title, filePath, fileType, createdAt: now });
    } catch (error) {
      console.error('上传文档失败:', error);
      response.status(500).json({ error: '上传文档失败。' });
    }
  });

  // 删除知识库文档
  app.delete('/api/admin/knowledge-bases/:baseId/documents/:docId', requireAdmin, (request, response) => {
    try {
      const docId = Number(request.params.docId);
      const existing = db.prepare('SELECT id FROM knowledge_documents WHERE id = ?').get(docId);
      if (!existing) {
        return response.status(404).json({ error: '文档不存在。' });
      }
      db.prepare('DELETE FROM knowledge_documents WHERE id = ?').run(docId);
      response.json({ success: true });
    } catch (error) {
      console.error('删除文档失败:', error);
      response.status(500).json({ error: '删除文档失败。' });
    }
  });

  // 解析并切分文档（生成 chunks 和 embeddings）
  app.post('/api/admin/knowledge-bases/:baseId/documents/:docId/process', requireAdmin, async (request, response) => {
    try {
      const baseId = Number(request.params.baseId);
      const docId = Number(request.params.docId);
      const knowledgeBase = require('../services/knowledgeBase');

      const doc = db.prepare('SELECT * FROM knowledge_documents WHERE id = ? AND base_id = ?').get(docId, baseId);
      if (!doc) {
        return response.status(404).json({ error: '文档不存在或不在该知识库中。' });
      }

      const text = knowledgeBase.parseDocument(doc.file_path, doc.file_type);
      const chunkCount = await knowledgeBase.chunkDocument(docId, text);

      response.json({ success: true, documentId: docId, chunkCount });
    } catch (error) {
      console.error('处理文档失败:', error);
      response.status(500).json({ error: '处理文档失败：' + error.message });
    }
  });

  // 测试知识库搜索（admin 权限）
  app.post('/api/knowledge-bases/:id/test', requireAdmin, async (request, response) => {
    try {
      const baseId = Number(request.params.id);
      const { question, topK } = request.body;

      if (!question || !question.trim()) {
        return response.status(400).json({ error: 'question 不能为空。' });
      }

      const knowledgeBase = require('../services/knowledgeBase');
      const results = await knowledgeBase.searchByVector(baseId, question.trim(), Number(topK) || 5);

      response.json({
        question: question.trim(),
        results: results.map((r) => ({
          content: r.content,
          score: r.score,
          documentTitle: r.documentTitle
        }))
      });
    } catch (error) {
      console.error('知识库测试搜索失败:', error);
      response.status(500).json({ error: '知识库测试搜索失败。' });
    }
  });
};
