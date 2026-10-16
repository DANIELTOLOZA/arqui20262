/* real.js — Simulador de direccionamiento en modo real. */
(function () {
  'use strict';
  const { $, esc, hexInput, Player, chips, cells } = UI;
  const H = X86.hex;
  const dec = (n) => n.toLocaleString('es-CO');
  const MAP_MAX = 0x110000; // 1 MiB + 64 KiB (para mostrar la HMA)

  const PRESETS = [
    { label: '1234:5678', seg: 0x1234, off: 0x5678, hint: 'Ejemplo clásico de clase' },
    { label: 'B800:0000', seg: 0xb800, off: 0x0000, hint: 'Primer carácter de la pantalla en modo texto' },
    { label: '07C0:0000', seg: 0x07c0, off: 0x0000, hint: 'Donde el BIOS carga el sector de arranque (7C00h)' },
    { label: 'FFFF:0000', seg: 0xffff, off: 0x0000, hint: 'Vector de reinicio: primera instrucción tras encender' },
    { label: '0040:0017', seg: 0x0040, off: 0x0017, hint: 'Estado del teclado en el área de datos del BIOS' },
    { label: 'FFFF:FFFF', seg: 0xffff, off: 0xffff, hint: 'Desborda los 20 bits: prueba con y sin A20', kind: 'warn' },
  ];

  let player, segIn, offIn, a20, viz, current;

  function init() {
    viz = $('#real-viz');
    a20 = $('#real-a20');
    segIn = hexInput($('#real-seg'), 16, 'El segmento');
    offIn = hexInput($('#real-off'), 16, 'El desplazamiento');
    player = new Player($('#real-stage [data-player]'), viz, { onStep });

    $('#real-form').addEventListener('submit', (e) => { e.preventDefault(); run(true); });
    a20.addEventListener('change', () => run(false, true));
    chips($('#real-presets'), PRESETS, (p) => {
      segIn.set(p.seg);
      offIn.set(p.off);
      run(true);
    });
    viz.addEventListener('click', (e) => {
      const b = e.target.closest('[data-eq]');
      if (!b) return;
      const [s, o] = b.dataset.eq.split(':').map((x) => parseInt(x, 16));
      segIn.set(s);
      offIn.set(o);
      run(false);
      UI.toast('Cargado ' + H(s, 4) + ':' + H(o, 4) + ' — misma dirección física');
    });
    initQuiz();
    run(false);
  }

  function run(animate, keepStep) {
    const s = segIn.check();
    const o = offIn.check();
    if (!s.ok || !o.ok) {
      (s.ok ? $('#real-off') : $('#real-seg')).focus();
      return;
    }
    const r = X86.realMode(s.value, o.value, a20.checked);
    current = r;
    viz.innerHTML = render(r);
    const steps = buildSteps(r);
    const at = keepStep ? player.index : animate ? 0 : steps.length - 1;
    player.load(steps, at);
    if (animate) player.play();
  }

  function onStep(i) {
    viz.classList.toggle('shifted', i >= 1);
    viz.classList.toggle('mapped', i >= 5);
  }

  /* ---------------------------- Pasos ---------------------------- */

  function buildSteps(r) {
    const segBin = X86.group(X86.bin(r.segment, 16), 4);
    const cols = r.columns.slice(0, r.overflow ? 6 : 5);
    const ops = cols.map((c) => {
      const t = c.a + c.b + c.carryIn;
      return '<li><span class="mono">' + H(c.a) + ' + ' + H(c.b) + (c.carryIn ? ' + <b class="carry-t">1</b>' : '') + ' = ' + H(t) + 'h</span>' +
        (t >= 16 ? ' → escribe <b>' + H(c.digit) + '</b>, lleva 1' : '') + '</li>';
    }).join('');
    const physHex = H(r.physical, r.physical > 0xfffff ? 6 : 5);
    const region = r.region ? r.region.name : '—';
    return [
      {
        title: 'Leer el segmento',
        text: '<p>El registro de segmento contiene <b class="mono">' + H(r.segment, 4) + 'h</b> = <span class="mono">' + segBin + 'b</span>.</p>' +
          '<p>No es una dirección: dice en qué <em>párrafo</em> (bloque de 16 bytes) comienza el segmento.</p>',
      },
      {
        title: 'Desplazar 4 bits (× 10h)',
        text: '<p>Multiplicar por 16 es desplazar 4 bits a la izquierda: se agrega un <b>0</b> hexadecimal a la derecha.</p>' +
          '<p class="mono big-eq">' + H(r.segment, 4) + 'h × 10h = <b>' + H(r.shifted, 5) + 'h</b></p><p>Esa es la dirección base donde empieza el segmento.</p>',
      },
      {
        title: 'Alinear el desplazamiento',
        text: '<p>El desplazamiento <b class="mono">' + H(r.offset, 4) + 'h</b> (' + dec(r.offset) + ' bytes) se alinea a la derecha, sin desplazar.</p>' +
          '<p>Indica cuántos bytes avanzar desde la base: de 0 a FFFFh (64 KiB por segmento).</p>',
      },
      {
        title: 'Sumar columna por columna',
        text: '<p>Se suma de derecha a izquierda, como en papel, pero en base 16:</p><ol class="ops">' + ops + '</ol>',
      },
      {
        title: r.overflow ? 'Resultado y desborde' : 'Dirección física',
        text: r.overflow
          ? '<p>La suma da <b class="mono">' + H(r.sum, 6) + 'h</b>, que necesita <b>21 bits</b>.</p>' +
            (r.a20
              ? '<p>Con <b>A20 habilitada</b> el bit 20 llega al bus: se accede a <b class="mono">' + physHex + 'h</b>, dentro de la HMA (los 65 520 bytes por encima de 1 MiB).</p>'
              : '<p>El 8086 solo tiene 20 líneas (A0–A19): el bit 20 se descarta y la dirección <b>da la vuelta</b> a <b class="mono">' + physHex + 'h</b>. Activa A20 para ver la diferencia.</p>')
          : '<p class="mono big-eq">' + H(r.segment, 4) + ':' + H(r.offset, 4) + ' → <b>' + physHex + 'h</b></p>' +
            '<p>' + dec(r.physical) + ' en decimal. Cabe en 20 bits, el ancho del bus de direcciones del 8086 (A0–A19).</p>',
      },
      {
        title: 'Ubicar en la memoria',
        text: '<p>La dirección cae en <b>' + esc(region) + '</b>.</p>' +
          '<p>El segmento abarca <span class="mono">' + H(r.windowStart, 5) + 'h–' + H(r.windowEnd, r.windowEnd > 0xfffff ? 6 : 5) + 'h</span>. ' +
          (r.equivalentCount > 1
            ? 'Otros <b>' + dec(r.equivalentCount - 1) + '</b> pares segmento:desplazamiento apuntan exactamente al mismo byte.'
            : 'Es el único par que llega a este byte.') + '</p>',
      },
    ];
  }

  /* ---------------------------- Render ---------------------------- */

  function render(r) {
    return regs(r) + hexAdd(r) + binAdd(r) + resultBanner(r) + memMap(r) + equivalents(r);
  }

  function regs(r) {
    return '<div class="regs">' +
      '<div class="reg reg-seg" data-s="0"><span class="reg-name">Segmento</span><span class="reg-val mono">' + H(r.segment, 4) + '<small>h</small></span><span class="reg-bin mono">' + X86.group(X86.bin(r.segment, 16), 4) + '</span></div>' +
      '<div class="reg-op" data-s="1" aria-hidden="true">×10h</div>' +
      '<div class="reg reg-off" data-s="2"><span class="reg-name">Desplazamiento</span><span class="reg-val mono">' + H(r.offset, 4) + '<small>h</small></span><span class="reg-bin mono">' + X86.group(X86.bin(r.offset, 16), 4) + '</span></div>' +
      '</div>';
  }

  function hexAdd(r) {
    // Columnas p = 5..0 (peso 16^p). Columna de la grilla = 2 + (5 - p)
    const gc = (p) => 2 + (5 - p);
    let carries = '';
    for (let p = 1; p <= 5; p++) {
      const c = r.columns[p];
      if (c.carryIn) carries += '<span class="cell carry" style="grid-column:' + gc(p) + ';--d:' + (p - 0.5) + '" data-s="3">1</span>';
    }
    const segDigits = H(r.segment, 4);
    const offDigits = H(r.offset, 4);
    let result = '';
    const top = r.overflow ? 5 : 4;
    for (let p = top; p >= 0; p--) {
      const digit = r.columns[p].digit;
      const lost = p === 5 && !r.a20;
      result += '<span class="cell res' + (p === 5 ? ' ovf' : '') + (lost ? ' lost' : '') + '" style="grid-column:' + gc(p) + ';--d:' + p + '" data-s="3">' + H(digit) + '</span>';
    }
    const weights = [5, 4, 3, 2, 1, 0].map((p) => '<span class="w" style="grid-column:' + gc(p) + '">16<sup>' + p + '</sup></span>').join('');
    return '<div class="hexadd" role="img" aria-label="Suma hexadecimal ' + H(r.shifted, 5) + ' más ' + H(r.offset, 4) + ' igual a ' + H(r.sum, 5) + '">' +
      '<div class="row row-w"><span class="lbl"></span>' + weights + '</div>' +
      '<div class="row row-c"><span class="lbl">acarreo</span>' + carries + '</div>' +
      '<div class="row row-a"><span class="lbl">Segmento<span class="x16" data-s="1"> × 10h</span></span>' +
        '<span class="segdigits" style="grid-column:' + gc(3) + ' / span 4">' + cells(segDigits, 'cell') + '</span>' +
        '<span class="cell zero" style="grid-column:' + gc(0) + '" data-s="1">0</span></div>' +
      '<div class="row row-b" data-s="2"><span class="lbl"><b class="op">+</b> Desplaz.</span><span class="offdigits" style="grid-column:' + gc(3) + ' / span 4">' + cells(offDigits, 'cell') + '</span></div>' +
      '<div class="rule" data-s="3"></div>' +
      '<div class="row row-r"><span class="lbl" data-s="3">Física</span>' + result + '</div>' +
      '</div>';
  }

  function binAdd(r) {
    const nib = (s) => s.replace(/(.{4})/g, '<i>$1</i>');
    const lead = (ch, cls) => '<span class="b21' + (cls ? ' ' + cls : '') + '">' + ch + '</span>';
    const segShift = X86.bin(r.segment, 16);
    const offBin = X86.bin(r.offset, 16);
    const sum20 = X86.bin(r.sum & 0xfffff, 20);
    return '<div class="binadd" aria-label="Misma suma en binario">' +
      '<p class="mini-title">En binario</p>' +
      '<div class="brow" data-s="0"><span class="blbl">Seg × 10h</span><code>' + lead(' ') + nib(segShift) + '<i class="pad" data-s="1">0000</i></code></div>' +
      '<div class="brow" data-s="2"><span class="blbl">+ Desplaz.</span><code>' + lead(' ') + '<i class="dim">0000</i>' + nib(offBin) + '</code></div>' +
      '<div class="brow sum" data-s="3"><span class="blbl">= Física</span><code>' + lead(r.overflow ? '1' : ' ', r.overflow ? (r.a20 ? 'ovf' : 'ovf lost') : '') + nib(sum20) + '</code></div>' +
      '</div>';
  }

  function resultBanner(r) {
    const wide = r.physical > 0xfffff;
    let note = '20 bits · ' + dec(r.physical) + ' decimal';
    if (r.overflow) note = r.a20 ? 'A20 habilitada · zona HMA' : 'Bit 20 descartado · dio la vuelta (wrap-around)';
    return '<div class="result' + (r.overflow ? ' warn' : '') + '" data-s="4">' +
      '<span class="result-k">Dirección física</span>' +
      '<span class="result-v mono">' + H(r.physical, wide ? 6 : 5) + '<small>h</small></span>' +
      '<span class="result-n">' + note + '</span>' +
      '</div>';
  }

  function memMap(r) {
    const pct = (a) => ((a / MAP_MAX) * 100).toFixed(4) + '%';
    const bands = X86.REAL_MEMORY_MAP.map((g) =>
      '<span class="band b-' + g.key + (r.region && r.region.key === g.key ? ' hit' : '') + '" style="left:' + pct(g.start) + ';width:' + pct(g.end - g.start + 1) + '" title="' + esc(g.name) + '"></span>'
    ).join('');
    const winEnd = Math.min(r.windowEnd + 1, MAP_MAX);
    const ticks = [0, 0x40000, 0x80000, 0xc0000, 0x100000].map((a) =>
      '<span class="tick" style="left:' + pct(a) + '">' + H(a, 5) + '</span>'
    ).join('');
    const legend = X86.REAL_MEMORY_MAP.map((g) =>
      '<li class="' + (r.region && r.region.key === g.key ? 'hit' : '') + '"><span class="sw b-' + g.key + '"></span><span class="mono">' + H(g.start, 5) + '–' + H(g.end, g.end > 0xfffff ? 6 : 5) + '</span> ' + esc(g.name) + '</li>'
    ).join('');
    const wrapped = r.overflow && !r.a20;
    const offPct = (r.offset / 0xffff) * 100;
    return '<div class="memsec" data-s="5">' +
      '<p class="mini-title">Mapa del primer megabyte</p>' +
      '<div class="memmap">' +
        '<div class="bands">' + bands + '<span class="limit1m" style="left:' + pct(0x100000) + '"><b>1 MiB</b></span></div>' +
        '<span class="window" style="left:' + pct(r.windowStart) + ';width:' + pct(winEnd - r.windowStart) + '"></span>' +
        '<span class="pin' + (wrapped ? ' wrapped' : '') + '" style="left:' + pct(r.physical) + '"><span class="pin-label mono">' + H(r.physical, r.physical > 0xfffff ? 6 : 5) + 'h' + (wrapped ? ' ↺' : '') + '</span></span>' +
        '<div class="ticks">' + ticks + '</div>' +
      '</div>' +
      '<div class="zoom">' +
        '<p class="zoom-title">Ventana del segmento · 64 KiB</p>' +
        '<div class="zoombar"><span class="zfill" style="width:' + offPct + '%"></span><span class="zpin" style="left:' + offPct + '%"></span></div>' +
        '<div class="zoomlbl mono"><span>' + H(r.segment, 4) + ':0000<br><small>' + H(r.windowStart, 5) + 'h</small></span><span class="zmid">+' + H(r.offset, 4) + 'h</span><span>' + H(r.segment, 4) + ':FFFF<br><small>' + H(r.windowEnd, r.windowEnd > 0xfffff ? 6 : 5) + 'h</small></span></div>' +
      '</div>' +
      '<ul class="legend">' + legend + '</ul>' +
      '</div>';
  }

  function equivalents(r) {
    if (r.equivalentCount <= 1) return '';
    const items = r.equivalents.map((e) => {
      const same = e.segment === r.segment;
      const norm = r.normalized && e.segment === r.normalized.segment;
      return '<button type="button" class="eq' + (same ? ' same' : '') + '" data-eq="' + H(e.segment, 4) + ':' + H(e.offset, 4) + '"' + (same ? ' disabled' : '') + '>' +
        '<span class="mono">' + H(e.segment, 4) + ':' + H(e.offset, 4) + '</span>' + (same ? '<small>tu entrada</small>' : '') + '</button>';
    }).join('');
    const n = r.normalized;
    return '<div class="equiv" data-s="5">' +
      '<p class="mini-title">Direcciones equivalentes</p>' +
      '<p class="equiv-lead"><b>' + dec(r.equivalentCount) + '</b> pares distintos apuntan al mismo byte, porque los segmentos se solapan cada 16 bytes.' +
      (n ? ' Forma normalizada (desplazamiento &lt; 10h): <span class="mono norm">' + H(n.segment, 4) + ':' + H(n.offset, 4) + '</span>.' : '') + '</p>' +
      '<div class="eq-list">' + items + '</div>' +
      '</div>';
  }

  /* ---------------------------- Reto ---------------------------- */

  function initQuiz() {
    let q = null;
    let streak = 0;
    const fb = $('#quiz-feedback');
    function next() {
      const seg = Math.floor(Math.random() * 0xe000) & 0xfff0 | Math.floor(Math.random() * 16);
      const off = Math.floor(Math.random() * 0x10000);
      q = { seg, off, ans: X86.realMode(seg, off, false).physical };
      $('#quiz-pair').textContent = H(seg, 4) + ':' + H(off, 4);
      $('#quiz-answer').value = '';
      fb.innerHTML = '';
      fb.className = 'quiz-feedback';
    }
    $('#quiz-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const r = X86.parseHex($('#quiz-answer').value, 24, 'Tu respuesta');
      if (!r.ok) {
        fb.className = 'quiz-feedback bad';
        fb.textContent = r.error;
        return;
      }
      if (r.value === q.ans) {
        streak++;
        fb.className = 'quiz-feedback good';
        fb.innerHTML = '¡Correcto! ' + H(q.seg, 4) + 'h × 10h + ' + H(q.off, 4) + 'h = <b>' + H(q.ans, 5) + 'h</b>';
        setTimeout(next, 1800);
      } else {
        streak = 0;
        fb.className = 'quiz-feedback bad';
        fb.innerHTML = 'No es ' + H(r.value) + 'h. <button type="button" class="link-btn" id="quiz-show">Ver la solución paso a paso</button>';
        $('#quiz-show').addEventListener('click', () => {
          segIn.set(q.seg);
          offIn.set(q.off);
          a20.checked = false;
          run(true);
          $('#real-stage').scrollIntoView({ behavior: UI.reducedMotion() ? 'auto' : 'smooth', block: 'start' });
        });
      }
      $('#quiz-streak').textContent = streak;
    });
    $('#quiz-new').addEventListener('click', next);
    next();
  }

  window.RealMode = { init, player: () => player };
})();
