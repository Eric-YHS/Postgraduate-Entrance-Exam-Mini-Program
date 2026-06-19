const adminState = {
  user: null,
  settings: {},
  applications: [],
  users: [],
  stats: {},
  currentMenu: 'dashboard',
  currentSettingsTab: 'settings-general',
  _userPage: 1
};

const MENU_CONFIG = [
  { id: 'dashboard', label: '数据看板', icon: '📊', roles: ['admin', 'teacher', 'customer_service'] },
  { id: 'content', label: '内容管理', icon: '📦', roles: ['admin', 'teacher'] },
  { id: 'students', label: '学员管理', icon: '👨‍🎓', roles: ['admin', 'teacher', 'customer_service'] },
  { id: 'questions', label: '题库管理', icon: '📝', roles: ['admin', 'teacher'] },
  { id: 'knowledge', label: '知识库/语料库', icon: '🧠', roles: ['admin'] },
  { id: 'messages', label: '消息模板管理', icon: '✉️', roles: ['admin'] },
  { id: 'forum', label: '论坛管理', icon: '💬', roles: ['admin', 'teacher', 'customer_service'] },
  { id: 'robots', label: '机器人管理', icon: '🤖', roles: ['admin'] },
  { id: 'entrepreneurship', label: '创业板块', icon: '🚀', roles: ['admin'] },
  { id: 'settings', label: '系统设置', icon: '⚙️', roles: ['admin'] }
];

const ROLE_LABELS = {
  admin: '管理员',
  teacher: '教师',
  customer_service: '客服',
  student: '学生'
};

const ROLE_BADGE_STYLES = {
  admin: 'background: var(--brand);',
  teacher: 'background: #059669;',
  customer_service: 'background: #f59e0b;',
  student: 'background: #6366f1;'
};

function canAccessMenu(menuId) {
  const menu = MENU_CONFIG.find((m) => m.id === menuId);
  if (!menu) return false;
  return menu.roles.includes(adminState.user.role);
}

function renderMenu() {
  const container = document.getElementById('admin-menu');
  container.innerHTML = MENU_CONFIG.filter((m) => m.roles.includes(adminState.user.role))
    .map((m) => `
      <li>
        <button data-menu="${m.id}" class="${m.id === adminState.currentMenu ? 'active' : ''}">
          <span class="menu-icon">${m.icon}</span>
          ${escapeHtml(m.label)}
        </button>
      </li>
    `).join('');
}

function switchMenu(menuId) {
  if (!canAccessMenu(menuId)) return;
  adminState.currentMenu = menuId;

  document.querySelectorAll('.admin-section').forEach((section) => section.classList.remove('active'));
  const target = document.getElementById(`section-${menuId}`);
  if (target) target.classList.add('active');

  document.querySelectorAll('.admin-menu button').forEach((btn) => btn.classList.toggle('active', btn.dataset.menu === menuId));

  const menu = MENU_CONFIG.find((m) => m.id === menuId);
  document.getElementById('admin-hero-title').textContent = menu ? menu.label : '管理后台';
}

function switchSettingsTab(tabId) {
  adminState.currentSettingsTab = tabId;
  document.querySelectorAll('#settings-tabs button').forEach((btn) => btn.classList.toggle('active', btn.dataset.settingsTab === tabId));
  document.querySelectorAll('.settings-tab-panel').forEach((panel) => {
    panel.style.display = panel.id === tabId ? 'block' : 'none';
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  const authResult = await ensureAuth(['admin', 'teacher', 'customer_service']);
  if (!authResult) return;

  adminState.user = authResult.user;
  document.getElementById('admin-role-badge').textContent = ROLE_LABELS[adminState.user.role] || adminState.user.role;
  document.getElementById('admin-role-hint').textContent = `${ROLE_LABELS[adminState.user.role]}控制台`;

  renderMenu();
  switchMenu('dashboard');

  document.getElementById('logout-button').addEventListener('click', logout);

  document.getElementById('admin-menu').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-menu]');
    if (!btn) return;
    switchMenu(btn.dataset.menu);
  });

  document.getElementById('settings-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-settings-tab]');
    if (!btn) return;
    switchSettingsTab(btn.dataset.settingsTab);
  });

  document.getElementById('dashboard-trend-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-trend]');
    if (!btn) return;
    document.querySelectorAll('#dashboard-trend-tabs button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    renderDashboardTrends(Number(btn.dataset.trend));
  });

  document.getElementById('save-settings-button').addEventListener('click', saveSettings);

  document.getElementById('user-search').addEventListener('input', () => {
    adminState._userPage = 1;
    renderUsers();
  });
  document.getElementById('user-role-filter').addEventListener('change', () => {
    adminState._userPage = 1;
    renderUsers();
  });

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const id = Number(btn.dataset.id);
    if (action === 'approve-app') approveApplication(id);
    else if (action === 'reject-app') rejectApplication(id);
    else if (action === 'admin-page') {
      adminState._userPage = Number(btn.dataset.page);
      renderUsers();
    } else if (action === 'delete-user') {
      deleteUser(Number(btn.dataset.userId), btn.dataset.userName);
    }
  });

  await loadBootstrap();
  if (adminState.user.role === 'admin') {
    await loadSettings();
    await loadDashboard();
  } else {
    renderDashboardStats();
  }
});

async function loadBootstrap() {
  try {
    const data = await fetchJSON('/api/admin/bootstrap');
    adminState.applications = data.applications;
    adminState.users = data.users;
    adminState.stats = data.stats;

    renderApplications();
    renderUsers();
    renderDashboardStats();
  } catch (error) {
    createToast(error.message, 'error');
  }
}

async function loadSettings() {
  try {
    const data = await fetchJSON('/api/admin/settings');
    adminState.settings = data.settings || {};
    renderSettingsForm();
  } catch (error) {
    createToast(error.message, 'error');
  }
}

async function loadDashboard() {
  try {
    const data = await fetchJSON('/api/admin/dashboard');
    adminState.dashboard = data;
    renderDashboardStats();
    renderDashboardTrends(7);
  } catch (error) {
    // 数据看板接口失败时仍用 bootstrap 的基础统计
    renderDashboardStats();
  }
}

function renderSettingsForm() {
  const container = document.getElementById('settings-form');
  const s = adminState.settings;
  const fields = [
    { key: 'site_name', label: '站点名称', type: 'text' },
    { key: 'trial_days', label: '默认体验天数', type: 'number' },
    { key: 'course_preview_count', label: '课程试看节数', type: 'number' },
    { key: 'low_stock_threshold', label: '低库存阈值', type: 'number' },
    { key: 'customer_service_account', label: '客服通知账号', type: 'text' },
    { key: 'wx_subscribe_template_id', label: '微信订阅消息模板 ID', type: 'text' },
    { key: 'payment_mode', label: '支付开关', type: 'select', options: { simulated: '开发环境模拟支付', wechat: '正式微信支付' } }
  ];

  container.innerHTML = fields.map((f) => {
    const value = escapeHtml(s[f.key] || '');
    let inputHtml;
    if (f.type === 'select') {
      inputHtml = `
        <select id="setting-${f.key}" class="input">
          ${Object.entries(f.options).map(([k, label]) => `
            <option value="${escapeHtml(k)}" ${value === k ? 'selected' : ''}>${escapeHtml(label)}</option>
          `).join('')}
        </select>
      `;
    } else {
      inputHtml = `<input id="setting-${f.key}" class="input" type="${f.type}" value="${value}" />
      `;
    }
    return `
      <label style="display: grid; gap: 6px;">
        <span>${escapeHtml(f.label)}</span>
        ${inputHtml}
      </label>
    `;
  }).join('');
}

async function saveSettings() {
  const fields = ['site_name', 'trial_days', 'course_preview_count', 'low_stock_threshold', 'customer_service_account', 'wx_subscribe_template_id', 'payment_mode'];
  const updates = {};
  for (const key of fields) {
    const input = document.getElementById(`setting-${key}`);
    if (input) updates[key] = input.value;
  }

  const btn = document.getElementById('save-settings-button');
  setButtonLoading(btn, true);
  try {
    await fetchJSON('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify(updates)
    });
    adminState.settings = { ...adminState.settings, ...updates };
    createToast('设置已保存。', 'success');
  } catch (error) {
    createToast(error.message, 'error');
  } finally {
    setButtonLoading(btn, false);
  }
}

function renderApplications() {
  const container = document.getElementById('applications-list');
  const pending = adminState.applications.filter((a) => a.status === 'pending');
  const processed = adminState.applications.filter((a) => a.status !== 'pending');

  let html = '';

  if (pending.length) {
    html += '<h4>待审核</h4>';
    html += '<div style="display: grid; gap: 12px;">';
    pending.forEach((app) => {
      html += `
        <div class="paper-card" style="padding: 16px;">
          <div style="display: flex; justify-content: space-between; align-items: start; flex-wrap: wrap; gap: 12px;">
            <div>
              <strong>${escapeHtml(app.displayName)}</strong>
              <span class="muted" style="margin-left: 8px;">@${escapeHtml(app.username)}</span>
              ${app.className ? `<span class="badge" style="margin-left: 8px;">${escapeHtml(app.className)}</span>` : ''}
              ${app.motivation ? `<p class="muted" style="margin-top: 6px;">${escapeHtml(app.motivation)}</p>` : ''}
              <p class="muted" style="margin-top: 4px; font-size: 12px;">申请时间：${formatDateTime(app.createdAt)}</p>
            </div>
            <div style="display: flex; gap: 8px;">
              <button class="button" style="padding: 6px 16px; font-size: 13px;" data-action="approve-app" data-id="${app.id}">批准</button>
              <button class="ghost-button" style="padding: 6px 16px; font-size: 13px; color: var(--danger);" data-action="reject-app" data-id="${app.id}">拒绝</button>
            </div>
          </div>
        </div>`;
    });
    html += '</div>';
  } else {
    html += '<p class="muted">暂无待审核的注册申请。</p>';
  }

  if (processed.length) {
    html += '<h4 style="margin-top: 24px;">已处理</h4>';
    html += '<div style="display: grid; gap: 8px;">';
    processed.forEach((app) => {
      const statusLabel = app.status === 'approved' ? '<span style="color: var(--success);">已批准</span>' : '<span style="color: var(--danger);">已拒绝</span>';
      html += `
        <div class="paper-card" style="padding: 12px; opacity: 0.7;">
          <strong>${escapeHtml(app.displayName)}</strong>
          <span class="muted" style="margin-left: 8px;">@${escapeHtml(app.username)}</span>
          ${statusLabel}
          <span class="muted" style="margin-left: 8px; font-size: 12px;">${formatDateTime(app.reviewedAt)}</span>
        </div>`;
    });
    html += '</div>';
  }

  container.innerHTML = html;
}

function renderUsers() {
  const container = document.getElementById('users-list');
  const search = (document.getElementById('user-search').value || '').toLowerCase();
  const roleFilter = document.getElementById('user-role-filter').value;

  let filtered = adminState.users;
  if (roleFilter) {
    filtered = filtered.filter((u) => u.role === roleFilter);
  }
  if (search) {
    filtered = filtered.filter((u) => u.username.toLowerCase().includes(search) || u.displayName.toLowerCase().includes(search));
  }

  if (!filtered.length) {
    container.innerHTML = '<p class="muted">没有匹配的用户。</p>';
    return;
  }

  const PAGE_SIZE = 20;
  if (!adminState._userPage) adminState._userPage = 1;
  if (search || roleFilter) adminState._userPage = 1;
  const page = adminState._userPage;
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const pageUsers = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  let html = '<table style="width: 100%; border-collapse: collapse;">';
  html += '<thead><tr style="border-bottom: 2px solid var(--border);">';
  html += '<th style="text-align: left; padding: 8px;">用户名</th>';
  html += '<th style="text-align: left; padding: 8px;">姓名</th>';
  html += '<th style="text-align: left; padding: 8px;">角色</th>';
  html += '<th style="text-align: left; padding: 8px;">班级</th>';
  html += '<th style="text-align: left; padding: 8px;">注册时间</th>';
  html += '<th style="text-align: right; padding: 8px;">操作</th>';
  html += '</tr></thead><tbody>';

  pageUsers.forEach((user) => {
    const roleLabel = ROLE_LABELS[user.role] || user.role;
    const roleBadge = ROLE_BADGE_STYLES[user.role] || 'background: #6b7280;';
    html += `
      <tr style="border-bottom: 1px solid var(--border);">
        <td style="padding: 8px;">${escapeHtml(user.username)}</td>
        <td style="padding: 8px;">${escapeHtml(user.displayName)}</td>
        <td style="padding: 8px;"><span class="badge" style="${roleBadge} color: white;">${roleLabel}</span></td>
        <td style="padding: 8px;">${escapeHtml(user.className || '-')}</td>
        <td style="padding: 8px; font-size: 13px;">${formatDateTime(user.createdAt)}</td>
        <td style="padding: 8px; text-align: right;">
          ${user.role !== 'admin' ? `<button class="ghost-button" style="font-size: 12px; color: var(--danger); padding: 4px 10px;" data-action="delete-user" data-user-id="${user.id}" data-user-name="${escapeHtml(user.displayName)}">删除</button>` : ''}
        </td>
      </tr>`;
  });

  html += '</tbody></table>';

  if (totalPages > 1) {
    html += '<div style="display:flex;justify-content:center;align-items:center;gap:12px;margin-top:16px;font-size:14px;">';
    html += `<button class="ghost-button" style="padding:6px 14px;" data-action="admin-page" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>上一页</button>`;
    html += `<span class="muted">第 ${page} / ${totalPages} 页（共 ${filtered.length} 条）</span>`;
    html += `<button class="ghost-button" style="padding:6px 14px;" data-action="admin-page" data-page="${page + 1}" ${page >= totalPages ? 'disabled' : ''}>下一页</button>`;
    html += '</div>';
  }

  container.innerHTML = html;
}

function renderDashboardStats() {
  const container = document.getElementById('dashboard-grid');
  const s = adminState.stats || {};
  const d = adminState.dashboard || {};

  const cards = [
    { label: '总用户数', value: s.totalUsers || d.totalUsers || 0 },
    { label: '教师', value: s.teacherCount || d.teacherCount || 0 },
    { label: '学生', value: s.studentCount || d.studentCount || 0 },
    { label: '待审核申请', value: s.pendingApplications || d.pendingApplications || 0 }
  ];

  if (d.tierDistribution) {
    cards.push({ label: '免费用户', value: d.tierDistribution.free || 0 });
    cards.push({ label: '体验用户', value: d.tierDistribution.trial || 0 });
    cards.push({ label: '付费用户', value: d.tierDistribution.paid || 0 });
  }

  container.innerHTML = cards.map((c) => `
    <div class="metric-card">
      <div class="metric-value">${c.value}</div>
      <div class="metric-label">${escapeHtml(c.label)}</div>
    </div>
  `).join('');
}

function renderDashboardTrends(days) {
  const container = document.getElementById('dashboard-trends');
  const d = adminState.dashboard || {};
  const key = days === 30 ? 'trend30' : 'trend7';
  const trends = d[key] || {};

  const renderTrend = (title, labels, values) => {
    if (!values || !values.length) return `<div class="paper-card" style="padding: 16px; margin-bottom: 12px;">
      <h4>${escapeHtml(title)}</h4>
      <p class="muted">暂无数据</p>
    </div>`;
    const max = Math.max(...values, 1);
    return `
      <div class="paper-card" style="padding: 16px; margin-bottom: 12px;">
        <h4>${escapeHtml(title)}</h4>
        <div style="display: grid; gap: 8px; margin-top: 12px;">
          ${labels.map((label, i) => {
            const val = values[i] || 0;
            const pct = Math.round((val / max) * 100);
            return `
              <div style="display: flex; align-items: center; gap: 12px;">
                <span style="width: 70px; font-size: 12px; color: var(--muted);">${escapeHtml(label)}</span>
                <div style="flex: 1; background: var(--surface); height: 16px; border-radius: 8px; overflow: hidden;">
                  <div style="width: ${pct}%; background: var(--brand); height: 100%;"></div>
                </div>
                <span style="width: 40px; text-align: right; font-size: 12px;">${val}</span>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  };

  const labels = trends.labels || [];
  container.innerHTML = `
    ${renderTrend('新增学员趋势', labels, trends.newStudents)}
    ${renderTrend('收入趋势', labels, trends.revenue)}
    ${renderTrend('任务完成率趋势', labels, trends.taskCompletionRate)}
    ${renderTrend('做题量趋势', labels, trends.questionCount)}
    ${renderTrend('课程学习趋势', labels, trends.courseViews)}
  `;
}

async function approveApplication(id) {
  try {
    await fetchJSON(`/api/admin/applications/${id}/approve`, { method: 'POST' });
    createToast('已批准，教师账号已创建。', 'success');
    await loadBootstrap();
  } catch (error) {
    createToast(error.message, 'error');
  }
}

async function rejectApplication(id) {
  try {
    await fetchJSON(`/api/admin/applications/${id}/reject`, { method: 'POST' });
    createToast('已拒绝该申请。', 'success');
    await loadBootstrap();
  } catch (error) {
    createToast(error.message, 'error');
  }
}

async function deleteUser(id, name) {
  if (!await confirmDialog({ title: '删除用户', message: `确定要删除用户「${name}」吗？此操作不可撤销。`, confirmText: '删除', danger: true })) return;
  try {
    await fetchJSON(`/api/admin/users/${id}`, { method: 'DELETE' });
    createToast('用户已删除。', 'success');
    await loadBootstrap();
  } catch (error) {
    createToast(error.message, 'error');
  }
}

// ===== P3/P4 运营面板数据 =====

adminState.contentType = 'courses';
adminState.forumTab = 'topics';
adminState.students = [];
adminState.questions = [];
adminState.contentData = {};
adminState.forumData = {};

function initOperationsListeners() {
  document.getElementById('content-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-content-type]');
    if (!btn) return;
    adminState.contentType = btn.dataset.contentType;
    document.querySelectorAll('#content-tabs button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('category-form').classList.toggle('hidden', adminState.contentType !== 'categories');
    loadContent();
  });

  document.getElementById('forum-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-forum-tab]');
    if (!btn) return;
    adminState.forumTab = btn.dataset.forumTab;
    document.querySelectorAll('#forum-tabs button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    loadForum();
  });

  document.getElementById('student-search').addEventListener('input', () => {
    loadStudents();
  });
  document.getElementById('student-tier-filter').addEventListener('change', () => {
    loadStudents();
  });

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-admin-action]');
    if (!btn) return;
    const action = btn.dataset.adminAction;
    if (action === 'load-questions') loadQuestions();
    if (action === 'load-students') loadStudents();
    if (action === 'load-content') loadContent();
    if (action === 'load-forum') loadForum();
  });

  // 内容管理操作
  document.getElementById('content-list').addEventListener('change', async (e) => {
    const select = e.target.closest('[data-content-update]');
    if (!select) return;
    const [type, id, field] = select.dataset.contentUpdate.split('|');
    const value = select.value;
    try {
      await fetchJSON(`/api/admin/content/${type}/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ [field]: value })
      });
      createToast('已更新', 'success');
    } catch (error) {
      createToast(error.message, 'error');
    }
  });

  document.getElementById('content-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-content-delete]');
    if (btn) {
      const [type, id, title] = [btn.dataset.contentDelete, btn.dataset.contentId, btn.dataset.contentTitle];
      if (!await confirmDialog({ title: '删除内容', message: `确定删除「${title}」吗？`, confirmText: '删除', danger: true })) return;
      try {
        await fetchJSON(`/api/admin/content/${type}/${id}`, { method: 'DELETE' });
        createToast('已删除', 'success');
        loadContent();
      } catch (error) {
        createToast(error.message, 'error');
      }
      return;
    }

    const editBtn = e.target.closest('[data-category-edit]');
    if (editBtn) {
      document.getElementById('category-id').value = editBtn.dataset.categoryEdit;
      document.getElementById('category-name').value = editBtn.dataset.categoryName;
      document.getElementById('category-type').value = editBtn.dataset.categoryType;
      document.getElementById('category-sort').value = editBtn.dataset.categorySort;
      document.getElementById('category-form').classList.remove('hidden');
      return;
    }

    const delCatBtn = e.target.closest('[data-category-delete]');
    if (delCatBtn) {
      if (!await confirmDialog({ title: '删除分类', message: `确定删除分类「${delCatBtn.dataset.categoryName}」吗？`, confirmText: '删除', danger: true })) return;
      try {
        await fetchJSON(`/api/admin/course-categories/${delCatBtn.dataset.categoryDelete}`, { method: 'DELETE' });
        createToast('已删除', 'success');
        loadContent();
      } catch (error) {
        createToast(error.message, 'error');
      }
      return;
    }

    if (e.target.closest('#add-category-btn')) {
      document.getElementById('category-id').value = '';
      document.getElementById('category-name').value = '';
      document.getElementById('category-type').value = 'public';
      document.getElementById('category-sort').value = '0';
      document.getElementById('category-form').classList.remove('hidden');
    }
  });

  document.getElementById('save-category-btn').addEventListener('click', async () => {
    const id = document.getElementById('category-id').value;
    const name = document.getElementById('category-name').value.trim();
    const type = document.getElementById('category-type').value;
    const sortOrder = Number(document.getElementById('category-sort').value) || 0;
    if (!name) { createToast('请输入分类名称。', 'error'); return; }
    try {
      if (id) {
        await fetchJSON(`/api/admin/course-categories/${id}`, { method: 'PUT', body: JSON.stringify({ name, type, sortOrder }) });
      } else {
        await fetchJSON('/api/admin/course-categories', { method: 'POST', body: JSON.stringify({ name, type, sortOrder }) });
      }
      createToast('已保存', 'success');
      document.getElementById('category-form').classList.add('hidden');
      loadContent();
    } catch (error) {
      createToast(error.message, 'error');
    }
  });

  document.getElementById('cancel-category-btn').addEventListener('click', () => {
    document.getElementById('category-form').classList.add('hidden');
  });

  // 题库操作
  document.getElementById('questions-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-question-action]');
    if (!btn) return;
    const action = btn.dataset.questionAction;
    const id = Number(btn.dataset.questionId);
    if (action === 'delete') {
      if (!await confirmDialog({ title: '删除题目', message: '确定删除该题目吗？', confirmText: '删除', danger: true })) return;
      try {
        await fetchJSON(`/api/admin/questions/${id}`, { method: 'DELETE' });
        createToast('已删除', 'success');
        loadQuestions();
      } catch (error) {
        createToast(error.message, 'error');
      }
    }
    if (action === 'toggle-paid') {
      try {
        await fetchJSON(`/api/admin/questions/${id}`, {
          method: 'PUT',
          body: JSON.stringify({ isPaidOnly: btn.dataset.paid === '1' ? 0 : 1 })
        });
        createToast('已更新', 'success');
        loadQuestions();
      } catch (error) {
        createToast(error.message, 'error');
      }
    }
  });

  // 论坛操作
  document.getElementById('forum-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-forum-action]');
    if (!btn) return;
    const action = btn.dataset.forumAction;
    const id = Number(btn.dataset.forumId);
    const type = btn.dataset.forumType;
    const wordId = Number(btn.dataset.wordId);
    try {
      if (action === 'delete') {
        if (!await confirmDialog({ title: '删除', message: '确定删除吗？', confirmText: '删除', danger: true })) return;
        await fetchJSON(`/api/admin/forum/${type}/${id}`, { method: 'DELETE' });
        createToast('已删除', 'success');
      } else if (action === 'pin') {
        await fetchJSON(`/api/admin/forum/topics/${id}/pin`, { method: 'POST', body: JSON.stringify({ pinned: btn.dataset.pinned !== '1' }) });
        createToast('已更新', 'success');
      } else if (action === 'feature') {
        await fetchJSON(`/api/admin/forum/topics/${id}/featured`, { method: 'POST', body: JSON.stringify({ featured: btn.dataset.featured !== '1' }) });
        createToast('已更新', 'success');
      } else if (action === 'review') {
        await fetchJSON(`/api/admin/forum/reports/${id}/review`, { method: 'POST', body: JSON.stringify({ status: btn.dataset.status }) });
        createToast('已更新', 'success');
      } else if (action === 'approve-topic') {
        await fetchJSON(`/api/admin/moderation/topics/${id}/approve`, { method: 'POST' });
        createToast('已通过', 'success');
      } else if (action === 'reject-topic') {
        await fetchJSON(`/api/admin/moderation/topics/${id}/reject`, { method: 'POST' });
        createToast('已拒绝', 'success');
      } else if (action === 'approve-reply') {
        await fetchJSON(`/api/admin/moderation/replies/${id}/approve`, { method: 'POST' });
        createToast('已通过', 'success');
      } else if (action === 'reject-reply') {
        await fetchJSON(`/api/admin/moderation/replies/${id}/reject`, { method: 'POST' });
        createToast('已拒绝', 'success');
      } else if (action === 'delete-word') {
        if (!await confirmDialog({ title: '删除敏感词', message: '确定删除该敏感词吗？', confirmText: '删除', danger: true })) return;
        await fetchJSON(`/api/admin/moderation/words/${wordId}`, { method: 'DELETE' });
        createToast('已删除', 'success');
      }
      loadForum();
    } catch (error) {
      createToast(error.message, 'error');
    }
  });
}

async function loadStudents() {
  const tier = document.getElementById('student-tier-filter').value;
  const search = document.getElementById('student-search').value;
  const params = new URLSearchParams();
  if (tier) params.set('tier', tier);
  if (search) params.set('search', search);
  try {
    const data = await fetchJSON(`/api/admin/students?${params.toString()}`);
    adminState.students = data.students;
    renderStudents();
  } catch (error) {
    createToast(error.message, 'error');
  }
}

function renderStudents() {
  const container = document.getElementById('students-list');
  if (!adminState.students.length) {
    container.innerHTML = '<p class="muted">没有匹配的学员。</p>';
    return;
  }
  let html = '<table style="width: 100%; border-collapse: collapse;">';
  html += '<thead><tr style="border-bottom: 2px solid var(--border);">';
  ['姓名', '班级', '权益', '体验剩余', '今日完成', '累计做题', '正确率', '最近学习', '操作'].forEach((th) => {
    html += `<th style="text-align: left; padding: 8px;">${escapeHtml(th)}</th>`;
  });
  html += '</tr></thead><tbody>';

  adminState.students.forEach((s) => {
    const tierLabel = { free: '免费', trial: '体验', paid: '付费' }[s.tier] || s.tier;
    html += `
      <tr style="border-bottom: 1px solid var(--border);">
        <td style="padding: 8px;">${escapeHtml(s.displayName)} <span class="muted">@${escapeHtml(s.username)}</span></td>
        <td style="padding: 8px;">${escapeHtml(s.className || '-')}</td>
        <td style="padding: 8px;"><span class="badge" style="background: var(--brand); color: white;">${escapeHtml(tierLabel)}</span></td>
        <td style="padding: 8px;">${s.trialDaysLeft > 0 ? s.trialDaysLeft + ' 天' : '-'}</td>
        <td style="padding: 8px;">${s.todayCompleted}</td>
        <td style="padding: 8px;">${s.totalQuestions}</td>
        <td style="padding: 8px;">${s.accuracy}%</td>
        <td style="padding: 8px; font-size: 12px;">${s.lastStudyAt ? formatDateTime(s.lastStudyAt) : '-'}</td>
        <td style="padding: 8px;"><button class="ghost-button" style="font-size: 12px;" data-student-detail="${s.id}">查看</button></td>
      </tr>`;
  });
  html += '</tbody></table>';
  container.innerHTML = html;
}

async function loadContent() {
  try {
    if (adminState.contentType === 'categories') {
      const data = await fetchJSON('/api/course-categories');
      adminState.contentData = { categories: data.categories || [] };
      renderContent();
      return;
    }
    const data = await fetchJSON(`/api/admin/content?type=${adminState.contentType}`);
    adminState.contentData = data;
    renderContent();
  } catch (error) {
    createToast(error.message, 'error');
  }
}

function renderContent() {
  const container = document.getElementById('content-list');
  const type = adminState.contentType;

  if (type === 'categories') {
    renderCategories(container);
    return;
  }

  const items = adminState.contentData[type === 'courses' ? 'courses' : type === 'folder_items' ? 'folderItems' : type === 'live_sessions' ? 'liveSessions' : 'products'] || [];

  if (!items.length) {
    container.innerHTML = '<p class="muted">暂无内容。</p>';
    return;
  }

  const visibilityOptions = `
    <option value="free">免费</option>
    <option value="preview">试看</option>
    <option value="trial_paid">体验/付费</option>
    <option value="subject_paid">科目付费</option>
    <option value="all_paid">全科付费</option>
  `;

  let html = '<table style="width: 100%; border-collapse: collapse;">';
  html += '<thead><tr style="border-bottom: 2px solid var(--border);">';
  ['标题', '科目/分类', '可见性', '操作'].forEach((th) => html += `<th style="text-align: left; padding: 8px;">${escapeHtml(th)}</th>`);
  html += '</tr></thead><tbody>';

  items.forEach((item) => {
    html += `
      <tr style="border-bottom: 1px solid var(--border);">
        <td style="padding: 8px;">${escapeHtml(item.title)} <span class="muted" style="font-size: 12px;">${escapeHtml(item.teacherName || item.folderName || '')}</span></td>
        <td style="padding: 8px;">${escapeHtml(item.subject || item.category || item.itemType || '-')}</td>
        <td style="padding: 8px;">
          <select class="input" style="width: auto; padding: 4px 8px; font-size: 13px;" data-content-update="${type}|${item.id}|visibility">
            ${visibilityOptions.replace(`value="${item.visibility}"`, `value="${item.visibility}" selected`)}
          </select>
        </td>
        <td style="padding: 8px;">
          <button class="ghost-button" style="font-size: 12px; color: var(--danger);" data-content-delete="${type}" data-content-id="${item.id}" data-content-title="${escapeHtml(item.title)}">删除</button>
        </td>
      </tr>`;
  });
  html += '</tbody></table>';
  container.innerHTML = html;
}

function renderCategories(container) {
  const items = adminState.contentData.categories || [];
  if (!items.length) {
    container.innerHTML = '<p class="muted">暂无分类，点击上方“新增/编辑分类”添加。</p>';
    return;
  }
  let html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;"><span class="muted" style="font-size:13px;">管理公共课/专业课分类</span><button class="button" id="add-category-btn" type="button" style="font-size:12px;padding:6px 14px;">新增分类</button></div>';
  html += '<table style="width: 100%; border-collapse: collapse;">';
  html += '<thead><tr style="border-bottom: 2px solid var(--border);">';
  ['名称', '类型', '排序', '操作'].forEach((th) => html += `<th style="text-align: left; padding: 8px;">${escapeHtml(th)}</th>`);
  html += '</tr></thead><tbody>';
  items.forEach((item) => {
    const typeLabel = item.type === 'public' ? '公共课' : '专业课';
    html += `
      <tr style="border-bottom: 1px solid var(--border);">
        <td style="padding: 8px;">${escapeHtml(item.name)}</td>
        <td style="padding: 8px;"><span class="badge" style="background:${item.type === 'public' ? 'var(--brand)' : '#8b5cf6'};color:white;">${escapeHtml(typeLabel)}</span></td>
        <td style="padding: 8px;">${item.sortOrder}</td>
        <td style="padding: 8px;">
          <button class="ghost-button" style="font-size: 12px;" data-category-edit="${item.id}" data-category-name="${escapeHtml(item.name)}" data-category-type="${item.type}" data-category-sort="${item.sortOrder}">编辑</button>
          <button class="ghost-button" style="font-size: 12px; color: var(--danger); margin-left: 8px;" data-category-delete="${item.id}" data-category-name="${escapeHtml(item.name)}">删除</button>
        </td>
      </tr>`;
  });
  html += '</tbody></table>';
  container.innerHTML = html;
}

async function loadQuestions() {
  try {
    const data = await fetchJSON('/api/admin/questions');
    adminState.questions = data.questions;
    renderQuestions();
  } catch (error) {
    createToast(error.message, 'error');
  }
}

function renderQuestions() {
  const container = document.getElementById('questions-list');
  if (!adminState.questions.length) {
    container.innerHTML = '<p class="muted">暂无题目。</p>';
    return;
  }
  let html = '<table style="width: 100%; border-collapse: collapse;">';
  html += '<thead><tr style="border-bottom: 2px solid var(--border);">';
  ['标题', '科目', '题型', '付费', '操作'].forEach((th) => html += `<th style="text-align: left; padding: 8px;">${escapeHtml(th)}</th>`);
  html += '</tr></thead><tbody>';

  adminState.questions.forEach((q) => {
    html += `
      <tr style="border-bottom: 1px solid var(--border);">
        <td style="padding: 8px;">${escapeHtml(q.title)}</td>
        <td style="padding: 8px;">${escapeHtml(q.subject)}</td>
        <td style="padding: 8px;">${escapeHtml(q.questionType || '-')}</td>
        <td style="padding: 8px;">${q.isPaidOnly ? '<span class="badge" style="background: var(--warning);">付费</span>' : '免费'}</td>
        <td style="padding: 8px;">
          <button class="ghost-button" style="font-size: 12px;" data-question-action="toggle-paid" data-question-id="${q.id}" data-paid="${q.isPaidOnly}">${q.isPaidOnly ? '设为免费' : '设为付费'}</button>
          <button class="ghost-button" style="font-size: 12px; color: var(--danger); margin-left: 8px;" data-question-action="delete" data-question-id="${q.id}">删除</button>
        </td>
      </tr>`;
  });
  html += '</tbody></table>';
  container.innerHTML = html;
}

async function loadForum() {
  try {
    const tab = adminState.forumTab;
    const form = document.getElementById('forum-words-form');
    form.style.display = 'none';
    if (tab === 'words') {
      const data = await fetchJSON('/api/admin/moderation/words');
      adminState.forumData[tab] = data.words;
      renderWordsForm();
    } else if (tab === 'pending') {
      const data = await fetchJSON('/api/admin/moderation/pending');
      adminState.forumData[tab] = data;
    } else {
      const url = tab === 'topics' ? '/api/admin/forum/topics' : tab === 'replies' ? '/api/admin/forum/replies' : '/api/admin/forum/reports';
      const data = await fetchJSON(url);
      adminState.forumData[tab] = data[tab === 'topics' ? 'topics' : tab === 'replies' ? 'replies' : 'reports'];
    }
    renderForum();
  } catch (error) {
    createToast(error.message, 'error');
  }
}

function renderForum() {
  const container = document.getElementById('forum-list');
  const wordsForm = document.getElementById('forum-words-form');
  const tab = adminState.forumTab;
  wordsForm.style.display = tab === 'words' ? 'block' : 'none';
  const items = adminState.forumData[tab] || [];

  if (tab === 'words') {
    if (!items.length) {
      container.innerHTML = '<p class="muted">暂无敏感词。</p>';
      return;
    }
    let html = '<table style="width: 100%; border-collapse: collapse;">';
    html += '<thead><tr style="border-bottom: 2px solid var(--border);"><th style="text-align:left;padding:8px;">敏感词</th><th style="text-align:left;padding:8px;">级别</th><th style="text-align:right;padding:8px;">操作</th></tr></thead><tbody>';
    items.forEach((w) => {
      html += `<tr style="border-bottom:1px solid var(--border);">
        <td style="padding:8px;">${escapeHtml(w.word)}</td>
        <td style="padding:8px;">${w.level === 'block' ? '<span class="badge" style="background:var(--danger);color:white;">拦截</span>' : '<span class="badge" style="background:var(--warning);">人工复核</span>'}</td>
        <td style="padding:8px;text-align:right;"><button class="ghost-button" style="font-size:12px;color:var(--danger);" data-forum-action="delete-word" data-word-id="${w.id}">删除</button></td>
      </tr>`;
    });
    html += '</tbody></table>';
    container.innerHTML = html;
    return;
  }

  if (tab === 'pending') {
    const topics = items.topics || [];
    const replies = items.replies || [];
    if (!topics.length && !replies.length) {
      container.innerHTML = '<p class="muted">暂无待审核内容。</p>';
      return;
    }
    let html = '<div style="display: grid; gap: 12px;">';
    topics.forEach((t) => {
      html += `
        <div class="paper-card" style="padding: 12px;">
          <span class="badge" style="background:var(--warning);">帖子</span>
          <strong style="margin-left:6px;">${escapeHtml(t.title)}</strong>
          <p class="muted" style="margin-top:6px;">${escapeHtml((t.content || '').slice(0, 120))}...</p>
          <p class="muted" style="font-size:12px; margin-top:4px;">${escapeHtml(t.author_name || '')} · ${formatDateTime(t.created_at)}</p>
          <div style="display:flex;gap:8px;margin-top:8px;">
            <button class="button" style="font-size:12px;padding:4px 10px;" data-forum-action="approve-topic" data-forum-id="${t.id}">通过</button>
            <button class="ghost-button" style="font-size:12px;color:var(--danger);" data-forum-action="reject-topic" data-forum-id="${t.id}">拒绝</button>
          </div>
        </div>`;
    });
    replies.forEach((r) => {
      html += `
        <div class="paper-card" style="padding: 12px;">
          <span class="badge" style="background:#6366f1;color:white;">回复</span>
          <p class="muted" style="margin-top:6px;">${escapeHtml((r.content || '').slice(0, 120))}...</p>
          <p class="muted" style="font-size:12px; margin-top:4px;">${escapeHtml(r.author_name || '')} · ${formatDateTime(r.created_at)}</p>
          <div style="display:flex;gap:8px;margin-top:8px;">
            <button class="button" style="font-size:12px;padding:4px 10px;" data-forum-action="approve-reply" data-forum-id="${r.id}">通过</button>
            <button class="ghost-button" style="font-size:12px;color:var(--danger);" data-forum-action="reject-reply" data-forum-id="${r.id}">拒绝</button>
          </div>
        </div>`;
    });
    html += '</div>';
    container.innerHTML = html;
    return;
  }

  if (!items.length) {
    container.innerHTML = '<p class="muted">暂无数据。</p>';
    return;
  }

  let html = '<div style="display: grid; gap: 12px;">';
  if (tab === 'topics') {
    items.forEach((t) => {
      html += `
        <div class="paper-card" style="padding: 16px;">
          <div style="display: flex; justify-content: space-between; align-items: start; gap: 12px;">
            <div>
              <strong>${escapeHtml(t.title)}</strong>
              ${t.moderationStatus && t.moderationStatus !== 'approved' ? `<span class="badge" style="background:var(--warning);margin-left:6px;">${t.moderationStatus}</span>` : ''}
              <p class="muted" style="margin-top: 6px;">${escapeHtml((t.content || '').slice(0, 80))}...</p>
              <p class="muted" style="font-size: 12px; margin-top: 4px;">${escapeHtml(t.authorName || '')} · ${formatDateTime(t.createdAt)} · 👍 ${t.likeCount || 0} · 💬 ${t.replies ? t.replies.length : 0}</p>
            </div>
            <div style="display: flex; gap: 8px; flex-shrink: 0;">
              <button class="ghost-button" style="font-size: 12px;" data-forum-action="pin" data-forum-type="topics" data-forum-id="${t.id}" data-pinned="${t.isPinned || 0}">${t.isPinned ? '取消置顶' : '置顶'}</button>
              <button class="ghost-button" style="font-size: 12px;" data-forum-action="feature" data-forum-type="topics" data-forum-id="${t.id}" data-featured="${t.isFeatured || 0}">${t.isFeatured ? '取消精华' : '精华'}</button>
              <button class="ghost-button" style="font-size: 12px; color: var(--danger);" data-forum-action="delete" data-forum-type="topics" data-forum-id="${t.id}">删除</button>
            </div>
          </div>
        </div>`;
    });
  } else if (tab === 'replies') {
    items.forEach((r) => {
      html += `
        <div class="paper-card" style="padding: 12px;">
          <p class="muted">${escapeHtml((r.content || '').slice(0, 100))}...</p>
          <p class="muted" style="font-size: 12px; margin-top: 4px;">${escapeHtml(r.authorName || r.author_name || '')} · ${formatDateTime(r.createdAt || r.created_at)}</p>
          <button class="ghost-button" style="font-size: 12px; color: var(--danger); margin-top: 8px;" data-forum-action="delete" data-forum-type="replies" data-forum-id="${r.id}">删除</button>
        </div>`;
    });
  } else {
    items.forEach((r) => {
      html += `
        <div class="paper-card" style="padding: 12px;">
          <p><strong>${escapeHtml(r.reason || '无原因')}</strong> · 状态：${escapeHtml(r.status)}</p>
          <p class="muted" style="font-size: 12px;">举报人：${escapeHtml(r.reporter_name || '')} · ${formatDateTime(r.created_at)}</p>
          <div style="display: flex; gap: 8px; margin-top: 8px;">
            <button class="ghost-button" style="font-size: 12px;" data-forum-action="review" data-forum-type="reports" data-forum-id="${r.id}" data-status="reviewed">通过</button>
            <button class="ghost-button" style="font-size: 12px;" data-forum-action="review" data-forum-type="reports" data-forum-id="${r.id}" data-status="dismissed">驳回</button>
          </div>
        </div>`;
    });
  }
  html += '</div>';
  container.innerHTML = html;
}

function renderWordsForm() {
  const container = document.getElementById('forum-words-form');
  container.innerHTML = `
    <div class="paper-card" style="padding: 16px;">
      <h4 style="margin:0 0 12px;">添加敏感词</h4>
      <div style="display:flex;gap:12px;align-items:flex-end;">
        <label style="flex:1;">敏感词<input id="new-word-text" class="input" type="text" placeholder="输入关键词" /></label>
        <label>级别
          <select id="new-word-level" class="input">
            <option value="review">人工复核</option>
            <option value="block">直接拦截</option>
          </select>
        </label>
        <button class="button" id="add-word-button" type="button">添加</button>
      </div>
    </div>
  `;
  container.querySelector('#add-word-button').addEventListener('click', async () => {
    const word = document.getElementById('new-word-text').value.trim();
    const level = document.getElementById('new-word-level').value;
    if (!word) return createToast('请输入敏感词。', 'error');
    try {
      await fetchJSON('/api/admin/moderation/words', { method: 'POST', body: JSON.stringify({ word, level }) });
      createToast('已添加。', 'success');
      loadForum();
    } catch (error) { createToast(error.message, 'error'); }
  });
}

// 在切换菜单时按需加载运营数据
const originalSwitchMenu = switchMenu;
switchMenu = function(menuId) {
  originalSwitchMenu(menuId);
  if (menuId === 'students') loadStudents();
  if (menuId === 'content') loadContent();
  if (menuId === 'questions') loadQuestions();
  if (menuId === 'forum') loadForum();
};

// 初始化
initOperationsListeners();

// ===== 学员详情与专属复习计划 =====

async function openStudentDetail(studentId) {
  const modal = document.getElementById('student-detail-modal');
  const body = document.getElementById('student-detail-body');
  const title = document.getElementById('student-detail-title');

  modal.style.display = 'flex';
  body.innerHTML = '<p class="muted">加载中...</p>';
  title.textContent = '学员详情';

  try {
    const data = await fetchJSON(`/api/admin/students/${studentId}`);
    title.textContent = `${escapeHtml(data.student.display_name || data.student.username)} 的详情`;
    renderStudentDetail(body, data, studentId);
  } catch (error) {
    body.innerHTML = `<p class="muted">加载失败：${escapeHtml(error.message)}</p>`;
  }
}

function closeStudentDetail() {
  const modal = document.getElementById('student-detail-modal');
  modal.style.display = 'none';
  document.getElementById('student-detail-body').innerHTML = '';
}

function renderStudentDetail(container, data, studentId) {
  const s = data.student || {};
  const e = data.entitlement || {};
  const ps = data.practiceStats || {};
  const calendar = data.taskCalendar || [];
  const wrongDistribution = ps.wrongDistribution || [];
  const plans = data.personalPlans || [];
  const tierLabel = { free: '免费', trial: '体验', paid: '付费' }[e.effectiveTier || e.tier] || (e.effectiveTier || e.tier || '未填写');
  const isPaid = (e.effectiveTier || e.tier) === 'paid';

  // 基本信息字段
  const basicInfo = [
    { label: '姓名', value: s.display_name || '未填写' },
    { label: '用户名', value: s.username || '未填写' },
    { label: '班级', value: s.class_name || '未填写' },
    { label: '电话', value: s.phone || '未填写' },
    { label: '毕业院校', value: s.graduated_school || '未填写' },
    { label: '目标院校', value: s.target_school || '未填写' },
    { label: '当前进度', value: s.current_progress || '未填写' },
    { label: '权益', value: tierLabel }
  ];

  // 学习数据
  const studyStats = [
    { label: '累计做题数', value: ps.totalQuestions || 0 },
    { label: '正确率', value: `${ps.accuracy || 0}%` },
    { label: '今日完成', value: (data.taskCalendar && data.taskCalendar.find(c => c.task_date === new Date().toISOString().slice(0, 10))?.cnt) || 0 },
    { label: '连续打卡', value: data.streakDays || '—' },
    { label: '最近学习日期', value: s.last_study_at ? formatDateTime(s.last_study_at) : '—' }
  ];

  // 日历渲染（最近30天）
  const today = new Date();
  const calendarHtml = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const dayNum = d.getDate();
    const completed = calendar.find(c => c.task_date === dateStr);
    const isDone = completed && completed.cnt > 0;
    calendarHtml.push(`<div style="width: 28px; height: 28px; border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 11px; ${isDone ? 'background: var(--success); color: white;' : 'background: var(--surface); color: var(--muted);'}" title="${dateStr}${isDone ? ' 已完成' : ''}">${dayNum}</div>`);
  }

  // 错题分布
  const wrongHtml = wrongDistribution.length
    ? `<table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <thead><tr style="border-bottom: 1px solid var(--border);"><th style="text-align: left; padding: 6px;">科目</th><th style="text-align: right; padding: 6px;">错题数</th></tr></thead>
        <tbody>${wrongDistribution.map(w => `<tr style="border-bottom: 1px solid var(--border);"><td style="padding: 6px;">${escapeHtml(w.subject)}</td><td style="padding: 6px; text-align: right;">${w.cnt}</td></tr>`).join('')}</tbody>
      </table>`
    : '<p class="muted">暂无错题数据</p>';

  // 专属计划列表
  const plansHtml = plans.length
    ? `<table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <thead><tr style="border-bottom: 1px solid var(--border);"><th style="text-align: left; padding: 6px;">标题</th><th style="text-align: left; padding: 6px;">科目</th><th style="text-align: left; padding: 6px;">时间</th><th style="text-align: left; padding: 6px;">状态</th></tr></thead>
        <tbody>${plans.map(p => {
          const start = p.startTime ? formatDateTime(p.startTime) : '—';
          const end = p.endTime ? formatDateTime(p.endTime) : '—';
          const status = p.status === 'completed' ? '<span style="color: var(--success);">已完成</span>' : '<span style="color: var(--brand);">进行中</span>';
          return `<tr style="border-bottom: 1px solid var(--border);"><td style="padding: 6px;">${escapeHtml(p.title)}</td><td style="padding: 6px;">${escapeHtml(p.subject || '—')}</td><td style="padding: 6px; font-size: 12px;">${start} ~ ${end}</td><td style="padding: 6px;">${status}</td></tr>`;
        }).join('')}</tbody>
      </table>`
    : '<p class="muted">暂无专属复习计划</p>';

  // 上传表单（仅付费学员）
  const planFormHtml = isPaid
    ? `<div class="paper-card" style="padding: 16px; margin-top: 16px;">
        <h4 style="margin: 0 0 12px;">上传专属复习计划</h4>
        <div style="display: grid; gap: 12px;">
          <label style="display: grid; gap: 4px;">
            <span style="font-size: 13px;">标题</span>
            <input class="input" id="plan-title" type="text" placeholder="计划标题" />
          </label>
          <label style="display: grid; gap: 4px;">
            <span style="font-size: 13px;">科目</span>
            <input class="input" id="plan-subject" type="text" placeholder="如：数学、英语" />
          </label>
          <label style="display: grid; gap: 4px;">
            <span style="font-size: 13px;">内容</span>
            <textarea class="input" id="plan-description" rows="3" placeholder="计划内容描述"></textarea>
          </label>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
            <label style="display: grid; gap: 4px;">
              <span style="font-size: 13px;">开始日期</span>
              <input class="input" id="plan-start" type="date" />
            </label>
            <label style="display: grid; gap: 4px;">
              <span style="font-size: 13px;">结束日期</span>
              <input class="input" id="plan-end" type="date" />
            </label>
          </div>
          <div>
            <span style="font-size: 13px; display: block; margin-bottom: 6px;">执行星期</span>
            <div style="display: flex; gap: 8px; flex-wrap: wrap;">
              ${['日', '一', '二', '三', '四', '五', '六'].map((day, i) => `<label style="display: flex; align-items: center; gap: 4px; font-size: 13px; cursor: pointer;"><input type="checkbox" class="plan-weekday" value="${i}" checked /> ${day}</label>`).join('')}
            </div>
          </div>
          <button class="button" id="submit-plan-btn" type="button" data-student-id="${studentId}">提交计划</button>
        </div>
      </div>`
    : `<div class="paper-card" style="padding: 16px; margin-top: 16px; background: var(--surface);">
        <p class="muted" style="margin: 0;">仅付费学员可上传专属复习计划</p>
      </div>`;

  container.innerHTML = `
    <div style="display: grid; gap: 20px;">
      <!-- 基本信息 -->
      <div class="paper-card" style="padding: 16px;">
        <h4 style="margin: 0 0 12px;">基本信息</h4>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; font-size: 13px;">
          ${basicInfo.map(info => `<div><span style="color: var(--muted);">${escapeHtml(info.label)}：</span><strong>${escapeHtml(String(info.value))}</strong></div>`).join('')}
        </div>
      </div>

      <!-- 学习数据 -->
      <div class="paper-card" style="padding: 16px;">
        <h4 style="margin: 0 0 12px;">学习数据</h4>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px;">
          ${studyStats.map(st => `<div class="metric-card" style="padding: 12px;"><div class="metric-value" style="font-size: 20px;">${escapeHtml(String(st.value))}</div><div class="metric-label" style="font-size: 12px;">${escapeHtml(st.label)}</div></div>`).join('')}
        </div>
      </div>

      <!-- 任务完成日历 -->
      <div class="paper-card" style="padding: 16px;">
        <h4 style="margin: 0 0 12px;">近30天任务完成情况</h4>
        <div style="display: flex; flex-wrap: wrap; gap: 4px;">
          ${calendarHtml.join('')}
        </div>
        <div style="margin-top: 8px; font-size: 12px; color: var(--muted);">
          <span style="display: inline-block; width: 12px; height: 12px; background: var(--success); border-radius: 3px; vertical-align: middle; margin-right: 4px;"></span>已完成
          <span style="display: inline-block; width: 12px; height: 12px; background: var(--surface); border-radius: 3px; vertical-align: middle; margin-left: 12px; margin-right: 4px;"></span>未完成
        </div>
      </div>

      <!-- 错题分布 -->
      <div class="paper-card" style="padding: 16px;">
        <h4 style="margin: 0 0 12px;">错题分布</h4>
        ${wrongHtml}
      </div>

      <!-- 专属复习计划 -->
      <div class="paper-card" style="padding: 16px;">
        <h4 style="margin: 0 0 12px;">专属复习计划</h4>
        ${plansHtml}
        ${planFormHtml}
      </div>
    </div>
  `;
}

async function submitStudentPlan(studentId) {
  const title = document.getElementById('plan-title').value.trim();
  const subject = document.getElementById('plan-subject').value.trim();
  const description = document.getElementById('plan-description').value.trim();
  const startTime = document.getElementById('plan-start').value;
  const endTime = document.getElementById('plan-end').value;
  const weekdays = Array.from(document.querySelectorAll('.plan-weekday:checked')).map(cb => Number(cb.value));

  if (!title || !startTime || !endTime) {
    createToast('请填写计划标题、开始和结束日期。', 'error');
    return;
  }
  if (new Date(startTime) > new Date(endTime)) {
    createToast('开始日期不能晚于结束日期。', 'error');
    return;
  }

  const btn = document.getElementById('submit-plan-btn');
  setButtonLoading(btn, true);
  try {
    await fetchJSON(`/api/admin/students/${studentId}/plans`, {
      method: 'POST',
      body: JSON.stringify({ title, subject, description, startTime, endTime, weekdays })
    });
    createToast('专属复习计划已创建。', 'success');
    await openStudentDetail(studentId);
  } catch (error) {
    createToast(error.message, 'error');
  } finally {
    setButtonLoading(btn, false);
  }
}

// 学员详情 Modal 事件监听
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-student-detail]');
  if (btn) {
    openStudentDetail(Number(btn.dataset.studentDetail));
    return;
  }
  if (e.target.closest('#close-student-detail')) {
    closeStudentDetail();
    return;
  }
  if (e.target.closest('#submit-plan-btn')) {
    const studentId = Number(e.target.closest('#submit-plan-btn').dataset.studentId);
    submitStudentPlan(studentId);
  }
});

// 点击 modal 背景关闭
document.getElementById('student-detail-modal').addEventListener('click', (e) => {
  if (e.target.id === 'student-detail-modal') closeStudentDetail();
});
