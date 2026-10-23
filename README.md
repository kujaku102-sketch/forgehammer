# Forgehammer

High-throughput, zero-allocation policy distillation and ultra-fast decision engine pipeline.

## Overview

Forgehammer is an end-to-end framework designed to bridge headless reinforcement/imitation learning with sub-microsecond edge inference:

1. **[DEVICE 1] Harvester (`crates/harvester`)**:
   - Zero-allocation Rust flight recorder.
   - Fixed-length feature vectors (`[f32; N]`), 16-byte aligned SIMD-friendly records.
   - On-the-fly Generalized Advantage Estimation (GAE) and online quantile filtering.
   - Zero-copy binary chunk streaming (`.bin`).

2. **[DEVICE 2] Distiller (`tools/distiller`)**:
   - Advantage-Weighted Regression (AWR) & policy distillation pipeline.
   - Converts large trajectory chunks into compact linear evaluators and flat unrolled decision trees.
   - DAgger loop integration for self-healing exploration.

3. **[DEVICE 3] Ultra-Fast CPU**:
   - Zero-heap, SIMD-accelerated inference (< 0.001ms / 1 microsecond latency).
   - Suitable for real-time game AI, vision-driven agents (GamersEYE), and low-latency rule execution.

## Specification

Detailed design specifications can be found in [docs/SPEC-042-CPU-FORGE-BLUEPRINT.md](docs/SPEC-042-CPU-FORGE-BLUEPRINT.md).

## Verification

```bash
cargo test
```
