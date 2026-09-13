// pwa-install.js - install affordance for the PWA

let _deferred = null;

export function initInstallPrompt() {
  const section = document.getElementById('install-app-section');
  const btn = document.getElementById('install-app-btn');
  const status = document.getElementById('install-app-status');
  if (!section) return;

  const standalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
  if (standalone) { section.hidden = true; return; }
  section.hidden = false;

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (isIOS && status) status.textContent = 'On iPhone/iPad: tap Share, then "Add to Home Screen".';

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    _deferred = e;
    if (btn) btn.hidden = false;
    if (status) status.textContent = 'Install Qwikipedia for a full-screen, offline-ready app.';
  });

  window.addEventListener('appinstalled', () => { _deferred = null; section.hidden = true; });

  btn?.addEventListener('click', async () => {
    if (_deferred) {
      _deferred.prompt();
      const { outcome } = await _deferred.userChoice;
      if (outcome === 'accepted') { _deferred = null; section.hidden = true; }
    } else if (isIOS && status) {
      status.textContent = 'Tap Share, then "Add to Home Screen".';
    } else if (status) {
      status.textContent = 'Use your browser menu: "Install app" / "Add to Home screen".';
    }
  });
}
