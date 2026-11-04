// src/tiempo.js — Única fuente de hora (America/Mexico_City). Usa Date.now() internamente,
// así el simulador puede falsear el reloj con node:test mock.timers.
const TZ = 'America/Mexico_City';

function ahoraMs()  { return Date.now(); }
function ahoraISO() { return new Date(Date.now()).toISOString(); }

// "HH:MM" (24h) en hora de México a partir de ISO o ms
function horaLocal(isoOMs) {
  if (isoOMs === null || isoOMs === undefined || isoOMs === '') return '?';
  const d = new Date(isoOMs);
  if (isNaN(d.getTime())) return '?';
  return d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
}

// Partes de fecha/hora actuales en México
function partesMex(ms) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(ms === undefined ? Date.now() : ms));
  const o = {};
  f.forEach(function(p) { o[p.type] = p.value; });
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second };
}

// Offset de México respecto a UTC en ms (negativo) para un instante dado
function offsetMex(ms) {
  const p = partesMex(ms);
  const comoUTC = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return comoUTC - Math.floor(ms / 1000) * 1000;
}

// Instante (ms UTC) de una hora local de México en el día de hoy (México)
function msDeHoyMex(h, m, dia) {
  const ahora = Date.now();
  const p = partesMex(ahora);
  const d = dia === undefined ? p.d : dia;
  const guess = Date.UTC(p.y, p.mo - 1, d, h, m, 0, 0);
  return guess - offsetMex(guess);
}

// "9:30" → ISO de hoy en México (null si no parsea)
function horaStrAISO(horaStr) {
  const m = String(horaStr || '').match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return new Date(msDeHoyMex(parseInt(m[1], 10), parseInt(m[2], 10))).toISOString();
}

// Horario laboral: el ayudante escribe horas en 12 h sin am/pm ("1:22", "4:22").
// 7-12 → mañana/mediodía tal cual; 1-6 → tarde (+12); 0 y 13-23 → tal cual.
function horaLaboral24(h) {
  h = parseInt(h, 10);
  return (h >= 1 && h <= 6) ? h + 12 : h;
}

// "1:22" → ISO de hoy en México, interpretando con horario laboral (1:22 = 13:22)
function horaLaboralAISO(horaStr) {
  const m = String(horaStr || '').match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return new Date(msDeHoyMex(horaLaboral24(m[1]), parseInt(m[2], 10))).toISOString();
}

// Milisegundos hasta la próxima medianoche de México
function msHastaMedianoche() {
  const p = partesMex(Date.now());
  const manana = Date.UTC(p.y, p.mo - 1, p.d + 1, 0, 0, 0, 0);
  return (manana - offsetMex(manana)) - Date.now();
}

// ¿Estamos dentro del horario permitido? (hora de inicio inclusive, fin exclusive; opcional solo lunes a viernes)
function dentroDeHorario(horaIni, horaFin, soloLV) {
  const p = partesMex(Date.now());
  if (soloLV) { const d = diaSemanaMex(); if (d === 0 || d === 6) return false; }
  return p.h >= horaIni && p.h < horaFin;
}

// Día de la semana en México: 0=domingo … 6=sábado
function diaSemanaMex() {
  const p = partesMex(Date.now());
  return new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay();
}

// Fecha YYYY-MM-DD en México
function fechaMex(ms) {
  const p = partesMex(ms);
  return p.y + '-' + String(p.mo).padStart(2, '0') + '-' + String(p.d).padStart(2, '0');
}

module.exports = { TZ, ahoraMs, ahoraISO, horaLocal, partesMex, msDeHoyMex, horaStrAISO, horaLaboral24, horaLaboralAISO, dentroDeHorario, msHastaMedianoche, diaSemanaMex, fechaMex };
