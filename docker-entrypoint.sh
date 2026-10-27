#!/bin/sh
# Make the persistent data folder writable for the unprivileged "node" user,
# then run the app as that user. Works with bind mounts (./data) and named volumes.
set -e
DATA_DIR="${DATA_DIR:-/app/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR"
  exec su-exec node "$@"
fi
exec "$@"
