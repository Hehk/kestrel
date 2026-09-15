//! Reproducible synthetic metadata growth/candidate-copy measurement, not a production benchmark.
use review_core::*;
use std::time::Instant;

fn main() -> Result<()> {
    let mut workspace = Workspace::new()?;
    let started = Instant::now();
    for index in 0..1000 {
        let target = Target {
            snapshot: "snapshot:1".into(),
            version: format!("file:{}", index % 100),
        };
        let actor = Actor::Agent {
            agent: "agent:1".into(),
            run: format!("run:{index}"),
        };
        workspace = workspace.command(&CommandRequest {
            command: Command::Assess {
                assessment: Assessment {
                    id: format!("assessment:{index}"),
                    target: target.clone(),
                    agent: "agent:1".into(),
                    run: format!("run:{index}"),
                    stream: "security".into(),
                    importance: AssessmentValue::Unimportant,
                    evidence: vec![format!("evidence:{index}")],
                    supersedes: (index >= 100).then(|| format!("assessment:{}", index - 100)),
                },
            },
            displayed: target,
            actor,
        })?;
        if index == 99 || index == 999 {
            let snapshot = workspace.snapshot()?;
            let load = Instant::now();
            let restored = Workspace::restore_trusted(&snapshot)?;
            let load_time = load.elapsed();
            let projection = Instant::now();
            let view = restored.view("file:0", Some("security"))?;
            println!("{} contributions: {} snapshot bytes; {:?} restore; {:?} one-file projection ({} assessments); {:?} cumulative commands", index + 1, snapshot.len(), load_time, projection.elapsed(), view.assessments.len(), started.elapsed());
        }
    }
    Ok(())
}
