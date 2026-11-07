// Flight Clerk: Zero-Allocation trajectory recorder
// Binary compatible with Rust StepRecord<N> (16-byte aligned)

const fs = require('fs');
const path = require('path');

class FlightClerk {
  /**
   * @param {number} featN Feature dimension (e.g. 8)
   * @param {number} maxEpisodeSteps Max steps in single episode (e.g. 500)
   */
  constructor(featN = 8, maxEpisodeSteps = 500) {
    this.featN = featN;
    this.maxSteps = maxEpisodeSteps;
    // StepRecord size: (featN * 4) + 16 bytes
    this.recordSizeBytes = featN * 4 + 16;
    
    // Pre-allocated contiguous buffer for one episode
    this.buffer = new ArrayBuffer(this.maxSteps * this.recordSizeBytes);
    this.f32View = new Float32Array(this.buffer);
    this.u8View = new Uint8Array(this.buffer);
    this.stepCount = 0;

    // Fast offset indices (in 4-byte float words)
    this.wordsPerRecord = this.recordSizeBytes / 4;
    this.advOffsetWords = this.featN;
    this.rewOffsetWords = this.featN + 1;
    this.valOffsetWords = this.featN + 2;
    // Action byte offset
    this.actOffsetBytes = this.featN * 4 + 12;
  }

  /**
   * Reset ring buffer for new episode. Zero allocations.
   */
  resetEpisode() {
    this.stepCount = 0;
  }

  /**
   * Record a single transition.
   * @param {Float32Array} features 
   * @param {number} action 
   * @param {number} value Estimated state value V(s)
   * @param {number} reward Immediate reward
   */
  recordStep(features, action, value, reward) {
    if (this.stepCount >= this.maxSteps) return;

    const baseWord = this.stepCount * this.wordsPerRecord;
    const baseByte = this.stepCount * this.recordSizeBytes;

    // 1. Copy features
    for (let i = 0; i < this.featN; i++) {
      this.f32View[baseWord + i] = features[i];
    }

    // 2. Write advantage (placeholder, computed on done), reward, value
    this.f32View[baseWord + this.advOffsetWords] = 0.0;
    this.f32View[baseWord + this.rewOffsetWords] = reward;
    this.f32View[baseWord + this.valOffsetWords] = value;

    // 3. Write action and padding
    this.u8View[baseByte + this.actOffsetBytes] = action;
    this.u8View[baseByte + this.actOffsetBytes + 1] = 0;
    this.u8View[baseByte + this.actOffsetBytes + 2] = 0;
    this.u8View[baseByte + this.actOffsetBytes + 3] = 0;

    this.stepCount++;
  }

  /**
   * Finalize episode, compute GAE in-place from terminal backwards.
   * @param {number} gamma Discount factor (default 0.99)
   * @param {number} lambda GAE lambda (default 0.95)
   * @returns {number} meanAdvantage
   */
  finalizeEpisode(gamma = 0.99, lambda = 0.95) {
    let lastGae = 0.0;
    let nextVal = 0.0; // Terminal value is 0.0
    let totalAdv = 0.0;

    for (let t = this.stepCount - 1; t >= 0; t--) {
      const baseWord = t * this.wordsPerRecord;
      const rew = this.f32View[baseWord + this.rewOffsetWords];
      const val = this.f32View[baseWord + this.valOffsetWords];

      // TD error: delta = r + gamma * V(s_{t+1}) - V(s_t)
      const delta = rew + gamma * nextVal - val;
      const adv = delta + gamma * lambda * lastGae;

      this.f32View[baseWord + this.advOffsetWords] = adv;
      totalAdv += adv;

      lastGae = adv;
      nextVal = val;
    }

    return this.stepCount > 0 ? totalAdv / this.stepCount : 0.0;
  }

  /**
   * Flush active records to a binary file slice.
   * @param {string} filePath 
   */
  flushToFile(filePath) {
    if (this.stepCount === 0) return 0;
    const activeBytes = this.stepCount * this.recordSizeBytes;
    const nodeBuf = Buffer.from(this.buffer, 0, activeBytes);
    fs.appendFileSync(filePath, nodeBuf);
    const saved = this.stepCount;
    this.resetEpisode();
    return saved;
  }
}

module.exports = { FlightClerk };
