// src/control.js — Procesa los mensajes del grupo Control de Cargadores (el ayudante es la fuente de verdad).
// Las dependencias se inyectan para poder probarlo sin Baileys.
const ayudante = require('./ayudante');

const MS_RECORDATORIO = 15 * 60 * 1000;
const MS_AVISO_DISPONIBLES = 10 * 60 * 1000;
const MAX_RECORDATORIOS = 3;   // automáticos al cumplir el tiempo; después se alerta a admins

function crear(deps) {
  const db = deps.db, timers = deps.timers, tiempo = deps.tiempo;
  const electricos = deps.enviarElectricos;     // (texto, menciones: string | string[] | null)
  const proyectoBot = deps.enviarProyectoBot;   // (texto)

  // ── Recordatorio de desconexión (un solo mensaje para todos los pendientes, cada 15 min)
  const pendientes = {};          // clave normalizada → { nombre, numero, cajon }
  let intervalo = null;
  let ultimoAvisoDisponibles = 0;

  function texto(personas) {
    if (personas.length === 1) {
      const p = personas[0];
      return (p.numero ? p.nombre + ' @' + p.numero : p.nombre) + ' por favor desconecta tu vehículo, el tiempo de carga ha terminado 🙏';
    }
    return personas.map(function(p) { return p.numero ? p.nombre + ' @' + p.numero : p.nombre; }).join(', ') +
      ' por favor desconecten su vehículo, el tiempo de carga ha terminado 🙏';
  }

  async function enviarRecordatorio(personas) {
    if (!personas.length) return;
    const menciones = personas.filter(function(p) { return p.numero; }).map(function(p) { return p.numero; });
    await electricos(texto(personas), menciones.length ? menciones : null);
  }

  function sigueConectado(p) {
    return ayudante.buscarPorNombre(p.nombre, db.ocupantes()).length > 0;
  }

  async function tick() {
    const vigentes = [], alertas = [];
    for (const k of Object.keys(pendientes)) {
      const p = pendientes[k];
      if (!sigueConectado(p)) { delete pendientes[k]; continue; }
      if (p.max && p.enviados >= p.max) {
        alertas.push(p);
        delete pendientes[k];
        if (p.cajon) await db.marcarRecordatorios(p.cajon, p.max + 1);   // marca "ya alertado"
        continue;
      }
      vigentes.push(p);
    }
    if (vigentes.length) {
      await enviarRecordatorio(vigentes);
      for (const p of vigentes) {
        p.enviados = (p.enviados || 0) + 1;
        if (p.max && p.cajon) await db.marcarRecordatorios(p.cajon, p.enviados);
      }
    }
    for (const p of alertas) {
      await proyectoBot('🚨 *' + p.nombre + '* (cajón ' + p.cajon + ') sigue sin desconectarse tras ' + p.max + ' recordatorios. ' +
        'Pasen a revisar. Cuando se desconecte: *' + p.cajon + ' libre* en Control.');
    }
    if (!Object.keys(pendientes).length) detenerIntervalo();
  }

  function detenerIntervalo() { if (intervalo) { clearInterval(intervalo); intervalo = null; } }

  async function iniciarRecordatorios(personas) {
    personas.forEach(function(p) { p.enviados = 1; pendientes[ayudante.normalizar(p.nombre)] = p; });
    await enviarRecordatorio(personas);
    for (const p of personas) { if (p.max && p.cajon) await db.marcarRecordatorios(p.cajon, 1); }
    if (!intervalo) intervalo = setInterval(function() { tick().catch(function(e) { console.log('[control] tick:', e.message); }); }, MS_RECORDATORIO);
    console.log('[recordatorio] Iniciado para ' + personas.map(function(p) { return p.nombre; }).join(', '));
  }

  function cancelarRecordatorio(nombre) {
    const k = ayudante.normalizar(nombre);
    if (pendientes[k]) { delete pendientes[k]; console.log('[recordatorio] Cancelado para ' + nombre); }
    if (!Object.keys(pendientes).length) detenerIntervalo();
  }

  // ── Eventos
  async function conecta(ev) {
    const est = db.getEstado();
    const cajon = String(ev.cajon);
    const previo = est.cargadores[cajon];
    const previoNombre = previo && previo.ocupado ? previo.usuario_actual : null;

    const cand = ayudante.buscarPorNombre(ev.nombre, est.fila.map(function(u) { return { id: u.numero, nombre: u.nombre, numero: u.numero }; }));
    const numero = cand.length === 1 ? cand[0].numero : null;

    const horaInicio = ev.horaInicio ? tiempo.horaLaboralAISO(ev.horaInicio) : null;
    await db.conectarUsuario(cajon, ev.nombre, numero, horaInicio, { marca: ev.marca, placas: ev.placas });
    timers.cancelarTimerConexion(cajon);
    await timers.reactivarTimerSesionCajon(cajon);

    const c = db.getEstado().cargadores[cajon];
    const ms = c.vip ? db.MS_SESION_VIP : db.MS_SESION;
    const fin = tiempo.horaLocal(new Date(c.hora_inicio).getTime() + ms);

    if (numero) {
      await electricos(ev.nombre + ' @' + numero + ' ✅ quedaste conectado hasta las ' + fin, numero);
    }
    console.log('[CONTROL] Conexión: ' + ev.nombre + ' cajón ' + cajon);

    const avisos = [];
    if (previoNombre && ayudante.buscarPorNombre(ev.nombre, [{ id: cajon, nombre: previoNombre }]).length === 0) {
      avisos.push('ℹ️ Cajón ' + cajon + ' estaba registrado a *' + previoNombre + '*; el ayudante reporta a *' + ev.nombre + '*. Actualicé.');
    }
    if (cand.length > 1) {
      avisos.push('⚠️ *' + ev.nombre + '* coincide con varios en la fila (' + cand.map(function(x) { return x.nombre; }).join(', ') + '). No les saqué de la fila: usa *quitar N* si corresponde.');
    }
    if (ev.nombreDudoso) {
      avisos.push('❓ Cajón ' + cajon + ' lo ocupa «' + ev.nombre + '»' + (ev.placas ? ' (' + ev.placas + ')' : '') + '. ¿Quién es? Responde: *' + cajon + ' es Nombre Apellido*');
    }
    if (!ev.horaInicio) {
      avisos.push('⏱ Sin hora de conexión para cajón ' + cajon + ': conté desde ahora.');
    }
    if (avisos.length) await proyectoBot(avisos.join('\n'));
  }

  // Personas de la fila que aún no tienen turno ni cajón
  function siguientesSinTurno() {
    const est = db.getEstado();
    const conTurno = {};
    Object.keys(est.cargadores).forEach(function(k) {
      const c = est.cargadores[k];
      if (c.numero_actual && (c.ocupado || (c.timer_conexion && c.timer_conexion.activo))) conTurno[c.numero_actual] = true;
    });
    return est.fila.filter(function(u) { return !conTurno[u.numero]; });
  }

  async function libre(ev) {
    const yaLibres = [], liberados = [];
    let ultimoPendiente = null;
    const llamados = {};   // personas ya avisadas en este mismo mensaje
    for (const cajon of ev.cajones) {
      const est = db.getEstado();
      const c = est.cargadores[cajon];
      if (!c || (!c.ocupado && !(c.timer_conexion && c.timer_conexion.activo))) { yaLibres.push(cajon); continue; }
      if (c.usuario_actual) cancelarRecordatorio(c.usuario_actual);
      timers.cancelarTimerConexion(cajon);
      timers.cancelarTimerSesion(cajon);
      await db.liberarCajon(cajon);
      liberados.push(cajon);

      const sig = siguientesSinTurno().find(function(u) { return !llamados[u.numero]; });
      if (sig && sig.numero) {
        await electricos(sig.nombre + ' @' + sig.numero + ' ya hay un lugar disponible para conectarte 🔌', sig.numero);
        llamados[sig.numero] = true;
        ultimoPendiente = { tipo: 'asignar_turno', cargador_id: cajon, nombre: sig.nombre, numero: sig.numero };
        await db.setPendiente(ultimoPendiente);
      }
      console.log('[CONTROL] Desconexión cajón ' + cajon);
    }
    if (yaLibres.length && !liberados.length) {
      console.log('[CONTROL] Cajón(es) ' + yaLibres.join(', ') + ' ya estaban libres');
    }
  }

  async function desconectan(ev) {
    const ocup = db.ocupantes();
    const personas = [], noEncontrados = [], ambiguos = [];
    ev.nombres.forEach(function(n) {
      const m = ayudante.buscarPorNombre(n, ocup);
      if (m.length === 1) personas.push({ nombre: m[0].nombre, numero: m[0].numero, cajon: m[0].id });
      else if (m.length === 0) noEncontrados.push(n);
      else ambiguos.push(n + ' → ' + m.map(function(x) { return x.nombre + ' (cajón ' + x.id + ')'; }).join(' / '));
    });
    if (personas.length) await iniciarRecordatorios(personas);
    const avisos = [];
    if (noEncontrados.length) avisos.push('⚠️ No encontré en los cajones: ' + noEncontrados.join(', ') + '. No envié recordatorio.');
    if (ambiguos.length) avisos.push('⚠️ Nombre ambiguo, no envié recordatorio:\n' + ambiguos.join('\n'));
    if (avisos.length) await proyectoBot(avisos.join('\n'));
  }

  async function disponibles(ev) {
    const libres = db.numLibres();
    if (ev.n === libres) return;
    const ahora = tiempo.ahoraMs();
    if (ahora - ultimoAvisoDisponibles < MS_AVISO_DISPONIBLES) return;
    ultimoAvisoDisponibles = ahora;
    await proyectoBot('ℹ️ Control reporta *' + ev.n + '* lugar(es) disponible(s) y yo tengo *' + libres + '* libre(s).\n' +
      'Si hay diferencia, que el ayudante mande *N libre* o *Se conecta ...*, o pega el reporte de cajones.');
  }

  // El timer de sesión llegó a 3 h (8 h VIP): recordatorio automático, el cajón sigue ocupado
  async function sesionCumplida(info) {
    await iniciarRecordatorios([{ nombre: info.nombre, numero: info.numero, cajon: info.cajon, max: MAX_RECORDATORIOS }]);
    const espera = db.getEstado().fila.length;
    await proyectoBot('⏰ *' + info.nombre + '* cumplió su tiempo en cajón ' + info.cajon + '. Sigue ocupado hasta que el ayudante reporte *' + info.cajon + ' libre*.\n' +
      'Recordatorios: 1/' + MAX_RECORDATORIOS + ' enviado en Eléctricos' + (espera ? ' · En fila: ' + espera : '') + '.');
  }

  // Tras un reinicio del bot: retoma los recordatorios automáticos que quedaron a medias
  function reanudarRecordatorios() {
    let n = 0;
    db.ocupantes().forEach(function(o) {
      const c = db.getEstado().cargadores[o.id];
      if (!c.timer_sesion || !c.timer_sesion.cumplido) return;
      const enviados = c.recordatorios || 0;
      if (enviados > MAX_RECORDATORIOS) return;   // ya se alertó a los admins
      pendientes[ayudante.normalizar(o.nombre)] = { nombre: o.nombre, numero: o.numero, cajon: o.id, max: MAX_RECORDATORIOS, enviados: enviados };
      n++;
    });
    if (n && !intervalo) intervalo = setInterval(function() { tick().catch(function(e) { console.log('[control] tick:', e.message); }); }, MS_RECORDATORIO);
    console.log('[control] Recordatorios reanudados: ' + n);
    return n;
  }

  // Comando admin "N desde H:MM" — devuelve el texto de respuesta
  async function ajustarInicio(cajon, horaStr) {
    cajon = String(cajon);
    const c = db.getEstado().cargadores[cajon];
    if (!c || !c.ocupado) return '⚠️ El cajón ' + cajon + ' no está ocupado.';
    const r = await db.ajustarInicio(cajon, String(horaStr).replace('.', ':'));
    if (!r) return '❌ No entendí la hora. Ejemplo: *' + cajon + ' desde 1:30*';
    if (r.futura) return '⚠️ Esa hora (' + tiempo.horaLocal(r.iso) + ') es futura. Revisa y vuelve a intentar.';
    timers.cancelarTimerSesion(cajon);
    if (!r.vencido) await timers.reactivarTimerSesionCajon(cajon);
    const desde = tiempo.horaLocal(r.iso), fin = tiempo.horaLocal(r.fin);
    if (r.vencido) {
      const hace = Math.round((tiempo.ahoraMs() - r.fin) / 60000);
      return '✅ Cajón ' + cajon + ': *' + r.nombre + '* desde ' + desde + '. Su tiempo terminó a las ' + fin + ' (hace ' + hace + ' min).\n' +
        'El cajón sigue ocupado hasta que el ayudante reporte *' + cajon + ' libre* o escribas *' + r.nombre + ' se desconectó*.';
    }
    return '✅ Cajón ' + cajon + ': *' + r.nombre + '* desde ' + desde + ', termina a las ' + fin + '.';
  }

  async function procesar(textoMsg) {
    const eventos = ayudante.parsearMensajeAyudante(textoMsg);
    if (!eventos.length) return false;
    for (const ev of eventos) {
      if (ev.tipo === 'reporte')          await deps.procesarReporte(textoMsg);
      else if (ev.tipo === 'conecta')     await conecta(ev);
      else if (ev.tipo === 'libre')       await libre(ev);
      else if (ev.tipo === 'desconectan') await desconectan(ev);
      else if (ev.tipo === 'disponibles') await disponibles(ev);
    }
    return true;
  }

  return { procesar, ajustarInicio, sesionCumplida, reanudarRecordatorios, cancelarRecordatorio, _pendientes: pendientes, _detener: detenerIntervalo };
}

module.exports = { crear };
