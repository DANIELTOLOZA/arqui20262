/* app.js — Arranque: pestañas, tema y atajos de teclado. */
(function () {
  'use strict';
  const { $, $$ } = UI;
  const TABS = ['real', 'protegido', 'reversing', 'teoria'];
  let active = 'real';

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch (e) { return null; }
    return null;
  }

  function go(tab, fromHash) {
    if (!TABS.includes(tab)) tab = 'real';
    active = tab;
    $$('.tab').forEach((b) => {
      const on = b.dataset.tab === tab;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
    TABS.forEach((t) => { $('#panel-' + t).hidden = t !== tab; });
    moveInk();
    if (!fromHash && location.hash !== '#' + tab) {
      try { history.replaceState(null, '', '#' + tab); } catch (e) { /* entornos sin history */ }
    }
    store('seglab-tab', tab);
    window.scrollTo({ top: 0 });
  }

  function moveInk() {
    const btn = $('.tab[aria-selected="true"]');
    const ink = $('.tab-ink');
    if (!btn || !ink) return;
    ink.style.width = btn.offsetWidth + 'px';
    ink.style.transform = 'translateX(' + btn.offsetLeft + 'px)';
  }

  function initTheme() {
    const saved = store('seglab-theme');
    if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
    $('#theme-toggle').addEventListener('click', () => {
      const cur = document.documentElement.dataset.theme ||
        (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      store('seglab-theme', next);
    });
  }

  function initKeys() {
    document.addEventListener('keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable) return;
      if (e.target.closest && e.target.closest('[role="radiogroup"], [role="tablist"]')) return;
      const p = active === 'real' ? RealMode.player() : active === 'protegido' ? ProtectedMode.player() : null;
      if (!p) return;
      if (e.key === 'ArrowRight') { p.pause(); p.go(p.index + 1); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { p.pause(); p.go(p.index - 1); e.preventDefault(); }
      else if (e.key === 'Home') { p.pause(); p.go(0); e.preventDefault(); }
      else if (e.key === 'End') { p.pause(); p.go(p.steps.length - 1); e.preventDefault(); }
      else if (e.key === ' ' && tag !== 'button') { p.toggle(); e.preventDefault(); }
    });
  }

  function initTabs() {
    const tabs = $$('.tab');
    tabs.forEach((b, i) => {
      b.addEventListener('click', () => go(b.dataset.tab));
      b.addEventListener('keydown', (e) => {
        const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        const nb = tabs[(i + d + tabs.length) % tabs.length];
        go(nb.dataset.tab);
        nb.focus();
      });
    });
    window.addEventListener('hashchange', () => go(location.hash.slice(1), true));
    window.addEventListener('resize', moveInk);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveInk);
  }

  function boot() {
    initTheme();
    RealMode.init();
    ProtectedMode.init();
    Reverse.init();
    Theory.init();
    initTabs();
    initKeys();
    const fromHash = location.hash.slice(1);
    go(TABS.includes(fromHash) ? fromHash : store('seglab-tab') || 'real', true);
    document.documentElement.classList.add('ready');
  }

  window.App = { go };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
