//! Guest task policy. The host supplies one accepted effect outcome; it never
//! selects a race winner or runs guest cleanup. All stacks share one codec graph.
use crate::boundary_json::{from_json, to_json};
use piccolo::{
    thread::checkpoint::{self, Snapshot},
    Callback, CallbackReturn, Closure, Context, Executor, ExecutorMode, Fuel, Function, Lua, Table,
    Thread, Value, Variadic,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};

const CANCEL: &str = "__workflow_cancelled__";
const MAX_TASKS: usize = 128;
const PRELUDE: &str = include_str!("tasks.lua");

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Completion {
    Value,
    Throw,
    Cancelled,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Status {
    Ready,
    Effect {
        id: u64,
        site: String,
        input: Json,
        cancel: bool,
    },
    Wait {
        mode: String,
        children: Vec<usize>,
        winner: Option<usize>,
    },
    Exiting {
        completion: Completion,
    },
    Done {
        completion: Completion,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Task {
    parent: Option<usize>,
    status: Status,
    cleanup: u32,
    completed_order: Option<u64>,
    abort: Option<(Completion, usize)>,
    unwinding: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct State {
    source: String,
    vm: Snapshot,
    tasks: Vec<Task>,
    next_effect: u64,
    /// Cleanup errors of halted children are observable but do not replace a winner.
    suppressed: Vec<Json>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Command {
    source: String,
    action: String,
    #[serde(default)]
    input: Json,
    #[serde(default)]
    state: Option<State>,
    #[serde(default)]
    id: Option<u64>,
    #[serde(default)]
    outcome: Json,
}

fn step<'gc>(ctx: Context<'gc>, thread: Thread<'gc>) -> Result<Vec<Value<'gc>>, String> {
    let executor = Executor::run(&ctx, thread).map_err(|e| e.to_string())?;
    for _ in 0..100 {
        executor
            .step(ctx, &mut Fuel::with(1000))
            .map_err(|e| e.to_string())?;
        if executor.mode() == ExecutorMode::Result {
            return thread
                .take_result::<Variadic<Vec<Value>>>(ctx)
                .map_err(|e| e.to_string())?
                .map_err(|e| e.to_string())
                .map(|v| v.0);
        }
    }
    Err("guest task fuel budget exceeded".into())
}
fn text(value: Value<'_>) -> Result<String, String> {
    match value {
        Value::String(s) => std::str::from_utf8(s.as_bytes())
            .map(str::to_owned)
            .map_err(|e| e.to_string()),
        _ => Err("expected guest command string".into()),
    }
}
fn done(task: &Task) -> bool {
    matches!(task.status, Status::Done { .. })
}
fn children(tasks: &[Task], parent: usize) -> Vec<usize> {
    tasks
        .iter()
        .enumerate()
        .filter_map(|(i, t)| (t.parent == Some(parent)).then_some(i))
        .collect()
}
fn cancel(tasks: &mut [Task], id: usize, abort: (Completion, usize)) {
    if done(&tasks[id]) || matches!(tasks[id].status, Status::Exiting { .. }) {
        return;
    }
    if tasks[id].abort.is_none() {
        tasks[id].abort = Some(abort);
    }
    if tasks[id].cleanup == 0 && !tasks[id].unwinding {
        if let Status::Effect { cancel, .. } = &mut tasks[id].status {
            *cancel = true;
        }
    }
    for child in children(tasks, id) {
        cancel(tasks, child, (Completion::Cancelled, child));
    }
}
fn resume<'gc>(
    ctx: Context<'gc>,
    thread: Thread<'gc>,
    value: Value<'gc>,
    throw: bool,
) -> Result<(), String> {
    if throw {
        thread.resume_err(&ctx, value.into())
    } else {
        thread.resume(ctx, value)
    }
    .map_err(|e| e.to_string())
}
fn result<'gc>(
    ctx: Context<'gc>,
    threads: &[Thread<'gc>],
    tasks: &[Task],
    id: usize,
) -> Result<Value<'gc>, String> {
    // A completed task is parked in its completion frame. Re-entering that frame
    // only reads its retained guest value; it never re-enters the authored body.
    if let Some((kind, source)) = tasks[id].abort {
        if let Status::Done { completion } = tasks[id].status {
            if completion == kind {
                if kind == Completion::Cancelled {
                    return Ok(Value::String(ctx.intern(CANCEL.as_bytes())));
                }
                if source != id {
                    return result(ctx, threads, tasks, source);
                }
            }
        }
    }
    threads[id].resume(ctx, ()).map_err(|e| e.to_string())?;
    let values = step(ctx, threads[id])?;
    if values.len() != 3 || text(values[0])? != "done" {
        return Err("invalid completion frame".into());
    }
    Ok(values[2])
}
fn interrupt<'gc>(
    ctx: Context<'gc>,
    threads: &[Thread<'gc>],
    tasks: &mut [Task],
    id: usize,
) -> Result<(), String> {
    let (kind, source) = tasks[id].abort.ok_or("missing task interruption")?;
    let value = if kind == Completion::Cancelled {
        Value::String(ctx.intern(CANCEL.as_bytes()))
    } else {
        result(ctx, threads, tasks, source)?
    };
    resume(ctx, threads[id], value, true)?;
    tasks[id].unwinding = true;
    tasks[id].status = Status::Ready;
    Ok(())
}
fn validate(state: &State) -> Result<(), String> {
    let tasks = &state.tasks;
    if tasks.is_empty()
        || tasks.len() > MAX_TASKS
        || state.vm.threads.len() != tasks.len()
        || tasks[0].parent.is_some()
    {
        return Err("invalid task roots".into());
    }
    let mut effects = std::collections::HashSet::new();
    let mut completions = std::collections::HashSet::new();
    for (id, task) in tasks.iter().enumerate() {
        if done(task) != task.completed_order.is_some()
            || task
                .completed_order
                .is_some_and(|n| n >= tasks.len() as u64 || !completions.insert(n))
        {
            return Err("invalid task completion order".into());
        }
        let mut seen = std::collections::HashSet::new();
        let mut cursor = id;
        while let Some((_, source)) = tasks[cursor].abort {
            if source >= tasks.len() {
                return Err("invalid task interruption source".into());
            }
            if source == cursor {
                break;
            }
            if !seen.insert(source) {
                return Err("cyclic task interruption".into());
            }
            cursor = source;
        }
        if (id > 0 && !task.parent.is_some_and(|p| p < id))
            || task.cleanup > 32
            || task.abort.is_some_and(|(_, source)| source >= tasks.len())
        {
            return Err("invalid task ownership".into());
        }
        match &task.status {
            Status::Ready => return Err("checkpoint contains runnable task".into()),
            Status::Effect { id, site, .. } => {
                if *id >= state.next_effect
                    || !effects.insert(*id)
                    || site.is_empty()
                    || site.len() > 200
                {
                    return Err("invalid pending effect".into());
                }
            }
            Status::Wait {
                mode,
                children,
                winner,
            } => {
                let unique: std::collections::HashSet<_> = children.iter().collect();
                if !["join", "all", "race"].contains(&mode.as_str())
                    || children.is_empty()
                    || unique.len() != children.len()
                    || children
                        .iter()
                        .any(|c| *c >= tasks.len() || tasks[*c].parent != Some(id))
                    || winner.is_some_and(|w| !children.contains(&w))
                {
                    return Err("invalid task wait".into());
                }
            }
            _ => {}
        }
    }
    Ok(())
}

pub fn execute(command: Command) -> Result<Json, String> {
    if command.source.len() > 64000 {
        return Err("source budget exceeded".into());
    }
    if !["start", "restore", "settle", "cancel"].contains(&command.action.as_str()) {
        return Err("unknown scheduler command".into());
    }
    if (command.action == "start") != command.state.is_none() {
        return Err("invalid scheduler state argument".into());
    }
    if let Some(state) = &command.state {
        if state.source != command.source {
            return Err("snapshot program mismatch".into());
        }
        validate(state)?;
    }
    let source = format!("{PRELUDE}\n{}\nend)\nreturn root()", command.source);
    let mut lua = Lua::empty();
    let output=lua.enter(|ctx|->Result<Json,String>{
        piccolo::stdlib::load_base(ctx);
        let env=Table::new(&ctx);
        let mut natives=Vec::new();
        for name in ["pcall","error","assert","type"] {
            let native:Callback=ctx.get_global(name).map_err(|e|e.to_string())?;
            env.set(ctx,name,native).map_err(|e|e.to_string())?;
            natives.push(native);
        }
        let command_callback=Callback::from_fn(&ctx,|_,_,_|Ok(CallbackReturn::Yield{to_thread:None,then:None}));
        env.set(ctx,"task_command",command_callback).map_err(|e|e.to_string())?;
        natives.push(command_callback);
        let root=Closure::load_with_env(ctx,Some("scoped.lua"),source.as_bytes(),env).map_err(|e|e.to_string())?;
        let protos=checkpoint::prototypes(root.prototype());
        let (mut threads,mut tasks,mut next_effect,mut suppressed)=if let Some(state)=&command.state {
            (checkpoint::restore_threads(ctx,&state.vm,&source,&protos,&natives)?,state.tasks.clone(),state.next_effect,state.suppressed.clone())
        } else {
            let thread=Thread::new(ctx);
            thread.start(ctx,Function::Closure(root),from_json(ctx,&command.input)?).map_err(|e|e.to_string())?;
            (vec![thread],vec![Task{parent:None,status:Status::Ready,cleanup:0,completed_order:None,abort:None,unwinding:false}],0,vec![])
        };
        if command.action=="settle" {
            let effect=command.id.ok_or("missing settlement identity")?;
            let id=tasks.iter().position(|t|matches!(t.status,Status::Effect{id,..} if id==effect)).ok_or("unknown or consumed effect")?;
            let kind=command.outcome["kind"].as_str().ok_or("missing outcome kind")?;
            if !["value","throw","cancelled"].contains(&kind) {return Err("invalid outcome kind".into());}
            if kind!="cancelled" && command.outcome.get("value").is_none() {return Err("missing outcome value".into());}
            if kind=="cancelled" && !matches!(tasks[id].status,Status::Effect{cancel:true,..}) {return Err("unsolicited cancellation settlement".into());}
            if tasks[id].abort.is_some() && tasks[id].cleanup==0 && !tasks[id].unwinding {
                interrupt(ctx,&threads,&mut tasks,id)?;
            } else {
                resume(ctx,threads[id],from_json(ctx,&command.outcome["value"])?,kind=="throw")?;
                tasks[id].status=Status::Ready;
            }
        } else if command.action=="cancel" {cancel(&mut tasks,0,(Completion::Cancelled,0));}
        if command.action!="restore" {
            let mut budget=10000usize;
            loop {
                if budget==0 {return Err("scheduler transition budget exceeded".into());} budget-=1;
                // Settle guest wait relationships before choosing the next runnable stack.
                let mut changed=false;
                for id in 0..tasks.len() {
                    match tasks[id].status.clone() {
                        Status::Exiting{completion}=>{
                            if children(&tasks,id).iter().all(|c|done(&tasks[*c])) {
                                let order=tasks.iter().filter_map(|t|t.completed_order).max().map_or(0,|n|n+1);
                                tasks[id].completed_order=Some(order);
                                tasks[id].status=Status::Done{completion}; changed=true;
                                if completion==Completion::Throw && tasks[id].parent.is_some()
                                    && matches!(tasks[id].abort,Some((Completion::Cancelled,_))) {
                                    let value=result(ctx,&threads,&tasks,id)?;
                                    suppressed.push(json!({"task":id,"error":to_json(value).unwrap_or(json!("non-JSON cleanup failure"))}));
                                }
                                if completion==Completion::Throw && tasks[id].abort.is_none() {
                                    if let Some(parent)=tasks[id].parent {
                                        let handled=matches!(&tasks[parent].status,Status::Wait{children,..} if children.contains(&id));
                                        if !handled {cancel(&mut tasks,parent,(Completion::Throw,id));}
                                    }
                                }
                            }
                        }
                        Status::Wait{mode,children:ids,mut winner}=>{
                            if tasks[id].abort.is_some() && !tasks[id].unwinding && tasks[id].cleanup==0 {
                                if children(&tasks,id).iter().all(|c|done(&tasks[*c])) {interrupt(ctx,&threads,&mut tasks,id)?;changed=true;}
                                continue;
                            }
                            if winner.is_none() {
                                winner=ids.iter().copied().filter(|c|matches!(tasks[*c].status,Status::Done{completion} if mode=="race" || completion!=Completion::Value)).min_by_key(|c|tasks[*c].completed_order);
                                if let Some(w)=winner {
                                    for c in &ids {if *c!=w {cancel(&mut tasks,*c,(Completion::Cancelled,*c));}}
                                    tasks[id].status=Status::Wait{mode:mode.clone(),children:ids.clone(),winner};changed=true;
                                }
                            }
                            if ids.iter().all(|c|done(&tasks[*c])) {
                                let (value,throw)=if let Some(w)=winner {
                                    (result(ctx,&threads,&tasks,w)?,!matches!(tasks[w].status,Status::Done{completion:Completion::Value}))
                                } else if mode=="join" {(result(ctx,&threads,&tasks,ids[0])?,false)}
                                else {let values=Table::new(&ctx); for (i,c) in ids.iter().enumerate(){values.set(ctx,(i+1) as i64,result(ctx,&threads,&tasks,*c)?).map_err(|e|e.to_string())?;} (Value::Table(values),false)};
                                resume(ctx,threads[id],value,throw)?; tasks[id].status=Status::Ready;changed=true;
                            }
                        }
                        _=>{}
                    }
                }
                let Some(id)=tasks.iter().position(|t|matches!(t.status,Status::Ready)) else {if changed {continue;} break;};
                let values=step(ctx,threads[id])?;
                let op=text(*values.first().ok_or("empty task command")?)?;
                match op.as_str() {
                    "start"=>{
                        if tasks[id].abort.is_some() {interrupt(ctx,&threads,&mut tasks,id)?;}
                        else {resume(ctx,threads[id],Value::Nil,false)?;}
                    }
                    "spawn"=>{
                        if tasks.len()>=MAX_TASKS {return Err("task budget exceeded".into());}
                        let Some(Value::Function(function))=values.get(1) else {return Err("spawn needs a closure".into());};
                        let child=Thread::new(ctx);child.start(ctx,*function,()).map_err(|e|e.to_string())?;
                        let child_id=tasks.len(); threads.push(child);
                        tasks.push(Task{parent:Some(id),status:Status::Ready,cleanup:0,completed_order:None,abort:None,unwinding:false});
                        resume(ctx,threads[id],Value::Integer(child_id as i64),false)?;
                    }
                    "join"|"all"|"race"=>{
                        let Some(Value::Table(list))=values.get(1) else {return Err("wait needs task identities".into());};
                        let mut ids=vec![];
                        for i in 1..=MAX_TASKS {match list.get::<_,Value>(ctx,i as i64).map_err(|e|e.to_string())? {
                            Value::Nil=>break,
                            Value::Integer(n) if n>0 && (n as usize)<tasks.len() && tasks[n as usize].parent==Some(id) && !ids.contains(&(n as usize))=>ids.push(n as usize),
                            _=>return Err("invalid child task handle".into()),
                        }}
                        if ids.is_empty() && op=="all" {
                            resume(ctx,threads[id],from_json(ctx,&json!([]))?,false)?;
                            continue;
                        }
                        if ids.is_empty() {return Err("empty task group".into());}
                        tasks[id].status=Status::Wait{mode:op,children:ids,winner:None};
                    }
                    "effect"=>{
                        if values.len()!=3 {return Err("effect needs site and input".into());}
                        let site=text(values[1])?;
                        if site.is_empty()||site.len()>200 {return Err("invalid effect site".into());}
                        let input=to_json(values[2])?;
                        tasks[id].status=Status::Effect{id:next_effect,site,input,cancel:false}; next_effect=next_effect.checked_add(1).ok_or("effect identity overflow")?;
                    }
                    "cleanup-enter"=>{
                        if tasks[id].cleanup>=32{return Err("cleanup budget exceeded".into());}
                        tasks[id].cleanup+=1;resume(ctx,threads[id],Value::Nil,false)?;
                    }
                    "cleanup-leave"=>{
                        tasks[id].cleanup=tasks[id].cleanup.checked_sub(1).ok_or("cleanup depth underflow")?;
                        resume(ctx,threads[id],Value::Nil,false)?;
                    }
                    "done"=>{
                        if values.len()!=3 {return Err("invalid completion".into());}
                        let mut completion=if matches!(values[1],Value::Boolean(true)){Completion::Value}
                            else if matches!(values[2],Value::String(s) if s.as_bytes()==CANCEL.as_bytes()){Completion::Cancelled}else{Completion::Throw};
                        if completion==Completion::Value {if let Some((kind,_))=tasks[id].abort {completion=kind;}}
                        tasks[id].status=Status::Exiting{completion};
                        for child in children(&tasks,id) {cancel(&mut tasks,child,(Completion::Cancelled,child));}
                    }
                    _=>return Err("unknown guest task command".into()),
                }
            }
        }
        let pending:Vec<_>=tasks.iter().enumerate().filter_map(|(task,t)|{
            if let Status::Effect{id,site,input,cancel}=&t.status {Some(json!({"id":id,"task":task,"request":{"site":site,"input":input},"intent":if *cancel{"cancel"}else{"run"}}))}else{None}
        }).collect();
        let boundary=if let Status::Done{completion}=tasks[0].status {
            let value=result(ctx,&threads,&tasks,0)?;
            match completion {Completion::Value=>json!({"kind":"completed","value":to_json(value)?}),Completion::Throw=>json!({"kind":"failed","error":to_json(value)?}),Completion::Cancelled=>json!({"kind":"cancelled"})}
        } else {
            if pending.is_empty(){return Err("guest task deadlock".into());}
            json!({"kind":"suspended","request":{"pending":pending}})
        };
        // A read-only restore validates and hydrates the graph without producing a
        // new checkpoint. Hash-table iteration may assign different node IDs on
        // recapture even though no guest instruction has executed.
        if command.action=="restore" {
            return Ok(json!({"boundary":boundary,"state":command.state}));
        }
        let vm=checkpoint::capture_threads(ctx,&threads,&source,&protos,&natives)?;
        Ok(json!({"boundary":boundary,"state":State{source:command.source,vm,tasks,next_effect,suppressed}}))
    })?;
    if lua.total_memory() > 32 * 1024 * 1024 {
        return Err("guest heap budget exceeded".into());
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_shared_tasks_restore_without_replaying() {
        let source = "local n=0; return workflow.all({function() n=n+1; return workflow.effect('a',n) end, function() n=n+10; return workflow.effect('b',n) end})";
        let first =
            execute(serde_json::from_value(json!({"action":"start","source":source})).unwrap())
                .unwrap();
        assert_eq!(
            first["boundary"]["request"]["pending"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        let restored = execute(
            serde_json::from_value(
                json!({"action":"restore","source":source,"state":first["state"]}),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(first, restored);
        let second=execute(serde_json::from_value(json!({"action":"settle","source":source,"state":restored["state"],"id":1,"outcome":{"kind":"value","value":20}})).unwrap()).unwrap();
        let last=execute(serde_json::from_value(json!({"action":"settle","source":source,"state":second["state"],"id":0,"outcome":{"kind":"value","value":30}})).unwrap()).unwrap();
        assert_eq!(
            last["boundary"],
            json!({"kind":"completed","value":[30,20]})
        );
    }
}
