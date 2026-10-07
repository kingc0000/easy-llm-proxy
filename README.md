# easy-llm-proxy v2

通用 LLM Provider **多 Key 多 Model 加权轮询代理** + **Web 管理面板**。
独立代理服务，任何支持 OpenAI 兼容接口的 agent 都可以接入（dsh、chatbox、lobe、one-api 等）。

## 核心能力

| 能力 | 说明 |
|---|---|
| 🎯 **加权轮询引擎** | 每 provider 多 model，model 配置权重(1-100)；主 model 限流 → 换 key → 全部 key 限流 → 按权重降级到下一个 model（100→99→97…） |
| 🔄 **自动切回** | 降级 model 使用达到 **成功次数**(usageLimit) 或 **时长**(useSeconds) 任一限制 → 自动切回权重 100 的主 model；`次数 = 成功返回的次数(2xx)，不是调用次数` |
| 🔑 **多 key 轮询** | 每 model 可配任意多个 key，round-robin + 429/5xx 自动换 key |
| 🌐 **协议归一化** | `openai`(默认) / `anthropic`(原生 /v1/messages + x-api-key)；Anthropic provider 自动做请求/非流式/流式 SSE 双向转换，客户端无感 |
| 💻 **Web 管理面板** | 浏览器可视化配置 provider/model/权重/key，免改配置文件 |
| 📊 **用量统计** | `/stats` per-provider/model/key 持久化统计 |
| ⚡ 热加载 / 健康检查 / 旧配置兼容 | 改配置即时生效；`/health`；旧 sensenova-proxy 配置自动转换 |

## 快速开始

```bash
cd /root/easy-llm-proxy
npm start                     # 或 ./deploy.sh 8790(安装 systemd 服务)
# 浏览器打开 http://127.0.0.1:8790/ 在 Web 面板添加 provider
# 或直接编辑 /etc/easy-llm-proxy/config.json
```

作为任何 agent 的 provider 使用：

```
baseURL: http://127.0.0.1:8790/v1
apiKey:  任意占位(代理本身不校验)
模型:    配置里任一 model id;未配置的 model 自动透传 + 用主 key 池
```

## 配置(v2)

```jsonc
{
  "defaultProvider": null,        // 固定用某个 provider(不指定 X-Provider-Name 时)
  "providers": [
    {
      "name": "sensenova",
      "apiType": "openai",                 // "openai" | "anthropic"
      "baseURL": "https://token.sensenova.cn",
      "usageLimit": 5,                     // provider 级默认: 降级后成功 N 次切回主(0=不限)
      "useSeconds": 10,                    // provider 级默认: 降级后 N 秒切回主(0=不限)
      "models": [
        {
          "id": "deepseek-v4-flash",       // 模型 id,被上流主 model
          "weight": 100,                   // 权重 1-100,越大越优先
          "usageLimit": 3,                 // 可选,覆盖 provider 默认
          "useSeconds": 10,                // 可选,覆盖 provider 默认
          "keys": ["sk-主key1", "sk-主key2"]
        },
        {
          "id": "sensenova-6.8-flash-lite",// 降级目标
          "weight": 90,
          "usageLimit": 1,
          "useSeconds": 20,
          "keys": ["sk-备用key"]
        }
      ]
    }
  ]
}
```

### 轮询规则(引擎语义)

1. 请求进来 → 命中配置的 model → 从该 model 的 key 开始轮询
2. 429/5xx/模型错误 → 换下一个 key;该 model 全部 key 失败 → **降级到权重更低的 model**（按权重降序）
3. 降级期间 成功次数 ≥ usageLimit **或** 持续时间 ≥ useSeconds → **切回权重最高的主 model**
4. 最低权重也失败 → 回到主 model 重试(带总尝试上限防死循环)
5. 请求 model **不在配置中** → 直接透传该 model + 用主 model 的 key 池(仅换 key,不降级)
6. 多 provider: 请求头 `X-Provider-Name: name` 指定,或 `defaultProvider`,或不指定则混合轮询

### 兼容旧配置

旧 sensenova-proxy 格式(`{"keys":[...]}` 无 models)自动转换为单 model `default`(weight 100),请求任意 model 走 key 池透传,平滑迁移。

## API

| 端点 | 说明 |
|---|---|
| `POST /v1/chat/completions` | 对话(OpenAI 格式,流式/非流式) |
| `GET /v1/models` | 模型列表(配置的 models) |
| `GET /health` / `/stats` | 健康检查 / 用量统计 |
| `GET /api/providers` | 管理: provider 列表(key 脱敏) |
| `POST /api/providers` / `PUT·DELETE /api/providers/:name` | 管理: 增删改 |
| `POST /api/providers/:name/test` | 管理: 测试连接 |
| `GET/PUT /api/config` | 管理: 整体读写配置 |
| `/` | Web 管理面板 |

管理 API 可选鉴权: 设置环境变量 `ADMIN_TOKEN` 后需 `X-Admin-Token` 头。

## 项目结构

```
easy-llm-proxy/
├── bin/start.js         入口
├── src/
│   ├── proxy.js         HTTP 服务(/v1 代理 + 管理 API + Web)
│   ├── balance.js       加权轮询引擎(核心)
│   ├── config.js        v2 配置模型 + 旧格式兼容
│   ├── adapters.js      上游请求 + openai/anthropic 协议转换
│   └── stats.js         per-key 统计持久化
├── web/                 Web 管理面板(零依赖 HTML/JS/CSS)
├── test/                单测 + mock 集成测试
├── deploy.sh            systemd 一键部署
└── config.example.json
```

## 本地部署(systemd)

```bash
./deploy.sh 8790        # 原子部署 + systemd 服务(开机自启,可传任意端口)
systemctl status easy-llm-proxy
journalctl -u easy-llm-proxy -f   # 查看日志
```

服务环境: PROXY_PORT / CONFIG_FILE(/etc/easy-llm-proxy/config.json) / STATS_FILE / MAX_ATTEMPTS。
停用: `systemctl disable --now easy-llm-proxy`。

## Docker 部署

```bash
./deploy-docker.sh 8790   # 一键: 准备配置 → 构建镜像 → 启动容器(compose)
# 或手动:
docker build -t easy-llm-proxy:local .
PROXY_PUBLIC_PORT=8790 ADMIN_TOKEN=xxx docker compose up -d
docker logs -f easy-llm-proxy
```

特性:
- 镜像 `node:20-alpine`(约 193MB),健康检查内置
- `config/` `data/` 目录挂载持久化(均已 gitignore,防止 key 泄露进仓库)
- 容器内监听 `0.0.0.0`(BIND_HOST=0.0.0.0),本地部署保持仅回环 127.0.0.1
- 重新构建: `docker compose up -d --build`
- 停止: `docker compose down`(镜像保留);彻底删除: `docker rmi easy-llm-proxy:local`

> 两种方式可共存并行测试(如 systemd 8790 + docker 8791);正式切换到 Docker 时
> 先停 systemd 服务释放端口。

## 测试

```bash
npm test        # 引擎单元测试(降级/切回/计数等 10 例)
node test/mock-upstream.js 9902   # 限流模拟上游(集成演练)
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PROXY_PORT` | 8787 | 监听端口 |
| `CONFIG_FILE` | /etc/easy-llm-proxy/config.json | 配置文件 |
| `STATS_FILE` | /var/lib/easy-llm-proxy/stats.json | 统计持久化 |
| `TIMEOUT_MS` | 120000 | 上游超时 |
| `ADMIN_TOKEN` | (空) | 管理 API 鉴权 token |