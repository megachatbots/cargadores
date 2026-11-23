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
  Object.keys(control._avisadoCorto).forEach(function(k) { delete control._avisadoCorto[k]; });
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

  console.log('\n11) Tiempo cumplido (etapa1c-7): UN solo mensaje al usuario; a los 15 min sin desconexión → alerta a Alma; el cajón sigue ocupado');
  await reset();
  await db.conectarUsuario('44', 'Arturo Montaño', '777', tiempo.horaLaboralAISO('11:45'));   // termina 2:45 p.m.
  await db.agregarFila('888', 'Alix Córdova');
  await timers.reactivarTimerSesionCajon('44');
  await avanzar(15 * MIN + 1000);   // 14:45
  check('2:45: UN mensaje en Eléctricos con mención a 777', E.length === 1 && E[0].m.join() === '777' && /Arturo Montaño @777 por favor desconecta/.test(E[0].t), JSON.stringify(E));
  check('2:45: Proyecto Bot informa (único aviso, alerta en 15 min); resumen marca ⏰', P.length === 1 && /único aviso/.test(P[0]) && /44 libre/.test(P[0]) && /tiempo cumplido/.test(db.resumenCargadores()), JSON.stringify(P));
  check('2:45: el cajón sigue ocupado, NO se llama a Alix, y queda guardada la hora de vencimiento', cj('44').ocupado === true && db.getEstado().pendiente === null && !E.some(function(x) { return x.m === '888'; }) && !!cj('44').cumplido_en);
  limpiar();
  await avanzar(14 * MIN);   // 2:59
  check('2:59: nada nuevo (ni segundo recordatorio ni alerta)', E.length === 0 && P.length === 0, JSON.stringify({ E, P }));
  await avanzar(1 * MIN + 2000);   // 3:00 → 15 min después del vencimiento
  check('3:00 (15 min después): alerta a Alma en Proyecto Bot, SIN escribir al usuario', E.length === 0 && P.length === 1 && /🚨/.test(P[0]) && /Arturo Montaño/.test(P[0]) && /Alma: llama a la persona/.test(P[0]) && /44 libre/.test(P[0]), JSON.stringify({ E, P }));
  check('la alerta queda marcada (no se repite)', cj('44').alerta_vencido === true);
  limpiar();
  await avanzar(15 * MIN); await avanzar(15 * MIN); await avanzar(60 * MIN);
  check('después: cero mensajes al usuario y cero alertas repetidas', E.length === 0 && P.length === 0, JSON.stringify({ E, P }));
  await control.procesar('44 libre');
  check('el ayudante reporta "44 libre" → se libera y ahora sí se llama a Alix', !cj('44').ocupado && E.length === 1 && E[0].m === '888', JSON.stringify(E));

  console.log('\n11b) Si el ayudante confirma la desconexión antes de los 15 min, NO hay alerta');
  await reset();
  await db.conectarUsuario('42', 'Pablo Monsalvo', '999', tiempo.horaLaboralAISO('11:45'));
  await timers.reactivarTimerSesionCajon('42');
  await avanzar(15 * MIN + 1000);   // vencimiento 2:45
  await avanzar(5 * MIN);
  limpiar();
  await control.procesar('Se desconecta\nPablo Monsalvo');
  await avanzar(30 * MIN);
  check('libre a los 5 min → sin alerta a Alma ni mensajes extra', !cj('42').ocupado && !P.some(function(t) { return /🚨/.test(t); }) && E.length === 0, JSON.stringify({ E, P }));

  console.log('\n12) Reinicio del bot con la alerta a Alma pendiente: se retoma; si ya pasaron los 15 min sale una sola vez');
  await reset();
  await db.conectarUsuario('42', 'Pablo Monsalvo', '999', tiempo.horaLaboralAISO('11:45'));
  await timers.reactivarTimerSesionCajon('42');
  await avanzar(15 * MIN + 1000);          // vencimiento (2:45)
  limpiar();
  control._detener();                       // "se cayó el bot"
  await avanzar(5 * MIN);
  check('se reanuda 1 alerta pendiente', control.reanudarRecordatorios() === 1);
  await avanzar(10 * MIN + 2000);           // completa los 15 min desde el vencimiento
  check('la alerta sale a los 15 min desde el vencimiento (no 15 min desde el reinicio)', P.length === 1 && /🚨/.test(P[0]) && E.length === 0, JSON.stringify({ E, P }));
  limpiar();
  check('tras la alerta, un reinicio ya no reanuda nada', control.reanudarRecordatorios() === 0);
  await reset();
  await db.conectarUsuario('48', 'Tere Soto', '555', tiempo.horaLaboralAISO('11:45'));
  await timers.reactivarTimerSesionCajon('48');
  await avanzar(15 * MIN + 1000);
  limpiar();
  control._detener();
  await avanzar(40 * MIN);                  // el bot estuvo caído 40 min
  check('si al volver ya pasaron los 15 min: se reanuda y alerta de inmediato (una vez)', control.reanudarRecordatorios() === 1);
  await avanzar(1000);
  check('   · alerta inmediata', P.length === 1 && /🚨/.test(P[0]), JSON.stringify(P));
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

  console.log('\n14) "Se tiene que desconectar X" (ayudante): YA NO se le escribe al usuario; se avisa a Alma (1 aviso por persona cada 15 min)');
  await reset();
  await db.conectarUsuario('44', 'Ana Pérez', '222');
  await control.procesar('Se tiene que desconectar Ana Pérez\nPedro Pérez');
  check('NO se escribe nada en Eléctricos', E.length === 0, JSON.stringify(E));
  check('aviso a Alma por Ana (cajón 44) con "Alma: avisa tú"', P.some(function(t) { return /Ana Pérez/.test(t) && /cajón 44/.test(t) && /Alma: avisa tú/.test(t); }), JSON.stringify(P));
  check('Pedro (no está en cajones) se informa aparte, sin aviso a Alma por él', P.some(function(t) { return /No encontré.*Pedro Pérez/.test(t); }) && !P.some(function(t) { return /Alma: avisa tú/.test(t) && /Pedro/.test(t); }), JSON.stringify(P));
  limpiar();
  await control.procesar('Se tiene que desconectar Ana Pérez');
  check('si el ayudante repite a los pocos minutos, no se duplica el aviso', !P.some(function(t) { return /Alma: avisa tú/.test(t); }) && E.length === 0, JSON.stringify(P));
  await avanzar(15 * MIN + 1000); limpiar();
  await control.procesar('Se tiene que desconectar Ana Pérez');
  check('pasados 15 min, un nuevo pedido sí avisa otra vez', P.some(function(t) { return /Alma: avisa tú/.test(t); }) && E.length === 0, JSON.stringify(P));
  control._detener();

  console.log('\nEntradas anotadas a mano (sin teléfono): no se mencionan en Eléctricos');
  await reset();
  await control.procesar('Se conecta\nCajón 42\nJuan Pérez\n11A111 BYD\n1:00 A 4:00');
  await db.anotarManual('Pedro Manual');
  limpiar();
  await control.procesar('42 libre');
  check('al liberar el 42, a Pedro (manual) NO se le menciona en Eléctricos', E.length === 0, JSON.stringify(E));
  check('Proyecto Bot recibe "le toca a Pedro Manual … avísale tú"', P.some(function(t) { return /Pedro Manual/.test(t) && /Avísale tú/.test(t); }), JSON.stringify(P));
  check('el resumen de "42 libre" también sale en Proyecto Bot', P.some(function(t) { return /Liberado.*42.*Juan Pérez/.test(t); }), JSON.stringify(P));
  await control.procesar('Se conecta\nCajón 44\nPedro Manual\n22B222 Tesla\n2:00 A 5:00');
  check('si conecta Pedro Manual: sale de la fila y queda sin número (no habrá @manual_N)', db.getEstado().fila.length === 0 && cj('44').numero_actual === null, JSON.stringify(cj('44')));

  console.log('\nVencimiento fuera de horario (puedeElectricos = false): al usuario NUNCA se le escribe (ni al volver el horario); la alerta a Alma sí sale');
  await reset();
  let puede = false;
  const control2 = crear({ db: db, timers: timers, tiempo: tiempo, puedeElectricos: function() { return puede; },
    enviarElectricos: async function(t, m) { E.push({ t: t, m: m }); }, enviarProyectoBot: async function(t) { P.push(t); }, procesarReporte: async function() {} });
  timers.setOnSesionCumplida(control2.sesionCumplida);
  await control2.procesar('Se conecta\nCajón 41\nVíctor Ojeda\n33G579 Tesla\n11:00 A 2:00');
  await avanzar(60 * MIN);
  for (let i = 0; i < 8; i++) await avanzar(15 * MIN);
  check('en pausa: no se escribe nada al usuario', E.length === 0, JSON.stringify(E));
  check('en pausa: la alerta a Alma SÍ sale (L–V a cualquier hora)', P.some(function(t) { return /🚨/.test(t) && /Víctor Ojeda/.test(t); }), JSON.stringify(P));
  check('el aviso a admins dice la verdad (no afirma que se le avisó)', P.some(function(t) { return /No le escribí en Eléctricos/.test(t); }) && !P.some(function(t) { return /único aviso/.test(t); }), JSON.stringify(P));
  puede = true; limpiar();
  await avanzar(60 * MIN);
  check('al volver el horario NO se le manda el aviso atrasado', E.length === 0, JSON.stringify(E));
  control2._detener();

  console.log('\nFin de semana: la alerta a Alma se difiere (resumen del lunes); entre semana sale directa');
  await reset();
  const D = [];
  const control3 = crear({ db: db, timers: timers, tiempo: tiempo, avisoDiferible: async function(t) { D.push(t); },
    enviarElectricos: async function(t, m) { E.push({ t: t, m: m }); }, enviarProyectoBot: async function(t) { P.push(t); }, procesarReporte: async function() {} });
  timers.setOnSesionCumplida(control3.sesionCumplida);
  mock.timers.setTime(Date.UTC(2026, 10, 7, 20, 30, 0));   // sábado 7 nov 14:30 México
  await db.conectarUsuario('45', 'Sábado Uno', '123', tiempo.horaLaboralAISO('11:45'));
  await timers.reactivarTimerSesionCajon('45');
  await avanzar(15 * MIN + 1000); await avanzar(15 * MIN);
  check('sábado: la alerta 🚨 va al resumen diferido, no directa a Proyecto Bot', D.some(function(t) { return /🚨/.test(t); }) && !P.some(function(t) { return /🚨/.test(t); }), JSON.stringify({ D, P }));
  control3._detener();
  timers.setOnSesionCumplida(control.sesionCumplida);

  console.log('\nCaso real 5 nov: "Citlali Guzmán desconectada / 1 cargador disponible" (antes no se detectó y siguieron los recordatorios)');
  await reset();
  for (const c of ['41', '42', '44', '46', '48', '49', '50']) await db.conectarUsuario(c, 'Usuario ' + c, null, null);
  await db.agregarFila('5215500000009', 'Pablo Pérez');
  await db.agregarFila('5215500000007', 'Citlali Guzmán');
  await control.procesar('Se conecta\nCajón 45\nCitlali Guzmán\n11A111 BYD\n11:45 A 2:45');
  await control.procesar('Se tiene que desconectar Citlali');
  check('Citlali (con su número) quedó sacada de la fila y el pedido del ayudante no escribe al usuario', db.getEstado().fila.length === 1 && !E.some(function(x) { return /desconecta/.test(x.t); }), JSON.stringify(E));
  limpiar();
  await control.procesar('Citlali Guzmán desconectada\n1 cargador disponible');
  check('el cajón 45 queda libre', cj('45').ocupado === false, JSON.stringify(cj('45')));
  check('se llama a Pablo Pérez, el siguiente de la fila', E.some(function(x) { return /Pablo Pérez/.test(x.t) && /lugar disponible/.test(x.t); }), JSON.stringify(E));
  check('Proyecto Bot: "Liberado … cajón 45 (Citlali Guzmán)"', P.some(function(t) { return /Liberado.*45.*Citlali Guzmán/.test(t); }), JSON.stringify(P));
  check('"1 cargador disponible" coincide con el conteo del bot (se procesa DESPUÉS de liberar): sin falsa alarma', !P.some(function(t) { return /Control reporta/.test(t); }), JSON.stringify(P));
  limpiar();
  await avanzar(15 * MIN); await avanzar(15 * MIN);
  check('ya no salen mensajes a Citlali', !E.some(function(x) { return /desconect/.test(x.t); }), JSON.stringify(E));

  console.log('\nPedido con el nombre primero ("Roxana se tiene que desconectar")');
  await reset();
  await control.procesar('Se conecta\nCajón 44\nRoxana Ali\n22B222 Tesla\n11:45 A 2:45');
  limpiar();
  await control.procesar('Roxana se tiene que desconectar');
  check('se avisa a Alma por Roxana y NO se le escribe a ella', E.length === 0 && P.some(function(t) { return /Roxana Ali/.test(t) && /Alma: avisa tú/.test(t); }), JSON.stringify({ E, P }));

  console.log('\nRespuesta del usuario en Eléctricos a su aviso de tiempo vencido: avisa a Alma; NUNCA libera el cajón');
  await reset();
  await db.agregarFila('5215500000007', 'Citlali Guzmán');
  await control.procesar('Se conecta\nCajón 45\nCitlali Guzmán\n11A111 BYD\n11:45 A 2:45');
  await avanzar(15 * MIN + 1000);   // 2:45: se vence su tiempo (ya recibió su único aviso)
  limpiar();
  check('"sí" de alguien SIN cajón vencido no hace nada', (await control.respuestaUsuario('5215599999999', 'Otra', 'Sí')) === false && P.length === 0);
  check('"todavía no me desconecto" NO cuenta', (await control.respuestaUsuario('5215500000007', 'Cit', 'todavía no me desconecto')) === false);
  check('"Ya me desconecté desde hace rato" con su número → atendido', (await control.respuestaUsuario('5215500000007', 'Cit', 'Ya me desconecté desde hace rato')) === true);
  check('el cajón 45 SIGUE ocupado (solo el ayudante lo libera)', cj('45').ocupado === true && cj('45').usuario_actual === 'Citlali Guzmán');
  check('Proyecto Bot: pide que el ayudante confirme (Se desconecta / 45 libre)', P.some(function(t) { return /Citlali Guzmán/.test(t) && /ayudante debe confirmarlo/.test(t) && /45 libre/.test(t); }), JSON.stringify(P));
  limpiar();
  check('si repite lo mismo, no se duplica el aviso', (await control.respuestaUsuario('5215500000007', 'Cit', 'ya me desconecté')) === true && P.length === 0);
  await control.procesar('Se desconecta Citlali');
  check('cuando el ayudante confirma, ahí sí se libera', cj('45').ocupado === false);

  console.log('\nRespuesta del usuario dentro de la alerta: si dijo "ya me desconecté" la alerta a Alma lo cita');
  await reset();
  await db.conectarUsuario('44', 'Arturo Montaño', '777', tiempo.horaLaboralAISO('11:45'));
  await timers.reactivarTimerSesionCajon('44');
  await avanzar(15 * MIN + 1000);
  check('"ya me desconecté" de Arturo tras el aviso', (await control.respuestaUsuario('777', 'Arturo', 'ya me desconecté')) === true);
  limpiar();
  await avanzar(15 * MIN + 1000);
  check('la alerta de los 15 min cita lo que escribió y pide confirmación del ayudante', P.length === 1 && /🚨/.test(P[0]) && /ya me desconecté/.test(P[0]) && /falta la confirmación del ayudante/.test(P[0]), JSON.stringify(P));
  control._detener();

  console.log('\n"Sí" al aviso de vencimiento (Ashley, captura del 4 nov 7:33 p. m.)');
  await reset();
  await db.agregarFila('5215500000008', 'Ashley Albarrán');
  await control.procesar('Se conecta\nCajón 42\nAshley Albarrán\n33G579 Tesla\n11:45 A 2:45');
  await avanzar(15 * MIN + 1000);
  limpiar();
  check('"Si" con su número → aviso a Alma', (await control.respuestaUsuario('5215500000008', 'Ashly Albarran', 'Si')) === true && P.length === 1);
  check('y el cajón 42 sigue ocupado', cj('42').ocupado === true);

  console.log('\nRespuesta de alguien sin teléfono registrado: solo avisa si dice que YA se desconectó');
  await reset();
  await control.procesar('Se conecta\nCajón 41\nCitlali Guzmán\n11A111 BYD\n11:45 A 2:45');
  await avanzar(15 * MIN + 1000);
  limpiar();
  check('"Ya me desconecté" de «Cit» (sin número en el bot) → aviso a Proyecto Bot', (await control.respuestaUsuario('5215514385349', 'Cit', 'Ya me desconecté desde hace rato')) === true && P.some(function(t) { return /«Cit»/.test(t) && /Citlali Guzmán/.test(t) && /sin teléfono/.test(t); }), JSON.stringify(P));
  check('un "sí" sin número NO se acepta', (await control.respuestaUsuario('5215514385349', 'Cit', 'Sí')) === false);
  limpiar();
  check('no repite el aviso por nombre', (await control.respuestaUsuario('5215514385349', 'Cit', 'ya me desconecté')) === false && P.length === 0);
  control._detener();

  console.log('\n"No puedo bajar" (etapa1c-3): se vuelve a formar al final y se llama a la siguiente persona');
  async function escenario() {
    await reset();
    await db.agregarFila('5215500000101', 'Ana Pérez'); await db.agregarFila('5215500000102', 'Beto Ruiz'); await db.agregarFila('5215500000103', 'Carla Soto');
    await db.conectarUsuario('41', 'Luis Vega', null);
    await control.procesar('41 libre');       // llama a Ana
    limpiar();
  }
  await escenario();
  check('base: Ana quedó llamada para el cajón 41 y el pendiente es suyo', db.getLlamadoActivo('5215500000101') && db.getLlamadoActivo('5215500000101').cajon === '41' && db.getPendiente().nombre === 'Ana Pérez');
  check('sin llamado activo, "no puedo" de Beto (en fila, no llamado) no hace nada', (await control.noPuedeBajar('5215500000102', 'Beto', 'ahorita no puedo')) === false && db.getEstado().fila[0].nombre === 'Ana Pérez');
  check('un "ya voy" de Ana no se interpreta como rechazo', (await control.noPuedeBajar('5215500000101', 'Ana', 'ya voy')) === false);

  const declinan = ['ahorita no puedo', 'termino junta y bajo', 'me vuelvo a formar', 'salí pero en cuanto me regrese me conecto', 'termino una llamada y bajo', 'estoy en reunión', 'bajo en 40 min'];
  for (const frase of declinan) {
    await escenario();
    const r = await control.noPuedeBajar('5215500000101', 'Ana', frase);
    const fila = db.getEstado().fila.map(function(u) { return u.nombre; });
    check('«' + frase + '» → Ana al final: ' + fila.join(', '), r === true && fila.join(',') === 'Beto Ruiz,Carla Soto,Ana Pérez', fila.join(','));
    check('   · se llama a Beto para el cajón 41 y el pendiente pasa a Beto', E.some(function(x) { return x.m === '5215500000102' && /lugar disponible/.test(x.t); }) && db.getPendiente().nombre === 'Beto Ruiz' && db.getPendiente().cargador_id === '41', JSON.stringify([E, db.getPendiente()]));
    check('   · Ana recibe confirmación con su posición 3', E.some(function(x) { return x.m === '5215500000101' && /posición 3/.test(x.t); }), JSON.stringify(E));
    check('   · Proyecto Bot informa y pide *sí*', P.length === 1 && /Ana Pérez/.test(P[0]) && /Beto Ruiz/.test(P[0]) && /\*sí\*/.test(P[0]), JSON.stringify(P));
    check('   · el cajón 41 NO se toca (sigue con su ocupante real)', cj('41').ocupado === false);
  }
  for (const frase of ['me conecto en 10', 'bajo en 15 min', 'ahorita no puedo, me conecto en 10']) {
    await escenario();
    const r = await control.noPuedeBajar('5215500000101', 'Ana', frase);
    check('«' + frase + '» → solo aviso a Proyecto Bot, Ana sigue primera', r === true && db.getEstado().fila[0].nombre === 'Ana Pérez' && P.length === 1 && /Ana Pérez/.test(P[0]) && /min/.test(P[0]), JSON.stringify(P));
    check('   · no se llama a nadie más ni se escribe en Eléctricos', E.length === 0 && db.getPendiente().nombre === 'Ana Pérez', JSON.stringify(E));
    limpiar();
    check('   · un segundo aviso igual no repite el mensaje', (await control.noPuedeBajar('5215500000101', 'Ana', frase)) === true && P.length === 0);
  }

  console.log('\n"No puedo bajar": casos de borde');
  await escenario();
  await control.noPuedeBajar('5215500000101', 'Ana', 'ahorita no puedo'); limpiar();
  check('repetir el mensaje no la mueve otra vez (ya no tiene llamado)', (await control.noPuedeBajar('5215500000101', 'Ana', 'ahorita no puedo')) === false && E.length === 0 && P.length === 0);

  await reset();
  await db.agregarFila('5215500000101', 'Ana Pérez');
  await db.conectarUsuario('41', 'Luis Vega', null);
  await control.procesar('41 libre'); limpiar();
  check('única persona en la fila: se reforma (queda 1) y no se le vuelve a llamar en bucle', (await control.noPuedeBajar('5215500000101', 'Ana', 'estoy en reunión')) === true && db.getEstado().fila.length === 1 && !E.some(function(x) { return /lugar disponible/.test(x.t); }), JSON.stringify(E));
  check('   · Proyecto Bot dice que no hay a quién llamar y el pendiente se limpia', /No hay a quién llamar/.test(P[0]) && db.getPendiente() === null, JSON.stringify([P, db.getPendiente()]));

  await escenario();
  await control.procesar('Se conecta\nCajón 41\nBeto Ruiz\n11A111 BYD\n2:00 A 5:00'); limpiar();
  check('si el cajón ya lo ocupó otra persona, el "no puedo" de Ana ya no aplica', (await control.noPuedeBajar('5215500000101', 'Ana', 'ahorita no puedo')) === false && db.getEstado().fila[0].nombre === 'Ana Pérez');

  await escenario();
  await control.procesar('Se conecta\nCajón 42\nBeto Ruiz\n11A111 BYD\n2:00 A 5:00'); limpiar();
  check('si el cajón 41 sigue libre y Beto ya está conectado, se llama a Carla (no a Beto)', (await control.noPuedeBajar('5215500000101', 'Ana', 'ahorita no puedo')) === true && E.some(function(x) { return x.m === '5215500000103'; }) && !E.some(function(x) { return x.m === '5215500000102'; }), JSON.stringify(E));

  // Fase "turno": el ayudante ya confirmó (sí) y corre su ventana de 15 min
  await escenario();
  await db.setPendiente(null);
  await timers.iniciarTimerConexion('41', 'Ana Pérez', '5215500000101');
  check('en turno (ventana de 15 min) también aplica', db.getLlamadoActivo('5215500000101').fase === 'turno');
  limpiar();
  check('«estoy en reunión» durante la ventana → se reforma', (await control.noPuedeBajar('5215500000101', 'Ana', 'estoy en reunión')) === true && db.getEstado().fila[2].nombre === 'Ana Pérez');
  check('   · la ventana de espera se cancela y se llama a Beto', cj('41').timer_conexion.activo === false && cj('41').usuario_actual === null && E.some(function(x) { return x.m === '5215500000102' && /lugar disponible/.test(x.t); }), JSON.stringify([cj('41').timer_conexion, E]));
  check('   · Proyecto Bot menciona que canceló la ventana de 15 min', /ventana de 15 min/.test(P[0]), JSON.stringify(P));
  await avanzar(20 * MIN);
  check('   · pasados 20 min no salen mensajes de "perdiste tu turno" para Ana', !E.some(function(x) { return /perdiste/.test(x.t); }), JSON.stringify(E));

  // Entrada manual como siguiente: no se menciona en Eléctricos
  await reset();
  await db.agregarFila('5215500000101', 'Ana Pérez');
  await db.anotarManual('Don Memo', 2);
  await db.conectarUsuario('41', 'Luis Vega', null);
  await control.procesar('41 libre'); limpiar();
  check('siguiente es una entrada manual: solo se avisa a Proyecto Bot', (await control.noPuedeBajar('5215500000101', 'Ana', 'ahorita no puedo')) === true && P.some(function(t) { return /Don Memo/.test(t) && /sin teléfono/.test(t); }) && !E.some(function(x) { return /Memo/.test(x.t); }), JSON.stringify([P, E]));

  // Cajón VIP cerrado: no se llama a la fila
  await reset();
  await db.agregarFila('5215500000101', 'Ana Pérez'); await db.agregarFila('5215500000102', 'Beto Ruiz');
  await db.marcarLlamado('5215500000101', '46', 'Ana Pérez');
  check('llamado a un cajón VIP cerrado: se reforma pero no se llama a nadie para él', (await control.noPuedeBajar('5215500000101', 'Ana', 'ahorita no puedo')) === true && !E.some(function(x) { return x.m === '5215500000102'; }), JSON.stringify(E));

  // Llamado caducado (> 2 h) o persona fuera de la fila
  await escenario();
  await avanzar(3 * 60 * MIN);
  check('un llamado de hace 3 h ya no cuenta', (await control.noPuedeBajar('5215500000101', 'Ana', 'ahorita no puedo')) === false);
  await escenario();
  await db.quitarFila('5215500000101');
  check('si la sacaron de la fila, no aplica', (await control.noPuedeBajar('5215500000101', 'Ana', 'ahorita no puedo')) === false);
  control._detener();

  console.log('\nResultado: ' + ok + '/' + (ok + fail) + ' ✅  ' + fail + ' ❌');
  mock.timers.reset();
  process.exit(fail ? 1 : 0);
})().catch(function(e) { console.error('💥', e); process.exit(2); });
