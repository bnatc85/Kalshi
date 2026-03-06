import fs from 'fs';
const k = fs.readFileSync('/tmp/new.pem', 'utf8').trim();
const env = [
  'KALSHI_API_KEY=56aac349-aa91-4213-a001-e634c10a61e3',
  'KALSHI_PRIVATE_KEY="' + k + '"',
  '',
  'DRY_RUN=false',
  'MIN_DIVERGENCE_BPS=300',
  'MIN_IRR=20',
  'POSITION_SIZE_USD=5',
  'MAX_OPEN_POSITIONS=1',
  'POLL_INTERVAL_SECONDS=60',
  'EXIT_CONVERGENCE_BPS=50',
  'DASHBOARD_PORT=3000',
].join('\n') + '\n';
fs.writeFileSync('.env', env);
console.log('ENV written OK');
console.log('Key type:', k.substring(0, 30));
