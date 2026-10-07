# ⚡ easy-llm-proxy

通用 LLM Provider **多 Key 多 Model 加权轮询代理** + **Web 管理面板** · 零第三方依赖 · 单文件可部署

一个独立的 LLM 代理服务：把多家大模型供应商（OpenAI 兼容 / Anthropic 原生）统一成一个 OpenAI 兼容端点，内置**按权重降级、多 Key 自动轮换、限流切回、真实 Token 统计、完整调用日志**等能力。任何支持 OpenAI 兼容接口的 agent / 客户端（dsh、ChatBox、LobeChat、One-API 等）填入 `base_url` 即可使用。

```
Agent / 客户端 ──(OpenAI 兼容)──▶ easy-llm-proxy ──▶ OpenAI 兼容上游 (DeepSeek/通义/Kimi/商汤…)
     Web 面板 ◀──(登录保护)──    │ 多 Provider × 多 Key × 多 Model 加权轮询
                                 └──▶ Anthropic 原生上游 (Claude 等, 自动协议转换)
```

## ✨ 核心特性

| 能力 | 说明 |
| --- | --- |
| 🎯 **加权轮询引擎** | 每 provider 可配多 model，model 配置权重(1-100) 与任意数量 key；主 model 限流 → 换下一个 key → 全部 key 限流 → 按权重降级（100→99→97…，同权重兄弟优先）|
| 🔄 **自动切回** | 降级期间达到 **成功次数**(usageLimit) 或 **时长**(useSeconds) 任一上限 → 自动切回权重最高的主 model；次数按 **2xx 成功返回**计数 |
| 🔑 **多 Key 轮询** | 每 model 多个 key 平滑分摊（并发公平，游标预占）；429/5xx/网络错误自动换 key |
| 🌐 **协议归一化** | `openai`（默认）与 `anthropic`（原生 `/v1/messages` + `x-api-key`）provider 混用；Anthropic 自动做请求体/非流式/流式 SSE 双向转换，**客户端无感**，全程 OpenAI 兼容 |
| 🔐 **登录认证** | Web 面板登录页（用户名/密码，scrypt 哈希存储、会话 Token、失败锁定），支持**修改用户名/密码**；管理 API 统一鉴权 |
| 📊 **真实 Token 统计** | 请求 Token / 缓存命中 Token / 输出 Token（OpenAI 与 Anthropic 均真实解析，非字节估算）；请求/成功/重试/降级/耗时聚合 + 小时/日趋势 + 错误类型分布 |
| 📜 **调用日志** | 每条调用完整记录：**原始请求 + 原始返回（含流式 SSE 原文）+ 错误信息**，按天落盘、面板可查、自动清理 |
| 💻 **Web 管理面板** | 浏览器可视化配置 Provider/Model/权重/Key、一键测试连接、查看统计与调用记录，免改配置文件 |
| ⚡ **轻量** | 纯 Node 标准库（`http/https/crypto`），**零第三方依赖**，无 node_modules；空闲 RSS ≈ 50MB，CPU 0% |
| 🔄 **热加载 / 兼容迁移** | 改配置即时生效；旧 sensenova-proxy 配置自动转换加载 |

## 🚀 快速开始

### 方式一：直接运行（开发/测试）

```bash
git clone https://github.com/kingc0000/easy-llm-proxy.git
cd easy-llm-proxy
npm start            # 默认 http://127.0.0.1:8787
npm test             # 单元测试
```

### 方式二：systemd 服务（生产推荐）

```bash
./deploy.sh 8790     # 安装 systemd unit 并启动(默认账号 admin/admin123,可用 AUTH_USER/AUTH_PASS 覆盖)
# 浏览器打开 http://127.0.0.1:8790/ 登录后到 Web 面板添加 provider
```

### 方式三：Docker

```bash
./deploy-docker.sh 8790          # 构建镜像 + 一键启动(端口 8790)
# 或自定义:
PROXY_PUBLIC_PORT=8790 ADMIN_TOKEN=你的管理令牌 docker compose up -d --build
```

登录默认账号：**`admin / admin123`**（仅首次创建时生效，可用 `AUTH_USER / AUTH_PASS` 环境变量覆盖；已存在 `auth.json` 时永不覆盖，生产环境请务必修改默认密码）。

## 🧩 客户端接入

任何 OpenAI 兼容客户端：

```
base_url:  http://127.0.0.1:8790/v1
api_key:   任意值(代理使用服务端配置的多 Key,客户端 Key 被忽略)
model:     任意配置中的 model id(自动按权重调度/降级)
```

> 用 `X-Provider-Name: 名称` 请求头可强制指定某 provider；未配置的 model 验证透传原 id + 主 Key 池（不跨 model 降级）。

## ⚙️ 配置

### 配置文件 `/etc/easy-llm-proxy/config.json`（或 `CONFIG_FILE` 指定）

```jsonc
{
  "defaultProvider": "mix",
  "providers": [
    {
      "name": "mix",                        // 唯一标识;X-Provider-Name 使用
      "apiType": "openai",                  // openai | anthropic
      "baseURL": "https://api.example.com", // 上游地址
      "apiPath": "",                        // 可选,自定义 chat 路径(留空自动)
      "apiKeyHeader": "",                   // 可选,自定义认证头(留空自动)
      "extraHeaders": {},                   // 可选,如 {"anthropic-version":"2023-06-01"}
      "usageLimit": 5,                      // 降级后成功几次切回主 model(0=不限)
      "useSeconds": 10,                     // 降级后几秒切回主 model(0=不限)
      "models": [
        { "id": "deepseek-chat", "weight": 100,
          "keys": ["sk-主key1", "sk-主key2"] },
        { "id": "qwen-max", "weight": 99,
          "keys": ["sk-备用key"] }
      ]
    }
  ]
}
```

### 轮询与降级语义

- 主 model 全部 key 返回 429/5xx/网络错误 → 降级到**更低权重** model（同权重兄弟优先），不跳级
- 降级 model 成功次数 ≥ `usageLimit` **或** 时长 ≥ `useSeconds` 任一满足 → 切回主 model
- 所有 model 都失败 → 回到主 model 再做一轮（总尝试数上限防死循环）
- `weight` 越大越优先（1-100）；同 provider 同 model id 重复配置保留首个

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PROXY_PORT` | `8787` | 监听端口 |
| `BIND_HOST` | `127.0.0.1` | 监听地址（Docker 设 `0.0.0.0`）|
| `CONFIG_FILE` | `/etc/easy-llm-proxy/config.json` | 配置文件路径 |
| `STATS_FILE` | `/var/lib/easy-llm-proxy/stats.json` | 统计持久化路径 |
| `REQUESTS_DIR` | `/var/lib/easy-llm-proxy/requests` | 调用日志目录（按天 jsonl）|
| `REQUESTS_KEEP_DAYS` | `7` | 调用日志保留天数 |
| `REQUESTS_MAX_REC` | `524288` | 单条响应原文记录上限(字节) |
| `ADMIN_TOKEN` | 空 | 管理 API 备用钥匙（脚本/运维用，优先级低于登录会话）|
| `AUTH_USER` / `AUTH_PASS` | `admin` / `admin123` | 首次创建登录账号（已有 `auth.json` 不覆盖，生产请改默认密码）|
| `AUTH_FILE` | `/etc/easy-llm-proxy/auth.json` | 账号凭证文件（scrypt 哈希，600 权限）|
| `SESSION_HOURS` | `168` | 登录会话有效期(小时) |
| `TIMEOUT_MS` | `120000` | 上游请求超时(毫秒) |

## 🖥️ Web 管理面板

浏览器打开 `http://<主机>:<端口>/`，输入账号密码登录（失败 5 次锁 60s）。

| 页面 | 功能 |
| --- | --- |
| **Providers** | 卡片化查看/编辑 Provider、Model、Key、权重；一键测试连接（未保存也能测）|
| **统计** | 实时 KPI（请求/成功/失败/重试/降级/耗时/成功率）、三种真实 Token、24h 趋势图、错误类型分布、Provider/Key 明细、降级事件 |
| **记录** | 调用日志：按日期/模型/状态码/内容关键词查询，点击展开 **原始请求 + 原始返回（流式含完整 SSE）+ 错误信息** |
| **账号** | 右上角 ⚙ 修改用户名/密码（需旧密码，改后全部会话失效重新登录）|

## 🌐 公网部署（nginx 反代）

```nginx
server {
    listen 443 ssl;
    server_name llm.example.com;
    ssl_certificate     /etc/ssl/llm.example.com.crt;
    ssl_certificate_key /etc/ssl/llm.example.com.key;
    access_log off;                 # 防敏感信息落盘

    location / {
        proxy_pass http://127.0.0.1:8790;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;      # 流式对话必需
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
}
```

> ⚠️ 公网开放时：管理 API 已登录保护；`/v1` 代理接口默认公开（供客户端使用），如需访问控制可加 Basic Auth 或客户端 Key 白名单。

## 📂 项目结构

```
bin/start.js         入口
src/proxy.js         主服务(路由/处理链/鉴权)
src/config.js        配置加载与校验(mtime 热加载)
src/balance.js       加权轮询/降级/切回引擎
src/adapters.js      上游请求/协议转换/usage 提取
src/stats.js         统计聚合与持久化
src/requests.js      调用日志(原始请求/返回/错误)
src/auth.js          登录/会话/改密
web/                 Web 面板(纯静态)
test/                单元测试 + mock 上游
deploy.sh            一键 systemd 部署
deploy-docker.sh     Docker 一键部署
```

## 🧪 测试

```bash
npm test              # 权重轮询单元测试(11 例)
# 本地 mock 集成: node test/mock-upstream.js + mock-anthropic.js,再 curl 验证
```

## 📄 License

MIT