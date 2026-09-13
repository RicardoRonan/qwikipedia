// pronounce.js - Web Speech API pronunciation (local, no network)

import { Storage } from './storage.js';

const supported = typeof window !== 'undefined'
  && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;

const LANG_MAP = {
  en: 'en-US', simple: 'en-US', fr: 'fr-FR', de: 'de-DE', es: 'es-ES',
  pt: 'pt-PT', it: 'it-IT', nl: 'nl-NL', ru: 'ru-RU', ja: 'ja-JP', zh: 'zh-CN',
};

let _voices = [];
let _activeBtn = null;
let _current = null;

function loadVoices() { if (supported) _voices = window.speechSynthesis.getVoices() || []; }
if (supported) {
  loadVoices();
  window.speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
}

export function isPronounceSupported() { return supported; }
export function getVoices() { return _voices; }
function langFor(wikiLang) { return LANG_MAP[wikiLang] || 'en-US'; }

function pickVoice(bcp47) {
  const prefs = Storage.getPrefs();
  const base = (bcp47 || 'en').split('-')[0];
  if (prefs.pronounceVoice) {
    const chosen = _voices.find(v => v.voiceURI === prefs.pronounceVoice);
    if (chosen) return chosen;
  }
  return _voices.find(v => (v.lang || '').toLowerCase().startsWith(base))
    || _voices.find(v => (v.lang || '').toLowerCase().startsWith('en'))
    || _voices[0] || null;
}

export function stopSpeaking() {
  if (!supported) return;
  window.speechSynthesis.cancel();
  _current = null;
  if (_activeBtn) { _activeBtn.classList.remove('is-speaking'); _activeBtn.setAttribute('aria-pressed', 'false'); }
  _activeBtn = null;
}

export function isSpeaking() { return supported && window.speechSynthesis.speaking; }

export function speak(text, { button = null } = {}) {
  if (!supported || !text) return;
  const prefs = Storage.getPrefs();
  if (prefs.pronounceEnabled === false) return;
  stopSpeaking();

  const bcp47 = langFor(prefs.wikiLang || 'en');
  const u = new SpeechSynthesisUtterance(text);
  u.lang = bcp47;
  const rate = Number(prefs.pronounceRate);
  u.rate = Number.isFinite(rate) ? Math.min(1.5, Math.max(0.5, rate)) : 1;
  const voice = pickVoice(bcp47);
  if (voice) u.voice = voice;

  u.onend = u.onerror = () => {
    if (_current === u) _current = null;
    if (button) { button.classList.remove('is-speaking'); button.setAttribute('aria-pressed', 'false'); }
    if (_activeBtn === button) _activeBtn = null;
  };

  _current = u;
  _activeBtn = button;
  if (button) { button.classList.add('is-speaking'); button.setAttribute('aria-pressed', 'true'); }
  window.speechSynthesis.speak(u);
}

export function bindPronounceButtons(root = document) {
  if (!supported) { root.querySelectorAll('[data-pronounce-text]').forEach(b => b.remove()); return; }
  root.querySelectorAll('[data-pronounce-text]').forEach(btn => {
    if (btn.dataset.pronounceBound) return;
    btn.dataset.pronounceBound = '1';
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const text = btn.dataset.pronounceText || '';
      if (btn.classList.contains('is-speaking')) stopSpeaking();
      else speak(text, { button: btn });
    });
  });
}

export function initPronounce() {
  if (!supported) return;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') stopSpeaking();
  });
}
