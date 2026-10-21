#![cfg(any(test, target_arch = "wasm32"))]

#[path = "../../../../../packages/flowmode-runtime-lua/vm/src/json.rs"]
mod boundary_json;
mod scheduler;

use piccolo::{
    thread::checkpoint::{self, Cell, Snapshot},
    Callback, CallbackReturn, Closure, Context, Executor, ExecutorMode, Fuel, Function, Lua, Table,
    Thread, Value, Variadic,
};

const SOURCE: &str = r#"
local counter = 0
local a = function()
    counter = counter + 1
    local reply = park("a", counter)
    counter = counter + reply
    park("a-done", counter)
end
local b = function()
    counter = counter + 10
    local reply = park("b", counter)
    counter = counter + reply
    park("b-done", counter)
end
park({a, b})
park("parent", counter)
"#;

fn setup<'gc>(ctx: Context<'gc>) -> (Closure<'gc>, Callback<'gc>) {
    let park = Callback::from_fn(&ctx, |_, _, _| {
        // Arguments are the yielded request. No host effect executes here.
        Ok(CallbackReturn::Yield {
            to_thread: None,
            then: None,
        })
    });
    let env = Table::new(&ctx);
    env.set(ctx, "park", park).unwrap();
    let root =
        Closure::load_with_env(ctx, Some("shared-tasks.lua"), SOURCE.as_bytes(), env).unwrap();
    (root, park)
}

fn boundary<'gc>(ctx: Context<'gc>, thread: Thread<'gc>) -> Vec<Value<'gc>> {
    let executor = Executor::run(&ctx, thread).unwrap();
    for _ in 0..100 {
        executor.step(ctx, &mut Fuel::with(1000)).unwrap();
        if executor.mode() == ExecutorMode::Result {
            return thread
                .take_result::<Variadic<Vec<Value>>>(ctx)
                .unwrap()
                .unwrap()
                .0;
        }
    }
    panic!("probe exceeded fuel budget");
}

fn assert_request(values: &[Value<'_>], name: &str, counter: i64) {
    assert!(matches!(values.first(), Some(Value::String(s)) if s.as_bytes() == name.as_bytes()));
    assert!(matches!(values.get(1), Some(Value::Integer(n)) if *n == counter));
}

fn start() -> String {
    let mut lua = Lua::empty();
    lua.enter(|ctx| {
        let (root, park) = setup(ctx);
        let protos = checkpoint::prototypes(root.prototype());
        let parent = Thread::new(ctx);
        parent.start(ctx, Function::Closure(root), ()).unwrap();
        let request = boundary(ctx, parent);
        let Value::Table(children) = request[0] else {
            panic!("expected children")
        };
        let a = Thread::new(ctx);
        let b = Thread::new(ctx);
        a.start(ctx, children.get::<_, Function>(ctx, 1).unwrap(), ())
            .unwrap();
        b.start(ctx, children.get::<_, Function>(ctx, 2).unwrap(), ())
            .unwrap();
        assert_request(&boundary(ctx, a), "a", 1);
        assert_request(&boundary(ctx, b), "b", 11);
        assert!(
            checkpoint::capture_threads(ctx, &[a, b], "tasks", &protos, &[park]).is_err(),
            "a live captured cell needs its owning parent stack"
        );
        assert!(
            checkpoint::capture_threads(ctx, &[parent, a, a], "tasks", &protos, &[park]).is_err(),
            "duplicate task roots must fail closed"
        );
        let saved =
            checkpoint::capture_threads(ctx, &[parent, a, b], "tasks", &protos, &[park]).unwrap();
        assert_eq!(saved.threads.len(), 3);
        assert!(saved
            .cells
            .iter()
            .any(|cell| matches!(cell, Cell::Open { thread: 0, .. })));
        serde_json::to_string(&saved).unwrap()
    })
}

fn settle(encoded: &str) -> String {
    let mut lua = Lua::empty();
    lua.enter(|ctx| {
        let (root, park) = setup(ctx);
        let protos = checkpoint::prototypes(root.prototype());
        let saved: Snapshot = serde_json::from_str(&encoded).unwrap();
        let threads = checkpoint::restore_threads(ctx, &saved, "tasks", &protos, &[park]).unwrap();
        assert_eq!(
            serde_json::to_value(
                checkpoint::capture_threads(ctx, &threads, "tasks", &protos, &[park]).unwrap()
            )
            .unwrap(),
            serde_json::to_value(&saved).unwrap(),
            "restore must not advance any stack"
        );
        // Reverse settlement order: b changes the cell that a later reads.
        threads[2].resume(ctx, 100).unwrap();
        assert_request(&boundary(ctx, threads[2]), "b-done", 111);
        threads[1].resume(ctx, 1000).unwrap();
        assert_request(&boundary(ctx, threads[1]), "a-done", 1111);
        let saved = checkpoint::capture_threads(ctx, &threads, "tasks", &protos, &[park]).unwrap();
        serde_json::to_string(&saved).unwrap()
    })
}

fn finish(encoded: &str) {
    let mut lua = Lua::empty();
    lua.enter(|ctx| {
        let (root, park) = setup(ctx);
        let protos = checkpoint::prototypes(root.prototype());
        let saved: Snapshot = serde_json::from_str(&encoded).unwrap();
        let threads = checkpoint::restore_threads(ctx, &saved, "tasks", &protos, &[park]).unwrap();
        threads[0].resume(ctx, ()).unwrap();
        assert_request(&boundary(ctx, threads[0]), "parent", 1111);
        let mut invalid: Snapshot = serde_json::from_str(&encoded).unwrap();
        let cell = invalid
            .cells
            .iter_mut()
            .find(|c| matches!(c, Cell::Open { .. }))
            .unwrap();
        if let Cell::Open { thread, .. } = cell {
            *thread = 999;
        }
        assert!(checkpoint::restore_threads(ctx, &invalid, "tasks", &protos, &[park]).is_err());
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn shared_cells_survive_two_fresh_restores() {
        let encoded = super::start();
        let encoded = super::settle(&encoded);
        super::finish(&encoded);
    }
}

#[cfg(target_arch = "wasm32")]
mod random {
    #[link(wasm_import_module = "host")]
    extern "C" {
        fn random_fill(ptr: *mut u8, len: usize);
    }
    fn fill(bytes: &mut [u8]) -> Result<(), getrandom::Error> {
        unsafe {
            random_fill(bytes.as_mut_ptr(), bytes.len());
        }
        Ok(())
    }
    getrandom::register_custom_getrandom!(fill);
    #[no_mangle]
    unsafe extern "Rust" fn __getrandom_v03_custom(
        ptr: *mut u8,
        len: usize,
    ) -> Result<(), getrandom03::Error> {
        random_fill(ptr, len);
        Ok(())
    }
}

// Probe-only ABI: each phase receives JSON and runs in a fresh Wasm instance.
#[cfg(target_arch = "wasm32")]
mod abi {
    const LIMIT: usize = 4 * 1024 * 1024;
    static mut OUTPUT_LEN: usize = 0;

    #[no_mangle]
    pub extern "C" fn allocate(len: usize) -> *mut u8 {
        assert!(len <= LIMIT);
        Box::into_raw(vec![0u8; len].into_boxed_slice()) as *mut u8
    }

    #[no_mangle]
    pub unsafe extern "C" fn execute(ptr: *mut u8, len: usize) -> *mut u8 {
        assert!(len <= LIMIT);
        let input = Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len));
        let request: serde_json::Value = serde_json::from_slice(&input).unwrap();
        let output = if request.get("action").is_some() {
            match serde_json::from_value(request)
                .map_err(|e| e.to_string())
                .and_then(super::scheduler::execute)
            {
                Ok(value) => serde_json::json!({"ok":value}),
                Err(error) => serde_json::json!({"error":error}),
            }
        } else {
            match request["phase"].as_u64().unwrap() {
                0 => serde_json::json!(super::start()),
                1 => serde_json::json!(super::settle(request["snapshot"].as_str().unwrap())),
                2 => {
                    super::finish(request["snapshot"].as_str().unwrap());
                    serde_json::json!(1111)
                }
                _ => panic!("unknown probe phase"),
            }
        };
        let bytes = serde_json::to_vec(&output).unwrap();
        assert!(bytes.len() <= LIMIT);
        OUTPUT_LEN = bytes.len();
        Box::into_raw(bytes.into_boxed_slice()) as *mut u8
    }

    #[no_mangle]
    pub unsafe extern "C" fn output_len() -> usize {
        OUTPUT_LEN
    }
}
