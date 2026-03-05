import { validateConfig } from './config.js';
import { startBot } from './bot.js';

try {
  validateConfig();
  await startBot();
} catch (err) {
  console.error('\n[fatal]', err.message);
  process.exit(1);
}
