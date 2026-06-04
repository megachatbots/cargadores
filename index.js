// index.js — Bot Cargadores Eléctricos (Fase 2)
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = require('crypto').webcrypto;
}

const http = require('http');
const QRCode = require('qrcode');
const pino = require('pino');

const db       = require('./src/db_cargadores');
const motor    = require('./src/motor_cargadores');
const timers   = require('./src/timers');

const GRUPO_ELECTRICOS   = process.env.GRUPO_ELECTRICOS    || 'Eléctricos';
const GRUPO_PROYECTO_BOT = process.env.GRUPO_PROYECTO_BOT  || 'Proyecto Bot';
const PORT               = parseInt(process.env.PORT || '3000');
const ADMIN_IDS          = (process.env.ADMIN_IDS || '147699831668775,218643967254543')
  .split(',').map(s => s.trim()).filter(Boolean);

let ID_ELECTRICOS   = null;
let ID_PROYECTO_BOT = null;
let qrActual        = null;
let conectado       = false;
let sockRef         = null;

let makeWASocket, useMultiFileAuthState, DisconnectReason;

// LOGGING
const _log = console.log.bind(console);
console.log = (...args) => { const l = args.join(' '); _log(l); };
const _err = console.error.bind(console);
console.error = (...args) => { const l = args.join(' '); _err(l); };

process.on('uncaughtException',  e => console.error('[UNCAUGHT]', e));
process.on('unhandledRejection', e => console.error('[UNHANDLED]', e));

// SERVIDOR WEB
const server = http.createServer(async (req, res) => {
  if (req.url === '/qr') {
    if (conectado) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<body style="font-family:sans-serif;text-align:center;padding:40px"><h2 style="color:green">Bot conectado</h2></body>');
    }
    if (qrActual) {
      const dataURL = await QRCode.toDataURL(qrActual, { width: 300, margin: 2 });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<body style="font-family:sans-serif;text-align:center;padding:40px;background:#f5f5f5"><h2>Bot Cargadores</h2><img src="' + dataURL + '" style="border:4px solid #333;border-radius:8px;margin:20px"/><script>setTimeout(()=>location.reload(),20000)</script></body>');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<body style="font-family:sans-serif;text-align:center;padding:40px"><h2>Iniciando</h2><script>setTimeout(()=>location.reload(),5000)</script></body>');
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: conectado ? 'connected' : 'waiting_qr' }));
});
server.listen(PORT, '0.0.0.0', () => console.log('[WEB] Puerto ' + PORT));

// ENVIO
async function enviar(chat, texto) {
  try { await sockRef.sendMessage(chat, { text: texto }); }
  catch (e) { console.log('[enviar]', e.message); }
}

async function enviarProyectoBot(texto) {
  if (!ID_PROYECTO_BOT) { console.log('[enviarProyectoBot] ID no disponible'); return; }
  await enviar(ID_PROYECTO_BOT, texto);
}

async function avisarAdmins(texto) {
  for (const id of ADMIN_IDS) {
    const jid = id.length > 13 ? id + '@lid' : id + '@s.whatsapp.net';
    await enviar(jid, texto);
  }
}

// FLUJO: SOLICITUD DE TURNO
async function procesarSolicitud(nombreFrom, numeroFrom) {
  const res = await db.agregarFila(numeroFrom, nombreFrom);

  if (res.yaEsta) {
    await enviarProyectoBot('ℹ️ *' + nombreFrom + '* volvió a pedir lugar — ya está en posición ' + res.posicion);
    return;
  }

  const pos    = res.posicion;
  const hrs    = db.tiempoEstimado(pos);
  const espera = hrs === 0 ? 'hay cargador disponible ahora' : '~' + hrs + 'h de espera';
  const libre  = db.cargadorLibre();

  let msgAdmin =
    '➕ *' + nombreFrom + '* se añadió a la fila\n' +
    '📍 Posición: ' + pos + ' | Fila total: ' + db.getEstado().fila.length + '\n' +
    '⏱ ' + espera + '\n\n' +
    '📋 *Copiar a "Eléctricos":*\n' +
    nombreFrom + ', quedaste anotado en posición ' + pos + '. ' +
    (hrs === 0 ? 'Hay cargador disponible.' : 'Tiempo estimado: ~' + hrs + 'h.');

  if (libre && pos === 1) {
    msgAdmin += '\n\n⚡ Hay cargador disponible ahora. ¿Asigno turno? Responde *sí*';
    await db.setPendiente({ tipo: 'asignar_turno', cargador_id: libre.id, nombre: nombreFrom, numero: numeroFrom });
  }

  await enviarProyectoBot(msgAdmin);
  console.log('[ELÉCTRICOS] Solicitud de ' + nombreFrom + ' — posición ' + pos);
}

// FLUJO: CARGADOR LIBRE
async function procesarCargadorLibre() {
  const siguiente = db.primeroEnFila();
  if (!siguiente) {
    await enviarProyectoBot('✅ Cargador libre pero la fila está vacía.');
    return;
  }
  const libre = db.cargadorLibre();
  if (!libre) {
    await enviarProyectoBot('⚠️ No hay cargadores libres disponibles.');
    return;
  }
  await db.setPendiente({ tipo: 'asignar_turno', cargador_id: libre.id, nombre: siguiente.nombre, numero: siguiente.numero });
  await enviarProyectoBot(
    '⚡ Le toca a *' + siguiente.nombre + '*\n' +
    'Cargador: ' + libre.id + '\n\n' +
    '¿Confirmas? Responde *sí*\n\n' +
    '📋 *Copiar a "Eléctricos":*\n' +
    siguiente.nombre + ', es tu turno. Tienes 15 minutos para conectarte al cargador ' + libre.id + '.'
  );
}

// FLUJO: CONFIRMAR
async function procesarConfirmar() {
  const pendiente = db.getPendiente();
  if (!pendiente) {
    await enviarProyectoBot('ℹ️ No hay pregunta pendiente que confirmar.');
    return;
  }
  if (pendiente.tipo === 'asignar_turno') {
    await db.setPendiente(null);
    await timers.iniciarTimerConexion(pendiente.cargador_id, pendiente.nombre, pendiente.numero);
    const finTimer = new Date(Date.now() + 15 * 60 * 1000)
      .toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' });
    await enviarProyectoBot(
      '✅ *Turno asignado a ' + pendiente.nombre + '*\n' +
      'Cargador: ' + pendiente.cargador_id + '\n' +
      '⏰ Tiene hasta las ' + finTimer + ' para conectarse\n\n' +
      '📋 *Copiar a "Eléctricos":*\n' +
      pendiente.nombre + ', es tu turno. Tienes 15 minutos para conectarte al cargador ' + pendiente.cargador_id + '.\n\n' +
      '📋 *Copiar al ayudante:*\n' +
      pendiente.nombre + ' va a conectar en cargador ' + pendiente.cargador_id + '.'
    );
    return;
  }
  if (pendiente.tipo === 'conexion_vencida') {
    await procesarUsuarioConecto(pendiente.nombre, pendiente.cargador_id);
    return;
  }
}

// FLUJO: USUARIO CONECTÓ
async function procesarUsuarioConecto(nombre, cargadorIdHint) {
  await db.setPendiente(null);
  const estado = db.getEstado();

  let cargador = estado.cargadores.find(function(c) {
    return c.timer_conexion && c.timer_conexion.activo && c.usuario_actual === nombre;
  });
  if (!cargador && cargadorIdHint) {
    cargador = estado.cargadores.find(function(c) { return c.id === cargadorIdHint; });
  }
  if (!cargador) {
    cargador = estado.cargadores.find(function(c) { return c.timer_conexion && c.timer_conexion.activo; });
  }
  if (!cargador) {
    await enviarProyectoBot('⚠️ No encontré turno activo para "' + nombre + '". Verifica con *estado*.');
    return;
  }

  timers.cancelarTimerConexion(cargador.id);
  await db.confirmarConexion(cargador.id);
  await timers.iniciarTimerSesion(cargador.id);

  const finSesion = new Date(Date.now() + 3 * 60 * 60 * 1000)
    .toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' });

  const filaActual = db.getEstado().fila;
  let msgFila = '';
  if (filaActual.length) {
    msgFila = '\n\n📋 *Copiar a "Eléctricos" — fila actualizada:*\n';
    filaActual.forEach(function(u, i) {
      const hrs = db.tiempoEstimado(i + 1);
      msgFila += (i + 1) + '. ' + u.nombre + ' — ' + (hrs === 0 ? 'disponible ahora' : '~' + hrs + 'h') + '\n';
    });
  }

  await enviarProyectoBot(
    '✅ *' + nombre + ' conectado*\n' +
    'Cargador: ' + cargador.id + ' | Termina a las: ' + finSesion +
    msgFila
  );
}

// FLUJO: USUARIO PERDIÓ TURNO
async function procesarUsuarioPerdio(nombre) {
  await db.setPendiente(null);
  const estado = db.getEstado();

  let cargador = estado.cargadores.find(function(c) {
    return c.timer_conexion && c.timer_conexion.activo && c.usuario_actual === nombre;
  });
  if (!cargador) {
    cargador = estado.cargadores.find(function(c) { return c.timer_conexion && c.timer_conexion.activo; });
  }
  if (!cargador) {
    await enviarProyectoBot('⚠️ No encontré turno activo para "' + nombre + '".');
    return;
  }

  const numActual = cargador.numero_actual;
  timers.cancelarTimerConexion(cargador.id);
  await db.liberarCargador(cargador.id);
  const res = await db.moverAlFinal(numActual || nombre);
  const nuevaPos = res ? res.posicion : '?';

  const siguiente = db.primeroEnFila();
  let msg =
    '❌ *' + nombre + ' perdió su turno*\n' +
    'Movido al final (posición ' + nuevaPos + ')\n\n' +
    '📋 *Copiar a "Eléctricos":*\n' +
    nombre + ', perdiste tu turno. Quedaste en posición ' + nuevaPos + ' de la fila.';

  if (siguiente) {
    const libreAhora = db.cargadorLibre();
    if (libreAhora) {
      msg += '\n\n⚡ Le toca ahora a *' + siguiente.nombre + '*. ¿Confirmas? Responde *sí*';
      await db.setPendiente({ tipo: 'asignar_turno', cargador_id: libreAhora.id, nombre: siguiente.nombre, numero: siguiente.numero });
    }
  }

  await enviarProyectoBot(msg);
}

// FLUJO: ESPERAR (extender 15 min)
async function procesarEsperar() {
  await db.setPendiente(null);
  const estado = db.getEstado();
  const cargador = estado.cargadores.find(function(c) { return c.timer_conexion && c.timer_conexion.activo; });
  if (!cargador) {
    await enviarProyectoBot('⚠️ No hay timer de conexión activo para extender.');
    return;
  }
  await timers.extenderTimerConexion(cargador.id);
  const finTimer = new Date(Date.now() + 15 * 60 * 1000)
    .toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' });
  await enviarProyectoBot(
    '⏳ *Extendido 15 min para ' + cargador.usuario_actual + '*\n' +
    'Nuevo límite: ' + finTimer
  );
}

// PROCESAR GRUPO ELÉCTRICOS
async function procesarElectricos(texto, numeroFrom, nombreFrom) {
  const r = await motor.detectarSolicitud(texto, nombreFrom);
  if (!r.es_solicitud) return;
  await procesarSolicitud(nombreFrom, numeroFrom);
}

// PROCESAR GRUPO PROYECTO BOT
async function procesarProyectoBot(texto, numeroFrom, nombreFrom) {
  if (!ADMIN_IDS.includes(numeroFrom)) return;

  const r = await motor.parsearComandoAdmin(texto, nombreFrom);
  if (!r.comando) return;

  console.log('[PROYECTO BOT] ' + nombreFrom + ': ' + r.comando + (r.nombre ? ' / ' + r.nombre : ''));

  switch (r.comando) {
    case 'cargador_libre':   await procesarCargadorLibre(); break;
    case 'usuario_conecto':  await procesarUsuarioConecto(r.nombre || '', null); break;
    case 'usuario_perdio':   await procesarUsuarioPerdio(r.nombre || ''); break;
    case 'esperar':          await procesarEsperar(); break;
    case 'confirmar':        await procesarConfirmar(); break;
    case 'ver_fila':         await enviarProyectoBot(db.resumenFila()); break;
    case 'ver_estado':       await enviarProyectoBot(db.resumenCompleto()); break;
    case 'quitar_usuario': {
      if (!r.nombre) { await enviarProyectoBot('❌ Indica el nombre. Ej: "quitar a Juan"'); return; }
      const est = db.getEstado();
      const u = est.fila.find(function(x) { return x.nombre.toLowerCase().includes(r.nombre.toLowerCase()); });
      if (!u) { await enviarProyectoBot('❌ "' + r.nombre + '" no está en la fila'); return; }
      await db.quitarFila(u.numero);
      await enviarProyectoBot('✅ ' + u.nombre + ' quitado de la fila');
      break;
    }
    default: break;
  }
}

// PROCESAR PRIVADO
async function procesarPrivado(chat, texto, numeroFrom) {
  const tl = texto.toLowerCase().trim();
  if (tl === 'miid') { await enviar(chat, 'Tu ID: ' + numeroFrom); return; }
  if (ADMIN_IDS.includes(numeroFrom)) {
    if (tl === 'estado') { await enviar(chat, db.resumenCompleto()); return; }
    if (tl === 'ayuda') {
      await enviar(chat,
        '🔌 *Comandos (en Proyecto Bot)*\n\n' +
        '• *cargador libre* — hay cargador disponible\n' +
        '• *[Nombre] conectó* — confirmar conexión\n' +
        '• *[Nombre] no llegó* — perdió su turno\n' +
        '• *esperar* — dar 15 min más\n' +
        '• *sí* — confirmar pregunta pendiente\n' +
        '• *fila* — ver lista de espera\n' +
        '• *estado* — ver cargadores y fila\n' +
        '• *quitar a [Nombre]* — sacar de la fila'
      );
      return;
    }
  }
}

// BAILEYS
async function iniciarBot() {
  console.log('[BAILEYS] Iniciando...');
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const waVersion = [2, 3000, 1040125391];
  const sock = makeWASocket({
    version: waVersion, auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['Mac OS', 'Safari', '10.15.7']
  });
  sockRef = sock;
  timers.setEnviarFn(enviarProyectoBot);

  sock.ev.on('connection.update', async function(u) {
    const { connection, lastDisconnect, qr } = u;
    if (qr) { qrActual = qr; conectado = false; console.log('[BAILEYS] QR generado'); }
    if (connection === 'close') {
      conectado = false;
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output ? lastDisconnect.error.output.statusCode : null;
      console.log('[BAILEYS] Cerrado. Código:', code);
      setTimeout(iniciarBot, code === DisconnectReason.loggedOut ? 5000 : 15000);
    }
    if (connection === 'open') {
      conectado = true; qrActual = null;
      console.log('Bot conectado');
      setTimeout(function() { detectarGrupos(sock); }, 2000);
    }
  });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async function(payload) {
    const messages = payload.messages;
    const type = payload.type;
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe || !msg.message) continue;
      const chat       = msg.key.remoteJid;
      const esGrupo    = chat.endsWith('@g.us');
      const numeroFrom = (msg.key.participant || msg.key.remoteJid)
        .replace('@s.whatsapp.net', '').replace('@lid', '');
      const texto      = (msg.message.conversation || (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) || '');
      if (!texto.trim()) continue;
      const nombreFrom = msg.pushName || numeroFrom;

      const canal = esGrupo ? (chat === ID_ELECTRICOS ? 'ELÉCTRICOS' : chat === ID_PROYECTO_BOT ? 'PROYECTO BOT' : 'OTRO') : 'PRIV';
      console.log('[MSG][' + canal + '] ' + nombreFrom + ': ' + texto.substring(0, 60));

      try {
        if (esGrupo) {
          if      (chat === ID_ELECTRICOS)   await procesarElectricos(texto, numeroFrom, nombreFrom);
          else if (chat === ID_PROYECTO_BOT) await procesarProyectoBot(texto, numeroFrom, nombreFrom);
        } else {
          await procesarPrivado(chat, texto, numeroFrom);
        }
      } catch (e) { console.log('[procesar]', e.message); }
    }
  });

  sock.ev.on('groups.update', async function() { await detectarGrupos(sock); });
}

async function detectarGrupos(sock) {
  try {
    const grupos = await sock.groupFetchAllParticipating();
    for (const id in grupos) {
      const info = grupos[id];
      if (info.subject === GRUPO_ELECTRICOS)   { ID_ELECTRICOS   = id; console.log('Grupo Eléctricos → ' + id); }
      if (info.subject === GRUPO_PROYECTO_BOT) { ID_PROYECTO_BOT = id; console.log('Grupo Proyecto Bot → ' + id); }
    }
    if (!ID_ELECTRICOS)   console.log('Grupo "' + GRUPO_ELECTRICOS + '" no encontrado');
    if (!ID_PROYECTO_BOT) console.log('Grupo "' + GRUPO_PROYECTO_BOT + '" no encontrado');
  } catch (e) { console.log('[detectarGrupos]', e.message); }
}

// ARRANQUE
async function arrancar() {
  console.log('Bot Cargadores Eléctricos — Fase 2');
  try {
    const baileys = await import('@whiskeysockets/baileys');
    makeWASocket          = baileys.default || baileys.makeWASocket;
    useMultiFileAuthState = baileys.useMultiFileAuthState;
    DisconnectReason      = baileys.DisconnectReason;
    await db.inicializar();
    await timers.reactivarTimers();
    await iniciarBot();
  } catch (e) {
    console.error('[ARRANQUE] ERROR FATAL:', e);
  }
}
arrancar();
