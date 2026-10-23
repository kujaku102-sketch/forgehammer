use tusk_harvester::*;

#[test]
fn test_linear_policy_eval() {
    let policy = LinearPolicy::<4, 2>::new([
        [1.0, 2.0, 3.0, 4.0],
        [4.0, 3.0, 2.0, 1.0],
    ]);
    let feats = [1.0, 1.0, 1.0, 1.0];
    let mut scores = [0.0; 2];
    policy.eval(&feats, &mut scores);

    assert_eq!(scores[0], 10.0);
    assert_eq!(scores[1], 10.0);
}

#[test]
fn test_ring_buffer_zero_alloc() {
    let mut buf = EpisodeRingBuffer::<4, 10>::new();
    assert_eq!(buf.len(), 0);
    assert!(buf.is_empty());

    for i in 0..10 {
        buf.push(StepRecord::new([i as f32; 4], 0.0, 1.0, 0.0, i as u8));
    }
    assert_eq!(buf.len(), 10);
    assert!(buf.is_full());

    // Push when full should be ignored (no reallocation)
    buf.push(StepRecord::new([99.0; 4], 0.0, 1.0, 0.0, 99));
    assert_eq!(buf.len(), 10);
    assert_eq!(buf.as_slice()[9].action, 9);

    buf.clear();
    assert_eq!(buf.len(), 0);
}

#[test]
fn test_gae_and_filter() {
    let mut traj = [
        StepRecord::new([0.0; 2], 0.0, 1.0, 2.0, 0),
        StepRecord::new([0.0; 2], 0.0, 2.0, 1.0, 1),
        StepRecord::new([0.0; 2], 0.0, 3.0, 0.0, 0),
    ];
    let total_return = calculate_gae_in_place(&mut traj, 0.99, 0.95);
    assert_eq!(total_return, 6.0);
    assert!(traj[0].advantage > 0.0);

    let mut filter = AdvantageFilter::new(0.85, 0.1);
    let kept = filter.should_keep(total_return);
    assert!(kept);
}
