### 1. システム設計フロー

```
+---------------------------------------------------------------------------------------------------+
| [DEVICE 1] HEADLESS HARVESTER (Tusk Core / Rust)                                                  |
|                                                                                                   |
|  +--------------+   Raw State   +---------------------+   &[f32; N]    +-----------------------+  |
|  | Env Stepper  | ------------> | Sensor Mock + Noise | -------------> | Policy Evaluator      |  |
|  | (Zero-Alloc) | <------------ | (σ=0.02, Vis-Only)  | --+            | fn(&[f32;N],&mut[f32])|  |
|  +--------------+  Action (u8)  +---------------------+   |            +-----------------------+  |
|         |                                                 |                        |              |
|         v Reward / Done                                   v                        v              |
|  +---------------------------------------------------------------------------------------------+  |
|  | Lock-Free RingBuffer (Thread-Local Episode Trajectory: [State_t, Action_t, Reward_t])       |  |
|  +---------------------------------------------------------------------------------------------+  |
|         | Episode Done                                                                            |
|         v                                                                                         |
|  +----------------------------------------------------+   Drop 80-90%  +-----------------------+  |
|  | Advantage Filter (GAE / Return Top 10-20% Quantile)| -------------> | [Null / Overwrite]    |  |
|  +----------------------------------------------------+                +-----------------------+  |
|         | Keep Top 10-20%                                                                         |
|         v Async Channel (Crossbeam)                                                               |
+---------|-----------------------------------------------------------------------------------------+
          | Binary Chunk (FlatBuffer / Raw Struct)
          v
+---------------------------------------------------------------------------------------------------+
| [DEVICE 2] POLICY DISTILLER (Offline / Python-Rust Bridge)                                        |
|                                                                                                   |
|  +--------------------+   w_i = exp(A_i / β)   +-----------------------------------------------+  |
|  | Binary Loader      | ---------------------> | AWR + Shallow GBDT / RuleFit Trainer          |  |
|  | (Mmap Zero-Copy)   |                        | (Max Depth <= 4, L1 Regularization)           |  |
|  +--------------------+                        +-----------------------------------------------+  |
|                                                                        | AST / Tree Weights       |
|                                                                        v                          |
|                                                +-----------------------------------------------+  |
|                                                | Static AST Codegen (Unrolled if-else / SIMD)  |  |
|                                                +-----------------------------------------------+  |
+------------------------------------------------------------------------|--------------------------+
                                                                         | Generated Source (.rs/.ts)
                                                                         v
+---------------------------------------------------------------------------------------------------+
| [DEVICE 3] ULTRA-FAST CPU & DAGGER LOOP                                                           |
|                                                                                                   |
|  +----------------------------------------------------+   Compile      +-----------------------+  |
|  | `generated_policy.rs`                              | -------------> | Target Latency < 1us  |  |
|  | #[inline(always)] fn eval(&[f32;N], &mut [f32;A])  |                | (No Branch Miss/Heap) |  |
|  +----------------------------------------------------+                +-----------------------+  |
|         |                                                                                         |
|         +---> [DAgger Loop]: Inject `generated_policy` back into [DEVICE 1] Policy Evaluator      |
+---------------------------------------------------------------------------------------------------+
```

#### 処理パイプライン定義
1. **Tick Loop**: `Env::step` -> `SensorMock::extract(state, rng, &mut feat)` -> `Policy::eval(&feat, &mut scores)` -> `ArgMax(scores)` -> `RingBuffer::push(feat, action, reward)`
2. **Flush Gate**: `if env.is_done()` -> `calc_gae(&ring_buf)` -> `if adv_mean >= threshold { async_tx.send(ring_buf.drain()) } else { ring_buf.clear() }`
3. **Distill**: `Mmap(dataset.bin)` -> `weights = exp(adv / beta)` -> `RuleFit.fit(X, y, sample_weight=weights)` -> `AST::from_trees(model)` -> `Codegen::emit_rust(ast)`
4. **DAgger**: `Env::step` 内の行動選択確率 $\pi_{mix} = \beta \pi_{expert} + (1-\beta) \pi_{distilled}$ で遷移し、状態に対する $\pi_{expert}$ (MCTS/重厚探索) または結果Advantageを記録。

---

### 2. 実装コンポーネント表

| ファイルパス | 責務 | 入力 | 出力 | 制約 |
| :--- | :--- | :--- | :--- | :--- |
| `crates/tusk_core/src/policy.rs` | 判断CPU共通インターフェース定義 | `&[f32; N]`, `&mut [f32; A]` | `()` | Trait Object禁止(Static Dispatch)、`no_std`互換、Heap確保禁止 |
| `crates/tusk_harvester/src/sensor.rs` | 視覚互換特徴量抽出・ノイズ注入 | `&RawEnvState`, `&mut XorShiftRng`, `&mut [f32; N]` | `()` | GamersEYE取得可能項目のみ。ガウシアン/一様ノイズ($\sigma=0.02$)をインプレース加算 |
| `crates/tusk_harvester/src/ring_buffer.rs` | 1エピソード軌跡のインメモリ保持 | `StepRecord<N>` | `&[StepRecord<N>]` | 固定長配列 `[StepRecord<N>; MAX_STEPS]`、動的確保禁止 (`Vec`使用不可) |
| `crates/tusk_harvester/src/advantage.rs` | GAE計算および上位パーセンタイル判定 | `&mut [StepRecord<N>]`, `gamma: f32`, `lambda: f32` | `f32` (Episode Score) | インプレースでAdvantageを書き換え。閾値移動平均をロックフリー更新 |
| `crates/tusk_harvester/src/writer.rs` | 選抜エピソードの非同期バイナリ書き出し | `Receiver<EpisodeChunk<N>>` | `dataset_part_*.bin` | ワーカースレッドから完全分離。C構造体互換(`#[repr(C)]`)で直接Disk Flush |
| `crates/tusk_harvester/src/dagger.rs` | 探索CPUと蒸留CPUの混合実行器 | `&[f32; N]`, `beta: f32`, `&mut XorShiftRng` | `Action (u8)` | $\beta$ 減衰スケジュール管理。Zero-Allocation |
| `tools/distiller/loader.py` | バイナリログのZero-Copyロード | `dataset_part_*.bin` | `np.memmap` (X, A, Adv) | メモリコピー禁止、`np.frombuffer` / `memmap` のみ使用 |
| `tools/distiller/awr_trainer.py` | AWR重み計算と浅いGBDT/RuleFit学習 | `X`, `A`, `Adv`, `beta: float` | `TreeEnsembleAST` | `max_depth <= 4`, `n_estimators <= 64`。重み上限クリッピング($w_{max}=20.0$) |
| `tools/distiller/codegen.py` | 決定木ASTからRust/TSコードへの直接展開 | `TreeEnsembleAST` | `generated_policy.rs`, `generated_policy.ts` | ループ禁止(完全アンロール)、配列境界チェック回避(`get_unchecked` または固定長型検査)、`#[inline(always)]` 付与 |
| `crates/tusk_cpu_gen/src/lib.rs` | Codegen出力コードのホスト・SIMD統合 | `&[f32; N]`, `&mut [f32; A]` | `()` | 推論レイテンシ $\le 1\mu s$。外部クレート依存ゼロ |

#### データレイアウト規約 (`#[repr(C)]`)
```rust
#[repr(C, align(16))]
pub struct StepRecord<const N: usize> {
    pub features: [f32; N],
    pub advantage: f32,
    pub action: u8,
    pub _pad: [u8; 11], // 16-byte alignment維持
}
```

---

### 3. 段階別実装マイルストーン

#### Phase 1: Zero-Allocation Harvester 構築
- **対象**: `policy.rs`, `sensor.rs`, `ring_buffer.rs`, `advantage.rs`, `writer.rs`
- **完了条件**:
  - 1スレッドあたり 100,000 steps/sec 以上の採集速度。
  - 採集ループ内のヒープアロケーション回数 `0` (dhat / custom allocator で検証)。
  - 上位15%のエピソードのみが `.bin` ファイルに正確な `#[repr(C)]` アライメントで出力されること。
- **検査スクリプト**:
  ```sh
  cargo test -p tusk_harvester --release -- --nocapture
  cargo bench -p tusk_harvester --bench harvest_throughput
  ```

#### Phase 2: AWR Distiller & AST Codegen 構築
- **対象**: `loader.py`, `awr_trainer.py`, `codegen.py`
- **完了条件**:
  - 1GBの `.bin` ファイルを1秒以内に `memmap` マウント完了。
  - 出力された `generated_policy.rs` が `rustc` で警告なしにコンパイル通過。
  - 生成コード内に動的メモリアロケーション、ループ構文(`for`/`while`)、関数コールが存在しないこと。
- **検査スクリプト**:
  ```sh
  python3 tools/distiller/run_distill.py --input ./data/ --output ./crates/tusk_cpu_gen/src/generated_policy.rs
   ! grep -E "for |while |vec!|Box::" ./crates/tusk_cpu_gen/src/generated_policy.rs
  cargo check -p tusk_cpu_gen
  ```

#### Phase 3: 1us ベンチマーク & DAgger 閉ループ結合
- **対象**: `crates/tusk_cpu_gen/src/lib.rs`, `dagger.rs`
- **完了条件**:
  - `tusk_cpu_gen::eval` の単回推論レイテンシが平均 `1,000 ns` (0.001ms) 以下。
  - アセンブリ出力に `panic` / `bounds_check` が含まれないこと。
  - DAgger 3イテレーション後、2%ノイズ環境下で初期探索CPU比 110% 以上の平均リターンを達成。
- **検査スクリプト**:
  ```sh
  cargo criterion -p tusk_cpu_gen --bench inference_latency
  cargo asm -p tusk_cpu_gen tusk_cpu_gen::generated_policy::eval | ! grep -i "panic"
  ./scripts/run_dagger_loop.sh --iterations 3 --noise 0.02
  ```