import { getCurrentUser, sendPasswordReset, updateDisplayName, signOut, getProfile, upsertProfile } from './auth.js';
import { renderLikesSection } from './settings.js';
import { showToast } from './toast.js';
import { escapeHtml } from './text-utils.js';
import { ICONS } from './icons.js';
import { panelLoading, stateBox, setButtonLoading } from './ui.js';

export async function renderAccountPage() {
  const host = document.getElementById('account-page-content');
  if (!host) return;

  host.innerHTML = panelLoading('Loading account details…');

  const user = await getCurrentUser();
  if (!user) {
    host.innerHTML = stateBox({
      icon: ICONS.alertCircle,
      title: 'Sign in required',
      body: 'Please sign in to access account settings.',
      action: { label: 'Sign in', action: 'open-auth' },
    });
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
      <div class="settings-row settings-row--stack-sm">
        <div class="settings-row-label">
          <strong>${escapeHtml(user.email || '')}</strong>
          <span>Email address</span>
        </div>
        <div class="input-group">
          <label class="input-label" for="account-display-name">Display name</label>
          <input class="input-field" id="account-display-name" value="${escapeHtml(displayName)}" minlength="2" maxlength="50" />
          <span class="input-hint">2–50 characters</span>
        </div>
        <button class="btn-primary" id="account-save-name"><span class="btn-label">Save name</span></button>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-header">Wikipedia</div>
      <div class="settings-row settings-row--stack-sm">
        <div class="input-group">
          <label class="input-label" for="account-wiki-username">Wikipedia username <span class="label-optional">(optional)</span></label>
          <div class="input-row">
            <input class="input-field" id="account-wiki-username" type="text" placeholder="e.g. YourWikipediaName" value="${escapeHtml(wikiUsername)}" minlength="2" maxlength="50" />
            <button class="btn-primary btn-compact" id="account-save-wiki-username"><span class="btn-label">Save</span></button>
          </div>
          ${wikiUsername ? `<a href="https://en.wikipedia.org/wiki/User:${encodeURIComponent(wikiUsername)}" target="_blank" rel="noopener" class="wiki-profile-link">View your Wikipedia profile →</a>` : ''}
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
        <button class="btn-secondary" id="account-reset-password"><span class="btn-label">Send reset email</span></button>
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
    setButtonLoading(btn, true);
    try {
      await updateDisplayName(val);
      showToast('Display name updated', 'success');
    } catch (err) {
      showToast(err?.message || 'Could not update display name', 'error');
    } finally {
      setButtonLoading(btn, false, 'Save name');
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
    setButtonLoading(btn, true);
    try {
      await upsertProfile(user.id, { wikipedia_username: val || null });
      showToast(val ? 'Wikipedia username saved' : 'Wikipedia username removed', 'success');
    } catch (err) {
      showToast(err?.message || 'Could not save Wikipedia username', 'error');
    } finally {
      setButtonLoading(btn, false, 'Save');
    }
  });

  host.querySelector('#account-reset-password')?.addEventListener('click', async () => {
    const btn = host.querySelector('#account-reset-password');
    setButtonLoading(btn, true);
    try {
      await sendPasswordReset(user.email);
      showToast('Password reset email sent - check your inbox', 'success');
    } catch (err) {
      showToast(err?.message || 'Could not send reset email', 'error');
    } finally {
      setButtonLoading(btn, false, 'Send reset email');
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
