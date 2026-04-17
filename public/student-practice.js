// student-practice.js — Question rendering, practice mode, wrong review, auto paper, question notes

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
