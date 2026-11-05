// src/ids.js — Quién es admin. WhatsApp puede mostrar a una persona como LID (15 dígitos) o como teléfono;
// ADMIN_IDS acepta ambos. Si se conoce el teléfono de un LID (metadata del grupo o campos alt del mensaje),
// un admin dado por teléfono también se reconoce cuando escribe con su LID. Puro, sin red.
function digitos(x) { return String(x || '').replace(/@.*$/, '').replace(/:\d+$/, '').replace(/\D/g, ''); }
function ult10(x) { return digitos(x).slice(-10); }
function esTelefono(x) { const d = digitos(x); return d.length >= 10 && d.length <= 13; }

function crear(adminIds) {
  const ids = (adminIds || []).map(digitos).filter(Boolean);
  const mapa = {};   // id (LID o teléfono) → teléfono
  function aprender(id, telefono) {
    const a = digitos(id), t = digitos(telefono);
    if (a && t && esTelefono(t) && a !== t) mapa[a] = t;
  }
  function setParticipantes(lista) {
    (lista || []).forEach(function(p) {
      const tel = p.phoneNumber || p.jid || (/@s\.whatsapp\.net$/.test(String(p.id || '')) ? p.id : null);
      if (!tel) return;
      [p.id, p.lid].forEach(function(x) { if (x) aprender(x, tel); });
    });
  }
  function telefonoDe(id) { const d = digitos(id); return mapa[d] || (esTelefono(d) ? d : null); }
  function esAdmin(id) {
    const d = digitos(id);
    if (!d) return false;
    if (ids.indexOf(d) !== -1) return true;
    const tel = telefonoDe(d);
    if (!tel) return false;
    return ids.some(function(a) { return esTelefono(a) && ult10(a) === ult10(tel); });
  }
  return { esAdmin, aprender, setParticipantes, telefonoDe, _mapa: mapa };
}
module.exports = { crear, digitos };
