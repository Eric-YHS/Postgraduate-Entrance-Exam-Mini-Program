// student-stats.js — Stats panel, heatmap, report export, exam countdown, habits

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
  countdownArea.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;"><div><div style="font-size:13px;opacity:0.7;">考研倒计时</div><div id="exam-countdown-display" style="font-size:36px;font-weight:700;margin:4px 0;">加载中...</div><div id="exam-countdown-name" style="font-size:12px;opacity:0.6;"></div></div><div><button class="ghost-button" id="exam-countdown-set" type="button" style="color:#fff;background:rgba(255,255,255,0.15);border-color:rgba(255,255,255,0.3);font-size:12px;padding:4px 12px;">设置日期</button></div></div>';
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
