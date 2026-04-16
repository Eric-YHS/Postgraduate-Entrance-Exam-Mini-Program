document.addEventListener('DOMContentLoaded', async () => {
  // 优先用 localStorage 中保存的 token 尝试自动登录
  const savedToken = localStorage.getItem('auth_token');
  if (savedToken) {
    try {
      const me = await fetchJSON('/api/auth/me', {
        headers: { Authorization: `Bearer ${savedToken}` }
      });
      if (me.user) {
        // token 仍然有效，直接跳转
        location.href = me.user.role === 'admin' ? '/admin' : me.user.role === 'teacher' ? '/teacher' : '/student';
        return;
      }
    } catch (e) {
      // token 过期或无效，清除
      localStorage.removeItem('auth_token');
    }
  }

  // 没有保存的 token，检查 session cookie
  const me = await fetchJSON('/api/auth/me').catch(() => ({ user: null }));
  if (me.user) {
    location.href = me.user.role === 'admin' ? '/admin' : me.user.role === 'teacher' ? '/teacher' : '/student';
    return;
  }

  const form = document.getElementById('login-form');

  // 回填保存的用户名
  const savedUsername = localStorage.getItem('auth_username');
  if (savedUsername) {
    const usernameInput = form.querySelector('input[name="username"]');
    if (usernameInput) usernameInput.value = savedUsername;
    // 聚焦到密码框
    const passwordInput = form.querySelector('input[name="password"]');
    if (passwordInput) passwordInput.focus();
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const formData = new FormData(form);
    const username = formData.get('username');
    const password = formData.get('password');
    const rememberMe = form.querySelector('input[name="remember"]')?.checked;

    try {
      const result = await fetchJSON('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      // 如果勾选了记住密码，保存 token 和用户名
      if (rememberMe && result.token) {
        localStorage.setItem('auth_token', result.token);
        localStorage.setItem('auth_username', username);
      }

      createToast('登录成功，正在进入你的考研规划台。', 'success');
      setTimeout(() => {
        location.href = result.user.role === 'admin' ? '/admin' : result.user.role === 'teacher' ? '/teacher' : '/student';
      }, 500);
    } catch (error) {
      createToast(error.message, 'error');
    }
  });
});
