'use strict';
/**
 * dsh-device-monitor —— MCP stdio 服务：把设备温度/内存能力暴露成 Agent 工具。
 */
const fs = require('node:fs');
const path = require('node:path');
const core = require('./core.cjs');

const definitions = [
  ['device_temp', '读取设备当前温度：电池温度 + 最热芯片热区（数据来自设备 shell，只读）。', {
    top: { type: 'integer', minimum: 1, maximum: 30, description: '返回多少个最热热区，默认 8' },
  }],
  ['device_memory', '读取内存占用：总量/已用/空闲/ZRAM、占用最多的应用（PSS 聚合到包名）、内存类别分布。', {
    top: { type: 'integer', minimum: 1, maximum: 40, description: '返回多少个应用，默认 15' },
  }],
  ['device_monitor', '控制过热监控：status 看当前状态、start/stop 启停、config 改阈值、report 生成 HTML 报表。', {
    op: { type: 'string', enum: ['status', 'start', 'stop', 'config', 'report'], description: '操作类型' },
    intervalSec: { type: 'integer', minimum: 10, maximum: 3600 },
    batteryWarnC: { type: 'number', minimum: 30, maximum: 60 },
    batteryCritC: { type: 'number', minimum: 30, maximum: 70 },
    zoneWarnC: { type: 'number', minimum: 50, maximum: 110 },
    zoneCritC: { type: 'number', minimum: 50, maximum: 120 },
    cooldownSec: { type: 'integer', minimum: 60, maximum: 86400 },
  }],
];

const tools = definitions.map(([name, description, properties]) => ({
  name,
  description,
  inputSchema: { type: 'object', properties, required: name === 'device_monitor' ? ['op'] : [], additionalProperties: false },
}));

let activeMonitor = null;

function tempText(snapshot) {
  const lines = [];
  lines.push('电池温度: ' + (snapshot.battery.temperatureC === null ? '未知' : snapshot.battery.temperatureC + ' °C'));
  lines.push('电量: ' + snapshot.battery.level + '% (' + (core.STATUS_MAP[snapshot.battery.statusCode] || '?') + (snapshot.battery.charging ? ', 充电中' : '') + '), 电池健康: ' + (core.HEALTH_MAP[snapshot.battery.healthCode] || '?'));
  lines.push('有效热区: ' + snapshot.zones.length + ' 个');
  lines.push('最热热区:');
  for (const zone of snapshot.hottest) lines.push('  ' + zone.celsius + ' °C  ' + zone.name + ' (' + zone.id + ')');
  return lines.join('\n');
}

async function call(name, args = {}) {
  if (name === 'device_temp') {
    const snapshot = await core.readTemps();
    return { content: [{ type: 'text', text: tempText(snapshot) + '\n\n最热 ' + Math.min(args.top || 8, 30) + ' 个:\n' + snapshot.zones.slice(0, args.top || 8).map(z => '  ' + z.celsius + ' °C  ' + z.name).join('\n') }] };
  }
  if (name === 'device_memory') {
    const top = args.top || 15;
    const memory = await core.readMemory({ top });
    if (!memory.ok) return { content: [{ type: 'text', text: '内存读取失败: ' + memory.error }], isError: true };
    const lines = [];
    lines.push('总内存 ' + core.fmtGb(memory.totals.totalKb) + ' | 已用 ' + core.fmtGb(memory.totals.usedKb) + ' | 空闲 ' + core.fmtGb(memory.totals.freeKb) + ' | Lost ' + core.fmtGb(memory.totals.lostKb) + ' | ZRAM 实占 ' + core.fmtGb(memory.totals.zramPhysicalKb));
    lines.push('');
    lines.push('占用最多的应用（PSS 聚合到包名，共 ' + memory.appCount + ' 个）:');
    memory.apps.forEach((app, index) => {
      lines.push('  ' + String(index + 1).padStart(2) + '. ' + core.fmtGb(app.kb).padStart(8) + '  ' + (app.label || app.package) + ' [' + app.package + '] ' + app.processes.length + ' 进程');
    });
    lines.push('');
    lines.push('系统/原生进程（共 ' + memory.nativeCount + ' 个，前 8）:');
    memory.native.slice(0, 8).forEach(entry => lines.push('  ' + core.fmtGb(entry.kb).padStart(8) + '  ' + entry.package));
    lines.push('');
    lines.push('内存去哪了（按类别）:');
    memory.categories.slice(0, 10).forEach(category => lines.push('  ' + core.fmtGb(category.kb).padStart(8) + '  ' + category.name));
    lines.push('');
    lines.push('按 OOM 分组: ' + memory.groups.slice(0, 6).map(group => group.name + '=' + core.fmtGb(group.kb)).join(', '));
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
  if (name === 'device_monitor') {
    const op = args.op;
    if (op === 'start') {
      if (activeMonitor && activeMonitor.running) return { content: [{ type: 'text', text: '监控已在运行；配置: ' + JSON.stringify(activeMonitor.config) }] };
      const overrides = {};
      for (const key of ['intervalSec', 'batteryWarnC', 'batteryCritC', 'zoneWarnC', 'zoneCritC', 'cooldownSec']) if (args[key] !== undefined) overrides[key] = args[key];
      activeMonitor = core.startMonitor(overrides);
      return { content: [{ type: 'text', text: '监控已启动: ' + JSON.stringify(activeMonitor.config) }] };
    }
    if (op === 'stop') {
      if (activeMonitor) { activeMonitor.stop(); activeMonitor = null; return { content: [{ type: 'text', text: '监控已停止' }] }; }
      return { content: [{ type: 'text', text: '监控未在运行' }] };
    }
    if (op === 'config') {
      const overrides = {};
      for (const key of ['intervalSec', 'batteryWarnC', 'batteryCritC', 'zoneWarnC', 'zoneCritC', 'cooldownSec']) if (args[key] !== undefined) overrides[key] = args[key];
      const config = { ...core.loadConfig(), ...overrides };
      core.saveConfig(config);
      return { content: [{ type: 'text', text: '当前配置: ' + JSON.stringify(config) }] };
    }
    if (op === 'report') {
      const [memory, temps] = await Promise.all([core.readMemory({ top: 20 }), core.readTemps()]);
      if (!memory.ok) return { content: [{ type: 'text', text: '内存读取失败: ' + memory.error }], isError: true };
      const file = core.STATE_DIR + '/report.html';
      fs.writeFileSync(file, core.renderReport(memory, temps), { mode: 0o600 });
      return { content: [{ type: 'text', text: '报表已生成: ' + file }] };
    }
    const samples = core.readRecentSamples(20);
    const last = samples[samples.length - 1] || null;
    const text = [
      '监控运行中: ' + Boolean(activeMonitor && activeMonitor.running),
      '配置: ' + JSON.stringify(core.loadConfig()),
      '样本数: ' + core.readRecentSamples(100000).length,
      '最近一次: ' + (last ? new Date(last.at).toLocaleString('zh-CN') + ' 电池 ' + last.batteryC + '°C / 最热热区 ' + last.maxZoneC + '°C (' + last.maxZoneName + ') / 电量 ' + last.level + '%' : '暂无'),
      '最近告警: ' + (samples.flatMap(s => s.alerts).slice(-5).join(' ; ') || '无'),
    ].join('\n');
    return { content: [{ type: 'text', text }] };
  }
  throw new Error('UNKNOWN_TOOL');
}

/* ------------------------------------------------------- MCP stdio 协议 */

function start() {
  let buffer = '';
  const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  let queue = Promise.resolve();
  let ended = false;

  async function receive(message) {
    const { id, method, params = {} } = message;
    if (id === undefined) return;
    if (ended) { send({ id, error: { code: -32800, message: 'Request cancelled' } }); return; }
    try {
      let result;
      if (method === 'initialize') {
        result = {
          protocolVersion: params.protocolVersion || '2025-03-26',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'DSHA Device Monitor', version: '1.0.0' },
          instructions: '温度与内存均通过受保护的设备 shell 只读采集。device_monitor 的 start 会在服务进程内启动过热采样与通知。',
        };
      } else if (method === 'ping') result = {};
      else if (method === 'tools/list') result = { tools };
      else if (method === 'tools/call') result = await call(params.name, params.arguments || {});
      else { send({ id, error: { code: -32601, message: 'Method not found' } }); return; }
      send({ id, result });
    } catch (error) {
      send({ id, result: { content: [{ type: 'text', text: '设备监控不可用: ' + ((error && error.message) || 'OPERATION_UNAVAILABLE') }], isError: true } });
    }
  }

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 1024 * 1024) process.exit(1);
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let value;
      try { value = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
      queue = queue.then(() => receive(value)).catch(() => {});
    }
  });
  process.stdin.on('end', () => { ended = true; });
  process.stdout.on('error', error => { if (error.code === 'EPIPE') process.exit(0); });
}

if (require.main === module) start();
module.exports = { definitions, tools, call, start };
