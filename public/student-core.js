// student-core.js — Initialization, state management, core rendering, bindStudentForms, socket, focus timer

let flashcardMode = 'flip';

const studentState = {
  user: null,
  data: null,
  socket: null,
  answerResults: {},
  token: null,
  cloudState: { currentParentId: null, path: [], folders: [], items: [] },
  flashcardState: { dueCards: [], currentIndex: 0, isFlipped: false, stats: { total: 0, again: 0, hard: 0, good: 0, easy: 0 } },
  questionFilter: { subject: '', questionType: '', tagId: '', page: 1, mode: 'sequential' },
  questionTimers: {},
  focusTimer: { running: false, paused: false, totalSeconds: 1500, remainingSeconds: 1500, intervalId: null, taskName: '' },
  notificationFilter: 'all'
};

document.addEventListener('DOMContentLoaded', async () => {
  const authResult = await ensureAuth('student').catch(() => null);
  if (!authResult) {
    return;
  }

  studentState.user = authResult.user;
  studentState.token = authResult.token;
  const nameEl = document.getElementById('student-name');
  if (nameEl) nameEl.textContent = authResult.user.displayName;
  // 设置面板账号信息
  const accountInfo = document.getElementById('settings-account-info');
  if (accountInfo) {
    accountInfo.innerHTML = `
      <div class="settings-info-item"><span class="muted">用户名</span><strong>${escapeHtml(authResult.user.username)}</strong></div>
      <div class="settings-info-item"><span class="muted">姓名</span><strong>${escapeHtml(authResult.user.displayName)}</strong></div>
      <div class="settings-info-item"><span class="muted">班级</span><strong>${escapeHtml(authResult.user.className || '未设置')}</strong></div>
      <div class="settings-info-item"><span class="muted">角色</span><strong>学生</strong></div>
    `;
  }
  const nowInit = new Date();
  document.getElementById('summary-date').value = `${nowInit.getFullYear()}-${String(nowInit.getMonth() + 1).padStart(2, '0')}-${String(nowInit.getDate()).padStart(2, '0')}`;
  activateTabs('.nav-link', '.panel', async (target) => {
    // 延迟加载：非核心面板首次激活时按需请求数据
    if (!studentState.data) return;
    const moduleMap = {
      'student-courses': 'courses',
      'student-live': 'liveSessions',
      'student-forum': 'forumTopics',
      'student-questions': 'questions',
      'student-store': 'products,orders'
    };
    const renderMap = {
      'student-courses': () => renderCourses(),
      'student-live': () => renderLiveSessions(),
      'student-questions': () => renderQuestions(),
      'student-store': () => renderStore(),
      'student-flashcards': () => { loadDueFlashcards(); },
      'student-stats-panel': () => loadDetailedStats(),
      'student-checkin': () => loadCheckinCalendar(),
      'student-achievements': () => loadAchievements(),
      'student-daily': () => {}
    };
    // 如果该 tab 需要从服务端加载模块数据，且本地还没有
    if (moduleMap[target] && !studentState.data._loadedModules?.has(target)) {
      try {
        const moduleData = await fetchJSON('/api/student/bootstrap?modules=' + moduleMap[target]);
        Object.assign(studentState.data, moduleData);
        if (!studentState.data._loadedModules) studentState.data._loadedModules = new Set();
        studentState.data._loadedModules.add(target);
      } catch (e) {
        console.warn('模块加载失败:', target, e);
        createToast('部分功能加载失败，请刷新重试', 'warning');
      }
    }
    if (renderMap[target]) renderMap[target]();
  });
  // 用户菜单中的"设置"按钮
  const settingsBtn = document.querySelector('.nav-user-dropdown [data-target="student-settings"]');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      document.querySelectorAll('.nav-link').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.panel').forEach((s) => s.classList.add('hidden'));
      const panel = document.getElementById('student-settings');
      if (panel) panel.classList.remove('hidden');
      const userDrop = document.querySelector('.nav-user-dropdown');
      if (userDrop) userDrop.classList.remove('show');
    });
  }
  document.getElementById('logout-button').addEventListener('click', logout);

  // Hero 区域"下一步动作"点击事件委托
  document.getElementById('next-action-area').addEventListener('click', (event) => {
    const goSummary = event.target.closest('[data-action="go-summary"]');
    if (goSummary) {
      const summaryTab = document.querySelector('[data-target="student-summary"]');
      if (summaryTab) summaryTab.click();
    }
  });

  // 总结 CTA 按钮点击事件委托
  document.getElementById('summary-cta-area').addEventListener('click', (event) => {
    const goSummary = event.target.closest('[data-action="go-summary"]');
    if (goSummary) {
      const summaryTab = document.querySelector('[data-target="student-summary"]');
      if (summaryTab) summaryTab.click();
    }
  });

  document.getElementById('notification-button').addEventListener('click', async () => {
    if ('Notification' in window) {
      const permission = await Notification.requestPermission();
      createToast(`提醒权限状态：${permission}`, 'success');
    }
  });

  bindStudentForms();
  bindStudentCloud();
  bindFlashcardControls();
  bindFocusTimer();
  bindPracticeMode();
  bindGlobalSearch();
  bindDailyQuestions();
  bindCartEvents();
  bindAddressEvents();
  bindProductReviewEvents();
  bindStatsTabs();
  bindCourseTabs();
  bindFlashcardGoal();
  bindReportExport();
  bindExamCountdown();
  bindHabits();
  bindWrongReview();
  bindQuestionNotes();
  bindAutoPaper();
  bindVirtualGoods();
  loadCourseSubjects();
  await refreshStudentData();
  loadFlashcardSubjects();
  loadDueFlashcards();
  connectStudentSocket();
});

async function refreshStudentData() {
  try {
    studentState.data = await fetchJSON('/api/student/bootstrap');
    renderStudentStats();
    renderNextAction();
    renderUnreadSummary();
    renderNotifications();
    renderTasks();
    renderSummaryCTA();
    renderSummaries();
    // 更新最后刷新时间
    const updateTimeEl = document.getElementById('last-update-time');
    if (updateTimeEl) {
      const now = new Date();
      updateTimeEl.textContent = `最后更新: ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    }
    // 非核心面板延迟到 tab 首次激活时渲染（通过 activateTabs 的 onActivate 回调）
  } catch (error) {
    createToast('数据加载失败：' + error.message, 'error');
  }
}

function renderStudentStats() {
  const data = studentState.data;
  const completedCount = data.todaysTasks.filter(t => t.completedAt).length;
  const totalCount = data.todaysTasks.length;
  const hasSummary = data.summaries && data.summaries.some(s => {
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    return s.taskDate === todayStr;
  });
  const liveNow = data.liveSessions.find(s => s.status === 'live');

  const stats = [
    { label: '今日完成', value: completedCount + '/' + totalCount },
    { label: '今日总结', value: hasSummary ? '已提交' : '未提交' },
    { label: '直播状态', value: liveNow ? '直播中' : (data.liveSessions.length ? '待开始' : '暂无') }
  ];

  document.getElementById('student-stats').innerHTML = stats
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

function renderNextAction() {
  const data = studentState.data;
  const incomplete = data.todaysTasks.filter(t => !t.completedAt)
    .sort((a, b) => (a.priority || 2) - (b.priority || 2));
  const area = document.getElementById('next-action-area');
  if (!area) return;

  const hasSummary = data.summaries && data.summaries.some(s => {
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    return s.taskDate === todayStr;
  });
  const liveNow = data.liveSessions.find(s => s.status === 'live');

  let html = '';
  if (incomplete.length) {
    const next = incomplete[0];
    const title = escapeHtml(next.title);
    const time = escapeHtml(next.startTime) + ' - ' + escapeHtml(next.endTime);
    html += '<div class="metric-card" style="background:#eff6ff;border-color:#93c5fd;"><span class="muted">下一步</span><strong style="font-size:15px;">' + title + '</strong><span class="muted" style="font-size:12px;">' + time + ' · ' + escapeHtml(next.subject) + '</span><button class="button" data-action="start-focus" data-task-title="' + title + '" type="button" style="margin-top:8px;font-size:12px;padding:4px 14px;">开始专注</button></div>';
  } else if (!hasSummary) {
    html += '<div class="metric-card" style="background:#fef3c7;border-color:#fcd34d;cursor:pointer;" data-action="go-summary"><span class="muted">任务已全部完成</span><strong style="color:#92400e;">别忘了提交今日总结</strong><span class="muted" style="font-size:12px;">点击这里去写总结</span></div>';
  } else {
    html += '<div class="metric-card" style="background:#dcfce7;border-color:#86efac;"><span class="muted">今日任务已全部完成</span><strong style="color:#166534;">做得不错，去刷题巩固吧</strong></div>';
  }
  if (liveNow) {
    html = '<div class="metric-card" style="background:#fef2f2;border-color:#fca5a5;"><span class="muted">直播进行中</span><strong style="color:#b91c1c;font-size:15px;">' + escapeHtml(liveNow.title) + '</strong><span class="muted" style="font-size:12px;">正在直播，点击进入</span></div>' + html;
  }
  area.innerHTML = html;
}

function renderUnreadSummary() {
  const data = studentState.data;
  const unread = data.notifications.filter(n => !n.readAt);
  const area = document.getElementById('unread-summary-area');
  if (!area) return;
  if (!unread.length) { area.innerHTML = ''; return; }
  const latest = unread[0];
  area.innerHTML = '<div class="metric-card" style="background:#fefce8;border-color:#fde047;"><span class="muted">未读提醒 (' + unread.length + ')</span><strong style="font-size:14px;color:#92400e;">' + escapeHtml(latest.title) + '</strong><button class="ghost-button" data-action="scroll-notifications" type="button" style="font-size:11px;margin-top:4px;">查看全部</button></div>';
}

function renderNotifications() {
  const root = document.getElementById('notification-list');
  const unreadCount = studentState.data.notifications.filter((n) => !n.readAt).length;
  const badge = document.getElementById('unread-badge');
  if (badge) badge.textContent = unreadCount > 0 ? unreadCount + ' 未读' : '';
  if (!studentState.data.notifications.length) {
    root.innerHTML = buildEmptyState('暂时没有提醒', '老师发送的早 7 点任务提醒和任务节点提醒都会显示在这里。');
    return;
  }

  // 按类型分类
  const filter = studentState.notificationFilter || 'all';
  let filtered = studentState.data.notifications;
  if (filter === 'task') {
    filtered = filtered.filter((n) => n.type === 'daily_dispatch' || n.type === 'due_reminder' || n.type === 'task_reminder');
  } else if (filter === 'system') {
    filtered = filtered.filter((n) => n.type === 'system' || n.type === 'order');
  }

  const tabsHtml = `
    <div style="display:flex;gap:6px;margin-bottom:10px;">
      <button class="ghost-button ${filter === 'all' ? 'active' : ''}" data-action="filter-notif" data-filter="all" type="button" style="font-size:11px;padding:3px 10px;">全部</button>
      <button class="ghost-button ${filter === 'task' ? 'active' : ''}" data-action="filter-notif" data-filter="task" type="button" style="font-size:11px;padding:3px 10px;">任务提醒</button>
      <button class="ghost-button ${filter === 'system' ? 'active' : ''}" data-action="filter-notif" data-filter="system" type="button" style="font-size:11px;padding:3px 10px;">系统通知</button>
    </div>
  `;

  root.innerHTML = tabsHtml + (filtered.length
    ? filtered
        .map(
          (item) => `
            <article class="notification-card">
              <div class="card-head">
                <div>
                  <h3>${escapeHtml(item.title)}</h3>
                </div>
                <div class="badge">${escapeHtml(formatDateTime(item.createdAt))}</div>
              </div>
              <div class="inline-actions">
                ${item.readAt ? `<span class="badge">已读</span>` : `<button class="ghost-button" data-action="read-notification" data-id="${item.id}" type="button" style="font-size:12px;padding:3px 10px;">已读</button>`}
              </div>
            </article>
          `
        )
        .join('')
    : '<p class="muted">该分类下暂无通知。</p>');
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
  const root = document.getElementById('student-tasks-list');
  if (!studentState.data.todaysTasks.length) {
    root.innerHTML = buildEmptyState('今天没有任务', '如果老师今天没有排课，这里会保持空白。');
    return;
  }

  const sorted = [...studentState.data.todaysTasks].sort((a, b) => (a.priority || 2) - (b.priority || 2));

  root.innerHTML = sorted.map((task) => {
    const title = escapeHtml(task.title);
    const isAllDay = task.startTime === '00:00' && task.endTime === '23:59';
    const timeLabel = isAllDay ? '' : (escapeHtml(task.startTime) + ' - ' + escapeHtml(task.endTime) + ' · ');
    const subject = escapeHtml(task.subject);
    const statusIcon = task.completedAt ? '<span style="color:#16a34a;font-size:18px;">&#10003;</span>' : '<span style="color:#d1d5db;font-size:18px;">&#9675;</span>';
    const actionBtn = task.completedAt
      ? '<span class="badge badge-success" style="font-size:11px;">已完成</span>'
      : '<button class="button" data-action="complete-task" data-task-title="' + title + '" type="button" style="font-size:12px;padding:4px 14px;">完成</button>';

    const extra = parseTaskExtra(task.description);
    let detailHtml = '';
    if (extra) {
      if (extra.tasks && extra.tasks.length) {
        detailHtml += '<div style="margin-top:4px;">' + extra.tasks.map((t) => '<div style="font-size:12px;color:#64748b;">' + escapeHtml(t) + '</div>').join('') + '</div>';
      }
      if (extra.link) {
        var urlMatch = extra.link.match(/https?:\/\/[^\s<>"']+/);
        var url = urlMatch ? urlMatch[0] : '';
        if (url) {
          detailHtml += '<div style="font-size:12px;margin-top:2px;">🔗 <a href="' + escapeHtml(url) + '" target="_blank" style="color:#2563eb;text-decoration:none;">打开听课链接</a></div>';
        } else {
          detailHtml += '<div style="font-size:12px;color:#64748b;margin-top:2px;">🔗 ' + escapeHtml(extra.link) + '</div>';
        }
      }
      if (extra.time) {
        detailHtml += '<span style="display:inline-block;font-size:11px;background:#fef3c7;color:#92400e;padding:1px 6px;border-radius:4px;margin-top:2px;">⏱ ' + escapeHtml(extra.time) + '</span>';
      }
      if (extra.notes) {
        detailHtml += '<div style="font-size:12px;color:#dc2626;margin-top:2px;">💡 ' + escapeHtml(extra.notes) + '</div>';
      }
    }

    return '<article class="task-card"><div class="card-head"><div style="display:flex;align-items:center;gap:10px;">' + statusIcon + '<div><h3 style="margin:0;">' + title + '</h3><p class="muted" style="margin:2px 0 0;">' + timeLabel + subject + '</p>' + detailHtml + '</div></div></div><div class="inline-actions">' + actionBtn + '</div></article>';
  }).join('');
}

function renderSummaryCTA() {
  const area = document.getElementById('summary-cta-area');
  if (!area) return;
  const data = studentState.data;
  const completedCount = data.todaysTasks.filter(t => t.completedAt).length;
  const totalCount = data.todaysTasks.length;
  const hasSummary = data.summaries && data.summaries.some(s => {
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    return s.taskDate === todayStr;
  });

  if (hasSummary) {
    area.innerHTML = '<div class="metric-card" style="background:#dcfce7;border-color:#86efac;"><span class="muted">今日总结</span><strong style="color:#166534;">已提交</strong></div>';
  } else if (completedCount > 0) {
    area.innerHTML = '<button class="button" data-action="go-summary" type="button" style="width:100%;font-size:14px;padding:10px;">提交今日学习总结</button>';
  }
}

function renderSummaries() {
  const root = document.getElementById('student-summaries-list');
  if (!studentState.data.summaries.length) {
    root.innerHTML = buildEmptyState('你还没有提交总结', '完成当天任务后，在上方上传图文或附件复盘。');
    return;
  }

  root.innerHTML = studentState.data.summaries
    .map(
      (summary) => {
        const preview = (summary.content || '暂无文字总结').substring(0, 50);
        const hasMore = (summary.content || '').length > 50;
        return `
        <article class="summary-card">
          <div class="card-head">
            <div>
              <h3>${escapeHtml(summary.taskDate)}</h3>
              <p class="muted">${escapeHtml(preview)}${hasMore ? '...' : ''}</p>
            </div>
            <div class="badge">${escapeHtml(formatDateTime(summary.updatedAt))}</div>
          </div>
          ${summary.teacherComment ? `<div style="margin-top:8px;background:#eff6ff;padding:10px 14px;border-radius:10px;border-left:3px solid #3b82f6;">
            <div style="font-size:12px;color:#3b82f6;font-weight:600;">老师点评</div>
            <div style="font-size:13px;color:#1e293b;">${escapeHtml(summary.teacherComment)}</div>
            ${summary.commentedAt ? `<div style="font-size:11px;color:#94a3b8;margin-top:4px;">${escapeHtml(formatDateTime(summary.commentedAt))}</div>` : ''}
          </div>` : ''}
        </article>
      `;
      }
    )
    .join('');
}

function bindStudentForms() {
  document.getElementById('summary-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submitBtn = form.querySelector('button[type="submit"]');
    setButtonLoading(submitBtn, true);
    try {
      await fetchJSON('/api/summaries', {
        method: 'POST',
        body: new FormData(form)
      });
      createToast('总结已提交。', 'success');
      form.reset();
      const nowReset = new Date();
      document.getElementById('summary-date').value = `${nowReset.getFullYear()}-${String(nowReset.getMonth() + 1).padStart(2, '0')}-${String(nowReset.getDate()).padStart(2, '0')}`;
      await refreshStudentData();
    } catch (error) {
      createToast(error.message, 'error');
    } finally {
      setButtonLoading(submitBtn, false);
    }
  });

  // 题库筛选器
  ['qf-subject', 'qf-type', 'qf-tag'].forEach((id) => {
    document.getElementById(id).addEventListener('change', () => {
      studentState.questionFilter.subject = document.getElementById('qf-subject').value;
      studentState.questionFilter.questionType = document.getElementById('qf-type').value;
      studentState.questionFilter.tagId = document.getElementById('qf-tag').value;
      studentState.questionFilter.page = 1;
      loadFilteredQuestions();
    });
  });

  // 题库子Tab切换
  const questionPanel = document.getElementById('student-questions');
  if (questionPanel) {
    questionPanel.addEventListener('click', (event) => {
      const tabBtn = event.target.closest('.tab-button[data-target]');
      if (tabBtn) {
        const target = tabBtn.dataset.target;
        questionPanel.querySelectorAll('.tab-button[data-target]').forEach((b) => b.classList.remove('active'));
        tabBtn.classList.add('active');
        ['qtab-all', 'qtab-wrong', 'qtab-fav'].forEach((id) => {
          document.getElementById(id).classList.toggle('hidden', id !== target);
        });
        if (target === 'qtab-wrong') loadWrongQuestions();
        if (target === 'qtab-fav') loadFavoriteQuestions();
        return;
      }
    });
  }

  // 答题 + 收藏 + 分页 事件委托
  const qtabAll = document.getElementById('qtab-all');
  if (qtabAll) {
    qtabAll.addEventListener('submit', async (event) => {
      const form = event.target.closest('.answer-form');
      if (!form) return;
      event.preventDefault();
      const submitBtn = form.querySelector('button[type="submit"]');
      const formData = new FormData(form);
      const qId = form.dataset.questionId;
      const timeSpentMs = studentState.questionTimers[qId] ? Date.now() - studentState.questionTimers[qId] : 0;
      setButtonLoading(submitBtn, true);
      try {
        const result = await fetchJSON(`/api/questions/${qId}/answer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ selectedAnswer: formData.get('selectedAnswer'), timeSpentMs })
        });
        studentState.answerResults[qId] = {
          ...result.result,
          subject: form.closest('.question-card')?.querySelector('.badge-brand')?.textContent || '',
          timeSpentMs: timeSpentMs
        };
        createToast(result.result.isCorrect ? '回答正确。' : `回答错误，正确答案 ${result.result.correctAnswer}。`, result.result.isCorrect ? 'success' : 'error');
        loadFilteredQuestions();
      } catch (error) {
        createToast(error.message, 'error');
      } finally {
        setButtonLoading(submitBtn, false);
      }
    });
  }

  // 收藏 + 分页 事件委托（全题库面板）
  document.getElementById('student-questions').addEventListener('click', async (event) => {
    const favBtn = event.target.closest('[data-action="toggle-fav"]');
    if (favBtn) {
      try {
        const result = await fetchJSON(`/api/questions/${favBtn.dataset.id}/favorite`, { method: 'POST' });
        favBtn.innerHTML = result.favorited ? '&#9733;' : '&#9734;';
        createToast(result.favorited ? '已收藏。' : '已取消收藏。', 'success');
      } catch (error) {
        createToast(error.message, 'error');
      }
      return;
    }

    const pageBtn = event.target.closest('[data-action="page"]');
    if (pageBtn) {
      studentState.questionFilter.page = Number(pageBtn.dataset.page);
      loadFilteredQuestions();
    }

    const reportBtn = event.target.closest('[data-action="show-report"]');
    if (reportBtn) {
      renderPracticeReport();
    }

    const closeReportBtn = event.target.closest('[data-action="close-report"]');
    if (closeReportBtn) {
      document.getElementById('practice-report').classList.add('hidden');
    }
  });

  document.getElementById('student-products-list').addEventListener('submit', async (event) => {
    const form = event.target.closest('.order-form');
    if (!form) {
      return;
    }

    event.preventDefault();
    const formData = new FormData(form);
    try {
      await fetchJSON('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: form.dataset.productId,
          quantity: Number(formData.get('quantity')),
          shippingAddress: formData.get('shippingAddress')
        })
      });
      createToast('下单成功。', 'success');
      await refreshStudentData();
    } catch (error) {
      createToast(error.message, 'error');
    }
  });

  document.getElementById('notification-list').addEventListener('click', async (event) => {
    // 通知分类筛选
    const filterBtn = event.target.closest('[data-action="filter-notif"]');
    if (filterBtn) {
      studentState.notificationFilter = filterBtn.dataset.filter;
      renderNotifications();
      return;
    }

    const button = event.target.closest('button[data-action="read-notification"]');
    if (!button) {
      return;
    }

    try {
      await fetchJSON(`/api/notifications/${button.dataset.id}/read`, { method: 'POST' });
      await refreshStudentData();
    } catch (error) {
      createToast(error.message, 'error');
    }
  });

  // 全部已读
  document.getElementById('read-all-btn').addEventListener('click', async () => {
    try {
      await fetchJSON('/api/notifications/read-all', { method: 'POST' });
      createToast('已全部标记为已读。', 'success');
      await refreshStudentData();
    } catch (error) {
      createToast(error.message, 'error');
    }
  });

  // 修改密码
  document.getElementById('change-password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const newPwd = formData.get('newPassword') || '';
    if (newPwd.length < 6) { createToast('新密码至少6位', 'error'); return; }
    const btn = form.querySelector('button[type="submit"]');
    setButtonLoading(btn, true);
    try {
      await fetchJSON('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPassword: formData.get('oldPassword'), newPassword: newPwd })
      });
      createToast('密码已修改。', 'success');
      form.reset();
    } catch (error) {
      createToast(error.message, 'error');
    } finally {
      setButtonLoading(btn, false);
    }
  });

  // 订单确认收货
  document.getElementById('student-orders-list').addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-action="confirm-order"]');
    if (!btn) return;
    try {
      await fetchJSON(`/api/orders/${btn.dataset.id}/confirm`, { method: 'POST' });
      createToast('已确认收货。', 'success');
      await refreshStudentData();
    } catch (error) {
      createToast(error.message, 'error');
    }
  });

  // 直播预约
  document.getElementById('student-live-list').addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-action="reserve-live"]');
    if (!btn) return;
    try {
      await fetchJSON('/api/live-sessions/' + btn.dataset.id + '/reserve', { method: 'POST' });
      createToast('已预约直播，开始时会收到提醒。', 'success');
      btn.textContent = '已预约';
      btn.disabled = true;
    } catch (error) {
      createToast(error.message, 'error');
    }
  });
}

// ── 专注计时器 ──

function bindFocusTimer() {
  // 任务卡片上的"开始专注"按钮 + "完成任务"按钮
  document.getElementById('student-tasks-list').addEventListener('click', (event) => {
    const goSummaryBtn = event.target.closest('[data-action="go-summary"]');
    if (goSummaryBtn) {
      const summaryTab = document.querySelector('[data-target="student-summary"]');
      if (summaryTab) summaryTab.click();
      return;
    }

    const btn = event.target.closest('[data-action="start-focus"]');
    if (btn) {
      startFocusTimer(btn.dataset.taskTitle || '专注学习');
      return;
    }

    const completeBtn = event.target.closest('[data-action="complete-task"]');
    if (completeBtn) {
      showCelebration(completeBtn.dataset.taskTitle || '任务完成');
      completeBtn.disabled = true;
      completeBtn.textContent = '已完成';
      completeBtn.style.background = '#dcfce7';
      completeBtn.style.color = '#16a34a';
      completeBtn.style.borderColor = '#86efac';
    }
  });

  document.getElementById('focus-pause-btn').addEventListener('click', () => {
    const ft = studentState.focusTimer;
    if (ft.paused) {
      ft.paused = false;
      document.getElementById('focus-pause-btn').textContent = '暂停';
      ft.intervalId = setInterval(() => tickFocusTimer(), 1000);
    } else {
      ft.paused = true;
      document.getElementById('focus-pause-btn').textContent = '继续';
      clearInterval(ft.intervalId);
      ft.intervalId = null;
    }
  });

  document.getElementById('focus-stop-btn').addEventListener('click', () => {
    stopFocusTimer();
  });
}

function startFocusTimer(taskName) {
  const ft = studentState.focusTimer;
  if (ft.running) {
    createToast('已有专注计时器在运行。', 'error');
    return;
  }
  ft.running = true;
  ft.paused = false;
  ft.totalSeconds = 1500; // 25分钟
  ft.remainingSeconds = 1500;
  ft.taskName = taskName;
  ft.startTime = Date.now();

  document.getElementById('focus-task-name').textContent = taskName;
  document.getElementById('focus-overlay').classList.remove('hidden');
  updateFocusTimerDisplay();

  ft.intervalId = setInterval(() => tickFocusTimer(), 1000);

  // 检查早起鸟成就
  const hour = new Date().getHours();
  if (hour < 6) {
    fetchJSON('/api/achievements/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'early_bird', value: 1 })
    }).then((result) => {
      if (result.unlocked) {
        createToast(`成就解锁：${result.achievement.title} ${result.achievement.icon}`, 'success');
      }
    }).catch(() => {});
  }
}

function tickFocusTimer() {
  const ft = studentState.focusTimer;
  ft.remainingSeconds--;
  updateFocusTimerDisplay();

  if (ft.remainingSeconds <= 0) {
    clearInterval(ft.intervalId);
    ft.intervalId = null;
    ft.running = false;
    document.getElementById('focus-overlay').classList.add('hidden');
    createToast('专注时间结束，休息一下吧！', 'success');

    // 计算专注时长（分钟）
    const focusMinutes = Math.round((ft.totalSeconds - ft.remainingSeconds) / 60);

    // 尝试解锁专注成就
    fetchJSON('/api/achievements/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'focus_60', value: focusMinutes })
    }).then((result) => {
      if (result.unlocked) {
        createToast(`成就解锁：${result.achievement.title} ${result.achievement.icon}`, 'success');
      }
    }).catch(() => {});

    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('专注时间结束', { body: `${ft.taskName} - 已完成 ${focusMinutes} 分钟` });
    }
  }
}

function updateFocusTimerDisplay() {
  const ft = studentState.focusTimer;
  const minutes = Math.floor(ft.remainingSeconds / 60);
  const seconds = ft.remainingSeconds % 60;
  document.getElementById('focus-timer-display').textContent =
    `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

  // 更新进度环
  const circumference = 2 * Math.PI * 94;
  const progress = (ft.totalSeconds - ft.remainingSeconds) / ft.totalSeconds;
  const offset = circumference * (1 - progress);
  document.getElementById('focus-progress-ring').setAttribute('stroke-dashoffset', String(offset));
}

function stopFocusTimer() {
  const ft = studentState.focusTimer;
  const elapsedSeconds = ft.totalSeconds - ft.remainingSeconds;
  const focusMinutes = Math.round(elapsedSeconds / 60);

  clearInterval(ft.intervalId);
  ft.intervalId = null;
  ft.running = false;
  document.getElementById('focus-overlay').classList.add('hidden');

  if (elapsedSeconds > 60) {
    createToast(`专注结束，已学习 ${focusMinutes} 分钟。`, 'success');

    fetchJSON('/api/achievements/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'focus_60', value: focusMinutes })
    }).then((result) => {
      if (result.unlocked) {
        createToast(`成就解锁：${result.achievement.title} ${result.achievement.icon}`, 'success');
      }
    }).catch(() => {});
  } else {
    createToast('专注已取消。', 'error');
  }
}

// ── 完成庆祝动画 ──

function showCelebration(taskTitle) {
  const encouragements = ['太棒了，继续保持！', '今天又进步了一点！', '坚持就是胜利！', '你的努力终将会有回报！', '离目标又近了一步！'];
  const msg = encouragements[Math.floor(Math.random() * encouragements.length)];
  const overlay = document.createElement('div');
  overlay.className = 'celebration-overlay';
  overlay.innerHTML = `
    <div class="celebration-card">
      <div class="celebration-icon">&#127881;</div>
      <h2>任务完成</h2>
      <p style="font-size:15px;color:#374151;margin:4px 0;">${escapeHtml(taskTitle)}</p>
      <p style="font-size:14px;color:var(--brand);font-weight:600;margin-top:8px;">${escapeHtml(msg)}</p>
      <button class="button" style="margin-top:18px;" onclick="this.closest('.celebration-overlay').remove()">好的</button>
    </div>
  `;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  setTimeout(() => { if (overlay.parentNode) overlay.remove(); }, 5000);
}

function connectStudentSocket() {
  // Lightbox 委托
  if (!studentState._lightboxBound) {
    studentState._lightboxBound = true;
    document.addEventListener('click', (event) => {
      const target = event.target.closest('[data-action="lightbox"]');
      if (target) {
        const overlay = document.createElement('div');
        overlay.className = 'lightbox-overlay';
        overlay.innerHTML = `<img src="${escapeHtml(target.dataset.src || target.src)}" />`;
        overlay.addEventListener('click', () => overlay.remove());
        document.body.appendChild(overlay);
      }
    });
  }


  // BUG-014: 清理旧的重连定时器，防止泄漏
  if (studentState.reconnectTimer) {
    clearTimeout(studentState.reconnectTimer);
    studentState.reconnectTimer = null;
  }
  studentState.reconnectAttempts = (studentState.reconnectAttempts || 0) + 1;
  if (studentState.reconnectAttempts > 10) return;
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${protocol}://${location.host}?token=${encodeURIComponent(studentState.token)}`);
  if (studentState.socket) {
    studentState.socket.close();
  }
  studentState.socket = socket;

  socket.addEventListener('open', () => {
    studentState.reconnectAttempts = 0;
  });

  socket.addEventListener('message', async (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }

    if (message.type === 'notification') {
      studentState.data.notifications.unshift(message.payload);
      renderNotifications();
      createToast(message.payload.title, 'success');

      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(message.payload.title, {
          body: message.payload.body
        });
      }
    }
  });

  socket.addEventListener('close', () => {
    studentState.reconnectTimer = setTimeout(connectStudentSocket, 3000);
  });
}

function safeJsonParse(str, fallback) {
  try { return JSON.parse(str); } catch (_) { return fallback; }
}
