import * as McpClient from '@deepseek-ai/dsh-mcp-client';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const name = 'dsh-device-monitor';
export const inject = ['tools'];

const require = createRequire(import.meta.url);

export async function apply(ctx) {
  const config = McpClient.Config({
    transport: 'stdio',
    serverName: 'dsha-device-monitor',
    command: process.execPath,
    args: [fileURLToPath(new URL('./server.cjs', import.meta.url))],
    failOnStartupError: true,
    toolCallTimeoutMs: 120000,
    reconnect: { enabled: false },
  });
  let child;
  ctx.effect(function* () {
    child = ctx.plugin(McpClient, config);
    yield child.dispose;
  }, 'dsha-device-monitor-tools');
  await child.await();

  // 后台过热监控：随 harness 启动，随卸载停止。
  ctx.effect(() => {
    const core = require('./core.cjs');
    let monitor = null;
    try {
      monitor = core.startMonitor({});
    } catch (error) {
      ctx.logger?.warn?.('[dsh-device-monitor] 监控启动失败: ' + (error && error.message));
    }
    return () => { try { monitor?.stop(); } catch {} };
  }, 'dsha-device-monitor-daemon');
}
