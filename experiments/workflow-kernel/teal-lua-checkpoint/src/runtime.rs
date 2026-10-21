use crate::json::{from_json, to_json};
use piccolo::{
    thread::checkpoint::{self, Snapshot, SavedFrame, Node},
    Callback, CallbackReturn, Closure, Executor, ExecutorMode, Fuel, Function, Lua, Table, Thread,
    ThreadMode, Value,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};
use sha2::{Digest, Sha256};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

const PRELUDE: &str = include_str!("../prelude.lua");
const MEMORY: usize = 32 * 1024 * 1024;
const CANCEL: &str = "__workflow_cancelled__";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Command {
    source: String,
    #[serde(default = "default_fuel")]
    fuel: u32,
    action: Action,
    #[serde(default)]
    input: Json,
    #[serde(default)]
    reply: Json,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    state: Option<State>,
}
#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Validate,
    Start,
    Restore,
    Resume,
    Continue,
    Reject,
    Cancel,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct State {
    program: String,
    vm: Option<Snapshot>,
    pub boundary: Json,
    cancelling: bool,
    reason: Option<String>,
    cleanup_depth: u32,
    calls: Vec<String>,
    fuel_used: u64,
}
fn default_fuel() -> u32 { 100_000 }

fn error<'gc>(ctx: piccolo::Context<'gc>, text: String) -> piccolo::Error<'gc> {
    Value::String(ctx.intern(text.as_bytes())).into()
}

pub fn execute(mut command: Command) -> Result<State, String> {
    if command.fuel == 0 || command.fuel > 1_000_000 { return Err("invalid fuel slice".into()); }
    let mut fuel_used = command.state.as_ref().map_or(0, |s| s.fuel_used);
    if command.source.len() > 64000 {
        return Err("Lua source exceeds 64KB".into());
    }
    let source = format!("{PRELUDE}\n{}", command.source);
    let program = format!(
        "{:x}",
        Sha256::digest(format!("piccolo-runtime-4;{source}"))
    );
    if command.action == Action::Validate {
        let mut lua = Lua::empty();
        lua.enter(|ctx| Closure::load_with_env(ctx, Some("workflow.lua"), source.as_bytes(), Table::new(&ctx)).map(|_| ()).map_err(|e| e.to_string()))?;
        return Ok(State { program, vm: None, boundary: json!({"kind":"completed","value":null}), cancelling:false, reason:None, cleanup_depth:0, calls:Vec::new(), fuel_used });
    }
    if command.action == Action::Start && command.state.is_some() {
        return Err("start must not contain state".into());
    }
    if command.action != Action::Start && command.state.is_none() {
        return Err("command requires state".into());
    }
    if let Some(saved) = command.state.as_ref() {
        if saved.program != program {
            return Err("snapshot source/runtime mismatch".into());
        }
        if saved.cleanup_depth > 32 {
            return Err("invalid cleanup depth".into());
        }
        if saved.vm.is_none() {
            if command.action != Action::Restore {
                return Err("execution is terminal".into());
            }
            return Ok(command.state.take().unwrap());
        }
        if saved.boundary["kind"] != "suspended" && saved.boundary["kind"] != "compute_paused" {
            return Err("invalid suspended state".into());
        }
    }
    if let Some(saved) = &command.state {
        let compute = saved.boundary["kind"] == "compute_paused";
        if (command.action == Action::Continue && !compute)
            || (matches!(command.action, Action::Resume | Action::Reject) && compute) {
            return Err("action does not match Lua boundary".into());
        }
    }
    let mut cancelling = command.state.as_ref().is_some_and(|s| s.cancelling);
    let mut reason = command.state.as_ref().and_then(|s| s.reason.clone());
    let cleanup = Rc::new(Cell::new(
        command.state.as_ref().map_or(0, |s| s.cleanup_depth),
    ));
    let pending = Rc::new(RefCell::new(None::<Json>));
    let skip_cancel = command.action == Action::Cancel && (cancelling || cleanup.get() > 0);
    if command.action == Action::Cancel && !cancelling {
        cancelling = true;
        reason = command.reason.clone();
    }
    let mut lua = Lua::empty();
    // Only a selected subset of base functions is reachable from the guest environment.
    let (thread, executor, root, natives) = lua.enter(|ctx| -> Result<_, String> {
        piccolo::stdlib::load_base(ctx);
        let env = Table::new(&ctx);
        let mut natives = Vec::new();
        for name in ["pcall", "error", "assert", "type"] {
            let callback: Callback = ctx.get_global(name).map_err(|e| e.to_string())?;
            env.set(ctx, name, callback).map_err(|e| e.to_string())?;
            natives.push(callback);
        }
        let effect = Callback::from_fn(&ctx, {
            let pending = pending.clone();
            move |ctx, _, mut stack| {
                let (site, value): (piccolo::String, Value) = stack.consume(ctx)?;
                let site = std::str::from_utf8(site.as_bytes())
                    .map_err(|_| error(ctx, "effect site must be UTF-8".into()))?;
                if site.is_empty() || site.len() > 200 {
                    return Err(error(ctx, "effect site size invalid".into()));
                }
                let value = to_json(value).map_err(|e| error(ctx, e))?;
                pending.replace(Some(json!({"site":site,"request":value})));
                stack.replace(ctx, ());
                Ok(CallbackReturn::Yield {
                    to_thread: None,
                    then: None,
                })
            }
        });
        let enter = Callback::from_fn(&ctx, {
            let depth = cleanup.clone();
            move |ctx, _, mut stack| {
                if depth.get() >= 32 {
                    return Err(error(ctx, "cleanup nesting exceeded".into()));
                }
                depth.set(depth.get() + 1);
                stack.replace(ctx, ());
                Ok(CallbackReturn::Return)
            }
        });
        let leave = Callback::from_fn(&ctx, {
            let depth = cleanup.clone();
            move |ctx, _, mut stack| {
                if depth.get() == 0 {
                    return Err(error(ctx, "cleanup depth underflow".into()));
                }
                depth.set(depth.get() - 1);
                stack.replace(ctx, ());
                Ok(CallbackReturn::Return)
            }
        });
        natives.extend([effect, enter, leave]);
        let workflow = Table::new(&ctx);
        workflow
            .set(ctx, "effect", effect)
            .map_err(|e| e.to_string())?;
        workflow
            .set(ctx, "_enter_cleanup", enter)
            .map_err(|e| e.to_string())?;
        workflow
            .set(ctx, "_leave_cleanup", leave)
            .map_err(|e| e.to_string())?;
        workflow
            .set(ctx, "null", from_json(ctx, &Json::Null)?)
            .map_err(|e| e.to_string())?;
        env.set(ctx, "workflow", workflow)
            .map_err(|e| e.to_string())?;
        let root = Closure::load_with_env(ctx, Some("workflow.lua"), source.as_bytes(), env)
            .map_err(|e| e.to_string())?;
        let protos = checkpoint::prototypes(root.prototype());
        let thread = if let Some(saved) = command.state.as_ref() {
            checkpoint::restore(ctx, saved.vm.as_ref().unwrap(), &program, &protos, &natives)?
        } else {
            let thread = Thread::new(ctx);
            thread
                .start(
                    ctx,
                    Function::Closure(root),
                    from_json(ctx, &command.input)?,
                )
                .map_err(|e| e.to_string())?;
            thread
        };
        if command.action == Action::Resume {
            thread
                .resume(ctx, from_json(ctx, &command.reply)?)
                .map_err(|e| e.to_string())?;
        } else if command.action == Action::Reject {
            thread
                .resume_err(&ctx, from_json(ctx, &command.reply)?.into())
                .map_err(|e| e.to_string())?;
        } else if command.action == Action::Cancel && !skip_cancel {
            let error = Value::String(ctx.intern(CANCEL.as_bytes())).into();
            if thread.mode() == ThreadMode::Normal {
                checkpoint::interrupt(ctx, thread, error)?;
            } else {
                thread.resume_err(&ctx, error).map_err(|e| e.to_string())?;
            }
        }
        let executor = Executor::run(&ctx, thread).map_err(|e| e.to_string())?;
        Ok((
            ctx.stash(thread),
            ctx.stash(executor),
            ctx.stash(root),
            natives
                .into_iter()
                .map(|n| ctx.stash(n))
                .collect::<Vec<_>>(),
        ))
    })?;
    if command.action == Action::Restore || skip_cancel {
        let mut saved = command.state.take().unwrap();
        saved.cancelling = cancelling;
        saved.reason = reason;
        return Ok(saved);
    }
    let mut remaining = i64::from(command.fuel);
    // Finish at a serializable VM boundary; the exposed native callbacks are bounded.
    for _ in 0..2000 {
        let done = lua.enter(|ctx| {
            let exec = ctx.fetch(&executor);
            let amount = if remaining > 0 { remaining.min(1000) as i32 } else { 1 };
            let mut fuel = Fuel::with(amount);
            exec.step(ctx, &mut fuel).map_err(|e| e.to_string())?;
            let consumed = i64::from(amount) - i64::from(fuel.remaining());
            fuel_used += consumed.max(0) as u64;
            remaining -= consumed.max(1);
            Ok::<_, String>(exec.mode() == ExecutorMode::Result
                || (remaining <= 0 && checkpoint::can_capture(ctx.fetch(&thread))))
        })?;
        if lua.total_memory() > MEMORY { return Err("Lua memory budget exceeded".into()); }
        if done { break; }
    }
    lua.enter(|ctx| {
        let exec = ctx.fetch(&executor);
        let thread = ctx.fetch(&thread);
        if exec.mode() != ExecutorMode::Result {
            let native_values = natives.iter().map(|n| ctx.fetch(n)).collect::<Vec<_>>();
            let protos = checkpoint::prototypes(ctx.fetch(&root).prototype());
            let snapshot = checkpoint::capture(ctx, thread, &program, &protos, &native_values)?;
            return Ok(State { program, vm: Some(snapshot), boundary: json!({"kind":"compute_paused"}),
                cancelling, reason, cleanup_depth: cleanup.get(), calls: Vec::new(), fuel_used });
        }
        let result = thread.take_result::<Value>(ctx).map_err(|e|e.to_string())?;
        if thread.mode() == ThreadMode::Suspended {
            result.map_err(|e|e.to_string())?;
            let request = pending.take().ok_or("yield without host request")?;
            let native_values = natives.iter().map(|n|ctx.fetch(n)).collect::<Vec<_>>();
            let protos = checkpoint::prototypes(ctx.fetch(&root).prototype());
            let snapshot = checkpoint::capture(ctx,thread,&program,&protos,&native_values)?;
            let calls = snapshot.threads[0].frames.iter().filter_map(|frame| {
                if let SavedFrame::Lua { closure, .. } = frame {
                    if let Node::Closure { prototype, .. } = &snapshot.nodes[*closure] {
                        return Some(protos[*prototype].reference.map_strings(|name| String::from_utf8_lossy(name.as_bytes()).into_owned()).to_string());
                    }
                }
                None
            }).collect();
            Ok(State { program, vm:Some(snapshot), boundary:json!({"kind":"suspended","request":request}), cancelling,reason,cleanup_depth:cleanup.get(), calls, fuel_used })
        } else {
            let boundary = match result {
                Ok(_) if cancelling => json!({"kind":"cancelled","reason":reason}),
                Ok(value) => match to_json(value) {
                    Ok(value) => json!({"kind":"completed","value":value}),
                    Err(e) => json!({"kind":"failed","error":e}),
                },
                Err(piccolo::Error::Lua(e)) if cancelling && matches!(e.0,Value::String(s) if s.as_bytes() == CANCEL.as_bytes()) => json!({"kind":"cancelled","reason":reason}),
                Err(piccolo::Error::Lua(e)) => json!({"kind":"failed","error":to_json(e.0).unwrap_or_else(|_|json!("non-JSON Lua error"))}),
                Err(e) => json!({"kind":"failed","error":e.to_string()}),
            };
            Ok(State { program, vm:None, boundary, cancelling,reason,cleanup_depth:cleanup.get(), calls:Vec::new(), fuel_used })
        }
    })
}
