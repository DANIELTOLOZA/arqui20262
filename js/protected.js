/* protected.js — Simulador de direccionamiento en modo protegido. */
(function () {
  'use strict';
  const { $, $$, esc, hexInput, segmented, Player, chips } = UI;
  const H = X86.hex;
  const h8 = (n) => H(n >>> 0, 8);

  const PRESETS = [
    { label: 'Datos de usuario · DS', reg: 'DS', sel: 0x0023, desc: '00CFF2400000FFFF', off: 0x00001234, cpl: 3, hint: 'Segmento de datos de anillo 3 con base 00400000h' },
    { label: 'Código del núcleo · CS', reg: 'CS', sel: 0x0008, desc: '00CF9A000000FFFF', off: 0xc0100000, cpl: 0, hint: 'Modelo plano: base 0 y límite de 4 GiB' },
    { label: 'Pila expand-down · SS', reg: 'SS', sel: 0x0018, desc: '0040960300000FFF', off: 0x0000fff0, cpl: 0, hint: 'Pila que crece hacia abajo: válidos 1000h–FFFFh' },
    { label: 'Selector de la LDT', reg: 'DS', sel: 0x000f, desc: '00CFF2800000FFFF', off: 0x00000400, cpl: 3, hint: 'TI = 1: el descriptor se busca en la LDT' },
    { label: 'Violación de privilegio', reg: 'DS', sel: 0x0013, desc: '00CF92000000FFFF', off: 0x00001000, cpl: 3, kind: 'bad', hint: 'Código de usuario intenta usar datos del núcleo' },
    { label: 'Fuera del límite', reg: 'DS', sel: 0x0020, desc: '0040922000000FFF', off: 0x00001000, cpl: 0, kind: 'bad', hint: 'Segmento de 4 KiB y offset 1000h' },
    { label: 'No presente', reg: 'DS', sel: 0x0028, desc: '00CF12000000FFFF', off: 0, cpl: 0, kind: 'bad', hint: 'P = 0 provoca #NP' },
    { label: 'Datos en CS', reg: 'CS', sel: 0x0010, desc: '00CF92000000FFFF', off: 0, cpl: 0, kind: 'bad', hint: 'CS solo acepta segmentos de código' },
    { label: 'Selector nulo en SS', reg: 'SS', sel: 0x0000, desc: '0000000000000000', off: 0, cpl: 0, kind: 'bad', hint: 'La entrada 0 de la GDT no se puede usar' },
  ];

  const OFFSET_HELP = {
    CS: 'EIP: dirección de la instrucción dentro del segmento de código.',
    DS: 'Dirección efectiva del operando (por ejemplo [EBX+ESI]).',
    SS: 'ESP: tope de la pila dentro del segmento de pila.',
  };

  let player, viz, regCtl, cplCtl, inputs, builder, lastResult;

  function init() {
    viz = $('#pm-viz');
    player = new Player($('#pm-stage [data-player]'), viz, {});
    inputs = {
      sel: hexInput($('#pm-sel'), 16, 'El selector', renderSelMini),
      desc: hexInput($('#pm-desc'), 64, 'El descriptor', (v) => builder.fill(v)),
      off: hexInput($('#pm-off'), 32, 'El desplazamiento'),
      gdtBase: hexInput($('#pm-gdt-base'), 32, 'La base de la GDT'),
      gdtLimit: hexInput($('#pm-gdt-limit'), 16, 'El límite de la GDT'),
      ldtBase: hexInput($('#pm-ldt-base'), 32, 'La base de la LDT'),
      ldtLimit: hexInput($('#pm-ldt-limit'), 16, 'El límite de la LDT'),
    };
    regCtl = segmented($('#pm-reg'), 'DS', updateOffsetLabel);
    cplCtl = segmented($('#pm-cpl'), '3');
    builder = makeBuilder();

    $('#pm-form').addEventListener('submit', (e) => { e.preventDefault(); run(true); });
    chips($('#pm-presets'), PRESETS, (p) => { applyPreset(p); run(true); });

    applyPreset(PRESETS[0]);
    run(false);
  }

  function applyPreset(p) {
    regCtl.set(p.reg, true);
    cplCtl.set(String(p.cpl), true);
    inputs.sel.set(p.sel);
    $('#pm-desc').value = p.desc;
    inputs.desc.check();
    inputs.off.set(p.off);
    builder.fill(BigInt('0x' + p.desc));
    updateOffsetLabel();
    renderSelMini();
  }

  /** Carga un descriptor desde otra sección (Reversing). */
  function loadDescriptor(value) {
    $('#pm-desc').value = H(value, 16);
    inputs.desc.check();
    builder.fill(value);
    const t = X86.decodeDescriptor(value).typeInfo;
    if (t.kind === 'code') regCtl.set('CS', true);
    else if (t.kind === 'data') regCtl.set(t.expandDown && t.writable ? 'SS' : 'DS', true);
    updateOffsetLabel();
    run(true);
  }

  function updateOffsetLabel() {
    const reg = regCtl.get();
    $('#pm-off-name').textContent = reg === 'CS' ? 'EIP' : reg === 'SS' ? 'ESP' : 'Desplazamiento';
    const msg = $('#pm-off-msg');
    if (!msg.classList.contains('error')) msg.textContent = OFFSET_HELP[reg];
  }

  function renderSelMini() {
    const r = X86.parseHex($('#pm-sel').value, 16);
    const box = $('#pm-sel-mini');
    if (!r.ok) { box.innerHTML = ''; return; }
    const s = X86.decodeSelector(r.value);
    const b = X86.bin(r.value, 16);
    box.innerHTML =
      '<span class="sm-idx"><code>' + b.slice(0, 13) + '</code><small>índice ' + s.index + '</small></span>' +
      '<span class="sm-ti"><code>' + b[13] + '</code><small>' + s.table + '</small></span>' +
      '<span class="sm-rpl"><code>' + b.slice(14) + '</code><small>RPL ' + s.rpl + '</small></span>';
  }

  /* ------------------------ Constructor por campos ------------------------ */

  function makeBuilder() {
    const el = {
      base: $('#b-base'), limit: $('#b-limit'), s: $('#b-s'), type: $('#b-type'), dpl: $('#b-dpl'),
      p: $('#b-p'), g: $('#b-g'), db: $('#b-db'), l: $('#b-l'), avl: $('#b-avl'),
    };
    const baseIn = hexInput(el.base, 32, 'La base', emit);
    const limIn = hexInput(el.limit, 20, 'El límite', emit);
    function typeOptions(s, selected) {
      let html = '';
      for (let t = 0; t < 16; t++) {
        const info = X86.describeType(s, t);
        html += '<option value="' + t + '">' + H(t) + 'h · ' + esc(s ? info.name.replace(/^(Código|Datos), /, (m, k) => k + ': ') : info.name) + '</option>';
      }
      el.type.innerHTML = html;
      el.type.value = String(selected);
    }
    function fill(v) {
      const d = X86.decodeDescriptor(v);
      el.base.value = h8(d.base);
      el.limit.value = H(d.limit, 5);
      el.s.value = String(d.s);
      typeOptions(d.s, d.type);
      el.dpl.value = String(d.dpl);
      el.p.checked = !!d.p; el.g.checked = !!d.g; el.db.checked = !!d.db; el.l.checked = !!d.l; el.avl.checked = !!d.avl;
      baseIn.check(); limIn.check();
    }
    function emit() {
      const b = baseIn.get();
      const l = limIn.get();
      if (!b.ok || !l.ok) return;
      const v = X86.encodeDescriptor({
        base: b.value, limit: l.value, s: +el.s.value, type: +el.type.value, dpl: +el.dpl.value,
        p: +el.p.checked, g: +el.g.checked, db: +el.db.checked, l: +el.l.checked, avl: +el.avl.checked,
      });
      $('#pm-desc').value = H(v, 16);
      inputs.desc.check();
    }
    el.s.addEventListener('change', () => { typeOptions(+el.s.value, +el.type.value); emit(); });
    ['type', 'dpl'].forEach((k) => el[k].addEventListener('change', emit));
    ['p', 'g', 'db', 'l', 'avl'].forEach((k) => el[k].addEventListener('change', emit));
    return { fill };
  }

  /* ------------------------------ Cálculo ------------------------------ */

  function run(animate) {
    const vals = {};
    for (const [k, inp] of Object.entries(inputs)) {
      const r = inp.check();
      if (!r.ok) {
        const ids = { sel: 'pm-sel', desc: 'pm-desc', off: 'pm-off', gdtBase: 'pm-gdt-base', gdtLimit: 'pm-gdt-limit', ldtBase: 'pm-ldt-base', ldtLimit: 'pm-ldt-limit' };
        const field = $('#' + ids[k]);
        const det = field.closest('details');
        if (det) det.open = true;
        field.focus();
        return;
      }
      vals[k] = r.value;
    }
    const r = X86.protectedMode({
      selector: vals.sel,
      descriptor: vals.desc,
      segReg: regCtl.get(),
      offset: vals.off,
      cpl: +cplCtl.get(),
      gdtBase: vals.gdtBase,
      gdtLimit: vals.gdtLimit,
      ldtBase: vals.ldtBase,
      ldtLimit: vals.ldtLimit,
    });
    lastResult = r;
    const ids = stepIds(r);
    const at = (id) => ids.indexOf(id);
    viz.innerHTML = render(r, at);
    const steps = buildSteps(r, ids);
    player.load(steps, animate ? 0 : steps.length - 1);
    if (animate) player.play();
  }

  function stepIds(r) {
    if (r.sel.isNull) return ['sel', 'checks'];
    const failed = r.checks.find((c) => !c.ok);
    if (!failed) return ['sel', 'table', 'desc', 'checks', 'limit', 'linear'];
    if (failed.id === 'table') return ['sel', 'table'];
    if (failed.id === 'limit') return ['sel', 'table', 'desc', 'checks', 'limit'];
    return ['sel', 'table', 'desc', 'checks'];
  }

  /* ------------------------------ Pasos ------------------------------ */

  function buildSteps(r, ids) {
    const s = r.sel;
    const d = r.desc;
    const reg = r.reg.name;
    const f = r.fault;
    const last = ids[ids.length - 1];
    const faultHtml = f ? '<p class="fault-inline"><b>' + f.vector + '(' + H(f.errorCode, 4) + 'h)</b> · ' + esc(f.title) + '. ' + esc(f.detail) + '</p>' : '';
    const T = {
      sel: {
        title: 'Descomponer el selector',
        text: '<p>' + reg + ' recibe el selector <b class="mono">' + H(s.value, 4) + 'h</b>. Sus 16 bits se dividen en tres campos:</p>' +
          '<ul class="kv"><li><b>Índice</b> (bits 15–3) = ' + s.index + ': número de entrada en la tabla.</li>' +
          '<li><b>TI</b> (bit 2) = ' + s.ti + ': buscar en la <b>' + s.table + '</b>.</li>' +
          '<li><b>RPL</b> (bits 1–0) = ' + s.rpl + ': privilegio que solicita quien usa el selector.</li></ul>' +
          (s.isNull ? '<p>Índice 0 con TI = 0 es el <b>selector nulo</b>.</p>' : ''),
      },
      table: {
        title: 'Ubicar la entrada en la ' + s.table,
        text: '<p>Cada descriptor ocupa 8 bytes, así que la entrada está en:</p>' +
          '<p class="mono big-eq">' + s.table + 'R.base + índice × 8<br>= ' + h8(r.tableBase) + 'h + ' + s.index + ' × 8 = <b>' + h8(r.entryAddress) + 'h</b></p>' +
          (r.checks.find((c) => c.id === 'table' && !c.ok) ? faultHtml : '<p>La entrada existe: ' + H(s.byteOffset + 7) + 'h ≤ límite ' + H(r.tableLimit) + 'h.</p>'),
      },
      desc: {
        title: 'Leer el descriptor',
        text: '<p>La CPU lee los 8 bytes <b class="mono">' + H(d.raw, 16) + 'h</b> y reúne los campos dispersos:</p>' +
          '<ul class="kv"><li><b>Base</b> = ' + H(d.fields.baseHi, 2) + ' | ' + H(d.fields.baseMid, 2) + ' | ' + H(d.fields.baseLo, 4) + ' = <b class="mono">' + h8(d.base) + 'h</b></li>' +
          '<li><b>Límite</b> = ' + H(d.limit, 5) + 'h, G = ' + d.g + (d.g ? ' → × 4 KiB + FFFh' : ' → en bytes') + ' = <b class="mono">' + h8(d.effectiveLimit) + 'h</b> (' + X86.formatSize(d.effectiveLimit + 1) + ')</li>' +
          '<li><b>Tipo</b>: ' + esc(d.typeInfo.name) + ' · DPL ' + d.dpl + ' · P = ' + d.p + '</li></ul>',
      },
      checks: {
        title: 'Validar protección',
        text: f && last === 'checks'
          ? '<p>La CPU revisa las reglas en orden y se detiene en la primera que falla.</p>' + faultHtml
          : '<p>Selector no nulo, descriptor de código/datos, tipo compatible con ' + reg + ', privilegio suficiente y segmento presente: <b>todo en orden</b>. El descriptor se copia en la parte oculta de ' + reg + '.</p>',
      },
      limit: {
        title: 'Comprobar el límite',
        text: r.range && r.range.expandDown
          ? '<p>Segmento <b>expand-down</b>: son válidos los desplazamientos <em>mayores</em> que el límite, hasta ' + (d.db ? 'FFFFFFFFh (B = 1)' : 'FFFFh (B = 0)') + '.</p>' + (f ? faultHtml : '<p>' + r.reg.offsetName + ' = ' + h8(r.offset) + 'h está dentro del rango.</p>')
          : '<p>' + r.reg.offsetName + ' debe ser ≤ límite efectivo.</p><p class="mono big-eq">' + h8(r.offset) + 'h ' + (f ? '&gt;' : '≤') + ' ' + h8(d.effectiveLimit) + 'h</p>' + (f ? faultHtml : ''),
      },
      linear: {
        title: 'Dirección lineal',
        text: '<p class="mono big-eq">' + h8(d.base) + 'h + ' + h8(r.offset) + 'h = <b>' + h8(r.linear || 0) + 'h</b></p>' +
          (r.wrapped ? '<p>La suma superó 32 bits y dio la vuelta (módulo 4 GiB).</p>' : '') +
          '<p>Sin paginación esta es la dirección física. Con paginación (CR0.PG = 1) la MMU todavía la traduce a física.</p>',
      },
    };
    return ids.map((id) => ({ ...T[id], kind: f && id === last ? 'fault' : null }));
  }

  /* ------------------------------ Render ------------------------------ */

  function render(r, at) {
    let html = '';
    if (at('sel') >= 0) html += secSelector(r, at('sel'));
    if (at('table') >= 0) html += secTable(r, at('table'));
    if (at('desc') >= 0) html += secDescriptor(r, at('desc'));
    if (at('checks') >= 0) html += secChecks(r, at('checks'));
    if (at('limit') >= 0) html += secLimit(r, at('limit'));
    if (at('linear') >= 0) html += secLinear(r, at('linear'));
    if (r.fault) html += secFault(r, Math.max(at('checks'), at('limit'), at('table')));
    return html;
  }

  function secSelector(r, s) {
    const b = X86.bin(r.sel.value, 16);
    let cellsHtml = '';
    for (let i = 0; i < 16; i++) {
      const bit = 15 - i;
      const cls = bit >= 3 ? 'f-index' : bit === 2 ? 'f-ti' : 'f-rpl';
      cellsHtml += '<span class="bc ' + cls + '" style="--d:' + i + '"><small>' + bit + '</small>' + b[i] + '</span>';
    }
    return '<section class="pm-sec" data-s="' + s + '">' +
      '<p class="mini-title">Registro ' + r.reg.name + ' · parte visible (selector)</p>' +
      '<div class="selbits">' + cellsHtml + '</div>' +
      '<div class="selfields">' +
        '<div class="sf f-index"><span>Índice</span><b class="mono">' + r.sel.index + '</b><small>' + H(r.sel.index) + 'h · bits 15–3</small></div>' +
        '<div class="sf f-ti"><span>TI</span><b class="mono">' + r.sel.ti + '</b><small>' + r.sel.table + '</small></div>' +
        '<div class="sf f-rpl"><span>RPL</span><b class="mono">' + r.sel.rpl + '</b><small>' + esc(X86.RPL_NAMES[r.sel.rpl]) + '</small></div>' +
      '</div></section>';
  }

  function secTable(r, s) {
    const total = Math.floor((r.tableLimit + 1) / 8);
    const idx = r.sel.index;
    const outside = idx >= total;
    const lo = Math.max(0, Math.min(idx, total) - 2);
    const hi = outside ? total - 1 : Math.min(total - 1, idx + 2);
    let rows = '';
    if (lo > 0) rows += '<li class="gap">⋮</li>';
    for (let i = lo; i <= hi; i++) {
      const target = i === idx;
      const content = target ? H(r.desc.raw, 16) : i === 0 && r.sel.ti === 0 ? 'descriptor nulo' : '· · ·';
      rows += '<li class="' + (target ? 'target' : '') + '"><span class="gi">#' + i + '</span><span class="ga mono">' + h8(r.tableBase + i * 8) + 'h</span><span class="gc mono">' + content + '</span>' + (target ? '<span class="arrow" aria-hidden="true">◀ ' + r.reg.name + '</span>' : '') + '</li>';
    }
    if (outside) {
      rows += '<li class="gap">⋮</li><li class="target missing"><span class="gi">#' + idx + '</span><span class="ga mono">' + h8(r.entryAddress) + 'h</span><span class="gc">fuera de la tabla</span><span class="arrow" aria-hidden="true">✕</span></li>';
    } else if (hi < total - 1) rows += '<li class="gap">⋮</li>';
    return '<section class="pm-sec" data-s="' + s + '">' +
      '<p class="mini-title">' + r.sel.table + ' en memoria · ' + total + ' entradas · ' + r.sel.table + 'R = ' + h8(r.tableBase) + 'h / límite ' + H(r.tableLimit, 4) + 'h</p>' +
      '<div class="calc-line mono"><span class="pill">' + h8(r.tableBase) + 'h</span> + <span class="pill f-index">' + idx + ' × 8</span> = <span class="pill strong">' + h8(r.entryAddress) + 'h</span></div>' +
      '<ol class="gdt">' + rows + '</ol></section>';
  }

  /** Diagrama del descriptor en dos dwords, al estilo del manual de Intel. */
  function dwordLayout(raw, fieldsDef) {
    const v = BigInt.asUintN(64, BigInt(raw));
    const row = (hiBit) => {
      const fs = fieldsDef.filter((f) => f.hi <= hiBit && f.lo >= hiBit - 31);
      return '<div class="dword">' + fs.map((f) => {
        const w = f.hi - f.lo + 1;
        const val = Number((v >> BigInt(f.lo)) & ((1n << BigInt(w)) - 1n));
        const bits = X86.bin(val, w);
        return '<div class="fld g-' + f.group + (w <= 2 ? ' narrow' : '') + '" data-key="' + f.key + '" style="grid-column:span ' + w + '">' +
          '<span class="fld-name">' + esc(f.label) + '</span>' +
          '<span class="fld-bits mono">' + bits + '</span>' +
          '<span class="fld-range">' + (w === 1 ? f.lo : f.hi + '–' + f.lo) + '</span></div>';
      }).join('') + '</div>';
    };
    return '<div class="dwords"><p class="dw-cap">Bytes 7–4 · bits 63–32</p>' + row(63) + '<p class="dw-cap">Bytes 3–0 · bits 31–0</p>' + row(31) + '</div>';
  }

  function secDescriptor(r, s) {
    const d = r.desc;
    const f = d.fields;
    const t = d.typeInfo;
    return '<section class="pm-sec" data-s="' + s + '">' +
      '<p class="mini-title">Descriptor · ' + H(d.raw, 16) + 'h</p>' +
      '<div class="scroll-x">' + dwordLayout(d.raw, X86.SEGMENT_FIELDS) + '</div>' +
      '<div class="assemble">' +
        '<div class="asm"><span class="asm-k">Base</span><span class="asm-parts mono"><i class="g-base">' + H(f.baseHi, 2) + '</i><i class="g-base">' + H(f.baseMid, 2) + '</i><i class="g-base">' + H(f.baseLo, 4) + '</i></span><span class="asm-eq mono">= ' + h8(d.base) + 'h</span></div>' +
        '<div class="asm"><span class="asm-k">Límite</span><span class="asm-parts mono"><i class="g-limit">' + H(f.limitHi, 1) + '</i><i class="g-limit">' + H(f.limitLo, 4) + '</i></span><span class="asm-eq mono">= ' + H(d.limit, 5) + 'h' +
          (d.g ? ' <span class="gflag">G=1 → ×4 KiB + FFFh</span> = ' + h8(d.effectiveLimit) + 'h' : ' <span class="gflag">G=0 → bytes</span>') + '</span></div>' +
        '<div class="attrs">' +
          '<span class="badge g-type">' + esc(t.name) + '</span>' +
          '<span class="badge g-dpl">DPL ' + d.dpl + '</span>' +
          '<span class="badge ' + (d.p ? 'ok' : 'bad') + '">' + (d.p ? 'Presente' : 'No presente') + '</span>' +
          '<span class="badge">' + (t.kind === 'code' ? (d.l ? '64 bits' : d.db ? '32 bits (D=1)' : '16 bits (D=0)') : d.db ? 'B = 1 (32 bits)' : 'B = 0 (16 bits)') + '</span>' +
          '<span class="badge">Tamaño ' + X86.formatSize(d.effectiveLimit + 1) + '</span>' +
        '</div>' +
      '</div></section>';
  }

  function secChecks(r, s) {
    const items = r.checks.filter((c) => c.id !== 'limit').map((c, i) =>
      '<li class="' + (c.ok ? 'ok' : 'bad') + '" style="--d:' + i + '"><span class="ck" aria-hidden="true">' + (c.ok ? '✓' : '✕') + '</span><div><b>' + esc(c.title) + '</b><p>' + esc(c.detail) + '</p></div></li>'
    ).join('');
    return '<section class="pm-sec" data-s="' + s + '">' +
      '<p class="mini-title">Validaciones al cargar ' + r.reg.name + ' · CPL ' + r.cpl + ' · RPL ' + r.sel.rpl + ' · DPL ' + r.desc.dpl + '</p>' +
      '<ol class="checks-list">' + items + '</ol>' +
      (r.sel.isNull ? '' : rings(r)) +
      '</section>';
  }

  function rings(r) {
    // Anillos de privilegio: muestra CPL, RPL y DPL
    const marks = (n) => [['CPL', r.cpl], ['RPL', r.sel.rpl], ['DPL', r.desc.dpl]].filter(([, v]) => v === n).map(([k]) => '<span class="rm rm-' + k.toLowerCase() + '">' + k + '</span>').join('');
    let out = '<div class="rings" aria-label="Anillos de privilegio">';
    for (let n = 3; n >= 0; n--) out += '<div class="ring ring-' + n + '"><span class="ring-n">Anillo ' + n + '</span><span class="ring-m">' + marks(n) + '</span></div>';
    return out + '<p class="rings-cap">Menor número = más privilegio</p></div>';
  }

  function secLimit(r, s) {
    const d = r.desc;
    const range = r.range;
    const ok = !r.fault;
    let scaleMax, note;
    if (range.expandDown) {
      scaleMax = range.hi + 1;
      note = 'Válidos: ' + h8(range.lo) + 'h – ' + h8(range.hi) + 'h';
    } else {
      scaleMax = Math.min(2 ** 32, Math.max(d.effectiveLimit + 1, r.offset + 1) * 1.25);
      note = 'Válidos: 00000000h – ' + h8(d.effectiveLimit) + 'h';
    }
    const pct = (x) => Math.min(100, (x / scaleMax) * 100);
    const vLeft = pct(range.lo);
    const vWidth = Math.max(0.6, pct(range.hi + 1) - vLeft);
    return '<section class="pm-sec" data-s="' + s + '">' +
      '<p class="mini-title">Comprobación de límite · ' + (range.expandDown ? 'expand-down' : 'expand-up') + '</p>' +
      '<div class="limbar' + (ok ? '' : ' fail') + '">' +
        '<span class="lim-valid" style="left:' + vLeft + '%;width:' + vWidth + '%"></span>' +
        '<span class="lim-pin" style="left:' + pct(r.offset) + '%"><span class="mono">' + r.reg.offsetName + ' ' + h8(r.offset) + 'h</span></span>' +
      '</div>' +
      '<div class="limlbl mono"><span>0</span><span>' + note + '</span><span>' + h8(Math.min(scaleMax - 1, 0xffffffff)) + 'h</span></div>' +
      '</section>';
  }

  function secLinear(r, s) {
    const d = r.desc;
    const shadow = '<div class="shadow-reg">' +
      '<div class="sr-vis"><span class="sr-k">' + r.reg.name + ' visible</span><b class="mono">' + H(r.sel.value, 4) + 'h</b></div>' +
      '<div class="sr-hid"><span class="sr-k">Parte oculta (caché del descriptor)</span>' +
        '<span class="mono"><i>base</i> ' + h8(d.base) + 'h</span><span class="mono"><i>límite</i> ' + h8(d.effectiveLimit) + 'h</span><span class="mono"><i>atrib.</i> ' + esc(d.typeInfo.short) + ', DPL ' + d.dpl + '</span></div>' +
      '</div>';
    const bH = h8(d.base);
    const oH = h8(r.offset);
    const lH = h8(r.linear);
    const col = (str, cls) => Array.from(str).map((c, i) => '<span class="cell ' + cls + '" style="--d:' + (7 - i) + '">' + c + '</span>').join('');
    return '<section class="pm-sec" data-s="' + s + '">' +
      '<p class="mini-title">Cálculo de la dirección lineal</p>' +
      '<div class="linadd">' +
        '<span class="lbl">Base</span>' + col(bH, 'g-base-c') +
        '<span class="lbl">+ ' + esc(r.reg.offsetName) + '</span>' + col(oH, '') +
        '<span class="rule"></span>' +
        '<span class="lbl">Lineal</span>' + col(lH, 'res') +
      '</div>' +
      '<div class="result" ><span class="result-k">Dirección lineal</span><span class="result-v mono">' + lH + '<small>h</small></span><span class="result-n">' + (r.wrapped ? 'Dio la vuelta en 4 GiB' : r.linear.toLocaleString('es-CO') + ' en decimal') + '</span></div>' +
      shadow +
      '<p class="note">El procesador marca el descriptor como accedido (A = 1): en memoria queda <span class="mono">' + H(r.accessedDescriptor, 16) + 'h</span>.</p>' +
      '</section>';
  }

  function secFault(r, s) {
    const f = r.fault;
    const ec = f.errorCode;
    return '<section class="pm-sec fault" data-s="' + s + '" role="alert">' +
      '<div class="fault-head"><span class="fault-vec mono">' + f.vector + '(' + H(ec, 4) + 'h)</span>' +
      '<span class="fault-name">Excepción ' + f.number + ' · ' + esc(f.name) + '</span></div>' +
      '<h4>' + esc(f.title) + '</h4><p>' + esc(f.detail) + '</p>' +
      '<p class="fault-ec">Código de error ' + H(ec, 4) + 'h' + (ec ? ' = índice ' + (ec >> 3) + ', TI ' + ((ec >> 2) & 1) + ' (el selector que causó el fallo)' : ' (el fallo no se atribuye a un selector)') + '. No se genera dirección: el sistema operativo atiende la excepción.</p>' +
      '</section>';
  }

  window.ProtectedMode = { init, loadDescriptor, dwordLayout, player: () => player, last: () => lastResult };
})();
