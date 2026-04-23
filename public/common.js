// 401 跳转锁，防止多个并行请求重复弹 toast 和跳转
let _authExpired = false;

async function fetchJSON(url, options = {}) {
  const { headers: customHeaders, ...restOptions } = options;
  const isFormData = typeof FormData !== 'undefined' && restOptions.body instanceof FormData;

  // 自动携带 localStorage 中的 token
  const savedToken = localStorage.getItem('auth_token');
  const autoHeaders = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...customHeaders
  };
  if (savedToken && !autoHeaders['Authorization'] && !autoHeaders['authorization']) {
    autoHeaders['Authorization'] = `Bearer ${savedToken}`;
  }

  const response = await fetch(url, {
    credentials: 'include',
    ...restOptions,
    headers: autoHeaders
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch (error) {
    payload = null;
  }

  if (!response.ok) {
    if (response.status === 401) {
      // 登录接口的 401 是密码错误，不走全局跳转
      const isLoginEndpoint = typeof url === 'string' && (url.includes('/api/auth/login') || url.includes('/api/auth/register'));
      if (isLoginEndpoint) {
        throw new Error(payload?.error || '账号或密码错误');
      }
      if (!_authExpired) {
        _authExpired = true;
        localStorage.removeItem('auth_token');
        createToast('登录已过期，请重新登录', 'error');
        setTimeout(() => { location.href = '/'; }, 1500);
      }
      throw new Error('登录已过期');
    }
    throw new Error(payload?.error || '请求失败');
  }

  return payload;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDateTime(value) {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function formatMoney(value) {
  const n = Number(value);
  return `¥${(isNaN(n) ? 0 : n).toFixed(2)}`;
}

function createToast(message, type = 'info', duration) {
  let root = document.getElementById('toast-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'toast-root';
    root.className = 'toast-root';
    document.body.appendChild(root);
  }

  // BUG-066: 最多保留 5 条 toast，超出则移除最早的
  while (root.children.length >= 5) {
    root.firstChild.remove();
  }

  const item = document.createElement('div');
  item.className = `toast toast-${type}`;
  item.textContent = message;
  root.appendChild(item);

  const dismissTime = duration || (type === 'error' ? 4500 : 2600);
  setTimeout(() => {
    item.classList.add('toast-hide');
    setTimeout(() => item.remove(), 350);
  }, dismissTime);
}

// 自定义确认弹窗（替代原生 confirm）
function confirmDialog({ title = '确认操作', message, confirmText = '确定', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-dialog">
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(message)}</p>
        <div class="confirm-actions">
          <button class="ghost-button confirm-cancel">${escapeHtml(cancelText)}</button>
          <button class="${danger ? 'danger-button' : 'button'} confirm-ok">${escapeHtml(confirmText)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('.confirm-cancel').addEventListener('click', () => {
      overlay.remove();
      resolve(false);
    });
    overlay.querySelector('.confirm-ok').addEventListener('click', () => {
      overlay.remove();
      resolve(true);
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.remove();
        resolve(false);
      }
    });
    // Escape 关闭
    const escHandler = (e) => {
      if (e.key === 'Escape') {
        overlay.remove();
        document.removeEventListener('keydown', escHandler);
        resolve(false);
      }
    };
    document.addEventListener('keydown', escHandler);
  });
}

// 按钮 loading 状态管理
function setButtonLoading(button, loading) {
  if (!button) return;
  if (loading) {
    button._origText = button.textContent;
    button.disabled = true;
    button.style.opacity = '0.7';
    button.style.cursor = 'wait';
    button.textContent = '处理中...';
  } else {
    button.disabled = false;
    button.style.opacity = '';
    button.style.cursor = '';
    button.textContent = button._origText || button.textContent;
  }
}

async function ensureAuth(requiredRole) {
  // 优先级：URL token > localStorage token > session cookie
  const urlParams = new URLSearchParams(location.search);
  const queryToken = urlParams.get('token');
  const savedToken = localStorage.getItem('auth_token');
  const authToken = queryToken || savedToken;

  let data;
  if (authToken) {
    data = await fetchJSON('/api/auth/me', {
      headers: { Authorization: `Bearer ${authToken}` }
    });
  } else {
    data = await fetchJSON('/api/auth/me');
  }

  if (!data.user) {
    localStorage.removeItem('auth_token');
    location.href = '/';
    return null;
  }

  if (requiredRole && data.user.role !== requiredRole) {
    const roleRoutes = { admin: '/admin', teacher: '/teacher', student: '/student' };
    location.href = roleRoutes[data.user.role] || '/';
    return null;
  }

  // 持久化 token，确保后续请求能自动携带
  if (data.token) {
    localStorage.setItem('auth_token', data.token);
  } else if (queryToken) {
    localStorage.setItem('auth_token', queryToken);
  }

  // BUG-006: 验证后从 URL 中移除 token
  if (queryToken) {
    const cleanUrl = new URL(location.href);
    cleanUrl.searchParams.delete('token');
    history.replaceState(null, '', cleanUrl.pathname + cleanUrl.hash);
  }

  return data;
}

async function logout() {
  localStorage.removeItem('auth_token');
  localStorage.removeItem('auth_username');
  await fetchJSON('/api/auth/logout', { method: 'POST' });
  location.href = '/';
}

function activateTabs(buttonSelector, sectionSelector, onActivate) {
  const buttons = Array.from(document.querySelectorAll(buttonSelector));
  const sections = Array.from(document.querySelectorAll(sectionSelector));

  // 查找"更多"下拉组件（兼容旧 tab-more 和新 nav-more）
  const moreWrap = document.querySelector('.nav-more-wrap') || document.querySelector('.tab-more-wrap');
  const moreBtn = moreWrap ? (moreWrap.querySelector('.nav-more-btn') || moreWrap.querySelector('.tab-more-btn')) : null;
  const dropdown = moreWrap ? (moreWrap.querySelector('.tab-dropdown') || moreWrap.querySelector('.nav-more-dropdown')) : null;
  const dropdownItems = dropdown ? Array.from(dropdown.querySelectorAll('.tab-dropdown-item, .nav-dropdown-item')) : [];

  // 查找用户下拉菜单
  const userBtn = document.querySelector('.nav-user-btn');
  const userDropdown = document.querySelector('.nav-user-dropdown');

  // 懒加载追踪：记录哪些面板已激活过
  const activatedPanels = new Set();

  function activate(target) {
    // 清除所有按钮的 active 状态
    buttons.forEach((b) => b.classList.remove('active'));
    dropdownItems.forEach((b) => b.classList.remove('active'));
    if (moreBtn) moreBtn.classList.remove('active');

    // 激活目标按钮
    const matchBtn = buttons.find((b) => b.dataset.target === target);
    if (matchBtn) matchBtn.classList.add('active');

    // 如果目标在下拉菜单中
    const matchDrop = dropdownItems.find((b) => b.dataset.target === target);
    if (matchDrop && moreBtn) {
      moreBtn.classList.add('active');
      matchDrop.classList.add('active');
    }

    // 切换面板
    sections.forEach((section) => section.classList.toggle('hidden', section.id !== target));

    // 首次激活时触发懒加载回调
    if (!activatedPanels.has(target)) {
      activatedPanels.add(target);
      if (typeof onActivate === 'function') {
        onActivate(target);
      }
    }

    // 关闭下拉
    if (dropdown) dropdown.classList.remove('show');
    if (userDropdown) userDropdown.classList.remove('show');
  }

  // 核心 tab 点击
  buttons.forEach((button) => {
    button.addEventListener('click', () => activate(button.dataset.target));
  });

  // 下拉菜单项点击
  dropdownItems.forEach((item) => {
    item.addEventListener('click', () => activate(item.dataset.target));
  });

  // "更多"按钮：切换下拉显示
  if (moreBtn && dropdown) {
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('show');
    });

    // 点击外部关闭下拉
    document.addEventListener('click', (e) => {
      if (!moreWrap.contains(e.target)) {
        dropdown.classList.remove('show');
      }
    });
  }

  // 标记首屏已激活的面板
  const activeBtn = buttons.find((b) => b.classList.contains('active'));
  if (activeBtn) activatedPanels.add(activeBtn.dataset.target);

  // 用户下拉菜单 toggle
  if (userBtn && userDropdown) {
    userBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      userDropdown.classList.toggle('show');
    });
    document.addEventListener('click', (e) => {
      if (!userBtn.contains(e.target) && !userDropdown.contains(e.target)) {
        userDropdown.classList.remove('show');
      }
    });
  }
}

function buildEmptyState(title, description, options = {}) {
  const { icon = '研', actionText, actionFn } = options;
  let html = `
    <div class="empty-state">
      <div class="empty-state-mark">${escapeHtml(icon)}</div>
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(description)}</p>
  `;
  if (actionText && typeof actionFn === 'function') {
    const actionId = 'empty-action-' + Math.random().toString(36).slice(2, 8);
    html += `<button class="ghost-button" id="${actionId}" type="button">${escapeHtml(actionText)}</button>`;
    // 延迟绑定事件（因为 buildEmptyState 通常用于 innerHTML）
    setTimeout(() => {
      const btn = document.getElementById(actionId);
      if (btn) btn.addEventListener('click', actionFn);
    }, 50);
  }
  html += '</div>';
  return html;
}

function buildRetryState(message, retryFn) {
  const retryId = 'retry-action-' + Math.random().toString(36).slice(2, 8);
  let html = `
    <div class="empty-state">
      <div class="empty-state-mark" style="background:#fef2f2;color:#b91c1c;">!</div>
      <h3>加载失败</h3>
      <p>${escapeHtml(message)}</p>
      <button class="ghost-button" id="${retryId}" type="button">重试</button>
    </div>
  `;
  setTimeout(() => {
    const btn = document.getElementById(retryId);
    if (btn) btn.addEventListener('click', retryFn);
  }, 50);
  return html;
}

const FEEDBACK = {
  loading: '处理中...',
  success: { save: '保存成功', submit: '提交成功', delete: '删除成功' },
  error: {
    network: '网络连接失败，请检查网络后重试',
    server: '服务器开小差了，请稍后重试',
    auth: '登录已过期，请重新登录',
    permission: '没有权限执行此操作',
    notFound: '请求的资源不存在'
  }
};
