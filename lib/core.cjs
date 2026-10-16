'use strict';
/**
 * dsh-device-monitor —— 设备温度实时监控 + 内存占用分析（核心模块）
 *
 * 数据来源（全部走受保护的设备 shell，只读）：
 *   温度：dumpsys battery（电池，单位 0.1°C）+ /sys/class/thermal 下各 thermal_zone 的 temp（毫摄氏度）
 *   内存：/proc/meminfo + dumpsys meminfo（PSS 分段：按进程 / 按 OOM 分组 / 按类别）
 * 通知：DSHA 3090 桥 /app/notify + /app/vibrate
 */
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

const SHELL = '/root/dsh-bin/adb-shell';
const BRIDGE = 'http://127.0.0.1:3090';
const TOKEN_PATH = '/root/.dsh/.bridge_token';
const STATE_DIR = '/root/.dsha-device-monitor';

const STATUS_MAP = { 1: 'unknown', 2: 'charging', 3: 'discharging', 4: 'not-charging', 5: 'full' };
const HEALTH_MAP = { 1: 'unknown', 2: 'good', 3: 'overheat', 4: 'dead', 5: 'over-voltage', 6: 'failure', 7: 'cold' };

/* ---------------------------------------------------------------- 基础工具 */

function strip(raw) {
  return String(raw || '')
    .split('\n')
    .filter(line => !/^\[EXIT=\d+\]\s*$/.test(line.trim()))
    .join('\n')
    .trim();
}

/** 执行一条受策略约束的设备 shell 命令（单条、只读）。 */
function sh(command, timeout = 25000) {
  return new Promise(resolve => {
    execFile(SHELL, [command], { timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const out = strip(stdout);
      const err = strip(stderr);
      if (error && !out) return resolve({ ok: false, out: err || String(error.message || error), command });
      resolve({ ok: true, out: out || err, command });
    });
  });
}

async function bridge(route, params = {}, options = {}) {
  const method = options.method || 'GET';
  const timeout = options.timeout || 15000;
  const token = (await fsp.readFile(TOKEN_PATH, 'utf8')).trim();
  const headers = { 'X-Token': token };
  let url = BRIDGE + route;
  let body;
  if (method === 'GET') {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) query.set(key, String(value));
    if (query.size) url += '?' + query.toString();
  } else {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    body = JSON.stringify(params);
  }
  const response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeout) });
  const text = await response.text();
  if (!response.ok) throw new Error('BRIDGE_HTTP_' + response.status);
  try {
    const outer = JSON.parse(text);
    return typeof outer.result === 'string' ? outer.result : outer;
  } catch {
    return text;
  }
}

async function notify(title, text) {
  try {
    await bridge('/app/notify', { title, text });
    await bridge('/app/vibrate', { ms: 400 });
    return true;
  } catch {
    return false;
  }
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/* -------------------------------------------------------------------- 温度 */

const zoneCache = { names: [], types: [], at: 0 };

async function zoneNames(force) {
  if (!force && zoneCache.names.length && Date.now() - zoneCache.at < 3600e3) return zoneCache.names;
  const result = await sh('ls /sys/class/thermal');
  const names = strip(result.out)
    .split(/\s+/)
    .filter(name => /^thermal_zone\d+$/.test(name))
    .sort((a, b) => Number(a.slice(12)) - Number(b.slice(12)));
  zoneCache.names = names;
  zoneCache.at = Date.now();
  return names;
}

async function zoneTypes(names) {
  if (zoneCache.types.length === names.length) return zoneCache.types;
  const paths = names.map(name => '/sys/class/thermal/' + name + '/type');
  const types = [];
  for (const batch of chunk(paths, 40)) {
    const result = await sh('cat ' + batch.join(' '));
    types.push(...strip(result.out).split(/\s+/));
  }
  zoneCache.types = types;
  return types;
}

async function batteryInfo() {
  const result = await sh('dumpsys battery');
  const text = strip(result.out);
  const pick = pattern => { const m = text.match(pattern); return m ? Number(m[1]) : null; };
  const temperatureRaw = pick(/temperature:\s*(-?\d+)/);
  return {
    ok: result.ok,
    level: pick(/level:\s*(\d+)/),
    temperatureC: temperatureRaw === null ? null : temperatureRaw / 10,
    voltageMv: pick(/voltage:\s*(\d+)/),
    chargeCounterUah: pick(/Charge counter:\s*(-?\d+)/),
    statusCode: pick(/status:\s*(\d+)/),
    healthCode: pick(/health:\s*(\d+)/),
    acPowered: /AC powered:\s*true/.test(text),
    charging: /status:\s*(2|5)\b/.test(text),
    technology: (text.match(/technology:\s*(\S+)/) || [])[1] || null,
    raw: text,
  };
}

async function readTemps() {
  const names = await zoneNames();
  const paths = names.map(name => '/sys/class/thermal/' + name + '/temp');
  const values = [];
  for (const batch of chunk(paths, 40)) {
    const result = await sh('cat ' + batch.join(' '));
    values.push(...strip(result.out).split(/\s+/));
  }
  const types = await zoneTypes(names);
  const zones = [];
  names.forEach((id, index) => {
    const raw = Number(values[index]);
    if (!Number.isFinite(raw)) return;
    const celsius = raw / 1000;
    if (celsius < -50) return; // 0K 哨兵值：该热区未启用
    zones.push({ id, name: (types[index] || id).trim(), celsius: Math.round(celsius * 10) / 10 });
  });
  zones.sort((a, b) => b.celsius - a.celsius);
  const battery = await batteryInfo();
  return {
    at: Date.now(),
    battery,
    zones,
    hottest: zones.slice(0, 5),
    maxZone: zones[0] || null,
  };
}

/* -------------------------------------------------------------------- 内存 */

function parseMeminfo(text) {
  const lines = String(text).split('\n');
  const sections = {};
  let current = null;
  for (const line of lines) {
    if (/^[A-Za-z][A-Za-z0-9 /()_-]*:\s*$/.test(line)) { current = line.trim().replace(/:$/, ''); sections[current] = []; continue; }
    if (current && line.trim()) sections[current].push(line);
  }
  const parseEntries = (title, indentLimit) => {
    const out = [];
    for (const line of (sections[title] || [])) {
      const m = line.match(/^(\s*)([\d,]+)K:\s+(.+?)\s*$/);
      if (!m) continue;
      if (indentLimit !== undefined && m[1].length > indentLimit) continue;
      let name = m[3];
      let pid = null;
      const pidMatch = name.match(/\s+\(pid\s+(\d+)[^)]*\)\s*$/);
      if (pidMatch) { pid = Number(pidMatch[1]); name = name.slice(0, pidMatch.index).trim(); }
      out.push({ kb: Number(m[2].replace(/,/g, '')), name, pid });
    }
    return out;
  };
  const numeric = pattern => { const m = String(text).match(pattern); return m ? Number(m[1].replace(/,/g, '')) : null; };
  return {
    totalKb: numeric(/Total RAM:\s*([\d,]+)K/),
    freeKb: numeric(/Free RAM:\s*([\d,]+)K/),
    usedKb: numeric(/Used RAM:\s*([\d,]+)K/),
    lostKb: numeric(/Lost RAM:\s*([\d,]+)K/),
    zramPhysicalKb: numeric(/ZRAM:\s*([\d,]+)K physical/),
    zramSwapKb: numeric(/physical used for\s*([\d,]+)K in swap/),
    gpuKb: numeric(/GPU:\s*([\d,]+)K/),
    byProcess: parseEntries('Total PSS by process'),
    byOom: parseEntries('Total PSS by OOM adjustment', 4),
    byCategory: parseEntries('Total PSS by category'),
  };
}

const appLabelCache = { at: 0, labels: new Map() };

async function appLabels() {
  if (appLabelCache.labels.size && Date.now() - appLabelCache.at < 600e3) return appLabelCache.labels;
  const labels = new Map();
  try {
    const text = await bridge('/app/apps');
    for (const line of String(text).split('\n')) {
      const m = line.match(/^([\w.]+)\t([^\t]+?)(?:\s+uid=\d+)?$/);
      if (m) labels.set(m[1], m[2]);
    }
  } catch { /* 拿不到标签就退回包名 */ }
  appLabelCache.labels = labels;
  appLabelCache.at = Date.now();
  return labels;
}

/** 内存总览 + 按应用聚合的占用排行。 */
async function readMemory(options = {}) {
  const topN = options.top || 15;
  const result = await sh('dumpsys meminfo', 40000);
  if (!result.ok || !/Total PSS by process/.test(result.out)) {
    return { ok: false, error: 'MEMINFO_UNAVAILABLE', detail: result.out.slice(0, 300) };
  }
  const parsed = parseMeminfo(result.out);
  const labels = await appLabels();
  const labelKeys = [...labels.keys()].sort((a, b) => b.length - a.length);
  const resolvePackage = name => {
    if (labels.has(name)) return name;
    const head = name.split(':')[0];
    if (labels.has(head)) return head;
    for (const key of labelKeys) {
      if (name === key || name.startsWith(key + ':') || name.startsWith(key + '.')) return key;
    }
    return head;
  };
  const byPackage = new Map();
  for (const proc of parsed.byProcess) {
    const pkg = resolvePackage(proc.name);
    const entry = byPackage.get(pkg) || { package: pkg, label: labels.get(pkg) || null, kb: 0, processes: [] };
    entry.kb += proc.kb;
    entry.processes.push({ name: proc.name, pid: proc.pid, kb: proc.kb });
    byPackage.set(pkg, entry);
  }
  const ranked = [...byPackage.values()].sort((a, b) => b.kb - a.kb);
  const apps = ranked.filter(entry => entry.label);
  const native = ranked.filter(entry => !entry.label);
  const categories = parsed.byCategory.slice(0, 16);
  const groups = parsed.byOom.slice(0, 12);
  return {
    ok: true,
    at: Date.now(),
    totals: {
      totalKb: parsed.totalKb,
      usedKb: parsed.usedKb,
      freeKb: parsed.freeKb,
      lostKb: parsed.lostKb,
      zramPhysicalKb: parsed.zramPhysicalKb,
      zramSwapKb: parsed.zramSwapKb,
      gpuKb: parsed.gpuKb,
    },
    apps: apps.slice(0, topN),
    appCount: apps.length,
    native: native.slice(0, topN),
    nativeCount: native.length,
    categories,
    groups,
    processes: parsed.byProcess.slice(0, topN),
  };
}

async function procMeminfo() {
  const result = await sh('cat /proc/meminfo');
  const map = {};
  for (const line of strip(result.out).split('\n')) {
    const m = line.match(/^(\S+):\s+(\d+) kB/);
    if (m) map[m[1]] = Number(m[2]);
  }
  return map;
}

/* ------------------------------------------------------------------ 守护 */

function ensureStateDir() {
  try { fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 }); } catch {}
}

function defaults() {
  return {
    intervalSec: 60,
    batteryWarnC: 40,
    batteryCritC: 43,
    zoneWarnC: 78,
    zoneCritC: 88,
    cooldownSec: 900,
  };
}

function loadConfig() {
  ensureStateDir();
  const file = STATE_DIR + '/config.json';
  const base = defaults();
  try { return { ...base, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { return base; }
}

function saveConfig(config) {
  ensureStateDir();
  fs.writeFileSync(STATE_DIR + '/config.json', JSON.stringify(config, null, 2), { mode: 0o600 });
}

async function sampleOnce(config) {
  const temps = await readTemps();
  const battery = temps.battery.temperatureC;
  const maxZone = temps.maxZone;
  const alerts = [];
  if (battery !== null && battery >= config.batteryCritC) alerts.push({ level: 'critical', kind: 'battery', celsius: battery, text: '电池温度 ' + battery + '°C，已超过危急阈值 ' + config.batteryCritC + '°C' });
  else if (battery !== null && battery >= config.batteryWarnC) alerts.push({ level: 'warn', kind: 'battery', celsius: battery, text: '电池温度 ' + battery + '°C，超过警戒阈值 ' + config.batteryWarnC + '°C' });
  if (maxZone) {
    if (maxZone.celsius >= config.zoneCritC) alerts.push({ level: 'critical', kind: 'zone', celsius: maxZone.celsius, name: maxZone.name, text: '芯片热区 ' + maxZone.name + ' 达 ' + maxZone.celsius + '°C，超过危急阈值 ' + config.zoneCritC + '°C' });
    else if (maxZone.celsius >= config.zoneWarnC) alerts.push({ level: 'warn', kind: 'zone', celsius: maxZone.celsius, name: maxZone.name, text: '芯片热区 ' + maxZone.name + ' 达 ' + maxZone.celsius + '°C，超过警戒阈值 ' + config.zoneWarnC + '°C' });
  }
  const sample = {
    at: temps.at,
    batteryC: battery,
    level: temps.battery.level,
    charging: temps.battery.charging,
    maxZoneC: maxZone ? maxZone.celsius : null,
    maxZoneName: maxZone ? maxZone.name : null,
    alerts: alerts.map(a => a.level + ':' + a.text),
  };
  try { fs.appendFileSync(STATE_DIR + '/temps.jsonl', JSON.stringify(sample) + '\n'); } catch {}
  try { fs.writeFileSync(STATE_DIR + '/state.json', JSON.stringify({ ...sample, zones: temps.zones.slice(0, 8) }, null, 2), { mode: 0o600 }); } catch {}
  return { sample, alerts };
}

function readRecentSamples(limit = 240) {
  try {
    const lines = fs.readFileSync(STATE_DIR + '/temps.jsonl', 'utf8').trim().split('\n');
    return lines.slice(-limit).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** 启动后台采样器（进程内定时器），返回 { stop, config }。阈值改动下一轮生效。 */
function startMonitor(options = {}) {
  ensureStateDir();
  saveConfig({ ...loadConfig(), ...options });
  const cooldownFile = STATE_DIR + '/cooldown.json';
  let cooldown = {};
  try { cooldown = JSON.parse(fs.readFileSync(cooldownFile, 'utf8')); } catch {}
  let timer = null;
  let running = true;
  const log = message => { try { process.stdout.write('[monitor] ' + message + '\n'); } catch {} };

  async function tick() {
    if (!running) return;
    const config = loadConfig();
    try {
      const { sample, alerts } = await sampleOnce(config);
      log(new Date(sample.at).toISOString() + ' battery=' + sample.batteryC + 'C maxZone=' + sample.maxZoneC + 'C(' + sample.maxZoneName + ') level=' + sample.level + '%');
      for (const alert of alerts) {
        const key = alert.kind + ':' + alert.level;
        if (Date.now() - (cooldown[key] || 0) < config.cooldownSec * 1000) continue;
        cooldown[key] = Date.now();
        fs.writeFileSync(cooldownFile, JSON.stringify(cooldown), { mode: 0o600 });
        const title = alert.level === 'critical' ? '设备过热 · 严重' : '设备温度偏高';
        await notify(title, alert.text);
        log('ALERT ' + alert.level + ' ' + alert.text);
      }
    } catch (error) {
      log('sample failed: ' + (error && error.message));
    } finally {
      if (running) {
        timer = setTimeout(tick, Math.max(10, config.intervalSec) * 1000);
        if (typeof timer.unref === 'function') timer.unref();
      }
    }
  }

  tick();
  const config0 = loadConfig();
  log('started interval=' + config0.intervalSec + 's battery warn/crit=' + config0.batteryWarnC + '/' + config0.batteryCritC + ' zone warn/crit=' + config0.zoneWarnC + '/' + config0.zoneCritC);
  return {
    stop() { running = false; if (timer) clearTimeout(timer); log('stopped'); },
    get config() { return loadConfig(); },
    get running() { return running; },
  };
}

/** 前台守护进程模式：阻塞直到收到 SIGTERM/SIGINT。 */
async function runDaemon(options = {}) {
  const monitor = startMonitor(options);
  // 采样用的是 unref 定时器（为了不拖住宿主进程），前台守护需要自己保活。
  const keepAlive = setInterval(() => {}, 3600e3);
  await new Promise(resolve => {
    const stop = () => resolve();
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  });
  clearInterval(keepAlive);
  monitor.stop();
}

/* ------------------------------------------------------------------ 报表 */

function fmtGb(kb) { return (kb / 1048576).toFixed(2) + ' GB'; }

function renderReport(memory, temps) {
  const rows = (memory.apps || []).map((app, index) => '<tr><td>' + (index + 1) + '</td><td>' + (app.label || app.package) + '</td><td><code>' + app.package + '</code></td><td>' + fmtGb(app.kb) + '</td><td>' + app.processes.length + '</td></tr>').join('');
  const zoneRows = (temps ? temps.zones.slice(0, 12) : []).map(zone => '<tr><td>' + zone.name + '</td><td>' + zone.celsius + ' °C</td></tr>').join('');
  const samples = readRecentSamples(180);
  const batterySeries = samples.filter(s => typeof s.batteryC === 'number');
  const zoneSeries = samples.filter(s => typeof s.maxZoneC === 'number');
  const spark = (points, key, color) => {
    if (points.length < 2) return '<p class="dim">样本不足，再等几分钟</p>';
    const values = points.map(p => p[key]);
    const min = Math.min(...values), max = Math.max(...values);
    const span = max - min || 1;
    const path = points.map((p, index) => {
      const x = (index / (points.length - 1)) * 600;
      const y = 130 - ((p[key] - min) / span) * 110 - 6;
      return (index ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    }).join(' ');
    return '<svg viewBox="0 0 600 140" class="chart"><path d="' + path + '" fill="none" stroke="' + color + '" stroke-width="2.5"/><text x="4" y="14" class="axis">' + max + ' °C</text><text x="4" y="136" class="axis">' + min + ' °C</text></svg>';
  };
  const battery = temps ? temps.battery : null;
  return '<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>设备温度与内存</title><style>' +
    'body{font:14px/1.6 system-ui,-apple-system,"PingFang SC",sans-serif;margin:0;padding:18px;background:#0f1115;color:#e8eaed}' +
    'h1{font-size:19px;margin:0 0 4px}h2{font-size:15px;margin:24px 0 8px;color:#9aa0a6}' +
    '.dim{color:#9aa0a6}.card{background:#171a21;border:1px solid #232833;border-radius:12px;padding:14px;margin:10px 0}' +
    '.metric{display:inline-block;margin:6px 18px 6px 0}.metric b{font-size:22px;display:block}' +
    'table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:5px 8px;border-bottom:1px solid #232833;font-size:13px}' +
    'th{color:#9aa0a6;font-weight:500}code{color:#8ab4f8}.chart{width:100%;height:140px}' +
    '.axis{fill:#5f6368;font-size:11px}</style></head><body>' +
    '<h1>设备温度与内存</h1><p class="dim">生成于 ' + new Date().toLocaleString('zh-CN') + ' · 数据来自设备 shell（只读）</p>' +
    '<div class="card"><div class="metric"><span class="dim">电池温度</span><b>' + (battery && battery.temperatureC !== null ? battery.temperatureC + ' °C' : '—') + '</b></div>' +
    '<div class="metric"><span class="dim">最热热区</span><b>' + (temps && temps.maxZone ? temps.maxZone.celsius + ' °C' : '—') + '</b><span class="dim">' + (temps && temps.maxZone ? temps.maxZone.name : '') + '</span></div>' +
    '<div class="metric"><span class="dim">电量</span><b>' + (battery && battery.level !== null ? battery.level + '%' : '—') + '</b><span class="dim">' + (battery ? (battery.charging ? '充电中' : (STATUS_MAP[battery.statusCode] || '')) : '') + '</span></div></div>' +
    '<h2>内存总览</h2><div class="card"><div class="metric"><span class="dim">总内存</span><b>' + fmtGb(memory.totals.totalKb || 0) + '</b></div>' +
    '<div class="metric"><span class="dim">已用</span><b>' + fmtGb(memory.totals.usedKb || 0) + '</b></div>' +
    '<div class="metric"><span class="dim">空闲</span><b>' + fmtGb(memory.totals.freeKb || 0) + '</b></div>' +
    '<div class="metric"><span class="dim">ZRAM 实占</span><b>' + fmtGb(memory.totals.zramPhysicalKb || 0) + '</b></div></div>' +
    '<h2>占用最多的应用</h2><div class="card"><table><tr><th>#</th><th>应用</th><th>包名</th><th>PSS</th><th>进程</th></tr>' + rows + '</table></div>' +
    '<h2>内存去哪了（按类别）</h2><div class="card"><table>' + (memory.categories || []).map(c => '<tr><td>' + c.name + '</td><td>' + fmtGb(c.kb) + '</td></tr>').join('') + '</table></div>' +
    '<h2>温度热区</h2><div class="card"><table>' + zoneRows + '</table></div>' +
    '<h2>温度趋势</h2><div class="card"><p class="dim">电池温度</p>' + spark(batterySeries, 'batteryC', '#8ab4f8') + '<p class="dim">最热热区</p>' + spark(zoneSeries, 'maxZoneC', '#f28b82') + '</div>' +
    '</body></html>';
}

module.exports = {
  sh, bridge, notify, strip, chunk,
  batteryInfo, readTemps, zoneNames,
  readMemory, parseMeminfo, procMeminfo, appLabels,
  loadConfig, saveConfig, defaults, sampleOnce, readRecentSamples, runDaemon, startMonitor,
  renderReport, fmtGb, STATE_DIR, STATUS_MAP, HEALTH_MAP,
};
