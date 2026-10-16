/*
 * core.js — Lógica pura de direccionamiento x86 (sin DOM).
 * Se usa desde el navegador (global window.X86) y desde Node (tests).
 *
 *  - Modo real:      dirección física = segmento × 16 + desplazamiento
 *  - Modo protegido: selector → descriptor → validaciones → base + desplazamiento
 *  - Reversing:      descriptor de 64 bits (binario) → campos y significado
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.X86 = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TWO32 = 0x100000000;

  /* ------------------------------------------------------------------ */
  /* Utilidades de formato y parseo                                       */
  /* ------------------------------------------------------------------ */

  function hex(value, digits) {
    const s = (typeof value === 'bigint' ? value : BigInt(value)).toString(16).toUpperCase();
    return digits ? s.padStart(digits, '0') : s;
  }

  function bin(value, bits) {
    const s = (typeof value === 'bigint' ? value : BigInt(value)).toString(2);
    return bits ? s.padStart(bits, '0') : s;
  }

  /** Agrupa una cadena en bloques de `size` caracteres desde la derecha. */
  function group(str, size, sep) {
    sep = sep === undefined ? ' ' : sep;
    const out = [];
    for (let i = str.length; i > 0; i -= size) out.unshift(str.slice(Math.max(0, i - size), i));
    return out.join(sep);
  }

  /**
   * Valida y convierte un texto hexadecimal.
   * Acepta "0x1A2B", "1A2Bh", "1a2b", espacios y guiones bajos.
   */
  function parseHex(text, bits, label) {
    label = label || 'El valor';
    const raw = String(text == null ? '' : text).trim();
    if (!raw) return { ok: false, error: label + ' está vacío. Escribe un número hexadecimal.' };
    let s = raw.replace(/[\s_]/g, '');
    if (/^0x/i.test(s)) s = s.slice(2);
    else if (/h$/i.test(s)) s = s.slice(0, -1);
    if (!s) return { ok: false, error: label + ' está vacío. Escribe un número hexadecimal.' };
    const bad = s.match(/[^0-9a-f]/i);
    if (bad) {
      return { ok: false, error: '«' + bad[0] + '» no es un dígito hexadecimal. Usa 0-9 y A-F.' };
    }
    const value = BigInt('0x' + s);
    const max = (1n << BigInt(bits)) - 1n;
    if (value > max) {
      return {
        ok: false,
        error: label + ' no cabe en ' + bits + ' bits (máximo ' + hex(max) + 'h).',
      };
    }
    return { ok: true, value: bits <= 32 ? Number(value) : value };
  }

  function formatSize(bytes) {
    // bytes = número de bytes direccionables (límite efectivo + 1)
    const units = [['GiB', 2 ** 30], ['MiB', 2 ** 20], ['KiB', 2 ** 10]];
    for (const [u, f] of units) {
      if (bytes >= f) {
        const v = bytes / f;
        return (Number.isInteger(v) ? v : v.toFixed(2).replace(/\.?0+$/, '')) + ' ' + u;
      }
    }
    return bytes + (bytes === 1 ? ' byte' : ' bytes');
  }

  /* ------------------------------------------------------------------ */
  /* MODO REAL                                                            */
  /* ------------------------------------------------------------------ */

  /** Mapa clásico del primer megabyte de un PC compatible IBM. */
  const REAL_MEMORY_MAP = [
    { start: 0x00000, end: 0x003FF, key: 'ivt', name: 'Tabla de vectores de interrupción (IVT)' },
    { start: 0x00400, end: 0x004FF, key: 'bda', name: 'Área de datos del BIOS (BDA)' },
    { start: 0x00500, end: 0x9FFFF, key: 'ram', name: 'Memoria convencional (RAM de programas)' },
    { start: 0xA0000, end: 0xBFFFF, key: 'vid', name: 'Memoria de vídeo (VGA / texto en B8000h)' },
    { start: 0xC0000, end: 0xC7FFF, key: 'vbios', name: 'ROM del BIOS de vídeo' },
    { start: 0xC8000, end: 0xEFFFF, key: 'uma', name: 'Área de memoria superior (ROM de expansión)' },
    { start: 0xF0000, end: 0xFFFFF, key: 'bios', name: 'ROM del BIOS del sistema' },
    { start: 0x100000, end: 0x10FFEF, key: 'hma', name: 'Área de memoria alta (HMA, requiere A20)' },
  ];

  function memoryRegion(addr) {
    return REAL_MEMORY_MAP.find((r) => addr >= r.start && addr <= r.end) || null;
  }

  /**
   * Calcula la dirección física en modo real.
   * @param {number} segment 0..FFFFh
   * @param {number} offset  0..FFFFh
   * @param {boolean} a20    true si la línea A20 está habilitada
   */
  function realMode(segment, offset, a20) {
    if (!(segment >= 0 && segment <= 0xffff)) throw new RangeError('Segmento fuera de rango');
    if (!(offset >= 0 && offset <= 0xffff)) throw new RangeError('Desplazamiento fuera de rango');
    const shifted = segment * 16; // segmento << 4
    const sum = shifted + offset; // hasta 21 bits (10FFEFh)
    const overflow = sum > 0xfffff;
    const physical = overflow && !a20 ? sum & 0xfffff : sum;

    // Suma columna a columna en hexadecimal (6 columnas, de derecha a izquierda)
    const columns = [];
    let carry = 0;
    for (let i = 0; i < 6; i++) {
      const a = Math.floor(shifted / 16 ** i) % 16;
      const b = Math.floor(offset / 16 ** i) % 16;
      const t = a + b + carry;
      columns.push({ index: i, a, b, carryIn: carry, digit: t % 16, carryOut: t >= 16 ? 1 : 0 });
      carry = t >= 16 ? 1 : 0;
    }

    // Equivalencias: todos los pares segmento:desplazamiento que apuntan a `sum`
    const segMax = Math.min(0xffff, Math.floor(sum / 16));
    const segMin = Math.max(0, Math.ceil((sum - 0xffff) / 16));
    const normalized = { segment: Math.floor(sum / 16), offset: sum % 16 };
    const pick = new Set([segMin, segMax, Math.round((segMin + segMax) / 2), segment]);
    const equivalents = [...pick]
      .filter((s) => s >= segMin && s <= segMax)
      .sort((x, y) => x - y)
      .map((s) => ({ segment: s, offset: sum - s * 16 }));

    return {
      segment,
      offset,
      shifted,
      sum,
      physical,
      overflow,
      a20: !!a20,
      columns,
      windowStart: shifted,
      windowEnd: shifted + 0xffff,
      region: memoryRegion(physical),
      normalized: normalized.segment <= 0xffff ? normalized : null,
      equivalentCount: segMax - segMin + 1,
      equivalents,
    };
  }

  /* ------------------------------------------------------------------ */
  /* SELECTORES Y DESCRIPTORES                                            */
  /* ------------------------------------------------------------------ */

  const RPL_NAMES = ['Anillo 0 · núcleo (kernel)', 'Anillo 1 · servicios del SO', 'Anillo 2 · servicios del SO', 'Anillo 3 · usuario'];

  function decodeSelector(sel) {
    const index = sel >>> 3;
    const ti = (sel >>> 2) & 1;
    const rpl = sel & 3;
    return {
      value: sel,
      index,
      ti,
      table: ti ? 'LDT' : 'GDT',
      rpl,
      isNull: index === 0 && ti === 0,
      byteOffset: index * 8,
    };
  }

  /** Ubicación de cada campo dentro de un descriptor de segmento (bits). */
  const SEGMENT_FIELDS = [
    { key: 'baseHi', label: 'Base 31:24', group: 'base', hi: 63, lo: 56 },
    { key: 'g', label: 'G', group: 'flag', hi: 55, lo: 55 },
    { key: 'db', label: 'D/B', group: 'flag', hi: 54, lo: 54 },
    { key: 'l', label: 'L', group: 'flag', hi: 53, lo: 53 },
    { key: 'avl', label: 'AVL', group: 'flag', hi: 52, lo: 52 },
    { key: 'limitHi', label: 'Límite 19:16', group: 'limit', hi: 51, lo: 48 },
    { key: 'p', label: 'P', group: 'access', hi: 47, lo: 47 },
    { key: 'dpl', label: 'DPL', group: 'dpl', hi: 46, lo: 45 },
    { key: 's', label: 'S', group: 'access', hi: 44, lo: 44 },
    { key: 'type', label: 'Tipo', group: 'type', hi: 43, lo: 40 },
    { key: 'baseMid', label: 'Base 23:16', group: 'base', hi: 39, lo: 32 },
    { key: 'baseLo', label: 'Base 15:0', group: 'base', hi: 31, lo: 16 },
    { key: 'limitLo', label: 'Límite 15:0', group: 'limit', hi: 15, lo: 0 },
  ];

  /** Ubicación de campos en una compuerta (call / interrupt / trap gate). */
  const GATE_FIELDS = [
    { key: 'offsetHi', label: 'Offset 31:16', group: 'base', hi: 63, lo: 48 },
    { key: 'p', label: 'P', group: 'access', hi: 47, lo: 47 },
    { key: 'dpl', label: 'DPL', group: 'dpl', hi: 46, lo: 45 },
    { key: 's', label: 'S', group: 'access', hi: 44, lo: 44 },
    { key: 'type', label: 'Tipo', group: 'type', hi: 43, lo: 40 },
    { key: 'zero', label: 'Reservado (000)', group: 'flag', hi: 39, lo: 37 },
    { key: 'params', label: 'Nº parámetros', group: 'flag', hi: 36, lo: 32 },
    { key: 'gateSelector', label: 'Selector destino', group: 'limit', hi: 31, lo: 16 },
    { key: 'offsetLo', label: 'Offset 15:0', group: 'base', hi: 15, lo: 0 },
  ];

  function bits(d, hi, lo) {
    return Number((d >> BigInt(lo)) & ((1n << BigInt(hi - lo + 1)) - 1n));
  }

  function decodeDescriptor(d) {
    d = BigInt.asUintN(64, BigInt(d));
    const f = {};
    for (const fl of SEGMENT_FIELDS) f[fl.key] = bits(d, fl.hi, fl.lo);
    const base = ((f.baseHi << 24) | (f.baseMid << 16) | f.baseLo) >>> 0;
    const limit = (f.limitHi << 16) | f.limitLo;
    const effectiveLimit = f.g ? limit * 4096 + 4095 : limit;
    return {
      raw: d,
      high: Number(d >> 32n),
      low: Number(d & 0xffffffffn),
      base,
      limit,
      effectiveLimit,
      g: f.g,
      db: f.db,
      l: f.l,
      avl: f.avl,
      p: f.p,
      dpl: f.dpl,
      s: f.s,
      type: f.type,
      fields: f,
      typeInfo: describeType(f.s, f.type),
    };
  }

  function encodeDescriptor(o) {
    const base = BigInt(o.base >>> 0);
    const limit = BigInt(o.limit & 0xfffff);
    let d = 0n;
    d |= limit & 0xffffn;
    d |= (base & 0xffffffn) << 16n;
    d |= BigInt(o.type & 0xf) << 40n;
    d |= BigInt(o.s & 1) << 44n;
    d |= BigInt(o.dpl & 3) << 45n;
    d |= BigInt(o.p & 1) << 47n;
    d |= ((limit >> 16n) & 0xfn) << 48n;
    d |= BigInt(o.avl & 1) << 52n;
    d |= BigInt(o.l & 1) << 53n;
    d |= BigInt(o.db & 1) << 54n;
    d |= BigInt(o.g & 1) << 55n;
    d |= ((base >> 24n) & 0xffn) << 56n;
    return d;
  }

  const SYSTEM_TYPES = {
    0x0: { name: 'Reservado', reserved: true },
    0x1: { name: 'TSS de 16 bits (disponible)', kind: 'tss' },
    0x2: { name: 'LDT (tabla de descriptores local)', kind: 'ldt' },
    0x3: { name: 'TSS de 16 bits (ocupada)', kind: 'tss' },
    0x4: { name: 'Compuerta de llamada de 16 bits (call gate)', kind: 'gate' },
    0x5: { name: 'Compuerta de tarea (task gate)', kind: 'gate' },
    0x6: { name: 'Compuerta de interrupción de 16 bits', kind: 'gate' },
    0x7: { name: 'Compuerta de trampa de 16 bits (trap gate)', kind: 'gate' },
    0x8: { name: 'Reservado', reserved: true },
    0x9: { name: 'TSS de 32 bits (disponible)', kind: 'tss' },
    0xa: { name: 'Reservado', reserved: true },
    0xb: { name: 'TSS de 32 bits (ocupada)', kind: 'tss' },
    0xc: { name: 'Compuerta de llamada de 32 bits (call gate)', kind: 'gate' },
    0xd: { name: 'Reservado', reserved: true },
    0xe: { name: 'Compuerta de interrupción de 32 bits', kind: 'gate' },
    0xf: { name: 'Compuerta de trampa de 32 bits (trap gate)', kind: 'gate' },
  };

  /** Interpreta el campo Tipo (4 bits) según el bit S. */
  function describeType(s, type) {
    if (!s) {
      const t = SYSTEM_TYPES[type];
      return {
        kind: 'system',
        sub: t.kind || 'reserved',
        reserved: !!t.reserved,
        name: t.name,
        short: t.reserved ? 'Reservado' : t.name.split(' (')[0],
        bitsLegend: [],
      };
    }
    const a = type & 1;
    if (type & 8) {
      const c = (type >> 2) & 1;
      const r = (type >> 1) & 1;
      return {
        kind: 'code',
        sub: 'code',
        executable: true,
        conforming: !!c,
        readable: !!r,
        accessed: !!a,
        writable: false,
        expandDown: false,
        name:
          'Código, ' + (r ? 'ejecución/lectura' : 'solo ejecución') +
          (c ? ', conforming' : ', no conforming') + (a ? ', accedido' : ''),
        short: r ? 'Código ejecutable y legible' : 'Código solo ejecución',
        bitsLegend: [
          { bit: 3, name: 'E (ejecutable)', value: 1, meaning: 'Es un segmento de código' },
          { bit: 2, name: 'C (conforming)', value: c, meaning: c ? 'Se puede ejecutar desde anillos menos privilegiados sin cambiar CPL' : 'Solo se ejecuta desde el mismo anillo (salvo compuertas)' },
          { bit: 1, name: 'R (legible)', value: r, meaning: r ? 'Se pueden leer datos (constantes) del segmento' : 'Solo ejecución: leerlo provoca #GP' },
          { bit: 0, name: 'A (accedido)', value: a, meaning: a ? 'El procesador ya cargó este descriptor alguna vez' : 'Aún no ha sido cargado en un registro de segmento' },
        ],
      };
    }
    const e = (type >> 2) & 1;
    const w = (type >> 1) & 1;
    return {
      kind: 'data',
      sub: 'data',
      executable: false,
      conforming: false,
      readable: true,
      writable: !!w,
      expandDown: !!e,
      accessed: !!a,
      name: 'Datos, ' + (w ? 'lectura/escritura' : 'solo lectura') + (e ? ', expand-down' : ', expand-up') + (a ? ', accedido' : ''),
      short: w ? 'Datos de lectura/escritura' : 'Datos de solo lectura',
      bitsLegend: [
        { bit: 3, name: 'E (ejecutable)', value: 0, meaning: 'Es un segmento de datos' },
        { bit: 2, name: 'ED (expand-down)', value: e, meaning: e ? 'Crece hacia abajo: válidos los offsets por ENCIMA del límite (pilas)' : 'Crece hacia arriba: válidos los offsets de 0 al límite' },
        { bit: 1, name: 'W (escritura)', value: w, meaning: w ? 'Se permite escribir' : 'Solo lectura: escribir provoca #GP' },
        { bit: 0, name: 'A (accedido)', value: a, meaning: a ? 'El procesador ya cargó este descriptor alguna vez' : 'Aún no ha sido cargado en un registro de segmento' },
      ],
    };
  }

  /** Rango de desplazamientos válidos de un segmento de código/datos. */
  function validRange(desc) {
    if (desc.s && !(desc.type & 8) && desc.type & 4) {
      // expand-down
      const upper = desc.db ? 0xffffffff : 0xffff;
      return { lo: desc.effectiveLimit + 1, hi: upper, expandDown: true, empty: desc.effectiveLimit >= upper };
    }
    return { lo: 0, hi: desc.effectiveLimit, expandDown: false, empty: false };
  }

  /* ------------------------------------------------------------------ */
  /* MODO PROTEGIDO                                                       */
  /* ------------------------------------------------------------------ */

  const SEG_REGS = {
    CS: { name: 'CS', role: 'Segmento de código', offsetName: 'EIP', exampleInstr: 'JMP FAR sel:EIP' },
    DS: { name: 'DS', role: 'Segmento de datos', offsetName: 'Desplazamiento', exampleInstr: 'MOV DS, sel' },
    SS: { name: 'SS', role: 'Segmento de pila', offsetName: 'ESP', exampleInstr: 'MOV SS, sel' },
  };

  function fault(vector, code, title, detail) {
    const names = { GP: 'Protección general', NP: 'Segmento no presente', SS: 'Fallo de pila' };
    const numbers = { GP: 13, NP: 11, SS: 12 };
    return {
      vector: '#' + vector,
      number: numbers[vector],
      name: names[vector],
      errorCode: code,
      title,
      detail,
    };
  }

  /**
   * Simula la carga de un selector en CS/DS/SS y el cálculo de la dirección lineal.
   * opts: { selector, descriptor (BigInt), segReg, offset, cpl, gdtBase, gdtLimit, ldtBase, ldtLimit }
   */
  function protectedMode(opts) {
    const reg = SEG_REGS[opts.segReg];
    if (!reg) throw new Error('Registro de segmento inválido');
    const cpl = opts.cpl | 0;
    const sel = decodeSelector(opts.selector);
    const desc = decodeDescriptor(opts.descriptor);
    const offset = opts.offset >>> 0;
    const tableBase = (sel.ti ? opts.ldtBase : opts.gdtBase) >>> 0;
    const tableLimit = sel.ti ? opts.ldtLimit : opts.gdtLimit;
    const entryAddress = (tableBase + sel.byteOffset) % TWO32;
    const selCode = opts.selector & 0xfffc;
    const checks = [];
    const result = { reg, sel, desc, offset, cpl, tableBase, tableLimit, entryAddress, checks, fault: null, linear: null };

    function add(id, ok, title, detail, f) {
      checks.push({ id, ok, title, detail });
      if (!ok && f && !result.fault) result.fault = f;
      return ok;
    }

    // 1. Selector nulo
    if (sel.isNull) {
      if (opts.segReg === 'DS') {
        add('null', false, 'Selector nulo', 'DS acepta un selector nulo (0000h–0003h), pero cualquier acceso a memoria a través de él genera #GP(0).',
          fault('GP', 0, 'Acceso con selector nulo', 'El registro DS quedó cargado con el selector nulo; al intentar leer o escribir memoria el procesador lanza #GP(0).'));
      } else {
        add('null', false, 'Selector nulo', 'Cargar ' + reg.name + ' con un selector nulo no está permitido.',
          fault('GP', 0, 'Selector nulo en ' + reg.name, 'La entrada 0 de la GDT está reservada como descriptor nulo. ' + reg.name + ' nunca puede apuntar a ella.'));
      }
      return result;
    }
    add('null', true, 'Selector no nulo', 'Índice ' + sel.index + ' en la ' + sel.table + '.');

    // 2. Límite de la tabla
    const inTable = sel.byteOffset + 7 <= tableLimit;
    if (!add('table', inTable, 'Entrada dentro de la ' + sel.table,
      'Índice × 8 + 7 = ' + hex(sel.byteOffset + 7) + 'h ' + (inTable ? '≤' : '>') + ' límite de la tabla ' + hex(tableLimit) + 'h.',
      fault('GP', selCode, 'Índice fuera de la tabla', 'La entrada ' + sel.index + ' no existe: la ' + sel.table + ' solo tiene ' + Math.floor((tableLimit + 1) / 8) + ' entradas.'))) return result;

    // 3. Debe ser segmento de código o datos (S = 1)
    if (!add('s', desc.s === 1, 'Descriptor de código o datos (S = 1)',
      desc.s ? 'Es un descriptor de segmento de aplicación.' : 'Es un descriptor de sistema (' + desc.typeInfo.name + ').',
      fault('GP', selCode, 'Descriptor de sistema', 'Un descriptor de sistema (TSS, LDT o compuerta) no se puede cargar en un registro de segmento.'))) return result;

    const t = desc.typeInfo;
    // 4. Tipo compatible con el registro
    let typeOk, typeDetail;
    if (opts.segReg === 'CS') {
      typeOk = t.kind === 'code';
      typeDetail = typeOk ? 'CS necesita un segmento ejecutable y este lo es.' : 'CS necesita un segmento de código, pero este es de datos.';
    } else if (opts.segReg === 'SS') {
      typeOk = t.kind === 'data' && t.writable;
      typeDetail = typeOk ? 'SS necesita datos con escritura y este los permite.' :
        t.kind === 'code' ? 'SS no admite segmentos de código.' : 'SS necesita un segmento escribible, este es de solo lectura.';
    } else {
      typeOk = t.kind === 'data' || t.readable;
      typeDetail = typeOk ? (t.kind === 'data' ? 'DS acepta segmentos de datos.' : 'DS acepta código legible (R = 1).') : 'DS no acepta código de solo ejecución.';
    }
    if (!add('type', typeOk, 'Tipo compatible con ' + reg.name, typeDetail,
      fault('GP', selCode, 'Tipo de segmento incorrecto', typeDetail))) return result;

    // 5. Privilegios
    let privOk, privDetail;
    const rpl = sel.rpl;
    const dpl = desc.dpl;
    if (opts.segReg === 'DS') {
      if (t.kind === 'code' && t.conforming) {
        privOk = true;
        privDetail = 'Código conforming legible: no se comprueba el privilegio.';
      } else {
        const eff = Math.max(cpl, rpl);
        privOk = dpl >= eff;
        privDetail = 'DPL (' + dpl + ') ' + (privOk ? '≥' : '<') + ' máx(CPL, RPL) = máx(' + cpl + ', ' + rpl + ') = ' + eff + '.';
      }
    } else if (opts.segReg === 'SS') {
      privOk = rpl === cpl && dpl === cpl;
      privDetail = 'Para la pila se exige RPL = CPL = DPL → ' + rpl + ' / ' + cpl + ' / ' + dpl + '.';
    } else if (t.conforming) {
      privOk = dpl <= cpl;
      privDetail = 'Código conforming: DPL (' + dpl + ') ' + (privOk ? '≤' : '>') + ' CPL (' + cpl + ').';
    } else {
      privOk = rpl <= cpl && dpl === cpl;
      privDetail = 'Código no conforming: RPL (' + rpl + ') ≤ CPL (' + cpl + ') y DPL (' + dpl + ') = CPL.';
    }
    if (!add('priv', privOk, 'Nivel de privilegio', privDetail,
      fault('GP', selCode, 'Violación de privilegio', privDetail))) return result;

    // 6. Presente
    const npVector = opts.segReg === 'SS' ? 'SS' : 'NP';
    if (!add('p', desc.p === 1, 'Segmento presente (P = 1)',
      desc.p ? 'El segmento está cargado en memoria.' : 'P = 0: el sistema operativo lo tiene fuera de memoria.',
      fault(npVector, selCode, 'Segmento no presente', 'El descriptor tiene P = 0. El sistema operativo puede cargar el segmento y reintentar la instrucción.'))) return result;

    // 7. Límite
    const range = validRange(desc);
    const inLimit = !range.empty && offset >= range.lo && offset <= range.hi;
    const limVector = opts.segReg === 'SS' ? 'SS' : 'GP';
    const limDetail = range.expandDown
      ? 'Expand-down: válidos ' + hex(range.lo, 8) + 'h … ' + hex(range.hi, 8) + 'h; ' + reg.offsetName + ' = ' + hex(offset, 8) + 'h.'
      : reg.offsetName + ' = ' + hex(offset, 8) + 'h ' + (inLimit ? '≤' : '>') + ' límite efectivo ' + hex(desc.effectiveLimit, 8) + 'h.';
    result.range = range;
    if (!add('limit', inLimit, 'Desplazamiento dentro del límite', limDetail,
      fault(limVector, 0, 'Desplazamiento fuera del límite', limDetail))) return result;

    // 8. Dirección lineal
    result.linear = (desc.base + offset) % TWO32;
    result.wrapped = desc.base + offset >= TWO32;
    result.accessedDescriptor = desc.raw | (1n << 40n);
    return result;
  }

  /* ------------------------------------------------------------------ */
  /* REVERSING                                                           */
  /* ------------------------------------------------------------------ */

  /** Valida el texto binario de un descriptor completo (64 bits). */
  function parseBinaryDescriptor(text) {
    const raw = String(text == null ? '' : text);
    let s = raw.replace(/[\s_.\-]/g, '');
    if (/^0b/i.test(s)) s = s.slice(2);
    if (!s) return { ok: false, count: 0, error: 'Escribe los 64 bits del descriptor (del bit 63 al bit 0).' };
    const invalid = [];
    for (let i = 0; i < s.length; i++) if (s[i] !== '0' && s[i] !== '1') invalid.push({ pos: i, ch: s[i] });
    if (invalid.length) {
      const first = invalid[0];
      return {
        ok: false,
        count: s.length,
        invalid,
        error: 'Solo se admiten 0 y 1. Hay ' + invalid.length + (invalid.length === 1 ? ' carácter inválido' : ' caracteres inválidos') +
          ' (el primero es «' + first.ch + '» en la posición ' + (first.pos + 1) + ').',
      };
    }
    if (s.length !== 64) {
      const diff = 64 - s.length;
      return {
        ok: false,
        count: s.length,
        error: 'Un descriptor tiene exactamente 64 bits; ingresaste ' + s.length + '. ' +
          (diff > 0 ? 'Faltan ' + diff + '.' : 'Sobran ' + -diff + '.'),
      };
    }
    return { ok: true, count: 64, bits: s, value: BigInt('0b' + s) };
  }

  const KNOWN = [
    { value: 0x0000000000000000n, name: 'Descriptor nulo (entrada 0 de la GDT)' },
    { value: 0x00cf9a000000ffffn, name: 'Código plano del núcleo (Linux/Windows x86, 4 GiB, anillo 0)' },
    { value: 0x00cf92000000ffffn, name: 'Datos planos del núcleo (4 GiB, anillo 0)' },
    { value: 0x00cffa000000ffffn, name: 'Código plano de usuario (4 GiB, anillo 3)' },
    { value: 0x00cff2000000ffffn, name: 'Datos planos de usuario (4 GiB, anillo 3)' },
    { value: 0x00af9a000000ffffn, name: 'Código de 64 bits del núcleo (modo largo)' },
  ];

  /** Analiza un descriptor (64 bits) y produce una ficha descriptiva completa. */
  function reverseDescriptor(value) {
    const d = decodeDescriptor(value);
    const t = d.typeInfo;
    const warnings = [];
    const notes = [];
    const known = KNOWN.find((k) => k.value === d.raw || k.value === (d.raw & ~(1n << 40n)));

    const isNull = d.raw === 0n;
    let title, subtitle, layout = 'segment';
    let gate = null;

    if (isNull) {
      title = 'Descriptor nulo';
      subtitle = 'La entrada 0 de la GDT. Cualquier selector que apunte aquí es un selector nulo.';
    } else if (t.kind === 'system' && t.sub === 'gate') {
      layout = 'gate';
      const raw = d.raw;
      gate = {
        offset: ((bits(raw, 63, 48) << 16) | bits(raw, 15, 0)) >>> 0,
        selector: bits(raw, 31, 16),
        params: bits(raw, 36, 32),
        zero: bits(raw, 39, 37),
      };
      gate.selectorInfo = decodeSelector(gate.selector);
      title = t.name.charAt(0).toUpperCase() + t.name.slice(1);
      if (d.type === 0x5) {
        subtitle = 'Apunta a la TSS con selector ' + hex(gate.selector, 4) + 'h. El campo de offset no se usa.';
      } else {
        subtitle = 'Salta a ' + hex(gate.selector, 4) + 'h:' + hex(gate.offset, 8) + 'h (' + gate.selectorInfo.table + ', índice ' + gate.selectorInfo.index + ').';
      }
      if (gate.zero !== 0) warnings.push('Los bits 39–37 de una compuerta deben valer 000.');
      if ((d.type === 0x4 || d.type === 0xc) && gate.params) notes.push('Copia ' + gate.params + ' parámetro(s) de la pila del llamador a la nueva pila.');
    } else if (t.kind === 'system') {
      title = t.reserved ? 'Descriptor de sistema reservado' : t.name.charAt(0).toUpperCase() + t.name.slice(1);
      subtitle = t.reserved ? 'El tipo ' + hex(d.type) + 'h con S = 0 no está definido en IA-32: el procesador lo rechaza (#GP).' :
        'Base ' + hex(d.base, 8) + 'h, ' + formatSize(d.effectiveLimit + 1) + '.';
      if (t.reserved) warnings.push('Tipo de sistema reservado: este descriptor no es válido.');
    } else {
      const bitsMode = t.kind === 'code' ? (d.l ? '64 bits' : d.db ? '32 bits' : '16 bits') : d.db ? '32 bits' : '16 bits';
      title = (t.kind === 'code' ? 'Segmento de código' : 'Segmento de datos') + ' · ' + bitsMode + ' · anillo ' + d.dpl;
      const range = validRange(d);
      subtitle = t.name + '. ' + (range.expandDown
        ? 'Offsets válidos ' + hex(range.lo, 8) + 'h–' + hex(range.hi, 8) + 'h.'
        : 'Cubre ' + hex(d.base, 8) + 'h – ' + hex((d.base + d.effectiveLimit) % TWO32, 8) + 'h (' + formatSize(d.effectiveLimit + 1) + ').');
      if (t.kind === 'code' && d.l && d.db) warnings.push('L = 1 y D = 1 a la vez es una combinación reservada: genera #GP en modo IA-32e.');
      if (t.kind === 'data' && d.l) warnings.push('El bit L solo tiene sentido en segmentos de código; en datos debería ser 0.');
      if (d.base === 0 && d.effectiveLimit === 0xffffffff) notes.push('Modelo plano (flat): base 0 y límite de 4 GiB. Es lo que usan los sistemas operativos modernos.');
      if (t.kind === 'code' && d.l) notes.push('Segmento de 64 bits: en modo largo la base y el límite se ignoran.');
      if (t.kind === 'data' && t.expandDown) notes.push('Expand-down: pensado para pilas que crecen hacia direcciones menores.');
    }
    if (!isNull && !d.p) warnings.push('P = 0: el segmento no está presente. Cargarlo genera #NP (o #SS si es la pila).');
    if (!isNull && t.kind !== 'system' && d.g === 0 && d.limit === 0xfffff) notes.push('G = 0 limita el segmento a 1 MiB aunque el límite sea FFFFFh.');
    if (known) notes.unshift('Patrón conocido: ' + known.name + '.');

    // Usos posibles en registros de segmento
    const usable = {
      CS: t.kind === 'code',
      SS: t.kind === 'data' && t.writable,
      DS: t.kind === 'data' || (t.kind === 'code' && t.readable),
    };

    const fieldsDef = layout === 'gate' ? GATE_FIELDS : SEGMENT_FIELDS;
    const fields = fieldsDef.map((f) => {
      const v = bits(d.raw, f.hi, f.lo);
      return { ...f, value: v, width: f.hi - f.lo + 1, binary: bin(v, f.hi - f.lo + 1), hexValue: hex(v, Math.ceil((f.hi - f.lo + 1) / 4)) };
    });

    return {
      desc: d,
      layout,
      gate,
      isNull,
      title,
      subtitle,
      warnings,
      notes,
      usable,
      known: known ? known.name : null,
      fields,
      hexValue: hex(d.raw, 16),
    };
  }

  return {
    hex,
    bin,
    group,
    parseHex,
    formatSize,
    REAL_MEMORY_MAP,
    memoryRegion,
    realMode,
    RPL_NAMES,
    decodeSelector,
    SEGMENT_FIELDS,
    GATE_FIELDS,
    decodeDescriptor,
    encodeDescriptor,
    describeType,
    validRange,
    SEG_REGS,
    protectedMode,
    parseBinaryDescriptor,
    reverseDescriptor,
  };
});
