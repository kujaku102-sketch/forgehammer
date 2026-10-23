//! Auto-forged by Forgehammer (Anvil & Hammer)
//! Latency target: < 1 microsecond (0.001ms), Zero heap allocations.

pub const FEAT_N: usize = 8;
pub const ACT_N: usize = 4;

/// Forged linear weights: [ACT_N][FEAT_N]
pub static LINEAR_WEIGHTS: [[f32; FEAT_N]; ACT_N] = [
    [-0.875203_f32, -1.151111_f32, -0.514187_f32, -0.635927_f32, 0.189626_f32, -0.247106_f32, -0.628152_f32, -0.457522_f32],
    [0.000000_f32, 0.000000_f32, 0.000000_f32, 0.000000_f32, 0.000000_f32, 0.000000_f32, 0.000000_f32, 0.000000_f32],
    [0.612865_f32, 0.682860_f32, 0.216231_f32, 0.105679_f32, -0.588264_f32, -0.050543_f32, 0.101988_f32, 0.119908_f32],
    [0.000000_f32, 0.000000_f32, 0.000000_f32, 0.000000_f32, 0.000000_f32, 0.000000_f32, 0.000000_f32, 0.000000_f32],
];

/// Forged decision stump adjustments
#[derive(Clone, Copy, Debug)]
pub struct Stump {
    pub feat_idx: usize,
    pub threshold: f32,
    pub left: [f32; ACT_N],
    pub right: [f32; ACT_N],
}

pub static STUMPS: [Stump; 1] = [
    Stump {
        feat_idx: 0,
        threshold: 0.010000_f32,
        left: [0.432607_f32, 0.000000_f32, 0.067393_f32, 0.000000_f32],
        right: [0.076325_f32, 0.000000_f32, 0.423675_f32, 0.000000_f32],
    },
];

pub struct UltraFastBlade;

impl UltraFastBlade {
    /// Executes instant inference in < 0.001ms with zero heap allocation.
    #[inline(always)]
    pub fn infer(features: &[f32; FEAT_N]) -> usize {
        let mut scores = [0.0f32; ACT_N];

        // 1. Linear evaluation (SIMD unrolled)
        for a in 0..ACT_N {
            let mut sum = 0.0f32;
            for f in 0..FEAT_N {
                sum += LINEAR_WEIGHTS[a][f] * features[f];
            }
            scores[a] = sum;
        }

        // 2. Decision stump edge sharpening
        for stump in &STUMPS {
            let val = features[stump.feat_idx];
            let delta = if val <= stump.threshold { &stump.left } else { &stump.right };
            for a in 0..ACT_N {
                scores[a] += delta[a];
            }
        }

        // 3. Argmax action selection
        let mut best_act = 0;
        let mut max_score = f32::NEG_INFINITY;
        for a in 0..ACT_N {
            if scores[a] > max_score {
                max_score = scores[a];
                best_act = a;
            }
        }
        best_act
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_blade_inference_accuracy() {
        // High positive features should trigger Action 2
        let pos_feats = [0.4f32, 0.4f32, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        assert_eq!(UltraFastBlade::infer(&pos_feats), 2);

        // Low negative features should trigger Action 0
        let neg_feats = [-0.4f32, -0.4f32, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        assert_eq!(UltraFastBlade::infer(&neg_feats), 0);
    }
}
