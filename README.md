# Forgehammer

High-throughput, zero-allocation policy distillation and ultra-fast decision engine pipeline.

> "蒸留器じゃねえ！鍛冶用ハンマーだ！CPUの雑多な情報を叩いて伸ばして使える道具にする"

```
[16多重 JS Swarm] GameOreUnit x 16  -->  [金床とハンマー] Hammer Strike  -->  [鍛造刃] Blade CPU
  (packages/ore-swarm)                       (crates/hammer)               (crates/blade)
  JS/Node.js ゼロコピー採掘                  不純物を叩き落とし薄く伸ばす     2.93ns で敵を斬る純粋関数
```

---

## ドキュメント

- **[取扱説明書 (docs/MANUAL.md)](docs/MANUAL.md)**: アーキテクチャ解説、自作ゲーム組み込み手順、操作方法
- **[詳細仕様書 (docs/SPEC-042-CPU-FORGE-BLUEPRINT.md)](docs/SPEC-042-CPU-FORGE-BLUEPRINT.md)**: 原初設計ブループリント

---

## 4大構成要素

1. **[16多重 並列採掘機] Ore Swarm (`packages/ore-swarm`)**:
   - `GameInstance + PilotCPU + FlightClerk` が1パッケージ（`GameOreUnit`）。
   - Node.js `worker_threads` により16個のゲームを同時超速ループ実行。
   - Zero-GC の `ArrayBuffer` で記録し、Rustと完全一致する16バイトアライメント `.bin` を連続射出。
   - ANSI ターミナルで16スレッドのFPS、ステップ数、勝率、Advantageをライブ集約。

2. **[Ore 採掘機 (Rust)] Ore Harvester (`crates/harvester`)**:
   - Rustネイティブ用のゼロアロケーション採掘機。
   - `[f32; N]` 固定長特徴量、GAEオンラインフィルタ。

3. **[金床とハンマー] Anvil & Hammer (`crates/hammer`)**:
   - Advantage-Weighted Regression (AWR) & impurity striker.
   - 採掘された `.bin` 粗鉄チャンクを直接ロードし、負の手・迷い手を火花にして叩き落とす。
   - 線形重みと決定株テーブルを叩き上げ、Rust純粋関数コード（Blade）を即座に自動生成。

4. **[鍛造刃 CPU] Ultra-Fast Blade (`crates/blade`)**:
   - Zero heap allocation, `#![no_std]` ready.
   - **推論レイテンシ: ~2.93 ns (0.00293 μs / 0.000003 ms)**
   - **秒間スループット: 3億4,000万回（340+ Million ops/sec）**。

---

## 起動コマンド

### 1. 16多重 採掘スウォームを起動（JS/Node.js）
```bash
# ワンクリック起動バッチ
launch_swarm.bat

# またはCLI
cd packages/ore-swarm
node src/swarm.js
```

### 2. サイバー鍛冶屋 TUI オペレーターを起動（Rust ANSI Console）
```bash
# ワンクリック起動バッチ
launch_forge_tui.bat

# またはCLI
cargo run --release -p forge_tui
```

### 3. 採掘バイナリをハンマーで一撃鍛造
```bash
cargo run --release -p hammer -- packages/ore-swarm/data/ore/ore_worker_00.bin crates/blade/src/lib.rs
```
