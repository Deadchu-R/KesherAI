#!/bin/sh
# KesherAI for Waybar (and other bars that run a script and read JSON: i3status-rust, eww, polybar with a wrapper).
# Prints {"text","tooltip","class"}: how many KesherAI chats are working. KESHERAI_URL / KESHERAI_TOKEN pick another
# of your computers (its address and remote-access token); this computer by default.
URL="${KESHERAI_URL:-http://127.0.0.1:7420}"
AUTH=""
[ -n "$KESHERAI_TOKEN" ] && AUTH="Authorization: Bearer $KESHERAI_TOKEN"
if ! act=$(curl -sf --connect-timeout 2 --max-time 4 ${AUTH:+-H "$AUTH"} "$URL/api/conversations/activity"); then
  printf '{"text":"✦","tooltip":"KesherAI is not running","class":"offline"}\n'
  exit 0
fi
n=$(printf '%s' "$act" | grep -o '":"' | wc -l | tr -d ' ')
if [ "$n" -gt 0 ]; then
  printf '{"text":"✦ %s","tooltip":"KesherAI: %s chats working","class":"working"}\n' "$n" "$n"
else
  printf '{"text":"✦","tooltip":"KesherAI: ready","class":"idle"}\n'
fi
