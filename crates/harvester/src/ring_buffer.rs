//! SPEC-042: StepRecord and Fixed-Size EpisodeRingBuffer
//!
//! Provides zero-allocation, C-aligned step records and fixed-capacity episode ring buffer.

/// 16-byte aligned step record representing a single transition in an episode.
#[repr(C, align(16))]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StepRecord<const N: usize> {
    pub features: [f32; N],
    pub advantage: f32,
    pub reward: f32,
    pub value: f32,
    pub action: u8,
    pub _pad: [u8; 3],
}

impl<const N: usize> StepRecord<N> {
    pub const ZERO: Self = Self {
        features: [0.0; N],
        advantage: 0.0,
        reward: 0.0,
        value: 0.0,
        action: 0,
        _pad: [0; 3],
    };

    pub const fn new(
        features: [f32; N],
        advantage: f32,
        reward: f32,
        value: f32,
        action: u8,
    ) -> Self {
        Self {
            features,
            advantage,
            reward,
            value,
            action,
            _pad: [0; 3],
        }
    }
}

impl<const N: usize> Default for StepRecord<N> {
    #[inline]
    fn default() -> Self {
        Self::ZERO
    }
}

/// Fixed-capacity episode buffer storing step records with zero heap allocation.
#[derive(Clone, Debug)]
pub struct EpisodeRingBuffer<const N: usize, const MAX_STEPS: usize> {
    buffer: [StepRecord<N>; MAX_STEPS],
    len: usize,
    is_full: bool,
}

impl<const N: usize, const MAX_STEPS: usize> EpisodeRingBuffer<N, MAX_STEPS> {
    /// Creates a new, empty episode ring buffer.
    pub const fn new() -> Self {
        Self {
            buffer: [StepRecord::ZERO; MAX_STEPS],
            len: 0,
            is_full: false,
        }
    }

    /// Pushes a record to the buffer. If the buffer is full, additional pushes are ignored.
    #[inline]
    pub fn push(&mut self, record: StepRecord<N>) {
        if self.len < MAX_STEPS {
            self.buffer[self.len] = record;
            self.len += 1;
            if self.len == MAX_STEPS {
                self.is_full = true;
            }
        }
    }

    /// Clears the buffer, resetting length and full flag.
    #[inline]
    pub fn clear(&mut self) {
        self.len = 0;
        self.is_full = false;
    }

    /// Returns a slice of the stored step records.
    #[inline]
    pub fn as_slice(&self) -> &[StepRecord<N>] {
        &self.buffer[..self.len]
    }

    /// Returns the number of step records currently stored.
    #[inline]
    pub const fn len(&self) -> usize {
        self.len
    }

    /// Returns `true` if the buffer contains no records.
    #[inline]
    pub const fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Returns `true` if the buffer has reached maximum capacity.
    #[inline]
    pub const fn is_full(&self) -> bool {
        self.is_full
    }
}

impl<const N: usize, const MAX_STEPS: usize> Default for EpisodeRingBuffer<N, MAX_STEPS> {
    #[inline]
    fn default() -> Self {
        Self::new()
    }
}
