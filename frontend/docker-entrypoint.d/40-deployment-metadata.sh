#!/bin/sh
set -eu

metadata_path=/usr/share/nginx/html/deployment.json

if [ -f "$metadata_path" ]; then
    exit 0
fi

case "${DEPLOYED_AT:-}" in
    ????-??-??T??:??:??Z)
        if ! date -u -d "$DEPLOYED_AT" >/dev/null 2>&1; then
            exit 0
        fi
        ;;
    *)
        exit 0
        ;;
esac

tmp_path="${metadata_path}.tmp"
printf '{"timestamp":"%s"}\n' "$DEPLOYED_AT" > "$tmp_path"
mv "$tmp_path" "$metadata_path"
