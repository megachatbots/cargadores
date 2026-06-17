// src/timers.js — Timers persistentes para conexión (15min) y sesión (3h/8h)
const db = require('./db_cargadores');

// Wrappers dinámicos — se actualizan en cada reconexión de Baileys
const _fns = { proyectoBot: null, electricos: null };

function setEnviarFn(fn) { _fns.proyectoBot = fn; }
function setEnviarElectricosFn(fn) { _fns.electricos = fn; }

async function enviar(texto) {
  if (_fns.proyectoBot) await _fns.proyectoBot(texto);
  else console.log('[timers] enviar sin fn:', texto.substring(0, 60));
}

async function enviarElectricosConMencion(nombre, numero, texto) {
  if (!_fns.electricos) { console.log('[timers] enviarElectricos sin fn'); return; }
  await _fns.electricos(nombre + ' ' + texto, numero);
}



const handles = { conexion: {}, sesion: {} };

// TIMER DE CONEXIÓN (15 min)
async function iniciarTimerConexion(cajon, nombre, numero) {
  cajon = String(cajon);
  cancelarTimerConexion(cajon);
  const c = await db.iniciarTimerConexion(cajon, nombre, numero);
  if (!c) return;
  handles.conexion[cajon] = setTimeout(function() { preguntarConexion(cajon); }, db.MS_CONEXION);
  console.log('[timers] Timer conexion iniciado — cajón ' + cajon + ', ' + nombre);
}

async function extenderTimerConexion(cajon) {
  cajon = String(cajon);
  cancelarTimerConexion(cajon);
  const c = await db.extenderTimerConexion(cajon);
  if (!c) return;
  handles.conexion[cajon] = setTimeout(function() { preguntarConexion(cajon); }, db.MS_CONEXION);
  console.log('[timers] Timer conexion extendido — cajón ' + cajon + ' #' + c.timer_conexion.extensiones);
}

function cancelarTimerConexion(cajon) {
  cajon = String(cajon);
  if (handles.conexion[cajon]) { clearTimeout(handles.conexion[cajon]); delete handles.conexion[cajon]; }
}

async function preguntarConexion(cajon) {
  cajon = String(cajon);
  delete handles.conexion[cajon];
  const estado = db.getEstado();
  const c = estado.cargadores[cajon];
  if (!c || !c.timer_conexion || !c.timer_conexion.activo) return;
  const nombre = c.usuario_actual;
  console.log('[timers] Timer conexion vencido — cajón ' + cajon + ', ' + nombre);
  await db.setPendiente({ tipo: 'conexion_vencida', cargador_id: cajon, nombre: nombre, numero: c.numero_actual });
  await enviar(
    '⏰ *Tiempo de conexión vencido*\n' +
    'Cajón ' + cajon + ' — ' + nombre + '\n\n' +
    '¿Se conectó?\n' +
    '• *sí* — confirmar conexión\n' +
    '• *no* — mover al final de la fila\n' +
    '• *esperar* — dar 15 min más'
  );
}

// TIMER DE SESIÓN (3h o 8h VIP)
async function iniciarTimerSesion(cajon) {
  cajon = String(cajon);
  cancelarTimerSesion(cajon);
  const estado = db.getEstado();
  const c = estado.cargadores[cajon];
  if (!c) return;
  const ms = c.timer_sesion ? c.timer_sesion.duracion_ms : db.MS_SESION;
  const MS_AVISO = 15 * 60 * 1000;
  // Timer aviso 15 min antes (solo si la sesión dura más de 15 min)
  if (ms > MS_AVISO) {
    handles['aviso_' + cajon] = setTimeout(function() { avisarProximoVencimiento(cajon); }, ms - MS_AVISO);
  }
  handles.sesion[cajon] = setTimeout(function() { notificarSesionTerminada(cajon); }, ms);
  console.log('[timers] Timer sesion iniciado — cajón ' + cajon + ', ' + (ms/3600000) + 'h');
}

// Reactivar timer de sesión para un cajón específico (usado en carga de estado inicial)
async function reactivarTimerSesionCajon(cajon) {
  cajon = String(cajon);
  cancelarTimerSesion(cajon);
  const estado = db.getEstado();
  const c = estado.cargadores[cajon];
  if (!c || !c.timer_sesion || !c.timer_sesion.activo) return;
  const transcurrido = Date.now() - new Date(c.timer_sesion.hora_inicio).getTime();
  const restante = c.timer_sesion.duracion_ms - transcurrido;
  const MS_AVISO = 15 * 60 * 1000;
  if (restante <= 0) {
    setTimeout(function() { notificarSesionTerminada(cajon); }, 1000);
  } else {
    // Reactivar aviso 15min si aún queda tiempo
    if (restante > MS_AVISO) {
      handles['aviso_' + cajon] = setTimeout(function() { avisarProximoVencimiento(cajon); }, restante - MS_AVISO);
    }
    handles.sesion[cajon] = setTimeout(function() { notificarSesionTerminada(cajon); }, restante);
    console.log('[timers] Timer sesion reactivado — cajón ' + cajon + ', ' + Math.round(restante/60000) + 'min restantes');
  }
}

function cancelarTimerSesion(cajon) {
  cajon = String(cajon);
  if (handles.sesion[cajon]) { clearTimeout(handles.sesion[cajon]); delete handles.sesion[cajon]; }
}

async function avisarProximoVencimiento(cajon) {
  cajon = String(cajon);
  delete handles['aviso_' + cajon];
  const estado = db.getEstado();
  const c = estado.cargadores[cajon];
  if (!c || !c.ocupado) return;
  const nombre = c.usuario_actual;
  const numero = c.numero_actual;
  console.log('[timers] Aviso 15min — cajón ' + cajon + ', ' + nombre);
  if (numero && _enviarElectricos) {
    await enviarElectricosConMencion(nombre, numero, '@' + numero + ' faltan 15 minutos para desconectarte ⚡');
  } else {
    await enviar('⏰ *Aviso:* ' + nombre + ' tiene 15 minutos antes de que expire su sesión en cajón ' + cajon + '.');
  }
}

async function notificarSesionTerminada(cajon) {
  cajon = String(cajon);
  delete handles.sesion[cajon];
  const estado = db.getEstado();
  const c = estado.cargadores[cajon];
  if (!c || !c.ocupado) return;
  const nombre = c.usuario_actual;
  const numero = c.numero_actual;
  console.log('[timers] Sesion terminada — cajón ' + cajon + ', ' + nombre);
  await db.liberarCajon(cajon);
  if (numero && _enviarElectricos) {
    await enviarElectricosConMencion(nombre, numero, '@' + numero + ' expiró tu tiempo de conexión, favor de desconectarte 🙏');
  } else {
    await enviar('🔋 *Sesión terminada*\n' + nombre + ' cumplió su tiempo en cajón ' + cajon + '.\n\n📋 *Copiar al ayudante:*\nEl cajón ' + cajon + ' de ' + nombre + ' está libre.');
  }
  const est2 = db.getEstado();
  // Contar cuántos usuarios ya tienen turno activo (timer_conexion activo)
  const conTurnoActivo = new Set();
  for (const c in est2.cargadores) {
    const carg = est2.cargadores[c];
    if (carg.timer_conexion && carg.timer_conexion.activo && carg.usuario_actual) {
      conTurnoActivo.add(carg.usuario_actual.toLowerCase());
    }
  }
  // Buscar el primero de la fila que NO tenga turno activo ya
  const siguiente = est2.fila.find(function(u) {
    return !conTurnoActivo.has(u.nombre.toLowerCase());
  });
  if (siguiente) {
    await enviar('⚡ Cajón ' + cajon + ' libre. Le toca a *' + siguiente.nombre + '*.\n¿Confirmas? Responde *sí*');
    await db.setPendiente({ tipo: 'asignar_turno', cargador_id: cajon, nombre: siguiente.nombre, numero: siguiente.numero });
  }
}

// REACTIVAR TODOS LOS TIMERS AL ARRANCAR
async function reactivarTimers() {
  const estado = db.getEstado();
  if (!estado) return;
  const ahora = Date.now();
  let reactivados = 0;

  for (const cajon in estado.cargadores) {
    const c = estado.cargadores[cajon];

    if (c.timer_conexion && c.timer_conexion.activo) {
      const transcurrido = ahora - new Date(c.timer_conexion.hora_inicio).getTime();
      const restante = c.timer_conexion.duracion_ms - transcurrido;
      if (restante <= 0) {
        console.log('[timers] Timer conexion ya vencio — cajón ' + cajon);
        setTimeout(function() { preguntarConexion(cajon); }, 1000);
      } else {
        handles.conexion[cajon] = setTimeout(function() { preguntarConexion(cajon); }, restante);
        console.log('[timers] Reactivando conexion — cajón ' + cajon + ', ' + Math.round(restante/60000) + 'min');
        reactivados++;
      }
    }

    if (c.timer_sesion && c.timer_sesion.activo) {
      const transcurrido = ahora - new Date(c.timer_sesion.hora_inicio).getTime();
      const restante = c.timer_sesion.duracion_ms - transcurrido;
      if (restante <= 0) {
        console.log('[timers] Sesion ya termino — cajón ' + cajon);
        setTimeout(function() { notificarSesionTerminada(cajon); }, 1000);
      } else {
        handles.sesion[cajon] = setTimeout(function() { notificarSesionTerminada(cajon); }, restante);
        console.log('[timers] Reactivando sesion — cajón ' + cajon + ', ' + Math.round(restante/60000) + 'min');
        reactivados++;
      }
    }
  }
  console.log('[timers] ' + reactivados + ' timer(s) reactivados');
}

module.exports = {
  setEnviarFn, setEnviarElectricosFn,
  iniciarTimerConexion, extenderTimerConexion, cancelarTimerConexion,
  iniciarTimerSesion, cancelarTimerSesion, reactivarTimerSesionCajon,
  preguntarConexion, avisarProximoVencimiento, notificarSesionTerminada,
  reactivarTimers
};
