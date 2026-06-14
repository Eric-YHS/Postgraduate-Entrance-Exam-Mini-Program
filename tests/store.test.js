const { getAgent, createTeacher, createStudent, createProduct, loginAs } = require('./helper');

describe('商城接口', () => {
  test('POST /api/orders 下单成功并扣减库存', async () => {
    const agent = getAgent();
    const teacher = createTeacher({ username: 'teacher_store_1' });
    const student = createStudent({ username: 'student_store_1' });
    const product = createProduct({ createdBy: teacher.id, title: '测试资料', price: 9.9, stock: 10 });

    await loginAs(agent, student.username);

    const res = await agent
      .post('/api/orders')
      .send({ productId: product.id, quantity: 2, shippingAddress: '测试地址' })
      .expect(200);

    expect(res.body.ok).toBe(true);

    const row = require('./helper').db.prepare('SELECT stock FROM products WHERE id = ?').get(product.id);
    expect(row.stock).toBe(8);
  });

  test('POST /api/orders 库存不足时拒绝并发超卖', async () => {
    const teacher = createTeacher({ username: 'teacher_store_2' });
    const product = createProduct({ createdBy: teacher.id, title: '限量资料', price: 99, stock: 1 });

    const studentA = createStudent({ username: 'student_store_a' });
    const studentB = createStudent({ username: 'student_store_b' });

    const agentA = getAgent();
    const agentB = getAgent();
    await loginAs(agentA, studentA.username);
    await loginAs(agentB, studentB.username);

    const [resA, resB] = await Promise.all([
      agentA.post('/api/orders').send({ productId: product.id, quantity: 1, shippingAddress: 'A' }),
      agentB.post('/api/orders').send({ productId: product.id, quantity: 1, shippingAddress: 'B' })
    ]);

    // 仅有一个请求成功
    const successCount = [resA, resB].filter((r) => r.status === 200).length;
    expect(successCount).toBe(1);

    const row = require('./helper').db.prepare('SELECT stock FROM products WHERE id = ?').get(product.id);
    expect(row.stock).toBe(0);

    const orderCount = require('./helper').db.prepare('SELECT COUNT(*) AS c FROM orders WHERE product_id = ?').get(product.id).c;
    expect(orderCount).toBe(1);
  });

  test('POST /api/cart/checkout 结算购物车并清空', async () => {
    const agent = getAgent();
    const teacher = createTeacher({ username: 'teacher_store_3' });
    const student = createStudent({ username: 'student_store_3' });
    const product = createProduct({ createdBy: teacher.id, title: '购物车资料', price: 19.9, stock: 5 });

    await loginAs(agent, student.username);

    // 加入购物车
    await agent
      .post('/api/cart')
      .send({ productId: product.id, quantity: 2 })
      .expect(200);

    // 添加地址
    const db = require('./helper').db;
    db.prepare(
      'INSERT INTO address_book (student_id, name, phone, address, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(student.id, '测试', '13800000000', '测试地址', 1, new Date().toISOString());
    const address = db.prepare('SELECT id FROM address_book WHERE student_id = ?').get(student.id);

    const res = await agent
      .post('/api/cart/checkout')
      .send({ addressId: address.id })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.created).toBe(1);

    const cart = db.prepare('SELECT COUNT(*) AS c FROM shopping_cart WHERE student_id = ?').get(student.id).c;
    expect(cart).toBe(0);

    const stock = db.prepare('SELECT stock FROM products WHERE id = ?').get(product.id).stock;
    expect(stock).toBe(3);
  });
});
