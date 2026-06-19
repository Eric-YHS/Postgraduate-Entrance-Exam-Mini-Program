// student-courses.js — Course/cloud rendering, live sessions, video player, course notes

function renderCourses() {
  loadCourseCategories();
  loadStudentCloud(null);
}

async function loadCourseCategories() {
  try {
    const result = await fetchJSON('/api/course-categories');
    studentState.cloudState.categories = result.categories || [];
    renderCategoryTabs();
  } catch (_) {}
}

function renderCategoryTabs() {
  const tabs = document.getElementById('course-category-tabs');
  if (!tabs) return;
  const current = studentState.cloudState.categoryFilter || 'all';
  tabs.querySelectorAll('[data-course-category]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.courseCategory === current);
  });

  const majorSub = document.getElementById('course-major-subtabs');
  const majorCategories = studentState.cloudState.categories.filter((c) => c.type === 'major');
  if (current === 'major' && majorCategories.length) {
    majorSub.classList.remove('hidden');
    const subCurrent = studentState.cloudState.majorSubFilter || '';
    majorSub.innerHTML = `
      <button class="tab-button ${!subCurrent ? 'active' : ''}" data-major-sub="" type="button">全部方向</button>
      ${majorCategories.map((c) => `
        <button class="tab-button ${String(c.id) === subCurrent ? 'active' : ''}" data-major-sub="${c.id}" type="button">${escapeHtml(c.name)}</button>
      `).join('')}
    `;
  } else {
    majorSub.classList.add('hidden');
    majorSub.innerHTML = '';
  }
}

function itemMatchesCategoryFilter(item) {
  const filter = studentState.cloudState.categoryFilter || 'all';
  if (filter === 'all') return true;
  const cats = studentState.cloudState.categories || [];
  const subjectCats = cats.filter((c) => c.name === item.subject || (c.parentId && cats.find((p) => p.id === c.parentId && p.name === item.subject)));
  const itemTypes = subjectCats.length ? subjectCats.map((c) => c.type) : [];
  if (filter === 'public') return itemTypes.includes('public') || (!item.subject && !studentState.cloudState.majorSubFilter);
  if (filter === 'major') {
    if (!studentState.cloudState.majorSubFilter) return itemTypes.includes('major') || !item.subject;
    return subjectCats.some((c) => c.type === 'major' && String(c.id) === studentState.cloudState.majorSubFilter);
  }
  return true;
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

  // 按章节分组并渲染文件项
  const ig = document.getElementById('student-cloud-items-grid');
  const visibleItems = (cs.items || []).filter(itemMatchesCategoryFilter);

  if (!visibleItems.length) {
    ig.innerHTML = (!cs.folders.length ? '<p class="muted">当前文件夹为空。</p>' : '');
  } else {
    const groups = {};
    const ungrouped = [];
    visibleItems.forEach((item) => {
      if (item.chapterId && item.chapterTitle) {
        if (!groups[item.chapterId]) groups[item.chapterId] = { title: item.chapterTitle, items: [] };
        groups[item.chapterId].items.push(item);
      } else {
        ungrouped.push(item);
      }
    });

    let html = '';
    Object.values(groups).forEach((group) => {
      html += `<div style="margin-top:16px;"><h3 style="font-size:15px;color:var(--brand);margin-bottom:8px;">${escapeHtml(group.title)}</h3><div class="cloud-grid">${renderCloudItemCards(group.items)}</div></div>`;
    });
    if (ungrouped.length) {
      html += `<div class="cloud-grid" style="margin-top:14px;">${renderCloudItemCards(ungrouped)}</div>`;
    }
    ig.innerHTML = html;
  }

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

function renderCloudItemCards(items) {
  return items.map((item) => {
    const icon = item.itemType === 'video' ? '&#127909;' : item.itemType === 'audio' ? '&#127925;' : '&#128196;';
    const src = item.filePath || item.fileUrl;
    const isLocked = item.locked;
    const isFreePreview = item.isFreePreview;
    const badges = [];
    if (isLocked) badges.push('<span class="badge" style="background:#fee2e2;color:#991b1b;">锁定</span>');
    else if (isFreePreview) badges.push('<span class="badge" style="background:#dcfce7;color:#166534;">试看</span>');
    if (item.subject) badges.push(`<span class="badge badge-brand">${escapeHtml(item.subject)}</span>`);

    let actionHtml = '';
    if (isLocked) {
      actionHtml = `<button class="ghost-button" data-action="locked-content" data-item-id="${item.id}" type="button" style="font-size:12px;padding:4px 10px;">锁定</button>`;
    } else if (item.itemType === 'video' && src) {
      actionHtml = `<button class="ghost-button" data-action="play-video" data-item-id="${item.id}" data-src="${escapeHtml(src)}" data-title="${escapeHtml(item.title)}" type="button" style="font-size:12px;padding:4px 10px;">播放</button>`;
    } else if (src) {
      actionHtml = `<a class="ghost-button" href="${escapeHtml(src)}" target="_blank" style="font-size:12px;padding:4px 10px;">查看</a>`;
    }

    return `
      <div class="paper-card cloud-item">
        <div class="cloud-item-icon">${icon}</div>
        <strong>${escapeHtml(item.title)}</strong>
        ${badges.join('')}
        ${actionHtml}
      </div>
    `;
  }).join('');
}

function renderLiveSessions() {
  const root = document.getElementById('student-live-list');
  root.innerHTML = studentState.data.liveSessions.length
    ? studentState.data.liveSessions
        .map(
          (session) => {
            let actionHtml = '';
            if (session.status === 'live') {
              actionHtml = `<a class="button" href="/live/${session.id}" target="_blank" style="text-decoration: none;">进入直播间</a>`;
            } else if (session.status === 'ended') {
              if (session.recordingPath) {
                actionHtml = `<button class="ghost-button" data-action="play-recording" data-recording-path="${escapeHtml(session.recordingPath)}" data-title="${escapeHtml(session.title)}" type="button" style="font-size:12px;padding:6px 14px;">观看回放</button>`;
              } else {
                actionHtml = `<span class="muted" style="font-size:12px;padding:6px 14px;display:inline-block;">暂无回放</span>`;
              }
            }
            // pending / draft 显示预约按钮
            const reserveHtml = (session.status === 'pending' || session.status === 'draft')
              ? `<button class="ghost-button" data-action="reserve-live" data-id="${session.id}" type="button" style="font-size:12px;padding:4px 12px;">预约直播</button>`
              : '';

            return `
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
                ${actionHtml}
                ${reserveHtml}
              </div>
            </article>
          `;
          }
        )
        .join('')
    : buildEmptyState('还没有直播', '老师创建直播后，这里会出现进入入口。');
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

  // 视频播放 / 锁定提示事件委托
  document.getElementById('student-cloud-items-grid').addEventListener('click', async (event) => {
    const playBtn = event.target.closest('[data-action="play-video"]');
    if (playBtn) {
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
      if (studentState._saveInterval) clearInterval(studentState._saveInterval);
      studentState._saveInterval = setInterval(async () => {
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
            <div class="reply-item review-item" style="padding:8px 0;" data-review-id="${r.id}">
              <div>
                <strong style="font-size:13px;">${escapeHtml(r.studentName || '同学')}</strong>
                <span class="badge" style="font-size:10px;margin-left:6px;">${'&#9733;'.repeat(r.rating)}</span>
                <p style="font-size:13px;margin-top:4px;">${escapeHtml(r.content || '未写评价')}</p>
              </div>
              <button class="ghost-button like-review-btn" data-review-id="${r.id}" data-liked="${r.liked ? '1' : ''}" type="button" style="font-size:12px;padding:4px 8px;margin-top:6px;">
                ${r.liked ? '&#10084;' : '&#9825;'} ${r.likes || 0}
              </button>
            </div>
          `).join('') : '<p class="muted" style="font-size:12px;">暂无评价。</p>';

          // 绑定点赞事件
          reviewsList.querySelectorAll('.like-review-btn').forEach((btn) => {
            btn.addEventListener('click', async () => {
              const reviewId = btn.dataset.reviewId;
              try {
                const res = await fetchJSON('/api/course-reviews/' + reviewId + '/like', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                });
                btn.dataset.liked = res.liked ? '1' : '';
                const currentLikes = Number(btn.textContent?.trim().split(' ')[1] || 0);
                btn.innerHTML = `${res.liked ? '&#10084;' : '&#9825;'} ${res.liked ? currentLikes + 1 : Math.max(0, currentLikes - 1)}`;
              } catch (err) {
                createToast(err.message, 'error');
              }
            });
          });
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
        clearInterval(studentState._saveInterval);
        studentState._saveInterval = null;
        playerRoot.innerHTML = '';
      });

      video.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    const lockedBtn = event.target.closest('[data-action="locked-content"]');
    if (lockedBtn) {
      createToast('该内容需升级权益后解锁，请联系老师或前往商城购买课程。', 'error');
    }
  });

  // 直播回放按钮事件委托
  document.getElementById('student-live-list').addEventListener('click', async (event) => {
    const recordingBtn = event.target.closest('[data-action="play-recording"]');
    if (recordingBtn) {
      const src = recordingBtn.dataset.recordingPath;
      const title = recordingBtn.dataset.title;

      const playerRoot = document.getElementById('video-player-area');
      playerRoot.innerHTML = `
        <div class="paper-card" style="padding:16px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
            <h3 style="margin:0;">${escapeHtml(title)}</h3>
            <button class="ghost-button" id="close-recording-btn" type="button" style="font-size:12px;padding:4px 10px;">关闭播放器</button>
          </div>
          <video id="recording-video" controls style="width:100%;border-radius:12px;background:#000;" src="${escapeHtml(src)}"></video>
        </div>
      `;

      document.getElementById('close-recording-btn').addEventListener('click', () => {
        playerRoot.innerHTML = '';
      });

      document.getElementById('recording-video').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
  });
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

// ── 课程筛选 + 最近观看 ──

function bindCourseTabs() {
  const panel = document.getElementById('student-courses');
  if (!panel) return;

  panel.addEventListener('click', (event) => {
    const catBtn = event.target.closest('[data-course-category]');
    if (catBtn) {
      studentState.cloudState.categoryFilter = catBtn.dataset.courseCategory;
      studentState.cloudState.majorSubFilter = '';
      renderCategoryTabs();
      renderStudentCloud();
      return;
    }

    const majorBtn = event.target.closest('[data-major-sub]');
    if (majorBtn) {
      studentState.cloudState.majorSubFilter = majorBtn.dataset.majorSub;
      renderCategoryTabs();
      renderStudentCloud();
      return;
    }

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
      const itemType = item.itemType || item.item_type;
      const filePath = item.filePath || item.file_path;
      const fileUrl = item.fileUrl || item.file_url;
      const durationSec = item.durationSeconds || item.duration_seconds || 0;
      const positionSec = item.positionSeconds || item.position_seconds || 0;
      const icon = itemType === 'video' ? '&#127909;' : '&#128196;';
      const pct = durationSec > 0 ? Math.round((positionSec / durationSec) * 100) : 0;
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
          ${itemType === 'video' && (filePath || fileUrl) ? `<button class="ghost-button" data-action="play-video" data-item-id="${item.id}" data-src="${escapeHtml(filePath || fileUrl)}" data-title="${escapeHtml(item.title)}" type="button" style="font-size:12px;padding:4px 10px;">续播</button>` : ''}
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
