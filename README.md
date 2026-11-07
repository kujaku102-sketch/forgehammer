# Forgehammer

High-throughput, zero-allocation policy distillation and ultra-fast decision engine pipeline.

> "蒸留器じゃねえ！鍛冶用ハンマーだ！CPUの雑多な情報を叩いて伸ばして使える道具にする"

```
[16多重 JS Swarm] GameOreUnit x 16  -->  [金床とハンマー] Hammer Strike  -->  [鍛造刃] Blade CPU
  (legacy/ore-swarm)                       (crates/hammer)               (crates/blade)
  JS/Node.js ゼロコピー採掘                  不純物を叩き落とし薄く伸ばす     2.93ns で敵を斬る純粋関数
```

---

## 可変候補版（`packages/forge`）— いま使う道

先生役の CPU が打った試合の「判断」を記録し、**候補の数が判断ごとに違ってよい**形で、候補ごとの点数 `z = w·φ(s,a)`（重みは1組）を学び、そのまま対戦できる JS の CPU モジュールを書き出す。

```
node packages/forge/bin/forge.mjs info    <ore...>                         記録の中身
node packages/forge/bin/forge.mjs hammer  <ore...> --out weights.json      学ぶ（softmax / pairwise / ridge、advantage で重み付け、試合単位で検証）
node packages/forge/bin/forge.mjs smith   weights.json --out <cpus/forged-名前.mjs> --name 名前   CPU モジュールを書く
```
- 記録の形: [docs/ORE-FORMAT.md](docs/ORE-FORMAT.md)（JSONL を gzip のメンバー単位で追記。試合ごとに終端行とハッシュ）。
- 記録を書く側と、特徴 φ を作る関数は、ゲームの対戦機（SZbattlefield）の側にある（`src/ore.mjs`、`cpus/learned/features.mjs`）。学習時と実行時で同じ関数を使う。
- 特徴はその席から見える情報だけ。カード名・番号では決め打ちしない。

下の「4大構成要素」（固定8特徴×4手の試作）は旧版。`legacy/ore-swarm`（mock_game.js を含む）と `crates/*` は、そのまま残してある。

---

## ドキュメント

- **[取扱説明書 (docs/MANUAL.md)](docs/MANUAL.md)**: アーキテクチャ解説、自作ゲーム組み込み手順、操作方法
- **[詳細仕様書 (docs/SPEC-042-CPU-FORGE-BLUEPRINT.md)](docs/SPEC-042-CPU-FORGE-BLUEPRINT.md)**: 原初設計ブループリント

---

## 4大構成要素

1. **[16多重 並列採掘機] Ore Swarm (`legacy/ore-swarm`)**:
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
cd legacy/ore-swarm
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
cargo run --release -p hammer -- legacy/ore-swarm/data/ore/ore_worker_00.bin crates/blade/src/lib.rs
```
