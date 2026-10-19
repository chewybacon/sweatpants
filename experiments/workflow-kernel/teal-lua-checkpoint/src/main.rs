mod json;
mod runtime;
use std::io::{self, Read};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Each command owns a fresh VM. A completed command leaves no native continuation alive.
    let mut bytes = Vec::new();
    io::stdin()
        .take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("command byte budget exceeded".into());
    }
    let command = serde_json::from_slice(&bytes)?;
    let state = runtime::execute(command)?;
    let output = serde_json::to_string(&state)?;
    if output.len() > 4 * 1024 * 1024 {
        return Err("checkpoint byte budget exceeded".into());
    }
    println!("{output}");
    Ok(())
}
