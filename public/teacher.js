const teacherState = {
  user: null,
  data: null,
  studentsOverview: null,
  selectedStudentId: null,
  tags: [],
  textbooks: [],
  cloudState: { currentParentId: null, path: [], folders: [], items: [] },
  flashcards: []
};

const weekdayLabels = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 0, label: '周日' }
];

document.addEventListener('DOMContentLoaded', async () => {
  const authResult = await ensureAuth('teacher').catch(() => null);
  if (!authResult) {
    return;
  }

  teacherState.user = authResult.user;
  const nameEl = document.getElementById('teacher-name');
  if (nameEl) nameEl.textContent = authResult.user.displayName;
  // 设置面板账号信息
  const accountInfo = document.getElementById('settings-account-info');
  if (accountInfo) {
    accountInfo.innerHTML = `
      <div class="settings-info-item"><span class="muted">用户名</span><strong>${escapeHtml(authResult.user.username)}</strong></div>
      <div class="settings-info-item"><span class="muted">姓名</span><strong>${escapeHtml(authResult.user.displayName)}</strong></div>
      <div class="settings-info-item"><span class="muted">班级</span><strong>${escapeHtml(authResult.user.className || '未设置')}</strong></div>
      <div class="settings-info-item"><span class="muted">角色</span><strong>老师</strong></div>
    `;
  }
  activateTabs('.nav-link', '.panel', async (target) => {
    // 延迟加载：非核心面板首次激活时按需请求数据
    if (!teacherState.data) return;
    const moduleMap = {
      'teacher-courses': 'courses',
      'teacher-live': 'liveSessions',
      'teacher-questions': 'questions',
      'teacher-store': 'products,orders',
      'teacher-summaries': 'summaries'
    };
    const renderMap = {
      'teacher-courses': () => renderCourses(),
      'teacher-live': () => renderLiveSessions(),
      'teacher-questions': () => renderQuestions(),
      'teacher-store': () => renderStore(),
      'teacher-summaries': () => renderSummaries()
    };
    if (moduleMap[target] && !teacherState.data._loadedModules?.has(target)) {
      try {
        const moduleData = await fetchJSON('/api/teacher/bootstrap?modules=' + moduleMap[target]);
        Object.assign(teacherState.data, moduleData);
        if (!teacherState.data._loadedModules) teacherState.data._loadedModules = new Set();
        teacherState.data._loadedModules.add(target);
      } catch (e) {
        console.warn('模块加载失败:', target, e);
        createToast('部分功能加载失败，请刷新重试', 'warning');
      }
    }
    if (renderMap[target]) renderMap[target]();
  });
  // 用户菜单中的"设置"按钮
  const settingsBtn = document.querySelector('.nav-user-dropdown [data-target="teacher-settings"]');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      // 激活设置面板
      document.querySelectorAll('.nav-link').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.panel').forEach((s) => s.classList.add('hidden'));
      const panel = document.getElementById('teacher-settings');
      if (panel) panel.classList.remove('hidden');
      const userDrop = document.querySelector('.nav-user-dropdown');
      if (userDrop) userDrop.classList.remove('show');
    });
  }
  document.getElementById('logout-button').addEventListener('click', logout);
  initializeDefaultDispatchTime();
  bindTeacherForms();
  bindTagForms();
  bindTextbookForms();
  bindKnowledgeForm();
  bindFlashcardForms();
  bindStudentManagement();
  bindPasswordForm();
  await refreshTeacherData();
  await loadStudentsOverview();
  loadTags();
  loadTextbooks();
  loadFlashcards();
});

function initializeDefaultDispatchTime() {
  const now = new Date();
  document.getElementById('dispatch-date').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  document.getElementById('dispatch-time').value = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

async function refreshTeacherData() {
  try {
    teacherState.data = await fetchJSON('/api/teacher/bootstrap');
    renderTeacherStats();
    renderTeacherTodayAlerts();
    renderWeekdayCheckboxes();
    renderStudentCheckboxes();
    renderTasks();
    // 模块数据延迟到 tab 激活时加载
  } catch (error) {
    createToast('数据加载失败，请刷新重试', 'error');
  }
}

// ── 学生管理 ──

async function loadStudentsOverview() {
  try {
    const result = await fetchJSON('/api/teacher/students/overview');
    teacherState.studentsOverview = result;
    renderStudentsOverview(result);
    // 学生数据加载后刷新统计和风险提醒
    renderTeacherStats();
    renderTeacherTodayAlerts();
  } catch (error) {
    createToast('学生数据加载失败，请刷新重试', 'error');
  }
}

function renderStudentsOverview(result) {
  const root = document.getElementById('students-list');
  const detailView = document.getElementById('student-detail-view');
  detailView.classList.add('hidden');
  detailView.innerHTML = '';

  if (!result.students.length) {
    root.innerHTML = buildEmptyState('暂无学生', '分配任务给学生后，这里会显示每个学生的完成情况。');
    return;
  }

  root.innerHTML = result.students.map((student) => {
    const completed = student.todaysCompletedCount;
    const total = student.todaysTaskCount;
    let statusBadge = '';
    if (total === 0) {
      statusBadge = '<span class="badge">无任务</span>';
    } else if (completed >= total) {
      statusBadge = '<span class="badge badge-success">已完成</span>';
    } else if (completed > 0) {
      statusBadge = '<span class="badge badge-warning">进行中</span>';
    } else {
      statusBadge = '<span class="badge badge-danger">未开始</span>';
    }

    return `
      <article class="paper-card" style="padding:16px;cursor:pointer;" data-action="view-student" data-student-id="${student.id}">
        <div class="card-head">
          <div>
            <h3 style="margin:0;">${escapeHtml(student.displayName)}</h3>
            ${student.className ? `<span class="badge" style="margin-top:6px;">${escapeHtml(student.className)}</span>` : ''}
          </div>
          ${statusBadge}
        </div>
        <div class="inline-actions" style="margin-top:10px;">
          <span class="badge">今日 ${completed}/${total} 任务</span>
          <span class="badge">正确率 ${student.practiceAccuracy}%</span>
          ${student.lastSummaryDate ? `<span class="badge">最近总结 ${escapeHtml(formatDateTime(student.lastSummaryDate).slice(0, 10))}</span>` : ''}
        </div>
      </article>
      <div class="hidden student-detail-slot" data-detail-for="${student.id}" style="margin-top:-10px;margin-bottom:12px;"></div>
    `;
  }).join('');
}

async function loadStudentDetail(studentId) {
  teacherState.selectedStudentId = studentId;
  try {
    const data = await fetchJSON(`/api/teacher/students/${studentId}/overview`);
    renderStudentDetail(data);
  } catch (error) {
    createToast('学生详情加载失败，请稍后重试', 'error');
  }
}

function renderStudentDetail(data) {
  // 先关闭所有已展开的详情
  document.querySelectorAll('.student-detail-slot:not(.hidden)').forEach((el) => {
    el.classList.add('hidden');
    el.innerHTML = '';
  });

  // 找到对应学生的 slot，插入详情
  const slot = document.querySelector(`.student-detail-slot[data-detail-for="${data.student.id}"]`);
  if (!slot) return;
  slot.classList.remove('hidden');

  const taskItems = data.todaysTasks.map((task) => `
    <div class="reply-item" style="display:flex;justify-content:space-between;align-items:center;">
      <div>
        <span class="badge badge-brand">${escapeHtml(task.subject)}</span>
        <strong style="margin-left:8px;">${escapeHtml(task.title)}</strong>
      </div>
      ${task.completed
        ? '<span class="badge badge-success">已完成</span>'
        : '<span class="badge badge-danger">未完成</span>'}
    </div>
  `).join('');

  const summaryItems = data.summaries.length
    ? data.summaries.map((s) => `
      <div class="reply-item">
        <strong>${escapeHtml(s.taskDate)}</strong>
        <p class="muted" style="margin:4px 0 0;">${escapeHtml((s.content || '').slice(0, 100))}${s.content && s.content.length > 100 ? '...' : ''}</p>
      </div>
    `).join('')
    : '<p class="muted">暂无总结记录。</p>';

  slot.innerHTML = `
    <div class="paper-card" style="padding:22px;border-left:3px solid #3b82f6;">
      <div class="card-head" style="margin-bottom:14px;">
        <div>
          <h3 style="margin:0;">${escapeHtml(data.student.displayName)} · 详细数据</h3>
        </div>
        <div class="inline-actions">
          <button class="button" data-action="remind-student" data-student-id="${data.student.id}" type="button" style="font-size:12px;padding:4px 12px;">提醒未完成任务</button>
        </div>
      </div>

      <h4 style="margin:12px 0 6px;">今日任务 (${data.todaysTasks.length})</h4>
      ${data.todaysTasks.length ? `<div class="reply-list" style="gap:8px;">${taskItems}</div>` : '<p class="muted">今日无任务。</p>'}

      <h4 style="margin:12px 0 6px;">最近总结</h4>
      ${summaryItems}

      <h4 style="margin:12px 0 6px;">练习统计</h4>
      <div class="stat-grid" style="margin-top:8px;">
        <div class="metric-card" style="padding:14px;">
          <span class="muted">总做题</span>
          <strong>${data.practiceStats.total}</strong>
        </div>
        <div class="metric-card" style="padding:14px;">
          <span class="muted">正确</span>
          <strong>${data.practiceStats.correct}</strong>
        </div>
        <div class="metric-card" style="padding:14px;">
          <span class="muted">正确率</span>
          <strong>${data.practiceStats.accuracy}%</strong>
        </div>
      </div>
    </div>
  `;

  // 滚动到展开位置
  slot.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderTeacherStats() {
  const data = teacherState.data;
  const today = new Date().toISOString().split('T')[0];
  const pendingSummaries = data.summaries.filter(s => s.taskDate >= today && !s.teacherComment).length;
  const incompleteCount = (teacherState.studentsOverview?.students || []).filter(s => {
    const completed = s.todaysCompletedCount || 0;
    const total = s.todaysTotalCount || s.todaysTaskCount || 0;
    return total > 0 && completed < total;
  }).length;

  const stats = [
    { label: '今日待处理', value: pendingSummaries + ' 条总结' },
    { label: '任务未完成学生', value: incompleteCount + ' 人' },
    { label: '学生总数', value: data.students.length }
  ];

  document.getElementById('teacher-stats').innerHTML = stats
    .map(
      (item) => `
        <div class="metric-card">
          <span class="muted">${escapeHtml(item.label)}</span>
          <strong>${escapeHtml(String(item.value))}</strong>
        </div>
      `
    )
    .join('');
}

function renderTeacherTodayAlerts() {
  const data = teacherState.data;
  const area = document.getElementById('teacher-today-alerts');
  if (!area || !data) return;
  const alerts = [];

  // 待批改总结
  const today = new Date().toISOString().split('T')[0];
  const pendingSummaries = data.summaries.filter(s => s.taskDate >= today && !s.teacherComment);
  if (pendingSummaries.length) {
    alerts.push({ type: 'warning', text: '有 ' + pendingSummaries.length + ' 条待批改总结' });
  }

  // 学生风险提醒
  if (teacherState.studentsOverview && teacherState.studentsOverview.students) {
    const students = teacherState.studentsOverview.students;

    // 任务完成率低的学生
    const lowCompletion = students.filter(s => {
      const completed = s.todaysCompletedCount || 0;
      const total = s.todaysTaskCount || 0;
      return total > 0 && completed / total < 0.3;
    });
    if (lowCompletion.length) {
      const names = lowCompletion.slice(0, 3).map(s => s.displayName).join('、');
      const suffix = lowCompletion.length > 3 ? `等${lowCompletion.length}人` : '';
      alerts.push({ type: 'danger', text: names + suffix + ' 今日任务完成率低于30%' });
    }

    // 连续未提交总结（利用 lastSummaryDate 判断）
    const noRecentSummary = students.filter(s => {
      if (!s.lastSummaryDate) return true;
      const lastDate = new Date(s.lastSummaryDate);
      const diffDays = Math.floor((Date.now() - lastDate.getTime()) / 86400000);
      return diffDays >= 3;
    });
    if (noRecentSummary.length) {
      alerts.push({ type: 'warning', text: noRecentSummary.length + ' 名学生超过3天未提交总结' });
    }
  }

  if (!alerts.length) {
    area.innerHTML = '<div class="metric-card" style="background:#dcfce7;border-color:#86efac;"><span class="muted">今日状态</span><strong style="color:#166534;">一切正常</strong></div>';
    return;
  }

  const colorMap = { warning: { bg: '#fef3c7', border: '#fcd34d', color: '#92400e' }, danger: { bg: '#fef2f2', border: '#fca5a5', color: '#b91c1c' } };
  area.innerHTML = alerts.map(a => {
    const c = colorMap[a.type] || colorMap.warning;
    return '<div class="metric-card" style="background:' + c.bg + ';border-color:' + c.border + ';"><span class="muted">风险提醒</span><strong style="font-size:14px;color:' + c.color + ';">' + escapeHtml(a.text) + '</strong></div>';
  }).join('');
}

function renderWeekdayCheckboxes() {
  const root = document.getElementById('weekday-checkboxes');
  if (root.childElementCount) {
    return;
  }

  root.innerHTML = weekdayLabels
    .map(
      (item) => `
        <label class="checkbox-chip">
          <input type="checkbox" name="weekday" value="${item.value}" checked />
          <span>${item.label}</span>
        </label>
      `
    )
    .join('');
}

function renderStudentCheckboxes() {
  const root = document.getElementById('student-checkboxes');
  root.innerHTML = teacherState.data.students
    .map(
      (student) => `
        <label class="checkbox-chip">
          <input type="checkbox" name="studentId" value="${student.id}" checked />
          <span>${escapeHtml(student.displayName)}</span>
        </label>
      `
    )
    .join('');
}

function parseTaskExtra(description) {
  if (!description) return null;
  try {
    const obj = JSON.parse(description);
    if (obj && typeof obj === 'object') return obj;
  } catch (_) {}
  return null;
}

function renderTasks() {
  const root = document.getElementById('tasks-list');
  if (!teacherState.data.tasks.length) {
    root.innerHTML = buildEmptyState('还没有规划任务', '先创建一个任务，或者导入 Excel 任务表。');
    return;
  }

  root.innerHTML = teacherState.data.tasks
    .map(
      (task) => {
        const extra = parseTaskExtra(task.description);
        const isAllDay = task.startTime === '00:00' && task.endTime === '23:59';

        let detailHtml = '';
        if (extra) {
          if (extra.tasks && extra.tasks.length) {
            detailHtml += extra.tasks.map((t) => `<div style="font-size:13px;color:#475569;padding:2px 0;">• ${escapeHtml(t)}</div>`).join('');
          }
          if (extra.link) {
            // 从长文本中提取 URL
            const urlMatch = extra.link.match(/https?:\/\/[^\s<>"']+/);
            const url = urlMatch ? urlMatch[0] : '';
            const shortLabel = extra.link.length > 60 ? extra.link.substring(0, 60) + '…' : extra.link;
            if (url) {
              detailHtml += `<div style="margin-top:6px;font-size:13px;">🔗 <a href="${escapeHtml(url)}" target="_blank" style="color:#2563eb;text-decoration:none;">打开听课链接</a><div style="font-size:11px;color:#94a3b8;margin-top:2px;word-break:break-all;">${escapeHtml(shortLabel)}</div></div>`;
            } else {
              detailHtml += `<div style="margin-top:6px;font-size:13px;color:#475569;">🔗 ${escapeHtml(extra.link)}</div>`;
            }
          }
          if (extra.time) {
            detailHtml += `<div style="margin-top:6px;"><span style="display:inline-block;font-size:12px;background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:6px;">⏱ ${escapeHtml(extra.time)}</span></div>`;
          }
          if (extra.notes) {
            detailHtml += `<div style="margin-top:6px;font-size:13px;color:#dc2626;background:#fef2f2;padding:6px 10px;border-radius:8px;border-left:3px solid #fca5a5;">💡 ${escapeHtml(extra.notes)}</div>`;
          }
        } else if (task.description) {
          detailHtml = `<p class="muted">${escapeHtml(task.description)}</p>`;
        }

        return `
        <article class="task-card">
          <div class="card-head">
            <div>
              <div class="badge badge-brand">${escapeHtml(task.subject)}</div>
              <h3>${escapeHtml(task.title)}</h3>
              ${detailHtml}
            </div>
            <div>
              ${!isAllDay ? `<div class="badge">${escapeHtml(task.startTime)} - ${escapeHtml(task.endTime)}</div>` : ''}
            </div>
          </div>
          <div class="inline-actions">
            ${!isAllDay ? `<span class="badge">${escapeHtml(task.weekdaysLabel)}</span>` : ''}
            ${task.students.map((student) => `<span class="badge">${escapeHtml(student.displayName)}</span>`).join('')}
          </div>
        </article>
      `;
      }
    )
    .join('');
}

function renderSummaries() {
  const root = document.getElementById('summaries-list');
  if (!teacherState.data.summaries.length) {
    root.innerHTML = buildEmptyState('还没有学生总结', '学生在晚上提交复盘后，这里会显示文字、图片和附件。');
    return;
  }

  root.innerHTML = teacherState.data.summaries
    .map(
      (summary) => `
        <article class="summary-card">
          <div class="card-head">
            <div>
              <h3>${escapeHtml(summary.studentName)} · ${escapeHtml(summary.taskDate)}</h3>
              <p class="muted">${escapeHtml(summary.content || '暂无文字总结')}</p>
            </div>
            <div class="badge">${escapeHtml(formatDateTime(summary.updatedAt))}</div>
          </div>
          ${summary.imagePaths.length ? `<div class="asset-list">${summary.imagePaths.map((item) => `<a class="badge" href="${escapeHtml(item)}" target="_blank">查看图片</a>`).join('')}</div>` : ''}
          ${summary.attachmentPaths.length ? `<div class="asset-list">${summary.attachmentPaths.map((item) => `<a class="badge" href="${escapeHtml(item)}" target="_blank">打开附件</a>`).join('')}</div>` : ''}
          <div style="margin-top:10px;border-top:1px dashed rgba(30,41,59,0.1);padding-top:10px;">
            ${summary.teacherComment ? `
              <div style="background:#eff6ff;padding:8px 12px;border-radius:8px;font-size:13px;margin-bottom:8px;">
                <strong style="color:#2563eb;">老师点评：</strong>${escapeHtml(summary.teacherComment)}
                <span class="muted" style="font-size:11px;margin-left:6px;">${escapeHtml(summary.commentedAt ? formatDateTime(summary.commentedAt) : '')}</span>
              </div>
            ` : ''}
            <div style="display:flex;gap:6px;">
              <input class="input" type="text" placeholder="写点评..." data-summary-id="${summary.id}" style="flex:1;font-size:13px;padding:6px 10px;" />
              <button class="button" type="button" data-action="comment-summary" data-id="${summary.id}" style="font-size:12px;padding:4px 12px;">发送</button>
            </div>
          </div>
        </article>
      `
    )
    .join('');

  // 事件委托 — 发送点评
  root.onclick = async (event) => {
    const btn = event.target.closest('[data-action="comment-summary"]');
    if (!btn) return;
    const summaryId = btn.dataset.id;
    const input = btn.parentElement.querySelector('input');
    const comment = (input.value || '').trim();
    if (!comment) return;

    btn.disabled = true;
    try {
      await fetchJSON(`/api/summaries/${summaryId}/comment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment })
      });
      createToast('点评已发送。', 'success');
      await refreshTeacherData();
    } catch (error) {
      createToast(error.message, 'error');
    } finally {
      btn.disabled = false;
    }
  };
}

function renderCourses() {
  // 云盘文件浏览器 — 初始加载根目录
  loadCloudFolder(null);
}

async function loadCloudFolder(parentId) {
  teacherState.cloudState.currentParentId = parentId;
  try {
    const url = '/api/folders' + (parentId ? '?parentId=' + parentId : '');
    const result = await fetchJSON(url);
    teacherState.cloudState.path = result.path || [];
    teacherState.cloudState.folders = result.folders || [];
    teacherState.cloudState.items = result.items || [];
    renderCloudView();
  } catch (error) {
    createToast('网盘加载失败，请稍后重试', 'error');
  }
}

function formatFileSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function renderCloudView() {
  const cs = teacherState.cloudState;
  // 面包屑
  const bc = document.getElementById('folder-breadcrumb');
  bc.innerHTML = '<a data-folder-id="">根目录</a>' +
    cs.path.map((p) => `<span> / </span><a data-folder-id="${p.id}">${escapeHtml(p.name)}</a>`).join('');

  // 文件夹
  const fg = document.getElementById('cloud-folder-grid');
  fg.innerHTML = cs.folders.length
    ? cs.folders.map((f) => `
      <div class="paper-card cloud-item" data-action="open-folder" data-folder-id="${f.id}">
        <div class="cloud-item-icon">&#128193;</div>
        <strong>${escapeHtml(f.name)}</strong>
        <button class="danger-button" data-action="delete-folder" data-folder-id="${f.id}" type="button" style="font-size:12px;padding:4px 10px;">删除</button>
      </div>
    `).join('')
    : '';

  // 文件
  const ig = document.getElementById('cloud-items-grid');
  ig.innerHTML = cs.items.length
    ? cs.items.map((item) => {
      const icon = item.itemType === 'video' ? '&#127909;' : item.itemType === 'audio' ? '&#127925;' : '&#128196;';
      const src = item.filePath || item.fileUrl;
      return `
        <div class="paper-card cloud-item">
          <div class="cloud-item-icon">${icon}</div>
          <strong>${escapeHtml(item.title)}</strong>
          ${item.subject ? `<span class="badge badge-brand">${escapeHtml(item.subject)}</span>` : ''}
          ${item.fileSize ? `<span class="muted">${formatFileSize(item.fileSize)}</span>` : ''}
          ${src ? `<a class="ghost-button" href="${escapeHtml(src)}" target="_blank" style="font-size:12px;padding:4px 10px;">查看</a>` : ''}
          <button class="danger-button" data-action="delete-item" data-item-id="${item.id}" type="button" style="font-size:12px;padding:4px 10px;">删除</button>
        </div>
      `;
    }).join('')
    : (!cs.folders.length ? '<p class="muted">当前文件夹为空。</p>' : '');
}

function renderLiveSessions() {
  const root = document.getElementById('live-list');
  if (!teacherState.data.liveSessions.length) {
    root.innerHTML = buildEmptyState('还没有直播间', '创建直播后，老师和学生都可以进入直播房间。');
    return;
  }

  root.innerHTML = teacherState.data.liveSessions
    .map(
      (session) => `
        <article class="paper-card">
          <div class="card-head">
            <div>
              <div class="badge badge-brand">${escapeHtml(session.subject)}</div>
              <h3>${escapeHtml(session.title)}</h3>
              <p class="muted">${escapeHtml(session.description || '暂无直播说明')}</p>
            </div>
            <div class="badge">${session.status === 'live' ? '直播中' : session.status === 'ended' ? '已结束' : '待开始'}</div>
          </div>
          <div class="inline-actions">
            <button class="button" data-action="start-live" data-id="${session.id}" type="button">开始直播</button>
            <button class="danger-button" data-action="end-live" data-id="${session.id}" type="button">结束直播</button>
            <a class="ghost-button" href="/live/${session.id}" target="_blank" style="text-decoration: none;">进入直播间</a>
          </div>
        </article>
      `
    )
    .join('');
}

function renderQuestions() {
  const root = document.getElementById('questions-list');
  if (!teacherState.data.questions.length) {
    root.innerHTML = buildEmptyState('题库还是空的', '录入一道题，学生端即可开始刷题。');
    return;
  }

  root.innerHTML = teacherState.data.questions
    .map(
      (question) => `
        <article class="question-card">
          <div class="card-head">
            <div>
              <div class="badge badge-brand">${escapeHtml(question.subject)}</div>
              <h3>${escapeHtml(question.title)}</h3>
              <p>${escapeHtml(question.stem)}</p>
            </div>
            <div class="badge">答案 ${escapeHtml(question.correctAnswer)}</div>
          </div>
          <div class="reply-list">
            ${question.options.map((option) => `<div class="reply-item"><strong>${escapeHtml(option.key)}</strong> ${escapeHtml(option.text)}</div>`).join('')}
          </div>
          ${question.analysisText ? `<p class="muted" style="margin-top: 12px;">${escapeHtml(question.analysisText)}</p>` : ''}
          ${question.analysisVideoPath || question.analysisVideoUrl ? `<video class="video-frame" controls src="${escapeHtml(question.analysisVideoPath || question.analysisVideoUrl)}"></video>` : ''}
        </article>
      `
    )
    .join('');
}

// ── 标签管理 ──

async function loadTags() {
  try {
    const result = await fetchJSON('/api/questions/tags');
    teacherState.tags = result.tags;
    renderTagsList();
    renderKnowledgeList();
    renderQuestionTagCheckboxes();
  } catch (error) {
    // 标签加载失败不阻塞页面
  }
}

function renderTagsList() {
  const root = document.getElementById('tags-list');
  if (!teacherState.tags.length) {
    root.innerHTML = '<p class="muted">暂无标签，创建后可在录入题目时关联。</p>';
    return;
  }
  root.innerHTML = '<div class="inline-actions">' + teacherState.tags.map((tag) =>
    `<span class="badge">${escapeHtml(tag.name)} <span class="muted">(${tag.count})</span></span>`
  ).join('') + '</div>';
}

function renderQuestionTagCheckboxes() {
  const root = document.getElementById('question-tag-checkboxes');
  if (!teacherState.tags.length) {
    root.innerHTML = '<p class="muted">暂无标签。</p>';
    return;
  }
  root.innerHTML = teacherState.tags.map((tag) =>
    `<label class="checkbox-chip"><input type="checkbox" name="tagId" value="${tag.id}" /><span>${escapeHtml(tag.name)}</span></label>`
  ).join('');
}

function bindTagForms() {
  document.getElementById('tag-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    try {
      await fetchJSON('/api/questions/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.get('name'),
          category: formData.get('category')
        })
      });
      createToast('标签已创建。', 'success');
      form.reset();
      await loadTags();
    } catch (error) {
      createToast(error.message, 'error');
    }
  });
}

// ── 书本管理 ──

async function loadTextbooks() {
  try {
    const result = await fetchJSON('/api/questions/textbooks');
    teacherState.textbooks = result.textbooks;
    renderTextbooksList();
    updateTextbookSelects();
  } catch (_) {}
  // 同时加载题型下拉
  try {
    const meta = await fetchJSON('/api/questions/meta');
    const typeSel = document.getElementById('question-type-select');
    if (typeSel && meta.types) {
      typeSel.innerHTML = '<option value="">未指定</option>' + meta.types.map((t) =>
        `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`
      ).join('');
    }
  } catch (_) {}
}

function renderTextbooksList() {
  const root = document.getElementById('textbooks-list');
  if (!teacherState.textbooks.length) {
    root.innerHTML = '<p class="muted">暂无书本，添加后录入题目时可选择。</p>';
    return;
  }
  root.innerHTML = '<div class="inline-actions" style="flex-wrap:wrap;">' + teacherState.textbooks.map((tb) =>
    `<span class="badge" style="gap:6px;">📘 ${escapeHtml(tb.textbook)} <span class="muted">(${tb.count}题)</span> <button type="button" class="ghost-button" data-delete-textbook="${escapeHtml(tb.textbook)}" style="font-size:11px;padding:2px 8px;">删除</button></span>`
  ).join('') + '</div>';
}

function updateTextbookSelects() {
  const opts = '<option value="">未指定</option>' + teacherState.textbooks.map((tb) =>
    `<option value="${escapeHtml(tb.textbook)}">${escapeHtml(tb.textbook)}</option>`
  ).join('');
  const qSel = document.getElementById('question-textbook-select');
  if (qSel) qSel.innerHTML = opts;
  const kSel = document.getElementById('knowledge-textbook-select');
  if (kSel) kSel.innerHTML = opts;
}

function bindTextbookForms() {
  const form = document.getElementById('textbook-form');
  if (!form) return;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const name = (formData.get('name') || '').trim();
    if (!name) return;
    try {
      await fetchJSON('/api/questions/textbooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      createToast('书本已添加。', 'success');
      form.reset();
      await loadTextbooks();
    } catch (error) {
      createToast(error.message, 'error');
    }
  });

  // 删除书本（事件委托）
  document.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-delete-textbook]');
    if (!btn) return;
    const name = btn.dataset.deleteTextbook;
    const ok = await confirmDialog({ title: '删除书本', message: `将"${name}"下所有题目的书本标记清除，题目不会被删除。确定？`, danger: true });
    if (!ok) return;
    try {
      await fetchJSON(`/api/questions/textbooks/${encodeURIComponent(name)}`, { method: 'DELETE' });
      createToast('书本已删除。', 'success');
      await loadTextbooks();
    } catch (error) {
      createToast(error.message, 'error');
    }
  });
}

// ── 知识点管理 ──

function renderKnowledgeList() {
  const root = document.getElementById('knowledge-list');
  const knowledgeTags = teacherState.tags.filter((t) => t.category === 'textbook' || t.category === 'custom');
  if (!knowledgeTags.length) {
    root.innerHTML = '<p class="muted">暂无知识点。</p>';
    return;
  }
  root.innerHTML = '<div class="inline-actions" style="flex-wrap:wrap;">' + knowledgeTags.map((tag) =>
    `<span class="badge" style="gap:6px;">📌 ${escapeHtml(tag.name)} <span class="muted">(${tag.count}题)</span></span>`
  ).join('') + '</div>';
}

function bindKnowledgeForm() {
  const form = document.getElementById('knowledge-form');
  if (!form) return;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const name = (formData.get('name') || '').trim();
    if (!name) return;
    try {
      await fetchJSON('/api/questions/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, category: 'textbook' })
      });
      createToast('知识点已添加。', 'success');
      form.reset();
      await loadTags();
      renderKnowledgeList();
    } catch (error) {
      createToast(error.message, 'error');
    }
  });
}

function bindFlashcardForms() {
  document.getElementById('flashcard-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const tagsRaw = (formData.get('tags') || '').split(/[,，]/).map((t) => t.trim()).filter(Boolean);
    try {
      await fetchJSON('/api/flashcards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: formData.get('title'),
          subject: formData.get('subject'),
          frontContent: formData.get('frontContent'),
          backContent: formData.get('backContent'),
          exampleSentence: formData.get('exampleSentence'),
          tags: tagsRaw
        })
      });
      createToast('卡片已创建。', 'success');
      form.reset();
      await loadFlashcards();
    } catch (error) {
      createToast(error.message, 'error');
    }
  });

  const flashcardImportForm = document.getElementById('flashcard-import-form');
  if (flashcardImportForm) {
    flashcardImportForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      try {
        const result = await fetchJSON('/api/flashcards/import', {
          method: 'POST',
          body: new FormData(form)
        });
        createToast(`导入完成：成功 ${result.imported} 条，跳过 ${result.skipped} 条。`, 'success');
        form.reset();
        await loadFlashcards();
      } catch (error) {
        createToast(error.message, 'error');
      }
    });
  }
}

// ── 词汇卡片管理 ──

async function loadFlashcards() {
  try {
    const result = await fetchJSON('/api/flashcards');
    teacherState.flashcards = result.flashcards;
    renderFlashcards();
  } catch (error) {
    console.warn('词汇卡片加载失败:', error);
  }
}

function renderFlashcards() {
  const root = document.getElementById('flashcards-list');
  if (!teacherState.flashcards.length) {
    root.innerHTML = buildEmptyState('暂无词汇卡片', '创建或导入卡片后，学生可开始复习。');
    return;
  }
  root.innerHTML = teacherState.flashcards.map((card) => `
    <article class="paper-card" style="padding:16px;">
      <div class="card-head">
        <div>
          <div class="badge badge-brand">${escapeHtml(card.subject || '通用')}</div>
          <h3 style="margin:4px 0;">${escapeHtml(card.title)}</h3>
          <p class="muted" style="margin:0;">正面: ${escapeHtml((card.frontContent || '').slice(0, 80))}</p>
          <p class="muted" style="margin:0;">背面: ${escapeHtml((card.backContent || '').slice(0, 80))}</p>
        </div>
        <div class="badge">${card.tags.length ? card.tags.map((t) => escapeHtml(t)).join(', ') : '无标签'}</div>
      </div>
    </article>
  `).join('');
}

function renderStore() {
  const productsRoot = document.getElementById('products-list');
  const ordersRoot = document.getElementById('orders-list');

  productsRoot.innerHTML = teacherState.data.products.length
    ? teacherState.data.products
        .map(
          (product) => `
            <article class="store-card">
              <div class="card-head">
                <div>
                  <h3>${escapeHtml(product.title)}</h3>
                  <p class="muted">${escapeHtml(product.description || '暂无商品说明')}</p>
                </div>
                <div>
                  <div class="badge badge-brand">${escapeHtml(formatMoney(product.price))}</div>
                  <div class="badge">库存 ${escapeHtml(product.stock)}</div>
                </div>
              </div>
              ${product.imagePath ? `<img class="image-preview" src="${escapeHtml(product.imagePath)}" alt="${escapeHtml(product.title)}" />` : ''}
            </article>
          `
        )
        .join('')
    : buildEmptyState('还没有上架资料', '可上架规划手册、冲刺资料包、答题模板等。');

  ordersRoot.innerHTML = teacherState.data.orders.length
    ? teacherState.data.orders
        .map(
          (order) => `
            <article class="order-card">
              <div class="card-head">
                <div>
                  <h3>${escapeHtml(order.productTitle)}</h3>
                  <p class="muted">${escapeHtml(order.studentName)} · 数量 ${escapeHtml(order.quantity)}</p>
                  <p class="muted">${escapeHtml(order.shippingAddress)}</p>
                </div>
                <div>
                  <div class="badge badge-brand">${escapeHtml(formatMoney(order.totalAmount))}</div>
                  <div class="badge">${escapeHtml(order.status)}</div>
                </div>
              </div>
              <div class="inline-actions" style="margin-top:8px;">
                ${order.status === 'paid' ? `<button class="button" data-action="update-order" data-id="${order.id}" data-status="shipped" type="button" style="font-size:12px;padding:6px 14px;">发货</button>` : ''}
                ${order.status === 'shipped' ? `<button class="button" data-action="update-order" data-id="${order.id}" data-status="delivered" type="button" style="font-size:12px;padding:6px 14px;">确认送达</button>` : ''}
              </div>
            </article>
          `
        )
        .join('')
    : buildEmptyState('还没有订单', '学生购买资料后，这里会显示下单记录。');
}

function bindTeacherForms() {
  // 子任务动态添加/删除
  const subtaskList = document.getElementById('subtask-list');
  if (subtaskList) {
    subtaskList.addEventListener('click', (event) => {
      const removeBtn = event.target.closest('[data-action="remove-subtask"]');
      if (removeBtn) {
        const rows = subtaskList.querySelectorAll('.subtask-row');
        if (rows.length > 1) removeBtn.closest('.subtask-row').remove();
      }
    });
  }
  const addSubtaskBtn = document.getElementById('add-subtask-btn');
  if (addSubtaskBtn) {
    addSubtaskBtn.addEventListener('click', () => {
      const row = document.createElement('div');
      row.className = 'subtask-row';
      row.style.cssText = 'display:flex;gap:6px;align-items:center;';
      row.innerHTML = '<input class="input" name="subtask" placeholder="子任务内容" style="flex:1;" /><button class="ghost-button" type="button" data-action="remove-subtask" style="font-size:12px;padding:4px 8px;">删除</button>';
      subtaskList.appendChild(row);
    });
  }

  document.getElementById('task-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submitBtn = form.querySelector('button[type="submit"]');
    const formData = new FormData(form);
    const weekdays = Array.from(document.querySelectorAll('input[name="weekday"]:checked')).map((item) => item.value);
    const studentIds = Array.from(document.querySelectorAll('input[name="studentId"]:checked')).map((item) => item.value);
    const subtasks = Array.from(form.querySelectorAll('input[name="subtask"]')).map((el) => el.value.trim()).filter(Boolean);

    setButtonLoading(submitBtn, true);
    try {
      await fetchJSON('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: formData.get('title'),
          description: formData.get('description'),
          subject: formData.get('subject'),
          startTime: formData.get('startTime'),
          endTime: formData.get('endTime'),
          weekdays,
          studentIds,
          priority: Number(formData.get('priority')) || 2,
          subtasks,
          reminderStart: formData.get('reminderStart') || '',
          reminderEnd: formData.get('reminderEnd') || ''
        })
      });
      createToast('任务已创建。', 'success');
      form.reset();
      // 重置子任务列表为只留一个空行
      document.getElementById('subtask-list').innerHTML = '<div class="subtask-row" style="display:flex;gap:6px;align-items:center;"><input class="input" name="subtask" placeholder="例如：背50个单词" style="flex:1;" /><button class="ghost-button" type="button" data-action="remove-subtask" style="font-size:12px;padding:4px 8px;">删除</button></div>';
      await refreshTeacherData();
    } catch (error) {
      createToast(error.message, 'error');
    } finally {
      setButtonLoading(submitBtn, false);
    }
  });

  document.getElementById('task-import-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submitBtn = form.querySelector('button[type="submit"]');
    setButtonLoading(submitBtn, true);
    try {
      const result = await fetchJSON('/api/tasks/import', {
        method: 'POST',
        body: new FormData(form)
      });
      createToast(`导入完成：成功 ${result.imported} 条，跳过 ${result.skipped} 条。`, 'success');
      form.reset();
      await refreshTeacherData();
    } catch (error) {
      createToast(error.message, 'error');
    } finally {
      setButtonLoading(submitBtn, false);
    }
  });

  document.getElementById('dispatch-daily-button').addEventListener('click', async () => {
    const btn = document.getElementById('dispatch-daily-button');
    setButtonLoading(btn, true);
    try {
      const result = await fetchJSON('/api/tasks/dispatch/daily', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: document.getElementById('dispatch-date').value })
      });
      createToast(`已发送 ${result.sent} 条总任务提醒。`, 'success');
      await refreshTeacherData();
    } catch (error) {
      createToast(error.message, 'error');
    } finally {
      setButtonLoading(btn, false);
    }
  });

  document.getElementById('dispatch-due-button').addEventListener('click', async () => {
    const btn = document.getElementById('dispatch-due-button');
    setButtonLoading(btn, true);
    try {
      const result = await fetchJSON('/api/tasks/dispatch/due', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: document.getElementById('dispatch-date').value,
          time: document.getElementById('dispatch-time').value
        })
      });
      createToast(`已发送 ${result.sent} 条节点提醒。`, 'success');
      await refreshTeacherData();
    } catch (error) {
      createToast(error.message, 'error');
    } finally {
      setButtonLoading(btn, false);
    }
  });

  document.getElementById('create-folder-btn').addEventListener('click', () => {
    document.getElementById('create-folder-form').classList.toggle('hidden');
  });
  document.getElementById('upload-file-btn').addEventListener('click', () => {
    document.getElementById('upload-file-form').classList.toggle('hidden');
  });

  document.getElementById('create-folder-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    try {
      await fetchJSON('/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.get('name'),
          parentId: teacherState.cloudState.currentParentId || null
        })
      });
      createToast('文件夹已创建。', 'success');
      form.reset();
      form.classList.add('hidden');
      await loadCloudFolder(teacherState.cloudState.currentParentId);
    } catch (error) {
      createToast(error.message, 'error');
    }
  });

  document.getElementById('upload-file-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fd = new FormData(form);
    fd.set('folderId', teacherState.cloudState.currentParentId || '');
    try {
      await fetchJSON('/api/folder-items', {
        method: 'POST',
        body: fd
      });
      createToast('文件已上传。', 'success');
      form.reset();
      form.classList.add('hidden');
      await loadCloudFolder(teacherState.cloudState.currentParentId);
    } catch (error) {
      createToast(error.message, 'error');
    }
  });

  // 云盘导航和操作事件委托
  document.getElementById('folder-breadcrumb').addEventListener('click', (event) => {
    const link = event.target.closest('a[data-folder-id]');
    if (link) {
      const id = link.dataset.folderId;
      loadCloudFolder(id ? Number(id) : null);
    }
  });

  document.getElementById('cloud-folder-grid').addEventListener('click', async (event) => {
    const openBtn = event.target.closest('[data-action="open-folder"]');
    if (openBtn) {
      await loadCloudFolder(Number(openBtn.dataset.folderId));
      return;
    }
    const delBtn = event.target.closest('[data-action="delete-folder"]');
    if (delBtn) {
      if (!await confirmDialog({ title: '删除文件夹', message: '确定删除该文件夹及其所有内容？删除后不可恢复。', confirmText: '删除', danger: true })) return;
      try {
        await fetchJSON(`/api/folders/${delBtn.dataset.folderId}`, { method: 'DELETE' });
        createToast('文件夹已删除。', 'success');
        await loadCloudFolder(teacherState.cloudState.currentParentId);
      } catch (error) {
        createToast(error.message, 'error');
      }
    }
  });

  document.getElementById('cloud-items-grid').addEventListener('click', async (event) => {
    const delBtn = event.target.closest('[data-action="delete-item"]');
    if (delBtn) {
      if (!await confirmDialog({ title: '删除文件', message: '确定删除该文件？删除后不可恢复。', confirmText: '删除', danger: true })) return;
      try {
        await fetchJSON(`/api/folder-items/${delBtn.dataset.itemId}`, { method: 'DELETE' });
        createToast('文件已删除。', 'success');
        await loadCloudFolder(teacherState.cloudState.currentParentId);
      } catch (error) {
        createToast(error.message, 'error');
      }
    }
  });

  document.getElementById('live-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await fetchJSON('/api/live-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(new FormData(form).entries()))
      });
      createToast('直播间已创建。', 'success');
      form.reset();
      await refreshTeacherData();
    } catch (error) {
      createToast(error.message, 'error');
    }
  });

  document.getElementById('question-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const result = await fetchJSON('/api/questions', {
        method: 'POST',
        body: new FormData(form)
      });
      // 关联标签
      const tagIds = Array.from(form.querySelectorAll('input[name="tagId"]:checked')).map((cb) => Number(cb.value));
      if (tagIds.length && result.id) {
        await fetchJSON(`/api/questions/${result.id}/tags`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tagIds })
        });
      }
      createToast('题目已录入。', 'success');
      form.reset();
      await refreshTeacherData();
    } catch (error) {
      createToast(error.message, 'error');
    }
  });

  document.getElementById('product-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await fetchJSON('/api/products', {
        method: 'POST',
        body: new FormData(form)
      });
      createToast('商品已上架。', 'success');
      form.reset();
      await refreshTeacherData();
    } catch (error) {
      createToast(error.message, 'error');
    }
  });

  document.getElementById('live-list').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) {
      return;
    }

    try {
      if (button.dataset.action === 'start-live') {
        await fetchJSON(`/api/live-sessions/${button.dataset.id}/start`, { method: 'POST' });
        createToast('直播已切换为进行中。', 'success');
      }

      if (button.dataset.action === 'end-live') {
        await fetchJSON(`/api/live-sessions/${button.dataset.id}/end`, { method: 'POST' });
        createToast('直播已结束。', 'success');
      }

      await refreshTeacherData();
    } catch (error) {
      createToast(error.message, 'error');
    }
  });

  // 订单状态更新
  document.getElementById('orders-list').addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-action="update-order"]');
    if (!btn) return;
    try {
      await fetchJSON(`/api/orders/${btn.dataset.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: btn.dataset.status })
      });
      createToast('订单状态已更新。', 'success');
      await refreshTeacherData();
    } catch (error) {
      createToast(error.message, 'error');
    }
  });
}

function bindStudentManagement() {
  document.getElementById('students-list').addEventListener('click', async (event) => {
    // 提醒学生（优先处理，避免被卡片点击拦截）
    const remindBtn = event.target.closest('[data-action="remind-student"]');
    if (remindBtn) {
      try {
        const result = await fetchJSON(`/api/teacher/students/${remindBtn.dataset.studentId}/remind`, {
          method: 'POST'
        });
        createToast(result.message || `已发送提醒 (${result.count} 项未完成任务)。`, 'success');
      } catch (error) {
        createToast(error.message, 'error');
      }
      return;
    }

    // 点击学生卡片 → toggle 展开/收起
    const card = event.target.closest('[data-action="view-student"]');
    if (card) {
      const studentId = card.dataset.studentId;
      const slot = document.querySelector(`.student-detail-slot[data-detail-for="${studentId}"]`);
      // 如果已展开 → 收起
      if (slot && !slot.classList.contains('hidden')) {
        slot.classList.add('hidden');
        slot.innerHTML = '';
        return;
      }
      // 否则 → 展开
      await loadStudentDetail(Number(studentId));
    }
  });
}

function showLightbox(src) {
  const overlay = document.createElement('div');
  overlay.className = 'lightbox-overlay';
  overlay.innerHTML = `<img src="${escapeHtml(src)}" />`;
  overlay.addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action="lightbox"]');
  if (target) {
    showLightbox(target.dataset.src || target.src);
  }
});

function bindPasswordForm() {
  const form = document.getElementById('change-password-form');
  if (!form) return;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    try {
      await fetchJSON('/api/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          oldPassword: formData.get('oldPassword'),
          newPassword: formData.get('newPassword')
        })
      });
      createToast('密码修改成功。', 'success');
      form.reset();
    } catch (error) {
      createToast(error.message, 'error');
    }
  });
}

// ===== 第二阶段教师端新功能 =====

// 模拟考试创建
document.getElementById('mock-exam-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const formData = new FormData(form);
  const title = formData.get('title');
  const subject = formData.get('subject') || '';
  const duration = Number(formData.get('duration')) || 120;
  const idsStr = formData.get('questionIds') || '';
  const questionIds = idsStr.split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
  if (!title || !questionIds.length) { createToast('请填写标题和题目ID。', 'error'); return; }
  try {
    await fetchJSON('/api/mock-exams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, subject, durationMinutes: duration, questionIds })
    });
    createToast('模拟考试已创建。', 'success');
    form.reset();
    loadMockExamsList();
  } catch (err) { createToast(err.message, 'error'); }
});

async function loadMockExamsList() {
  try {
    const res = await fetchJSON('/api/mock-exams');
    const root = document.getElementById('mock-exams-list');
    if (!root) return;
    root.innerHTML = res.exams.length ? res.exams.map((e) => {
      const qIds = safeJsonParse(e.questionIds || e.question_ids, []);
      return '<div class="paper-card" style="display:flex;justify-content:space-between;align-items:center;">' +
        '<div><strong>' + escapeHtml(e.title) + '</strong><div class="muted" style="font-size:12px;">' + escapeHtml(e.subject || '综合') + ' · ' + (e.duration_minutes || e.durationMinutes) + '分钟 · ' + qIds.length + '题</div></div>' +
        '<div class="muted" style="font-size:12px;">创建者：' + escapeHtml(e.creator_name || '') + '</div></div>';
    }).join('') : '<p class="muted">暂无模拟考试。</p>';
  } catch (_) {}
}

// AI 生成题目
document.getElementById('ai-generate-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const formData = new FormData(form);
  const resultDiv = document.getElementById('ai-generate-result');
  if (resultDiv) { resultDiv.style.display = 'block'; resultDiv.innerHTML = '<div class="muted">AI 正在生成题目...</div>'; }
  try {
    const res = await fetchJSON('/api/ai/generate-questions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject: formData.get('subject') || '综合',
        topic: formData.get('topic') || '综合',
        count: Number(formData.get('count')) || 5,
        type: '选择题'
      })
    });
    if (resultDiv) {
      resultDiv.innerHTML = '<div style="white-space:pre-wrap;font-size:13px;padding:12px;background:var(--bg);border-radius:10px;max-height:400px;overflow:auto;">' + escapeHtml(res.response) + '</div>';
    }
  } catch (err) {
    if (resultDiv) { resultDiv.innerHTML = '<div style="color:#ef4444;">' + escapeHtml(err.message) + '</div>'; }
  }
});

function safeJsonParse(str, fallback) {
  try { return JSON.parse(str); } catch (_) { return fallback; }
}

// 加载模拟考试列表
loadMockExamsList();
