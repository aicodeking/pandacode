#!/bin/sh
# pandacode-bridge — talk to a PandaCode bot from any chat platform.
#
# This is the whole contract between an external adapter (signal-cli, a Mattermost bot, an
# ntfy subscriber, a cron job) and PandaCode. It is a plain HTTP client on purpose: no SDK,
# no dependency, nothing to install. Point it at a bridge channel and it carries normalized
# messages in and replies out.
#
#   send      one inbound message  (POST .../messages)
#   receive   one long poll        (GET  .../events?after=)
#   listen    keep polling, print each reply as one JSON line
#
# Setup: copy the exports from the bridge channel's setup panel in PandaCode, or set them:
#
#   export PANDACODE_BRIDGE_URL='http://127.0.0.1:47321'
#   export PANDACODE_BRIDGE_CHANNEL='<channel id>'
#   export PANDACODE_BRIDGE_TOKEN='<token>'
#   export PANDACODE_BRIDGE_CURSOR_FILE="${PANDACODE_BRIDGE_CURSOR_FILE:-$HOME/.pandacode-bridge.cursor}"
#
# Needs curl and (for send's JSON escaping) nothing else: it is POSIX sh.
set -eu

url=${PANDACODE_BRIDGE_URL:?set PANDACODE_BRIDGE_URL}
channel=${PANDACODE_BRIDGE_CHANNEL:?set PANDACODE_BRIDGE_CHANNEL}
token=${PANDACODE_BRIDGE_TOKEN:?set PANDACODE_BRIDGE_TOKEN}
cursor_file=${PANDACODE_BRIDGE_CURSOR_FILE:-"$HOME/.pandacode-bridge.cursor"}
base="$url/api/bridge/$channel"

die() { printf '%s\n' "$*" >&2; exit 1; }

# JSON-escape a value on stdin (backslash, quote, tab, newline). Enough for message text and
# ids; deliberately not a general-purpose encoder.
escape() {
    awk 'BEGIN{ORS=""} {
        gsub(/\\/,"\\\\"); gsub(/"/,"\\\""); gsub(/\t/,"\\t")
        printf "%s", $0
        if (NR > 0) printf "\\n"
    }' | sed 's/\\n$//'
}

usage() {
    cat <<'USAGE'
usage: pandacode-bridge send --sender-id ID --thread THREAD [--sender-name NAME] [--event-id ID] [--text TEXT]
       pandacode-bridge send --json            # read one JSON object on stdin
       pandacode-bridge receive                # one long poll, prints the JSON response
       pandacode-bridge listen                 # poll forever, one reply JSON per line
USAGE
    exit 2
}

# One inbound message. Flags win; --json takes a whole object so an adapter can pass a
# platform event through a jq filter without re-quoting it here.
send() {
    if [ "${1:-}" = "--json" ]; then
        body=$(cat)
    else
        sender_id='' thread='' sender_name='' event_id='' text=''
        while [ $# -gt 0 ]; do
            case $1 in
                --sender-id) sender_id=$2; shift 2 ;;
                --sender-name) sender_name=$2; shift 2 ;;
                --thread) thread=$2; shift 2 ;;
                --event-id) event_id=$2; shift 2 ;;
                --text) text=$2; shift 2 ;;
                -) text=$(cat); shift ;;
                *) die "unknown option: $1" ;;
            esac
        done
        [ -n "$sender_id" ] || die "--sender-id is required"
        [ -n "$thread" ] || die "--thread is required"
        [ -n "$text" ] || die "--text is required (or pass - and pipe it)"
        # An event id is optional; without one a retried POST can run twice.
        event_field=''
        [ -n "$event_id" ] && event_field="\"eventId\":\"$(printf '%s' "$event_id" | escape)\","
        body=$(printf '{%s"senderId":"%s","senderName":"%s","thread":"%s","text":"%s"}' \
            "$event_field" \
            "$(printf '%s' "$sender_id" | escape)" \
            "$(printf '%s' "${sender_name:-$sender_id}" | escape)" \
            "$(printf '%s' "$thread" | escape)" \
            "$(printf '%s' "$text" | escape)")
    fi
    curl -sS -X POST "$base/messages" \
        -H "Authorization: Bearer $token" \
        -H 'Content-Type: application/json' \
        --data-binary "$body"
    printf '\n'
}

# One long poll. The server holds the connection up to 25s, so `--max-time` is generous.
receive() {
    after=''
    [ -f "$cursor_file" ] && after=$(cat "$cursor_file" 2>/dev/null || true)
    response=$(curl -sS --max-time 40 "$base/events?after=${after:-0}" -H "Authorization: Bearer $token") \
        || die 'bridge request failed'
    case $response in
        *'"error"'*) die "$response" ;;
    esac
    # Remember the cursor only after the events were handed to the caller. The server may
    # put whitespace after the colon, so allow it.
    printf '%s' "$response" | sed -n 's/.*"cursor"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' > "$cursor_file" 2>/dev/null || true
    printf '%s\n' "$response"
}

# Poll forever, printing each reply as its own JSON line, so a shell loop can post them:
#
#   pandacode-bridge listen | while read -r line; do
#       text=$(printf '%s' "$line" | jq -r .text)
#       thread=$(printf '%s' "$line" | jq -r .thread)
#       my-platform-send "$thread" "$text"
#   done
listen() {
    while :; do
        response=$(receive) || exit 1
        case $response in
            *'"truncated":true'*|*'"truncated": true'*) printf '{"warning":"cursor fell behind; some replies were pruned"}\n' >&2 ;;
        esac
        # One event object per line. `fflush()` after each so a consumer reading the pipe
        # sees a reply immediately instead of waiting for a stdio buffer to fill.
        printf '%s' "$response" | tr -d '\n' | awk '
            {
                sub(/.*"events"[[:space:]]*:[[:space:]]*\[/, "")
                sub(/\].*/, "")
                n = split($0, parts, /\}[[:space:]]*,[[:space:]]*\{/)
                if (length(parts) == 1 && parts[1] == "") exit
                for (i = 1; i <= n; i++) {
                    if (parts[i] == "") continue
                    line = parts[i]
                    if (n > 1) {
                        if (i > 1) line = "{" line
                        if (i < n) line = line "}"
                    }
                    print line
                    fflush()
                }
            }'
    done
}

cmd=${1:-}; [ $# -gt 0 ] && shift || true
case $cmd in
    send) send "$@" ;;
    receive) receive ;;
    listen) listen ;;
    ''|-h|--help|help) usage ;;
    *) die "unknown command: $cmd" ;;
esac
