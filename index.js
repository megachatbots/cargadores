// index.js — Bot Cargadores Eléctricos (Fase 2)
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = require('crypto').webcrypto;
}

const http = require('http');
const QRCode = require('qrcode');
const pino = require('pino');

const db    = require('./src/db_cargadores');
const motor = require('./src/motor_cargadores');
const timers = require('./src/timers');

const GRUPO_ELECTRICOS   = process.env.GRUPO_ELECTRICOS    || 'Eléctricos';
const GRUPO_PROYECTO_BOT = process.env.GRUPO_PROYECTO_BOT  || 'Proyecto Bot';
const PORT               = parseInt(process.env.PORT || '3000');
const ADMIN_IDS          = (process.env.ADMIN_IDS || '147699831668775,218643967254543,130795377307849')
  .split(',').map(function(s) { return s.trim(); }).filter(Boolean);

let ID_ELECTRICOS   = null;
let ID_PROYECTO_BOT = null;
let qrActual        = null;
let conectado       = false;
let sockRef         = null;
let makeWASocket, useMultiFileAuthState, DisconnectReason;

// LOGGING
process.on('uncaughtException',  function(e) { console.error('[UNCAUGHT]', e); });
process.on('unhandledRejection', function(e) { console.error('[UNHANDLED]', e); });

// SERVIDOR WEB
const server = http.createServer(async function(req, res) {
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
server.listen(PORT, '0.0.0.0', function() { console.log('[WEB] Puerto ' + PORT); });

// ENVIO
async function enviar(chat, texto) {
  try { await sockRef.sendMessage(chat, { text: texto }); }
  catch (e) { console.log('[enviar]', e.message); }
}

async function enviarProyectoBot(texto) {
  if (!ID_PROYECTO_BOT) { console.log('[enviarProyectoBot] ID no disponible'); return; }
  await enviar(ID_PROYECTO_BOT, texto);
}

async function enviarElectricos(texto, mencionNumero) {
  if (!ID_ELECTRICOS) { console.log('[enviarElectricos] ID no disponible'); return; }
  if (mencionNumero) {
    const jid = mencionNumero.includes('@') ? mencionNumero : mencionNumero + '@s.whatsapp.net';
    try {
      await sockRef.sendMessage(ID_ELECTRICOS, { text: texto, mentions: [jid] });
      return;
    } catch (e) { console.log('[enviarElectricos]', e.message); }
  }
  await enviar(ID_ELECTRICOS, texto);
}

// HELPERS para buscar cajones (cargadores es ahora un objeto keyed por cajon)
function _buscarCajonPorNombre(cargadores, nombre) {
  for (const cajon in cargadores) {
    const c = cargadores[cajon];
    if (c.timer_conexion && c.timer_conexion.activo && c.usuario_actual === nombre) return c;
  }
  return null;
}

function _buscarCajonConTimerConexion(cargadores) {
  for (const cajon in cargadores) {
    const c = cargadores[cajon];
    if (c.timer_conexion && c.timer_conexion.activo) return c;
  }
  return null;
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
    await db.setPendiente({ tipo: 'asignar_turno', cargador_id: libre.cajon, nombre: nombreFrom, numero: numeroFrom });
  }
  await enviarProyectoBot(msgAdmin);
  // Bot responde al usuario en Eléctricos
  await enviarElectricos('@' + numeroFrom + ' Buen día, quedaste anotado en la lista de espera 👍', numeroFrom);
  console.log('[ELÉCTRICOS] Solicitud de ' + nombreFrom + ' — posición ' + pos);
}

// FLUJO: CARGADOR LIBRE
async function procesarCargadorLibre() {
  const siguiente = db.primeroEnFila();
  if (!siguiente) { await enviarProyectoBot('✅ Cargador libre pero la fila está vacía.'); return; }
  const libre = db.cargadorLibre();
  if (!libre)     { await enviarProyectoBot('⚠️ No hay cajones libres disponibles.'); return; }

  await db.setPendiente({ tipo: 'asignar_turno', cargador_id: libre.cajon, nombre: siguiente.nombre, numero: siguiente.numero });
  await enviarProyectoBot(
    '⚡ Le toca a *' + siguiente.nombre + '*\n' +
    'Cajón: ' + libre.cajon + '\n\n' +
    '¿Confirmas? Responde *sí*\n\n' +
    '📋 *Copiar a "Eléctricos":*\n' +
    siguiente.nombre + ', es tu turno. Tienes 15 minutos para conectarte al cajón ' + libre.cajon + '.'
  );
}

// FLUJO: CONFIRMAR
async function procesarConfirmar() {
  const pendiente = db.getPendiente();
  if (!pendiente) { await enviarProyectoBot('ℹ️ No hay pregunta pendiente que confirmar.'); return; }

  if (pendiente.tipo === 'asignar_turno') {
    await db.setPendiente(null);
    await timers.iniciarTimerConexion(pendiente.cargador_id, pendiente.nombre, pendiente.numero);
    const finTimer = new Date(Date.now() + 15 * 60 * 1000)
      .toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' });
    await enviarProyectoBot(
      '✅ *Turno asignado a ' + pendiente.nombre + '*\n' +
      'Cajón: ' + pendiente.cargador_id + '\n' +
      '⏰ Tiene hasta las ' + finTimer + ' para conectarse\n\n' +
      '📋 *Copiar a "Eléctricos":*\n' +
      pendiente.nombre + ', es tu turno. Tienes 15 minutos para conectarte al cajón ' + pendiente.cargador_id + '.\n\n' +
      '📋 *Copiar al ayudante:*\n' +
      pendiente.nombre + ' va a conectar en cajón ' + pendiente.cargador_id + '.'
    );
    return;
  }
  if (pendiente.tipo === 'conexion_vencida') {
    await procesarUsuarioConecto(pendiente.nombre, pendiente.cargador_id);
    return;
  }
}

// FLUJO: USUARIO CONECTÓ
async function procesarUsuarioConecto(nombre, cajonHint) {
  await db.setPendiente(null);
  const estado = db.getEstado();

  let cargador = _buscarCajonPorNombre(estado.cargadores, nombre);
  if (!cargador && cajonHint) cargador = estado.cargadores[String(cajonHint)];
  if (!cargador) cargador = _buscarCajonConTimerConexion(estado.cargadores);
  if (!cargador) { await enviarProyectoBot('⚠️ No encontré turno activo para "' + nombre + '". Verifica con *estado*.'); return; }

  timers.cancelarTimerConexion(cargador.cajon);
  const c = await db.confirmarConexion(cargador.cajon);
  await timers.iniciarTimerSesion(cargador.cajon);

  const msSesion  = c.vip ? db.MS_SESION_VIP : db.MS_SESION;
  const finSesion = new Date(Date.now() + msSesion)
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

  await enviarProyectoBot('✅ *' + nombre + ' conectado*\nCajón: ' + cargador.cajon + ' | Termina a las: ' + finSesion + msgFila);
}

// FLUJO: USUARIO PERDIÓ TURNO
async function procesarUsuarioPerdio(nombre) {
  await db.setPendiente(null);
  const estado = db.getEstado();

  let cargador = _buscarCajonPorNombre(estado.cargadores, nombre);
  if (!cargador) cargador = _buscarCajonConTimerConexion(estado.cargadores);
  if (!cargador) { await enviarProyectoBot('⚠️ No encontré turno activo para "' + nombre + '".'); return; }

  const numActual = cargador.numero_actual;
  timers.cancelarTimerConexion(cargador.cajon);
  await db.liberarCajon(cargador.cajon);
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
      await db.setPendiente({ tipo: 'asignar_turno', cargador_id: libreAhora.cajon, nombre: siguiente.nombre, numero: siguiente.numero });
    }
  }
  await enviarProyectoBot(msg);
}

// FLUJO: ESPERAR
async function procesarEsperar() {
  await db.setPendiente(null);
  const estado   = db.getEstado();
  const cargador = _buscarCajonConTimerConexion(estado.cargadores);
  if (!cargador) { await enviarProyectoBot('⚠️ No hay timer de conexión activo para extender.'); return; }

  await timers.extenderTimerConexion(cargador.cajon);
  const finTimer = new Date(Date.now() + 15 * 60 * 1000)
    .toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' });
  await enviarProyectoBot('⏳ *Extendido 15 min para ' + cargador.usuario_actual + '*\nNuevo límite: ' + finTimer);
}

// FLUJO: ESTADO INICIAL (reporte matutino copiado por admin)
async function procesarEstadoInicial(texto) {
  const items = motor.parsearReporteMatutino(texto);
  if (!items || !items.length) {
    await enviarProyectoBot('❌ No pude interpretar el reporte. Verifica el formato:\nCajón 41\nNombre 9:30-12:30\nMarca\nPlacas');
    return;
  }
  const resultado = await db.cargarEstadoInicial(items);

  let resumen = '🌅 *Estado inicial cargado*\n\n';
  for (const item of items) {
    if (item.ocupado) {
      resumen += '🔴 Cajón ' + item.cajon + ': ' + item.nombre;
      if (item.horaInicio) resumen += ' (desde ' + item.horaInicio + ')';
      resumen += '\n';
    } else {
      resumen += '🟢 Cajón ' + item.cajon + ': Libre\n';
    }
  }
  if (resultado && resultado.sacados > 0) {
    resumen += '\n✂️ ' + resultado.sacados + ' persona(s) quitada(s) de la fila por ya estar conectadas.\n';
  }
  resumen += '\n' + db.resumenCargadores();
  await enviarProyectoBot(resumen);

  // Reactivar timers para los cajones con sesión activa
  const estado = db.getEstado();
  for (const cajon in estado.cargadores) {
    const c = estado.cargadores[cajon];
    if (c.timer_sesion && c.timer_sesion.activo) {
      await timers.reactivarTimerSesionCajon(cajon);
    }
  }
}

// PROCESAR GRUPO ELÉCTRICOS
async function procesarElectricos(texto, numeroFrom, nombreFrom) {
  // Ignorar mensajes de admins en Eléctricos
  if (ADMIN_IDS.includes(numeroFrom)) return;
  const r = await motor.detectarSolicitud(texto, nombreFrom);
  if (!r.es_solicitud) return;
  await procesarSolicitud(nombreFrom, numeroFrom);
}

// PROCESAR GRUPO PROYECTO BOT
async function procesarProyectoBot(texto, numeroFrom, nombreFrom) {
  if (!ADMIN_IDS.includes(numeroFrom)) return;

  const tl = texto.toLowerCase().trim();

  // Comandos directos sin AI
  if (tl === 'reiniciar estado') {
    await db.reiniciar();
    await enviarProyectoBot('🔄 Estado reiniciado. Todos los cajones libres y fila vacía.');
    return;
  }

  // Detectar reporte matutino pegado por el admin
  if (motor.esReporteMatutino(texto)) {
    await procesarEstadoInicial(texto);
    return;
  }

  // Comandos via AI
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
      const u   = est.fila.find(function(x) { return x.nombre.toLowerCase().includes(r.nombre.toLowerCase()); });
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
        '• Pegar reporte matutino → carga estado inicial\n' +
        '• *cargador libre* — hay cajón disponible\n' +
        '• *[Nombre] conectó* — confirmar conexión\n' +
        '• *[Nombre] no llegó* — perdió su turno\n' +
        '• *esperar* — dar 15 min más\n' +
        '• *sí* — confirmar pregunta pendiente\n' +
        '• *fila* — ver lista de espera\n' +
        '• *estado* — ver cajones y fila\n' +
        '• *quitar a [Nombre]* — sacar de la fila\n' +
        '• *reiniciar estado* — borrar todo y empezar de cero'
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
  const sock = makeWASocket({ version: waVersion, auth: state, logger: pino({ level: 'silent' }), browser: ['Mac OS', 'Safari', '10.15.7'] });
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
    if (payload.type !== 'notify') return;
    for (const msg of payload.messages) {
      if (msg.key.fromMe || !msg.message) continue;
      const chat       = msg.key.remoteJid;
      const esGrupo    = chat.endsWith('@g.us');
      const numeroFrom = (msg.key.participant || msg.key.remoteJid).replace('@s.whatsapp.net', '').replace('@lid', '');
      const texto      = (msg.message.conversation || (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) || '');
      if (!texto.trim()) continue;
      const nombreFrom = msg.pushName || numeroFrom;
      const canal      = esGrupo ? (chat === ID_ELECTRICOS ? 'ELÉCTRICOS' : chat === ID_PROYECTO_BOT ? 'PROYECTO BOT' : 'OTRO') : 'PRIV';
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

// REINICIO AUTOMÁTICO A MEDIANOCHE HORA MÉXICO
function programarReinicioNocturno() {
  const ahora = new Date();
  // Calcular siguiente medianoche en México (UTC-6)
  const ahoraMex = new Date(ahora.toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
  const manana = new Date(ahoraMex);
  manana.setDate(manana.getDate() + 1);
  manana.setHours(0, 0, 0, 0);
  const offset = ahora.getTime() - ahoraMex.getTime();
  const medianoche = new Date(manana.getTime() + offset);
  const msHastaMedianoche = medianoche.getTime() - ahora.getTime();

  console.log('[reinicio] Próximo reinicio nocturno en ' + Math.round(msHastaMedianoche / 60000) + ' minutos');

  setTimeout(async function() {
    console.log('[reinicio] Ejecutando reinicio nocturno...');
    try {
      // Cancelar todos los timers activos
      const estado = db.getEstado();
      for (const cajon in estado.cargadores) {
        timers.cancelarTimerConexion(cajon);
        timers.cancelarTimerSesion(cajon);
      }
      await db.reiniciarTodo();
      await enviarProyectoBot('🌙 Reinicio automático de medianoche completado. Sistema listo para el nuevo día.');
      console.log('[reinicio] Reinicio nocturno completado');
    } catch (e) {
      console.error('[reinicio] Error en reinicio nocturno:', e.message);
    }
    // Programar el siguiente
    programarReinicioNocturno();
  }, msHastaMedianoche);
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
    programarReinicioNocturno();
    await iniciarBot();
  } catch (e) { console.error('[ARRANQUE] ERROR FATAL:', e); }
}
arrancar();
