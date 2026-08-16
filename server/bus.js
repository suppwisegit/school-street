// Winziger Event-Bus: Engine/Jobs senden Broadcasts, index.js hängt die WebSocket-Anbindung dran.
const listeners = [];
function emit(msg) { for (const l of listeners) l(msg); }
function on(l) { listeners.push(l); }
module.exports = { emit, on };
