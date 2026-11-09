// test/test_alias.js — "M es Miguel Angel": renombrar en la fila con alias persistente por número
process.env.DATABASE_URL = ''; process.env.ANTHROPIC_API_KEY = 'x';
const db = require('../src/db_cargadores');
const filaCmd = require('../src/fila_cmd');
const fc = filaCmd.crear(db);
let ok = 0, fail = 0;
function check(d, c, x) { if (c) { ok++; console.log('  ✅ ' + d); } else { fail++; console.log('  ❌ ' + d + (x ? ' → ' + x : '')); } }
const nombres = function() { return db.getEstado().fila.map(function(u) { return u.nombre; }).join(' | '); };
const run = async function(t) { const c = filaCmd.interpretar(t); return c ? fc.ejecutar(c) : undefined; };

(async function() {
  await db.inicializar(); await db.reiniciarTodo();
  for (const [n, nom] of [['5215500000001', 'Erika'], ['5215500000002', 'My'], ['5215500000003', 'M'], ['5215500000004', 'Alex M'], ['5215500000005', 'Mj'], ['5215500000006', 'Cit']]) await db.agregarFila(n, nom);

  console.log('\nInterpretación');
  check('"M es Miguel Angel" → renombrar', JSON.stringify(filaCmd.interpretar('M es Miguel Angel')) === JSON.stringify({ tipo: 'renombrar', quien: 'M', nombre: 'Miguel Angel' }), JSON.stringify(filaCmd.interpretar('M es Miguel Angel')));
  check('"44 es Ana López" NO es renombrar (es de cajones)', (filaCmd.interpretar('44 es Ana López') || {}).tipo !== 'renombrar');
  check('"3 se llama Miguel Angel" → por posición', (filaCmd.interpretar('3 se llama Miguel Angel') || {}).tipo === 'renombrar_pos');

  console.log('\nEjecución');
  const r = await run('M es Miguel Angel');
  check('"M es Miguel Angel" renombra SOLO a "M" (aunque My, Mj y Alex M contienen la letra)', nombres() === 'Erika | My | Miguel Angel | Alex M | Mj | Cit', nombres() + ' / ' + r);
  check('respuesta: posición 3, guardado', /Posición 3/.test(r) && /«M» ahora es \*Miguel Angel\*/.test(r) && /guardado/.test(r), r);
  check('la lista estática también muestra el nombre real', db.resumenListaEstatica().indexOf('Miguel Angel') !== -1);
  check('alias guardado por número', db.getAlias('5215500000003') === 'Miguel Angel');
  check('la bitácora lo registra', db.bitacoraFila(5).some(function(x) { return x.ev === 'renombre'; }));

  const r2 = await run('Es muy importante que revisen el cajón 44 es');
  check('una frase cualquiera con "es" no renombra a nadie', r2 === null || r2 === undefined, r2);
  const r3 = await run('eso es todo por hoy');
  check('"eso es todo por hoy" no hace nada', r3 === null, r3);
  const r4 = await run('Zzz es Fulano');
  check('nombre que no está en la fila → silencio (null)', r4 === null, r4);
  check('por posición: "6 se llama Citlali Guzmán"', /Posición 6/.test(await run('6 se llama Citlali Guzmán')) && db.getEstado().fila[5].nombre === 'Citlali Guzmán');
  check('posición inexistente → error', /no existe/.test(await run('20 se llama X Y')));

  console.log('\nAl día siguiente: Miguel vuelve a escribir como "M" y entra ya con su nombre real');
  await db.reiniciarTodo();
  await db.agregarFila('5215500000003', 'M');
  check('entra como "Miguel Angel"', nombres() === 'Miguel Angel', nombres());

  console.log('\nEl ayudante lo conecta por su nombre completo y sale de la fila con su número');
  const ayud = require('../src/ayudante');
  const ms = ayud.buscarPorNombre('Miguel Ángel Martínez', db.getEstado().fila.map(function(u) { return { id: u.numero, nombre: u.nombre, numero: u.numero }; }));
  check('"Miguel Ángel Martínez" reconoce a "Miguel Angel" de la fila', ms.length === 1 && ms[0].numero === '5215500000003', JSON.stringify(ms));

  console.log('\nResultado: ' + ok + '/' + (ok + fail) + ' ✅  ' + fail + ' ❌');
  process.exit(fail ? 1 : 0);
})().catch(function(e) { console.error('💥', e); process.exit(2); });
