const adminState = {
  user: null,
  settings: {},
  applications: [],
  users: [],
  stats: {},
  currentMenu: 'dashboard',
  currentSettingsTab: 'settings-general',
  _userPage: 1,
  knowledgeBases: [],
  currentKnowledgeBase: null,
  messageTemplates: [],
  currentMessageTemplate: null,
  bots: [],
  currentBot: null,
  wecomGroups: [],
  wecomDirectory: [],
  wecomDirectoryLoaded: false,
  wecomGroupModalMode: 'create',
  currentWecomGroupId: null,
  wecomKfStatus: null,
  wecomKfAccounts: [],
  wecomKfModalMode: '',
  currentWecomKfid: '',
  studentProfiles: [],
  robotOverview: null,
  robotTickets: [],
  promoterApplications: [],
  promoterFilter: { status: '' },
  refunds: []
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
  { id: 'refunds', label: '退款审核', icon: '💰', roles: ['admin', 'customer_service'] },
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

  if (location.hash !== `#${menuId}`) {
    history.replaceState(null, '', `${location.pathname}${location.search}#${menuId}`);
  }

  document.querySelectorAll('.admin-section').forEach((section) => section.classList.remove('active'));
  const target = document.getElementById(`section-${menuId}`);
  if (target) target.classList.add('active');

  document.querySelectorAll('.admin-menu button').forEach((btn) => btn.classList.toggle('active', btn.dataset.menu === menuId));
  const activeButton = document.querySelector(`.admin-menu button[data-menu="${menuId}"]`);
  if (activeButton && window.matchMedia('(max-width: 900px)').matches) {
    requestAnimationFrame(() => {
      const nav = activeButton.closest('nav');
      const left = activeButton.offsetLeft - ((nav.clientWidth - activeButton.offsetWidth) / 2);
      nav.scrollLeft = Math.max(0, left);
    });
  }

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
  const requestedMenu = location.hash.replace(/^#/, '');
  switchMenu(canAccessMenu(requestedMenu) ? requestedMenu : 'dashboard');

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
    } else if (action === 'kb-edit') {
      openKnowledgeBaseModal(id);
    } else if (action === 'kb-delete') {
      deleteKnowledgeBase(id);
    } else if (action === 'kb-view') {
      openKnowledgeBaseDetail(id);
    } else if (action === 'kb-add-doc') {
      openKnowledgeBaseDocModal(Number(btn.dataset.baseId));
    } else if (action === 'kb-del-doc') {
      deleteKnowledgeBaseDoc(Number(btn.dataset.baseId), Number(btn.dataset.docId));
    } else if (action === 'kb-process-doc') {
      processKnowledgeBaseDoc(Number(btn.dataset.baseId), Number(btn.dataset.docId), btn);
    } else if (action === 'mt-edit') {
      openMessageTemplateModal(id);
    } else if (action === 'mt-delete') {
      deleteMessageTemplate(id);
    } else if (action === 'mt-toggle') {
      toggleMessageTemplate(id, btn.dataset.active === 'true');
    } else if (action === 'mt-preview') {
      previewMessageTemplate(btn.dataset.code);
    } else if (action === 'bot-edit') {
      openBotModal(id);
    } else if (action === 'bot-delete') {
      deleteBot(id);
    } else if (action === 'bot-toggle') {
      toggleBot(id, btn.dataset.active === 'true');
    } else if (action === 'bot-view-conversations') {
      viewBotConversations(btn.dataset.code);
    } else if (action === 'bot-view-audits') {
      viewBotAudits(id);
    } else if (action === 'bot-gray-release') {
      createBotGrayRelease(id);
    } else if (action === 'bot-schedule-trigger') {
      triggerBotSchedule(id, btn.dataset.scheduleId);
    } else if (action === 'bot-add-group') {
      addBotToGroup(id);
    } else if (action === 'bot-remove-group') {
      removeBotFromGroup(id, Number(btn.dataset.groupId));
    } else if (action === 'student-profile-copy') {
      copyText(btn.dataset.url || '', '登记链接已复制。');
    } else if (action === 'student-plan-adjust') {
      adjustStudentPlan(Number(btn.dataset.studentId), btn.dataset.mode || 'semi_auto');
    } else if (action === 'student-plan-template-save') {
      saveStudentPlanTemplate(Number(btn.dataset.studentId));
    } else if (action === 'robot-ticket-resolve') {
      resolveRobotTicket(id);
    } else if (action === 'wecom-group-edit') {
      openWecomGroupSettings(id);
    } else if (action === 'wecom-group-members') {
      openWecomGroupMembers(id);
    } else if (action === 'wecom-group-rebind') {
      rebindWecomGroup(id);
    } else if (action === 'wecom-group-sync') {
      syncWecomGroup(id);
    } else if (action === 'wecom-kf-copy-callback') {
      copyText(adminState.wecomKfStatus?.callbackUrl || '', '回调 URL 已复制。');
    } else if (action === 'wecom-kf-copy-link') {
      const account = adminState.wecomKfAccounts.find((item) => item.openKfid === btn.dataset.openKfid);
      copyText(account?.contactUrl || '', '客服入口链接已复制。');
    } else if (action === 'wecom-kf-account-settings') {
      openWecomKfAccountSettings(btn.dataset.openKfid);
    } else if (action === 'wecom-kf-account-customers') {
      openWecomKfCustomers(btn.dataset.openKfid);
    } else if (action === 'wecom-kf-refresh-link') {
      refreshWecomKfLink(btn.dataset.openKfid);
    } else if (action === 'wecom-kf-sync-messages') {
      syncWecomKfMessages(btn.dataset.openKfid);
    } else if (action === 'wecom-kf-customer-takeover') {
      setWecomKfTakeover(
        btn.dataset.openKfid,
        btn.dataset.externalUserid,
        btn.dataset.manual === 'true'
      );
    } else if (action === 'promoter-approve') {
      approvePromoter(id);
    } else if (action === 'promoter-reject') {
      rejectPromoter(id);
    } else if (action === 'refund-approve') {
      handleRefund(id, 'approved');
    } else if (action === 'refund-reject') {
      handleRefund(id, 'rejected');
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
    { key: 'payment_mode', label: '支付开关', type: 'select', options: { simulated: '开发环境模拟支付', wechat: '正式微信支付' } },
    { key: 'wechat_appid', label: '微信 AppID', type: 'text' },
    { key: 'wechat_secret', label: '微信 Secret', type: 'text' },
    { key: 'alipay_appid', label: '支付宝 AppID', type: 'text' },
    { key: 'alipay_private_key', label: '支付宝私钥', type: 'text' },
    { key: 'alipay_public_key', label: '支付宝公钥', type: 'text' },
    { key: 'sms_access_key', label: '短信 AccessKey', type: 'text' },
    { key: 'sms_secret', label: '短信 Secret', type: 'text' },
    { key: 'oss_access_key', label: 'OSS AccessKey', type: 'text' },
    { key: 'oss_secret', label: 'OSS Secret', type: 'text' },
    { key: 'oss_bucket', label: 'OSS Bucket', type: 'text' },
    { key: 'oss_region', label: 'OSS Region', type: 'text' },
    { key: 'cdn_domain', label: 'CDN 域名', type: 'text' },
    { key: 'robot_api_key', label: '机器人 API Key', type: 'text' },
    { key: 'robot_api_endpoint', label: '机器人 API 地址', type: 'text' }
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
  const fields = ['site_name', 'trial_days', 'course_preview_count', 'low_stock_threshold', 'customer_service_account', 'wx_subscribe_template_id', 'payment_mode', 'wechat_appid', 'wechat_secret', 'alipay_appid', 'alipay_private_key', 'alipay_public_key', 'sms_access_key', 'sms_secret', 'oss_access_key', 'oss_secret', 'oss_bucket', 'oss_region', 'cdn_domain', 'robot_api_key', 'robot_api_endpoint'];
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

  // B-07: 新增数据看板指标
  if (d.todayTaskCompletionRate !== undefined) {
    cards.push({ label: '今日任务完成率', value: d.todayTaskCompletionRate + '%' });
  }
  if (d.courseViews !== undefined) {
    cards.push({ label: '课程总学习次数', value: d.courseViews });
  }
  if (d.courseCompletionRate !== undefined) {
    cards.push({ label: '课程完成率', value: d.courseCompletionRate + '%' });
  }
  if (d.avgStudyMinutes !== undefined) {
    cards.push({ label: '今日人均学习时长', value: d.avgStudyMinutes + ' 分钟' });
  }
  if (d.totalRevenue !== undefined) {
    cards.push({ label: '累计收入', value: '¥' + d.totalRevenue });
  }
  if (d.todayRevenue !== undefined) {
    cards.push({ label: '今日收入', value: '¥' + d.todayRevenue });
  }
  if (d.conversionRate !== undefined) {
    cards.push({ label: '付费转化率', value: d.conversionRate + '%' });
  }
  if (d.robotData && typeof d.robotData === 'object') {
    cards.push({ label: 'AI对话总量', value: d.robotData.totalConversations || 0 });
    cards.push({ label: '今日AI对话', value: d.robotData.todayConversations || 0 });
    cards.push({ label: '知识库命中率', value: (d.robotData.knowledgeHitRate || 0) + '%' });
  }

  container.innerHTML = cards.map((c) => `
    <div class="metric-card">
      <div class="metric-value">${c.value}</div>
      <div class="metric-label">${escapeHtml(c.label)}</div>
    </div>
  `).join('');
}

function renderDashboardTrends(days) {
  const d = adminState.dashboard || {};
  const key = days === 30 ? 'trend30' : 'trend7';
  const trends = d[key] || {};
  const labels = trends.labels || [];

  const chartConfigs = [
    { id: 'chart-new-students', name: '新增学员', data: trends.newStudents },
    { id: 'chart-revenue', name: '收入 (元)', data: trends.revenue },
    { id: 'chart-task-rate', name: '任务完成率 (%)', data: trends.taskCompletionRate },
    { id: 'chart-questions', name: '做题量', data: trends.questionCount },
    { id: 'chart-course-views', name: '课程学习', data: trends.courseViews }
  ];

  chartConfigs.forEach(function(cfg) {
    var dom = document.getElementById(cfg.id);
    if (!dom) return;
    if (typeof echarts === 'undefined') {
      dom.innerHTML = '<p class="muted" style="padding:16px;">ECharts 未加载</p>';
      return;
    }
    // 销毁旧图表实例（避免重复初始化）
    var existingInstance = echarts.getInstanceByDom(dom);
    if (existingInstance) existingInstance.dispose();

    var dataArr = cfg.data || [];
    var chart = echarts.init(dom);
    chart.setOption({
      tooltip: { trigger: 'axis' },
      grid: { left: 45, right: 20, top: 20, bottom: 30 },
      xAxis: { type: 'category', data: labels, axisLabel: { fontSize: 10, rotate: labels.length > 14 ? 45 : 0 } },
      yAxis: { type: 'value', minInterval: 1 },
      series: [{
        data: dataArr,
        type: 'line',
        smooth: true,
        areaStyle: { opacity: 0.15 },
        lineStyle: { width: 2 }
      }]
    });
  });
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
adminState.questionFilter = {};

function initOperationsListeners() {
  document.getElementById('content-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-content-type]');
    if (!btn) return;
    adminState.contentType = btn.dataset.contentType;
    document.querySelectorAll('#content-tabs button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('category-form').classList.toggle('hidden', adminState.contentType !== 'categories');
    // B-14: 显示/隐藏低库存阈值设置
    document.getElementById('product-stock-filter').classList.toggle('hidden', adminState.contentType !== 'products');
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

  // B-14: 低库存阈值应用按钮
  document.getElementById('apply-low-stock-btn').addEventListener('click', () => {
    const input = document.getElementById('low-stock-threshold-input');
    const value = Number(input.value);
    if (Number.isNaN(value) || value < 0) {
      createToast('请输入有效的阈值', 'error');
      return;
    }
    adminState.lowStockThreshold = value;
    loadContent();
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
    if (action === 'edit') {
      openQuestionEditModal(id);
    }
  });

  // 题库筛选
  document.getElementById('apply-question-filter').addEventListener('click', () => {
    adminState.questionFilter = {
      subject: document.getElementById('question-filter-subject').value,
      questionType: document.getElementById('question-filter-type').value,
      textbook: document.getElementById('question-filter-textbook').value,
      sourceYear: document.getElementById('question-filter-year').value,
      difficulty: document.getElementById('question-filter-difficulty').value,
      isPaidOnly: document.getElementById('question-filter-paid').value
    };
    loadQuestions();
  });

  document.getElementById('reset-question-filter').addEventListener('click', () => {
    document.getElementById('question-filter-subject').value = '';
    document.getElementById('question-filter-type').value = '';
    document.getElementById('question-filter-textbook').value = '';
    document.getElementById('question-filter-year').value = '';
    document.getElementById('question-filter-difficulty').value = '';
    document.getElementById('question-filter-paid').value = '';
    adminState.questionFilter = {};
    loadQuestions();
  });
  document.getElementById('question-import-button').addEventListener('click', () => importWorkbook('/api/questions/import', 'question-import-file', '题目', loadQuestions));
  document.getElementById('vocabulary-import-button').addEventListener('click', () => importWorkbook('/api/flashcards/import', 'vocabulary-import-file', '单词'));

  // 题目编辑 Modal 事件
  document.getElementById('close-question-edit').addEventListener('click', closeQuestionEditModal);
  document.getElementById('cancel-question-edit').addEventListener('click', closeQuestionEditModal);
  document.getElementById('save-question-edit').addEventListener('click', saveQuestionEdit);
  document.getElementById('question-edit-modal').addEventListener('click', (e) => {
    if (e.target.id === 'question-edit-modal') closeQuestionEditModal();
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
    let url = `/api/admin/content?type=${adminState.contentType}`;
    // B-14: 商品资料 Tab 加载时传入低库存阈值
    if (adminState.contentType === 'products') {
      const threshold = adminState.lowStockThreshold || adminState.settings.low_stock_threshold || 10;
      url += `&low_stock_threshold=${threshold}`;
    }
    const data = await fetchJSON(url);
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
    // B-14: 低库存商品行标红
    const lowStockStyle = (type === 'products' && item.isLowStock) ? 'color: var(--danger); background: #fef2f2;' : '';
    html += `
      <tr style="border-bottom: 1px solid var(--border); ${lowStockStyle}">
        <td style="padding: 8px;">${escapeHtml(item.title)} <span class="muted" style="font-size: 12px;">${escapeHtml(item.teacherName || item.folderName || '')}</span>${type === 'products' && item.isLowStock ? ' <span class="badge" style="background:var(--danger);color:white;">低库存</span>' : ''}</td>
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
    const params = new URLSearchParams();
    const f = adminState.questionFilter || {};
    if (f.subject) params.set('subject', f.subject);
    if (f.questionType) params.set('questionType', f.questionType);
    if (f.textbook) params.set('textbook', f.textbook);
    if (f.sourceYear) params.set('sourceYear', f.sourceYear);
    if (f.difficulty) params.set('difficulty', f.difficulty);
    if (f.isPaidOnly !== undefined && f.isPaidOnly !== '') params.set('isPaidOnly', f.isPaidOnly);
    const queryString = params.toString();
    const data = await fetchJSON(`/api/admin/questions${queryString ? '?' + queryString : ''}`);
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
  ['标题', '科目', '题型', '年份', '难度', '付费', '操作'].forEach((th) => html += `<th style="text-align: left; padding: 8px;">${escapeHtml(th)}</th>`);
  html += '</tr></thead><tbody>';

  adminState.questions.forEach((q) => {
    const difficultyLabel = { easy: '简单', medium: '中等', hard: '困难' }[q.difficulty] || (q.difficulty || '-');
    html += `
      <tr style="border-bottom: 1px solid var(--border);">
        <td style="padding: 8px;">${escapeHtml(q.title)}</td>
        <td style="padding: 8px;">${escapeHtml(q.subject)}</td>
        <td style="padding: 8px;">${escapeHtml(q.questionType || '-')}</td>
        <td style="padding: 8px;">${escapeHtml(q.sourceYear || '-')}</td>
        <td style="padding: 8px;"><span class="badge" style="background: ${q.difficulty === 'hard' ? 'var(--danger)' : q.difficulty === 'medium' ? 'var(--warning)' : 'var(--success)'}; color: white;">${escapeHtml(difficultyLabel)}</span></td>
        <td style="padding: 8px;">${q.isPaidOnly ? '<span class="badge" style="background: var(--warning);">付费</span>' : '免费'}</td>
        <td style="padding: 8px;">
          <button class="ghost-button" style="font-size: 12px;" data-question-action="edit" data-question-id="${q.id}">编辑</button>
          <button class="ghost-button" style="font-size: 12px;" data-question-action="toggle-paid" data-question-id="${q.id}" data-paid="${q.isPaidOnly}">${q.isPaidOnly ? '设为免费' : '设为付费'}</button>
          <button class="ghost-button" style="font-size: 12px; color: var(--danger); margin-left: 8px;" data-question-action="delete" data-question-id="${q.id}">删除</button>
        </td>
      </tr>`;
  });
  html += '</tbody></table>';
  container.innerHTML = html;
}

function openQuestionEditModal(id) {
  const q = adminState.questions.find((x) => x.id === id);
  if (!q) return;
  document.getElementById('qe-id').value = q.id;
  document.getElementById('qe-title').value = q.title || '';
  document.getElementById('qe-analysis').value = q.analysisText || '';
  document.getElementById('qe-correct').value = q.correctAnswer || '';
  document.getElementById('qe-tags').value = Array.isArray(q.tags) ? q.tags.join(',') : '';
  document.getElementById('qe-paid').checked = q.isPaidOnly ? true : false;
  document.getElementById('question-edit-modal').style.display = 'flex';
}

function closeQuestionEditModal() {
  document.getElementById('question-edit-modal').style.display = 'none';
}

async function saveQuestionEdit() {
  const id = Number(document.getElementById('qe-id').value);
  const title = document.getElementById('qe-title').value.trim();
  const analysisText = document.getElementById('qe-analysis').value.trim();
  const correctAnswer = document.getElementById('qe-correct').value.trim();
  const tagsStr = document.getElementById('qe-tags').value.trim();
  const isPaidOnly = document.getElementById('qe-paid').checked ? 1 : 0;
  const tags = tagsStr ? tagsStr.split(',').map((t) => t.trim()).filter(Boolean) : [];

  const body = {};
  if (title) body.title = title;
  if (analysisText) body.analysisText = analysisText;
  if (correctAnswer) body.correctAnswer = correctAnswer;
  body.tags = tags;
  body.isPaidOnly = isPaidOnly;

  try {
    await fetchJSON(`/api/admin/questions/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    createToast('题目已更新', 'success');
    closeQuestionEditModal();
    loadQuestions();
  } catch (error) {
    createToast(error.message, 'error');
  }
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
  if (menuId === 'knowledge') loadKnowledgeBases();
  if (menuId === 'messages') loadMessageTemplates();
  if (menuId === 'robots') loadRobotWorkspace();
  if (menuId === 'entrepreneurship') loadPromoterApplications();
  if (menuId === 'refunds') loadRefunds();
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

// ===== 知识库 / 语料库管理 =====

async function loadKnowledgeBases() {
  try {
    const data = await fetchJSON('/api/admin/knowledge-bases');
    adminState.knowledgeBases = data.bases || data.knowledgeBases || [];
    renderKnowledgeBases();
  } catch (error) {
    createToast(error.message, 'error');
  }
}

function renderKnowledgeBases() {
  const container = document.getElementById('knowledge-list');
  const items = adminState.knowledgeBases;
  if (!items.length) {
    container.innerHTML = '<p class="muted">暂无知识库，点击右上角按钮创建。</p>';
    return;
  }
  container.innerHTML = items.map((kb) => `
    <div class="paper-card" style="padding: 16px; margin-bottom: 12px;">
      <div style="display: flex; justify-content: space-between; align-items: flex-start;">
        <div>
          <h4 style="margin: 0 0 6px;">${escapeHtml(kb.title)}</h4>
          <p class="muted" style="margin: 0 0 6px; font-size: 13px;">${escapeHtml(kb.description || '无描述')}</p>
          <p class="muted" style="margin: 0; font-size: 12px;">分类：${escapeHtml(kb.category || '-')} · 文档数：${kb.documentCount || 0} · 创建时间：${formatDateTime(kb.createdAt)}</p>
        </div>
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          <button class="ghost-button" data-action="kb-view" data-id="${kb.id}" type="button">查看</button>
          <button class="ghost-button" data-action="kb-edit" data-id="${kb.id}" type="button">编辑</button>
          <button class="ghost-button" data-action="kb-delete" data-id="${kb.id}" type="button" style="color: var(--danger);">删除</button>
        </div>
      </div>
    </div>
  `).join('');
}

function openKnowledgeBaseModal(id) {
  const kb = id ? adminState.knowledgeBases.find((b) => b.id === id) : null;
  const modal = document.getElementById('kb-modal');
  const body = document.getElementById('kb-modal-body');
  document.getElementById('kb-modal-title').textContent = kb ? '编辑知识库' : '新增知识库';
  body.innerHTML = `
    <div style="display: grid; gap: 16px;">
      <input type="hidden" id="kb-id" value="${kb ? kb.id : ''}" />
      <label>标题<input id="kb-title" class="input" type="text" value="${escapeHtml(kb ? kb.title : '')}" placeholder="如：考研政策库" /></label>
      <label>分类<input id="kb-category" class="input" type="text" value="${escapeHtml(kb ? kb.category || '' : '')}" placeholder="如：政策、院校、FAQ" /></label>
      <label>描述<textarea id="kb-description" class="input" rows="3" placeholder="知识库用途描述">${escapeHtml(kb ? kb.description || '' : '')}</textarea></label>
    </div>
  `;
  modal.style.display = 'flex';
}

async function saveKnowledgeBase() {
  const id = document.getElementById('kb-id').value;
  const title = document.getElementById('kb-title').value.trim();
  const category = document.getElementById('kb-category').value.trim();
  const description = document.getElementById('kb-description').value.trim();
  if (!title) return createToast('请输入知识库标题。', 'error');
  try {
    const body = JSON.stringify({ title, category, description });
    if (id) {
      await fetchJSON(`/api/admin/knowledge-bases/${id}`, { method: 'PUT', body });
    } else {
      await fetchJSON('/api/admin/knowledge-bases', { method: 'POST', body });
    }
    createToast('保存成功。', 'success');
    closeKnowledgeBaseModal();
    loadKnowledgeBases();
  } catch (error) {
    createToast(error.message, 'error');
  }
}

function closeKnowledgeBaseModal() {
  document.getElementById('kb-modal').style.display = 'none';
}

async function deleteKnowledgeBase(id) {
  if (!await confirmDialog({ title: '确认删除', message: '删除知识库会同时删除其下所有文档和语料，是否继续？', danger: true })) return;
  try {
    await fetchJSON(`/api/admin/knowledge-bases/${id}`, { method: 'DELETE' });
    createToast('已删除。', 'success');
    loadKnowledgeBases();
  } catch (error) {
    createToast(error.message, 'error');
  }
}

async function openKnowledgeBaseDetail(id) {
  const modal = document.getElementById('kb-detail-modal');
  const body = document.getElementById('kb-detail-body');
  const title = document.getElementById('kb-detail-title');
  modal.style.display = 'flex';
  body.innerHTML = '<p class="muted">加载中...</p>';
  try {
    const data = await fetchJSON(`/api/admin/knowledge-bases/${id}`);
    const base = data.base || data;
    adminState.currentKnowledgeBase = base;
    title.textContent = `${base.title} - 文档列表`;
    const docs = data.documents || [];
    body.innerHTML = `
      <div style="margin-bottom: 16px;">
        <button class="button" data-action="kb-add-doc" data-base-id="${id}" type="button">上传文档</button>
      </div>
      ${docs.length ? docs.map((doc) => `
        <div class="paper-card" style="padding: 12px; margin-bottom: 10px;">
          <div style="display: flex; justify-content: space-between; align-items: flex-start;">
            <div>
              <p style="margin: 0 0 4px; font-weight: 500;">${escapeHtml(doc.title)}</p>
              <p class="muted" style="margin: 0; font-size: 12px;">${escapeHtml(doc.fileType)} · ${(doc.fileSize / 1024).toFixed(1)} KB · 分块：${doc.chunkCount || 0} · ${formatDateTime(doc.createdAt)}</p>
            </div>
            <div style="display: flex; gap: 8px;">
              <button class="ghost-button" data-action="kb-process-doc" data-base-id="${id}" data-doc-id="${doc.id}" type="button">处理</button>
              <button class="ghost-button" data-action="kb-del-doc" data-base-id="${id}" data-doc-id="${doc.id}" type="button" style="color: var(--danger);">删除</button>
            </div>
          </div>
        </div>
      `).join('') : '<p class="muted">暂无文档。</p>'}
    `;
  } catch (error) {
    body.innerHTML = `<p class="muted">加载失败：${escapeHtml(error.message)}</p>`;
  }
}

function closeKnowledgeBaseDetail() {
  document.getElementById('kb-detail-modal').style.display = 'none';
}

function openKnowledgeBaseDocModal(baseId) {
  const modal = document.getElementById('kb-doc-modal');
  const body = document.getElementById('kb-doc-modal-body');
  document.getElementById('kb-doc-modal-title').textContent = '上传文档';
  body.innerHTML = `
    <input type="hidden" id="kb-doc-base-id" value="${baseId}" />
    <div style="display: grid; gap: 16px;">
      <label>文档标题<input id="kb-doc-title" class="input" type="text" placeholder="如：2025年招生简章" /></label>
      <label>选择文件
        <input id="kb-doc-file" class="input" type="file" accept=".pdf,.docx,.xls,.xlsx,.csv,.txt,.md" />
      </label>
      <p class="muted" style="margin:0;font-size:12px;">支持书本 PDF/Word、表 4 单词和表 5 题目 Excel，以及 CSV/TXT/Markdown；单文件最大 100 MB。</p>
    </div>
  `;
  modal.style.display = 'flex';
}

async function saveKnowledgeBaseDoc() {
  const baseId = Number(document.getElementById('kb-doc-base-id').value);
  const title = document.getElementById('kb-doc-title').value.trim();
  const file = document.getElementById('kb-doc-file').files?.[0];
  if (!title || !file) return createToast('请填写标题并选择文件。', 'error');
  try {
    const formData = new FormData();
    formData.append('file', file);
    const upload = await fetchJSON('/api/upload', { method: 'POST', body: formData });
    const filePath = upload.data?.url || upload.url;
    const fileType = (file.name.split('.').pop() || '').toLowerCase();
    await fetchJSON(`/api/admin/knowledge-bases/${baseId}/documents`, {
      method: 'POST',
      body: JSON.stringify({ title, filePath, fileType })
    });
    createToast('文档已添加。', 'success');
    closeKnowledgeBaseDocModal();
    openKnowledgeBaseDetail(baseId);
  } catch (error) {
    createToast(error.message, 'error');
  }
}

function closeKnowledgeBaseDocModal() {
  document.getElementById('kb-doc-modal').style.display = 'none';
}

async function deleteKnowledgeBaseDoc(baseId, docId) {
  if (!await confirmDialog({ title: '确认删除', message: '是否删除该文档？', danger: true })) return;
  try {
    await fetchJSON(`/api/admin/knowledge-bases/${baseId}/documents/${docId}`, { method: 'DELETE' });
    createToast('已删除。', 'success');
    openKnowledgeBaseDetail(baseId);
  } catch (error) {
    createToast(error.message, 'error');
  }
}

async function processKnowledgeBaseDoc(baseId, docId, btn) {
  setButtonLoading(btn, true);
  try {
    const res = await fetchJSON(`/api/admin/knowledge-bases/${baseId}/documents/${docId}/process`, { method: 'POST' });
    createToast(`处理完成，生成 ${res.chunkCount || 0} 个语料片段。`, 'success');
    openKnowledgeBaseDetail(baseId);
  } catch (error) {
    createToast(error.message, 'error');
  } finally {
    setButtonLoading(btn, false);
  }
}

document.getElementById('kb-modal').addEventListener('click', (e) => { if (e.target.id === 'kb-modal') closeKnowledgeBaseModal(); });
document.getElementById('close-kb-modal').addEventListener('click', closeKnowledgeBaseModal);
document.getElementById('kb-detail-modal').addEventListener('click', (e) => { if (e.target.id === 'kb-detail-modal') closeKnowledgeBaseDetail(); });
document.getElementById('close-kb-detail').addEventListener('click', closeKnowledgeBaseDetail);
document.getElementById('kb-doc-modal').addEventListener('click', (e) => { if (e.target.id === 'kb-doc-modal') closeKnowledgeBaseDocModal(); });
document.getElementById('close-kb-doc-modal').addEventListener('click', closeKnowledgeBaseDocModal);
document.getElementById('save-kb-btn').addEventListener('click', saveKnowledgeBase);
document.getElementById('cancel-kb-btn').addEventListener('click', closeKnowledgeBaseModal);
document.getElementById('save-kb-doc-btn').addEventListener('click', saveKnowledgeBaseDoc);
document.getElementById('cancel-kb-doc-btn').addEventListener('click', closeKnowledgeBaseDocModal);
document.getElementById('add-kb-btn').addEventListener('click', () => openKnowledgeBaseModal());

// ===== 消息模板管理 =====

async function loadMessageTemplates() {
  try {
    const data = await fetchJSON('/api/admin/message-templates');
    adminState.messageTemplates = data.templates || [];
    renderMessageTemplates();
  } catch (error) {
    createToast(error.message, 'error');
  }
}

function renderMessageTemplates() {
  const container = document.getElementById('messages-list');
  const items = adminState.messageTemplates;
  if (!items.length) {
    container.innerHTML = '<p class="muted">暂无消息模板。</p>';
    return;
  }
  container.innerHTML = items.map((t) => `
    <div class="paper-card" style="padding: 16px; margin-bottom: 12px;">
      <div style="display: flex; justify-content: space-between; align-items: flex-start;">
        <div>
          <h4 style="margin: 0 0 6px;">${escapeHtml(t.name)} <code style="font-size: 12px; color: var(--muted);">${escapeHtml(t.code)}</code></h4>
          <p class="muted" style="margin: 0 0 6px; font-size: 13px;">${escapeHtml((t.content || '').slice(0, 120))}${(t.content || '').length > 120 ? '...' : ''}</p>
          <p class="muted" style="margin: 0; font-size: 12px;">渠道：${escapeHtml(t.channels || '-')} · 状态：${t.isActive ? '启用' : '禁用'} · 更新：${formatDateTime(t.updatedAt)}</p>
        </div>
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          <button class="ghost-button" data-action="mt-preview" data-code="${t.code}" type="button">预览</button>
          <button class="ghost-button" data-action="mt-edit" data-id="${t.id}" type="button">编辑</button>
          <button class="ghost-button" data-action="mt-toggle" data-id="${t.id}" data-active="${t.isActive}" type="button">${t.isActive ? '禁用' : '启用'}</button>
          <button class="ghost-button" data-action="mt-delete" data-id="${t.id}" type="button" style="color: var(--danger);">删除</button>
        </div>
      </div>
    </div>
  `).join('');
}

function openMessageTemplateModal(id) {
  const t = id ? adminState.messageTemplates.find((x) => x.id === id) : null;
  const modal = document.getElementById('mt-modal');
  const body = document.getElementById('mt-modal-body');
  document.getElementById('mt-modal-title').textContent = t ? '编辑消息模板' : '新增消息模板';
  body.innerHTML = `
    <input type="hidden" id="mt-id" value="${t ? t.id : ''}" />
    <div style="display: grid; gap: 16px;">
      <label>模板编码<input id="mt-code" class="input" type="text" value="${escapeHtml(t ? t.code : '')}" ${t ? 'disabled' : ''} placeholder="如：morning_plan" /></label>
      <label>模板名称<input id="mt-name" class="input" type="text" value="${escapeHtml(t ? t.name : '')}" placeholder="如：早安计划" /></label>
      <label>内容<textarea id="mt-content" class="input" rows="6" placeholder="支持 {name} {time} {subject} 等变量">${escapeHtml(t ? t.content : '')}</textarea></label>
      <label>渠道<input id="mt-channels" class="input" type="text" value="${escapeHtml(t ? t.channels || '' : '')}" placeholder="如：wecom,miniapp" /></label>
      <label style="display: flex; align-items: center; gap: 8px;">
        <input id="mt-active" type="checkbox" ${t && t.isActive ? 'checked' : ''} /> 启用
      </label>
    </div>
  `;
  modal.style.display = 'flex';
}

async function saveMessageTemplate() {
  const id = document.getElementById('mt-id').value;
  const code = document.getElementById('mt-code').value.trim();
  const name = document.getElementById('mt-name').value.trim();
  const content = document.getElementById('mt-content').value.trim();
  const channels = document.getElementById('mt-channels').value.trim();
  const isActive = document.getElementById('mt-active').checked ? 1 : 0;
  if (!code || !name || !content) return createToast('请填写编码、名称和内容。', 'error');
  try {
    const body = JSON.stringify({ code, name, content, channels, isActive });
    if (id) {
      await fetchJSON(`/api/admin/message-templates/${id}`, { method: 'PUT', body });
    } else {
      await fetchJSON('/api/admin/message-templates', { method: 'POST', body });
    }
    createToast('保存成功。', 'success');
    closeMessageTemplateModal();
    loadMessageTemplates();
  } catch (error) {
    createToast(error.message, 'error');
  }
}

function closeMessageTemplateModal() {
  document.getElementById('mt-modal').style.display = 'none';
}

async function deleteMessageTemplate(id) {
  if (!await confirmDialog({ title: '确认删除', message: '是否删除该消息模板？', danger: true })) return;
  try {
    await fetchJSON(`/api/admin/message-templates/${id}`, { method: 'DELETE' });
    createToast('已删除。', 'success');
    loadMessageTemplates();
  } catch (error) {
    createToast(error.message, 'error');
  }
}

async function toggleMessageTemplate(id, currentActive) {
  try {
    await fetchJSON(`/api/admin/message-templates/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ isActive: currentActive ? 0 : 1 })
    });
    createToast('状态已更新。', 'success');
    loadMessageTemplates();
  } catch (error) {
    createToast(error.message, 'error');
  }
}

async function previewMessageTemplate(code) {
  const variables = prompt('请输入预览变量 JSON（可选）：', '{"name":"张三","time":"08:00","subject":"数学"}');
  if (variables === null) return;
  try {
    const data = await fetchJSON(`/api/admin/message-templates/${code}/render`, {
      method: 'POST',
      body: JSON.stringify({ variables: JSON.parse(variables || '{}') })
    });
    alert(`预览结果：\n${data.rendered || data.content || '无内容'}`);
  } catch (error) {
    createToast(error.message, 'error');
  }
}

document.getElementById('mt-modal').addEventListener('click', (e) => { if (e.target.id === 'mt-modal') closeMessageTemplateModal(); });
document.getElementById('close-mt-modal').addEventListener('click', closeMessageTemplateModal);
document.getElementById('save-mt-btn').addEventListener('click', saveMessageTemplate);
document.getElementById('cancel-mt-btn').addEventListener('click', closeMessageTemplateModal);
document.getElementById('add-mt-btn').addEventListener('click', () => openMessageTemplateModal());

// ===== 机器人管理 =====

async function loadBots() {
  try {
    const data = await fetchJSON('/api/admin/bots');
    adminState.bots = data.bots || [];
    renderBots();
  } catch (error) {
    createToast(error.message, 'error');
  }
}

async function loadRobotWorkspace() {
  await Promise.all([loadBots(), loadWecomGroups(), loadWecomKf(), loadStudentProfiles(), loadKnowledgeBases()]);
}

function renderBots() {
  const container = document.getElementById('robots-list');
  const keyword = (document.getElementById('bot-search')?.value || '').trim().toLowerCase();
  const items = adminState.bots.filter((bot) => (
    !keyword || bot.name.toLowerCase().includes(keyword) || bot.code.toLowerCase().includes(keyword)
  ));
  if (!items.length) {
    container.innerHTML = '<p class="muted">暂无机器人。</p>';
    return;
  }
  container.innerHTML = items.map((bot) => `
    <div class="paper-card" style="padding: 16px; margin-bottom: 12px;">
      <div style="display: flex; justify-content: space-between; align-items: flex-start;">
        <div>
          <h4 style="margin: 0 0 6px;">${escapeHtml(bot.name)} <code style="font-size: 12px; color: var(--muted);">${escapeHtml(bot.robotUid || '')} · ${escapeHtml(bot.code)}</code></h4>
          <p class="muted" style="margin: 0 0 6px; font-size: 13px;">类型：${escapeHtml(bot.type)} · 状态：${escapeHtml(bot.status || (bot.isActive ? 'online' : 'draft'))} · 上线检查：${bot.checklist?.valid ? '已通过' : '待补齐'}</p>
          <p style="margin:0 0 6px;font-size:13px;line-height:1.6;">${escapeHtml(bot.config?.description || '尚未填写角色简介')}</p>
          <p class="muted" style="margin:0 0 6px;font-size:12px;">触发词：${escapeHtml((bot.config?.triggerKeywords || []).join?.('、') || '未设置（作为群默认角色时仍会回复）')}</p>
          <p class="muted" style="margin:0;font-size:12px;">配置：Prompt ${bot.config?.prompts?.length || 0} · 语料 ${bot.config?.corpus?.length || 0} · 关键词 ${bot.config?.keywords?.length || 0} · 模板 ${bot.config?.templates?.length || 0} · 推送位 ${bot.config?.pushSlots?.length || 0}</p>
          ${(bot.config?.schedules || []).filter((item) => item.enabled !== false).length ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">${bot.config.schedules.filter((item) => item.enabled !== false).map((item) => `<button class="ghost-button" data-action="bot-schedule-trigger" data-id="${bot.id}" data-schedule-id="${escapeHtml(item.id || item.name)}" type="button">执行：${escapeHtml(item.name)}</button>`).join('')}</div>` : ''}
          ${bot.checklist?.valid ? '' : `<details style="margin-top:8px;"><summary style="cursor:pointer;color:var(--danger);font-size:12px;">查看未通过项</summary><ul style="margin:6px 0 0;padding-left:20px;font-size:12px;">${(bot.checklist?.checks || []).filter((item) => !item.ok).map((item) => `<li>${escapeHtml(item.label)}：${escapeHtml(item.detail)}</li>`).join('')}</ul></details>`}
        </div>
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          <button class="ghost-button" data-action="bot-view-conversations" data-code="${bot.code}" type="button">对话记录</button>
          <button class="ghost-button" data-action="bot-view-audits" data-id="${bot.id}" type="button">配置审计</button>
          <button class="ghost-button" data-action="bot-gray-release" data-id="${bot.id}" type="button">灰度发布</button>
          <button class="ghost-button" data-action="bot-edit" data-id="${bot.id}" type="button">编辑</button>
          <button class="ghost-button" data-action="bot-toggle" data-id="${bot.id}" data-active="${bot.isActive}" type="button">${bot.isActive ? '暂停' : '上线'}</button>
          <button class="ghost-button" data-action="bot-delete" data-id="${bot.id}" type="button" style="color: var(--danger);">删除</button>
        </div>
      </div>
    </div>
  `).join('');
}

function openBotModal(id) {
  const bot = id ? adminState.bots.find((b) => b.id === id) : null;
  adminState.currentBot = bot || null;
  const modal = document.getElementById('bot-modal');
  const body = document.getElementById('bot-modal-body');
  document.getElementById('bot-modal-title').textContent = bot ? '编辑机器人' : '新增机器人';
  const botConfig = bot?.config || {};
  const triggerKeywords = Array.isArray(botConfig.triggerKeywords)
    ? botConfig.triggerKeywords.join('，')
    : String(botConfig.triggerKeywords || '');
  const style = botConfig.style || {};
  const promptConfig = botConfig.prompts?.[0] || {};
  const systemTerms = ['包过', '保过', '必上岸', '100%通过', '保录取', '不过退款', '稳过', '绝对能', '不通过赔钱', '签约保过', '内部资料', '泄题', '压题', '原题', '答案已出', '考后改分'];
  const selectedTerms = new Set(botConfig.systemRestrictedWords || systemTerms);
  const pushSlots = botConfig.pushSlots || [
    { key: 'daily_question', name: '每日一题', enabled: false, trigger: '每天固定时间' },
    { key: 'key_point', name: '考点速记', enabled: false, trigger: '每周一/四 9 点' },
    { key: 'wrong_review', name: '错题回炉', enabled: false, trigger: '标记“不懂”后 3 天' },
    { key: 'stage_change', name: '阶段切换提醒', enabled: true, trigger: '阶段变化时' },
    { key: 'mock_exam', name: '模考真题', enabled: true, trigger: '模考报名/考前一周' },
    { key: 'current_affairs', name: '时效内容', enabled: false, trigger: '重大时政事件' },
  ];
  const standardPushKeys = new Set(['daily_question', 'key_point', 'wrong_review', 'stage_change', 'mock_exam', 'current_affairs']);
  const standardPushSlots = pushSlots.filter((item) => standardPushKeys.has(item.key));
  const customPushSlots = pushSlots.filter((item) => !standardPushKeys.has(item.key));
  const rateLimits = botConfig.rateLimits || { perBotPerStudentDaily: 1, allBotsPerStudentDaily: 3, startHour: 9, endHour: 21, examSilenceDays: 3 };
  const lineValue = (items, mapper) => escapeHtml((items || []).map(mapper).join('\n'));
  body.innerHTML = `
    <input type="hidden" id="bot-id" value="${bot ? bot.id : ''}" />
    <div style="display: grid; gap: 16px;">
      <div class="paper-card" style="padding:12px;background:#eff6ff;"><strong>创建门禁</strong><p class="muted" style="margin:6px 0 0;">新建后固定为草稿。基础信息、5 维风格、4 段 Prompt、运营红线、5+ 条语料、3 类关键词、3+ 类模板、6 个推送位、兜底和转人工词全部通过后，列表中才能上线。</p></div>
      <h4 style="margin:0;">1. 基础信息</h4>
      <label>机器人编码<input id="bot-code" class="input" type="text" value="${escapeHtml(bot ? bot.code : '')}" ${bot ? 'disabled' : ''} placeholder="如：supervisor_bot" /></label>
      <label>名称<input id="bot-name" class="input" type="text" value="${escapeHtml(bot ? bot.name : '')}" placeholder="如：督学机器人" /></label>
      <label>类型
        <select id="bot-type" class="input">
          <option value="tutor" ${bot && bot.type === 'tutor' ? 'selected' : ''}>答疑</option>
          <option value="supervisor" ${bot && bot.type === 'supervisor' ? 'selected' : ''}>督学</option>
          <option value="advisor" ${bot && ['advisor', 'school'].includes(bot.type) ? 'selected' : ''}>择校</option>
          <option value="generator" ${bot && ['generator', 'exam'].includes(bot.type) ? 'selected' : ''}>自测</option>
          <option value="planner" ${bot && bot.type === 'planner' ? 'selected' : ''}>规划</option>
          <option value="other" ${bot && bot.type === 'other' ? 'selected' : ''}>其他</option>
        </select>
      </label>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;">
        <label>昵称<input id="bot-nickname" class="input" value="${escapeHtml(botConfig.nickname || '')}" placeholder="如：小语" /></label>
        <label>头像标识<input id="bot-avatar" class="input" maxlength="2" value="${escapeHtml(botConfig.avatar || '')}" placeholder="如：语" /></label>
        <label>角色定位<input id="bot-positioning" class="input" value="${escapeHtml(botConfig.positioning || '')}" placeholder="如：学科答疑" /></label>
      </div>
      <label>角色简介<input id="bot-description" class="input" type="text" value="${escapeHtml(botConfig.description || '')}" placeholder="例如：熟悉院校、专业和报录比的择校老师" /></label>
      <label>初始说明<input id="bot-initial-note" class="input" value="${escapeHtml(botConfig.initialNote || '')}" placeholder="内部备注，一句话" /></label>
      <h4 style="margin:0;">2. 说话风格（5 维）</h4>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;">
        <label>人设口吻<input id="bot-style-tone" class="input" value="${escapeHtml(style.tone || '')}" placeholder="中立老师" /></label>
        <label>称谓<input id="bot-style-address" class="input" value="${escapeHtml(style.addressStudent || '你')}" /></label>
        <label>称呼自己<input id="bot-style-self" class="input" value="${escapeHtml(style.selfReference || '')}" /></label>
        <label>收尾风格<input id="bot-style-closing" class="input" value="${escapeHtml(style.closingStyle || '')}" /></label>
        <label>禁用话术<input id="bot-style-banned" class="input" value="${escapeHtml(style.bannedSpeech || '')}" /></label>
      </div>
      <h4 style="margin:0;">3. Prompt 库（4 段式）</h4>
      <label>角色<textarea id="bot-prompt-role" class="input" rows="3">${escapeHtml(promptConfig.role || '')}</textarea></label>
      <label>上下文<textarea id="bot-prompt-context" class="input" rows="3">${escapeHtml(promptConfig.context || '')}</textarea></label>
      <label>任务<textarea id="bot-prompt-task" class="input" rows="3">${escapeHtml(promptConfig.task || '')}</textarea></label>
      <label>输出规范<textarea id="bot-prompt-output" class="input" rows="3">${escapeHtml(promptConfig.outputRules || '')}</textarea></label>
      <h4 style="margin:0;">4. 限定词</h4>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:6px;">${systemTerms.map((term) => `<label style="display:flex;gap:6px;align-items:center;"><input type="checkbox" name="bot-system-term" value="${escapeHtml(term)}" ${selectedTerms.has(term) ? 'checked' : ''} />${escapeHtml(term)}</label>`).join('')}</div>
      <label>自定义禁用词<input id="bot-custom-restricted" class="input" value="${escapeHtml((botConfig.customRestrictedWords || []).join('，'))}" placeholder="多个词用逗号分隔" /></label>
      <h4 style="margin:0;">5. 专属语料库（每行：标题|分类|来源|内容，至少 5 条且内容 50 字以上）</h4>
      <textarea id="bot-corpus" class="input" rows="8" placeholder="极限的核心概念|概念|张宇18讲|极限是描述无限接近但不一定到达的工具……">${lineValue(botConfig.corpus, (item) => `${item.title || ''}|${item.category || ''}|${item.source || ''}|${item.content || ''}`)}</textarea>
      <label>关联全局知识库（答疑时先检索，再交给大模型）
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:6px;margin-top:6px;">${adminState.knowledgeBases.length ? adminState.knowledgeBases.map((kb) => `<label style="display:flex;gap:6px;align-items:center;"><input type="checkbox" name="bot-kb-id" value="${kb.id}" ${(botConfig.knowledgeBaseIds || []).map(Number).includes(kb.id) ? 'checked' : ''} />${escapeHtml(kb.title)}</label>`).join('') : '<span class="muted">暂无全局知识库，可先到“知识库/语料库”创建。</span>'}</div>
      </label>
      <h4 style="margin:0;">6. 关键词快答（每行：优先级|匹配类型|关键词|分类|回复）</h4>
      <textarea id="bot-keywords" class="input" rows="7" placeholder="P0|exact|人工|handoff|这个问题我转给老师。">${lineValue(botConfig.keywords, (item) => `${item.priority || 'P1'}|${item.matchType || 'contains'}|${item.pattern || item.keyword || ''}|${item.category || 'business'}|${item.response || ''}`)}</textarea>
      <h4 style="margin:0;">7. 消息模板（每行：分类|名称|触发场景|内容）</h4>
      <textarea id="bot-templates" class="input" rows="7" placeholder="welcome|欢迎|加好友|你好，我是{昵称}……">${lineValue(botConfig.templates, (item) => `${item.category || ''}|${item.name || ''}|${item.trigger || ''}|${item.content || ''}`)}</textarea>
      <h4 style="margin:0;">8. 主动推送窗口</h4>
      <div style="display:grid;gap:8px;">${standardPushSlots.map((slot, index) => `<div style="display:grid;grid-template-columns:160px 1fr;gap:8px;align-items:center;"><label style="display:flex;gap:6px;align-items:center;"><input type="checkbox" name="bot-push-enabled" data-index="${index}" ${slot.enabled ? 'checked' : ''} />${escapeHtml(slot.name)}</label><input class="input" name="bot-push-trigger" data-index="${index}" data-key="${escapeHtml(slot.key)}" data-name="${escapeHtml(slot.name)}" value="${escapeHtml(slot.trigger || '')}" /></div>`).join('')}</div>
      <label>自定义推送位（每行：名称|触发方式|圈选规则|启用）<textarea id="bot-custom-push-slots" class="input" rows="4">${lineValue(customPushSlots, (item) => `${item.name || ''}|${item.trigger || ''}|${item.audience || 'all'}|${item.enabled !== false ? '1' : '0'}`)}</textarea></label>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;">
        <label>单机器人/学员/日<input id="bot-rate-per-bot" class="input" type="number" value="${Number(rateLimits.perBotPerStudentDaily) || 1}" /></label>
        <label>跨机器人/学员/日<input id="bot-rate-all" class="input" type="number" value="${Number(rateLimits.allBotsPerStudentDaily) || 3}" /></label>
        <label>开始时段<input id="bot-rate-start" class="input" type="number" min="0" max="23" value="${Number(rateLimits.startHour)}" /></label>
        <label>结束时段<input id="bot-rate-end" class="input" type="number" min="1" max="24" value="${Number(rateLimits.endHour)}" /></label>
        <label>考前静默天数<input id="bot-rate-exam" class="input" type="number" min="0" value="${Number(rateLimits.examSilenceDays)}" /></label>
        <label>灰度比例<select id="bot-rollout-percent" class="input"><option value="10" ${Number(botConfig.rolloutPercent) === 10 ? 'selected' : ''}>10%</option><option value="50" ${Number(botConfig.rolloutPercent) === 50 ? 'selected' : ''}>50%</option><option value="100" ${!botConfig.rolloutPercent || Number(botConfig.rolloutPercent) === 100 ? 'selected' : ''}>100%</option></select></label>
      </div>
      <h4 style="margin:0;">9. 定时任务（每行：任务名|触发类型|cron|模板ID|圈选规则|启用）</h4>
      <textarea id="bot-schedules" class="input" rows="5">${lineValue(botConfig.schedules, (item) => `${item.name || ''}|${item.triggerType || 'cron'}|${item.cron || ''}|${item.templateId || ''}|${item.audience || 'all'}|${item.enabled !== false ? '1' : '0'}`)}</textarea>
      <h4 style="margin:0;">10-12. 转人工、引导分流与兜底</h4>
      <label>转人工触发词<input id="bot-handoff-keywords" class="input" value="${escapeHtml((botConfig.handoffKeywords || ['人工', '老师', '真人', '客服', '转人工', '找老师']).join('，'))}" /></label>
      <label>引导分流（每行：学员问|引导到）<textarea id="bot-routing" class="input" rows="5">${lineValue(botConfig.routing, (item) => `${item.pattern || ''}|${item.target || ''}`)}</textarea></label>
      <label>兜底回复<textarea id="bot-fallback" class="input" rows="3" maxlength="150">${escapeHtml(botConfig.fallbackReply || '')}</textarea></label>
      <label>触发词<input id="bot-trigger-keywords" class="input" type="text" value="${escapeHtml(triggerKeywords)}" placeholder="多个词用逗号分隔，例如：择校，院校，专业选择" /></label>
      <label>欢迎语<textarea id="bot-welcome-message" class="input" rows="3" placeholder="机器人加入群或介绍角色时使用">${escapeHtml(botConfig.welcomeMessage || '')}</textarea></label>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;">
        <label>模型（留空用系统默认）<input id="bot-model" class="input" type="text" value="${escapeHtml(botConfig.model || '')}" placeholder="deepseek-chat" /></label>
        <label>回答灵活度 0-2<input id="bot-temperature" class="input" type="number" min="0" max="2" step="0.1" value="${Number.isFinite(Number(botConfig.temperature)) ? Number(botConfig.temperature) : 0.6}" /></label>
        <label>最长输出 Token<input id="bot-max-tokens" class="input" type="number" min="100" max="4000" step="100" value="${Number(botConfig.maxTokens) || 1000}" /></label>
      </div>
      <label style="display:flex;align-items:center;gap:8px;">
        <input id="bot-show-name" type="checkbox" ${botConfig.showName !== false ? 'checked' : ''} /> 回复开头显示角色名
      </label>
      <div class="paper-card" style="padding:12px;background:#fff7ed;">保存只更新配置；上线/暂停请在机器人列表执行。新机器人始终先进入草稿。</div>
    </div>
  `;
  modal.style.display = 'flex';
}

async function saveBot() {
  const id = document.getElementById('bot-id').value;
  const code = document.getElementById('bot-code').value.trim();
  const name = document.getElementById('bot-name').value.trim();
  const type = document.getElementById('bot-type').value;
  const existingConfig = adminState.currentBot?.config || {};
  const splitLines = (id, columns) => document.getElementById(id).value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const parts = line.split('|');
    while (parts.length < columns) parts.push('');
    if (parts.length > columns) parts.splice(columns - 1, parts.length - columns + 1, parts.slice(columns - 1).join('|'));
    return parts.map((part) => part.trim());
  });
  const promptConfig = {
    id: existingConfig.prompts?.[0]?.id || 'P-01',
    name: existingConfig.prompts?.[0]?.name || '总 Prompt（全局人设）',
    role: document.getElementById('bot-prompt-role').value.trim(),
    context: document.getElementById('bot-prompt-context').value.trim(),
    task: document.getElementById('bot-prompt-task').value.trim(),
    outputRules: document.getElementById('bot-prompt-output').value.trim(),
    version: existingConfig.prompts?.[0]?.version || 'v1.0.0',
    active: true,
  };
  const pushTriggers = [...document.querySelectorAll('[name="bot-push-trigger"]')];
  const config = {
    ...existingConfig,
    nickname: document.getElementById('bot-nickname').value.trim(),
    avatar: document.getElementById('bot-avatar').value.trim(),
    positioning: document.getElementById('bot-positioning').value.trim(),
    description: document.getElementById('bot-description').value.trim(),
    initialNote: document.getElementById('bot-initial-note').value.trim(),
    style: {
      tone: document.getElementById('bot-style-tone').value.trim(),
      addressStudent: document.getElementById('bot-style-address').value.trim(),
      selfReference: document.getElementById('bot-style-self').value.trim(),
      closingStyle: document.getElementById('bot-style-closing').value.trim(),
      bannedSpeech: document.getElementById('bot-style-banned').value.trim(),
    },
    prompts: [promptConfig],
    systemRestrictedWords: [...document.querySelectorAll('[name="bot-system-term"]:checked')].map((item) => item.value),
    customRestrictedWords: document.getElementById('bot-custom-restricted').value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean),
    corpus: splitLines('bot-corpus', 4).map(([title, category, source, content], index) => ({ id: `KB-${index + 1}`, title, category, source, content })),
    keywords: splitLines('bot-keywords', 5).map(([priority, matchType, pattern, category, response], index) => ({ id: `KW-${index + 1}`, priority, matchType, pattern, category, response })),
    templates: splitLines('bot-templates', 4).map(([category, templateName, trigger, content], index) => ({ id: `TPL-${index + 1}`, category, name: templateName, trigger, content, enabled: true })),
    pushSlots: [...pushTriggers.map((input, index) => ({
      key: input.dataset.key,
      name: input.dataset.name,
      trigger: input.value.trim(),
      enabled: Boolean(document.querySelector(`[name="bot-push-enabled"][data-index="${index}"]`)?.checked),
    })), ...splitLines('bot-custom-push-slots', 4).map(([slotName, trigger, audience, enabled], index) => ({ key: `custom_${index + 1}`, name: slotName, trigger, audience, enabled: enabled !== '0' }))],
    rateLimits: {
      perBotPerStudentDaily: Number(document.getElementById('bot-rate-per-bot').value),
      allBotsPerStudentDaily: Number(document.getElementById('bot-rate-all').value),
      startHour: Number(document.getElementById('bot-rate-start').value),
      endHour: Number(document.getElementById('bot-rate-end').value),
      examSilenceDays: Number(document.getElementById('bot-rate-exam').value),
    },
    rolloutPercent: Number(document.getElementById('bot-rollout-percent').value),
    knowledgeBaseIds: [...document.querySelectorAll('[name="bot-kb-id"]:checked')].map((item) => Number(item.value)),
    schedules: splitLines('bot-schedules', 6).map(([scheduleName, triggerType, cron, templateId, audience, enabled], index) => ({ id: `JOB-${index + 1}`, name: scheduleName, triggerType, cron, templateId, audience, enabled: enabled !== '0' })),
    handoffKeywords: document.getElementById('bot-handoff-keywords').value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean),
    routing: splitLines('bot-routing', 2).map(([pattern, target]) => ({ pattern, target })),
    fallbackReply: document.getElementById('bot-fallback').value.trim(),
    triggerKeywords: document.getElementById('bot-trigger-keywords').value
      .split(/[,，\n]/).map((item) => item.trim()).filter(Boolean),
    welcomeMessage: document.getElementById('bot-welcome-message').value.trim(),
    model: document.getElementById('bot-model').value.trim(),
    temperature: Math.min(2, Math.max(0, Number(document.getElementById('bot-temperature').value) || 0.6)),
    maxTokens: Math.min(4000, Math.max(100, Number(document.getElementById('bot-max-tokens').value) || 1000)),
    showName: document.getElementById('bot-show-name').checked,
  };
  if (!code || !name) return createToast('请填写编码和名称。', 'error');
  try {
    const body = JSON.stringify({ code, name, type, config, isActive: id ? Boolean(adminState.currentBot?.isActive) : false });
    if (id) {
      await fetchJSON(`/api/admin/bots/${id}`, { method: 'PUT', body });
    } else {
      await fetchJSON('/api/admin/bots', { method: 'POST', body });
    }
    createToast('保存成功。', 'success');
    closeBotModal();
    loadBots();
  } catch (error) {
    createToast(error.message, 'error');
  }
}

function closeBotModal() {
  document.getElementById('bot-modal').style.display = 'none';
  adminState.currentBot = null;
}

async function deleteBot(id) {
  if (!await confirmDialog({ title: '确认删除', message: '是否删除该机器人？', danger: true })) return;
  try {
    await fetchJSON(`/api/admin/bots/${id}`, { method: 'DELETE' });
    createToast('已删除。', 'success');
    loadBots();
  } catch (error) {
    createToast(error.message, 'error');
  }
}

async function toggleBot(id, currentActive) {
  try {
    await fetchJSON(`/api/admin/bots/${id}/${currentActive ? 'pause' : 'activate'}`, { method: 'POST' });
    createToast('状态已更新。', 'success');
    loadBots();
  } catch (error) {
    createToast(error.message, 'error');
  }
}

async function viewBotConversations(code) {
  const modal = document.getElementById('bot-conversations-modal');
  document.getElementById('bot-conversations-title').textContent = '对话记录';
  const body = document.getElementById('bot-conversations-body');
  modal.style.display = 'flex';
  body.innerHTML = '<p class="muted">加载中...</p>';
  try {
    const data = await fetchJSON(`/api/admin/conversations?type=${encodeURIComponent(code)}&limit=50`);
    const list = data.conversations || [];
    body.innerHTML = list.length ? list.map((c) => `
      <div class="paper-card" style="padding: 12px; margin-bottom: 10px;">
        <p class="muted" style="margin: 0 0 6px; font-size: 12px;">用户 ${c.userId} · ${formatDateTime(c.createdAt)}</p>
        <p style="margin: 0 0 6px;"><strong>问：</strong>${escapeHtml((c.prompt || '').slice(0, 200))}</p>
        <p style="margin: 0;" class="muted"><strong>答：</strong>${escapeHtml((c.response || '').slice(0, 300))}</p>
      </div>
    `).join('') : '<p class="muted">暂无对话记录。</p>';
  } catch (error) {
    body.innerHTML = `<p class="muted">加载失败：${escapeHtml(error.message)}</p>`;
  }
}

function closeBotConversationsModal() {
  document.getElementById('bot-conversations-modal').style.display = 'none';
}

document.getElementById('bot-modal').addEventListener('click', (e) => { if (e.target.id === 'bot-modal') closeBotModal(); });
document.getElementById('close-bot-modal').addEventListener('click', closeBotModal);
document.getElementById('bot-conversations-modal').addEventListener('click', (e) => { if (e.target.id === 'bot-conversations-modal') closeBotConversationsModal(); });
document.getElementById('save-bot-btn').addEventListener('click', saveBot);
document.getElementById('cancel-bot-btn').addEventListener('click', closeBotModal);
document.getElementById('close-bot-conversations').addEventListener('click', closeBotConversationsModal);
document.getElementById('add-bot-btn').addEventListener('click', () => openBotModal());

// ===== 企业微信群与角色分配 =====

async function loadWecomGroups() {
  try {
    const data = await fetchJSON('/api/admin/wecom/groups');
    adminState.wecomGroups = data.groups || [];
    renderWecomGroups();
  } catch (error) {
    const container = document.getElementById('wecom-groups-list');
    if (container) container.innerHTML = `<p class="muted">加载失败：${escapeHtml(error.message)}</p>`;
  }
}

async function importWorkbook(url, inputId, label, onSuccess) {
  const input = document.getElementById(inputId);
  const file = input.files?.[0];
  if (!file) return createToast(`请先选择${label}表格。`, 'error');
  const formData = new FormData();
  formData.append('file', file);
  try {
    const result = await fetchJSON(url, { method: 'POST', body: formData });
    createToast(`${label}导入完成：成功 ${result.imported || 0}，跳过 ${result.skipped || 0}。`, 'success');
    input.value = '';
    if (onSuccess) await onSuccess();
  } catch (error) {
    createToast(error.message, 'error');
  }
}

async function triggerBotSchedule(botId, scheduleId) {
  if (!await confirmDialog({ title: '执行主动推送', message: '将按圈选规则、灰度比例、静默时段和每日限频执行，是否继续？' })) return;
  try {
    const result = await fetchJSON(`/api/admin/bots/${botId}/schedules/${encodeURIComponent(scheduleId)}/trigger`, {
      method: 'POST',
      body: JSON.stringify({})
    });
    const sent = (result.deliveries || []).filter((item) => item.sent).length;
    const skipped = (result.deliveries || []).length - sent;
    createToast(`主动推送执行完成：发送 ${sent}，跳过 ${skipped}。`, 'success');
    loadRobotOperations();
  } catch (error) {
    createToast(error.message, 'error');
  }
}

async function loadWecomDirectory(force = false) {
  if (adminState.wecomDirectoryLoaded && !force) return adminState.wecomDirectory;
  try {
    const data = await fetchJSON('/api/admin/wecom/directory');
    adminState.wecomDirectory = data.users || [];
    adminState.wecomDirectoryLoaded = true;
    renderWecomGroups();
    return adminState.wecomDirectory;
  } catch (error) {
    adminState.wecomDirectory = [];
    adminState.wecomDirectoryLoaded = false;
    createToast(`${error.message}；仍可手工填写企业微信账号。`, 'error', 6000);
    return [];
  }
}

function getWecomUserLabel(userId) {
  const user = adminState.wecomDirectory.find((item) => item.userId === userId);
  return user ? `${user.name}（${user.userId}）` : userId;
}

function renderWecomGroups() {
  const container = document.getElementById('wecom-groups-list');
  if (!container) return;
  if (!adminState.wecomGroups.length) {
    container.innerHTML = '<div class="paper-card" style="padding:24px;text-align:center;"><p class="muted">还没有通过后台管理的企业微信群。</p></div>';
    return;
  }

  container.innerHTML = adminState.wecomGroups.map((group) => {
    const botText = group.bots?.length
      ? group.bots.map((bot) => `${bot.isDefault ? '默认：' : ''}${bot.name}`).join('、')
      : '未分配（使用系统默认答疑）';
    const memberText = (group.members || []).slice(0, 8)
      .map((member) => getWecomUserLabel(member.userId)).join('、');
    const connectionColor = group.connected ? '#166534' : '#b45309';
    const connectionText = group.connected ? '已接入会话存档' : '等待自动绑定';
    return `
      <div class="paper-card" style="padding:18px;margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap;">
          <div style="min-width:260px;flex:1;">
            <h4 style="margin:0 0 8px;">${escapeHtml(group.name)}</h4>
            <p style="margin:0 0 6px;font-size:13px;color:${connectionColor};font-weight:600;">● ${connectionText}</p>
            <p class="muted" style="margin:0 0 6px;font-size:13px;">群主：${escapeHtml(getWecomUserLabel(group.owner))} · 成员 ${group.members?.length || 0} 人</p>
            <p class="muted" style="margin:0 0 6px;font-size:13px;">回复：${group.replyEnabled ? (group.replyAllText ? '所有成员文字' : '仅智能识别的问题') : '已关闭'} · 等待 ${group.replyDelaySeconds} 秒</p>
            <p class="muted" style="margin:0 0 6px;font-size:13px;">机器人：${escapeHtml(botText)}</p>
            <p class="muted" style="margin:0;font-size:12px;line-height:1.6;">成员：${escapeHtml(memberText || '暂无')}${(group.members?.length || 0) > 8 ? '…' : ''}</p>
            ${group.pending ? `<p style="margin:8px 0 0;color:#b45309;font-size:12px;">有一批消息正在等待回复${group.pending.lastError ? `；最近错误：${escapeHtml(group.pending.lastError)}` : ''}</p>` : ''}
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="ghost-button" data-action="wecom-group-edit" data-id="${group.id}" type="button">回复与角色</button>
            <button class="ghost-button" data-action="wecom-group-members" data-id="${group.id}" type="button">添加成员</button>
            <button class="ghost-button" data-action="wecom-group-sync" data-id="${group.id}" type="button">同步群信息</button>
            ${group.connected ? '' : `<button class="ghost-button" data-action="wecom-group-rebind" data-id="${group.id}" type="button">重新绑定</button>`}
          </div>
        </div>
      </div>`;
  }).join('');
}

function botChoicesHtml(selectedIds = [], defaultBotId = null) {
  if (!adminState.bots.length) {
    return '<p class="muted">尚无机器人角色。可先保存群设置，再到“机器人角色”中新建。</p>';
  }
  const selected = new Set(selectedIds.map(Number));
  return `<div style="display:grid;gap:8px;max-height:240px;overflow:auto;border:1px solid var(--border);border-radius:12px;padding:12px;">
    ${adminState.bots.filter((bot) => bot.isActive).map((bot) => `
      <div style="display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center;padding:8px;border-bottom:1px solid var(--border);">
        <label style="display:flex;gap:8px;align-items:flex-start;">
          <input type="checkbox" name="wecom-bot-id" value="${bot.id}" ${selected.has(bot.id) ? 'checked' : ''} />
          <span><strong>${escapeHtml(bot.name)}</strong><small class="muted" style="display:block;">${escapeHtml(bot.config?.description || bot.type)}</small></span>
        </label>
        <label style="display:flex;gap:6px;align-items:center;font-size:12px;">
          <input type="radio" name="wecom-default-bot" value="${bot.id}" ${Number(defaultBotId) === bot.id ? 'checked' : ''} /> 默认
        </label>
      </div>`).join('')}
  </div>`;
}

function directoryOptionsHtml(selectedOwner = '') {
  return `<option value="">请选择企业成员</option>${adminState.wecomDirectory.map((user) => `
    <option value="${escapeHtml(user.userId)}" ${selectedOwner === user.userId ? 'selected' : ''}>${escapeHtml(user.name)}（${escapeHtml(user.userId)}）</option>
  `).join('')}`;
}

function directoryCheckboxesHtml(excludedIds = []) {
  const excluded = new Set(excludedIds);
  if (!adminState.wecomDirectory.length) {
    return '<p class="muted">未能读取通讯录，请在下方手工填写成员账号。</p>';
  }
  return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:8px;max-height:260px;overflow:auto;border:1px solid var(--border);border-radius:12px;padding:12px;">
    ${adminState.wecomDirectory.filter((user) => !excluded.has(user.userId)).map((user) => `
      <label style="display:flex;gap:8px;align-items:center;padding:6px;">
        <input type="checkbox" name="wecom-member-id" value="${escapeHtml(user.userId)}" />
        <span>${escapeHtml(user.name)}<small class="muted" style="display:block;">${escapeHtml(user.userId)}</small></span>
      </label>`).join('')}
  </div>`;
}

function commonGroupSettingsHtml(group = null) {
  const selectedBotIds = group?.bots?.map((bot) => bot.id) || [];
  const defaultBotId = group?.bots?.find((bot) => bot.isDefault)?.id || selectedBotIds[0] || null;
  return `
    <div style="display:grid;gap:14px;">
      <label style="display:flex;gap:8px;align-items:center;"><input id="wecom-reply-enabled" type="checkbox" ${group?.replyEnabled !== false ? 'checked' : ''} /> 开启机器人回复</label>
      <label style="display:flex;gap:8px;align-items:center;"><input id="wecom-reply-all-text" type="checkbox" ${group?.replyAllText !== false ? 'checked' : ''} /> 回复所有成员文字消息</label>
      <label>连续消息等待时间（秒）<input id="wecom-reply-delay" class="input" type="number" min="0" max="300" step="1" value="${group?.replyDelaySeconds ?? 5}" /><small class="muted">从最后一条消息开始计时；期间有新消息会重新计时并合并回答。</small></label>
      <div><strong style="display:block;margin-bottom:8px;">本群可用机器人与默认角色</strong>${botChoicesHtml(selectedBotIds, defaultBotId)}</div>
    </div>`;
}

async function openCreateWecomGroup() {
  adminState.wecomGroupModalMode = 'create';
  adminState.currentWecomGroupId = null;
  const modal = document.getElementById('wecom-group-modal');
  const body = document.getElementById('wecom-group-modal-body');
  document.getElementById('wecom-group-modal-title').textContent = '创建企业微信群';
  modal.style.display = 'flex';
  body.innerHTML = '<p class="muted">正在读取企业微信通讯录...</p>';
  await loadWecomDirectory();
  body.innerHTML = `
    <div style="display:grid;gap:16px;">
      <label>群名称<input id="wecom-group-name" class="input" maxlength="50" placeholder="例如：张三考研服务群" /></label>
      <label>群主<select id="wecom-group-owner" class="input">${directoryOptionsHtml()}</select></label>
      <label>通讯录读取失败时手工填写群主账号<input id="wecom-group-owner-manual" class="input" placeholder="企业微信 UserID" /></label>
      <div><strong style="display:block;margin-bottom:8px;">选择群成员</strong>${directoryCheckboxesHtml()}</div>
      <label>补充成员账号<textarea id="wecom-member-ids-manual" class="input" rows="3" placeholder="每行一个企业微信 UserID，也可以用逗号分隔"></textarea></label>
      ${commonGroupSettingsHtml()}
    </div>`;
}

function openWecomGroupSettings(groupId) {
  const group = adminState.wecomGroups.find((item) => item.id === groupId);
  if (!group) return;
  adminState.wecomGroupModalMode = 'settings';
  adminState.currentWecomGroupId = groupId;
  document.getElementById('wecom-group-modal-title').textContent = `${group.name}：回复与角色`;
  document.getElementById('wecom-group-modal-body').innerHTML = commonGroupSettingsHtml(group);
  document.getElementById('wecom-group-modal').style.display = 'flex';
}

async function openWecomGroupMembers(groupId) {
  const group = adminState.wecomGroups.find((item) => item.id === groupId);
  if (!group) return;
  adminState.wecomGroupModalMode = 'members';
  adminState.currentWecomGroupId = groupId;
  document.getElementById('wecom-group-modal-title').textContent = `${group.name}：添加成员`;
  const modal = document.getElementById('wecom-group-modal');
  const body = document.getElementById('wecom-group-modal-body');
  modal.style.display = 'flex';
  body.innerHTML = '<p class="muted">正在读取企业微信通讯录...</p>';
  await loadWecomDirectory();
  body.innerHTML = `
    <div style="display:grid;gap:16px;">
      <p class="muted" style="margin:0;">这里只会添加尚未入群的企业内部成员。</p>
      ${directoryCheckboxesHtml(group.members.map((member) => member.userId))}
      <label>补充成员账号<textarea id="wecom-member-ids-manual" class="input" rows="3" placeholder="每行一个企业微信 UserID，也可以用逗号分隔"></textarea></label>
    </div>`;
}

function selectedGroupBotIds() {
  return [...document.querySelectorAll('#wecom-group-modal input[name="wecom-bot-id"]:checked')]
    .map((input) => Number(input.value));
}

function selectedMemberIds() {
  const checked = [...document.querySelectorAll('#wecom-group-modal input[name="wecom-member-id"]:checked')]
    .map((input) => input.value);
  const manual = (document.getElementById('wecom-member-ids-manual')?.value || '')
    .split(/[,，\n\s]+/).map((item) => item.trim()).filter(Boolean);
  return [...new Set([...checked, ...manual])];
}

async function saveWecomGroup() {
  const mode = adminState.wecomGroupModalMode;
  const groupId = adminState.currentWecomGroupId;
  const saveButton = document.getElementById('save-wecom-group-btn');
  saveButton.disabled = true;

  try {
    if (mode === 'create') {
      const name = document.getElementById('wecom-group-name').value.trim();
      const owner = document.getElementById('wecom-group-owner').value
        || document.getElementById('wecom-group-owner-manual').value.trim();
      const memberUserIds = selectedMemberIds();
      if (!name || !owner || memberUserIds.length === 0) {
        throw new Error('请填写群名称、选择群主并至少选择一位群成员。');
      }
      const botIds = selectedGroupBotIds();
      const defaultBotId = Number(document.querySelector('#wecom-group-modal input[name="wecom-default-bot"]:checked')?.value) || null;
      const data = await fetchJSON('/api/admin/wecom/groups', {
        method: 'POST',
        body: JSON.stringify({
          name,
          owner,
          memberUserIds,
          replyEnabled: document.getElementById('wecom-reply-enabled').checked,
          replyAllText: document.getElementById('wecom-reply-all-text').checked,
          replyDelaySeconds: Number(document.getElementById('wecom-reply-delay').value),
          botIds,
          defaultBotId,
        }),
      });
      createToast(data.warning || '企业微信群已创建，正在自动接入机器人。', data.warning ? 'info' : 'success', 5000);
      setTimeout(loadWecomGroups, 3500);
    } else if (mode === 'settings') {
      const botIds = selectedGroupBotIds();
      const defaultBotId = Number(document.querySelector('#wecom-group-modal input[name="wecom-default-bot"]:checked')?.value) || null;
      await fetchJSON(`/api/admin/wecom/groups/${groupId}`, {
        method: 'PUT',
        body: JSON.stringify({
          replyEnabled: document.getElementById('wecom-reply-enabled').checked,
          replyAllText: document.getElementById('wecom-reply-all-text').checked,
          replyDelaySeconds: Number(document.getElementById('wecom-reply-delay').value),
          botIds,
          defaultBotId,
        }),
      });
      createToast('群回复设置已保存。', 'success');
    } else if (mode === 'members') {
      const userIds = selectedMemberIds();
      if (!userIds.length) throw new Error('请选择要添加的成员。');
      await fetchJSON(`/api/admin/wecom/groups/${groupId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userIds }),
      });
      createToast('成员已添加。', 'success');
    }

    closeWecomGroupModal();
    await loadWecomGroups();
  } catch (error) {
    createToast(error.message, 'error', 6000);
  } finally {
    saveButton.disabled = false;
  }
}

function closeWecomGroupModal() {
  document.getElementById('wecom-group-modal').style.display = 'none';
  adminState.currentWecomGroupId = null;
}

async function rebindWecomGroup(groupId) {
  try {
    await fetchJSON(`/api/admin/wecom/groups/${groupId}/rebind`, { method: 'POST' });
    createToast('绑定消息已发送，请稍等几秒后刷新。', 'success');
    setTimeout(loadWecomGroups, 3500);
  } catch (error) {
    createToast(error.message, 'error');
  }
}

async function syncWecomGroup(groupId) {
  try {
    await fetchJSON(`/api/admin/wecom/groups/${groupId}/sync`, { method: 'POST' });
    createToast('群名称和成员已同步。', 'success');
    await loadWecomGroups();
  } catch (error) {
    createToast(error.message, 'error');
  }
}

// ===== 微信客服（普通微信一对一咨询） =====

async function copyText(value, successMessage = '已复制。') {
  const text = String(value || '');
  if (!text) {
    createToast('当前没有可复制的内容。', 'error');
    return;
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    createToast(successMessage, 'success');
  } catch (error) {
    createToast(`复制失败：${error.message}`, 'error');
  }
}

function formatWecomKfTime(value, epochSeconds = false) {
  if (!value) return '暂无';
  const date = epochSeconds ? new Date(Number(value) * 1000) : new Date(value);
  if (Number.isNaN(date.getTime())) return '暂无';
  return date.toLocaleString('zh-CN', { hour12: false });
}

async function loadWecomKf() {
  try {
    const [status, accountData] = await Promise.all([
      fetchJSON('/api/admin/wecom/kf/status'),
      fetchJSON('/api/admin/wecom/kf/accounts'),
    ]);
    adminState.wecomKfStatus = status;
    adminState.wecomKfAccounts = accountData.accounts || [];
    renderWecomKf();
  } catch (error) {
    const container = document.getElementById('wecom-kf-accounts-list');
    if (container) container.innerHTML = `<p class="muted">加载失败：${escapeHtml(error.message)}</p>`;
  }
}

function renderWecomKfStatus() {
  const container = document.getElementById('wecom-kf-status');
  const status = adminState.wecomKfStatus;
  if (!container || !status) return;
  const ready = status.enabled && status.credentialsReady;
  const color = ready ? '#166534' : '#b45309';
  const background = ready ? '#f0fdf4' : '#fffbeb';
  const runtime = status.runtime || {};
  container.style.background = background;
  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap;">
      <div style="flex:1;min-width:260px;">
        <strong style="color:${color};">● ${ready ? '服务器端微信客服渠道已启用' : '服务器端已部署，等待企业微信网页授权'}</strong>
        <p class="muted" style="margin:8px 0;line-height:1.7;">
          ${status.credentialsReady ? '服务器所需凭据已就绪。' : '服务器还缺少微信客服鉴权配置。'}
          ${runtime.running ? `消息同步与默认 ${escapeHtml(String(status.defaultReplyDelaySeconds || 5))} 秒延迟回复正在运行。` : '消息同步会在渠道启用后运行。'}
          当前待回复 ${Number(runtime.pendingReplies || 0)} 个会话。
        </p>
        <label style="display:block;font-size:13px;">企业微信回调 URL
          <input class="input" value="${escapeHtml(status.callbackUrl || '')}" readonly style="margin-top:6px;" />
        </label>
      </div>
      <button class="ghost-button" data-action="wecom-kf-copy-callback" type="button">复制回调 URL</button>
    </div>
    <details style="margin-top:12px;">
      <summary style="cursor:pointer;font-weight:600;">企业管理员最后需要完成的网页操作</summary>
      <ol class="muted" style="line-height:1.8;margin-bottom:0;">
        ${(status.permissionSteps || []).map((step) => `<li>${escapeHtml(step)}</li>`).join('')}
      </ol>
      <p class="muted" style="font-size:12px;">为避免泄露密钥，本页只显示回调 URL，不显示服务器保存的 Token、EncodingAESKey 或 Secret。</p>
    </details>`;
}

function renderWecomKfAccounts() {
  const container = document.getElementById('wecom-kf-accounts-list');
  if (!container) return;
  if (!adminState.wecomKfAccounts.length) {
    container.innerHTML = `
      <div class="paper-card" style="padding:24px;text-align:center;">
        <h4 style="margin-top:0;">尚未同步到微信客服账号</h4>
        <p class="muted" style="line-height:1.7;">这是权限未开通时的正常状态。企业管理员完成本页上方三项网页操作后，点击“同步微信客服账号”，系统会自动读取账号和普通微信入口链接。</p>
      </div>`;
    return;
  }

  container.innerHTML = adminState.wecomKfAccounts.map((account) => {
    const bots = account.bots?.length
      ? account.bots.map((bot) => `${bot.isDefault ? '默认：' : ''}${bot.name}`).join('、')
      : '未分配（使用系统默认考研助手）';
    const safeLink = /^https:\/\//i.test(account.contactUrl || '') ? account.contactUrl : '';
    const safeAvatar = /^https:\/\//i.test(account.avatar || '') ? account.avatar : '';
    return `
      <div class="paper-card" style="padding:18px;margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap;">
          <div style="display:flex;gap:14px;flex:1;min-width:280px;">
            ${safeAvatar ? `<img src="${escapeHtml(safeAvatar)}" alt="" style="width:48px;height:48px;border-radius:12px;object-fit:cover;" />` : ''}
            <div>
              <h4 style="margin:0 0 8px;">${escapeHtml(account.name)}</h4>
              <p class="muted" style="margin:0 0 6px;font-size:13px;">回复：${account.replyEnabled ? `开启，连续消息等待 ${account.replyDelaySeconds} 秒` : '已关闭'} · ${account.managedByApi ? '已获 API 管理权限' : '等待 API 管理权限'}</p>
              <p class="muted" style="margin:0 0 6px;font-size:13px;">角色：${escapeHtml(bots)}</p>
              <p class="muted" style="margin:0 0 6px;font-size:13px;">客户 ${account.customerCount} 人 · 人工接管 ${account.manualCount} 人 · 待回复 ${account.pendingCount} 个会话</p>
              <p class="muted" style="margin:0;font-size:12px;">最近同步：${escapeHtml(formatWecomKfTime(account.lastSyncedAt))}</p>
              ${safeLink ? `<p style="margin:8px 0 0;font-size:13px;"><a href="${escapeHtml(safeLink)}" target="_blank" rel="noopener noreferrer">打开普通微信客服入口</a></p>` : '<p style="margin:8px 0 0;color:#b45309;font-size:13px;">尚未获取客服入口链接</p>'}
              ${account.lastError ? `<p style="margin:8px 0 0;color:#b91c1c;font-size:12px;">最近错误：${escapeHtml(account.lastError)}</p>` : ''}
            </div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="ghost-button" data-action="wecom-kf-account-settings" data-open-kfid="${escapeHtml(account.openKfid)}" type="button">回复与角色</button>
            <button class="ghost-button" data-action="wecom-kf-account-customers" data-open-kfid="${escapeHtml(account.openKfid)}" type="button">客户与人工接管</button>
            <button class="ghost-button" data-action="wecom-kf-sync-messages" data-open-kfid="${escapeHtml(account.openKfid)}" type="button">立即同步消息</button>
            <button class="ghost-button" data-action="wecom-kf-refresh-link" data-open-kfid="${escapeHtml(account.openKfid)}" type="button">刷新入口链接</button>
            ${safeLink ? `<button class="ghost-button" data-action="wecom-kf-copy-link" data-open-kfid="${escapeHtml(account.openKfid)}" type="button">复制入口链接</button>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');
}

function renderWecomKf() {
  renderWecomKfStatus();
  renderWecomKfAccounts();
}

function wecomKfBotChoicesHtml(account) {
  if (!adminState.bots.length) return '<p class="muted">尚无机器人角色，请先在“机器人角色”标签中新建。</p>';
  const selected = new Set((account.bots || []).map((bot) => Number(bot.id)));
  const defaultId = account.bots?.find((bot) => bot.isDefault)?.id;
  return `<div style="display:grid;gap:8px;max-height:260px;overflow:auto;border:1px solid var(--border);border-radius:12px;padding:12px;">
    ${adminState.bots.filter((bot) => bot.isActive).map((bot) => `
      <div style="display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center;padding:8px;border-bottom:1px solid var(--border);">
        <label style="display:flex;gap:8px;align-items:flex-start;">
          <input type="checkbox" name="wecom-kf-bot-id" value="${bot.id}" ${selected.has(Number(bot.id)) ? 'checked' : ''} />
          <span><strong>${escapeHtml(bot.name)}</strong><small class="muted" style="display:block;">${escapeHtml(bot.config?.description || bot.type)}</small></span>
        </label>
        <label style="display:flex;gap:6px;align-items:center;font-size:12px;">
          <input type="radio" name="wecom-kf-default-bot" value="${bot.id}" ${Number(defaultId) === Number(bot.id) ? 'checked' : ''} /> 默认
        </label>
      </div>`).join('')}
  </div>`;
}

function openWecomKfAccountSettings(openKfid) {
  const account = adminState.wecomKfAccounts.find((item) => item.openKfid === openKfid);
  if (!account) return;
  adminState.wecomKfModalMode = 'settings';
  adminState.currentWecomKfid = openKfid;
  document.getElementById('wecom-kf-modal-title').textContent = `${account.name}：回复与角色`;
  document.getElementById('wecom-kf-modal-body').innerHTML = `
    <div style="display:grid;gap:16px;">
      <label style="display:flex;gap:8px;align-items:center;"><input id="wecom-kf-reply-enabled" type="checkbox" ${account.replyEnabled ? 'checked' : ''} /> 开启 AI 自动回复</label>
      <label>连续消息等待时间（秒）
        <input id="wecom-kf-reply-delay" class="input" type="number" min="0" max="300" step="1" value="${account.replyDelaySeconds}" />
        <small class="muted">从最后一条消息开始计时；期间的新消息会合并后只回复一次。</small>
      </label>
      <div><strong style="display:block;margin-bottom:8px;">本客服账号可用机器人与默认角色</strong>${wecomKfBotChoicesHtml(account)}</div>
    </div>`;
  document.getElementById('wecom-kf-modal-footer').style.display = 'flex';
  document.getElementById('wecom-kf-modal').style.display = 'flex';
}

async function openWecomKfCustomers(openKfid) {
  const account = adminState.wecomKfAccounts.find((item) => item.openKfid === openKfid);
  if (!account) return;
  adminState.wecomKfModalMode = 'customers';
  adminState.currentWecomKfid = openKfid;
  document.getElementById('wecom-kf-modal-title').textContent = `${account.name}：客户与人工接管`;
  const body = document.getElementById('wecom-kf-modal-body');
  body.innerHTML = '<p class="muted">正在读取客户会话...</p>';
  document.getElementById('wecom-kf-modal-footer').style.display = 'none';
  document.getElementById('wecom-kf-modal').style.display = 'flex';
  try {
    const data = await fetchJSON(`/api/admin/wecom/kf/accounts/${encodeURIComponent(openKfid)}/customers`);
    const customers = data.customers || [];
    if (!customers.length) {
      body.innerHTML = '<p class="muted">还没有普通微信用户向这个客服账号发过消息。</p>';
      return;
    }
    body.innerHTML = customers.map((customer) => `
      <div class="paper-card" style="padding:14px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap;">
          <div style="flex:1;min-width:260px;">
            <strong>${escapeHtml(customer.nickname)}</strong>
            <p class="muted" style="margin:6px 0;font-size:13px;">状态：${escapeHtml(customer.serviceStateLabel)} · ${customer.manualTakeover ? '人工接管中' : 'AI 可接待'} · 48 小时额度剩余 ${customer.remainingMessages} 条</p>
            <p class="muted" style="margin:0 0 6px;font-size:12px;">最近发言：${escapeHtml(formatWecomKfTime(customer.lastMessageAt, true))}</p>
            <p style="margin:0;font-size:13px;line-height:1.6;white-space:pre-wrap;">${escapeHtml(String(customer.lastMessage || '').slice(0, 500))}</p>
          </div>
          <button class="${customer.manualTakeover ? 'button' : 'ghost-button'}"
            data-action="wecom-kf-customer-takeover"
            data-open-kfid="${escapeHtml(openKfid)}"
            data-external-userid="${escapeHtml(customer.externalUserid)}"
            data-manual="${customer.manualTakeover ? 'false' : 'true'}"
            type="button">${customer.manualTakeover ? '结束人工并恢复 AI' : '转人工接管'}</button>
        </div>
      </div>`).join('');
  } catch (error) {
    body.innerHTML = `<p style="color:#b91c1c;">读取失败：${escapeHtml(error.message)}</p>`;
  }
}

async function saveWecomKfSettings() {
  if (adminState.wecomKfModalMode !== 'settings' || !adminState.currentWecomKfid) return;
  const saveButton = document.getElementById('save-wecom-kf-btn');
  saveButton.disabled = true;
  try {
    const botIds = [...document.querySelectorAll('#wecom-kf-modal input[name="wecom-kf-bot-id"]:checked')]
      .map((input) => Number(input.value));
    const defaultBotId = Number(document.querySelector('#wecom-kf-modal input[name="wecom-kf-default-bot"]:checked')?.value) || null;
    await fetchJSON(`/api/admin/wecom/kf/accounts/${encodeURIComponent(adminState.currentWecomKfid)}`, {
      method: 'PUT',
      body: JSON.stringify({
        replyEnabled: document.getElementById('wecom-kf-reply-enabled').checked,
        replyDelaySeconds: Number(document.getElementById('wecom-kf-reply-delay').value),
        botIds,
        defaultBotId,
      }),
    });
    createToast('微信客服回复与角色设置已保存。', 'success');
    closeWecomKfModal();
    await loadWecomKf();
  } catch (error) {
    createToast(error.message, 'error', 7000);
  } finally {
    saveButton.disabled = false;
  }
}

function closeWecomKfModal() {
  document.getElementById('wecom-kf-modal').style.display = 'none';
  adminState.wecomKfModalMode = '';
  adminState.currentWecomKfid = '';
}

async function syncWecomKfAccounts() {
  const button = document.getElementById('sync-wecom-kf-accounts-btn');
  button.disabled = true;
  try {
    const data = await fetchJSON('/api/admin/wecom/kf/accounts/sync', { method: 'POST' });
    createToast(`已同步 ${Number(data.remoteCount || 0)} 个微信客服账号。`, 'success');
    if (data.warnings?.length) createToast(data.warnings.join('；'), 'info', 9000);
    await loadWecomKf();
  } catch (error) {
    createToast(`${error.message}。如果尚未授权，请先完成上方“企业管理员网页操作”。`, 'error', 10000);
  } finally {
    button.disabled = false;
  }
}

async function refreshWecomKfLink(openKfid) {
  try {
    await fetchJSON(`/api/admin/wecom/kf/accounts/${encodeURIComponent(openKfid)}/link`, {
      method: 'POST',
      body: JSON.stringify({ scene: 'admin' }),
    });
    createToast('客服入口链接已刷新。', 'success');
    await loadWecomKf();
  } catch (error) {
    createToast(error.message, 'error', 7000);
  }
}

async function syncWecomKfMessages(openKfid) {
  try {
    const data = await fetchJSON(`/api/admin/wecom/kf/accounts/${encodeURIComponent(openKfid)}/messages/sync`, {
      method: 'POST',
    });
    createToast(`消息同步完成，本次读取 ${Number(data.result?.messages || 0)} 条。`, 'success');
    await loadWecomKf();
  } catch (error) {
    createToast(error.message, 'error', 7000);
  }
}

async function setWecomKfTakeover(openKfid, externalUserid, manual) {
  const message = manual
    ? '转人工后，AI 会立即停止回复该客户。确认继续吗？'
    : '恢复 AI 时，如人工仍在接待，系统会先结束本次人工会话；客户下一次发言后 AI 接待。确认继续吗？';
  if (!await confirmDialog({ title: manual ? '转人工接管' : '恢复 AI 接待', message })) return;
  try {
    await fetchJSON(
      `/api/admin/wecom/kf/accounts/${encodeURIComponent(openKfid)}/customers/${encodeURIComponent(externalUserid)}/takeover`,
      { method: 'POST', body: JSON.stringify({ manual }) }
    );
    createToast(manual ? '已转入人工接管。' : '已恢复 AI 接待。', 'success');
    await openWecomKfCustomers(openKfid);
    await loadWecomKf();
  } catch (error) {
    createToast(error.message, 'error', 7000);
  }
}

async function loadStudentProfiles() {
  const container = document.getElementById('student-profiles-list');
  if (!container) return;
  try {
    const data = await fetchJSON('/api/admin/student-profiles');
    adminState.studentProfiles = data.profiles || [];
    renderStudentProfiles();
  } catch (error) {
    container.innerHTML = `<p class="muted">学员档案加载失败：${escapeHtml(error.message)}</p>`;
  }
}

function renderStudentProfiles() {
  const container = document.getElementById('student-profiles-list');
  if (!adminState.studentProfiles.length) {
    container.innerHTML = '<p class="muted">暂无登记链接。填写学生 ID 或企业微信 UserID 后生成。</p>';
    return;
  }
  const origin = location.origin;
  container.innerHTML = adminState.studentProfiles.map((profile) => {
    const url = `${origin}/student-profile.html?token=${encodeURIComponent(profile.inviteToken)}`;
    const plan = profile.planTemplate || {};
    const field = (name, label, value = '', type = 'text') => `<label style="display:grid;gap:5px;font-size:12px;color:var(--muted);">${label}<input class="input" data-plan-field="${name}" type="${type}" value="${escapeHtml(value ?? '')}" /></label>`;
    return `
      <div class="paper-card" data-plan-template-student="${profile.userId || ''}" style="padding:16px;margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap;">
          <div>
            <h4 style="margin:0 0 6px;">${escapeHtml(profile.name || profile.displayName || '待填写')} <code style="font-size:12px;color:var(--muted);">学生 ${profile.userId || '未绑定'} · 企微 ${escapeHtml(profile.wecomUserid || '未绑定')}</code></h4>
            <p class="muted" style="margin:0 0 6px;font-size:13px;">目标：${escapeHtml(profile.targetSchool || '待填')} / ${escapeHtml(profile.targetMajor || '待填')} · 阶段：${escapeHtml(profile.currentStage || '基础')} · 邮箱：${escapeHtml(profile.email || '未填')}</p>
            <p class="muted" style="margin:0;font-size:12px;">${profile.submittedAt ? `已提交 ${formatDateTime(profile.submittedAt)}` : '尚未提交'}</p>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="ghost-button" data-action="student-profile-copy" data-url="${escapeHtml(url)}" type="button">复制登记链接</button>
            ${profile.userId ? `<button class="ghost-button" data-action="student-plan-adjust" data-student-id="${profile.userId}" data-mode="semi_auto" type="button">半自动生成明日计划</button><button class="ghost-button" data-action="student-plan-adjust" data-student-id="${profile.userId}" data-mode="full_auto" type="button">全自动生成明日计划</button>` : ''}
          </div>
        </div>
        ${profile.userId ? `<details style="margin-top:14px;border-top:1px solid var(--border);padding-top:12px;">
          <summary style="cursor:pointer;font-weight:700;">表 2 · 目标分数与分科任务模板</summary>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:12px;">
            ${field('targetSchool', '目标院校', plan.targetSchool || profile.targetSchool)}
            ${field('englishTargetScore', '英语目标分', plan.englishTargetScore, 'number')}
            ${field('politicsTargetScore', '政治目标分', plan.politicsTargetScore, 'number')}
            ${field('business1TargetScore', '业务课 1 目标分', plan.business1TargetScore, 'number')}
            ${field('business2TargetScore', '业务课 2 目标分', plan.business2TargetScore, 'number')}
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;margin-top:10px;">
            ${field('englishLongTask', '英语长期任务', plan.englishLongTask)}
            ${field('englishStageTask', '英语阶段任务', plan.englishStageTask)}
            ${field('mathTask', '数学任务', plan.mathTask)}
            ${field('politicsTask', '政治任务', plan.politicsTask)}
            ${field('professionalTask', '专业任务', plan.professionalTask)}
            ${field('extraTasks', '额外任务（每行一项）', (plan.extraTasks || []).map((item) => typeof item === 'string' ? item : item.title).filter(Boolean).join('\n'))}
          </div>
          <div style="display:flex;justify-content:flex-end;margin-top:10px;"><button class="button" data-action="student-plan-template-save" data-student-id="${profile.userId}" type="button">保存表 2 模板</button></div>
        </details>` : ''}
      </div>`;
  }).join('');
}

async function createStudentProfileInvite() {
  const userId = Number(document.getElementById('student-profile-user-id').value) || null;
  const wecomUserid = document.getElementById('student-profile-wecom-id').value.trim();
  if (!userId && !wecomUserid) return createToast('请填写站内学生 ID 或企业微信 UserID。', 'error');
  try {
    const data = await fetchJSON('/api/admin/student-profiles/invites', {
      method: 'POST',
      body: JSON.stringify({ userId, wecomUserid })
    });
    await copyText(data.url, '登记链接已生成并复制。');
    await loadStudentProfiles();
  } catch (error) {
    createToast(error.message, 'error');
  }
}

async function adjustStudentPlan(studentId, mode) {
  try {
    const data = await fetchJSON(`/api/admin/study-plans/${studentId}/adjust-next-day`, {
      method: 'POST',
      body: JSON.stringify({ sourceMode: mode })
    });
    createToast(`已生成 ${data.planDate} 的 ${data.items?.length || 0} 项计划。`, 'success');
  } catch (error) {
    createToast(error.message, 'error');
  }
}

async function saveStudentPlanTemplate(studentId) {
  const container = document.querySelector(`[data-plan-template-student="${studentId}"]`);
  if (!container) return;
  const value = (name) => container.querySelector(`[data-plan-field="${name}"]`)?.value.trim() || '';
  const numeric = (name) => value(name) === '' ? null : Number(value(name));
  const payload = {
    targetSchool: value('targetSchool'),
    englishTargetScore: numeric('englishTargetScore'),
    politicsTargetScore: numeric('politicsTargetScore'),
    business1TargetScore: numeric('business1TargetScore'),
    business2TargetScore: numeric('business2TargetScore'),
    englishLongTask: value('englishLongTask'),
    englishStageTask: value('englishStageTask'),
    mathTask: value('mathTask'),
    politicsTask: value('politicsTask'),
    professionalTask: value('professionalTask'),
    extraTasks: value('extraTasks').split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
  };
  try {
    await fetchJSON(`/api/admin/study-plans/${studentId}/template`, { method: 'PUT', body: JSON.stringify(payload) });
    createToast('表 2 计划模板已保存。', 'success');
    await loadStudentProfiles();
  } catch (error) {
    createToast(error.message, 'error');
  }
}

async function loadRobotOperations() {
  const overviewNode = document.getElementById('robot-platform-overview');
  const ticketsNode = document.getElementById('robot-handoff-tickets');
  try {
    const [overview, ticketData] = await Promise.all([
      fetchJSON('/api/admin/robot-platform/overview'),
      fetchJSON('/api/admin/robot-platform/tickets?status=open')
    ]);
    adminState.robotOverview = overview.summary || {};
    adminState.robotTickets = ticketData.tickets || [];
    const summary = adminState.robotOverview;
    overviewNode.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;">
      ${[
        ['机器人', `${summary.onlineBots || 0}/${summary.totalBots || 0} 在线`],
        ['上线检查', `${summary.completeBots || 0} 个完整`],
        ['待处理工单', `${summary.openTickets || 0} 条`],
        ['P0 紧急', `${summary.urgentTickets || 0} 条`],
        ['24h 违规', `${summary.violations24h || 0} 次`],
        ['灰度观察', `${summary.observingReleases || 0} 批`],
      ].map(([label, value]) => `<div class="paper-card" style="padding:16px;"><div class="muted" style="font-size:12px;">${label}</div><strong style="display:block;margin-top:6px;font-size:20px;">${value}</strong></div>`).join('')}
    </div>`;
    ticketsNode.innerHTML = adminState.robotTickets.length ? adminState.robotTickets.map((ticket) => `
      <div style="display:flex;justify-content:space-between;gap:14px;padding:12px 0;border-bottom:1px solid var(--border);">
        <div><strong>${escapeHtml(ticket.priority)} · ${escapeHtml(ticket.botName || ticket.robotUid || '系统')}</strong><p style="margin:5px 0;font-size:13px;">${escapeHtml(ticket.reason)}</p><p class="muted" style="margin:0;font-size:12px;">${escapeHtml(ticket.channel)} · ${escapeHtml(ticket.externalUserId)} · ${formatDateTime(ticket.createdAt)}</p></div>
        <button class="ghost-button" data-action="robot-ticket-resolve" data-id="${ticket.id}" type="button">标记解决</button>
      </div>`).join('') : '<p class="muted">暂无待处理工单。</p>';
  } catch (error) {
    overviewNode.innerHTML = '';
    ticketsNode.innerHTML = `<p class="muted">加载失败：${escapeHtml(error.message)}</p>`;
  }
}

async function resolveRobotTicket(id) {
  try {
    await fetchJSON(`/api/admin/robot-platform/tickets/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'resolved' }) });
    createToast('工单已解决。', 'success');
    await loadRobotOperations();
  } catch (error) {
    createToast(error.message, 'error');
  }
}

async function viewBotAudits(id) {
  const modal = document.getElementById('bot-conversations-modal');
  document.getElementById('bot-conversations-title').textContent = '配置审计';
  const body = document.getElementById('bot-conversations-body');
  modal.style.display = 'flex';
  body.innerHTML = '<p class="muted">加载审计记录...</p>';
  try {
    const data = await fetchJSON(`/api/admin/bots/${id}/audits`);
    body.innerHTML = (data.audits || []).length ? data.audits.map((audit) => `
      <div class="paper-card" style="padding:12px;margin-bottom:10px;">
        <strong>${escapeHtml(audit.action)} · ${escapeHtml(audit.actorName)}</strong>
        <p style="margin:6px 0;">${escapeHtml(audit.summary || '配置变更')}</p>
        <p class="muted" style="margin:0;font-size:12px;">${formatDateTime(audit.createdAt)}</p>
      </div>`).join('') : '<p class="muted">暂无审计记录。</p>';
  } catch (error) {
    body.innerHTML = `<p class="muted">加载失败：${escapeHtml(error.message)}</p>`;
  }
}

async function createBotGrayRelease(id) {
  const percent = Number(prompt('灰度比例（10 / 50 / 100）：', '10'));
  if (![10, 50, 100].includes(percent)) return createToast('灰度比例只能是 10、50 或 100。', 'error');
  try {
    await fetchJSON(`/api/admin/bots/${id}/releases`, { method: 'POST', body: JSON.stringify({ rolloutPercent: percent }) });
    createToast(`已启动 ${percent}% 灰度观察。`, 'success');
    await loadRobotOperations();
  } catch (error) {
    createToast(error.message, 'error');
  }
}

document.getElementById('robot-tabs').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-robot-tab]');
  if (!button) return;
  document.querySelectorAll('#robot-tabs button').forEach((item) => item.classList.toggle('active', item === button));
  document.querySelectorAll('.robot-tab-panel').forEach((panel) => {
    panel.style.display = panel.id === button.dataset.robotTab ? 'block' : 'none';
  });
  if (button.dataset.robotTab === 'wecom-groups-panel') {
    await loadWecomDirectory();
    await loadWecomGroups();
  } else if (button.dataset.robotTab === 'wecom-kf-panel') {
    await loadWecomKf();
  } else if (button.dataset.robotTab === 'student-plans-panel') {
    await loadStudentProfiles();
  } else if (button.dataset.robotTab === 'robot-operations-panel') {
    await loadRobotOperations();
  }
});

document.getElementById('bot-search').addEventListener('input', renderBots);
document.getElementById('add-wecom-group-btn').addEventListener('click', openCreateWecomGroup);
document.getElementById('refresh-wecom-groups-btn').addEventListener('click', async () => {
  await loadWecomDirectory(true);
  await loadWecomGroups();
});
document.getElementById('create-student-profile-invite').addEventListener('click', createStudentProfileInvite);
document.getElementById('refresh-student-profiles').addEventListener('click', loadStudentProfiles);
document.getElementById('refresh-robot-operations').addEventListener('click', loadRobotOperations);
document.getElementById('wecom-group-modal').addEventListener('click', (event) => {
  if (event.target.id === 'wecom-group-modal') closeWecomGroupModal();
});
document.getElementById('wecom-group-modal-body').addEventListener('change', (event) => {
  if (event.target.name !== 'wecom-default-bot') return;
  const checkbox = document.querySelector(`#wecom-group-modal input[name="wecom-bot-id"][value="${event.target.value}"]`);
  if (checkbox) checkbox.checked = true;
});
document.getElementById('close-wecom-group-modal').addEventListener('click', closeWecomGroupModal);
document.getElementById('cancel-wecom-group-btn').addEventListener('click', closeWecomGroupModal);
document.getElementById('save-wecom-group-btn').addEventListener('click', saveWecomGroup);
document.getElementById('sync-wecom-kf-accounts-btn').addEventListener('click', syncWecomKfAccounts);
document.getElementById('refresh-wecom-kf-btn').addEventListener('click', loadWecomKf);
document.getElementById('wecom-kf-modal').addEventListener('click', (event) => {
  if (event.target.id === 'wecom-kf-modal') closeWecomKfModal();
});
document.getElementById('wecom-kf-modal-body').addEventListener('change', (event) => {
  if (event.target.name !== 'wecom-kf-default-bot') return;
  const checkbox = document.querySelector(`#wecom-kf-modal input[name="wecom-kf-bot-id"][value="${event.target.value}"]`);
  if (checkbox) checkbox.checked = true;
});
document.getElementById('close-wecom-kf-modal').addEventListener('click', closeWecomKfModal);
document.getElementById('cancel-wecom-kf-btn').addEventListener('click', closeWecomKfModal);
document.getElementById('save-wecom-kf-btn').addEventListener('click', saveWecomKfSettings);

// ===== 创业板块管理 =====

async function loadPromoterApplications() {
  try {
    const status = adminState.promoterFilter.status;
    const url = status ? `/api/admin/promoter-applications?status=${status}` : '/api/admin/promoter-applications';
    const data = await fetchJSON(url);
    adminState.promoterApplications = data.applications || [];
    renderPromoterApplications();
  } catch (error) {
    createToast(error.message, 'error');
  }
}

function renderPromoterApplications() {
  const container = document.getElementById('promoter-list');
  const items = adminState.promoterApplications;
  if (!items.length) {
    container.innerHTML = '<p class="muted">暂无报名记录。</p>';
    return;
  }
  container.innerHTML = items.map((app) => `
    <div class="paper-card" style="padding: 16px; margin-bottom: 12px;">
      <div style="display: flex; justify-content: space-between; align-items: flex-start;">
        <div>
          <h4 style="margin: 0 0 6px;">${escapeHtml(app.name)} <span class="muted" style="font-size: 12px;">(${escapeHtml(app.userDisplayName || '未知用户')})</span></h4>
          <p class="muted" style="margin: 0 0 6px; font-size: 13px;">平台：${escapeHtml(app.platform)} · 粉丝数：${app.followerCount || 0} · 联系方式：${escapeHtml(app.contact)}</p>
          <p class="muted" style="margin: 0; font-size: 12px;">状态：<span style="font-weight: 500; color: ${app.status === 'approved' ? '#16a34a' : app.status === 'rejected' ? '#dc2626' : '#ca8a04'};">${escapeHtml(app.status)}</span> · 申请时间：${formatDateTime(app.createdAt)}</p>
        </div>
        ${app.status === 'pending' ? `
        <div style="display: flex; gap: 8px;">
          <button class="ghost-button" data-action="promoter-approve" data-id="${app.id}" type="button" style="color: #16a34a;">通过</button>
          <button class="ghost-button" data-action="promoter-reject" data-id="${app.id}" type="button" style="color: var(--danger);">驳回</button>
        </div>
        ` : ''}
      </div>
    </div>
  `).join('');
}

async function approvePromoter(id) {
  if (!await confirmDialog({ title: '确认通过', message: '是否通过该博主申请？' })) return;
  try {
    await fetchJSON(`/api/admin/promoter-applications/${id}/approve`, { method: 'POST' });
    createToast('已通过。', 'success');
    loadPromoterApplications();
  } catch (error) {
    createToast(error.message, 'error');
  }
}

async function rejectPromoter(id) {
  if (!await confirmDialog({ title: '确认驳回', message: '是否驳回该博主申请？', danger: true })) return;
  try {
    await fetchJSON(`/api/admin/promoter-applications/${id}/reject`, { method: 'POST' });
    createToast('已驳回。', 'success');
    loadPromoterApplications();
  } catch (error) {
    createToast(error.message, 'error');
  }
}

document.getElementById('promoter-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-promoter-status]');
  if (!btn) return;
  document.querySelectorAll('#promoter-tabs button').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  adminState.promoterFilter.status = btn.dataset.promoterStatus;
  loadPromoterApplications();
});

// ===== 退款审核 =====

async function loadRefunds() {
  try {
    const data = await fetchJSON('/api/admin/refunds?status=requested');
    adminState.refunds = data.refunds || [];
    renderRefunds();
  } catch (error) {
    createToast(error.message, 'error');
  }
}

function renderRefunds() {
  const container = document.getElementById('refunds-list');
  const items = adminState.refunds;
  if (!items.length) {
    container.innerHTML = '<p class="muted">暂无待审核退款申请。</p>';
    return;
  }
  container.innerHTML = items.map((r) => `
    <div class="paper-card" style="padding: 16px; margin-bottom: 12px;">
      <div style="display: flex; justify-content: space-between; align-items: flex-start;">
        <div>
          <h4 style="margin: 0 0 6px;">订单 #${r.orderId} · ¥${r.amount}</h4>
          <p class="muted" style="margin: 0 0 6px; font-size: 13px;">学生：${escapeHtml(r.studentDisplayName || r.studentId)} · 原因：${escapeHtml(r.reason || '无')}</p>
          <p class="muted" style="margin: 0; font-size: 12px;">订单状态：${escapeHtml(r.orderStatus)} · 申请时间：${formatDateTime(r.createdAt)}</p>
        </div>
        <div style="display: flex; gap: 8px;">
          <button class="ghost-button" data-action="refund-approve" data-id="${r.orderId}" type="button" style="color: #16a34a;">通过</button>
          <button class="ghost-button" data-action="refund-reject" data-id="${r.orderId}" type="button" style="color: var(--danger);">驳回</button>
        </div>
      </div>
    </div>
  `).join('');
}

async function handleRefund(orderId, status) {
  const ok = await confirmDialog({
    title: status === 'approved' ? '确认退款' : '确认驳回',
    message: status === 'approved' ? '通过后将回库存并取消订单，是否继续？' : '驳回后学生将不能再次申请，是否继续？',
    danger: status === 'rejected'
  });
  if (!ok) return;
  try {
    await fetchJSON(`/api/admin/orders/${orderId}/refund`, { method: 'POST', body: JSON.stringify({ status }) });
    createToast(status === 'approved' ? '退款已通过。' : '退款已驳回。', 'success');
    loadRefunds();
  } catch (error) {
    createToast(error.message, 'error');
  }
}
