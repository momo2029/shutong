// 书童 — 通用交互脚本
window.showToast = function(message, type = 'info', timeout = 3000) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('hide');
    setTimeout(() => el.remove(), 200);
  }, timeout);
};

document.addEventListener('DOMContentLoaded', () => {
  const flash = document.getElementById('flashData');
  if (flash?.dataset.message) {
    window.showToast(flash.dataset.message, flash.dataset.type || 'info');
  }

  // Confirm dialogs
  document.querySelectorAll('[data-confirm]').forEach(el => {
    el.addEventListener('click', (e) => {
      if (!confirm(el.getAttribute('data-confirm') || '确定?')) {
        e.preventDefault();
      }
    });
  });
});
