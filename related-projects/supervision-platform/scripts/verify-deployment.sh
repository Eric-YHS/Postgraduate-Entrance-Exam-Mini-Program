#!/usr/bin/env sh
set -eu

BASE_URL=${1:-http://127.0.0.1:4000}
fail() {
  printf 'verify-deployment failed: %s\n' "$1" >&2
  exit 1
}
request() {
  curl -fsS --max-time 15 "$1"
}
assert_ok() {
  printf '%s' "$1" | grep -q '"ok":true' || fail "expected ok response, got $1"
}
assert_status() {
  url=$1
  expected=$2
  actual=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$url")
  [ "$actual" = "$expected" ] || fail "$url returned $actual, expected $expected"
}

HEALTH=$(request "$BASE_URL/health")
assert_ok "$HEALTH"
READY=$(request "$BASE_URL/ready")
assert_ok "$READY"
ROOT_HEADERS=$(curl -fsSI --max-time 15 "$BASE_URL/")
printf '%s' "$ROOT_HEADERS" | grep -qi '^content-type:.*text/html' || fail "root did not return HTML"

assert_status "$BASE_URL/api/auth/me" 401
assert_status "$BASE_URL/api/orders" 401
assert_status "$BASE_URL/api/students" 401
assert_status "$BASE_URL/api/products" 401
assert_status "$BASE_URL/api/courses" 401

# Login path should validate input and reject unknown credentials, not 500.
LOGIN_STATUS=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -X POST -H 'Content-Type: application/json' -d '{"phone":"not-a-phone","password":"short"}' "$BASE_URL/api/auth/login")
case "$LOGIN_STATUS" in 400|401) ;; *) fail "login schema validation returned $LOGIN_STATUS" ;; esac

# Sensitive endpoints must not be reachable without credentials.
AUTH_PROBE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$BASE_URL/api/admin/entrance/questions")
[ "$AUTH_PROBE" = "401" ] || fail "/api/admin/entrance/questions returned $AUTH_PROBE, expected 401"

printf 'deployment smoke checks passed: health, readiness, web, auth guard, payload validation\n'
