// src/motor_cargadores.js — AI para solicitudes + parser de comandos admin
const { promptClasificador, promptComandoAdmin } = require('./prompt_cargadores');

const API_KEY  = process.env.ANTHROPIC_API_KEY;
const MODELO   = process.env.MODELO_PARSER || 'claude-haiku-4-5-20251001';

const PROMPT_CLASIFICADOR = promptClasificador();
const PROMPT_COMANDO      = promptComandoAdmin();

// ─── LLAMADA GENÉRICA ─────────────────────────────────────────────────
async function llamarClaude(system, userContent, maxTokens = 256) {
  if (!API_KEY) throw new Error('Falta ANTHROPIC_API_KEY');
  for (let intento = 0; intento <= 3; intento++) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODELO,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: userContent }]
      })
    });
    if (resp.status === 429) {
      const espera = (intento + 1) * 8000;
      console.log(`[motor_c] 429. Esperando ${espera / 1000}s...`);
      await new Promise(r => setTimeout(r, espera));
      continue;
    }
    if (!resp.ok) { const e = await resp.text(); throw new Error(`API ${resp.status}: ${e}`); }
    const data = await resp.json();
    const txt = data.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const limpio = txt.replace(/```json|```/g, '').trim();
    const f = limpio.indexOf('{'), l = limpio.lastIndexOf('}');
    return JSON.parse(f !== -1 ? limpio.substring(f, l + 1) : limpio);
  }
  throw new Error('API: agotados los reintentos');
}

// ─── PRE-FILTRO LOCAL ─────────────────────────────────────────────────
function prefiltroCargador(texto) {
  const tl = texto.toLowerCase();

  // Señales negativas — descartar sin AI
  const negativo = /^(ok|gracias|de acuerdo|claro|perfecto|bajo|listo|conectad|desconectad|libero|libera|liberand|bajando|voy)/i
    .test(tl.trim());
  if (negativo) return false;

  // Señales positivas
  return /cargar|turno|lugar|fila|anot|apunt|anex|agrega|cargador|espera|quiero|necesito|disponib|hay lugar|también|tambi[eé]n/i
    .test(tl);
}

// Detecta si un mensaje del grupo Eléctricos es solicitud de turno
async function detectarSolicitud(texto, nombreRemitente) {
  if (!prefiltroCargador(texto)) return { es_solicitud: false };
  try {
    return await llamarClaude(PROMPT_CLASIFICADOR, `Remitente: ${nombreRemitente}\nMensaje: "${texto}"`);
  } catch (e) {
    console.log('[motor_c] detectarSolicitud error:', e.message);
    return { es_solicitud: false };
  }
}

// Parsea un comando del admin en "Proyecto Bot"
async function parsearComandoAdmin(texto, nombreRemitente) {
  try {
    return await llamarClaude(PROMPT_COMANDO, `Admin: ${nombreRemitente}\nMensaje: "${texto}"`);
  } catch (e) {
    console.log('[motor_c] parsearComandoAdmin error:', e.message);
    return { comando: null, nombre: null };
  }
}

module.exports = { detectarSolicitud, parsearComandoAdmin, prefiltroCargador };
