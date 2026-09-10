// toast.js - lightweight toast notification utility

export function showToast(message, type = 'info', durationMs = 3500) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), durationMs);
}

export function showActionToast(message, actionLabel, onAction, durationMs = 5000) {
  const container = document.getElementById('toast-container');
  if (!container) return null;
  let dismissed = false;
  const toast = document.createElement('div');
  toast.className = 'toast toast-info toast--action';

  const msgSpan = document.createElement('span');
  msgSpan.className = 'toast__msg';
  msgSpan.textContent = message;
  toast.appendChild(msgSpan);

  const actionBtn = document.createElement('button');
  actionBtn.className = 'toast__action';
  actionBtn.type = 'button';
  actionBtn.textContent = actionLabel;
  actionBtn.addEventListener('click', () => {
    dismissed = true;
    toast.remove();
    if (typeof onAction === 'function') onAction();
  });
  toast.appendChild(actionBtn);

  container.appendChild(toast);
  setTimeout(() => {
    if (!dismissed) toast.remove();
  }, durationMs);
  return toast;
}
