/* reverse.js — Reversing: binario de 64 bits → ficha del descriptor. */
(function () {
  'use strict';
  const { $, $$, esc, chips } = UI;
  const H = X86.hex;
  const h8 = (n) => H(n >>> 0, 8);

  const toBin = (hexStr) => X86.group(X86.bin(BigInt('0x' + hexStr), 64), 8);

  const PRESETS = [
    { label: 'Código núcleo plano', hex: '00CF9A000000FFFF' },
    { label: 'Datos usuario plano', hex: '00CFF2000000FFFF' },
    { label: 'Pila expand-down', hex: '0040960300000FFF' },
    { label: 'Código 64 bits', hex: '00AF9A000000FFFF' },
    { label: 'TSS de 32 bits', hex: '0000890012340067' },
    { label: 'Call gate', hex: '1234EC0200085678' },
    { label: 'Descriptor nulo', hex: '0000000000000000' },
    { label: 'Inválido: L y D', hex: '00EF9A000000FFFF', kind: 'bad' },
  ];

  const FIELD_HELP = {
    baseHi: 'Bits 31–24 de la dirección base del segmento.',
    baseMid: 'Bits 23–16 de la dirección base.',
    baseLo: 'Bits 15–0 de la dirección base.',
    limitHi: 'Bits 19–16 del límite (20 bits en total).',
    limitLo: 'Bits 15–0 del límite.',
    g: 'Granularidad: 0 = límite en bytes (hasta 1 MiB); 1 = en páginas de 4 KiB (hasta 4 GiB).',
    db: 'Código: tamaño por defecto (1 = 32 bits). Pila: 1 = usa ESP. Expand-down: límite superior FFFFFFFFh.',
    l: 'Código de 64 bits (modo IA-32e). Debe ser 0 en datos y fuera del modo largo.',
    avl: 'Disponible para el sistema operativo; la CPU lo ignora.',
    p: 'Presente: 1 = el segmento está en memoria.',
    dpl: 'Nivel de privilegio del descriptor (0 = núcleo, 3 = usuario).',
    s: 'Clase: 1 = código o datos; 0 = sistema (TSS, LDT, compuertas).',
    type: 'Tipo: permisos de lectura/escritura/ejecución o tipo de objeto de sistema.',
    offsetHi: 'Bits 31–16 del punto de entrada.',
    offsetLo: 'Bits 15–0 del punto de entrada.',
    zero: 'Reservado: debe ser 000.',
    params: 'Cantidad de parámetros (dwords) que se copian a la nueva pila.',
    gateSelector: 'Selector del segmento de código destino (o de la TSS en una task gate).',
  };

  let ta, out, counter, ruler, msg, current = null;

  function init() {
    ta = $('#rev-bin');
    out = $('#rev-out');
    counter = $('#rev-count');
    ruler = $('#rev-ruler');
    msg = $('#rev-msg');

    ta.addEventListener('input', () => live(false));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); live(true, true); }
    });
    $('#rev-go').addEventListener('click', () => live(true, true));
    $('#rev-clear').addEventListener('click', () => { ta.value = ''; live(false); ta.focus(); });
    $('#rev-hex-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const inp = $('#rev-hex');
      const r = X86.parseHex(inp.value, 64, 'El valor hexadecimal');
      if (!r.ok) { setMsg(r.error, true); inp.focus(); return; }
      ta.value = X86.group(X86.bin(r.value, 64), 8);
      inp.value = '';
      live(true, true);
    });
    chips($('#rev-presets'), PRESETS, (p) => { ta.value = toBin(p.hex); live(true, true); });

    out.addEventListener('mouseover', hoverField);
    out.addEventListener('focusin', hoverField);
    out.addEventListener('mouseleave', () => highlight(null));
    out.addEventListener('click', (e) => {
      if (e.target.closest('#rev-send') && current) {
        window.App.go('protegido');
        window.ProtectedMode.loadDescriptor(current.desc.raw);
        UI.toast('Descriptor cargado en Modo protegido');
      }
    });

    ta.value = toBin(PRESETS[0].hex);
    live(true, false);
  }

  function setMsg(text, isError) {
    msg.textContent = text;
    msg.classList.toggle('error', !!isError);
  }

  /** Valida en vivo, dibuja la regla de 64 posiciones y, si es válido, la ficha. */
  function live(analyze, animate) {
    const p = X86.parseBinaryDescriptor(ta.value);
    const clean = ta.value.replace(/[\s_.\-]/g, '').replace(/^0b/i, '');
    counter.textContent = clean.length + ' / 64 bits';
    counter.className = 'counter' + (p.ok ? ' ok' : clean.length > 64 || (p.invalid && p.invalid.length) ? ' bad' : '');
    drawRuler(clean);
    ta.classList.toggle('invalid', !p.ok && clean.length > 0 && (clean.length > 64 || !!(p.invalid && p.invalid.length) || analyze));
    if (!clean.length) {
      setMsg('Se admiten espacios, guiones bajos y el prefijo 0b para agrupar.', false);
      out.innerHTML = empty();
      current = null;
      return;
    }
    if (!p.ok) {
      const pending = !p.invalid && clean.length < 64 && !analyze;
      setMsg(pending ? 'Llevas ' + clean.length + ' bits; faltan ' + (64 - clean.length) + '.' : p.error, !pending);
      if (analyze || !pending) {
        out.innerHTML = '<div class="card rev-empty bad"><b>No se puede analizar todavía.</b><p>' + esc(p.error) + '</p></div>';
        current = null;
      }
      return;
    }
    setMsg('Entrada válida: 64 bits. Valor hexadecimal ' + H(p.value, 16) + 'h.', false);
    if (analyze || !current || current.desc.raw !== p.value) {
      current = X86.reverseDescriptor(p.value);
      out.innerHTML = render(current);
      if (animate && !UI.reducedMotion()) {
        out.classList.remove('reveal');
        void out.offsetWidth;
        out.classList.add('reveal');
      }
    }
  }

  function drawRuler(clean) {
    const fields = X86.SEGMENT_FIELDS;
    const groupOf = (bit) => fields.find((f) => bit <= f.hi && bit >= f.lo).group;
    let html = '';
    for (let i = 0; i < 64; i++) {
      const bit = 63 - i;
      const ch = clean[i];
      const state = ch === undefined ? 'empty' : ch === '0' || ch === '1' ? 'v' : 'x';
      html += '<span class="rb g-' + groupOf(bit) + ' ' + state + (i % 8 === 0 && i ? ' sep' : '') + '">' + (ch === undefined ? '' : esc(ch)) + '</span>';
    }
    if (clean.length > 64) html += '<span class="rb-extra">+' + (clean.length - 64) + '</span>';
    ruler.innerHTML = html;
  }

  function empty() {
    return '<div class="card rev-empty"><b>Esperando un descriptor.</b><p>Escribe 64 bits o elige un ejemplo para ver su ficha.</p></div>';
  }

  /* ------------------------------ Ficha ------------------------------ */

  function render(r) {
    const d = r.desc;
    const t = d.typeInfo;
    const kindLabel = r.isNull ? 'Nulo' : t.kind === 'code' ? 'Código' : t.kind === 'data' ? 'Datos' : t.sub === 'gate' ? 'Compuerta' : t.sub === 'tss' ? 'TSS' : t.sub === 'ldt' ? 'LDT' : 'Sistema';
    const kindCls = r.isNull ? 'k-null' : 'k-' + (t.kind === 'system' ? t.sub : t.kind);

    const use = ['CS', 'DS', 'SS'].map((reg) => '<span class="use ' + (r.usable[reg] ? 'yes' : 'no') + '" title="' + (r.usable[reg] ? 'Se puede cargar en ' : 'No se puede cargar en ') + reg + '">' + reg + ' ' + (r.usable[reg] ? '✓' : '✕') + '</span>').join('');

    const alerts = r.warnings.map((w) => '<li class="warn">' + esc(w) + '</li>').join('') + r.notes.map((n) => '<li class="info">' + esc(n) + '</li>').join('');

    let facts = '';
    if (r.layout === 'gate') {
      const g = r.gate;
      facts =
        fact('Selector destino', H(g.selector, 4) + 'h', g.selectorInfo.table + ' · índice ' + g.selectorInfo.index + ' · RPL ' + g.selectorInfo.rpl) +
        fact('Punto de entrada', h8(g.offset) + 'h', d.type === 5 ? 'No se usa en task gates' : 'EIP al entrar') +
        fact('Parámetros', String(g.params), d.type === 4 || d.type === 0xc ? 'Dwords copiados a la pila' : 'Solo aplica a call gates') +
        fact('DPL', String(d.dpl), 'Anillo mínimo para usar la compuerta') +
        fact('Presente', d.p ? 'Sí' : 'No', 'P = ' + d.p);
    } else {
      facts =
        fact('Base', h8(d.base) + 'h', 'Inicio en memoria lineal') +
        fact('Límite', H(d.limit, 5) + 'h', 'G = ' + d.g + (d.g ? ' · en páginas de 4 KiB' : ' · en bytes')) +
        fact('Límite efectivo', h8(d.effectiveLimit) + 'h', X86.formatSize(d.effectiveLimit + 1)) +
        fact('Privilegio (DPL)', String(d.dpl), X86.RPL_NAMES[d.dpl]) +
        fact('Presente', d.p ? 'Sí' : 'No', 'P = ' + d.p) +
        fact('Tamaño de operando', t.kind === 'system' ? '—' : t.kind === 'code' && d.l ? '64 bits' : d.db ? '32 bits' : '16 bits', 'D/B = ' + d.db + ' · L = ' + d.l);
    }

    const typeBits = X86.bin(d.type, 4);
    const typeLegend = t.bitsLegend.length
      ? '<ul class="tbits">' + t.bitsLegend.map((b) => '<li><span class="tb mono ' + (b.value ? 'on' : '') + '">' + b.value + '</span><div><b>Bit ' + (40 + b.bit) + ' · ' + esc(b.name) + '</b><p>' + esc(b.meaning) + '</p></div></li>').join('') + '</ul>'
      : '<p class="tsys">S = 0: el campo Tipo <span class="mono">' + typeBits + 'b = ' + H(d.type) + 'h</span> identifica un objeto de sistema: <b>' + esc(t.name) + '</b>.</p>';

    const rows = r.fields.map((f) =>
      '<tr data-key="' + f.key + '" tabindex="0"><td><span class="sw g-' + f.group + '"></span>' + esc(f.label) + '</td><td class="mono">' + (f.width === 1 ? f.lo : f.hi + '–' + f.lo) + '</td><td class="mono">' + f.binary + '</td><td class="mono">' + f.hexValue + 'h</td><td>' + esc(meaning(f, r)) + '</td></tr>'
    ).join('');

    return '' +
      '<div class="idcard card ' + kindCls + '">' +
        '<div class="id-kind"><span class="id-tag">' + kindLabel + '</span><span class="id-hex mono">' + r.hexValue + 'h</span></div>' +
        '<div class="id-main"><p class="eyebrow">¿Quién es?</p><h2>' + esc(r.title) + '</h2><p class="id-sub">' + esc(r.subtitle) + '</p>' +
          '<div class="id-use"><span class="id-use-k">Se puede cargar en</span>' + use + '</div>' +
          (alerts ? '<ul class="alerts">' + alerts + '</ul>' : '') +
          (r.layout === 'segment' && !r.isNull && t.kind !== 'system' ? '<button class="btn primary" type="button" id="rev-send">Usar en Modo protegido →</button>' : '') +
        '</div>' +
      '</div>' +
      '<div class="facts">' + facts + '</div>' +
      '<div class="card rev-block">' +
        '<h3 class="card-title">Mapa de bits</h3><p class="hint">Pasa el cursor por un campo para resaltarlo en la tabla.</p>' +
        '<div class="scroll-x">' + bitGrid(r) + '</div>' +
        '<div class="scroll-x">' + window.ProtectedMode.dwordLayout(d.raw, r.layout === 'gate' ? X86.GATE_FIELDS : X86.SEGMENT_FIELDS) + '</div>' +
      '</div>' +
      '<div class="rev-cols">' +
        '<div class="card rev-block"><h3 class="card-title">Campos</h3><div class="scroll-x"><table class="ftable"><thead><tr><th>Campo</th><th>Bits</th><th>Binario</th><th>Hex</th><th>Significado</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>' +
        '<div class="card rev-block"><h3 class="card-title">Campo Tipo · <span class="mono">' + typeBits + 'b</span></h3>' + typeLegend + '</div>' +
      '</div>';
  }

  function fact(k, v, sub) {
    return '<div class="fact"><span class="fact-k">' + esc(k) + '</span><span class="fact-v mono">' + esc(v) + '</span><span class="fact-s">' + esc(sub) + '</span></div>';
  }

  function meaning(f, r) {
    const d = r.desc;
    switch (f.key) {
      case 'g': return f.value ? 'Límite en unidades de 4 KiB' : 'Límite en bytes';
      case 'db': return d.typeInfo.kind === 'code' ? (f.value ? 'Operandos de 32 bits' : 'Operandos de 16 bits') : f.value ? 'Big: 32 bits (ESP / tope FFFFFFFFh)' : '16 bits (SP / tope FFFFh)';
      case 'l': return f.value ? 'Código de 64 bits' : 'No es código de 64 bits';
      case 'avl': return f.value ? 'Marcado por el SO' : 'Libre para el SO';
      case 'p': return f.value ? 'Presente en memoria' : 'No presente (#NP al cargar)';
      case 'dpl': return 'Anillo ' + f.value;
      case 's': return f.value ? 'Código o datos' : 'Sistema';
      case 'type': return d.typeInfo.name;
      case 'zero': return f.value ? 'Debería ser 000' : 'Correcto (000)';
      case 'params': return f.value + ' parámetro(s)';
      case 'gateSelector': return 'Índice ' + (f.value >> 3) + ' de la ' + ((f.value >> 2) & 1 ? 'LDT' : 'GDT') + ', RPL ' + (f.value & 3);
      default: return FIELD_HELP[f.key] || '';
    }
  }

  function bitGrid(r) {
    const raw = r.desc.raw;
    const defs = r.layout === 'gate' ? X86.GATE_FIELDS : X86.SEGMENT_FIELDS;
    const row = (from) => {
      let html = '<div class="bitrow">';
      for (let bit = from; bit > from - 32; bit--) {
        const f = defs.find((x) => bit <= x.hi && bit >= x.lo);
        const v = Number((raw >> BigInt(bit)) & 1n);
        const edge = bit === f.lo ? ' edge' : '';
        html += '<span class="bit g-' + f.group + edge + (v ? ' one' : '') + '" data-key="' + f.key + '" style="--d:' + (63 - bit) + '" title="Bit ' + bit + ' · ' + esc(f.label) + '"><small>' + bit + '</small>' + v + '</span>';
      }
      return html + '</div>';
    };
    return '<div class="bitgrid">' + row(63) + row(31) + '</div>';
  }

  function hoverField(e) {
    const el = e.target.closest('[data-key]');
    highlight(el ? el.dataset.key : null);
  }

  function highlight(key) {
    $$('[data-key]', out).forEach((el) => el.classList.toggle('hl', key != null && el.dataset.key === key));
    out.classList.toggle('has-hl', key != null);
  }

  window.Reverse = { init };
})();
