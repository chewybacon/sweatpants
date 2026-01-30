The Debug Journey
Initial Symptom: createDurableChatHandler hung when running in TanStack Start's Vite dev server, but worked perfectly in tests and simple Express servers.
What We Ruled Out (all worked fine in TanStack Start):
- Simple Effection pull-based streaming ✓
- resource() pattern ✓
- useBackgroundTask ✓
- setupInMemoryDurableStreams ✓
- registry.acquire() with a source stream ✓
- Nested resources ✓
- All initializer hooks ✓
The Breakthrough: Through systematic bisection testing, we discovered:
1. The setup function was returning successfully (we saw "returning subscription" logs)
2. But scope.run() in createStreamingHandler never resolved
3. Adding more logging revealed the chat engine was getting signal.aborted: true immediately
4. Tracing back, we found request.signal was being aborted right after calling request.json()
Root Cause: TanStack Start (via h3/unjs) aborts the request signal after consuming the body - a surprising behavior that differs from other frameworks.
Two Fixes:
1. Create a separate AbortController for the chat engine
2. Fix the abort check to not repeatedly reset to error state
The fix was ultimately just ~5 lines of code change, but finding it required methodical elimination of all other possibilities. Classic debugging story - the hardest bugs often have the simplest fixes once you find them!
