// 16-Parallel Game + Ore Mining Swarm Client for Forgehammer
// Node.js worker_threads orchestrator with live ANSI telemetry.

const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');

const NUM_WORKERS = 16;
const ORE_DIR = path.resolve(__dirname, '../data/ore');

// Ensure output dir exists
if (!fs.existsSync(ORE_DIR)) {
  fs.mkdirSync(ORE_DIR, { recursive: true });
}

// ANSI Colors
const C_RESET = '\x1b[0m';
const C_BOLD = '\x1b[1m';
const C_CYAN = '\x1b[38;2;0;229;255m';
const C_FIRE = '\x1b[38;2;255;102;0m';
const C_GOLD = '\x1b[38;2;255;215;0m';
const C_GREEN = '\x1b[38;2;0;255;136m';
const C_RED = '\x1b[38;2;255;51;102m';
const C_DARK = '\x1b[38;2;80;80;100m';

// Hide cursor
process.stdout.write('\x1b[?25l\x1b[2J\x1b[H');

// Worker Telemetry state
const workers = [];
const stats = Array.from({ length: NUM_WORKERS }, (_, i) => ({
  unitId: i,
  episodes: 0,
  totalSteps: 0,
  fps: 0,
  winRate: 0.0,
  meanAdv: 0.0,
}));

const workerScript = path.resolve(__dirname, 'worker_thread.js');

for (let i = 0; i < NUM_WORKERS; i++) {
  const orePath = path.join(ORE_DIR, `ore_worker_${String(i).padStart(2, '0')}.bin`);
  // Remove existing file if starting fresh
  if (fs.existsSync(orePath)) {
    fs.unlinkSync(orePath);
  }

  const worker = new Worker(workerScript, {
    workerData: {
      unitId: i,
      oreOutputPath: orePath,
    },
  });

  worker.on('message', (msg) => {
    stats[msg.unitId] = msg;
  });

  workers.push(worker);
}

const startTime = Date.now();

// Render loop at 10 FPS
const renderInterval = setInterval(() => {
  let totalSteps = 0;
  let totalEpisodes = 0;
  let totalFps = 0;
  let avgWinRate = 0;

  for (const s of stats) {
    totalSteps += s.totalSteps;
    totalEpisodes += s.episodes;
    totalFps += s.fps;
    avgWinRate += s.winRate;
  }
  avgWinRate /= NUM_WORKERS;

  const elapsedSec = (Date.now() - startTime) / 1000.0;

  let out = '\x1b[H'; // Home

  out += `${C_BOLD}${C_FIRE}╔══════════════════════════════════════════════════════════════════════════════════════════════════╗${C_RESET}\n`;
  out += `${C_BOLD}${C_GOLD}║  ⚡ FORGEHAMMER 16-PARALLEL ORE SWARM CLIENT ⚡               [Workers: 16 Active]               ║${C_RESET}\n`;
  out += `${C_BOLD}${C_FIRE}╠══════════════════════════════════════════════════════════════════════════════════════════════════╣${C_RESET}\n`;

  out += `║  ${C_BOLD}Total Steps:${C_RESET} ${C_CYAN}${totalSteps.toLocaleString().padStart(10)}${C_RESET}  │  ${C_BOLD}Episodes:${C_RESET} ${C_GREEN}${totalEpisodes.toLocaleString().padStart(8)}${C_RESET}  │  ${C_BOLD}Total Swarm Speed:${C_RESET} ${C_GOLD}${totalFps.toLocaleString().padStart(7)} steps/sec${C_RESET} ║\n`;
  out += `║  ${C_BOLD}Avg Win Rate:${C_RESET} ${avgWinRate >= 50 ? C_GREEN : C_RED}${avgWinRate.toFixed(1).padStart(5)}%${C_RESET}     │  ${C_BOLD}Elapsed:${C_RESET}  ${elapsedSec.toFixed(1).padStart(7)}s   │  ${C_BOLD}Ore Files:${C_RESET}        ${C_CYAN}${NUM_WORKERS} .bin streams${C_RESET}      ║\n`;

  out += `${C_BOLD}${C_FIRE}╠══════════════════════════════════════════════════════════════════════════════════════════════════╣${C_RESET}\n`;
  out += `║  ${C_DARK}ID │ Status │ Episodes │    Steps │     FPS │ Win% │ Mean GAE Adv${C_RESET}                                ║\n`;
  out += `╟─────┼────────┼──────────┼──────────┼─────────┼──────┼─────────────────────────────────────────────╢\n`;

  // Display 16 worker lines
  for (let i = 0; i < NUM_WORKERS; i++) {
    const s = stats[i];
    const advStr = s.meanAdv >= 0 ? `${C_GREEN}+${s.meanAdv.toFixed(2)}${C_RESET}` : `${C_RED}${s.meanAdv.toFixed(2)}${C_RESET}`;
    const idStr = String(s.unitId).padStart(2, '0');
    const barLen = Math.min(15, Math.max(0, Math.round((s.fps / 2000) * 15)));
    const fpsBar = `${C_CYAN}${'■'.repeat(barLen)}${C_DARK}${'░'.repeat(15 - barLen)}${C_RESET}`;

    out += `║ #${idStr} │ ${C_GREEN}MINING${C_RESET} │ ${String(s.episodes).padStart(8)} │ ${String(s.totalSteps).padStart(8)} │ ${String(s.fps).padStart(5)}/s │ ${s.winRate.toFixed(0).padStart(3)}% │ ${advStr.padStart(6)} [${fpsBar}] ║\n`;
  }

  out += `${C_BOLD}${C_FIRE}╚══════════════════════════════════════════════════════════════════════════════════════════════════╝${C_RESET}\n`;
  out += `  ${C_BOLD}[INFO]${C_RESET} Streaming raw ore chunks to ${C_CYAN}packages/ore-swarm/data/ore/*.bin${C_RESET} | Press ${C_BOLD}Ctrl+C${C_RESET} to stop.\n`;

  process.stdout.write(out);
}, 100);

// Graceful shutdown
function shutdown() {
  clearInterval(renderInterval);
  for (const w of workers) {
    w.postMessage('STOP');
    w.terminate();
  }
  // Show cursor
  process.stdout.write('\x1b[?25h\x1b[0m\n\n');
  console.log(`${C_GOLD}⚡ Swarm stopped cleanly.${C_RESET} All 16 ore binary streams saved.`);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
