// test/sim.js — Simulador con reloj falso. Sin red, sin Postgres, sin API.
// Uso: node test/sim.js
process.env.DATABASE_URL = '';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'x';
const { mock } = require('node:test');

const MIN = 60 * 1000, HORA = 60 * MIN;
// 2026-11-03 07:00 México = 13:00 UTC
const T0 = Date.UTC(2026, 10, 3, 13, 0, 0);
mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: T0 });

const db = require('../src/db_cargadores');
const timers = require('../src/timers');
const tiempo = require('../src/tiempo');

const grupoProyecto = [];
const grupoElectricos = [];
timers.setEnviarFn(async function(t) { grupoProyecto.push(t); });
timers.setEnviarElectricosFn(async function(t, num) { grupoElectricos.push({ t, num }); });

// Avanza el reloj y deja correr los handlers async
async function avanzar(ms) {
  mock.timers.tick(ms);
  for (let i = 0; i < 5; i++) await new Promise(function(r) { setImmediate(r); });
}

let ok = 0, fail = 0;
function check(desc, cond, extra) {
  if (cond) { console.log('  ✅ ' + desc); ok++; }
  else { console.log('  ❌ ' + desc + (extra ? ' → ' + extra : '')); fail++; }
}
function limpiar() { grupoProyecto.length = 0; grupoElectricos.length = 0; }

async function reset() {
  await db.reiniciarTodo();
  limpiar();
}

// Conexión confirmada con timer de sesión (equivale a "X conectó en cajón N")
async function conectar(cajon, nombre, numero) {
  await db.conectarUsuario(cajon, nombre, numero);
  await timers.iniciarTimerSesion(cajon);
}

(async function main() {
  await db.inicializar();
  console.log('\n🧪 SIMULADOR — hora inicial ' + tiempo.horaLocal(Date.now()) + ' (México)\n');

  console.log('Escenario 1: sesión de 3 h con aviso a los 2:45 y liberación a las 3:00');
  await reset();
  await db.agregarFila('111', 'Tania');
  await conectar('44', 'Juan Orta', '222');
  await avanzar(2 * HORA + 44 * MIN);
  check('antes de 2:45 no hay avisos', grupoElectricos.length === 0 && grupoProyecto.length === 0);
  await avanzar(1 * MIN + 1000);
  check('a los 2:45 aviso en Eléctricos con mención', grupoElectricos.length === 1 && grupoElectricos[0].num === '222',
    JSON.stringify(grupoElectricos));
  check('cajón 44 sigue ocupado a los 2:45', db.getEstado().cargadores['44'].ocupado === true);
  limpiar();
  await avanzar(15 * MIN);
  check('a las 3:00 el cajón 44 se libera', db.getEstado().cargadores['44'].ocupado === false);
  check('a las 3:00 se avisa en Eléctricos', grupoElectricos.length === 1, JSON.stringify(grupoElectricos));
  check('a las 3:00 se propone al primero de la fila (Tania)', grupoProyecto.some(function(t) { return t.includes('Tania'); }),
    JSON.stringify(grupoProyecto));

  console.log('\nEscenario 2: llamada de turno y vencimiento a los 15 min');
  await reset();
  await db.agregarFila('111', 'Tania');
  await timers.iniciarTimerConexion('41', 'Tania', '111');
  await avanzar(14 * MIN);
  check('a los 14 min aún no vence', grupoProyecto.length === 0);
  await avanzar(1 * MIN + 1000);
  check('a los 15 min se pregunta en Proyecto Bot', grupoProyecto.some(function(t) { return t.includes('Tiempo de conexión vencido'); }),
    JSON.stringify(grupoProyecto));

  console.log('\nEscenario 3: VIP (cajón 46) dura 8 h');
  await reset();
  await conectar('46', 'Cesar Mora', '333');
  await avanzar(3 * HORA + 1 * MIN);
  check('VIP sigue ocupado a las 3 h', db.getEstado().cargadores['46'].ocupado === true);
  await avanzar(5 * HORA);
  check('VIP se libera a las 8 h', db.getEstado().cargadores['46'].ocupado === false);

  console.log('\nEscenario 4: reinicio del bot (reactivarTimers recalcula tiempo restante)');
  await reset();
  await conectar('42', 'Euguenia Cesar', '444');
  timers.cancelarTimerSesion('42');
  await avanzar(1 * HORA);
  await timers.reactivarTimers();
  await avanzar(2 * HORA + 1 * MIN);
  check('tras reinicio, la sesión vence a las 3 h reales desde la conexión', db.getEstado().cargadores['42'].ocupado === false);

  console.log('\nEscenario 6: liberar un cajón cancela también el aviso de 15 min (no avisa al siguiente ocupante)');
  await reset();
  mock.timers.setTime(T0);
  await conectar('48', 'Primero', '555');
  await avanzar(2 * HORA + 40 * MIN);
  timers.cancelarTimerConexion('48'); timers.cancelarTimerSesion('48');
  await db.liberarCajon('48');
  await conectar('48', 'Segundo', '666');
  limpiar();
  await avanzar(10 * MIN);
  check('el aviso del ocupante anterior NO le llega al siguiente', !grupoElectricos.some(function(m) { return m.num === '666' && /faltan 15 minutos/.test(m.t); }), JSON.stringify(grupoElectricos));

  console.log('\nEscenario 5: medianoche México');
  mock.timers.setTime(T0);
  check('de 07:00 a medianoche faltan 17 h', Math.round(tiempo.msHastaMedianoche() / HORA) === 17, String(tiempo.msHastaMedianoche() / HORA));
  mock.timers.setTime(Date.UTC(2026, 10, 4, 5, 59, 0));
  check('a las 23:59 falta 1 min', Math.round(tiempo.msHastaMedianoche() / MIN) === 1);

  console.log('\n' + '─'.repeat(50));
  console.log('Resultado: ' + ok + '/' + (ok + fail) + ' ✅  ' + fail + ' ❌');
  mock.timers.reset();
  process.exit(fail ? 1 : 0);
})().catch(function(e) { console.error('💥', e); process.exit(2); });
