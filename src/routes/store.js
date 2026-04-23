const dayjs = require('dayjs');
const { sanitizeText, stripHtml } = require('../utils/sanitize');

module.exports = function registerStoreRoutes(app, shared) {
  const { db, requireAuth, requireStudent, requireTeacher, toPublicPath, productUpload, safeJsonParse } = shared;

  // 创建商品
  app.post('/api/products', requireTeacher, (request, response) => {
    productUpload(request, response, (error) => {
      if (error) {
        response.status(400).json({ error: '商品上传失败。' });
        return;
      }

      const title = sanitizeText(request.body.title);
      const price = Number(request.body.price || 0);
      const stock = Number(request.body.stock || 0);

      if (!title || Number.isNaN(price) || price <= 0 || Number.isNaN(stock) || stock < 0) {
        response.status(400).json({ error: '请完整填写商品标题、价格与库存。' });
        return;
      }

      const productResult = db.prepare(
        `
          INSERT INTO products (title, description, price, stock, image_path, category, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
      ).run(
        title,
        sanitizeText(request.body.description),
        price,
        stock,
        request.file ? toPublicPath(request.file.path) : '',
        sanitizeText(request.body.category || ''),
        request.currentUser.id,
        dayjs().toISOString()
      );

      response.json({ ok: true, id: productResult.lastInsertRowid });
    });
  });

  // 下单
  app.post('/api/orders', requireStudent, (request, response) => {
    const productId = Number(request.body.productId);
    const rawQuantity = request.body.quantity !== undefined ? request.body.quantity : 1;
    const quantity = Number(rawQuantity);
    const shippingAddress = sanitizeText(request.body.shippingAddress);
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);

    if (!product) {
      response.status(404).json({ error: '商品不存在。' });
      return;
    }

    if (!shippingAddress || Number.isNaN(quantity) || quantity <= 0 || !Number.isInteger(quantity)) {
      response.status(400).json({ error: '请填写有效的正整数数量和收货地址。' });
      return;
    }

    // BUG-015: 使用分计算避免浮点精度问题
    const totalAmount = Math.round(product.price * 100 * quantity) / 100;
    const now = dayjs().toISOString();
    const transaction = db.transaction(() => {
      const stockResult = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?').run(quantity, productId, quantity);
      if (!stockResult.changes) {
        throw new Error('库存不足。');
      }
      db.prepare(
        `
          INSERT INTO orders (product_id, student_id, quantity, total_amount, shipping_address, status, created_at)
          VALUES (?, ?, ?, ?, ?, 'paid', ?)
        `
      ).run(productId, request.currentUser.id, quantity, totalAmount, shippingAddress, now);
    });

    try {
      transaction();
    } catch (error) {
      response.status(400).json({ error: error.message || '库存不足。' });
      return;
    }
    response.json({ ok: true });
  });

  // 订单状态更新（教师）
  app.post('/api/orders/:id/status', requireTeacher, (request, response) => {
    const { status } = request.body;
    const allowed = ['paid', 'shipped', 'delivered', 'confirmed', 'cancelled'];
    if (!allowed.includes(status)) {
      response.status(400).json({ error: '无效的订单状态。' });
      return;
    }
    // BUG-09: 取消订单时回滚库存 + BUG-14: 校验教师所有权
    const order = db.prepare('SELECT o.*, p.created_by FROM orders o JOIN products p ON p.id = o.product_id WHERE o.id = ?').get(request.params.id);
    if (!order) { response.status(404).json({ error: '订单不存在。' }); return; }
    if (order.created_by !== request.currentUser.id) { response.status(403).json({ error: '无权操作此订单。' }); return; }
    if (status === 'cancelled' && order.status !== 'cancelled') {
      db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(order.quantity, order.product_id);
    }
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, request.params.id);
    response.json({ ok: true });
  });

  // 学生确认收货
  app.post('/api/orders/:id/confirm', requireStudent, (request, response) => {
    const result = db.prepare('UPDATE orders SET status = ? WHERE id = ? AND student_id = ? AND status = ?')
      .run('confirmed', request.params.id, request.currentUser.id, 'delivered');
    if (!result.changes) { response.status(400).json({ error: '订单状态不正确。' }); return; }
    response.json({ ok: true });
  });

  // 购物车
  app.get('/api/cart', requireStudent, (request, response) => {
    const items = db.prepare(
      `SELECT shopping_cart.*, products.title, products.price, products.image_path, products.stock
       FROM shopping_cart
       LEFT JOIN products ON products.id = shopping_cart.product_id
       WHERE shopping_cart.student_id = ? ORDER BY shopping_cart.created_at DESC`
    ).all(request.currentUser.id);
    response.json({ items });
  });

  app.post('/api/cart', requireStudent, (request, response) => {
    const productId = Number(request.body.productId);
    const quantity = Number(request.body.quantity) || 1;
    const product = db.prepare('SELECT id, stock FROM products WHERE id = ?').get(productId);
    if (!product) { response.status(404).json({ error: '商品不存在。' }); return; }
    quantity = Math.max(1, Math.floor(Number(quantity) || 1));
    db.prepare(
      `INSERT INTO shopping_cart (student_id, product_id, quantity, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(student_id, product_id) DO UPDATE SET quantity = MIN(excluded.quantity, ?)`
    ).run(request.currentUser.id, productId, quantity, dayjs().toISOString(), product.stock);
    response.json({ ok: true });
  });

  app.delete('/api/cart/:id', requireStudent, (request, response) => {
    db.prepare('DELETE FROM shopping_cart WHERE id = ? AND student_id = ?').run(request.params.id, request.currentUser.id);
    response.json({ ok: true });
  });

  app.post('/api/cart/checkout', requireStudent, (request, response) => {
    const addressId = Number(request.body.addressId);
    const address = db.prepare('SELECT * FROM address_book WHERE id = ? AND student_id = ?').get(addressId, request.currentUser.id);
    if (!address) { response.status(400).json({ error: '请选择收货地址。' }); return; }
    const cartItems = db.prepare(
      `SELECT shopping_cart.*, products.title AS product_title, products.price, products.stock
       FROM shopping_cart LEFT JOIN products ON products.id = shopping_cart.product_id
       WHERE shopping_cart.student_id = ?`
    ).all(request.currentUser.id);
    if (!cartItems.length) { response.status(400).json({ error: '购物车为空。' }); return; }

    const insertOrder = db.prepare(
      `INSERT INTO orders (product_id, student_id, quantity, total_amount, shipping_address, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'paid', ?)`
    );
    const updateStock = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?');
    const clearCart = db.prepare('DELETE FROM shopping_cart WHERE student_id = ?');

    const txn = db.transaction(() => {
      let created = 0;
      for (const item of cartItems) {
        if (item.stock < item.quantity) throw new Error(`${item.product_title} 库存不足。`);
        const totalCents = Math.round(item.price * 100) * item.quantity;
        insertOrder.run(item.product_id, request.currentUser.id, item.quantity, totalCents / 100, address.address, dayjs().toISOString());
        updateStock.run(item.quantity, item.product_id, item.quantity);
        created++;
      }
      clearCart.run(request.currentUser.id);
      return created;
    });

    try {
      const count = txn();
      response.json({ ok: true, created: count });
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  // 地址簿
  app.get('/api/addresses', requireStudent, (request, response) => {
    const addresses = db.prepare('SELECT * FROM address_book WHERE student_id = ? ORDER BY is_default DESC, created_at DESC').all(request.currentUser.id);
    response.json({ addresses });
  });

  app.post('/api/addresses', requireStudent, (request, response) => {
    const name = sanitizeText(request.body.name);
    const address = sanitizeText(request.body.address);
    if (!name || !address) { response.status(400).json({ error: '请填写姓名和地址。' }); return; }
    if (request.body.isDefault) {
      db.prepare('UPDATE address_book SET is_default = 0 WHERE student_id = ?').run(request.currentUser.id);
    }
    db.prepare(
      'INSERT INTO address_book (student_id, name, phone, address, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(request.currentUser.id, name, sanitizeText(request.body.phone || ''), address, request.body.isDefault ? 1 : 0, dayjs().toISOString());
    response.json({ ok: true });
  });

  app.delete('/api/addresses/:id', requireStudent, (request, response) => {
    db.prepare('DELETE FROM address_book WHERE id = ? AND student_id = ?').run(request.params.id, request.currentUser.id);
    response.json({ ok: true });
  });

  // 商品评价
  app.get('/api/products/:id/reviews', requireAuth, (request, response) => {
    const reviews = db.prepare(
      `SELECT product_reviews.*, users.display_name AS student_name
       FROM product_reviews LEFT JOIN users ON users.id = product_reviews.student_id
       WHERE product_reviews.product_id = ? ORDER BY product_reviews.created_at DESC`
    ).all(request.params.id);
    const avgRating = reviews.length ? (reviews.reduce((s, r) => s + r.rating, 0) / reviews.length).toFixed(1) : '0.0';
    response.json({ reviews, avgRating, totalReviews: reviews.length });
  });

  app.post('/api/products/:id/reviews', requireStudent, (request, response) => {
    const rating = Number(request.body.rating);
    if (!rating || rating < 1 || rating > 5) { response.status(400).json({ error: '评分须为1-5。' }); return; }
    const order = db.prepare(
      `SELECT id FROM orders WHERE product_id = ? AND student_id = ? AND status = 'confirmed'`
    ).get(request.params.id, request.currentUser.id);
    if (!order) { response.status(400).json({ error: '只有确认收货后才能评价。' }); return; }
    db.prepare(
      'INSERT INTO product_reviews (product_id, student_id, rating, content, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(request.params.id, request.currentUser.id, rating, stripHtml(request.body.content || ''), dayjs().toISOString());
    response.json({ ok: true });
  });

  // 商城推荐
  app.get('/api/products/recommended', requireAuth, (request, response) => {
    const userId = request.currentUser.id;
    // 基于用户做题科目推荐相关资料
    const subjects = db.prepare(`
      SELECT subject, COUNT(*) AS cnt FROM practice_records pr
      JOIN questions q ON q.id = pr.question_id
      WHERE pr.student_id = ? GROUP BY subject ORDER BY cnt DESC LIMIT 3
    `).all(userId);

    let products = [];
    if (subjects.length) {
      const subjectNames = subjects.map((s) => s.subject);
      const placeholders = subjectNames.map(() => '?').join(',');
      products = db.prepare(`
        SELECT * FROM products WHERE (title LIKE '%' || ? || '%' OR description LIKE '%' || ? || '%' OR subject IN (${placeholders})) AND stock > 0
        ORDER BY RANDOM() LIMIT 10
      `).all(subjectNames[0], subjectNames[0], ...subjectNames);
    }

    // 不足则补充热门商品
    if (products.length < 5) {
      const existing = new Set(products.map((p) => p.id));
      const more = db.prepare('SELECT * FROM products WHERE stock > 0 ORDER BY created_at DESC LIMIT 10').all()
        .filter((p) => !existing.has(p.id));
      products = products.concat(more.slice(0, 5 - products.length));
    }

    response.json({ products });
  });

  // 拼团
  app.post('/api/group-buys', requireStudent, (request, response) => {
    const productId = Number(request.body.productId);
    const groupPrice = Number(request.body.groupPrice) || 0;
    const targetCount = Math.max(2, Number(request.body.targetCount) || 3);
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) { return response.status(404).json({ error: '商品不存在。' }); }
    if (product.stock < 1) { return response.status(400).json({ error: '库存不足。' }); }

    const price = groupPrice > 0 ? groupPrice : Math.round(product.price * 0.8 * 100) / 100;
    const expiresAt = dayjs().add(24, 'hour').toISOString();

    const result = db.prepare(
      'INSERT INTO group_buys (product_id, initiator_id, target_count, group_price, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(productId, request.currentUser.id, targetCount, price, expiresAt, dayjs().toISOString());

    db.prepare('INSERT INTO group_buy_participants (group_buy_id, student_id, joined_at) VALUES (?, ?, ?)').run(result.lastInsertRowid, request.currentUser.id, dayjs().toISOString());

    response.json({ ok: true, groupBuyId: result.lastInsertRowid });
  });

  app.post('/api/group-buys/:id/join', requireStudent, (request, response) => {
    const gbId = Number(request.params.id);
    const gb = db.prepare('SELECT * FROM group_buys WHERE id = ?').get(gbId);
    if (!gb) { return response.status(404).json({ error: '拼团不存在。' }); }
    if (gb.status !== 'open') { return response.status(400).json({ error: '拼团已结束。' }); }
    if (dayjs(gb.expires_at).isBefore(dayjs())) { return response.status(400).json({ error: '拼团已过期。' }); }

    const already = db.prepare('SELECT id FROM group_buy_participants WHERE group_buy_id = ? AND student_id = ?').get(gbId, request.currentUser.id);
    if (already) { return response.status(400).json({ error: '已参与。' }); }

    db.prepare('INSERT INTO group_buy_participants (group_buy_id, student_id, joined_at) VALUES (?, ?, ?)').run(gbId, request.currentUser.id, dayjs().toISOString());
    const currentCount = db.prepare('SELECT COUNT(*) AS cnt FROM group_buy_participants WHERE group_buy_id = ?').get(gbId).cnt;

    if (currentCount >= gb.target_count) {
      db.prepare('UPDATE group_buys SET status = ? WHERE id = ?').run('success', gbId);
    }

    response.json({ ok: true, currentCount, targetCount: gb.target_count });
  });

  app.get('/api/group-buys', requireAuth, (request, response) => {
    const groups = db.prepare(`
      SELECT gb.*, p.title AS product_title, p.image_path FROM group_buys gb
      LEFT JOIN products p ON p.id = gb.product_id
      WHERE gb.status = 'open' AND julianday(gb.expires_at) > julianday('now')
      ORDER BY gb.created_at DESC LIMIT 20
    `).all();
    const result = groups.map((g) => {
      const count = db.prepare('SELECT COUNT(*) AS cnt FROM group_buy_participants WHERE group_buy_id = ?').get(g.id).cnt;
      return { ...g, currentCount: count };
    });
    response.json({ groupBuys: result });
  });

  // 虚拟商品自动发货
  app.post('/api/orders/:id/download', requireStudent, (request, response) => {
    const order = db.prepare('SELECT o.*, p.is_virtual, p.virtual_content FROM orders o LEFT JOIN products p ON p.id = o.product_id WHERE o.id = ? AND o.student_id = ?').get(request.params.id, request.currentUser.id);
    if (!order) { return response.status(404).json({ error: '订单不存在。' }); }
    if (!order.is_virtual) { return response.status(400).json({ error: '非虚拟商品。' }); }
    if (order.status !== 'paid' && order.status !== 'delivered') { return response.status(400).json({ error: '订单状态不允许下载。' }); }
    response.json({ content: order.virtual_content });
  });
};
