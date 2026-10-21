mod json;
mod runtime;

// A single command per instance. Only the JSON result crosses the ABI; the
// instance (including these allocations) is discarded after the command.
#[cfg(target_arch = "wasm32")]
mod abi {
    const LIMIT: usize = 4 * 1024 * 1024;
    static mut OUTPUT_LEN: usize = 0;

    #[link(wasm_import_module = "host")]
    extern "C" {
        fn random_fill(ptr: *mut u8, len: usize);
    }
    fn random(bytes: &mut [u8]) -> Result<(), getrandom::Error> {
        unsafe { random_fill(bytes.as_mut_ptr(), bytes.len()); }
        Ok(())
    }
    getrandom::register_custom_getrandom!(random);
    #[no_mangle]
    unsafe extern "Rust" fn __getrandom_v03_custom(ptr: *mut u8, len: usize) -> Result<(), getrandom03::Error> {
        random_fill(ptr, len);
        Ok(())
    }

    #[no_mangle]
    pub extern "C" fn allocate(len: usize) -> *mut u8 {
        assert!(len <= LIMIT);
        Box::into_raw(vec![0u8; len].into_boxed_slice()) as *mut u8
    }

    #[no_mangle]
    pub unsafe extern "C" fn execute(ptr: *mut u8, len: usize) -> *mut u8 {
        assert!(len <= LIMIT);
        let input = Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len));
        let result = serde_json::from_slice(&input)
            .map_err(|e| e.to_string())
            .and_then(super::runtime::execute);
        let envelope = match result {
            Ok(state) => serde_json::json!({"ok":state}),
            Err(error) => serde_json::json!({"error":error}),
        };
        let mut output = serde_json::to_vec(&envelope).unwrap();
        if output.len() > LIMIT {
            output = br#"{"error":"Lua output byte budget exceeded"}"#.to_vec();
        }
        OUTPUT_LEN = output.len();
        Box::into_raw(output.into_boxed_slice()) as *mut u8
    }

    #[no_mangle]
    pub unsafe extern "C" fn output_len() -> usize { OUTPUT_LEN }
}
