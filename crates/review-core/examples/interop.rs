//! File-based native/official-JS interop harness; never used by the application.
use std::{env, fs, path::Path};

use review_core::*;

fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = env::args().collect();
    let dir = Path::new(&args[2]);
    let target = Target {
        snapshot: "snapshot:1".into(),
        version: "file:v1".into(),
    };
    match args[1].as_str() {
        "emit" => {
            let base = Workspace::new()?;
            fs::write(dir.join("rust.snapshot"), base.snapshot()?)?;
            fs::write(dir.join("rust.vv"), base.version())?;
            let changed = base.command(&CommandRequest {
                command: Command::Review {
                    target: target.clone(),
                    reviewed: true,
                },
                actor: Actor::Human,
                displayed: target,
            })?;
            fs::write(
                dir.join("rust.update"),
                changed.updates_since(&base.version())?,
            )?;
            fs::write(dir.join("rust-after.snapshot"), changed.snapshot()?)?;
        }
        "verify" => {
            let base = Workspace::restore_trusted(&fs::read(dir.join("rust-after.snapshot"))?)?;
            let merged = base.import_trusted(&fs::read(dir.join("js.update"))?)?;
            let restored = Workspace::restore_trusted(&fs::read(dir.join("js.snapshot"))?)?;
            let view = merged.view("file:v1", Some("security"))?;
            assert_eq!(view, restored.view("file:v1", Some("security"))?);
            assert!(view.reviewed);
            assert!(!view.collapsed);
            assert_eq!(view.effective_importance, Some(AssessmentValue::Important));
            assert!(merged.covers(&fs::read(dir.join("js.vv"))?)?);
            let changed = merged.command(&CommandRequest {
                command: Command::Review {
                    target: target.clone(),
                    reviewed: false,
                },
                actor: Actor::Human,
                displayed: target,
            })?;
            fs::write(
                dir.join("rust-reply.update"),
                changed.updates_since(&merged.version())?,
            )?;
            fs::write(dir.join("rust-reply.vv"), changed.version())?;
        }
        _ => panic!("expected emit or verify"),
    }
    Ok(())
}
