#!/bin/sh
# Cursor hook -> display bridge. Never blocks or changes what the agent does:
# prints nothing, always exits 0, gives up after 1 second.
curl -s -m 1 -X POST -H 'Content-Type: application/json' --data-binary @- \
  http://127.0.0.1:47321/event >/dev/null 2>&1
exit 0
