// student-social.js — Global search, daily questions, search suggestions

// ── 全局搜索 ──

function bindGlobalSearch() {
  const searchBtn = document.getElementById('global-search-btn');
  const searchInput = document.getElementById('global-search-input');
  if (!searchBtn || !searchInput) return;

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
