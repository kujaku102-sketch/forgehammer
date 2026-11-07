// Worker Thread: Runs 1 GameOreUnit in high-speed loop.

const { parentPort, workerData } = require('worker_threads');
const { GameOreUnit } = require('./unit');

const { unitId, oreOutputPath } = workerData;
const unit = new GameOreUnit(unitId, oreOutputPath);

let active = true;
let winCount = 0;
let lastReportTime = Date.now();
let stepsSinceLastReport = 0;

// Listen for stop signal
parentPort.on('message', (msg) => {
  if (msg === 'STOP') {
    active = false;
  }
});

// High-speed run loop
function loop() {
  if (!active) return;

  const result = unit.runEpisode();
  stepsSinceLastReport += result.steps;
  if (result.won) winCount++;

  const now = Date.now();
  if (now - lastReportTime >= 200) {
    // Report metrics to parent every 200ms
    const elapsedSec = (now - lastReportTime) / 1000.0;
    const fps = Math.round(stepsSinceLastReport / elapsedSec);

    parentPort.postMessage({
      unitId,
      episodes: unit.episodesCompleted,
      totalSteps: unit.totalSteps,
      fps,
      winRate: (winCount / Math.max(1, unit.episodesCompleted)) * 100,
      meanAdv: result.meanAdv,
    });

    lastReportTime = now;
    stepsSinceLastReport = 0;
  }

  // Yield to avoid blocking event loop
  setImmediate(loop);
}

loop();
