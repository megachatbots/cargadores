// test/ayudante.js — Parser del ayudante con mensajes reales (sin red)
process.env.DATABASE_URL = ''; process.env.ANTHROPIC_API_KEY = 'x';
const A = require('../src/ayudante');
let ok = 0, fail = 0;
function check(d, c, x) { if (c) { ok++; console.log('  ✅ ' + d); } else { fail++; console.log('  ❌ ' + d + (x ? ' → ' + x : '')); } }
const j = JSON.stringify;
function ev(t) { return A.parsearMensajeAyudante(t); }

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
check('41 libre', j(ev('41 libre')) === j([{ tipo: 'libre', cajones: ['41'] }]), j(ev('41 libre')));
check('44 libre Tania', j(ev('44 libre Tania')) === j([{ tipo: 'libre', cajones: ['44'] }]));
check('Cajón 42 libre', j(ev('Cajón 42 libre')) === j([{ tipo: 'libre', cajones: ['42'] }]));
check('1:50:42 PM Carlos: 42 libre Carlos', j(ev('1:50:42 PM Carlos: 42 libre Carlos')) === j([{ tipo: 'libre', cajones: ['42'] }]), j(ev('1:50:42 PM Carlos: 42 libre Carlos')));
check('41 y 42 libres', j(ev('41 y 42 libres')) === j([{ tipo: 'libre', cajones: ['41', '42'] }]), j(ev('41 y 42 libres')));
check('Cajón 41 libre / Cajón 42 libre (dos líneas)', j(ev('Cajón 41 libre\nCajón 42 libre')) === j([{ tipo: 'libre', cajones: ['41', '42'] }]), j(ev('Cajón 41 libre\nCajón 42 libre')));
check('"Cajón 46\\nLibre uso extendido" suelto no es libre', ev('Cajón 46\nLibre uso extendido').length === 0, j(ev('Cajón 46\nLibre uso extendido')));
check('cajón inexistente (47) se ignora', ev('47 libre').length === 0);

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

console.log('\nResultado: ' + ok + '/' + (ok + fail) + ' ✅  ' + fail + ' ❌');
process.exit(fail ? 1 : 0);
