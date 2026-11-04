// test/control.js — Integración: mensajes reales del ayudante → estado y mensajes salientes (reloj falso)
process.env.DATABASE_URL = ''; process.env.ANTHROPIC_API_KEY = 'x';
const { mock } = require('node:test');
const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 10, 3, 20, 30, 0); // 14:30 México
mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: T0 });

const db = require('../src/db_cargadores');
const timers = require('../src/timers');
const tiempo = require('../src/tiempo');
const crear = require('../src/control').crear;

const E = [], P = [], R = [];
timers.setEnviarFn(async function(t) { P.push(t); });
timers.setEnviarElectricosFn(async function(t, n) { E.push({ t: t, m: n }); });
const control = crear({
  db: db, timers: timers, tiempo: tiempo,
  enviarElectricos: async function(t, m) { E.push({ t: t, m: m }); },
  enviarProyectoBot: async function(t) { P.push(t); },
  procesarReporte: async function(t) { R.push(t); }
});

timers.setOnSesionCumplida(control.sesionCumplida);
async function avanzar(ms) { mock.timers.tick(ms); for (let i = 0; i < 6; i++) await new Promise(function(r) { setImmediate(r); }); }
function limpiar() { E.length = 0; P.length = 0; R.length = 0; }
// Estado limpio + reloj en T0 + sin timers vivos de escenarios anteriores
async function reset() {
  db.CAJONES.forEach(function(c) { timers.cancelarTimerConexion(c); timers.cancelarTimerSesion(c); });
  control._detener();
  Object.keys(control._pendientes).forEach(function(k) { delete control._pendientes[k]; });
  await db.reiniciarTodo();
  mock.timers.setTime(T0);
  limpiar();
}
let ok = 0, fail = 0;
function check(d, c, x) { if (c) { ok++; console.log('  ✅ ' + d); } else { fail++; console.log('  ❌ ' + d + (x ? ' → ' + x : '')); } }
const cj = function(n) { return db.getEstado().cargadores[n]; };

(async function() {
  await db.inicializar();

  console.log('\n1) "Se conecta" de alguien que NO está en la fila');
  await reset();
  await control.procesar('Se conecta \nCajón 41\nVíctor Ojeda \n33G579 Tesla \n1:22 A 4:22');
  check('cajón 41 ocupado por Víctor Ojeda', cj('41').ocupado && cj('41').usuario_actual === 'Víctor Ojeda');
  check('placas y marca guardadas', cj('41').placas === '33G579' && cj('41').marca === 'Tesla', JSON.stringify([cj('41').placas, cj('41').marca]));
  check('inicio 1:22 p.m., sesión activa, termina 4:22 p.m.',
    tiempo.horaLocal(cj('41').hora_inicio) === '01:22 p.m.' && cj('41').timer_sesion.activo &&
    tiempo.horaLocal(new Date(cj('41').hora_inicio).getTime() + cj('41').timer_sesion.duracion_ms) === '04:22 p.m.');
  check('sin número: no hay mensaje en Eléctricos ni avisos', E.length === 0 && P.length === 0, JSON.stringify({ E, P }));
  await avanzar(2 * 60 * MIN + 52 * MIN); // 14:30 + 2h52 = 17:22 → 4:22 pm ya pasó (16:22)? no: 17:22
  check('a las 4:22 p.m. se cumple el tiempo (calculado desde la hora real de conexión) y el cajón NO se libera solo', cj('41').timer_sesion.cumplido === true && cj('41').ocupado === true);

  console.log('\n2) Conecta alguien que SÍ está en la fila → se le avisa en Eléctricos y sale de la fila');
  await reset();
  await db.agregarFila('111', 'Pablo');
  await db.agregarFila('222', 'Ana Pérez');
  await control.procesar('Se conecta\nCajón 42\nPablo\n11A111 BYD\n' + '2:25 A 5:25');
  check('Pablo en cajón 42 con su número', cj('42').usuario_actual === 'Pablo' && cj('42').numero_actual === '111');
  check('Pablo salió de la fila, Ana sigue', db.getEstado().fila.length === 1 && db.getEstado().fila[0].nombre === 'Ana Pérez');
  check('Eléctricos: mención a 111 con hora de fin', E.length === 1 && E[0].m === '111' && /quedaste conectado hasta las 0?5:25 p\.m\./.test(E[0].t), JSON.stringify(E));

  console.log('\n3) Ocupante con nombre de marca → pregunta a admins');
  limpiar();
  await control.procesar('Se conecta\nCajón 44\nCupra\n62G718\n2:10 A 5:10');
  check('queda conectado como "Cupra"', cj('44').usuario_actual === 'Cupra' && cj('44').placas === '62G718');
  check('Proyecto Bot pregunta "44 es Nombre"', P.length === 1 && /44 es Nombre/.test(P[0]), JSON.stringify(P));
  await db.renombrarOcupante('44', 'Ana Pérez');
  check('"44 es Ana Pérez" renombra, toma su número y la saca de la fila', cj('44').usuario_actual === 'Ana Pérez' && cj('44').numero_actual === '222' && db.getEstado().fila.length === 0);

  console.log('\n4) "Se desconectan" = CONFIRMACIÓN: libera cajones, llama a la fila, CERO recordatorios');
  await db.agregarFila('333', 'Carla'); await db.agregarFila('444', 'Dino');
  limpiar();
  await control.procesar('Se desconectan \nPablo\nAna Pérez');
  check('cajones 42 y 44 liberados', !cj('42').ocupado && !cj('44').ocupado);
  check('se llama a Carla y a Dino (distintos), sin recordatorios de desconexión', E.length === 2 && E[0].m === '333' && E[1].m === '444' && !E.some(function(x) { return /desconecta tu/.test(x.t); }), JSON.stringify(E));
  limpiar();
  await avanzar(60 * MIN);
  check('una hora después: nada más sale a Eléctricos', E.length === 0, JSON.stringify(E));

  console.log('\n5) Se desconectan: nombre inexistente y ambiguo → solo aviso a admins, nada a Eléctricos');
  await reset();
  await db.conectarUsuario('41', 'Nancy bañuelos', null); await db.conectarUsuario('42', 'Nancy López', null);
  await control.procesar('Se desconectan\nPedro Pérez\nNancy');
  check('nada a Eléctricos', E.length === 0, JSON.stringify(E));
  check('Proyecto Bot avisa del inexistente y del ambiguo (con sus cajones)', P.length === 1 && /Pedro Pérez/.test(P[0]) && /ambiguo/i.test(P[0]) && /cajón 41/.test(P[0]), JSON.stringify(P));
  check('ningún cajón se liberó', cj('41').ocupado && cj('42').ocupado);
  control._detener();

  console.log('\n6) "41 y 44 libres" con dos personas esperando → se llama a dos distintas');
  await reset();
  await db.conectarUsuario('41', 'Luis', null); await db.conectarUsuario('44', 'Marta', null);
  await db.agregarFila('333', 'Ana'); await db.agregarFila('444', 'Beto'); await db.agregarFila('555', 'Caro');
  await control.procesar('41 y 44 libres');
  check('41 y 44 liberados', !cj('41').ocupado && !cj('44').ocupado);
  check('se avisa a Ana y a Beto (no a la misma dos veces, ni a Caro)', E.length === 2 && E[0].m === '333' && E[1].m === '444', JSON.stringify(E));

  console.log('\n7) "N lugares disponibles"');
  await reset();
  await db.conectarUsuario('41', 'Luis', null);
  await control.procesar('2 lugares disponibles');
  check('discrepancia (bot tiene 7 libres) → avisa en Proyecto Bot', P.length === 1 && /2/.test(P[0]) && /7/.test(P[0]), JSON.stringify(P));
  limpiar();
  await control.procesar('2 lugares disponibles');
  check('mismo aviso dentro de 10 min no se repite', P.length === 0);
  limpiar();
  await avanzar(11 * MIN);
  await control.procesar('2 lugares disponibles');
  check('pasados 10 min sí se vuelve a avisar', P.length === 1);
  limpiar();
  await control.procesar('7 lugares disponibles');
  check('si coincide con lo que ve el bot, no avisa', P.length === 0);

  console.log('\n8) Reporte y charla');
  limpiar();
  const rep = 'Cajón 41\nDavid antes de las 7:00\nVolt\n33K048\n\nCajón 42\nLibre';
  await control.procesar(rep);
  check('reporte de varios cajones se delega al cargador de estado inicial', R.length === 1 && R[0] === rep);
  const sinInterpretar = await control.procesar('@210706850914377 apoyo para desconectar tu vehículo por favor');
  check('charla del ayudante → no hace nada', sinInterpretar === false && E.length === 0);

  console.log('\n9) Reporte sin hora ya no inventa "hasta 10:00 a.m."');
  await reset();
  const motor = require('../src/motor_cargadores');
  await db.cargarEstadoInicial(motor.parsearReporteMatutino('Cajón 45\nCarlos Guadarrama\n83F796\n\nCajón 46\nCesar Mora\nCarga extendida'));
  const res = db.resumenCargadores();
  check('45 se muestra "(sin hora)"', /Cajón 45: Carlos Guadarrama \(sin hora\)/.test(res), res);
  check('46 VIP se muestra "(carga extendida)"', /Cajón 46 ⭐: Cesar Mora \(carga extendida\)/.test(res), res);
  check('45 no queda marcado vencido', !cj('45').timer_sesion.vencido && cj('45').timer_sesion.sin_hora === true);

  console.log('\n10) Comando "N desde H:MM" (reloj: 14:30)');
  await reset();
  await db.conectarUsuario('45', 'Carlos Guadarrama', null);
  let m = await control.ajustarInicio('45', '1:30');
  check('45 desde 1:30 → termina 4:30 p.m., sesión activa', /desde 0?1:30 p\.m\./.test(m) && /termina a las 0?4:30 p\.m\./.test(m) && cj('45').timer_sesion.activo === true, m);
  await avanzar(2 * 60 * MIN + 1 * MIN);
  check('el timer corregido cumple el tiempo a las 4:30 p.m.', cj('45').timer_sesion.cumplido === true);
  await reset();
  await db.conectarUsuario('48', 'Brenda Cervantes', null);
  m = await control.ajustarInicio('48', '9:00');
  check('48 desde 9:00 → ya venció: sigue ocupado, sin timer, avisa cómo liberarlo', cj('48').ocupado === true && cj('48').timer_sesion.activo === false && cj('48').timer_sesion.vencido === true && /sigue ocupado/.test(m) && /48 libre/.test(m), m);
  m = await control.ajustarInicio('48', '5:10');
  check('hora futura (5:10 p.m. cuando son las 2:30) se rechaza', /futura/.test(m) && cj('48').timer_sesion.vencido === true, m);
  m = await control.ajustarInicio('42', '1:30');
  check('cajón libre → avisa', /no está ocupado/.test(m), m);
  m = await control.ajustarInicio('48', 'abc');
  check('hora ilegible → da ejemplo', /No entendí/.test(m), m);
  m = await control.ajustarInicio('48', '1.30');
  check('acepta "1.30" con punto', /✅/.test(m), m);

  console.log('\n11) Tiempo cumplido: 3 recordatorios cada 15 min y luego alerta a admins; el cajón sigue ocupado');
  await reset();
  await db.conectarUsuario('44', 'Arturo Montaño', '777', tiempo.horaLaboralAISO('11:45'));   // termina 2:45 p.m.
  await db.agregarFila('888', 'Alix Córdova');
  await timers.reactivarTimerSesionCajon('44');
  await avanzar(15 * MIN + 1000);   // 14:45
  check('2:45: primer recordatorio en Eléctricos con mención a 777', E.length === 1 && E[0].m.join() === '777' && /Arturo Montaño @777 por favor desconecta/.test(E[0].t), JSON.stringify(E));
  check('2:45: Proyecto Bot informa 1/3 y que sigue ocupado; resumen marca ⏰', P.length === 1 && /1\/3/.test(P[0]) && /44 libre/.test(P[0]) && /tiempo cumplido/.test(db.resumenCargadores()), JSON.stringify(P));
  check('2:45: el cajón sigue ocupado y NO se llama a Alix', cj('44').ocupado === true && db.getEstado().pendiente === null && !E.some(function(x) { return x.m === '888'; }));
  check('contador persistido = 1', cj('44').recordatorios === 1, cj('44').recordatorios);
  await avanzar(15 * MIN); await avanzar(15 * MIN);   // 3:00 y 3:15
  check('3 recordatorios en total', E.filter(function(x) { return /desconecta/.test(x.t); }).length === 3, E.length);
  limpiar();
  await avanzar(15 * MIN);   // 3:30
  check('al cuarto turno NO hay otro recordatorio y se alerta a admins', E.length === 0 && P.length === 1 && /🚨/.test(P[0]) && /3 recordatorios/.test(P[0]) && /44 libre/.test(P[0]), JSON.stringify({ E, P }));
  limpiar();
  await avanzar(60 * MIN);
  check('después de la alerta no hay más mensajes', E.length === 0 && P.length === 0, JSON.stringify({ E, P }));
  await control.procesar('44 libre');
  check('el ayudante reporta "44 libre" → se libera y ahora sí se llama a Alix', !cj('44').ocupado && E.length === 1 && E[0].m === '888', JSON.stringify(E));

  console.log('\n12) Reinicio del bot a mitad de los recordatorios: se retoman sin reiniciar la cuenta');
  await reset();
  await db.conectarUsuario('42', 'Pablo Monsalvo', '999', tiempo.horaLaboralAISO('11:45'));
  await timers.reactivarTimerSesionCajon('42');
  await avanzar(15 * MIN + 1000);          // primer recordatorio (1/3)
  limpiar();
  control._detener(); Object.keys(control._pendientes).forEach(function(k) { delete control._pendientes[k]; });   // "se cayó el bot"
  const n = control.reanudarRecordatorios();
  check('se reanuda 1 recordatorio pendiente', n === 1);
  await avanzar(15 * MIN);
  check('siguiente recordatorio sale en 15 min (2/3), no 1/3', E.length === 1 && cj('42').recordatorios === 2, JSON.stringify({ E, r: cj('42').recordatorios }));
  await avanzar(15 * MIN);
  check('tercer recordatorio (3/3)', cj('42').recordatorios === 3);
  limpiar();
  await avanzar(15 * MIN);
  check('luego alerta a admins una sola vez', P.length === 1 && /🚨/.test(P[0]) && cj('42').recordatorios === 4, JSON.stringify(P));
  control._detener(); Object.keys(control._pendientes).forEach(function(k) { delete control._pendientes[k]; });
  limpiar();
  check('tras la alerta, un reinicio ya no reanuda nada', control.reanudarRecordatorios() === 0);
  control._detener();

  console.log('\n13) Evidencia real: confirmaciones del ayudante NO generan mensajes a Eléctricos');
  await reset();
  await db.conectarUsuario('41', 'Carlos Guadarrama', '777');
  await db.conectarUsuario('42', 'Zamanny Nieto', '888');
  await db.agregarFila('555', 'Javier Domínguez');
  await control.procesar('Se desconectan\nZamanny Nieto \n\nJavier Dominges');
  check('Zamanny liberó su cajón y se llamó a Javier de la fila', !cj('42').ocupado && E.length === 1 && E[0].m === '555' && /ya hay un lugar/.test(E[0].t), JSON.stringify(E));
  check('Javier (no está en cajones) solo genera aviso a admins', P.some(function(t) { return /Javier Dominges/.test(t); }), JSON.stringify(P));
  limpiar(); db.getEstado().fila.length = 0;
  await control.procesar('Se desconecta \n\nCarlos Guadarrama');
  check('"Se desconecta / Carlos Guadarrama" libera el 41 y no escribe nada a Eléctricos', !cj('41').ocupado && E.length === 0, JSON.stringify(E));
  await avanzar(4 * 60 * MIN);
  check('4 horas después: cero mensajes (antes eran recordatorios cada 15 min)', E.length === 0, JSON.stringify(E));
  control._detener();

  console.log('\n14) "se tiene que desconectar X" = RECORDATORIO: máximo 3 y alerta; no se manda por nombre a quien no está en cajones');
  await reset();
  await db.conectarUsuario('44', 'Ana Pérez', '222');
  await control.procesar('Se tiene que desconectar Ana Pérez\nPedro Pérez');
  check('recordatorio 1 solo a Ana; Pedro (no está en cajones) no recibe nada', E.length === 1 && String(E[0].m) === '222' && !/Pedro/.test(E[0].t), JSON.stringify(E));
  check('admins avisados de Pedro', P.some(function(t) { return /Pedro Pérez/.test(t); }), JSON.stringify(P));
  limpiar();
  await avanzar(15 * MIN); await avanzar(15 * MIN); await avanzar(15 * MIN); await avanzar(15 * MIN);
  const rec = E.filter(function(x) { return /desconecta/.test(x.t); }).length;
  check('en total 3 recordatorios (1 inicial + 2) y luego se detiene', rec === 2, String(rec) + ' ' + JSON.stringify(E));
  check('alerta 🚨 a admins', P.some(function(t) { return /🚨/.test(t); }), JSON.stringify(P));
  control._detener();

  console.log('\nResultado: ' + ok + '/' + (ok + fail) + ' ✅  ' + fail + ' ❌');
  mock.timers.reset();
  process.exit(fail ? 1 : 0);
})().catch(function(e) { console.error('💥', e); process.exit(2); });
