// src/declina.js — Detecta cuando alguien a quien ya se llamó dice que NO puede bajar/conectarse ahora.
// Módulo puro (sin dependencias de BD ni WhatsApp). Solo se consulta si la persona tiene un llamado activo.
//   clasificar(texto) → null
//                     | { tipo: 'declina' }                      → se vuelve a formar al final y se llama al siguiente
//                     | { tipo: 'aviso_corto', minutos: N }      → promete conectarse en ≤ MAX_AVISO_CORTO min: solo se avisa a Proyecto Bot
// Regla (ajustable): promesa explícita ≤ 15 min = aviso; todo lo abierto ("termino mi junta y bajo") o > 15 min = se reforma.
const MAX_AVISO_CORTO = 15;
const MAX_PALABRAS = 22;   // mensajes largos casi siempre son conversación, no una respuesta al llamado

function normalizar(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Petición explícita de volver a la fila: gana siempre, aunque mencione minutos
const RE_REFORMAR = /\b(me\s+(vuelvo|voy|regreso)\s+a\s+(formar|anotar|registrar|poner)|vuelvo\s+a\s+formarme|(formame|anotame|ponme|mandame|pasame|regresame)\s+(al\s+final|hasta\s+atras)|(me\s+)?(formo|anoto)\s+(al\s+final|de\s+nuevo|otra\s+vez)|paso\s+mi\s+turno|cedo\s+(mi\s+)?turno|que\s+pase\s+(el|la)\s+siguiente|dejalo\s+para\s+(el|la)\s+siguiente)\b/;

// Negativas / impedimentos
const RE_NO_PUEDO = /\b(no\s+(puedo|podre|podria|voy\s+a\s+poder|alcanzo|alcance|alcanzare|me\s+es\s+posible)|(ahorita|ahora|en\s+este\s+momento|por\s+el\s+momento)\s+no(\s+(puedo|se\s+puede|voy|podria))?|no\s+estoy\s+(en|aqui|alla|cerca|disponible)|no\s+me\s+puedo)\b/;

// Ocupado: reunión, junta, llamada…
const RE_OCUPADO = /\b(estoy|ando|sigo|seguimos|estamos)\s+(todavia\s+|aun\s+)?(en|con|dando)\s+(una\s+|la\s+|mi\s+|un\s+|el\s+)?(junta|reunion|llamada|call|meeting|clase|cita|presentacion|comida|visita|evento|curso)\b/;
const RE_TERMINO_Y_BAJO = /\b(termino|acabo|salgo\s+de|cuando\s+termine|en\s+cuanto\s+termine|al\s+terminar|despues\s+de)\b.*\b(junta|reunion|llamada|call|meeting|clase|cita|presentacion|comida)\b/;
// Abierto: "en cuanto me regrese", "cuando llegue", "salí pero…"
const RE_ABIERTO = /\b(en\s+cuanto|cuando|apenas|tan\s+pronto\s+como)\s+(me\s+)?(regrese|llegue|vuelva|pueda|termine|salga|acabe)\b|\bsali\b.*\bpero\b|\bsalgo\s+(a|de)\b.*\bpero\b|\ben\s+un\s+(rato|ratito)\b|\bmas\s+tarde\b|\bdespues\s+bajo\b|\bluego\s+(bajo|me\s+conecto)\b/;

// Promesas con minutos: "me conecto en 10", "bajo en 15 min", "en 5 minutos", "en media hora", "en una hora"
function minutosPrometidos(t) {
  if (/\bmedia\s+hora\b/.test(t)) return 30;
  if (/\bun\s+cuarto\s+de\s+hora\b/.test(t)) return 15;
  let m = t.match(/\ben\s+(\d{1,3})\s*(hora|horas|hr|hrs|h)\b/);
  if (m) return parseInt(m[1], 10) * 60;
  if (/\ben\s+(una|1)\s+hora\b/.test(t)) return 60;
  if (/\ben\s+(dos|2)\s+horas\b/.test(t)) return 120;
  m = t.match(/\b(?:en|dentro\s+de)\s+(\d{1,3})\s*(?:min|mins|minuto|minutos|minutitos|m)?\b/);
  if (m) return parseInt(m[1], 10);
  m = t.match(/\b(?:en|dentro\s+de)\s+(cinco|diez|quince|veinte)\s*(?:min|mins|minutos)?\b/);
  if (m) return { cinco: 5, diez: 10, quince: 15, veinte: 20 }[m[1]];
  return null;
}

function clasificar(texto) {
  const t = normalizar(texto);
  if (!t || t.split(' ').length > MAX_PALABRAS) return null;

  if (RE_REFORMAR.test(t)) return { tipo: 'declina' };

  const min = minutosPrometidos(t);
  const hayImpedimento = RE_NO_PUEDO.test(t) || RE_OCUPADO.test(t) || RE_TERMINO_Y_BAJO.test(t) || RE_ABIERTO.test(t);

  // Promesa concreta: ≤ 15 → solo aviso; > 15 → se reforma. Tiene que sonar a conectarse (verbo) o a impedimento.
  if (min !== null) {
    const verbo = /\b(bajo|bajar|bajare|baje|me\s+conecto|conecto|conectarme|conectar|voy|llego|llegare|ya\s+mero|salgo|estoy\s+ahi|alla\s+estoy|me\s+paso|subo)\b/.test(t) || hayImpedimento;
    if (verbo) {
      if (min <= MAX_AVISO_CORTO) return { tipo: 'aviso_corto', minutos: min };
      return { tipo: 'declina' };
    }
  }
  if (hayImpedimento) return { tipo: 'declina' };
  return null;
}

module.exports = { clasificar, normalizar, MAX_AVISO_CORTO };
