const tiempo = require('./tiempo');
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
  if (!process.env.DATABASE_URL) { if (!conectarPG._avisado) { console.log('[DB_C] ⚠️ DATABASE_URL no definida — SIN persistencia (el estado se pierde al reiniciar)'); conectarPG._avisado = true; } return null; }
  try {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });
    await pool.query('CREATE TABLE IF NOT EXISTS cargadores_bot (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMP DEFAULT NOW())');
    pgClient = pool;
    console.log('[DB_C] PostgreSQL conectado');
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
  return { fila: [], lista_estatica: [], cargadores, proximoId: 1, pendiente: null, llamados: {}, bitacora_fila: [],
    lista_abierta: false, vip_abierto: false, lista_dia: tiempo.fechaMex(Date.now()), lista_auto_hecho: false };
}

// INICIALIZACIÓN
async function inicializar() {
  await conectarPG();
  try { aliasNombres = (await pgGet('alias_nombres')) || {}; } catch (e) { aliasNombres = {}; }
  const guardado = await pgGet('estado_cargadores');
  if (guardado) {
    estado = guardado;
    if (estado.pendiente === undefined) estado.pendiente = null;
    if (!estado.lista_estatica) estado.lista_estatica = [];
    if (!estado.llamados) estado.llamados = {};
    if (!estado.bitacora_fila) estado.bitacora_fila = [];
    if (estado.lista_abierta === undefined) { estado.lista_abierta = false; estado.vip_abierto = false; estado.lista_dia = tiempo.fechaMex(Date.now()); estado.lista_auto_hecho = false; }
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
  // Reinicio manual: conserva el estado de la lista del día (no la cierra ni la vuelve a anunciar)
  const l = { a: estado.lista_abierta, v: estado.vip_abierto, d: estado.lista_dia, h: estado.lista_auto_hecho };
  estado = estadoVacio();
  estado.lista_abierta = !!l.a; estado.vip_abierto = !!l.v; estado.lista_dia = l.d || estado.lista_dia; estado.lista_auto_hecho = !!l.h;
  await guardar('reinicio manual');
  return true;
}

async function reiniciarTodo() {
  estado = estadoVacio();
  await guardar('reinicio total');
  return true;
}

function getEstado() { return estado; }
function persistencia() { return !!pgClient; }

// FILA
async function agregarFila(numero, nombre) {
  const yaEsta = estado.fila.find(function(u) { return u.numero === numero; });
  if (yaEsta) return { ok: false, yaEsta: true, posicion: estado.fila.indexOf(yaEsta) + 1 };
  const item = { id: estado.proximoId++, numero, nombre: aliasNombres[numero] || nombre || numero, hora_solicitud: tiempo.ahoraISO() };
  estado.fila.push(item);
  _bit('alta', item, 'solicitud #' + estado.fila.length);
  // Registrar en lista estática (no se modifica después)
  if (!estado.lista_estatica) estado.lista_estatica = [];
  const yaEnEstatica = estado.lista_estatica.find(function(u) { return u.numero === numero; });
  if (!yaEnEstatica) {
    estado.lista_estatica.push({ nombre: item.nombre, numero, hora_solicitud: item.hora_solicitud });
  }
  await guardar('agregar fila');
  return { ok: true, posicion: estado.fila.length, item };
}

// ALIAS: nombre real de quien se anota con un nombre de WhatsApp corto ("M" → "Miguel Angel"). Persiste entre días (clave propia en BD).
let aliasNombres = {};
async function renombrarEnFila(numero, nuevo) {
  const u = estado.fila.find(function(x) { return x.numero === numero; });
  if (!u) return null;
  const antes = u.nombre;
  u.nombre = nuevo;
  (estado.lista_estatica || []).forEach(function(x) { if (x.numero === numero) x.nombre = nuevo; });
  if (estado.pendiente && estado.pendiente.numero === numero) estado.pendiente.nombre = nuevo;
  Object.keys(estado.llamados || {}).forEach(function(k) { if (k === numero) estado.llamados[k].nombre = nuevo; });
  _bit('renombre', u, '«' + antes + '» → «' + nuevo + '»');
  const persistido = !esManual(numero);
  if (persistido) { aliasNombres[numero] = nuevo; await pgSet('alias_nombres', aliasNombres); }
  await guardar('renombrar en fila');
  return { antes: antes, persistido: persistido, posicion: estado.fila.indexOf(u) + 1 };
}
function getAlias(numero) { return aliasNombres[numero] || null; }

// Entradas manuales: no tienen teléfono (numero = 'manual_N'); nunca se mencionan en Eléctricos
function esManual(numero) { return String(numero || '').indexOf('manual_') === 0; }

// Bitácora de la fila: quién entró/salió y por qué (para aclarar casos tipo "me dijeron que me anotaron y no aparezco")
function _bit(ev, u, motivo) {
  if (!estado.bitacora_fila) estado.bitacora_fila = [];
  estado.bitacora_fila.push({ h: tiempo.ahoraISO(), ev: ev, nombre: u && u.nombre, numero: u && u.numero, motivo: motivo || null });
  if (estado.bitacora_fila.length > 200) estado.bitacora_fila.splice(0, estado.bitacora_fila.length - 200);
}
function bitacoraFila(n) { return (estado.bitacora_fila || []).slice(-(n || 30)); }
// Mismo nombre: igual, o uno contiene al otro SOLO si el corto tiene ≥ 5 letras (un pushName como "A" o "Al" no debe coincidir con medio mundo)
function _mismoNombre(a, b) {
  a = String(a || '').toLowerCase().trim(); b = String(b || '').toLowerCase().trim();
  if (!a || !b) return false;
  if (a === b) return true;
  const corto = a.length <= b.length ? a : b;
  return corto.length >= 5 && (a.includes(b) || b.includes(a));
}
// Quita de la fila (y registra en la bitácora) a quien coincida con el predicado
function _sacarDeFila(pred, motivo) {
  const quedan = [];
  estado.fila.forEach(function(u) { if (pred(u)) _bit('baja', u, motivo); else quedan.push(u); });
  const n = estado.fila.length - quedan.length;
  estado.fila = quedan;
  return n;
}

// Primera posición (1-based) que se puede ocupar sin saltarse a quien ya tiene un llamado activo:
// la persona del pendiente "asignar_turno" y quienes tienen timer de conexión activo conservan su lugar.
function posicionMinima() {
  const prot = {};
  const p = estado.pendiente;
  if (p && p.tipo === 'asignar_turno' && p.numero) prot[p.numero] = true;
  for (const k in estado.cargadores) {
    const c = estado.cargadores[k];
    if (c.timer_conexion && c.timer_conexion.activo && c.numero_actual) prot[c.numero_actual] = true;
  }
  let max = -1;
  estado.fila.forEach(function(u, i) { if (prot[u.numero]) max = i; });
  return max + 2;
}
// Coloca `item` en la posición pedida (1-based), respetando llamados activos. Devuelve { posicion, ajustada }
function _colocar(item, pos) {
  if (!pos) { estado.fila.push(item); return { posicion: estado.fila.length, ajustada: false }; }
  let q = Math.min(Math.max(pos, 1), estado.fila.length + 1);
  const min = Math.min(posicionMinima(), estado.fila.length + 1);
  let ajustada = false;
  if (q < min) { q = min; ajustada = true; }
  estado.fila.splice(q - 1, 0, item);
  return { posicion: q, ajustada: ajustada };
}

// Agregar manualmente a la fila (admin) — sin número de teléfono. pos opcional (1 = el siguiente en ser llamado)
async function anotarManual(nombre, pos) {
  const yaEsta = estado.fila.find(function(u) { return u.nombre.toLowerCase() === nombre.toLowerCase(); });
  if (yaEsta) return { ok: false, yaEsta: true, posicion: estado.fila.indexOf(yaEsta) + 1 };
  const id = 'manual_' + (estado.proximoId++);
  const hora = tiempo.ahoraISO();
  const item = { id, numero: id, nombre, hora_solicitud: hora, manual: true };
  const r = _colocar(item, pos);
  if (!estado.lista_estatica) estado.lista_estatica = [];
  estado.lista_estatica.push({ nombre, numero: id, hora_solicitud: hora });
  await guardar('anotar manual ' + nombre);
  return { ok: true, posicion: r.posicion, ajustada: r.ajustada, item };
}

// Mover a alguien que ya está en la fila a otra posición (admin)
async function moverEnFila(numero, pos) {
  const idx = estado.fila.findIndex(function(u) { return u.numero === numero; });
  if (idx === -1) return null;
  const desde = idx + 1;
  const item = estado.fila.splice(idx, 1)[0];
  const r = _colocar(item, pos);
  await guardar('mover en fila');
  return { posicion: r.posicion, ajustada: r.ajustada, desde: desde, item };
}

async function moverAlFinal(numero) {
  const idx = estado.fila.findIndex(function(u) { return u.numero === numero; });
  if (idx === -1) return null;
  const item = estado.fila.splice(idx, 1)[0];
  item.hora_solicitud = tiempo.ahoraISO();
  estado.fila.push(item);
  _bit('final', item, 'movido al final #' + estado.fila.length);
  if (estado.llamados) delete estado.llamados[numero];
  await guardar('mover al final');
  return { posicion: estado.fila.length, item };
}

async function quitarFila(numero) {
  const idx = estado.fila.findIndex(function(u) { return u.numero === numero; });
  if (idx === -1) return { ok: false, msg: 'Usuario no encontrado en la fila' };
  const item = estado.fila.splice(idx, 1)[0];
  _bit('baja', item, 'quitar (admin)');
  await guardar('quitar fila');
  return { ok: true, nombre: item.nombre };
}

function primeroEnFila() { return estado.fila[0] || null; }

// CARGADORES
// Lista del día y cajones VIP
function listaAbierta() { return !!estado.lista_abierta; }
function vipAbierto() { return !!estado.vip_abierto; }
async function setLista(v) { estado.lista_abierta = !!v; estado.lista_dia = tiempo.fechaMex(Date.now()); estado.lista_auto_hecho = true; await guardar('lista ' + (v ? 'abierta' : 'cerrada')); }
async function setVip(v) { estado.vip_abierto = !!v; await guardar('vip ' + (v ? 'abierto' : 'cerrado')); }
async function nuevoDiaLista(hoy) { estado.lista_dia = hoy; estado.lista_abierta = false; estado.vip_abierto = false; estado.lista_auto_hecho = false; await guardar('nuevo dia'); }
// Cajones que cuentan para la fila general (VIP solo si un admin los abrió)
function cajonesActivos() { return CAJONES.filter(function(c) { return !CAJONES_VIP.has(c) || estado.vip_abierto; }); }

function cargadorLibre() {
  for (const cajon of cajonesActivos()) {
    const c = estado.cargadores[cajon];
    if (!c.ocupado && !c.timer_conexion.activo) return c;
  }
  return null;
}

function numLibresTotal() {
  return CAJONES.filter(function(cajon) {
    const c = estado.cargadores[cajon];
    return !c.ocupado && !c.timer_conexion.activo;
  }).length;
}

function numLibres() {
  return cajonesActivos().filter(function(cajon) {
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
  c.timer_conexion = { activo: true, hora_inicio: tiempo.ahoraISO(), duracion_ms: MS_CONEXION, extensiones: 0 };
  await guardar('timer conexion ' + cajon);
  return c;
}

async function extenderTimerConexion(cajon) {
  cajon = String(cajon);
  const c = estado.cargadores[cajon];
  if (!c || !c.timer_conexion.activo) return null;
  c.timer_conexion.hora_inicio = tiempo.ahoraISO();
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
  c.hora_inicio    = tiempo.ahoraISO();
  c.timer_conexion = { activo: false, hora_inicio: null, duracion_ms: MS_CONEXION, extensiones: 0 };
  c.timer_sesion   = { activo: true, hora_inicio: tiempo.ahoraISO(), duracion_ms: msSesion };
  _sacarDeFila(function(u) { return u.numero === c.numero_actual; }, 'confirmó conexión en cajón ' + cajon);
  if (estado.llamados && c.numero_actual) delete estado.llamados[c.numero_actual];
  await guardar('conexion confirmada ' + cajon);
  return c;
}

async function liberarCajon(cajon) {
  cajon = String(cajon);
  const c = estado.cargadores[cajon];
  if (!c) return null;
  const nombre = c.usuario_actual;
  estado.cargadores[cajon] = cajonVacio(cajon);
  Object.keys(estado.llamados || {}).forEach(function(k) { if (estado.llamados[k].cajon === cajon) delete estado.llamados[k]; });
  await guardar('liberar ' + cajon);
  return { cajon, nombre };
}

// Conectar usuario manualmente (comando admin)
// numero puede ser null si no está en la fila
async function conectarUsuario(cajon, nombre, numero, horaInicio, extra) {
  cajon = String(cajon);
  const c = estado.cargadores[cajon];
  if (!c) return null;
  const msSesion = c.vip ? MS_SESION_VIP : MS_SESION;
  // Usar horaInicio si viene (matutino), si no usar ahora
  const inicio = horaInicio ? horaInicio : tiempo.ahoraISO();
  c.ocupado        = true;
  c.usuario_actual = nombre;
  c.numero_actual  = numero || null;
  c.hora_inicio    = inicio;
  if (extra) { c.marca = extra.marca || null; c.placas = extra.placas || null; }
  c.timer_conexion = { activo: false, hora_inicio: null, duracion_ms: MS_CONEXION, extensiones: 0 };
  c.timer_sesion   = { activo: true, hora_inicio: inicio, duracion_ms: msSesion };
  // Sacar de la fila si está
  if (numero) {
    _sacarDeFila(function(u) { return u.numero === numero; }, 'conectado en cajón ' + cajon + ' (' + nombre + ')');
  } else {
    // Sacar por nombre si no hay número
    _sacarDeFila(function(u) { return _mismoNombre(u.nombre, nombre); }, 'conectado por nombre en cajón ' + cajon + ' (' + nombre + ')');
  }
  if (estado.llamados && numero) delete estado.llamados[numero];
  await guardar('conectar ' + nombre + ' en ' + cajon);
  return c;
}

// Cumplió su tiempo (3 h / 8 h VIP): el cajón sigue ocupado hasta que el ayudante lo reporte libre
async function marcarTiempoCumplido(cajon) {
  cajon = String(cajon);
  const c = estado.cargadores[cajon];
  if (!c || !c.ocupado) return null;
  c.timer_sesion = Object.assign({}, c.timer_sesion, { activo: false, cumplido: true });
  c.recordatorios = 0;
  await guardar('tiempo cumplido ' + cajon);
  return c;
}
async function marcarRecordatorios(cajon, n) {
  const c = estado.cargadores[String(cajon)];
  if (!c || !c.ocupado) return;
  c.recordatorios = n;
  await guardar('recordatorios ' + cajon);
}

// "45 desde 1:30": corrige la hora de conexión de quien ocupa el cajón y recalcula su fin de sesión
async function ajustarInicio(cajon, horaStr) {
  cajon = String(cajon);
  const c = estado.cargadores[cajon];
  if (!c || !c.ocupado) return null;
  const iso = tiempo.horaLaboralAISO(horaStr);
  if (!iso) return null;
  const ms = c.vip ? MS_SESION_VIP : MS_SESION;
  const ini = new Date(iso).getTime();
  const ahora = tiempo.ahoraMs();
  if (ini > ahora + 60000) return { futura: true, iso: iso };
  const fin = ini + ms;
  c.hora_inicio = iso;
  c.timer_sesion = { activo: fin > ahora, hora_inicio: iso, duracion_ms: ms };
  if (fin <= ahora) c.timer_sesion.vencido = true;
  await guardar('ajustar inicio ' + cajon);
  return { iso: iso, fin: fin, vencido: fin <= ahora, nombre: c.usuario_actual };
}

// Ocupantes actuales (para búsquedas por nombre)
function ocupantes() {
  const out = [];
  for (const cajon of CAJONES) {
    const c = estado.cargadores[cajon];
    if (c.ocupado && c.usuario_actual) out.push({ id: cajon, nombre: c.usuario_actual, numero: (c.numero_actual && !esManual(c.numero_actual)) ? c.numero_actual : null });
  }
  return out;
}

// "44 es Nombre": corrige el nombre de quien ocupa un cajón y lo saca de la fila si estaba
async function renombrarOcupante(cajon, nombre) {
  cajon = String(cajon);
  const c = estado.cargadores[cajon];
  if (!c || !c.ocupado) return null;
  c.usuario_actual = nombre;
  const nl = nombre.toLowerCase();
  const enFila = estado.fila.find(function(u) { return _mismoNombre(u.nombre, nombre); });
  if (enFila) { c.numero_actual = esManual(enFila.numero) ? null : enFila.numero; _sacarDeFila(function(u) { return u === enFila; }, 'renombrado cajón ' + cajon + ' (' + nombre + ')'); }
  await guardar('renombrar ocupante ' + cajon);
  return c;
}

// Interruptor "silencio": corta todo lo que sale a Eléctricos (persiste entre deploys)
async function cargarSilencio() { return !!(await pgGet('silencio')); }
async function guardarSilencio(v) { return pgSet('silencio', !!v); }

// IDs de grupos de WhatsApp (persisten entre deploys)
async function cargarGrupos() { return (await pgGet('grupos_ids')) || {}; }
async function guardarGrupos(g) { return pgSet('grupos_ids', g); }

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
    if (!c.vip && !item.horaInicio) {
      // Sin hora de conexión: no se inventa. Queda ocupado, sin timer, marcado "sin hora".
      c.timer_sesion = { activo: false, hora_inicio: null, duracion_ms: MS_SESION, sin_hora: true };
    } else if (!c.vip) {
      const msSesion = MS_SESION;
      const horaStr = item.horaInicio;
      const inicio  = _parsearHoraHoy(horaStr);
      if (inicio) {
        c.hora_inicio = inicio.toISOString();
        const finMs   = inicio.getTime() + msSesion;
        const ahoraMs = tiempo.ahoraMs();
        if (finMs > ahoraMs) {
          c.timer_sesion = { activo: true, hora_inicio: inicio.toISOString(), duracion_ms: msSesion };
        } else {
          // Ya venció — guardar hora para mostrar en resumen pero marcar inactivo
          c.timer_sesion = { activo: false, hora_inicio: inicio.toISOString(), duracion_ms: msSesion, vencido: true };
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
  _sacarDeFila(function(u) { return nombresConectados.some(function(n) { return _mismoNombre(u.nombre, n); }); }, 'reporte matutino (ya conectado)');
  const sacados = filaAntes - estado.fila.length;

  await guardar('estado inicial cargado');
  return { ok: true, sacados };
}

// PENDIENTE
async function setPendiente(p) { estado.pendiente = p; await guardar('pendiente'); }
function getPendiente() { return estado.pendiente; }

// LLAMADOS: a quién se le avisó "ya hay un lugar" y para qué cajón (sirve para detectar "no puedo bajar").
// Se guarda en BD para sobrevivir reinicios; caduca a las 2 h y se limpia en el reinicio de medianoche.
const MS_LLAMADO_VIGENTE = 2 * 60 * 60 * 1000;
function _dig(x) { return String(x || '').replace(/@.*$/, '').replace(/\D/g, ''); }
async function marcarLlamado(numero, cajon, nombre) {
  if (!estado.llamados) estado.llamados = {};
  estado.llamados[numero] = { cajon: String(cajon), nombre: nombre, hora: tiempo.ahoraISO() };
  await guardar('llamado ' + cajon);
}
async function limpiarLlamado(numero) {
  if (estado.llamados && estado.llamados[numero]) { delete estado.llamados[numero]; await guardar('limpiar llamado'); }
}
async function limpiarLlamadosCajon(cajon) {
  cajon = String(cajon);
  let n = 0;
  Object.keys(estado.llamados || {}).forEach(function(k) { if (estado.llamados[k].cajon === cajon) { delete estado.llamados[k]; n++; } });
  if (n) await guardar('limpiar llamados cajon ' + cajon);
}
// Llamado vigente de una persona: { numero, cajon, nombre, fase: 'llamado' | 'turno' } o null.
//  - 'llamado': se le avisó, el cajón sigue libre y ella sigue en la fila
//  - 'turno'  : el ayudante ya confirmó (sí) y corre su ventana de 15 min en ese cajón
function getLlamadoActivo(numero) {
  const dn = _dig(numero);
  if (!dn) return null;
  for (const cajon of CAJONES) {
    const c = estado.cargadores[cajon];
    if (c && !c.ocupado && c.timer_conexion && c.timer_conexion.activo && _dig(c.numero_actual) === dn) {
      return { numero: c.numero_actual, cajon: cajon, nombre: c.usuario_actual, fase: 'turno', desde: c.timer_conexion.hora_inicio };
    }
  }
  const k = Object.keys(estado.llamados || {}).find(function(x) { return _dig(x) === dn; });
  if (!k) return null;
  const ll = estado.llamados[k];
  if (tiempo.ahoraMs() - new Date(ll.hora).getTime() > MS_LLAMADO_VIGENTE) return null;
  const c = estado.cargadores[ll.cajon];
  if (!c || c.ocupado || (c.timer_conexion && c.timer_conexion.activo)) return null;   // el cajón ya se ocupó
  if (!estado.fila.some(function(u) { return u.numero === k; })) return null;           // ya no está en la fila
  return { numero: k, cajon: ll.cajon, nombre: ll.nombre, fase: 'llamado', desde: ll.hora };
}

// TIEMPO ESTIMADO
function tiempoEstimado(posicion) {
  const libres = numLibres();
  if (posicion <= libres) return 0;
  return Math.ceil((posicion - libres) / cajonesActivos().length) * 3;
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
      // Mostrar hora de fin aunque el timer ya haya vencido
      if (c.timer_sesion && c.timer_sesion.sin_hora) {
        fin = null;
      } else if (c.vip && !(c.timer_sesion && c.timer_sesion.hora_inicio)) {
        fin = 'carga extendida';
      } else if (c.timer_sesion && c.timer_sesion.hora_inicio) {
        fin = _horaLocal(new Date(new Date(c.timer_sesion.hora_inicio).getTime() + c.timer_sesion.duracion_ms).toISOString());
      } else if (c.hora_inicio) {
        fin = _horaLocal(new Date(new Date(c.hora_inicio).getTime() + MS_SESION).toISOString());
      }
      const cumplido = c.timer_sesion && c.timer_sesion.cumplido ? ' ⏰ tiempo cumplido' : '';
      txt += '🔴 Cajón ' + cajon + vipTag + ': ' + c.usuario_actual + (fin === null ? ' (sin hora)' : fin === 'carga extendida' ? ' (carga extendida)' : ' hasta ' + fin) + cumplido;
      if (c.placas) txt += ' (' + c.placas + ')';
      txt += '\n';
    } else if (c.timer_conexion && c.timer_conexion.activo) {
      const fin = _horaLocal(new Date(new Date(c.timer_conexion.hora_inicio).getTime() + c.timer_conexion.duracion_ms).toISOString());
      txt += '🟡 Cajón ' + cajon + vipTag + ': esperando a ' + c.usuario_actual + ' hasta ' + fin + '\n';
    } else {
      txt += '🟢 Cajón ' + cajon + vipTag + ': Libre\n';
    }
  }
  txt += '\n*' + numLibres() + '/' + cajonesActivos().length + ' libres*' + (estado.vip_abierto ? ' (VIP abierto)' : ' (46 y 50 solo MD)');
  return txt;
}

function resumenCompleto() { return resumenCargadores() + '\n\n' + resumenFila(); }

function resumenListaEstatica() {
  if (!estado.lista_estatica || !estado.lista_estatica.length) {
    return '📋 *Lista estática*\n\nNo hay registros de hoy todavía.';
  }
  let txt = '📋 *Lista estática — orden de llegada*\n\n';
  estado.lista_estatica.forEach(function(u, i) {
    const hora = tiempo.horaLocal(u.hora_solicitud);
    txt += (i + 1) + '. ' + u.nombre + ' — ' + hora + '\n';
  });
  return txt;
}

// UTILS
function _horaLocal(iso) {
  return tiempo.horaLocal(iso);
}

function _parsearHoraHoy(horaStr) {
  const iso = tiempo.horaLaboralAISO(horaStr);
  return iso ? new Date(iso) : null;
}

module.exports = {
  inicializar, getEstado, persistencia, guardar, reiniciar, reiniciarTodo,
  agregarFila, moverAlFinal, quitarFila, primeroEnFila,
  cargadorLibre, numLibres, numLibresTotal, tiempoEstimado, listaAbierta, vipAbierto, setLista, setVip, nuevoDiaLista, cajonesActivos,
  iniciarTimerConexion, extenderTimerConexion, confirmarConexion, liberarCajon,
  conectarUsuario, buscarCajonDeUsuario, buscarEnFila,
  cargarEstadoInicial, ocupantes, renombrarOcupante, ajustarInicio, marcarTiempoCumplido, marcarRecordatorios, cargarGrupos, guardarGrupos, cargarSilencio, guardarSilencio,
  setPendiente, getPendiente, marcarLlamado, limpiarLlamado, limpiarLlamadosCajon, getLlamadoActivo,
  resumenFila, resumenCargadores, resumenCompleto, resumenListaEstatica,
  bitacoraFila, renombrarEnFila, getAlias, anotarManual, moverEnFila, posicionMinima, esManual, buscarEnFilaTolerate,
  MS_CONEXION, MS_SESION, MS_SESION_VIP, CAJONES, CAJONES_VIP
};
