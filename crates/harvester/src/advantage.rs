//! SPEC-042: Generalized Advantage Estimation (GAE) and Top Quantile Filtering

#[repr(C, align(16))]
#[derive(Debug, Clone, Copy)]
pub struct AdvantageFilter {
    pub threshold_ema: f32,
    pub quantile_target: f32,
    pub decay: f32,
}

impl AdvantageFilter {
    #[inline]
    pub const fn new(quantile_target: f32, decay: f32) -> Self {
        Self {
            threshold_ema: 0.0,
            quantile_target,
            decay,
        }
    }

    #[inline]
    pub fn threshold(&self) -> f32 {
        self.threshold_ema
    }

    #[inline]
    pub fn should_keep(&mut self, score: f32) -> bool {
        let keep = score >= self.threshold_ema;
        let tau = if self.quantile_target < 0.5 {
            1.0 - self.quantile_target
        } else {
            self.quantile_target
        };
        let weight = if keep { tau } else { 1.0 - tau };
        self.threshold_ema += self.decay * weight * (score - self.threshold_ema);
        keep
    }
}

impl Default for AdvantageFilter {
    #[inline]
    fn default() -> Self {
        Self::new(0.85, 0.01)
    }
}

/// Computes Generalized Advantage Estimation (GAE) in-place over a trajectory.
///
/// Iterates backwards from trajectory end, updating `step.advantage` and
/// returns the undiscounted total episode return.
pub fn calculate_gae_in_place<const N: usize>(
    trajectory: &mut [crate::ring_buffer::StepRecord<N>],
    gamma: f32,
    lambda: f32,
) -> f32 {
    if trajectory.is_empty() {
        return 0.0;
    }

    let mut gae = 0.0f32;
    let mut total_return = 0.0f32;
    let mut next_value = 0.0f32;

    for step in trajectory.iter_mut().rev() {
        total_return += step.reward;
        let delta = step.reward + gamma * next_value - step.value;
        gae = delta + gamma * lambda * gae;
        step.advantage = gae;
        next_value = step.value;
    }

    total_return
}
