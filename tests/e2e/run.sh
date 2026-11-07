#!/bin/bash
# 端到端冒烟测试：启动调试服务器（如果没在跑），按顺序跑 tests/e2e/*.py
# 依赖：.venv 里装 playwright（uv pip install playwright && .venv/bin/playwright install chromium）
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PY="$ROOT/.venv/bin/python"
URL="${SEEDBOXES_URL:-http://127.0.0.1:8765}"
export E2E_OUT="${E2E_OUT:-/tmp/seedboxes-e2e/}"
if ! curl -s -o /dev/null "$URL/index.html"; then
  (cd "$ROOT" && "$PY" scripts/dev_server.py 8765 > "$E2E_OUT.devserver.log" 2>&1 &)
  for i in $(seq 1 40); do curl -s -o /dev/null "$URL/index.html" && break; sleep 0.5; done
fi
TESTS=("$@"); [ ${#TESTS[@]} -eq 0 ] && TESTS=(sheet1 keep1 drag1 ov1 tx1 bool1 bh fit1 rot1 layers1 panels1 radial1 line1 thick1 stage1 home1 smart1 precise1 rcfg1 sf5)
for t in "${TESTS[@]}"; do
  echo "=== $t"
  "$PY" "$ROOT/tests/e2e/$t.py" 2>&1 | grep -v "GL Driver"
done
echo "截图在 $E2E_OUT"
