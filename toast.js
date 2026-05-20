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
  toast.className = 'toast toast-info';
  toast.style.display = 'flex';
  toast.style.alignItems = 'center';
  toast.style.gap = '10px';
  toast.style.cursor = 'default';

  const msgSpan = document.createElement('span');
  msgSpan.style.flex = '1';
  msgSpan.textContent = message;
  toast.appendChild(msgSpan);

  const actionBtn = document.createElement('button');
  actionBtn.textContent = actionLabel;
  actionBtn.style.cssText = `
    font-size: var(--fs-xs);
    font-weight: 600;
    padding: 4px 10px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--secondary);
    color: var(--foreground);
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
  `;
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
