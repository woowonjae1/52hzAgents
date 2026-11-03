#!/usr/bin/env node
'use strict';

// Usage: node server/scripts/probe-agents.js [--versions] [--json]
// Read-only: detects clients and native config file presence. Never reads config
// contents, starts model turns, logs in or edits native configuration.

const { probeClients, CAPABILITY_KEYS } = require('../agents/capabilities');

const STATUS = { verified: '已验证', declared: '文档声明', unsupported: '不支持', unknown: '未知' };

(async () => {
  const args = new Set(process.argv.slice(2));
  const result = await probeClients({ versions: args.has('--versions') });
  if (args.has('--json')) return console.log(JSON.stringify(result, null, 2));
  const lines = [`探测时间：${result.probedAt}（${result.platform}）`, ''];
  lines.push('| 客户端 | 阶段 | 检测 | 版本 | 配置来源（存在 / 缺失） |', '| --- | --- | --- | --- | --- |');
  for (const c of result.clients) {
    const sources = c.configSources.map(s => `${s.id} ${s.exists ? '存在' : '缺失'}`).join('<br>') || '—';
    const detected = c.installation.bundled ? '随工作台打包' : c.installation.detected ? '已检测' : '未检测到';
    const version = c.installation.version || (c.installation.versionError ? `无法读取（${c.installation.versionError}）` : '—');
    lines.push(`| ${c.name} | ${c.stage} | ${detected} | ${version} | ${sources} |`);
  }
  lines.push('', `| 能力 | ${result.clients.map(c => c.name).join(' | ')} |`, `| --- |${result.clients.map(() => ' --- |').join('')}`);
  for (const key of CAPABILITY_KEYS) {
    lines.push(`| ${key} | ${result.clients.map(c => STATUS[c.capabilities[key].status]).join(' | ')} |`);
  }
  console.log(lines.join('\n'));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
