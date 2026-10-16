/* theory.js — Contenido de la pestaña Teoría. */
(function () {
  'use strict';
  const H = X86.hex;

  function typeTable() {
    let rows = '';
    for (let t = 0; t < 16; t++) {
      const i = X86.describeType(1, t);
      rows += '<tr><td class="mono">' + H(t) + 'h</td><td class="mono">' + X86.bin(t, 4) + '</td><td>' + (t & 8 ? 'Código' : 'Datos') + '</td><td>' + i.name.replace(/^(Código|Datos), /, '') + '</td></tr>';
    }
    return '<div class="scroll-x"><table class="ftable compact"><thead><tr><th>Tipo</th><th>Bits</th><th>Clase</th><th>Permisos</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function render() {
    return '' +
      '<article class="card th">' +
        '<h2>Modo real</h2>' +
        '<p>Es el modo en que arranca todo procesador x86. Imita al 8086: registros de 16 bits y un bus de direcciones de 20 bits, es decir 2<sup>20</sup> = 1 MiB de memoria.</p>' +
        '<p class="formula">Física = Segmento × 10h + Desplazamiento</p>' +
        '<ul><li>Un segmento empieza en cualquier múltiplo de 16 bytes (un <em>párrafo</em>) y mide como máximo 64 KiB.</li>' +
        '<li>Los segmentos se solapan: hasta 4096 pares distintos apuntan al mismo byte.</li>' +
        '<li>No hay protección: cualquier programa puede escribir en cualquier dirección.</li>' +
        '<li>FFFF:FFFF = 10FFEFh necesita 21 bits. Sin la línea <b>A20</b> da la vuelta a 0FFEFh; con A20 se alcanza la HMA.</li></ul>' +
      '</article>' +
      '<article class="card th">' +
        '<h2>Modo protegido</h2>' +
        '<p>Desde el 80286 (y en 32 bits desde el 80386), el registro de segmento ya no contiene una base sino un <b>selector</b> que apunta a un <b>descriptor</b> de 8 bytes en una tabla.</p>' +
        '<ol class="flow"><li><b>Selector</b> → índice, TI y RPL.</li><li><b>Tabla</b>: GDTR.base (o LDTR) + índice × 8.</li><li><b>Descriptor</b>: base de 32 bits, límite de 20 bits y atributos.</li><li><b>Validación</b>: tipo, privilegio, presencia y límite.</li><li><b>Lineal</b> = base + desplazamiento.</li></ol>' +
        '<p>El descriptor se guarda en la parte oculta del registro de segmento, así la CPU no vuelve a leer la tabla en cada acceso.</p>' +
      '</article>' +
      '<article class="card th">' +
        '<h2>Selector (16 bits)</h2>' +
        '<div class="sel-diagram"><span class="f-index" style="flex:13">Índice · bits 15–3</span><span class="f-ti" style="flex:2.2">TI · 2</span><span class="f-rpl" style="flex:3">RPL · 1–0</span></div>' +
        '<ul><li><b>Índice</b>: entrada 0 a 8191 de la tabla.</li><li><b>TI</b>: 0 = GDT (global), 1 = LDT (local de la tarea).</li><li><b>RPL</b>: privilegio solicitado por quien entrega el selector.</li></ul>' +
      '</article>' +
      '<article class="card th wide">' +
        '<h2>Descriptor de segmento (64 bits)</h2>' +
        '<div class="scroll-x">' + window.ProtectedMode.dwordLayout(0x00cf9a000000ffffn, X86.SEGMENT_FIELDS) + '</div>' +
        '<ul class="two"><li><b>Base</b> (32 bits) repartida en 3 trozos: 15–0, 23–16 y 31–24.</li><li><b>Límite</b> (20 bits) en 2 trozos. Con <b>G = 1</b> se mide en páginas de 4 KiB: límite efectivo = límite × 1000h + FFFh.</li>' +
        '<li><b>P</b> presente, <b>DPL</b> privilegio, <b>S</b> código/datos (1) o sistema (0).</li><li><b>D/B</b> tamaño por defecto (32/16 bits), <b>L</b> código de 64 bits, <b>AVL</b> libre para el SO.</li></ul>' +
      '</article>' +
      '<article class="card th">' +
        '<h2>Reglas de privilegio</h2>' +
        '<p>CPL es el anillo del código que se ejecuta; RPL viene en el selector; DPL en el descriptor. Menor número = más privilegio.</p>' +
        '<div class="scroll-x"><table class="ftable compact"><thead><tr><th>Registro</th><th>Condición para cargar</th></tr></thead><tbody>' +
          '<tr><td><b>DS, ES, FS, GS</b></td><td class="mono">DPL ≥ máx(CPL, RPL)</td></tr>' +
          '<tr><td><b>SS</b></td><td class="mono">RPL = CPL = DPL</td></tr>' +
          '<tr><td><b>CS</b> no conforming</td><td class="mono">RPL ≤ CPL y DPL = CPL</td></tr>' +
          '<tr><td><b>CS</b> conforming</td><td class="mono">DPL ≤ CPL</td></tr>' +
        '</tbody></table></div>' +
      '</article>' +
      '<article class="card th">' +
        '<h2>Excepciones</h2>' +
        '<div class="scroll-x"><table class="ftable compact"><thead><tr><th>Vector</th><th>Cuándo ocurre</th></tr></thead><tbody>' +
          '<tr><td class="mono">#GP · 13</td><td>Selector nulo en CS/SS, índice fuera de la tabla, tipo incorrecto, privilegio insuficiente, desplazamiento fuera del límite.</td></tr>' +
          '<tr><td class="mono">#NP · 11</td><td>El descriptor tiene P = 0 (al cargar DS, ES, FS, GS o CS).</td></tr>' +
          '<tr><td class="mono">#SS · 12</td><td>P = 0 al cargar SS, o ESP fuera del límite de la pila.</td></tr>' +
        '</tbody></table></div>' +
      '</article>' +
      '<article class="card th">' +
        '<h2>Tipos de código y datos (S = 1)</h2>' + typeTable() +
      '</article>';
  }

  window.Theory = { init: () => { document.getElementById('theory').innerHTML = render(); } };
})();
