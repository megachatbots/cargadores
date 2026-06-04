// src/motor.js — Detección de solicitudes (AI) + parser de ayudante (regex)
const { construirPrompt } = require('./prompt');

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODELO = process.env.MODELO_PARSER || 'claude-haiku-4-5-20251001';
const SYSTEM_PROMPT = construirPrompt();

// ─── LLAMADA A API ────────────────────────────────────────────────────
async function llamarClaude(userContent) {
  if (!API_KEY) throw new Error('Falta ANTHROPIC_API_KEY');
  const MAX_REINTENTOS = 3;
  for (let intento = 0; intento <= MAX_REINTENTOS; intento++) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODELO,
        max_tokens: 256,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }]
      })
    });
    if (resp.status === 429) {
      const espera = (intento + 1) * 8000;
      console.log(`[motor] 429 rate limit. Esperando ${espera / 1000}s...`);
      await new Promise(r => setTimeout(r, espera));
      continue;
    }
    if (!resp.ok) { const err = await resp.text(); throw new Error(`API ${resp.status}: ${err}`); }
    const data = await resp.json();
    const txt = data.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const limpio = txt.replace(/```json|```/g, '').trim();
    const f = limpio.indexOf('{'), l = limpio.lastIndexOf('}');
    return JSON.parse(f !== -1 ? limpio.substring(f, l + 1) : limpio);
  }
  throw new Error('API: agotados los reintentos');
}

// ─── PRE-FILTRO LOCAL (sin costo) ─────────────────────────────────────
// Descarta mensajes que claramente no son solicitudes
function preFiltraSolicitud(texto) {
  const tl = texto.toLowerCase();
  // Señales positivas — pasar a la AI
  const positivo = [
    /ano[t|]|apun[t|]|anex[a|]|agrega|lista|lugar|disponib|cargador|hay lugar|tienen lugar/i,
    /me pueden|me podr[ií]an|me pueden considerar/i,
    /buenos d[ií]as.{0,40}(list|anot|apunt)/i,
    /hola.{0,30}(list|anot|apunt)/i,
    /tambi[eé]n.{0,20}(por favor|porfa|pf|plis)/i,
    /a mi tambi[eé]n/i
  ].some(r => r.test(tl));

  // Señales negativas — descartar sin AI
  const negativo = [
    /^(ok|gracias|de acuerdo|claro|perfecto|voy|bajo|listo|conectad|desconectad|libero|libera|liberand)/i,
    /^(buen fin|buena tarde|buenas noches|hasta luego)/i
  ].some(r => r.test(tl.trim()));

  if (negativo) return false;
  return positivo;
}

// Detecta si un mensaje del grupo Eléctricos es solicitud de lugar
// Devuelve { es_solicitud, nombre } o { es_solicitud: false }
async function detectarSolicitud(texto, nombreRemitente) {
  if (!preFiltraSolicitud(texto)) return { es_solicitud: false };
  try {
    return await llamarClaude(`Remitente: ${nombreRemitente}\nMensaje: "${texto}"`);
  } catch (e) {
    console.log('[motor] detectarSolicitud error:', e.message);
    return { es_solicitud: false, _error: e.message };
  }
}

// ─── PARSER AYUDANTE (regex, sin AI) ──────────────────────────────────
// Parsea mensajes del chat Control de Cargadores

// Formatos de conexión que manda Carlos:
// "Cajón 44\nNombre HH:MM-HH:MM\nMarca\nPlacas"
// "Cajón 44\nNombre HH:MM-H:MM\nBYD\n79G184"
// "Cajón 46\nNombre HH:MM-H-MM\nMarca\nPlacas"  ← Carlos a veces usa guión en vez de ':'
const HORA_RANGO = /(\d{1,2}:\d{2})-(\d{1,2}[:\-]\d{2})/;

function parsearConexion(texto) {
  // Patrón multi-línea: Cajón N / Nombre hora-hora / Marca / Placas
  const m = texto.match(/caj[oó]n\s+(\d+)\s*\n([^\n]+?)\s+(\d{1,2}:\d{2}-\d{1,2}[:\-]\d{2})\s*\n([^\n]*)\s*\n([^\n]*)/i);
  if (m) {
    const horas = m[3].match(HORA_RANGO);
    return {
      tipo: 'conexion',
      cajon: m[1],
      nombre: m[2].trim(),
      horaDesde: horas ? horas[1] : null,
      horaHasta: horas ? horas[2].replace('-',':') : null,
      marca: m[4].trim() || null,
      placas: m[5].trim() || null
    };
  }
  // Sin marca/placas: "Cajón 44\nNombre HH:MM-HH:MM"
  const m2 = texto.match(/caj[oó]n\s+(\d+)\s*\n([^\n]+?)\s+(\d{1,2}:\d{2}-\d{1,2}[:\-]\d{2})/i);
  if (m2) {
    const horas = m2[3].match(HORA_RANGO);
    return { tipo: 'conexion', cajon: m2[1], nombre: m2[2].trim(), horaDesde: horas ? horas[1] : null, horaHasta: horas ? horas[2].replace('-',':') : null, marca: null, placas: null };
  }
  return null;
}

// Formatos de desconexión:
// "44 libre", "44 libre Tania", "Cajón 44 libre", "41 libre se puede conectar"
function parsearDesconexion(texto) {
  const m = texto.match(/(?:caj[oó]n\s+)?(\d+)\s+libre/i);
  if (m) return { tipo: 'libre', cajon: m[1] };
  return null;
}

// "falla cajón 49", "el cargador #49 está en foco rojo", "cajón 49 no funciona"
function parsearFalla(texto) {
  const tl = texto.toLowerCase();
  const m = texto.match(/(?:caj[oó]n\s+#?|cargador\s+#?)(\d+)/i);
  if (m && /falla|foco rojo|no funciona|no carga|error|avería/i.test(tl)) {
    return { tipo: 'falla', cajon: m[1] };
  }
  return null;
}

// "bloqueado cajón 46", "cajón 46 bloqueado"
function parsearBloqueo(texto) {
  const m = texto.match(/(?:caj[oó]n\s+)?(\d+)\s+bloqueado|bloqueado\s+(?:caj[oó]n\s+)?(\d+)/i);
  if (m) return { tipo: 'bloqueo', cajon: m[1] || m[2] };
  return null;
}

// Reporte matutino: bloque con varios cajones
// Líneas como "Cajón 41\nDavid antes de las 7:00\nVolt\n33K048"
// o "Cajón 46\nLibre uso extendido"
function parsearReporteMatutino(texto) {
  // Detectar si es reporte matutino: tiene al menos 3 bloques de "Cajón N"
  const matches = texto.match(/caj[oó]n\s+\d+/gi) || [];
  if (matches.length < 3) return null;

  const items = [];
  // Dividir por "Cajón N"
  const bloques = texto.split(/(?=caj[oó]n\s+\d+)/i).filter(b => b.trim());
  for (const bloque of bloques) {
    const lineas = bloque.split(/\n/).map(l => l.trim()).filter(Boolean);
    if (!lineas.length) continue;
    const mCajon = lineas[0].match(/caj[oó]n\s+(\d+)/i);
    if (!mCajon) continue;
    const cajon = mCajon[1];
    const resto = lineas.slice(1).join(' ').toLowerCase();

    if (/libre/i.test(lineas[1] || '')) {
      items.push({ cajon, estado: 'libre' });
    } else if (/bloqueado|mantenimiento/i.test(resto)) {
      items.push({ cajon, estado: 'bloqueado' });
    } else if (lineas.length >= 2) {
      // "Nombre HH:MM-HH:MM" o "Nombre antes de las 7:00"
      const lineaNombre = lineas[1] || '';
      const mHora = lineaNombre.match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
      const nombre = lineaNombre.replace(/\s+\d{1,2}:\d{2}.*/,'').replace(/antes de.*$/i,'').trim();
      const marca = lineas[2] || null;
      const placas = lineas[3] || null;

      // Convertir hora local a ISO (aproximado — usamos fecha de hoy)
      let desdeISO = null;
      if (mHora) {
        const [h, m] = mHora[1].split(':').map(Number);
        const d = new Date();
        d.setHours(h, m, 0, 0);
        desdeISO = d.toISOString();
      }

      items.push({ cajon, estado: 'ocupado', nombre, marca, placas, desde: desdeISO });
    }
  }
  return items.length ? { tipo: 'reporte_matutino', items } : null;
}

// Punto de entrada: parsea cualquier mensaje del ayudante
function parsearAyudante(texto) {
  // Orden de prioridad: reporte matutino > conexión > desconexión > falla > bloqueo
  const rm = parsearReporteMatutino(texto);
  if (rm) return rm;

  const conn = parsearConexion(texto);
  if (conn) return conn;

  const libre = parsearDesconexion(texto);
  if (libre) return libre;

  const falla = parsearFalla(texto);
  if (falla) return falla;

  const bloqueo = parsearBloqueo(texto);
  if (bloqueo) return bloqueo;

  return null;
}

module.exports = { detectarSolicitud, parsearAyudante, preFiltraSolicitud };
