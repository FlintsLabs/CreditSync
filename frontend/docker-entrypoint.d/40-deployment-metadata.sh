#!/bin/sh
set -eu

metadata_path=/usr/share/nginx/html/deployment.json

if [ -f "$metadata_path" ]; then
    exit 0
fi

deployment_timestamp=${DEPLOYED_AT:-}

# Accept only the canonical UTC form emitted by the deployment command. Do not
# use `date -d`: nginx:alpine provides BusyBox date, whose ISO parsing differs
# between versions. The allowlist also makes the JSON write safe without an
# escaping implementation.
case "$deployment_timestamp" in
    ????-??-??T??:??:??Z) ;;
    *) exit 0 ;;
esac
case "$deployment_timestamp" in
    *[!0-9TZ:.-]*) exit 0 ;;
esac

year=${deployment_timestamp%T*}
year=${year%%-*}
month=${deployment_timestamp#????-}
month=${month%%-*}
day=${deployment_timestamp#????-??-}
day=${day%%T*}
hour=${deployment_timestamp#*T}
hour=${hour%%:*}
minute=${deployment_timestamp#*T??:}
minute=${minute%%:*}
second=${deployment_timestamp#*T??:??:}
second=${second%Z}

case "$month" in 0[1-9]|1[0-2]) ;; *) exit 0 ;; esac
case "$day" in 0[1-9]|[12][0-9]|3[01]) ;; *) exit 0 ;; esac
case "$hour" in [01][0-9]|2[0-3]) ;; *) exit 0 ;; esac
case "$minute" in [0-5][0-9]) ;; *) exit 0 ;; esac
case "$second" in [0-5][0-9]) ;; *) exit 0 ;; esac

# Check month length and leap years using POSIX awk, available in BusyBox.
if ! awk -v y="$year" -v m="$month" -v d="$day" '
    BEGIN {
        leap = (y % 400 == 0) || (y % 4 == 0 && y % 100 != 0)
        days = (m == 2 ? (leap ? 29 : 28) : ((m == 4 || m == 6 || m == 9 || m == 11) ? 30 : 31))
        exit !(d <= days)
    }
' </dev/null; then
    exit 0
fi

tmp_path="${metadata_path}.tmp"
printf '{"timestamp":"%s"}\n' "$deployment_timestamp" > "$tmp_path"
mv "$tmp_path" "$metadata_path"
