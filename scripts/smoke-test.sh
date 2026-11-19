#!/usr/bin/env bash
# 本地端到端冒烟测试：启动 wrangler dev，验证鉴权 / CRUD / 用户隔离 / 安全头，然后关闭服务
set -uo pipefail

cd "$(dirname "$0")/.."
PORT="${PORT:-8787}"
BASE="http://127.0.0.1:${PORT}"
LOG=".wrangler/smoke-dev.log"
TMP=".wrangler/smoke-tmp"
mkdir -p .wrangler "$TMP"
FAIL=0

pass() { printf '  [PASS] %s\n' "$1"; }
fail() { printf '  [FAIL] %s\n' "$1"; FAIL=1; }
has() { grep -qi -- "$2" "$1" 2>/dev/null; }

echo '== 1. 初始化本地 D1 =='
npx wrangler d1 execute md-notes-db --local --file=./schema.sql >/dev/null 2>&1 \
  && pass 'schema.sql 执行成功' || fail 'schema.sql 执行失败'

echo '== 2. 启动本地 Worker =='
npx wrangler dev --local --port "$PORT" > "$LOG" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 90); do
  if curl -sf "$BASE/" -o /dev/null; then break; fi
  sleep 1
done
if curl -sf "$BASE/" -o /dev/null; then
  pass "服务已就绪 $BASE"
else
  fail '服务启动失败'; tail -60 "$LOG"; exit 1
fi

INVITE=$(sed -n 's/^INVITE_CODE=//p' .dev.vars | head -1)
UA="alice$RANDOM"; UB="bob$RANDOM"
# 每次运行使用不同模拟 IP，避免被固定窗口限流影响测试可重复性
TEST_IP="127.0.0.$((RANDOM % 200 + 20))"

echo '== 3. 注册两个用户 =='
curl -s -D "$TMP/hA" -o "$TMP/bA" -X POST "$BASE/api/auth/register" \
  -H "CF-Connecting-IP: $TEST_IP" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$UA\",\"password\":\"Passw0rd!123\",\"inviteCode\":\"$INVITE\"}"
curl -s -D "$TMP/hB" -o "$TMP/bB" -X POST "$BASE/api/auth/register" \
  -H "CF-Connecting-IP: $TEST_IP" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$UB\",\"password\":\"Passw0rd!123\",\"inviteCode\":\"$INVITE\"}"
CA=$(sed -n 's/^[Ss]et-[Cc]ookie: \(session=[^;]*\).*/\1/p' "$TMP/hA" | head -1)
CB=$(sed -n 's/^[Ss]et-[Cc]ookie: \(session=[^;]*\).*/\1/p' "$TMP/hB" | head -1)
[ -n "$CA" ] && pass '用户 A 注册并下发会话' || fail '用户 A 注册失败'
[ -n "$CB" ] && pass '用户 B 注册并下发会话' || fail '用户 B 注册失败'

echo '== 4. 未登录访问被拒绝 =='
curl -s -o "$TMP/bAnon" -w '%{http_code}' "$BASE/api/notes" > "$TMP/codeAnon"
[ "$(cat "$TMP/codeAnon")" = '401' ] && pass '未登录 GET /api/notes 返回 401' || fail '未登录访问未拒绝'

echo '== 5. A 新建笔记 =='
PAYLOAD='{"title":"测试笔记","content":"# Hello\n<script>alert(1)</script>"}'
curl -s -o "$TMP/bCreate" -w '%{http_code}' -X POST "$BASE/api/notes" \
  -H "Cookie: $CA" -H 'Content-Type: application/json' -d "$PAYLOAD" > "$TMP/codeCreate"
ID=$(sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p' "$TMP/bCreate" | head -1)
[ "$(cat "$TMP/codeCreate")" = '201' ] && pass '新建返回 201' || fail '新建失败'
[ -n "$ID" ] && pass "笔记 ID = $ID" || fail '无法解析笔记 ID'

echo '== 6. 用户隔离 =='
curl -s -o "$TMP/bCross" -w '%{http_code}' "$BASE/api/notes/$ID" -H "Cookie: $CB" > "$TMP/codeCross"
[ "$(cat "$TMP/codeCross")" = '404' ] && pass 'B 读取 A 的笔记返回 404' || fail '越权读取未被拦截'
curl -s "$BASE/api/notes" -H "Cookie: $CB" > "$TMP/bListB"
[ "$TMP/bListB" != "" ] && has "$TMP/bListB" '\[\]' && pass 'B 的列表为空' || fail 'B 的列表不为空'

echo '== 7. A 编辑并读取自己的笔记 =='
curl -s -o "$TMP/bUpdate" -w '%{http_code}' -X PUT "$BASE/api/notes/$ID" \
  -H "Cookie: $CA" -H 'Content-Type: application/json' \
  -d '{"title":"已更新标题","content":"**加粗** 与 `code`"}' > "$TMP/codeUpdate"
[ "$(cat "$TMP/codeUpdate")" = '200' ] && pass '更新返回 200' || fail '更新失败'
curl -s "$BASE/api/notes/$ID" -H "Cookie: $CA" > "$TMP/bGet"
has "$TMP/bGet" '已更新标题' && pass '读回更新后的标题' || fail '更新未持久化'
has "$TMP/bGet" '**加粗**' && pass '服务端仅存 Markdown 原文（HTML 由前端消毒）' || fail '原文未正确保存'

echo '== 8. 删除 =='
curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/notes/$ID" -H "Cookie: $CA" > "$TMP/codeDel"
[ "$(cat "$TMP/codeDel")" = '200' ] && pass '删除返回 200' || fail '删除失败'
curl -s -o /dev/null -w '%{http_code}' "$BASE/api/notes/$ID" -H "Cookie: $CA" > "$TMP/codeGetAfter"
[ "$(cat "$TMP/codeGetAfter")" = '404' ] && pass '删除后读取返回 404' || fail '删除未生效'

echo '== 9. 静态资源与安全头 =='
curl -s "$BASE/" > "$TMP/index"
has "$TMP/index" 'Markdown 记事本' && pass '首页可访问' || fail '首页异常'
curl -s -o /dev/null -w '%{http_code}' "$BASE/app.js" > "$TMP/codeJs"
[ "$(cat "$TMP/codeJs")" = '200' ] && pass '前端脚本可访问' || fail 'app.js 不可访问'
has "$TMP/hA" 'HttpOnly' && pass 'Cookie 含 HttpOnly' || fail 'Cookie 缺 HttpOnly'
has "$TMP/hA" 'Secure' && pass 'Cookie 含 Secure' || fail 'Cookie 缺 Secure'
has "$TMP/hA" 'SameSite=Lax' && pass 'Cookie 含 SameSite=Lax' || fail 'Cookie 缺 SameSite'
has "$TMP/hA" 'content-security-policy' && pass '响应含 CSP' || fail '响应缺 CSP'

echo '== 10. 会话吊销 =='
curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/logout" -H "Cookie: $CA" > "$TMP/codeLogout"
[ "$(cat "$TMP/codeLogout")" = '200' ] && pass '登出返回 200' || fail '登出失败'
curl -s -o /dev/null -w '%{http_code}' "$BASE/api/notes" -H "Cookie: $CA" > "$TMP/codeRevoked"
[ "$(cat "$TMP/codeRevoked")" = '401' ] && pass '登出后旧 Cookie 失效（服务端会话已删除）' || fail '旧 Cookie 仍可访问'
curl -s -o /dev/null -w '%{http_code}' "$BASE/api/notes" -H "Cookie: $CB" > "$TMP/codeOther"
[ "$(cat "$TMP/codeOther")" = '200' ] && pass '其他用户会话不受影响' || fail '误伤其他会话'

echo
if [ "$FAIL" -eq 0 ]; then echo 'SMOKE TEST: ALL PASS'; else echo 'SMOKE TEST: FAILED'; fi
exit "$FAIL"
