// ui.js - shared loading, empty/error, and button-state helpers
import { ICONS } from './icons.js';
import { escapeHtml } from './text-utils.js';

export function setHidden(el, hidden) {
  if (!el) return;
  el.classList.toggle('is-hidden', hidden);
}

export function setBusy(el, busy) {
  if (!el) return;
  if (busy) el.setAttribute('aria-busy', 'true');
  else el.removeAttribute('aria-busy');
}

export function setButtonLabel(btn, label) {
  if (!btn || label == null) return;
  let span = btn.querySelector('.btn-label');
  if (!span) {
    btn.textContent = '';
    span = document.createElement('span');
    span.className = 'btn-label';
    btn.appendChild(span);
  }
  span.textContent = label;
}

export function setButtonLoading(btn, loading, label) {
  if (!btn) return;
  if (label) setButtonLabel(btn, label);
  else if (!btn.querySelector('.btn-label') && btn.childElementCount === 0) {
    setButtonLabel(btn, btn.textContent.trim());
  }
  btn.classList.toggle('is-loading', !!loading);
  btn.setAttribute('aria-busy', String(!!loading));
  btn.disabled = !!loading;
}

export function loadingSpinner(label = 'Loading') {
  return `<div class="loading-spinner" role="status" aria-label="${escapeHtml(label)}"></div>`;
}

export function panelLoading(message = 'Loading…') {
  return `<div class="state-box" role="status" aria-busy="true">
    ${loadingSpinner(message)}
    <p>${escapeHtml(message)}</p>
  </div>`;
}

export function stateBox({ icon = ICONS.inbox, title, body, action, extra = '' } = {}) {
  const actionHtml = action
    ? `<button class="btn-primary" type="button" data-action="${escapeHtml(action.action)}"><span class="btn-label">${escapeHtml(action.label)}</span></button>`
    : '';
  return `<div class="state-box">
    ${icon ? `<div class="state-icon" aria-hidden="true">${icon}</div>` : ''}
    ${title ? `<h3>${escapeHtml(title)}</h3>` : ''}
    ${body ? `<p>${body}</p>` : ''}
    ${actionHtml}
    ${extra}
  </div>`;
}

const SKELETON_WIDTHS = [
  [78, 100, 88, 62],
  [72, 100, 84, 55],
  [85, 100, 91, 70],
  [68, 100, 80, 48],
  [81, 100, 86, 64],
];

export function skeletonCardsHtml(count = 5) {
  return Array.from({ length: count }, (_, i) => {
    const [t, e1, e2, e3] = SKELETON_WIDTHS[i % SKELETON_WIDTHS.length];
    return `<div class="skeleton-card" aria-hidden="true">
      <div class="skeleton-image"></div>
      <div class="skeleton-title" style="--w:${t}%"></div>
      <div class="skeleton-excerpt" style="--w:${e1}%"></div>
      <div class="skeleton-excerpt" style="--w:${e2}%"></div>
      <div class="skeleton-excerpt" style="--w:${e3}%"></div>
      <div class="skeleton-actions">
        <div class="skeleton-pill"></div>
        <div class="skeleton-pill"></div>
      </div>
    </div>`;
  }).join('');
}

export function showSkeletonCards(container, count = 5) {
  if (!container) return;
  container.insertAdjacentHTML('beforeend', skeletonCardsHtml(count));
}

export function removeSkeletonCards(container) {
  container?.querySelectorAll('.skeleton-card').forEach(el => el.remove());
}

export function bindAppActions(root = document.getElementById('app')) {
  if (!root || root.dataset.actionsBound) return;
  root.dataset.actionsBound = '1';
  root.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'retry-feed') window.reloadFeed?.();
    if (action === 'retry-search') document.getElementById('search-submit-btn')?.click();
    if (action === 'open-auth') window.openAuthModal?.('signin');
  });
}
