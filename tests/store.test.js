const { getAgent, createTeacher, createStudent, createProduct, loginAs } = require('./helper');

describe('商城接口', () => {
  test('POST /api/orders 创建未支付订单，支付成功后扣减库存', async () => {
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
    expect(res.body.id).toBeGreaterThan(0);

    const db = require('./helper').db;
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(res.body.id);
    expect(order.status).toBe('unpaid');

    let row = db.prepare('SELECT stock FROM products WHERE id = ?').get(product.id);
    expect(row.stock).toBe(10);

    await agent.post(`/api/orders/${order.id}/pay`).send({}).expect(200);

    row = db.prepare('SELECT stock FROM products WHERE id = ?').get(product.id);
    expect(row.stock).toBe(8);

    const paidOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    expect(paidOrder.status).toBe('paid');
  });

  test('POST /api/orders 支付时库存不足拒绝并发超卖', async () => {
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

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const payA = await agentA.post(`/api/orders/${resA.body.id}/pay`).send({});
    const payB = await agentB.post(`/api/orders/${resB.body.id}/pay`).send({});

    const successCount = [payA, payB].filter((r) => r.status === 200).length;
    expect(successCount).toBe(1);

    const row = require('./helper').db.prepare('SELECT stock FROM products WHERE id = ?').get(product.id);
    expect(row.stock).toBe(0);

    const paidCount = require('./helper').db.prepare("SELECT COUNT(*) AS c FROM orders WHERE product_id = ? AND status = 'paid'").get(product.id).c;
    expect(paidCount).toBe(1);
  });

  test('POST /api/cart/checkout 创建未支付订单，支付后扣减库存并清空购物车', async () => {
    const agent = getAgent();
    const teacher = createTeacher({ username: 'teacher_store_3' });
    const student = createStudent({ username: 'student_store_3' });
    const product = createProduct({ createdBy: teacher.id, title: '购物车资料', price: 19.9, stock: 5 });

    await loginAs(agent, student.username);

    await agent
      .post('/api/cart')
      .send({ productId: product.id, quantity: 2 })
      .expect(200);

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
    expect(res.body.orderIds.length).toBe(1);

    const cart = db.prepare('SELECT COUNT(*) AS c FROM shopping_cart WHERE student_id = ?').get(student.id).c;
    expect(cart).toBe(0);

    let stock = db.prepare('SELECT stock FROM products WHERE id = ?').get(product.id).stock;
    expect(stock).toBe(5);

    await agent.post(`/api/orders/${res.body.orderIds[0]}/pay`).send({}).expect(200);

    stock = db.prepare('SELECT stock FROM products WHERE id = ?').get(product.id).stock;
    expect(stock).toBe(3);
  });
});
