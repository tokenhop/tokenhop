#!/usr/bin/env sh
# Rebuild and restart the local container. Like compose.yml, it keeps the existing
# data volume, since a renamed volume would start empty.
docker rm -f 9router tokenhop 2>/dev/null # legacy(9router): pre-v1 container name, remove in v2
docker build -t tokenhop .
docker run -d --name tokenhop -p 20128:20128 --env-file .env -v 9router-data:/app/data tokenhop # legacy(9router): existing volume name
