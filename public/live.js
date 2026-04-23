const liveState = {
  liveId: Number(location.pathname.split('/').pop()) || 0,
  user: null,
  liveSession: null,
  socket: null,
  localStream: null,
  peerConnections: new Map(),
  roomUsers: [],
  token: null
};

document.addEventListener('DOMContentLoaded', async () => {
  const authResult = await ensureAuth().catch(() => null);
  if (!authResult) {
    return;
  }

  liveState.user = authResult.user;
  liveState.token = authResult.token;
  document.getElementById('logout-button').addEventListener('click', logout);
  document.getElementById('chat-form').addEventListener('submit', submitChat);
  document.getElementById('start-broadcast-button').addEventListener('click', startBroadcast);
  document.getElementById('end-live-button').addEventListener('click', endLiveSession);

  // 禁言事件委托
  document.getElementById('chat-list').addEventListener('click', async (event) => {
    const muteBtn = event.target.closest('[data-action="mute-user"]');
    if (!muteBtn) return;
    const userId = muteBtn.dataset.userId;
    const userName = muteBtn.dataset.userName;
    if (!await confirmDialog({ title: '禁言确认', message: `确定禁言 ${userName} 10分钟？`, confirmText: '禁言', danger: true })) return;
    try {
      await fetchJSON('/api/live-sessions/' + liveState.liveId + '/mute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: Number(userId), durationMinutes: 10 })
      });
      createToast(`已禁言 ${userName} 10分钟。`, 'success');
    } catch (error) {
      createToast(error.message, 'error');
    }
  });

  await loadLiveSession();
  if (!liveState.liveId || !liveState.liveSession) {
    createToast('直播间不存在或链接无效。', 'error');
    location.href = '/';
    return;
  }
  connectLiveSocket();

  if (authResult.user.role !== 'teacher') {
    document.getElementById('teacher-controls').classList.add('hidden');
  }
});

async function loadLiveSession() {
  const payload = await fetchJSON(`/api/live-sessions/${liveState.liveId}`);
  liveState.liveSession = payload.liveSession;
  // BUG-027: 直播不存在时显示提示
  if (!payload.liveSession) {
    document.getElementById('live-title').textContent = '直播不存在或已结束';
    return;
  }
  document.getElementById('live-role-badge').textContent = liveState.user.role === 'teacher' ? '老师直播控制台' : '学生听课房间';
  document.getElementById('live-title').textContent = payload.liveSession.title;
  document.getElementById('live-description').textContent = payload.liveSession.description || '直播间已就绪，可进行语音视频推流和实时聊天。';
  document.getElementById('live-status').textContent = payload.liveSession.status;
  renderChatMessages(payload.messages);
}

function updateConnectionStatus(status) {
  let el = document.getElementById('connection-status');
  if (!el) {
    el = document.createElement('div');
    el.id = 'connection-status';
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;padding:10px;text-align:center;font-size:14px;font-weight:600;z-index:9998;transition:opacity 0.3s;';
    document.body.appendChild(el);
  }
  if (status === 'connected') {
    if (el.dataset.wasDisconnected === 'true') {
      el.textContent = '已重新连接';
      el.style.background = '#dcfce7'; el.style.color = '#166534'; el.style.borderBottom = '2px solid #86efac';
      setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 2000);
    }
  } else if (status === 'reconnecting') {
    el.dataset.wasDisconnected = 'true';
    el.textContent = '连接断开，正在重连...';
    el.style.background = '#fef3c7'; el.style.color = '#92400e'; el.style.borderBottom = '2px solid #fcd34d'; el.style.opacity = '1';
  }
}

function connectLiveSocket() {
  // BUG-014: 清理旧的重连定时器，防止泄漏
  if (liveState.reconnectTimer) {
    clearTimeout(liveState.reconnectTimer);
    liveState.reconnectTimer = null;
  }
  liveState.reconnectAttempts = (liveState.reconnectAttempts || 0) + 1;
  if (liveState.reconnectAttempts > 10) {
    setTimeout(() => { liveState.reconnectAttempts = 0; }, 30000);
    return;
  }
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const token = liveState.token || localStorage.getItem('auth_token') || '';
  const socket = new WebSocket(`${protocol}://${location.host}?token=${encodeURIComponent(token)}`);
  if (liveState.socket) {
    liveState.socket.close();
  }
  liveState.socket = socket;

  socket.addEventListener('open', () => {
    liveState.reconnectAttempts = 0;
    updateConnectionStatus('connected');
    socket.send(
      JSON.stringify({
        type: 'join-live',
        liveId: liveState.liveId
      })
    );
  });

  socket.addEventListener('message', async (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }

    if (message.type === 'room-users') {
      liveState.roomUsers = message.users;
      if (liveState.user.role === 'teacher' && liveState.localStream) {
        for (const userId of message.users) {
          await ensureOfferToUser(userId);
        }
      }
      return;
    }

    if (message.type === 'live-presence') {
      if (liveState.user.role === 'teacher' && liveState.localStream && message.role === 'student') {
        await ensureOfferToUser(message.userId);
      }
      return;
    }

    if (message.type === 'live-leave') {
      closePeer(message.userId);
      removeRemoteVideo(message.userId);
      return;
    }

    if (message.type === 'signal') {
      await handleSignal(message.fromUserId, message.signal);
      return;
    }

    if (message.type === 'live-chat') {
      appendChatMessage(message.payload);
      // 弹幕效果
      showDanmaku(message.payload);
      return;
    }

    if (message.type === 'poll') {
      showLivePoll(message.poll);
      return;
    }

    if (message.type === 'live-ended') {
      document.getElementById('live-status').textContent = 'ended';
      createToast('老师已结束直播。', 'error');
    }
  });

  socket.addEventListener('close', () => {
    updateConnectionStatus('reconnecting');
    liveState.reconnectTimer = setTimeout(connectLiveSocket, 3000);
  });
}

async function startBroadcast() {
  if (liveState.user.role !== 'teacher') {
    return;
  }

  try {
    if (!liveState.localStream) {
      liveState.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      document.getElementById('local-video').srcObject = liveState.localStream;
    }

    await fetchJSON(`/api/live-sessions/${liveState.liveId}/start`, { method: 'POST' });
    document.getElementById('live-status').textContent = 'live';

    for (const userId of liveState.roomUsers) {
      await ensureOfferToUser(userId);
    }

    createToast('推流已开启。', 'success');
  } catch (error) {
    createToast(error.message || '无法开启直播。', 'error');
  }
}

async function endLiveSession() {
  if (liveState.user.role !== 'teacher') {
    return;
  }

  try {
    await fetchJSON(`/api/live-sessions/${liveState.liveId}/end`, { method: 'POST' });
    document.getElementById('live-status').textContent = 'ended';
    if (liveState.localStream) {
      liveState.localStream.getTracks().forEach((track) => track.stop());
      liveState.localStream = null;
      document.getElementById('local-video').srcObject = null;
    }
    // BUG-030: 结束直播时清理所有 peer 连接的轨道
    liveState.peerConnections.forEach((peer) => {
      peer.getSenders().forEach((sender) => { try { peer.removeTrack(sender); } catch (_) {} });
      peer.close();
    });
    liveState.peerConnections.clear();
    createToast('直播已结束。', 'success');
  } catch (error) {
    createToast(error.message, 'error');
  }
}

async function submitChat(event) {
  event.preventDefault();
  // BUG-036: 保存表单引用，防止异步边界后 event.currentTarget 失效
  const form = event.currentTarget;
  const formData = new FormData(form);
  const content = String(formData.get('content') || '').trim();
  if (!content || !liveState.socket || liveState.socket.readyState !== WebSocket.OPEN) {
    return;
  }

  liveState.socket.send(
    JSON.stringify({
      type: 'live-chat',
      liveId: liveState.liveId,
      content
    })
  );
  form.reset();
}

function renderChatMessages(messages) {
  const root = document.getElementById('chat-list');
  root.innerHTML = messages.length
    ? messages
        .map(
          (message) => {
            const muteBtn = liveState.user.role === 'teacher' && message.userId !== liveState.user.id
              ? `<button class="ghost-button" data-action="mute-user" data-user-id="${message.userId}" data-user-name="${escapeHtml(message.authorName)}" type="button" style="font-size:10px;padding:1px 6px;margin-left:6px;color:#ef4444;">禁言</button>`
              : '';
            return `
              <div class="chat-item">
                <strong>${escapeHtml(message.authorName)}</strong>${muteBtn}
                <p>${escapeHtml(message.content)}</p>
                <span class="muted">${escapeHtml(formatDateTime(message.createdAt))}</span>
              </div>
            `;
          }
        )
        .join('')
    : buildEmptyState('还没有聊天消息', '可以先在右侧发一条开场说明或提问。');
  root.scrollTop = root.scrollHeight;
}

function appendChatMessage(message) {
  const root = document.getElementById('chat-list');
  if (root.querySelector('.empty-state')) {
    root.innerHTML = '';
  }

  const node = document.createElement('div');
  node.className = 'chat-item';
  const muteBtn = liveState.user.role === 'teacher' && message.userId !== liveState.user.id
    ? `<button class="ghost-button" data-action="mute-user" data-user-id="${message.userId}" data-user-name="${escapeHtml(message.authorName)}" type="button" style="font-size:10px;padding:1px 6px;margin-left:6px;color:#ef4444;">禁言</button>`
    : '';
  node.innerHTML = `
    <strong>${escapeHtml(message.authorName)}</strong>${muteBtn}
    <p>${escapeHtml(message.content)}</p>
    <span class="muted">${escapeHtml(formatDateTime(message.createdAt))}</span>
  `;
  root.appendChild(node);
  root.scrollTop = root.scrollHeight;
}

async function fetchIceServers() {
  if (liveState.iceServers) {
    return liveState.iceServers;
  }
  try {
    const response = await fetch('/api/ice-servers', { headers: { Authorization: `Bearer ${liveState.token}` }, credentials: 'include' });
    if (!response.ok) throw new Error('ICE server request failed');
    const data = await response.json();
    liveState.iceServers = data.iceServers;
    return liveState.iceServers;
  } catch {
    return [{ urls: 'stun:stun.l.google.com:19302' }];
  }
}

async function createPeerConnection(targetUserId) {
  const iceServers = await fetchIceServers();
  const peer = new RTCPeerConnection({ iceServers });

  peer.onicecandidate = (event) => {
    if (event.candidate && liveState.socket?.readyState === WebSocket.OPEN) {
      liveState.socket.send(
        JSON.stringify({
          type: 'signal',
          liveId: liveState.liveId,
          targetUserId,
          signal: { candidate: event.candidate }
        })
      );
    }
  };

  peer.ontrack = (event) => {
    attachRemoteStream(targetUserId, event.streams[0]);
  };

  peer.onconnectionstatechange = () => {
    if (['failed', 'closed', 'disconnected'].includes(peer.connectionState)) {
      removeRemoteVideo(targetUserId);
    }
  };

  liveState.peerConnections.set(targetUserId, peer);
  return peer;
}

async function getPeerConnection(targetUserId) {
  return liveState.peerConnections.get(targetUserId) || (await createPeerConnection(targetUserId));
}

async function ensureOfferToUser(targetUserId) {
  if (Number(targetUserId) === Number(liveState.user.id)) {
    return;
  }

  try {
    const peer = await getPeerConnection(targetUserId);
    if (!liveState.localStream) {
      return;
    }

    const existingSenders = peer.getSenders().map((sender) => sender.track?.id).filter(Boolean);
    liveState.localStream.getTracks().forEach((track) => {
      if (!existingSenders.includes(track.id)) {
        peer.addTrack(track, liveState.localStream);
      }
    });

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    if (!liveState.socket || liveState.socket.readyState !== WebSocket.OPEN) return;
    liveState.socket.send(
      JSON.stringify({
        type: 'signal',
        liveId: liveState.liveId,
        targetUserId,
        signal: { description: peer.localDescription }
      })
    );
  } catch (error) {
    console.error('WebRTC ensureOffer error:', error);
  }
}

async function handleSignal(fromUserId, signal) {
  try {
    const peer = await getPeerConnection(fromUserId);

    if (signal.description) {
      const isPolite = Number(fromUserId) < Number(liveState.user.id);
      if (signal.description.type === 'offer' && peer.signalingState === 'have-local-offer') {
        if (!isPolite) return;
        await peer.setLocalDescription({ type: 'rollback' });
      }

      await peer.setRemoteDescription(new RTCSessionDescription(signal.description));

      if (signal.description.type === 'offer') {
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        liveState.socket.send(
          JSON.stringify({
            type: 'signal',
            liveId: liveState.liveId,
            targetUserId: fromUserId,
            signal: { description: peer.localDescription }
          })
        );
      }
    }

    if (signal.candidate) {
      await peer.addIceCandidate(new RTCIceCandidate(signal.candidate));
    }
  } catch (error) {
    console.error('WebRTC handleSignal error:', error);
  }
}

function attachRemoteStream(userId, stream) {
  const root = document.getElementById('remote-videos');
  let wrapper = document.querySelector(`[data-remote-user="${userId}"]`);
  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.dataset.remoteUser = userId;
    wrapper.className = 'paper-card';
    wrapper.innerHTML = `<h3>远端用户 ${escapeHtml(userId)}</h3><video class="video-frame" autoplay playsinline></video>`;
    root.appendChild(wrapper);
  }

  wrapper.querySelector('video').srcObject = stream;
}

function removeRemoteVideo(userId) {
  const node = document.querySelector(`[data-remote-user="${userId}"]`);
  if (node) {
    node.remove();
  }
}

function closePeer(userId) {
  const peer = liveState.peerConnections.get(userId);
  if (peer) {
    peer.close();
    liveState.peerConnections.delete(userId);
  }
}

window.addEventListener('beforeunload', () => {
  if (liveState.localStream) {
    liveState.localStream.getTracks().forEach(t => t.stop());
  }
  liveState.peerConnections.forEach((peer) => peer.close());
  liveState.peerConnections.clear();
  if (liveState.socket && liveState.socket.readyState === WebSocket.OPEN) {
    liveState.socket.close();
  }
});

// ===== 第二阶段直播增强 =====

// 弹幕效果
function showDanmaku(msg) {
  if (!msg || !msg.content) return;
  const container = document.getElementById('danmaku-layer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'danmaku-item';
  el.textContent = msg.content;
  el.style.top = Math.random() * 80 + '%';
  el.style.color = msg.color || '#fff';
  container.appendChild(el);
  setTimeout(() => el.remove(), 8000);
}

// 直播互动答题
function showLivePoll(poll) {
  const pollArea = document.getElementById('live-poll-area');
  if (!pollArea || !poll) return;
  pollArea.innerHTML = '<div class="paper-card" style="background:#fef3c7;border-color:#f59e0b;margin-bottom:12px;">' +
    '<h4 style="margin:0 0 8px;">课堂投票</h4>' +
    '<p style="font-size:14px;margin:0 0 8px;">' + escapeHtml(poll.question) + '</p>' +
    poll.options.map((opt, i) =>
      '<button class="ghost-button" style="display:block;width:100%;text-align:left;margin-bottom:4px;padding:8px 12px;" data-action="vote-poll" data-poll-id="' + poll.id + '" data-option="' + i + '">' +
      String.fromCharCode(65 + i) + '. ' + escapeHtml(opt) + '</button>'
    ).join('') + '</div>';
}

document.addEventListener('click', async (e) => {
  // 投票
  const voteBtn = e.target.closest('[data-action="vote-poll"]');
  if (voteBtn) {
    try {
      await fetchJSON('/api/live-sessions/' + liveState.liveId + '/polls/vote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pollId: Number(voteBtn.dataset.pollId), optionIndex: Number(voteBtn.dataset.option) })
      });
      createToast('投票成功！', 'success');
      voteBtn.style.background = '#22c55e';
      voteBtn.style.color = '#fff';
    } catch (err) { createToast(err.message, 'error'); }
    return;
  }
  // 查看投票结果
  const resultsBtn = e.target.closest('[data-action="poll-results"]');
  if (resultsBtn) {
    try {
      const res = await fetchJSON('/api/live-sessions/' + liveState.liveId + '/polls/' + resultsBtn.dataset.pollId + '/results');
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:2000;display:flex;align-items:center;justify-content:center;';
      const totalVotes = Object.values(res.results).reduce((s, v) => s + v, 0) || 1;
      overlay.innerHTML = '<div style="background:#fff;border-radius:16px;padding:24px;max-width:400px;width:90%;">' +
        '<h3 style="margin:0 0 12px;">' + escapeHtml(res.poll.question) + '</h3>' +
        res.poll.options.map((opt, i) => {
          const cnt = res.results[i] || 0;
          const pct = Math.round(cnt / totalVotes * 100);
          return '<div style="margin-bottom:8px;"><div style="display:flex;justify-content:space-between;font-size:13px;"><span>' + String.fromCharCode(65 + i) + '. ' + escapeHtml(opt) + '</span><span>' + pct + '%</span></div>' +
            '<div style="height:6px;background:var(--border);border-radius:3px;margin-top:3px;"><div style="height:6px;background:var(--brand);border-radius:3px;width:' + pct + '%;"></div></div></div>';
        }).join('') +
        '<div style="text-align:center;margin-top:12px;"><button class="ghost-button" onclick="this.closest(\'div[style*=fixed]\').remove()">关闭</button></div></div>';
      overlay.addEventListener('click', (ev) => { if (ev.target === overlay) overlay.remove(); });
      document.body.appendChild(overlay);
    } catch (err) { createToast(err.message, 'error'); }
    return;
  }
});

// 教师创建投票按钮
if (liveState.user && liveState.user.role === 'teacher') {
  const chatForm = document.getElementById('chat-form');
  if (chatForm) {
    const pollBtn = document.createElement('button');
    pollBtn.type = 'button';
    pollBtn.className = 'ghost-button';
    pollBtn.style.cssText = 'font-size:11px;padding:4px 10px;';
    pollBtn.textContent = '发起投票';
    pollBtn.addEventListener('click', async () => {
      const question = prompt('投票问题：');
      if (!question) return;
      const optsStr = prompt('选项（逗号分隔，如：A选项,B选项,C选项）：');
      if (!optsStr) return;
      const options = optsStr.split(',').map((s) => s.trim()).filter(Boolean);
      if (options.length < 2) { createToast('至少需要2个选项。', 'error'); return; }
      try {
        await fetchJSON('/api/live-sessions/' + liveState.liveId + '/polls', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question, options })
        });
        createToast('投票已发起。', 'success');
      } catch (err) { createToast(err.message, 'error'); }
    });
    chatForm.appendChild(pollBtn);
  }
}
