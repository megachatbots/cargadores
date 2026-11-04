// src/lista.js — Apertura/cierre diario de la lista de espera y cajones VIP (sin red; testeable con reloj falso)
const MENSAJE_INICIO =
  '🔌 *Lista de espera abierta*\n\n' +
  'Escribe aquí cuando estés listo para conectar y te apunto en la fila.\n' +
  '• Cuando sea tu turno tienes 15 minutos para conectarte.\n' +
  '• La carga es de 3 horas máximo; te aviso 15 minutos antes de que termine.\n' +
  '• Los cajones 46 y 50 son solo para MD.\n' +
  '• Las solicitudes enviadas antes de las 8:00 a.m. se omiten.\n' +
  '• No se toman en cuenta horarios especiales: la lista es del momento, escribe cuando estés listo para conectar.\n' +
  '• Al terminar, desconecta tu vehículo y avisa en Control para liberar el cajón.';

function crear(deps) {
  const db = deps.db, tiempo = deps.tiempo;
  const HORA_APERTURA = deps.horaApertura === undefined ? 8 : deps.horaApertura;
  const HORA_CIERRE = deps.horaCierre === undefined ? 20 : deps.horaCierre;
  const listo = deps.listo || function() { return true; };

  function habil() { const d = tiempo.diaSemanaMex(); return d >= 1 && d <= 5; }

  async function abrir() {
    await db.setLista(true);
    await deps.enviarElectricos(MENSAJE_INICIO, null);
  }
  async function cerrar() { await db.setLista(false); }

  // Se llama cada minuto
  async function tick() {
    const est = db.getEstado();
    const hoy = tiempo.fechaMex(Date.now());
    if (est.lista_dia !== hoy) await db.nuevoDiaLista(hoy);   // cambio de día: cerrada, VIP cerrado
    const h = tiempo.partesMex(Date.now()).h;
    const e2 = db.getEstado();
    if (e2.lista_abierta && h >= HORA_CIERRE) { await cerrar(); return 'cerrada'; }
    if (!e2.lista_abierta && !e2.lista_auto_hecho && habil() && h >= HORA_APERTURA && h < HORA_CIERRE) {
      if (!listo()) return 'esperando';                       // sin conexión: reintenta en el siguiente minuto
      await abrir();
      return 'abierta';
    }
    return null;
  }

  return { tick, abrir, cerrar, MENSAJE_INICIO };
}

module.exports = { crear, MENSAJE_INICIO };
