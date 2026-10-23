//! SPEC-042: ゼロアロケーションポリシー評価トレイトおよび静的ポリシ実装
//!
//! ホットループ内でのヒープ確保を完全に排除し、静的ディスパッチおよび
//! キャッシュアラインメントに最適化されたポリシー評価を提供します。

/// 特徴量ベクトルから各行動スコアを評価する静的トレイト。
///
/// コンパイル時定数 `FEAT_N` (特徴量次元数) および `ACT_N` (行動数) を受け取り、
/// スタック上で直接評価を行います。
pub trait PolicyEvaluator<const FEAT_N: usize, const ACT_N: usize> {
    /// 与えられた特徴量ベクトルから行動スコアを計算し、出力バッファに書き込みます。
    ///
    /// # 引数
    /// * `features` - 入力特徴量配列への参照
    /// * `out_scores` - 計算結果を書き込む行動スコア配列への可変参照
    fn eval(&self, features: &[f32; FEAT_N], out_scores: &mut [f32; ACT_N]);
}

/// 単純な線形重み行列によるポリシー実装。
///
/// 各行動 `a` に対するスコアは内積 `dot(weights[a], features)` として計算されます。
/// SIMDベクトル化とキャッシュライン最適化のため、16バイト境界でアラインメントされています。
#[repr(C, align(16))]
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LinearPolicy<const FEAT_N: usize, const ACT_N: usize> {
    /// 行動ごとの重みベクトル (サイズ: ACT_N x FEAT_N)
    pub weights: [[f32; FEAT_N]; ACT_N],
}

impl<const FEAT_N: usize, const ACT_N: usize> LinearPolicy<FEAT_N, ACT_N> {
    /// すべての重みがゼロで初期化された新しい `LinearPolicy` を生成します。
    #[inline]
    pub const fn new_zeroed() -> Self {
        Self {
            weights: [[0.0f32; FEAT_N]; ACT_N],
        }
    }

    /// 指定された重み行列から `LinearPolicy` を生成します。
    #[inline]
    pub const fn new(weights: [[f32; FEAT_N]; ACT_N]) -> Self {
        Self { weights }
    }
}

impl<const FEAT_N: usize, const ACT_N: usize> PolicyEvaluator<FEAT_N, ACT_N>
    for LinearPolicy<FEAT_N, ACT_N>
{
    #[inline(always)]
    fn eval(&self, features: &[f32; FEAT_N], out_scores: &mut [f32; ACT_N]) {
        let mut act_idx = 0;
        while act_idx < ACT_N {
            let mut dot = 0.0f32;
            let mut feat_idx = 0;
            while feat_idx < FEAT_N {
                dot += self.weights[act_idx][feat_idx] * features[feat_idx];
                feat_idx += 1;
            }
            out_scores[act_idx] = dot;
            act_idx += 1;
        }
    }
}
