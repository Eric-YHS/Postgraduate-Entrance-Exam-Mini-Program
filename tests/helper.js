/**
 * 测试辅助模块
 * 使用内存数据库启动应用，并提供常用工厂函数。
 */

process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret-for-jest-only-do-not-use-in-production';
process.env.COOKIE_SECURE = 'false';

const request = require('supertest');
const { app, db } = require('../src/server');
const bcrypt = require('bcryptjs');
const dayjs = require('dayjs');

function getAgent() {
  return request.agent(app);
}

function createUser({ username, password, role, displayName, className }) {
  const hashed = bcrypt.hashSync(password, 8);
  const result = db.prepare(
    `INSERT INTO users (username, password, role, display_name, class_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(username, hashed, role, displayName, className || '', dayjs().toISOString());
  return { id: result.lastInsertRowid, username, role, displayName };
}

function createTeacher(overrides = {}) {
  return createUser({
    username: `teacher_${Date.now()}`,
    password: '123456',
    role: 'teacher',
    displayName: '测试教师',
    className: '测试班',
    ...overrides
  });
}

function createStudent(overrides = {}) {
  return createUser({
    username: `student_${Date.now()}`,
    password: '123456',
    role: 'student',
    displayName: '测试学生',
    className: '测试班',
    ...overrides
  });
}

function createProduct({ createdBy, title, price, stock }) {
  const result = db.prepare(
    `INSERT INTO products (title, description, price, stock, image_path, created_by, created_at)
     VALUES (?, '', ?, ?, '', ?, ?)`
  ).run(title, price, stock, createdBy, dayjs().toISOString());
  return { id: result.lastInsertRowid, title, price, stock };
}

async function loginAs(agent, username, password = '123456') {
  const res = await agent
    .post('/api/auth/login')
    .set('Origin', 'http://localhost:3000')
    .send({ username, password });
  if (!res.body || !res.body.token) {
    throw new Error(`登录失败: ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

module.exports = {
  app,
  db,
  getAgent,
  createUser,
  createTeacher,
  createStudent,
  createProduct,
  loginAs
};
