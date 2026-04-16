const forumState = {
  user: null,
  token: null,
  topics: [],
  selectedCategory: '',
  searchKeyword: '',
  sortMode: 'latest',
  showFavoritesOnly: false,
  selectedHashtag: '',
  _searchTimer: null
};

const categories = ['全部', '考研交流', '备考规划', '阶段复盘', '经验分享', '答疑互助'];

document.addEventListener('DOMContentLoaded', async () => {
  const authResult = await ensureAuth().catch(() => null);
  if (!authResult) return;

  forumState.user = authResult.user;
  forumState.token = authResult.token;

  const backLink = document.querySelector('.forum-header-left a');
  if (forumState.user.role === 'student') {
    backLink.href = '/student';
  } else if (forumState.user.role === 'admin') {
    backLink.href = '/admin';
  }

  document.getElementById('forum-user-name').textContent =
    `${forumState.user.displayName} (${forumState.user.role === 'teacher' ? '老师' : forumState.user.role === 'admin' ? '管理员' : '同学'})`;

  renderCategoryBar();
  bindEvents();
  loadHashtags();
  await loadTopics();
});

function renderCategoryBar() {
  const bar = document.getElementById('category-bar');
  bar.innerHTML = categories.map((cat) =>
    `<button class="category-chip ${cat === '全部' && !forumState.selectedCategory ? 'active' : cat === forumState.selectedCategory ? 'active' : ''}" data-category="${cat === '全部' ? '' : cat}" type="button">${cat}</button>`
  ).join('');
}

async function loadHashtags() {
  try {
    const result = await fetchJSON('/api/forum/hashtags');
    const bar = document.getElementById('hashtag-bar');
    if (!result.hashtags.length) {
      bar.innerHTML = '';
      return;
    }
    bar.innerHTML = result.hashtags.slice(0, 10).map((h) =>
      `<button class="hashtag-chip ${forumState.selectedHashtag === h.name ? 'active' : ''}" data-hashtag="${escapeHtml(h.name)}" type="button">#${escapeHtml(h.name)}# <span class="muted" style="font-size:11px;">${h.count}</span></button>`
    ).join('');
  } catch (_) {}
}

function bindEvents() {
  document.getElementById('category-bar').addEventListener('click', (event) => {
    const chip = event.target.closest('.category-chip');
    if (!chip) return;
    forumState.selectedCategory = chip.dataset.category;
    renderCategoryBar();
    loadTopics();
  });

  // 话题标签筛选
  document.getElementById('hashtag-bar').addEventListener('click', (event) => {
    const chip = event.target.closest('.hashtag-chip');
    if (!chip) return;
    const tag = chip.dataset.hashtag;
    forumState.selectedHashtag = forumState.selectedHashtag === tag ? '' : tag;
    loadHashtags();
    loadTopics();
  });

  // 搜索（防抖）
  document.getElementById('forum-search').addEventListener('input', (event) => {
    forumState.searchKeyword = event.target.value.trim();
    clearTimeout(forumState._searchTimer);
    forumState._searchTimer = setTimeout(() => loadTopics(), 400);
  });

  // 排序
  document.getElementById('forum-sort').addEventListener('change', (event) => {
    forumState.sortMode = event.target.value;
    loadTopics();
  });

  // 我的收藏
  document.getElementById('forum-my-favs').addEventListener('click', () => {
    forumState.showFavoritesOnly = !forumState.showFavoritesOnly;
    const btn = document.getElementById('forum-my-favs');
    btn.style.background = forumState.showFavoritesOnly ? 'var(--brand)' : '';
    btn.style.color = forumState.showFavoritesOnly ? '#fff' : '';
    loadTopics();
  });

  // 新帖弹窗
  document.getElementById('new-post-btn').addEventListener('click', () => {
    document.getElementById('new-post-modal').classList.remove('hidden');
  });
  document.getElementById('close-modal-btn').addEventListener('click', () => {
    document.getElementById('new-post-modal').classList.add('hidden');
  });
  document.getElementById('new-post-modal').addEventListener('click', (event) => {
    if (event.target.id === 'new-post-modal') {
      document.getElementById('new-post-modal').classList.add('hidden');
    }
  });

  document.getElementById('new-topic-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await fetchJSON('/api/forum/topics', {
        method: 'POST',
        body: new FormData(form)
      });
      createToast('帖子已发布。', 'success');
      form.reset();
      document.getElementById('new-post-modal').classList.add('hidden');
      await loadTopics();
      loadHashtags();
    } catch (error) {
      createToast(error.message, 'error');
    }
  });

  // 帖子列表事件委托
  document.getElementById('topics-list').addEventListener('click', (event) => {
    const titleEl = event.target.closest('.topic-title');
    if (titleEl) {
      location.href = '/forum/topic/' + titleEl.dataset.topicId;
      return;
    }
    // 展开全文
    const expandBtn = event.target.closest('[data-action="expand-content"]');
    if (expandBtn) {
      const contentEl = expandBtn.previousElementSibling;
      contentEl.classList.remove('topic-content-collapsed');
      expandBtn.remove();
      return;
    }
    // 图片 lightbox
    const imgEl = event.target.closest('[data-action="lightbox"]');
    if (imgEl) {
      const overlay = document.createElement('div');
      overlay.className = 'lightbox-overlay';
      overlay.innerHTML = `<img src="${escapeHtml(imgEl.dataset.src)}" />`;
      overlay.addEventListener('click', () => overlay.remove());
      document.body.appendChild(overlay);
      return;
    }
    // 话题标签点击
    const hashtagEl = event.target.closest('.hashtag-highlight');
    if (hashtagEl) {
      const tag = hashtagEl.textContent.replace(/#/g, '');
      forumState.selectedHashtag = tag;
      loadHashtags();
      loadTopics();
      return;
    }
  });
}

async function loadTopics() {
  try {
    if (forumState.showFavoritesOnly) {
      const params = new URLSearchParams();
      if (forumState.selectedCategory) params.set('category', forumState.selectedCategory);
      const result = await fetchJSON('/api/forum/topics/favorites?' + params.toString());
      forumState.topics = result.topics;
      renderTopics();
      return;
    }

    const params = new URLSearchParams();
    if (forumState.selectedCategory) params.set('category', forumState.selectedCategory);
    if (forumState.searchKeyword) params.set('search', forumState.searchKeyword);
    if (forumState.sortMode === 'hot') params.set('sort', 'hot');
    if (forumState.selectedHashtag) params.set('hashtag', forumState.selectedHashtag);
    const result = await fetchJSON('/api/forum/topics?' + params.toString());
    forumState.topics = result.topics;
    renderTopics();
  } catch (error) {
    createToast('加载失败：' + error.message, 'error');
  }
}

function renderHashtagsInText(text) {
  return text.replace(/#([^#\s]+)#/g, '<span class="hashtag-highlight" style="cursor:pointer;">#$1#</span>');
}

function renderTopics() {
  const root = document.getElementById('topics-list');
  if (!forumState.topics.length) {
    root.innerHTML = forumState.showFavoritesOnly
      ? buildEmptyState('没有收藏帖子', '浏览帖子时点击收藏按钮即可收藏。')
      : buildEmptyState('社区还是空的', '发一条备考交流贴，和同学一起讨论。');
    return;
  }

  root.innerHTML = forumState.topics.map((topic) => {
    const authorInitial = (topic.authorName || '?')[0];
    const replyCount = topic.replies ? topic.replies.length : 0;
    const isLong = (topic.content || '').length > 100;
    const contentPreview = isLong ? topic.content.slice(0, 100) : topic.content;

    // 图片九宫格
    let imagesHtml = '';
    if (topic.imagePaths && topic.imagePaths.length) {
      const images = topic.imagePaths;
      const displayImages = images.slice(0, 6);
      const extra = images.length > 6 ? images.length - 6 : 0;
      imagesHtml = `
        <div class="topic-images-grid">
          ${displayImages.map((src, i) => `
            <div class="topic-image-item" style="position:relative;">
              <img src="${escapeHtml(src)}" data-action="lightbox" data-src="${escapeHtml(src)}" />
              ${i === displayImages.length - 1 && extra > 0 ? `<div class="topic-image-more">+${extra}</div>` : ''}
            </div>
          `).join('')}
        </div>
      `;
    }

    // 话题标签
    const tagsHtml = topic.hashtags && topic.hashtags.length
      ? `<div style="margin-top:6px;">${topic.hashtags.map((t) => `<span class="hashtag-highlight" style="cursor:pointer;margin-right:4px;">#${escapeHtml(t)}#</span>`).join('')}</div>`
      : '';

    // 增强标签
    const badges = [];
    if (topic.isPinned) badges.push('<span class="badge" style="background:#ef4444;color:#fff;margin-right:4px;">置顶</span>');
    if (topic.isFeatured) badges.push('<span class="badge" style="background:#f59e0b;color:#fff;margin-right:4px;">精华</span>');

    const isTeacherOrAdmin = forumState.user && (forumState.user.role === 'teacher' || forumState.user.role === 'admin');
    const manageButtons = isTeacherOrAdmin ?
      '<span style="margin-left:8px;"><button data-action="pin" data-id="' + topic.id + '" data-val="' + topic.isPinned + '" style="font-size:10px;padding:2px 6px;border:none;background:none;color:var(--brand);cursor:pointer;">' + (topic.isPinned ? '取消置顶' : '置顶') + '</button>' +
      '<button data-action="feature" data-id="' + topic.id + '" data-val="' + topic.isFeatured + '" style="font-size:10px;padding:2px 6px;border:none;background:none;color:var(--brand);cursor:pointer;">' + (topic.isFeatured ? '取消精华' : '加精') + '</button></span>' : '';

    return `
      <div class="topic-card">
        <div class="topic-author">
          <div class="author-avatar">${escapeHtml(authorInitial)}</div>
          <div>
            <strong style="font-size:14px;">${escapeHtml(topic.authorName)}</strong>
            <span class="badge" style="margin-left:6px;font-size:11px;">${escapeHtml(topic.authorRole === 'teacher' ? '老师' : topic.authorRole === 'admin' ? '管理员' : '同学')}</span>
            <button data-action="follow" data-user-id="${topic.authorId || ''}" style="font-size:10px;padding:2px 8px;border:1px solid var(--border);border-radius:10px;background:none;cursor:pointer;margin-left:6px;">关注</button>
            <div class="topic-meta">${escapeHtml(topic.category)} · ${escapeHtml(formatDateTime(topic.createdAt))}</div>
          </div>
        </div>
        <h3 class="topic-title" data-topic-id="${topic.id}">${badges.join('')}${escapeHtml(topic.title)}</h3>
        <div class="topic-content topic-content-collapsed">${renderHashtagsInText(escapeHtml(contentPreview))}</div>
        ${isLong ? `<button class="expand-btn" data-action="expand-content" type="button">展开全文</button>` : ''}
        ${tagsHtml}
        ${imagesHtml}
        <div class="topic-footer">
          <span style="cursor:pointer;">${replyCount} 条回复</span>
          <span>${topic.likedByMe ? '&#10084;' : '&#9825;'} ${topic.likeCount || 0}</span>
          ${topic.favoritedByMe ? '<span>&#9733; 已收藏</span>' : ''}
          <button data-action="endorse" data-id="${topic.id}" style="font-size:11px;padding:2px 8px;border:1px solid var(--border);border-radius:10px;background:none;cursor:pointer;">赞同${topic.endorseCount ? ' ' + topic.endorseCount : ''}</button>
          <button data-action="report" data-id="${topic.id}" style="font-size:10px;padding:2px 6px;border:none;background:none;color:var(--muted);cursor:pointer;">举报</button>
          ${manageButtons}
        </div>
      </div>
    `;
  }).join('');
}

// Lightbox (全局)
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

// ===== 第二阶段论坛增强 =====

// 加载热门话题
async function loadTrending() {
  try {
    const res = await fetchJSON('/api/forum/trending');
    const container = document.getElementById('trending-area');
    if (!container) return;
    if (!res.trending.length) { container.innerHTML = ''; return; }
    container.innerHTML = '<h4 style="margin:0 0 8px;font-size:14px;">热门话题</h4>' +
      res.trending.slice(0, 10).map((t, i) =>
        '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;cursor:pointer;" class="topic-title" data-topic-id="' + t.id + '">' +
        '<span style="width:20px;text-align:center;font-weight:700;color:' + (i < 3 ? '#ef4444' : 'var(--muted)') + ';">' + (i + 1) + '</span>' +
        '<span style="flex:1;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(t.title) + '</span>' +
        '<span style="font-size:11px;color:var(--muted);">' + t.score + '</span></div>'
      ).join('');
  } catch (_) {}
}

// 在帖子卡片中添加置顶/精华标识和赞同/举报按钮
function renderTopicEnhancements() {
  document.getElementById('topics-list').addEventListener('click', async (e) => {
    // 赞同
    const endorseBtn = e.target.closest('[data-action="endorse"]');
    if (endorseBtn) {
      try {
        const res = await fetchJSON('/api/forum/topics/' + endorseBtn.dataset.id + '/endorse', { method: 'POST' });
        endorseBtn.textContent = res.endorsed ? '已赞同' : '赞同';
        endorseBtn.style.color = res.endorsed ? '#22c55e' : '';
        loadTopics();
      } catch (err) { createToast(err.message, 'error'); }
      return;
    }
    // 举报
    const reportBtn = e.target.closest('[data-action="report"]');
    if (reportBtn) {
      const reason = prompt('请输入举报原因：');
      if (!reason) return;
      try {
        await fetchJSON('/api/reports', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetType: 'topic', targetId: reportBtn.dataset.id, reason })
        });
        createToast('举报已提交，感谢反馈。', 'success');
      } catch (err) { createToast(err.message, 'error'); }
      return;
    }
    // 关注
    const followBtn = e.target.closest('[data-action="follow"]');
    if (followBtn) {
      try {
        const res = await fetchJSON('/api/users/' + followBtn.dataset.userId + '/follow', { method: 'POST' });
        followBtn.textContent = res.following ? '已关注' : '关注';
        followBtn.style.color = res.following ? '#22c55e' : '';
      } catch (err) { createToast(err.message, 'error'); }
      return;
    }
    // 置顶
    const pinBtn = e.target.closest('[data-action="pin"]');
    if (pinBtn) {
      try {
        await fetchJSON('/api/forum/topics/' + pinBtn.dataset.id + '/pin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pinned: pinBtn.dataset.val === '1' ? 0 : 1 })
        });
        loadTopics();
      } catch (err) { createToast(err.message, 'error'); }
      return;
    }
    // 精华
    const featureBtn = e.target.closest('[data-action="feature"]');
    if (featureBtn) {
      try {
        await fetchJSON('/api/forum/topics/' + featureBtn.dataset.id + '/feature', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ featured: featureBtn.dataset.val === '1' ? 0 : 1 })
        });
        loadTopics();
      } catch (err) { createToast(err.message, 'error'); }
      return;
    }
  });
}

// 初始化增强功能
loadTrending();
renderTopicEnhancements();
