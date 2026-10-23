//! Forgehammer: CLI Hammer Runner
//! Knocks off raw trajectory impurities and forges an ultra-fast Blade CPU.

use std::env;
use std::fs;
use std::time::Instant;

use hammer::loader::load_ore;
use hammer::smith::emit_blade_rust;
use hammer::strike::HammerStrike;
use tusk_harvester::ring_buffer::StepRecord;

const DEMO_FEAT_N: usize = 8;
const DEMO_ACT_N: usize = 4;

fn main() {
    let args: Vec<String> = env::args().collect();

    println!("============================================================");
    println!(" [FORGEHAMMER] Anvil & Hammer Strike Engine");
    println!(" Knocking off impurities -> Forging ultra-fast Blade");
    println!("============================================================");

    if args.len() > 1 && args[1] != "--demo" {
        // CLI file mode
        let input_path = &args[1];
        let output_path = if args.len() > 2 {
            &args[2]
        } else {
            "blade_generated.rs"
        };

        println!("[Ore] Loading raw trajectory from: {}", input_path);
        let ore = load_ore::<DEMO_FEAT_N, _>(input_path).expect("Failed to load raw ore");
        println!("[Ore] Loaded {} raw records.", ore.len());

        let hammer = HammerStrike::<DEMO_FEAT_N, DEMO_ACT_N>::default();
        let start = Instant::now();
        let rule = hammer.strike(&ore);
        println!("[Hammer] Forged in {:?}", start.elapsed());

        let code = emit_blade_rust(&rule);
        fs::write(output_path, code).expect("Failed to write blade output");
        println!("[Smith] Blade forged and written to: {}", output_path);
        return;
    }

    // Demo Mode
    println!("[Demo] Generating raw simulated ore (1,000 steps)...");
    let mut ore = Vec::new();
    for i in 0..1000 {
        let mut feats = [0.0f32; DEMO_FEAT_N];
        for f in 0..DEMO_FEAT_N {
            feats[f] = ((i * 7 + f * 13) % 100) as f32 / 100.0 - 0.5;
        }

        // True rule: if feat[0] + feat[1] > 0 action 2 else 0
        let good_act = if feats[0] + feats[1] > 0.0 { 2 } else { 0 };
        // Randomly explore other actions
        let taken_act = if i % 5 == 0 { (i % 4) as u8 } else { good_act };

        // Positive advantage if matched good action, negative otherwise
        let advantage = if taken_act == good_act {
            1.5 + (i % 10) as f32 * 0.1
        } else {
            -1.0 - (i % 5) as f32 * 0.2
        };

        ore.push(StepRecord::<DEMO_FEAT_N>::new(
            feats,
            advantage,
            advantage * 2.0,
            advantage * 0.5,
            taken_act,
        ));
    }

    println!("[Hammer] Striking ore with Advantage-Weighted Regression...");
    let hammer = HammerStrike::<DEMO_FEAT_N, DEMO_ACT_N>::default();
    let start_strike = Instant::now();
    let rule = hammer.strike(&ore);
    let strike_duration = start_strike.elapsed();

    println!("[Hammer] Strike complete in {:?}", strike_duration);
    println!("[Smith] Forging Blade source code...");
    let blade_code = emit_blade_rust(&rule);

    let blade_path = "blade_demo.rs";
    fs::write(blade_path, &blade_code).expect("Failed to write demo blade");
    println!("[Smith] Blade saved to: {}", blade_path);

    // Benchmarking generated rule evaluation speed
    println!("\n[Benchmark] Testing evaluation latency (1,000,000 inferences)...");
    let test_feats = [0.25f32, 0.30f32, -0.1f32, 0.0f32, 0.1f32, -0.2f32, 0.05f32, -0.05f32];
    
    let bench_start = Instant::now();
    let mut sum_act = 0usize;
    for _ in 0..1_000_000 {
        // Direct linear + stump eval
        let mut scores = [0.0f32; DEMO_ACT_N];
        for a in 0..DEMO_ACT_N {
            let mut sum = 0.0f32;
            for f in 0..DEMO_FEAT_N {
                sum += rule.linear_weights[a][f] * test_feats[f];
            }
            scores[a] = sum;
        }
        for s in &rule.stumps {
            let val = test_feats[s.feature_idx];
            let delta = if val <= s.threshold { &s.left_delta } else { &s.right_delta };
            for a in 0..DEMO_ACT_N {
                scores[a] += delta[a];
            }
        }
        let mut best = 0;
        let mut max_s = f32::NEG_INFINITY;
        for a in 0..DEMO_ACT_N {
            if scores[a] > max_s {
                max_s = scores[a];
                best = a;
            }
        }
        sum_act = sum_act.wrapping_add(best);
    }
    let total_time = bench_start.elapsed();
    let per_infer_ns = (total_time.as_nanos() as f64) / 1_000_000.0;
    let per_infer_us = per_infer_ns / 1_000.0;

    println!("------------------------------------------------------------");
    println!(" Total Time:      {:?} (checksum: {})", total_time, sum_act);
    println!(" Latency / Infer: {:.2} ns ({:.5} microsec / {:.6} ms)", per_infer_ns, per_infer_us, per_infer_us / 1000.0);
    println!(" Inferences/sec:  {:.1} M ops/s", 1000.0 / per_infer_ns);
    println!(" Target Met:      {} (< 0.001 ms / 1 microsec)", if per_infer_us < 1.0 { "SUCCESS! [PASS]" } else { "FAIL" });
    println!("------------------------------------------------------------");
}
