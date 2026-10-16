// Pruebas de la lógica de direccionamiento. Ejecutar con:  node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const X86 = require('../js/core.js');

const base = { gdtBase: 0x1000, gdtLimit: 0xffff, ldtBase: 0x8000, ldtLimit: 0xffff, cpl: 0 };

test('parseHex acepta formatos comunes y valida rango', () => {
  assert.equal(X86.parseHex('1234', 16).value, 0x1234);
  assert.equal(X86.parseHex('0xB800', 16).value, 0xb800);
  assert.equal(X86.parseHex('ffffh', 16).value, 0xffff);
  assert.equal(X86.parseHex('00CF 9A00 0000 FFFF', 64).value, 0x00cf9a000000ffffn);
  assert.equal(X86.parseHex('10000', 16).ok, false);
  assert.equal(X86.parseHex('12G4', 16).ok, false);
  assert.equal(X86.parseHex('', 16).ok, false);
});

test('modo real: 1234:5678 → 179B8', () => {
  const r = X86.realMode(0x1234, 0x5678, false);
  assert.equal(r.shifted, 0x12340);
  assert.equal(r.physical, 0x179b8);
  assert.equal(r.overflow, false);
  // Comprobación por columnas: los dígitos reconstruyen la suma
  const fromCols = r.columns.reduce((acc, c) => acc + c.digit * 16 ** c.index, 0);
  assert.equal(fromCols, r.sum);
});

test('modo real: casos clásicos', () => {
  assert.equal(X86.realMode(0xb800, 0x0000).physical, 0xb8000);
  assert.equal(X86.realMode(0xffff, 0x0000).physical, 0xffff0);
  assert.equal(X86.realMode(0x0000, 0x0000).physical, 0);
  assert.equal(X86.realMode(0x07c0, 0x0000).physical, 0x7c00);
  assert.equal(X86.realMode(0x0000, 0x7c00).physical, 0x7c00);
});

test('modo real: FFFF:FFFF desborda y depende de A20', () => {
  const off = X86.realMode(0xffff, 0xffff, false);
  assert.equal(off.sum, 0x10ffef);
  assert.equal(off.overflow, true);
  assert.equal(off.physical, 0x0ffef);
  const on = X86.realMode(0xffff, 0xffff, true);
  assert.equal(on.physical, 0x10ffef);
  assert.equal(on.region.key, 'hma');
});

test('modo real: equivalencias apuntan a la misma dirección', () => {
  const r = X86.realMode(0x1234, 0x5678);
  assert.equal(r.equivalentCount, 4096);
  for (const e of r.equivalents) assert.equal(e.segment * 16 + e.offset, r.sum);
  assert.deepEqual(r.normalized, { segment: 0x179b, offset: 0x8 });
  assert.equal(X86.realMode(0, 0).equivalentCount, 1);
});

test('selector se descompone en índice, TI y RPL', () => {
  const s = X86.decodeSelector(0x002b);
  assert.equal(s.index, 5);
  assert.equal(s.ti, 0);
  assert.equal(s.rpl, 3);
  const l = X86.decodeSelector(0x000f);
  assert.equal(l.index, 1);
  assert.equal(l.table, 'LDT');
  assert.equal(X86.decodeSelector(0x0003).isNull, true);
  assert.equal(X86.decodeSelector(0x0004).isNull, false);
});

test('descriptor plano de código del núcleo', () => {
  const d = X86.decodeDescriptor(0x00cf9a000000ffffn);
  assert.equal(d.base, 0);
  assert.equal(d.limit, 0xfffff);
  assert.equal(d.effectiveLimit, 0xffffffff);
  assert.equal(d.g, 1);
  assert.equal(d.db, 1);
  assert.equal(d.p, 1);
  assert.equal(d.dpl, 0);
  assert.equal(d.s, 1);
  assert.equal(d.type, 0xa);
  assert.equal(d.typeInfo.kind, 'code');
  assert.equal(d.typeInfo.readable, true);
});

test('base y límite repartidos en el descriptor', () => {
  // Base 12345678h, límite 0ABCDh, G=0, datos RW, DPL 3
  const raw = X86.encodeDescriptor({ base: 0x12345678, limit: 0xabcd, type: 2, s: 1, dpl: 3, p: 1, avl: 0, l: 0, db: 1, g: 0 });
  assert.equal(X86.hex(raw, 16), '1240F2345678ABCD');
  const d = X86.decodeDescriptor(raw);
  assert.equal(d.base, 0x12345678);
  assert.equal(d.limit, 0xabcd);
  assert.equal(d.dpl, 3);
  // ida y vuelta
  for (const v of [0x00cf9a000000ffffn, 0xff4093456789abcdn, 0x0000890012340067n]) {
    const x = X86.decodeDescriptor(v);
    assert.equal(X86.encodeDescriptor(x), v);
  }
});

test('modo protegido: cálculo de dirección lineal exitoso', () => {
  const desc = X86.encodeDescriptor({ base: 0x00400000, limit: 0xfffff, type: 2, s: 1, dpl: 3, p: 1, avl: 0, l: 0, db: 1, g: 1 });
  const r = X86.protectedMode({ ...base, cpl: 3, selector: 0x0023, descriptor: desc, segReg: 'DS', offset: 0x1234 });
  assert.equal(r.fault, null);
  assert.equal(r.linear, 0x00401234);
  assert.equal(r.entryAddress, 0x1000 + 4 * 8);
});

test('modo protegido: la suma base + offset da la vuelta en 4 GiB', () => {
  const desc = X86.encodeDescriptor({ base: 0xfffff000, limit: 0xfffff, type: 0xa, s: 1, dpl: 0, p: 1, avl: 0, l: 0, db: 1, g: 1 });
  const r = X86.protectedMode({ ...base, selector: 0x0008, descriptor: desc, segReg: 'CS', offset: 0x2000 });
  assert.equal(r.fault, null);
  assert.equal(r.linear, 0x00001000);
  assert.equal(r.wrapped, true);
});

test('modo protegido: excepciones', () => {
  const code = 0x00cf9a000000ffffn;
  const data = 0x00cf92000000ffffn;
  const pm = (o) => X86.protectedMode({ ...base, offset: 0, ...o });

  assert.equal(pm({ selector: 0, descriptor: code, segReg: 'CS' }).fault.vector, '#GP');
  assert.equal(pm({ selector: 0, descriptor: data, segReg: 'DS' }).fault.errorCode, 0);
  // Datos en CS
  assert.equal(pm({ selector: 0x10, descriptor: data, segReg: 'CS' }).fault.vector, '#GP');
  // Código en SS
  assert.equal(pm({ selector: 0x08, descriptor: code, segReg: 'SS' }).fault.vector, '#GP');
  // Código legible en DS: válido
  assert.equal(pm({ selector: 0x08, descriptor: code, segReg: 'DS' }).fault, null);
  // Código solo ejecución en DS
  assert.equal(pm({ selector: 0x08, descriptor: 0x00cf98000000ffffn, segReg: 'DS' }).checks.at(-1).id, 'type');
  // Usuario (CPL 3) cargando datos de anillo 0
  const priv = pm({ selector: 0x13, descriptor: data, segReg: 'DS', cpl: 3 });
  assert.equal(priv.fault.vector, '#GP');
  assert.equal(priv.fault.errorCode, 0x10);
  // SS exige RPL = CPL = DPL
  assert.equal(pm({ selector: 0x13, descriptor: data, segReg: 'SS' }).fault.vector, '#GP');
  // No presente
  assert.equal(pm({ selector: 0x10, descriptor: 0x00cf12000000ffffn, segReg: 'DS' }).fault.vector, '#NP');
  assert.equal(pm({ selector: 0x10, descriptor: 0x00cf12000000ffffn, segReg: 'SS' }).fault.vector, '#SS');
  // Descriptor de sistema
  assert.equal(pm({ selector: 0x28, descriptor: 0x0000890012340067n, segReg: 'DS' }).checks.at(-1).id, 's');
  // Índice fuera de la tabla
  assert.equal(pm({ selector: 0x80, descriptor: data, segReg: 'DS', gdtLimit: 0x1f }).fault.errorCode, 0x80);
});

test('modo protegido: límite expand-up y expand-down', () => {
  const small = X86.encodeDescriptor({ base: 0x2000, limit: 0x0fff, type: 2, s: 1, dpl: 0, p: 1, avl: 0, l: 0, db: 1, g: 0 });
  const pm = (o) => X86.protectedMode({ ...base, selector: 0x10, descriptor: small, segReg: 'DS', ...o });
  assert.equal(pm({ offset: 0x0fff }).linear, 0x2fff);
  assert.equal(pm({ offset: 0x1000 }).fault.vector, '#GP');
  assert.equal(pm({ offset: 0x1000, segReg: 'SS' }).fault.vector, '#SS');

  // Pila expand-down de 16 bits (B = 0): válidos límite+1 … FFFFh
  const down = X86.encodeDescriptor({ base: 0x30000, limit: 0x0fff, type: 6, s: 1, dpl: 0, p: 1, avl: 0, l: 0, db: 0, g: 0 });
  const st = (off) => X86.protectedMode({ ...base, selector: 0x18, descriptor: down, segReg: 'SS', offset: off });
  assert.equal(st(0x0fff).fault.vector, '#SS');
  assert.equal(st(0x1000).linear, 0x31000);
  assert.equal(st(0xffff).linear, 0x3ffff);
  assert.equal(st(0x10000).fault.vector, '#SS');
});

test('reversing: validación de entrada binaria', () => {
  assert.equal(X86.parseBinaryDescriptor('').ok, false);
  const short = X86.parseBinaryDescriptor('1010');
  assert.equal(short.ok, false);
  assert.match(short.error, /Faltan 60/);
  const bad = X86.parseBinaryDescriptor('0'.repeat(63) + '2');
  assert.equal(bad.ok, false);
  assert.equal(bad.invalid[0].pos, 63);
  assert.match(X86.parseBinaryDescriptor('1'.repeat(65)).error, /Sobran 1/);
  const ok = X86.parseBinaryDescriptor('00000000 11001111 10011010 00000000\n00000000_00000000 1111111111111111');
  assert.equal(ok.ok, true);
  assert.equal(ok.value, 0x00cf9a000000ffffn);
});

test('reversing: identifica segmentos, sistema y compuertas', () => {
  const code = X86.reverseDescriptor(0x00cf9a000000ffffn);
  assert.match(code.title, /código · 32 bits · anillo 0/);
  assert.ok(code.known);
  assert.deepEqual(code.usable, { CS: true, SS: false, DS: true });

  const stack = X86.reverseDescriptor(X86.encodeDescriptor({ base: 0x30000, limit: 0xfff, type: 6, s: 1, dpl: 3, p: 1, avl: 0, l: 0, db: 1, g: 0 }));
  assert.match(stack.title, /datos · 32 bits · anillo 3/);
  assert.ok(stack.notes.some((n) => /Expand-down/.test(n)));

  const tss = X86.reverseDescriptor(0x0000890012340067n);
  assert.equal(tss.desc.typeInfo.sub, 'tss');
  assert.match(tss.title, /TSS de 32 bits/);

  // Compuerta de llamada 32 bits: selector 0008h, offset 12345678h, DPL 3, 2 parámetros
  const gateRaw = (0x1234n << 48n) | (1n << 47n) | (3n << 45n) | (0xcn << 40n) | (2n << 32n) | (0x0008n << 16n) | 0x5678n;
  const gate = X86.reverseDescriptor(gateRaw);
  assert.equal(gate.layout, 'gate');
  assert.equal(gate.gate.offset, 0x12345678);
  assert.equal(gate.gate.selector, 8);
  assert.equal(gate.gate.params, 2);

  assert.equal(X86.reverseDescriptor(0n).isNull, true);
  assert.ok(X86.reverseDescriptor(0x0000800000000000n).warnings.length > 0); // tipo de sistema reservado
  assert.ok(X86.reverseDescriptor(0x00ef9a000000ffffn).warnings.some((w) => /L = 1 y D = 1/.test(w)));
  assert.ok(X86.reverseDescriptor(0x00cf1a000000ffffn).warnings.some((w) => /P = 0/.test(w)));
});
