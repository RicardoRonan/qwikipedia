// pronounce.js - Web Speech API pronunciation (local, no network)

import { Storage } from './storage.js';
import { escapeHtml } from './text-utils.js';
import { ICONS } from './icons.js';

const supported = typeof window !== 'undefined'
  && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;

const LANG_MAP = {
  en: 'en-US', simple: 'en-US', fr: 'fr-FR', de: 'de-DE', es: 'es-ES',
  pt: 'pt-PT', it: 'it-IT', nl: 'nl-NL', ru: 'ru-RU', ja: 'ja-JP', zh: 'zh-CN',
};

let _voices = [];
let _activeBtn = null;
let _current = null;
let _highlightEl = null;
let _highlightTimer = null;
let _highlightWordIndex = 0;
let _highlightRate = 1;
let _boundaryWord = 0;
let _paused = false;
let _dock = null;
let _fullText = '';
let _spokenIndex = 0;
let _highlightOffset = 0;

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

function wrapSpeechWords(el) {
  if (!el) return;
  if (el.dataset.wordsWrapped === '1' && el.querySelector('.speech-word')) return;
  const text = el.textContent || '';
  const re = /\S+/g;
  let html = '';
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    html += escapeHtml(text.slice(last, m.index));
    html += `<span class="speech-word" data-start="${m.index}">${escapeHtml(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  html += escapeHtml(text.slice(last));
  el.innerHTML = html;
  el.dataset.wordsWrapped = '1';
}

function highlightChar(el, charIndex) {
  const words = el.querySelectorAll('.speech-word');
  if (!words.length) return;
  let active = words[0];
  for (const w of words) {
    if (Number(w.dataset.start) <= charIndex) active = w;
    else break;
  }
  words.forEach(w => w.classList.toggle('is-spoken', w === active));
}

function wordIndexForChar(el, charIndex) {
  const words = el.querySelectorAll('.speech-word');
  let i = 0;
  for (let k = 0; k < words.length; k++) {
    if (Number(words[k].dataset.start) <= charIndex) i = k;
    else break;
  }
  return i;
}

function clearHighlight() {
  if (_highlightTimer) { clearInterval(_highlightTimer); _highlightTimer = null; }
  const el = _highlightEl;
  _highlightEl = null;
  if (!el) return;
  el.querySelectorAll('.speech-word.is-spoken').forEach(w => w.classList.remove('is-spoken'));
  el.classList.remove('is-speech-reading');
}

function prepareHighlight(el) {
  wrapSpeechWords(el);
  el.classList.add('expanded', 'is-speech-reading');
  el.setAttribute('aria-expanded', 'true');
  const toggle = el.parentElement?.querySelector('.card-extract-toggle');
  if (toggle) {
    toggle.setAttribute('aria-expanded', 'true');
    toggle.textContent = 'Show less';
  }
}

function startFallbackHighlight(el, rate, fromIndex = 0) {
  const words = [...el.querySelectorAll('.speech-word')];
  if (words.length < 2) return;
  _highlightRate = Number.isFinite(rate) ? rate : 1;
  const wpm = 165 * _highlightRate;
  const ms = Math.max(160, 60000 / wpm);
  _highlightWordIndex = Math.max(0, fromIndex);
  const start0 = Number(words[_highlightWordIndex].dataset.start);
  _spokenIndex = Math.max(0, start0 - _highlightOffset);
  highlightChar(el, start0);
  if (_highlightTimer) { clearInterval(_highlightTimer); _highlightTimer = null; }
  _highlightTimer = setInterval(() => {
    if (_paused || el.dataset.gotBoundary === '1') {
      clearInterval(_highlightTimer);
      _highlightTimer = null;
      return;
    }
    _highlightWordIndex += 1;
    if (_highlightWordIndex >= words.length) {
      clearInterval(_highlightTimer);
      _highlightTimer = null;
      return;
    }
    const start = Number(words[_highlightWordIndex].dataset.start);
    _spokenIndex = Math.max(0, start - _highlightOffset);
    highlightChar(el, start);
  }, ms);
}

function ensureDock() {
  if (_dock) return _dock;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'speech-dock';
  btn.className = 'speech-dock';
  btn.hidden = true;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    togglePause();
  });
  document.body.appendChild(btn);
  _dock = btn;
  return btn;
}

function syncDock() {
  const dock = ensureDock();
  const active = !!_current;
  dock.hidden = !active;
  if (!active) return;
  dock.innerHTML = _paused ? (ICONS.play || '') : (ICONS.pause || '');
  dock.setAttribute('aria-label', _paused ? 'Resume reading' : 'Pause reading');
}

function togglePause() {
  if (!_current) return;
  if (_paused) resumeSpeaking();
  else pauseSpeaking();
}

function pauseSpeaking() {
  if (!supported || !_current || _paused) return;
  _paused = true;
  if (_highlightTimer) { clearInterval(_highlightTimer); _highlightTimer = null; }
  if (window.speechSynthesis.speaking) window.speechSynthesis.pause();
  syncDock();
  setTimeout(() => {
    if (!_paused || !_current) return;
    if (!window.speechSynthesis.paused) window.speechSynthesis.cancel();
  }, 80);
}

function resumeSpeaking() {
  if (!supported || !_paused) return;
  const button = _activeBtn;
  const highlightEl = _highlightEl;
  const sliced = (_fullText || '').slice(_spokenIndex);
  const lead = (sliced.match(/^\s*/) || [''])[0].length;
  const rest = sliced.trim();
  const offset = _highlightOffset + _spokenIndex + lead;
  _paused = false;
  if (window.speechSynthesis.paused && (window.speechSynthesis.speaking || window.speechSynthesis.pending)) {
    window.speechSynthesis.resume();
    if (highlightEl && highlightEl.dataset.gotBoundary !== '1') {
      startFallbackHighlight(highlightEl, _highlightRate, _highlightWordIndex);
    }
    syncDock();
    return;
  }
  if (!rest) { stopSpeaking(); return; }
  speak(rest, { button, highlightEl, charOffset: offset });
}

export function stopSpeaking() {
  if (!supported) return;
  _paused = false;
  _fullText = '';
  _spokenIndex = 0;
  _highlightOffset = 0;
  window.speechSynthesis.cancel();
  _current = null;
  if (_activeBtn) { _activeBtn.classList.remove('is-speaking'); _activeBtn.setAttribute('aria-pressed', 'false'); }
  _activeBtn = null;
  clearHighlight();
  syncDock();
}

export function isSpeaking() { return supported && window.speechSynthesis.speaking; }

export function speak(text, { button = null, highlightEl = null, charOffset = 0 } = {}) {
  if (!supported || !text) return;
  const prefs = Storage.getPrefs();
  if (prefs.pronounceEnabled === false) return;
  if (charOffset > 0) {
    _paused = false;
    window.speechSynthesis.cancel();
    _current = null;
  } else {
    stopSpeaking();
  }

  _fullText = text;
  _spokenIndex = 0;
  _highlightOffset = charOffset;

  if (highlightEl) {
    _highlightEl = highlightEl;
    _boundaryWord = 0;
    delete highlightEl.dataset.gotBoundary;
    if (charOffset === 0) {
      prepareHighlight(highlightEl);
      text = (highlightEl.textContent || '').trim() || text;
      _fullText = text;
    }
  }

  const bcp47 = langFor(prefs.wikiLang || 'en');
  const u = new SpeechSynthesisUtterance(text);
  u.lang = bcp47;
  const rate = Number(prefs.pronounceRate);
  u.rate = Number.isFinite(rate) ? Math.min(1.5, Math.max(0.5, rate)) : 1;
  const voice = pickVoice(bcp47);
  if (voice) u.voice = voice;

  u.onboundary = (e) => {
    if (_current !== u || !_highlightEl || _paused) return;
    if (e.name && e.name !== 'word') return;
    _highlightEl.dataset.gotBoundary = '1';
    if (_highlightTimer) { clearInterval(_highlightTimer); _highlightTimer = null; }
    _spokenIndex = e.charIndex || 0;
    let idx = _spokenIndex + _highlightOffset;
    if (_spokenIndex === 0 && _boundaryWord > 0) {
      const words = _highlightEl.querySelectorAll('.speech-word');
      const w = words[_boundaryWord];
      if (w) idx = Number(w.dataset.start);
    }
    _highlightWordIndex = _boundaryWord;
    _boundaryWord += 1;
    highlightChar(_highlightEl, idx);
  };

  u.onend = u.onerror = () => {
    if (_current !== u) return;
    if (_paused) return;
    _current = null;
    _paused = false;
    if (button) { button.classList.remove('is-speaking'); button.setAttribute('aria-pressed', 'false'); }
    if (_activeBtn === button) _activeBtn = null;
    clearHighlight();
    syncDock();
  };

  _current = u;
  _paused = false;
  _activeBtn = button;
  if (button) { button.classList.add('is-speaking'); button.setAttribute('aria-pressed', 'true'); }
  if (_highlightEl) {
    const from = charOffset > 0 ? wordIndexForChar(_highlightEl, charOffset) : 0;
    startFallbackHighlight(_highlightEl, u.rate, from);
  }
  syncDock();
  // cancel() then speak() in the same turn is dropped by Chromium
  const start = () => {
    if (_current !== u) return;
    window.speechSynthesis.speak(u);
    if (_paused) window.speechSynthesis.pause();
  };
  if (window.speechSynthesis.speaking || window.speechSynthesis.pending) setTimeout(start, 80);
  else setTimeout(start, 0);
}

export function bindPronounceButtons(root = document) {
  if (!supported) { root.querySelectorAll('[data-pronounce-text]').forEach(b => b.remove()); return; }
  root.querySelectorAll('[data-pronounce-text]').forEach(btn => {
    if (btn.dataset.pronounceBound) return;
    btn.dataset.pronounceBound = '1';
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const extract = btn.classList.contains('card-extract-listen')
        ? (btn.closest('.card')?.querySelector('.card-extract')
          || btn.closest('.like-card')?.querySelector('.like-card-extract'))
        : null;
      const text = (extract?.textContent || btn.dataset.pronounceText || '').trim();
      if (btn.classList.contains('is-speaking')) stopSpeaking();
      else speak(text, { button: btn, highlightEl: extract || null });
    });
  });
}

export function initPronounce() {
  if (!supported) return;
  ensureDock();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') stopSpeaking();
  });
}
