// index.js — Bot Cargadores Eléctricos (Fase 1)
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = require('crypto').webcrypto;
}

const fs = require('fs');
const http = require('http');
const QRCode = require('qrcode');
const pino = require('pino');

const db = require('./src/db');
const motor = require('./src/motor');

const GRUPO_ELECTRICOS    = process.env.GRUPO_ELECTRICOS    || 'Eléctricos';
const GRUPO_CONTROL       = process.env.GRUPO_CONTROL       || 'Control de Cargadores 🚗';
const PORT                = parseInt(process.env.PORT || '3001');
const ADMIN_IDS = (process.env.ADMIN_IDS || '525579737436,525579325672')
  .split(',').map(s => s.trim()).filter(Boolean);

let ID_ELECTRICOS = null;
let ID_CONTROL    = null;
let qrActual      = null;
let conectado     = false;
let sockRef       = null;

let makeWASocket, useMultiFileAuthState, DisconnectReason;

// ─── LOGGING ──────────────────────────────────────────────────────────
const _log = console.log.bind(console);
console.log = (...args) => {
  const l = args.join(' ');
  _log(l);
  if (/\[MSG\]|\[ARRANQUE\]|\[BAILEYS\]|ERROR|UNCAUGHT/.test(l)) {
    db.pgLog(l).catch(() => {});
  }
};
const _err = console.error.bind(console);
console.error = (...args) => { const l = args.join(' '); _err(l); db.pgLog('[ERROR] ' + l).catch(() => {}); };

process.on('uncaughtException',  e => console.error('[UNCAUGHT]', e));
process.on('unhandledRejection', e => console.error('[UNHANDLED]', e));

// ─── SERVIDOR WEB (QR) ────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.url === '/qr') {
    if (conectado) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<body style="font-family:sans-serif;text-align:center;padding:40px"><h2 style="color:green">✅ Bot conectado</h2></body>`);
    }
    if (qrActual) {
      const dataURL = await QRCode.toDataURL(qrActual, { width: 300, margin: 2 });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<body style="font-family:sans-serif;text-align:center;padding:40px;background:#f5f5f5"><h2>🔌 Bot Cargadores — Conectar WhatsApp</h2><img src="${dataURL}" style="border:4px solid #333;border-radius:8px;margin:20px"/><script>setTimeout(()=>location.reload(),20000)</script></body>`);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<body style="font-family:sans-serif;text-align:center;padding:40px"><h2>⏳ Iniciando…</h2><script>setTimeout(()=>location.reload(),5000)</script></body>`);
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: conectado ? 'connected' : 'waiting_qr' }));
});
server.listen(PORT, '0.0.0.0', () => console.log(`🌐 Web en puerto ${PORT}`));

// ─── ENVÍO ────────────────────────────────────────────────────────────
async function enviar(chat, texto) {
  try { await sockRef.sendMessage(chat, { text: texto }); }
  catch (e) { console.log('[enviar]', e.message); }
}

async function avisarAdmin(texto) {
  for (const id of ADMIN_IDS) {
    const jid = id.includes('@') ? id : `${id}@s.whatsapp.net`;
    await enviar(jid, texto);
  }
}

// ─── PROCESAR GRUPO ELÉCTRICOS ────────────────────────────────────────
async function procesarElectricos(texto, numeroFrom, nombreFrom) {
  // Solo escucha — el bot es completamente silencioso en este grupo
  const r = await motor.detectarSolicitud(texto, nombreFrom);
  if (!r.es_solicitud) return;

  // Agregar a la fila
  const res = await db.agregarFila(numeroFrom, nombreFrom);
  if (res.yaEsta) {
    // Ya estaba — notificar al admin pero no hacer nada más
    await avisarAdmin(`ℹ️ *${nombreFrom}* volvió a pedir lugar pero ya está en la fila (posición ${res.posicion})\nMensaje: "${texto.substring(0, 80)}"`);
    return;
  }

  // Notificar al admin con contexto
  await avisarAdmin(
    `📋 *Nueva solicitud*\n` +
    `👤 ${nombreFrom} (${numeroFrom})\n` +
    `📍 Posición en fila: *${res.posicion}*\n` +
    `💬 "${texto.substring(0, 100)}"\n\n` +
    `Usa *lista* para ver la fila completa.`
  );
  console.log(`[MSG][ELÉCTRICOS] Solicitud de ${nombreFrom} — posición ${res.posicion}`);
}

// ─── PROCESAR GRUPO CONTROL DE CARGADORES ─────────────────────────────
async function procesarControl(texto, numeroFrom, nombreFrom) {
  const r = motor.parsearAyudante(texto);
  if (!r) return; // mensaje no reconocido — silencio

  if (r.tipo === 'reporte_matutino') {
    const res = await db.cargarReporteMatutino(r.items);
    await avisarAdmin(
      `🌅 *Reporte matutino cargado*\n` +
      `${res.procesados} cajones actualizados\n\n` +
      db.resumenCargadores()
    );
    console.log(`[MSG][CONTROL] Reporte matutino — ${res.procesados} cajones`);
    return;
  }

  if (r.tipo === 'conexion') {
    const res = await db.conectar(r.cajon, r.nombre, r.marca, r.placas);
    if (!res.ok) {
      console.log(`[MSG][CONTROL] conectar cajón ${r.cajon}: ${res.msg}`);
      return;
    }
    const hasta = res.hasta.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' });
    await avisarAdmin(
      `✅ *Cajón ${r.cajon} ocupado*\n` +
      `👤 ${r.nombre}\n` +
      `⏰ Hasta las ${hasta}` +
      (r.placas ? `\n🚗 ${r.placas}` : '')
    );
    console.log(`[MSG][CONTROL] Cajón ${r.cajon} conectado — ${r.nombre}`);
    return;
  }

  if (r.tipo === 'libre') {
    const res = await db.liberar(r.cajon);
    if (!res.ok) { console.log(`[MSG][CONTROL] liberar ${r.cajon}: ${res.msg}`); return; }
    const quien = res.nombre ? ` (antes: ${res.nombre})` : '';
    await avisarAdmin(`🔓 *Cajón ${r.cajon} libre*${quien}`);
    console.log(`[MSG][CONTROL] Cajón ${r.cajon} liberado`);
    return;
  }

  if (r.tipo === 'falla') {
    const res = await db.marcarFalla(r.cajon);
    if (!res.ok) return;
    await avisarAdmin(`⚠️ *Cajón ${r.cajon} en FALLA* — reportado por ${nombreFrom}`);
    console.log(`[MSG][CONTROL] Cajón ${r.cajon} en falla`);
    return;
  }

  if (r.tipo === 'bloqueo') {
    const res = await db.bloquear(r.cajon);
    if (!res.ok) return;
    await avisarAdmin(`⛔ *Cajón ${r.cajon} bloqueado*`);
    return;
  }
}

// ─── PROCESAR PRIVADO (panel admin) ───────────────────────────────────
async function procesarPrivado(chat, texto, numeroFrom) {
  const tl = texto.toLowerCase().trim();

  if (tl === 'miid') {
    await enviar(chat, `Tu ID: ${numeroFrom}`);
    return;
  }

  if (!ADMIN_IDS.includes(numeroFrom)) {
    // Usuarios normales que escriben al bot directamente — también registrar solicitud
    // (algunos prefieren escribir al bot en privado)
    const r = await motor.detectarSolicitud(texto, numeroFrom);
    if (r.es_solicitud) {
      const res = await db.agregarFila(numeroFrom, r.nombre || numeroFrom);
      if (!res.yaEsta) {
        await avisarAdmin(
          `📋 *Nueva solicitud (privado)*\n` +
          `👤 ${r.nombre || numeroFrom}\n` +
          `📍 Posición: *${res.posicion}*\n` +
          `💬 "${texto.substring(0, 80)}"`
        );
      }
    }
    return; // Sin respuesta al usuario
  }

  // ── COMANDOS ADMIN ────────────────────────────────────────────────
  if (tl === 'ayuda' || tl === 'help') {
    await enviar(chat,
      `🔌 *Panel Admin — Cargadores*\n\n` +
      `• *lista* — fila de espera\n` +
      `• *cargadores* — estado de los 8 cajones\n` +
      `• *estado* — resumen completo\n` +
      `• *quitar [número]* — sacar a alguien de la fila\n` +
      `• *conectar [nombre] cajón [N]* — registrar conexión manual\n` +
      `• *liberar cajón [N]* — liberar cajón manualmente\n` +
      `• *bloquear cajón [N]* — bloquear por mantenimiento\n` +
      `• *falla cajón [N]* — marcar falla\n` +
      `• *ayuda* — este menú`
    );
    return;
  }

  if (tl === 'lista') { await enviar(chat, db.resumenFila()); return; }
  if (tl === 'cargadores') { await enviar(chat, db.resumenCargadores()); return; }
  if (tl === 'estado') { await enviar(chat, db.snapshotTexto()); return; }

  if (tl.startsWith('quitar ')) {
    const numero = texto.split(/\s+/)[1].replace(/[^0-9]/g, '');
    const r = await db.quitarFila(numero);
    await enviar(chat, r.ok ? `✅ ${r.nombre} quitado de la fila` : `❌ ${r.msg}`);
    return;
  }

  if (tl.startsWith('conectar ')) {
    // "conectar Tania cajón 44" o "conectar Tania cajon 44"
    const m = texto.match(/conectar\s+(.+?)\s+caj[oó]n\s+(\d+)/i);
    if (!m) { await enviar(chat, '❌ Formato: conectar Nombre cajón N'); return; }
    const r = await db.conectar(m[2], m[1].trim(), null, null);
    if (r.ok) {
      const hasta = r.hasta.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' });
      await enviar(chat, `✅ Cajón ${r.cajon}: ${r.nombre} hasta ${hasta}`);
    } else {
      await enviar(chat, `❌ ${r.msg}`);
    }
    return;
  }

  if (tl.startsWith('liberar ')) {
    const m = texto.match(/liberar\s+caj[oó]n\s+(\d+)/i);
    if (!m) { await enviar(chat, '❌ Formato: liberar cajón N'); return; }
    const r = await db.liberar(m[1]);
    await enviar(chat, r.ok ? `✅ Cajón ${r.cajon} liberado` : `❌ ${r.msg}`);
    return;
  }

  if (tl.startsWith('bloquear ')) {
    const m = texto.match(/bloquear\s+caj[oó]n\s+(\d+)/i);
    if (!m) { await enviar(chat, '❌ Formato: bloquear cajón N'); return; }
    const r = await db.bloquear(m[1]);
    await enviar(chat, r.ok ? `⛔ Cajón ${r.cajon} bloqueado` : `❌ ${r.msg}`);
    return;
  }

  if (tl.startsWith('falla ')) {
    const m = texto.match(/falla\s+caj[oó]n\s+(\d+)/i);
    if (!m) { await enviar(chat, '❌ Formato: falla cajón N'); return; }
    const r = await db.marcarFalla(m[1]);
    await enviar(chat, r.ok ? `⚠️ Cajón ${r.cajon} marcado en falla` : `❌ ${r.msg}`);
    return;
  }

  await enviar(chat, 'No reconocí el comando. Escribe *ayuda*.');
}

// ─── BAILEYS ──────────────────────────────────────────────────────────
async function iniciarBot() {
  console.log('[BAILEYS] Iniciando autenticación...');
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const waVersion = [2, 3000, 1040125391];
  const sock = makeWASocket({
    version: waVersion,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['Mac OS', 'Safari', '10.15.7']
  });
  sockRef = sock;

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) { qrActual = qr; conectado = false; console.log('[BAILEYS] QR generado — abre /qr'); }
    if (connection === 'close') {
      conectado = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log('[BAILEYS] Cerrado. Código:', code);
      setTimeout(iniciarBot, code === DisconnectReason.loggedOut ? 5000 : 15000);
    }
    if (connection === 'open') {
      conectado = true; qrActual = null;
      console.log('✅ Bot conectado');
      setTimeout(() => detectarGrupos(sock), 2000);
    }
  });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe || !msg.message) continue;
      const chat = msg.key.remoteJid;
      const esGrupo = chat.endsWith('@g.us');
      const numeroFrom = (msg.key.participant || msg.key.remoteJid)
        .replace('@s.whatsapp.net', '').replace('@lid', '');
      const texto = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
      if (!texto.trim()) continue;

      // Nombre display del remitente
      const nombreFrom = msg.pushName || numeroFrom;

      console.log(`[MSG][${esGrupo ? chat === ID_ELECTRICOS ? 'ELÉCTRICOS' : chat === ID_CONTROL ? 'CONTROL' : 'OTRO_GRUPO' : 'PRIV'}] ${nombreFrom}: ${texto.substring(0, 60)}`);

      try {
        if (esGrupo) {
          if (chat === ID_ELECTRICOS) await procesarElectricos(texto, numeroFrom, nombreFrom);
          else if (chat === ID_CONTROL) await procesarControl(texto, numeroFrom, nombreFrom);
          // Otros grupos: ignorar
        } else {
          await procesarPrivado(chat, texto, numeroFrom);
        }
      } catch (e) { console.log('[procesar]', e.message); }
    }
  });

  sock.ev.on('groups.update', async () => { await detectarGrupos(sock); });
}

async function detectarGrupos(sock) {
  try {
    const grupos = await sock.groupFetchAllParticipating();
    for (const [id, info] of Object.entries(grupos)) {
      if (info.subject === GRUPO_ELECTRICOS) { ID_ELECTRICOS = id; console.log(`✅ Grupo Eléctricos → ${id}`); }
      if (info.subject === GRUPO_CONTROL)    { ID_CONTROL = id;    console.log(`✅ Grupo Control → ${id}`); }
    }
    if (!ID_ELECTRICOS) console.log(`⚠️ Grupo "${GRUPO_ELECTRICOS}" no encontrado`);
    if (!ID_CONTROL)    console.log(`⚠️ Grupo "${GRUPO_CONTROL}" no encontrado`);
  } catch (e) { console.log('[detectarGrupos]', e.message); }
}

// ─── ARRANQUE ─────────────────────────────────────────────────────────
async function arrancar() {
  console.log('🔌 Iniciando Bot Cargadores Eléctricos — Fase 1...');
  try {
    const baileys = await import('@whiskeysockets/baileys');
    makeWASocket         = baileys.default || baileys.makeWASocket;
    useMultiFileAuthState = baileys.useMultiFileAuthState;
    DisconnectReason      = baileys.DisconnectReason;
    await db.inicializar();
    await iniciarBot();
  } catch (e) {
    console.error('[ARRANQUE] ERROR FATAL:', e);
  }
}
arrancar();
