// test/test_declina.js — Detector puro de "no puedo bajar" con frases reales (9 nov 2026) y frases que NO deben activarlo
const d = require('../src/declina');
let ok = 0, fail = 0;
function check(desc, c, x) { if (c) { ok++; console.log('  ✅ ' + desc); } else { fail++; console.log('  ❌ ' + desc + (x ? ' → ' + x : '')); } }
const tipo = function(t) { const r = d.clasificar(t); return r ? r.tipo + (r.minutos !== undefined ? ':' + r.minutos : '') : null; };

console.log('\nFrases reales dadas por GQ');
[['ahorita no puedo', 'declina'], ['termino junta y bajo', 'declina'], ['me conecto en 10', 'aviso_corto:10'], ['me vuelvo a formar', 'declina'],
 ['bajo en 15 min', 'aviso_corto:15'], ['salí pero en cuanto me regrese me conecto', 'declina'], ['termino una llamada y bajo', 'declina'], ['estoy en reunión', 'declina']
].forEach(function(p) { check('«' + p[0] + '» → ' + p[1], tipo(p[0]) === p[1], tipo(p[0])); });

console.log('\nVariantes (mayúsculas, signos, acentos)');
[['Ahorita no puedo 🙏', 'declina'], ['NO PUEDO BAJAR EN ESTE MOMENTO', 'declina'], ['Estoy en una junta, ahorita bajo', 'declina'], ['Ahorita no puedo, bajo en 10', 'aviso_corto:10'],
 ['bajo en 20 minutos', 'declina'], ['en media hora bajo', 'declina'], ['bajo en una hora', 'declina'], ['en 5 min me conecto', 'aviso_corto:5'], ['mejor me formo al final', 'declina'],
 ['fórmame al final porfa', 'declina'], ['estoy en la llamada con un cliente', 'declina'], ['no estoy en la oficina', 'declina'], ['bajo en un rato', 'declina'], ['salí a comer pero ya regreso', 'declina']
].forEach(function(p) { check('«' + p[0] + '» → ' + p[1], tipo(p[0]) === p[1], tipo(p[0])); });

console.log('\nNO deben activarse');
['ya voy', 'ya bajo', 'voy', 'sí', 'ok gracias', 'listo ya me conecté', 'ahorita bajo', 'gracias', 'ya me desconecté', 'en 10 minutos llego a la oficina?? pregunto otra cosa y escribo un mensaje larguísimo que no es respuesta alguna al llamado de nadie'].forEach(function(t) {
  check('«' + t.substring(0, 50) + '» → null', tipo(t) === null, tipo(t));
});

console.log('\nResultado: ' + ok + '/' + (ok + fail) + ' ✅  ' + fail + ' ❌');
process.exit(fail ? 1 : 0);
