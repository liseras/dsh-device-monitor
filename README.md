# dsh-device-monitor

设备温度实时监控（过热通知）+ 运行内存占用分析。数据全部通过受保护的设备 shell 只读采集，
不依赖 root、不需要 ADB 配对（走当前已授权的 shell 通道）。

## 组件

| 文件 | 作用 |
|---|---|
| `lib/core.cjs` | 采集与守护核心：温度、内存解析、阈值告警、HTML 报表 |
| `lib/server.cjs` | MCP stdio 服务，暴露 `device_temp` / `device_memory` / `device_monitor` |
| `lib/index.js` | Cordis 插件外壳（随 harness 启动 MCP 服务 + 后台监控） |
| `bin/monitor.cjs` | 命令行入口 |

## 数据来源

- 电池温度：`dumpsys battery`（`temperature` 字段，单位 0.1°C）
- 芯片热区：`/sys/class/thermal/thermal_zone*/temp`（毫摄氏度，跳过 -273°C 的未启用哨兵值）
- 内存总量：`/proc/meminfo` + `dumpsys meminfo`（PSS 按进程 / 按 OOM 分组 / 按类别）
- 应用名：DSHA 3090 桥 `/app/apps`（包名 → 中文名）

## 命令行

```bash
node bin/monitor.cjs temp --top 8        # 当前温度
node bin/monitor.cjs mem  --top 15       # 内存总览 + 应用排行
node bin/monitor.cjs report              # 生成 HTML 报表（默认 /root/.dsha-device-monitor/report.html）
node bin/monitor.cjs status              # 监控状态与最近告警
node bin/monitor.cjs daemon --interval 60 # 前台守护：采样 + 过热通知
```

## 告警阈值（`/root/.dsha-device-monitor/config.json`）

```json
{ "intervalSec": 60, "batteryWarnC": 40, "batteryCritC": 43,
  "zoneWarnC": 78, "zoneCritC": 88, "cooldownSec": 900 }
```

超阈值时经 3090 桥发通知栏提醒 + 震动；同一类告警 15 分钟内不重复。

## 运行数据

- 采样历史：`/root/.dsha-device-monitor/temps.jsonl`
- 最近状态：`/root/.dsha-device-monitor/state.json`
- HTML 报表：`/root/.dsha-device-monitor/report.html`
