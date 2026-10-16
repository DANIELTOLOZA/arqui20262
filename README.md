# SegLab x86

Laboratorio web interactivo para aprender el **direccionamiento de memoria x86** en modo real y en modo protegido, con animaciones paso a paso.

## Cómo usarlo

No requiere instalación ni compilación: abre `index.html` en cualquier navegador moderno (Chrome, Edge, Firefox, Safari).
Opcionalmente, sírvelo localmente:

```bash
python3 -m http.server 8000   # luego abre http://localhost:8000
```

## Secciones

| Sección | Entrada | Qué muestra |
|---|---|---|
| **Modo real** | Segmento y desplazamiento (hex, 16 bits) | Desplazamiento de 4 bits del segmento, suma hexadecimal columna a columna con acarreos, la misma suma en binario, la dirección física de 20 bits, el desborde con la línea **A20**, la ubicación en el mapa del primer MiB y los pares segmento:desplazamiento equivalentes. Incluye un **reto rápido** para practicar. |
| **Modo protegido** | Tipo de segmento (CS, DS, SS), selector, descriptor (hex o por campos), desplazamiento, CPL y GDTR/LDTR | Descomposición del selector (índice, TI, RPL), ubicación de la entrada en la GDT/LDT, lectura del descriptor (base, límite, G, atributos), validaciones de tipo, privilegio y presencia, comprobación de límite (expand-up / expand-down), dirección lineal y caché oculta del registro. Si una regla falla, muestra la excepción (#GP, #NP, #SS) y su código de error. |
| **Reversing** | Descriptor completo en **binario** (64 bits) | Valida la entrada (solo 0/1, exactamente 64 bits, indica la posición de un carácter inválido), muestra una ficha "¿Quién es?" (código, datos, TSS, LDT, compuertas, nulo o reservado), mapa de bits interactivo, tabla de campos, el significado del campo Tipo, advertencias (P = 0, L y D a la vez, tipos reservados…) y permite enviarlo al simulador de modo protegido. |
| **Teoría** | — | Resumen de fórmulas, formatos de selector y descriptor, reglas de privilegio, excepciones y tabla de tipos. |

Atajos: `←` / `→` cambian de paso, `Espacio` reproduce o pausa, `Inicio` / `Fin` van al primer o último paso.

## Estructura

```
index.html          Interfaz
css/styles.css      Estilos (tema claro y oscuro)
js/core.js          Lógica pura de direccionamiento (sin DOM, probada)
js/ui.js            Componentes: entradas hex, controles, reproductor de pasos
js/real.js          Modo real
js/protected.js     Modo protegido
js/reverse.js       Reversing de descriptores
js/theory.js        Pestaña de teoría
js/app.js           Pestañas, tema y atajos
tests/core.test.js  Pruebas automáticas de la lógica
```

## Validación

La lógica de cálculo está cubierta por pruebas automáticas (Node.js 18 o superior):

```bash
npm test        # equivale a: node --test tests/core.test.js
```

Casos verificados, entre otros:

- `1234:5678 → 179B8h`, `B800:0000 → B8000h`, `FFFF:0000 → FFFF0h`, `FFFF:FFFF → 0FFEFh` sin A20 y `10FFEFh` con A20.
- Selector `0023h` → índice 4, GDT, RPL 3; descriptor `00CFF2400000FFFF` + `00001234h` → lineal `00401234h`.
- Excepciones: selector nulo en CS/SS, datos en CS, código en SS, código solo-ejecución en DS, DPL insuficiente, P = 0 (#NP / #SS), desplazamiento fuera de límite, índice fuera de la GDT.
- Segmentos expand-down de 16 y 32 bits, granularidad G, vuelta en 4 GiB.
- Reversing: validación de longitud y caracteres, segmentos de código y datos, TSS, compuertas de llamada, descriptor nulo y combinaciones inválidas.
