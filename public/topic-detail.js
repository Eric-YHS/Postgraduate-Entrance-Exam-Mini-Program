const detailState = {
  user: null,
  token: null,
  topicId: Number(location.pathname.split('/').pop()) || 0,
  topic: null,
  replyingTo: null // { id, authorName }
};

document.addEventListener('DOMContentLoaded', async () => {
  const authResult = await ensureAuth().catch(() => null);
  if (!authResult) return;

  detailState.user = authResult.user;
  detailState.token = authResult.token;

  document.getElementById('detail-user-name').textContent =
    `${detailState.user.displayName} (${detailState.user.role === 'teacher' ? '老师' : detailState.user.role === 'admin' ? '管理员' : '同学'})`;

  bindDetailEvents();
  await loadTopic();
});

async function loadTopic() {
  try {
    const result = await fetchJSON('/api/forum/topics/' + detailState.topicId);
    detailState.topic = result.topic;
    renderDetail();
  } catch (error) {
    document.getElementById('topic-detail').innerHTML =
      `<div class="detail-card"><p class="muted">帖子不存在或加载失败。</p><a class="button" href="/forum" style="display:inline-block;margin-top:12px;">返回社区</a></div>`;
  }
}

function renderDetailMedia(item) {
  let html = '';
  if (item.imagePaths && item.imagePaths.length) {
    html += `<div class="media-image-grid">${item.imagePaths.map((src) =>
      `<img class="media-thumbnail" src="${escapeHtml(src)}" data-action="lightbox" data-src="${escapeHtml(src)}" />`
    ).join('')}</div>`;
  }
  if (item.videoPaths && item.videoPaths.length) {
    html += item.videoPaths.map((src) =>
      `<video class="video-frame" controls src="${escapeHtml(src)}" style="margin-top:10px;"></video>`
    ).join('');
  }
  if (item.attachmentPaths && item.attachmentPaths.length) {
    html += `<div class="inline-actions" style="margin-top:10px;">${item.attachmentPaths.map((src) =>
      `<a class="badge" href="${escapeHtml(src)}" target="_blank">附件下载</a>`
    ).join('')}</div>`;
  }
  if (item.links && item.links.length) {
    html += `<div class="inline-actions" style="margin-top:10px;">${item.links.map((link) =>
      `<a class="badge badge-brand" href="${escapeHtml(link.url || link)}" target="_blank">${escapeHtml(link.title || link.url || link)}</a>`
    ).join('')}</div>`;
  }
  return html ? `<div class="detail-media">${html}</div>` : '';
}

function renderReplyMedia(reply) {
  let html = '';
  if (reply.imagePaths && reply.imagePaths.length) {
    html += `<div class="media-image-grid">${reply.imagePaths.map((src) =>
      `<img class="media-thumbnail" src="${escapeHtml(src)}" data-action="lightbox" data-src="${escapeHtml(src)}" />`
    ).join('')}</div>`;
  }
  if (reply.videoPaths && reply.videoPaths.length) {
    html += reply.videoPaths.map((src) =>
      `<video class="video-frame" controls src="${escapeHtml(src)}" style="margin-top:8px;max-height:300px;"></video>`
    ).join('');
  }
  return html ? `<div class="reply-media">${html}</div>` : '';
}

function renderHashtags(text) {
  return text.replace(/#([^#\s]+)#/g, '<span class="hashtag-highlight">#$1#</span>');
}

function buildReplyTree(replies) {
  const map = {};
  const roots = [];
  replies.forEach((r) => {
    map[r.id] = { ...r, children: [] };
  });
  replies.forEach((r) => {
    if (r.replyToId && map[r.replyToId]) {
      map[r.replyToId].children.push(map[r.id]);
    } else {
      roots.push(map[r.id]);
    }
  });
  return roots;
}

function renderNestedReply(reply) {
  const replyInitial = (reply.authorName || '?')[0];
  const replyRole = reply.authorRole === 'teacher' ? '老师' : reply.authorRole === 'admin' ? '管理员' : '同学';
  const replyPrefix = reply.replyToUser ? `<span class="muted" style="font-size:12px;">回复 @${escapeHtml(reply.replyToUser)}：</span>` : '';

  let childrenHtml = '';
  if (reply.children && reply.children.length) {
    childrenHtml = `<div class="nested-replies">${reply.children.map((c) => renderNestedReply(c)).join('')}</div>`;
  }

  return `
    <div class="reply-item" data-reply-id="${reply.id}">
      <div class="reply-avatar">${escapeHtml(replyInitial)}</div>
      <div class="reply-body">
        <span class="reply-author">${escapeHtml(reply.authorName)}</span>
        <span class="badge" style="font-size:10px;margin-left:4px;">${escapeHtml(replyRole)}</span>
        <span class="reply-time">${escapeHtml(formatDateTime(reply.createdAt))}</span>
        <p class="reply-text">${replyPrefix}${escapeHtml(reply.content)}</p>
        ${renderReplyMedia(reply)}
        <div class="reply-actions">
          <button class="reply-action-btn" data-action="reply-to" data-reply-id="${reply.id}" data-author-name="${escapeHtml(reply.authorName)}" type="button">回复</button>
        </div>
        ${childrenHtml}
      </div>
    </div>
  `;
}

function renderDetail() {
  const topic = detailState.topic;
  const root = document.getElementById('topic-detail');
  const authorInitial = (topic.authorName || '?')[0];
  const roleLabel = topic.authorRole === 'teacher' ? '老师' : topic.authorRole === 'admin' ? '管理员' : '同学';

  // 构建嵌套回复树
  const replyTree = buildReplyTree(topic.replies);
  const repliesHtml = replyTree.length
    ? replyTree.map((r) => renderNestedReply(r)).join('')
    : '<p class="muted">暂无回复，来说两句吧。</p>';

  // 话题标签
  const hashtagsHtml = topic.hashtags && topic.hashtags.length
    ? `<div class="inline-actions" style="margin-top:8px;">${topic.hashtags.map((t) => `<span class="hashtag-highlight">#${escapeHtml(t)}#</span>`).join(' ')}</div>`
    : '';

  root.innerHTML = `
    <div class="detail-card">
      <div class="detail-author">
        <div class="detail-avatar">${escapeHtml(authorInitial)}</div>
        <div class="detail-author-info">
          <div class="detail-author-name">${escapeHtml(topic.authorName)} <span class="badge" style="font-size:10px;">${escapeHtml(roleLabel)}</span></div>
          <div class="detail-author-meta">${escapeHtml(topic.category)} · ${escapeHtml(formatDateTime(topic.createdAt))}</div>
        </div>
      </div>
      <h1 class="detail-title">${escapeHtml(topic.title)}</h1>
      <div class="detail-body">${renderHashtags(escapeHtml(topic.content))}</div>
      ${hashtagsHtml}
      ${renderDetailMedia(topic)}
      <div class="action-bar">
        <button class="action-btn ${topic.likedByMe ? 'liked' : ''}" id="like-btn" type="button">
          <span class="icon">${topic.likedByMe ? '&#10084;' : '&#9825;'}</span>
          <span class="count" id="like-count">${topic.likeCount || 0}</span>
        </button>
        <button class="action-btn ${topic.favoritedByMe ? 'liked' : ''}" id="fav-btn" type="button">
          <span class="icon">${topic.favoritedByMe ? '&#9733;' : '&#9734;'}</span>
          <span>${topic.favoritedByMe ? '已收藏' : '收藏'}</span>
        </button>
        <button class="action-btn" id="share-btn" type="button">
          <span class="icon">&#128279;</span>
          <span>分享</span>
        </button>
        <span class="muted" style="margin-left:auto;font-size:13px;">${topic.replies.length} 条回复</span>
      </div>
    </div>

    <div class="replies-section">
      <h2 class="replies-title">全部回复 (${topic.replies.length})</h2>
      ${repliesHtml}
    </div>

    <div class="reply-form-card">
      <h3>写回复${detailState.replyingTo ? ` · 回复 @${escapeHtml(detailState.replyingTo.authorName)}` : ''}</h3>
      ${detailState.replyingTo ? `<button class="ghost-button" data-action="cancel-reply-to" type="button" style="font-size:12px;padding:4px 10px;margin-bottom:8px;">取消回复</button>` : ''}
      <form id="reply-form">
        <textarea id="reply-content" placeholder="写下你的回复..." rows="3"></textarea>
        <div class="reply-form-actions">
          <input id="reply-images" type="file" accept="image/*" multiple style="font-size:12px;" />
          <button class="button" type="submit" style="font-size:13px;padding:8px 20px;">发布回复</button>
        </div>
      </form>
    </div>
  `;
}

function bindDetailEvents() {
  const root = document.getElementById('topic-detail');

  root.addEventListener('click', async (event) => {
    // 点赞
    const likeBtn = event.target.closest('#like-btn');
    if (likeBtn) {
      try {
        const result = await fetchJSON('/api/forum/topics/' + detailState.topicId + '/like', { method: 'POST' });
        detailState.topic.likedByMe = result.liked;
        detailState.topic.likeCount = result.likeCount;
        likeBtn.className = 'action-btn' + (result.liked ? ' liked' : '');
        likeBtn.querySelector('.icon').innerHTML = result.liked ? '&#10084;' : '&#9825;';
        document.getElementById('like-count').textContent = result.likeCount;
      } catch (error) {
        createToast(error.message, 'error');
      }
      return;
    }

    // 收藏
    const favBtn = event.target.closest('#fav-btn');
    if (favBtn) {
      try {
        const result = await fetchJSON('/api/forum/topics/' + detailState.topicId + '/favorite', { method: 'POST' });
        detailState.topic.favoritedByMe = result.favorited;
        favBtn.className = 'action-btn' + (result.favorited ? ' liked' : '');
        favBtn.querySelector('.icon').innerHTML = result.favorited ? '&#9733;' : '&#9734;';
        favBtn.querySelector('span:last-child').textContent = result.favorited ? '已收藏' : '收藏';
        createToast(result.favorited ? '已收藏。' : '已取消收藏。', 'success');
      } catch (error) {
        createToast(error.message, 'error');
      }
      return;
    }

    // 分享
    const shareBtn = event.target.closest('#share-btn');
    if (shareBtn) {
      try {
        await navigator.clipboard.writeText(location.href);
        createToast('链接已复制到剪贴板。', 'success');
      } catch {
        const input = document.createElement('input');
        input.value = location.href;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        input.remove();
        createToast('链接已复制到剪贴板。', 'success');
      }
      return;
    }

    // 楼中楼回复按钮
    const replyToBtn = event.target.closest('[data-action="reply-to"]');
    if (replyToBtn) {
      detailState.replyingTo = {
        id: Number(replyToBtn.dataset.replyId),
        authorName: replyToBtn.dataset.authorName
      };
      renderDetail();
      document.getElementById('reply-content').focus();
      return;
    }

    // 取消回复
    const cancelBtn = event.target.closest('[data-action="cancel-reply-to"]');
    if (cancelBtn) {
      detailState.replyingTo = null;
      renderDetail();
      return;
    }
  });

  // 回复提交
  root.addEventListener('submit', async (event) => {
    if (event.target.id !== 'reply-form') return;
    event.preventDefault();

    const content = document.getElementById('reply-content').value.trim();
    if (!content) {
      createToast('请输入回复内容。', 'error');
      return;
    }

    const fd = new FormData();
    fd.set('content', content);
    if (detailState.replyingTo) {
      fd.set('replyToId', String(detailState.replyingTo.id));
    }
    const fileInput = document.getElementById('reply-images');
    if (fileInput && fileInput.files.length) {
      for (const file of fileInput.files) {
        fd.append('images', file);
      }
    }

    try {
      await fetchJSON('/api/forum/topics/' + detailState.topicId + '/replies', {
        method: 'POST',
        body: fd
      });
      createToast('回复已发布。', 'success');
      detailState.replyingTo = null;
      await loadTopic();
    } catch (error) {
      createToast(error.message, 'error');
    }
  });

  // Lightbox
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
