// test_motor.js — Pruebas del motor de cargadores
// Uso: ANTHROPIC_API_KEY=sk-ant-... node test_motor.js
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
process.env.DATABASE_URL = '';

const motor = require('./src/motor');

// ─── CASOS: detección de solicitudes (AI) ─────────────────────────────
const CASOS_SOLICITUD = [
  // Deben detectarse como solicitud
  { rem: 'Almir Lima',           msg: 'Buenos dias m. Me pueden apuntar por favor',               esperado: true },
  { rem: 'Roxana Ali Domínguez', msg: 'Hola, buen día. Me anotan por favor',                      esperado: true },
  { rem: 'Cit',                  msg: 'Buen dia \nA mi también por favor',                        esperado: true },
  { rem: 'Lizbeth Nucamendi',    msg: 'Buenos días me anotan también por favor. Gracias',         esperado: true },
  { rem: 'Marcela Avendaño',     msg: 'Buenos dias ! Me pueden apuntar para después de la 1 pm x favor', esperado: true },
  { rem: 'Rocio Guerrero',       msg: 'Buen día. Me pueden anotar por favor?',                    esperado: true },
  { rem: 'Roxana Ali Domínguez', msg: 'Hola me anotan a mi también por favor. Gracias',           esperado: true },
  { rem: 'Pp Pko',               msg: 'Buenos días! Me pueden apuntar 4pm? Gracias!',             esperado: true },
  { rem: 'Bln💓',                msg: 'Hola buen día me anexan a la lista por favor 🙏🏽 muchas gracias !', esperado: true },
  { rem: 'AMM',                  msg: 'Buenos días. Me anotan en la lista por favor.',            esperado: true },
  { rem: 'MaRyFeR',              msg: 'Buen día. Tmb me anoto porfa',                             esperado: true },
  { rem: 'Pp Pko',               msg: 'Hola! Ya tendrán cargador disponible?',                   esperado: true },
  { rem: 'G',                    msg: 'Me pueden anotar porfa',                                   esperado: true },
  { rem: 'Jhon\'s😎',            msg: 'Me podrían apuntar por favor',                             esperado: true },
  { rem: 'Lalo Aguilar Horta',   msg: 'Hola me pueden anotar por favor',                         esperado: true },
  { rem: 'Ale Medina',           msg: 'Hola buen dia me anotan por favor',                       esperado: true },
  { rem: 'Dan',                  msg: 'Buenos dias me podrían anotar por favor',                  esperado: true },

  // No deben detectarse como solicitud
  { rem: 'Eddson SM',            msg: 'Desconectado',                                             esperado: false },
  { rem: 'Rocio Guerrero',       msg: 'Voy bajando a desconectarme',                              esperado: false },
  { rem: 'AMM',                  msg: 'Desconectado. Gracias',                                    esperado: false },
  { rem: 'Lizbeth Nucamendi',    msg: 'Liberó lugar',                                             esperado: false },
  { rem: 'Luis Gonzalez',        msg: 'Buenos días libero lugar',                                 esperado: false },
  { rem: 'Almir Lima',           msg: 'Desconectado gracias',                                     esperado: false },
  { rem: 'Pp Pko',               msg: 'Gracias!',                                                 esperado: false },
  { rem: 'OJRS',                 msg: 'Bajando Grs',                                              esperado: false },
  { rem: 'Dan',                  msg: 'ya bajo gracias',                                          esperado: false },
  { rem: 'Cit',                  msg: 'Bajo',                                                     esperado: false },
  { rem: 'Tania',                msg: 'Conectada, gracias',                                       esperado: false },
  { rem: 'Jhon\'s😎',            msg: 'Libero lugar',                                             esperado: false },
  { rem: 'Brenda',               msg: 'Hola libero lugar',                                        esperado: false },
  { rem: 'Poncho',               msg: 'Conectado',                                                esperado: false },
];

// ─── CASOS: parser ayudante (regex) ───────────────────────────────────
const CASOS_AYUDANTE = [
  // Conexión simple
  {
    desc: 'Conexión con marca y placas',
    msg: 'Cajón 44\nTania 9:35-12:35\nBYD\n79G184',
    esperado: { tipo: 'conexion', cajon: '44', nombre: 'Tania', marca: 'BYD', placas: '79G184' }
  },
  {
    desc: 'Conexión Tesla',
    msg: 'Cajón 44\nJuan Orta 12:40-3:40\nTesla \n16G080',
    esperado: { tipo: 'conexion', cajon: '44', nombre: 'Juan Orta', marca: 'Tesla', placas: '16G080' }
  },
  {
    desc: 'Conexión BMW',
    msg: 'Cajón 46\nCesar Mora 8:28-4-28\nBMW\n19J257',
    esperado: { tipo: 'conexion', cajon: '46', nombre: 'Cesar Mora' }
  },
  {
    desc: 'Conexión Volvo',
    msg: 'Cajón 49\nEuguenia Cesar 7:25-10:25\nVolvo\n76J706',
    esperado: { tipo: 'conexion', cajon: '49', nombre: 'Euguenia Cesar', marca: 'Volvo', placas: '76J706' }
  },
  // Desconexión
  {
    desc: 'Libre simple con número',
    msg: '44 libre Tania',
    esperado: { tipo: 'libre', cajon: '44' }
  },
  {
    desc: 'Cajón libre formato corto',
    msg: '41 libre',
    esperado: { tipo: 'libre', cajon: '41' }
  },
  {
    desc: 'Cajón libre formato largo',
    msg: 'Cajón 42 libre',
    esperado: { tipo: 'libre', cajon: '42' }
  },
  {
    desc: 'Libre con texto extra',
    msg: '1:50:42 PM Carlos: 42 libre Carlos',
    esperado: { tipo: 'libre', cajon: '42' }
  },
  // Falla
  {
    desc: 'Falla con foco rojo',
    msg: 'El cargador #49 está en foco rojo.',
    esperado: { tipo: 'falla', cajon: '49' }
  },
  // Reporte matutino
  {
    desc: 'Reporte matutino completo',
    msg: `Cajón 41\nDavid antes de las 7:00\nVolt\n33K048\n\nCajón 42\nCupra antes de las 7:00\n68J089\n\nCajón 44\nCupra antes de las 7:00\n62G718\n\nCajón 45\nSandra Marin antes de las 7:00\nMG\nMCG681A\n\nCajón 46\nLibre uso extendido \n\nCajón 48\nBYD antes de las 7:00\n83J496\n\nCajón 49\nEuguenia Cesar 7:25-10:25\nVolvo\n76J706\n\nCajón 50 \nLibre uso extendido`,
    esperado: { tipo: 'reporte_matutino', min_items: 6 }
  },
];

// ─── RUNNER ───────────────────────────────────────────────────────────
async function correr() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Falta ANTHROPIC_API_KEY');
    process.exit(1);
  }

  console.log('\n🔌 PRUEBAS — Bot Cargadores Eléctricos');
  console.log('─'.repeat(60));

  let ok = 0, fail = 0;
  const fallidos = [];

  // ── Pruebas AI: solicitudes ──
  console.log('\n📱 Detección de solicitudes (AI)\n');
  for (const caso of CASOS_SOLICITUD) {
    process.stdout.write(`  [${caso.esperado ? 'SÍ' : 'NO'}] ${caso.rem}: "${caso.msg.substring(0,50)}"... `);
    try {
      const r = await motor.detectarSolicitud(caso.msg, caso.rem);
      const pasoPrefiltro = motor.preFiltraSolicitud(caso.msg);

      if (r.es_solicitud === caso.esperado) {
        console.log('✅');
        ok++;
      } else {
        console.log(`❌ → es_solicitud:${r.es_solicitud} (prefiltro:${pasoPrefiltro})`);
        fail++;
        fallidos.push({ tipo: 'solicitud', caso, resultado: r });
      }
    } catch (e) {
      console.log(`💥 ${e.message}`);
      fail++;
    }
    await new Promise(r => setTimeout(r, 800));
  }

  // ── Pruebas regex: ayudante ──
  console.log('\n🔧 Parser ayudante (regex)\n');
  for (const caso of CASOS_AYUDANTE) {
    process.stdout.write(`  ${caso.desc}... `);
    const r = motor.parsearAyudante(caso.msg);
    if (!r) {
      console.log(`❌ → null (no reconoció nada)`);
      fail++;
      fallidos.push({ tipo: 'ayudante', caso, resultado: null });
      continue;
    }
    const errores = [];
    if (r.tipo !== caso.esperado.tipo) errores.push(`tipo: esperaba "${caso.esperado.tipo}", obtuvo "${r.tipo}"`);
    if (caso.esperado.cajon && r.cajon !== caso.esperado.cajon) errores.push(`cajón: esperaba "${caso.esperado.cajon}", obtuvo "${r.cajon}"`);
    if (caso.esperado.nombre && r.nombre !== caso.esperado.nombre) errores.push(`nombre: esperaba "${caso.esperado.nombre}", obtuvo "${r.nombre}"`);
    if (caso.esperado.marca && r.marca !== caso.esperado.marca) errores.push(`marca: esperaba "${caso.esperado.marca}", obtuvo "${r.marca}"`);
    if (caso.esperado.placas && r.placas !== caso.esperado.placas) errores.push(`placas: esperaba "${caso.esperado.placas}", obtuvo "${r.placas}"`);
    if (caso.esperado.min_items && (!r.items || r.items.length < caso.esperado.min_items))
      errores.push(`items: esperaba ≥${caso.esperado.min_items}, obtuvo ${r.items?.length || 0}`);

    if (!errores.length) { console.log('✅'); ok++; }
    else { console.log(`❌\n     → ${errores.join('; ')}`); fail++; fallidos.push({ tipo: 'ayudante', caso, resultado: r }); }
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`\nResultado: ${ok}/${ok + fail} ✅  ${fail} ❌`);
  if (fail === 0) {
    console.log('✅ Todos los casos pasan. Listo para producción.');
  } else {
    console.log('\n📋 Fallos:');
    fallidos.forEach(f => {
      console.log(`  • [${f.tipo}] ${f.caso.desc || f.caso.rem}: ${JSON.stringify(f.resultado).substring(0, 100)}`);
    });
  }
}

correr().catch(console.error);
