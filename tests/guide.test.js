const fs = require('fs');
const path = require('path');
const { getAgent } = require('./helper');

const publicDir = path.join(__dirname, '..', 'public');

describe('三端使用指导', () => {
  test('GET /guide 返回指导页面和所需资源', async () => {
    const response = await getAgent()
      .get('/guide')
      .expect(200)
      .expect('Content-Type', /html/);

    expect(response.text).toContain('<strong>使用指导</strong>');
    expect(response.text).toContain('href="/guide.css"');
    expect(response.text).toContain('src="/guide.js"');
    expect(response.text).toContain('id="guide-search"');
  });

  test.each(['student.html', 'teacher.html', 'admin.html'])('%s 提供使用指导入口', (fileName) => {
    const html = fs.readFileSync(path.join(publicDir, fileName), 'utf8');
    expect(html).toContain('href="/guide"');
    expect(html).toContain('使用指导');
  });

  test('页内标签逻辑不会接管普通导航链接', () => {
    const script = fs.readFileSync(path.join(publicDir, 'common.js'), 'utf8');
    expect(script).toContain('.filter((button) => button.dataset.target)');
  });

  test('指导脚本包含三种角色及完整功能清单', () => {
    const script = fs.readFileSync(path.join(publicDir, 'guide.js'), 'utf8');

    expect(script).toContain("student: {");
    expect(script).toContain("teacher: {");
    expect(script).toContain("admin: {");
    expect(script).toContain("title: '学生端使用指导'");
    expect(script).toContain("title: '教师端使用指导'");
    expect(script).toContain("title: '管理员端使用指导'");
    expect(script.match(/id: 'student-[^']+-guide'/g)).toHaveLength(14);
    expect(script.match(/id: 'teacher-[^']+-guide'/g)).toHaveLength(11);
    expect(script.match(/id: 'admin-[^']+-guide'/g)).toHaveLength(15);
  });

  test('教师和管理员指导如实说明学生创建方式', () => {
    const script = fs.readFileSync(path.join(publicDir, 'guide.js'), 'utf8');

    expect(script).toContain('教师端当前没有手工新建学生入口');
    expect(script).toContain('学生目前需要先通过微信小程序首次登录创建账号');
    expect(script).toContain('当前列表页不提供手工新建学生');
  });
});
