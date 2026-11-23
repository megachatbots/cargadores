// src/control.js — Procesa los mensajes del grupo Control de Cargadores (el ayudante es la fuente de verdad).
// Las dependencias se inyectan para poder probarlo sin Baileys.
const ayudante = require('./ayudante');
const declina = require('./declina');

const MS_AVISO_DISPONIBLES = 10 * 60 * 1000;
const MS_ALERTA_VENCIDO = 15 * 60 * 1000;   // tras el mensaje de "tiempo vencido", si no hay desconexión confirmada se alerta a Alma

function crear(deps) {
  const db = deps.db, timers = deps.timers, tiempo = deps.tiempo;
  const electricos = deps.enviarElectricos;     // (texto, menciones: string | string[] | null)
  const proyectoBot = deps.enviarProyectoBot;   // (texto)
  // ¿Se puede escribir ahora en Eléctricos? (horario permitido y sin "silencio"). Si no, los recordatorios se PAUSAN.
  const puedeElectricos = deps.puedeElectricos || function() { return true; };
  // Aviso automático a admins: fuera de horario se junta en un resumen para las 7:00 (lo implementa index.js)
  const avisoDiferible = deps.avisoDiferible || proyectoBot;

  // ── Tiempo vencido (etapa1c-7): el usuario recibe SOLO 2 mensajes ("faltan 15 minutos" y "tu tiempo ya se venció").
  // No hay más recordatorios. Si 15 min después del vencimiento el ayudante no reportó la desconexión, se ALERTA A ALMA.
  // Alertas: L–V a cualquier hora (directo a Proyecto Bot); sábado/domingo se difieren al resumen del lunes.
  const alertasVencido = {};      // cajón → timeout de la alerta a Alma
  const dijoDesconectado = {};    // cajón → texto del usuario ("ya me desconecté"): se cita en la alerta
  const avisadoRecordar = {};     // cajón → ms del último aviso "el ayudante pidió desconectar"
  const avisadoRespuesta = {};    // cajón|vencimiento → true
  const avisadoPorNombre = {};    // cajón|nombre → true: un aviso por nombre de WhatsApp es suficiente
  let ultimoAvisoDisponibles = 0;

  // Alerta a las supervisoras: L–V siempre; fin de semana → resumen diferido
  async function avisoAlma(texto) {
    const d = tiempo.diaSemanaMex();
    if (d === 0 || d === 6) return avisoDiferible(texto);
    return proyectoBot(texto);
  }

  function textoVencido(p) {
    return (p.numero ? p.nombre + ' @' + p.numero : p.nombre) + ' por favor desconecta tu vehículo, el tiempo de carga ha terminado 🙏';
  }

  function soloDigitos(x) { return String(x || '').replace(/@.*$/, '').replace(/\D/g, ''); }

  function cancelarAlertaCajon(cajon) {
    cajon = String(cajon);
    if (alertasVencido[cajon]) { clearTimeout(alertasVencido[cajon]); delete alertasVencido[cajon]; }
    delete dijoDesconectado[cajon];
    Object.keys(avisadoRecordar).forEach(function(k) { if (k.indexOf(cajon + '|') === 0) delete avisadoRecordar[k]; });
  }
  // Compatibilidad: cancela por nombre de quien ocupa un cajón
  function cancelarRecordatorio(nombre) {
    ayudante.buscarPorNombre(nombre, db.ocupantes()).forEach(function(o) { cancelarAlertaCajon(o.id); });
  }
  function detenerIntervalo() {
    Object.keys(alertasVencido).forEach(function(k) { clearTimeout(alertasVencido[k]); delete alertasVencido[k]; });
    [dijoDesconectado, avisadoRecordar, avisadoRespuesta, avisadoPorNombre].forEach(function(o) { Object.keys(o).forEach(function(k) { delete o[k]; }); });
  }

  function programarAlertaVencido(cajon, cumplidoEnMs) {
    cajon = String(cajon);
    if (alertasVencido[cajon]) clearTimeout(alertasVencido[cajon]);
    const espera = Math.max(0, cumplidoEnMs + MS_ALERTA_VENCIDO - tiempo.ahoraMs());
    alertasVencido[cajon] = setTimeout(function() { dispararAlertaVencido(cajon).catch(function(e) { console.log('[control] alerta vencido:', e.message); }); }, espera);
  }

  async function dispararAlertaVencido(cajon) {
    cajon = String(cajon);
    delete alertasVencido[cajon];
    const c = db.getEstado().cargadores[cajon];
    if (!c || !c.ocupado || !c.timer_sesion || !c.timer_sesion.cumplido || c.alerta_vencido) return;   // ya se desconectó, o ya se alertó
    const espera = db.getEstado().fila.length;
    const dijo = dijoDesconectado[cajon];
    await avisoAlma('🚨 *' + c.usuario_actual + '* (cajón ' + cajon + ') sigue conectado 15 min después de vencer su tiempo' +
      (c.cumplido_en ? ' (terminó a las ' + tiempo.horaLocal(c.cumplido_en) + ')' : '') + '.' +
      (dijo ? ' El usuario escribió «' + dijo + '», pero falta la confirmación del ayudante.' : '') +
      '\n*Alma: llama a la persona.* Cuando se desconecte, el ayudante reporta *' + cajon + ' libre* o *Se desconecta ' + c.usuario_actual + '* en Control.' +
      (espera ? ' · En fila: ' + espera : ''));
    await db.marcarAlertaVencido(cajon);
    delete dijoDesconectado[cajon];
  }

  // ── Respuesta de un usuario en Eléctricos a su aviso de "tiempo vencido" ("ya me desconecté", "sí", "ok").
  // El AYUDANTE es la fuente de verdad: esto NUNCA libera el cajón. Solo avisa a Alma (una vez por vencimiento) y queda
  // citado en la alerta de los 15 min. Si no tenemos su número (cargado por reporte) solo avisa cuando dice que YA se desconectó.
  const RE_YA_DESCONECTE = /\bdesconect(?:e|o|ado|ada)\b/;
  const RE_NEGACION = /\b(no|aun|todavia|falta|cuando|despues|luego|en un rato)\b/;
  const RE_ACUSE = /^(si+|ok|okay|vale|listo|lista|enterado|enterada|gracias|de acuerdo|ahorita|ya voy|voy|ya mero|ya)$/;
  function vencidos() {
    return db.ocupantes().filter(function(o) { const c = db.getEstado().cargadores[o.id]; return c && c.timer_sesion && (c.timer_sesion.cumplido || c.timer_sesion.vencido); });
  }
  async function respuestaUsuario(numero, nombreWa, textoMsg) {
    const t = ayudante.normalizar(textoMsg);
    if (!t || t.split(' ').length > 8) return false;
    const dice = RE_NEGACION.test(t) ? null : (RE_YA_DESCONECTE.test(t) ? 'desconectado' : (RE_ACUSE.test(t) ? 'acuse' : null));
    if (!dice) return false;
    const lista = vencidos();
    if (!lista.length) return false;
    const dn = soloDigitos(numero);
    const p = dn ? lista.find(function(x) { return x.numero && soloDigitos(x.numero) === dn; }) : null;
    const citado = String(textoMsg).trim().substring(0, 60);
    if (p) {
      if (dice === 'desconectado') dijoDesconectado[p.id] = citado;
      const c = db.getEstado().cargadores[p.id];
      const k = p.id + '|' + (c.cumplido_en || c.hora_inicio || '');
      if (avisadoRespuesta[k]) return true;
      avisadoRespuesta[k] = true;
      await avisoAlma('🔔 *' + p.nombre + '* (cajón ' + p.id + ') respondió en Eléctricos «' + citado + '». ' +
        'El cajón sigue ocupado en mi registro: el ayudante debe confirmarlo con *Se desconecta ' + p.nombre + '* o *' + p.id + ' libre*.');
      return true;
    }
    // Sin número registrado: solo si dice que YA se desconectó y su nombre de WhatsApp apunta a una única persona sin teléfono
    if (dice !== 'desconectado' || !nombreWa) return false;
    const sinNum = lista.filter(function(x) { return !x.numero; });
    const m = ayudante.buscarPorNombre(nombreWa, sinNum.map(function(x) { return { id: x.id, nombre: x.nombre }; }));
    if (m.length !== 1 || avisadoPorNombre[m[0].id + '|' + m[0].nombre]) return false;
    avisadoPorNombre[m[0].id + '|' + m[0].nombre] = true;
    await avisoAlma('🔔 «' + nombreWa + '» escribió en Eléctricos «' + citado + '». Podría ser *' + m[0].nombre + '* (cajón ' + m[0].id + ', sin teléfono registrado). ' +
      'El ayudante debe confirmar con *Se desconecta ' + m[0].nombre + '* o *' + m[0].id + ' libre*.');
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
    cancelarAlertaCajon(cajon);
    timers.cancelarTimerConexion(cajon);
    timers.cancelarTimerSesion(cajon);
    await db.liberarCajon(cajon);
    // Cajones VIP (46/50): no se ofrecen a la fila general mientras un admin no los abra
    if (db.CAJONES_VIP.has(cajon) && !db.vipAbierto()) { console.log('[CONTROL] Cajón VIP ' + cajon + ' liberado; no se llama a la fila'); return true; }
    await llamarAlSiguiente(cajon, llamados, { saltarLlamados: true });   // quien ya fue llamado a OTRO cajón no se llama dos veces
    console.log('[CONTROL] Desconexión cajón ' + cajon);
    return true;
  }

  // "N libre" del ayudante sobre un cajón que mi registro ya tenía libre: llama a la fila si nadie tiene ya ese cajón.
  async function llamarSiLibreReportado(cajon, llamados) {
    const c = db.getEstado().cargadores[cajon];
    if (!c || c.ocupado) return null;
    if (db.CAJONES_VIP.has(cajon) && !db.vipAbierto()) return null;
    if (db.hayLlamadoParaCajon(cajon)) return null;
    return await llamarAlSiguiente(cajon, llamados, { saltarLlamados: true });
  }

  // Llama a la siguiente persona de la fila para un cajón libre. `llamados` = personas que no deben repetirse.
  // opts.saltarLlamados: omite a quien ya tiene un llamado vigente para otro cajón. Devuelve la persona llamada o null.
  async function llamarAlSiguiente(cajon, llamados, opts) {
    const saltar = !!(opts && opts.saltarLlamados);
    const sig = siguientesSinTurno().find(function(u) { return !llamados[u.numero] && !(saltar && db.getLlamadoActivo(u.numero)); });
    if (!sig || !sig.numero) return null;
    if (db.esManual(sig.numero)) {
      // anotado a mano: no tiene teléfono, no se menciona en Eléctricos
      await proyectoBot('⚡ Cajón ' + cajon + ' libre: le toca a *' + sig.nombre + '* (anotado a mano, sin teléfono). Avísale tú.');
    } else {
      await electricos(sig.nombre + ' @' + sig.numero + ' ya hay un lugar disponible para conectarte 🔌', sig.numero);
    }
    llamados[sig.numero] = true;
    await db.marcarLlamado(sig.numero, cajon, sig.nombre);
    await db.setPendiente({ tipo: 'asignar_turno', cargador_id: cajon, nombre: sig.nombre, numero: sig.numero });
    return sig;
  }

  // ── "No puedo bajar": alguien a quien ya se llamó (o con turno de 15 min) dice que no puede ahora.
  //  · promete ≤ 15 min  → solo se avisa a Proyecto Bot (no se mueve a nadie)
  //  · abierto o > 15 min → se vuelve a formar al FINAL, se llama a la siguiente persona y se avisa a Proyecto Bot
  // Nunca toca un cajón ocupado: solo libera la ventana de espera (cajón sin coche) de quien cede su turno.
  const avisadoCorto = {};
  async function noPuedeBajar(numero, nombreWa, textoMsg) {
    const r = declina.clasificar(textoMsg);
    if (!r) return false;
    const ll = db.getLlamadoActivo(numero);
    if (!ll) return false;
    const citado = String(textoMsg).trim().substring(0, 80);
    if (r.tipo === 'aviso_corto') {
      const k = ll.numero + '|' + ll.cajon + '|' + ll.fase + '|' + ll.desde;   // un llamado nuevo vuelve a avisar
      if (avisadoCorto[k]) return true;
      avisadoCorto[k] = true;
      await avisoDiferible('⏳ *' + ll.nombre + '* respondió «' + citado + '»: se conecta en ~' + r.minutos + ' min (cajón ' + ll.cajon + '). ' +
        'No lo moví de la fila ni llamé a nadie más. Si no llega: *' + ll.nombre + ' no llegó*.');
      return true;
    }
    return cederTurno(ll, citado);
  }

  async function cederTurno(ll, citado) {
    const cajon = ll.cajon;
    if (ll.fase === 'turno') {
      timers.cancelarTimerConexion(cajon);
      await db.liberarCajon(cajon);            // era solo una ventana de espera: no hay coche
    }
    const pend = db.getPendiente();
    if (pend && pend.tipo === 'asignar_turno' && soloDigitos(pend.numero) === soloDigitos(ll.numero)) await db.setPendiente(null);
    const res = await db.moverAlFinal(ll.numero);
    if (!res) { await db.limpiarLlamado(ll.numero); return false; }
    const c = db.getEstado().cargadores[cajon];
    const libre = c && !c.ocupado && !(c.timer_conexion && c.timer_conexion.activo);
    let sig = null;
    if (libre && !(db.CAJONES_VIP.has(cajon) && !db.vipAbierto())) sig = await llamarAlSiguiente(cajon, (function() { const o = {}; o[ll.numero] = true; return o; })(), { saltarLlamados: true });
    if (!db.esManual(ll.numero)) {
      await electricos(ll.nombre + ' @' + ll.numero + ' listo, te volví a formar al final de la lista (posición ' + res.posicion + ') 👍', ll.numero);
    }
    await avisoDiferible('🔁 *' + ll.nombre + '* dijo «' + citado + '». Lo volví a formar al final (posición ' + res.posicion + ')' +
      (ll.fase === 'turno' ? ' y cancelé su ventana de 15 min' : '') + '. ' +
      (sig ? 'Llamé a *' + sig.nombre + '* para el cajón ' + cajon + ': responde *sí* para darle el turno.' : 'No hay a quién llamar para el cajón ' + cajon + ' (sigue libre).'));
    console.log('[CONTROL] ' + ll.nombre + ' cede su turno (cajón ' + cajon + ') → posición ' + res.posicion + (sig ? ', llamado ' + sig.nombre : ''));
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
    const llamados = {}, liberados = [], yaLibres = [], llamadosExtra = [], avisos = [];
    for (const cajon of ev.cajones) {
      const previo = db.getEstado().cargadores[cajon];
      const quien = previo && previo.usuario_actual ? previo.usuario_actual : null;
      if (await liberarYLlamar(cajon, llamados)) liberados.push(cajon + (quien ? ' (' + quien + ')' : ''));
      else {
        // El ayudante es la verdad: si dice "libre" y mi registro ya lo tenía libre (no me enteré de la conexión),
        // igual se llama a la fila, salvo que ya haya un llamado vigente para ese cajón.
        const sig = await llamarSiLibreReportado(cajon, llamados);
        if (sig) { llamadosExtra.push(cajon + ' → ' + sig.nombre); console.log('[CONTROL] Cajón ' + cajon + ' libre por reporte (no estaba ocupado en mi registro); llamado ' + sig.nombre); }
        else { yaLibres.push(cajon); console.log('[CONTROL] Cajón ' + cajon + ' ya estaba libre'); }
      }
    }
    if (liberados.length) avisos.push('✅ Liberado' + (liberados.length > 1 ? 's' : '') + ' por reporte del ayudante: cajón ' + liberados.join(', ') + '.');
    if (llamadosExtra.length) avisos.push('ℹ️ El ayudante reporta libre un cajón que yo tenía libre (no me llegó su conexión). Llamé a la fila: ' + llamadosExtra.join(', ') + '.');
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

  // "se tiene que desconectar X": el ayudante pide que se le recuerde a alguien. Ya NO se le escribe al usuario:
  // se avisa a Alma (escalación). Un aviso por persona cada 15 min.
  async function recordar(ev) {
    const ocup = db.ocupantes();
    const avisadas = [], noEncontrados = [], ambiguos = [];
    const ahora = tiempo.ahoraMs();
    ev.nombres.forEach(function(n) {
      const m = ayudante.buscarPorNombre(n, ocup);
      if (m.length === 1) {
        const clave = m[0].id + '|' + m[0].nombre;   // por persona: si el cajón cambia de ocupante, no hereda el aviso anterior
        const ult = avisadoRecordar[clave];
        if (ult && ahora - ult < MS_ALERTA_VENCIDO) return;
        avisadoRecordar[clave] = ahora;
        avisadas.push(m[0]);
      }
      else if (m.length === 0) noEncontrados.push(n);
      else ambiguos.push(n + ' → ' + m.map(function(x) { return x.nombre + ' (cajón ' + x.id + ')'; }).join(' / '));
    });
    if (avisadas.length) {
      await avisoAlma('🔔 El ayudante pidió que se desconecte: ' + avisadas.map(function(o) { return '*' + o.nombre + '* (cajón ' + o.id + ')'; }).join(', ') +
        '.\n*Alma: avisa tú a la persona.* (Ya no le escribo yo al usuario.) Cuando se desconecte: *N libre* o *Se desconecta Nombre* en Control.');
    }
    const avisos = [];
    if (noEncontrados.length) avisos.push('⚠️ No encontré en los cajones: ' + noEncontrados.join(', ') + '. No avisé a Alma.');
    if (ambiguos.length) avisos.push('⚠️ Nombre ambiguo, no avisé a Alma:\n' + ambiguos.join('\n'));
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

  // El timer de sesión llegó a 3 h (8 h VIP): UN mensaje al usuario (si se puede escribir) y alerta a Alma a los 15 min.
  // El cajón sigue ocupado. Fuera de horario / silencio el mensaje NO se manda ni se reintenta al día siguiente.
  async function sesionCumplida(info) {
    const cajon = String(info.cajon);
    let enviado = false;
    if (puedeElectricos()) {
      await electricos(textoVencido(info), info.numero ? [info.numero] : null);
      enviado = true;
    }
    const espera = db.getEstado().fila.length;
    await avisoDiferible('⏰ *' + info.nombre + '* cumplió su tiempo en cajón ' + cajon + '. Sigue ocupado hasta que el ayudante reporte *' + cajon + ' libre*.\n' +
      (enviado ? 'Le avisé en Eléctricos (único aviso).' : 'No le escribí en Eléctricos (fuera de horario o silencio).') +
      ' Si en 15 min no hay desconexión, te alerto.' + (espera ? ' · En fila: ' + espera : ''));
    const c = db.getEstado().cargadores[cajon];
    programarAlertaVencido(cajon, c && c.cumplido_en ? new Date(c.cumplido_en).getTime() : tiempo.ahoraMs());
  }

  // Tras un reinicio del bot: retoma las alertas a Alma que estaban pendientes (si ya pasaron los 15 min, sale ya, una sola vez)
  function reanudarRecordatorios() {
    let n = 0;
    db.ocupantes().forEach(function(o) {
      const c = db.getEstado().cargadores[o.id];
      if (!c.timer_sesion || !c.timer_sesion.cumplido || c.alerta_vencido) return;
      if ((c.recordatorios || 0) > 3) return;   // estado anterior a etapa1c-7: ya se había alertado a los admins
      programarAlertaVencido(o.id, c.cumplido_en ? new Date(c.cumplido_en).getTime() : tiempo.ahoraMs() - MS_ALERTA_VENCIDO);
      n++;
    });
    console.log('[control] Alertas de vencimiento reanudadas: ' + n);
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

  return { procesar, respuestaUsuario, noPuedeBajar, ajustarInicio, sesionCumplida, reanudarRecordatorios, cancelarRecordatorio, _pendientes: alertasVencido, _avisadoCorto: avisadoCorto, _detener: detenerIntervalo };
}

module.exports = { crear };
