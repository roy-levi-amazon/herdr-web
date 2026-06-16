mod agent_resume;
mod api;
mod build_info;
mod config;
mod input;
mod ipc;
mod logging;
mod protocol;
mod raw_input;
mod server;
mod session;
mod sound;
mod web_bridge;
mod workspace;

fn main() -> std::io::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(web_bridge::run_command(&args)?);
}
