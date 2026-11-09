// test/test_lista.js — Lista del día, VIP y horarios especiales (reloj falso, sin red)
process.env.DATABASE_URL = ''; process.env.ANTHROPIC_API_KEY = 'x';
const { mock } = require('node:test');
const H = 60 * 60 * 1000, MIN = 60 * 1000;
const mx = function(d, h, m) { return Date.UTC(2026, 10, d, h + 6, m || 0, 0); };   // Nov 2026 (México UTC-6)
mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: mx(3, 6, 0) });  // martes 3, 6:00
const db = require('../src/db_cargadores');
const timers = require('../src/timers');
const tiempo = require('../src/tiempo');
const motor = require('../src/motor_cargadores');
const E = [], P = [];
timers.setEnviarFn(async function(t) { P.push(t); });
timers.setEnviarElectricosFn(async function(t, n) { E.push({ t: t, m: n }); });
const control = require('../src/control').crear({ db: db, timers: timers, tiempo: tiempo,
  enviarElectricos: async function(t, m) { E.push({ t: t, m: m }); }, enviarProyectoBot: async function(t) { P.push(t); }, procesarReporte: async function() {} });
let conectado = true;
const lista = require('../src/lista').crear({ db: db, tiempo: tiempo, listo: function() { return conectado; },
  enviarElectricos: async function(t, m) { E.push({ t: t, m: m }); } });

let ok = 0, fail = 0;
function check(d, c, x) { if (c) { ok++; console.log('  ✅ ' + d); } else { fail++; console.log('  ❌ ' + d + (x ? ' → ' + x : '')); } }
const limpiar = function() { E.length = 0; P.length = 0; };
async function en(d, h, m) { mock.timers.setTime(mx(d, h, m)); return lista.tick(); }
const cj = function(n) { return db.getEstado().cargadores[n]; };

(async function() {
  await db.inicializar();
  console.log('\n1) Apertura automática 8:00 L–V');
  await db.reiniciarTodo(); limpiar();
  await en(3, 6, 0);
  check('6:00 lista cerrada', !db.listaAbierta());
  await en(3, 7, 58);
  check('7:58 sigue cerrada y no se escribe nada', !db.listaAbierta() && E.length === 0);
  const r = await en(3, 7, 59);
  check('7:59 se abre (1 min antes, para no perder a quien escribe a las 8:00 en punto) y se envía el mensaje de inicio', r === 'abierta' && db.listaAbierta() && E.length === 1 && /Lista de espera abierta/.test(E[0].t), JSON.stringify(E));
  check('el mensaje incluye: 15 min, 3 h, 46/50 solo MD, omitir antes de 8, sin horarios especiales',
    /15 minutos/.test(E[0].t) && /3 horas/.test(E[0].t) && /46 y 50 son solo para MD/.test(E[0].t) && /antes de las 8:00 a\.m\. se omiten/.test(E[0].t) && /No se toman en cuenta horarios especiales/.test(E[0].t));
  await en(3, 8, 0); await en(3, 8, 1); await en(3, 9, 0);
  check('no se vuelve a anunciar', E.length === 1);
  await en(3, 20, 0);
  check('20:00 se cierra', !db.listaAbierta());

  console.log('\n2) Cierre manual no se reabre; sin conexión espera; fin de semana no abre');
  await db.reiniciarTodo(); limpiar();
  await en(4, 8, 0); limpiar();
  await lista.cerrar();
  await en(4, 8, 30);
  check('tras "cerrar lista" no se reabre sola', !db.listaAbierta() && E.length === 0);
  await en(5, 7, 0); conectado = false;
  const w = await en(5, 7, 59);
  check('sin conexión no se abre ni se marca como hecha', w === 'esperando' && !db.listaAbierta());
  conectado = true;
  await en(5, 8, 1);
  check('al reconectar se abre', db.listaAbierta());
  limpiar();
  await en(6, 0, 5);
  check('cambio de día: cerrada y VIP cerrado', !db.listaAbierta() && !db.vipAbierto());
  await en(6, 9, 0);
  check('viernes 6 a las 9:00 sigue abriendo (rezagada)', db.listaAbierta());
  limpiar();
  await en(7, 0, 5); await en(7, 9, 0); await en(8, 9, 0);
  check('sábado y domingo no se abre', !db.listaAbierta() && E.length === 0);

  console.log('\n3) VIP 46/50: fuera de la fila general hasta "abrir vip"');
  await db.reiniciarTodo(); limpiar();
  mock.timers.setTime(mx(9, 9, 0));
  for (const c of ['41', '42', '44', '45', '48', '49']) await db.conectarUsuario(c, 'Ocupante ' + c, null);
  check('con los 6 normales ocupados NO hay cajón libre para la fila (46/50 no cuentan)', db.cargadorLibre() === null && db.numLibres() === 0, JSON.stringify(db.cargadorLibre()));
  await db.setVip(true);
  check('con VIP abierto sí hay libre (46)', db.cargadorLibre() && db.cargadorLibre().cajon === '46' && db.numLibres() === 2);
  await db.setVip(false);
  await db.agregarFila('111', 'Ana');
  await db.conectarUsuario('46', 'Don MD', null);
  await control.procesar('46 libre');
  check('Control libera 46 (VIP cerrado): cajón libre pero NO se llama a Ana', !cj('46').ocupado && E.length === 0, JSON.stringify(E));
  await control.procesar('41 libre');
  check('41 libre sí llama a Ana', E.length === 1 && E[0].m === '111');
  limpiar();
  await control.procesar('3 lugares disponibles');
  check('discrepancia usa el total de cajones libres (41, 46 y 50 = 3) → sin aviso', P.length === 0, JSON.stringify(P));

  console.log('\n4) Reinicio manual conserva lista abierta; medianoche la cierra');
  await db.setLista(true); await db.setVip(true);
  await db.reiniciar();
  check('"reiniciar estado" no cierra la lista ni el VIP', db.listaAbierta() && db.vipAbierto());
  await db.reiniciarTodo();
  check('reinicio de medianoche la cierra', !db.listaAbierta() && !db.vipAbierto());

  console.log('\n5) Horarios especiales (motor.horaEspecial)');
  const si = ['Buen día, me apunto a las 2', 'quiero cargar a las 14:00', 'me anotan para las 3 pm', 'cargo después de comer',
    'más tarde me apunto', 'quiero cargar mañana', 'me anotas en una hora', 'quiero cargar hoy en la tarde', 'me apunto como a las 4', 'anótenme 1:30'];
  const no = ['Buen día, me apuntan por favor', 'quiero cargar', 'me pueden anotar', 'hay lugar?', 'por la mañana quise cargar y no había, me apuntan', 'también me apunto'];
  si.forEach(function(t) { check('especial: "' + t + '"', motor.horaEspecial(t) === true); });
  no.forEach(function(t) { check('normal: "' + t + '"', motor.horaEspecial(t) === false); });

  console.log('\n7) Fila: bitácora y bajas por nombre (etapa1c-4)');
  await db.reiniciarTodo();
  await db.agregarFila('111', 'Miguel Ángel Martínez'); await db.agregarFila('222', 'A'); await db.agregarFila('333', 'Rodrigo Mendoza');
  await db.conectarUsuario('41', 'Ana Gómez', null, null);
  check('conectar a "Ana Gómez" por nombre NO saca de la fila a alguien llamado "A"', db.getEstado().fila.length === 3, JSON.stringify(db.getEstado().fila.map(function(u) { return u.nombre; })));
  await db.conectarUsuario('42', 'Miguel Ángel Martínez', null, null);
  check('conectar a "Miguel Ángel Martínez" sí lo saca (mismo nombre)', db.getEstado().fila.map(function(u) { return u.nombre; }).join() === 'A,Rodrigo Mendoza');
  const bit = db.bitacoraFila(10);
  check('la bitácora registra las 3 altas y la baja con su motivo', bit.filter(function(x) { return x.ev === 'alta'; }).length === 3 && bit.some(function(x) { return x.ev === 'baja' && /Miguel Ángel/.test(x.nombre) && /cajón 42/.test(x.motivo); }), JSON.stringify(bit));

  console.log('\nResultado: ' + ok + '/' + (ok + fail) + ' ✅  ' + fail + ' ❌');
  mock.timers.reset();
  process.exit(fail ? 1 : 0);
})().catch(function(e) { console.error('💥', e); process.exit(2); });
