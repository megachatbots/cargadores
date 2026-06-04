// src/db.js — Estado + PostgreSQL para bot de cargadores eléctricos
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const CAJONES_VALIDOS = new Set(['41','42','44','45','46','48','49','50']);
const HORAS_MAX = 3;

let pgClient = null;
let pgInitPromise = null;
let estado = null;
// estado: { cargadores, fila, historial, proximoId }

// ─── POSTGRES ─────────────────────────────────────────────────────────
async function conectarPG() {
  if (pgClient) return pgClient;
  if (!process.env.DATABASE_URL) { console.log('[DB] Sin DATABASE_URL — solo memoria/archivo'); return null; }
  if (pgInitPromise) return pgInitPromise;
  pgInitPromise = (async () => {
    try {
      const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 });
      await pool.query(`CREATE TABLE IF NOT EXISTS cargadores_bot (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMP DEFAULT NOW())`);
      await pool.query(`CREATE TABLE IF NOT EXISTS cargadores_logs (id SERIAL PRIMARY KEY, ts TIMESTAMP DEFAULT NOW(), fecha DATE DEFAULT CURRENT_DATE, linea TEXT NOT NULL)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS cargadores_logs_fecha_idx ON cargadores_logs(fecha)`);
      pgClient = pool;
      console.log('[DB] PostgreSQL conectado ✅');
      return pgClient;
    } catch (e) { console.error('[DB] Error PG:', e.message); pgInitPromise = null; return null; }
  })();
  return pgInitPromise;
}

async function pgLog(linea) {
  const c = await conectarPG(); if (!c) return;
  try { await c.query('INSERT INTO cargadores_logs (linea) VALUES ($1)', [linea]); } catch (e) {}
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
  } catch (e) { console.error('[DB] pgSet:', e.message); return false; }
}

// ─── INICIALIZACIÓN ───────────────────────────────────────────────────
async function inicializar() {
  await conectarPG();
  const guardado = await pgGet('estado');
  if (guardado) {
    estado = guardado;
    console.log('[DB] Estado cargado desde PostgreSQL');
  } else {
    const local = path.join(__dirname, '..', 'datos', 'estado_local.json');
    if (fs.existsSync(local)) {
      estado = JSON.parse(fs.readFileSync(local, 'utf8'));
      console.log('[DB] Estado cargado desde archivo local');
    } else {
      const inicial = path.join(__dirname, '..', 'datos', 'estado_inicial.json');
      estado = JSON.parse(fs.readFileSync(inicial, 'utf8'));
      console.log('[DB] Estado nuevo inicializado');
    }
    await guardar('init');
  }
  return estado;
}

async function guardar(motivo = 'cambio') {
  await pgSet('estado', estado);
  try {
    fs.writeFileSync(
      path.join(__dirname, '..', 'datos', 'estado_local.json'),
      JSON.stringify(estado, null, 2)
    );
  } catch (e) {}
}

function getEstado() { return estado; }

// ─── FILA ─────────────────────────────────────────────────────────────
// Agrega a la fila. Devuelve { ok, posicion, msg }
async function agregarFila(numero, nombre) {
  // Ya está en la fila?
  const yaEsta = estado.fila.find(u => u.numero === numero);
  if (yaEsta) {
    const pos = estado.fila.indexOf(yaEsta) + 1;
    return { ok: false, yaEsta: true, posicion: pos, msg: `Ya estás en la fila en la posición ${pos}` };
  }
  const item = {
    id: estado.proximoId++,
    numero,
    nombre: nombre || numero,
    solicitado: new Date().toISOString()
  };
  estado.fila.push(item);
  _historial('fila_entrada', { numero, nombre: item.nombre });
  await guardar('agregar fila');
  return { ok: true, posicion: estado.fila.length, item };
}

// Elimina de la fila por número. Devuelve { ok, msg }
async function quitarFila(numero) {
  const idx = estado.fila.findIndex(u => u.numero === numero);
  if (idx === -1) return { ok: false, msg: 'Usuario no encontrado en la fila' };
  const [item] = estado.fila.splice(idx, 1);
  _historial('fila_salida', { numero, nombre: item.nombre, motivo: 'admin' });
  await guardar('quitar fila');
  return { ok: true, nombre: item.nombre };
}

// ─── CARGADORES ───────────────────────────────────────────────────────
// Registra conexión en un cajón. nombre puede ser display name.
async function conectar(cajon, nombre, marca, placas) {
  cajon = String(cajon);
  if (!CAJONES_VALIDOS.has(cajon)) return { ok: false, msg: `Cajón ${cajon} no existe` };
  const c = estado.cargadores[cajon];
  if (c.estado === 'ocupado') return { ok: false, ocupado: true, nombre: c.nombre, msg: `Cajón ${cajon} ya está ocupado por ${c.nombre}` };
  if (c.estado === 'bloqueado') return { ok: false, msg: `Cajón ${cajon} está bloqueado` };

  const ahora = new Date();
  const hasta = new Date(ahora.getTime() + HORAS_MAX * 60 * 60 * 1000);

  estado.cargadores[cajon] = {
    estado: 'ocupado',
    nombre: nombre || '?',
    usuario: null, // se puede enriquecer en fases futuras
    desde: ahora.toISOString(),
    hasta: hasta.toISOString(),
    marca: marca || null,
    placas: placas || null
  };
  _historial('conexion', { cajon, nombre, marca, placas, desde: ahora.toISOString(), hasta: hasta.toISOString() });
  await guardar(`conectar cajón ${cajon}`);
  return { ok: true, cajon, nombre, desde: ahora, hasta };
}

// Registra desconexión / libera un cajón
async function liberar(cajon) {
  cajon = String(cajon);
  if (!CAJONES_VALIDOS.has(cajon)) return { ok: false, msg: `Cajón ${cajon} no existe` };
  const c = estado.cargadores[cajon];
  const nombreAntes = c.nombre;
  const eraLibre = c.estado === 'libre';

  estado.cargadores[cajon] = {
    estado: 'libre', nombre: null, usuario: null,
    desde: null, hasta: null, marca: null, placas: null
  };
  _historial('desconexion', { cajon, nombre: nombreAntes });
  await guardar(`liberar cajón ${cajon}`);
  return { ok: true, cajon, nombre: nombreAntes, eraLibre };
}

// Bloquea un cajón por mantenimiento
async function bloquear(cajon) {
  cajon = String(cajon);
  if (!CAJONES_VALIDOS.has(cajon)) return { ok: false, msg: `Cajón ${cajon} no existe` };
  const anteriorNombre = estado.cargadores[cajon].nombre;
  estado.cargadores[cajon] = {
    estado: 'bloqueado', nombre: null, usuario: null,
    desde: null, hasta: null, marca: null, placas: null
  };
  _historial('bloqueo', { cajon });
  await guardar(`bloquear cajón ${cajon}`);
  return { ok: true, cajon, anteriorNombre };
}

// Marca un cajón como en falla
async function marcarFalla(cajon) {
  cajon = String(cajon);
  if (!CAJONES_VALIDOS.has(cajon)) return { ok: false, msg: `Cajón ${cajon} no existe` };
  estado.cargadores[cajon].estado = 'falla';
  _historial('falla', { cajon });
  await guardar(`falla cajón ${cajon}`);
  return { ok: true, cajon };
}

// Carga el reporte matutino completo (array de objetos por cajón)
// items: [{ cajon, estado, nombre, marca, placas, desde }]
async function cargarReporteMatutino(items) {
  for (const item of items) {
    const cajon = String(item.cajon);
    if (!CAJONES_VALIDOS.has(cajon)) continue;
    if (item.estado === 'libre') {
      estado.cargadores[cajon] = { estado: 'libre', nombre: null, usuario: null, desde: null, hasta: null, marca: null, placas: null };
    } else if (item.estado === 'ocupado') {
      // Calcular hasta = desde + 3h si no está disponible
      let hasta = null;
      if (item.desde) {
        const d = new Date(item.desde);
        hasta = new Date(d.getTime() + HORAS_MAX * 60 * 60 * 1000).toISOString();
      }
      estado.cargadores[cajon] = {
        estado: 'ocupado',
        nombre: item.nombre || '?',
        usuario: null,
        desde: item.desde || null,
        hasta,
        marca: item.marca || null,
        placas: item.placas || null
      };
    } else if (item.estado === 'bloqueado') {
      estado.cargadores[cajon] = { estado: 'bloqueado', nombre: null, usuario: null, desde: null, hasta: null, marca: null, placas: null };
    }
  }
  _historial('reporte_matutino', { items: items.length });
  await guardar('reporte matutino');
  return { ok: true, procesados: items.length };
}

// ─── RESUMEN ──────────────────────────────────────────────────────────
function resumenCargadores() {
  const emojis = { libre: '🟢', ocupado: '🔴', bloqueado: '⛔', falla: '⚠️' };
  const CAJONES = ['41','42','44','45','46','48','49','50'];
  let txt = '🔌 *Estado de cargadores*\n\n';
  for (const cajon of CAJONES) {
    const c = estado.cargadores[cajon];
    const e = emojis[c.estado] || '❓';
    if (c.estado === 'ocupado') {
      const hasta = c.hasta ? _horaLocal(c.hasta) : '?';
      txt += `${e} Cajón ${cajon}: ${c.nombre} hasta ${hasta}`;
      if (c.placas) txt += ` (${c.placas})`;
      txt += '\n';
    } else if (c.estado === 'libre') {
      txt += `${e} Cajón ${cajon}: Libre\n`;
    } else if (c.estado === 'bloqueado') {
      txt += `${e} Cajón ${cajon}: Bloqueado\n`;
    } else if (c.estado === 'falla') {
      txt += `${e} Cajón ${cajon}: Falla\n`;
    }
  }
  const libres = CAJONES.filter(n => estado.cargadores[n].estado === 'libre').length;
  txt += `\n*${libres}/8 libres*`;
  return txt;
}

function resumenFila() {
  if (!estado.fila.length) return '📋 *Fila de espera*\n\nNo hay nadie en la fila ✅';
  let txt = `📋 *Fila de espera* (${estado.fila.length} personas)\n\n`;
  estado.fila.forEach((u, i) => {
    const ts = _horaLocal(u.solicitado);
    txt += `${i + 1}. ${u.nombre} — desde ${ts}\n`;
  });
  return txt;
}

function snapshotTexto() {
  return resumenCargadores() + '\n\n' + resumenFila();
}

// ─── HISTORIAL ────────────────────────────────────────────────────────
function _historial(tipo, datos) {
  estado.historial.push({ t: new Date().toISOString(), tipo, ...datos });
  // Mantener solo los últimos 500 eventos
  if (estado.historial.length > 500) estado.historial = estado.historial.slice(-500);
}

// ─── UTILS ────────────────────────────────────────────────────────────
function _horaLocal(iso) {
  if (!iso) return '?';
  return new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' });
}

function cajonValido(n) { return CAJONES_VALIDOS.has(String(n)); }

module.exports = {
  inicializar, getEstado, guardar,
  agregarFila, quitarFila,
  conectar, liberar, bloquear, marcarFalla, cargarReporteMatutino,
  resumenCargadores, resumenFila, snapshotTexto,
  cajonValido, pgLog, CAJONES_VALIDOS
};
