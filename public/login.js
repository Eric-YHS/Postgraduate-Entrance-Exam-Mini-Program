document.addEventListener('DOMContentLoaded', async () => {
  const me = await fetchJSON('/api/auth/me').catch(() => ({ user: null }));
  if (me.user) {
    location.href = me.user.role === 'admin' ? '/admin' : me.user.role === 'teacher' ? '/teacher' : '/student';
    return;
  }

  const form = document.getElementById('login-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const formData = new FormData(form);
    try {
      const result = await fetchJSON('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          username: formData.get('username'),
          password: formData.get('password')
        })
      });

      createToast('登录成功，正在进入你的考研规划台。', 'success');
      setTimeout(() => {
        location.href = result.user.role === 'admin' ? '/admin' : result.user.role === 'teacher' ? '/teacher' : '/student';
      }, 500);
    } catch (error) {
      createToast(error.message, 'error');
    }
  });
});
