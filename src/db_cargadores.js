// src/db_cargadores.js — Estado de cargadores eléctricos (independiente del torneo)
const { Pool } = require('pg');

const NUM_CARGADORES = 6;
const MS_CONEXION = 15 * 60 * 1000;   // 15 minutos
const MS_SESION   = 3 * 60 * 60 * 1000; // 3 horas

let pgClient = null;
let estado = null;
// estado: { fila, cargadores, proximoId, pendiente }
// pendiente: { tipo, cargador_id, nombre } — pregunta abierta esperando confirmación

// ─── POSTGRES ─────────────────────────────────────────────────────────
async function conectarPG() {
  if (pgClient) return pgClient;
  if (!process.env.DATABASE_URL) return null;
  try {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3
    });
    await pool.query(`CREATE TABLE IF NOT EXISTS cargadores_bot
      (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMP DEFAULT NOW())`);
    pgClient = pool;
    return pgClient;
  } catch (e) { console.error('[DB_C] Error PG:', e.message); return null; }
}

async function pgGet(key) {
  const c = await conectarPG(); if (!c) return null;
  try {
    const r = await c.query('SELECT value FROM cargadores_bot WHERE key=$1', [key]);
    return r.rows.length ? JSON.parse(r.rows[0].value) : null;
  } catch (e) { return null; }
}

async function pgSet(key, value) {
  const c = await conectarPG(); if (!c) return false;
  try {
    await c.query(
      `INSERT INTO cargadores_bot (key,value,updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()`,
      [key, JSON.stringify(value)]
    );
    return true;
  } catch (e) { console.error('[DB_C] pgSet:', e.message); return false; }
}

// ─── ESTADO INICIAL ───────────────────────────────────────────────────
function estadoVacio() {
  return {
    fila: [],
    cargadores: Array.from({ length: NUM_CARGADORES }, (_, i) => ({
      id: i + 1,
      ocupado: false,
      usuario_actual: null,
      numero_actual: null,
      hora_inicio: null,
      timer_conexion: { activo: false, hora_inicio: null, duracion_ms: MS_CONEXION, extensiones: 0 },
      timer_sesion:   { activo: false, hora_inicio: null, duracion_ms: MS_SESION }
    })),
    proximoId: 1,
    pendiente: null  // { tipo: 'asignar_turno'|'conexion_vencida', cargador_id, nombre, numero }
  };
}

// ─── INICIALIZACIÓN ───────────────────────────────────────────────────
async function inicializar() {
  await conectarPG();
  const guardado = await pgGet('estado_cargadores');
  if (guardado) {
    estado = guardado;
    // Migración: asegurar campo pendiente
    if (estado.pendiente === undefined) estado.pendiente = null;
    console.log('[DB_C] Estado cargadores cargado desde PostgreSQL');
  } else {
    estado = estadoVacio();
    console.log('[DB_C] Estado cargadores nuevo inicializado');
    await guardar('init');
  }
  return estado;
}

async function guardar(motivo = 'cambio') {
  await pgSet('estado_cargadores', estado);
}

function getEstado() { return estado; }

// ─── FILA ─────────────────────────────────────────────────────────────
// Agrega usuario a la fila. Devuelve { ok, posicion, yaEsta }
async function agregarFila(numero, nombre) {
  const yaEsta = estado.fila.find(u => u.numero === numero);
  if (yaEsta) {
    return { ok: false, yaEsta: true, posicion: estado.fila.indexOf(yaEsta) + 1 };
  }
  const item = {
    id: estado.proximoId++,
    numero,
    nombre: nombre || numero,
    hora_solicitud: new Date().toISOString()
  };
  estado.fila.push(item);
  await guardar('agregar fila');
  return { ok: true, posicion: estado.fila.length, item };
}

// Mueve usuario al final de la fila (perdió turno)
async function moverAlFinal(numero) {
  const idx = estado.fila.findIndex(u => u.numero === numero);
  if (idx === -1) return null;
  const [item] = estado.fila.splice(idx, 1);
  item.hora_solicitud = new Date().toISOString(); // actualizar timestamp
  estado.fila.push(item);
  await guardar('mover al final');
  return { posicion: estado.fila.length, item };
}

// Quita usuario de la fila por número
async function quitarFila(numero) {
  const idx = estado.fila.findIndex(u => u.numero === numero);
  if (idx === -1) return { ok: false, msg: 'Usuario no encontrado en la fila' };
  const [item] = estado.fila.splice(idx, 1);
  await guardar('quitar fila');
  return { ok: true, nombre: item.nombre };
}

// Primero en la fila
function primeroEnFila() {
  return estado.fila[0] || null;
}

// ─── CARGADORES ───────────────────────────────────────────────────────
function cargadorLibre() {
  return estado.cargadores.find(c => !c.ocupado) || null;
}

function numLibres() {
  return estado.cargadores.filter(c => !c.ocupado).length;
}

// Inicia timer de conexión (15 min) para un usuario
async function iniciarTimerConexion(cargadorId, nombre, numero) {
  const c = estado.cargadores.find(x => x.id === cargadorId);
  if (!c) return null;
  c.usuario_actual = nombre;
  c.numero_actual  = numero;
  c.timer_conexion = {
    activo: true,
    hora_inicio: new Date().toISOString(),
    duracion_ms: MS_CONEXION,
    extensiones: 0
  };
  await guardar(`timer conexion cargador ${cargadorId}`);
  return c;
}

// Extiende timer de conexión 15 min más
async function extenderTimerConexion(cargadorId) {
  const c = estado.cargadores.find(x => x.id === cargadorId);
  if (!c || !c.timer_conexion.activo) return null;
  c.timer_conexion.hora_inicio = new Date().toISOString();
  c.timer_conexion.extensiones++;
  await guardar(`extender timer cargador ${cargadorId}`);
  return c;
}

// Cancela timer de conexión e inicia timer de sesión (usuario se conectó)
async function confirmarConexion(cargadorId) {
  const c = estado.cargadores.find(x => x.id === cargadorId);
  if (!c) return null;
  c.ocupado         = true;
  c.hora_inicio     = new Date().toISOString();
  c.timer_conexion  = { activo: false, hora_inicio: null, duracion_ms: MS_CONEXION, extensiones: 0 };
  c.timer_sesion    = { activo: true, hora_inicio: new Date().toISOString(), duracion_ms: MS_SESION };
  // Sacar al usuario de la fila
  estado.fila = estado.fila.filter(u => u.numero !== c.numero_actual);
  await guardar(`conexion confirmada cargador ${cargadorId}`);
  return c;
}

// Libera un cargador (sesión terminó o usuario perdió turno)
async function liberarCargador(cargadorId) {
  const c = estado.cargadores.find(x => x.id === cargadorId);
  if (!c) return null;
  const nombre = c.usuario_actual;
  c.ocupado        = false;
  c.usuario_actual = null;
  c.numero_actual  = null;
  c.hora_inicio    = null;
  c.timer_conexion = { activo: false, hora_inicio: null, duracion_ms: MS_CONEXION, extensiones: 0 };
  c.timer_sesion   = { activo: false, hora_inicio: null, duracion_ms: MS_SESION };
  await guardar(`liberar cargador ${cargadorId}`);
  return { cargadorId, nombre };
}

// ─── PENDIENTE (pregunta abierta del bot) ─────────────────────────────
async function setPendiente(p) {
  estado.pendiente = p; // null para limpiar
  await guardar('pendiente');
}

function getPendiente() { return estado.pendiente; }

// ─── TIEMPO ESTIMADO ──────────────────────────────────────────────────
// Calcula tiempo estimado de espera para una posición en la fila
function tiempoEstimado(posicion) {
  const libres = numLibres();
  if (posicion <= libres) return 0; // disponible ahora
  return Math.ceil((posicion - libres) / NUM_CARGADORES) * 3; // horas
}

// ─── RESÚMENES ────────────────────────────────────────────────────────
function resumenFila() {
  if (!estado.fila.length) return '📋 *Fila de espera*\n\nNo hay nadie en la fila ✅';
  let txt = `📋 *Fila de espera* (${estado.fila.length} personas)\n\n`;
  estado.fila.forEach((u, i) => {
    const hrs = tiempoEstimado(i + 1);
    const espera = hrs === 0 ? 'disponible ahora' : `~${hrs}h de espera`;
    txt += `${i + 1}. ${u.nombre} — ${espera}\n`;
  });
  return txt;
}

function resumenCargadores() {
  let txt = '🔌 *Estado de cargadores*\n\n';
  for (const c of estado.cargadores) {
    if (c.ocupado) {
      const fin = c.timer_sesion.activo
        ? _horaLocal(new Date(new Date(c.timer_sesion.hora_inicio).getTime() + c.timer_sesion.duracion_ms).toISOString())
        : '?';
      txt += `🔴 Cargador ${c.id}: ${c.usuario_actual} hasta ${fin}\n`;
    } else if (c.timer_conexion.activo) {
      const fin = _horaLocal(new Date(new Date(c.timer_conexion.hora_inicio).getTime() + c.timer_conexion.duracion_ms).toISOString());
      txt += `🟡 Cargador ${c.id}: esperando a ${c.usuario_actual} hasta ${fin}\n`;
    } else {
      txt += `🟢 Cargador ${c.id}: Libre\n`;
    }
  }
  txt += `\n*${numLibres()}/${NUM_CARGADORES} libres*`;
  return txt;
}

function resumenCompleto() {
  return resumenCargadores() + '\n\n' + resumenFila();
}

// ─── UTILS ────────────────────────────────────────────────────────────
function _horaLocal(iso) {
  if (!iso) return '?';
  return new Date(iso).toLocaleTimeString('es-MX', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City'
  });
}

module.exports = {
  inicializar, getEstado, guardar,
  agregarFila, moverAlFinal, quitarFila, primeroEnFila,
  cargadorLibre, numLibres, tiempoEstimado,
  iniciarTimerConexion, extenderTimerConexion, confirmarConexion, liberarCargador,
  setPendiente, getPendiente,
  resumenFila, resumenCargadores, resumenCompleto,
  MS_CONEXION, MS_SESION, NUM_CARGADORES
};
