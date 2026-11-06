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
// Palabras que delatan que NO es un nombre ("Citlali no se ha desconectado", "falta que se desconecte X")
const RE_NO_NOMBRE = /\b(nadie|ninguno|ninguna|todos|todas|alguien|se|ya|no|ha|han|he|aun|todavia|falta|faltan|cuando|si|que|favor|para|pedir|hay|cargador|cargadores|cajon|cajones|lugar|lugares|disponible|disponibles|libre|libres)\b/;
// Lista de nombres válidos, o null si algún elemento no parece un nombre (≤5 palabras, sin dígitos ni palabras delatoras)
function nombresValidos(txt) {
  const ns = listaNombres(txt);
  if (!ns.length) return null;
  for (const n of ns) {
    const norm = normalizar(n);
    if (!norm || norm.split(' ').length > 5 || /\d/.test(norm) || RE_NO_NOMBRE.test(norm)) return null;
  }
  return ns;
}
// "Roxana se tiene que desconectar" / "Roxana y Nancy se tienen que desconectar" (todas las líneas deben ser así)
const RE_NOMBRE_RECORDAR = /^\s*(.{2,80}?)\s+se\s+tiene[n]?\s+que\s+desconect(?:ar|arse)\s*[.!]*\s*$/i;
function parsearRecordarNombrePrimero(t) {
  const lineas = t.split('\n').filter(function(l) { return l.trim(); });
  if (!lineas.length) return null;
  const nombres = [];
  for (const l of lineas) {
    const m = l.match(RE_NOMBRE_RECORDAR);
    const ns = m ? nombresValidos(m[1]) : null;
    if (!ns) return null;
    ns.forEach(function(n) { nombres.push(n); });
  }
  return { tipo: 'recordar', nombres: nombres };
}

function parsearRecordar(t) {
  let m = t.match(/^\s*se\s+tiene[n]?\s+que\s+desconect(?:ar|arse)\b[ \t]*[:\-]?[ \t]*([\s\S]*)$/i);
  if (!m) m = t.match(/^\s*(?:favor\s+de\s+)?desconect(?:ar|en|e)\s+a\s+([\s\S]+)$/i);
  if (!m) m = t.match(/^\s*pedir\s+(?:a\s+)?([\s\S]+?)\s+que\s+se\s+desconect/i);
  if (!m) return parsearRecordarNombrePrimero(t);
  const nombres = listaNombres(m[1]);
  return nombres.length ? { tipo: 'recordar', nombres: nombres } : null;
}

// ── CONFIRMACIÓN (el ayudante avisa que YA se desconectan / desconectaron):
//    "Se desconectan\nA\nB", "Se desconecta\n\nC", "Se desconectó X"
function parsearDesconectaron(t) {
  // OJO: \b no considera letra a la «ó», por eso el fin de palabra se pide con (?![a-záéíóúñ])
  const m = t.match(/^\s*(?:ya\s+)?se\s+desconect(?:aron|an|ó|o|a)(?![a-záéíóúñ])[ \t]*[:\-]?[ \t]*([\s\S]*)$/i);
  if (!m) return null;
  // Líneas del cuerpo que en realidad dicen "41 libre": se separan de los nombres y generan un evento 'libre'
  const lineas = m[1].split('\n'), restoNombres = [];
  const libres = { validos: [], invalidos: [] };
  lineas.forEach(function(l) {
    const r = parsearLibres(l);
    if (hayLibres(r)) {
      r.validos.forEach(function(n) { if (libres.validos.indexOf(n) === -1) libres.validos.push(n); });
      r.invalidos.forEach(function(n) { if (libres.invalidos.indexOf(n) === -1) libres.invalidos.push(n); });
    } else restoNombres.push(l);
  });
  const nombres = listaNombres(restoNombres.join('\n'));
  const out = [];
  if (nombres.length) out.push({ tipo: 'desconectaron', nombres: nombres });
  if (hayLibres(libres)) out.push({ tipo: 'libre', cajones: libres.validos, invalidos: libres.invalidos });
  return out.length ? out : null;
}

// ── "2 lugares disponibles"
function parsearDisponibles(t) {
  const m = t.match(/(\d+)\s+(?:lugar(?:es)?|cajon(?:es)?|caj[oó]n(?:es)?|cargador(?:es)?|espacios?)\s+(?:disponibles?|libres?)/i);
  return m ? { tipo: 'disponibles', n: parseInt(m[1], 10) } : null;
}

// ── CONFIRMACIÓN con el nombre primero (una línea por persona, o "A y B"):
//    "Citlali Guzmán desconectada", "Citlali se desconectó", "Citlali ya se desconectó", "Roxana y Citlali desconectadas"
//    Puede venir con "1 cargador disponible" en el mismo mensaje (se procesa primero la desconexión y luego el conteo).
//    Solo cuenta si la línea TERMINA en el verbo (o hora / "hace rato" / "ahorita"): "Roxana desconectó a Citlali" no cuenta.
const RE_NOMBRE_DESCONECTO = /^\s*(?:ya\s+)?(.{2,80}?)\s+(?:ya\s+)?(?:se\s+)?desconect(?:ó|o|ada|ado|adas|ados|aron)(?:\s+(?:a\s+las\s+)?\d{1,2}[:.]\d{2}(?:\s*[ap]\.?m\.?)?|\s+hace\s+(?:rato|\d+\s+min\w*)|\s+ahorita)?\s*[.!]*\s*(?:[,;].*)?$/i;
function parsearNombreDesconecto(t) {
  // Un reporte de conexiones no se toca
  if (/^\s*se\s+conectan?\b/i.test(t) || (t.match(/caj[oó]n\s+\d+/gi) || []).length >= 2) return null;
  const nombres = [];
  t.split('\n').forEach(function(l) {
    const m = l.match(RE_NOMBRE_DESCONECTO);
    const ns = m ? nombresValidos(m[1]) : null;
    if (ns) ns.forEach(function(n) { if (nombres.indexOf(n) === -1) nombres.push(n); });
  });
  if (!nombres.length) return null;
  const out = [{ tipo: 'desconectaron', nombres: nombres }];
  const libres = parsearLibres(t);
  if (hayLibres(libres)) out.push({ tipo: 'libre', cajones: libres.validos, invalidos: libres.invalidos });
  const disp = parsearDisponibles(t);
  if (disp) out.push(disp);
  return out;
}

// ── "44 libre", "41 y 42 libres", "Cajón 42 libre", "Libre 41", "41: libre", "41 ya está libre", "Libres 41 y 42"
// Cada línea por separado (no cruza saltos de línea, para no confundir "Cajón 46\nLibre uso extendido" del reporte).
// Devuelve { validos: [...], invalidos: [...] }: invalidos = números 40-59 que no son cajón ("59" por "50").
const LISTA_NUM = '\\d{2}(?:[ \\t]*(?:,|y|e)[ \\t]*\\d{2})*';
const RE_LIBRE_DESPUES = new RegExp('(?<![\\d:])(' + LISTA_NUM + ')[ \\t]*[:\\-–]?[ \\t]*(?:ya[ \\t]+)?(?:est[aá]n?[ \\t]+|qued[oó][ \\t]+|quedaron[ \\t]+)?libres?\\b', 'gi');
const RE_LIBRE_ANTES = new RegExp('\\blibres?\\b[ \\t]+(?:el[ \\t]+|los[ \\t]+)?(?:caj[oó]n(?:es)?[ \\t]+)?(' + LISTA_NUM + ')(?![\\d:]|[ \\t]*(?:min|hrs?\\b|horas?|h\\b|a\\.?m|p\\.?m|%))', 'gi');
function parsearLibres(t) {
  const validos = [], invalidos = [];
  function tomar(txt) {
    (txt.match(/\d{2}/g) || []).forEach(function(n) {
      if (CAJONES_VALIDOS.indexOf(n) !== -1) { if (validos.indexOf(n) === -1) validos.push(n); }
      else if (+n >= 40 && +n <= 59 && invalidos.indexOf(n) === -1) invalidos.push(n);
    });
  }
  String(t).split('\n').forEach(function(linea) {
    let m;
    RE_LIBRE_DESPUES.lastIndex = 0;
    while ((m = RE_LIBRE_DESPUES.exec(linea)) !== null) tomar(m[1]);
    RE_LIBRE_ANTES.lastIndex = 0;
    while ((m = RE_LIBRE_ANTES.exec(linea)) !== null) tomar(m[1]);
  });
  return { validos: validos, invalidos: invalidos };
}
function hayLibres(l) { return l.validos.length > 0 || l.invalidos.length > 0; }

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
  if (d) return d;
  const nd = parsearNombreDesconecto(t);
  if (nd) return nd;
  const disp = parsearDisponibles(t);
  if (disp) return [disp];
  const libres = parsearLibres(t);
  if (hayLibres(libres)) return [{ tipo: 'libre', cajones: libres.validos, invalidos: libres.invalidos }];
  return parsearConexiones(t);
}

// Distancia de edición (Levenshtein) para tolerar errores de ortografía: "Dominges" ~ "Dominguez"
function distancia(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const d = [];
  for (let i = 0; i <= m; i++) { d[i] = [i]; }
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      // letras adyacentes intercambiadas ("juardo" ~ "jurado") cuentan como 1 error
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}
// Tokens parecidos: iguales, prefijo (≥3) o con 1 error (≥5 letras) / 2 errores (≥8 letras)
function tokenParecido(x, y) {
  if (x === y) return true;
  if (x.length >= 3 && y.length >= 3 && (y.indexOf(x) === 0 || x.indexOf(y) === 0)) return true;
  // una parte del nombre dentro del otro ("pimosh" en "pasapimosh"), con ≥5 letras para no dar falsos positivos
  if (x.length >= 5 && y.length >= 5 && (y.indexOf(x) !== -1 || x.indexOf(y) !== -1)) return true;
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
