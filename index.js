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
const tiempo = require('./src/tiempo');
const control = require('./src/control').crear({
  db: db, timers: timers, tiempo: tiempo,
  enviarElectricos: function(t, m) { return enviarElectricos(t, m); },
  enviarProyectoBot: function(t) { return enviarProyectoBot(t); },
  procesarReporte: function(t) { return procesarEstadoInicial(t); },
  puedeElectricos: function() { return puedeElectricos(); },
  avisoDiferible: function(t) { return avisoDiferible(t); }
});
timers.setOnSesionCumplida(control.sesionCumplida);

const GRUPO_ELECTRICOS   = process.env.GRUPO_ELECTRICOS    || 'Eléctricos';
const GRUPO_PROYECTO_BOT = process.env.GRUPO_PROYECTO_BOT  || 'Proyecto Bot';
const GRUPO_CONTROL      = process.env.GRUPO_CONTROL       || 'Control de Cargadores 🚗';
const PORT               = parseInt(process.env.PORT || '3000');
const ADMIN_IDS          = (process.env.ADMIN_IDS || '147699831668775,218643967254543,130795377307849')
  .split(',').map(function(s) { return s.trim(); }).filter(Boolean);
// ADMIN_IDS acepta LID (15 dígitos) o teléfono; si se conoce el teléfono de un LID, también se reconoce
const admin   = require('./src/ids').crear(ADMIN_IDS);
const filaCmd = require('./src/fila_cmd').crear(db);

let ID_ELECTRICOS   = null;
let ID_PROYECTO_BOT = null;
let ID_CONTROL      = null;

// Recordatorios de desconexión activos: { nombre -> intervalHandle }
let qrActual        = null;
let conectado       = false;
let sockRef         = null;
let makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion;

const VERSION = 'etapa1c-1';
// Miembros de Eléctricos (solo a ellos se les menciona). null = aún no cargado → no se filtra.
let miembrosElectricos = null;
const _noMiembroAvisado = new Set();
function _digitos(x) { return String(x).replace(/@.*$/, '').replace(/:\d+$/, ''); }
async function refrescarMiembros() {
  if (!sockRef || !ID_ELECTRICOS) return;
  try {
    const md = await sockRef.groupMetadata(ID_ELECTRICOS);
    const s = new Set();
    (md.participants || []).forEach(function(p) { [p.id, p.lid, p.phoneNumber, p.jid].forEach(function(x) { if (x) s.add(_digitos(x)); }); });
    if (s.size) { miembrosElectricos = s; console.log('[miembros] Eléctricos: ' + s.size + ' ids'); }
  } catch (e) { console.log('[miembros] error:', e.message); }
}
// Teléfono real de quienes están en Proyecto Bot (para reconocer admins dados por teléfono cuando escriben con LID)
async function refrescarAdmins() {
  if (!sockRef || !ID_PROYECTO_BOT) return;
  try {
    const md = await sockRef.groupMetadata(ID_PROYECTO_BOT);
    admin.setParticipantes(md.participants || []);
    console.log('[admins] Proyecto Bot: ' + (md.participants || []).length + ' participantes, alias=' + Object.keys(admin._mapa).length);
  } catch (e) { console.log('[admins] error:', e.message); }
}
// Horario permitido para escribir en Eléctricos (L-V). Variable HORARIO_ELECTRICOS="7-20" para cambiarlo.
const HORARIO = (process.env.HORARIO_ELECTRICOS || '7-20').split('-').map(Number);
let silencio = false;
let _ultimoAvisoSilencio = 0;
const listaCtl = require('./src/lista').crear({
  db: db, tiempo: tiempo,
  horaCierre: HORARIO[1],   // el cierre de la lista sigue a HORARIO_ELECTRICOS (antes estaba fija en 20)
  enviarElectricos: function(t, m) { return enviarElectricos(t, m); },
  listo: function() { return !!(sockRef && ID_ELECTRICOS); }
});

// ¿Se puede escribir ahora en Eléctricos? (horario L-V y sin "silencio"). Los recordatorios se PAUSAN si no.
function dentroHorario() { return tiempo.dentroDeHorario(HORARIO[0], HORARIO[1], true); }
function puedeElectricos() { return !silencio && dentroHorario(); }
// Avisos automáticos a admins: fuera de horario se juntan y salen en un solo resumen al volver el horario (7:00)
const _diferidos = [];
async function avisoDiferible(texto) {
  if (dentroHorario()) { await enviarProyectoBot(texto); return; }
  const linea = '• [' + tiempo.fechaMex(Date.now()).slice(5) + ' ' + tiempo.horaLocal(Date.now()) + '] ' + String(texto).replace(/\n+/g, ' ');
  if (_diferidos.indexOf(linea) === -1) _diferidos.push(linea);
  while (_diferidos.length > 30) _diferidos.shift();
  console.log('[diferido] ' + linea.substring(0, 90));
}
async function vaciarDiferidos() {
  if (!_diferidos.length || !dentroHorario()) return;
  const t = _diferidos.splice(0, _diferidos.length);
  await enviarProyectoBot('🌅 *Resumen de avisos fuera de horario* (' + t.length + ')\n\n' + t.join('\n'));
}
const AUTH_DIR = process.env.AUTH_DIR || 'auth_info';
const INICIO_MS = Date.now();
let reinicioPendienteHasta = 0;
let _gruposUltimo = 0, _gruposEnCurso = false;

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
  if (req.url === '/version') {
    let resumen = null;
    try {
      const e = db.getEstado();
      const cs = Object.keys(e.cargadores || {});
      resumen = { fila: (e.fila || []).length, ocupados: cs.filter(function(k) { return e.cargadores[k].ocupado; }).length, cajones: cs.length };
    } catch (err) { resumen = { error: err.message }; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      version: VERSION,
      commit: (process.env.RAILWAY_GIT_COMMIT_SHA || 'local').substring(0, 7),
      arranque: tiempo.horaLocal(INICIO_MS),
      hora_mexico: tiempo.horaLocal(Date.now()),
      conectado: conectado,
      persistencia_db: db.persistencia(),
      silencio: silencio,
      admin_alias: Object.keys(admin._mapa).length,
      avisos_diferidos: _diferidos.length,
      lista_abierta: db.listaAbierta(),
      vip_abierto: db.vipAbierto(),
      miembros_electricos: miembrosElectricos ? miembrosElectricos.size : null,
      horario_ok: tiempo.dentroDeHorario(HORARIO[0], HORARIO[1], true),
      auth_dir: AUTH_DIR,
      grupos: { electricos: !!ID_ELECTRICOS, proyecto_bot: !!ID_PROYECTO_BOT, control: !!ID_CONTROL },
      estado: resumen
    }));
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
  // Guardas: interruptor "silencio" y horario permitido. Fuera de eso, nada sale a Eléctricos.
  const horarioOk = tiempo.dentroDeHorario(HORARIO[0], HORARIO[1], true);
  if (silencio || !horarioOk) {
    console.log('[enviarElectricos] BLOQUEADO (' + (silencio ? 'silencio' : 'fuera de horario') + '): ' + texto.substring(0, 70));
    if (!silencio && !horarioOk) { await avisoDiferible('🔕 No envié a Eléctricos (fuera de horario ' + HORARIO[0] + ':00-' + HORARIO[1] + ':00 L-V): «' + texto.substring(0, 80) + '»'); return; }
    if (Date.now() - _ultimoAvisoSilencio > 3 * 60 * 60 * 1000) {
      _ultimoAvisoSilencio = Date.now();
      await enviarProyectoBot('🔕 No envié a Eléctricos (' + (silencio ? 'modo silencio' : 'fuera de horario ' + HORARIO[0] + ':00-' + HORARIO[1] + ':00 L-V') + '). Primer mensaje bloqueado: «' + texto.substring(0, 80) + '»');
    }
    return;
  }
  // Solo se menciona a miembros de Eléctricos
  const _m = !mencionNumero ? [] : (Array.isArray(mencionNumero) ? mencionNumero : [mencionNumero]);
  if (miembrosElectricos && _m.length) {
    const fuera = _m.filter(function(n) { return !miembrosElectricos.has(_digitos(n)); });
    if (fuera.length) {
      console.log('[enviarElectricos] BLOQUEADO (no miembro): ' + fuera.join(','));
      const nuevos = fuera.filter(function(n) { return !_noMiembroAvisado.has(String(n)); });
      nuevos.forEach(function(n) { _noMiembroAvisado.add(String(n)); });
      if (nuevos.length) await enviarProyectoBot('🚫 No envié a Eléctricos: ' + nuevos.join(', ') + ' no aparece(n) en el grupo. Mensaje: «' + texto.substring(0, 80) + '»');
      return;
    }
  }
  // Siempre leer ID_ELECTRICOS en el momento de enviar (no en el momento de crear la función)
  if (!ID_ELECTRICOS) {
    console.log('[enviarElectricos] ID_ELECTRICOS no disponible — redetectando');
    if (sockRef) await detectarGrupos(sockRef);
    if (!ID_ELECTRICOS) { console.log('[enviarElectricos] Sigue sin ID, abortando'); return; }
  }
  if (!sockRef) { console.log('[enviarElectricos] sockRef no disponible'); return; }
  const menciones = !mencionNumero ? [] : (Array.isArray(mencionNumero) ? mencionNumero : [mencionNumero]);
  if (menciones.length) {
    const jids = menciones.map(function(n) { return String(n).includes('@') ? String(n) : (String(n).length > 13 ? n + '@lid' : n + '@s.whatsapp.net'); });
    try {
      await sockRef.sendMessage(ID_ELECTRICOS, { text: texto, mentions: jids });
      console.log('[enviarElectricos] Enviado con mención a ' + menciones.join(', '));
      return;
    } catch (e) { console.log('[enviarElectricos] Error con mención:', e.message); }
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
    '';

  if (libre && pos === 1) {
    msgAdmin += '\n\n⚡ Hay cargador disponible ahora. ¿Asigno turno? Responde *sí*';
    await db.setPendiente({ tipo: 'asignar_turno', cargador_id: libre.cajon, nombre: nombreFrom, numero: numeroFrom });
  }
  await enviarProyectoBot(msgAdmin);
  // Bot responde al usuario en Eléctricos
  await enviarElectricos(nombreFrom + ' @' + numeroFrom + ' Buen día, te anotamos en la lista de espera 👍', numeroFrom);
  console.log('[ELÉCTRICOS] Solicitud de ' + nombreFrom + ' — posición ' + pos);
}

// FLUJO: CARGADOR LIBRE
async function procesarCargadorLibre() {
  const siguiente = db.primeroEnFila();
  if (!siguiente) { await enviarProyectoBot('✅ Cargador libre pero la fila está vacía.'); return; }
  const libre = db.cargadorLibre();
  if (!libre)     { await enviarProyectoBot('⚠️ No hay cajones libres disponibles.'); return; }

  await db.setPendiente({ tipo: 'asignar_turno', cargador_id: libre.cajon, nombre: siguiente.nombre, numero: siguiente.numero });
  await enviarProyectoBot('⚡ Le toca a *' + siguiente.nombre + '*\n¿Confirmas? Responde *sí*');
}

// FLUJO: CONFIRMAR
async function procesarConfirmar() {
  const pendiente = db.getPendiente();
  if (!pendiente) { await enviarProyectoBot('ℹ️ No hay pregunta pendiente que confirmar.'); return; }

  if (pendiente.tipo === 'asignar_turno') {
    await db.setPendiente(null);
    await timers.iniciarTimerConexion(pendiente.cargador_id, pendiente.nombre, pendiente.numero);
    const finTimer = tiempo.horaLocal(Date.now() + 15 * 60 * 1000);
    // Avisar al usuario en Eléctricos
    const manualP = db.esManual(pendiente.numero);
    if (pendiente.numero && !manualP) {
      await enviarElectricos(pendiente.nombre + ' @' + pendiente.numero + ' es tu turno, tienes 15 minutos para conectarte 🔌', pendiente.numero);
    }
    await enviarProyectoBot('✅ *Turno asignado a ' + pendiente.nombre + '*\n⏰ Tiene hasta las ' + finTimer + ' para conectarse' + (manualP ? '\n⚠️ Anotado a mano, sin teléfono: avísale tú.' : ''));
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
  const finSesion = tiempo.horaLocal(Date.now() + msSesion);

  await enviarProyectoBot('✅ *' + nombre + ' conectado* | Termina a las: ' + finSesion);
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

  // Avisar al usuario en Eléctricos si tiene número
  const uFila = db.getEstado().fila.find(function(u) { return u.numero === numActual; });
  if (uFila && uFila.numero && !db.esManual(uFila.numero)) {
    await enviarElectricos(nombre + ' @' + uFila.numero + ' perdiste tu turno. Quedaste en posición ' + nuevaPos + ' de la lista 😔', uFila.numero);
  }

  const siguiente = db.primeroEnFila();
  let msg = '❌ *' + nombre + ' perdió su turno* — posición ' + nuevaPos;
  if (siguiente) {
    const libreAhora = db.cargadorLibre();
    if (libreAhora) {
      msg += '\n⚡ Le toca ahora a *' + siguiente.nombre + '*. ¿Confirmas? Responde *sí*';
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
  const finTimer = tiempo.horaLocal(Date.now() + 15 * 60 * 1000);
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

  // Reactivar timers y notificar vencidos
  const estado = db.getEstado();
  const vencidos = [];
  for (const cajon in estado.cargadores) {
    const c = estado.cargadores[cajon];
    if (c.timer_sesion && c.timer_sesion.activo) {
      await timers.reactivarTimerSesionCajon(cajon);
    } else if (c.timer_sesion && c.timer_sesion.vencido) {
      vencidos.push('Cajón ' + cajon + ': ' + c.usuario_actual);
    }
  }
  if (vencidos.length) {
    await enviarProyectoBot(
      '⚠️ *Sesiones ya vencidas al cargar el estado:*\n' +
      vencidos.join('\n') + '\n\nEscribe *[Nombre] se desconectó* para liberar cada cajón.'
    );
  }
}

// PROCESAR GRUPO ELÉCTRICOS
async function procesarElectricos(texto, numeroFrom, nombreFrom) {
  // Ignorar mensajes de admins en Eléctricos
  if (admin.esAdmin(numeroFrom)) return;
  if (miembrosElectricos) miembrosElectricos.add(_digitos(numeroFrom));   // quien escribe es miembro
  // Lista cerrada (antes de las 8:00, fin de semana o cerrada por admin): las solicitudes se omiten
  if (!db.listaAbierta()) { console.log('[ELÉCTRICOS] Lista cerrada: mensaje omitido (' + nombreFrom + ')'); return; }
  const r = await motor.detectarSolicitud(texto, nombreFrom);
  if (!r.es_solicitud) return;
  // No se toman en cuenta horarios especiales: la lista es del momento
  if (motor.horaEspecial(texto)) {
    await enviarElectricos('Hola ' + nombreFrom + ' @' + numeroFrom + ', la lista es del momento: escríbenos cuando estés listo para conectar 🙏', numeroFrom);
    console.log('[ELÉCTRICOS] Solicitud con horario especial NO anotada: ' + nombreFrom);
    return;
  }
  await procesarSolicitud(nombreFrom, numeroFrom);
}

// FLUJO: CONEXIÓN MANUAL [Nombre] conectó en cajón N
async function procesarConexionManual(nombre, cajon) {
  cajon = String(cajon);
  // Buscar en fila
  const candidatos = db.buscarEnFila(nombre);
  // Coincidencia exacta
  const exacto = candidatos.find(function(u) { return u.nombre.toLowerCase() === nombre.toLowerCase(); });
  if (exacto) {
    await _ejecutarConexion(cajon, exacto.nombre, exacto.numero, false);
    return;
  }
  // Un solo candidato en fila
  if (candidatos.length === 1) {
    await _ejecutarConexion(cajon, candidatos[0].nombre, candidatos[0].numero, false);
    return;
  }
  // Ambigüedad — mostrar lista
  let msg = '❓ No encontré "' + nombre + '" exactamente. ¿A quién te refieres?\n\n';
  candidatos.forEach(function(u, i) { msg += (i + 1) + '. ' + u.nombre + '\n'; });
  msg += (candidatos.length + 1) + '. No está en la fila (conectado directo)\n\n';
  msg += 'Responde con el número de la opción.';
  await db.setPendiente({ tipo: 'desambiguar_conexion', cajon, nombre, candidatos });
  await enviarProyectoBot(msg);
}

async function _ejecutarConexion(cajon, nombre, numero, esMañana) {
  const horaInicio = esMañana ? _horaISO700() : null;
  await db.conectarUsuario(cajon, nombre, numero, horaInicio);
  await timers.cancelarTimerConexion(cajon);
  await timers.iniciarTimerSesion(cajon);
  const estado = db.getEstado();
  const c = estado.cargadores[cajon];
  const msSesion = c && c.vip ? db.MS_SESION_VIP : db.MS_SESION;
  const finSesion = tiempo.horaLocal(Date.now() + msSesion);
  const filaActual = db.getEstado().fila;
  let msgFila = '';
  if (filaActual.length) {
    msgFila = '\n\n📋 *Fila actualizada:*\n';
    filaActual.forEach(function(u, i) {
      const hrs = db.tiempoEstimado(i + 1);
      msgFila += (i + 1) + '. ' + u.nombre + ' — ' + (hrs === 0 ? 'disponible ahora' : '~' + hrs + 'h') + '\n';
    });
  }
  await enviarProyectoBot('✅ *' + nombre + ' conectado en cajón ' + cajon + '*\nTermina a las: ' + finSesion + msgFila);
}

function _horaISO700() {
  return tiempo.horaStrAISO('7:00');
}

// FLUJO: DESCONEXIÓN MANUAL [Nombre] se desconectó
async function procesarDesconexionManual(nombre) {
  const c = db.buscarCajonDeUsuario(nombre);
  if (!c) {
    await enviarProyectoBot('⚠️ No encontré a "' + nombre + '" conectado en ningún cajón.');
    return;
  }
  if (c.usuario_actual) control.cancelarRecordatorio(c.usuario_actual);
  timers.cancelarTimerConexion(c.cajon);
  timers.cancelarTimerSesion(c.cajon);
  await db.liberarCajon(c.cajon);

  let msg = '✅ *' + c.usuario_actual + ' desconectado* — cajón ' + c.cajon + ' libre.';

  const siguiente = db.primeroEnFila();
  if (siguiente) {
    msg += '\n\n⚡ Le toca a *' + siguiente.nombre + '*.';
    await db.setPendiente({ tipo: 'asignar_turno', cargador_id: c.cajon, nombre: siguiente.nombre, numero: siguiente.numero });
    // Avisar en Eléctricos
    if (siguiente.numero && !db.esManual(siguiente.numero)) {
      await enviarElectricos(siguiente.nombre + ' @' + siguiente.numero + ' es tu turno, ya hay un cajón disponible 🔌', siguiente.numero);
    } else if (siguiente.numero) {
      msg += '\n⚠️ Anotado a mano, sin teléfono: avísale tú.';
    }
    msg += '\n¿Confirmas? Responde *sí*';
  }
  await enviarProyectoBot(msg);
}

// PROCESAR GRUPO PROYECTO BOT
async function procesarProyectoBot(texto, numeroFrom, nombreFrom) {
  const tl = texto.toLowerCase().trim();
  // miid también en este grupo: es el ID EXACTO con el que el bot te ve aquí (el que debe ir en ADMIN_IDS). Antes un no-admin recibía silencio.
  if (RE_MIID.test(tl)) { await enviarProyectoBot(textoMiId(numeroFrom)); return; }
  if (!admin.esAdmin(numeroFrom)) return;

  // Ayuda
  if (tl === 'ayuda') {
    await enviarProyectoBot('🔌 *Comandos disponibles*\n\n' +
        '📋 *Gestión de cajones:*\n' +
        '• Pegar reporte matutino → carga estado inicial\n' +
        '• *[Nombre] conectó en cajón N* — registrar conexión\n' +
        '• *[Nombre] se desconectó* — liberar cajón\n' +
        '• *cargador libre* — hay cajón disponible (asigna siguiente en fila)\n' +
        '• *[Nombre] conectó* — confirmar después de asignar turno\n' +
        '• *[Nombre] no llegó* — perdió su turno\n' +
        '• *esperar* — dar 15 min más\n' +
        '• *sí* — confirmar pregunta pendiente\n\n' +
        '📊 *Consultas:*\n' +
        '• *fila* — ver lista de espera\n' +
        '• *estado* — ver cajones y fila\n' +
        '• *quitar N* / *fuera N* — sacar de la fila al de la posición N\n' +
        '• *quitar a [Nombre]* / *fuera [Nombre]* — sacar por nombre (tolera faltas de ortografía)\n' +
        '• *anotar a [Nombre]* o *anotar a [Nombre] en N* — anotar a mano (N = posición; 1 = el siguiente)\n' +
        '• *mover [Nombre] a N* o *[Nombre] en N* — cambiar de posición a alguien de la fila\n' +
        '• *miid* — ver tu ID (para dar de alta admins)\n' +
        '• *abrir lista / cerrar lista* — abrir o cerrar la lista de espera (se abre sola a las 8:00 L-V)\n' +
        '• *abrir vip / cerrar vip* — cajones 46 y 50 para la fila general\n' +
        '• *N es Nombre* — decir quién ocupa el cajón N\n' +
        '• *N desde H:MM* — corregir la hora de conexión del cajón N\n' +
        '• *silencio on / off* — cortar o reanudar los mensajes a Eléctricos\n\n' +
        '⚠️ *Emergencia:*\n' +
        '• *reiniciar estado* — borrar todo y empezar de cero');
    return;
  }

  // Reiniciar
  if (tl === 'reiniciar estado') {
    reinicioPendienteHasta = Date.now() + 120000;
    await enviarProyectoBot('⚠️ Esto borra la fila y libera TODOS los cajones. Para confirmar escribe *confirmar reinicio* en los próximos 2 minutos.');
    return;
  }
  if (tl === 'confirmar reinicio') {
    if (Date.now() > reinicioPendienteHasta) { await enviarProyectoBot('No hay un reinicio pendiente. Escribe *reiniciar estado* primero.'); return; }
    reinicioPendienteHasta = 0;
    const estadoActual = db.getEstado();
    for (const cajon in estadoActual.cargadores) {
      timers.cancelarTimerConexion(cajon);
      timers.cancelarTimerSesion(cajon);
    }
    await db.reiniciar();
    await enviarProyectoBot('🔄 Estado reiniciado. Todos los cajones libres y fila vacía.');
    return;
  }

  // Lista de espera y cajones VIP
  if (tl === 'abrir lista' || tl === 'cerrar lista') {
    if (tl === 'abrir lista') {
      if (db.listaAbierta()) { await enviarProyectoBot('ℹ️ La lista ya está abierta.'); return; }
      await listaCtl.abrir();
      await enviarProyectoBot('✅ Lista abierta y mensaje de inicio enviado a Eléctricos.');
    } else {
      await listaCtl.cerrar();
      await enviarProyectoBot('🔒 Lista cerrada. Las solicitudes se omiten hasta que escribas *abrir lista* (no se reabre sola hoy).');
    }
    return;
  }
  if (tl === 'abrir vip' || tl === 'cerrar vip') {
    await db.setVip(tl === 'abrir vip');
    await enviarProyectoBot(tl === 'abrir vip'
      ? '⭐ Cajones 46 y 50 *abiertos* para la fila general (hasta medianoche o *cerrar vip*).'
      : '⭐ Cajones 46 y 50 *cerrados* para la fila general (solo MD).');
    return;
  }
  // quitar N / fuera N / quitar a X / fuera X / anotar a X [en N] / mover X a N  (búsqueda tolerante; si hay 2+ coincidencias pregunta y no actúa)
  const cmdFila = filaCmd.interpretar(texto);
  if (cmdFila && cmdFila.tipo !== 'mover_simple') {
    const respFila = await filaCmd.ejecutar(cmdFila);
    if (respFila) { await enviarProyectoBot(respFila); return; }
  }

  // Interruptor de emergencia: corta todo lo que el bot manda a Eléctricos
  if (tl === 'silencio on' || tl === 'silencio off') {
    silencio = tl === 'silencio on';
    await db.guardarSilencio(silencio);
    await enviarProyectoBot(silencio ? '🔕 *Silencio ACTIVADO*: no enviaré nada a Eléctricos hasta que escribas *silencio off*.' : '🔔 *Silencio desactivado*: vuelvo a escribir en Eléctricos (dentro del horario permitido).');
    return;
  }

  // "45 desde 1:30" — corrige la hora de conexión del ocupante de un cajón
  const mDesde = texto.trim().match(/^(\d{2})\s+desde(?:\s+las)?\s+(\d{1,2}[:.]\d{2})$/i);
  if (mDesde && db.CAJONES.indexOf(mDesde[1]) !== -1) {
    await enviarProyectoBot(await control.ajustarInicio(mDesde[1], mDesde[2]));
    return;
  }

  // "44 es Nombre Apellido" — dice quién ocupa un cajón (cuando el reporte traía marca/placas en vez de nombre)
  const mEs = texto.trim().match(/^(\d{2})\s+es\s+(.+)$/i);
  if (mEs && db.CAJONES.indexOf(mEs[1]) !== -1) {
    const cajonEs = mEs[1];
    const nombreEs = mEs[2].trim();
    const cEs = db.getEstado().cargadores[cajonEs];
    if (!cEs || !cEs.ocupado) { await enviarProyectoBot('⚠️ El cajón ' + cajonEs + ' no está ocupado.'); return; }
    const anterior = cEs.usuario_actual;
    await db.renombrarOcupante(cajonEs, nombreEs);
    await enviarProyectoBot('✅ Cajón ' + cajonEs + ': *' + nombreEs + '*' + (anterior && anterior !== nombreEs ? ' (antes «' + anterior + '»)' : '') + '.');
    return;
  }

  // Respuesta a desambiguación pendiente (número 1, 2, 3...)
  const pendiente = db.getPendiente();
  if (pendiente && pendiente.tipo === 'desambiguar_conexion' && /^\d+$/.test(tl)) {
    const opcion = parseInt(tl);
    const candidatos = pendiente.candidatos || [];
    await db.setPendiente(null);
    if (opcion === candidatos.length + 1) {
      // No está en la fila — conectar sin número
      await _ejecutarConexion(pendiente.cajon, pendiente.nombre, null, false);
    } else if (opcion >= 1 && opcion <= candidatos.length) {
      const elegido = candidatos[opcion - 1];
      await _ejecutarConexion(pendiente.cajon, elegido.nombre, elegido.numero, false);
    } else {
      await enviarProyectoBot('❌ Opción inválida.');
    }
    return;
  }

  // Lista estática directo
  if (tl === 'lista estatica' || tl === 'lista estática') {
    await enviarProyectoBot(db.resumenListaEstatica());
    return;
  }

  // Reporte matutino
  if (motor.esReporteMatutino(texto)) {
    await procesarEstadoInicial(texto);
    return;
  }

  // Detectar "[Nombre] conectó en cajón N" antes de llamar AI
  const mConectoEn = texto.match(/^(.+?)\s+conect[oó]\s+en\s+caj[oó]n\s+(\d+)/i);
  if (mConectoEn) {
    await procesarConexionManual(mConectoEn[1].trim(), mConectoEn[2]);
    return;
  }

  // Detectar "[Nombre] se desconectó" antes de llamar AI
  const mDesconecto = texto.match(/^(.+?)\s+se\s+desconect[oó]/i);
  if (mDesconecto) {
    await procesarDesconexionManual(mDesconecto[1].trim());
    return;
  }

  // "Pablo en 2": mueve a Pablo solo si está en la fila (si no, sigue como cualquier otro mensaje)
  if (cmdFila && cmdFila.tipo === 'mover_simple') {
    const respMover = await filaCmd.ejecutar(cmdFila);
    if (respMover) { await enviarProyectoBot(respMover); return; }
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
    case 'ver_fila': {
      let msgFila = db.resumenFila();
      if (db.getEstado().fila.length) msgFila += '\n\nPara quitar escribe: *quitar [número]*';
      await enviarProyectoBot(msgFila);
      break;
    }
    case 'ver_estado':       await enviarProyectoBot(db.resumenCompleto()); break;
    case 'lista_estatica':   await enviarProyectoBot(db.resumenListaEstatica()); break;
    case 'anotar_usuario': {
      if (!r.nombre) { await enviarProyectoBot('❌ Indica el nombre. Ej: "anotar a Juan"'); return; }
      await enviarProyectoBot(await filaCmd.anotar(r.nombre, null));
      break;
    }
    case 'quitar_usuario': {
      if (!r.nombre) { await enviarProyectoBot('❌ Indica el nombre. Ej: "quitar a Juan"'); return; }
      await enviarProyectoBot(await filaCmd.quitarNombre(r.nombre));
      break;
    }
    default: break;
  }
}

// PROCESAR GRUPO CONTROL DE CARGADORES
async function procesarControl(texto, numeroFrom, nombreFrom) {
  // El ayudante puede ser cualquiera en el grupo — no restringimos por ADMIN_IDS
  // Solo ignoramos mensajes del propio bot
  const tl = texto.toLowerCase().trim();

  // Ayuda — solo para admins
  if (tl === 'ayuda' && admin.esAdmin(numeroFrom)) {
    await enviar(ID_CONTROL,
      '🔌 *Comandos del ayudante*\n\n' +
      '• Pegar reporte matutino → el bot carga el estado\n' +
      '• *Cajón N\nNombre HH:MM-HH:MM\nMarca\nPlacas* → conexión\n' +
      '• *N libre* o *N libre Nombre* → desconexión'
    );
    return;
  }

  // Todo lo demás lo interpreta el módulo del ayudante (conexiones, libres, recordatorios, reportes)
  const atendido = await control.procesar(texto);
  if (!atendido) console.log('[CONTROL] Sin interpretar: ' + texto.substring(0, 60).replace(/\n/g, ' / '));
}

function _horaDesdeStr(horaStr) {
  return tiempo.horaLaboralAISO(horaStr);
}

// Texto de un mensaje de WhatsApp, incluso envuelto (mensajes temporales, ver una vez, documento con pie, imagen con pie)
function extraerTexto(m) {
  let x = m, n = 0;
  while (x && n++ < 4) {
    const w = x.ephemeralMessage || x.viewOnceMessage || x.viewOnceMessageV2 || x.documentWithCaptionMessage || x.editedMessage;
    if (!w || !w.message) break;
    x = w.message;
  }
  if (!x) return '';
  return x.conversation || (x.extendedTextMessage && x.extendedTextMessage.text) ||
    (x.imageMessage && x.imageMessage.caption) || (x.videoMessage && x.videoMessage.caption) || '';
}
const RE_MIID = /^\s*mi\s*-?\s*id\s*$/i;
function textoMiId(id) {
  const tel = admin.telefonoDe(id);
  return 'Tu ID: ' + id + (tel && tel !== String(id) ? '\nTu teléfono: ' + tel : '') + (admin.esAdmin(id) ? '\n✅ Ya eres admin' : '\nPásale este ID a quien administra el bot para darte de alta como admin.');
}

// PROCESAR PRIVADO
async function procesarPrivado(chat, texto, numeroFrom) {
  const tl = texto.toLowerCase().trim();
  if (RE_MIID.test(tl)) { await enviar(chat, textoMiId(numeroFrom)); return; }
  if (admin.esAdmin(numeroFrom)) {
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
        '• *quitar N* / *quitar a [Nombre]* — sacar de la fila\n' +
        '• *reiniciar estado* — borrar todo y empezar de cero'
      );
      return;
    }
  }
}

// BAILEYS
async function iniciarBot() {
  console.log('[BAILEYS] Iniciando... (sesión en ' + AUTH_DIR + ')');
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let waVersion = [2, 3000, 1040125391]; // respaldo si no se puede consultar la última
  try {
    if (fetchLatestBaileysVersion) {
      const r = await fetchLatestBaileysVersion();
      if (r && Array.isArray(r.version)) waVersion = r.version;
    }
  } catch (e) { console.log('[BAILEYS] No pude consultar la versión de WhatsApp Web, uso respaldo:', e.message); }
  console.log('[BAILEYS] Versión WA: ' + waVersion.join('.'));
  const sock = makeWASocket({ version: waVersion, auth: state, logger: pino({ level: 'silent' }), browser: ['Mac OS', 'Safari', '10.15.7'] });
  sockRef = sock;
  timers.setEnviarFn(enviarProyectoBot);
  timers.setEnviarElectricosFn(enviarElectricos);
  timers.setAvisoDiferibleFn(avisoDiferible);

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
      setTimeout(function() { detectarGrupos(sock, true); }, 2000);
      setTimeout(refrescarAdmins, 5000);
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
      const alt = msg.key.participantAlt || msg.key.remoteJidAlt || msg.key.participantPn;
      if (alt) admin.aprender(numeroFrom, alt);
      const texto      = extraerTexto(msg.message);
      if (!texto.trim()) { console.log('[MSG] sin texto (' + (esGrupo ? 'grupo' : 'PRIV') + ') de ' + numeroFrom + ': tipo=' + Object.keys(msg.message).join(',')); continue; }
      const nombreFrom = msg.pushName || numeroFrom;
      const canal      = esGrupo ? (chat === ID_ELECTRICOS ? 'ELÉCTRICOS' : chat === ID_PROYECTO_BOT ? 'PROYECTO BOT' : chat === ID_CONTROL ? 'CONTROL' : 'OTRO') : 'PRIV';
      console.log('[MSG][' + canal + '] ' + nombreFrom + ': ' + texto.substring(0, 60));
      // Si llega mensaje de grupo no reconocido, intentar redetectar grupos
      if (esGrupo && chat !== ID_ELECTRICOS && chat !== ID_PROYECTO_BOT && chat !== ID_CONTROL) {
        await resolverGrupo(sockRef, chat);
      }
      try {
        if (esGrupo) {
          if      (chat === ID_ELECTRICOS)   await procesarElectricos(texto, numeroFrom, nombreFrom);
          else if (chat === ID_PROYECTO_BOT) await procesarProyectoBot(texto, numeroFrom, nombreFrom);
          else if (chat === ID_CONTROL)       await procesarControl(texto, numeroFrom, nombreFrom);
        } else {
          await procesarPrivado(chat, texto, numeroFrom);
        }
      } catch (e) { console.log('[procesar]', e.message); }
    }
  });

  sock.ev.on('groups.update', async function() { await detectarGrupos(sock); });
  sock.ev.on('group-participants.update', function() { refrescarMiembros(); refrescarAdmins(); });
}

// Resuelve UN grupo por su ID (llamada ligera; evita rate-overlimit de groupFetchAllParticipating)
const _gruposCache = {}; // id -> { subject, hasta } ; hasta = ms hasta el que no se reintenta si falló
async function resolverGrupo(sock, id) {
  const c = _gruposCache[id];
  if (c && c.subject) { asignarGrupo(id, c.subject); return; }
  if (c && Date.now() < c.hasta) return;
  try {
    const meta = await sock.groupMetadata(id);
    _gruposCache[id] = { subject: meta.subject, hasta: 0 };
    console.log('[grupo] ' + id + ' = "' + meta.subject + '"');
    asignarGrupo(id, meta.subject);
  } catch (e) {
    _gruposCache[id] = { subject: null, hasta: Date.now() + 60000 };
    console.log('[grupo] groupMetadata ' + id + ': ' + e.message);
  }
}
function asignarGrupo(id, subject) {
  const antes = ID_ELECTRICOS + '|' + ID_PROYECTO_BOT + '|' + ID_CONTROL;
  if (subject === GRUPO_ELECTRICOS)   { const _nuevo = ID_ELECTRICOS !== id; ID_ELECTRICOS = id; if (_nuevo) setTimeout(refrescarMiembros, 1000); }
  if (subject === GRUPO_PROYECTO_BOT) { const _nuevoP = ID_PROYECTO_BOT !== id; ID_PROYECTO_BOT = id; if (_nuevoP) setTimeout(refrescarAdmins, 1000); }
  if (subject === GRUPO_CONTROL)      ID_CONTROL      = id;
  if (antes !== ID_ELECTRICOS + '|' + ID_PROYECTO_BOT + '|' + ID_CONTROL) {
    db.guardarGrupos({ electricos: ID_ELECTRICOS, proyecto_bot: ID_PROYECTO_BOT, control: ID_CONTROL })
      .catch(function(e) { console.log('[grupos] no pude guardar:', e.message); });
  }
}

async function detectarGrupos(sock, forzar) {
  const ahora = Date.now();
  if (_gruposEnCurso) return;
  if (!forzar && ahora - _gruposUltimo < 60000) return; // cooldown 60 s (evita rate-overlimit)
  _gruposEnCurso = true;
  _gruposUltimo = ahora;
  try {
    const grupos = await sock.groupFetchAllParticipating();
    for (const id in grupos) {
      const info = grupos[id];
      asignarGrupo(id, info.subject);
      if (info.subject === GRUPO_ELECTRICOS || info.subject === GRUPO_PROYECTO_BOT || info.subject === GRUPO_CONTROL) {
        console.log('Grupo "' + info.subject + '" → ' + id);
      }
    }
    if (!ID_ELECTRICOS)   console.log('Grupo "' + GRUPO_ELECTRICOS + '" no encontrado');
    if (!ID_PROYECTO_BOT) console.log('Grupo "' + GRUPO_PROYECTO_BOT + '" no encontrado');
  } catch (e) {
    console.log('[detectarGrupos]', e.message);
    if (/rate-overlimit/i.test(e.message)) _gruposUltimo = Date.now() + 240000; // castigo: ~5 min sin reintentar
  } finally { _gruposEnCurso = false; }
}

// REINICIO AUTOMÁTICO A MEDIANOCHE HORA MÉXICO
function programarReinicioNocturno() {
  const msHastaMedianoche = tiempo.msHastaMedianoche();

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
      await avisoDiferible('🌙 Reinicio automático de medianoche completado. Sistema listo para el nuevo día.');
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
    const baileys = globalThis.__BAILEYS_TEST__ || await import('@whiskeysockets/baileys');   // __BAILEYS_TEST__: solo pruebas
    makeWASocket          = baileys.default || baileys.makeWASocket;
    useMultiFileAuthState = baileys.useMultiFileAuthState;
    DisconnectReason      = baileys.DisconnectReason;
    fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
    await db.inicializar();
    try {
      const g = await db.cargarGrupos();
      if (g.electricos)    ID_ELECTRICOS   = g.electricos;
      if (g.proyecto_bot)  ID_PROYECTO_BOT = g.proyecto_bot;
      if (g.control)       ID_CONTROL      = g.control;
      console.log('[grupos] Cargados de Postgres: E=' + !!ID_ELECTRICOS + ' P=' + !!ID_PROYECTO_BOT + ' C=' + !!ID_CONTROL);
    } catch (e) { console.log('[grupos] no pude cargar:', e.message); }
    await timers.reactivarTimers();
    try { silencio = await db.cargarSilencio(); } catch (e) { silencio = false; }
    console.log('[arranque] silencio=' + silencio + ' horario=' + HORARIO.join('-'));
    control.reanudarRecordatorios();
    refrescarMiembros();
    setInterval(refrescarMiembros, 30 * 60 * 1000);
    setInterval(refrescarAdmins, 30 * 60 * 1000);
    setInterval(function() {
      listaCtl.tick().catch(function(e) { console.log('[lista] tick error:', e.message); });
      vaciarDiferidos().catch(function(e) { console.log('[diferidos] error:', e.message); });
    }, 60 * 1000);
    listaCtl.tick().catch(function(e) { console.log('[lista] tick error:', e.message); });
    programarReinicioNocturno();
    await iniciarBot();
  } catch (e) { console.error('[ARRANQUE] ERROR FATAL:', e); }
}
module.exports = { arrancar };
if (!process.env.BOT_TEST) arrancar();   // BOT_TEST: lo define solo test/test_index.js
