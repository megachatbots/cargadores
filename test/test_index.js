// test/test_index.js — Integración de index.js con un WhatsApp falso: admin por teléfono, miid en grupo,
// comandos de fila, "libres" con 59, y silencio nocturno (recordatorios pausados + resumen a las 7:00).
process.env.DATABASE_URL = ''; process.env.ANTHROPIC_API_KEY = 'x'; process.env.BOT_TEST = '1'; process.env.PORT = '0';
process.env.ADMIN_IDS = '147699831668775,5522614857';          // un admin por LID y Alma por teléfono
const { mock } = require('node:test');
const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 10, 5, 16, 0, 0);                    // jue 5 nov 2026, 10:00 México
mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: T0 });

const ENV = { e: '1203630@g.us', p: '1203631@g.us', c: '1203632@g.us' };
const ALMA = '999888777666555', ADM = '147699831668775', OTRO = '111222333444555';
const AN = '777000111222331', BE = '777000111222332';   // Ana y Beto, miembros de Eléctricos
let metaE = 0;                                          // cuántas veces se leyó la lista de miembros de Eléctricos
const enviados = [];   // { a: 'p'|'e'|'c'|..., t, m }
const handlers = {};
const sock = {
  ev: { on: function(n, f) { handlers[n] = f; } },
  groupFetchAllParticipating: async function() {
    return { [ENV.e]: { subject: 'Eléctricos' }, [ENV.p]: { subject: 'Proyecto Bot' }, [ENV.c]: { subject: 'Control de Cargadores 🚗' } };
  },
  groupMetadata: async function(id) {
    if (id === ENV.p) return { subject: 'Proyecto Bot', participants: [
      { id: ADM + '@lid', phoneNumber: '5215500000000@s.whatsapp.net' },
      { id: ALMA + '@lid', phoneNumber: '525522614857@s.whatsapp.net' },
      { id: OTRO + '@lid', phoneNumber: '5215599999999@s.whatsapp.net' }] };
    if (id === ENV.e) { metaE++; return { subject: 'Eléctricos', participants: [{ id: '5215500000001@s.whatsapp.net' }, { id: AN + '@lid' }, { id: BE + '@lid' }] }; }
    return { subject: 'Control de Cargadores 🚗', participants: [] };
  },
  sendMessage: async function(jid, c) {
    const a = jid === ENV.p ? 'p' : jid === ENV.e ? 'e' : jid === ENV.c ? 'c' : jid;
    enviados.push({ a: a, t: c.text, m: c.mentions || null });
  }
};
function makeWASocket() { return sock; }
globalThis.__BAILEYS_TEST__ = { default: makeWASocket, makeWASocket: makeWASocket,
  useMultiFileAuthState: async function() { return { state: {}, saveCreds: function() {} }; },
  DisconnectReason: { loggedOut: 401 }, fetchLatestBaileysVersion: async function() { return { version: [2, 3000, 1] }; } };

const db = require('../src/db_cargadores');
const tiempo = require('../src/tiempo');
const idx = require('../index');
async function flush() { for (let i = 0; i < 15; i++) await new Promise(function(r) { setImmediate(r); }); }
async function avanzar(ms) { mock.timers.tick(ms); await flush(); }
async function msg(grupo, de, texto) {
  await handlers['messages.upsert']({ type: 'notify', messages: [{ key: { remoteJid: ENV[grupo], participant: de + '@lid', fromMe: false }, message: { conversation: texto }, pushName: 'Alguien' }] });
  await flush();
}
async function priv(de, texto, extra) {
  await handlers['messages.upsert']({ type: 'notify', messages: [{ key: { remoteJid: de + '@lid', fromMe: false }, message: extra || { conversation: texto }, pushName: 'Alguien' }] });
  await flush();
}
const en = function(a) { return enviados.filter(function(x) { return x.a === a; }).map(function(x) { return x.t; }); };
const limpiar = function() { enviados.length = 0; };
let ok = 0, fail = 0;
function check(d, c, x) { if (c) { ok++; console.log('  ✅ ' + d); } else { fail++; console.log('  ❌ ' + d + (x ? ' → ' + x : '')); } }
const ultimo = function(a) { const l = en(a); return l[l.length - 1] || ''; };

(async function() {
  await idx.arrancar();
  await flush();
  await handlers['connection.update']({ connection: 'open' });
  await avanzar(2500); await avanzar(4000);   // primero se resuelven los grupos (2 s), luego el refresco de alias (5 s)
  console.log('\n1) Alma (admin por teléfono 5522614857) y miid en el grupo');
  limpiar();
  await msg('p', OTRO, 'miid');
  check('un no-admin escribe miid en Proyecto Bot → recibe su ID (antes: silencio)', /Tu ID: 111222333444555/.test(ultimo('p')) && /Pásale este ID/.test(ultimo('p')), ultimo('p'));
  limpiar();
  await msg('p', OTRO, 'quitar 1');
  check('un no-admin NO puede usar comandos', en('p').length === 0);
  limpiar();
  await msg('p', ALMA, 'Miid');
  check('Alma: miid muestra su ID, su teléfono y "Ya eres admin" (reconocida por teléfono)', /Tu ID: 999888777666555/.test(ultimo('p')) && /525522614857/.test(ultimo('p')) && /Ya eres admin/.test(ultimo('p')), ultimo('p'));
  limpiar();
  await priv(ALMA, 'miid');
  check('miid en privado también responde', /Tu ID: 999888777666555/.test(ultimo(ALMA + '@lid')), JSON.stringify(enviados));
  limpiar();
  await priv(ALMA, '', { ephemeralMessage: { message: { conversation: 'miid' } } });
  check('miid dentro de un mensaje temporal (ephemeral) también responde', /Tu ID/.test(ultimo(ALMA + '@lid')), JSON.stringify(enviados));

  console.log('\n2) Comandos de fila (los manda Alma, admin solo por teléfono)');
  await db.reiniciarTodo();
  for (const [n, nom] of [['5215500000001', 'Pasapimosh'], ['5215500000002', 'Pablo Pérez'], ['5215500000003', 'Pablo Ruiz'], ['5215500000004', 'Ana López']]) await db.agregarFila(n, nom);
  const nombres = function() { return db.getEstado().fila.map(function(u) { return u.nombre; }).join(' | '); };
  limpiar(); await msg('p', ALMA, 'fuera papapimosh');
  check('"fuera papapimosh" encuentra a Pasapimosh (búsqueda tolerante)', /Pasapimosh quitado/.test(ultimo('p')) && nombres() === 'Pablo Pérez | Pablo Ruiz | Ana López', ultimo('p') + ' / ' + nombres());
  limpiar(); await msg('p', ALMA, 'quitar a Pablo');
  check('"quitar a Pablo" con 2 Pablos: pregunta y NO quita a nadie', /coincide con varios/.test(ultimo('p')) && db.getEstado().fila.length === 3, ultimo('p'));
  limpiar(); await msg('p', ALMA, 'fuera 3');
  check('"fuera 3" quita a la posición 3 (Ana López)', /Ana López quitado.*posición 3/.test(ultimo('p')) && nombres() === 'Pablo Pérez | Pablo Ruiz', ultimo('p') + ' / ' + nombres());
  limpiar(); await msg('p', ALMA, 'quitar 9');
  check('"quitar 9" fuera de rango', /no existe.*2 personas/.test(ultimo('p')), ultimo('p'));
  limpiar(); await msg('p', ALMA, 'anotar a Luis Gómez en 2');
  check('"anotar a Luis Gómez en 2" → posición 2', /Luis Gómez.*posición 2/.test(ultimo('p')) && nombres() === 'Pablo Pérez | Luis Gómez | Pablo Ruiz', ultimo('p') + ' / ' + nombres());
  limpiar(); await msg('p', ALMA, 'anotar a Marta Díaz');
  check('"anotar a Marta Díaz" sin posición → al final', /Marta Díaz.*posición 4/.test(ultimo('p')), ultimo('p'));
  limpiar(); await msg('p', ALMA, 'mover Marta Díaz a 1');
  check('"mover Marta Díaz a 1" → 1', nombres().startsWith('Marta Díaz |'), nombres());
  limpiar(); await msg('p', ALMA, 'Luis Gómez en 4');
  check('"Luis Gómez en 4" (forma corta) mueve a alguien de la fila', nombres() === 'Marta Díaz | Pablo Pérez | Pablo Ruiz | Luis Gómez', nombres());
  // llamado activo: la posición 1 queda reservada
  await db.setPendiente({ tipo: 'asignar_turno', cargador_id: '41', nombre: 'Marta Díaz', numero: db.getEstado().fila[0].numero });
  limpiar(); await msg('p', ALMA, 'anotar a Raúl Peña en 1');
  check('con un llamado activo, "en 1" no se salta al llamado: queda en 2 y lo avisa', /posición 2/.test(ultimo('p')) && /reservadas por un llamado/.test(ultimo('p')) && nombres().startsWith('Marta Díaz | Raúl Peña'), ultimo('p') + ' / ' + nombres());
  await db.setPendiente(null);

  console.log('\n3) Mensajes reales del ayudante: "Cajón 42 libre" y "…49,59 libres"');
  await db.reiniciarTodo();
  for (const c of ['41', '42', '44', '45', '46', '48', '49', '50']) await db.conectarUsuario(c, 'Usuario ' + c, null, null);
  limpiar(); await msg('c', OTRO, 'Cajón 42 libre');
  check('"Cajón 42 libre" libera el 42 y responde en Proyecto Bot', db.getEstado().cargadores['42'].ocupado === false && /Liberado.*42/.test(ultimo('p')), ultimo('p'));
  limpiar(); await msg('c', OTRO, 'Cajón 41,42,44,45,46,48,49,59 libres');
  const ocup = db.ocupantes().map(function(o) { return o.id; }).join();
  check('libera 41,44,45,46,48,49; el 50 sigue ocupado y se pregunta por 59→50', ocup === '50' && /No reconocí el cajón 59/.test(ultimo('p')) && /50 libre/.test(ultimo('p')), ocup + ' / ' + ultimo('p'));
  limpiar(); await msg('c', OTRO, '50 libre');
  check('"50 libre" completa la liberación', db.ocupantes().length === 0);

  console.log('\n4) Noche: recordatorios pausados, nada a Eléctricos, resumen a las 7:00');
  await db.reiniciarTodo();
  await db.setLista(true);                                       // lista ya abierta hoy (si no, el tick la abriría de nuevo)
  while (tiempo.partesMex(Date.now()).h < 19 || tiempo.partesMex(Date.now()).mi < 30) await avanzar(15 * MIN);   // hasta las 19:30 del jueves
  limpiar();
  await db.agregarFila('5215500000001', 'Pasapimosh');
  await msg('c', OTRO, 'Se conecta\nCajón 41\nVíctor Ojeda\n33G579 Tesla\n5:45 A 8:45');
  for (let i = 0; i < 12; i++) await avanzar(15 * MIN);          // hasta 22:30 (el corte es a las 20:00)
  check('desde las 20:00 no sale NADA a Eléctricos', en('e').length === 0, JSON.stringify(en('e')));
  check('de noche no sale ningún aviso a Proyecto Bot (solo se juntan)', en('p').length === 0, JSON.stringify(en('p')));
  const rec = db.getEstado().cargadores['41'].recordatorios || 0;
  check('los recordatorios bloqueados NO se cuentan como enviados', rec === 0, 'recordatorios=' + rec);
  while (!(tiempo.partesMex(Date.now()).h === 7 && tiempo.partesMex(Date.now()).mi >= 15)) await avanzar(15 * MIN);   // hasta las 7:15 del viernes (cruza la medianoche)
  const resumen = en('p').filter(function(t) { return /Resumen de avisos fuera de horario/.test(t); });
  check('a las 7:00 sale UN resumen a Proyecto Bot con lo ocurrido de noche', resumen.length === 1 && /cumplió su tiempo/.test(resumen[0]) && /Reinicio automático/.test(resumen[0]), JSON.stringify(en('p')));
  check('y sigue sin salir nada a Eléctricos', en('e').length === 0, JSON.stringify(en('e')));

  console.log('\n5) Caso real 5 nov: Citlali responde en Eléctricos y luego el ayudante escribe "Citlali Guzmán desconectada"');
  await db.reiniciarTodo(); await db.setLista(true);
  const CIT = '555000111222333';
  await db.agregarFila(CIT, 'Citlali Guzmán');
  await msg('c', OTRO, 'Se conecta\nCajón 45\nCitlali Guzmán\n11A111 BYD\n7:00 A 10:00');
  await msg('c', OTRO, 'Se tiene que desconectar Citlali');
  limpiar();
  await msg('e', CIT, 'Ya me desconecté desde hace rato');
  check('su respuesta en Eléctricos avisa a Proyecto Bot y pide confirmación del ayudante', /Citlali Guzmán.*respondió/.test(ultimo('p')) && /ayudante debe confirmarlo/.test(ultimo('p')), ultimo('p'));
  check('el cajón 45 sigue ocupado (solo el ayudante libera)', db.getEstado().cargadores['45'].ocupado === true);
  check('el bot no contesta nada en Eléctricos', en('e').length === 0, JSON.stringify(en('e')));
  limpiar();
  await msg('c', OTRO, 'Citlali Guzmán desconectada\n1 cargador disponible');
  check('"Citlali Guzmán desconectada / 1 cargador disponible" libera el 45', db.getEstado().cargadores['45'].ocupado === false && /Liberado.*45.*Citlali Guzmán/.test(en('p').join('\n')), en('p').join(' | '));

  console.log('\n6) "No puedo bajar" de punta a punta (etapa1c-3)');
  await db.reiniciarTodo(); await db.setLista(true);
  await db.agregarFila(AN, 'Ana Pérez'); await db.agregarFila(BE, 'Beto Ruiz');
  await db.conectarUsuario('41', 'Víctor Ojeda', null);
  await msg('c', OTRO, '41 libre');
  check('el ayudante libera el 41 y se llama a Ana', en('e').some(function(t) { return /Ana Pérez/.test(t) && /lugar disponible/.test(t); }), JSON.stringify(en('e')));
  limpiar();
  await msg('e', AN, 'Ahorita no puedo, termino junta y bajo');
  check('Ana queda al final de la fila', db.getEstado().fila.map(function(u) { return u.nombre; }).join() === 'Beto Ruiz,Ana Pérez', JSON.stringify(db.getEstado().fila));
  check('se llama a Beto para el 41 y Ana recibe su nueva posición', en('e').some(function(t) { return /Beto Ruiz/.test(t) && /lugar disponible/.test(t); }) && en('e').some(function(t) { return /Ana Pérez/.test(t) && /posición 2/.test(t); }), JSON.stringify(en('e')));
  check('Proyecto Bot informa y el pendiente es de Beto', /Ana Pérez/.test(ultimo('p')) && /Beto Ruiz/.test(ultimo('p')) && db.getPendiente().nombre === 'Beto Ruiz', ultimo('p'));
  limpiar();
  await db.setPendiente(null); await require('../src/timers').iniciarTimerConexion('41', 'Beto Ruiz', BE);   // equivale al "sí" del admin (que pasa por el clasificador IA, no disponible en pruebas)
  check('con el turno de Beto en marcha (ventana de 15 min) su llamado sigue vigente', db.getLlamadoActivo(BE) && db.getLlamadoActivo(BE).fase === 'turno');
  limpiar();
  await msg('e', BE, 'me conecto en 10');
  check('Beto promete 10 min en su ventana: solo aviso a Proyecto Bot, nadie se mueve', /Beto Ruiz/.test(ultimo('p')) && /10 min/.test(ultimo('p')) && db.getEstado().fila[0].nombre === 'Beto Ruiz' && en('e').length === 0, JSON.stringify(enviados));
  limpiar();
  await msg('e', AN, 'gracias');
  check('un mensaje cualquiera de alguien sin llamado no cambia nada', en('p').length === 0 && db.getEstado().fila.length === 2);

  console.log('\n7) Miembros de Eléctricos se recargan al abrir la conexión (antes quedaban en null hasta 30 min)');
  const antes = metaE;
  await handlers['connection.update']({ connection: 'open' });
  await avanzar(6000);
  check('al reconectar se vuelve a leer la lista de miembros', metaE > antes, 'lecturas ' + antes + ' → ' + metaE);

  console.log('\n8) Comando "bitacora" (solo admin)');
  limpiar();
  await msg('p', OTRO, 'bitacora');
  check('un no-admin no recibe nada', en('p').length === 0);
  await msg('p', ALMA, 'bitacora');
  check('un admin recibe la bitácora de la fila con altas/bajas y motivos', /Bitácora de la fila/.test(ultimo('p')) && /➕ Ana Pérez/.test(ultimo('p')), ultimo('p'));

  console.log('\n9) "M es Miguel Angel" desde Proyecto Bot (etapa1c-5)');
  await db.reiniciarTodo(); await db.setLista(true);
  await db.agregarFila('5215500000091', 'My'); await db.agregarFila('5215500000092', 'M'); await db.agregarFila('5215500000093', 'Mj');
  limpiar();
  await msg('p', OTRO, 'M es Miguel Angel');
  check('un no-admin no puede renombrar', db.getEstado().fila[1].nombre === 'M' && en('p').length === 0);
  await msg('p', ALMA, 'M es Miguel Angel');
  check('el admin renombra a "M" (posición 2) y el bot lo confirma', db.getEstado().fila.map(function(u) { return u.nombre; }).join() === 'My,Miguel Angel,Mj' && /Posición 2/.test(ultimo('p')), ultimo('p') + ' / ' + db.getEstado().fila.map(function(u) { return u.nombre; }));
  limpiar();
  await msg('p', ALMA, 'Hoy es un buen día');
  check('una frase normal con "es" no toca la fila', db.getEstado().fila.length === 3 && db.getEstado().fila.map(function(u) { return u.nombre; }).join() === 'My,Miguel Angel,Mj');

  console.log('\nResultado: ' + ok + '/' + (ok + fail) + ' ✅  ' + fail + ' ❌');
  process.exit(fail ? 1 : 0);
})().catch(function(e) { console.error('ERROR EN TEST', e); process.exit(2); });
