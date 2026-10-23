# Forgehammer 総合取扱説明書 (Architecture & Operation Manual)

> **「蒸留器じゃねえ！鍛冶用ハンマーだ！CPUの雑多な情報を叩いて伸ばして使える道具にする」**

Forgehammer は、ゲームやシミュレータの探索ログから**ナノ秒（10億分の1秒単位）で動く純粋関数CPU**を叩き出すための超高硬度エンドツーエンド鍛造フレームワークです。

---

## 目次
1. [設計思想と全体アーキテクチャ](#1-設計思想と全体アーキテクチャ)
2. [4大構成要素](#2-4大構成要素)
   - [① 16多重並列採掘スウォーム (packages/ore-swarm)](#1-16多重並列採掘スウォーム-packagesore-swarm)
   - [② ゼロアロケーション採掘機 (crates/harvester)](#2-ゼロアロケーション採掘機-cratesharvester)
   - [③ 金床と鍛造ハンマー (crates/hammer)](#3-金床と鍛造ハンマー-crateshammer)
   - [④ 鍛造刃 CPU (crates/blade)](#4-鍛造刃-cpu-cratesblade)
3. [サイバー金床 TUI オペレーター (crates/forge_tui)](#3-サイバー金床-tui-オペレーター-cratesforge_tui)
4. [自作ゲーム・実環境への組み込みガイド](#4-自作ゲーム実環境への組み込みガイド)
5. [クイックスタート・コマンドリファレンス](#5-クイックスタートコマンドリファレンス)

---

## 1. 設計思想と全体アーキテクチャ

強化学習や模倣学習（Behavioral Cloning / AWR）の最大のボトルネックは、**「重いニューラルネットワーク推論によるミリ秒単位の遅延」**と**「ログ記録によるGC（ガベージコレクション）スパイク」**にあります。

Forgehammer は、以下の3つの極限要件を完全達成するために設計されました：
1. **0.001ms（1マイクロ秒）以内の超速推論**: 実測 **2.93 ナノ秒**（秒間 3億4,000万回）。
2. **ゼロ・ガベージコレクション（Zero-GC）**: ゲームのホットループ中に配列やオブジェクトを一切生成しない。
3. **言語の壁を越えたゼロコピー相互運用**: JavaScript/Node.js で採掘したバイナリを、Rust の鍛冶ハンマーが一瞬で直読みして鍛造。

```
[16多重 並列採掘機]                [金床＆ハンマー]                 [鍛造刃 CPU]
packages/ore-swarm                crates/hammer                   crates/blade
┌──────────────────┐             ┌─────────────────┐             ┌─────────────────┐
│ Game + CPU + 記録 │ ──.bin──>  │ 不純物叩き落とし │  ──Rust──>   │ 2.93ns 純粋関数 │
│ 16スレッド爆走   │             │ AWR / 決定株    │    コード   │ Zero Allocation │
└──────────────────┘             └─────────────────┘             └─────────────────┘
```

---

## 2. 4大構成要素

### ① 16多重並列採掘スウォーム (`packages/ore-swarm`)
JavaScript/Node.js 環境で動く、超高スループット並列採掘クライアント。

- **`GameOreUnit`（ニコイチ構成）**:
  - **ゲーム本体** (`src/mock_game.js`): ゲーム状態を更新し報酬を返す。
  - **操作CPU** (`src/cpu.js`): $\epsilon$-greedy 探索付きで行動を選択する。
  - **記録係** (`src/clerk.js`): CPUにログの仕事をさせず、`ArrayBuffer` に `(s, a, q, r, d)` を淡々と記録。エピソード完了時に後ろから GAE（Generalized Advantage Estimation: $\gamma=0.99, \lambda=0.95$）を自動逆算。
- **バイナリ完全互換**:
  Rust の `#[repr(C, align(16))] StepRecord<N>` と完全一致するバイナリを生成（16バイトアライメント）。
- **`src/swarm.js`**:
  Node.js の `worker_threads` を使い、16スレッドでゲームを並列稼働。毎秒数万手の粗鉄ログを `.bin` ファイル群へ高速ストリーミング。

### ② ゼロアロケーション採掘機 (`crates/harvester`)
Rust ネイティブ環境用の最速フライトレコーダー。
- コンパイル時固定長特徴量 `[f32; N]` と固定長リングバッファ `EpisodeRingBuffer<N, MAX_STEPS>`。
- ヒープアロケーション完全ゼロで動作し、極限のシミュレータ環境で真価を発揮。

### ③ 金床と鍛造ハンマー (`crates/hammer`)
不純物だらけの粗鉄ログを金床に据え、熱いハンマーで叩いて薄く強靭なルールに鍛造する。
- **Advantage-Weighted Strike**:
  負のAdvantageや無駄な迷い手を火花にして叩き落とし（下位Quantile破棄）、上位の優れた手に対して $w_i = \exp(A_i / \beta)$ で重み付け。
- **Gauss-Jordan 正規方程式ソルバー**:
  重み付けリッジ回帰 $(X^T W X + \lambda I)^{-1} X^T W Y$ を Gauss-Jordan 消去法で高速に解き、線形重み行列 `[ACT_N][FEAT_N]` を叩き出す。
- **決定株（Decision Stump）による精密研磨**:
  残差に対して最適な分岐閾値を打ち込み、鋭利な刃先を成型。
- **鍛造速度**: **1,000手をわずか 74.8 マイクロ秒 で一撃鍛造**。
- **自動コード生成 (`src/smith.rs`)**:
  鍛え上げたルールから、`UltraFastBlade` の Rust ソースコードを自動射出。

### ④ 鍛造刃 CPU (`crates/blade`)
鍛え上げられた純粋関数意思決定エンジン。
- **レイテンシ**: **2.93 ナノ秒** (0.00293 μs / 0.000003 ms)
- **スループット**: **340.7 M ops/sec** (毎秒 3億4,000万回判断)
- **メモリ**: ヒープアロケーション完全ゼロ、`#![no_std]` 対応、SIMDループ展開。

---

## 3. サイバー金床 TUI オペレーター (`crates/forge_tui`)

Windows コマンドプロンプト上で火花を散らす 24-bit TrueColor ANSI リアルタイム操作コンソール。

```text
╔══════════════════════════════════════════════════════════════════════════════════════════════════╗
║  🔥 FORGEHAMMER CYBER-ANVIL OPERATOR 🔥      [MODE: MANUAL]   Latency: 2.93ns   Throughput: 340M/s   ║
╠════════════════════════════════╦═════════════════════════════════╦════════════════════════════════╣
║ ⛏️  ORE HARVESTER (DEV 1)      ║ 🔨 ANVIL & HAMMER (DEV 2)     ║ ⚔️  BLADE INFERENCE (DEV 3)    ║
║ Status:   ACTIVE [140 recs]    ║ Strike Count:  #12 strikes      ║ Latency:    2.93 ns (PASS)     ║
║ Buffer:   [████████░░] 68%     ║ Impurity Drop: 68.4% (GAE)      ║ Weight:     W[A2]: +0.68,+0.71 ║
╠────────────────────────────────╫─────────────────────────────────╫────────────────────────────────╢
║ [Recent Trajectory Stream]     ║   💥  *   *  .  🔥              ║ [Real-time Action Decision]    ║
║ st:124 a:2 adv:+1.8            ║   O===[**]|  >> SLAM! <<        ║ Act 0: [██░░░░░░░░] 15%        ║
║ st:125 a:0 adv:-1.2            ║    💥 ⚡ *  SPARKS: 842         ║ Act 1: [░░░░░░░░░░]  5%        ║
║ st:126 a:2 adv:+2.1            ║     ___[ ANVIL ]___             ║ Act 2: [██████████] 95% ◀      ║
║ ...                            ║     ...                         ║ ...                            ║
```

### 操作キー
- **`[SPACE]`**: **ハンマースイング！** 金床に火花が散り、粗鉄を打撃して新ルールを即座に鍛造。
- **`[A]`**: **自動鍛造モード（AUTO-FORGE）切替**。採掘と鍛造が自動で回り続ける。
- **`[H]`**: 粗鉄ログを20ステップ採掘。
- **`[Q]`**: 安全にオペレーター終了。

---

## 4. 自作ゲーム・実環境への組み込みガイド

あなたの自作ゲーム（HTML/JS/Canvas/カードゲーム）を接続する手順です。
書き換えるファイルは **[packages/ore-swarm/src/mock_game.js](file:///C:/Users/Masaya.Futamata/Documents/forgehammer/packages/ore-swarm/src/mock_game.js) のみ** です。

### 手順 1: 特徴量ベクトル（Features）の設計
ゲームの状態を固定長（例: 8次元）の `Float32Array` に正規化します。
```javascript
// 値はすべて -1.0 〜 +1.0 または 0.0 〜 1.0 に正規化すること
features[0] = playerHp / maxHp;       // 自分のHP
features[1] = enemyHp / maxEnemyHp;   // 敵のHP
features[2] = mp / maxMp;             // リソース
features[3] = handCard0_Cost / 10.0;  // 手札0のコスト
```

### 手順 2: `reset()` と `step(action)` の実装
```javascript
class MyGame {
  constructor() {
    this.featN = 8; // 特徴量次元数
    this.actN = 4;  // 選択可能な行動数
    this.features = new Float32Array(this.featN);
  }

  reset() {
    // 盤面初期化
    return this.features;
  }

  step(action) {
    // 1. 行動の適用
    // 2. 報酬の計算（勝ち手には正、負け手には負の値を付与）
    let reward = 0.0;
    let done = false;

    if (won)  { reward += 10.0; done = true; }
    if (lost) { reward -= 5.0;  done = true; }

    return { nextState: this.features, reward, done };
  }
}
```

### 手順 3: スウォームを起動して採掘
```bash
launch_swarm.bat
```
16スレッドが並列でゲームをプレイし、`data/ore/*.bin` に粗鉄が自動生成されます。

### 手順 4: ハンマーで鍛造
```bash
cargo run --release -p hammer -- packages/ore-swarm/data/ore/ore_worker_00.bin crates/blade/src/lib.rs
```
**数ミリ秒で、2.93nsの最強CPUコード（`Blade`）が射出されます。**

---

## 5. クイックスタート・コマンドリファレンス

| 操作 | コマンド / バッチ | 説明 |
| :--- | :--- | :--- |
| **採掘スウォーム起動** | `launch_swarm.bat` | 16多重並列でゲームを自動プレイ＆粗鉄ログ採掘 |
| **サイバー金床TUI起動** | `launch_forge_tui.bat` | コマンドプロンプトで火花散るリアルタイム鍛冶画面 |
| **ハンマー打撃（デモ）** | `cargo run --release -p hammer` | 粗鉄を打撃して100万回推論ベンチマークを計測 |
| **実ログ鍛造** | `cargo run --release -p hammer -- <in.bin> <out.rs>` | 指定の `.bin` ログを食わせて Rust 刃コードを生成 |
| **全単体テスト実行** | `cargo test` | Harvester, Hammer, Blade の全単体テストを検証 |

---
*Generated for Forgehammer SSOT - 2026*
