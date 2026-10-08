#!/bin/bash
# deploy.sh — easy-llm-proxy 原子部署脚本
#
# 用法: ./deploy.sh [端口]        # 默认 8790（与线上 sensenova-proxy 8787 并行,不冲突）
#
# 流程: 语法预检 → 安装 systemd unit → 启动 → 健康检查
set -euo pipefail

PORT="${1:-8790}"
DIR="/root/easy-llm-proxy"
SRC="$DIR/bin/start.js"
UNIT="/etc/systemd/system/easy-llm-proxy.service"
CONFIG_DIR="/etc/easy-llm-proxy"
STATS_DIR="/var/lib/easy-llm-proxy"

[ -f "$SRC" ] || { echo "❌ $SRC 不存在"; exit 1; }

echo "==> 1. 语法预检: node --check"
node --check "$SRC"

echo "==> 2. 准备配置（已有配置不覆盖；没有则沿用旧 sensenova 配置,最后才用示例）"
mkdir -p "$CONFIG_DIR" "$STATS_DIR"
chmod 600 "$CONFIG_DIR/config.json" 2>/dev/null || true  # 含真实 key,仅属主可读
if [ ! -f "$CONFIG_DIR/config.json" ]; then
  if [ -f /etc/sensenova-proxy/config.json ]; then
    cp /etc/sensenova-proxy/config.json "$CONFIG_DIR/config.json"
    echo "    已沿用旧 sensenova-proxy 配置(平滑迁移,3 key 直接可用)"
  else
    cp "$DIR/config.example.json" "$CONFIG_DIR/config.json"
    echo "    已写入示例配置(请填入真实 key)"
  fi
fi

echo "==> 2.5 防御性备份 auth.json / config.json（异常重建时可回滚）"
if [ -f "$CONFIG_DIR/auth.json" ]; then cp -p "$CONFIG_DIR/auth.json" "$CONFIG_DIR/auth.json.pre-deploy-$(date +%s)"; fi
[ -f "$STATS_DIR/stats.json" ] && cp -p "$STATS_DIR/stats.json" "$STATS_DIR/stats.json.pre-deploy-$(date +%s)" || true
[ -f "$CONFIG_DIR/config.json" ] && cp -p "$CONFIG_DIR/config.json" "$CONFIG_DIR/config.json.pre-deploy-$(date +%s)" || true

echo "==> 2.6 初始化管理账号（默认 admin/admin123;已存在 auth.json 不覆盖,服务实例账号以其为准）"
if [ ! -f "$CONFIG_DIR/auth.json" ]; then
  AUTH_FILE="$CONFIG_DIR/auth.json" AUTH_USER="${AUTH_USER:-admin}" AUTH_PASS="${AUTH_PASS:-admin123}" node -e "require('$DIR/src/auth.js').init(process.env.AUTH_USER, process.env.AUTH_PASS) && console.log('    已创建管理账号:'+process.env.AUTH_USER)" || true
fi

echo "==> 3. 安装 systemd unit（端口 $PORT）"
cat > "$UNIT" <<EOF
[Unit]
Description=easy-llm-proxy: general LLM provider multi-key proxy (OpenAI/Anthropic)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node $SRC
Environment=PROXY_PORT=$PORT
Environment=CONFIG_FILE=$CONFIG_DIR/config.json
Environment=STATS_FILE=$STATS_DIR/stats.json
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload

echo "==> 4. 启动服务"
systemctl enable easy-llm-proxy >/dev/null 2>&1 || true
systemctl restart easy-llm-proxy
sleep 2

echo "==> 5. 健康检查"
systemctl is-active easy-llm-proxy
curl -s --max-time 10 "http://127.0.0.1:$PORT/health" | head -c 400
echo
echo "✅ 完成: easy-llm-proxy 运行在 http://127.0.0.1:$PORT （并行测试,不影响 sensenova-proxy:8787）"
