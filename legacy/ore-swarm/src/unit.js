// GameOreUnit: 1 Package of (Game Instance + Pilot CPU + Flight Clerk)
// Self-contained loop runner.

const { FlightClerk } = require('./clerk');
const { PilotCPU } = require('./cpu');
const { MockCardGame } = require('./mock_game');

class GameOreUnit {
  /**
   * @param {number} unitId 
   * @param {string} oreOutputPath 
   */
  constructor(unitId, oreOutputPath) {
    this.unitId = unitId;
    this.oreOutputPath = oreOutputPath;

    // The Triad: Game + CPU + Clerk
    this.game = new MockCardGame();
    this.cpu = new PilotCPU(this.game.featN, this.game.actN, 0.15);
    this.clerk = new FlightClerk(this.game.featN, 100);

    this.episodesCompleted = 0;
    this.totalSteps = 0;
  }

  /**
   * Run a single episode.
   * Zero GC allocations in the hot loop.
   * @returns {{ steps: number, meanAdv: number, won: boolean }}
   */
  runEpisode() {
    this.clerk.resetEpisode();
    let state = this.game.reset();
    let done = false;
    let epSteps = 0;

    while (!done) {
      // 1. CPU decides action
      const { action, value } = this.cpu.decide(state);

      // 2. Step the game
      const res = this.game.step(action);

      // 3. Clerk records the transition
      this.clerk.recordStep(state, action, value, res.reward);

      state = res.nextState;
      done = res.done;
      epSteps++;
    }

    // 4. Finalize episode GAE
    const meanAdv = this.clerk.finalizeEpisode(0.99, 0.95);

    // 5. Flush to binary ore file
    if (this.oreOutputPath) {
      this.clerk.flushToFile(this.oreOutputPath);
    }

    this.episodesCompleted++;
    this.totalSteps += epSteps;

    return {
      steps: epSteps,
      meanAdv,
      won: this.game.enemyHp <= 0,
    };
  }
}

module.exports = { GameOreUnit };
