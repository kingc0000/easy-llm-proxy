#!/usr/bin/env node
/* 聚合测试运行器 */
'use strict';
(async () => {
  const files = ['./balance.test.js'];
  let allOk = true;
  for (const f of files) {
    console.log('▶', f);
    const mod = require(f);
    const ok = typeof mod === 'function' ? await mod() : await mod.run();
    if (!ok) allOk = false;
  }
  process.exit(allOk ? 0 : 1);
})();
