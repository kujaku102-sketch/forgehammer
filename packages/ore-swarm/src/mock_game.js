// Mock Card Battle Environment
// State: 8 features -> Action: 4 card choices

class MockCardGame {
  constructor() {
    this.featN = 8;
    this.actN = 4;
    this.features = new Float32Array(this.featN);
    this.reset();
  }

  reset() {
    this.playerHp = 20;
    this.playerMp = 10;
    this.enemyHp = 25;
    this.turn = 0;
    this.updateFeatures();
    return this.features;
  }

  updateFeatures() {
    this.features[0] = this.playerHp / 20.0;   // Player HP (0~1)
    this.features[1] = this.playerMp / 10.0;   // Player MP (0~1)
    this.features[2] = this.enemyHp / 25.0;    // Enemy HP (0~1)
    this.features[3] = (this.turn % 10) / 10.0; // Turn count
    // Hand cards cost/dmg
    this.features[4] = 0.3; // Card 0: Strike (Cost 1, Dmg 4)
    this.features[5] = 0.5; // Card 1: Defend (Cost 1, Block 5)
    this.features[6] = 0.8; // Card 2: Heavy Smash (Cost 3, Dmg 9)
    this.features[7] = 0.1; // Card 3: Quick Shot (Cost 0, Dmg 2)
  }

  /**
   * Step the game.
   * @param {number} action 0..3
   * @returns {{ nextState: Float32Array, reward: number, done: boolean }}
   */
  step(action) {
    this.turn++;
    let reward = 0.0;
    let done = false;

    // Card effects
    if (action === 0) {
      // Strike
      this.enemyHp -= 4;
      reward += 1.0;
    } else if (action === 1) {
      // Defend
      this.playerHp = Math.min(20, this.playerHp + 2);
      reward += 0.5;
    } else if (action === 2) {
      // Heavy Smash (High reward if MP available)
      if (this.playerMp >= 3) {
        this.playerMp -= 3;
        this.enemyHp -= 9;
        reward += 2.5;
      } else {
        // Punish illegal MP use
        reward -= 1.0;
      }
    } else if (action === 3) {
      // Quick Shot
      this.enemyHp -= 2;
      reward += 0.8;
    }

    // Enemy attacks
    if (this.enemyHp > 0) {
      this.playerHp -= 3;
      reward -= 0.5;
    }

    // Check terminal
    if (this.enemyHp <= 0) {
      reward += 10.0; // Win bonus!
      done = true;
    } else if (this.playerHp <= 0 || this.turn >= 30) {
      reward -= 5.0; // Loss penalty
      done = true;
    }

    this.updateFeatures();
    return {
      nextState: this.features,
      reward,
      done,
    };
  }
}

module.exports = { MockCardGame };
