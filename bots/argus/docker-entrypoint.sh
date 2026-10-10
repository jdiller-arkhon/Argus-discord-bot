#!/bin/sh
# Starts the bot as the unprivileged `node` user, and makes sure that user owns
# the data directory first. Docker named volumes copy the image's ownership,
# but some hosts (Fly.io volumes, bind mounts) mount the directory owned by
# root, and the bot then couldn't write its SQLite database.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$(dirname "${ARGUS_DB_PATH:-/app/data/argus.sqlite}")"
  chown -R node:node "$(dirname "${ARGUS_DB_PATH:-/app/data/argus.sqlite}")"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
