document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('register-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const formData = new FormData(form);
    try {
      await fetchJSON('/api/auth/register/teacher', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: formData.get('username'),
          password: formData.get('password'),
          displayName: formData.get('displayName'),
          className: formData.get('className'),
          motivation: formData.get('motivation')
        })
      });

      createToast('注册申请已提交，请等待管理员审核。', 'success');
      setTimeout(() => { location.href = '/'; }, 2000);
    } catch (error) {
      createToast(error.message, 'error');
    }
  });
});
