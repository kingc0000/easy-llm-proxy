#!/bin/bash
# deploy-docker.sh — easy-llm-proxy Docker 一键部署
#
# 用法: ./deploy-docker.sh [公网端口]
#   默认 8790(与线上 sensenova-proxy 8787 / systemd 8790 并行)
#
# 首次自动准备配置: 有旧 sensenova 配置则沿用,否则复制示例
set -euo pipefail

PORT="${1:-8790}"
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "==> 1. 准备配置目录"
mkdir -p config data
if [ ! -f config/config.json ]; then
  if [ -f /etc/sensenova-proxy/config.json ]; then
    cp /etc/sensenova-proxy/config.json config/config.json
    echo "    已沿用旧 sensenova-proxy 配置(自动转换为 v2 格式加载)"
  else
    cp config.example.json config/config.json
    echo "    已写入示例配置,请编辑 config/config.json 填入真实 key"
  fi
fi

echo "==> 2. 构建镜像"
docker build -t easy-llm-proxy:local .

echo "==> 3. 启动容器(端口 $PORT)"
PROXY_PUBLIC_PORT="$PORT" docker compose up -d --build

echo "==> 4. 等待健康检查"
for i in $(seq 1 20); do
  if curl -sf --max-time 3 "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then
    echo "✅ 健康检查通过"
    curl -s "http://127.0.0.1:$PORT/health" | head -c 200; echo
    echo "✅ Docker 部署完成: Web 面板 http://127.0.0.1:$PORT/"
    exit 0
  fi
  sleep 2
done
echo "❌ 健康检查超时,查看: docker logs easy-llm-proxy"
exit 1