const { getAgent, createTeacher, createStudent, createProduct, loginAs, db } = require('./helper');
const config = require('../src/config');

describe('免费模式下的交易与推广接口', () => {
  test.each([
    ['GET', '/api/products'],
    ['POST', '/api/orders'],
    ['GET', '/api/refunds'],
    ['GET', '/api/cart'],
    ['POST', '/api/cart/checkout'],
    ['GET', '/api/addresses'],
    ['GET', '/api/group-buys'],
    ['POST', '/api/wxpay/callback'],
    ['POST', '/api/promoter/apply'],
    ['GET', '/api/admin/promoter-applications'],
    ['GET', '/api/admin/refunds']
  ])('%s %s 返回 410', async (method, path) => {
    const agent = getAgent();
    const response = method === 'GET'
      ? await agent.get(path)
      : await agent.post(path).send({});

    expect(response.status).toBe(410);
    expect(response.body.error).toContain('免费模式');
  });

  test('订单接口不可创建交易记录', async () => {
    const agent = getAgent();
    const teacher = createTeacher({ username: 'teacher_disabled_store' });
    const student = createStudent({ username: 'student_disabled_store' });
    const product = createProduct({ createdBy: teacher.id, title: '不可购买资料', price: 9.9, stock: 10 });
    await loginAs(agent, student.username);

    const before = db.prepare('SELECT COUNT(*) AS count FROM orders').get().count;
    await agent.post('/api/orders').send({ productId: product.id, quantity: 1, shippingAddress: '测试地址' }).expect(410);
    const after = db.prepare('SELECT COUNT(*) AS count FROM orders').get().count;
    expect(after).toBe(before);
  });

  test('学生和教师 bootstrap 不返回 products/orders 模块', async () => {
    const teacherAgent = getAgent();
    const studentAgent = getAgent();
    const teacher = createTeacher({ username: 'teacher_no_store_bootstrap' });
    const student = createStudent({ username: 'student_no_store_bootstrap' });
    await loginAs(teacherAgent, teacher.username);
    await loginAs(studentAgent, student.username);

    const teacherBootstrap = await teacherAgent
      .get('/api/teacher/bootstrap?modules=products,orders,courses')
      .expect(200);
    expect(teacherBootstrap.body).not.toHaveProperty('products');
    expect(teacherBootstrap.body).not.toHaveProperty('orders');
    expect(teacherBootstrap.body).toHaveProperty('courses');

    const studentBootstrap = await studentAgent
      .get('/api/student/bootstrap?modules=products,orders,courses')
      .expect(200);
    expect(studentBootstrap.body).not.toHaveProperty('products');
    expect(studentBootstrap.body).not.toHaveProperty('orders');
    expect(studentBootstrap.body).toHaveProperty('courses');
  });

  test('微信支付环境配置在免费模式下强制失效', () => {
    expect(config.freeAccessMode).toBe(true);
    expect(config.wxPayEnabled).toBe('false');
    expect(config.wxPayAppId).toBe('');
    expect(config.wxPayMchId).toBe('');
    expect(config.wxPayApiV3Key).toBe('');
    expect(config.wxPayPrivateKeyPath).toBe('');
    expect(config.wxPaySerialNo).toBe('');
  });
});
