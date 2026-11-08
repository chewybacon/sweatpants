# Lua workflow target

The portable root exports `luaWorkflowTarget.emit(module)`, returning
`{ format: "lua-execution/1", source, effects }` for the Lua kernel. It verifies and
lowers the shared Scheme S-expression IR, with no ScriptC or runtime dependency.

The Node `@sweatpan.ts/codemode-compiler-lua/link` entry exports `luaWorkflowLinker`:

```ts
const linked = luaWorkflowLinker.link({
  module: artifact.module,
  caller: { language: "lua", text: "return sendEmail(input)" },
  name: "sendEmail",
  identity: luaRuntimeIdentity,
});
```

`name` is configurable: an ASCII letter followed by letters/digits/underscores.
Lua keywords, `input`, `workflow`, `type`, and `error` are reserved. Leading underscores
are unavailable to public bindings. Caller locals cannot shadow the public binding.
The private compiled function stays inside its generated closure; callers can only
invoke the named entry. The program hash binds source, runtime identity and effect
metadata. It is not a grant or an authenticity proof.

This is a bounded target, not arbitrary Scheme-to-Lua compilation. It supports one
compiled definition, strings, lexical lambdas, lists, field access, checked string
addition, Outcome branching, declared effects and protected cleanup. It rejects
unsupported forms, duplicate parameters and statement-only lambda tails. A workflow
that falls through fails explicitly. Strings must contain well-formed Unicode.

Caller syntax is separately bounded: locals, returns, if/else, strings, equality,
concatenation and public calls, at most 12K characters. No globals, raw effects,
functions, loops, assignments or long comments. Caller expressions retain Lua
semantics; compiled `js-add` checks string operands. The linker re-emits caller
syntax and renames locals to preserve the closure boundary.

Assembly supplies effect grants, payload/schema validation, model policy, and kernel
acquisition/recovery. Domain Outcomes remain ordinary reply data. No diagnostic
inspection API is promoted. Public-tool acceptance compiles the directive-bearing
`sendEmail` source and executes fresh/cached artifacts through this linker on both
host runtimes, restoring checkpoints between effects. It establishes the exercised
profile, not arbitrary Lua sandboxing, process-crash recovery or deployment.
