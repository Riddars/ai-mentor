#!/bin/sh
# Health watchdog for ai-curator, run by ai-curator-health.timer. Two failed checks in a
# row (no answer, or the review worker stalled) restart the service; a stopped service is
# left alone. Other problems (config, db, disk) are not fixed by a restart.
set -u
URL=http://127.0.0.1:3000/api/health
COUNTER=/run/ai-curator-health.failures

if ! systemctl is-active --quiet ai-curator; then
  rm -f "$COUNTER"
  exit 0
fi

if body=$(curl -s -m 10 "$URL") && ! printf '%s' "$body" | grep -q worker_stalled; then
  rm -f "$COUNTER"
  exit 0
fi

failures=$(( $(cat "$COUNTER" 2>/dev/null || echo 0) + 1 ))
if [ "$failures" -lt 2 ]; then
  echo "$failures" > "$COUNTER"
  echo "health check failed: ${body:-no answer}"
  exit 0
fi
rm -f "$COUNTER"
echo "health check failed twice in a row: ${body:-no answer}; restarting ai-curator"
systemctl --no-block try-restart ai-curator
