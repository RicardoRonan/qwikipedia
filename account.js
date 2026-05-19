import { getCurrentUser, sendPasswordReset, updateDisplayName, signOut, getProfile, upsertProfile } from './auth.js';
import { renderLikesSection } from './settings.js';
import { showToast } from './toast.js';

export async function renderAccountPage() {
  const host = document.getElementById('account-page-content');
  if (!host) return;

  // Loading state
  host.innerHTML = `
    <div class="state-box">
      <div class="loading-spinner" style="width:24px;height:24px;margin:0 auto 12px;border:2px solid var(--border);border-top-color:var(--foreground);border-radius:50%;animation:spin 0.9s linear infinite;"></div>
      <p>Loading account details…</p>
    </div>
  `;

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
    await renderLikesSection();
    return;
  }

  const displayName = user.user_metadata?.display_name || '';
  let wikiUsername = '';
  try {
    const profile = await getProfile(user.id);
    wikiUsername = profile?.wikipedia_username || '';
  } catch {}

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
          <input class="input-field" id="account-display-name" value="${escapeHtml(displayName)}" minlength="2" maxlength="50" />
          <span style="font-size:var(--fs-xs);color:var(--muted-foreground);">2–50 characters</span>
        </div>
        <button class="btn-primary" id="account-save-name">Save name</button>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-header">Wikipedia</div>
      <div class="settings-row" style="flex-direction:column;align-items:flex-start;gap:10px;">
        <div class="input-group">
          <label class="input-label" for="account-wiki-username">Wikipedia username <span style="font-weight:400;color:var(--text-muted)">(optional)</span></label>
          <div style="display:flex;gap:8px;width:100%;">
            <input class="input-field" id="account-wiki-username" type="text" placeholder="e.g. YourWikipediaName" value="${escapeHtml(wikiUsername)}" style="flex:1" minlength="2" maxlength="50" />
            <button class="btn-primary" id="account-save-wiki-username" style="white-space:nowrap;padding:9px 14px;">Save</button>
          </div>
          ${wikiUsername ? `<a href="https://en.wikipedia.org/wiki/User:${encodeURIComponent(wikiUsername)}" target="_blank" rel="noopener" style="font-size:var(--fs-sm);margin-top:4px;display:inline-block;">View your Wikipedia profile →</a>` : ''}
        </div>
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
      <div class="settings-row">
        <div class="settings-row-label">
          <strong>Log out</strong>
          <span>Sign out of your account</span>
        </div>
        <button class="btn-secondary" id="account-logout">Log out</button>
      </div>
    </div>
  `;

  host.querySelector('#account-save-name')?.addEventListener('click', async () => {
    const val = host.querySelector('#account-display-name')?.value?.trim() || '';
    if (val.length < 2) {
      showToast('Display name must be at least 2 characters', 'error');
      return;
    }
    if (val.length > 50) {
      showToast('Display name must be 50 characters or fewer', 'error');
      return;
    }
    const btn = host.querySelector('#account-save-name');
    btn.textContent = 'Saving…';
    btn.disabled = true;
    try {
      await updateDisplayName(val);
      showToast('Display name updated', 'success');
    } catch (err) {
      showToast(err?.message || 'Could not update display name', 'error');
    } finally {
      btn.textContent = 'Save name';
      btn.disabled = false;
    }
  });

  host.querySelector('#account-save-wiki-username')?.addEventListener('click', async () => {
    const val = host.querySelector('#account-wiki-username')?.value?.trim() || '';
    if (val && val.length < 2) {
      showToast('Wikipedia username must be at least 2 characters if provided', 'error');
      return;
    }
    if (val.length > 50) {
      showToast('Wikipedia username must be 50 characters or fewer', 'error');
      return;
    }
    const btn = host.querySelector('#account-save-wiki-username');
    btn.textContent = 'Saving…';
    btn.disabled = true;
    try {
      await upsertProfile(user.id, { wikipedia_username: val || null });
      showToast(val ? 'Wikipedia username saved' : 'Wikipedia username removed', 'success');
    } catch (err) {
      showToast(err?.message || 'Could not save Wikipedia username', 'error');
    } finally {
      btn.textContent = 'Save';
      btn.disabled = false;
    }
  });

  host.querySelector('#account-reset-password')?.addEventListener('click', async () => {
    const btn = host.querySelector('#account-reset-password');
    btn.textContent = 'Sending…';
    btn.disabled = true;
    try {
      await sendPasswordReset(user.email);
      showToast('Password reset email sent — check your inbox', 'success');
    } catch (err) {
      showToast(err?.message || 'Could not send reset email', 'error');
    } finally {
      btn.textContent = 'Send reset email';
      btn.disabled = false;
    }
  });

  host.querySelector('#account-logout')?.addEventListener('click', async () => {
    try {
      await signOut();
      showToast('Signed out successfully', 'success');
      window.reloadFeed?.();
      window.showPage?.('feed-page');
    } catch (err) {
      showToast(err?.message || 'Could not sign out', 'error');
    }
  });

  await renderLikesSection();
}

function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
