#!/usr/bin/env bash
# 隔离 e2e: 验证多 provider 下 "外部只传 model 即自动路由 + /v1/models 全量列表"
# 不碰生产 elp(8790)。用法: bash test/e2e-multiprovider.sh
set -euo pipefail
cd "$(dirname "$0")/.."

TMP=$(mktemp -d)
MOCK_A=$((9900 + RANDOM % 100)); MOCK_B=$((10100 + RANDOM % 100)); ELP=$((8790 + RANDOM % 300))
export MOCK_A MOCK_B ELP
cleanup() { kill "${PIDS[@]}" 2>/dev/null || true; rm -rf "$TMP"; }
PIDS=()
trap cleanup EXIT

# 两个假上游 provider
node -e '
const http=require("http");
const port=parseInt(process.env.MOCK_A,10);
http.createServer((req,res)=>{const c=[];req.on("data",x=>c.push(x));req.on("end",()=>{let b={};try{b=JSON.parse(Buffer.concat(c).toString())}catch{}
if(req.url.startsWith("/v1/models")){res.writeHead(200,{"Content-Type":"application/json"});return res.end(JSON.stringify({object:"list",data:[{id:"p1a"},{id:"p1b"}]}))}
res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({id:"m1",object:"chat.completion",created:1,model:b.model||"p1a",choices:[{index:0,message:{role:"assistant",content:"OK from providerA/"+(b.model||"?")},finish_reason:"stop"}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}))})}).listen(port,"127.0.0.1",()=>console.log("[mockA]",port))' &
PIDS+=($!)
node -e '
const http=require("http");
const port=parseInt(process.env.MOCK_B,10);
http.createServer((req,res)=>{const c=[];req.on("data",x=>c.push(x));req.on("end",()=>{let b={};try{b=JSON.parse(Buffer.concat(c).toString())}catch{}
res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({id:"m2",object:"chat.completion",created:1,model:b.model||"p2a",choices:[{index:0,message:{role:"assistant",content:"OK from providerB/"+(b.model||"?")},finish_reason:"stop"}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}))})}).listen(port,"127.0.0.1",()=>console.log("[mockB]",port))' &
PIDS+=($!)

# 双 provider 配置
cat > "$TMP/config.json" <<EOF
{ "defaultProvider": null, "providers": [
  { "name": "A", "weight": 95, "apiType": "openai", "baseURL": "http://127.0.0.1:$MOCK_A/v1", "models": [
      { "id": "p1a", "weight": 95, "keys": ["sk-a1"] }, { "id": "p1b", "weight": 90, "keys": ["sk-a2"] } ] },
  { "name": "B", "weight": 90, "apiType": "openai", "baseURL": "http://127.0.0.1:$MOCK_B/v1", "models": [
      { "id": "p2a", "weight": 95, "keys": ["sk-b1"] }, { "id": "p2b", "weight": 90, "keys": ["sk-b2"] } ] }
] }
EOF
: > "$TMP/keys.json"

sleep 1
PROXY_PORT=$ELP CONFIG_FILE="$TMP/config.json" KEYS_FILE="$TMP/keys.json" REQUESTS_DIR="$TMP/req" node bin/start.js &
PIDS+=($!)
sleep 2

echo "--- 1) 无任何自定义头, model=p1a → 应路由到 provider A ---"
R1=$(curl -s --max-time 8 -X POST "http://127.0.0.1:$ELP/v1/chat/completions" -H 'Content-Type: application/json' -d '{"model":"p1a","messages":[{"role":"user","content":"hi"}]}')
echo "$R1" | grep -o 'OK from providerA/p1a' || { echo "FAIL: $R1"; exit 1; }

echo "--- 2) 无自定义头, model=p2a → 应路由到 provider B ---"
R2=$(curl -s --max-time 8 -X POST "http://127.0.0.1:$ELP/v1/chat/completions" -H 'Content-Type: application/json' -d '{"model":"p2a","messages":[{"role":"user","content":"hi"}]}')
echo "$R2" | grep -o 'OK from providerB/p2a' || { echo "FAIL: $R2"; exit 1; }

echo "--- 3) /v1/models 无头 → 全部 4 真实模型 + 每 provider 一个 <provider>/auto = 6 条 ---"
R3=$(curl -s --max-time 8 "http://127.0.0.1:$ELP/v1/models")
echo "$R3" | grep -oE '"id":"p[12][ab]"|"id":"[AB]/auto"' | sort | tr '\n' ' '; echo
[ "$(echo "$R3" | grep -oE '"id":"p[12][ab]"|"id":"[AB]/auto"' | wc -l)" = "6" ] || { echo "FAIL: $R3"; exit 1; }

echo "--- 4) /v1/models 带 x-provider-name: B → B 的 2 真实 + auto = 3 条 ---"
R4=$(curl -s --max-time 8 "http://127.0.0.1:$ELP/v1/models" -H 'x-provider-name: B')
echo "$R4" | grep -oE '"id":"p[12][ab]"|"id":"[AB]/auto"' | sort | tr '\n' ' '; echo
[ "$(echo "$R4" | grep -oE '"id":"p[12][ab]"|"id":"[AB]/auto"' | wc -l)" = "3" ] || { echo "FAIL: $R4"; exit 1; }

echo "--- 5) model=auto 无头连续 6 次 → 分发到 A/B 所有 provider 的主 model ---"
AUTO=""
for i in 1 2 3 4 5 6; do
  AUTO="$AUTO$(curl -s --max-time 8 -X POST "http://127.0.0.1:$ELP/v1/chat/completions" -H 'Content-Type: application/json' -d '{"model":"auto","messages":[{"role":"user","content":"hi"}]}' | grep -oE 'OK from provider[AB]/p[12][ab]' | tr -d '\n') "
done
echo "实际: $AUTO"
echo "$AUTO" | grep -q 'providerA/p1a' || { echo "FAIL: auto 未路由到 provider A 主 model"; exit 1; }
echo "$AUTO" | grep -q 'providerB/p2a' || { echo "FAIL: auto 未路由到 provider B 主 model"; exit 1; }
echo "$AUTO" | grep -qE 'provider[AB]/p[12]b' && { echo "FAIL: auto 不应落到备用 model"; exit 1; }

echo "--- 5b) model=A/auto → 锁定 provider A 主 model; model=B/auto → 锁定 B ---"
R5b=$(curl -s --max-time 8 -X POST "http://127.0.0.1:$ELP/v1/chat/completions" -H 'Content-Type: application/json' -d '{"model":"A/auto","messages":[{"role":"user","content":"hi"}]}')
echo "$R5b" | grep -o 'OK from providerA/p1a' || { echo "FAIL(A/auto): $R5b"; exit 1; }
R5c=$(curl -s --max-time 8 -X POST "http://127.0.0.1:$ELP/v1/chat/completions" -H 'Content-Type: application/json' -d '{"model":"B/auto","messages":[{"role":"user","content":"hi"}]}')
echo "$R5c" | grep -o 'OK from providerB/p2a' || { echo "FAIL(B/auto): $R5c"; exit 1; }
R5d=$(curl -s --max-time 8 -X POST "http://127.0.0.1:$ELP/v1/chat/completions" -H 'Content-Type: application/json' -d '{"model":"NoSuch/auto","messages":[{"role":"user","content":"hi"}]}')
echo "$R5d" | grep -q '不存在' || { echo "FAIL(未知 provider auto): $R5d"; exit 1; }

echo "--- 6) model=auto + x-provider-name: A → 锁定 A 主 model ---"
R6=$(curl -s --max-time 8 -X POST "http://127.0.0.1:$ELP/v1/chat/completions" -H 'Content-Type: application/json' -H 'x-provider-name: A' -d '{"model":"auto","messages":[{"role":"user","content":"hi"}]}')
echo "$R6" | grep -o 'OK from providerA/p1a' || { echo "FAIL: $R6"; exit 1; }

echo "--- 7) 显式 x-provider-name: B + model=p1a → 仍走 B(头优先), p1a 不在 B 配置内 → 主 key 池透传 ---"
R7=$(curl -s --max-time 8 -X POST "http://127.0.0.1:$ELP/v1/chat/completions" -H 'Content-Type: application/json' -H 'x-provider-name: B' -d '{"model":"p1a","messages":[{"role":"user","content":"hi"}]}')
echo "$R7" | grep -o 'OK from providerB/p1a' || { echo "FAIL: $R7"; exit 1; }

echo "--- 8) 30 次 auto → 各 provider 均被覆盖、无单边独占 (权重比例 95:90 由单测 185 次精确验证) ---"
N=0; A=0; B=0
for i in $(seq 1 30); do
  R=$(curl -s --max-time 8 -X POST "http://127.0.0.1:$ELP/v1/chat/completions" -H 'Content-Type: application/json' -d '{"model":"auto","messages":[{"role":"user","content":"hi"}]}')
  if echo "$R" | grep -q 'providerA'; then A=$((A+1))
  elif echo "$R" | grep -q 'providerB'; then B=$((B+1))
  fi
done
N=$((A+B))
echo "30 次实际: A=$A B=$B (命中 $N/30)"
[ "$A" -ge 10 ] || { echo "FAIL: provider A 覆盖不足 ($A)"; exit 1; }
[ "$B" -ge 10 ] || { echo "FAIL: provider B 覆盖不足 ($B)"; exit 1; }
[ "$N" -ge 28 ] || { echo "FAIL: 命中数过低 $N/30"; exit 1; }

echo "ALL PASS"
