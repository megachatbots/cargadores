// src/fila_cmd.js — Comandos de admin sobre la fila (quitar / fuera / anotar / mover). Puro: sin red, testeable.
// interpretar(texto) → { tipo, ... } | null ; ejecutar(cmd) → texto de respuesta (o null si "no es para mí")
const ayudante = require('./ayudante');

const RE_QUITAR_N  = /^(?:quitar|fuera)\s+(?:a\s+)?#?(\d{1,3})\s*$/i;
const RE_QUITAR    = /^(?:quitar|fuera)\s+(?:a\s+)?(.+)$/i;
const RE_ANOTAR    = /^(?:anotar|agregar|apuntar|a[nñ]adir)\s+(?:a\s+)?(.+?)(?:\s+en\s+(?:la\s+)?(?:posici[oó]n\s+|lugar\s+)?#?(\d{1,2}))?\s*$/i;
const RE_MOVER     = /^(?:mover|subir|pasar|poner)\s+(?:a\s+)?(.+?)\s+(?:a|en)\s+(?:la\s+)?(?:posici[oó]n\s+|lugar\s+)?#?(\d{1,2})\s*$/i;
const RE_MOVER_SIMPLE = /^(.+?)\s+en\s+(?:la\s+)?(?:posici[oó]n\s+|lugar\s+)?#?(\d{1,2})\s*$/i;   // "Pablo en 2": solo si Pablo está en la fila

const RE_SE_LLAMA  = /^#?(\d{1,3})\s+se\s+llama\s+(.+)$/i;               // "3 se llama Miguel Angel" (por posición)
const RE_ES        = /^(.{1,40}?)\s+es\s+(.{3,60})$/i;                   // "M es Miguel Angel" (por nombre en la fila; solo si existe)

function interpretar(texto) {
  const t = String(texto || '').trim();
  let m;
  if ((m = t.match(RE_SE_LLAMA))) return { tipo: 'renombrar_pos', pos: parseInt(m[1], 10), nombre: m[2].trim() };
  if ((m = t.match(RE_QUITAR_N))) return { tipo: 'quitar_pos', pos: parseInt(m[1], 10) };
  if ((m = t.match(RE_QUITAR)))   return { tipo: 'quitar_nombre', nombre: m[1].trim() };
  if ((m = t.match(RE_MOVER)))    return { tipo: 'mover', nombre: m[1].trim(), pos: parseInt(m[2], 10) };
  if ((m = t.match(RE_ANOTAR)))   return { tipo: 'anotar', nombre: m[1].trim(), pos: m[2] ? parseInt(m[2], 10) : null };
  if ((m = t.match(RE_MOVER_SIMPLE))) return { tipo: 'mover_simple', nombre: m[1].trim(), pos: parseInt(m[2], 10) };
  if ((m = t.match(RE_ES)) && !/^\d{2}$/.test(m[1].trim())) return { tipo: 'renombrar', quien: m[1].trim(), nombre: m[2].trim() };   // "44 es X" es de cajones
  return null;
}

function crear(db) {
  function candidatos() {
    return db.getEstado().fila.map(function(u, i) { return { id: String(i + 1), nombre: u.nombre, numero: u.numero, pos: i + 1 }; });
  }
  function buscar(nombre) { return ayudante.buscarPorNombre(nombre, candidatos()); }
  function listar(ms) { return ms.map(function(x) { return x.pos + '. ' + x.nombre; }).join('\n'); }
  function esAmbiguo(nombre, ms) { return '❓ «' + nombre + '» coincide con varios en la fila:\n' + listar(ms) + '\nNo quité a nadie. Escribe *quitar N* con el número.'; }

  async function quitarPos(n) {
    const fila = db.getEstado().fila;
    if (n < 1 || n > fila.length) return '❌ Posición ' + n + ' no existe. La fila tiene ' + fila.length + ' persona' + (fila.length === 1 ? '' : 's') + '.';
    const u = fila[n - 1];
    await db.quitarFila(u.numero);
    return '✅ ' + u.nombre + ' quitado de la fila (era posición ' + n + ')';
  }
  async function quitarNombre(nombre) {
    const ms = buscar(nombre);
    if (!ms.length) return '❌ «' + nombre + '» no está en la fila';
    if (ms.length > 1) return esAmbiguo(nombre, ms);
    await db.quitarFila(ms[0].numero);
    return '✅ ' + ms[0].nombre + ' quitado de la fila (era posición ' + ms[0].pos + ')';
  }
  function textoPosicion(r, nombre) {
    return '✅ *' + nombre + '* en posición ' + r.posicion + (r.ajustada ? ' (las primeras posiciones están reservadas por un llamado activo)' : '');
  }
  async function anotar(nombre, pos) {
    const exacto = db.getEstado().fila.find(function(u) { return ayudante.normalizar(u.nombre) === ayudante.normalizar(nombre); });
    if (exacto) {
      const actual = db.getEstado().fila.indexOf(exacto) + 1;
      if (!pos || pos === actual) return 'ℹ️ ' + exacto.nombre + ' ya está en la fila (posición ' + actual + ')';
      const r = await db.moverEnFila(exacto.numero, pos);
      return 'ℹ️ ' + exacto.nombre + ' ya estaba en la fila (posición ' + actual + '); lo moví. ' + textoPosicion(r, exacto.nombre);
    }
    const r = await db.anotarManual(nombre, pos);
    return textoPosicion(r, nombre) + (pos ? '' : ' (al final)') + '\n⚠️ Sin teléfono: cuando le toque te aviso a ti para que le avises.';
  }
  async function mover(nombre, pos, soloSiExiste) {
    const ms = buscar(nombre);
    if (!ms.length) return soloSiExiste ? null : '❌ «' + nombre + '» no está en la fila';
    if (ms.length > 1) return soloSiExiste ? null : esAmbiguo(nombre, ms).replace('Escribe *quitar N* con el número.', 'Usa el nombre completo.').replace('No quité', 'No moví');
    const r = await db.moverEnFila(ms[0].numero, pos);
    return '↕️ ' + ms[0].nombre + ': posición ' + ms[0].pos + ' → ' + r.posicion + (r.ajustada ? ' (las primeras posiciones están reservadas por un llamado activo)' : '');
  }

  // Renombra a alguien de la fila con su nombre real y lo guarda para sus próximas solicitudes
  async function renombrarU(u, nombre) {
    const r = await db.renombrarEnFila(u.numero, nombre);
    if (!r) return '❌ No pude renombrar a «' + u.nombre + '».';
    return '✅ Posición ' + r.posicion + ': «' + r.antes + '» ahora es *' + nombre + '*' +
      (r.persistido ? ' (guardado: cuando vuelva a escribir se anotará con ese nombre)' : ' (anotado a mano, sin teléfono: solo cambia hoy)') + '.';
  }
  async function renombrar(quien, nombre, soloSiExiste) {
    const fila = db.getEstado().fila;
    const nq = ayudante.normalizar(quien);
    const exactos = nq ? candidatos().filter(function(c) { return ayudante.normalizar(c.nombre) === nq; }) : [];
    // Forma "M es Miguel": solo nombre EXACTO (una frase cualquiera del admin con "es" no debe renombrar a nadie). Tolerante solo con "N se llama X".
    const ms = exactos.length || soloSiExiste ? exactos : buscar(quien);
    if (!ms.length) return soloSiExiste ? null : '❌ «' + quien + '» no está en la fila';
    if (ms.length > 1) return '❓ «' + quien + '» coincide con varios en la fila:\n' + listar(ms) + '\nNo cambié nada. Usa *N se llama ' + nombre + '* con el número de posición.';
    return renombrarU(fila[ms[0].pos - 1], nombre);
  }
  async function renombrarPos(n, nombre) {
    const fila = db.getEstado().fila;
    if (n < 1 || n > fila.length) return '❌ Posición ' + n + ' no existe. La fila tiene ' + fila.length + ' persona' + (fila.length === 1 ? '' : 's') + '.';
    return renombrarU(fila[n - 1], nombre);
  }

  async function ejecutar(cmd) {
    if (!cmd) return null;
    if (cmd.tipo === 'quitar_pos')    return quitarPos(cmd.pos);
    if (cmd.tipo === 'quitar_nombre') return quitarNombre(cmd.nombre);
    if (cmd.tipo === 'anotar')        return anotar(cmd.nombre, cmd.pos);
    if (cmd.tipo === 'mover')         return mover(cmd.nombre, cmd.pos, false);
    if (cmd.tipo === 'mover_simple')  return mover(cmd.nombre, cmd.pos, true);
    if (cmd.tipo === 'renombrar_pos') return renombrarPos(cmd.pos, cmd.nombre);
    if (cmd.tipo === 'renombrar')     return renombrar(cmd.quien, cmd.nombre, true);
    return null;
  }
  return { interpretar, ejecutar, quitarPos, quitarNombre, anotar, mover };
}

module.exports = { crear, interpretar };
