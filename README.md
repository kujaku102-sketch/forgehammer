# Forgehammer

High-throughput, zero-allocation policy distillation and ultra-fast decision engine pipeline.

> "蒸留器じゃねえ！鍛冶用ハンマーだ！CPUの雑多な情報を叩いて伸ばして使える道具にする"

```
[Ore 採掘] Harvester  -->  [金床とハンマー] Hammer Strike  -->  [鍛造刃] Blade CPU
  (crates/harvester)            (crates/hammer)               (crates/blade)
  ゼロアロケーション採掘         不純物を叩き落とし薄く伸ばす     2.93ns で敵を斬る純粋関数
```

---

## 3層鍛造アーキテクチャ

1. **[DEVICE 1] Ore Harvester (`crates/harvester`)**:
   - Zero-allocation Rust flight recorder.
   - Fixed-length feature vectors (`[f32; N]`), 16-byte aligned SIMD-friendly records.
   - On-the-fly Generalized Advantage Estimation (GAE) and online quantile filtering.
   - Zero-copy binary chunk streaming (`.bin`).

2. **[DEVICE 2] Anvil & Hammer (`crates/hammer`)**:
   - Advantage-Weighted Regression (AWR) & impurity striker.
   - Knocks off bad actions, noisy exploration, and negative advantages.
   - Forges linear weights and decision stump tables via Gauss-Jordan weighted ridge solver.
   - Auto-emits optimized Rust source code.

3. **[DEVICE 3] Ultra-Fast Blade (`crates/blade`)**:
   - Zero heap allocation, `#![no_std]` ready.
   - Unrolled SIMD evaluation + decision stump sharpening.
   - **Latency: ~2.93 ns (0.00293 μs / 0.000003 ms)**
   - **Throughput: 340+ Million ops/sec**.

---

## Benchmark (Real Strike on Ryzen/x86_64)

```text
============================================================
 [FORGEHAMMER] Anvil & Hammer Strike Engine
 Knocking off impurities -> Forging ultra-fast Blade
============================================================
[Demo] Generating raw simulated ore (1,000 steps)...
[Hammer] Striking ore with Advantage-Weighted Regression...
[Hammer] Strike complete in 74.8µs
[Smith] Forging Blade source code...
[Smith] Blade saved to: blade_demo.rs

[Benchmark] Testing evaluation latency (1,000,000 inferences)...
------------------------------------------------------------
 Total Time:      2.9349ms (checksum: 2000000)
 Latency / Infer: 2.93 ns (0.00293 microsec / 0.000003 ms)
 Inferences/sec:  340.7 M ops/s
 Target Met:      SUCCESS! [PASS] (< 0.001 ms / 1 microsec)
------------------------------------------------------------
```

---

## Verification

```bash
# Run all workspace tests (Harvester, Hammer, Blade)
cargo test

# Run hammer strike demo and benchmark
cargo run --release -p hammer
```
