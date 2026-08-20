#!/usr/bin/env bash
# ADR-076 §7 — Consumer-contract smoke test for the public MCP surface.
#
# What it verifies (idempotent, read-only):
#   A. Un-auth surface — RFC 9728 + RFC 8414 discovery + WWW-Authenticate
#   B. RFC 7591 dynamic client registration
#   C. Bearer-auth surface (when TOKEN is set) — every §2 consumer tool
#      returns a well-formed result against the first available record
#
# Usage:
#   MCP_URL=https://video-sync-mcp-667037737667.us-central1.run.app \
#   TOKEN=vsync_XXXXXXXXXXXXX \
#     bash scripts/mcp-consumer-contract-test.sh
#
# Without TOKEN, only stages A + B run — enough to prove the un-auth
# contract on a fresh deployment.

set -u
MCP="${MCP_URL:-https://video-sync-mcp-667037737667.us-central1.run.app}"
BASE="$MCP/api/mcp"
TOKEN="${TOKEN:-}"

pass=0
fail=0
section() { echo; echo "=== $1 ==="; }
ok()      { echo "  ✓ $1"; pass=$((pass + 1)); }
bad()     { echo "  ✗ $1"; fail=$((fail + 1)); }

rpc() {
  local method="$1"; local params="${2:-{}}"
  local h_auth=()
  [ -n "$TOKEN" ] && h_auth=(-H "Authorization: Bearer $TOKEN")
  curl -sS -X POST "$BASE" \
    -H "Content-Type: application/json" \
    "${h_auth[@]}" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$method\",\"params\":$params}"
}

# ─── A. Un-auth discovery ────────────────────────────────────
section "A. Un-auth discovery + 401 shape"

body=$(curl -sS "$MCP/.well-known/oauth-protected-resource")
echo "$body" | python3 -c "
import sys,json
d=json.load(sys.stdin)
must = ['resource','authorization_servers','scopes_supported','bearer_methods_supported']
missing = [k for k in must if k not in d]
if missing: print('MISSING:', missing); sys.exit(1)
if 'mcp' not in d.get('scopes_supported',[]): print('scope mcp absent'); sys.exit(1)
" && ok "protected-resource metadata (RFC 9728)" || bad "protected-resource metadata"

body=$(curl -sS "$MCP/.well-known/oauth-authorization-server")
echo "$body" | python3 -c "
import sys,json
d=json.load(sys.stdin)
must = ['issuer','authorization_endpoint','token_endpoint','registration_endpoint','code_challenge_methods_supported']
missing = [k for k in must if k not in d]
if missing: print('MISSING:', missing); sys.exit(1)
if 'S256' not in d.get('code_challenge_methods_supported',[]): print('S256 missing'); sys.exit(1)
" && ok "auth-server metadata (RFC 8414, PKCE-S256)" || bad "auth-server metadata"

hdrs=$(curl -sS -i -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' "$BASE" | head -20)
echo "$hdrs" | grep -qi "^HTTP.*401" && ok "anonymous POST → 401" || bad "anonymous POST did not 401"
echo "$hdrs" | grep -qi '^www-authenticate: Bearer resource_metadata=' \
  && ok "WWW-Authenticate points at protected-resource metadata" \
  || bad "WWW-Authenticate missing / malformed"

# ─── B. RFC 7591 dynamic client registration ────────────────
section "B. RFC 7591 dynamic client registration"

reg=$(curl -sS -X POST -H "Content-Type: application/json" \
  -d '{"client_name":"consumer-contract-test","redirect_uris":["http://localhost/cb"]}' \
  "$BASE/oauth/register")
echo "$reg" | python3 -c "
import sys,json
d=json.load(sys.stdin)
if 'client_id' not in d or not d['client_id'].startswith('mcp_'):
    print('bad client_id:',d); sys.exit(1)
must = ['grant_types','response_types','token_endpoint_auth_method']
missing = [k for k in must if k not in d]
if missing: print('MISSING:', missing); sys.exit(1)
" && ok "registration returns RFC 7591 shape + mcp_ client_id" || bad "registration payload malformed"

# ─── C. Bearer-auth surface (only with TOKEN) ────────────────
if [ -z "$TOKEN" ]; then
  section "C. Bearer-auth surface — SKIPPED (set TOKEN=vsync_… to run)"
else
  section "C. Bearer-auth surface"

  # C.1 initialize returns serverInfo + instructions
  rpc initialize | python3 -c "
import sys,json
d=json.load(sys.stdin)
r=d.get('result',{})
if not r: print('no result:',d); sys.exit(1)
if 'serverInfo' not in r or 'instructions' not in r:
    print('missing serverInfo/instructions'); sys.exit(1)
" && ok "initialize returns serverInfo + instructions" || bad "initialize malformed"

  # C.2 tools/list advertises the §2 consumer subset
  rpc tools/list | python3 -c "
import sys,json
d=json.load(sys.stdin)
tools=[t['name'] for t in d.get('result',{}).get('tools',[])]
need = ['list_series','search_records','get_show_notes','get_description','get_description_full','get_reference','list_artifacts']
missing = [n for n in need if n not in tools]
if missing: print('MISSING TOOLS:', missing); sys.exit(1)
print(f'  advertised: {len(tools)} tools ({sum(1 for n in need if n in tools)}/{len(need)} consumer subset present)')
" && ok "tools/list advertises consumer subset" || bad "consumer tools missing from tools/list"

  # C.3 resources/list advertises the §2 kinds
  rpc resources/list | python3 -c "
import sys,json,re
d=json.load(sys.stdin)
uris=[r['uri'] for r in d.get('result',{}).get('resources',[])]
def has(kind): return any(re.search(rf'/{kind}\$', u) for u in uris)
seen_kinds=[k for k in ['show-notes','description','description-full','transcript','chat','youtube-snippet','reference','artifacts'] if has(k)]
if not seen_kinds: print('no resources advertised — is the catalog empty?'); sys.exit(1)
print('  kinds present:', seen_kinds)
" && ok "resources/list advertises artifact URIs" || bad "resources/list surface missing"

  # C.4 pick a record & exercise the consumer tools
  RECORD_ID=$(rpc resources/list | python3 -c "
import sys,json,re
d=json.load(sys.stdin)
for r in d.get('result',{}).get('resources',[]):
    m=re.match(r'vsync://records/([0-9a-f-]+)/show-notes',r['uri'])
    if m: print(m.group(1)); break
")
  if [ -z "$RECORD_ID" ]; then
    bad "no test record with Show Notes — skipping per-tool checks"
  else
    echo "  test record: $RECORD_ID"

    rpc tools/call "{\"name\":\"list_series\",\"arguments\":{}}" | python3 -c "
import sys,json
d=json.load(sys.stdin)
txt=d.get('result',{}).get('content',[{}])[0].get('text','')
parsed=json.loads(txt)
if 'series' not in parsed: print('missing series key:',parsed); sys.exit(1)
print(f\"  series: {len(parsed['series'])}\")
" && ok "list_series result shape" || bad "list_series malformed"

    rpc tools/call "{\"name\":\"search_records\",\"arguments\":{\"query\":\"a\",\"limit\":3}}" | python3 -c "
import sys,json
d=json.load(sys.stdin)
txt=d.get('result',{}).get('content',[{}])[0].get('text','')
parsed=json.loads(txt)
if not isinstance(parsed.get('hits'),list): print('missing hits'); sys.exit(1)
if parsed['hits']:
    h=parsed['hits'][0]
    for k in ['id','title','source_platform','has_show_notes','deep_link']:
        if k not in h: print('hit missing',k); sys.exit(1)
print(f\"  hits: {len(parsed['hits'])}\")
" && ok "search_records result shape" || bad "search_records malformed"

    rpc tools/call "{\"name\":\"get_show_notes\",\"arguments\":{\"record_id\":\"$RECORD_ID\"}}" | python3 -c "
import sys,json
d=json.load(sys.stdin)
txt=d.get('result',{}).get('content',[{}])[0].get('text','')
if len(txt)<50: print('show notes suspiciously short:',len(txt)); sys.exit(1)
print(f'  show_notes length: {len(txt)} chars')
" && ok "get_show_notes returns markdown" || bad "get_show_notes malformed"

    rpc tools/call "{\"name\":\"get_description\",\"arguments\":{\"record_id\":\"$RECORD_ID\"}}" | python3 -c "
import sys,json
d=json.load(sys.stdin)
txt=d.get('result',{}).get('content',[{}])[0].get('text','')
print(f'  description length: {len(txt)} chars')
" && ok "get_description reachable" || bad "get_description failed"

    rpc tools/call "{\"name\":\"get_description_full\",\"arguments\":{\"record_id\":\"$RECORD_ID\"}}" | python3 -c "
import sys,json
d=json.load(sys.stdin)
r=d.get('result',{})
if r.get('isError'):
    print('  ⚠ description-full not yet materialised (expected until operator runs Rewrite from Show Notes)')
else:
    txt=r.get('content',[{}])[0].get('text','')
    print(f'  description_full length: {len(txt)} chars')
" && ok "get_description_full graceful (materialised OR informative error)" || bad "get_description_full malformed"

    rpc tools/call "{\"name\":\"get_reference\",\"arguments\":{\"record_id\":\"$RECORD_ID\"}}" | python3 -c "
import sys,json
d=json.load(sys.stdin)
r=d.get('result',{})
txt=r.get('content',[{}])[0].get('text','')
if r.get('isError'):
    try:
        parsed=json.loads(txt)
        print(f'  ⚠ reference not_yet_generated: {parsed.get(\"reason\",\"?\")}')
    except: print(f'  ⚠ reference error: {txt[:120]}')
else:
    print(f'  reference length: {len(txt)} chars')
" && ok "get_reference reachable" || bad "get_reference failed"

    rpc tools/call "{\"name\":\"list_artifacts\",\"arguments\":{\"record_id\":\"$RECORD_ID\"}}" | python3 -c "
import sys,json
d=json.load(sys.stdin)
txt=d.get('result',{}).get('content',[{}])[0].get('text','')
parsed=json.loads(txt)
arts=parsed.get('artifacts',{})
print(f\"  artifacts on Drive: {sorted(arts.keys())}\")
" && ok "list_artifacts returns .meta.json index" || bad "list_artifacts malformed"
  fi
fi

echo
echo "─────────────────────────────────────────"
echo "PASS: $pass    FAIL: $fail"
[ $fail -eq 0 ] && exit 0 || exit 1
