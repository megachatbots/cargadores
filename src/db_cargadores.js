// src/db_cargadores.js — Estado de cargadores eléctricos
const { Pool } = require('pg');

const CAJONES         = ['41','42','44','45','46','48','49','50'];
const CAJONES_VIP     = new Set(['46','50']);
const NUM_CARGADORES  = CAJONES.length;
const MS_CONEXION     = 15 * 60 * 1000;
const MS_SESION       = 3 * 60 * 60 * 1000;
const MS_SESION_VIP   = 8 * 60 * 60 * 1000;

let pgClient = null;
let estado   = null;

// POSTGRES
async function conectarPG() {
  if (pgClient) return pgClient;
  if (!process.env.DATABASE_URL) return null;
  try {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });
    await pool.query('CREATE TABLE IF NOT EXISTS cargadores_bot (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMP DEFAULT NOW())');
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
      'INSERT INTO cargadores_bot (key,value,updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()',
      [key, JSON.stringify(value)]
    );
    return true;
  } catch (e) { console.error('[DB_C] pgSet:', e.message); return false; }
}

// ESTADO INICIAL
function cajonVacio(cajon) {
  return {
    cajon,
    vip: CAJONES_VIP.has(String(cajon)),
    ocupado: false,
    usuario_actual: null,
    numero_actual: null,
    marca: null,
    placas: null,
    hora_inicio: null,
    timer_conexion: { activo: false, hora_inicio: null, duracion_ms: MS_CONEXION, extensiones: 0 },
    timer_sesion:   { activo: false, hora_inicio: null, duracion_ms: MS_SESION }
  };
}

function estadoVacio() {
  const cargadores = {};
  for (const c of CAJONES) cargadores[c] = cajonVacio(c);
  return { fila: [], lista_estatica: [], cargadores, proximoId: 1, pendiente: null };
}

// INICIALIZACIÓN
async function inicializar() {
  await conectarPG();
  const guardado = await pgGet('estado_cargadores');
  if (guardado) {
    estado = guardado;
    if (estado.pendiente === undefined) estado.pendiente = null;
    if (!estado.lista_estatica) estado.lista_estatica = [];
    // Migración: si los cargadores son array viejo (1-6), reiniciar
    if (Array.isArray(estado.cargadores)) {
      console.log('[DB_C] Migrando estado antiguo a cajones reales');
      estado = estadoVacio();
      await guardar('migracion cajones');
    }
    console.log('[DB_C] Estado cargadores cargado desde PostgreSQL');
  } else {
    estado = estadoVacio();
    console.log('[DB_C] Estado cargadores nuevo inicializado');
    await guardar('init');
  }
  return estado;
}

async function guardar(motivo) {
  await pgSet('estado_cargadores', estado);
}

async function reiniciar() {
  estado = estadoVacio();
  await guardar('reinicio manual');
  return true;
}

async function reiniciarTodo() {
  estado = estadoVacio();
  await guardar('reinicio total');
  return true;
}

function getEstado() { return estado; }

// FILA
async function agregarFila(numero, nombre) {
  const yaEsta = estado.fila.find(function(u) { return u.numero === numero; });
  if (yaEsta) return { ok: false, yaEsta: true, posicion: estado.fila.indexOf(yaEsta) + 1 };
  const item = { id: estado.proximoId++, numero, nombre: nombre || numero, hora_solicitud: new Date().toISOString() };
  estado.fila.push(item);
  // Registrar en lista estática (no se modifica después)
  if (!estado.lista_estatica) estado.lista_estatica = [];
  const yaEnEstatica = estado.lista_estatica.find(function(u) { return u.numero === numero; });
  if (!yaEnEstatica) {
    estado.lista_estatica.push({ nombre: item.nombre, numero, hora_solicitud: item.hora_solicitud });
  }
  await guardar('agregar fila');
  return { ok: true, posicion: estado.fila.length, item };
}

// Agregar manualmente a la fila (admin) — sin número de teléfono
async function anotarManual(nombre) {
  const yaEsta = estado.fila.find(function(u) { return u.nombre.toLowerCase() === nombre.toLowerCase(); });
  if (yaEsta) return { ok: false, yaEsta: true, posicion: estado.fila.indexOf(yaEsta) + 1 };
  const id = 'manual_' + (estado.proximoId++);
  const hora = new Date().toISOString();
  const item = { id, numero: id, nombre, hora_solicitud: hora, manual: true };
  estado.fila.push(item);
  if (!estado.lista_estatica) estado.lista_estatica = [];
  estado.lista_estatica.push({ nombre, numero: id, hora_solicitud: hora });
  await guardar('anotar manual ' + nombre);
  return { ok: true, posicion: estado.fila.length, item };
}

async function moverAlFinal(numero) {
  const idx = estado.fila.findIndex(function(u) { return u.numero === numero; });
  if (idx === -1) return null;
  const item = estado.fila.splice(idx, 1)[0];
  item.hora_solicitud = new Date().toISOString();
  estado.fila.push(item);
  await guardar('mover al final');
  return { posicion: estado.fila.length, item };
}

async function quitarFila(numero) {
  const idx = estado.fila.findIndex(function(u) { return u.numero === numero; });
  if (idx === -1) return { ok: false, msg: 'Usuario no encontrado en la fila' };
  const item = estado.fila.splice(idx, 1)[0];
  await guardar('quitar fila');
  return { ok: true, nombre: item.nombre };
}

function primeroEnFila() { return estado.fila[0] || null; }

// CARGADORES
function cargadorLibre() {
  for (const cajon of CAJONES) {
    const c = estado.cargadores[cajon];
    if (!c.ocupado && !c.timer_conexion.activo) return c;
  }
  return null;
}

function numLibres() {
  return CAJONES.filter(function(cajon) {
    const c = estado.cargadores[cajon];
    return !c.ocupado && !c.timer_conexion.activo;
  }).length;
}

async function iniciarTimerConexion(cajon, nombre, numero) {
  cajon = String(cajon);
  const c = estado.cargadores[cajon];
  if (!c) return null;
  c.usuario_actual = nombre;
  c.numero_actual  = numero;
  c.timer_conexion = { activo: true, hora_inicio: new Date().toISOString(), duracion_ms: MS_CONEXION, extensiones: 0 };
  await guardar('timer conexion ' + cajon);
  return c;
}

async function extenderTimerConexion(cajon) {
  cajon = String(cajon);
  const c = estado.cargadores[cajon];
  if (!c || !c.timer_conexion.activo) return null;
  c.timer_conexion.hora_inicio = new Date().toISOString();
  c.timer_conexion.extensiones++;
  await guardar('extender timer ' + cajon);
  return c;
}

async function confirmarConexion(cajon) {
  cajon = String(cajon);
  const c = estado.cargadores[cajon];
  if (!c) return null;
  const msSesion = c.vip ? MS_SESION_VIP : MS_SESION;
  c.ocupado        = true;
  c.hora_inicio    = new Date().toISOString();
  c.timer_conexion = { activo: false, hora_inicio: null, duracion_ms: MS_CONEXION, extensiones: 0 };
  c.timer_sesion   = { activo: true, hora_inicio: new Date().toISOString(), duracion_ms: msSesion };
  estado.fila = estado.fila.filter(function(u) { return u.numero !== c.numero_actual; });
  await guardar('conexion confirmada ' + cajon);
  return c;
}

async function liberarCajon(cajon) {
  cajon = String(cajon);
  const c = estado.cargadores[cajon];
  if (!c) return null;
  const nombre = c.usuario_actual;
  estado.cargadores[cajon] = cajonVacio(cajon);
  await guardar('liberar ' + cajon);
  return { cajon, nombre };
}

// Conectar usuario manualmente (comando admin)
// numero puede ser null si no está en la fila
async function conectarUsuario(cajon, nombre, numero, horaInicio) {
  cajon = String(cajon);
  const c = estado.cargadores[cajon];
  if (!c) return null;
  const msSesion = c.vip ? MS_SESION_VIP : MS_SESION;
  // Usar horaInicio si viene (matutino), si no usar ahora
  const inicio = horaInicio ? horaInicio : new Date().toISOString();
  c.ocupado        = true;
  c.usuario_actual = nombre;
  c.numero_actual  = numero || null;
  c.hora_inicio    = inicio;
  c.timer_conexion = { activo: false, hora_inicio: null, duracion_ms: MS_CONEXION, extensiones: 0 };
  c.timer_sesion   = { activo: true, hora_inicio: inicio, duracion_ms: msSesion };
  // Sacar de la fila si está
  if (numero) {
    estado.fila = estado.fila.filter(function(u) { return u.numero !== numero; });
  } else {
    // Sacar por nombre si no hay número
    estado.fila = estado.fila.filter(function(u) {
      return !u.nombre.toLowerCase().includes(nombre.toLowerCase()) &&
             !nombre.toLowerCase().includes(u.nombre.toLowerCase());
    });
  }
  await guardar('conectar ' + nombre + ' en ' + cajon);
  return c;
}

// Distancia de edición simplificada (para tolerancia de errores)
function _similitud(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;
  // Contar caracteres en común
  const setA = new Set(a.split(''));
  const setB = new Set(b.split(''));
  let comunes = 0;
  setA.forEach(function(c) { if (setB.has(c)) comunes++; });
  return comunes / Math.max(setA.size, setB.size);
}

// Buscar en fila con tolerancia a errores
function buscarEnFilaTolerate(nombre) {
  const nl = nombre.toLowerCase();
  return estado.fila.filter(function(u) {
    const ul = u.nombre.toLowerCase();
    return ul.includes(nl) || nl.includes(ul) || _similitud(nl, ul) > 0.7;
  }).sort(function(a, b) {
    return _similitud(b.nombre.toLowerCase(), nl) - _similitud(a.nombre.toLowerCase(), nl);
  });
}

// Buscar cajón ocupado por nombre (búsqueda flexible)
function buscarCajonDeUsuario(nombre) {
  const nl = nombre.toLowerCase();
  for (const cajon of CAJONES) {
    const c = estado.cargadores[cajon];
    if (c.ocupado && c.usuario_actual) {
      const ul = c.usuario_actual.toLowerCase();
      if (ul === nl || ul.includes(nl) || nl.includes(ul)) return c;
    }
    if (c.timer_conexion && c.timer_conexion.activo && c.usuario_actual) {
      const ul = c.usuario_actual.toLowerCase();
      if (ul === nl || ul.includes(nl) || nl.includes(ul)) return c;
    }
  }
  return null;
}

// Buscar candidatos en fila por nombre (para desambiguación)
function buscarEnFila(nombre) {
  return buscarEnFilaTolerate(nombre);
}

// CARGA DE ESTADO MATUTINO
// items: [{ cajon, ocupado, nombre, marca, placas, horaInicio, horaFin }]
async function cargarEstadoInicial(items) {
  // Primero actualizar cajones
  for (const item of items) {
    const cajon = String(item.cajon);
    if (!CAJONES.includes(cajon)) continue;
    if (!item.ocupado) {
      estado.cargadores[cajon] = cajonVacio(cajon);
      continue;
    }
    const c = cajonVacio(cajon);
    c.ocupado        = true;
    c.usuario_actual = item.nombre || '?';
    c.marca          = item.marca  || null;
    c.placas         = item.placas || null;

    // Calcular timer de sesión desde hora de inicio
    if (!c.vip) {
      const msSesion = MS_SESION;
      // Usar hora del reporte o asumir 7:00 si no hay
      const horaStr = item.horaInicio || '7:00';
      const inicio  = _parsearHoraHoy(horaStr);
      if (inicio) {
        c.hora_inicio = inicio.toISOString();
        const finMs   = inicio.getTime() + msSesion;
        const ahoraMs = Date.now();
        if (finMs > ahoraMs) {
          c.timer_sesion = { activo: true, hora_inicio: inicio.toISOString(), duracion_ms: msSesion };
        } else {
          // Ya venció — marcar ocupado sin timer, bot avisará en Proyecto Bot
          c.timer_sesion = { activo: false, hora_inicio: inicio.toISOString(), duracion_ms: msSesion };
        }
      }
    }
    // VIP: ocupado sin timer
    estado.cargadores[cajon] = c;
  }

  // Sacar de la fila a quienes ya están conectados en algún cajón
  const nombresConectados = [];
  for (const cajon in estado.cargadores) {
    const c = estado.cargadores[cajon];
    if (c.ocupado && c.usuario_actual) nombresConectados.push(c.usuario_actual.toLowerCase());
  }
  const filaAntes = estado.fila.length;
  estado.fila = estado.fila.filter(function(u) {
    return !nombresConectados.some(function(n) { return u.nombre.toLowerCase().includes(n) || n.includes(u.nombre.toLowerCase()); });
  });
  const sacados = filaAntes - estado.fila.length;

  await guardar('estado inicial cargado');
  return { ok: true, sacados };
}

// PENDIENTE
async function setPendiente(p) { estado.pendiente = p; await guardar('pendiente'); }
function getPendiente() { return estado.pendiente; }

// TIEMPO ESTIMADO
function tiempoEstimado(posicion) {
  const libres = numLibres();
  if (posicion <= libres) return 0;
  return Math.ceil((posicion - libres) / NUM_CARGADORES) * 3;
}

// RESÚMENES
function resumenFila() {
  if (!estado.fila.length) return '📋 *Fila de espera*\n\nNo hay nadie en la fila ✅';
  let txt = '📋 *Fila de espera* (' + estado.fila.length + ' personas)\n\n';
  estado.fila.forEach(function(u, i) {
    const hrs = tiempoEstimado(i + 1);
    txt += (i + 1) + '. ' + u.nombre + ' — ' + (hrs === 0 ? 'disponible ahora' : '~' + hrs + 'h') + '\n';
  });
  return txt;
}

function resumenCargadores() {
  let txt = '🔌 *Estado de cajones*\n\n';
  for (const cajon of CAJONES) {
    const c = estado.cargadores[cajon];
    const vipTag = c.vip ? ' ⭐' : '';
    if (c.ocupado) {
      let fin = '?';
      if (c.timer_sesion && c.timer_sesion.activo) {
        fin = _horaLocal(new Date(new Date(c.timer_sesion.hora_inicio).getTime() + c.timer_sesion.duracion_ms).toISOString());
      }
      txt += '🔴 Cajón ' + cajon + vipTag + ': ' + c.usuario_actual + ' hasta ' + fin;
      if (c.placas) txt += ' (' + c.placas + ')';
      txt += '\n';
    } else if (c.timer_conexion && c.timer_conexion.activo) {
      const fin = _horaLocal(new Date(new Date(c.timer_conexion.hora_inicio).getTime() + c.timer_conexion.duracion_ms).toISOString());
      txt += '🟡 Cajón ' + cajon + vipTag + ': esperando a ' + c.usuario_actual + ' hasta ' + fin + '\n';
    } else {
      txt += '🟢 Cajón ' + cajon + vipTag + ': Libre\n';
    }
  }
  txt += '\n*' + numLibres() + '/' + NUM_CARGADORES + ' libres*';
  return txt;
}

function resumenCompleto() { return resumenCargadores() + '\n\n' + resumenFila(); }

function resumenListaEstatica() {
  if (!estado.lista_estatica || !estado.lista_estatica.length) {
    return '📋 *Lista estática*\n\nNo hay registros de hoy todavía.';
  }
  let txt = '📋 *Lista estática — orden de llegada*\n\n';
  estado.lista_estatica.forEach(function(u, i) {
    const hora = new Date(u.hora_solicitud).toLocaleTimeString('es-MX', {
      hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City'
    });
    txt += (i + 1) + '. ' + u.nombre + ' — ' + hora + '\n';
  });
  return txt;
}

// UTILS
function _horaLocal(iso) {
  if (!iso) return '?';
  return new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' });
}

function _parsearHoraHoy(horaStr) {
  // "9:30" → Date de hoy con esa hora en México
  const m = horaStr.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const ahora = new Date();
  // Convertir a hora México
  const fechaMex = new Date(ahora.toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
  fechaMex.setHours(parseInt(m[1]), parseInt(m[2]), 0, 0);
  // Ajustar offset
  const offset = ahora.getTime() - new Date(ahora.toLocaleString('en-US', { timeZone: 'America/Mexico_City' })).getTime();
  return new Date(fechaMex.getTime() + offset);
}

module.exports = {
  inicializar, getEstado, guardar, reiniciar, reiniciarTodo,
  agregarFila, moverAlFinal, quitarFila, primeroEnFila,
  cargadorLibre, numLibres, tiempoEstimado,
  iniciarTimerConexion, extenderTimerConexion, confirmarConexion, liberarCajon,
  conectarUsuario, buscarCajonDeUsuario, buscarEnFila,
  cargarEstadoInicial,
  setPendiente, getPendiente,
  resumenFila, resumenCargadores, resumenCompleto, resumenListaEstatica,
  anotarManual, buscarEnFilaTolerate,
  MS_CONEXION, MS_SESION, MS_SESION_VIP, CAJONES, CAJONES_VIP
};
