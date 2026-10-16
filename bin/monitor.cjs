#!/usr/bin/env node
'use strict';
/**
 * dsh-device-monitor 命令行入口
 *   node bin/monitor.cjs temp [--top 8]
 *   node bin/monitor.cjs mem  [--top 15]
 *   node bin/monitor.cjs report          # 生成 HTML 报表
 *   node bin/monitor.cjs status
 *   node bin/monitor.cjs daemon [--interval 60] [--bat-warn 40] [--bat-crit 43] [--zone-warn 78] [--zone-crit 88]
 */
const fs = require('node:fs');
const core = require('../lib/core.cjs');

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const [key, inline] = token.slice(2).split('=');
      const value = inline !== undefined ? inline : argv[i + 1];
      if (inline === undefined) i++;
      out[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = Number.isNaN(Number(value)) ? value : Number(value);
    }
  }
  return out;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = flags(rest);

  if (command === 'temp') {
    const snapshot = await core.readTemps();
    const battery = snapshot.battery;
    console.log('电池温度  ' + (battery.temperatureC === null ? '未知' : battery.temperatureC + ' °C') +
      '   电量 ' + battery.level + '%  ' + (core.STATUS_MAP[battery.statusCode] || '') + (battery.charging ? ' 充电中' : '') +
      '   健康 ' + (core.HEALTH_MAP[battery.healthCode] || '?'));
    console.log('热区共 ' + snapshot.zones.length + ' 个，最热 ' + (options.top || 8) + ' 个：');
    for (const zone of snapshot.zones.slice(0, options.top || 8)) console.log('  ' + String(zone.celsius).padStart(6) + ' °C  ' + zone.name + '  (' + zone.id + ')');
    return;
  }

  if (command === 'mem') {
    const memory = await core.readMemory({ top: options.top || 15 });
    if (!memory.ok) { console.error('内存读取失败: ' + memory.error + ' ' + (memory.detail || '')); process.exit(1); }
    console.log('总 ' + core.fmtGb(memory.totals.totalKb) + '  已用 ' + core.fmtGb(memory.totals.usedKb) + '  空闲 ' + core.fmtGb(memory.totals.freeKb) +
      '  Lost ' + core.fmtGb(memory.totals.lostKb) + '  ZRAM 实占 ' + core.fmtGb(memory.totals.zramPhysicalKb));
    console.log('\n占用最多的应用（' + memory.appCount + ' 个）：');
    memory.apps.forEach((app, index) => console.log('  ' + String(index + 1).padStart(2) + '. ' + core.fmtGb(app.kb).padStart(9) + '  ' + (app.label || '') + '  [' + app.package + '] ' + app.processes.length + ' 进程'));
    console.log('\n系统/原生进程（' + memory.nativeCount + ' 个，前 10）：');
    memory.native.slice(0, 10).forEach(entry => console.log('      ' + core.fmtGb(entry.kb).padStart(9) + '  ' + entry.package));
    console.log('\n内存类别：');
    memory.categories.slice(0, 12).forEach(category => console.log('      ' + core.fmtGb(category.kb).padStart(9) + '  ' + category.name));
    console.log('\nOOM 分组：' + memory.groups.slice(0, 8).map(group => group.name + '=' + core.fmtGb(group.kb)).join(', '));
    return;
  }

  if (command === 'report') {
    const [memory, temps] = await Promise.all([core.readMemory({ top: 20 }), core.readTemps()]);
    if (!memory.ok) { console.error('内存读取失败: ' + memory.error); process.exit(1); }
    const file = (options.out ? String(options.out) : core.STATE_DIR + '/report.html');
    fs.mkdirSync(require('node:path').dirname(file), { recursive: true });
    fs.writeFileSync(file, core.renderReport(memory, temps), { mode: 0o600 });
    console.log('报表已生成: ' + file);
    return;
  }

  if (command === 'status') {
    const samples = core.readRecentSamples(20);
    const last = samples[samples.length - 1];
    console.log('配置: ' + JSON.stringify(core.loadConfig()));
    console.log('样本总数: ' + core.readRecentSamples(1000000).length);
    console.log('最近一次: ' + (last ? new Date(last.at).toLocaleString('zh-CN') + ' 电池 ' + last.batteryC + '°C / 最热热区 ' + last.maxZoneC + '°C (' + last.maxZoneName + ')' : '暂无'));
    console.log('最近告警: ' + (samples.flatMap(s => s.alerts).slice(-5).join(' ; ') || '无'));
    return;
  }

  if (command === 'daemon') {
    await core.runDaemon({
      intervalSec: options.interval || 60,
      batteryWarnC: options.batWarn || 40,
      batteryCritC: options.batCrit || 43,
      zoneWarnC: options.zoneWarn || 78,
      zoneCritC: options.zoneCrit || 88,
    });
    return;
  }

  console.log('用法: monitor.cjs <temp|mem|report|status|daemon> [--top N] [--interval 秒]');
}

main().catch(error => { console.error(String((error && error.stack) || error)); process.exit(1); });
