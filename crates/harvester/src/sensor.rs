use core::sync::atomic::{AtomicU64, Ordering};

/// Default standard deviation for simulated visual jitter (GamersEYE).
pub const DEFAULT_NOISE_SIGMA: f32 = 0.02;

/// Trait for feature extraction from raw state with optional visual jitter noise.
pub trait FeatureSensor<RawState, const FEAT_N: usize> {
    fn extract(&self, raw: &RawState, noise_sigma: f32, out_features: &mut [f32; FEAT_N]);
}

/// Fast, lightweight zero-allocation 64-bit XorShift pseudo-random number generator.
#[repr(C, align(16))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct XorShift64 {
    state: u64,
}

impl XorShift64 {
    pub const DEFAULT_SEED: u64 = 0x8a5cd789635d2dff;

    #[inline(always)]
    pub const fn new(seed: u64) -> Self {
        let state = if seed == 0 { Self::DEFAULT_SEED } else { seed };
        Self { state }
    }

    #[inline(always)]
    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.state;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.state = x;
        x
    }

    #[inline(always)]
    pub fn next_f32_signed(&mut self) -> f32 {
        let v = (self.next_u64() >> 40) as u32;
        (v as f32 / 16777216.0f32) - 0.5f32
    }

    /// Irwin-Hall approximation for standard normal distribution N(0, 1).
    #[inline(always)]
    pub fn next_gaussian(&mut self) -> f32 {
        let mut sum = 0.0f32;
        let mut i = 0;
        while i < 12 {
            sum += self.next_f32_signed();
            i += 1;
        }
        sum
    }
}

/// In-place noise injection for fixed-size feature arrays.
#[inline(always)]
pub fn inject_noise_inplace<const N: usize>(
    features: &mut [f32; N],
    sigma: f32,
    rng: &mut XorShift64,
) {
    if sigma <= 0.0 {
        return;
    }
    for feat in features.iter_mut() {
        *feat += rng.next_gaussian() * sigma;
    }
}

/// In-place noise injection for dynamically sized feature slices.
#[inline(always)]
pub fn inject_noise_slice(features: &mut [f32], sigma: f32, rng: &mut XorShift64) {
    if sigma <= 0.0 {
        return;
    }
    for feat in features.iter_mut() {
        *feat += rng.next_gaussian() * sigma;
    }
}

/// Lock-free mock visual sensor implementing `FeatureSensor` with atomic PRNG state.
#[repr(C, align(16))]
#[derive(Debug)]
pub struct MockFeatureSensor {
    prng_state: AtomicU64,
}

impl MockFeatureSensor {
    #[inline(always)]
    pub const fn new(seed: u64) -> Self {
        let state = if seed == 0 { XorShift64::DEFAULT_SEED } else { seed };
        Self {
            prng_state: AtomicU64::new(state),
        }
    }

    #[inline(always)]
    pub fn next_u64(&self) -> u64 {
        let mut current = self.prng_state.load(Ordering::Relaxed);
        loop {
            let mut next = current;
            next ^= next << 13;
            next ^= next >> 7;
            next ^= next << 17;
            match self.prng_state.compare_exchange_weak(
                current,
                next,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => return next,
                Err(actual) => current = actual,
            }
        }
    }

    #[inline(always)]
    pub fn next_f32_signed(&self) -> f32 {
        let v = (self.next_u64() >> 40) as u32;
        (v as f32 / 16777216.0f32) - 0.5f32
    }

    #[inline(always)]
    pub fn next_gaussian(&self) -> f32 {
        let mut sum = 0.0f32;
        let mut i = 0;
        while i < 12 {
            sum += self.next_f32_signed();
            i += 1;
        }
        sum
    }
}

impl<const FEAT_N: usize> FeatureSensor<[f32; FEAT_N], FEAT_N> for MockFeatureSensor {
    #[inline]
    fn extract(
        &self,
        raw: &[f32; FEAT_N],
        noise_sigma: f32,
        out_features: &mut [f32; FEAT_N],
    ) {
        *out_features = *raw;
        if noise_sigma > 0.0 {
            for feat in out_features.iter_mut() {
                *feat += self.next_gaussian() * noise_sigma;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_xorshift64_deterministic() {
        let mut rng1 = XorShift64::new(12345);
        let mut rng2 = XorShift64::new(12345);
        for _ in 0..100 {
            assert_eq!(rng1.next_u64(), rng2.next_u64());
        }
    }

    #[test]
    fn test_mock_sensor_zero_sigma() {
        let sensor = MockFeatureSensor::new(42);
        let raw = [1.0f32, 2.0f32, 3.0f32, 4.0f32];
        let mut out = [0.0f32; 4];
        sensor.extract(&raw, 0.0, &mut out);
        assert_eq!(raw, out);
    }

    #[test]
    fn test_mock_sensor_noise_injection() {
        let sensor = MockFeatureSensor::new(42);
        let raw = [1.0f32; 8];
        let mut out = [0.0f32; 8];
        sensor.extract(&raw, DEFAULT_NOISE_SIGMA, &mut out);
        let mut changed = false;
        for i in 0..8 {
            if (out[i] - raw[i]).abs() > 1e-6 {
                changed = true;
            }
        }
        assert!(changed, "Noise should alter feature values when sigma > 0");
    }
}
