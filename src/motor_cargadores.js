// src/motor_cargadores.js — AI para solicitudes + parser de comandos + parser matutino
const { promptClasificador, promptComandoAdmin } = require('./prompt_cargadores');

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODELO  = process.env.MODELO_PARSER || 'claude-haiku-4-5-20251001';

const PROMPT_CLASIFICADOR = promptClasificador();
const PROMPT_COMANDO      = promptComandoAdmin();

// LLAMADA API
async function llamarClaude(system, userContent, maxTokens) {
  if (!API_KEY) throw new Error('Falta ANTHROPIC_API_KEY');
  maxTokens = maxTokens || 256;
  for (let intento = 0; intento <= 3; intento++) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODELO, max_tokens: maxTokens, system: system, messages: [{ role: 'user', content: userContent }] })
    });
    if (resp.status === 429) {
      const espera = (intento + 1) * 8000;
      console.log('[motor_c] 429. Esperando ' + (espera/1000) + 's...');
      await new Promise(function(r) { setTimeout(r, espera); });
      continue;
    }
    if (!resp.ok) { const e = await resp.text(); throw new Error('API ' + resp.status + ': ' + e); }
    const data  = await resp.json();
    const txt   = data.content.filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('').trim();
    const limpio = txt.replace(/```json|```/g, '').trim();
    const f = limpio.indexOf('{'), l = limpio.lastIndexOf('}');
    return JSON.parse(f !== -1 ? limpio.substring(f, l + 1) : limpio);
  }
  throw new Error('API: agotados los reintentos');
}

// PRE-FILTRO LOCAL
function prefiltroCargador(texto) {
  const tl = texto.toLowerCase();
  const negativo = /^(ok|gracias|de acuerdo|claro|perfecto|bajo|listo|conectad|desconectad|libero|libera|liberand|bajando|voy)/i.test(tl.trim());
  if (negativo) return false;
  return /cargar|turno|lugar|fila|anot|apunt|anex|agrega|cargador|espera|quiero|necesito|disponib|hay lugar|también|tambi[eé]n|considerar|lista/i.test(tl);
}

// DETECTAR SOLICITUD (AI)
async function detectarSolicitud(texto, nombreRemitente) {
  if (!prefiltroCargador(texto)) return { es_solicitud: false };
  try {
    return await llamarClaude(PROMPT_CLASIFICADOR, 'Remitente: ' + nombreRemitente + '\nMensaje: "' + texto + '"');
  } catch (e) {
    console.log('[motor_c] detectarSolicitud error:', e.message);
    return { es_solicitud: false };
  }
}

// PARSEAR COMANDO ADMIN (AI)
async function parsearComandoAdmin(texto, nombreRemitente) {
  try {
    return await llamarClaude(PROMPT_COMANDO, 'Admin: ' + nombreRemitente + '\nMensaje: "' + texto + '"');
  } catch (e) {
    console.log('[motor_c] parsearComandoAdmin error:', e.message);
    return { comando: null, nombre: null };
  }
}

// PARSER REPORTE MATUTINO (regex, sin AI)
// Formato:
// Cajón 41
// Nombre HH:MM-HH:MM
// Marca
// Placas
//
// Cajón 42
// Libre
//
// Cajón 46
// Libre uso extendido
function parsearReporteMatutino(texto) {
  // Debe mencionar al menos 3 cajones para ser considerado reporte matutino
  const numCajones = (texto.match(/caj[oó]n\s+\d+/gi) || []).length;
  if (numCajones < 2) return null;

  const items = [];
  // Dividir por "Cajón N"
  const bloques = texto.split(/(?=caj[oó]n\s+\d+)/i).filter(function(b) { return b.trim(); });

  for (const bloque of bloques) {
    const lineas = bloque.split(/\n/).map(function(l) { return l.trim(); }).filter(Boolean);
    if (!lineas.length) continue;

    const mCajon = lineas[0].match(/caj[oó]n\s+(\d+)/i);
    if (!mCajon) continue;
    const cajon = mCajon[1];

    // Libre
    if (!lineas[1] || /^libre/i.test(lineas[1])) {
      items.push({ cajon, ocupado: false });
      continue;
    }

    // Ocupado: "Nombre HH:MM-HH:MM" o "Nombre antes de las 7:00"
    const lineaNombre = lineas[1];
    const mHora = lineaNombre.match(/(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}[:\-]\d{2})/);
    const nombre = lineaNombre
      .replace(/\s+\d{1,2}:\d{2}.*/,'')
      .replace(/\s+antes de.*/i,'')
      .trim();

    // Si no hay rango de horas, asumir que conectó antes de las 7:00
    const horaInicio = mHora ? mHora[1] : '7:00';
    const horaFin    = mHora ? mHora[2].replace('-',':') : null;
    const marca      = lineas[2] || null;
    const placas     = lineas[3] || null;

    items.push({ cajon, ocupado: true, nombre, horaInicio, horaFin, marca, placas });
  }

  return items.length ? items : null;
}

// Detecta si un mensaje es un reporte matutino (para rutear antes de llamar AI)
function esReporteMatutino(texto) {
  return (texto.match(/caj[oó]n\s+\d+/gi) || []).length >= 2;
}

// Parser conexión ayudante: "Cajón 44\nNombre HH:MM-HH:MM\nMarca\nPlacas"
function parsearAyudanteConexion(texto) {
  const HORA_RANGO = /(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}[:\-]\d{2})/;
  const m = texto.match(/caj[oó]n\s+(\d+)\s*\n([^\n]+?)\s+(\d{1,2}:\d{2}[-–]\d{1,2}[:\-]\d{2})\s*\n([^\n]*)\s*\n([^\n]*)/i);
  if (m) {
    const horas = m[3].match(HORA_RANGO);
    return { cajon: m[1], nombre: m[2].trim(), horaDesde: horas ? horas[1] : null, horaHasta: horas ? horas[2].replace('-',':') : null, marca: m[4].trim() || null, placas: m[5].trim() || null };
  }
  // Sin marca/placas
  const m2 = texto.match(/caj[oó]n\s+(\d+)\s*\n([^\n]+?)\s+(\d{1,2}:\d{2}[-–]\d{1,2}[:\-]\d{2})/i);
  if (m2) {
    const horas = m2[3].match(HORA_RANGO);
    return { cajon: m2[1], nombre: m2[2].trim(), horaDesde: horas ? horas[1] : null, horaHasta: horas ? horas[2].replace('-',':') : null, marca: null, placas: null };
  }
  return null;
}

// Parser desconexión ayudante: "44 libre" / "44 libre Tania" / "Cajón 44 libre"
function parsearAyudanteLibre(texto) {
  const m = texto.match(/(?:caj[oó]n\s+)?(\d+)\s+libre/i);
  if (m) return { cajon: m[1] };
  return null;
}

module.exports = { detectarSolicitud, parsearComandoAdmin, parsearReporteMatutino, esReporteMatutino, prefiltroCargador, parsearAyudanteConexion, parsearAyudanteLibre };
