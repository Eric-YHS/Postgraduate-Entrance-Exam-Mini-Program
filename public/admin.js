const adminState = {
  applications: [],
  users: [],
  stats: {}
};

document.addEventListener('DOMContentLoaded', async () => {
  const authResult = await ensureAuth('admin');
  if (!authResult) return;

  document.getElementById('logout-button').addEventListener('click', logout);
  activateTabs('.tab-button', '.panel');
  await loadBootstrap();

  document.getElementById('user-search').addEventListener('input', renderUsers);
  document.getElementById('user-role-filter').addEventListener('change', renderUsers);
});

async function loadBootstrap() {
  try {
    const data = await fetchJSON('/api/admin/bootstrap');
    adminState.applications = data.applications;
    adminState.users = data.users;
    adminState.stats = data.stats;

    renderApplications();
    renderUsers();
    renderStats();

    document.getElementById('admin-sidebar-stats').innerHTML = `
      <div class="metric-card"><div class="metric-value">${data.stats.teacherCount}</div><div class="metric-label">教师</div></div>
      <div class="metric-card"><div class="metric-value">${data.stats.studentCount}</div><div class="metric-label">学生</div></div>
    `;
  } catch (error) {
    createToast(error.message, 'error');
  }
}

function renderApplications() {
  const container = document.getElementById('applications-list');
  const pending = adminState.applications.filter((a) => a.status === 'pending');
  const processed = adminState.applications.filter((a) => a.status !== 'pending');

  let html = '';

  if (pending.length) {
    html += '<h3>待审核</h3>';
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
              <button class="button" style="padding: 6px 16px; font-size: 13px;" onclick="approveApplication(${app.id})">批准</button>
              <button class="ghost-button" style="padding: 6px 16px; font-size: 13px; color: var(--danger);" onclick="rejectApplication(${app.id})">拒绝</button>
            </div>
          </div>
        </div>`;
    });
    html += '</div>';
  } else {
    html += '<p class="muted">暂无待审核的注册申请。</p>';
  }

  if (processed.length) {
    html += '<h3 style="margin-top: 24px;">已处理</h3>';
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
    const roleLabel = user.role === 'admin' ? '管理员' : user.role === 'teacher' ? '教师' : '学生';
    const roleBadge = user.role === 'admin' ? 'background: var(--brand);' : user.role === 'teacher' ? 'background: #059669;' : 'background: #6366f1;';
    html += `
      <tr style="border-bottom: 1px solid var(--border);">
        <td style="padding: 8px;">${escapeHtml(user.username)}</td>
        <td style="padding: 8px;">${escapeHtml(user.displayName)}</td>
        <td style="padding: 8px;"><span class="badge" style="${roleBadge} color: white;">${roleLabel}</span></td>
        <td style="padding: 8px;">${escapeHtml(user.className || '-')}</td>
        <td style="padding: 8px; font-size: 13px;">${formatDateTime(user.createdAt)}</td>
        <td style="padding: 8px; text-align: right;">
          ${user.role !== 'admin' ? `<button class="ghost-button" style="font-size: 12px; color: var(--danger); padding: 4px 10px;" data-user-id="${user.id}" data-user-name="${escapeHtml(user.displayName)}" onclick="deleteUser(Number(this.dataset.userId), this.dataset.userName)">删除</button>` : ''}
        </td>
      </tr>`;
  });

  html += '</tbody></table>';

  if (totalPages > 1) {
    html += '<div style="display:flex;justify-content:center;align-items:center;gap:12px;margin-top:16px;font-size:14px;">';
    html += `<button class="ghost-button" style="padding:6px 14px;" onclick="adminState._userPage=${page - 1};renderUsers();" ${page <= 1 ? 'disabled' : ''}>上一页</button>`;
    html += `<span class="muted">第 ${page} / ${totalPages} 页（共 ${filtered.length} 条）</span>`;
    html += `<button class="ghost-button" style="padding:6px 14px;" onclick="adminState._userPage=${page + 1};renderUsers();" ${page >= totalPages ? 'disabled' : ''}>下一页</button>`;
    html += '</div>';
  }

  container.innerHTML = html;
}

function renderStats() {
  const container = document.getElementById('stats-grid');
  const s = adminState.stats;
  container.innerHTML = `
    <div class="metric-card"><div class="metric-value">${s.totalUsers}</div><div class="metric-label">总用户数</div></div>
    <div class="metric-card"><div class="metric-value">${s.teacherCount}</div><div class="metric-label">教师</div></div>
    <div class="metric-card"><div class="metric-value">${s.studentCount}</div><div class="metric-label">学生</div></div>
    <div class="metric-card"><div class="metric-value">${s.pendingApplications}</div><div class="metric-label">待审核申请</div></div>
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
