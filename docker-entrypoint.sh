#!/bin/sh
set -e

mkdir -p /data
chown node:node /data

exec su-exec node "$@"
