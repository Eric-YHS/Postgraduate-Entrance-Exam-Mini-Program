const dayjs = require('dayjs');
const { sanitizeText, stripHtml } = require('../utils/sanitize');

// Phase 3: 引入付费群创建机器人（可选加载，失败不阻塞）
let paidGroupBot = null;
try {
  paidGroupBot = require('../services/bots/paidGroupBot');
} catch (err) {
  console.warn('[store] paidGroupBot 未加载:', err.message);
}

module.exports = function registerStoreRoutes(app, shared) {
  const { db, requireAuth, requireStudent, requireTeacher, requireAdmin, toPublicPath, productUpload, safeJsonParse, getSetting, grantEntitlementFromOrder } = shared;

  // 创建商品
  app.post('/api/products', requireTeacher, (request, response) => {
    productUpload(request, response, (error) => {
      if (error) {
        response.status(400).json({ error: '商品上传失败。' });
        return;
      }

      const title = sanitizeText(request.body.title);
      // B-24: 价格四舍五入到分，避免浮点精度问题
      const price = Math.round(Number(request.body.price || 0) * 100) / 100;
      const stock = Number(request.body.stock || 0);

      if (!title || Number.isNaN(price) || price <= 0 || Number.isNaN(stock) || stock < 0) {
        response.status(400).json({ error: '请完整填写商品标题、价格与库存。' });
        return;
      }

      const packageType = String(request.body.packageType || 'physical').trim();
      const validPackageTypes = ['physical', 'virtual', 'single_subject', 'all_subjects', 'addon'];
      if (!validPackageTypes.includes(packageType)) {
        response.status(400).json({ error: '无效的商品套餐类型。' });
        return;
      }

      const status = String(request.body.status || 'active').trim();
      if (!['active', 'inactive'].includes(status)) {
        response.status(400).json({ error: '无效的商品状态。' });
        return;
      }

      const productResult = db.prepare(
        `
          INSERT INTO products (title, description, price, stock, image_path, category, package_type, subject_scope, is_virtual, delivery_content, status, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      ).run(
        title,
        sanitizeText(request.body.description),
        price,
        stock,
        request.file ? toPublicPath(request.file.path) : '',
        sanitizeText(request.body.category || ''),
        packageType,
        sanitizeText(request.body.subjectScope || ''),
        request.body.isVirtual === true || request.body.isVirtual === '1' || request.body.isVirtual === 1 ? 1 : 0,
        sanitizeText(request.body.deliveryContent || ''),
        status,
        request.currentUser.id,
        dayjs().toISOString()
      );

      response.json({ ok: true, id: productResult.lastInsertRowid });
    });
  });

  // 下单（创建未支付订单）
  app.post('/api/orders', requireStudent, (request, response) => {
    const productId = Number(request.body.productId);
    const rawQuantity = request.body.quantity !== undefined ? request.body.quantity : 1;
    const quantity = Number(rawQuantity);
    const shippingAddress = sanitizeText(request.body.shippingAddress);

    if (!shippingAddress || Number.isNaN(quantity) || quantity <= 0 || !Number.isInteger(quantity)) {
      response.status(400).json({ error: '请填写有效的正整数数量和收货地址。' });
      return;
    }

    if (!Number.isInteger(productId) || productId <= 0) {
      response.status(400).json({ error: '无效的商品ID。' });
      return;
    }

    const now = dayjs().toISOString();
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) {
      response.status(404).json({ error: '商品不存在。' });
      return;
    }
    if (product.status === 'inactive') {
      response.status(400).json({ error: '该商品已下架。' });
      return;
    }

    const totalAmount = Math.round(product.price * 100 * quantity) / 100;
    const outTradeNo = `ORDER${Date.now()}${productId}${request.currentUser.id}`;

    const result = db.prepare(
      `
        INSERT INTO orders (product_id, student_id, quantity, total_amount, shipping_address, out_trade_no, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'unpaid', ?)
      `
    ).run(productId, request.currentUser.id, quantity, totalAmount, shippingAddress, outTradeNo, now);

    response.json({ ok: true, id: result.lastInsertRowid, outTradeNo });
  });

  // 订单状态更新（教师）
  app.post('/api/orders/:id/status', requireTeacher, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const { status } = request.body;
    const allowed = ['unpaid', 'paid', 'shipped', 'delivered', 'confirmed', 'cancelled'];
    if (!allowed.includes(status)) {
      response.status(400).json({ error: '无效的订单状态。' });
      return;
    }
    const order = db.prepare('SELECT o.*, p.created_by FROM orders o JOIN products p ON p.id = o.product_id WHERE o.id = ?').get(id);
    if (!order) { response.status(404).json({ error: '订单不存在。' }); return; }
    if (order.created_by !== request.currentUser.id) { response.status(403).json({ error: '无权操作此订单。' }); return; }
    const validTransitions = {
      unpaid: ['paid', 'cancelled'],
      paid: ['shipped', 'cancelled'],
      shipped: ['delivered', 'cancelled'],
      delivered: ['confirmed', 'cancelled'],
      confirmed: ['cancelled'],
      cancelled: []
    };
    if (!validTransitions[order.status] || !validTransitions[order.status].includes(status)) {
      return response.status(400).json({ error: `订单状态不能从 "${order.status}" 变更为 "${status}"。` });
    }
    if (status === 'paid' && order.status === 'unpaid') {
      fulfillOrder(id);
    } else if (status === 'cancelled' && order.status !== 'cancelled') {
      db.transaction(() => {
        db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(order.quantity, order.product_id);
        db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, id);
      })();
    } else {
      db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, id);
    }
    response.json({ ok: true });
  });

  // 学生确认收货
  app.post('/api/orders/:id/confirm', requireStudent, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const result = db.prepare('UPDATE orders SET status = ? WHERE id = ? AND student_id = ? AND status = ?')
      .run('confirmed', id, request.currentUser.id, 'delivered');
    if (!result.changes) { response.status(400).json({ error: '订单状态不正确。' }); return; }
    response.json({ ok: true });
  });

  function fulfillOrder(orderId) {
    const order = db.prepare('SELECT o.*, p.package_type, p.subject_scope, p.stock FROM orders o JOIN products p ON p.id = o.product_id WHERE o.id = ?').get(orderId);
    if (!order || order.status !== 'unpaid') return false;

    const now = dayjs().toISOString();
    const txn = db.transaction(() => {
      if (order.stock < order.quantity) {
        throw new Error('库存不足');
      }
      db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?').run(order.quantity, order.product_id, order.quantity);
      db.prepare(`
        UPDATE orders SET status = 'paid', paid_at = ?, payment_method = ?, transaction_id = ?
        WHERE id = ? AND status = 'unpaid'
      `).run(now, 'simulated', order.out_trade_no || '', orderId);
      grantEntitlementFromOrder(order, { package_type: order.package_type, subject_scope: order.subject_scope });
    });

    try {
      txn();
      // Phase 3(C): 付费履约成功后异步创建付费专属服务群（不阻塞，失败不影响订单）
      if (paidGroupBot && typeof paidGroupBot.createPaidServiceGroup === 'function') {
        setImmediate(() => {
          paidGroupBot.createPaidServiceGroup(db, order.student_id, orderId).catch((err) => {
            console.error(`[store] 创建付费服务群失败 orderId=${orderId}:`, err.message);
          });
        });
      }
      return true;
    } catch (error) {
      console.error('订单履约失败:', error.message);
      return false;
    }
  }

  // 订单支付
  app.post('/api/orders/:id/pay', requireStudent, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const order = db.prepare('SELECT o.*, p.title AS product_title, p.package_type, p.subject_scope FROM orders o JOIN products p ON p.id = o.product_id WHERE o.id = ? AND o.student_id = ?').get(id, request.currentUser.id);
    if (!order) { response.status(404).json({ error: '订单不存在。' }); return; }
    if (order.status !== 'unpaid') { response.status(400).json({ error: '订单状态不正确。' }); return; }

    const paymentMode = getSetting('payment_mode', 'simulated');
    if (paymentMode === 'simulated') {
      const ok = fulfillOrder(id);
      if (!ok) { response.status(400).json({ error: '支付失败，库存不足。' }); return; }
      response.json({ ok: true, paid: true });
      return;
    }

    // 微信支付：生成预支付参数（骨架，真实签名需要商户证书）
    const nonceStr = require('crypto').randomBytes(16).toString('hex');
    const timeStamp = String(Math.floor(Date.now() / 1000));
    response.json({
      ok: true,
      paid: false,
      jsapiParams: {
        appId: '',
        timeStamp,
        nonceStr,
        package: `prepay_id=${order.out_trade_no}`,
        signType: 'RSA',
        paySign: ''
      }
    });
  });

  // 微信支付回调（幂等）
  app.post('/api/wxpay/callback', (request, response) => {
    const { out_trade_no, transaction_id } = request.body || {};
    if (!out_trade_no) { response.status(400).json({ error: '缺少订单号。' }); return; }

    const order = db.prepare('SELECT * FROM orders WHERE out_trade_no = ?').get(out_trade_no);
    if (!order) { response.status(404).json({ error: '订单不存在。' }); return; }

    if (order.status === 'paid') {
      response.json({ ok: true, message: '已处理' });
      return;
    }

    if (order.status !== 'unpaid') {
      response.status(400).json({ error: '订单状态不正确。' });
      return;
    }

    const ok = fulfillOrder(order.id);
    if (!ok) { response.status(400).json({ error: '履约失败' }); return; }

    db.prepare('UPDATE orders SET transaction_id = ? WHERE id = ?').run(transaction_id || '', order.id);
    response.json({ ok: true });
  });

  // 退款申请
  app.post('/api/orders/:id/refund', requireStudent, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND student_id = ?').get(id, request.currentUser.id);
    if (!order) { response.status(404).json({ error: '订单不存在。' }); return; }
    if (order.status !== 'paid' && order.status !== 'shipped' && order.status !== 'delivered') {
      response.status(400).json({ error: '当前订单状态不允许退款。' }); return;
    }

    const existing = db.prepare('SELECT status FROM refunds WHERE order_id = ? AND status IN ("requested", "approved", "refunded")').get(id);
    if (existing) { response.status(400).json({ error: '该订单已有退款申请。' }); return; }

    db.prepare('INSERT INTO refunds (order_id, student_id, reason, amount, status, created_at) VALUES (?, ?, ?, ?, "requested", ?)')
      .run(id, request.currentUser.id, sanitizeText(request.body.reason || ''), order.total_amount, dayjs().toISOString());
    response.json({ ok: true });
  });

  // 退款审核（管理员/教师）
  app.post('/api/admin/orders/:id/refund', requireAdmin, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const { status } = request.body;
    if (!['approved', 'rejected'].includes(status)) { response.status(400).json({ error: '无效的审核状态。' }); return; }

    const refund = db.prepare('SELECT * FROM refunds WHERE order_id = ? AND status = "requested"').get(id);
    if (!refund) { response.status(404).json({ error: '未找到待审核退款。' }); return; }

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!order) { response.status(404).json({ error: '订单不存在。' }); return; }

    const now = dayjs().toISOString();
    if (status === 'approved') {
      db.transaction(() => {
        db.prepare('UPDATE refunds SET status = "refunded", processed_at = ? WHERE id = ?').run(now, refund.id);
        db.prepare('UPDATE orders SET status = "cancelled" WHERE id = ?').run(id);
        db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(order.quantity, order.product_id);
      })();
    } else {
      db.prepare('UPDATE refunds SET status = "rejected", processed_at = ? WHERE id = ?').run(now, refund.id);
    }

    response.json({ ok: true });
  });

  // 商城商品列表（支持搜索、分类、排序）
  app.get('/api/products', requireAuth, (request, response) => {
    const { search, category, sort, status } = request.query;
    let query = 'SELECT * FROM products WHERE 1=1';
    const params = [];

    if (request.currentUser.role === 'student') {
      query += ' AND status = ?';
      params.push('active');
    } else if (status) {
      query += ' AND status = ?';
      params.push(status);
    }

    if (category) { query += ' AND category = ?'; params.push(category); }
    if (search) {
      const safeSearch = String(search).replace(/[%_]/g, '\\$&');
      query += " AND (title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')";
      params.push(`%${safeSearch}%`, `%${safeSearch}%`);
    }

    if (sort === 'price_asc') { query += ' ORDER BY price ASC'; }
    else if (sort === 'price_desc') { query += ' ORDER BY price DESC'; }
    else { query += ' ORDER BY created_at DESC'; }

    query += ' LIMIT 200';
    const products = db.prepare(query).all(...params).map(serializeProduct);
    response.json({ products });
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
    let quantity = Math.max(1, Math.floor(Number(request.body.quantity) || 1));
    const product = db.prepare('SELECT id, stock FROM products WHERE id = ?').get(productId);
    if (!product) { response.status(404).json({ error: '商品不存在。' }); return; }
    db.prepare(
      `INSERT INTO shopping_cart (student_id, product_id, quantity, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(student_id, product_id) DO UPDATE SET quantity = MIN(excluded.quantity, ?)`
    ).run(request.currentUser.id, productId, quantity, dayjs().toISOString(), product.stock);
    response.json({ ok: true });
  });

  app.delete('/api/cart/:id', requireStudent, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    db.prepare('DELETE FROM shopping_cart WHERE id = ? AND student_id = ?').run(id, request.currentUser.id);
    response.json({ ok: true });
  });

  app.post('/api/cart/checkout', requireStudent, (request, response) => {
    const addressId = Number(request.body.addressId);
    if (!Number.isInteger(addressId) || addressId <= 0) {
      response.status(400).json({ error: '请选择有效的收货地址。' });
      return;
    }

    const address = db.prepare('SELECT * FROM address_book WHERE id = ? AND student_id = ?').get(addressId, request.currentUser.id);
    if (!address) { response.status(400).json({ error: '请选择收货地址。' }); return; }

    const cartItems = db.prepare(
      `SELECT shopping_cart.*, products.title AS product_title, products.price, products.stock, products.status
       FROM shopping_cart LEFT JOIN products ON products.id = shopping_cart.product_id
       WHERE shopping_cart.student_id = ?`
    ).all(request.currentUser.id);
    if (!cartItems.length) { response.status(400).json({ error: '购物车为空。' }); return; }

    const now = dayjs().toISOString();
    const insertOrder = db.prepare(
      `INSERT INTO orders (product_id, student_id, quantity, total_amount, shipping_address, out_trade_no, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'unpaid', ?)`
    );
    const clearCart = db.prepare('DELETE FROM shopping_cart WHERE student_id = ?');

    const createdIds = [];
    for (const item of cartItems) {
      if (item.status === 'inactive') {
        response.status(400).json({ error: `${item.product_title} 已下架。` });
        return;
      }
      const totalCents = Math.round(item.price * 100) * item.quantity;
      const outTradeNo = `ORDER${Date.now()}${item.product_id}${request.currentUser.id}`;
      const result = insertOrder.run(item.product_id, request.currentUser.id, item.quantity, totalCents / 100, address.address, outTradeNo, now);
      createdIds.push(result.lastInsertRowid);
    }
    clearCart.run(request.currentUser.id);

    response.json({ ok: true, created: createdIds.length, orderIds: createdIds });
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
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    db.prepare('DELETE FROM address_book WHERE id = ? AND student_id = ?').run(id, request.currentUser.id);
    response.json({ ok: true });
  });

  // 商品评价
  app.get('/api/products/:id/reviews', requireAuth, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const reviews = db.prepare(
      `SELECT product_reviews.*, users.display_name AS student_name
       FROM product_reviews LEFT JOIN users ON users.id = product_reviews.student_id
       WHERE product_reviews.product_id = ? ORDER BY product_reviews.created_at DESC`
    ).all(id);
    const avgRating = reviews.length ? (reviews.reduce((s, r) => s + r.rating, 0) / reviews.length).toFixed(1) : '0.0';
    response.json({ reviews, avgRating, totalReviews: reviews.length });
  });

  app.post('/api/products/:id/reviews', requireStudent, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const rating = Number(request.body.rating);
    if (!rating || rating < 1 || rating > 5) { response.status(400).json({ error: '评分须为1-5。' }); return; }
    const order = db.prepare(
      `SELECT id FROM orders WHERE product_id = ? AND student_id = ? AND status = 'confirmed'`
    ).get(id, request.currentUser.id);
    if (!order) { response.status(400).json({ error: '只有确认收货后才能评价。' }); return; }
    db.prepare(
      `INSERT INTO product_reviews (product_id, student_id, rating, content, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(product_id, student_id) DO UPDATE SET rating = excluded.rating, content = excluded.content, created_at = excluded.created_at`
    ).run(id, request.currentUser.id, rating, stripHtml(request.body.content || ''), dayjs().toISOString());
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
      const subjectNames = subjects.map((s) => s.subject).filter(Boolean);
      if (!subjectNames.length) {
        response.json({ products: [] });
        return;
      }
      const placeholders = subjectNames.map(() => '?').join(',');
      // B-07: 转义 LIKE 通配符
      const safeSubject = subjectNames[0].replace(/[%_]/g, '\\$&');
      products = db.prepare(`
        SELECT * FROM products WHERE (title LIKE '%' || ? || '%' ESCAPE '\\' OR description LIKE '%' || ? || '%' ESCAPE '\\' OR category IN (${placeholders})) AND stock > 0
        ORDER BY RANDOM() LIMIT 10
      `).all(safeSubject, safeSubject, ...subjectNames);
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

    const createGroupBuy = db.transaction(() => {
      const result = db.prepare(
        'INSERT INTO group_buys (product_id, initiator_id, target_count, group_price, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(productId, request.currentUser.id, targetCount, price, expiresAt, dayjs().toISOString());
      db.prepare('INSERT INTO group_buy_participants (group_buy_id, student_id, joined_at) VALUES (?, ?, ?)').run(result.lastInsertRowid, request.currentUser.id, dayjs().toISOString());
      return result.lastInsertRowid;
    });
    const groupBuyId = createGroupBuy();

    response.json({ ok: true, groupBuyId });
  });

  app.post('/api/group-buys/:id/join', requireStudent, (request, response) => {
    const gbId = Number(request.params.id);
    const gb = db.prepare('SELECT * FROM group_buys WHERE id = ?').get(gbId);
    if (!gb) { return response.status(404).json({ error: '拼团不存在。' }); }
    if (gb.status !== 'open') { return response.status(400).json({ error: '拼团已结束。' }); }
    if (dayjs(gb.expires_at).isBefore(dayjs())) { return response.status(400).json({ error: '拼团已过期。' }); }

    const already = db.prepare('SELECT id FROM group_buy_participants WHERE group_buy_id = ? AND student_id = ?').get(gbId, request.currentUser.id);
    if (already) { return response.status(400).json({ error: '已参与。' }); }

    const joinGroupBuy = db.transaction(() => {
      db.prepare('INSERT INTO group_buy_participants (group_buy_id, student_id, joined_at) VALUES (?, ?, ?)').run(gbId, request.currentUser.id, dayjs().toISOString());
      const currentCount = db.prepare('SELECT COUNT(*) AS cnt FROM group_buy_participants WHERE group_buy_id = ?').get(gbId).cnt;
      if (currentCount >= gb.target_count) {
        db.prepare('UPDATE group_buys SET status = ? WHERE id = ?').run('success', gbId);
        db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?').run(currentCount, gb.product_id, currentCount);
      }
      return currentCount;
    });
    const currentCount = joinGroupBuy();

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
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return response.status(400).json({ error: '无效的 ID。' });
    const order = db.prepare('SELECT o.*, p.is_virtual, p.virtual_content FROM orders o LEFT JOIN products p ON p.id = o.product_id WHERE o.id = ? AND o.student_id = ?').get(id, request.currentUser.id);
    if (!order) { return response.status(404).json({ error: '订单不存在。' }); }
    if (!order.is_virtual) { return response.status(400).json({ error: '非虚拟商品。' }); }
    if (order.status !== 'paid' && order.status !== 'delivered') { return response.status(400).json({ error: '订单状态不允许下载。' }); }
    response.json({ content: order.virtual_content });
  });
};
