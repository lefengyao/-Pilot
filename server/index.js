import 'dotenv/config';
import { createLanTerminalServer } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig(); const service = createLanTerminalServer({ config }); let closing = false;
async function shutdown(signal) { if (closing) return; closing = true; console.info(`收到 ${signal}，正在结束终端会话…`); await service.close(); }
process.on('SIGINT', () => shutdown('SIGINT')); process.on('SIGTERM', () => shutdown('SIGTERM'));
service.listen().then(() => console.info(`LAN Terminal 已监听 http://${config.host}:${config.port}`)).catch((error) => { console.error(error); process.exitCode = 1; });
