// Pilot CPU: Pure-function decision engine with exploration

class PilotCPU {
  /**
   * @param {number} featN Feature count
   * @param {number} actN Action count
   * @param {number} epsilon Exploration rate (e.g. 0.15)
   */
  constructor(featN = 8, actN = 4, epsilon = 0.15) {
    this.featN = featN;
    this.actN = actN;
    this.epsilon = epsilon;

    // Baseline linear weights: [actN][featN]
    this.weights = new Float32Array(actN * featN);
    this.outScores = new Float32Array(actN);

    // Randomize initial weights
    for (let i = 0; i < this.weights.length; i++) {
      this.weights[i] = (Math.random() - 0.5) * 0.2;
    }
  }

  /**
   * Evaluate scores and select action with exploration.
   * @param {Float32Array} features 
   * @returns {{ action: number, value: number }}
   */
  decide(features) {
    // 1. Compute linear scores (Zero-allocation)
    let maxScore = -Infinity;
    let bestAct = 0;

    for (let a = 0; a < this.actN; a++) {
      let sum = 0.0;
      const base = a * this.featN;
      for (let f = 0; f < this.featN; f++) {
        sum += this.weights[base + f] * features[f];
      }
      this.outScores[a] = sum;
      if (sum > maxScore) {
        maxScore = sum;
        bestAct = a;
      }
    }

    // 2. Epsilon-greedy exploration
    let chosenAct = bestAct;
    if (Math.random() < this.epsilon) {
      chosenAct = Math.floor(Math.random() * this.actN);
    }

    // Value approximation is the expected max score
    return {
      action: chosenAct,
      value: maxScore,
    };
  }

  /**
   * Inject forged blade weights (Hot-swapping from Forgehammer)
   * @param {Float32Array|number[]} flatWeights 
   */
  hotSwapWeights(flatWeights) {
    for (let i = 0; i < Math.min(this.weights.length, flatWeights.length); i++) {
      this.weights[i] = flatWeights[i];
    }
  }
}

module.exports = { PilotCPU };
