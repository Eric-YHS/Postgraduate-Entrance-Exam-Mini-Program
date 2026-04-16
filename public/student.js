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
  document.getElementById('student-name').textContent = `${authResult.user.displayName} 的研途日程`;
  const nowInit = new Date();
  document.getElementById('summary-date').value = `${nowInit.getFullYear()}-${String(nowInit.getMonth() + 1).padStart(2, '0')}-${String(nowInit.getDate()).padStart(2, '0')}`;
  activateTabs('.tab-button', '.panel', (target) => {
    // 延迟加载：非核心面板首次激活时才渲染
    if (!studentState.data) return;
    const lazyRenderers = {
      'student-courses': () => renderCourses(),
      'student-live': () => renderLiveSessions(),
      'student-forum': () => {},
      'student-questions': () => renderQuestions(),
      'student-store': () => renderStore(),
      'student-flashcards': () => { loadDueFlashcards(); },
      'student-stats-panel': () => loadDetailedStats(),
      'student-checkin': () => loadCheckinCalendar(),
      'student-achievements': () => loadAchievements(),
      'student-daily': () => {},
      'student-mock-exams': () => {},
      'student-ai': () => {}
    };
    if (lazyRenderers[target]) lazyRenderers[target]();
  });
  document.getElementById('logout-button').addEventListener('click', logout);
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
  bindMockExams();
  bindQuestionNotes();
  bindAutoPaper();
  bindAIAssistant();
  bindAISection();
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
    renderNotifications();
    renderTasks();
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
  const stats = [
    { label: '今日任务', value: data.todaysTasks.length },
    { label: '课程数量', value: data.courses.length },
    { label: '直播场次', value: data.liveSessions.length },
    { label: '题库数量', value: data.questions.length },
    { label: '我的订单', value: data.orders.length }
  ];

  document.getElementById('student-stats').innerHTML = stats
    .map(
      (item) => `
        <div class="metric-card">
          <span class="muted">${escapeHtml(item.label)}</span>
          <strong>${escapeHtml(item.value)}</strong>
        </div>
      `
    )
    .join('');
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
                  <div class="badge badge-brand">${escapeHtml(item.type)}</div>
                  <h3>${escapeHtml(item.title)}</h3>
                  <p class="muted">${escapeHtml(item.body)}</p>
                </div>
                <div class="badge">${escapeHtml(formatDateTime(item.createdAt))}</div>
              </div>
              <div class="inline-actions">
                ${item.readAt ? `<span class="badge">已读</span>` : `<button class="ghost-button" data-action="read-notification" data-id="${item.id}" type="button">标记已读</button>`}
              </div>
            </article>
          `
        )
        .join('')
    : '<p class="muted">该分类下暂无通知。</p>');
}

function renderTasks() {
  const root = document.getElementById('student-tasks-list');
  if (!studentState.data.todaysTasks.length) {
    root.innerHTML = buildEmptyState('今天没有任务', '如果老师今天没有排课，这里会保持空白。');
    return;
  }

  const sorted = [...studentState.data.todaysTasks].sort((a, b) => (a.priority || 2) - (b.priority || 2));

  root.innerHTML = sorted.map((task) => {
    const priorityLabel = task.priority === 1 ? '<span class="badge badge-danger" style="font-size:10px;">高优</span>' : task.priority === 3 ? '<span class="badge" style="font-size:10px;color:var(--subtle);">低优</span>' : '';
    const subject = escapeHtml(task.subject);
    const title = escapeHtml(task.title);
    const desc = escapeHtml(task.description || '暂无任务说明');
    const time = escapeHtml(task.startTime) + ' - ' + escapeHtml(task.endTime);
    const weekLabel = escapeHtml(task.weekdaysLabel);
    const teacher = escapeHtml(task.teacherName || '老师');
    return '<article class="task-card"><div class="card-head"><div><div class="badge badge-brand">' + subject + '</div>' + priorityLabel + '<h3>' + title + '</h3><p class="muted">' + desc + '</p></div><div class="badge">' + time + '</div></div><div class="inline-actions"><span class="badge">' + weekLabel + '</span><span class="badge">' + teacher + '</span><button class="ghost-button" data-action="start-focus" data-task-title="' + title + '" type="button" style="font-size:12px;padding:4px 10px;">开始专注</button><button class="button" data-action="complete-task" data-task-title="' + title + '" type="button" style="font-size:12px;padding:4px 10px;">完成任务</button></div></article>';
  }).join('');
}

function renderSummaries() {
  const root = document.getElementById('student-summaries-list');
  if (!studentState.data.summaries.length) {
    root.innerHTML = buildEmptyState('你还没有提交总结', '完成当天任务后，在上方上传图文或附件复盘。');
    return;
  }

  root.innerHTML = studentState.data.summaries
    .map(
      (summary) => `
        <article class="summary-card">
          <div class="card-head">
            <div>
              <h3>${escapeHtml(summary.taskDate)}</h3>
              <p class="muted">${escapeHtml(summary.content || '暂无文字总结')}</p>
            </div>
            <div class="badge">${escapeHtml(formatDateTime(summary.updatedAt))}</div>
          </div>
          ${summary.imagePaths.length ? `<div class="asset-list">${summary.imagePaths.map((item) => `<a class="badge" href="${escapeHtml(item)}" target="_blank">查看图片</a>`).join('')}</div>` : ''}
          ${summary.attachmentPaths.length ? `<div class="asset-list">${summary.attachmentPaths.map((item) => `<a class="badge" href="${escapeHtml(item)}" target="_blank">打开附件</a>`).join('')}</div>` : ''}
        </article>
      `
    )
    .join('');
}

function renderCourses() {
  loadStudentCloud(null);
}

async function loadStudentCloud(parentId, subject) {
  studentState.cloudState.currentParentId = parentId;
  try {
    const params = new URLSearchParams();
    if (parentId) params.set('parentId', parentId);
    if (subject) params.set('subject', subject);
    const qs = params.toString();
    const url = '/api/folders' + (qs ? '?' + qs : '');
    const result = await fetchJSON(url);
    studentState.cloudState.path = result.path || [];
    studentState.cloudState.folders = result.folders || [];
    studentState.cloudState.items = result.items || [];
    renderStudentCloud();
  } catch (error) {
    // 静默失败
  }
}

function renderStudentCloud() {
  const cs = studentState.cloudState;
  const bc = document.getElementById('student-folder-breadcrumb');
  bc.innerHTML = '<a data-folder-id="">根目录</a>' +
    cs.path.map((p) => `<span> / </span><a data-folder-id="${p.id}">${escapeHtml(p.name)}</a>`).join('');

  const fg = document.getElementById('student-cloud-folder-grid');
  fg.innerHTML = cs.folders.length
    ? cs.folders.map((f) => `
      <div class="paper-card cloud-item" data-action="open-folder" data-folder-id="${f.id}">
        <div class="cloud-item-icon">&#128193;</div>
        <strong>${escapeHtml(f.name)}</strong>
      </div>
    `).join('')
    : '';

  const ig = document.getElementById('student-cloud-items-grid');
  ig.innerHTML = cs.items.length
    ? cs.items.map((item) => {
      const icon = item.itemType === 'video' ? '&#127909;' : item.itemType === 'audio' ? '&#127925;' : '&#128196;';
      const src = item.filePath || item.fileUrl;
      return `
        <div class="paper-card cloud-item">
          <div class="cloud-item-icon">${icon}</div>
          <strong>${escapeHtml(item.title)}</strong>
          ${item.subject ? `<span class="badge badge-brand">${escapeHtml(item.subject)}</span>` : ''}
          ${item.itemType === 'video' && src ? `<button class="ghost-button" data-action="play-video" data-item-id="${item.id}" data-src="${escapeHtml(src)}" data-title="${escapeHtml(item.title)}" type="button" style="font-size:12px;padding:4px 10px;">播放</button>` : ''}
          ${src && item.itemType !== 'video' ? `<a class="ghost-button" href="${escapeHtml(src)}" target="_blank" style="font-size:12px;padding:4px 10px;">查看</a>` : ''}
        </div>
      `;
    }).join('')
    : (!cs.folders.length ? '<p class="muted">当前文件夹为空。</p>' : '');

  // 视频播放区域
  let playerRoot = document.getElementById('video-player-area');
  if (!playerRoot) {
    playerRoot = document.createElement('div');
    playerRoot.id = 'video-player-area';
    playerRoot.style.cssText = 'margin-top:18px;';
    const igEl = document.getElementById('student-cloud-items-grid');
    igEl.parentNode.insertBefore(playerRoot, igEl.nextSibling);
  }
  playerRoot.innerHTML = '';
}

function renderLiveSessions() {
  const root = document.getElementById('student-live-list');
  root.innerHTML = studentState.data.liveSessions.length
    ? studentState.data.liveSessions
        .map(
          (session) => `
            <article class="paper-card">
              <div class="card-head">
                <div>
                  <div class="badge badge-brand">${escapeHtml(session.subject)}</div>
                  <h3>${escapeHtml(session.title)}</h3>
                  <p class="muted">${escapeHtml(session.description || '暂无直播说明')}</p>
                </div>
                <div>
                  <div class="badge">${session.status === 'live' ? '直播中' : session.status === 'ended' ? '已结束' : '待开始'}</div>
                  ${session.viewerCount > 0 ? `<div class="badge" style="margin-top:4px;">&#128065; ${session.viewerCount} 人观看</div>` : ''}
                </div>
              </div>
              <div class="inline-actions">
                ${session.status === 'ended' ? `<a class="ghost-button" href="/live/${session.id}" target="_blank" style="text-decoration: none;font-size:12px;padding:6px 14px;">查看回放</a>` : `<a class="button" href="/live/${session.id}" target="_blank" style="text-decoration: none;">进入直播间</a>`}
                ${session.status === 'pending' ? `<button class="ghost-button" data-action="reserve-live" data-id="${session.id}" type="button" style="font-size:12px;padding:4px 12px;">预约直播</button>` : ''}
              </div>
            </article>
          `
        )
        .join('')
    : buildEmptyState('还没有直播', '老师创建直播后，这里会出现进入入口。');
}

function renderQuestions() {
  loadQuestionFilters();
  loadFilteredQuestions();
}

async function loadQuestionFilters() {
  try {
    const meta = await fetchJSON('/api/questions/meta');
    const subjectSel = document.getElementById('qf-subject');
    const typeSel = document.getElementById('qf-type');
    const tagSel = document.getElementById('qf-tag');
    subjectSel.innerHTML = '<option value="">全部科目</option>' + meta.subjects.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    typeSel.innerHTML = '<option value="">全部题型</option>' + meta.types.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
    tagSel.innerHTML = '<option value="">全部标签</option>' + meta.tags.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
  } catch (_) {}
}

async function loadFilteredQuestions() {
  const f = studentState.questionFilter;
  const params = new URLSearchParams();
  if (f.subject) params.set('subject', f.subject);
  if (f.questionType) params.set('questionType', f.questionType);
  if (f.tagId) params.set('tagId', f.tagId);
  if (f.mode && f.mode !== 'sequential') params.set('mode', f.mode);
  params.set('page', f.page);
  params.set('limit', '10');
  try {
    const result = await fetchJSON('/api/questions?' + params.toString());
    renderQuestionList(result.questions, result.totalCount, result.page, result.limit, 'qtab-all');
    renderAnswerCard(result.questions, result.totalCount, result.page, result.limit);
  } catch (error) {
    createToast(error.message, 'error');
  }
}

async function loadWrongQuestions() {
  const subject = studentState.questionFilter.subject;
  const url = '/api/practice/wrong' + (subject ? '?subject=' + encodeURIComponent(subject) : '');
  try {
    const result = await fetchJSON(url);
    const root = document.getElementById('qtab-wrong');
    if (!result.questions.length) {
      root.innerHTML = buildEmptyState('没有错题', '太棒了，继续保持！');
      return;
    }
    root.innerHTML = result.questions.map((q) => renderQuestionCard(q, true)).join('');
  } catch (error) {
    createToast(error.message, 'error');
  }
}

async function loadFavoriteQuestions() {
  const subject = studentState.questionFilter.subject;
  const url = '/api/questions/favorites' + (subject ? '?subject=' + encodeURIComponent(subject) : '');
  try {
    const result = await fetchJSON(url);
    const root = document.getElementById('qtab-fav');
    if (!result.questions.length) {
      root.innerHTML = buildEmptyState('没有收藏题目', '做题时点击星标即可收藏。');
      return;
    }
    root.innerHTML = result.questions.map((q) => renderQuestionCard(q, false)).join('');
  } catch (error) {
    createToast(error.message, 'error');
  }
}

function renderQuestionCard(question, showWrong) {
  const feedback = studentState.answerResults[question.id];
  if (!studentState.questionTimers[question.id] && !feedback) {
    studentState.questionTimers[question.id] = Date.now();
  }
  return `
    <article class="question-card">
      <div class="card-head">
        <div>
          <div class="badge badge-brand">${escapeHtml(question.subject)}</div>
          <h3>${escapeHtml(question.title)}</h3>
          <p>${escapeHtml(question.stem)}</p>
        </div>
        <div style="display:flex;gap:6px;">
          ${showWrong && question.selectedAnswer ? `<div class="badge badge-danger">你的答案 ${escapeHtml(question.selectedAnswer)}</div>` : ''}
          ${question.latestRecord ? `<div class="badge">${question.latestRecord.isCorrect ? '上次答对' : '上次答错'}</div>` : ''}
          <button class="ghost-button" data-action="toggle-fav" data-id="${question.id}" type="button" style="font-size:12px;padding:4px 8px;">${question.favorited ? '&#9733;' : '&#9734;'}</button>
        </div>
      </div>
      ${!showWrong ? `
      <form class="form-grid answer-form" data-question-id="${question.id}">
        <div class="field full-span">
          <div class="reply-list">
            ${question.options.map((opt) => `
              <label class="checkbox-chip">
                <input type="radio" name="selectedAnswer" value="${escapeHtml(opt.key)}" />
                <span>${escapeHtml(opt.key)}. ${escapeHtml(opt.text)}</span>
              </label>
            `).join('')}
          </div>
        </div>
        <div class="field full-span">
          <button class="button" type="submit">提交答案</button>
        </div>
      </form>
      ` : ''}
      ${feedback ? `
        <div class="reply-item" style="margin-top: 12px;">
          <strong>${feedback.isCorrect ? '回答正确' : `回答错误，正确答案 ${feedback.correctAnswer}`}</strong>
          <p>${escapeHtml(feedback.analysisText || '暂无文字解析')}</p>
          ${feedback.analysisVideoPath || feedback.analysisVideoUrl ? `<video class="video-frame" controls src="${escapeHtml(feedback.analysisVideoPath || feedback.analysisVideoUrl)}"></video>` : ''}
        </div>
      ` : ''}
    </article>
  `;
}

function renderQuestionList(questions, totalCount, page, limit, containerId) {
  const root = document.getElementById(containerId);
  if (!questions.length) {
    root.innerHTML = buildEmptyState('题库还是空的', '老师录题后，这里就能开始刷题。');
    document.getElementById('question-pagination').innerHTML = '';
    return;
  }
  root.innerHTML = questions.map((q) => renderQuestionCard(q, false)).join('');
  const totalPages = Math.ceil(totalCount / limit);
  const pagination = document.getElementById('question-pagination');
  if (totalPages <= 1) { pagination.innerHTML = ''; return; }
  let html = '';
  if (page > 1) html += `<button class="ghost-button" data-action="page" data-page="${page - 1}" type="button">上一页</button>`;
  html += `<span class="muted" style="padding:6px 12px;">${page} / ${totalPages}</span>`;
  if (page < totalPages) html += `<button class="ghost-button" data-action="page" data-page="${page + 1}" type="button">下一页</button>`;
  pagination.innerHTML = html;
}

function renderAnswerCard(questions, totalCount, page, limit) {
  const sidebar = document.getElementById('answer-card-sidebar');
  if (!questions.length || totalCount <= 0) {
    sidebar.classList.add('hidden');
    sidebar.innerHTML = '';
    return;
  }

  sidebar.classList.remove('hidden');
  const startIdx = (page - 1) * limit;
  const totalPages = Math.ceil(totalCount / limit);

  let cardsHtml = '';
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const num = startIdx + i + 1;
    const feedback = studentState.answerResults[q.id];
    let cardClass = 'answer-card-item';
    let statusIcon = '';
    if (feedback) {
      cardClass += feedback.isCorrect ? ' answer-correct' : ' answer-wrong';
      statusIcon = feedback.isCorrect ? '&#10003;' : '&#10007;';
    } else {
      cardClass += ' answer-unanswered';
    }
    cardsHtml += `<div class="${cardClass}" data-question-idx="${i}" title="${feedback ? (feedback.isCorrect ? '正确' : '错误') : '未答'}">${num}${statusIcon}</div>`;
  }

  sidebar.innerHTML = `
    <div class="paper-card" style="padding:12px;">
      <h4 style="margin:0 0 8px;font-size:13px;">答题卡</h4>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px;">
        ${cardsHtml}
      </div>
      <div style="margin-top:10px;font-size:11px;color:var(--subtle);">
        <span style="color:#22c55e;">&#10003; 正确</span>
        <span style="margin-left:6px;color:#ef4444;">&#10007; 错误</span>
      </div>
      <div style="margin-top:8px;font-size:11px;color:var(--subtle);">
        第 ${page}/${totalPages} 页 · 共 ${totalCount} 题
      </div>
      ${Object.keys(studentState.answerResults).length > 0 ? `<button class="button" data-action="show-report" type="button" style="width:100%;margin-top:10px;font-size:12px;padding:6px;">查看报告</button>` : ''}
    </div>
  `;
}

function renderPracticeReport() {
  const results = studentState.answerResults;
  const ids = Object.keys(results);
  if (!ids.length) {
    createToast('还没有答题记录。', 'error');
    return;
  }

  let correct = 0;
  let wrong = 0;
  let totalTime = 0;
  const subjectMap = {};

  ids.forEach((id) => {
    const r = results[id];
    if (r.isCorrect) correct++;
    else wrong++;
    totalTime += r.timeSpentMs || 0;
    const subj = r.subject || '未分类';
    if (!subjectMap[subj]) subjectMap[subj] = { correct: 0, wrong: 0 };
    if (r.isCorrect) subjectMap[subj].correct++;
    else subjectMap[subj].wrong++;
  });

  const total = correct + wrong;
  const accuracy = total > 0 ? Math.round((correct / total) * 100) : 0;
  const minutes = Math.round(totalTime / 60000);

  const subjectRows = Object.entries(subjectMap).map(([subj, data]) => {
    const totalSubj = data.correct + data.wrong;
    const accSubj = Math.round((data.correct / totalSubj) * 100);
    return `<div style="display:flex;justify-content:space-between;font-size:12px;padding:4px 0;border-bottom:1px solid #f1f5f9;">
      <span>${escapeHtml(subj)}</span>
      <span>${data.correct}/${totalSubj} (${accSubj}%)</span>
    </div>`;
  }).join('');

  const reportRoot = document.getElementById('practice-report');
  reportRoot.classList.remove('hidden');
  reportRoot.innerHTML = `
    <div class="paper-card" style="padding:20px;">
      <h3 style="margin:0 0 14px;">做题报告</h3>
      <div class="stat-grid">
        <div class="metric-card"><span class="muted">总题数</span><strong>${total}</strong></div>
        <div class="metric-card"><span class="muted">正确</span><strong style="color:#22c55e;">${correct}</strong></div>
        <div class="metric-card"><span class="muted">错误</span><strong style="color:#ef4444;">${wrong}</strong></div>
        <div class="metric-card"><span class="muted">正确率</span><strong>${accuracy}%</strong></div>
        <div class="metric-card"><span class="muted">用时</span><strong>${minutes > 0 ? minutes + ' 分钟' : '< 1 分钟'}</strong></div>
      </div>
      ${subjectRows ? `<h4 style="margin:14px 0 8px;font-size:14px;">科目分布</h4>${subjectRows}` : ''}
      <div style="margin-top:14px;">
        <button class="ghost-button" data-action="close-report" type="button">关闭报告</button>
      </div>
    </div>
  `;
  reportRoot.scrollIntoView({ behavior: 'smooth' });
}

function renderStore() {
  const productsRoot = document.getElementById('student-products-list');
  const ordersRoot = document.getElementById('student-orders-list');

  productsRoot.innerHTML = studentState.data.products.length
    ? studentState.data.products
        .map(
          (product) => `
            <article class="store-card">
              <div class="card-head">
                <div>
                  <h3>${escapeHtml(product.title)}</h3>
                  <p class="muted">${escapeHtml(product.description || '暂无商品说明')}</p>
                  ${product.category ? `<span class="badge" style="margin-top:4px;">${escapeHtml(product.category)}</span>` : ''}
                </div>
                <div>
                  <div class="badge badge-brand">${escapeHtml(formatMoney(product.price))}</div>
                  <div class="badge">库存 ${escapeHtml(product.stock)}</div>
                </div>
              </div>
              ${product.imagePath ? `<img class="image-preview" src="${escapeHtml(product.imagePath)}" alt="${escapeHtml(product.title)}" />` : ''}
              <div class="inline-actions" style="margin-top:14px;">
                <button class="ghost-button" data-action="add-to-cart" data-id="${product.id}" type="button" style="font-size:12px;padding:6px 14px;">加入购物车</button>
              </div>
            </article>
          `
        )
        .join('')
    : buildEmptyState('暂无资料商品', '老师上架后可直接购买。');

  ordersRoot.innerHTML = studentState.data.orders.length
    ? studentState.data.orders
        .map(
          (order) => `
            <article class="order-card">
              <div class="card-head">
                <div>
                  <h3>${escapeHtml(order.productTitle)}</h3>
                  <p class="muted">数量 ${escapeHtml(order.quantity)} · ${escapeHtml(order.shippingAddress)}</p>
                </div>
                <div>
                  <div class="badge badge-brand">${escapeHtml(formatMoney(order.totalAmount))}</div>
                  <div class="badge">${escapeHtml(order.status)}</div>
                </div>
              </div>
              <div style="margin-top:8px;display:flex;gap:8px;">
                ${order.status === 'delivered' ? `<button class="button" data-action="confirm-order" data-id="${order.id}" type="button" style="font-size:12px;padding:6px 14px;">确认收货</button>` : ''}
                ${order.status === 'confirmed' && order.productId ? `<button class="ghost-button" data-action="review-product" data-product-id="${order.productId}" data-title="${escapeHtml(order.productTitle)}" type="button" style="font-size:12px;padding:6px 14px;">评价商品</button>` : ''}
              </div>
            </article>
          `
        )
        .join('')
    : buildEmptyState('还没有订单', '在上方加入购物车下单。');
  loadCart();
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

function bindStudentCloud() {
  document.getElementById('student-folder-breadcrumb').addEventListener('click', (event) => {
    const link = event.target.closest('a[data-folder-id]');
    if (link) {
      const id = link.dataset.folderId;
      loadStudentCloud(id ? Number(id) : null);
    }
  });

  document.getElementById('student-cloud-folder-grid').addEventListener('click', (event) => {
    const folder = event.target.closest('[data-action="open-folder"]');
    if (folder) {
      loadStudentCloud(Number(folder.dataset.folderId));
    }
  });

  // 视频播放事件委托
  document.getElementById('student-cloud-items-grid').addEventListener('click', async (event) => {
    const playBtn = event.target.closest('[data-action="play-video"]');
    if (!playBtn) return;
    const itemId = playBtn.dataset.itemId;
    const src = playBtn.dataset.src;
    const title = playBtn.dataset.title;

    // 加载播放进度
    let savedPosition = 0;
    try {
      const progress = await fetchJSON('/api/courses/' + itemId + '/progress');
      savedPosition = progress.positionSeconds || 0;
    } catch (_) {}

    const playerRoot = document.getElementById('video-player-area');
    playerRoot.innerHTML = `
      <div class="paper-card" style="padding:16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <h3 style="margin:0;">${escapeHtml(title)}</h3>
          <button class="ghost-button" id="close-player-btn" type="button" style="font-size:12px;padding:4px 10px;">关闭播放器</button>
        </div>
        <video id="course-video" controls style="width:100%;border-radius:12px;background:#000;" src="${escapeHtml(src)}"></video>
        ${savedPosition > 0 ? `<p class="muted" style="margin-top:8px;font-size:12px;">上次观看到 ${Math.round(savedPosition)}秒，已自动续播。</p>` : ''}
        <div style="display:flex;gap:8px;margin-top:14px;">
          <button class="tab-button active" data-vtab="notes" type="button">笔记</button>
          <button class="tab-button" data-vtab="review" type="button">评价</button>
        </div>
        <div id="video-notes-section" style="margin-top:10px;">
          <div style="display:flex;gap:8px;">
            <input class="input" id="note-input" placeholder="写下笔记（可选：记录当前时间点）" style="flex:1;padding:8px 12px;font-size:13px;" />
            <button class="button" id="save-note-btn" type="button" style="font-size:12px;padding:8px 16px;">保存</button>
          </div>
          <div id="notes-list" style="margin-top:10px;"></div>
        </div>
        <div id="video-review-section" class="hidden" style="margin-top:10px;">
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;">
            <label style="font-size:13px;">评分：</label>
            <select id="review-rating" class="input" style="padding:6px 10px;font-size:13px;width:80px;">
              <option value="5">5星</option><option value="4">4星</option><option value="3">3星</option><option value="2">2星</option><option value="1">1星</option>
            </select>
            <button class="button" id="submit-review-btn" type="button" style="font-size:12px;padding:6px 14px;">提交评价</button>
          </div>
          <textarea class="textarea" id="review-content" placeholder="写下你的评价..." style="min-height:60px;"></textarea>
          <div id="review-list" style="margin-top:12px;"></div>
        </div>
      </div>
    `;

    const video = document.getElementById('course-video');
    if (savedPosition > 0) {
      video.currentTime = savedPosition;
    }

    // 定期保存进度（每15秒）
    const saveInterval = setInterval(async () => {
      if (video.paused || video.ended) return;
      try {
        await fetchJSON('/api/courses/' + itemId + '/progress', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            positionSeconds: video.currentTime,
            durationSeconds: video.duration || 0
          })
        });
      } catch (_) {}
    }, 15000);

    // 暂停时也保存
    video.addEventListener('pause', async () => {
      try {
        await fetchJSON('/api/courses/' + itemId + '/progress', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            positionSeconds: video.currentTime,
            durationSeconds: video.duration || 0
          })
        });
      } catch (_) {}
    });

    // 视频 Tab 切换
    playerRoot.querySelectorAll('[data-vtab]').forEach((tab) => {
      tab.addEventListener('click', () => {
        playerRoot.querySelectorAll('[data-vtab]').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('video-notes-section').classList.toggle('hidden', tab.dataset.vtab !== 'notes');
        document.getElementById('video-review-section').classList.toggle('hidden', tab.dataset.vtab !== 'review');
      });
    });

    // 加载笔记
    const loadNotes = async () => {
      const notes = await loadCourseNotes(itemId);
      const notesList = document.getElementById('notes-list');
      notesList.innerHTML = notes.length ? notes.map((n) => `
        <div class="reply-item" style="padding:8px 0;">
          <div>
            <span class="badge" style="font-size:10px;">${Math.round(n.timestamp_seconds)}秒</span>
            <span style="font-size:13px;margin-left:6px;">${escapeHtml(n.content)}</span>
          </div>
        </div>
      `).join('') : '<p class="muted" style="font-size:12px;">暂无笔记。</p>';
    };
    loadNotes();

    document.getElementById('save-note-btn').addEventListener('click', async () => {
      const content = document.getElementById('note-input').value.trim();
      if (!content) { createToast('请输入笔记内容。', 'error'); return; }
      const ts = video.currentTime || 0;
      await saveCourseNote(itemId, content, ts);
      document.getElementById('note-input').value = '';
      loadNotes();
    });

    // 加载评价
    const loadReviews = async () => {
      try {
        const result = await fetchJSON('/api/courses/' + itemId + '/reviews');
        const reviewsList = document.getElementById('review-list');
        if (result.myReview) {
          document.getElementById('review-rating').value = result.myReview.rating;
          document.getElementById('review-content').value = result.myReview.content || '';
        }
        reviewsList.innerHTML = result.reviews.length ? result.reviews.map((r) => `
          <div class="reply-item" style="padding:8px 0;">
            <div>
              <strong style="font-size:13px;">${escapeHtml(r.studentName || '同学')}</strong>
              <span class="badge" style="font-size:10px;margin-left:6px;">${'&#9733;'.repeat(r.rating)}</span>
              <p style="font-size:13px;margin-top:4px;">${escapeHtml(r.content || '未写评价')}</p>
            </div>
          </div>
        `).join('') : '<p class="muted" style="font-size:12px;">暂无评价。</p>';
      } catch (_) {}
    };
    loadReviews();

    document.getElementById('submit-review-btn').addEventListener('click', async () => {
      const rating = Number(document.getElementById('review-rating').value);
      const content = document.getElementById('review-content').value.trim();
      try {
        await fetchJSON('/api/courses/' + itemId + '/reviews', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rating, content })
        });
        createToast('评价已提交。', 'success');
        loadReviews();
      } catch (error) {
        createToast(error.message, 'error');
      }
    });

    document.getElementById('close-player-btn').addEventListener('click', () => {
      clearInterval(saveInterval);
      playerRoot.innerHTML = '';
    });

    video.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

function bindFlashcardControls() {
  document.getElementById('flashcard-subject-filter').addEventListener('change', (event) => {
    loadDueFlashcards(event.target.value);
  });

  document.getElementById('flashcard-mode-flip').addEventListener('click', () => {
    flashcardMode = 'flip';
    document.getElementById('flashcard-mode-flip').classList.add('active');
    document.getElementById('flashcard-mode-quiz').classList.remove('active');
    renderFlashcardSession();
  });

  document.getElementById('flashcard-mode-quiz').addEventListener('click', () => {
    flashcardMode = 'quiz';
    document.getElementById('flashcard-mode-quiz').classList.add('active');
    document.getElementById('flashcard-mode-flip').classList.remove('active');
    renderFlashcardSession();
  });
}

// ── 词汇记忆 ──

async function loadDueFlashcards(subject) {
  try {
    const url = '/api/flashcards/due' + (subject ? '?subject=' + encodeURIComponent(subject) : '');
    const result = await fetchJSON(url);
    studentState.flashcardState.dueCards = result.flashcards;
    studentState.flashcardState.currentIndex = 0;
    studentState.flashcardState.isFlipped = false;
    studentState.flashcardState.stats = { total: 0, again: 0, hard: 0, good: 0, easy: 0 };
    renderFlashcardSession();
  } catch (error) {
    // 静默
  }
}

async function loadFlashcardSubjects() {
  try {
    const result = await fetchJSON('/api/flashcards');
    const subjects = [...new Set(result.flashcards.map((c) => c.subject).filter(Boolean))];
    const sel = document.getElementById('flashcard-subject-filter');
    sel.innerHTML = '<option value="">全部科目</option>' + subjects.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
  } catch (_) {}
}

function renderFlashcardSession() {
  const fs = studentState.flashcardState;
  const statsRoot = document.getElementById('flashcard-stats');
  const cardRoot = document.getElementById('flashcard-container');

  if (!fs.dueCards.length) {
    statsRoot.innerHTML = '';
    cardRoot.innerHTML = buildEmptyState('今天没有需要复习的卡片', '教师创建词汇卡片后，这里会显示待复习内容。');
    return;
  }

  if (fs.currentIndex >= fs.dueCards.length) {
    statsRoot.innerHTML = '';
    cardRoot.innerHTML = `
      <div class="paper-card" style="padding:30px;text-align:center;">
        <h3>复习完成！</h3>
        <p>本次复习 ${fs.stats.total} 张卡片。</p>
        <div class="inline-actions" style="justify-content:center;margin-top:12px;">
          <span class="badge badge-danger">忘记 ${fs.stats.again}</span>
          <span class="badge rating-hard">困难 ${fs.stats.hard}</span>
          <span class="badge rating-good">良好 ${fs.stats.good}</span>
          <span class="badge rating-easy">简单 ${fs.stats.easy}</span>
        </div>
        <button class="button" style="margin-top:16px;" onclick="loadDueFlashcards()">再复习一轮</button>
      </div>
    `;
    return;
  }

  const card = fs.dueCards[fs.currentIndex];
  statsRoot.innerHTML = `
    <div class="metric-card" style="padding:14px;">
      <span class="muted">进度</span>
      <strong>${fs.currentIndex + 1} / ${fs.dueCards.length}</strong>
    </div>
    <div class="metric-card" style="padding:14px;">
      <span class="muted">已复习</span>
      <strong>${fs.stats.total}</strong>
    </div>
  `;

  if (flashcardMode === 'quiz') {
    renderQuizMode(card, cardRoot, fs);
  } else {
    renderFlipMode(card, cardRoot, fs);
  }
}

function renderFlipMode(card, cardRoot, fs) {
  const flippedClass = fs.isFlipped ? 'flashcard-flipped' : '';
  const frontImg = card.frontImagePath ? `<img src="${escapeHtml(card.frontImagePath)}" style="max-width:100%;max-height:200px;border-radius:12px;margin-top:10px;" />` : '';
  const backImg = card.backImagePath ? `<img src="${escapeHtml(card.backImagePath)}" style="max-width:100%;max-height:200px;border-radius:12px;margin-top:10px;" />` : '';
  const audioEl = card.audioPath ? `<audio controls src="${escapeHtml(card.audioPath)}" style="margin-top:10px;width:100%;"></audio>` : '';
  const exampleEl = card.exampleSentence ? `<div style="margin-top:12px;padding:10px 14px;background:#f8fafc;border-radius:10px;border-left:3px solid var(--brand);font-size:14px;color:#475569;line-height:1.5;"><strong style="color:var(--brand);font-size:12px;">例句</strong><br/>${escapeHtml(card.exampleSentence)}</div>` : '';

  cardRoot.innerHTML = `
    <div class="flashcard-wrapper">
      <div class="flashcard ${flippedClass}" id="flashcard-card">
        <div class="flashcard-front">
          <div class="badge badge-brand">${escapeHtml(card.subject || '通用')}</div>
          <h3 style="margin-top:12px;">${escapeHtml(card.title)}</h3>
          <p style="margin-top:10px;font-size:18px;">${escapeHtml(card.frontContent)}</p>
          ${frontImg}
          ${audioEl}
        </div>
        <div class="flashcard-back">
          <h3 style="margin-bottom:10px;">答案</h3>
          <p style="font-size:18px;">${escapeHtml(card.backContent)}</p>
          ${backImg}
          ${exampleEl}
        </div>
      </div>
    </div>
    ${fs.isFlipped ? `
      <div class="flashcard-rating">
        <button class="rating-btn rating-again" data-quality="0" type="button">忘记了</button>
        <button class="rating-btn rating-hard" data-quality="1" type="button">困难</button>
        <button class="rating-btn rating-good" data-quality="2" type="button">良好</button>
        <button class="rating-btn rating-easy" data-quality="3" type="button">简单</button>
      </div>
    ` : '<p class="muted" style="text-align:center;margin-top:12px;">点击卡片翻转查看答案</p>'}
  `;

  document.getElementById('flashcard-card').addEventListener('click', () => {
    if (!fs.isFlipped) {
      fs.isFlipped = true;
      renderFlashcardSession();
    }
  });

  cardRoot.querySelectorAll('[data-quality]').forEach((btn) => {
    btn.addEventListener('click', () => rateFlashcard(Number(btn.dataset.quality)));
  });
}

function renderQuizMode(card, cardRoot, fs) {
  const correctAnswer = card.backContent;
  const distractors = fs.dueCards
    .filter((c) => c.id !== card.id && c.backContent !== correctAnswer)
    .map((c) => c.backContent)
    .sort(() => Math.random() - 0.5)
    .slice(0, 3);
  while (distractors.length < 3) distractors.push('---');
  const options = [correctAnswer, ...distractors].sort(() => Math.random() - 0.5);
  const correctIndex = options.indexOf(correctAnswer);
  const audioEl = card.audioPath ? `<audio controls src="${escapeHtml(card.audioPath)}" style="margin-top:10px;width:100%;"></audio>` : '';
  const frontImg = card.frontImagePath ? `<img src="${escapeHtml(card.frontImagePath)}" style="max-width:100%;max-height:200px;border-radius:12px;margin-top:10px;" />` : '';

  cardRoot.innerHTML = `
    <div class="paper-card" style="padding:24px;">
      <div class="badge badge-brand">${escapeHtml(card.subject || '通用')}</div>
      <h3 style="margin-top:10px;">${escapeHtml(card.title)}</h3>
      <p style="margin-top:10px;font-size:18px;">${escapeHtml(card.frontContent)}</p>
      ${frontImg}
      ${audioEl}
      <form id="quiz-form" style="margin-top:16px;">
        <div class="reply-list">
          ${options.map((opt, i) => `
            <label class="checkbox-chip" style="margin:4px 0;cursor:pointer;">
              <input type="radio" name="quizAnswer" value="${i}" />
              <span>${escapeHtml(opt)}</span>
            </label>
          `).join('')}
        </div>
        <button class="button" type="submit" style="margin-top:12px;">确认</button>
      </form>
      <div id="quiz-feedback" style="margin-top:12px;"></div>
    </div>
  `;

  document.getElementById('quiz-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const selected = new FormData(event.target).get('quizAnswer');
    if (selected === null) { createToast('请选择一个答案。', 'error'); return; }
    const isCorrect = Number(selected) === correctIndex;
    const quality = isCorrect ? 2 : 0;
    const backImg = card.backImagePath ? `<img src="${escapeHtml(card.backImagePath)}" style="max-width:100%;max-height:150px;border-radius:12px;margin-top:8px;" />` : '';
    document.getElementById('quiz-feedback').innerHTML = `
      <strong>${isCorrect ? '回答正确！' : `回答错误。正确答案：${escapeHtml(correctAnswer)}`}</strong>
      ${!isCorrect ? backImg : ''}
      <button class="button" style="margin-top:10px;" onclick="rateFlashcard(${quality})">${isCorrect ? '下一题' : '继续'}</button>
    `;
  });
}

async function rateFlashcard(quality) {
  const fs = studentState.flashcardState;
  const card = fs.dueCards[fs.currentIndex];
  try {
    await fetchJSON(`/api/flashcards/${card.id}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quality })
    });
    fs.stats.total++;
    if (quality === 0) fs.stats.again++;
    else if (quality === 1) fs.stats.hard++;
    else if (quality === 2) fs.stats.good++;
    else fs.stats.easy++;
    fs.currentIndex++;
    fs.isFlipped = false;
    renderFlashcardSession();
  } catch (error) {
    createToast(error.message, 'error');
  }
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

// ── 学习数据统计 ──

async function loadDetailedStats() {
  try {
    const data = await fetchJSON('/api/practice/stats/detailed');
    renderStatsOverview(data.overview);
    renderSubjectAccuracy(data.subjectAccuracy);
    renderDailyActivity(data.dailyActivity);
    renderRecentSessions(data.recentSessions);
    renderTagAccuracy(data.tagAccuracy);
    renderRecentSessions(data.recentSessions);
  } catch (_) {}
}

function renderStatsOverview(overview) {
  const totalMinutes = Math.round((overview.totalTimeSpentMs || 0) / 60000);
  document.getElementById('stats-overview').innerHTML = [
    { label: '总做题', value: overview.totalAttempts },
    { label: '正确率', value: (overview.accuracy || 0) + '%' },
    { label: '闪卡已学', value: overview.flashcardsLearned },
    { label: '练习次数', value: overview.totalSessions },
    { label: '累计用时', value: totalMinutes + ' 分钟' }
  ].map((item) => `
    <div class="metric-card">
      <span class="muted">${escapeHtml(item.label)}</span>
      <strong>${escapeHtml(String(item.value))}</strong>
    </div>
  `).join('') + '<div style="margin-top:10px;"><button class="ghost-button" data-action="export-report" type="button" style="font-size:12px;padding:6px 16px;">导出学习报告</button></div>';
}

function renderSubjectAccuracy(subjects) {
  const root = document.getElementById('stats-subject-accuracy');
  if (!subjects || !subjects.length) { root.innerHTML = ''; return; }
  root.innerHTML = `
    <h3 style="margin-bottom:12px;">科目正确率</h3>
    ${subjects.map((s) => `
      <div style="margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;">
          <span>${escapeHtml(s.subject)}</span>
          <span class="muted">${s.correct}/${s.total} (${s.accuracy}%)</span>
        </div>
        <div style="background:#e2e8f0;border-radius:6px;height:8px;overflow:hidden;">
          <div style="background:var(--brand);height:100%;width:${Math.min(s.accuracy, 100)}%;border-radius:6px;transition:width 0.3s;"></div>
        </div>
      </div>
    `).join('')}
  `;
}

function renderDailyActivity(daily) {
  const root = document.getElementById('stats-daily-activity');
  if (!daily || !daily.length) { root.innerHTML = ''; return; }
  const maxCount = Math.max(...daily.map((d) => d.questionsAnswered), 1);
  root.innerHTML = `
    <h3 style="margin-bottom:12px;">近 30 天活动</h3>
    <div style="display:flex;flex-wrap:wrap;gap:3px;">
      ${daily.map((d) => {
        const intensity = Math.round((d.questionsAnswered / maxCount) * 100);
        const bg = d.questionsAnswered === 0 ? '#e2e8f0' : `rgba(37,99,235,${0.2 + intensity * 0.008})`;
        return `<div title="${d.date}: ${d.questionsAnswered} 题" style="width:14px;height:14px;border-radius:3px;background:${bg};"></div>`;
      }).join('')}
    </div>
  `;
}

function renderRecentSessions(sessions) {
  const root = document.getElementById('stats-recent-sessions');
  if (!sessions || !sessions.length) { root.innerHTML = ''; return; }
  root.innerHTML = `
    <h3 style="margin-bottom:12px;">最近练习</h3>
    <div class="list-grid">
      ${sessions.slice(0, 10).map((s) => {
        const typeLabel = { mixed: '综合', subject: '专项', flashcard: '闪卡', wrong_review: '错题重做' }[s.sessionType] || s.sessionType;
        const acc = s.totalQuestions ? Math.round((s.correctCount / s.totalQuestions) * 100) : 0;
        return `
          <div class="paper-card" style="padding:12px;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <div>
                <span class="badge badge-brand">${escapeHtml(typeLabel)}</span>
                ${s.subjectFilter ? `<span class="badge" style="margin-left:4px;">${escapeHtml(s.subjectFilter)}</span>` : ''}
              </div>
              <span class="badge">${acc}% 正确</span>
            </div>
            <p class="muted" style="margin-top:6px;font-size:12px;">${s.correctCount}/${s.totalQuestions} 题 · ${escapeHtml(formatDateTime(s.startedAt))}</p>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function renderTagAccuracy(tags) {
  // 找到 stats-subject-accuracy 后面的位置来渲染标签分析
  const root = document.getElementById('stats-subject-accuracy');
  if (!root) return;
  if (!tags || !tags.length) return;
  const tagHtml = `
    <h3 style="margin-top:24px;margin-bottom:12px;">知识点薄弱分析</h3>
    <p class="muted" style="font-size:12px;margin-bottom:10px;">按标签维度统计正确率，排在最前面的知识点最需要加强。</p>
    ${tags.slice(0, 10).map((t) => {
      const color = t.accuracy >= 80 ? '#22c55e' : t.accuracy >= 60 ? '#f59e0b' : '#ef4444';
      return `
        <div style="margin-bottom:8px;">
          <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:3px;">
            <span>${escapeHtml(t.tagName)} <span class="muted" style="font-size:11px;">(${escapeHtml(t.tagCategory)})</span></span>
            <span style="color:${color};">${t.correct}/${t.total} (${t.accuracy}%)</span>
          </div>
          <div style="background:#e2e8f0;border-radius:6px;height:6px;overflow:hidden;">
            <div style="background:${color};height:100%;width:${Math.min(t.accuracy, 100)}%;border-radius:6px;"></div>
          </div>
        </div>
      `;
    }).join('')}
  `;
  root.insertAdjacentHTML('afterend', tagHtml);
}

// ── 打卡日历 ──

async function loadCheckinCalendar(year, month) {
  const y = year || new Date().getFullYear();
  const m = month || new Date().getMonth() + 1;
  try {
    const result = await fetchJSON(`/api/study/streak?year=${y}&month=${m}`);
    renderCheckinStats(result);
    renderCheckinCalendar(y, m, result.calendarDays || []);
  } catch (_) {}
}

function renderCheckinStats(data) {
  document.getElementById('checkin-streak-stats').innerHTML = [
    { label: '当前连续', value: (data.currentStreak || 0) + ' 天' },
    { label: '最长连续', value: (data.longestStreak || 0) + ' 天' },
    { label: '本月学习', value: (data.monthDays || 0) + ' 天' }
  ].map((item) => `
    <div class="metric-card">
      <span class="muted">${escapeHtml(item.label)}</span>
      <strong>${escapeHtml(String(item.value))}</strong>
    </div>
  `).join('');
}

function renderCheckinCalendar(year, month, activeDays) {
  const root = document.getElementById('checkin-calendar');
  const activeSet = new Set(activeDays.map((d) => d.date));
  const weekLabels = ['一', '二', '三', '四', '五', '六', '日'];
  const firstDay = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0);
  const startWeekday = (firstDay.getDay() + 6) % 7;
  const daysInMonth = lastDay.getDate();
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  let cells = weekLabels.map((l) => `<div style="text-align:center;font-size:12px;color:var(--subtle);font-weight:600;">${l}</div>`).join('');
  for (let i = 0; i < startWeekday; i++) cells += '<div></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const isActive = activeSet.has(dateStr);
    const isToday = dateStr === todayStr;
    const bg = isActive ? 'var(--brand-light)' : '#f8fafc';
    const border = isToday ? '2px solid var(--brand)' : isActive ? '1px solid var(--brand)' : '1px solid var(--line)';
    cells += `<div style="text-align:center;padding:8px 4px;border-radius:8px;background:${bg};border:${border};font-size:13px;${isActive ? 'color:var(--brand);font-weight:700;' : ''}">${d}</div>`;
  }

  root.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
      <button class="ghost-button" data-action="prev-month" type="button" style="padding:6px 12px;">&lt;</button>
      <strong>${year} 年 ${month} 月</strong>
      <button class="ghost-button" data-action="next-month" type="button" style="padding:6px 12px;">&gt;</button>
    </div>
    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:4px;">${cells}</div>
  `;
}

// 打卡日历月份切换事件
document.addEventListener('click', (event) => {
  const prevBtn = event.target.closest('[data-action="prev-month"]');
  const nextBtn = event.target.closest('[data-action="next-month"]');
  if (!prevBtn && !nextBtn) return;
  const el = document.getElementById('checkin-calendar');
  const currentLabel = el.querySelector('strong');
  if (!currentLabel) return;
  const parts = currentLabel.textContent.match(/(\d{4}) 年 (\d{1,2}) 月/);
  if (!parts) return;
  let y = Number(parts[1]);
  let m = Number(parts[2]);
  if (prevBtn) { m--; if (m < 1) { m = 12; y--; } }
  if (nextBtn) { m++; if (m > 12) { m = 1; y++; } }
  loadCheckinCalendar(y, m);
});

// ── 专项练习模式 ──

function bindPracticeMode() {
  const questionPanel = document.getElementById('student-questions');
  if (!questionPanel) return;
  questionPanel.addEventListener('click', (event) => {
    const modeBtn = event.target.closest('[data-practice-mode]');
    if (!modeBtn) return;
    const mode = modeBtn.dataset.practiceMode;
    studentState.questionFilter.mode = mode;
    studentState.questionFilter.page = 1;
    questionPanel.querySelectorAll('[data-practice-mode]').forEach((b) => b.classList.remove('active'));
    modeBtn.classList.add('active');
    loadFilteredQuestions();
  });
}

// ── 专注计时器 ──

function bindFocusTimer() {
  // 任务卡片上的"开始专注"按钮 + "完成任务"按钮
  document.getElementById('student-tasks-list').addEventListener('click', (event) => {
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

// ── 成就系统 ──

async function loadAchievements() {
  try {
    const result = await fetchJSON('/api/achievements');
    renderAchievements(result.achievements);
  } catch (_) {}
}

function renderAchievements(achievements) {
  const root = document.getElementById('achievements-grid');
  if (!achievements || !achievements.length) {
    root.innerHTML = buildEmptyState('暂无成就', '持续学习即可解锁成就徽章。');
    return;
  }
  root.innerHTML = achievements.map((a) => `
    <div class="paper-card" style="padding:16px;text-align:center;${a.unlocked ? '' : 'opacity:0.5;filter:grayscale(0.8);'}">
      <div style="font-size:32px;margin-bottom:8px;">${a.icon}</div>
      <strong style="font-size:13px;">${escapeHtml(a.title)}</strong>
      <p class="muted" style="font-size:11px;margin-top:4px;">${escapeHtml(a.description)}</p>
      ${a.unlocked ? `<div class="badge badge-success" style="margin-top:8px;font-size:10px;">已解锁</div>` : `<div class="badge" style="margin-top:8px;font-size:10px;">未解锁</div>`}
    </div>
  `).join('');
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

// ── 全局搜索 ──

function bindGlobalSearch() {
  const searchBtn = document.getElementById('global-search-btn');
  const searchInput = document.getElementById('global-search-input');

  searchBtn.addEventListener('click', () => doGlobalSearch());
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doGlobalSearch(); });
  bindSearchSuggestions();
}

async function doGlobalSearch() {
  const keyword = document.getElementById('global-search-input').value.trim();
  if (!keyword || keyword.length < 2) { createToast('请输入至少2个字符。', 'error'); return; }
  saveSearchHistory(keyword);

  const root = document.getElementById('global-search-results');
  root.classList.remove('hidden');
  root.innerHTML = '<p class="muted">搜索中...</p>';

  try {
    const result = await fetchJSON('/api/search?q=' + encodeURIComponent(keyword));
    let html = '';
    if (result.topics.length) {
      html += '<h3 style="margin:14px 0 8px;">帖子</h3>';
      html += result.topics.map((t) => `
        <div class="paper-card" style="padding:12px;margin-bottom:8px;cursor:pointer;" onclick="location.href='/forum/topic/${t.id}'">
          <strong>${escapeHtml(t.title)}</strong>
          <span class="muted" style="margin-left:8px;font-size:12px;">${escapeHtml(t.authorName)} · ${escapeHtml(formatDateTime(t.createdAt))}</span>
        </div>
      `).join('');
    }
    if (result.questions.length) {
      html += '<h3 style="margin:14px 0 8px;">题目</h3>';
      html += result.questions.map((q) => `
        <div class="paper-card" style="padding:12px;margin-bottom:8px;">
          <span class="badge badge-brand">${escapeHtml(q.subject)}</span>
          <strong style="margin-left:8px;">${escapeHtml(q.title)}</strong>
        </div>
      `).join('');
    }
    if (result.items.length) {
      html += '<h3 style="margin:14px 0 8px;">课程资料</h3>';
      html += result.items.map((i) => `
        <div class="paper-card" style="padding:12px;margin-bottom:8px;">
          <span class="badge">${escapeHtml(i.itemType || '文件')}</span>
          <strong style="margin-left:8px;">${escapeHtml(i.title)}</strong>
        </div>
      `).join('');
    }
    if (!html) html = '<p class="muted">未找到相关结果。</p>';
    root.innerHTML = html;
  } catch (error) {
    createToast(error.message, 'error');
  }
}

// ── 每日推荐 ──

function bindDailyQuestions() {
  loadDailyQuestions();
}

async function loadDailyQuestions() {
  try {
    const result = await fetchJSON('/api/questions/daily');
    const root = document.getElementById('daily-questions-list');
    if (!result.questions.length) {
      root.innerHTML = buildEmptyState('今日暂无推荐', '多做一些题目后，系统会根据你的情况推荐。');
      return;
    }
    root.innerHTML = result.questions.map((q) => renderQuestionCard(q, false)).join('');
  } catch (_) {}
}

// ── 课程笔记（在视频播放器中集成） ──

async function loadCourseNotes(itemId) {
  try {
    const result = await fetchJSON('/api/courses/' + itemId + '/notes');
    return result.notes || [];
  } catch (_) { return []; }
}

async function saveCourseNote(itemId, content, timestampSeconds) {
  try {
    await fetchJSON('/api/courses/' + itemId + '/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, timestampSeconds })
    });
    createToast('笔记已保存。', 'success');
  } catch (error) {
    createToast(error.message, 'error');
  }
}

// ── 购物车 ──

async function loadCart() {
  try {
    const result = await fetchJSON('/api/cart');
    renderCart(result.items);
  } catch (error) {
    createToast(error.message, 'error');
  }
}

function renderCart(items) {
  const root = document.getElementById('cart-items-list');
  const checkoutArea = document.getElementById('cart-checkout-area');

  if (!items.length) {
    root.innerHTML = '<p class="muted" style="font-size:13px;">购物车为空。</p>';
    checkoutArea.classList.add('hidden');
    return;
  }

  checkoutArea.classList.remove('hidden');
  let totalAmount = 0;
  root.innerHTML = items.map((item) => {
    const subtotal = item.price * item.quantity;
    totalAmount += subtotal;
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--line);">
        <div>
          <strong style="font-size:13px;">${escapeHtml(item.title)}</strong>
          <span class="muted" style="margin-left:8px;font-size:12px;">${formatMoney(item.price)} x ${item.quantity}</span>
        </div>
        <div style="display:flex;gap:6px;align-items:center;">
          <span style="font-size:13px;font-weight:600;">${formatMoney(subtotal)}</span>
          <button class="ghost-button" data-action="remove-cart" data-id="${item.id}" type="button" style="font-size:11px;padding:2px 8px;color:#ef4444;">移除</button>
        </div>
      </div>
    `;
  }).join('') + `<div style="text-align:right;padding:10px 0;font-weight:600;">合计：${formatMoney(totalAmount)}</div>`;

  loadAddresses();
}

function bindCartEvents() {
  document.getElementById('student-products-list').addEventListener('click', async (event) => {
    const addBtn = event.target.closest('[data-action="add-to-cart"]');
    if (!addBtn) return;
    try {
      await fetchJSON('/api/cart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: addBtn.dataset.id, quantity: 1 })
      });
      createToast('已加入购物车。', 'success');
      loadCart();
    } catch (error) {
      createToast(error.message, 'error');
    }
  });

  document.getElementById('cart-items-list').addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-action="remove-cart"]');
    if (!btn) return;
    try {
      await fetchJSON('/api/cart/' + btn.dataset.id, { method: 'DELETE' });
      createToast('已移除。', 'success');
      loadCart();
    } catch (error) {
      createToast(error.message, 'error');
    }
  });

  document.getElementById('cart-checkout-btn').addEventListener('click', async () => {
    const addressId = document.getElementById('cart-address-select').value;
    if (!addressId) { createToast('请选择收货地址。', 'error'); return; }
    const btn = document.getElementById('cart-checkout-btn');
    setButtonLoading(btn, true);
    try {
      const result = await fetchJSON('/api/cart/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addressId: Number(addressId) })
      });
      createToast(`下单成功，共 ${result.created} 个订单。`, 'success');
      loadCart();
      refreshStudentData();
    } catch (error) {
      createToast(error.message, 'error');
    } finally {
      setButtonLoading(btn, false);
    }
  });

  document.getElementById('cart-manage-address').addEventListener('click', () => {
    document.getElementById('address-manager').classList.toggle('hidden');
  });
}

// ── 地址簿 ──

async function loadAddresses() {
  try {
    const result = await fetchJSON('/api/addresses');
    renderAddresses(result.addresses);
  } catch (_) {}
}

function renderAddresses(addresses) {
  const sel = document.getElementById('cart-address-select');
  sel.innerHTML = '<option value="">选择收货地址</option>' +
    addresses.map((a) => `<option value="${a.id}">${escapeHtml(a.name)} ${escapeHtml(a.phone)} - ${escapeHtml(a.address)}</option>`).join('');

  const root = document.getElementById('address-list');
  root.innerHTML = addresses.length ? addresses.map((a) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--line);">
      <div>
        <strong style="font-size:13px;">${escapeHtml(a.name)}</strong>
        ${a.phone ? `<span class="muted" style="margin-left:6px;font-size:12px;">${escapeHtml(a.phone)}</span>` : ''}
        <p class="muted" style="font-size:12px;">${escapeHtml(a.address)}</p>
      </div>
      <div style="display:flex;gap:6px;">
        ${a.is_default ? '<span class="badge badge-brand" style="font-size:10px;">默认</span>' : ''}
        <button class="ghost-button" data-action="delete-address" data-id="${a.id}" type="button" style="font-size:11px;padding:2px 8px;color:#ef4444;">删除</button>
      </div>
    </div>
  `).join('') : '<p class="muted" style="font-size:12px;">暂无保存的地址。</p>';
}

function bindAddressEvents() {
  document.getElementById('address-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    try {
      await fetchJSON('/api/addresses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.get('name'),
          phone: formData.get('phone'),
          address: formData.get('address'),
          isDefault: formData.get('isDefault') === 'on'
        })
      });
      createToast('地址已保存。', 'success');
      form.reset();
      loadAddresses();
    } catch (error) {
      createToast(error.message, 'error');
    }
  });

  document.getElementById('address-list').addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-action="delete-address"]');
    if (!btn) return;
    try {
      await fetchJSON('/api/addresses/' + btn.dataset.id, { method: 'DELETE' });
      createToast('地址已删除。', 'success');
      loadAddresses();
    } catch (error) {
      createToast(error.message, 'error');
    }
  });
}

// ── 商品评价 ──

function bindProductReviewEvents() {
  document.getElementById('student-orders-list').addEventListener('click', async (event) => {
    const reviewBtn = event.target.closest('[data-action="review-product"]');
    if (!reviewBtn) return;
    const productId = reviewBtn.dataset.productId;
    const productTitle = reviewBtn.dataset.title;

    const overlay = document.createElement('div');
    overlay.className = 'celebration-overlay';
    overlay.innerHTML = `
      <div class="celebration-card" style="max-width:400px;">
        <h3 style="margin-bottom:12px;">评价商品：${escapeHtml(productTitle)}</h3>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;">
          <label style="font-size:13px;">评分：</label>
          <select id="product-review-rating" class="input" style="padding:6px 10px;font-size:13px;width:80px;">
            <option value="5">5星</option><option value="4">4星</option><option value="3">3星</option><option value="2">2星</option><option value="1">1星</option>
          </select>
        </div>
        <textarea class="textarea" id="product-review-content" placeholder="写下你的评价..." style="min-height:60px;"></textarea>
        <div style="display:flex;gap:8px;margin-top:12px;">
          <button class="button" id="submit-product-review" data-product-id="${productId}" type="button">提交评价</button>
          <button class="ghost-button" onclick="this.closest('.celebration-overlay').remove()" type="button">取消</button>
        </div>
      </div>
    `;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);

    document.getElementById('submit-product-review').addEventListener('click', async () => {
      const rating = Number(document.getElementById('product-review-rating').value);
      const content = document.getElementById('product-review-content').value.trim();
      try {
        await fetchJSON('/api/products/' + productId + '/reviews', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rating, content })
        });
        createToast('评价已提交。', 'success');
        overlay.remove();
      } catch (error) {
        createToast(error.message, 'error');
      }
    });
  });
}

// ── 周报/月报 ──

function bindStatsTabs() {
  const panel = document.getElementById('student-stats-panel');
  if (!panel) return;
  panel.addEventListener('click', (event) => {
    const tabBtn = event.target.closest('[data-stats-tab]');
    if (!tabBtn) return;
    const tab = tabBtn.dataset.statsTab;
    panel.querySelectorAll('[data-stats-tab]').forEach((b) => b.classList.remove('active'));
    tabBtn.classList.add('active');

    const overview = document.getElementById('stats-overview');
    const subjectAcc = document.getElementById('stats-subject-accuracy');
    const dailyAct = document.getElementById('stats-daily-activity');
    const recentSess = document.getElementById('stats-recent-sessions');
    const weekly = document.getElementById('stats-weekly-report');
    const monthly = document.getElementById('stats-monthly-report');

    if (tab === 'overview') {
      overview.classList.remove('hidden');
      subjectAcc.classList.remove('hidden');
      dailyAct.classList.remove('hidden');
      recentSess.classList.remove('hidden');
      weekly.classList.add('hidden');
      monthly.classList.add('hidden');
    } else if (tab === 'weekly') {
      overview.classList.add('hidden');
      subjectAcc.classList.add('hidden');
      dailyAct.classList.add('hidden');
      recentSess.classList.add('hidden');
      weekly.classList.remove('hidden');
      monthly.classList.add('hidden');
      loadWeeklyReport();
    } else if (tab === 'monthly') {
      overview.classList.add('hidden');
      subjectAcc.classList.add('hidden');
      dailyAct.classList.add('hidden');
      recentSess.classList.add('hidden');
      weekly.classList.add('hidden');
      monthly.classList.remove('hidden');
      loadMonthlyReport();
    }
  });
}

async function loadWeeklyReport(weekOffset) {
  const offset = weekOffset || 0;
  try {
    const data = await fetchJSON('/api/practice/stats/weekly?weekOffset=' + offset);
    const root = document.getElementById('stats-weekly-report');
    const subjectRows = data.subjectBreakdown.map((s) => {
      const acc = s.total > 0 ? Math.round((s.correct / s.total) * 100) : 0;
      return `<div style="display:flex;justify-content:space-between;font-size:12px;padding:6px 0;border-bottom:1px solid var(--line);">
        <span>${escapeHtml(s.subject)}</span>
        <span>${s.correct}/${s.total} (${acc}%) · ${Math.round(s.timeMs / 60000)}分钟</span>
      </div>`;
    }).join('');

    const dailyBars = data.dailyBreakdown.map((d) => {
      const acc = d.total > 0 ? Math.round((d.correct / d.total) * 100) : 0;
      const dayLabel = d.date.slice(5);
      return `<div style="display:flex;align-items:center;gap:8px;font-size:12px;">
        <span style="width:36px;">${dayLabel}</span>
        <div style="flex:1;background:#e2e8f0;border-radius:4px;height:14px;overflow:hidden;">
          <div style="background:var(--brand);height:100%;width:${Math.min(acc, 100)}%;border-radius:4px;"></div>
        </div>
        <span style="width:60px;text-align:right;">${d.total}题 ${acc}%</span>
      </div>`;
    }).join('');

    root.innerHTML = `
      <div class="paper-card" style="padding:20px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
          <button class="ghost-button" data-action="prev-week" data-offset="${offset + 1}" type="button" style="padding:4px 12px;">&lt; 上一周</button>
          <strong>${data.weekStart} ~ ${data.weekEnd}</strong>
          ${offset > 0 ? `<button class="ghost-button" data-action="next-week" data-offset="${offset - 1}" type="button" style="padding:4px 12px;">下一周 &gt;</button>` : '<span></span>'}
        </div>
        <div class="stat-grid">
          <div class="metric-card"><span class="muted">做题数</span><strong>${data.totalQuestions}</strong></div>
          <div class="metric-card"><span class="muted">正确率</span><strong>${data.accuracy}%</strong></div>
          <div class="metric-card"><span class="muted">用时</span><strong>${data.totalTimeMinutes} 分钟</strong></div>
          <div class="metric-card"><span class="muted">闪卡复习</span><strong>${data.flashcardCount}</strong></div>
        </div>
        ${subjectRows ? `<h4 style="margin:14px 0 8px;font-size:14px;">科目分布</h4>${subjectRows}` : ''}
        ${dailyBars ? `<h4 style="margin:14px 0 8px;font-size:14px;">每日正确率</h4>${dailyBars}` : ''}
      </div>
    `;

    root.querySelectorAll('[data-action="prev-week"],[data-action="next-week"]').forEach((btn) => {
      btn.addEventListener('click', () => loadWeeklyReport(Number(btn.dataset.offset)));
    });
  } catch (error) {
    createToast(error.message, 'error');
  }
}

async function loadMonthlyReport(monthOffset) {
  const offset = monthOffset || 0;
  try {
    const data = await fetchJSON('/api/practice/stats/monthly?monthOffset=' + offset);
    const root = document.getElementById('stats-monthly-report');
    const subjectRows = data.subjectBreakdown.map((s) => {
      const acc = s.total > 0 ? Math.round((s.correct / s.total) * 100) : 0;
      return `<div style="display:flex;justify-content:space-between;font-size:12px;padding:6px 0;border-bottom:1px solid var(--line);">
        <span>${escapeHtml(s.subject)}</span>
        <span>${s.correct}/${s.total} (${acc}%) · ${Math.round(s.timeMs / 60000)}分钟</span>
      </div>`;
    }).join('');

    const dailyChart = data.dailyBreakdown.map((d) => {
      const acc = d.total > 0 ? Math.round((d.correct / d.total) * 100) : 0;
      const barH = Math.min(d.total, 20);
      const bg = acc >= 80 ? '#22c55e' : acc >= 60 ? '#f59e0b' : '#ef4444';
      return `<div title="${d.date}: ${d.total}题 ${acc}%" style="display:flex;flex-direction:column;align-items:center;gap:2px;">
        <div style="width:16px;height:${barH * 3}px;background:${bg};border-radius:3px;"></div>
        <span style="font-size:9px;color:var(--subtle);">${d.date.slice(8)}</span>
      </div>`;
    }).join('');

    root.innerHTML = `
      <div class="paper-card" style="padding:20px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
          <button class="ghost-button" data-action="prev-month-report" data-offset="${offset + 1}" type="button" style="padding:4px 12px;">&lt; 上个月</button>
          <strong>${data.month}</strong>
          ${offset > 0 ? `<button class="ghost-button" data-action="next-month-report" data-offset="${offset - 1}" type="button" style="padding:4px 12px;">下个月 &gt;</button>` : '<span></span>'}
        </div>
        <div class="stat-grid">
          <div class="metric-card"><span class="muted">做题数</span><strong>${data.totalQuestions}</strong></div>
          <div class="metric-card"><span class="muted">正确率</span><strong>${data.accuracy}%</strong></div>
          <div class="metric-card"><span class="muted">用时</span><strong>${data.totalTimeMinutes} 分钟</strong></div>
          <div class="metric-card"><span class="muted">活跃天数</span><strong>${data.activeDays}</strong></div>
          <div class="metric-card"><span class="muted">闪卡复习</span><strong>${data.flashcardCount}</strong></div>
          <div class="metric-card"><span class="muted">学习总结</span><strong>${data.summaryCount}</strong></div>
        </div>
        ${subjectRows ? `<h4 style="margin:14px 0 8px;font-size:14px;">科目分布</h4>${subjectRows}` : ''}
        ${dailyChart ? `<h4 style="margin:14px 0 8px;font-size:14px;">每日题量</h4><div style="display:flex;gap:2px;flex-wrap:wrap;align-items:flex-end;">${dailyChart}</div>` : ''}
      </div>
    `;

    root.querySelectorAll('[data-action="prev-month-report"],[data-action="next-month-report"]').forEach((btn) => {
      btn.addEventListener('click', () => loadMonthlyReport(Number(btn.dataset.offset)));
    });
  } catch (error) {
    createToast(error.message, 'error');
  }
}

// ── 课程筛选 + 最近观看 ──

function bindCourseTabs() {
  const panel = document.getElementById('student-courses');
  if (!panel) return;

  panel.addEventListener('click', (event) => {
    const tabBtn = event.target.closest('[data-course-tab]');
    if (!tabBtn) return;
    const tab = tabBtn.dataset.courseTab;
    panel.querySelectorAll('[data-course-tab]').forEach((b) => b.classList.remove('active'));
    tabBtn.classList.add('active');

    const browse = document.getElementById('student-course-browse');
    const recent = document.getElementById('student-recent-courses');

    if (tab === 'browse') {
      browse.classList.remove('hidden');
      recent.classList.add('hidden');
    } else {
      browse.classList.add('hidden');
      recent.classList.remove('hidden');
      loadRecentCourses();
    }
  });

  document.getElementById('course-subject-filter').addEventListener('change', (event) => {
    loadStudentCloud(null, event.target.value);
  });
}

async function loadRecentCourses() {
  try {
    const result = await fetchJSON('/api/courses/recent');
    const root = document.getElementById('recent-courses-list');
    if (!result.items.length) {
      root.innerHTML = '<p class="muted">还没有观看记录。</p>';
      return;
    }
    root.innerHTML = result.items.map((item) => {
      const icon = item.item_type === 'video' ? '&#127909;' : '&#128196;';
      const pct = item.duration_seconds > 0 ? Math.round((item.position_seconds / item.duration_seconds) * 100) : 0;
      return `
        <div class="paper-card cloud-item">
          <div class="cloud-item-icon">${icon}</div>
          <strong>${escapeHtml(item.title)}</strong>
          ${item.subject ? `<span class="badge badge-brand">${escapeHtml(item.subject)}</span>` : ''}
          <div style="margin-top:6px;">
            <div style="background:#e2e8f0;border-radius:4px;height:4px;overflow:hidden;">
              <div style="background:var(--brand);height:100%;width:${pct}%;border-radius:4px;"></div>
            </div>
            <span class="muted" style="font-size:11px;">${pct}% 已观看</span>
          </div>
          ${item.item_type === 'video' && (item.file_path || item.file_url) ? `<button class="ghost-button" data-action="play-video" data-item-id="${item.id}" data-src="${escapeHtml(item.file_path || item.file_url)}" data-title="${escapeHtml(item.title)}" type="button" style="font-size:12px;padding:4px 10px;">续播</button>` : ''}
        </div>
      `;
    }).join('');
  } catch (error) {
    createToast(error.message, 'error');
  }
}

// ── 课程科目筛选 ──

async function loadCourseSubjects() {
  try {
    const result = await fetchJSON('/api/folders');
    const items = result.items || [];
    const subjects = [...new Set(items.map((i) => i.subject).filter(Boolean))];
    const sel = document.getElementById('course-subject-filter');
    if (sel) {
      sel.innerHTML = '<option value="">全部科目</option>' + subjects.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    }
  } catch (_) {}
}

// ── 闪卡每日目标 ──

function bindFlashcardGoal() {
  const goalBtn = document.getElementById('flashcard-goal-btn');
  const goalBar = document.getElementById('flashcard-goal-bar');
  goalBtn.addEventListener('click', () => {
    goalBar.classList.toggle('hidden');
    if (!goalBar.classList.contains('hidden')) loadFlashcardGoal();
  });

  document.getElementById('save-goal-btn').addEventListener('click', async () => {
    const dailyNew = Number(document.getElementById('goal-daily-new').value);
    const dailyReview = Number(document.getElementById('goal-daily-review').value);
    const btn = document.getElementById('save-goal-btn');
    setButtonLoading(btn, true);
    try {
      await fetchJSON('/api/flashcards/goal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dailyNew, dailyReview })
      });
      createToast('目标已保存。', 'success');
    } catch (error) {
      createToast(error.message, 'error');
    } finally {
      setButtonLoading(btn, false);
    }
  });
}

async function loadFlashcardGoal() {
  try {
    const result = await fetchJSON('/api/flashcards/goal');
    document.getElementById('goal-daily-new').value = result.goal.dailyNew || 20;
    document.getElementById('goal-daily-review').value = result.goal.dailyReview || 50;

    // 显示进度
    const fs = studentState.flashcardState;
    const dueCount = fs.dueCards.length;
    const progressRoot = document.getElementById('flashcard-goal-progress');
    progressRoot.innerHTML = `
      <div style="font-size:12px;color:#475569;">
        今日待复习：<strong>${dueCount}</strong> 张（目标 ${result.goal.dailyReview} 张）
        <div style="margin-top:4px;background:#e2e8f0;border-radius:6px;height:6px;overflow:hidden;">
          <div style="background:var(--brand);height:100%;width:${Math.min(Math.round((fs.stats.total / Math.max(result.goal.dailyReview, 1)) * 100), 100)}%;border-radius:6px;"></div>
        </div>
      </div>
    `;
  } catch (_) {}
}

// ── 搜索历史 + 热门搜索 ──

function bindSearchSuggestions() {
  loadHotSearch();
  loadSearchHistory();

  const input = document.getElementById('global-search-input');
  input.addEventListener('focus', () => {
    document.getElementById('search-history').classList.remove('hidden');
  });
}

async function loadHotSearch() {
  try {
    const result = await fetchJSON('/api/search/hot');
    const tags = document.getElementById('hot-search-tags');
    if (result.keywords.length) {
      tags.innerHTML = result.keywords.map((k) =>
        `<a style="color:var(--brand);cursor:pointer;margin-right:8px;" data-search-keyword="${escapeHtml(k.keyword)}">${escapeHtml(k.keyword)}</a>`
      ).join('');
      tags.querySelectorAll('[data-search-keyword]').forEach((a) => {
        a.addEventListener('click', () => {
          document.getElementById('global-search-input').value = a.dataset.searchKeyword;
          doGlobalSearch();
        });
      });
    } else {
      tags.innerHTML = '<span class="muted">暂无</span>';
    }
  } catch (_) {}
}

function loadSearchHistory() {
  const history = JSON.parse(localStorage.getItem('search_history') || '[]');
  const root = document.getElementById('history-tags');
  if (!history.length) {
    document.getElementById('search-history').classList.add('hidden');
    return;
  }
  document.getElementById('search-history').classList.remove('hidden');
  root.innerHTML = history.slice(0, 8).map((kw) =>
    `<a style="color:var(--subtle);cursor:pointer;margin-right:8px;" data-history-keyword="${escapeHtml(kw)}">${escapeHtml(kw)}</a>`
  ).join('');

  root.querySelectorAll('[data-history-keyword]').forEach((a) => {
    a.addEventListener('click', () => {
      document.getElementById('global-search-input').value = a.dataset.historyKeyword;
      doGlobalSearch();
    });
  });
}

function saveSearchHistory(keyword) {
  let history = JSON.parse(localStorage.getItem('search_history') || '[]');
  history = history.filter((h) => h !== keyword);
  history.unshift(keyword);
  history = history.slice(0, 20);
  localStorage.setItem('search_history', JSON.stringify(history));
  loadSearchHistory();
}

// ── 学情报告导出（截图分享） ──

function bindReportExport() {
  document.getElementById('student-stats-panel').addEventListener('click', (event) => {
    const exportBtn = event.target.closest('[data-action="export-report"]');
    if (!exportBtn) return;
    exportStudyReport();
  });
}

async function exportStudyReport() {
  try {
    const [statsRes, streakRes] = await Promise.all([
      fetchJSON('/api/practice/stats/detailed'),
      fetchJSON('/api/study/streak')
    ]);
    const data = statsRes;
    const totalMinutes = Math.round((data.overview.totalTimeSpentMs || 0) / 60000);
    const acc = data.overview.accuracy || 0;

    const reportDiv = document.createElement('div');
    reportDiv.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:2000;display:flex;align-items:center;justify-content:center;padding:20px;';
    reportDiv.innerHTML = `
      <div style="background:#fff;border-radius:16px;padding:30px;max-width:500px;width:100%;max-height:90vh;overflow:auto;">
        <div id="report-content" style="background:linear-gradient(135deg,#eff6ff,#f0f9ff);border-radius:12px;padding:24px;">
          <div style="text-align:center;margin-bottom:16px;">
            <h2 style="margin:0;color:#1e40af;">研途学习报告</h2>
            <p style="margin:4px 0 0;font-size:13px;color:#64748b;">${new Date().toLocaleDateString('zh-CN')}</p>
          </div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;text-align:center;">
            <div style="background:#fff;border-radius:10px;padding:12px;">
              <div style="font-size:24px;font-weight:700;color:#2563eb;">${data.overview.totalAttempts}</div>
              <div style="font-size:11px;color:#64748b;">累计做题</div>
            </div>
            <div style="background:#fff;border-radius:10px;padding:12px;">
              <div style="font-size:24px;font-weight:700;color:${acc >= 80 ? '#22c55e' : acc >= 60 ? '#f59e0b' : '#ef4444'};">${acc}%</div>
              <div style="font-size:11px;color:#64748b;">正确率</div>
            </div>
            <div style="background:#fff;border-radius:10px;padding:12px;">
              <div style="font-size:24px;font-weight:700;color:#2563eb;">${streakRes.currentStreak || 0}</div>
              <div style="font-size:11px;color:#64748b;">连续打卡</div>
            </div>
          </div>
          <div style="margin-top:14px;background:#fff;border-radius:10px;padding:12px;">
            <div style="font-size:12px;font-weight:600;margin-bottom:8px;">科目分布</div>
            ${data.subjectAccuracy.map((s) => `
              <div style="display:flex;justify-content:space-between;font-size:11px;padding:3px 0;">
                <span>${escapeHtml(s.subject)}</span>
                <span>${s.correct}/${s.total} (${s.accuracy}%)</span>
              </div>
            `).join('') || '<p style="font-size:11px;color:#94a3b8;">暂无数据</p>'}
          </div>
          <div style="text-align:center;margin-top:14px;font-size:10px;color:#94a3b8;">研途总控台 · 坚持就是胜利</div>
        </div>
        <div style="display:flex;gap:8px;justify-content:center;margin-top:16px;">
          <button class="button" onclick="this.closest('div[style*=fixed]').querySelector('#report-content').innerHTML&&createToast('请使用浏览器截图功能保存报告。','success')" type="button">保存报告</button>
          <button class="ghost-button" onclick="this.closest('div[style*=fixed]').remove()" type="button">关闭</button>
        </div>
      </div>
    `;
    reportDiv.addEventListener('click', (e) => { if (e.target === reportDiv) reportDiv.remove(); });
    document.body.appendChild(reportDiv);
  } catch (error) {
    createToast(error.message, 'error');
  }
}

// ===== 第二阶段新前端功能 =====

// ── 考研倒计时 ──

function bindExamCountdown() {
  const panel = document.getElementById('student-tasks');
  if (!panel) return;
  const countdownArea = document.createElement('div');
  countdownArea.id = 'exam-countdown-area';
  countdownArea.style.cssText = 'margin-bottom:18px;padding:16px 20px;background:linear-gradient(135deg,#1e3a5f,#0f172a);border-radius:14px;color:#fff;';
  countdownArea.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;"><div><div style="font-size:13px;opacity:0.7;">考研倒计时</div><div id="exam-countdown-display" style="font-size:36px;font-weight:700;margin:4px 0;">加载中...</div><div id="exam-countdown-name" style="font-size:12px;opacity:0.6;"></div></div><div><button class="ghost-button" id="exam-countdown-set" type="button" style="color:#fff;border-color:rgba(255,255,255,0.3);font-size:12px;padding:4px 12px;">设置日期</button></div></div>';
  panel.insertBefore(countdownArea, panel.firstChild);
  loadExamCountdown();

  document.getElementById('exam-countdown-set').addEventListener('click', () => {
    const dateStr = prompt('请输入考试日期（格式：YYYY-MM-DD，如 2026-12-26）：');
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) { if (dateStr) createToast('日期格式不正确。', 'error'); return; }
    const name = prompt('考试名称（默认：考研）') || '考研';
    fetchJSON('/api/exam-countdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ examDate: dateStr, examName: name })
    }).then(() => loadExamCountdown()).catch((e) => createToast(e.message, 'error'));
  });
}

async function loadExamCountdown() {
  try {
    const res = await fetchJSON('/api/exam-countdown');
    const display = document.getElementById('exam-countdown-display');
    const nameEl = document.getElementById('exam-countdown-name');
    if (!display) return;
    if (res.countdown) {
      const target = new Date(res.countdown.examDate);
      const now = new Date();
      const diff = Math.ceil((target - now) / (1000 * 60 * 60 * 24));
      display.textContent = diff > 0 ? diff + ' 天' : (diff === 0 ? '今天！' : '已过');
      nameEl.textContent = res.countdown.examName + ' · ' + res.countdown.examDate;
    } else {
      display.textContent = '-- 天';
      nameEl.textContent = '点击"设置日期"开始倒计时';
    }
  } catch (_) {}
}

// ── 习惯追踪 ──

function bindHabits() {
  const panel = document.getElementById('student-checkin');
  if (!panel) return;
  const habitsArea = document.createElement('div');
  habitsArea.id = 'habits-area';
  habitsArea.style.cssText = 'margin-top:18px;padding:16px;border:1px solid var(--border);border-radius:12px;';
  habitsArea.innerHTML = '<h3 style="margin:0 0 12px;">习惯追踪</h3><div style="display:flex;gap:8px;margin-bottom:12px;"><input id="habit-name-input" class="input" placeholder="输入习惯名称..." style="flex:1;padding:8px 12px;" /><input id="habit-days-input" class="input" type="number" min="1" max="365" value="7" style="width:70px;padding:8px 12px;" placeholder="天数" /><button class="button" id="add-habit-btn" type="button" style="font-size:12px;padding:8px 14px;">添加</button></div><div id="habits-list"></div>';
  panel.appendChild(habitsArea);
  loadHabits();

  document.getElementById('add-habit-btn').addEventListener('click', async () => {
    const name = document.getElementById('habit-name-input').value.trim();
    const days = Number(document.getElementById('habit-days-input').value) || 7;
    if (!name) { createToast('请输入习惯名称。', 'error'); return; }
    try {
      await fetchJSON('/api/habits', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, targetDays: days }) });
      document.getElementById('habit-name-input').value = '';
      loadHabits();
    } catch (e) { createToast(e.message, 'error'); }
  });
}

async function loadHabits() {
  try {
    const res = await fetchJSON('/api/habits');
    const root = document.getElementById('habits-list');
    if (!root) return;
    if (!res.habits.length) { root.innerHTML = '<p class="muted" style="font-size:13px;">还没有添加习惯。添加一个开始追踪吧！</p>'; return; }
    const today = new Date().toISOString().split('T')[0];
    root.innerHTML = res.habits.map((h) => {
      const checked = h.completedDates.includes(today);
      const progress = Math.min(h.completedDates.length, h.targetDays);
      const pct = Math.round(progress / h.targetDays * 100);
      return '<div style="display:flex;align-items:center;gap:10px;padding:10px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;">' +
        '<button class="ghost-button" style="font-size:16px;padding:4px 8px;' + (checked ? 'color:#22c55e;' : '') + '" data-action="check-habit" data-id="' + h.id + '">' + (checked ? '&#10004;' : '&#9744;') + '</button>' +
        '<div style="flex:1;"><div style="font-size:13px;font-weight:600;">' + escapeHtml(h.habit_name) + '</div>' +
        '<div style="font-size:11px;color:var(--muted);">' + progress + '/' + h.targetDays + ' 天 (' + pct + '%)</div>' +
        '<div style="height:4px;background:var(--border);border-radius:2px;margin-top:4px;"><div style="height:4px;background:var(--brand);border-radius:2px;width:' + pct + '%;"></div></div></div>' +
        '<button class="ghost-button" style="font-size:11px;padding:2px 6px;color:#ef4444;" data-action="delete-habit" data-id="' + h.id + '">删除</button></div>';
    }).join('');
  } catch (_) {}
}

// ── 错题智能复习 ──

function bindWrongReview() {
  document.getElementById('student-questions').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="load-wrong-review"]');
    if (btn) loadWrongReviewQuestions();
  });
}

async function loadWrongReviewQuestions() {
  try {
    const res = await fetchJSON('/api/practice/wrong-review');
    const container = document.getElementById('qtab-all');
    if (!res.questions.length) { createToast('今日没有待复习的错题。', 'success'); return; }
    container.innerHTML = '<div class="paper-card" style="background:#fef3c7;border-color:#f59e0b;"><h4 style="color:#92400e;">错题智能复习（3/7/15天间隔）</h4><p class="muted">共 ' + res.questions.length + ' 道待复习错题</p></div>' +
      res.questions.map((q) => renderQuestionCard(q, true)).join('');
  } catch (e) { createToast(e.message, 'error'); }
}

// ── 模拟考试 ──

function bindMockExams() {
  document.getElementById('student-questions').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="start-mock-exam"]');
    if (btn) startMockExam(btn.dataset.id);
    const btn2 = e.target.closest('[data-action="view-exam-result"]');
    if (btn2) viewExamResult(btn2.dataset.id);
  });
}

async function loadMockExams() {
  try {
    const res = await fetchJSON('/api/mock-exams');
    const container = document.getElementById('mock-exams-area');
    if (!container) return;
    container.innerHTML = res.exams.length ? res.exams.map((e) =>
      '<div class="paper-card" style="display:flex;justify-content:space-between;align-items:center;">' +
      '<div><div style="font-weight:600;">' + escapeHtml(e.title) + '</div><div class="muted" style="font-size:12px;">' + escapeHtml(e.subject) + ' · ' + e.durationMinutes + '分钟 · ' + safeJsonParse(e.questionIds, []).length + '题</div></div>' +
      '<button class="button" style="font-size:12px;padding:6px 14px;" data-action="start-mock-exam" data-id="' + e.id + '">开始考试</button></div>'
    ).join('') : '<p class="muted">暂无模拟考试。</p>';
  } catch (_) {}
}

let mockExamTimer = null;
async function startMockExam(examId) {
  try {
    const res = await fetchJSON('/api/mock-exams/' + examId + '/start', { method: 'POST' });
    if (!res.exam) { createToast('无法开始考试。', 'error'); return; }
    const questionIds = safeJsonParse(res.exam.question_ids, []);
    const duration = res.exam.duration_minutes * 60;
    let remaining = duration;

    // 加载题目
    const questionsRes = await fetchJSON('/api/questions?limit=200');
    const allQ = questionsRes.questions || [];
    const examQs = questionIds.map((id) => allQ.find((q) => q.id === id)).filter(Boolean);
    const answers = {};

    const overlay = document.createElement('div');
    overlay.id = 'mock-exam-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:2000;overflow:auto;color:#fff;padding:20px;';

    const renderExam = () => {
      overlay.innerHTML = '<div style="max-width:800px;margin:0 auto;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">' +
        '<h2 style="margin:0;">' + escapeHtml(res.exam.title) + '</h2>' +
        '<div style="font-size:28px;font-weight:700;color:#f59e0b;" id="exam-timer">' + formatTime(remaining) + '</div></div>' +
        '<div style="background:rgba(255,255,255,0.1);border-radius:12px;padding:20px;">' +
        examQs.map((q, i) => {
          const opts = q.options || [];
          return '<div style="margin-bottom:20px;' + (i > 0 ? 'border-top:1px solid rgba(255,255,255,0.1);padding-top:16px;' : '') + '">' +
            '<div style="font-size:15px;font-weight:600;margin-bottom:10px;">' + (i + 1) + '. ' + escapeHtml(q.stem) + '</div>' +
            '<div style="display:flex;flex-direction:column;gap:6px;">' +
            opts.map((o) =>
              '<label style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:' + (answers[q.id] === o.key ? 'rgba(59,130,246,0.3)' : 'rgba(255,255,255,0.05)') + ';border-radius:8px;cursor:pointer;">' +
              '<input type="radio" name="exam-q-' + q.id + '" value="' + o.key + '" ' + (answers[q.id] === o.key ? 'checked' : '') + ' style="accent-color:#3b82f6;" />' +
              '<span>' + o.key + '. ' + escapeHtml(o.text) + '</span></label>'
            ).join('') + '</div></div>';
        }).join('') +
        '</div><div style="text-align:center;margin-top:20px;"><button class="button" id="submit-exam-btn" style="padding:12px 40px;">交卷</button></div></div>';

      overlay.querySelectorAll('input[type="radio"]').forEach((input) => {
        input.addEventListener('change', () => {
          const qId = Number(input.name.replace('exam-q-', ''));
          answers[qId] = input.value;
        });
      });

      document.getElementById('submit-exam-btn').addEventListener('click', async () => {
        clearInterval(mockExamTimer);
        try {
          const submitRes = await fetchJSON('/api/mock-exams/' + examId + '/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ answers, timeSpentMs: (duration - remaining) * 1000 })
          });
          overlay.remove();
          viewExamResult(examId);
          createToast('考试提交成功！得分：' + submitRes.score + '/' + submitRes.total, 'success');
        } catch (e) { createToast(e.message, 'error'); }
      });
    };

    mockExamTimer = setInterval(() => {
      remaining--;
      const timerEl = document.getElementById('exam-timer');
      if (timerEl) timerEl.textContent = formatTime(remaining);
      if (remaining <= 0) {
        clearInterval(mockExamTimer);
        document.getElementById('submit-exam-btn')?.click();
      }
    }, 1000);

    renderExam();
    document.body.appendChild(overlay);
  } catch (e) { createToast(e.message, 'error'); }
}

async function viewExamResult(examId) {
  try {
    const res = await fetchJSON('/api/mock-exams/' + examId + '/result');
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:2000;display:flex;align-items:center;justify-content:center;padding:20px;';
    overlay.innerHTML = '<div style="background:#fff;border-radius:16px;padding:30px;max-width:600px;width:100%;max-height:90vh;overflow:auto;">' +
      '<h2 style="margin:0 0 16px;">' + escapeHtml(res.exam.title) + ' - 成绩单</h2>' +
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px;">' +
      '<div class="metric-card"><span class="muted">得分</span><strong style="color:#2563eb;">' + res.submission.score + '</strong></div>' +
      '<div class="metric-card"><span class="muted">用时</span><strong>' + formatTime(Math.round(res.submission.timeSpentMs / 1000)) + '</strong></div>' +
      '<div class="metric-card"><span class="muted">正确</span><strong>' + res.details.filter((d) => d.isCorrect).length + '/' + res.details.length + '</strong></div></div>' +
      res.details.map((d, i) =>
        '<div style="padding:10px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;border-left:4px solid ' + (d.isCorrect ? '#22c55e' : '#ef4444') + ';">' +
        '<div style="font-size:13px;font-weight:600;">' + (i + 1) + '. ' + escapeHtml(d.stem) + '</div>' +
        '<div style="font-size:12px;margin-top:4px;">你的答案：<span style="color:' + (d.isCorrect ? '#22c55e' : '#ef4444') + ';">' + escapeHtml(d.myAnswer || '未答') + '</span>' +
        (d.isCorrect ? '' : ' · 正确答案：<span style="color:#22c55e;">' + escapeHtml(d.correctAnswer) + '</span>') + '</div>' +
        (d.analysisText ? '<div class="muted" style="font-size:11px;margin-top:4px;">' + escapeHtml(d.analysisText).substring(0, 200) + '</div>' : '') + '</div>'
      ).join('') +
      '<div style="text-align:center;margin-top:16px;"><button class="ghost-button" onclick="this.closest(\'div[style*=fixed]\').remove()">关闭</button></div></div>';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  } catch (e) { createToast(e.message, 'error'); }
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

// ── 刷题热力图 ──

async function loadHeatmap() {
  try {
    const year = new Date().getFullYear();
    const res = await fetchJSON('/api/practice/heatmap?year=' + year);
    const container = document.getElementById('stats-daily-activity');
    if (!container) return;

    const weeks = [];
    const startDate = new Date(year, 0, 1);
    const endDate = new Date(year, 11, 31);
    let current = new Date(startDate);
    while (current <= endDate) {
      const week = [];
      for (let d = 0; d < 7; d++) {
        if (current > endDate) break;
        const dateStr = current.toISOString().split('T')[0];
        const count = res.heatmap[dateStr] || 0;
        const color = count === 0 ? '#ebedf0' : count <= 2 ? '#9be9a8' : count <= 5 ? '#40c463' : count <= 10 ? '#30a14e' : '#216e39';
        week.push({ date: dateStr, count, color });
        current.setDate(current.getDate() + 1);
      }
      weeks.push(week);
    }

    container.innerHTML = '<h3 style="margin:0 0 10px;">做题热力图 (' + year + ')</h3>' +
      '<div style="display:flex;gap:3px;overflow-x:auto;padding:8px 0;">' +
      weeks.map((w) => '<div style="display:flex;flex-direction:column;gap:3px;">' +
        w.map((d) => '<div title="' + d.date + ': ' + d.count + '题" style="width:12px;height:12px;border-radius:2px;background:' + d.color + ';"></div>').join('') +
        '</div>').join('') + '</div>' +
      '<div style="display:flex;gap:4px;align-items:center;font-size:10px;margin-top:6px;"><span>少</span>' +
      ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'].map((c) => '<div style="width:10px;height:10px;border-radius:2px;background:' + c + ';"></div>').join('') +
      '<span>多</span></div>';
  } catch (_) {}
}

// ── 题目笔记 ──

function bindQuestionNotes() {
  document.getElementById('student-questions').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action="add-note"]');
    if (btn) {
      const qId = btn.dataset.id;
      const note = prompt('请输入你的笔记/理解：');
      if (!note) return;
      try {
        await fetchJSON('/api/questions/' + qId + '/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: note }) });
        createToast('笔记已保存。', 'success');
      } catch (err) { createToast(err.message, 'error'); }
    }
  });
}

// ── 闪卡排行榜 ──

async function loadFlashcardLeaderboard() {
  try {
    const res = await fetchJSON('/api/flashcards/leaderboard?period=week');
    const container = document.getElementById('flashcard-container');
    if (!container) return;
    // 排行榜放在闪卡容器下方
    let lbDiv = document.getElementById('flashcard-leaderboard');
    if (!lbDiv) {
      lbDiv = document.createElement('div');
      lbDiv.id = 'flashcard-leaderboard';
      lbDiv.style.cssText = 'margin-top:24px;padding:16px;border:1px solid var(--border);border-radius:12px;';
      container.parentNode.appendChild(lbDiv);
    }
    if (!res.leaderboard.length) { lbDiv.innerHTML = '<h4 style="margin:0 0 8px;">本周学习排行</h4><p class="muted" style="font-size:12px;">暂无数据。</p>'; return; }
    lbDiv.innerHTML = '<h4 style="margin:0 0 12px;">本周学习排行</h4>' +
      '<div style="display:flex;flex-direction:column;gap:6px;">' +
      res.leaderboard.slice(0, 10).map((l, i) =>
        '<div style="display:flex;align-items:center;gap:10px;padding:8px;background:' + (i < 3 ? '#fef9c3' : 'var(--bg)') + ';border-radius:8px;">' +
        '<span style="width:24px;text-align:center;font-weight:700;font-size:14px;color:' + (i === 0 ? '#f59e0b' : i === 1 ? '#94a3b8' : i === 2 ? '#cd7f32' : 'var(--muted)') + ';">' + (i + 1) + '</span>' +
        '<span style="flex:1;font-size:13px;">' + escapeHtml(l.display_name) + '</span>' +
        '<span class="muted" style="font-size:12px;">' + l.review_count + ' 张 · 正确 ' + l.good_count + '</span></div>'
      ).join('') + '</div>';
  } catch (_) {}
}

// ── 随机组卷 ──

function bindAutoPaper() {
  document.getElementById('student-questions').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action="auto-paper"]');
    if (btn) {
      try {
        const subject = document.getElementById('qf-subject')?.value || '';
        const res = await fetchJSON('/api/questions/auto-paper', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subject, count: 20 })
        });
        if (!res.questionIds.length) { createToast('没有找到题目。', 'error'); return; }
        createToast('已生成 ' + res.questionIds.length + ' 道随机题目，开始练习。', 'success');
        // 加载这些题目
        const qRes = await fetchJSON('/api/questions?limit=200');
        const filtered = (qRes.questions || []).filter((q) => res.questionIds.includes(q.id));
        document.getElementById('qtab-all').innerHTML = filtered.map((q) => renderQuestionCard(q)).join('');
      } catch (err) { createToast(err.message, 'error'); }
    }
  });
}

// ── 商城推荐 & 拼团 ──

async function loadRecommendedProducts() {
  try {
    const res = await fetchJSON('/api/products/recommended');
    const container = document.getElementById('student-products-list');
    if (!container || !res.products.length) return;
    const recDiv = document.createElement('div');
    recDiv.className = 'paper-card';
    recDiv.style.marginBottom = '16px';
    recDiv.innerHTML = '<h4 style="margin:0 0 10px;color:var(--brand);">为你推荐</h4>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;">' +
      res.products.map((p) =>
        '<div style="border:1px solid var(--border);border-radius:10px;padding:10px;text-align:center;">' +
        '<div style="font-size:13px;font-weight:600;">' + escapeHtml(p.title) + '</div>' +
        '<div style="font-size:16px;font-weight:700;color:var(--brand);margin-top:6px;">¥' + p.price + '</div>' +
        (p.originalPrice > p.price ? '<div style="font-size:11px;text-decoration:line-through;color:var(--muted);">¥' + p.originalPrice + '</div>' : '') +
        '</div>'
      ).join('') + '</div>';
    container.insertBefore(recDiv, container.firstChild);
  } catch (_) {}
}

async function loadGroupBuys() {
  try {
    const res = await fetchJSON('/api/group-buys');
    const container = document.getElementById('student-store');
    if (!container || !res.groupBuys.length) return;
    let gbDiv = document.getElementById('group-buys-area');
    if (!gbDiv) {
      gbDiv = document.createElement('div');
      gbDiv.id = 'group-buys-area';
      gbDiv.style.cssText = 'margin-top:16px;padding:16px;border:1px solid var(--brand-light);border-radius:12px;background:#fefce8;';
      container.insertBefore(gbDiv, container.querySelector('#student-products-list'));
    }
    gbDiv.innerHTML = '<h4 style="margin:0 0 10px;color:#92400e;">限时拼团</h4>' +
      res.groupBuys.map((g) =>
        '<div style="display:flex;align-items:center;gap:12px;padding:10px;background:#fff;border-radius:8px;margin-bottom:8px;">' +
        '<div style="flex:1;"><div style="font-size:13px;font-weight:600;">' + escapeHtml(g.product_title) + '</div>' +
        '<div style="font-size:12px;color:#92400e;">拼团价 ¥' + g.groupPrice + ' · 已拼 ' + g.currentCount + '/' + g.targetCount + ' 人</div></div>' +
        '<button class="button" style="font-size:11px;padding:4px 12px;" data-action="join-group" data-id="' + g.id + '">参与拼团</button></div>'
      ).join('');
  } catch (_) {}
}

// ── AI 助手面板 ──

function bindAIAssistant() {
  const panel = document.getElementById('student-daily');
  if (!panel) return;
  const aiArea = document.createElement('div');
  aiArea.id = 'ai-assistant-area';
  aiArea.style.cssText = 'margin-top:18px;padding:16px;border:1px solid var(--brand-light);border-radius:12px;background:linear-gradient(135deg,#eff6ff,#f0f9ff);';
  aiArea.innerHTML = '<h3 style="margin:0 0 12px;color:#1e40af;">AI 智能助手</h3>' +
    '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;">' +
    '<button class="tab-button active" data-ai-tab="tutor" type="button">AI答疑</button>' +
    '<button class="tab-button" data-ai-tab="essay" type="button">作文批改</button>' +
    '<button class="tab-button" data-ai-tab="plan" type="button">学习计划</button>' +
    '<button class="tab-button" data-ai-tab="summary" type="button">智能摘要</button>' +
    '</div>' +
    '<div id="ai-tutor-panel"><textarea id="ai-input" class="textarea" placeholder="输入你的问题..." style="min-height:80px;"></textarea>' +
    '<button class="button" id="ai-submit-btn" type="button" style="margin-top:8px;">提问</button></div>' +
    '<div id="ai-response" style="margin-top:12px;display:none;padding:12px;background:#fff;border-radius:10px;border:1px solid var(--border);max-height:300px;overflow:auto;"></div>';
  panel.appendChild(aiArea);

  // Tab switching
  aiArea.querySelectorAll('[data-ai-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      aiArea.querySelectorAll('[data-ai-tab]').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const type = tab.dataset.aiTab;
      const input = document.getElementById('ai-input');
      if (type === 'tutor') input.placeholder = '输入你的问题...';
      else if (type === 'essay') input.placeholder = '粘贴你的考研英语作文...';
      else if (type === 'plan') input.placeholder = '点击下方按钮获取个性化学习计划';
      else if (type === 'summary') input.placeholder = '粘贴需要摘要的长文本内容...';
    });
  });

  document.getElementById('ai-submit-btn').addEventListener('click', async () => {
    const input = document.getElementById('ai-input');
    const text = input.value.trim();
    if (!text) return;
    const activeTab = aiArea.querySelector('[data-ai-tab].active');
    const type = activeTab ? activeTab.dataset.aiTab : 'tutor';
    const responseDiv = document.getElementById('ai-response');
    responseDiv.style.display = 'block';
    responseDiv.innerHTML = '<div style="color:var(--muted);">AI 正在思考...</div>';

    try {
      let endpoint = '/api/ai/tutor';
      let body = { question: text };
      if (type === 'essay') { endpoint = '/api/ai/essay-grade'; body = { essay: text, type: '大作文' }; }
      else if (type === 'plan') { endpoint = '/api/ai/study-plan'; body = {}; }
      else if (type === 'summary') { endpoint = '/api/ai/summary'; body = { content: text, type: '帖子' }; }

      const res = await fetchJSON(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      responseDiv.innerHTML = '<div style="font-size:13px;white-space:pre-wrap;line-height:1.6;">' + escapeHtml(res.response) + '</div>';
    } catch (e) {
      responseDiv.innerHTML = '<div style="color:#ef4444;">' + escapeHtml(e.message) + '</div>';
    }
  });
}

// ── 虚拟商品下载 ──

function bindVirtualGoods() {
  document.getElementById('student-store').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action="download-virtual"]');
    if (btn) {
      try {
        const res = await fetchJSON('/api/orders/' + btn.dataset.orderId + '/download');
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:2000;display:flex;align-items:center;justify-content:center;';
        overlay.innerHTML = '<div style="background:#fff;border-radius:16px;padding:30px;max-width:500px;width:90%;"><h3>虚拟商品内容</h3>' +
          '<div style="margin-top:12px;white-space:pre-wrap;font-size:13px;max-height:400px;overflow:auto;padding:12px;border:1px solid var(--border);border-radius:8px;">' + escapeHtml(res.content) + '</div>' +
          '<div style="text-align:center;margin-top:16px;"><button class="ghost-button" onclick="this.closest(\'div[style*=fixed]\').remove()">关闭</button></div></div>';
        overlay.addEventListener('click', (ev) => { if (ev.target === overlay) overlay.remove(); });
        document.body.appendChild(overlay);
      } catch (err) { createToast(err.message, 'error'); }
    }
    // 拼团参与
    const joinGroupBtn = e.target.closest('[data-action="join-group"]');
    if (joinGroupBtn) {
      try {
        const res = await fetchJSON('/api/group-buys/' + joinGroupBtn.dataset.id + '/join', { method: 'POST' });
        createToast('已参与拼团！当前 ' + res.currentCount + '/' + res.targetCount + ' 人。', 'success');
        loadGroupBuys();
      } catch (err) { createToast(err.message, 'error'); }
    }
    // 习惯打卡
    const checkHabitBtn = e.target.closest('[data-action="check-habit"]');
    if (checkHabitBtn) {
      try {
        await fetchJSON('/api/habits/' + checkHabitBtn.dataset.id + '/check', { method: 'POST' });
        loadHabits();
      } catch (err) { createToast(err.message, 'error'); }
    }
    // 删除习惯
    const deleteHabitBtn = e.target.closest('[data-action="delete-habit"]');
    if (deleteHabitBtn) {
      try {
        await fetchJSON('/api/habits/' + deleteHabitBtn.dataset.id, { method: 'DELETE' });
        loadHabits();
      } catch (err) { createToast(err.message, 'error'); }
    }
  });
}

function safeJsonParse(str, fallback) {
  try { return JSON.parse(str); } catch (_) { return fallback; }
}

// ── AI 专用 tab 绑定 ──

function bindAISection() {
  const aiPanel = document.getElementById('student-ai');
  if (!aiPanel) return;

  aiPanel.querySelectorAll('[data-ai-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      aiPanel.querySelectorAll('[data-ai-tab]').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const type = tab.dataset.aiTab;
      const input = document.getElementById('ai-main-input');
      if (type === 'tutor') input.placeholder = '输入你的问题...';
      else if (type === 'essay') input.placeholder = '粘贴你的考研英语作文...';
      else if (type === 'plan') input.placeholder = '点击发送获取个性化学习计划';
      else if (type === 'summary') input.placeholder = '粘贴需要摘要的长文本内容...';
    });
  });

  document.getElementById('ai-main-submit').addEventListener('click', async () => {
    const input = document.getElementById('ai-main-input');
    const text = input.value.trim();
    if (!text && input.placeholder.includes('粘贴')) return;
    const activeTab = aiPanel.querySelector('[data-ai-tab].active');
    const type = activeTab ? activeTab.dataset.aiTab : 'tutor';
    const responseDiv = document.getElementById('ai-main-response');
    responseDiv.style.display = 'block';
    responseDiv.innerHTML = '<div style="color:var(--muted);">AI 正在思考...</div>';

    try {
      let endpoint = '/api/ai/tutor';
      let body = { question: text };
      if (type === 'essay') { endpoint = '/api/ai/essay-grade'; body = { essay: text, type: '大作文' }; }
      else if (type === 'plan') { endpoint = '/api/ai/study-plan'; body = {}; }
      else if (type === 'summary') { endpoint = '/api/ai/summary'; body = { content: text, type: '帖子' }; }

      const res = await fetchJSON(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      responseDiv.innerHTML = '<div style="font-size:13px;white-space:pre-wrap;line-height:1.6;">' + escapeHtml(res.response) + '</div>';
    } catch (e) {
      responseDiv.innerHTML = '<div style="color:#ef4444;">' + escapeHtml(e.message) + '</div>';
    }
  });
}
