// Dev utility: import existing CLAUDE_CONFIG_DIR directories as Sonic profiles
// from the command line, using the exact same code path as the Settings UI.
// Usage: cargo run --example import_profiles -- <name>=<dir> [<name>=<dir> ...]

use sonic_lib::profiles::ProfileRegistry;
use std::path::PathBuf;

fn main() {
    let base = PathBuf::from(std::env::var("HOME").expect("HOME not set"))
        .join("Library/Application Support/com.sonic.app");
    let mut registry = ProfileRegistry::load(&base);
    for arg in std::env::args().skip(1) {
        let Some((name, dir)) = arg.split_once('=') else {
            eprintln!("skipping malformed arg (want name=dir): {arg}");
            continue;
        };
        if registry.profiles().iter().any(|p| p.name == name) {
            println!("already present, skipping: {name}");
            continue;
        }
        match registry.import(name, &PathBuf::from(dir)) {
            Ok(p) => println!(
                "imported {:10} -> {} (hooks_ok: {}, color: {})",
                p.name,
                p.config_dir.display(),
                p.hooks_ok,
                p.color
            ),
            Err(e) => eprintln!("FAILED {name}: {e}"),
        }
    }
}
