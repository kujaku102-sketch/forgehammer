//! Strike Engine: Knocks off impurities using Advantage weights and forges decision weights.

use tusk_harvester::ring_buffer::StepRecord;

/// Forged linear weights and decision stumps.
#[derive(Debug, Clone)]
pub struct ForgedRule<const FEAT_N: usize, const ACT_N: usize> {
    /// Linear weights per action: [ACT_N][FEAT_N]
    pub linear_weights: [[f32; FEAT_N]; ACT_N],
    /// Decision stumps for fine edge shaping: (feature_idx, threshold, left_boost, right_boost)
    pub stumps: Vec<DecisionStump<ACT_N>>,
}

#[derive(Debug, Clone)]
pub struct DecisionStump<const ACT_N: usize> {
    pub feature_idx: usize,
    pub threshold: f32,
    pub left_delta: [f32; ACT_N],
    pub right_delta: [f32; ACT_N],
}

/// Strikes impurities and forges an action decision policy.
pub struct HammerStrike<const FEAT_N: usize, const ACT_N: usize> {
    pub beta: f32,          // Temperature for Advantage weighting (e.g. 1.0)
    pub l2_reg: f32,        // Ridge regularization (e.g. 1e-3)
    pub min_quantile: f32,  // Filter out bottom records (e.g. 0.3 for bottom 30%)
}

impl<const FEAT_N: usize, const ACT_N: usize> Default for HammerStrike<FEAT_N, ACT_N> {
    fn default() -> Self {
        Self {
            beta: 1.0,
            l2_reg: 1e-3,
            min_quantile: 0.2, // Discard bottom 20%
        }
    }
}

impl<const FEAT_N: usize, const ACT_N: usize> HammerStrike<FEAT_N, ACT_N> {
    /// Hammer down raw ore records into a forged decision rule.
    pub fn strike(&self, records: &[StepRecord<FEAT_N>]) -> ForgedRule<FEAT_N, ACT_N> {
        assert!(!records.is_empty(), "Cannot strike empty ore");

        // 1. Strike impurities: compute advantage threshold
        let mut advs: Vec<f32> = records.iter().map(|r| r.advantage).collect();
        advs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let cutoff_idx = ((advs.len() as f32) * self.min_quantile) as usize;
        let adv_cutoff = advs[cutoff_idx.min(advs.len() - 1)];

        // 2. Filter records and compute weights
        let mut filtered_records = Vec::new();
        let mut weights = Vec::new();

        for r in records {
            if r.advantage >= adv_cutoff {
                // AWR exponent weight, clamped to avoid overflow
                let exp_w = ((r.advantage / self.beta).clamp(-10.0, 10.0)).exp();
                filtered_records.push(r);
                weights.push(exp_w);
            }
        }

        if filtered_records.is_empty() {
            // Fallback if everything was filtered
            filtered_records.extend(records.iter());
            weights.resize(records.len(), 1.0);
        }

        // 3. Forge Linear Weights via Weighted Ridge Regression
        // (X^T W X + lambda * I) w_a = X^T W y_a
        let mut xtwx = vec![vec![0.0f64; FEAT_N]; FEAT_N];
        let mut xtwy = vec![vec![0.0f64; FEAT_N]; ACT_N];

        for (rec, &w) in filtered_records.iter().zip(weights.iter()) {
            let w64 = w as f64;
            let act = (rec.action as usize).min(ACT_N - 1);

            for i in 0..FEAT_N {
                let xi = rec.features[i] as f64;
                xtwy[act][i] += w64 * xi; // target y_a = 1.0 for taken action

                for j in 0..FEAT_N {
                    let xj = rec.features[j] as f64;
                    xtwx[i][j] += w64 * xi * xj;
                }
            }
        }

        // Add L2 regularization to diagonal
        for i in 0..FEAT_N {
            xtwx[i][i] += self.l2_reg as f64;
        }

        // Invert X^T W X using Gauss-Jordan
        let inv_xtwx = invert_matrix::<FEAT_N>(&xtwx);

        let mut linear_weights = [[0.0f32; FEAT_N]; ACT_N];
        for a in 0..ACT_N {
            for i in 0..FEAT_N {
                let mut sum = 0.0f64;
                for j in 0..FEAT_N {
                    sum += inv_xtwx[i][j] * xtwy[a][j];
                }
                linear_weights[a][i] = sum as f32;
            }
        }

        // 4. Forge Decision Stumps (fine edge adjustment on top of linear base)
        let mut stumps = Vec::new();
        // Generate up to 2 stumps on the most discriminative features
        if FEAT_N > 0 {
            let best_stump = self.find_best_stump(&filtered_records, &weights, &linear_weights);
            stumps.push(best_stump);
        }

        ForgedRule {
            linear_weights,
            stumps,
        }
    }

    fn find_best_stump(
        &self,
        records: &[&StepRecord<FEAT_N>],
        weights: &[f32],
        _linear_weights: &[[f32; FEAT_N]; ACT_N],
    ) -> DecisionStump<ACT_N> {
        // Find median threshold of feature 0 as simple effective stump
        let feat_idx = 0;
        let mut vals: Vec<f32> = records.iter().map(|r| r.features[feat_idx]).collect();
        vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let threshold = vals[vals.len() / 2];

        let mut left_count = [0.0f32; ACT_N];
        let mut right_count = [0.0f32; ACT_N];

        for (rec, &w) in records.iter().zip(weights.iter()) {
            let act = (rec.action as usize).min(ACT_N - 1);
            if rec.features[feat_idx] <= threshold {
                left_count[act] += w;
            } else {
                right_count[act] += w;
            }
        }

        let mut left_delta = [0.0f32; ACT_N];
        let mut right_delta = [0.0f32; ACT_N];
        let total_left: f32 = left_count.iter().sum::<f32>().max(1e-5);
        let total_right: f32 = right_count.iter().sum::<f32>().max(1e-5);

        for a in 0..ACT_N {
            left_delta[a] = (left_count[a] / total_left) * 0.5;
            right_delta[a] = (right_count[a] / total_right) * 0.5;
        }

        DecisionStump {
            feature_idx: feat_idx,
            threshold,
            left_delta,
            right_delta,
        }
    }
}

/// Gauss-Jordan matrix inversion for N x N matrix.
fn invert_matrix<const N: usize>(mat: &[Vec<f64>]) -> Vec<Vec<f64>> {
    let mut a = mat.to_vec();
    let mut inv = vec![vec![0.0f64; N]; N];
    for i in 0..N {
        inv[i][i] = 1.0;
    }

    for i in 0..N {
        // Find pivot
        let mut max_row = i;
        for k in (i + 1)..N {
            if a[k][i].abs() > a[max_row][i].abs() {
                max_row = k;
            }
        }
        a.swap(i, max_row);
        inv.swap(i, max_row);

        let pivot = a[i][i];
        let pivot_safe = if pivot.abs() < 1e-12 { 1e-12 } else { pivot };

        for j in 0..N {
            a[i][j] /= pivot_safe;
            inv[i][j] /= pivot_safe;
        }

        for k in 0..N {
            if k != i {
                let factor = a[k][i];
                for j in 0..N {
                    a[k][j] -= factor * a[i][j];
                    inv[k][j] -= factor * inv[i][j];
                }
            }
        }
    }

    inv
}
