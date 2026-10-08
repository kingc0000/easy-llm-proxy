#!/usr/bin/env node
/* easy-llm-proxy 入口 */
'use strict';
// 启动时若 auth.json 不存在且提供 AUTH_USER/AUTH_PASS 则自动创建(不覆盖已有账号)
require('../src/auth').init(process.env.AUTH_USER, process.env.AUTH_PASS);
require('../src/server').start();
