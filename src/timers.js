// src/timers.js — Timers persistentes para conexión (15min) y sesión (3h)
const db = require('./db_cargadores');

// Referencia al envío — se inyecta desde index.js para evitar dependencia circular
let _enviarProyectoBot = null;

function setEnviarFn(fn) { _enviarProyectoBot = fn; }

async function enviar(texto) {
  if (_enviarProyectoBot) await _enviarProyectoBot(texto);
  else console.log('[timers] enviar sin fn registrada:', texto.substring(0, 60));
}

// Handles activos en memoria (para poder cancelarlos)
const handles = {
  conexion: {}, // cargadorId → timeoutHandle
  sesion: {}    // cargadorId → timeoutHandle
};

// ─── TIMER DE CONEXIÓN (15 min) ───────────────────────────────────────
// Inicia el timer. Guarda en DB antes de lanzar setTimeout.
async function iniciarTimerConexion(cargadorId, nombre, numero) {
  // Cancelar timer previo si existe
  cancelarTimerConexion(cargadorId);

  const c = await db.iniciarTimerConexion(cargadorId, nombre, numero);
  if (!c) return;

  const ms = db.MS_CONEXION;
  handles.conexion[cargadorId] = setTimeout(() => preguntarConexion(cargadorId), ms);
  console.log(`[timers] Timer conexión iniciado — cargador ${cargadorId}, ${nombre}, ${ms / 60000}min`);
}

// Extiende el timer de conexión 15 min más
async function extenderTimerConexion(cargadorId) {
  cancelarTimerConexion(cargadorId);
  const c = await db.extenderTimerConexion(cargadorId);
  if (!c) return;

  const ms = db.MS_CONEXION;
  handles.conexion[cargadorId] = setTimeout(() => preguntarConexion(cargadorId), ms);
  console.log(`[timers] Timer conexión extendido — cargador ${cargadorId}, extensión #${c.timer_conexion.extensiones}`);
}

function cancelarTimerConexion(cargadorId) {
  if (handles.conexion[cargadorId]) {
    clearTimeout(handles.conexion[cargadorId]);
    delete handles.conexion[cargadorId];
  }
}

// Se dispara cuando vencen los 15 min
async function preguntarConexion(cargadorId) {
  delete handles.conexion[cargadorId];
  const estado = db.getEstado();
  const c = estado.cargadores.find(x => x.id === cargadorId);
  if (!c || !c.timer_conexion.activo) return; // ya fue resuelto

  const nombre = c.usuario_actual;
  console.log(`[timers] Timer conexión vencido — cargador ${cargadorId}, ${nombre}`);

  // Guardar pendiente en DB
  await db.setPendiente({ tipo: 'conexion_vencida', cargador_id: cargadorId, nombre, numero: c.numero_actual });

  await enviar(
    `⏰ *Tiempo de conexión vencido*\n` +
    `Cargador ${cargadorId} — ${nombre}\n\n` +
    `¿Se conectó?\n` +
    `• *sí* — confirmar conexión\n` +
    `• *no* — mover al final de la fila\n` +
    `• *esperar* — dar 15 min más`
  );
}

// ─── TIMER DE SESIÓN (3 horas) ────────────────────────────────────────
async function iniciarTimerSesion(cargadorId) {
  cancelarTimerSesion(cargadorId);
  const ms = db.MS_SESION;
  handles.sesion[cargadorId] = setTimeout(() => notificarSesionTerminada(cargadorId), ms);
  console.log(`[timers] Timer sesión iniciado — cargador ${cargadorId}, ${ms / 3600000}h`);
}

function cancelarTimerSesion(cargadorId) {
  if (handles.sesion[cargadorId]) {
    clearTimeout(handles.sesion[cargadorId]);
    delete handles.sesion[cargadorId];
  }
}

// Se dispara cuando vencen las 3 horas
async function notificarSesionTerminada(cargadorId) {
  delete handles.sesion[cargadorId];
  const estado = db.getEstado();
  const c = estado.cargadores.find(x => x.id === cargadorId);
  if (!c || !c.ocupado) return;

  const nombre = c.usuario_actual;
  console.log(`[timers] Sesión terminada — cargador ${cargadorId}, ${nombre}`);

  await db.liberarCargador(cargadorId);

  await enviar(
    `🔋 *Sesión terminada*\n` +
    `${nombre} cumplió 3 horas en cargador ${cargadorId}.\n\n` +
    `📋 *Copiar al ayudante:*\n` +
    `El cargador de ${nombre} está libre.`
  );

  // Si hay fila, avisar que hay cargador disponible
  const siguiente = db.primeroEnFila();
  if (siguiente) {
    await enviar(
      `⚡ Hay cargador disponible. Le toca a *${siguiente.nombre}*.\n` +
      `¿Confirmas asignar turno? Responde *sí*`
    );
    await db.setPendiente({ tipo: 'asignar_turno', cargador_id: cargadorId, nombre: siguiente.nombre, numero: siguiente.numero });
  }
}

// ─── REACTIVAR TIMERS AL ARRANCAR ────────────────────────────────────
// Llamar después de db.inicializar() y antes de aceptar mensajes
async function reactivarTimers() {
  const estado = db.getEstado();
  if (!estado) return;
  const ahora = Date.now();
  let reactivados = 0;

  for (const c of estado.cargadores) {
    // Timer de conexión
    if (c.timer_conexion?.activo) {
      const transcurrido = ahora - new Date(c.timer_conexion.hora_inicio).getTime();
      const restante = c.timer_conexion.duracion_ms - transcurrido;
      if (restante <= 0) {
        console.log(`[timers] Timer conexión ya venció — cargador ${c.id}, lanzando pregunta`);
        setTimeout(() => preguntarConexion(c.id), 1000);
      } else {
        console.log(`[timers] Reactivando timer conexión — cargador ${c.id}, ${Math.round(restante / 60000)}min restantes`);
        handles.conexion[c.id] = setTimeout(() => preguntarConexion(c.id), restante);
        reactivados++;
      }
    }
    // Timer de sesión
    if (c.timer_sesion?.activo) {
      const transcurrido = ahora - new Date(c.timer_sesion.hora_inicio).getTime();
      const restante = c.timer_sesion.duracion_ms - transcurrido;
      if (restante <= 0) {
        console.log(`[timers] Sesión ya terminó — cargador ${c.id}, liberando`);
        setTimeout(() => notificarSesionTerminada(c.id), 1000);
      } else {
        console.log(`[timers] Reactivando timer sesión — cargador ${c.id}, ${Math.round(restante / 3600000 * 10) / 10}h restantes`);
        handles.sesion[c.id] = setTimeout(() => notificarSesionTerminada(c.id), restante);
        reactivados++;
      }
    }
  }
  console.log(`[timers] ${reactivados} timer(s) reactivados`);
}

module.exports = {
  setEnviarFn,
  iniciarTimerConexion, extenderTimerConexion, cancelarTimerConexion,
  iniciarTimerSesion, cancelarTimerSesion,
  preguntarConexion, notificarSesionTerminada,
  reactivarTimers
};
