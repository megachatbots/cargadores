// test/parser.js — Casos reales del reporte matutino / estado inicial. Sin red.
process.env.DATABASE_URL = ''; process.env.ANTHROPIC_API_KEY = 'x';
const { mock } = require('node:test');
// 2026-11-03 14:04 México = 20:04 UTC
mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 3, 20, 4, 0) });
const motor = require('../src/motor_cargadores');
const db = require('../src/db_cargadores');
const tiempo = require('../src/tiempo');

let ok = 0, fail = 0;
function check(d, c, x) { if (c) { ok++; console.log('  ✅ ' + d); } else { fail++; console.log('  ❌ ' + d + (x ? ' → ' + x : '')); } }

(async function() {
  await db.inicializar(); await db.reiniciarTodo();

  console.log('\nFormato nuevo del ayudante (líneas separadas, "A" como separador)');
  const rep = [
    'Cajón 41\nVíctor Ojeda\n33G579 Tesla\n1:22 A 4:22',
    'Cajón 42\nCitlali Guzmán\nCupra 68J089\n1:35 A 4:35',
    'Cajón 44\nNancy bañuelos\nBYD 62G718\n1:07 A 4:07',
    'Cajón 45\nEn espera de Ana Mendez',
    'Cajón 46\nCesar Mora\nCarga extendida',
    'Cajón 48\nBrenda Cervantes\nBYD 83J496\n1:16 A 4:16',
    'Cajón 49\nRoxana Ali\nVolvo 76J706\n11:07 A 2:07',
    'Cajón 50\nCarlos Seghun\nCarga extendida'
  ].join('\n\n');
  const items = motor.parsearReporteMatutino(rep);
  check('8 cajones parseados', items && items.length === 8, JSON.stringify(items && items.length));
  const i41 = items.find(x => x.cajon === '41');
  check('41: nombre Víctor Ojeda', i41.nombre === 'Víctor Ojeda', i41.nombre);
  check('41: inicio 1:22 fin 4:22', i41.horaInicio === '1:22' && i41.horaFin === '4:22', i41.horaInicio + '/' + i41.horaFin);
  check('41: placas 33G579, marca Tesla', i41.placas === '33G579' && i41.marca === 'Tesla', i41.placas + '/' + i41.marca);
  const i42 = items.find(x => x.cajon === '42');
  check('42: marca Cupra, placas 68J089', i42.marca === 'Cupra' && i42.placas === '68J089', i42.marca + '/' + i42.placas);
  const i49 = items.find(x => x.cajon === '49');
  check('49: 11:07 A 2:07', i49.horaInicio === '11:07' && i49.horaFin === '2:07');

  console.log('\nFormatos anteriores siguen funcionando');
  const v = motor.parsearReporteMatutino('Cajón 44\nTania 9:35-12:35\nBYD\n79G184\n\nCajón 46\nCesar Mora 8:28-4-28\nBMW\n19J257');
  check('Tania inicio 9:35 fin 12:35 BYD 79G184', v[0].nombre === 'Tania' && v[0].horaInicio === '9:35' && v[0].horaFin === '12:35' && v[0].marca === 'BYD' && v[0].placas === '79G184', JSON.stringify(v[0]));
  check('Cesar 8:28-4-28 → fin 4:28', v[1].horaInicio === '8:28' && v[1].horaFin === '4:28', JSON.stringify(v[1]));
  const m = motor.parsearReporteMatutino('Cajón 41\nDavid antes de las 7:00\nVolt\n33K048\n\nCajón 42\nLibre');
  check('"antes de las 7:00" → inicio 7:00', m[0].nombre === 'David' && m[0].horaInicio === '7:00' && m[0].placas === '33K048', JSON.stringify(m[0]));
  check('Libre', m[1].ocupado === false);

  console.log('\nHorario laboral y fin de sesión (reloj: 14:04)');
  check('1:22 → 13:22', tiempo.horaLocal(tiempo.horaLaboralAISO('1:22')) === '01:22 p.m.', tiempo.horaLocal(tiempo.horaLaboralAISO('1:22')));
  check('11:07 → 11:07 a.m.', tiempo.horaLocal(tiempo.horaLaboralAISO('11:07')) === '11:07 a.m.');
  check('7:00 → 7:00 a.m.', tiempo.horaLocal(tiempo.horaLaboralAISO('7:00')) === '07:00 a.m.');
  await db.cargarEstadoInicial(items);
  const e = db.getEstado().cargadores;
  const fin = function(c) { return tiempo.horaLocal(new Date(e[c].timer_sesion.hora_inicio).getTime() + e[c].timer_sesion.duracion_ms); };
  check('41 termina 4:22 p.m. y sigue activo', fin('41') === '04:22 p.m.' && e['41'].timer_sesion.activo === true, fin('41'));
  check('44 termina 4:07 p.m.', fin('44') === '04:07 p.m.', fin('44'));
  check('49 termina 2:07 p.m. y NO está vencido (son las 2:04)', fin('49') === '02:07 p.m.' && e['49'].timer_sesion.activo === true, fin('49'));
  console.log('\n--- Resumen que vería el admin ---\n' + db.resumenCargadores());

  console.log('\nResultado: ' + ok + '/' + (ok + fail) + ' ✅  ' + fail + ' ❌');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('💥', e); process.exit(2); });
