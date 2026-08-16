#!/usr/bin/env bash
# School-Street starten (überlebt das Schließen des Terminals nicht — dafür Strg+C zum Stoppen).
# Für Dauertest im WLAN. Optional: PORT=8080 ./start.sh
cd "$(dirname "$0")"
if ! curl -s -o /dev/null -m 1 "http://127.0.0.1:${PORT:-3000}/api/securities"; then
  setsid nohup node server/index.js >> server/data/schoolstreet.log 2>&1 < /dev/null &
  sleep 1.5
fi
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo "Spieler : http://${IP:-localhost}:${PORT:-3000}/"
echo "AG/Admin: http://${IP:-localhost}:${PORT:-3000}/admin"
echo "Board/TV: http://${IP:-localhost}:${PORT:-3000}/board"
echo "Log     : tail -f server/data/schoolstreet.log   |  Stop: pkill -f 'node server/index.js'"
