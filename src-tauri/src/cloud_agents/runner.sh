#!/bin/sh
# PandaCode cloud agent runner (docs/cloud-agents.md, step 5). Started detached with
# `exec sh ./runner.sh` in its run directory, so $$ leads the process group.
# Runs cmd.sh (the harness) with stdin from the append-only file `inbox`, stdout in `out`,
# stderr in `err`; writes `pid` first and `exit` last. Touching `eof` (after the last
# append) closes the harness's stdin once everything before it was delivered. Nothing
# here depends on the client staying connected.
cd "$(dirname "$0")" || exit 1
trap '' HUP
echo $$ > pid
: >> inbox
: >> out
: >> err
rm -f stdin.fifo
mkfifo stdin.fifo || { echo 127 > exit.tmp; mv exit.tmp exit; exit 1; }
(
  sent=0
  while :; do
    last=; [ -f eof ] && last=1
    size=$(wc -c < inbox | tr -d ' ')
    if [ "$size" -gt "$sent" ]; then
      tail -c +"$((sent + 1))" inbox | head -c "$((size - sent))"
      sent=$size
    fi
    [ -n "$last" ] && break
    sleep 0.2 2>/dev/null || sleep 1
  done
) > stdin.fifo &
feeder=$!
sh ./cmd.sh < stdin.fifo >> out 2>> err
code=$?
kill "$feeder" 2>/dev/null
rm -f stdin.fifo
echo "$code" > exit.tmp && mv exit.tmp exit
