import { getCurrentUser, sendPasswordReset, updateDisplayName } from './auth.js';
import { Storage } from './storage.js';
import { showToast } from './toast.js';

export async function renderAccountPage() {
  const host = document.getElementById('account-page-content');
  if (!host) return;
  const user = await getCurrentUser();
  if (!user) {
    host.innerHTML = `
      <div class="state-box">
        <h3>Sign in required</h3>
        <p>Please sign in to access account settings.</p>
        <button class="btn-primary" id="account-open-auth">Sign in</button>
      </div>
    `;
    host.querySelector('#account-open-auth')?.addEventListener('click', () => window.openAuthModal?.('signin'));
    return;
  }

  const displayName = user.user_metadata?.display_name || '';
  const likedCount = Storage.getHistory().likedTitles?.length || 0;
  host.innerHTML = `
    <div class="settings-section">
      <div class="settings-section-header">Profile</div>
      <div class="settings-row" style="flex-direction:column;align-items:flex-start;gap:10px;">
        <div class="settings-row-label">
          <strong>${escapeHtml(user.email || '')}</strong>
          <span>Email address</span>
        </div>
        <div class="input-group">
          <label class="input-label" for="account-display-name">Display name</label>
          <input class="input-field" id="account-display-name" value="${escapeHtml(displayName)}" minlength="2" />
        </div>
        <button class="btn-primary" id="account-save-name">Save name</button>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-header">Security</div>
      <div class="settings-row">
        <div class="settings-row-label">
          <strong>Password reset</strong>
          <span>Send a reset link to your email</span>
        </div>
        <button class="btn-secondary" id="account-reset-password">Send reset email</button>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-header">Library</div>
      <div class="settings-row">
        <div class="settings-row-label">
          <strong>Liked articles</strong>
          <span>${likedCount} saved in this profile session</span>
        </div>
      </div>
    </div>
  `;

  host.querySelector('#account-save-name')?.addEventListener('click', async () => {
    const val = host.querySelector('#account-display-name')?.value?.trim() || '';
    if (val.length < 2) {
      showToast('Display name must be at least 2 characters', 'error');
      return;
    }
    try {
      await updateDisplayName(val);
      showToast('Display name updated', 'success');
    } catch (err) {
      showToast(err?.message || 'Could not update display name', 'error');
    }
  });

  host.querySelector('#account-reset-password')?.addEventListener('click', async () => {
    try {
      await sendPasswordReset(user.email);
      showToast('Password reset email sent', 'success');
    } catch (err) {
      showToast(err?.message || 'Could not send reset email', 'error');
    }
  });
}

function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
