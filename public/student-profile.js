const token = new URLSearchParams(location.search).get('token') || '';
const form = document.getElementById('profile-form');
const statusNode = document.getElementById('status');
const submitButton = document.getElementById('submit-button');

function setStatus(message, success = false) {
  statusNode.textContent = message;
  statusNode.classList.toggle('success', success);
}

function populate(profile) {
  Object.entries(profile || {}).forEach(([key, value]) => {
    const input = form.elements.namedItem(key);
    if (input && value !== null && value !== undefined) input.value = value;
  });
}

async function loadProfile() {
  if (!token) {
    setStatus('登记链接缺少 token，请联系班主任重新获取。');
    submitButton.disabled = true;
    return;
  }
  try {
    const response = await fetch(`/api/public/student-profiles/${encodeURIComponent(token)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '登记链接无效。');
    populate(data.profile);
  } catch (error) {
    setStatus(error.message);
    submitButton.disabled = true;
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  submitButton.disabled = true;
  setStatus('正在提交...');
  const payload = Object.fromEntries(new FormData(form).entries());
  try {
    const response = await fetch(`/api/public/student-profiles/${encodeURIComponent(token)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '提交失败。');
    setStatus('登记已保存。后续每日计划会根据完成情况持续调整。', true);
  } catch (error) {
    setStatus(error.message || '提交失败，请稍后重试。');
  } finally {
    submitButton.disabled = false;
  }
});

loadProfile();
