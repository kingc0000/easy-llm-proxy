# easy-llm-proxy — Docker 镜像
# 构建: docker build -t easy-llm-proxy .
# 运行: docker compose up -d   (见 docker-compose.yml)
FROM node:20-alpine

LABEL org.opencontainers.image.source="https://github.com/kingc0000/easy-llm-proxy" \
      org.opencontainers.image.description="通用 LLM Provider 多 Key 多 Model 加权轮询代理 + Web 管理面板"

ENV NODE_ENV=production \
    PROXY_PORT=8787 \
    BIND_HOST=0.0.0.0 \
    CONFIG_FILE=/etc/easy-llm-proxy/config.json \
    STATS_FILE=/var/lib/easy-llm-proxy/stats.json

WORKDIR /app

# 项目为纯 Node 标准库实现,无 node_modules
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY web ./web

# 配置与统计目录(挂载卷)
RUN mkdir -p /etc/easy-llm-proxy /var/lib/easy-llm-proxy

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/health > /dev/null 2>&1 || exit 1

# 优雅退出(捕获 SIGTERM 保存统计后退出)
STOPSIGNAL SIGTERM

CMD ["node", "bin/start.js"]