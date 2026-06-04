// 书童 — 通用交互脚本
document.addEventListener('DOMContentLoaded', () => {
  // Confirm dialogs
  document.querySelectorAll('[data-confirm]').forEach(el => {
    el.addEventListener('click', (e) => {
      if (!confirm(el.getAttribute('data-confirm') || '确定?')) {
        e.preventDefault();
      }
    });
  });
});
