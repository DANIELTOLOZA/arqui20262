/* ui.js — Utilidades de interfaz compartidas: selección, escape, entradas hex,
 * controles segmentados y el reproductor de pasos. */
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /**
   * Conecta un <input> hexadecimal: valida mientras se escribe y muestra el error
   * en el párrafo .msg del mismo campo.
   */
  function hexInput(input, bits, label, onValid) {
    const field = input.closest('.field');
    const msg = field ? $('.msg', field) : null;
    const help = msg ? msg.innerHTML : '';
    function check() {
      const r = X86.parseHex(input.value, bits, label);
      input.classList.toggle('invalid', !r.ok);
      input.setAttribute('aria-invalid', r.ok ? 'false' : 'true');
      if (msg) {
        msg.classList.toggle('error', !r.ok);
        msg.innerHTML = r.ok ? help : esc(r.error);
      }
      return r;
    }
    input.addEventListener('input', () => {
      const r = check();
      if (r.ok && onValid) onValid(r.value);
    });
    input.addEventListener('blur', () => {
      const r = X86.parseHex(input.value, bits, label);
      if (r.ok) input.value = X86.hex(r.value, Math.ceil(bits / 4));
    });
    return { check, get: () => X86.parseHex(input.value, bits, label), set: (v) => { input.value = X86.hex(v, Math.ceil(bits / 4)); check(); } };
  }

  /** Control segmentado (radiogroup) con navegación por teclado. */
  function segmented(root, initial, onChange) {
    const buttons = $$('button', root);
    let value = initial;
    function render() {
      buttons.forEach((b) => {
        const on = b.dataset.value === String(value);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      });
    }
    buttons.forEach((b, i) => {
      b.addEventListener('click', () => { set(b.dataset.value); });
      b.addEventListener('keydown', (e) => {
        const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        e.stopPropagation();
        const nb = buttons[(i + d + buttons.length) % buttons.length];
        set(nb.dataset.value);
        nb.focus();
      });
    });
    function set(v, silent) {
      value = v;
      render();
      if (!silent && onChange) onChange(v);
    }
    render();
    return { get: () => value, set };
  }

  /**
   * Reproductor paso a paso. Las piezas visuales usan data-s="n": se muestran
   * cuando el paso actual es ≥ n y se resaltan cuando es exactamente n.
   */
  class Player {
    constructor(root, viz, opts) {
      this.root = root;
      this.viz = viz;
      this.opts = opts || {};
      this.stepper = $('[data-stepper]', root);
      this.explain = $('[data-explain]', root);
      this.progress = $('[data-progress]', root);
      this.speed = $('[data-speed]', root);
      this.playBtn = $('[data-act="play"]', root);
      this.playLabel = $('[data-play-label]', root);
      this.steps = [];
      this.index = 0;
      this.timer = null;
      root.addEventListener('click', (e) => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        const act = b.dataset.act;
        if (act === 'prev') this.pause(), this.go(this.index - 1);
        else if (act === 'next') this.pause(), this.go(this.index + 1);
        else if (act === 'restart') this.pause(), this.go(0);
        else if (act === 'end') this.pause(), this.go(this.steps.length - 1);
        else if (act === 'play') this.toggle();
      });
      this.stepper.addEventListener('click', (e) => {
        const li = e.target.closest('[data-i]');
        if (li) { this.pause(); this.go(+li.dataset.i); }
      });
    }

    load(steps, start) {
      this.pause();
      this.steps = steps;
      this.stepper.innerHTML = steps.map((s, i) =>
        '<li data-i="' + i + '"' + (s.kind ? ' data-kind="' + s.kind + '"' : '') + '><button type="button" aria-label="Paso ' + (i + 1) + ': ' + esc(s.title) + '"><span class="n">' + (i + 1) + '</span><span class="t">' + esc(s.title) + '</span></button></li>'
      ).join('');
      this.go(start == null ? 0 : start, true);
    }

    go(i, instant) {
      if (!this.steps.length) return;
      i = Math.max(0, Math.min(this.steps.length - 1, i));
      this.index = i;
      const step = this.steps[i];
      $$('li', this.stepper).forEach((li, k) => {
        li.classList.toggle('done', k < i);
        li.classList.toggle('now', k === i);
        if (k === i) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
      });
      const nowLi = $('li.now', this.stepper);
      if (nowLi && this.stepper.scrollWidth > this.stepper.clientWidth) {
        this.stepper.scrollTo({ left: nowLi.offsetLeft - this.stepper.clientWidth / 2 + nowLi.clientWidth / 2, behavior: instant || reducedMotion() ? 'auto' : 'smooth' });
      }
      this.explain.innerHTML =
        '<p class="explain-k">Paso ' + (i + 1) + ' de ' + this.steps.length + '</p>' +
        '<h3>' + esc(step.title) + '</h3><div class="explain-body">' + step.text + '</div>';
      if (this.progress) this.progress.style.width = ((i + 1) / this.steps.length) * 100 + '%';
      this.viz.classList.toggle('instant', !!instant);
      $$('[data-s]', this.viz).forEach((el) => {
        const s = +el.dataset.s;
        el.classList.toggle('on', s <= i);
        el.classList.toggle('now', s === i);
      });
      if (this.opts.onStep) this.opts.onStep(i, step, !!instant);
      if (instant) requestAnimationFrame(() => this.viz.classList.remove('instant'));
    }

    toggle() { this.timer ? this.pause() : this.play(); }

    play() {
      if (this.index >= this.steps.length - 1) this.go(0);
      this.setPlaying(true);
      const tick = () => {
        if (this.index >= this.steps.length - 1) { this.pause(); return; }
        this.go(this.index + 1);
        this.timer = setTimeout(tick, +this.speed.value);
      };
      this.timer = setTimeout(tick, +this.speed.value);
    }

    pause() {
      clearTimeout(this.timer);
      this.timer = null;
      this.setPlaying(false);
    }

    setPlaying(on) {
      this.root.classList.toggle('playing', on);
      if (this.playLabel) this.playLabel.textContent = on ? 'Pausar' : 'Reproducir';
      if (this.playBtn) this.playBtn.setAttribute('aria-label', on ? 'Pausar' : 'Reproducir');
    }
  }

  /** Dibuja una fila de chips de ejemplos. */
  function chips(root, items, onPick) {
    root.innerHTML = items.map((it, i) =>
      '<button type="button" class="chip' + (it.kind ? ' chip-' + it.kind : '') + '" data-i="' + i + '" title="' + esc(it.hint || '') + '">' + esc(it.label) + '</button>'
    ).join('');
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-i]');
      if (b) onPick(items[+b.dataset.i], b);
    });
  }

  /** Muestra un dígito/bit por celda. */
  function cells(str, cls, attrs) {
    return Array.from(str).map((c) => '<span class="' + cls + '"' + (attrs || '') + '>' + esc(c) + '</span>').join('');
  }

  function toast(msg) {
    let t = $('#toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast';
      t.className = 'toast';
      t.setAttribute('role', 'status');
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('show'), 2400);
  }

  window.UI = { $, $$, esc, hexInput, segmented, Player, chips, cells, toast, reducedMotion };
})();
