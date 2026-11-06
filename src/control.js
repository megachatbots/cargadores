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
  // ¿Se puede escribir ahora en Eléctricos? (horario permitido y sin "silencio"). Si no, los recordatorios se PAUSAN.
  const puedeElectricos = deps.puedeElectricos || function() { return true; };
  // Aviso automático a admins: fuera de horario se junta en un resumen para las 7:00 (lo implementa index.js)
  const avisoDiferible = deps.avisoDiferible || proyectoBot;

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

  // Devuelve true solo si de verdad se mandó (fuera de horario / silencio no cuenta como enviado)
  async function enviarRecordatorio(personas) {
    if (!personas.length) return false;
    if (!puedeElectricos()) return false;
    const menciones = personas.filter(function(p) { return p.numero; }).map(function(p) { return p.numero; });
    await electricos(texto(personas), menciones.length ? menciones : null);
    return true;
  }

  function sigueConectado(p) {
    return ayudante.buscarPorNombre(p.nombre, db.ocupantes()).length > 0;
  }

  async function tick() {
    if (!puedeElectricos()) return;   // pausa: no se envía, no se cuenta y no se alerta; se retoma al volver el horario
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
      await avisoDiferible('🚨 *' + p.nombre + '* (cajón ' + p.cajon + ') sigue sin desconectarse tras ' + p.max + ' recordatorios. ' +
        'Pasen a revisar. Cuando se desconecte: *' + p.cajon + ' libre* en Control.');
    }
    if (!Object.keys(pendientes).length) detenerIntervalo();
  }

  function detenerIntervalo() { if (intervalo) { clearInterval(intervalo); intervalo = null; } }

  async function iniciarRecordatorios(personas) {
    const enviado = await enviarRecordatorio(personas);
    personas.forEach(function(p) { p.enviados = enviado ? 1 : 0; if (!p.sinCajon) pendientes[ayudante.normalizar(p.nombre)] = p; });   // sinCajon: un solo envío
    if (enviado) { for (const p of personas) { if (p.max && p.cajon) await db.marcarRecordatorios(p.cajon, 1); } }
    if (!intervalo) intervalo = setInterval(function() { tick().catch(function(e) { console.log('[control] tick:', e.message); }); }, MS_RECORDATORIO);
    console.log('[recordatorio] ' + (enviado ? 'Iniciado' : 'En pausa (fuera de horario o silencio)') + ' para ' + personas.map(function(p) { return p.nombre; }).join(', '));
    return enviado;
  }

  function cancelarRecordatorio(nombre) {
    const k = ayudante.normalizar(nombre);
    if (pendientes[k]) { delete pendientes[k]; console.log('[recordatorio] Cancelado para ' + nombre); }
    if (!Object.keys(pendientes).length) detenerIntervalo();
  }

  // ── Respuesta de un usuario en Eléctricos a su recordatorio ("ya me desconecté", "sí", "ok").
  // El AYUDANTE es la fuente de verdad: esto NUNCA libera el cajón. Solo (a) detiene los recordatorios si sabemos
  // con certeza quién es (coincide su número) y (b) avisa a Proyecto Bot para que el ayudante confirme.
  // Si no tenemos su número (cargado por reporte), solo se avisa y NO se detienen recordatorios (podría ser otra persona).
  function soloDigitos(x) { return String(x || '').replace(/@.*$/, '').replace(/\D/g, ''); }
  const RE_YA_DESCONECTE = /\bdesconect(?:e|o|ado|ada)\b/;
  const RE_NEGACION = /\b(no|aun|todavia|falta|cuando|despues|luego|en un rato)\b/;
  const RE_ACUSE = /^(si+|ok|okay|vale|listo|lista|enterado|enterada|gracias|de acuerdo|ahorita|ya voy|voy|ya mero|ya)$/;
  const avisadoPorNombre = {};   // cajón → true: un aviso por nombre de WhatsApp es suficiente
  async function respuestaUsuario(numero, nombreWa, textoMsg) {
    const t = ayudante.normalizar(textoMsg);
    if (!t || t.split(' ').length > 8) return false;
    const dice = RE_NEGACION.test(t) ? null : (RE_YA_DESCONECTE.test(t) ? 'desconectado' : (RE_ACUSE.test(t) ? 'acuse' : null));
    if (!dice) return false;
    const lista = Object.keys(pendientes).map(function(k) { return pendientes[k]; }).filter(function(p) { return p.cajon && !p.sinCajon; });
    if (!lista.length) return false;
    const dn = soloDigitos(numero);
    let p = dn ? lista.find(function(x) { return x.numero && soloDigitos(x.numero) === dn; }) : null;
    const citado = String(textoMsg).trim().substring(0, 60);
    if (p) {
      cancelarRecordatorio(p.nombre);
      await db.marcarRecordatorios(p.cajon, (p.max || MAX_RECORDATORIOS) + 1);   // "ya atendido": no se reanudan tras un reinicio
      await avisoDiferible('🔔 *' + p.nombre + '* (cajón ' + p.cajon + ') respondió en Eléctricos «' + citado + '». ' +
        'Detuve sus recordatorios, pero el cajón sigue ocupado en mi registro: el ayudante debe confirmarlo con *Se desconecta ' + p.nombre + '* o *' + p.cajon + ' libre*. ' +
        'Si en realidad no se ha desconectado, el ayudante puede pedirlo otra vez con *Se tiene que desconectar ' + p.nombre + '*.');
      return true;
    }
    // Sin número registrado: solo si dice que YA se desconectó y su nombre de WhatsApp apunta a una única persona sin teléfono
    if (dice !== 'desconectado' || !nombreWa) return false;
    const sinNum = lista.filter(function(x) { return !x.numero; });
    const m = ayudante.buscarPorNombre(nombreWa, sinNum.map(function(x) { return { id: x.cajon, nombre: x.nombre }; }));
    if (m.length !== 1 || avisadoPorNombre[m[0].id]) return false;
    avisadoPorNombre[m[0].id] = true;
    await avisoDiferible('🔔 «' + nombreWa + '» escribió en Eléctricos «' + citado + '». Podría ser *' + m[0].nombre + '* (cajón ' + m[0].id + ', sin teléfono registrado), ' +
      'por eso NO detuve sus recordatorios. El ayudante debe confirmar con *Se desconecta ' + m[0].nombre + '* o *' + m[0].id + ' libre*.');
    return true;
  }

  // ── Eventos
  async function conecta(ev) {
    const est = db.getEstado();
    const cajon = String(ev.cajon);
    const previo = est.cargadores[cajon];
    const previoNombre = previo && previo.ocupado ? previo.usuario_actual : null;

    const cand = ayudante.buscarPorNombre(ev.nombre, est.fila.map(function(u) { return { id: u.numero, nombre: u.nombre, numero: u.numero }; }));
    const numero = cand.length === 1 && !db.esManual(cand[0].numero) ? cand[0].numero : null;

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

  // Libera un cajón y llama a la siguiente persona de la fila (sin repetir personas dentro del mismo mensaje)
  async function liberarYLlamar(cajon, llamados) {
    const c = db.getEstado().cargadores[cajon];
    if (!c || (!c.ocupado && !(c.timer_conexion && c.timer_conexion.activo))) return false;
    if (c.usuario_actual) cancelarRecordatorio(c.usuario_actual);
    timers.cancelarTimerConexion(cajon);
    timers.cancelarTimerSesion(cajon);
    await db.liberarCajon(cajon);
    // Cajones VIP (46/50): no se ofrecen a la fila general mientras un admin no los abra
    if (db.CAJONES_VIP.has(cajon) && !db.vipAbierto()) { console.log('[CONTROL] Cajón VIP ' + cajon + ' liberado; no se llama a la fila'); return true; }
    const sig = siguientesSinTurno().find(function(u) { return !llamados[u.numero]; });
    if (sig && sig.numero) {
      if (db.esManual(sig.numero)) {
        // anotado a mano: no tiene teléfono, no se menciona en Eléctricos
        await proyectoBot('⚡ Cajón ' + cajon + ' libre: le toca a *' + sig.nombre + '* (anotado a mano, sin teléfono). Avísale tú.');
      } else {
        await electricos(sig.nombre + ' @' + sig.numero + ' ya hay un lugar disponible para conectarte 🔌', sig.numero);
      }
      llamados[sig.numero] = true;
      await db.setPendiente({ tipo: 'asignar_turno', cargador_id: cajon, nombre: sig.nombre, numero: sig.numero });
    }
    console.log('[CONTROL] Desconexión cajón ' + cajon);
    return true;
  }

  // Para "59" sugiere el único cajón válido que difiere en un dígito y no venía ya en el mensaje ("50")
  function sugerirCajon(n, yaEnMensaje) {
    const cands = ayudante.CAJONES_VALIDOS.filter(function(v) {
      if (yaEnMensaje.indexOf(v) !== -1) return false;
      return (v[0] !== n[0] ? 1 : 0) + (v[1] !== n[1] ? 1 : 0) === 1;
    });
    return cands.length === 1 ? cands[0] : null;
  }

  // "41 libre", "41 y 42 libres": libera y responde en Proyecto Bot lo que hizo
  async function libre(ev) {
    const llamados = {}, liberados = [], yaLibres = [], avisos = [];
    for (const cajon of ev.cajones) {
      const previo = db.getEstado().cargadores[cajon];
      const quien = previo && previo.usuario_actual ? previo.usuario_actual : null;
      if (await liberarYLlamar(cajon, llamados)) liberados.push(cajon + (quien ? ' (' + quien + ')' : ''));
      else { yaLibres.push(cajon); console.log('[CONTROL] Cajón ' + cajon + ' ya estaba libre'); }
    }
    if (liberados.length) avisos.push('✅ Liberado' + (liberados.length > 1 ? 's' : '') + ' por reporte del ayudante: cajón ' + liberados.join(', ') + '.');
    if (yaLibres.length) avisos.push('ℹ️ Ya estaba' + (yaLibres.length > 1 ? 'n' : '') + ' libre' + (yaLibres.length > 1 ? 's' : '') + ' en mi registro: ' + yaLibres.join(', ') + '.');
    (ev.invalidos || []).forEach(function(n) {
      const s = sugerirCajon(n, ev.cajones);
      avisos.push('⚠️ No reconocí el cajón ' + n + ' (no existe).' + (s ? ' ¿Quisiste decir ' + s + '? Responde *' + s + ' libre* en Control para liberarlo.' : ' Revisa el mensaje del ayudante.'));
    });
    if (avisos.length) await proyectoBot(avisos.join('\n'));
  }

  // "Se desconectan / Nombre1 / Nombre2": el ayudante CONFIRMA que ya se desconectaron → se liberan sus cajones
  async function desconectaron(ev) {
    const ocup = db.ocupantes();
    const llamados = {}, liberados = [], noEncontrados = [], ambiguos = [], vistos = {};
    for (const n of ev.nombres) {
      cancelarRecordatorio(n);                       // si había recordatorios para ese nombre, se acaban
      const m = ayudante.buscarPorNombre(n, ocup);
      if (m.length === 1) {
        if (vistos[m[0].id]) continue;
        vistos[m[0].id] = true;
        if (await liberarYLlamar(m[0].id, llamados)) liberados.push('cajón ' + m[0].id + ' (' + m[0].nombre + ')');
      } else if (m.length === 0) noEncontrados.push(n);
      else ambiguos.push(n + ' → ' + m.map(function(x) { return x.nombre + ' (cajón ' + x.id + ')'; }).join(' / '));
    }
    const avisos = [];
    if (liberados.length) avisos.push('✅ Liberado por reporte del ayudante: ' + liberados.join(', ') + '.');
    if (noEncontrados.length) avisos.push('ℹ️ No encontré en los cajones a: ' + noEncontrados.join(', ') + ' (no hice nada con ellos).');
    if (ambiguos.length) avisos.push('⚠️ Nombre ambiguo, no liberé:\n' + ambiguos.join('\n') + '\nUsa *N libre* en Control.');
    if (avisos.length) await proyectoBot(avisos.join('\n'));
  }

  // "se tiene que desconectar X": el ayudante PIDE recordar. Máximo 3 recordatorios y luego alerta a admins.
  async function recordar(ev) {
    const ocup = db.ocupantes();
    const personas = [], noEncontrados = [], ambiguos = [];
    ev.nombres.forEach(function(n) {
      const m = ayudante.buscarPorNombre(n, ocup);
      if (m.length === 1) personas.push({ nombre: m[0].nombre, numero: m[0].numero, cajon: m[0].id, max: MAX_RECORDATORIOS });
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
    const libres = db.numLibresTotal();   // Control cuenta todos los cajones, VIP incluidos
    if (ev.n === libres) return;
    const ahora = tiempo.ahoraMs();
    if (ahora - ultimoAvisoDisponibles < MS_AVISO_DISPONIBLES) return;
    ultimoAvisoDisponibles = ahora;
    await proyectoBot('ℹ️ Control reporta *' + ev.n + '* lugar(es) disponible(s) y yo tengo *' + libres + '* libre(s).\n' +
      'Si hay diferencia, que el ayudante mande *N libre* o *Se conecta ...*, o pega el reporte de cajones.');
  }

  // El timer de sesión llegó a 3 h (8 h VIP): recordatorio automático, el cajón sigue ocupado
  async function sesionCumplida(info) {
    const enviado = await iniciarRecordatorios([{ nombre: info.nombre, numero: info.numero, cajon: info.cajon, max: MAX_RECORDATORIOS }]);
    const espera = db.getEstado().fila.length;
    await avisoDiferible('⏰ *' + info.nombre + '* cumplió su tiempo en cajón ' + info.cajon + '. Sigue ocupado hasta que el ayudante reporte *' + info.cajon + ' libre*.\n' +
      (enviado ? 'Recordatorios: 1/' + MAX_RECORDATORIOS + ' enviado en Eléctricos' : 'Recordatorios en pausa (fuera de horario o silencio): no se ha enviado nada') + (espera ? ' · En fila: ' + espera : '') + '.');
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
      else if (ev.tipo === 'recordar')       await recordar(ev);
      else if (ev.tipo === 'desconectaron')  await desconectaron(ev);
      else if (ev.tipo === 'disponibles') await disponibles(ev);
    }
    return true;
  }

  return { procesar, respuestaUsuario, ajustarInicio, sesionCumplida, reanudarRecordatorios, cancelarRecordatorio, _pendientes: pendientes, _detener: detenerIntervalo };
}

module.exports = { crear };
