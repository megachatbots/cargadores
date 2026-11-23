// test/ayudante.js — Parser del ayudante con mensajes reales (sin red)
process.env.DATABASE_URL = ''; process.env.ANTHROPIC_API_KEY = 'x';
const A = require('../src/ayudante');
let ok = 0, fail = 0;
function check(d, c, x) { if (c) { ok++; console.log('  ✅ ' + d); } else { fail++; console.log('  ❌ ' + d + (x ? ' → ' + x : '')); } }
const j = JSON.stringify;
function ev(t) { return A.parsearMensajeAyudante(t); }
// Libres: solo los cajones válidos (el evento 'libre' trae además `invalidos`)
function lib(t) { const r = ev(t); return r.length === 1 && r[0].tipo === 'libre' ? r[0].cajones.join() : j(r.map(function(x) { return x.tipo; })); }

console.log('\nConexiones');
let e = ev('Se conecta \nCajón 41\nVíctor Ojeda \n33G579 Tesla \n1:22 A 4:22');
check('Se conecta / Cajón 41 / Víctor Ojeda / 33G579 Tesla / 1:22 A 4:22', e.length === 1 && e[0].tipo === 'conecta' && e[0].cajon === '41' &&
  e[0].nombre === 'Víctor Ojeda' && e[0].placas === '33G579' && e[0].marca === 'Tesla' && e[0].horaInicio === '1:22' && e[0].horaFin === '4:22' && !e[0].nombreDudoso, j(e));
e = ev('Cajón 44\nTania 9:35-12:35\nBYD\n79G184');
check('formato anterior (una línea nombre+hora)', e.length === 1 && e[0].tipo === 'conecta' && e[0].nombre === 'Tania' && e[0].marca === 'BYD' && e[0].placas === '79G184', j(e));
e = ev('Cajón 46\nCesar Mora 8:28-4-28\nBMW\n19J257');
check('8:28-4-28', e.length === 1 && e[0].horaInicio === '8:28' && e[0].horaFin === '4:28', j(e));
e = ev('Se conecta\nCajón 41\nAna Pérez\n11A111 BYD\n1:00 A 4:00\n\nCajón 42\nLuis Gómez\nVolvo 22B222\n1:05 A 4:05');
check('dos bloques con "Se conecta" → 2 conexiones', e.length === 2 && e[0].cajon === '41' && e[1].cajon === '42' && e[1].marca === 'Volvo' && e[1].placas === '22B222', j(e));
e = ev('Se conecta\nCajón 44\nCupra\n62G718\n2:10 A 5:10');
check('nombre es una marca → dudoso', e.length === 1 && e[0].nombre === 'Cupra' && e[0].nombreDudoso === true, j(e));
e = ev('Se conecta\nCajón 45\nCarlos Guadarrama\n83F796');
check('Se conecta sin hora → horaInicio null', e.length === 1 && e[0].horaInicio === null && e[0].placas === '83F796', j(e));

console.log('\nLibres');
check('41 libre', lib('41 libre') === '41', lib('41 libre'));
check('44 libre Tania', lib('44 libre Tania') === '44');
check('Cajón 42 libre (mensaje real)', lib('Cajón 42 libre') === '42');
check('1:50:42 PM Carlos: 42 libre Carlos', lib('1:50:42 PM Carlos: 42 libre Carlos') === '42', lib('1:50:42 PM Carlos: 42 libre Carlos'));
check('41 y 42 libres', lib('41 y 42 libres') === '41,42', lib('41 y 42 libres'));
check('Cajón 41 libre / Cajón 42 libre (dos líneas)', lib('Cajón 41 libre\nCajón 42 libre') === '41,42', lib('Cajón 41 libre\nCajón 42 libre'));
check('"Cajón 46\\nLibre uso extendido" suelto no es libre', ev('Cajón 46\nLibre uso extendido').length === 0, j(ev('Cajón 46\nLibre uso extendido')));
check('cajón inexistente (47): no libera nada, queda como inválido', (function() { const r = ev('47 libre'); return r.length === 1 && r[0].cajones.length === 0 && r[0].invalidos.join() === '47'; })(), j(ev('47 libre')));

console.log('\nLibres: mensajes reales del ayudante y formatos nuevos');
e = ev('Cajón 41,42,44,45,46,48,49,59 libres');
check('real: "Cajón 41,42,44,45,46,48,49,59 libres" → 7 válidos y el 59 como inválido', e.length === 1 && e[0].cajones.join() === '41,42,44,45,46,48,49' && e[0].invalidos.join() === '59', j(e));
check('Cajón 41,42,44,45,46,48,49,50 libres → los 8', lib('Cajón 41,42,44,45,46,48,49,50 libres') === '41,42,44,45,46,48,49,50');
check('Libre 41', lib('Libre 41') === '41');
check('Libre el 41', lib('Libre el 41') === '41');
check('Libre cajón 41', lib('Libre cajón 41') === '41');
check('Libres 41 y 42', lib('Libres 41 y 42') === '41,42');
check('41: libre', lib('41: libre') === '41');
check('Cajón 41 - libre', lib('Cajón 41 - libre') === '41');
check('41 ya está libre', lib('41 ya está libre') === '41');
check('41 quedó libre', lib('41 quedó libre') === '41');
check('"libre 45 minutos" NO libera el 45', ev('queda libre 45 minutos').length === 0, j(ev('queda libre 45 minutos')));
check('hora "12:45 libre" NO libera el 45', ev('12:45 libre').length === 0, j(ev('12:45 libre')));
e = ev('Se desconecta Juan Pérez\n41 libre');
check('"Se desconecta X" + "41 libre" → desconectaron(X) y libre(41)', e.length === 2 && e[0].tipo === 'desconectaron' && j(e[0].nombres) === j(['Juan Pérez']) && e[1].tipo === 'libre' && e[1].cajones.join() === '41', j(e));
e = ev('Se desconecta\nJuan Pérez\nCajón 41 libre');
check('misma cosa con salto de línea antes', e.length === 2 && j(e[0].nombres) === j(['Juan Pérez']) && e[1].cajones.join() === '41', j(e));
check('"Cajón 46\\nLibre" (dos líneas) sigue sin ser libre', ev('Cajón 46\nLibre').length === 0);

console.log('\nDesconectaron (confirmación) vs recordar');
e = ev('Se desconectan \nDavid Shelfeld \nFrancisco Antonello');
check('Se desconectan / David Shelfeld / Francisco Antonello', e.length === 1 && e[0].tipo === 'desconectaron' && j(e[0].nombres) === j(['David Shelfeld', 'Francisco Antonello']), j(e));
e = ev('se tiene que desconectar usuario Francisco Antonello');
check('se tiene que desconectar usuario X', e.length === 1 && e[0].tipo === 'recordar' && j(e[0].nombres) === j(['Francisco Antonello']), j(e));
e = ev('Se desconectan Ana y Luis');
check('"Ana y Luis" en una línea → 2 nombres', e.length === 1 && e[0].nombres.length === 2, j(e));
check('"apoyo para desconectar tu vehículo" NO es recordatorio', ev('@210706850914377 apoyo para desconectar tu vehículo por favor').length === 0);

console.log('\nOtros');
check('2 lugares disponibles', j(ev('2 lugares disponibles')) === j([{ tipo: 'disponibles', n: 2 }]));
check('reporte de 8 cajones → reporte', ev('Cajón 41\nDavid antes de las 7:00\nVolt\n33K048\n\nCajón 42\nLibre\n\nCajón 44\nTania 9:35-12:35\nBYD\n79G184').map(x => x.tipo).join() === 'reporte');
check('falla de cajón no es conexión', ev('Cajón 49 en foco rojo').length === 0, j(ev('Cajón 49 en foco rojo')));
check('"El cargador #49 está en foco rojo." → nada', ev('El cargador #49 está en foco rojo.').length === 0);
check('charla ("Mando Citlali guzman y a Ana mendez", "Ok") → nada', ev('Mando Citlali guzman y a Ana mendez').length === 0 && ev('Ok').length === 0);

console.log('\nBúsqueda tolerante de nombres');
const ocup = [{ id: '41', nombre: 'Víctor Ojeda' }, { id: '42', nombre: 'Nancy bañuelos' }, { id: '44', nombre: 'Nancy López' }];
check('sin acentos/mayúsculas: "victor ojeda"', A.buscarPorNombre('victor ojeda', ocup).map(x => x.id).join() === '41');
check('orden distinto: "Ojeda Víctor"', A.buscarPorNombre('Ojeda Víctor', ocup).map(x => x.id).join() === '41');
check('parcial ambiguo: "Nancy" → 2', A.buscarPorNombre('Nancy', ocup).map(x => x.id).join() === '42,44');
check('exacto gana: "Nancy López" → 44', A.buscarPorNombre('Nancy López', ocup).map(x => x.id).join() === '44');
check('sin coincidencia: "Pedro"', A.buscarPorNombre('Pedro', ocup).length === 0);
check('no confunde "Ana" con "Nancy"', A.buscarPorNombre('Ana', ocup).length === 0);

console.log('\nBúsqueda con errores de ortografía (casos reales)');
check('"Javier Dominges" encuentra "Javier Domínguez"', A.buscarPorNombre('Javier Dominges', [{ id: '1', nombre: 'Javier Domínguez' }]).length === 1);
check('"Zamany Nieto" encuentra "Zamanny Nieto"', A.buscarPorNombre('Zamany Nieto', [{ id: '2', nombre: 'Zamanny Nieto' }]).length === 1);
check('"Carlos Guadarrama" NO confunde con "Carlos Seghun"', A.buscarPorNombre('Carlos Guadarrama', [{ id: '3', nombre: 'Carlos Seghun' }]).length === 0);
check('"Ale E" NO confunde con "Alejandra Espinosa"', A.buscarPorNombre('Ale E', [{ id: '4', nombre: 'Alejandra Espinosa' }]).length === 0);
check('"Pablo" NO confunde con "Pamela"', A.buscarPorNombre('Pablo', [{ id: '5', nombre: 'Pamela Arestegui' }]).length === 0);
check('"Gerardo Jurado" encuentra "Gérardo Jurado"', A.buscarPorNombre('Gerardo Jurado', [{ id: '6', nombre: 'Gérardo Jurado' }]).length === 1);

console.log('\nBúsqueda tolerante: caso real "papapimosh", letras intercambiadas y parte del nombre');
check('"papapimosh" encuentra "Pasapimosh"', A.buscarPorNombre('papapimosh', [{ id: '1', nombre: 'Pasapimosh' }]).length === 1);
check('"gerardo juardo" (letras intercambiadas) encuentra "Gerardo Jurado"', A.buscarPorNombre('gerardo juardo', [{ id: '1', nombre: 'Gerardo Jurado' }]).length === 1);
check('"pimosh" (parte del nombre) encuentra "Pasapimosh"', A.buscarPorNombre('pimosh', [{ id: '1', nombre: 'Pasapimosh' }]).length === 1);
check('"Pedro" sigue sin encontrar "Pasapimosh"', A.buscarPorNombre('Pedro', [{ id: '1', nombre: 'Pasapimosh' }]).length === 0);

console.log('\nDesconexión con el nombre primero (capturas reales del 5 nov: "Citlali Guzmán desconectada")');
function desc(t) { const r = ev(t); return r.length && r[0].tipo === 'desconectaron' ? j(r[0].nombres) : j(r.map(function(x) { return x.tipo; })); }
e = ev('Citlali Guzmán desconectada\n1 cargador disponible');
check('REAL "Citlali Guzmán desconectada / 1 cargador disponible" → desconectaron + disponibles(1), en ese orden', e.length === 2 && e[0].tipo === 'desconectaron' && j(e[0].nombres) === j(['Citlali Guzmán']) && e[1].tipo === 'disponibles' && e[1].n === 1, j(e));
check('"Citlali Guzmán desconectada"', desc('Citlali Guzmán desconectada') === j(['Citlali Guzmán']));
check('"Citlali desconectado"', desc('Citlali desconectado') === j(['Citlali']));
check('"Citlali se desconectó"', desc('Citlali se desconectó') === j(['Citlali']));
check('"Citlali ya se desconectó"', desc('Citlali ya se desconectó') === j(['Citlali']));
check('"Se desconectó Citlali" (antes no se reconocía: \\b y la ó)', desc('Se desconectó Citlali') === j(['Citlali']), desc('Se desconectó Citlali'));
check('"Ya se desconectó Citlali"', desc('Ya se desconectó Citlali') === j(['Citlali']));
check('"Roxana y Citlali desconectadas" → dos nombres', desc('Roxana y Citlali desconectadas') === j(['Roxana', 'Citlali']));
check('una línea por persona + "2 cargadores disponibles"', (function() { const r = ev('Citlali Guzmán desconectada\nRoxana Ali desconectada\n2 cargadores disponibles'); return r.length === 2 && j(r[0].nombres) === j(['Citlali Guzmán', 'Roxana Ali']) && r[1].n === 2; })());
check('"Citlali Guzmán desconectada a las 2:42"', desc('Citlali Guzmán desconectada a las 2:42') === j(['Citlali Guzmán']));
check('"Pablo Perez desconectado, 45 libre" → desconectaron + libre(45)', (function() { const r = ev('Pablo Perez desconectado, 45 libre'); return r.length === 2 && r[1].tipo === 'libre' && r[1].cajones.join() === '45'; })());
check('"Se desconecta Citlali" sigue funcionando', desc('Se desconecta Citlali') === j(['Citlali']));
console.log('  — falsos positivos que NO deben liberar nada —');
check('"Citlali no se ha desconectado"', ev('Citlali no se ha desconectado').length === 0, j(ev('Citlali no se ha desconectado')));
check('"Falta que se desconecte Citlali"', ev('Falta que se desconecte Citlali').length === 0);
check('"Roxana desconectó a Citlali" (otra persona la desconectó)', ev('Roxana desconectó a Citlali').length === 0);
check('"Roxana desconectó el cargador"', ev('Roxana desconectó el cargador').length === 0);
check('"Nadie se desconectó"', ev('Nadie se desconectó').length === 0, j(ev('Nadie se desconectó')));
check('"Se desconectó" (sin nombre)', ev('Se desconectó').length === 0);
check('un reporte de conexión no se toca', ev('Se conecta\nCajón 42\nPablo Perez\n04k546 Tesla\n3:45 A 6:45').length === 1 && ev('Se conecta\nCajón 42\nPablo Perez\n04k546 Tesla\n3:45 A 6:45')[0].tipo === 'conecta');

console.log('\nRecordatorio con el nombre primero (captura: "Roxana se tiene que desconectar")');
check('REAL "Roxana se tiene que desconectar" → recordar', (function() { const r = ev('Roxana se tiene que desconectar'); return r.length === 1 && r[0].tipo === 'recordar' && j(r[0].nombres) === j(['Roxana']); })(), j(ev('Roxana se tiene que desconectar')));
check('REAL "Se tiene que desconectar Citlali" sigue funcionando', (function() { const r = ev('Se tiene que desconectar Citlali'); return r.length === 1 && r[0].tipo === 'recordar' && j(r[0].nombres) === j(['Citlali']); })());
check('"Roxana y Nancy se tienen que desconectar"', (function() { const r = ev('Roxana y Nancy se tienen que desconectar'); return r.length === 1 && j(r[0].nombres) === j(['Roxana', 'Nancy']); })());
check('dos líneas, una por persona', (function() { const r = ev('Roxana se tiene que desconectar\nCitlali se tiene que desconectar'); return r.length === 1 && j(r[0].nombres) === j(['Roxana', 'Citlali']); })());
check('mezclado con texto ajeno NO se interpreta', ev('Roxana se tiene que desconectar\nMando a Pablo').length === 0);

console.log('\nFormatos reales del ayudante nuevo (23 nov): "N / Nombre conectada H a H" y "Nombre / Desconectado"');
e = ev('42\nEricka Rodríguez conectada 9:38 a 12:38');
check('REAL "42 / Ericka Rodríguez conectada 9:38 a 12:38"', e.length === 1 && e[0].tipo === 'conecta' && e[0].cajon === '42' && e[0].nombre === 'Ericka Rodríguez' && e[0].horaInicio === '9:38' && e[0].horaFin === '12:38' && !e[0].nombreDudoso, j(e));
e = ev('45 \nDavid seinfield conectado 10:47 a 1:47');
check('REAL número con espacio al final y 1:47 (p.m.)', e.length === 1 && e[0].cajon === '45' && e[0].horaInicio === '10:47' && e[0].horaFin === '1:47', j(e));
e = ev('48\nNancy Bañuelos conectada 10:59 a 1:59\n');
check('REAL con salto de línea final', e.length === 1 && e[0].cajon === '48' && e[0].nombre === 'Nancy Bañuelos', j(e));
const lista = '41\nAlix Córdoba \nByd 02G518 \nConectada antes de 7 am.\n\n42\nRossy Curiel \nLink&Co 49H364 \nConectada 7:03 a 10:03\n\n44\nEugenia César \nVolvo 76J706\nConectada 7:12 a 10:12 \n\n45\nGerardo Jurado \nGeely 56k948\nConectado 7:20 a 10:20\n\n46\nJavier Jara\nBMW 77j430\nConectado uso extendido \n\n48\nHéctor Alvarez \nGeely 13h621\nConectado antes de las 7 am \n\n49\nErick Palomec \nByd 42k093\nConectado 7:10 a 10:10\n\n50\nCarlos Seghun \nZeekr 90j941\nConectado uso extendido';
e = ev(lista);
check('REAL lista de las 8:11: 8 conexiones', e.length === 8 && e.every(function(x) { return x.tipo === 'conecta'; }), j(e.map(function(x) { return x.cajon; })));
check('   · "antes de 7 am" → inicio 7:00 sin hora fin', e[0].cajon === '41' && e[0].horaInicio === '7:00' && e[0].horaFin === null && e[5].cajon === '48' && e[5].horaInicio === '7:00', j([e[0], e[5]]));
check('   · placas y marca de cada bloque', e[1].marca === 'Link&Co' && e[1].placas === '49H364' && e[3].placas === '56K948', j([e[1], e[3]]));
check('   · "uso extendido" sin hora → inicio null (se cuenta desde ahora)', e[4].cajon === '46' && e[4].horaInicio === null && e[7].cajon === '50' && e[7].horaInicio === null, j([e[4], e[7]]));
check('"41\\nLibre" y "46\\nLibre uso extendido" NO son conexiones', ev('48\nLibre uso extendido').length === 0 && ev('41\nLibre').filter(function(x) { return x.tipo === 'conecta'; }).length === 0);
check('"42\\nPablo no se ha conectado" NO es conexión', ev('42\nPablo no se ha conectado').length === 0, j(ev('42\nPablo no se ha conectado')));
check('cajón inexistente (59) no genera conexión', ev('59\nPablo Perez conectado 9:00 a 12:00').length === 0);
e = ev('Miguel Juarez \nDesconectado');
check('REAL "Miguel Juarez / Desconectado" (2 líneas)', e.length === 1 && e[0].tipo === 'desconectaron' && j(e[0].nombres) === j(['Miguel Juarez']), j(e));
e = ev('Rosy Curiel \nDesconectada');
check('REAL "Rosy Curiel / Desconectada"', e.length === 1 && e[0].tipo === 'desconectaron' && j(e[0].nombres) === j(['Rosy Curiel']), j(e));
e = ev('Ana Mendez\n Se tiene que desconectar');
check('REAL "Ana Mendez / Se tiene que desconectar" (2 líneas) → recordar', e.length === 1 && e[0].tipo === 'recordar' && j(e[0].nombres) === j(['Ana Mendez']), j(e));
e = ev('Alejamos Espinosa \nSe desconecta');
check('REAL "Alejamos Espinosa / Se desconecta" → confirmación', e.length === 1 && e[0].tipo === 'desconectaron', j(e));
check('"Se desconecta\\n\\nNombre" (orden inverso) sigue igual', j(ev('Se desconecta\n\nCitlali')) === j([{ tipo: 'desconectaron', nombres: ['Citlali'] }]), j(ev('Se desconecta\n\nCitlali')));
check('REAL "Rossy Curiel desconectada" y "Libre 42" siguen igual', ev('Rossy Curiel desconectada')[0].tipo === 'desconectaron' && lib('Libre 42') === '42');

console.log('\nResultado: ' + ok + '/' + (ok + fail) + ' ✅  ' + fail + ' ❌');
process.exit(fail ? 1 : 0);
