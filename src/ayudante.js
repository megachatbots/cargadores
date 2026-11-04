// src/ayudante.js — Interpreta los mensajes del grupo Control de Cargadores (funciones puras, sin red)
// Devuelve una lista de eventos:
//   {tipo:'conecta', cajon, nombre, horaInicio, horaFin, marca, placas, nombreDudoso}
//   {tipo:'libre', cajones:[...]}
//   {tipo:'recordar', nombres:[...]}        (pide recordatorio: "se tiene que desconectar X")
//   {tipo:'desconectaron', nombres:[...]}   (confirma desconexión: "Se desconectan X")
//   {tipo:'disponibles', n}
//   {tipo:'reporte'}            (≥2 bloques "Cajón N": lo procesa el cargador de estado inicial)
const { parsearBloqueOcupado } = require('./motor_cargadores');

const CAJONES_VALIDOS = ['41', '42', '44', '45', '46', '48', '49', '50'];
const MARCAS = ['tesla', 'byd', 'bmw', 'volvo', 'cupra', 'mg', 'volt', 'chevrolet', 'nissan', 'ford', 'kia',
  'hyundai', 'audi', 'mercedes', 'porsche', 'volkswagen', 'vw', 'renault', 'polestar', 'mini', 'jac',
  'geely', 'zeekr', 'leapmotor', 'deepal', 'seres', 'jetour', 'omoda', 'fiat', 'peugeot', 'toyota',
  'honda', 'mazda', 'lexus', 'smart', 'ora', 'xpeng', 'nio', 'lucid', 'rivian', 'omoda', 'chery'];

function normalizar(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Nombre que en realidad es una marca o placas ("Cupra", "Tesla", "62G718")
function nombreDudoso(nombre) {
  const n = normalizar(nombre);
  if (!n) return true;
  if (MARCAS.indexOf(n) !== -1) return true;
  if (/\d/.test(n)) return true;
  return false;
}

// Lista de nombres a partir de un cuerpo de texto (una por línea, o separados por coma / "y")
function listaNombres(cuerpo) {
  return cuerpo.split(/\n|,|;|\s+y\s+/i)
    .map(function(x) { return x.replace(/^\s*(?:usuarios?|a)\s+/i, '').trim(); })
    .filter(function(x) { return x.length >= 2; });
}

// ── RECORDATORIO (pide que el bot recuerde a alguien que debe desconectarse):
//    "se tiene que desconectar X", "desconecten a X", "pedir a X que se desconecte"
function parsearRecordar(t) {
  let m = t.match(/^\s*se\s+tiene[n]?\s+que\s+desconect(?:ar|arse)\b[ \t]*[:\-]?[ \t]*([\s\S]*)$/i);
  if (!m) m = t.match(/^\s*(?:favor\s+de\s+)?desconect(?:ar|en|e)\s+a\s+([\s\S]+)$/i);
  if (!m) m = t.match(/^\s*pedir\s+(?:a\s+)?([\s\S]+?)\s+que\s+se\s+desconect/i);
  if (!m) return null;
  const nombres = listaNombres(m[1]);
  return nombres.length ? { tipo: 'recordar', nombres: nombres } : null;
}

// ── CONFIRMACIÓN (el ayudante avisa que YA se desconectan / desconectaron):
//    "Se desconectan\nA\nB", "Se desconecta\n\nC", "Se desconectó X"
function parsearDesconectaron(t) {
  const m = t.match(/^\s*se\s+desconect(?:a|an|ó|o|aron)\b[ \t]*[:\-]?[ \t]*([\s\S]*)$/i);
  if (!m) return null;
  const nombres = listaNombres(m[1]);
  return nombres.length ? { tipo: 'desconectaron', nombres: nombres } : null;
}

// ── "2 lugares disponibles"
function parsearDisponibles(t) {
  const m = t.match(/(\d+)\s+(?:lugar(?:es)?|cajon(?:es)?|caj[oó]n(?:es)?|cargador(?:es)?|espacios?)\s+(?:disponibles?|libres?)/i);
  return m ? { tipo: 'disponibles', n: parseInt(m[1], 10) } : null;
}

// ── "44 libre", "41 y 42 libres", "Cajón 42 libre", "1:50 PM Carlos: 42 libre Carlos"
// Misma línea (no cruza saltos de línea, para no confundir "Cajón 46\nLibre uso extendido" del reporte)
function parsearLibres(t) {
  const encontrados = [];
  const re = /(?<![\d:])(\d{2}(?:[ \t]*(?:,|y|e)[ \t]*\d{2})*)[ \t]+(?:est[aá]n?[ \t]+)?libres?\b/gi;
  let m;
  while ((m = re.exec(t)) !== null) {
    (m[1].match(/\d{2}/g) || []).forEach(function(n) {
      if (CAJONES_VALIDOS.indexOf(n) !== -1 && encontrados.indexOf(n) === -1) encontrados.push(n);
    });
  }
  return encontrados;
}

// ── Conexiones: "Se conecta\nCajón 41\nNombre\nPlacas Marca\n1:22 A 4:22" (uno o varios bloques)
function parsearConexiones(t) {
  let prefijo = false;
  let cuerpo = t;
  const mp = cuerpo.match(/^\s*se\s+conectan?\b[ \t]*[:\-]?[ \t]*\n?/i);
  if (mp) { prefijo = true; cuerpo = cuerpo.slice(mp[0].length); }

  const numBloques = (cuerpo.match(/caj[oó]n\s+\d+/gi) || []).length;
  if (numBloques === 0) return [];
  if (numBloques >= 2 && !prefijo) return [{ tipo: 'reporte' }];

  const eventos = [];
  const bloques = cuerpo.split(/(?=caj[oó]n\s+\d+)/i).filter(function(b) { return b.trim(); });
  for (const bloque of bloques) {
    const lineas = bloque.split(/\n/).map(function(l) { return l.trim(); }).filter(Boolean);
    const mc = lineas[0] && lineas[0].match(/^caj[oó]n\s+(\d+)\s*(.*)$/i);
    if (!mc || CAJONES_VALIDOS.indexOf(mc[1]) === -1) continue;
    const resto = [];
    if (mc[2] && mc[2].trim()) resto.push(mc[2].trim());
    lineas.slice(1).forEach(function(l) { resto.push(l); });
    if (!resto.length || /^libre/i.test(resto[0])) continue;
    if (/falla|foco|no funciona|no carga|bloquead|mantenimiento|descompuest|averi/i.test(resto.join(' '))) continue;

    const b = parsearBloqueOcupado(resto);
    // Sin prefijo "Se conecta" exigimos pruebas de que es una conexión (hora o placas)
    if (!prefijo && !b.horaFin && !b.placas) continue;
    eventos.push({
      tipo: 'conecta', cajon: mc[1], nombre: b.nombre, horaInicio: b.horaInicio, horaFin: b.horaFin,
      marca: b.marca, placas: b.placas, nombreDudoso: nombreDudoso(b.nombre)
    });
  }
  return eventos;
}

function parsearMensajeAyudante(texto) {
  const t = String(texto || '').replace(/\r/g, '');
  const r = parsearRecordar(t);
  if (r) return [r];
  const d = parsearDesconectaron(t);
  if (d) return [d];
  const disp = parsearDisponibles(t);
  if (disp) return [disp];
  const libres = parsearLibres(t);
  if (libres.length) return [{ tipo: 'libre', cajones: libres }];
  return parsearConexiones(t);
}

// Distancia de edición (Levenshtein) para tolerar errores de ortografía: "Dominges" ~ "Dominguez"
function distancia(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = [], cur = [];
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
// Tokens parecidos: iguales, prefijo (≥3) o con 1 error (≥5 letras) / 2 errores (≥8 letras)
function tokenParecido(x, y) {
  if (x === y) return true;
  if (x.length >= 3 && y.length >= 3 && (y.indexOf(x) === 0 || x.indexOf(y) === 0)) return true;
  const m = Math.min(x.length, y.length);
  const tol = m >= 8 ? 2 : (m >= 5 ? 1 : 0);
  return tol > 0 && distancia(x, y) <= tol;
}

// ── Búsqueda tolerante de nombres: sin acentos, sin importar el orden, nombre parcial.
// candidatos = [{ id, nombre, ... }]. Devuelve los que coinciden (solo exactos si los hay).
function buscarPorNombre(buscado, candidatos) {
  const tb = normalizar(buscado).split(' ').filter(Boolean);
  if (!tb.length) return [];
  const exactos = [], parciales = [];
  candidatos.forEach(function(c) {
    const tc = normalizar(c.nombre).split(' ').filter(Boolean);
    if (!tc.length) return;
    const igual = tb.length === tc.length && tb.every(function(x) { return tc.indexOf(x) !== -1; });
    if (igual) { exactos.push(c); return; }
    const corto = tb.length <= tc.length ? tb : tc;
    const largo = tb.length <= tc.length ? tc : tb;
    const cubre = corto.every(function(x) {
      return largo.some(function(y) { return tokenParecido(x, y); });
    });
    if (cubre) parciales.push(c);
  });
  return exactos.length ? exactos : parciales;
}

module.exports = { parsearMensajeAyudante, buscarPorNombre, nombreDudoso, normalizar, CAJONES_VALIDOS };
