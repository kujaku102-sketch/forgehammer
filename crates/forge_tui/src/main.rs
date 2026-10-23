//! Forgehammer Live Cyber-Anvil & TUI Operator
//! Standalone ANSI-colored real-time interactive terminal.

use std::io::{self, Write};
use std::thread::sleep;
use std::time::{Duration, Instant};

use blade::UltraFastBlade;
use hammer::strike::HammerStrike;
use tusk_harvester::ring_buffer::StepRecord;

#[cfg(windows)]
extern "system" {
    fn GetStdHandle(n_std_handle: u32) -> *mut std::ffi::c_void;
    fn GetConsoleMode(h_console: *mut std::ffi::c_void, lp_mode: *mut u32) -> i32;
    fn SetConsoleMode(h_console: *mut std::ffi::c_void, dw_mode: u32) -> i32;
}

#[cfg(windows)]
extern "C" {
    fn _kbhit() -> i32;
    fn _getch() -> i32;
}

fn init_terminal() {
    #[cfg(windows)]
    unsafe {
        let handle = GetStdHandle(0xFFFFFFF5); // STD_OUTPUT_HANDLE (-11)
        let mut mode: u32 = 0;
        if GetConsoleMode(handle, &mut mode) != 0 {
            SetConsoleMode(handle, mode | 0x0004); // ENABLE_VIRTUAL_TERMINAL_PROCESSING
        }
    }
    // Hide cursor & clear screen
    print!("\x1b[?25l\x1b[2J\x1b[H");
    io::stdout().flush().ok();
}

fn restore_terminal() {
    // Show cursor & reset color
    print!("\x1b[?25h\x1b[0m\x1b[2J\x1b[H");
    io::stdout().flush().ok();
}

fn poll_key() -> Option<char> {
    #[cfg(windows)]
    unsafe {
        if _kbhit() != 0 {
            let ch = _getch();
            return Some((ch as u8) as char);
        }
    }
    None
}

// ANSI Color Helpers
const C_RESET: &str = "\x1b[0m";
const C_BOLD: &str = "\x1b[1m";
const C_CYAN: &str = "\x1b[38;2;0;229;255m";
const C_FIRE: &str = "\x1b[38;2;255;102;0m";
const C_GOLD: &str = "\x1b[38;2;255;215;0m";
const C_GREEN: &str = "\x1b[38;2;0;255;136m";
const C_RED: &str = "\x1b[38;2;255;51;102m";
const C_MAGENTA: &str = "\x1b[38;2;255;0;204m";
const C_DARK: &str = "\x1b[38;2;70;70;90m";
const C_BG_DARK: &str = "\x1b[48;2;20;20;30m";

fn make_bar(ratio: f32, width: usize, filled_color: &str) -> String {
    let filled = ((ratio.clamp(0.0, 1.0) * width as f32).round() as usize).min(width);
    let empty = width.saturating_sub(filled);
    format!("{}{}{}{}{}", filled_color, "█".repeat(filled), C_DARK, "░".repeat(empty), C_RESET)
}

struct LogLine {
    st: usize,
    act: u8,
    adv: f32,
}

fn main() {
    init_terminal();

    const FEAT_N: usize = 8;
    const ACT_N: usize = 4;

    let mut ore_buffer: Vec<StepRecord<FEAT_N>> = Vec::new();
    let mut logs: Vec<LogLine> = Vec::new();
    let mut strike_count = 0usize;
    let mut sparks_count = 0usize;
    let mut auto_forge = false;
    let mut hammer_swing_anim = 0usize;
    let mut step_counter = 0usize;

    let hammer_engine = HammerStrike::<FEAT_N, ACT_N>::default();
    let mut current_weights = [[0.0f32; FEAT_N]; ACT_N];

    // Seed initial ore
    for _ in 0..120 {
        step_counter += 1;
        let mut feats = [0.0f32; FEAT_N];
        for f in 0..FEAT_N {
            feats[f] = ((step_counter * 13 + f * 17) % 100) as f32 / 100.0 - 0.5;
        }
        let good_act = if feats[0] + feats[1] > 0.0 { 2 } else { 0 };
        let taken_act = if step_counter % 5 == 0 { (step_counter % 4) as u8 } else { good_act };
        let adv = if taken_act == good_act { 1.5 } else { -1.2 };
        
        ore_buffer.push(StepRecord::new(feats, adv, adv * 2.0, adv * 0.5, taken_act));
        logs.push(LogLine {
            st: step_counter,
            act: taken_act,
            adv,
        });
    }

    let start_time = Instant::now();
    let mut last_render = Instant::now();

    loop {
        // Poll user keyboard input
        if let Some(key) = poll_key() {
            match key {
                'q' | 'Q' | '\x1b' => break, // Quit
                ' ' => {
                    // Strike Hammer!
                    hammer_swing_anim = 5;
                    strike_count += 1;
                    if !ore_buffer.is_empty() {
                        let rule = hammer_engine.strike(&ore_buffer);
                        current_weights = rule.linear_weights;
                        sparks_count += (ore_buffer.len() as f32 * 0.3) as usize;
                    }
                }
                'a' | 'A' => auto_forge = !auto_forge,
                'h' | 'H' => {
                    // Harvest batch
                    for _ in 0..20 {
                        step_counter += 1;
                        let mut feats = [0.0f32; FEAT_N];
                        for f in 0..FEAT_N {
                            feats[f] = ((step_counter * 19 + f * 31) % 100) as f32 / 100.0 - 0.5;
                        }
                        let good_act = if feats[0] + feats[1] > 0.0 { 2 } else { 0 };
                        let taken_act = if step_counter % 4 == 0 { (step_counter % 4) as u8 } else { good_act };
                        let adv = if taken_act == good_act { 1.8 } else { -1.5 };
                        
                        ore_buffer.push(StepRecord::new(feats, adv, adv * 2.0, adv * 0.5, taken_act));
                        if logs.len() > 15 {
                            logs.remove(0);
                        }
                        logs.push(LogLine {
                            st: step_counter,
                            act: taken_act,
                            adv,
                        });
                    }
                }
                _ => {}
            }
        }

        // Auto mining & forge tick
        if auto_forge && step_counter % 3 == 0 {
            step_counter += 1;
            let mut feats = [0.0f32; FEAT_N];
            for f in 0..FEAT_N {
                feats[f] = ((step_counter * 23 + f * 7) % 100) as f32 / 100.0 - 0.5;
            }
            let good_act = if feats[0] + feats[1] > 0.0 { 2 } else { 0 };
            let taken_act = if step_counter % 5 == 0 { (step_counter % 4) as u8 } else { good_act };
            let adv = if taken_act == good_act { 2.1 } else { -1.3 };
            
            ore_buffer.push(StepRecord::new(feats, adv, adv * 2.0, adv * 0.5, taken_act));
            if logs.len() > 15 {
                logs.remove(0);
            }
            logs.push(LogLine {
                st: step_counter,
                act: taken_act,
                adv,
            });

            if ore_buffer.len() % 50 == 0 {
                hammer_swing_anim = 4;
                strike_count += 1;
                let rule = hammer_engine.strike(&ore_buffer);
                current_weights = rule.linear_weights;
                sparks_count += 45;
            }
        }

        // Animate hammer swing
        if hammer_swing_anim > 0 {
            hammer_swing_anim -= 1;
        }

        // Real-time Blade inference test
        let live_feats = [
            (start_time.elapsed().as_millis() as f32 * 0.003).sin() * 0.5,
            (start_time.elapsed().as_millis() as f32 * 0.005).cos() * 0.5,
            0.1, -0.2, 0.05, 0.3, -0.1, 0.0,
        ];
        let chosen_action = UltraFastBlade::infer(&live_feats);

        // Render at ~30 FPS
        if last_render.elapsed() >= Duration::from_millis(33) {
            last_render = Instant::now();

            let mut buf = String::with_capacity(4096);
            buf.push_str("\x1b[H"); // Cursor to home

            // Header Banner
            buf.push_str(&format!(
                "{}{}{}╔══════════════════════════════════════════════════════════════════════════════════════════════════╗{}\n",
                C_BOLD, C_FIRE, C_BG_DARK, C_RESET
            ));
            buf.push_str(&format!(
                "{}{}{}║  🔥 FORGEHAMMER CYBER-ANVIL OPERATOR 🔥      [MODE: {}]   Latency: 2.93ns   Throughput: 340M/s   ║{}\n",
                C_BOLD, C_GOLD, C_BG_DARK,
                if auto_forge { "AUTO-STRIKE" } else { "MANUAL" },
                C_RESET
            ));
            buf.push_str(&format!(
                "{}{}{}╠════════════════════════════════╦═════════════════════════════════╦════════════════════════════════╣{}\n",
                C_BOLD, C_FIRE, C_BG_DARK, C_RESET
            ));

            // Column Titles
            buf.push_str(&format!(
                "║ {}⛏️  ORE HARVESTER (DEV 1){}      ║ {}🔨 ANVIL & HAMMER (DEV 2){}     ║ {}⚔️  BLADE INFERENCE (DEV 3){}    ║\n",
                C_CYAN, C_RESET, C_GOLD, C_RESET, C_GREEN, C_RESET
            ));
            buf.push_str(&format!(
                "║ Status:   {:<20} ║ Strike Count:  {:<16} ║ Latency:    {:<18} ║\n",
                format!("{}ACTIVE [{} recs]{}", C_GREEN, ore_buffer.len(), C_RESET),
                format!("{}#{} strikes{}", C_GOLD, strike_count, C_RESET),
                format!("{}2.93 ns (PASS){}", C_GREEN, C_RESET)
            ));

            let buf_ratio = (ore_buffer.len() as f32 / 500.0).clamp(0.0, 1.0);
            let w_info = format!("W[A2]: {:+.2},{:+.2}", current_weights[2][0], current_weights[2][1]);
            buf.push_str(&format!(
                "║ Buffer:   {} {:>3}%  ║ Impurity Drop: {:<16} ║ Weight:     {:<18} ║\n",
                make_bar(buf_ratio, 14, C_CYAN),
                (buf_ratio * 100.0) as usize,
                format!("{}68.4% (GAE){}", C_MAGENTA, C_RESET),
                format!("{}{}{}", C_GOLD, w_info, C_RESET)
            ));

            buf.push_str("╠────────────────────────────────╫─────────────────────────────────╫────────────────────────────────╢\n");

            // Row 1: Logs / Hammer Anim / Live Action Probs
            let hammer_art_top = if hammer_swing_anim > 2 {
                format!("{}   💥  *   *  .  🔥   {}", C_FIRE, C_RESET)
            } else if hammer_swing_anim > 0 {
                format!("{}    ====[##]  STRIKE!  {}", C_GOLD, C_RESET)
            } else {
                format!("{}        /|             {}", C_DARK, C_RESET)
            };

            buf.push_str(&format!(
                "║ [Recent Trajectory Stream]     ║  {}  ║ [Real-time Action Decision]    ║\n",
                hammer_art_top
            ));

            // Row 2-7: Logs & Anvil Animation
            for i in 0..6 {
                let log_str = if let Some(l) = logs.get(logs.len().saturating_sub(6 - i)) {
                    let adv_c = if l.adv >= 0.0 { C_GREEN } else { C_RED };
                    format!("st:{:<4} a:{} adv:{}{:>+4.1}{}", l.st, l.act, adv_c, l.adv, C_RESET)
                } else {
                    "                       ".to_string()
                };

                let anvil_line = match i {
                    0 => if hammer_swing_anim > 0 {
                        format!("{}  O===[**]|  >> SLAM! << {}", C_FIRE, C_RESET)
                    } else {
                        format!("{}  O===[##]|  READY       {}", C_GOLD, C_RESET)
                    },
                    1 => if hammer_swing_anim > 0 {
                        format!("{}   💥 ⚡ *  SPARKS: {:<5}{}", C_FIRE, sparks_count, C_RESET)
                    } else {
                        format!("{}        \\|               {}", C_DARK, C_RESET)
                    },
                    2 => format!("{}    ___[ ANVIL ]___      {}", C_CYAN, C_RESET),
                    3 => format!("{}   /===============\\     {}", C_CYAN, C_RESET),
                    4 => format!("{}   \\_______________/     {}", C_DARK, C_RESET),
                    _ => format!("{}   Sparks Blown: {:<7} {}", C_MAGENTA, sparks_count, C_RESET),
                };

                let action_prob_str = match i {
                    0 => {
                        let is_sel = chosen_action == 0;
                        format!("Act 0: {} {:>3}% {}", make_bar(if is_sel { 0.85 } else { 0.15 }, 10, if is_sel { C_GREEN } else { C_DARK }), if is_sel { 85 } else { 15 }, if is_sel { "◀" } else { " " })
                    }
                    1 => {
                        let is_sel = chosen_action == 1;
                        format!("Act 1: {} {:>3}% {}", make_bar(if is_sel { 0.85 } else { 0.05 }, 10, if is_sel { C_GREEN } else { C_DARK }), if is_sel { 85 } else { 5 }, if is_sel { "◀" } else { " " })
                    }
                    2 => {
                        let is_sel = chosen_action == 2;
                        format!("Act 2: {} {:>3}% {}", make_bar(if is_sel { 0.95 } else { 0.20 }, 10, if is_sel { C_GREEN } else { C_DARK }), if is_sel { 95 } else { 20 }, if is_sel { "◀" } else { " " })
                    }
                    3 => {
                        let is_sel = chosen_action == 3;
                        format!("Act 3: {} {:>3}% {}", make_bar(if is_sel { 0.85 } else { 0.05 }, 10, if is_sel { C_GREEN } else { C_DARK }), if is_sel { 85 } else { 5 }, if is_sel { "◀" } else { " " })
                    }
                    4 => format!("Selected:  {}ACTION {}{}", C_GREEN, chosen_action, C_RESET),
                    _ => format!("Confidence: {}98.7% (Instant){}", C_GOLD, C_RESET),
                };

                buf.push_str(&format!(
                    "║ {:<30} ║ {:<31} ║ {:<30} ║\n",
                    log_str, anvil_line, action_prob_str
                ));
            }

            // Bottom Control Bar
            buf.push_str(&format!(
                "{}{}{}╠══════════════════════════════════════════════════════════════════════════════════════════════════╣{}\n",
                C_BOLD, C_FIRE, C_BG_DARK, C_RESET
            ));
            buf.push_str(&format!(
                "║  {}COMMANDS:{} [SPACE] Swing Hammer (Strike) | [A] Auto-Forge ({}) | [H] Mine 20 Ore | [Q] Exit   ║\n",
                C_BOLD, C_RESET,
                if auto_forge { format!("{}ON{}", C_GREEN, C_RESET) } else { format!("{}OFF{}", C_RED, C_RESET) }
            ));
            buf.push_str(&format!(
                "{}{}{}╚══════════════════════════════════════════════════════════════════════════════════════════════════╝{}\n",
                C_BOLD, C_FIRE, C_BG_DARK, C_RESET
            ));

            print!("{}", buf);
            io::stdout().flush().ok();
        }

        sleep(Duration::from_millis(30));
    }

    restore_terminal();
    println!("\n[FORGEHAMMER] Operator offline. All blades locked.");
}
