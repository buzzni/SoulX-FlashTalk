#!/usr/bin/env bash
# Local mongod helper for dev / test (PR0).
#
# Usage:
#   scripts/dev_mongod.sh start    # fork mongod on 127.0.0.1:27017
#   scripts/dev_mongod.sh stop     # graceful shutdown via PID file
#   scripts/dev_mongod.sh status   # ps + port check
#   scripts/dev_mongod.sh logs     # tail -f the log
#
# Data lives under ~/data/db, log at ~/data/log/mongod.log.
# The mongod binary is the user-local tarball install at
# ~/local/mongodb-community/bin/mongod (PR0 step 1). Override via $MONGOD.

set -euo pipefail

MONGOD="${MONGOD:-$HOME/local/mongodb-community/bin/mongod}"
DBPATH="${MONGO_DBPATH:-$HOME/data/db}"
LOGPATH="${MONGO_LOGPATH:-$HOME/data/log/mongod.log}"
PORT="${MONGO_PORT:-27017}"

case "${1:-}" in
  start)
    mkdir -p "$DBPATH" "$(dirname "$LOGPATH")"
    if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$PORT$"; then
      echo "mongod already listening on port $PORT"
      exit 0
    fi
    "$MONGOD" --dbpath "$DBPATH" --logpath "$LOGPATH" \
              --port "$PORT" --bind_ip 127.0.0.1 --fork
    ;;
  stop)
    PIDFILE="$DBPATH/mongod.lock"
    if [ -s "$PIDFILE" ]; then
      PID=$(cat "$PIDFILE")
      kill "$PID" 2>/dev/null || true
      for _ in $(seq 1 10); do
        kill -0 "$PID" 2>/dev/null || { echo "mongod stopped (pid $PID)"; exit 0; }
        sleep 1
      done
      echo "mongod did not stop within 10s; sending SIGKILL"
      kill -9 "$PID" 2>/dev/null || true
    else
      echo "no PID file at $PIDFILE — was mongod running?"
    fi
    ;;
  status)
    ss -ltn 2>/dev/null | awk -v p=":$PORT" '$4 ~ p { print "listening: " $4 }' || true
    pgrep -af mongod || echo "mongod not running"
    ;;
  logs)
    tail -f "$LOGPATH"
    ;;
  *)
    echo "usage: $0 {start|stop|status|logs}" >&2
    exit 2
    ;;
esac
