// student-flashcards.js — Flashcards, checkin calendar, achievements, flashcard goal, leaderboard

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
