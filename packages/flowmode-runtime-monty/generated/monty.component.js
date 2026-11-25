"use components";
export function instantiate(getCoreModule, imports, instantiateCore = WebAssembly.instantiate) {
  
  function promiseWithResolvers() {
    if (Promise.withResolvers) {
      return Promise.withResolvers();
    } else {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }
  }
  const symbolDispose = Symbol.dispose || Symbol.for('dispose');
  const symbolAsyncIterator = Symbol.asyncIterator;
  const symbolIterator = Symbol.iterator;
  
  const _debugLog = (...args) => {
    if (!globalThis?.process?.env?.JCO_DEBUG) { return; }
    console.debug(...args);
  };
  const ASYNC_DETERMINISM = 'random';
  const GLOBAL_COMPONENT_MEMORY_MAP = new Map();
  const CURRENT_TASK_META = {};
  
  function _getGlobalCurrentTaskMeta(componentIdx) {
    if (componentIdx === null || componentIdx === undefined) {
      throw new Error("missing/invalid component idx");
    }
    const v = CURRENT_TASK_META[componentIdx];
    if (v === undefined || v === null) {
      return undefined;
    }
    return { ...v };
  }
  
  
  function _setGlobalCurrentTaskMeta(args) {
    if (!args) { throw new TypeError('args missing'); }
    if (args.taskID === undefined) { throw new TypeError('missing task ID'); }
    if (args.componentIdx === undefined) { throw new TypeError('missing component idx'); }
    const { taskID, componentIdx } = args;
    return CURRENT_TASK_META[componentIdx] = { taskID, componentIdx };
  }
  
  
  function _withGlobalCurrentTaskMeta(args) {
    _debugLog('[_withGlobalCurrentTaskMeta()] args', args);
    if (!args) { throw new TypeError('args missing'); }
    if (args.taskID === undefined) { throw new TypeError('missing task ID'); }
    if (args.componentIdx === undefined) { throw new TypeError('missing component idx'); }
    if (!args.fn) { throw new TypeError('missing fn'); }
    const { taskID, componentIdx, fn } = args;
    
    try {
      CURRENT_TASK_META[componentIdx] = { taskID, componentIdx };
      return fn();
    } catch (err) {
      _debugLog("error while executing sync callee/callback", {
        ...args,
        err,
      });
      throw err;
    } finally {
      CURRENT_TASK_META[componentIdx] = null;
    }
  }
  
  async function _withGlobalCurrentTaskMetaAsync(args) {
    _debugLog('[_withGlobalCurrentTaskMetaAsync()] args', args);
    if (!args) { throw new TypeError('args missing'); }
    if (args.taskID === undefined) { throw new TypeError('missing task ID'); }
    if (args.componentIdx === undefined) { throw new TypeError('missing component idx'); }
    if (!args.fn) { throw new TypeError('missing fn'); }
    
    const { taskID, componentIdx, fn } = args;
    
    try {
      CURRENT_TASK_META[componentIdx] = { taskID, componentIdx };
      return await fn();
    } catch (err) {
      _debugLog("error while executing async callee/callback", {
        ...args,
        err,
      });
      throw err;
    } finally {
      CURRENT_TASK_META[componentIdx] = null;
    }
  }
  
  async function _clearCurrentTask(args) {
    _debugLog('[_clearCurrentTask()] args', args);
    if (!args) { throw new TypeError('args missing'); }
    if (args.taskID === undefined) { throw new TypeError('missing task ID'); }
    if (args.componentIdx === undefined) { throw new TypeError('missing component idx'); }
    const { taskID, componentIdx } = args;
    
    const meta = CURRENT_TASK_META[componentIdx];
    if (!meta) { throw new Error(`missing current task meta for component idx [${componentIdx}]`); }
    
    if (meta.taskID !== taskID) {
      throw new Error(`task ID [${meta.taskID}] != requested ID [${taskID}]`);
    }
    if (meta.componentIdx !== componentIdx) {
      throw new Error(`component idx [${meta.componentIdx}] != requested idx [${componentIdx}]`);
    }
    
    CURRENT_TASK_META[componentIdx] = null;
  }
  
  function lookupMemoriesForComponent(args) {
    const { componentIdx } = args ?? {};
    if (args.componentIdx === undefined) { throw new TypeError("missing component idx"); }
    
    const metas = GLOBAL_COMPONENT_MEMORY_MAP.get(componentIdx);
    if (!metas) { return []; }
    
    if (args.memoryIdx === undefined) {
      return Object.values(metas);
    }
    
    const meta = metas[args.memoryIdx];
    return meta?.memory;
  }
  
  function registerGlobalMemoryForComponent(args) {
    const { componentIdx, memory, memoryIdx } = args ?? {};
    if (componentIdx === undefined) { throw new TypeError('missing component idx'); }
    if (memory === undefined && memoryIdx === undefined) { throw new TypeError('missing both memory & memory idx'); }
    let inner = GLOBAL_COMPONENT_MEMORY_MAP.get(componentIdx);
    if (!inner) {
      inner = {};
      GLOBAL_COMPONENT_MEMORY_MAP.set(componentIdx, inner);
    }
    
    inner[memoryIdx] = { memory, memoryIdx, componentIdx };
  }
  
  class RepTable {
    #data = [0, null];
    #size = 0;
    #target;
    
    constructor(args) {
      this.target = args?.target;
    }
    
    data() { return this.#data; }
    
    insert(val) {
      _debugLog('[RepTable#insert()] args', { val, target: this.target });
      const freeIdx = this.#data[0];
      if (freeIdx === 0) {
        this.#data.push(val);
        this.#data.push(null);
        const rep = (this.#data.length >> 1) - 1;
        _debugLog('[RepTable#insert()] inserted', { val, target: this.target, rep });
        this.#size += 1;
        return rep;
      }
      this.#data[0] = this.#data[freeIdx << 1];
      const placementIdx = freeIdx << 1;
      this.#data[placementIdx] = val;
      this.#data[placementIdx + 1] = null;
      _debugLog('[RepTable#insert()] inserted', { val, target: this.target, rep: freeIdx });
      this.#size += 1;
      return freeIdx;
    }
    
    get(rep) {
      _debugLog('[RepTable#get()] args', { rep, target: this.target });
      if (rep === 0) { throw new Error('invalid resource rep during get, (cannot be 0)'); }
      
      const baseIdx = rep << 1;
      const val = this.#data[baseIdx];
      return val;
    }
    
    contains(rep) {
      _debugLog('[RepTable#contains()] args', { rep, target: this.target });
      if (rep === 0) { throw new Error('invalid resource rep during contains, (cannot be 0)'); }
      
      const baseIdx = rep << 1;
      return !!this.#data[baseIdx];
    }
    
    remove(rep) {
      _debugLog('[RepTable#remove()] args', { rep, target: this.target });
      if (rep === 0) { throw new Error('invalid resource rep during remove, (cannot be 0)'); }
      if (this.#data.length === 2) { throw new Error('invalid'); }
      
      const baseIdx = rep << 1;
      const val = this.#data[baseIdx];
      
      this.#data[baseIdx] = this.#data[0];
      this.#data[0] = rep;
      this.#size -= 1;
      
      return val;
    }
    
    size() { return this.#size; }
    
    clear() {
      _debugLog('[RepTable#clear()] args', { rep, target: this.target });
      this.#data = [0, null];
    }
  }
  const _coinFlip = () => { return Math.random() > 0.5; };
  let SCOPE_ID = 0;
  const I32_MIN = -2_147_483_648;
  
  const I32_MAX= 2_147_483_647;
  
  
  function _isValidNumericPrimitive(ty, v) {
    if (v === undefined || v === null) { return false; }
    switch (ty) {
      case 'bool':
      return v === 0 || v === 1;
      break;
      case 'u8':
      return v >= 0 && v <= 255;
      break;
      case 's8':
      return v >= -128 && v <= 127;
      break;
      case 'u16':
      return v >= 0 && v <= 65535;
      break;
      case 's16':
      return v >= -32768 && v <= 32767;
      case 'u32':
      return v >= 0 && v <= 4_294_967_295;
      case 's32':
      return v >= -2_147_483_648 && v <= 2_147_483_647;
      case 'u64':
      return typeof v === 'bigint' && v >= 0 && v <= 18_446_744_073_709_551_615n;
      case 's64':
      return typeof v === 'bigint' && v >= -9223372036854775808n && v <= 9223372036854775807n;
      break;
      case 'f32':
      case 'f64': return typeof v === 'number';
      default:
      return false;
    }
    return true;
  }
  
  function _requireValidNumericPrimitive(ty, v) {
    if (v === undefined  || v === null || !_isValidNumericPrimitive(ty, v)) {
      throw new TypeError(`invalid ${ty} value [${v}]`);
    }
    return true;
  }
  
  const _typeCheckValidI32 = (n) => typeof n === 'number' && n >= I32_MIN && n <= I32_MAX;
  
  
  const _typeCheckAsyncFn= (f) => {
    return f instanceof ASYNC_FN_CTOR;
  };
  
  let RESOURCE_CALL_BORROWS = [];const ASYNC_FN_CTOR = (async () => {}).constructor;
  
  function clearCurrentTask(componentIdx, taskID) {
    _debugLog('[clearCurrentTask()] args', { componentIdx, taskID });
    
    if (componentIdx === undefined || componentIdx === null) {
      throw new Error('missing/invalid component instance index while ending current task');
    }
    
    const tasks = ASYNC_TASKS_BY_COMPONENT_IDX.get(componentIdx);
    if (!tasks || !Array.isArray(tasks)) {
      throw new Error('missing/invalid tasks for component instance while ending task');
    }
    if (tasks.length == 0) {
      throw new Error(`no current tasks for component instance [${componentIdx}] while ending task`);
    }
    
    if (taskID !== undefined) {
      const last = tasks[tasks.length - 1];
      if (last.id !== taskID) {
        // throw new Error('current task does not match expected task ID');
        return;
      }
    }
    
    ASYNC_CURRENT_TASK_IDS.pop();
    ASYNC_CURRENT_COMPONENT_IDXS.pop();
    
    const taskMeta = tasks.pop();
    return taskMeta.task;
  }
  
  const CURRENT_TASK_MAY_BLOCK= globalThis.WebAssembly ? new globalThis.WebAssembly.Global({ value: 'i32', mutable: true }, 0) : false;
  
  const ASYNC_CURRENT_TASK_IDS = [];
  const ASYNC_CURRENT_COMPONENT_IDXS = [];
  
  function unpackCallbackResult(result) {
    if (!(_typeCheckValidI32(result))) { throw new Error('invalid callback return value [' + result + '], not a valid i32'); }
    const eventCode = result & 0xF;
    if (eventCode < 0 || eventCode > 3) {
      throw new Error('invalid async return value [' + eventCode + '], outside callback code range');
    }
    if (result < 0 || result >= 2**32) { throw new Error('invalid callback result'); }
    // TODO: table max length check?
    const waitableSetRep = result >> 4;
    return [eventCode, waitableSetRep];
  }
  
  class AsyncSubtask {
    static _ID = 0n;
    
    static State = {
      STARTING: 0,
      STARTED: 1,
      RETURNED: 2,
      CANCELLED_BEFORE_STARTED: 3,
      CANCELLED_BEFORE_RETURNED: 4,
    };
    
    #id;
    #state = AsyncSubtask.State.STARTING;
    #componentIdx;
    
    #parentTask;
    #childTask = null;
    
    #dropped = false;
    #cancelRequested = false;
    
    #memoryIdx = null;
    #lenders = null;
    
    #waitable = null;
    
    #callbackFn = null;
    #callbackFnName = null;
    
    #postReturnFn = null;
    #onProgressFn = null;
    #pendingEventFn = null;
    
    #callMetadata = {};
    
    #resolved = false;
    
    #onResolveHandlers = [];
    #onStartHandlers = [];
    
    #result = null;
    #resultSet = false;
    
    fnName;
    target;
    isAsync;
    isManualAsync;
    
    constructor(args) {
      if (typeof args.componentIdx !== 'number') {
        throw new Error('invalid componentIdx for subtask creation');
      }
      this.#componentIdx = args.componentIdx;
      
      this.#id = ++AsyncSubtask._ID;
      this.fnName = args.fnName;
      
      if (!args.parentTask) { throw new Error('missing parent task during subtask creation'); }
      this.#parentTask = args.parentTask;
      
      if (args.childTask) { this.#childTask = args.childTask; }
      
      if (args.memoryIdx) { this.#memoryIdx = args.memoryIdx; }
      
      if (!args.waitable) { throw new Error("missing/invalid waitable"); }
      this.#waitable = args.waitable;
      
      if (args.callMetadata) { this.#callMetadata = args.callMetadata; }
      
      this.#lenders = [];
      this.target = args.target;
      this.isAsync = args.isAsync;
      this.isManualAsync = args.isManualAsync;
    }
    
    id() { return this.#id; }
    parentTaskID() { return this.#parentTask?.id(); }
    childTaskID() { return this.#childTask?.id(); }
    state() { return this.#state; }
    
    waitable() { return this.#waitable; }
    waitableRep() { return this.#waitable.idx(); }
    
    join() { return this.#waitable.join(...arguments); }
    getPendingEvent() { return this.#waitable.getPendingEvent(...arguments); }
    hasPendingEvent() { return this.#waitable.hasPendingEvent(...arguments); }
    setPendingEvent() { return this.#waitable.setPendingEvent(...arguments); }
    
    setTarget(tgt) { this.target = tgt; }
    
    getResult() {
      if (!this.#resultSet) { throw new Error("subtask result has not been set") }
      return this.#result;
    }
    setResult(v) {
      if (this.#resultSet) { throw new Error("subtask result has already been set"); }
      this.#result = v;
      this.#resultSet = true;
    }
    
    componentIdx() { return this.#componentIdx; }
    
    setChildTask(t) {
      if (!t) { throw new Error('cannot set missing/invalid child task on subtask'); }
      if (this.#childTask) { throw new Error('child task is already set on subtask'); }
      if (this.#parentTask === t) { throw new Error("parent cannot be child"); }
      this.#childTask = t;
    }
    getChildTask(t) { return this.#childTask; }
    
    getParentTask() { return this.#parentTask; }
    
    setCallbackFn(f, name) {
      if (!f) { return; }
      if (this.#callbackFn) { throw new Error('callback fn can only be set once'); }
      this.#callbackFn = f;
      this.#callbackFnName = name;
    }
    
    getCallbackFnName() {
      if (!this.#callbackFn) { return undefined; }
      return this.#callbackFn.name;
    }
    
    setPostReturnFn(f) {
      if (!f) { return; }
      if (this.#postReturnFn) { throw new Error('postReturn fn can only be set once'); }
      this.#postReturnFn = f;
    }
    
    setOnProgressFn(f) {
      if (this.#onProgressFn) { throw new Error('on progress fn can only be set once'); }
      this.#onProgressFn = f;
    }
    
    isNotStarted() {
      return this.#state == AsyncSubtask.State.STARTING;
    }
    
    registerOnStartHandler(f) {
      this.#onStartHandlers.push(f);
    }
    
    onStart(args) {
      _debugLog('[AsyncSubtask#onStart()] args', {
        componentIdx: this.#componentIdx,
        subtaskID: this.#id,
        parentTaskID: this.parentTaskID(),
        fnName: this.fnName,
        args,
      });
      
      if (this.#onProgressFn) { this.#onProgressFn(); }
      
      this.#state = AsyncSubtask.State.STARTED;
      
      let result;
      
      // If we have been provided a helper start function as a result of
      // component fusion performed by wasmtime tooling, then we can call that helper and lifts/lowers will
      // be performed for us.
      //
      // See also documentation on `HostIntrinsic::PrepareCall`
      //
      if (this.#callMetadata.startFn) {
        result = this.#callMetadata.startFn.apply(null, args?.startFnParams ?? []);
      }
      
      return result;
    }
    
    
    registerOnResolveHandler(f) {
      this.#onResolveHandlers.push(f);
    }
    
    reject(subtaskErr) {
      this.#childTask?.reject(subtaskErr);
    }
    
    onResolve(subtaskValue) {
      _debugLog('[AsyncSubtask#onResolve()] args', {
        componentIdx: this.#componentIdx,
        subtaskID: this.#id,
        isAsync: this.isAsync,
        childTaskID: this.childTaskID(),
        parentTaskID: this.parentTaskID(),
        parentTaskFnName: this.#parentTask?.entryFnName(),
        fnName: this.fnName,
      });
      
      if (this.#resolved) {
        throw new Error('subtask has already been resolved');
      }
      
      if (this.#onProgressFn) { this.#onProgressFn(); }
      
      if (subtaskValue === null && this.#cancelRequested) {
        if (this.#state === AsyncSubtask.State.STARTING) {
          this.#state = AsyncSubtask.State.CANCELLED_BEFORE_STARTED;
        } else {
          if (this.#state !== AsyncSubtask.State.STARTED) {
            throw new Error('resolved subtask must have been started before cancellation');
          }
          this.#state = AsyncSubtask.State.CANCELLED_BEFORE_RETURNED;
        }
      } else {
        if (this.#state !== AsyncSubtask.State.STARTED) {
          throw new Error('resolved subtask must have been started before completion');
        }
        this.#state = AsyncSubtask.State.RETURNED;
      }
      
      this.setResult(subtaskValue);
      
      for (const f of this.#onResolveHandlers) {
        try {
          f(subtaskValue);
        } catch (err) {
          console.error("error during subtask resolve handler", err);
          throw err;
        }
      }
      
      const callMetadata = this.getCallMetadata();
      
      // TODO(fix): we should be able to easily have the caller's meomry
      // to lower into here, but it's not present in PrepareCall
      const memory = callMetadata.memory ?? this.#parentTask?.getReturnMemory() ?? lookupMemoriesForComponent({ componentIdx: this.#parentTask?.componentIdx() })[0];
      if (callMetadata && !callMetadata.returnFn && this.isAsync && callMetadata.resultPtr && memory) {
        const { resultPtr, realloc } = callMetadata;
        const lowers = callMetadata.lowers; // may have been updated in task.return of the child
        if (lowers && lowers.length > 0) {
          lowers[0]({
            componentIdx: this.#componentIdx,
            memory,
            realloc,
            vals: [subtaskValue],
            storagePtr: resultPtr,
            stringEncoding: callMetadata.stringEncoding,
          });
        }
      }
      
      this.#resolved = true;
      this.#parentTask.removeSubtask(this);
      
      if (!this.isAsync) {
        this.deliverResolve();
        const rep = this.waitableRep();
        if (rep) {
          try {
            const removed = this.#getComponentState().handles.remove(rep);
            if (removed !== this) {
              throw new Error("unexpectedly received non-self Subtask from handle removal");
            }
            this.drop();
          } catch (err) {
            _debugLog('[AsyncSubtask#onResolve()] failed to remove subtask after sync subtask completion', err);
          }
        }
      }
    }
    
    getStateNumber() { return this.#state; }
    isReturned() { return this.#state === AsyncSubtask.State.RETURNED; }
    
    getCallMetadata() { return this.#callMetadata; }
    
    isResolved() {
      if (this.#state === AsyncSubtask.State.STARTING
      || this.#state === AsyncSubtask.State.STARTED) {
        return false;
      }
      if (this.#state === AsyncSubtask.State.RETURNED
      || this.#state === AsyncSubtask.State.CANCELLED_BEFORE_STARTED
      || this.#state === AsyncSubtask.State.CANCELLED_BEFORE_RETURNED) {
        return true;
      }
      throw new Error('unrecognized internal Subtask state [' + this.#state + ']');
    }
    
    addLender(handle) {
      _debugLog('[AsyncSubtask#addLender()] args', { handle });
      if (!Number.isNumber(handle)) { throw new Error('missing/invalid lender handle [' + handle + ']'); }
      
      if (this.#lenders.length === 0 || this.isResolved()) {
        throw new Error('subtask has no lendors or has already been resolved');
      }
      
      handle.lends++;
      this.#lenders.push(handle);
    }
    
    deliverResolve() {
      _debugLog('[AsyncSubtask#deliverResolve()] args', {
        lenders: this.#lenders,
        parentTaskID: this.parentTaskID(),
        subtaskID: this.#id,
        childTaskID: this.childTaskID(),
        resolved: this.isResolved(),
        resolveDelivered: this.resolveDelivered(),
      });
      
      const cannotDeliverResolve = this.resolveDelivered() || !this.isResolved();
      if (cannotDeliverResolve) {
        throw new Error('subtask cannot deliver resolution twice, and the subtask must be resolved');
      }
      
      for (const lender of this.#lenders) {
        lender.lends--;
      }
      
      this.#lenders = null;
    }
    
    resolveDelivered() {
      _debugLog('[AsyncSubtask#resolveDelivered()] args', { });
      if (this.#lenders === null && !this.isResolved()) {
        throw new Error('invalid subtask state, lenders missing and subtask has not been resolved');
      }
      return this.#lenders === null;
    }
    
    drop() {
      _debugLog('[AsyncSubtask#drop()] args', {
        componentIdx: this.#componentIdx,
        parentTaskID: this.#parentTask?.id(),
        parentTaskFnName: this.#parentTask?.entryFnName(),
        childTaskID: this.#childTask?.id(),
        childTaskFnName: this.#childTask?.entryFnName(),
        subtaskFnName: this.fnName,
      });
      if (!this.#waitable) { throw new Error('missing/invalid inner waitable'); }
      if (!this.resolveDelivered()) {
        throw new Error('cannot drop subtask before resolve is delivered');
      }
      if (this.#waitable) { this.#waitable.drop() }
      this.#dropped = true;
    }
    
    #getComponentState() {
      const state = getOrCreateAsyncState(this.#componentIdx);
      if (!state) {
        throw new Error('invalid/missing async state for component [' + componentIdx + ']');
      }
      return state;
    }
    
    getWaitableHandleIdx() {
      _debugLog('[AsyncSubtask#getWaitableHandleIdx()] args', { });
      if (!this.#waitable) { throw new Error('missing/invalid waitable'); }
      return this.waitableRep();
    }
  }
  
  function _prepareCall(
  memoryIdx,
  getMemoryFn,
  startFn,
  returnFn,
  callerComponentIdx,
  calleeComponentIdx,
  taskReturnTypeIdx,
  calleeIsAsyncInt,
  stringEncoding,
  resultCountOrAsync,
  ) {
    _debugLog('[_prepareCall()]', {
      memoryIdx,
      callerComponentIdx,
      calleeComponentIdx,
      taskReturnTypeIdx,
      calleeIsAsyncInt,
      stringEncoding,
      resultCountOrAsync,
    });
    const argArray = [...arguments];
    
    // value passed in *may* be as large as u32::MAX which may be mangled into -2
    resultCountOrAsync >>>= 0;
    
    let isAsync = false;
    let hasResultPointer = false;
    if (resultCountOrAsync === 2**32 - 1) {
      // prepare async with no result (u32::MAX)
      isAsync = true;
      hasResultPointer = false;
    } else if (resultCountOrAsync === 2**32 - 2) {
      // prepare async with result (u32::MAX - 1)
      isAsync = true;
      hasResultPointer = true;
    }
    
    const currentCallerTaskMeta = getCurrentTask(callerComponentIdx);
    if (!currentCallerTaskMeta) {
      throw new Error('invalid/missing current task for caller during prepare call');
    }
    
    const currentCallerTask = currentCallerTaskMeta.task;
    if (!currentCallerTask) {
      throw new Error('unexpectedly missing task in meta for caller during prepare call');
    }
    
    if (currentCallerTask.componentIdx() !== callerComponentIdx) {
      throw new Error(`task component idx [${ currentCallerTask.componentIdx() }] !== [${ callerComponentIdx }] (callee ${ calleeComponentIdx })`);
    }
    
    let getCalleeParamsFn;
    let resultPtr = null;
    let directParamsArr;
    if (hasResultPointer) {
      directParamsArr = argArray.slice(10, argArray.length - 1);
      getCalleeParamsFn = () => directParamsArr;
      resultPtr = argArray[argArray.length - 1];
    } else {
      directParamsArr = argArray.slice(10);
      getCalleeParamsFn = () => directParamsArr;
    }
    
    let encoding;
    switch (stringEncoding) {
      case 0:
      encoding = 'utf8';
      break;
      case 1:
      encoding = 'utf16';
      break;
      case 2:
      encoding = 'compact-utf16';
      break;
      default:
      throw new Error(`unrecognized string encoding enum [${stringEncoding}]`);
    }
    
    const subtask = currentCallerTask.createSubtask({
      componentIdx: callerComponentIdx,
      parentTask: currentCallerTask,
      isAsync,
      callMetadata: {
        getMemoryFn,
        memoryIdx,
        resultPtr,
        returnFn,
        startFn,
        stringEncoding,
      }
    });
    
    const [newTask, newTaskID] = createNewCurrentTask({
      componentIdx: calleeComponentIdx,
      isAsync,
      getCalleeParamsFn,
      entryFnName: [
      'task',
      subtask.getParentTask().id(),
      'subtask',
      subtask.id(),
      'new-prepared-async-task'
      ].join('/'),
      stringEncoding,
    });
    newTask.setParentSubtask(subtask);
    newTask.setReturnMemoryIdx(memoryIdx);
    newTask.setReturnMemory(getMemoryFn);
    subtask.setChildTask(newTask);
    
    newTask.subtaskMeta = {
      subtask,
      calleeComponentIdx,
      callerComponentIdx,
      getCalleeParamsFn,
      stringEncoding,
      isAsync,
    };
    
    _setGlobalCurrentTaskMeta({
      taskID: newTask.id(),
      componentIdx: newTask.componentIdx(),
    });
  }
  
  function _asyncStartCall(args, callee, paramCount, resultCount, flags) {
    const componentIdx = ASYNC_CURRENT_COMPONENT_IDXS.at(-1);
    
    const globalTaskMeta = _getGlobalCurrentTaskMeta(componentIdx);
    if (!globalTaskMeta) { throw new Error('missing global current task globalTaskMeta'); }
    const taskID = globalTaskMeta.taskID;
    
    _debugLog('[_asyncStartCall()] args', { args, componentIdx });
    const { getCallbackFn, callbackIdx, getPostReturnFn, postReturnIdx } = args;
    
    const preparedTaskMeta = getCurrentTask(componentIdx, taskID);
    if (!preparedTaskMeta) { throw new Error('unexpectedly missing current task'); }
    
    const preparedTask = preparedTaskMeta.task;
    if (!preparedTask) { throw new Error('unexpectedly missing current task'); }
    if (!preparedTask.subtaskMeta) { throw new Error('missing subtask meta from prepare'); }
    
    const {
      subtask,
      returnMemoryIdx,
      getReturnMemoryFn,
      callerComponentIdx,
      calleeComponentIdx,
      getCalleeParamsFn,
      isAsync,
      stringEncoding,
    } = preparedTask.subtaskMeta;
    if (!subtask) { throw new Error("missing subtask from cstate during async start call"); }
    if (calleeComponentIdx !== preparedTask.componentIdx()) {
      throw new Error(`meta callee idx [${calleeComponentIdx}] != current task idx [${preparedTask.componentIdx()}] during async start call`);
    }
    if (calleeComponentIdx !== componentIdx) {
      throw new Error("mismatched componentIdx for async start call (does not match prepare)");
    }
    
    const argArray = [...arguments];
    
    if (resultCount < 0 || resultCount > 1) { throw new Error('invalid/unsupported result count'); }
    
    const callbackFnName = 'callback_' + callbackIdx;
    const callbackFn = getCallbackFn();
    preparedTask.setCallbackFn(callbackFn, callbackFnName);
    preparedTask.setPostReturnFn(getPostReturnFn());
    
    if (resultCount < 0 || resultCount > 1) {
      throw new Error(`unsupported result count [${ resultCount }]`);
    }
    
    const params = preparedTask.getCalleeParams();
    if (paramCount !== params.length) {
      throw new Error(`unexpected callee param count [${ params.length }], _asyncStartCall invocation expected [${ paramCount }]`);
    }
    
    const callerComponentState = getOrCreateAsyncState(subtask.componentIdx());
    
    const calleeComponentState = getOrCreateAsyncState(preparedTask.componentIdx());
    const calleeBackpressure = calleeComponentState.hasBackpressure();
    
    // Set up a handler on subtask completion to lower results from the call into the caller's memory region.
    //
    // NOTE: during fused guest->guest calls this handler is triggered, but does not actually perform
    // lowering manually, as fused modules provider helper functions that can
    subtask.registerOnResolveHandler((res) => {
      _debugLog('[_asyncStartCall()] handling subtask result', { res, subtaskID: subtask.id() });
      
      let subtaskCallMeta = subtask.getCallMetadata();
      
      // NOTE: in the case of guest -> guest async calls, there may be no memory/realloc present,
      // as the host will intermediate the value storage/movement between calls.
      //
      // We can simply take the value and lower it as a parameter
      if (subtaskCallMeta.memory || subtaskCallMeta.realloc) {
        throw new Error("call metadata unexpectedly contains memory/realloc for guest->guest call");
      }
      
      const callerTask = subtask.getParentTask();
      const calleeTask = preparedTask;
      const callerMemoryIdx = callerTask.getReturnMemoryIdx();
      const callerComponentIdx = callerTask.componentIdx();
      
      // If a helper function was provided we are likely in a fused guest->guest call,
      // and the result will be delivered (lift/lowered) via helper function
      if (subtaskCallMeta && subtaskCallMeta.returnFn) {
        _debugLog('[_asyncStartCall()] return function present while handling subtask result, returning early (skipping lower)', {
          calleeTaskID: calleeTask.id(),
          calleeComponentIdx,
        });
        
        // TODO: centralize calling of returnFn to *one place* (if possible)
        if (subtaskCallMeta.returnFnCalled) { return; }
        
        const res = subtaskCallMeta.returnFn.apply(null, [subtaskCallMeta.resultPtr]);
        
        _debugLog('[_asyncStartCall()] finished calling return fn', {
          calleeTaskID: calleeTask.id(),
          calleeComponentIdx,
          res,
        });
        
        return;
      }
      
      // If there is no where to lower the results, exit early
      if (!subtaskCallMeta.resultPtr) {
        _debugLog('[_asyncStartCall()] no result ptr during subtask result handling, returning early (skipping lower)');
        return;
      }
      
      let callerMemory;
      if (callerMemoryIdx !== null && callerMemoryIdx !== undefined) {
        callerMemory = lookupMemoriesForComponent({ componentIdx: callerComponentIdx, memoryIdx: callerMemoryIdx });
      } else {
        const callerMemories = lookupMemoriesForComponent({ componentIdx: callerComponentIdx });
        if (callerMemories.length !== 1) { throw new Error(`unsupported amount of caller memories`); }
        callerMemory = callerMemories[0];
      }
      
      if (!callerMemory) {
        _debugLog('[_asyncStartCall()] missing memory', { subtaskID: subtask.id(), res });
        throw new Error(`missing memory for to guest->guest call result (subtask [${subtask.id()}])`);
      }
      
      const lowerFns = calleeTask.getReturnLowerFns();
      if (!lowerFns || lowerFns.length === 0) {
        _debugLog('[_asyncStartCall()] missing result lower metadata for guest->guest call', { subtaskID: subtask.id() });
        throw new Error(`missing result lower metadata for guest->guest call (subtask [${subtask.id()}])`);
      }
      
      if (lowerFns.length !== 1) {
        _debugLog('[_asyncStartCall()] only single result reportetd for guest->guest call', { subtaskID: subtask.id() });
        throw new Error(`only single result supported for guest->guest calls (subtask [${subtask.id()}])`);
      }
      
      _debugLog('[_asyncStartCall()] lowering results', { subtaskID: subtask.id() });
      lowerFns[0]({
        realloc: undefined,
        memory: callerMemory,
        vals: [res],
        storagePtr: subtaskCallMeta.resultPtr,
        componentIdx: callerComponentIdx,
        stringEncoding: subtaskCallMeta.stringEncoding,
      });
      
    });
    
    subtask.setOnProgressFn(() => {
      subtask.setPendingEvent(() => {
        if (subtask.isResolved()) { subtask.deliverResolve(); }
        const event = {
          code: ASYNC_EVENT_CODE.SUBTASK,
          payload0: subtask.waitableRep(),
          payload1: subtask.getStateNumber(),
        };
        return event;
      });
    });
    
    // Start the (event) driver loop that will resolve the subtask
    // in a new JS task
    setTimeout(async () => {
      _debugLog('[_asyncStartCall()] continuing started subtask (in JS task)', {
        taskID: preparedTask.id(),
        subtaskID: subtask.id(),
        callerComponentIdx,
        calleeComponentIdx,
      });
      
      let startRes = subtask.onStart({ startFnParams: params });
      startRes = Array.isArray(startRes) ? startRes : [startRes];
      
      if (calleeComponentState.isExclusivelyLocked()) {
        _debugLog('[_asyncStartCall()] during continuation callee is exclusively locked, suspending...', {
          taskID: preparedTask.id(),
          subtaskID: subtask.id(),
          callerComponentIdx,
          calleeComponentIdx,
        });
        await calleeComponentState.suspendTask({
          task: preparedTask,
          readyFn: () => !calleeComponentState.isExclusivelyLocked(),
        });
      }
      
      const started = await preparedTask.enter();
      if (!started) {
        _debugLog('[_asyncStartCall()] task failed early', {
          taskID: preparedTask.id(),
          subtaskID: subtask.id(),
        });
        throw new Error("task failed to start");
        return;
      }
      
      let callbackResult;
      try {
        let jspiCallee;
        if (callee._cachedPromising) {
          jspiCallee = callee._cachedPromising;
        } else {
          callee._cachedPromising = WebAssembly.promising(callee);
          jspiCallee = callee._cachedPromising;
        }
        
        callbackResult = await _withGlobalCurrentTaskMetaAsync({
          taskID: preparedTask.id(),
          componentIdx: preparedTask.componentIdx(),
          fn: () => {
            return jspiCallee.apply(null, startRes);
          }
        });
      } catch(err) {
        _debugLog("[_asyncStartCall()] initial subtask callee run failed", err);
        // NOTE: a good place to rejectt the parent task, if rejection API is enabled
        // subtask.reject(err);
        // subtask.getParentTask().reject(err);
        
        subtask.getParentTask().setErrored(err);
        
        return;
      }
      
      // If there was no callback function, we're dealing with a sync function
      // that was lifted as async without one, there is only the callee.
      if (!callbackFn) {
        _debugLog("[_asyncStartCall()] no callback, resolving w/ callee result", {
          taskID: preparedTask.id(),
          componentIdx: preparedTask.componentIdx(),
          preparedTask,
          stateNumber: preparedTask.taskState(),
          isResolved: preparedTask.isResolved(),
          callbackFn,
        });
        preparedTask.resolve([callbackResult]);
        return;
      }
      
      let fnName = callbackFn.fnName;
      if (!fnName) {
        fnName = [
        '<task ',
        subtask.parentTaskID(),
        '/subtask ',
        subtask.id(),
        '/task ',
        preparedTask.id(),
        '>',
        ].join("");
      }
      
      try {
        _debugLog("[_asyncStartCall()] starting driver loop", {
          fnName,
          componentIdx: preparedTask.componentIdx(),
          subtaskID: subtask.id(),
          childTaskID: subtask.childTaskID(),
          parentTaskID: subtask.parentTaskID(),
        });
        
        await _driverLoop({
          componentState: calleeComponentState,
          task: preparedTask,
          fnName,
          isAsync: true,
          callbackResult,
          resolve,
          reject
        });
      } catch (err) {
        _debugLog("[AsyncStartCall] drive loop call failure", { err });
      }
      
    }, 0);
    
    const subtaskState = subtask.getStateNumber();
    if (subtaskState < 0 || subtaskState > 2**5) {
      throw new Error('invalid subtask state, out of valid range');
    }
    
    _debugLog('[_asyncStartCall()] returning subtask rep & state', {
      subtask: {
        rep: subtask.waitableRep(),
        state: subtaskState,
      }
    });
    
    return Number(subtask.waitableRep()) << 4 | subtaskState;
  }
  
  function _syncStartCall(callbackIdx) {
    _debugLog('[_syncStartCall()] args', { callbackIdx });
    throw new Error('synchronous start call not implemented!');
  }
  
  class Waitable {
    #componentIdx;
    
    #pendingEventFn = null;
    
    #promise;
    #resolve;
    #reject;
    
    #waitableSet = null;
    
    #hasSyncWaiter = false;
    
    #idx = null; // to component-global waitables
    
    target;
    
    constructor(args) {
      const { componentIdx, target } = args;
      this.#componentIdx = componentIdx;
      this.target = args.target;
      this.#resetPromise();
    }
    
    componentIdx() { return this.#componentIdx; }
    isInSet() { return this.#waitableSet !== null; }
    
    idx() { return this.#idx; }
    setIdx(idx) {
      if (idx === 0) { throw new Error("waitable idx cannot be zero"); }
      this.#idx = idx;
    }
    
    setTarget(tgt) { this.target = tgt; }
    
    #resetPromise() {
      const { promise, resolve, reject } = promiseWithResolvers()
      this.#promise = promise;
      this.#resolve = resolve;
      this.#reject = reject;
    }
    
    resolve() { this.#resolve(); }
    reject(err) { this.#reject(err); }
    promise() { return this.#promise; }
    
    hasPendingEvent() {
      // _debugLog('[Waitable#hasPendingEvent()]', {
        //     componentIdx: this.#componentIdx,
        //     waitable: this,
        //     waitableSet: this.#waitableSet,
        //     hasPendingEvent: this.#pendingEventFn !== null,
        // });
        return this.#pendingEventFn !== null;
      }
      
      setPendingEvent(fn) {
        _debugLog('[Waitable#setPendingEvent()] args', {
          waitable: this,
          inSet: this.#waitableSet,
        });
        this.#pendingEventFn = fn;
      }
      
      getPendingEvent() {
        _debugLog('[Waitable#getPendingEvent()] args', {
          waitable: this,
          inSet: this.#waitableSet,
          hasPendingEvent: this.#pendingEventFn !== null,
        });
        if (this.#pendingEventFn === null) { return null; }
        const eventFn = this.#pendingEventFn;
        this.#pendingEventFn = null;
        const e = eventFn();
        this.#resetPromise();
        return e;
      }
      
      join(waitableSet) {
        _debugLog('[Waitable#join()] args', {
          waitable: this,
          waitableSet: waitableSet,
          isRemoval: waitableSet === null,
        });
        
        if (this.#waitableSet === undefined) {
          throw new TypeError('waitable set must be not be undefined');
        }
        
        if (this.#waitableSet) {
          this.#waitableSet.removeWaitable(this);
        }
        
        this.#waitableSet = waitableSet;
        
        if (waitableSet) {
          this.#waitableSet.addWaitable(this);
        }
      }
      
      drop() {
        _debugLog('[Waitable#drop()] args', {
          componentIdx: this.#componentIdx,
          waitable: this,
        });
        if (this.hasPendingEvent()) {
          throw new Error('waitables with pending events cannot be dropped');
        }
        this.join(null);
      }
      
      async waitForPendingEvent(args) {
        const { cstate } = args;
        if (!cstate) { throw new TypeError('missing component state'); }
        
        if (this.#waitableSet !== null || this.#hasSyncWaiter) {
          throw new Error("waitable is already in a set/has a sync waiter");
        }
        this.#hasSyncWaiter = true;
        await cstate.waitUntil({
          cancellable: false,
          readyFn: () => this.hasPendingEvent(),
        });
        this.#hasSyncWaiter = false;
      }
      
    }
    
    const ERR_CTX_TABLES = {};
    
    function contextGet(ctx) {
      const { componentIdx, slot } = ctx;
      if (componentIdx === undefined) { throw new TypeError("missing component idx"); }
      if (slot === undefined) { throw new TypeError("missing slot"); }
      
      const currentTaskMeta = _getGlobalCurrentTaskMeta(componentIdx);
      if (!currentTaskMeta) {
        throw new Error(`missing/incomplete global current task meta for component idx [${componentIdx}] during context set`);
      }
      const taskID = currentTaskMeta.taskID;
      
      const taskMeta = getCurrentTask(componentIdx, taskID);
      if (!taskMeta) { throw new Error('failed to retrieve current task'); }
      
      let task = taskMeta.task;
      if (!task) { throw new Error('invalid/missing current task in metadata while getting context'); }
      
      _debugLog('[contextGet()] args', {
        slot,
        storage: task.storage,
        taskID: task.id(),
        componentIdx: task.componentIdx(),
      });
      
      if (slot < 0 || slot >= task.storage.length) { throw new Error('invalid slot for current task'); }
      
      return task.storage[slot];
    }
    
    
    function contextSet(ctx, value) {
      const { componentIdx, slot } = ctx;
      if (componentIdx === undefined) { throw new TypeError("missing component idx"); }
      if (slot === undefined) { throw new TypeError("missing slot"); }
      if (!(_typeCheckValidI32(value))) { throw new Error('invalid value for context set (not valid i32)'); }
      
      const currentTaskMeta = _getGlobalCurrentTaskMeta(componentIdx);
      if (!currentTaskMeta) {
        throw new Error(`missing/incomplete global current task meta for component idx [${componentIdx}] during context set`);
      }
      const taskID = currentTaskMeta.taskID;
      
      const taskMeta = getCurrentTask(componentIdx, taskID);
      if (!taskMeta) { throw new Error('failed to retrieve current task'); }
      
      let task = taskMeta.task;
      if (!task) { throw new Error('invalid/missing current task in metadata while setting context'); }
      
      _debugLog('[contextSet()] args', {
        slot,
        value,
        storage: task.storage,
        taskID: task.id(),
        componentIdx: task.componentIdx(),
      });
      
      if (slot < 0 || slot >= task.storage.length) { throw new Error('invalid slot for current task'); }
      task.storage[slot] = value;
    }
    
    const ASYNC_TASKS_BY_COMPONENT_IDX = new Map();
    
    class AsyncTask {
      static _ID = 0n;
      
      static State = {
        INITIAL: 'initial',
        CANCELLED: 'cancelled',
        CANCEL_PENDING: 'cancel-pending',
        CANCEL_DELIVERED: 'cancel-delivered',
        RESOLVED: 'resolved',
      }
      
      static BlockResult = {
        CANCELLED: 'block.cancelled',
        NOT_CANCELLED: 'block.not-cancelled',
      }
      
      #id;
      #componentIdx;
      #state;
      #isAsync;
      #isManualAsync;
      #entryFnName = null;
      
      #onResolveHandlers = [];
      #completionPromise = null;
      #rejected = false;
      
      #exitPromise = null;
      #onExitHandlers = [];
      
      #memoryIdx = null;
      #memory = null;
      
      #callbackFn = null;
      #callbackFnName = null;
      
      #postReturnFn = null;
      
      #getCalleeParamsFn = null;
      
      #stringEncoding = null;
      
      #parentSubtask = null;
      
      #errHandling;
      
      #backpressurePromise;
      #backpressureWaiters = 0n;
      
      #returnLowerFns = null;
      
      #subtasks = [];
      
      #entered = false;
      #exited = false;
      #errored = null;
      
      cancelled = false;
      cancelRequested = false;
      alwaysTaskReturn = false;
      
      returnCalls =  0;
      storage = [0, 0];
      borrowedHandles = {};
      
      tmpRetI64HighBits = 0|0;
      
      constructor(opts) {
        this.#id = ++AsyncTask._ID;
        
        if (opts?.componentIdx === undefined) {
          throw new TypeError('missing component id during task creation');
        }
        this.#componentIdx = opts.componentIdx;
        
        this.#state = AsyncTask.State.INITIAL;
        this.#isAsync = opts?.isAsync ?? false;
        this.#isManualAsync = opts?.isManualAsync ?? false;
        this.#entryFnName = opts.entryFnName;
        
        const {
          promise: completionPromise,
          resolve: resolveCompletionPromise,
          reject: rejectCompletionPromise,
        } = promiseWithResolvers();
        this.#completionPromise = completionPromise;
        
        this.#onResolveHandlers.push((results) => {
          if (this.#parentSubtask !== null) { return; }
          if (!this.#isAsync) { return; }
          
          if (this.#errored !== null) {
            rejectCompletionPromise(this.#errored);
            return;
          } else if (this.#rejected) {
            rejectCompletionPromise(results);
            return;
          }
          
          resolveCompletionPromise(results);
        });
        
        const {
          promise: exitPromise,
          resolve: resolveExitPromise,
          reject: rejectExitPromise,
        } = promiseWithResolvers();
        this.#exitPromise = exitPromise;
        
        this.#onExitHandlers.push(() => {
          resolveExitPromise();
        });
        
        if (opts.callbackFn) { this.#callbackFn = opts.callbackFn; }
        if (opts.callbackFnName) { this.#callbackFnName = opts.callbackFnName; }
        
        if (opts.getCalleeParamsFn) { this.#getCalleeParamsFn = opts.getCalleeParamsFn; }
        
        if (opts.stringEncoding) { this.#stringEncoding = opts.stringEncoding; }
        
        if (opts.parentSubtask) { this.#parentSubtask = opts.parentSubtask; }
        
        
        if (opts.errHandling) { this.#errHandling = opts.errHandling; }
      }
      
      taskState() { return this.#state; }
      id() { return this.#id; }
      componentIdx() { return this.#componentIdx; }
      entryFnName() { return this.#entryFnName; }
      
      completionPromise() { return this.#completionPromise; }
      exitPromise() { return this.#exitPromise; }
      
      isAsync() { return this.#isAsync; }
      isSync() { return !this.isAsync(); }
      
      getErrHandling() { return this.#errHandling; }
      
      hasCallback() { return this.#callbackFn !== null; }
      
      getReturnMemoryIdx() { return this.#memoryIdx; }
      setReturnMemoryIdx(idx) {
        if (idx === null) { return; }
        this.#memoryIdx = idx;
      }
      
      getReturnMemory() { return this.#memory; }
      setReturnMemory(m) {
        if (m === null) { return; }
        this.#memory = m;
      }
      
      setReturnLowerFns(fns) { this.#returnLowerFns = fns; }
      getReturnLowerFns() { return this.#returnLowerFns; }
      
      setParentSubtask(subtask) {
        if (!subtask || !(subtask instanceof AsyncSubtask)) { return }
        if (this.#parentSubtask) { throw new Error('parent subtask can only be set once'); }
        this.#parentSubtask = subtask;
      }
      
      getParentSubtask() { return this.#parentSubtask; }
      
      // TODO(threads): this is very inefficient, we can pass along a root task,
      // and ideally do not need this once thread support is in place
      getRootTask() {
        let currentSubtask = this.getParentSubtask();
        let task = this;
        while (currentSubtask) {
          task = currentSubtask.getParentTask();
          currentSubtask = task.getParentSubtask();
        }
        return task;
      }
      
      setPostReturnFn(f) {
        if (!f) { return; }
        if (this.#postReturnFn) { throw new Error('postReturn fn can only be set once'); }
        this.#postReturnFn = f;
      }
      
      setCallbackFn(f, name) {
        if (!f) { return; }
        if (this.#callbackFn) { throw new Error('callback fn can only be set once'); }
        this.#callbackFn = f;
        this.#callbackFnName = name;
      }
      
      getCallbackFnName() {
        if (!this.#callbackFnName) { return undefined; }
        return this.#callbackFnName;
      }
      
      async runCallbackFn(...args) {
        if (!this.#callbackFn) { throw new Error('no callback function has been set for task'); }
        return _withGlobalCurrentTaskMetaAsync({
          taskID: this.#id,
          componentIdx: this.#componentIdx,
          fn: () => { return this.#callbackFn.apply(null, args); }
        });
      }
      
      getCalleeParams() {
        if (!this.#getCalleeParamsFn) { throw new Error('missing/invalid getCalleeParamsFn'); }
        return this.#getCalleeParamsFn();
      }
      
      mayBlock() { return this.isAsync() || this.isResolvedState() }
      
      mayEnter(task) {
        const cstate = getOrCreateAsyncState(this.#componentIdx);
        if (cstate.hasBackpressure()) {
          _debugLog('[AsyncTask#mayEnter()] disallowed due to backpressure', { taskID: this.#id });
          return false;
        }
        if (!cstate.callingSyncImport()) {
          _debugLog('[AsyncTask#mayEnter()] disallowed due to sync import call', { taskID: this.#id });
          return false;
        }
        const callingSyncExportWithSyncPending = cstate.callingSyncExport && !task.isAsync;
        if (!callingSyncExportWithSyncPending) {
          _debugLog('[AsyncTask#mayEnter()] disallowed due to sync export w/ sync pending', { taskID: this.#id });
          return false;
        }
        return true;
      }
      
      enterSync() {
        if (this.needsExclusiveLock()) {
          const cstate = getOrCreateAsyncState(this.#componentIdx);
          // TODO(???): it is *very possible* for a the line below to fail if
          // an async function is already running (and holding the exclusive lock)
          //
          // It's not really possible to fix this unless we turn every sync export into
          // an async export that will use the regular async enabled `enter()`.
          cstate.exclusiveLock();
        }
        return true;
      }
      
      async enter(opts) {
        _debugLog('[AsyncTask#enter()] args', {
          taskID: this.#id,
          componentIdx: this.#componentIdx,
          subtaskID: this.getParentSubtask()?.id(),
          args: opts,
          entryFnName: this.#entryFnName,
        });
        
        if (this.#entered) {
          throw new Error(`task with ID [${this.#id}] should not be entered twice`);
        }
        
        const cstate = getOrCreateAsyncState(this.#componentIdx);
        
        if (opts?.isHost) {
          this.#entered = true;
          return this.#entered;
        }
        
        await cstate.nextTaskExecutionSlot({ task: this });
        
        // If a task is synchronous then we can avoid component-relevant
        // tracking and immediately enter.
        if (this.isSync()) {
          this.#entered = true;
          
          // TODO(breaking): remove once manually-specifying async fns is removed
          // It is currently possible for an actually sync export to be specified
          // as async via JSPI
          if (this.#isManualAsync) {
            if (this.needsExclusiveLock()) { cstate.exclusiveLock(); }
          }
          
          return this.#entered;
        }
        
        // Perform intial backpressure check
        if (cstate.hasBackpressure() || this.needsExclusiveLock() && cstate.isExclusivelyLocked()) {
          cstate.addBackpressureWaiter();
          
          const result = await this.waitUntil({
            readyFn: () => {
              return !(cstate.hasBackpressure()
              || this.needsExclusiveLock() && cstate.isExclusivelyLocked());
            },
            cancellable: true,
          });
          
          cstate.removeBackpressureWaiter();
          
          if (result === AsyncTask.BlockResult.CANCELLED) {
            this.cancel();
            return false;
          }
        }
        
        // Lock the component state or keep trying until we can/do
        try {
          if (this.needsExclusiveLock()) { cstate.exclusiveLock(); }
        } catch {
          // Continuously attempt to lock until we can
          while (cstate.hasBackpressure() || this.needsExclusiveLock() && cstate.isExclusivelyLocked()) {
            try {
              if (this.needsExclusiveLock()) { cstate.exclusiveLock(); }
              break;
            } catch(err) {
              cstate.addBackpressureWaiter();
              const result = await this.waitUntil({
                readyFn: () => {
                  return !(cstate.hasBackpressure()
                  || this.needsExclusiveLock() && cstate.isExclusivelyLocked());
                },
                cancellable: true,
              });
              cstate.removeBackpressureWaiter();
              if (result === AsyncTask.BlockResult.CANCELLED) {
                this.cancel();
                return false;
              }
            }
          }
        }
        
        this.#entered = true;
        return this.#entered;
      }
      
      isRunningState() { return this.#state !== AsyncTask.State.RESOLVED; }
      isResolvedState() { return this.#state === AsyncTask.State.RESOLVED; }
      isResolved() { return this.#state === AsyncTask.State.RESOLVED; }
      
      async waitUntil(opts) {
        const { readyFn, cancellable } = opts;
        _debugLog('[AsyncTask#waitUntil()] args', { taskID: this.#id, args: { cancellable } });
        
        // TODO(fix): check for cancel
        // TODO(fix): determinism
        // TODO(threads): add this thread to waiting list
        
        const keepGoing = await this.suspendUntil({
          readyFn,
          cancellable,
        });
        
        return keepGoing;
      }
      
      async yieldUntil(opts) {
        const { readyFn, cancellable } = opts;
        _debugLog('[AsyncTask#yieldUntil()]', {
          taskID: this.#id,
          args: {
            cancellable,
          },
          componentIdx: this.#componentIdx,
        });
        
        const keepGoing = await this.suspendUntil({ readyFn, cancellable });
        if (keepGoing) {
          return {
            code: ASYNC_EVENT_CODE.NONE,
            payload0: 0,
            payload1: 0,
          };
        }
        
        return {
          code: ASYNC_EVENT_CODE.TASK_CANCELLED,
          payload0: 0,
          payload1: 0,
        };
      }
      
      async suspendUntil(opts) {
        const { cancellable, readyFn } = opts;
        _debugLog('[AsyncTask#suspendUntil()] args', {
          taskID: this.#id,
          args: {
            cancellable,
          },
          componentIdx: this.#componentIdx,
        });
        
        const pendingCancelled = this.deliverPendingCancel({ cancellable });
        if (pendingCancelled) { return false; }
        
        const completed = await this.immediateSuspendUntil({ readyFn, cancellable });
        return completed;
      }
      
      // TODO(threads): equivalent to thread.suspend_until()
      async immediateSuspendUntil(opts) {
        const { cancellable, readyFn } = opts;
        _debugLog('[AsyncTask#immediateSuspendUntil()] args', {
          args: {
            cancellable,
            readyFn,
          },
          taskID: this.#id,
          componentIdx: this.#componentIdx,
        });
        
        const ready = readyFn();
        if (ready && ASYNC_DETERMINISM === 'random') {
          const coinFlip = _coinFlip();
          if (coinFlip) { return true }
        }
        
        const keepGoing = await this.immediateSuspend({ cancellable, readyFn });
        return keepGoing;
      }
      
      async immediateSuspend(opts) { // NOTE: equivalent to thread.suspend()
      // TODO(threads): store readyFn on the thread
      const { cancellable, readyFn } = opts;
      _debugLog('[AsyncTask#immediateSuspend()] args', { cancellable, readyFn });
      
      const pendingCancelled = this.deliverPendingCancel({ cancellable });
      if (pendingCancelled) { return false; }
      
      const cstate = getOrCreateAsyncState(this.#componentIdx);
      const keepGoing = await cstate.suspendTask({ task: this, readyFn });
      return keepGoing;
    }
    
    deliverPendingCancel(opts) {
      const { cancellable } = opts;
      _debugLog('[AsyncTask#deliverPendingCancel()]', {
        args: { cancellable },
        taskID: this.#id,
        componentIdx: this.#componentIdx,
      });
      
      if (cancellable && this.#state === AsyncTask.State.PENDING_CANCEL) {
        this.#state = AsyncTask.State.CANCEL_DELIVERED;
        return true;
      }
      
      return false;
    }
    
    isCancelled() { return this.cancelled }
    
    cancel(args) {
      _debugLog('[AsyncTask#cancel()] args', { });
      if (this.taskState() !== AsyncTask.State.CANCEL_DELIVERED) {
        throw new Error(`(component [${this.#componentIdx}]) task [${this.#id}] invalid task state [${this.taskState()}] for cancellation`);
      }
      if (this.borrowedHandles.length > 0) { throw new Error('task still has borrow handles'); }
      this.cancelled = true;
      this.onResolve(args?.error ?? new Error('task cancelled'));
      this.#state = AsyncTask.State.RESOLVED;
    }
    
    onResolve(taskValue) {
      const handlers = this.#onResolveHandlers;
      this.#onResolveHandlers = [];
      for (const f of handlers) {
        try {
          f(taskValue);
        } catch (err) {
          _debugLog("[AsyncTask#onResolve] error during task resolve handler", err);
          throw err;
        }
      }
      
      if (this.#parentSubtask) {
        const meta = this.#parentSubtask.getCallMetadata();
        // Run the rturn fn if it has not already been called -- this *should* have happened in
        // `task.return`, but some paths do not go through task.return (e.g. async lower of sync fn
        // which goes through prepare + async-start-call)
        if (meta.returnFn && !meta.returnFnCalled) {
          _debugLog('[AsyncTask#onResolve()] running returnFn', {
            componentIdx: this.#componentIdx,
            taskID: this.#id,
            subtaskID: this.#parentSubtask.id(),
          });
          const memory = meta.getMemoryFn();
          meta.returnFn.apply(null, [taskValue, meta.resultPtr]);
          meta.returnFnCalled = true;
        }
      }
      
      if (this.#postReturnFn) {
        _debugLog('[AsyncTask#onResolve()] running post return ', {
          componentIdx: this.#componentIdx,
          taskID: this.#id,
        });
        try {
          this.#postReturnFn(taskValue);
        } catch (err) {
          _debugLog("[AsyncTask#onResolve] error during task resolve handler", err);
          throw err;
        }
      }
      
      if (this.#parentSubtask) {
        this.#parentSubtask.onResolve(taskValue);
      }
    }
    
    registerOnResolveHandler(f) {
      this.#onResolveHandlers.push(f);
    }
    
    isRejected() { return this.#rejected; }
    
    isErrored() { return this.#errored; }
    setErrored(err) { this.#errored = err; }
    
    reject(taskErr) {
      _debugLog('[AsyncTask#reject()] args', {
        componentIdx: this.#componentIdx,
        taskID: this.#id,
        parentSubtask: this.#parentSubtask,
        parentSubtaskID: this.#parentSubtask?.id(),
        entryFnName: this.entryFnName(),
        callbackFnName: this.#callbackFnName,
        errMsg: taskErr.message,
      });
      
      if (this.isResolvedState() || this.#rejected) { return; }
      
      this.#rejected = true;
      this.cancelRequested = true;
      this.#state = AsyncTask.State.PENDING_CANCEL;
      const cancelled = this.deliverPendingCancel({ cancellable: true });
      
      // TODO: do cleanup here to reset the machinery so we can run again?
      
      this.cancel({ error: taskErr });
    }
    
    resolve(results) {
      _debugLog('[AsyncTask#resolve()] args', {
        componentIdx: this.#componentIdx,
        taskID: this.#id,
        entryFnName: this.entryFnName(),
        callbackFnName: this.#callbackFnName,
      });
      
      if (this.#state === AsyncTask.State.RESOLVED) {
        throw new Error(`(component [${this.#componentIdx}]) task [${this.#id}]  is already resolved (did you forget to wait for an import?)`);
      }
      
      if (this.borrowedHandles.length > 0) {
        throw new Error('task still has borrow handles');
      }
      
      this.#state = AsyncTask.State.RESOLVED;
      
      switch (results.length) {
        case 0:
        this.onResolve(undefined);
        break;
        case 1:
        this.onResolve(results[0]);
        break;
        default:
        _debugLog('[AsyncTask#resolve()] unexpected number of results', {
          componentIdx: this.#componentIdx,
          results,
          taskID: this.#id,
          subtaskID: this.#parentSubtask?.id(),
          entryFnName: this.#entryFnName,
          callbackFnName: this.#callbackFnName,
        });
        throw new Error('unexpected number of results');
      }
    }
    
    exit(args) {
      _debugLog('[AsyncTask#exit()]', {
        componentIdx: this.#componentIdx,
        taskID: this.#id,
      });
      
      if (this.#exited)  { throw new Error("task has already exited"); }
      
      if (this.#state !== AsyncTask.State.RESOLVED) {
        throw new Error(`(component [${this.#componentIdx}]) task [${this.#id}] exited without resolution`);
      }
      
      if (this.borrowedHandles > 0) {
        throw new Error('task [${this.#id}] exited without clearing borrowed handles');
      }
      
      const state = getOrCreateAsyncState(this.#componentIdx);
      if (!state) { throw new Error('missing async state for component [' + this.#componentIdx + ']'); }
      
      // Exempt the host from exclusive lock check
      if (this.#componentIdx !== -1 && !args?.skipExclusiveLockCheck) {
        if (this.needsExclusiveLock() && !state.isExclusivelyLocked()) {
          throw new Error(`task [${this.#id}] exit: component [${this.#componentIdx}] should have been exclusively locked`);
        }
      }
      
      state.exclusiveRelease();
      
      for (const f of this.#onExitHandlers) {
        try {
          f();
        } catch (err) {
          console.error("error during task exit handler", err);
          throw err;
        }
      }
      
      this.#exited = true;
      clearCurrentTask(this.#componentIdx, this.id());
    }
    
    needsExclusiveLock() {
      return !this.#isAsync || this.hasCallback();
    }
    
    createSubtask(args) {
      _debugLog('[AsyncTask#createSubtask()] args', args);
      const { componentIdx, childTask, callMetadata, fnName, isAsync, isManualAsync } = args;
      
      const cstate = getOrCreateAsyncState(this.#componentIdx);
      if (!cstate) {
        throw new Error(`invalid/missing async state for component idx [${componentIdx}]`);
      }
      
      const waitable = new Waitable({
        componentIdx: this.#componentIdx,
        target: `subtask (internal ID [${this.#id}])`,
      });
      
      const newSubtask = new AsyncSubtask({
        componentIdx,
        childTask,
        parentTask: this,
        callMetadata,
        isAsync,
        isManualAsync,
        fnName,
        waitable,
      });
      this.#subtasks.push(newSubtask);
      newSubtask.setTarget(`subtask (internal ID [${newSubtask.id()}], waitable [${waitable.idx()}], component [${componentIdx}])`);
      waitable.setIdx(cstate.handles.insert(newSubtask));
      waitable.setTarget(`waitable for subtask (waitable id [${waitable.idx()}], subtask internal ID [${newSubtask.id()}])`);
      return newSubtask;
    }
    
    getLatestSubtask() {
      return this.#subtasks.at(-1);
    }
    
    getSubtaskByWaitableRep(rep) {
      if (rep === undefined) { throw new TypeError('missing rep'); }
      return this.#subtasks.find(s => s.waitableRep() === rep);
    }
    
    currentSubtask() {
      _debugLog('[AsyncTask#currentSubtask()]');
      if (this.#subtasks.length === 0) { return undefined; }
      return this.#subtasks.at(-1);
    }
    
    removeSubtask(subtask) {
      if (this.#subtasks.length === 0) {
        throw new Error('cannot end current subtask: no current subtask');
      }
      this.#subtasks = this.#subtasks.filter(t => t !== subtask);
      return subtask;
    }
  }
  
  const ASYNC_EVENT_CODE = {
    NONE: 0,
    SUBTASK: 1,
    STREAM_READ: 2,
    STREAM_WRITE: 3,
    FUTURE_READ: 4,
    FUTURE_WRITE: 5,
    TASK_CANCELLED: 6,
  };
  
  function getCurrentTask(componentIdx, taskID) {
    let usedGlobal = false;
    if (componentIdx === undefined || componentIdx === null) {
      throw new Error('missing component idx'); // TODO(fix)
      // componentIdx = ASYNC_CURRENT_COMPONENT_IDXS.at(-1);
      // usedGlobal = true;
    }
    
    const taskMetas = ASYNC_TASKS_BY_COMPONENT_IDX.get(componentIdx);
    if (taskMetas === undefined || taskMetas.length === 0) { return undefined; }
    
    if (taskID) {
      return taskMetas.find(meta => meta.task.id() === taskID);
    }
    
    const taskMeta = taskMetas[taskMetas.length - 1];
    if (!taskMeta || !taskMeta.task) { return undefined; }
    
    return taskMeta;
  }
  
  let dv = new DataView(new ArrayBuffer());
  const dataView = mem => dv.buffer === mem.buffer ? dv : dv = new DataView(mem.buffer);
  
  function toInt64(val) {
    const converted = BigInt(val)
    
    return BigInt.asIntN(64, converted);
  }
  
  
  function toUint64(val) {
    const converted = BigInt(val)
    
    return BigInt.asUintN(64, converted);
  }
  
  
  function toInt32(val) {
    
    return val >> 0;
  }
  
  
  function toUint32(val) {
    
    return val >>> 0;
  }
  
  
  function toUint8(val) {
    
    val >>>= 0;
    val %= 2 ** 8;
    return val;
  }
  
  
  function _utf16AllocateAndEncode(str, realloc, memory) {
    const len = str.length;
    const ptr = realloc(0, 0, 2, len * 2);
    const out = new Uint16Array(memory.buffer, ptr, len);
    let i = 0;
    if (isLE) {
      while (i < len) { out[i] = str.charCodeAt(i++); }
    } else {
      while (i < len) {
        const ch = str.charCodeAt(i);
        out[i++] = (ch & 0xff) << 8 | ch >>> 8;
      }
    }
    return { ptr, len, codepoints: [...str].length };
  }
  
  const TEXT_DECODER_UTF8 = new TextDecoder();
  const TEXT_ENCODER_UTF8 = new TextEncoder();
  
  function _utf8AllocateAndEncode(s, realloc, memory) {
    if (typeof s !== 'string') {
      throw new TypeError('expected a string, received [' + typeof s + ']');
    }
    if (s.length === 0) { return { ptr: 1, len: 0 }; }
    let buf = TEXT_ENCODER_UTF8.encode(s);
    let ptr = realloc(0, 0, 1, buf.length);
    new Uint8Array(memory.buffer).set(buf, ptr);
    const res = { ptr, len: buf.length, codepoints: [...s].length };
    return res;
  }
  
  
  const T_FLAG = 1 << 30;
  
  function rscTableCreateOwn(table, rep) {
    const free = table[0] & ~T_FLAG;
    table._createdReps.add(rep);
    if (free === 0) {
      table.push(0);
      table.push(rep | T_FLAG);
      return (table.length >> 1) - 1;
    }
    table[0] = table[free << 1];
    table[free << 1] = 0;
    table[(free << 1) + 1] = rep | T_FLAG;
    return free;
  }
  
  function rscTableRemove(table, handle) {
    const scope = table[handle << 1];
    const val = table[(handle << 1) + 1];
    const own = (val & T_FLAG) !== 0;
    const rep = val & ~T_FLAG;
    if (val === 0 || (scope & T_FLAG) !== 0) {
      throw new TypeError("Invalid handle");
    }
    table[handle << 1] = table[0] | T_FLAG;
    table[0] = handle | T_FLAG;
    return { rep, scope, own };
  }
  
  let curResourceBorrows = [];
  
  function createNewCurrentTask(args) {
    _debugLog('[createNewCurrentTask()] args', args);
    const {
      componentIdx,
      isAsync,
      isManualAsync,
      entryFnName,
      parentSubtaskID,
      callbackFnName,
      getCallbackFn,
      getParamsFn,
      stringEncoding,
      errHandling,
      getCalleeParamsFn,
      resultPtr,
      callingWasmExport,
    } = args;
    if (componentIdx === undefined || componentIdx === null) {
      throw new Error('missing/invalid component instance index while starting task');
    }
    let taskMetas = ASYNC_TASKS_BY_COMPONENT_IDX.get(componentIdx);
    const callbackFn = getCallbackFn ? getCallbackFn() : null;
    
    const newTask = new AsyncTask({
      componentIdx,
      isAsync,
      isManualAsync,
      entryFnName,
      callbackFn,
      callbackFnName,
      stringEncoding,
      getCalleeParamsFn,
      resultPtr,
      errHandling,
    });
    
    const newTaskID = newTask.id();
    const newTaskMeta = { id: newTaskID, componentIdx, task: newTask };
    
    // NOTE: do not track host tasks
    ASYNC_CURRENT_TASK_IDS.push(newTaskID);
    ASYNC_CURRENT_COMPONENT_IDXS.push(componentIdx);
    
    if (!taskMetas) {
      taskMetas = [newTaskMeta];
      ASYNC_TASKS_BY_COMPONENT_IDX.set(componentIdx, [newTaskMeta]);
    } else {
      taskMetas.push(newTaskMeta);
    }
    
    return [newTask, newTaskID];
  }
  
  function _lowerImportBackwardsCompat(args) {
    const params = [...arguments].slice(1);
    _debugLog('[_lowerImportBackwardsCompat()] args', { args, params });
    const {
      functionIdx,
      componentIdx,
      isAsync,
      isManualAsync,
      paramLiftFns,
      resultLowerFns,
      hasResultPointer,
      funcTypeIsAsync,
      metadata,
      memoryIdx,
      getMemoryFn,
      getReallocFn,
      importFn,
      stringEncoding,
    } = args;
    
    let meta = _getGlobalCurrentTaskMeta(componentIdx);
    let createdTask;
    
    // Some components depend on initialization logic (i.e. `_initialize` or some such
    // core wasm export) that is embedded in the component, but is not executed or wizer'd
    // away before the transpiled component is attempted to be used.
    //
    // These components execut their initialization logic *when they are imported* in the
    // transpiled context -- so we may get a call to an export that is lowered without going
    // through `CallWasm` or `CallInterface`.
    //
    if (!meta) {
      if (funcTypeIsAsync || (isAsync && !isManualAsync)) {
        throw new Error('p3 async wasm exports cannot use backwards compat auto-task init');
      }
      
      const [newTask, newTaskID] = createNewCurrentTask({
        componentIdx,
        isAsync,
        isManualAsync,
        callingWasmExport: false,
      });
      createdTask = newTask;
      
      // Since we're managing the task creation ourselves we must clear ourselves
      createdTask.registerOnResolveHandler(() => {
        _clearCurrentTask({
          taskID: task.id(),
          componentIdx: task.componentIdx(),
        });
      });
      
      _setGlobalCurrentTaskMeta({
        componentIdx,
        taskID: newTaskID,
      });
      
      meta = _getGlobalCurrentTaskMeta(componentIdx);
    }
    
    const { taskID } = meta;
    
    const taskMeta = getCurrentTask(componentIdx, taskID);
    if (!taskMeta) {
      throw new Error('invalid/missing async task meta');
    }
    
    const task = taskMeta.task;
    if (!task) { throw new Error('invalid/missing async task'); }
    
    const cstate = getOrCreateAsyncState(componentIdx);
    
    // TODO: re-enable this check -- postReturn can call imports though,
    // and that breaks things.
    //
    // if (!cstate.mayLeave) {
      //     throw new Error(`cannot leave instance [${componentIdx}]`);
      // }
      
      if (!task.mayBlock() && funcTypeIsAsync && !isAsync) {
        throw new Error("non async exports cannot synchronously call async functions");
      }
      
      // If there is an existing task, this should be part of a subtask
      const memory = getMemoryFn();
      // Canonical ABI lower appends result storage as a trailing
      // param when async lower has any flat result, or sync lower
      // has more than one flat result.
      const resultPtr = hasResultPointer ? params[params.length - 1] : undefined;
      const subtask = task.createSubtask({
        componentIdx,
        parentTask: task,
        fnName: importFn.fnName,
        isAsync,
        isManualAsync,
        callMetadata: {
          memoryIdx,
          memory,
          realloc: getReallocFn?.(),
          getReallocFn,
          resultPtr,
          lowers: resultLowerFns,
          stringEncoding,
        }
      });
      task.setReturnMemoryIdx(memoryIdx);
      task.setReturnMemory(getMemoryFn());
      
      subtask.onStart();
      
      // If dealing with a sync lowered sync function, we can directly return results
      //
      // TODO(breaking): remove once we get rid of manual async import specification,
      // as func types cannot be detected in that case only (and we don't need that w/ p3)
      if (!isManualAsync && !isAsync && !funcTypeIsAsync) {
        if (createdTask) { createdTask.enterSync(); }
        
        const res = importFn(...params);
        
        // TODO(breaking): remove once we get rid of manual async import specification,
        // as func types cannot be detected in that case only (and we don't need that w/ p3)
        if (!funcTypeIsAsync && !subtask.isReturned()) {
          throw new Error('post-execution subtasks must either be async or returned');
        }
        
        const syncRes = subtask.getResult();
        if (createdTask) { createdTask.resolve([syncRes]); }
        
        return syncRes;
      }
      
      // Sync-lowered async functions requires async behavior because the callee *can* block,
      // but this call must *act* synchronously and return immediately with the result
      // (i.e. not returning until the work is done)
      //
      // TODO(breaking): remove checking for manual async specification here, once we can go p3-only
      //
      if (!isManualAsync && !isAsync && funcTypeIsAsync) {
        const { promise, resolve } = new Promise();
        queueMicrotask(async () => {
          if (!subtask.isResolvedState()) {
            await task.suspendUntil({ readyFn: () => task.isResolvedState() });
          }
          resolve(subtask.getResult());
        });
        return promise;
      }
      
      // NOTE: at this point we know that we are working with an async lowered import
      
      const subtaskState = subtask.getStateNumber();
      if (subtaskState < 0 || subtaskState >= 2**4) {
        throw new Error('invalid subtask state, out of valid range');
      }
      
      subtask.setOnProgressFn(() => {
        subtask.setPendingEvent(() => {
          if (subtask.isResolved()) { subtask.deliverResolve(); }
          const event = {
            code: ASYNC_EVENT_CODE.SUBTASK,
            payload0: subtask.waitableRep(),
            payload1: subtask.getStateNumber(),
          }
          return event;
        });
      });
      
      // This is a hack to maintain backwards compatibility with
      // manually-specified async imports, used in wasm exports that are
      // not actually async (but are specified as so).
      //
      // This is not normal p3 sync behavior but instead anticipating that
      // the caller that is doing manual async will be waiting for a promise that
      // resolves to the *actual* result.
      //
      // TODO(breaking): remove once manually specified async is removed
      //
      // There are a few cases:
      // 1. sync function with async types (e.g. `f: func() -> stream<u32>`)
      // 2. async function with async types (e.g. `f: async func() -> stream<u32>`)
      // 3. async function with sync types (e.g. `f: async func() -> list<u32>`)
      // 4. sync function with non-async types (e.g. `f: func() -> list<u32>`)
      //
      // This hack *only* applies to 4 -- the case where an async JS host function
      // is supplied to a Wasm export which does *not* need to do any async abi
      // lifting/lowering (async ABI did not exist when JSPI integratiton was
      // initially merged to enable asynchronously returning values from the host)
      //
      const requiresManualAsyncResult = !isAsync && !funcTypeIsAsync && isManualAsync;
      let manualAsyncResult;
      if (requiresManualAsyncResult) {
        manualAsyncResult = promiseWithResolvers();
      }
      
      queueMicrotask(async () => {
        try {
          _debugLog('[_lowerImportBackwardsCompat()] calling lowered import', { importFn, params });
          if (createdTask) { await createdTask.enter(); }
          
          const asyncRes = await importFn(...params);
          if (requiresManualAsyncResult) {
            manualAsyncResult.resolve(subtask.getResult());
          }
          
          if (createdTask) { createdTask.resolve([asyncRes]); }
          
          
        } catch (err) {
          _debugLog("[_lowerImportBackwardsCompat()] import fn error:", err);
          if (requiresManualAsyncResult) {
            manualAsyncResult.reject(err);
          }
          throw err;
        }
      });
      
      if (requiresManualAsyncResult) { return manualAsyncResult.promise; }
      
      return Number(subtask.waitableRep()) << 4 | subtaskState;
    }
    
    function _liftFlatU8(ctx) {
      _debugLog('[_liftFlatU8()] args', { ctx });
      let val;
      
      if (ctx.useDirectParams) {
        if (ctx.params.length === 0) { throw new Error('expected at least a single i32 argument'); }
        val = ctx.params[0];
        ctx.params = ctx.params.slice(1);
        return [val, ctx];
      }
      
      if (ctx.storageLen !== undefined && ctx.storageLen < 1) {
        throw new Error(`insufficient storage ([${ctx.storageLen}] bytes) for lift (u8 requires 1 byte)`);
      }
      
      val = new DataView(ctx.memory.buffer).getUint8(ctx.storagePtr, true);
      
      ctx.storagePtr += 1;
      if (ctx.storageLen !== undefined) { ctx.storageLen -= 1; }
      
      return [val, ctx];
    }
    
    
    function _liftFlatU16(ctx) {
      _debugLog('[_liftFlatU16()] args', { ctx });
      let val;
      
      if (ctx.useDirectParams) {
        if (ctx.params.length === 0) { throw new Error('expected at least a single i32 argument'); }
        val = ctx.params[0];
        ctx.params = ctx.params.slice(1);
        return [val, ctx];
      }
      
      if (ctx.storageLen !== undefined && ctx.storageLen < 2) {
        throw new Error(`insufficient storage ([${ctx.storageLen}] bytes) for lift (u16 requires 2 bytes)`);
      }
      
      val = new DataView(ctx.memory.buffer).getUint16(ctx.storagePtr, true);
      
      ctx.storagePtr += 2;
      if (ctx.storageLen !== undefined) { ctx.storageLen -= 2; }
      
      const rem = ctx.storagePtr % 2;
      if (rem !== 0) { ctx.storagePtr += (2 - rem); }
      
      return [val, ctx];
    }
    
    
    function _liftFlatU32(ctx) {
      _debugLog('[_liftFlatU32()] args', { ctx });
      let val;
      
      if (ctx.useDirectParams) {
        if (ctx.params.length === 0) { throw new Error('expected at least a single i34 argument'); }
        val = ctx.params[0];
        ctx.params = ctx.params.slice(1);
        return [val, ctx];
      }
      
      if (ctx.storageLen !== undefined && ctx.storageLen < 4) {
        throw new Error(`insufficient storage ([${ctx.storageLen}] bytes) for lift (u32 requires 4 bytes)`);
      }
      val = new DataView(ctx.memory.buffer).getUint32(ctx.storagePtr, true);
      ctx.storagePtr += 4;
      if (ctx.storageLen !== undefined) { ctx.storageLen -= 4; }
      
      return [val, ctx];
    }
    
    
    function _liftFlatU64(ctx) {
      _debugLog('[_liftFlatU64()] args', { ctx });
      let val;
      
      if (ctx.useDirectParams) {
        if (ctx.params.length === 0) { throw new Error('expected at least one single i64 argument'); }
        if (typeof ctx.params[0] !== 'bigint') { throw new Error('expected bigint'); }
        val = ctx.params[0];
        ctx.params = ctx.params.slice(1);
        return [val, ctx];
      }
      
      if (ctx.storageLen !== undefined && ctx.storageLen < 8) {
        throw new Error(`insufficient storage ([${ctx.storageLen}] bytes) for lift (u64 requires 8 bytes)`);
      }
      
      val = new DataView(ctx.memory.buffer).getBigUint64(ctx.storagePtr, true);
      ctx.storagePtr += 8;
      if (ctx.storageLen !== undefined) { ctx.storageLen -= 8; }
      
      return [val, ctx];
    }
    
    
    function _liftFlatFloat64(ctx) {
      _debugLog('[_liftFlatFloat64()] args', { ctx });
      let val;
      
      if (ctx.useDirectParams) {
        if (ctx.params.length === 0) {
          throw new Error('expected at least one single f64 argument');
        }
        val = ctx.params[0];
        ctx.params = ctx.params.slice(1);
        
        if (ctx.inVariant) {
          const dv = new DataView(new ArrayBuffer(8));
          dv.setBigInt64(0, val);
          val = dv.getFloat64(0);
        }
        
        return [val, ctx];
      }
      
      if (ctx.storageLen !== undefined && ctx.storageLen < 8) {
        throw new Error(`insufficient storage ([${ctx.storageLen}] bytes) for lift (f64 requires 8 bytes)`);
      }
      
      val = new DataView(ctx.memory.buffer).getFloat64(ctx.storagePtr, true);
      ctx.storagePtr += 8;
      if (ctx.storageLen !== undefined) { ctx.storageLen -= 8; }
      
      return [val, ctx];
    }
    
    
    function _liftFlatVariant(meta) {
      const {
        caseMetas,
        variantSize32,
        variantAlign32,
        variantPayloadOffset32,
        variantFlatCount,
        isEnum,
      } = meta;
      
      return function _liftFlatVariantInner(ctx) {
        _debugLog('[_liftFlatVariant()] args', { ctx });
        const origUseParams = ctx.useDirectParams;
        
        // If we're in the process of lifting a variant, we note
        // we are during any lifting that happens (e.g. to accomodate f32/f64 mechanics)
        const wasInVariant = ctx.inVariant;
        ctx.inVariant = true;
        
        let caseIdx;
        let liftRes;
        const originalPtr = ctx.storagePtr;
        const numCases =  caseMetas.length;
        if (caseMetas.length < 256) {
          liftRes = _liftFlatU8(ctx);
        } else if (numCases >= 256 && numCases < 65536) {
          liftRes = _liftFlatU16(ctx);
        } else if (numCases >= 65536 && numCases < 4_294_967_296) {
          liftRes = _liftFlatU32(ctx);
        } else {
          throw new Error(`unsupported number of variant cases [${numCases}]`);
        }
        caseIdx = liftRes[0];
        ctx = liftRes[1];
        
        const [
        tag,
        liftFn,
        caseSize32,
        caseAlign32,
        caseFlatCount,
        ] = caseMetas[caseIdx];
        
        if (variantPayloadOffset32 === undefined) {
          throw new Error('unexpectedly missing payload offset');
        }
        
        if (originalPtr !== undefined) {
          ctx.storagePtr = originalPtr + variantPayloadOffset32;
        }
        
        let val;
        if (liftFn === null) {
          val = { tag };
          // NOTE: here we need to move past the entire object in memory
          // despite moving to the payload which we now know is missing/unnecessary
          if (originalPtr !== undefined) {
            ctx.storagePtr = originalPtr + variantSize32;
          }
        } else {
          if (ctx.useDirectParams && ctx.params && liftFn !== _liftFlatFloat64 && typeof ctx.params[0] === 'bigint') {
            if (ctx.params[0] > BigInt(Number.MAX_SAFE_INTEGER)) {
              throw new Error(`invalid value, reinterpreted i32/f32 too large: [${ctx.params[0]}]`);
            }
            ctx.params[0] = Number(ctx.params[0]);
          }
          
          const [newVal, newCtx] = liftFn(ctx);
          val = { tag, val: newVal };
          ctx = newCtx;
        }
        
        if (origUseParams) {
          if (variantFlatCount === undefined || variantFlatCount === null) {
            _debugLog('[_liftFlatVariant()] variant with unknown flat count', { ctx, meta });
            throw new Error('cannot lift variant with unknown flat count');
          }
          if (caseFlatCount === undefined || caseFlatCount === null) {
            _debugLog('[_liftFlatVariant()] case with unknown flat count', { ctx, meta, case: meta.caseMetas[caseIdx] });
            throw new Error('cannot lift case with unknown flat count');
          }
          // NOTE: enums can be tightly packed and do not have a descriminant
          const remainingPayloadParams = variantFlatCount - caseFlatCount - (isEnum ? 0 : 1);
          if (remainingPayloadParams < 0) {
            throw new Error(`invalid variant flat count metadata`);
          }
          if (ctx.params.length < remainingPayloadParams) {
            throw new Error(`expected at least [${remainingPayloadParams}] remaining variant payload params, but got [${ctx.params.length}]`);
          }
          ctx.params = ctx.params.slice(remainingPayloadParams);
        }
        
        if (ctx.storagePtr !== undefined) {
          const rem = ctx.storagePtr % variantAlign32;
          if (rem !== 0) { ctx.storagePtr += variantAlign32 - rem; }
        }
        
        ctx.inVariant = wasInVariant;
        
        return [val, ctx];
      }
    }
    
    function _liftFlatList(meta) {
      const { elemLiftFn, elemSize32, elemAlign32, knownLen, typedArray } = meta;
      
      const listValue =
      typedArray === undefined
      ? values => values
      : values => new typedArray(values);
      
      const readValuesAndReset = (ctx, originalPtr, originalLen, dataPtr, len) => {
        ctx.storagePtr = dataPtr;
        const val = [];
        for (var i = 0; i < len; i++) {
          const elemPtr = dataPtr + i * elemSize32;
          ctx.storagePtr = elemPtr;
          const [res, nextCtx] = elemLiftFn(ctx);
          val.push(res);
          ctx = nextCtx;
          
          ctx.storagePtr = Math.max(ctx.storagePtr, elemPtr + elemSize32);
        }
        if (originalPtr !== null) { ctx.storagePtr = originalPtr; }
        if (originalLen !== null) { ctx.storageLen = originalLen; }
        return [listValue(val), ctx];
      };
      
      return function _liftFlatListInner(ctx) {
        _debugLog('[_liftFlatList()] args', { ctx });
        
        let liftResults;
        if (knownLen !== undefined) { // list with known length
        if (ctx.useDirectParams) {
          _debugLog('memory unexpectedly missing while lifting unknown length list', { ctx });
          liftResults = [listValue(ctx.params.slice(0, knownLen)), ctx];
          ctx.params = ctx.params.slice(knownLen);
        } else { // indirect params
        if (ctx.memory === null) {
          _debugLog('memory unexpectedly missing while lifting known length list', { knownLen, ctx });
          throw new Error(`memory missing while lifting known length (${knownLen}) list`);
        }
        
        const originalLen = ctx.storageLen;
        const originalPtr = ctx.storagePtr;
        
        ctx.storageLen = knownLen * elemSize32;
        liftResults = readValuesAndReset(ctx, null, originalLen, ctx.storagePtr, knownLen);
      }
      
    } else { // unknown length list
    
    if (ctx.useDirectParams) {
      // unknown length list ptr w/ direct params
      const dataPtr = ctx.params[0];
      const len = ctx.params[1];
      ctx.params = ctx.params.slice(2);
      
      ctx.useDirectParams = false;
      const originalPtr = ctx.storagePtr;
      const originalLen = ctx.storageLen;
      ctx.storageLen = len * elemSize32;
      
      liftResults = readValuesAndReset(ctx, originalPtr, originalLen, dataPtr, len);
      
      ctx.useDirectParams = true;
    } else {
      // unknown length list ptr w/ in-memory params
      const originalLen = ctx.storageLen;
      ctx.storageLen = 8;
      
      const dataPtrLiftRes = _liftFlatU32(ctx);
      const dataPtr = dataPtrLiftRes[0];
      ctx = dataPtrLiftRes[1];
      
      const lenLiftRes = _liftFlatU32(ctx);
      const len = lenLiftRes[0];
      ctx = lenLiftRes[1];
      
      const originalPtr = ctx.storagePtr;
      ctx.storagePtr = dataPtr;
      
      ctx.storageLen = len * elemSize32;
      liftResults = readValuesAndReset(ctx, originalPtr, originalLen, dataPtr, len);
    }
  }
  
  return liftResults;
}
}

function _liftFlatResult(meta) {
  const f = _liftFlatVariant(meta);
  return function _liftFlatResultInner(ctx) {
    _debugLog('[_liftFlatResult()] args', { ctx });
    return f(ctx);
  }
}

function _liftFlatBorrow(componentTableIdx, size, memory, vals, storagePtr, storageLen) {
  _debugLog('[_liftFlatBorrow()] args', { size, memory, vals, storagePtr, storageLen });
  throw new Error('flat lift for borrowed resources is not supported!');
}


function _lowerFlatU8(ctx) {
  _debugLog('[_lowerFlatU8()] args', ctx);
  
  if (ctx.vals.length !== 1) {
    throw new Error(`unexpected number [${ctx.vals.length}] of vals (expected 1)`);
  }
  
  _requireValidNumericPrimitive.bind('u8', ctx.vals[0]);
  
  if (!ctx.memory) { throw new Error("missing memory for lower"); }
  new DataView(ctx.memory.buffer).setUint32(ctx.storagePtr, ctx.vals[0], true);
  
  ctx.storagePtr += 1;
}

function _lowerFlatU16(ctx) {
  _debugLog('[_lowerFlatU16()] args', { ctx });
  
  if (!ctx.memory) { throw new Error("missing memory for lower"); }
  if (ctx.vals.length !== 1) {
    throw new Error(`unexpected number [${ctx.vals.length}] of vals (expected 1)`);
  }
  
  const rem = ctx.storagePtr % 2;
  if (rem !== 0) { ctx.storagePtr += (2 - rem); }
  
  _requireValidNumericPrimitive.bind('u16', ctx.vals[0]);
  new DataView(ctx.memory.buffer).setUint16(ctx.storagePtr, ctx.vals[0], true);
  
  ctx.storagePtr += 2;
}

function _lowerFlatU32(ctx) {
  _debugLog('[_lowerFlatU32()] args', { ctx });
  
  if (ctx.vals.length !== 1) {
    throw new Error(`expected single value to lower, got [${ctx.vals.length}]`);
  }
  
  const rem = ctx.storagePtr % 4;
  if (rem !== 0) { ctx.storagePtr += (4 - rem); }
  
  _requireValidNumericPrimitive.bind('u32', ctx.vals[0]);
  new DataView(ctx.memory.buffer).setUint32(ctx.storagePtr, ctx.vals[0], true);
  
  ctx.storagePtr += 4;
}

function _lowerFlatU64(ctx) {
  _debugLog('[_lowerFlatU64()] args', { ctx });
  
  if (ctx.vals.length !== 1) { throw new Error('unexpected number of vals'); }
  
  const rem = ctx.storagePtr % 8;
  if (rem !== 0) { ctx.storagePtr += (8 - rem); }
  
  _requireValidNumericPrimitive.bind('u64', ctx.vals[0]);
  new DataView(ctx.memory.buffer).setBigUint64(ctx.storagePtr, ctx.vals[0], true);
  
  ctx.storagePtr += 8;
}

function _lowerFlatStringAny(ctx) {
  switch (ctx.stringEncoding) {
    case 'utf8':
    return _lowerFlatStringUTF8(ctx);
    case 'utf16':
    return _lowerFlatStringUTF16(ctx);
    default:
    throw new Error(`missing/unrecognized/unsupported string encoding [${ctx.stringEncoding}]`);
  }
}

function _lowerFlatStringUTF8(ctx) {
  _debugLog('[_lowerFlatStringUTF8()] args', ctx);
  if (!ctx.realloc) { throw new Error('missing realloc during flat string lower'); }
  
  const s = ctx.vals[0];
  const { ptr, codepoints } = _utf8AllocateAndEncode(ctx.vals[0], ctx.realloc, ctx.memory);
  
  const view = new DataView(ctx.memory.buffer);
  view.setUint32(ctx.storagePtr, ptr, true);
  view.setUint32(ctx.storagePtr + 4, codepoints, true);
  
  ctx.storagePtr += 8;
}

function _lowerFlatStringUTF16(ctx) {
  _debugLog('[_lowerFlatStringUTF16()] args', { ctx });
  if (!ctx.realloc) { throw new Error('missing realloc during flat string lower'); }
  
  const s = ctx.vals[0];
  const { ptr, len, codepoints } = _utf16AllocateAndEncode(ctx.vals[0], ctx.realloc, ctx.memory);
  
  const view = new DataView(ctx.memory.buffer);
  view.setUint32(ctx.storagePtr, ptr, true);
  view.setUint32(ctx.storagePtr + 4, codepoints, true);
  
  const bytes = new Uint16Array(ctx.memory.buffer, start, codeUnits);
  if (ctx.memory.buffer.byteLength < start + bytes.byteLength) {
    throw new Error('memory out of bounds');
  }
  if (ctx.storageLen !== undefined && ctx.storageLen !== bytes.byteLength) {
    throw new Error(`storage length [${ctx.storageLen}] != [${bytes.byteLength}])`);
  }
  new Uint16Array(ctx.memory.buffer, ctx.storagePtr).set(bytes);
  
  ctx.storagePtr += len;
}

function _lowerFlatRecord(meta) {
  const { fieldMetas, size32: recordSize32, align32: recordAlign32 } = meta;
  return function _lowerFlatRecordInner(ctx) {
    _debugLog('[_lowerFlatRecord()] args', { ctx });
    
    const originalPtr = ctx.storagePtr;
    const r = ctx.vals[0];
    for (const [tag, lowerFn, size32, align32 ] of fieldMetas) {
      const rem = ctx.storagePtr % align32;
      if (rem !== 0) { ctx.storagePtr += align32 - rem; }
      
      const fieldPtr = ctx.storagePtr;
      ctx.vals = [r[tag]];
      lowerFn(ctx);
      
      ctx.storagePtr = Math.max(ctx.storagePtr, fieldPtr + size32);
    }
    
    ctx.storagePtr = Math.max(ctx.storagePtr, originalPtr + recordSize32);
    
    const rem = ctx.storagePtr % recordAlign32;
    if (rem !== 0) {
      ctx.storagePtr += recordAlign32 - rem;
    }
  }
}

function _lowerFlatVariant(meta) {
  const { variantSize32, variantAlign32, variantPayloadOffset32, caseMetas } = meta;
  
  let caseLookup = {};
  for (const [idx, meta] of caseMetas.entries()) {
    let tag = meta[0];
    caseLookup[tag] = { discriminant: idx, meta };
  }
  
  return function _lowerFlatVariantInner(ctx) {
    _debugLog('[_lowerFlatVariant()] args', { ctx });
    
    const { tag, val } = ctx.vals[0];
    const variantCase = caseLookup[tag];
    if (!variantCase) {
      throw new Error(`missing tag [${tag}] (valid tags: ${Object.keys(caseLookup)})`);
    }
    
    const [ _tag, lowerFn, caseSize32, caseAlign32, caseFlatCount ] = variantCase.meta;
    
    const originalPtr = ctx.storagePtr;
    ctx.vals = [variantCase.discriminant];
    let discLowerRes;
    if (caseMetas.length < 256) {
      discLowerRes = _lowerFlatU8(ctx);
    } else if (caseMetas.length >= 256 && caseMetas.length < 65536) {
      discLowerRes = _lowerFlatU16(ctx);
    } else if (caseMetas.length >= 65536 && caseMetas.length < 4_294_967_296) {
      discLowerRes = _lowerFlatU32(ctx);
    } else {
      throw new Error(`unsupported number of cases [${caseMetas.length}]`);
    }
    
    const payloadOffsetPtr = originalPtr + variantPayloadOffset32;
    ctx.storagePtr = payloadOffsetPtr;
    ctx.vals = [val];
    if (lowerFn) { lowerFn(ctx); }
    
    ctx.storagePtr = Math.max(ctx.storagePtr, originalPtr + variantSize32);
    
    const rem = ctx.storagePtr % variantAlign32;
    if (rem !== 0) { ctx.storagePtr += varianttAlign32 - rem; }
  }
}

function _lowerFlatList(meta) {
  const {
    elemLowerFn,
    knownLen,
    size32,
    align32,
    elemSize32,
    elemAlign32,
  } = meta;
  
  if (!elemLowerFn) { throw new TypeError("missing/invalid element lower fn for list"); }
  
  return function _lowerFlatListInner(ctx) {
    _debugLog('[_lowerFlatList()] args', { ctx });
    
    if (ctx.useDirectParams) {
      if (ctx.params.length < 2) { throw new Error('insufficient params left to lower list'); }
      const storagePtr = ctx.params[0];
      const elemCount = ctx.params[1];
      ctx.params = ctx.params.slice(2);
      
      const list = ctx.vals[0];
      if (!list) { throw new Error("missing direct param value"); }
      
      const lowerCtx = {
        storagePtr,
        memory: ctx.memory,
        stringEncoding: ctx.stringEncoding,
      };
      for (let idx = 0; idx < list.length; idx++) {
        const elemPtr = storagePtr + idx * elemSize32;
        lowerCtx.storagePtr = elemPtr;
        lowerCtx.vals = list.slice(idx, idx+1);
        elemLowerFn(lowerCtx);
        lowerCtx.storagePtr = Math.max(lowerCtx.storagePtr, elemPtr + elemSize32);
      }
      ctx.storagePtr = lowerCtx.storagePtr;
      
      // TODO: implement parma-only known-length processing
      
      return;
    }
    
    // TODO(fix): is it possible to get a vals that are a addr and length here from
    // a component lower?
    
    const elems = ctx.vals[0];
    if (knownLen === undefined) {
      // unknown length
      if (!ctx.realloc) { throw new Error('missing realloc during flat string lower'); }
      const dataPtr = ctx.realloc(0, 0, elemAlign32, elemSize32 * elems.length);
      
      ctx.vals[0] = dataPtr;
      _lowerFlatU32(ctx);
      
      ctx.vals[0] = elems.length;
      _lowerFlatU32(ctx);
      
      const origPtr = ctx.storagePtr;
      ctx.storagePtr = dataPtr;
      
      for (const [idx, elem] of elems.entries()) {
        const elemPtr = dataPtr + idx * elemSize32;
        ctx.storagePtr = elemPtr;
        ctx.vals = [elem];
        elemLowerFn(ctx);
        ctx.storagePtr = Math.max(ctx.storagePtr, elemPtr + elemSize32);
      }
      
      ctx.storagePtr = origPtr;
      
    } else {
      // known length
      
      if (elems.length !== knownLen) {
        throw new TypeError(`invalid list input of length [${elems.length}], must be length [${knownLen}]`);
      }
      
      const originalPtr = ctx.storagePtr;
      for (const [idx, elem] of elems.entries()) {
        const elemPtr = originalPtr + idx * elemSize32;
        ctx.storagePtr = elemPtr;
        ctx.vals = [elem];
        elemLowerFn(ctx);
        ctx.storagePtr = Math.max(ctx.storagePtr, elemPtr + elemSize32);
      }
    }
    
    // TODO(fix): special case for u8/u16/etc, we can do a direct copy
    
    const totalSizeBytes = elems.length * size32;
    if (ctx.storageLen !== undefined && totalSizeBytes > ctx.storageLen) {
      throw new Error('not enough storage remaining for list flat lower');
    }
  }
}

function _lowerFlatTuple(meta) {
  const { elemLowerMetas, size32: tupleSize32, align32: tupleAlign32 } = meta;
  return function _lowerFlatTupleInner(ctx) {
    _debugLog('[_lowerFlatTuple()] args', { ctx });
    const originalPtr = ctx.storagePtr;
    const tuple = ctx.vals[0];
    for (const [idx, [ lowerFn, size32, align32 ]]  of elemLowerMetas.entries()) {
      const rem = ctx.storagePtr % align32;
      if (rem !== 0) { ctx.storagePtr += align32 - rem; }
      
      const elemPtr = ctx.storagePtr;
      ctx.vals = [tuple[idx]];
      lowerFn(ctx);
      ctx.storagePtr = Math.max(ctx.storagePtr, elemPtr + size32);
    }
    
    ctx.storagePtr = Math.max(ctx.storagePtr, originalPtr + tupleSize32);
    
    const rem = ctx.storagePtr % tupleAlign32;
    if (rem !== 0) {
      ctx.storagePtr += tupleAlign32 - rem;
    }
  }
}

function _lowerFlatEnum(meta) {
  const f = _lowerFlatVariant(meta);
  return function _lowerFlatEnumInner(ctx) {
    _debugLog('[_lowerFlatEnum()] args', { ctx });
    
    const v = ctx.vals[0];
    const isNotEnumObject = typeof v !== 'object'
    || Object.keys(v).length !== 2
    || !('tag' in v);
    if (isNotEnumObject) {
      ctx.vals[0] = { tag: v };
    }
    
    f(ctx);
  }
}

function _lowerFlatOption(meta) {
  const f = _lowerFlatVariant(meta);
  return function _lowerFlatOptionInner(ctx) {
    _debugLog('[_lowerFlatOption()] args', { ctx });
    
    const v = ctx.vals[0];
    if (v === null || v === undefined) {
      ctx.vals[0] = { tag: 'none' };
    } else {
      const isNotOptionObject = typeof v !== 'object'
      || Object.keys(v).length !== 2
      || !('tag' in v)
      || !(v.tag === 'some' || v.tag === 'none')
      || !('val' in v);
      if (isNotOptionObject) {
        ctx.vals[0] = { tag: 'some', val: v };
      }
    }
    
    f(ctx);
  }
}

function _lowerFlatResult(meta) {
  const f = _lowerFlatVariant(meta);
  return function _lowerFlatResultInner(ctx) {
    _debugLog('[_lowerFlatResult()] args', { ctx });
    
    const v = ctx.vals[0];
    const isNotResultObject = typeof v !== 'object'
    || Object.keys(v).length !== 2
    || !('tag' in v)
    || !('ok' === v.tag || 'err' === v.tag)
    || !('val' in v);
    if (isNotResultObject) {
      ctx.vals[0] = { tag: 'ok', val: v };
    }
    
    f(ctx);
  };
}

function _lowerFlatOwn(meta) {
  const { lowerFn, componentIdx } = meta;
  
  return function _lowerFlatOwnInner(ctx) {
    _debugLog('[_lowerFlatOwn()] args', { ctx });
    const { createFn } = ctx;
    
    if (ctx.componentIdx !== componentIdx) {
      throw new Error(`component index mismatch (expected [${componentIdx}], lift called from [${ctx.componentIdx}])`);
    }
    
    const obj = ctx.vals[0];
    if (obj === undefined || obj === null) { throw new Error('missing resource'); }
    const handle = lowerFn(obj);
    
    ctx.vals[0] = handle;
    _lowerFlatU32(ctx);
  };
}

const STREAMS = new RepTable({ target: 'global stream map' });
const ASYNC_STATE = new Map();

function getOrCreateAsyncState(componentIdx, init) {
  if (!ASYNC_STATE.has(componentIdx)) {
    const newState = new ComponentAsyncState({ componentIdx });
    ASYNC_STATE.set(componentIdx, newState);
  }
  return ASYNC_STATE.get(componentIdx);
}

class ComponentAsyncState {
  static EVENT_HANDLER_EVENTS = [ 'backpressure-change' ];
  
  #componentIdx;
  #callingAsyncImport = false;
  #syncImportWait = promiseWithResolvers();
  #locked = false;
  #parkedTasks = new Map();
  #suspendedTasksByTaskID = new Map();
  #suspendedTaskIDs = [];
  #errored = null;
  
  #backpressure = 0;
  #backpressureWaiters = 0n;
  
  #handlerMap = new Map();
  #nextHandlerID = 0n;
  
  #tickLoop = null;
  #tickLoopInterval = null;
  
  #onExclusiveReleaseHandlers = [];
  
  mayLeave = true;
  
  handles;
  subtasks;
  
  constructor(args) {
    this.#componentIdx = args.componentIdx;
    this.handles = new RepTable({ target: `component [${this.#componentIdx}] handles (waitable objects)` });
    this.subtasks = new RepTable({ target: `component [${this.#componentIdx}] subtasks` });
  };
  
  componentIdx() { return this.#componentIdx; }
  
  errored() { return this.#errored !== null; }
  setErrored(err) {
    _debugLog('[ComponentAsyncState#setErrored()] component errored', { err, componentIdx: this.#componentIdx });
    if (this.#errored) { return; }
    if (!err) {
      err = new Error('error elswehere (see other component instance error)')
      err.componentIdx = this.#componentIdx;
    }
    this.#errored = err;
  }
  
  callingSyncImport(val) {
    if (val === undefined) { return this.#callingAsyncImport; }
    if (typeof val !== 'boolean') { throw new TypeError('invalid setting for async import'); }
    const prev = this.#callingAsyncImport;
    this.#callingAsyncImport = val;
    if (prev === true && this.#callingAsyncImport === false) {
      this.#notifySyncImportEnd();
    }
  }
  
  #notifySyncImportEnd() {
    const existing = this.#syncImportWait;
    this.#syncImportWait = promiseWithResolvers();
    existing.resolve();
  }
  
  async waitForSyncImportCallEnd() {
    await this.#syncImportWait.promise;
  }
  
  setBackpressure(v) {
    this.#backpressure = v;
    return this.#backpressure
  }
  getBackpressure() { return this.#backpressure; }
  
  incrementBackpressure() {
    const current = this.#backpressure;
    if (current < 0 || current > 2**16) {
      throw new Error(`invalid current backpressure value [${current}]`);
    }
    const newValue = this.getBackpressure() + 1;
    if (newValue >= 2**16) {
      throw new Error(`invalid new backpressure value [${newValue}], overflow`);
    }
    return this.setBackpressure(newValue);
  }
  
  decrementBackpressure() {
    const current = this.#backpressure;
    if (current < 0 || current > 2**16) {
      throw new Error(`invalid current backpressure value [${current}]`);
    }
    const newValue = Math.max(0, current - 1);
    if (newValue < 0) {
      throw new Error(`invalid new backpressure value [${newValue}], underflow`);
    }
    return this.setBackpressure(newValue);
  }
  hasBackpressure() { return this.#backpressure > 0; }
  
  waitForBackpressure() {
    let backpressureCleared = false;
    const cstate = this;
    cstate.addBackpressureWaiter();
    const handlerID = this.registerHandler({
      event: 'backpressure-change',
      fn: (bp) => {
        if (bp === 0) {
          cstate.removeHandler(handlerID);
          backpressureCleared = true;
        }
      }
    });
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        if (backpressureCleared) { return; }
        clearInterval(interval);
        cstate.removeBackpressureWaiter();
        resolve(null);
      }, 0);
    });
  }
  
  registerHandler(args) {
    const { event, fn } = args;
    if (!event) { throw new Error("missing handler event"); }
    if (!fn) { throw new Error("missing handler fn"); }
    
    if (!ComponentAsyncState.EVENT_HANDLER_EVENTS.includes(event)) {
      throw new Error(`unrecognized event handler [${event}]`);
    }
    
    const handlerID = this.#nextHandlerID++;
    let handlers = this.#handlerMap.get(event);
    if (!handlers) {
      handlers = [];
      this.#handlerMap.set(event, handlers)
    }
    
    handlers.push({ id: handlerID, fn, event });
    return handlerID;
  }
  
  removeHandler(args) {
    const { event, handlerID } = args;
    const registeredHandlers = this.#handlerMap.get(event);
    if (!registeredHandlers) { return; }
    const found = registeredHandlers.find(h => h.id === handlerID);
    if (!found) { return; }
    this.#handlerMap.set(event, this.#handlerMap.get(event).filter(h => h.id !== handlerID));
  }
  
  getBackpressureWaiters() { return this.#backpressureWaiters; }
  addBackpressureWaiter() { this.#backpressureWaiters++; }
  removeBackpressureWaiter() {
    this.#backpressureWaiters--;
    if (this.#backpressureWaiters < 0) {
      throw new Error("unexepctedly negative number of backpressure waiters");
    }
  }
  
  isExclusivelyLocked() { return this.#locked === true; }
  setLocked(locked) {
    this.#locked = locked;
  }
  
  exclusiveLock() {
    _debugLog('[ComponentAsyncState#exclusiveLock()]', {
      locked: this.#locked,
      componentIdx: this.#componentIdx,
    });
    this.setLocked(true);
  }
  
  exclusiveRelease() {
    _debugLog('[ComponentAsyncState#exclusiveRelease()] args', {
      locked: this.#locked,
      componentIdx: this.#componentIdx,
    });
    this.setLocked(false);
    
    this.#onExclusiveReleaseHandlers = this.#onExclusiveReleaseHandlers.filter(v => !!v);
    for (const [idx, f] of this.#onExclusiveReleaseHandlers.entries()) {
      try {
        this.#onExclusiveReleaseHandlers[idx] = null;
        f();
      } catch (err) {
        _debugLog("error while executing handler for next exclusive release", err);
        throw err;
      }
    }
  }
  
  onNextExclusiveRelease(fn) {
    _debugLog('[ComponentAsyncState#()onNextExclusiveRelease] registering');
    this.#onExclusiveReleaseHandlers.push(fn);
  }
  
  // nextTaskPromise & nextTaskQueue are used to await current task completion and queues
  // any tasks attempting to enter() and complete.
  //
  // see: nextTaskExecutionSlot()
  //
  // TODO(threads): this should be unnecessary once threads are properly implemented,
  // as the task.enter() logic should suffice (it should be guaranteed that we cannot re-enter
  // unless the task in question is the current task in the thread execution, and only one can
  // run at a time)
  #nextTaskPromise = Promise.resolve(true);
  #nextTaskQueue = [];
  
  async nextTaskExecutionSlot(args) {
    const { task } = args;
    
    const placeholder = {
      completed: false,
      task,
      promise: task.exitPromise().then(() => {
        placeholder.completed = true;
      }),
    };
    this.#nextTaskQueue.push(placeholder);
    
    let next;
    while (true) {
      await this.#nextTaskPromise;
      
      next = this.#nextTaskQueue.find(placeholder => !placeholder.completed);
      
      // This task is next in the queue, we can continue
      if (next === undefined || next === placeholder) {
        this.#nextTaskPromise = next.promise;
        if (this.#nextTaskQueue.length > 1000) {
          this.#nextTaskQueue = this.#nextTaskQueue.filter(p => !p.completed);
          if (this.#nextTaskQueue.length > 1000) {
            _debugLog('[ComponentAsyncState#()nextTaskExecutionSlot] next task queue length > 1000 even after cleanup, tasks may be leaking');
          }
        }
        break;
      }
      
      // If we get here, this task was *not* next in the queue, continue waiting
      // (at this point the task that *is* next will likely have already set itself
      // as this.#nextTaskPromise)
    }
  }
  
  #getSuspendedTaskMeta(taskID) {
    return this.#suspendedTasksByTaskID.get(taskID);
  }
  
  #removeSuspendedTaskMeta(taskID) {
    _debugLog('[ComponentAsyncState#removeSuspendedTaskMeta()] removing suspended task', {
      taskID,
      componentIdx: this.#componentIdx,
    });
    const idx = this.#suspendedTaskIDs.findIndex(t => t === taskID);
    const meta = this.#suspendedTasksByTaskID.get(taskID);
    this.#suspendedTaskIDs[idx] = null;
    this.#suspendedTasksByTaskID.delete(taskID);
    return meta;
  }
  
  #addSuspendedTaskMeta(meta) {
    if (!meta) { throw new Error('missing task meta'); }
    const taskID = meta.taskID;
    this.#suspendedTasksByTaskID.set(taskID, meta);
    this.#suspendedTaskIDs.push(taskID);
    if (this.#suspendedTasksByTaskID.size < this.#suspendedTaskIDs.length - 10) {
      this.#suspendedTaskIDs = this.#suspendedTaskIDs.filter(t => t !== null);
    }
  }
  
  // TODO(threads): readyFn is normally on the thread
  suspendTask(args) {
    const { task, readyFn } = args;
    const taskID = task.id();
    const componentIdx = task.componentIdx();
    _debugLog('[ComponentAsyncState#suspendTask()]', {
      taskID,
      componentIdx: this.#componentIdx,
      taskEntryFnName: task.entryFnName(),
      subtask: task.getParentSubtask(),
    });
    
    if (componentIdx !== this.#componentIdx) {
      throw new Error('assert: task component idx should match async state');
    }
    
    if (this.#getSuspendedTaskMeta(taskID)) {
      throw new Error(`task [${taskID}] already suspended`);
    }
    
    const { promise, resolve, reject } = promiseWithResolvers();
    this.#addSuspendedTaskMeta({
      task,
      taskID,
      readyFn,
      resume: () => {
        _debugLog('[ComponentAsyncState] resuming suspended task', {
          taskID,
          componentIdx: this.#componentIdx,
        });
        // TODO(threads): it's thread cancellation we should be checking for below, not task
        resolve(!task.isCancelled());
      },
    });
    
    this.runTickLoop();
    
    return promise;
  }
  
  resumeTaskByID(taskID) {
    const meta = this.#removeSuspendedTaskMeta(taskID);
    if (!meta) { return; }
    if (meta.taskID !== taskID) { throw new Error('task ID does not match'); }
    meta.resume();
  }
  
  async runTickLoop() {
    if (this.#tickLoop !== null) { return; }
    this.#tickLoop = 1;
    setTimeout(async () => {
      let done = this.tick();
      while (!done) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        done = this.tick();
      }
      this.#tickLoop = null;
    }, 10);
  }
  
  tick() {
    // _debugLog('[ComponentAsyncState#tick()]', { suspendedTaskIDs: this.#suspendedTaskIDs });
    
    const resumableTasks = this.#suspendedTaskIDs.filter(t => t !== null);
    for (const taskID of resumableTasks) {
      const meta = this.#suspendedTasksByTaskID.get(taskID);
      if (!meta || !meta.readyFn) {
        throw new Error(`missing/invalid task despite ID [${taskID}] being present`);
      }
      
      // If the task failed via any means, allow the task to resume because
      // it's been cancelled -- the callback should immediately exit as well
      if (meta.task.isRejected()) {
        _debugLog('[ComponentAsyncState#tick()] detected task rejection, leaving early', { meta });
        this.resumeTaskByID(taskID);
        return;
      }
      
      const isReady = meta.readyFn();
      if (!isReady) { continue; }
      
      _debugLog('[ComponentAsyncState#tick()] resuming task via tick', {
        taskID,
        componentIdx: this.#componentIdx,
      });
      this.resumeTaskByID(taskID);
    }
    
    return this.#suspendedTaskIDs.filter(t => t !== null).length === 0;
  }
  
  addStreamEndToTable(args) {
    _debugLog('[ComponentAsyncState#addStreamEnd()] args', args);
    const { tableIdx, streamEnd } = args;
    if (typeof streamEnd === 'number') { throw new Error("INSERTING BAD STREAMEND"); }
    
    let { table, componentIdx } = STREAM_TABLES[tableIdx];
    if (componentIdx === undefined || !table) {
      throw new Error(`invalid global stream table state for table [${tableIdx}]`);
    }
    
    const handle = table.insert(streamEnd);
    streamEnd.setHandle(handle);
    streamEnd.setStreamTableIdx(tableIdx);
    
    const cstate = getOrCreateAsyncState(componentIdx);
    const waitableIdx = cstate.handles.insert(streamEnd);
    streamEnd.setWaitableIdx(waitableIdx);
    
    _debugLog('[ComponentAsyncState#addStreamEnd()] added stream end', {
      tableIdx,
      table,
      handle,
      streamEnd,
      destComponentIdx: componentIdx,
    });
    
    return { handle, waitableIdx };
  }
  
  createWaitable(args) {
    return new Waitable({ target: args?.target, });
  }
  
  createReadableStreamEnd(args) {
    _debugLog('[ComponentAsyncState#createStreamEnd()] args', args);
    const { tableIdx, elemMeta, hostInjectFn } = args;
    
    const { table: localStreamTable, componentIdx } = STREAM_TABLES[tableIdx];
    if (!localStreamTable) {
      throw new Error(`missing global stream table lookup for table [${tableIdx}] while creating stream`);
    }
    if (componentIdx !== this.#componentIdx) {
      throw new Error('component idx mismatch while creating stream');
    }
    
    const waitable = this.createWaitable();
    const streamEnd = new StreamReadableEnd({
      tableIdx,
      elemMeta,
      hostInjectFn,
      pendingBufferMeta: {},
      target: `stream read end (lowered, @init)`,
      waitable,
    });
    
    streamEnd.setWaitableIdx(this.handles.insert(streamEnd));
    streamEnd.setHandle(localStreamTable.insert(streamEnd));
    if (streamEnd.streamTableIdx() !== tableIdx) {
      throw new Error("unexpectedly mismatched stream table");
    }
    const streamEndWaitableIdx = streamEnd.waitableIdx();
    const streamEndHandle = streamEnd.handle();
    waitable.setTarget(`waitable for stream read end (lowered, waitable [${streamEndWaitableIdx}])`);
    streamEnd.setTarget(`stream read end (lowered, waitable [${streamEndWaitableIdx}])`);
    
    return {
      waitableIdx: streamEndWaitableIdx,
      handle: streamEndHandle,
      streamEnd,
    };
  }
  
  createStream(args) {
    _debugLog('[ComponentAsyncState#createStream()] args', args);
    const { tableIdx, elemMeta, hostInjectFn } = args;
    if (tableIdx === undefined) { throw new Error("missing table idx while adding stream"); }
    if (elemMeta === undefined) { throw new Error("missing element metadata while adding stream"); }
    
    const { table: localStreamTable, componentIdx } = STREAM_TABLES[tableIdx];
    if (!localStreamTable) {
      throw new Error(`missing global stream table lookup for table [${tableIdx}] while creating stream`);
    }
    if (componentIdx !== this.#componentIdx) {
      throw new Error('component idx mismatch while creating stream');
    }
    
    const readWaitable = this.createWaitable();
    const writeWaitable = this.createWaitable();
    
    const stream = new InternalStream({
      tableIdx,
      elemMeta,
      readWaitable,
      writeWaitable,
      hostInjectFn,
    });
    stream.setGlobalStreamMapRep(STREAMS.insert(stream));
    
    const writeEnd = stream.writeEnd();
    writeEnd.setWaitableIdx(this.handles.insert(writeEnd));
    writeEnd.setHandle(localStreamTable.insert(writeEnd));
    if (writeEnd.streamTableIdx() !== tableIdx) { throw new Error("unexpectedly mismatched stream table"); }
    
    const writeEndWaitableIdx = writeEnd.waitableIdx();
    const writeEndHandle = writeEnd.handle();
    writeWaitable.setTarget(`waitable for stream write end (waitable [${writeEndWaitableIdx}])`);
    writeEnd.setTarget(`stream write end (waitable [${writeEndWaitableIdx}])`);
    
    const readEnd = stream.readEnd();
    readEnd.setWaitableIdx(this.handles.insert(readEnd));
    readEnd.setHandle(localStreamTable.insert(readEnd));
    if (readEnd.streamTableIdx() !== tableIdx) { throw new Error("unexpectedly mismatched stream table"); }
    
    const readEndWaitableIdx = readEnd.waitableIdx();
    const readEndHandle = readEnd.handle();
    readWaitable.setTarget(`waitable for read end (waitable [${readEndWaitableIdx}])`);
    readEnd.setTarget(`stream read end (waitable [${readEndWaitableIdx}])`);
    
    return {
      writeEnd,
      writeEndWaitableIdx,
      writeEndHandle,
      readEndWaitableIdx,
      readEndHandle,
      readEnd,
    };
  }
  
  getStreamEnd(args) {
    _debugLog('[ComponentAsyncState#getStreamEnd()] args', args);
    const { tableIdx, streamEndHandle, streamEndWaitableIdx } = args;
    if (tableIdx === undefined) {
      throw new Error('missing table idx while getting stream end');
    }
    
    const { table, componentIdx } = STREAM_TABLES[tableIdx];
    const cstate = getOrCreateAsyncState(componentIdx);
    
    let streamEnd;
    if (streamEndWaitableIdx !== undefined) {
      streamEnd = cstate.handles.get(streamEndWaitableIdx);
    } else if (streamEndHandle !== undefined) {
      if (!table) { throw new Error(`missing/invalid table [${tableIdx}] while getting stream end`); }
      streamEnd = table.get(streamEndHandle);
    } else {
      throw new TypeError("must specify either waitable idx or handle to retrieve stream");
    }
    
    if (!streamEnd) {
      throw new Error(`missing stream end (tableIdx [${tableIdx}], handle [${streamEndHandle}], waitableIdx [${streamEndWaitableIdx}])`);
    }
    if (tableIdx && streamEnd.streamTableIdx() !== tableIdx) {
      throw new Error(`stream end table idx [${streamEnd.streamTableIdx()}] does not match [${tableIdx}]`);
    }
    
    return streamEnd;
  }
  
  deleteStreamEnd(args) {
    _debugLog('[ComponentAsyncState#deleteStreamEnd()] args', args);
    const { tableIdx, streamEndWaitableIdx } = args;
    if (tableIdx === undefined) { throw new Error("missing table idx while removing stream end"); }
    if (streamEndWaitableIdx === undefined) { throw new Error("missing stream idx while removing stream end"); }
    
    const { table, componentIdx } = STREAM_TABLES[tableIdx];
    const cstate = getOrCreateAsyncState(componentIdx);
    
    const streamEnd = cstate.handles.get(streamEndWaitableIdx);
    if (!streamEnd) {
      throw new Error(`missing stream end [${streamEndWaitableIdx}] in component handles while deleting stream`);
    }
    if (streamEnd.streamTableIdx() !== tableIdx) {
      throw new Error(`stream end table idx [${streamEnd.streamTableIdx()}] does not match [${tableIdx}]`);
    }
    
    let removed = cstate.handles.remove(streamEnd.waitableIdx());
    if (!removed) {
      throw new Error(`failed to remove stream end [${streamEndWaitableIdx}] waitable obj in component [${componentIdx}]`);
    }
    
    removed = table.remove(streamEnd.handle());
    if (!removed) {
      throw new Error(`failed to remove stream end with handle [${streamEnd.handle()}] from stream table [${tableIdx}] in component [${componentIdx}]`);
    }
    
    return streamEnd;
  }
  
  removeStreamEndFromTable(args) {
    _debugLog('[ComponentAsyncState#removeStreamEndFromTable()] args', args);
    
    const { tableIdx, streamWaitableIdx } = args;
    if (tableIdx === undefined) { throw new Error("missing table idx while removing stream end"); }
    if (streamWaitableIdx === undefined) {
      throw new Error("missing stream end waitable idx while removing stream end");
    }
    
    const { table, componentIdx } = STREAM_TABLES[tableIdx];
    if (!table) { throw new Error(`missing/invalid table [${tableIdx}] while removing stream end`); }
    
    const cstate = getOrCreateAsyncState(componentIdx);
    
    const streamEnd = cstate.handles.get(streamWaitableIdx);
    if (!streamEnd) {
      throw new Error(`missing stream end (handle [${streamWaitableIdx}], table [${tableIdx}])`);
    }
    const handle = streamEnd.handle();
    
    let removed = cstate.handles.remove(streamWaitableIdx);
    if (!removed) {
      throw new Error(`failed to remove streamEnd from handles (waitable idx [${streamWaitableIdx}]), component [${componentIdx}])`);
    }
    
    removed = table.remove(handle);
    if (!removed) {
      throw new Error(`failed to remove streamEnd from table (handle [${handle}]), table [${tableIdx}], component [${componentIdx}])`);
    }
    
    return streamEnd;
  }
  
  createFuture(args) {
    _debugLog('[ComponentAsyncState#createFuture()] args', args);
    const { tableIdx, elemMeta, hostInjectFn } = args;
    if (tableIdx === undefined) { throw new Error("missing table idx while adding future"); }
    if (elemMeta === undefined) { throw new Error("missing element metadata while adding future"); }
    
    const { table: futureTable, componentIdx } = FUTURE_TABLES[tableIdx];
    if (!futureTable) {
      throw new Error(`missing global future table lookup for table [${tableIdx}] while creating future`);
    }
    if (componentIdx !== this.#componentIdx) {
      throw new Error('component idx mismatch while creating future');
    }
    
    const readWaitable = this.createWaitable();
    const writeWaitable = this.createWaitable();
    
    const future = new InternalFuture({
      tableIdx,
      componentIdx: this.#componentIdx,
      elemMeta,
      readWaitable,
      writeWaitable,
      hostInjectFn,
    });
    future.setGlobalFutureMapRep(FUTURES.insert(future));
    
    const writeEnd = future.writeEnd();
    writeEnd.setWaitableIdx(this.handles.insert(writeEnd));
    writeEnd.setHandle(futureTable.insert(writeEnd));
    if (writeEnd.futureTableIdx() !== tableIdx) { throw new Error("unexpectedly mismatched future table"); }
    
    const writeEndWaitableIdx = writeEnd.waitableIdx();
    const writeEndHandle = writeEnd.handle();
    writeWaitable.setTarget(`waitable for future write end (waitable [${writeEndWaitableIdx}])`);
    writeEnd.setTarget(`future write end (waitable [${writeEndWaitableIdx}])`);
    
    const readEnd = future.readEnd();
    readEnd.setWaitableIdx(this.handles.insert(readEnd));
    readEnd.setHandle(futureTable.insert(readEnd));
    if (readEnd.futureTableIdx() !== tableIdx) { throw new Error("unexpectedly mismatched future table"); }
    
    const readEndWaitableIdx = readEnd.waitableIdx();
    const readEndHandle = readEnd.handle();
    readWaitable.setTarget(`waitable for read end (waitable [${readEndWaitableIdx}])`);
    readEnd.setTarget(`future read end (waitable [${readEndWaitableIdx}])`);
    
    return {
      writeEnd,
      writeEndWaitableIdx,
      writeEndHandle,
      readEndWaitableIdx,
      readEndHandle,
      readEnd,
    };
  }
  
  getFutureEnd(args) {
    _debugLog('[ComponentAsyncState#getFutureEnd()] args', args);
    const { tableIdx, futureEndHandle, futureEndWaitableIdx } = args;
    if (tableIdx === undefined) {
      throw new Error('missing table idx while getting future end');
    }
    
    const { table, componentIdx } = FUTURE_TABLES[tableIdx];
    const cstate = getOrCreateAsyncState(componentIdx);
    
    let futureEnd;
    if (futureEndWaitableIdx !== undefined) {
      futureEnd = cstate.handles.get(futureEndWaitableIdx);
    } else if (futureEndHandle !== undefined) {
      if (!table) { throw new Error(`missing/invalid table [${tableIdx}] while getting future end`); }
      futureEnd = table.get(futureEndHandle);
    } else {
      throw new TypeError("must specify either waitable idx or handle to retrieve future");
    }
    
    if (!futureEnd) {
      throw new Error(`missing future end (tableIdx [${tableIdx}], handle [${futureEndHandle}], waitableIdx [${futureEndWaitableIdx}])`);
    }
    if (tableIdx && futureEnd.futureTableIdx() !== tableIdx) {
      throw new Error(`future end table idx [${futureEnd.futureTableIdx()}] does not match [${tableIdx}]`);
    }
    
    return futureEnd;
  }
  
  removeFutureEndFromTable(args) {
    _debugLog('[ComponentAsyncState#removeFutureEndFromTable()] args', args);
    
    const { tableIdx, futureWaitableIdx } = args;
    if (tableIdx === undefined) { throw new Error("missing table idx while removing future end"); }
    if (futureWaitableIdx === undefined) {
      throw new Error("missing future end waitable idx while removing future end");
    }
    
    const { table, componentIdx } = FUTURE_TABLES[tableIdx];
    if (!table) { throw new Error(`missing/invalid table [${tableIdx}] while removing future end`); }
    
    const cstate = getOrCreateAsyncState(componentIdx);
    
    const futureEnd = cstate.handles.get(futureWaitableIdx);
    if (!futureEnd) {
      throw new Error(`missing future end (handle [${futureWaitableIdx}], table [${tableIdx}])`);
    }
    const handle = futureEnd.handle();
    
    let removed = cstate.handles.remove(futureWaitableIdx);
    if (!removed) {
      throw new Error(`failed to remove futureEnd from handles (waitable idx [${futureWaitableIdx}]), component [${componentIdx}])`);
    }
    
    removed = table.remove(handle);
    if (!removed) {
      throw new Error(`failed to remove futureEnd from table (handle [${handle}]), table [${tableIdx}], component [${componentIdx}])`);
    }
    
    return futureEnd;
  }
  
}

function clampGuest(i, min, max) {
  if (i < min || i > max) {
    throw new TypeError(`must be between ${min} and ${max}`);
  }
  return i;
}


const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;
let _fs;
async function fetchCompile (url) {
  if (isNode) {
    _fs = _fs || await import('node:fs/promises');
    return WebAssembly.compile(await _fs.readFile(url));
  }
  return fetch(url).then(WebAssembly.compileStreaming);
}

const symbolCabiDispose = Symbol.for('cabiDispose');

const symbolRscHandle = Symbol('handle');

const symbolRscRep = Symbol.for('cabiRep');

const HANDLE_TABLES= [];


function getErrorPayload(e) {
  if (e && hasOwnProperty.call(e, 'payload')) return e.payload;
  if (e instanceof Error) throw e;
  return e;
}

const isLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function throwInvalidBool() {
  throw new TypeError('invalid variant discriminant for bool');
}

const hasOwnProperty = Object.prototype.hasOwnProperty;


if (!getCoreModule) getCoreModule = (name) => fetchCompile(new URL(`./${name}`, import.meta.url));
const module0 = getCoreModule('monty.component.core.wasm');
const module1 = getCoreModule('monty.component.core2.wasm');
const module2 = getCoreModule('monty.component.core3.wasm');
const module3 = getCoreModule('monty.component.core4.wasm');

const { getEnvironment } = imports['wasi:cli/environment'];

if (getEnvironment=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'getEnvironment', was 'getEnvironment' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { exit } = imports['wasi:cli/exit'];

if (exit=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'exit', was 'exit' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { getStderr } = imports['wasi:cli/stderr'];

if (getStderr=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'getStderr', was 'getStderr' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { getStdin } = imports['wasi:cli/stdin'];

if (getStdin=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'getStdin', was 'getStdin' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { getStdout } = imports['wasi:cli/stdout'];

if (getStdout=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'getStdout', was 'getStdout' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { now } = imports['wasi:clocks/monotonic-clock'];

if (now=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'now', was 'now' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { now: now$1 } = imports['wasi:clocks/wall-clock'];

if (now$1=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'now$1', was 'now' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { getDirectories } = imports['wasi:filesystem/preopens'];

if (getDirectories=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'getDirectories', was 'getDirectories' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { Descriptor, filesystemErrorCode } = imports['wasi:filesystem/types'];

if (Descriptor=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'Descriptor', was 'Descriptor' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}


if (filesystemErrorCode=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'filesystemErrorCode', was 'filesystemErrorCode' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { Error: Error$1 } = imports['wasi:io/error'];

if (Error$1=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'Error$1', was 'Error' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { InputStream, OutputStream } = imports['wasi:io/streams'];

if (InputStream=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'InputStream', was 'InputStream' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}


if (OutputStream=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'OutputStream', was 'OutputStream' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

const { getRandomBytes } = imports['wasi:random/random'];

if (getRandomBytes=== undefined) {
  const err = new Error("unexpectedly undefined instance import 'getRandomBytes', was 'getRandomBytes' available at instantiation?");
  console.error("ERROR:", err.toString());
  throw err;
}

let gen = (function* _initGenerator () {
  let exports0;
  let exports1;
  
  const _trampoline0 = function() {
    _debugLog('[iface="wasi:clocks/monotonic-clock@0.2.3", function="now"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'now',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => now(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    _debugLog('[iface="wasi:clocks/monotonic-clock@0.2.3", function="now"][Instruction::Return]', {
      funcName: 'now',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([toUint64(ret)]);
    task.exit();
    return toUint64(ret);
  }
  _trampoline0.fnName = 'wasi:clocks/monotonic-clock@0.2.3#now';
  
  const handleTable1 = [T_FLAG, 0];
  handleTable1._createdReps = new Set();
  
  
  const captureTable1= new Map();
  let captureCnt1= 0;
  
  HANDLE_TABLES[1] = handleTable1;
  
  const _trampoline5 = function() {
    _debugLog('[iface="wasi:cli/stderr@0.2.3", function="get-stderr"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'getStderr',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => getStderr(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    
    if (!(ret instanceof OutputStream)) {
      throw new TypeError('Resource error: Not a valid \"OutputStream\" resource.');
    }
    var handle0 = ret[symbolRscHandle];
    if (!handle0) {
      const rep = ret[symbolRscRep] || ++captureCnt1;
      captureTable1.set(rep, ret);
      handle0 = rscTableCreateOwn(handleTable1, rep);
    }
    
    _debugLog('[iface="wasi:cli/stderr@0.2.3", function="get-stderr"][Instruction::Return]', {
      funcName: 'get-stderr',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([handle0]);
    task.exit();
    return handle0;
  }
  _trampoline5.fnName = 'wasi:cli/stderr@0.2.3#getStderr';
  
  const handleTable2 = [T_FLAG, 0];
  handleTable2._createdReps = new Set();
  
  
  const captureTable2= new Map();
  let captureCnt2= 0;
  
  HANDLE_TABLES[2] = handleTable2;
  
  const _trampoline6 = function() {
    _debugLog('[iface="wasi:cli/stdin@0.2.3", function="get-stdin"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'getStdin',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => getStdin(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    
    if (!(ret instanceof InputStream)) {
      throw new TypeError('Resource error: Not a valid \"InputStream\" resource.');
    }
    var handle0 = ret[symbolRscHandle];
    if (!handle0) {
      const rep = ret[symbolRscRep] || ++captureCnt2;
      captureTable2.set(rep, ret);
      handle0 = rscTableCreateOwn(handleTable2, rep);
    }
    
    _debugLog('[iface="wasi:cli/stdin@0.2.3", function="get-stdin"][Instruction::Return]', {
      funcName: 'get-stdin',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([handle0]);
    task.exit();
    return handle0;
  }
  _trampoline6.fnName = 'wasi:cli/stdin@0.2.3#getStdin';
  
  const _trampoline7 = function() {
    _debugLog('[iface="wasi:cli/stdout@0.2.3", function="get-stdout"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'getStdout',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => getStdout(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    
    if (!(ret instanceof OutputStream)) {
      throw new TypeError('Resource error: Not a valid \"OutputStream\" resource.');
    }
    var handle0 = ret[symbolRscHandle];
    if (!handle0) {
      const rep = ret[symbolRscRep] || ++captureCnt1;
      captureTable1.set(rep, ret);
      handle0 = rscTableCreateOwn(handleTable1, rep);
    }
    
    _debugLog('[iface="wasi:cli/stdout@0.2.3", function="get-stdout"][Instruction::Return]', {
      funcName: 'get-stdout',
      paramCount: 1,
      async: false,
      postReturn: false
    });
    task.resolve([handle0]);
    task.exit();
    return handle0;
  }
  _trampoline7.fnName = 'wasi:cli/stdout@0.2.3#getStdout';
  
  const _trampoline8 = function(arg0) {
    let variant0;
    switch (arg0) {
      case 0: {
        variant0= {
          tag: 'ok',
          val: undefined
        };
        break;
      }
      case 1: {
        variant0= {
          tag: 'err',
          val: undefined
        };
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for expected');
      }
    }
    _debugLog('[iface="wasi:cli/exit@0.2.3", function="exit"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'exit',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => exit(variant0),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    _debugLog('[iface="wasi:cli/exit@0.2.3", function="exit"][Instruction::Return]', {
      funcName: 'exit',
      paramCount: 0,
      async: false,
      postReturn: false
    });
    task.resolve([ret]);
    task.exit();
  }
  _trampoline8.fnName = 'wasi:cli/exit@0.2.3#exit';
  let exports2;
  let memory0;
  let realloc0;
  let realloc0Async;
  
  const _trampoline9 = function(arg0) {
    _debugLog('[iface="wasi:cli/environment@0.2.3", function="get-environment"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'getEnvironment',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => getEnvironment(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    var vec3 = ret;
    var len3 = vec3.length;
    var result3 = realloc0(0, 0, 4, len3 * 16);
    for (let i = 0; i < vec3.length; i++) {
      const e = vec3[i];
      const base = result3 + i * 16;var [tuple0_0, tuple0_1] = e;
      
      var encodeRes = _utf8AllocateAndEncode(tuple0_0, realloc0, memory0);
      var ptr1= encodeRes.ptr;
      var len1 = encodeRes.len;
      
      dataView(memory0).setUint32(base + 4, len1, true);
      dataView(memory0).setUint32(base + 0, ptr1, true);
      
      var encodeRes = _utf8AllocateAndEncode(tuple0_1, realloc0, memory0);
      var ptr2= encodeRes.ptr;
      var len2 = encodeRes.len;
      
      dataView(memory0).setUint32(base + 12, len2, true);
      dataView(memory0).setUint32(base + 8, ptr2, true);
    }
    dataView(memory0).setUint32(arg0 + 4, len3, true);
    dataView(memory0).setUint32(arg0 + 0, result3, true);
    _debugLog('[iface="wasi:cli/environment@0.2.3", function="get-environment"][Instruction::Return]', {
      funcName: 'get-environment',
      paramCount: 0,
      async: false,
      postReturn: false
    });
    task.resolve([ret]);
    task.exit();
  }
  _trampoline9.fnName = 'wasi:cli/environment@0.2.3#getEnvironment';
  
  const _trampoline10 = function(arg0) {
    _debugLog('[iface="wasi:clocks/wall-clock@0.2.3", function="now"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'now$1',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'none',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    
    try {
      ret = _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => now$1(),
      })
      ;
    } catch (err) {
      
      _debugLog('[Instruction::CallInterface] error during sync call', {
        taskID: task.id(),
        subtaskID: task.getParentSubtask()?.id(),
        err,
      });
      task.setErrored(err);
      task.reject(err);
      task.exit();
      throw err;
      
    }
    
    var {seconds: v0_0, nanoseconds: v0_1 } = ret;
    dataView(memory0).setBigInt64(arg0 + 0, toUint64(v0_0), true);
    dataView(memory0).setInt32(arg0 + 8, toUint32(v0_1), true);
    _debugLog('[iface="wasi:clocks/wall-clock@0.2.3", function="now"][Instruction::Return]', {
      funcName: 'now',
      paramCount: 0,
      async: false,
      postReturn: false
    });
    task.resolve([ret]);
    task.exit();
  }
  _trampoline10.fnName = 'wasi:clocks/wall-clock@0.2.3#now$1';
  
  const handleTable3 = [T_FLAG, 0];
  handleTable3._createdReps = new Set();
  
  
  const captureTable3= new Map();
  let captureCnt3= 0;
  
  HANDLE_TABLES[3] = handleTable3;
  
  const _trampoline11 = function(arg0, arg1) {
    var handle1 = arg0;
    
    var rep2 = handleTable3[(handle1 << 1) + 1] & ~T_FLAG;
    var rsc0 = captureTable3.get(rep2);
    if (!rsc0) {
      rsc0 = Object.create(Descriptor.prototype);
      Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
      Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
    }
    
    curResourceBorrows.push(rsc0);
    _debugLog('[iface="wasi:filesystem/types@0.2.3", function="[method]descriptor.get-type"] [Instruction::CallInterface] (sync, @ enter)');
    const hostProvided = true;
    
    let parentTask;
    let task;
    let subtask;
    
    const createTask = () => {
      const results = createNewCurrentTask({
        componentIdx: -1,
        isAsync: false,
        entryFnName: 'getType',
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: 'result-catch-handler',
        callingWasmExport: false,
      });
      task = results[0];
    };
    
    taskCreation: {
      parentTask = getCurrentTask(
      0,
      _getGlobalCurrentTaskMeta(0)?.taskID,
      )?.task;
      
      if (!parentTask) {
        createTask();
        break taskCreation;
      }
      
      createTask();
      
      if (hostProvided) {
        subtask = parentTask.getLatestSubtask();
        if (!subtask) {
          throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
        }
        task.setParentSubtask(subtask);
      }
    }
    
    const started = task.enterSync();
    
    let ret;
    try {
      ret = { tag: 'ok', val: _withGlobalCurrentTaskMeta({
        componentIdx: task.componentIdx(),
        taskID: task.id(),
        fn: () => rsc0.getType(),
      })
    };
  } catch (e) {
    ret = { tag: 'err', val: getErrorPayload(e) };
  }
  
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  var variant5 = ret;
  switch (variant5.tag) {
    case 'ok': {
      const e = variant5.val;
      dataView(memory0).setInt8(arg1 + 0, 0, true);
      var val3 = e;
      let enum3;
      switch (val3) {
        case 'unknown': {
          enum3 = 0;
          break;
        }
        case 'block-device': {
          enum3 = 1;
          break;
        }
        case 'character-device': {
          enum3 = 2;
          break;
        }
        case 'directory': {
          enum3 = 3;
          break;
        }
        case 'fifo': {
          enum3 = 4;
          break;
        }
        case 'symbolic-link': {
          enum3 = 5;
          break;
        }
        case 'regular-file': {
          enum3 = 6;
          break;
        }
        case 'socket': {
          enum3 = 7;
          break;
        }
        default: {
          if ((e) instanceof Error) {
            console.error(e);
          }
          
          throw new TypeError(`"${val3}" is not one of the cases of descriptor-type`);
        }
      }
      dataView(memory0).setInt8(arg1 + 1, enum3, true);
      
      break;
    }
    case 'err': {
      const e = variant5.val;
      dataView(memory0).setInt8(arg1 + 0, 1, true);
      var val4 = e;
      let enum4;
      switch (val4) {
        case 'access': {
          enum4 = 0;
          break;
        }
        case 'would-block': {
          enum4 = 1;
          break;
        }
        case 'already': {
          enum4 = 2;
          break;
        }
        case 'bad-descriptor': {
          enum4 = 3;
          break;
        }
        case 'busy': {
          enum4 = 4;
          break;
        }
        case 'deadlock': {
          enum4 = 5;
          break;
        }
        case 'quota': {
          enum4 = 6;
          break;
        }
        case 'exist': {
          enum4 = 7;
          break;
        }
        case 'file-too-large': {
          enum4 = 8;
          break;
        }
        case 'illegal-byte-sequence': {
          enum4 = 9;
          break;
        }
        case 'in-progress': {
          enum4 = 10;
          break;
        }
        case 'interrupted': {
          enum4 = 11;
          break;
        }
        case 'invalid': {
          enum4 = 12;
          break;
        }
        case 'io': {
          enum4 = 13;
          break;
        }
        case 'is-directory': {
          enum4 = 14;
          break;
        }
        case 'loop': {
          enum4 = 15;
          break;
        }
        case 'too-many-links': {
          enum4 = 16;
          break;
        }
        case 'message-size': {
          enum4 = 17;
          break;
        }
        case 'name-too-long': {
          enum4 = 18;
          break;
        }
        case 'no-device': {
          enum4 = 19;
          break;
        }
        case 'no-entry': {
          enum4 = 20;
          break;
        }
        case 'no-lock': {
          enum4 = 21;
          break;
        }
        case 'insufficient-memory': {
          enum4 = 22;
          break;
        }
        case 'insufficient-space': {
          enum4 = 23;
          break;
        }
        case 'not-directory': {
          enum4 = 24;
          break;
        }
        case 'not-empty': {
          enum4 = 25;
          break;
        }
        case 'not-recoverable': {
          enum4 = 26;
          break;
        }
        case 'unsupported': {
          enum4 = 27;
          break;
        }
        case 'no-tty': {
          enum4 = 28;
          break;
        }
        case 'no-such-device': {
          enum4 = 29;
          break;
        }
        case 'overflow': {
          enum4 = 30;
          break;
        }
        case 'not-permitted': {
          enum4 = 31;
          break;
        }
        case 'pipe': {
          enum4 = 32;
          break;
        }
        case 'read-only': {
          enum4 = 33;
          break;
        }
        case 'invalid-seek': {
          enum4 = 34;
          break;
        }
        case 'text-file-busy': {
          enum4 = 35;
          break;
        }
        case 'cross-device': {
          enum4 = 36;
          break;
        }
        default: {
          if ((e) instanceof Error) {
            console.error(e);
          }
          
          throw new TypeError(`"${val4}" is not one of the cases of error-code`);
        }
      }
      dataView(memory0).setInt8(arg1 + 1, enum4, true);
      
      break;
    }
    default: {
      _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant5, valueType: typeof variant5});
      throw new TypeError('invalid variant specified for result');
    }
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.3", function="[method]descriptor.get-type"][Instruction::Return]', {
    funcName: '[method]descriptor.get-type',
    paramCount: 0,
    async: false,
    postReturn: false
  });
  task.resolve([ret]);
  task.exit();
}
_trampoline11.fnName = 'wasi:filesystem/types@0.2.3#getType';

const handleTable0 = [T_FLAG, 0];
handleTable0._createdReps = new Set();


const captureTable0= new Map();
let captureCnt0= 0;

HANDLE_TABLES[0] = handleTable0;

const _trampoline12 = function(arg0, arg1) {
  var handle1 = arg0;
  
  var rep2 = handleTable0[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable0.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Error$1.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:filesystem/types@0.2.3", function="filesystem-error-code"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'filesystemErrorCode',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'none',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  
  try {
    ret = _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => filesystemErrorCode(rsc0),
    })
    ;
  } catch (err) {
    
    _debugLog('[Instruction::CallInterface] error during sync call', {
      taskID: task.id(),
      subtaskID: task.getParentSubtask()?.id(),
      err,
    });
    task.setErrored(err);
    task.reject(err);
    task.exit();
    throw err;
    
  }
  
  for (const rsc of curResourceBorrows) {
    rsc[symbolRscHandle] = undefined;
  }
  curResourceBorrows = [];
  var variant4 = ret;
  if (variant4 === null || variant4=== undefined) {
    dataView(memory0).setInt8(arg1 + 0, 0, true);
  } else {
    const e = variant4;
    dataView(memory0).setInt8(arg1 + 0, 1, true);
    var val3 = e;
    let enum3;
    switch (val3) {
      case 'access': {
        enum3 = 0;
        break;
      }
      case 'would-block': {
        enum3 = 1;
        break;
      }
      case 'already': {
        enum3 = 2;
        break;
      }
      case 'bad-descriptor': {
        enum3 = 3;
        break;
      }
      case 'busy': {
        enum3 = 4;
        break;
      }
      case 'deadlock': {
        enum3 = 5;
        break;
      }
      case 'quota': {
        enum3 = 6;
        break;
      }
      case 'exist': {
        enum3 = 7;
        break;
      }
      case 'file-too-large': {
        enum3 = 8;
        break;
      }
      case 'illegal-byte-sequence': {
        enum3 = 9;
        break;
      }
      case 'in-progress': {
        enum3 = 10;
        break;
      }
      case 'interrupted': {
        enum3 = 11;
        break;
      }
      case 'invalid': {
        enum3 = 12;
        break;
      }
      case 'io': {
        enum3 = 13;
        break;
      }
      case 'is-directory': {
        enum3 = 14;
        break;
      }
      case 'loop': {
        enum3 = 15;
        break;
      }
      case 'too-many-links': {
        enum3 = 16;
        break;
      }
      case 'message-size': {
        enum3 = 17;
        break;
      }
      case 'name-too-long': {
        enum3 = 18;
        break;
      }
      case 'no-device': {
        enum3 = 19;
        break;
      }
      case 'no-entry': {
        enum3 = 20;
        break;
      }
      case 'no-lock': {
        enum3 = 21;
        break;
      }
      case 'insufficient-memory': {
        enum3 = 22;
        break;
      }
      case 'insufficient-space': {
        enum3 = 23;
        break;
      }
      case 'not-directory': {
        enum3 = 24;
        break;
      }
      case 'not-empty': {
        enum3 = 25;
        break;
      }
      case 'not-recoverable': {
        enum3 = 26;
        break;
      }
      case 'unsupported': {
        enum3 = 27;
        break;
      }
      case 'no-tty': {
        enum3 = 28;
        break;
      }
      case 'no-such-device': {
        enum3 = 29;
        break;
      }
      case 'overflow': {
        enum3 = 30;
        break;
      }
      case 'not-permitted': {
        enum3 = 31;
        break;
      }
      case 'pipe': {
        enum3 = 32;
        break;
      }
      case 'read-only': {
        enum3 = 33;
        break;
      }
      case 'invalid-seek': {
        enum3 = 34;
        break;
      }
      case 'text-file-busy': {
        enum3 = 35;
        break;
      }
      case 'cross-device': {
        enum3 = 36;
        break;
      }
      default: {
        if ((e) instanceof Error) {
          console.error(e);
        }
        
        throw new TypeError(`"${val3}" is not one of the cases of error-code`);
      }
    }
    dataView(memory0).setInt8(arg1 + 1, enum3, true);
  }
  _debugLog('[iface="wasi:filesystem/types@0.2.3", function="filesystem-error-code"][Instruction::Return]', {
    funcName: 'filesystem-error-code',
    paramCount: 0,
    async: false,
    postReturn: false
  });
  task.resolve([ret]);
  task.exit();
}
_trampoline12.fnName = 'wasi:filesystem/types@0.2.3#filesystemErrorCode';

const _trampoline13 = function(arg0, arg1, arg2) {
  var handle1 = arg0;
  
  var rep2 = handleTable3[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable3.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Descriptor.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:filesystem/types@0.2.3", function="[method]descriptor.write-via-stream"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'writeViaStream',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'result-catch-handler',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  try {
    ret = { tag: 'ok', val: _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.writeViaStream(BigInt.asUintN(64, BigInt(arg1))),
    })
  };
} catch (e) {
  ret = { tag: 'err', val: getErrorPayload(e) };
}

for (const rsc of curResourceBorrows) {
  rsc[symbolRscHandle] = undefined;
}
curResourceBorrows = [];
var variant5 = ret;
switch (variant5.tag) {
  case 'ok': {
    const e = variant5.val;
    dataView(memory0).setInt8(arg2 + 0, 0, true);
    
    if (!(e instanceof OutputStream)) {
      throw new TypeError('Resource error: Not a valid \"OutputStream\" resource.');
    }
    var handle3 = e[symbolRscHandle];
    if (!handle3) {
      const rep = e[symbolRscRep] || ++captureCnt1;
      captureTable1.set(rep, e);
      handle3 = rscTableCreateOwn(handleTable1, rep);
    }
    
    dataView(memory0).setInt32(arg2 + 4, handle3, true);
    
    break;
  }
  case 'err': {
    const e = variant5.val;
    dataView(memory0).setInt8(arg2 + 0, 1, true);
    var val4 = e;
    let enum4;
    switch (val4) {
      case 'access': {
        enum4 = 0;
        break;
      }
      case 'would-block': {
        enum4 = 1;
        break;
      }
      case 'already': {
        enum4 = 2;
        break;
      }
      case 'bad-descriptor': {
        enum4 = 3;
        break;
      }
      case 'busy': {
        enum4 = 4;
        break;
      }
      case 'deadlock': {
        enum4 = 5;
        break;
      }
      case 'quota': {
        enum4 = 6;
        break;
      }
      case 'exist': {
        enum4 = 7;
        break;
      }
      case 'file-too-large': {
        enum4 = 8;
        break;
      }
      case 'illegal-byte-sequence': {
        enum4 = 9;
        break;
      }
      case 'in-progress': {
        enum4 = 10;
        break;
      }
      case 'interrupted': {
        enum4 = 11;
        break;
      }
      case 'invalid': {
        enum4 = 12;
        break;
      }
      case 'io': {
        enum4 = 13;
        break;
      }
      case 'is-directory': {
        enum4 = 14;
        break;
      }
      case 'loop': {
        enum4 = 15;
        break;
      }
      case 'too-many-links': {
        enum4 = 16;
        break;
      }
      case 'message-size': {
        enum4 = 17;
        break;
      }
      case 'name-too-long': {
        enum4 = 18;
        break;
      }
      case 'no-device': {
        enum4 = 19;
        break;
      }
      case 'no-entry': {
        enum4 = 20;
        break;
      }
      case 'no-lock': {
        enum4 = 21;
        break;
      }
      case 'insufficient-memory': {
        enum4 = 22;
        break;
      }
      case 'insufficient-space': {
        enum4 = 23;
        break;
      }
      case 'not-directory': {
        enum4 = 24;
        break;
      }
      case 'not-empty': {
        enum4 = 25;
        break;
      }
      case 'not-recoverable': {
        enum4 = 26;
        break;
      }
      case 'unsupported': {
        enum4 = 27;
        break;
      }
      case 'no-tty': {
        enum4 = 28;
        break;
      }
      case 'no-such-device': {
        enum4 = 29;
        break;
      }
      case 'overflow': {
        enum4 = 30;
        break;
      }
      case 'not-permitted': {
        enum4 = 31;
        break;
      }
      case 'pipe': {
        enum4 = 32;
        break;
      }
      case 'read-only': {
        enum4 = 33;
        break;
      }
      case 'invalid-seek': {
        enum4 = 34;
        break;
      }
      case 'text-file-busy': {
        enum4 = 35;
        break;
      }
      case 'cross-device': {
        enum4 = 36;
        break;
      }
      default: {
        if ((e) instanceof Error) {
          console.error(e);
        }
        
        throw new TypeError(`"${val4}" is not one of the cases of error-code`);
      }
    }
    dataView(memory0).setInt8(arg2 + 4, enum4, true);
    
    break;
  }
  default: {
    _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant5, valueType: typeof variant5});
    throw new TypeError('invalid variant specified for result');
  }
}
_debugLog('[iface="wasi:filesystem/types@0.2.3", function="[method]descriptor.write-via-stream"][Instruction::Return]', {
  funcName: '[method]descriptor.write-via-stream',
  paramCount: 0,
  async: false,
  postReturn: false
});
task.resolve([ret]);
task.exit();
}
_trampoline13.fnName = 'wasi:filesystem/types@0.2.3#writeViaStream';

const _trampoline14 = function(arg0, arg1) {
  var handle1 = arg0;
  
  var rep2 = handleTable3[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable3.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Descriptor.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:filesystem/types@0.2.3", function="[method]descriptor.append-via-stream"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'appendViaStream',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'result-catch-handler',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  try {
    ret = { tag: 'ok', val: _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.appendViaStream(),
    })
  };
} catch (e) {
  ret = { tag: 'err', val: getErrorPayload(e) };
}

for (const rsc of curResourceBorrows) {
  rsc[symbolRscHandle] = undefined;
}
curResourceBorrows = [];
var variant5 = ret;
switch (variant5.tag) {
  case 'ok': {
    const e = variant5.val;
    dataView(memory0).setInt8(arg1 + 0, 0, true);
    
    if (!(e instanceof OutputStream)) {
      throw new TypeError('Resource error: Not a valid \"OutputStream\" resource.');
    }
    var handle3 = e[symbolRscHandle];
    if (!handle3) {
      const rep = e[symbolRscRep] || ++captureCnt1;
      captureTable1.set(rep, e);
      handle3 = rscTableCreateOwn(handleTable1, rep);
    }
    
    dataView(memory0).setInt32(arg1 + 4, handle3, true);
    
    break;
  }
  case 'err': {
    const e = variant5.val;
    dataView(memory0).setInt8(arg1 + 0, 1, true);
    var val4 = e;
    let enum4;
    switch (val4) {
      case 'access': {
        enum4 = 0;
        break;
      }
      case 'would-block': {
        enum4 = 1;
        break;
      }
      case 'already': {
        enum4 = 2;
        break;
      }
      case 'bad-descriptor': {
        enum4 = 3;
        break;
      }
      case 'busy': {
        enum4 = 4;
        break;
      }
      case 'deadlock': {
        enum4 = 5;
        break;
      }
      case 'quota': {
        enum4 = 6;
        break;
      }
      case 'exist': {
        enum4 = 7;
        break;
      }
      case 'file-too-large': {
        enum4 = 8;
        break;
      }
      case 'illegal-byte-sequence': {
        enum4 = 9;
        break;
      }
      case 'in-progress': {
        enum4 = 10;
        break;
      }
      case 'interrupted': {
        enum4 = 11;
        break;
      }
      case 'invalid': {
        enum4 = 12;
        break;
      }
      case 'io': {
        enum4 = 13;
        break;
      }
      case 'is-directory': {
        enum4 = 14;
        break;
      }
      case 'loop': {
        enum4 = 15;
        break;
      }
      case 'too-many-links': {
        enum4 = 16;
        break;
      }
      case 'message-size': {
        enum4 = 17;
        break;
      }
      case 'name-too-long': {
        enum4 = 18;
        break;
      }
      case 'no-device': {
        enum4 = 19;
        break;
      }
      case 'no-entry': {
        enum4 = 20;
        break;
      }
      case 'no-lock': {
        enum4 = 21;
        break;
      }
      case 'insufficient-memory': {
        enum4 = 22;
        break;
      }
      case 'insufficient-space': {
        enum4 = 23;
        break;
      }
      case 'not-directory': {
        enum4 = 24;
        break;
      }
      case 'not-empty': {
        enum4 = 25;
        break;
      }
      case 'not-recoverable': {
        enum4 = 26;
        break;
      }
      case 'unsupported': {
        enum4 = 27;
        break;
      }
      case 'no-tty': {
        enum4 = 28;
        break;
      }
      case 'no-such-device': {
        enum4 = 29;
        break;
      }
      case 'overflow': {
        enum4 = 30;
        break;
      }
      case 'not-permitted': {
        enum4 = 31;
        break;
      }
      case 'pipe': {
        enum4 = 32;
        break;
      }
      case 'read-only': {
        enum4 = 33;
        break;
      }
      case 'invalid-seek': {
        enum4 = 34;
        break;
      }
      case 'text-file-busy': {
        enum4 = 35;
        break;
      }
      case 'cross-device': {
        enum4 = 36;
        break;
      }
      default: {
        if ((e) instanceof Error) {
          console.error(e);
        }
        
        throw new TypeError(`"${val4}" is not one of the cases of error-code`);
      }
    }
    dataView(memory0).setInt8(arg1 + 4, enum4, true);
    
    break;
  }
  default: {
    _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant5, valueType: typeof variant5});
    throw new TypeError('invalid variant specified for result');
  }
}
_debugLog('[iface="wasi:filesystem/types@0.2.3", function="[method]descriptor.append-via-stream"][Instruction::Return]', {
  funcName: '[method]descriptor.append-via-stream',
  paramCount: 0,
  async: false,
  postReturn: false
});
task.resolve([ret]);
task.exit();
}
_trampoline14.fnName = 'wasi:filesystem/types@0.2.3#appendViaStream';

const _trampoline15 = function(arg0, arg1) {
  var handle1 = arg0;
  
  var rep2 = handleTable3[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable3.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(Descriptor.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:filesystem/types@0.2.3", function="[method]descriptor.stat"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'stat',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'result-catch-handler',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  try {
    ret = { tag: 'ok', val: _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.stat(),
    })
  };
} catch (e) {
  ret = { tag: 'err', val: getErrorPayload(e) };
}

for (const rsc of curResourceBorrows) {
  rsc[symbolRscHandle] = undefined;
}
curResourceBorrows = [];
var variant12 = ret;
switch (variant12.tag) {
  case 'ok': {
    const e = variant12.val;
    dataView(memory0).setInt8(arg1 + 0, 0, true);
    var {type: v3_0, linkCount: v3_1, size: v3_2, dataAccessTimestamp: v3_3, dataModificationTimestamp: v3_4, statusChangeTimestamp: v3_5 } = e;
    var val4 = v3_0;
    let enum4;
    switch (val4) {
      case 'unknown': {
        enum4 = 0;
        break;
      }
      case 'block-device': {
        enum4 = 1;
        break;
      }
      case 'character-device': {
        enum4 = 2;
        break;
      }
      case 'directory': {
        enum4 = 3;
        break;
      }
      case 'fifo': {
        enum4 = 4;
        break;
      }
      case 'symbolic-link': {
        enum4 = 5;
        break;
      }
      case 'regular-file': {
        enum4 = 6;
        break;
      }
      case 'socket': {
        enum4 = 7;
        break;
      }
      default: {
        if ((v3_0) instanceof Error) {
          console.error(v3_0);
        }
        
        throw new TypeError(`"${val4}" is not one of the cases of descriptor-type`);
      }
    }
    dataView(memory0).setInt8(arg1 + 8, enum4, true);
    dataView(memory0).setBigInt64(arg1 + 16, toUint64(v3_1), true);
    dataView(memory0).setBigInt64(arg1 + 24, toUint64(v3_2), true);
    var variant6 = v3_3;
    if (variant6 === null || variant6=== undefined) {
      dataView(memory0).setInt8(arg1 + 32, 0, true);
    } else {
      const e = variant6;
      dataView(memory0).setInt8(arg1 + 32, 1, true);
      var {seconds: v5_0, nanoseconds: v5_1 } = e;
      dataView(memory0).setBigInt64(arg1 + 40, toUint64(v5_0), true);
      dataView(memory0).setInt32(arg1 + 48, toUint32(v5_1), true);
    }
    var variant8 = v3_4;
    if (variant8 === null || variant8=== undefined) {
      dataView(memory0).setInt8(arg1 + 56, 0, true);
    } else {
      const e = variant8;
      dataView(memory0).setInt8(arg1 + 56, 1, true);
      var {seconds: v7_0, nanoseconds: v7_1 } = e;
      dataView(memory0).setBigInt64(arg1 + 64, toUint64(v7_0), true);
      dataView(memory0).setInt32(arg1 + 72, toUint32(v7_1), true);
    }
    var variant10 = v3_5;
    if (variant10 === null || variant10=== undefined) {
      dataView(memory0).setInt8(arg1 + 80, 0, true);
    } else {
      const e = variant10;
      dataView(memory0).setInt8(arg1 + 80, 1, true);
      var {seconds: v9_0, nanoseconds: v9_1 } = e;
      dataView(memory0).setBigInt64(arg1 + 88, toUint64(v9_0), true);
      dataView(memory0).setInt32(arg1 + 96, toUint32(v9_1), true);
    }
    
    break;
  }
  case 'err': {
    const e = variant12.val;
    dataView(memory0).setInt8(arg1 + 0, 1, true);
    var val11 = e;
    let enum11;
    switch (val11) {
      case 'access': {
        enum11 = 0;
        break;
      }
      case 'would-block': {
        enum11 = 1;
        break;
      }
      case 'already': {
        enum11 = 2;
        break;
      }
      case 'bad-descriptor': {
        enum11 = 3;
        break;
      }
      case 'busy': {
        enum11 = 4;
        break;
      }
      case 'deadlock': {
        enum11 = 5;
        break;
      }
      case 'quota': {
        enum11 = 6;
        break;
      }
      case 'exist': {
        enum11 = 7;
        break;
      }
      case 'file-too-large': {
        enum11 = 8;
        break;
      }
      case 'illegal-byte-sequence': {
        enum11 = 9;
        break;
      }
      case 'in-progress': {
        enum11 = 10;
        break;
      }
      case 'interrupted': {
        enum11 = 11;
        break;
      }
      case 'invalid': {
        enum11 = 12;
        break;
      }
      case 'io': {
        enum11 = 13;
        break;
      }
      case 'is-directory': {
        enum11 = 14;
        break;
      }
      case 'loop': {
        enum11 = 15;
        break;
      }
      case 'too-many-links': {
        enum11 = 16;
        break;
      }
      case 'message-size': {
        enum11 = 17;
        break;
      }
      case 'name-too-long': {
        enum11 = 18;
        break;
      }
      case 'no-device': {
        enum11 = 19;
        break;
      }
      case 'no-entry': {
        enum11 = 20;
        break;
      }
      case 'no-lock': {
        enum11 = 21;
        break;
      }
      case 'insufficient-memory': {
        enum11 = 22;
        break;
      }
      case 'insufficient-space': {
        enum11 = 23;
        break;
      }
      case 'not-directory': {
        enum11 = 24;
        break;
      }
      case 'not-empty': {
        enum11 = 25;
        break;
      }
      case 'not-recoverable': {
        enum11 = 26;
        break;
      }
      case 'unsupported': {
        enum11 = 27;
        break;
      }
      case 'no-tty': {
        enum11 = 28;
        break;
      }
      case 'no-such-device': {
        enum11 = 29;
        break;
      }
      case 'overflow': {
        enum11 = 30;
        break;
      }
      case 'not-permitted': {
        enum11 = 31;
        break;
      }
      case 'pipe': {
        enum11 = 32;
        break;
      }
      case 'read-only': {
        enum11 = 33;
        break;
      }
      case 'invalid-seek': {
        enum11 = 34;
        break;
      }
      case 'text-file-busy': {
        enum11 = 35;
        break;
      }
      case 'cross-device': {
        enum11 = 36;
        break;
      }
      default: {
        if ((e) instanceof Error) {
          console.error(e);
        }
        
        throw new TypeError(`"${val11}" is not one of the cases of error-code`);
      }
    }
    dataView(memory0).setInt8(arg1 + 8, enum11, true);
    
    break;
  }
  default: {
    _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant12, valueType: typeof variant12});
    throw new TypeError('invalid variant specified for result');
  }
}
_debugLog('[iface="wasi:filesystem/types@0.2.3", function="[method]descriptor.stat"][Instruction::Return]', {
  funcName: '[method]descriptor.stat',
  paramCount: 0,
  async: false,
  postReturn: false
});
task.resolve([ret]);
task.exit();
}
_trampoline15.fnName = 'wasi:filesystem/types@0.2.3#stat';

const _trampoline16 = function(arg0, arg1) {
  var handle1 = arg0;
  
  var rep2 = handleTable1[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable1.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(OutputStream.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:io/streams@0.2.3", function="[method]output-stream.check-write"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'checkWrite',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'result-catch-handler',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  try {
    ret = { tag: 'ok', val: _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.checkWrite(),
    })
  };
} catch (e) {
  ret = { tag: 'err', val: getErrorPayload(e) };
}

for (const rsc of curResourceBorrows) {
  rsc[symbolRscHandle] = undefined;
}
curResourceBorrows = [];
var variant5 = ret;
switch (variant5.tag) {
  case 'ok': {
    const e = variant5.val;
    dataView(memory0).setInt8(arg1 + 0, 0, true);
    dataView(memory0).setBigInt64(arg1 + 8, toUint64(e), true);
    
    break;
  }
  case 'err': {
    const e = variant5.val;
    dataView(memory0).setInt8(arg1 + 0, 1, true);
    var variant4 = e;
    switch (variant4.tag) {
      case 'last-operation-failed': {
        const e = variant4.val;
        dataView(memory0).setInt8(arg1 + 8, 0, true);
        
        if (!(e instanceof Error$1)) {
          throw new TypeError('Resource error: Not a valid \"Error\" resource.');
        }
        var handle3 = e[symbolRscHandle];
        if (!handle3) {
          const rep = e[symbolRscRep] || ++captureCnt0;
          captureTable0.set(rep, e);
          handle3 = rscTableCreateOwn(handleTable0, rep);
        }
        
        dataView(memory0).setInt32(arg1 + 12, handle3, true);
        break;
      }
      case 'closed': {
        dataView(memory0).setInt8(arg1 + 8, 1, true);
        break;
      }
      default: {
        throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant4.tag)}\` (received \`${variant4}\`) specified for \`StreamError\``);
      }
    }
    
    break;
  }
  default: {
    _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant5, valueType: typeof variant5});
    throw new TypeError('invalid variant specified for result');
  }
}
_debugLog('[iface="wasi:io/streams@0.2.3", function="[method]output-stream.check-write"][Instruction::Return]', {
  funcName: '[method]output-stream.check-write',
  paramCount: 0,
  async: false,
  postReturn: false
});
task.resolve([ret]);
task.exit();
}
_trampoline16.fnName = 'wasi:io/streams@0.2.3#checkWrite';

const _trampoline17 = function(arg0, arg1, arg2, arg3) {
  var handle1 = arg0;
  
  var rep2 = handleTable1[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable1.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(OutputStream.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  var ptr3 = arg1;
  var len3 = arg2;
  var result3 = new Uint8Array(memory0.buffer.slice(ptr3, ptr3 + len3 * 1));
  _debugLog('[iface="wasi:io/streams@0.2.3", function="[method]output-stream.write"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'write',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'result-catch-handler',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  try {
    ret = { tag: 'ok', val: _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.write(result3),
    })
  };
} catch (e) {
  ret = { tag: 'err', val: getErrorPayload(e) };
}

for (const rsc of curResourceBorrows) {
  rsc[symbolRscHandle] = undefined;
}
curResourceBorrows = [];
var variant6 = ret;
switch (variant6.tag) {
  case 'ok': {
    const e = variant6.val;
    dataView(memory0).setInt8(arg3 + 0, 0, true);
    
    break;
  }
  case 'err': {
    const e = variant6.val;
    dataView(memory0).setInt8(arg3 + 0, 1, true);
    var variant5 = e;
    switch (variant5.tag) {
      case 'last-operation-failed': {
        const e = variant5.val;
        dataView(memory0).setInt8(arg3 + 4, 0, true);
        
        if (!(e instanceof Error$1)) {
          throw new TypeError('Resource error: Not a valid \"Error\" resource.');
        }
        var handle4 = e[symbolRscHandle];
        if (!handle4) {
          const rep = e[symbolRscRep] || ++captureCnt0;
          captureTable0.set(rep, e);
          handle4 = rscTableCreateOwn(handleTable0, rep);
        }
        
        dataView(memory0).setInt32(arg3 + 8, handle4, true);
        break;
      }
      case 'closed': {
        dataView(memory0).setInt8(arg3 + 4, 1, true);
        break;
      }
      default: {
        throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant5.tag)}\` (received \`${variant5}\`) specified for \`StreamError\``);
      }
    }
    
    break;
  }
  default: {
    _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant6, valueType: typeof variant6});
    throw new TypeError('invalid variant specified for result');
  }
}
_debugLog('[iface="wasi:io/streams@0.2.3", function="[method]output-stream.write"][Instruction::Return]', {
  funcName: '[method]output-stream.write',
  paramCount: 0,
  async: false,
  postReturn: false
});
task.resolve([ret]);
task.exit();
}
_trampoline17.fnName = 'wasi:io/streams@0.2.3#write';

const _trampoline18 = function(arg0, arg1, arg2, arg3) {
  var handle1 = arg0;
  
  var rep2 = handleTable1[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable1.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(OutputStream.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  var ptr3 = arg1;
  var len3 = arg2;
  var result3 = new Uint8Array(memory0.buffer.slice(ptr3, ptr3 + len3 * 1));
  _debugLog('[iface="wasi:io/streams@0.2.3", function="[method]output-stream.blocking-write-and-flush"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'blockingWriteAndFlush',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'result-catch-handler',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  try {
    ret = { tag: 'ok', val: _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.blockingWriteAndFlush(result3),
    })
  };
} catch (e) {
  ret = { tag: 'err', val: getErrorPayload(e) };
}

for (const rsc of curResourceBorrows) {
  rsc[symbolRscHandle] = undefined;
}
curResourceBorrows = [];
var variant6 = ret;
switch (variant6.tag) {
  case 'ok': {
    const e = variant6.val;
    dataView(memory0).setInt8(arg3 + 0, 0, true);
    
    break;
  }
  case 'err': {
    const e = variant6.val;
    dataView(memory0).setInt8(arg3 + 0, 1, true);
    var variant5 = e;
    switch (variant5.tag) {
      case 'last-operation-failed': {
        const e = variant5.val;
        dataView(memory0).setInt8(arg3 + 4, 0, true);
        
        if (!(e instanceof Error$1)) {
          throw new TypeError('Resource error: Not a valid \"Error\" resource.');
        }
        var handle4 = e[symbolRscHandle];
        if (!handle4) {
          const rep = e[symbolRscRep] || ++captureCnt0;
          captureTable0.set(rep, e);
          handle4 = rscTableCreateOwn(handleTable0, rep);
        }
        
        dataView(memory0).setInt32(arg3 + 8, handle4, true);
        break;
      }
      case 'closed': {
        dataView(memory0).setInt8(arg3 + 4, 1, true);
        break;
      }
      default: {
        throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant5.tag)}\` (received \`${variant5}\`) specified for \`StreamError\``);
      }
    }
    
    break;
  }
  default: {
    _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant6, valueType: typeof variant6});
    throw new TypeError('invalid variant specified for result');
  }
}
_debugLog('[iface="wasi:io/streams@0.2.3", function="[method]output-stream.blocking-write-and-flush"][Instruction::Return]', {
  funcName: '[method]output-stream.blocking-write-and-flush',
  paramCount: 0,
  async: false,
  postReturn: false
});
task.resolve([ret]);
task.exit();
}
_trampoline18.fnName = 'wasi:io/streams@0.2.3#blockingWriteAndFlush';

const _trampoline19 = function(arg0, arg1) {
  var handle1 = arg0;
  
  var rep2 = handleTable1[(handle1 << 1) + 1] & ~T_FLAG;
  var rsc0 = captureTable1.get(rep2);
  if (!rsc0) {
    rsc0 = Object.create(OutputStream.prototype);
    Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1});
    Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2});
  }
  
  curResourceBorrows.push(rsc0);
  _debugLog('[iface="wasi:io/streams@0.2.3", function="[method]output-stream.blocking-flush"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'blockingFlush',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'result-catch-handler',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  try {
    ret = { tag: 'ok', val: _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => rsc0.blockingFlush(),
    })
  };
} catch (e) {
  ret = { tag: 'err', val: getErrorPayload(e) };
}

for (const rsc of curResourceBorrows) {
  rsc[symbolRscHandle] = undefined;
}
curResourceBorrows = [];
var variant5 = ret;
switch (variant5.tag) {
  case 'ok': {
    const e = variant5.val;
    dataView(memory0).setInt8(arg1 + 0, 0, true);
    
    break;
  }
  case 'err': {
    const e = variant5.val;
    dataView(memory0).setInt8(arg1 + 0, 1, true);
    var variant4 = e;
    switch (variant4.tag) {
      case 'last-operation-failed': {
        const e = variant4.val;
        dataView(memory0).setInt8(arg1 + 4, 0, true);
        
        if (!(e instanceof Error$1)) {
          throw new TypeError('Resource error: Not a valid \"Error\" resource.');
        }
        var handle3 = e[symbolRscHandle];
        if (!handle3) {
          const rep = e[symbolRscRep] || ++captureCnt0;
          captureTable0.set(rep, e);
          handle3 = rscTableCreateOwn(handleTable0, rep);
        }
        
        dataView(memory0).setInt32(arg1 + 8, handle3, true);
        break;
      }
      case 'closed': {
        dataView(memory0).setInt8(arg1 + 4, 1, true);
        break;
      }
      default: {
        throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant4.tag)}\` (received \`${variant4}\`) specified for \`StreamError\``);
      }
    }
    
    break;
  }
  default: {
    _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant5, valueType: typeof variant5});
    throw new TypeError('invalid variant specified for result');
  }
}
_debugLog('[iface="wasi:io/streams@0.2.3", function="[method]output-stream.blocking-flush"][Instruction::Return]', {
  funcName: '[method]output-stream.blocking-flush',
  paramCount: 0,
  async: false,
  postReturn: false
});
task.resolve([ret]);
task.exit();
}
_trampoline19.fnName = 'wasi:io/streams@0.2.3#blockingFlush';

const _trampoline20 = function(arg0, arg1) {
  _debugLog('[iface="wasi:random/random@0.2.3", function="get-random-bytes"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'getRandomBytes',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'none',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  
  try {
    ret = _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => getRandomBytes(BigInt.asUintN(64, BigInt(arg0))),
    })
    ;
  } catch (err) {
    
    _debugLog('[Instruction::CallInterface] error during sync call', {
      taskID: task.id(),
      subtaskID: task.getParentSubtask()?.id(),
      err,
    });
    task.setErrored(err);
    task.reject(err);
    task.exit();
    throw err;
    
  }
  
  var val0 = ret;
  var len0 = Array.isArray(val0) ? val0.length : val0.byteLength;
  var ptr0 = realloc0(0, 0, 1, len0 * 1);
  
  let valData0;
  const valLenBytes0 = len0 * 1;
  if (Array.isArray(val0)) {
    // Regular array likely containing numbers, write values to memory
    let offset = 0;
    const dv0 = new DataView(memory0.buffer);
    for (const v of val0) {
      _requireValidNumericPrimitive.bind(null, 'u8')(v);
      dv0.setUint8(ptr0+ offset, v, true);
      offset += 1;
    }
  } else {
    // TypedArray / ArrayBuffer-like, direct copy
    valData0 = new Uint8Array(val0.buffer || val0, val0.byteOffset, valLenBytes0);
    const out0 = new Uint8Array(memory0.buffer, ptr0, valLenBytes0);
    out0.set(valData0);
  }
  
  dataView(memory0).setUint32(arg1 + 4, len0, true);
  dataView(memory0).setUint32(arg1 + 0, ptr0, true);
  _debugLog('[iface="wasi:random/random@0.2.3", function="get-random-bytes"][Instruction::Return]', {
    funcName: 'get-random-bytes',
    paramCount: 0,
    async: false,
    postReturn: false
  });
  task.resolve([ret]);
  task.exit();
}
_trampoline20.fnName = 'wasi:random/random@0.2.3#getRandomBytes';

const _trampoline21 = function(arg0) {
  _debugLog('[iface="wasi:filesystem/preopens@0.2.3", function="get-directories"] [Instruction::CallInterface] (sync, @ enter)');
  const hostProvided = true;
  
  let parentTask;
  let task;
  let subtask;
  
  const createTask = () => {
    const results = createNewCurrentTask({
      componentIdx: -1,
      isAsync: false,
      entryFnName: 'getDirectories',
      getCallbackFn: () => null,
      callbackFnName: null,
      errHandling: 'none',
      callingWasmExport: false,
    });
    task = results[0];
  };
  
  taskCreation: {
    parentTask = getCurrentTask(
    0,
    _getGlobalCurrentTaskMeta(0)?.taskID,
    )?.task;
    
    if (!parentTask) {
      createTask();
      break taskCreation;
    }
    
    createTask();
    
    if (hostProvided) {
      subtask = parentTask.getLatestSubtask();
      if (!subtask) {
        throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
      }
      task.setParentSubtask(subtask);
    }
  }
  
  const started = task.enterSync();
  
  let ret;
  
  try {
    ret = _withGlobalCurrentTaskMeta({
      componentIdx: task.componentIdx(),
      taskID: task.id(),
      fn: () => getDirectories(),
    })
    ;
  } catch (err) {
    
    _debugLog('[Instruction::CallInterface] error during sync call', {
      taskID: task.id(),
      subtaskID: task.getParentSubtask()?.id(),
      err,
    });
    task.setErrored(err);
    task.reject(err);
    task.exit();
    throw err;
    
  }
  
  var vec3 = ret;
  var len3 = vec3.length;
  var result3 = realloc0(0, 0, 4, len3 * 12);
  for (let i = 0; i < vec3.length; i++) {
    const e = vec3[i];
    const base = result3 + i * 12;var [tuple0_0, tuple0_1] = e;
    
    if (!(tuple0_0 instanceof Descriptor)) {
      throw new TypeError('Resource error: Not a valid \"Descriptor\" resource.');
    }
    var handle1 = tuple0_0[symbolRscHandle];
    if (!handle1) {
      const rep = tuple0_0[symbolRscRep] || ++captureCnt3;
      captureTable3.set(rep, tuple0_0);
      handle1 = rscTableCreateOwn(handleTable3, rep);
    }
    
    dataView(memory0).setInt32(base + 0, handle1, true);
    
    var encodeRes = _utf8AllocateAndEncode(tuple0_1, realloc0, memory0);
    var ptr2= encodeRes.ptr;
    var len2 = encodeRes.len;
    
    dataView(memory0).setUint32(base + 8, len2, true);
    dataView(memory0).setUint32(base + 4, ptr2, true);
  }
  dataView(memory0).setUint32(arg0 + 4, len3, true);
  dataView(memory0).setUint32(arg0 + 0, result3, true);
  _debugLog('[iface="wasi:filesystem/preopens@0.2.3", function="get-directories"][Instruction::Return]', {
    funcName: 'get-directories',
    paramCount: 0,
    async: false,
    postReturn: false
  });
  task.resolve([ret]);
  task.exit();
}
_trampoline21.fnName = 'wasi:filesystem/preopens@0.2.3#getDirectories';
let exports3;
let realloc1;
let realloc1Async;
let postReturn0;
let postReturn0Async;
let workerCancellationContract;

function cancellationContract() {
  _debugLog('[iface="pydantic:monty/worker", function="cancellation-contract"][Instruction::CallWasm] enter', {
    funcName: 'cancellation-contract',
    paramCount: 0,
    async: false,
    postReturn: false,
  });
  const hostProvided = false;
  
  const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
    componentIdx: 0,
    isAsync: false,
    isManualAsync: false,
    entryFnName: 'workerCancellationContract',
    getCallbackFn: () => null,
    callbackFnName: null,
    errHandling: 'none',
    callingWasmExport: true,
  });
  
  const started = task.enterSync();
  
  if (null!== null) {
    task.setReturnMemoryIdx(null);
    task.setReturnMemory(() => null());
  }
  
  
  let ret;
  
  try {
    ret =   _withGlobalCurrentTaskMeta({
      taskID: task.id(),
      componentIdx: task.componentIdx(),
      fn: () => workerCancellationContract(),
    });
  } catch (err) {
    
    _debugLog('[Instruction::CallWasm] error during sync call', {
      taskID: task.id(),
      err,
    });
    task.setErrored(err);
    task.reject(err);
    task.exit();
    throw err;
    
  }
  
  _debugLog('[iface="pydantic:monty/worker", function="cancellation-contract"][Instruction::Return]', {
    funcName: 'cancellation-contract',
    paramCount: 1,
    async: false,
    postReturn: false
  });
  task.resolve([ret >>> 0]);
  task.exit();
  return ret >>> 0;
}
let workerDispatch;

function dispatch(arg0) {
  var ptr0 = realloc1(0, 0, 8, 312);
  var variant318 = arg0;
  switch (variant318.tag) {
    case 'configure': {
      const e = variant318.val;
      dataView(memory0).setInt8(ptr0 + 0, 0, true);
      var {scriptName: v1_0, limits: v1_1, typeCheck: v1_2, typeCheckStubs: v1_3, assertMessageAnnotations: v1_4, typeCheckFormat: v1_5, typeCheckColor: v1_6, printFlushIntervalMs: v1_7, osPolicy: v1_8 } = e;
      
      var encodeRes = _utf8AllocateAndEncode(v1_0, realloc1, memory0);
      var ptr2= encodeRes.ptr;
      var len2 = encodeRes.len;
      
      dataView(memory0).setUint32(ptr0 + 12, len2, true);
      dataView(memory0).setUint32(ptr0 + 8, ptr2, true);
      var variant11 = v1_1;
      if (variant11 === null || variant11=== undefined) {
        dataView(memory0).setInt8(ptr0 + 16, 0, true);
      } else {
        const e = variant11;
        dataView(memory0).setInt8(ptr0 + 16, 1, true);
        var {maxFeedDurationMicros: v3_0, maxTurnDurationMicros: v3_1, maxMemoryBytes: v3_2, gcInterval: v3_3, maxRecursionDepth: v3_4, maxSuspensions: v3_5, maxTotalSleepMicros: v3_6 } = e;
        var variant4 = v3_0;
        if (variant4 === null || variant4=== undefined) {
          dataView(memory0).setInt8(ptr0 + 24, 0, true);
        } else {
          const e = variant4;
          dataView(memory0).setInt8(ptr0 + 24, 1, true);
          dataView(memory0).setBigInt64(ptr0 + 32, toUint64(e), true);
        }
        var variant5 = v3_1;
        if (variant5 === null || variant5=== undefined) {
          dataView(memory0).setInt8(ptr0 + 40, 0, true);
        } else {
          const e = variant5;
          dataView(memory0).setInt8(ptr0 + 40, 1, true);
          dataView(memory0).setBigInt64(ptr0 + 48, toUint64(e), true);
        }
        var variant6 = v3_2;
        if (variant6 === null || variant6=== undefined) {
          dataView(memory0).setInt8(ptr0 + 56, 0, true);
        } else {
          const e = variant6;
          dataView(memory0).setInt8(ptr0 + 56, 1, true);
          dataView(memory0).setBigInt64(ptr0 + 64, toUint64(e), true);
        }
        var variant7 = v3_3;
        if (variant7 === null || variant7=== undefined) {
          dataView(memory0).setInt8(ptr0 + 72, 0, true);
        } else {
          const e = variant7;
          dataView(memory0).setInt8(ptr0 + 72, 1, true);
          dataView(memory0).setBigInt64(ptr0 + 80, toUint64(e), true);
        }
        var variant8 = v3_4;
        if (variant8 === null || variant8=== undefined) {
          dataView(memory0).setInt8(ptr0 + 88, 0, true);
        } else {
          const e = variant8;
          dataView(memory0).setInt8(ptr0 + 88, 1, true);
          dataView(memory0).setBigInt64(ptr0 + 96, toUint64(e), true);
        }
        var variant9 = v3_5;
        if (variant9 === null || variant9=== undefined) {
          dataView(memory0).setInt8(ptr0 + 104, 0, true);
        } else {
          const e = variant9;
          dataView(memory0).setInt8(ptr0 + 104, 1, true);
          dataView(memory0).setBigInt64(ptr0 + 112, toUint64(e), true);
        }
        var variant10 = v3_6;
        if (variant10 === null || variant10=== undefined) {
          dataView(memory0).setInt8(ptr0 + 120, 0, true);
        } else {
          const e = variant10;
          dataView(memory0).setInt8(ptr0 + 120, 1, true);
          dataView(memory0).setBigInt64(ptr0 + 128, toUint64(e), true);
        }
      }
      dataView(memory0).setInt8(ptr0 + 136, v1_2 ? 1 : 0, true);
      var variant13 = v1_3;
      if (variant13 === null || variant13=== undefined) {
        dataView(memory0).setInt8(ptr0 + 140, 0, true);
      } else {
        const e = variant13;
        dataView(memory0).setInt8(ptr0 + 140, 1, true);
        
        var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
        var ptr12= encodeRes.ptr;
        var len12 = encodeRes.len;
        
        dataView(memory0).setUint32(ptr0 + 148, len12, true);
        dataView(memory0).setUint32(ptr0 + 144, ptr12, true);
      }
      var variant14 = v1_4;
      if (variant14 === null || variant14=== undefined) {
        dataView(memory0).setInt8(ptr0 + 152, 0, true);
      } else {
        const e = variant14;
        dataView(memory0).setInt8(ptr0 + 152, 1, true);
        dataView(memory0).setInt32(ptr0 + 156, toUint32(e), true);
      }
      var val15 = v1_5;
      let enum15;
      switch (val15) {
        case 'full': {
          enum15 = 0;
          break;
        }
        case 'concise': {
          enum15 = 1;
          break;
        }
        case 'azure': {
          enum15 = 2;
          break;
        }
        case 'json': {
          enum15 = 3;
          break;
        }
        case 'json-lines': {
          enum15 = 4;
          break;
        }
        case 'rdjson': {
          enum15 = 5;
          break;
        }
        case 'pylint': {
          enum15 = 6;
          break;
        }
        case 'gitlab': {
          enum15 = 7;
          break;
        }
        case 'github': {
          enum15 = 8;
          break;
        }
        default: {
          if ((v1_5) instanceof Error) {
            console.error(v1_5);
          }
          
          throw new TypeError(`"${val15}" is not one of the cases of type-check-format`);
        }
      }
      dataView(memory0).setInt8(ptr0 + 160, enum15, true);
      dataView(memory0).setInt8(ptr0 + 161, v1_6 ? 1 : 0, true);
      var variant16 = v1_7;
      if (variant16 === null || variant16=== undefined) {
        dataView(memory0).setInt8(ptr0 + 164, 0, true);
      } else {
        const e = variant16;
        dataView(memory0).setInt8(ptr0 + 164, 1, true);
        dataView(memory0).setInt32(ptr0 + 168, toUint32(e), true);
      }
      var variant38 = v1_8;
      if (variant38 === null || variant38=== undefined) {
        dataView(memory0).setInt8(ptr0 + 176, 0, true);
      } else {
        const e = variant38;
        dataView(memory0).setInt8(ptr0 + 176, 1, true);
        var {datetime: v17_0, timezone: v17_1, sleep: v17_2, randomStart: v17_3, processTime: v17_4 } = e;
        var variant20 = v17_0;
        if (variant20 === null || variant20=== undefined) {
          dataView(memory0).setInt8(ptr0 + 184, 0, true);
        } else {
          const e = variant20;
          dataView(memory0).setInt8(ptr0 + 184, 1, true);
          var variant19 = e;
          switch (variant19.tag) {
            case 'system': {
              dataView(memory0).setInt8(ptr0 + 192, 0, true);
              break;
            }
            case 'call-host': {
              dataView(memory0).setInt8(ptr0 + 192, 1, true);
              break;
            }
            case 'fixed': {
              const e = variant19.val;
              dataView(memory0).setInt8(ptr0 + 192, 2, true);
              var {unixSeconds: v18_0, microsecond: v18_1 } = e;
              dataView(memory0).setBigInt64(ptr0 + 200, toInt64(v18_0), true);
              dataView(memory0).setInt32(ptr0 + 208, toUint32(v18_1), true);
              break;
            }
            default: {
              throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant19.tag)}\` (received \`${variant19}\`) specified for \`DatetimeSource\``);
            }
          }
        }
        var variant26 = v17_1;
        if (variant26 === null || variant26=== undefined) {
          dataView(memory0).setInt8(ptr0 + 216, 0, true);
        } else {
          const e = variant26;
          dataView(memory0).setInt8(ptr0 + 216, 1, true);
          var variant25 = e;
          switch (variant25.tag) {
            case 'utc': {
              dataView(memory0).setInt8(ptr0 + 220, 0, true);
              break;
            }
            case 'named': {
              const e = variant25.val;
              dataView(memory0).setInt8(ptr0 + 220, 1, true);
              
              var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
              var ptr21= encodeRes.ptr;
              var len21 = encodeRes.len;
              
              dataView(memory0).setUint32(ptr0 + 228, len21, true);
              dataView(memory0).setUint32(ptr0 + 224, ptr21, true);
              break;
            }
            case 'fixed': {
              const e = variant25.val;
              dataView(memory0).setInt8(ptr0 + 220, 2, true);
              var {offsetSeconds: v22_0, name: v22_1 } = e;
              dataView(memory0).setInt32(ptr0 + 224, toInt32(v22_0), true);
              var variant24 = v22_1;
              if (variant24 === null || variant24=== undefined) {
                dataView(memory0).setInt8(ptr0 + 228, 0, true);
              } else {
                const e = variant24;
                dataView(memory0).setInt8(ptr0 + 228, 1, true);
                
                var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
                var ptr23= encodeRes.ptr;
                var len23 = encodeRes.len;
                
                dataView(memory0).setUint32(ptr0 + 236, len23, true);
                dataView(memory0).setUint32(ptr0 + 232, ptr23, true);
              }
              break;
            }
            default: {
              throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant25.tag)}\` (received \`${variant25}\`) specified for \`TimeZone\``);
            }
          }
        }
        var variant29 = v17_2;
        if (variant29 === null || variant29=== undefined) {
          dataView(memory0).setInt8(ptr0 + 240, 0, true);
        } else {
          const e = variant29;
          dataView(memory0).setInt8(ptr0 + 240, 1, true);
          var variant28 = e;
          switch (variant28.tag) {
            case 'system': {
              const e = variant28.val;
              dataView(memory0).setInt8(ptr0 + 248, 0, true);
              var variant27 = e;
              if (variant27 === null || variant27=== undefined) {
                dataView(memory0).setInt8(ptr0 + 256, 0, true);
              } else {
                const e = variant27;
                dataView(memory0).setInt8(ptr0 + 256, 1, true);
                dataView(memory0).setBigInt64(ptr0 + 264, toUint64(e), true);
              }
              break;
            }
            case 'call-host': {
              dataView(memory0).setInt8(ptr0 + 248, 1, true);
              break;
            }
            case 'zero': {
              dataView(memory0).setInt8(ptr0 + 248, 2, true);
              break;
            }
            default: {
              throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant28.tag)}\` (received \`${variant28}\`) specified for \`SleepMode\``);
            }
          }
        }
        var variant35 = v17_3;
        if (variant35 === null || variant35=== undefined) {
          dataView(memory0).setInt8(ptr0 + 272, 0, true);
        } else {
          const e = variant35;
          dataView(memory0).setInt8(ptr0 + 272, 1, true);
          var variant34 = e;
          switch (variant34.tag) {
            case 'system': {
              dataView(memory0).setInt8(ptr0 + 280, 0, true);
              break;
            }
            case 'call-host': {
              dataView(memory0).setInt8(ptr0 + 280, 1, true);
              break;
            }
            case 'seed': {
              const e = variant34.val;
              dataView(memory0).setInt8(ptr0 + 280, 2, true);
              var variant33 = e;
              switch (variant33.tag) {
                case 'int': {
                  const e = variant33.val;
                  dataView(memory0).setInt8(ptr0 + 288, 0, true);
                  var val30 = e;
                  var len30 = Array.isArray(val30) ? val30.length : val30.byteLength;
                  var ptr30 = realloc1(0, 0, 1, len30 * 1);
                  
                  let valData30;
                  const valLenBytes30 = len30 * 1;
                  if (Array.isArray(val30)) {
                    // Regular array likely containing numbers, write values to memory
                    let offset = 0;
                    const dv30 = new DataView(memory0.buffer);
                    for (const v of val30) {
                      _requireValidNumericPrimitive.bind(null, 'u8')(v);
                      dv30.setUint8(ptr30+ offset, v, true);
                      offset += 1;
                    }
                  } else {
                    // TypedArray / ArrayBuffer-like, direct copy
                    valData30 = new Uint8Array(val30.buffer || val30, val30.byteOffset, valLenBytes30);
                    const out30 = new Uint8Array(memory0.buffer, ptr30, valLenBytes30);
                    out30.set(valData30);
                  }
                  
                  dataView(memory0).setUint32(ptr0 + 300, len30, true);
                  dataView(memory0).setUint32(ptr0 + 296, ptr30, true);
                  break;
                }
                case 'float': {
                  const e = variant33.val;
                  dataView(memory0).setInt8(ptr0 + 288, 1, true);
                  dataView(memory0).setFloat64(ptr0 + 296, +e, true);
                  break;
                }
                case 'str': {
                  const e = variant33.val;
                  dataView(memory0).setInt8(ptr0 + 288, 2, true);
                  
                  var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
                  var ptr31= encodeRes.ptr;
                  var len31 = encodeRes.len;
                  
                  dataView(memory0).setUint32(ptr0 + 300, len31, true);
                  dataView(memory0).setUint32(ptr0 + 296, ptr31, true);
                  break;
                }
                case 'bytes': {
                  const e = variant33.val;
                  dataView(memory0).setInt8(ptr0 + 288, 3, true);
                  var val32 = e;
                  var len32 = Array.isArray(val32) ? val32.length : val32.byteLength;
                  var ptr32 = realloc1(0, 0, 1, len32 * 1);
                  
                  let valData32;
                  const valLenBytes32 = len32 * 1;
                  if (Array.isArray(val32)) {
                    // Regular array likely containing numbers, write values to memory
                    let offset = 0;
                    const dv32 = new DataView(memory0.buffer);
                    for (const v of val32) {
                      _requireValidNumericPrimitive.bind(null, 'u8')(v);
                      dv32.setUint8(ptr32+ offset, v, true);
                      offset += 1;
                    }
                  } else {
                    // TypedArray / ArrayBuffer-like, direct copy
                    valData32 = new Uint8Array(val32.buffer || val32, val32.byteOffset, valLenBytes32);
                    const out32 = new Uint8Array(memory0.buffer, ptr32, valLenBytes32);
                    out32.set(valData32);
                  }
                  
                  dataView(memory0).setUint32(ptr0 + 300, len32, true);
                  dataView(memory0).setUint32(ptr0 + 296, ptr32, true);
                  break;
                }
                default: {
                  throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant33.tag)}\` (received \`${variant33}\`) specified for \`RandomSeed\``);
                }
              }
              break;
            }
            default: {
              throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant34.tag)}\` (received \`${variant34}\`) specified for \`RandomStart\``);
            }
          }
        }
        var variant37 = v17_4;
        if (variant37 === null || variant37=== undefined) {
          dataView(memory0).setInt8(ptr0 + 304, 0, true);
        } else {
          const e = variant37;
          dataView(memory0).setInt8(ptr0 + 304, 1, true);
          var variant36 = e;
          switch (variant36.tag) {
            case 'zero': {
              dataView(memory0).setInt8(ptr0 + 305, 0, true);
              break;
            }
            case 'elapsed': {
              dataView(memory0).setInt8(ptr0 + 305, 1, true);
              break;
            }
            default: {
              throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant36.tag)}\` (received \`${variant36}\`) specified for \`ProcessTime\``);
            }
          }
        }
      }
      break;
    }
    case 'feed': {
      const e = variant318.val;
      dataView(memory0).setInt8(ptr0 + 0, 1, true);
      var {code: v39_0, inputs: v39_1, values: v39_2, skipTypeCheck: v39_3, cwd: v39_4 } = e;
      
      var encodeRes = _utf8AllocateAndEncode(v39_0, realloc1, memory0);
      var ptr40= encodeRes.ptr;
      var len40 = encodeRes.len;
      
      dataView(memory0).setUint32(ptr0 + 12, len40, true);
      dataView(memory0).setUint32(ptr0 + 8, ptr40, true);
      var vec43 = v39_1;
      var len43 = vec43.length;
      var result43 = realloc1(0, 0, 4, len43 * 12);
      for (let i = 0; i < vec43.length; i++) {
        const e = vec43[i];
        const base = result43 + i * 12;var {name: v41_0, value: v41_1 } = e;
        
        var encodeRes = _utf8AllocateAndEncode(v41_0, realloc1, memory0);
        var ptr42= encodeRes.ptr;
        var len42 = encodeRes.len;
        
        dataView(memory0).setUint32(base + 4, len42, true);
        dataView(memory0).setUint32(base + 0, ptr42, true);
        dataView(memory0).setInt32(base + 8, toUint32(v41_1), true);
      }
      dataView(memory0).setUint32(ptr0 + 20, len43, true);
      dataView(memory0).setUint32(ptr0 + 16, result43, true);
      var {nodes: v44_0 } = v39_2;
      var vec105 = v44_0;
      var len105 = vec105.length;
      var result105 = realloc1(0, 0, 8, len105 * 48);
      for (let i = 0; i < vec105.length; i++) {
        const e = vec105[i];
        const base = result105 + i * 48;var variant104 = e;
        switch (variant104.tag) {
          case 'ellipsis': {
            dataView(memory0).setInt8(base + 0, 0, true);
            break;
          }
          case 'not-implemented': {
            dataView(memory0).setInt8(base + 0, 1, true);
            break;
          }
          case 'none': {
            dataView(memory0).setInt8(base + 0, 2, true);
            break;
          }
          case 'boolean': {
            const e = variant104.val;
            dataView(memory0).setInt8(base + 0, 3, true);
            dataView(memory0).setInt8(base + 8, e ? 1 : 0, true);
            break;
          }
          case 'integer': {
            const e = variant104.val;
            dataView(memory0).setInt8(base + 0, 4, true);
            dataView(memory0).setBigInt64(base + 8, toInt64(e), true);
            break;
          }
          case 'bigint': {
            const e = variant104.val;
            dataView(memory0).setInt8(base + 0, 5, true);
            
            var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
            var ptr45= encodeRes.ptr;
            var len45 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len45, true);
            dataView(memory0).setUint32(base + 8, ptr45, true);
            break;
          }
          case 'float': {
            const e = variant104.val;
            dataView(memory0).setInt8(base + 0, 6, true);
            dataView(memory0).setFloat64(base + 8, +e, true);
            break;
          }
          case 'complex': {
            const e = variant104.val;
            dataView(memory0).setInt8(base + 0, 7, true);
            var {real: v46_0, imag: v46_1 } = e;
            dataView(memory0).setFloat64(base + 8, +v46_0, true);
            dataView(memory0).setFloat64(base + 16, +v46_1, true);
            break;
          }
          case 'text': {
            const e = variant104.val;
            dataView(memory0).setInt8(base + 0, 8, true);
            
            var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
            var ptr47= encodeRes.ptr;
            var len47 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len47, true);
            dataView(memory0).setUint32(base + 8, ptr47, true);
            break;
          }
          case 'bytes': {
            const e = variant104.val;
            dataView(memory0).setInt8(base + 0, 9, true);
            var val48 = e;
            var len48 = Array.isArray(val48) ? val48.length : val48.byteLength;
            var ptr48 = realloc1(0, 0, 1, len48 * 1);
            
            let valData48;
            const valLenBytes48 = len48 * 1;
            if (Array.isArray(val48)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv48 = new DataView(memory0.buffer);
              for (const v of val48) {
                _requireValidNumericPrimitive.bind(null, 'u8')(v);
                dv48.setUint8(ptr48+ offset, v, true);
                offset += 1;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData48 = new Uint8Array(val48.buffer || val48, val48.byteOffset, valLenBytes48);
              const out48 = new Uint8Array(memory0.buffer, ptr48, valLenBytes48);
              out48.set(valData48);
            }
            
            dataView(memory0).setUint32(base + 12, len48, true);
            dataView(memory0).setUint32(base + 8, ptr48, true);
            break;
          }
          case 'list-value': {
            const e = variant104.val;
            dataView(memory0).setInt8(base + 0, 10, true);
            var val49 = e;
            var len49 = val49.length;
            var ptr49 = realloc1(0, 0, 4, len49 * 4);
            
            let valData49;
            const valLenBytes49 = len49 * 4;
            if (Array.isArray(val49)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv49 = new DataView(memory0.buffer);
              for (const v of val49) {
                _requireValidNumericPrimitive.bind(null, 'u32')(v);
                dv49.setUint32(ptr49+ offset, v, true);
                offset += 4;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData49 = new Uint8Array(val49.buffer || val49, val49.byteOffset, valLenBytes49);
              const out49 = new Uint8Array(memory0.buffer, ptr49, valLenBytes49);
              out49.set(valData49);
            }
            
            dataView(memory0).setUint32(base + 12, len49, true);
            dataView(memory0).setUint32(base + 8, ptr49, true);
            break;
          }
          case 'tuple-value': {
            const e = variant104.val;
            dataView(memory0).setInt8(base + 0, 11, true);
            var val50 = e;
            var len50 = val50.length;
            var ptr50 = realloc1(0, 0, 4, len50 * 4);
            
            let valData50;
            const valLenBytes50 = len50 * 4;
            if (Array.isArray(val50)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv50 = new DataView(memory0.buffer);
              for (const v of val50) {
                _requireValidNumericPrimitive.bind(null, 'u32')(v);
                dv50.setUint32(ptr50+ offset, v, true);
                offset += 4;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData50 = new Uint8Array(val50.buffer || val50, val50.byteOffset, valLenBytes50);
              const out50 = new Uint8Array(memory0.buffer, ptr50, valLenBytes50);
              out50.set(valData50);
            }
            
            dataView(memory0).setUint32(base + 12, len50, true);
            dataView(memory0).setUint32(base + 8, ptr50, true);
            break;
          }
          case 'named-tuple': {
            const e = variant104.val;
            dataView(memory0).setInt8(base + 0, 12, true);
            var {typeName: v51_0, fieldNames: v51_1, items: v51_2 } = e;
            
            var encodeRes = _utf8AllocateAndEncode(v51_0, realloc1, memory0);
            var ptr52= encodeRes.ptr;
            var len52 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len52, true);
            dataView(memory0).setUint32(base + 8, ptr52, true);
            var vec54 = v51_1;
            var len54 = vec54.length;
            var result54 = realloc1(0, 0, 4, len54 * 8);
            for (let i = 0; i < vec54.length; i++) {
              const e = vec54[i];
              const base = result54 + i * 8;
              var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
              var ptr53= encodeRes.ptr;
              var len53 = encodeRes.len;
              
              dataView(memory0).setUint32(base + 4, len53, true);
              dataView(memory0).setUint32(base + 0, ptr53, true);
            }
            dataView(memory0).setUint32(base + 20, len54, true);
            dataView(memory0).setUint32(base + 16, result54, true);
            var val55 = v51_2;
            var len55 = val55.length;
            var ptr55 = realloc1(0, 0, 4, len55 * 4);
            
            let valData55;
            const valLenBytes55 = len55 * 4;
            if (Array.isArray(val55)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv55 = new DataView(memory0.buffer);
              for (const v of val55) {
                _requireValidNumericPrimitive.bind(null, 'u32')(v);
                dv55.setUint32(ptr55+ offset, v, true);
                offset += 4;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData55 = new Uint8Array(val55.buffer || val55, val55.byteOffset, valLenBytes55);
              const out55 = new Uint8Array(memory0.buffer, ptr55, valLenBytes55);
              out55.set(valData55);
            }
            
            dataView(memory0).setUint32(base + 28, len55, true);
            dataView(memory0).setUint32(base + 24, ptr55, true);
            break;
          }
          case 'dict': {
            const e = variant104.val;
            dataView(memory0).setInt8(base + 0, 13, true);
            var vec57 = e;
            var len57 = vec57.length;
            var result57 = realloc1(0, 0, 4, len57 * 8);
            for (let i = 0; i < vec57.length; i++) {
              const e = vec57[i];
              const base = result57 + i * 8;var {key: v56_0, value: v56_1 } = e;
              dataView(memory0).setInt32(base + 0, toUint32(v56_0), true);
              dataView(memory0).setInt32(base + 4, toUint32(v56_1), true);
            }
            dataView(memory0).setUint32(base + 12, len57, true);
            dataView(memory0).setUint32(base + 8, result57, true);
            break;
          }
          case 'set': {
            const e = variant104.val;
            dataView(memory0).setInt8(base + 0, 14, true);
            var val58 = e;
            var len58 = val58.length;
            var ptr58 = realloc1(0, 0, 4, len58 * 4);
            
            let valData58;
            const valLenBytes58 = len58 * 4;
            if (Array.isArray(val58)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv58 = new DataView(memory0.buffer);
              for (const v of val58) {
                _requireValidNumericPrimitive.bind(null, 'u32')(v);
                dv58.setUint32(ptr58+ offset, v, true);
                offset += 4;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData58 = new Uint8Array(val58.buffer || val58, val58.byteOffset, valLenBytes58);
              const out58 = new Uint8Array(memory0.buffer, ptr58, valLenBytes58);
              out58.set(valData58);
            }
            
            dataView(memory0).setUint32(base + 12, len58, true);
            dataView(memory0).setUint32(base + 8, ptr58, true);
            break;
          }
          case 'frozen-set': {
            const e = variant104.val;
            dataView(memory0).setInt8(base + 0, 15, true);
            var val59 = e;
            var len59 = val59.length;
            var ptr59 = realloc1(0, 0, 4, len59 * 4);
            
            let valData59;
            const valLenBytes59 = len59 * 4;
            if (Array.isArray(val59)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv59 = new DataView(memory0.buffer);
              for (const v of val59) {
                _requireValidNumericPrimitive.bind(null, 'u32')(v);
                dv59.setUint32(ptr59+ offset, v, true);
                offset += 4;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData59 = new Uint8Array(val59.buffer || val59, val59.byteOffset, valLenBytes59);
              const out59 = new Uint8Array(memory0.buffer, ptr59, valLenBytes59);
              out59.set(valData59);
            }
            
            dataView(memory0).setUint32(base + 12, len59, true);
            dataView(memory0).setUint32(base + 8, ptr59, true);
            break;
          }
          case 'date': {
            const e = variant104.val;
            dataView(memory0).setInt8(base + 0, 16, true);
            var {year: v60_0, month: v60_1, day: v60_2 } = e;
            dataView(memory0).setInt32(base + 8, toInt32(v60_0), true);
            dataView(memory0).setInt8(base + 12, toUint8(v60_1), true);
            dataView(memory0).setInt8(base + 13, toUint8(v60_2), true);
            break;
          }
          case 'datetime': {
            const e = variant104.val;
            dataView(memory0).setInt8(base + 0, 17, true);
            var {year: v61_0, month: v61_1, day: v61_2, hour: v61_3, minute: v61_4, second: v61_5, microsecond: v61_6, offsetSeconds: v61_7, timezoneName: v61_8 } = e;
            dataView(memory0).setInt32(base + 8, toInt32(v61_0), true);
            dataView(memory0).setInt8(base + 12, toUint8(v61_1), true);
            dataView(memory0).setInt8(base + 13, toUint8(v61_2), true);
            dataView(memory0).setInt8(base + 14, toUint8(v61_3), true);
            dataView(memory0).setInt8(base + 15, toUint8(v61_4), true);
            dataView(memory0).setInt8(base + 16, toUint8(v61_5), true);
            dataView(memory0).setInt32(base + 20, toUint32(v61_6), true);
            var variant62 = v61_7;
            if (variant62 === null || variant62=== undefined) {
              dataView(memory0).setInt8(base + 24, 0, true);
            } else {
              const e = variant62;
              dataView(memory0).setInt8(base + 24, 1, true);
              dataView(memory0).setInt32(base + 28, toInt32(e), true);
            }
            var variant64 = v61_8;
            if (variant64 === null || variant64=== undefined) {
              dataView(memory0).setInt8(base + 32, 0, true);
            } else {
              const e = variant64;
              dataView(memory0).setInt8(base + 32, 1, true);
              
              var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
              var ptr63= encodeRes.ptr;
              var len63 = encodeRes.len;
              
              dataView(memory0).setUint32(base + 40, len63, true);
              dataView(memory0).setUint32(base + 36, ptr63, true);
            }
            break;
          }
          case 'time': {
            const e = variant104.val;
            dataView(memory0).setInt8(base + 0, 18, true);
            var {hour: v65_0, minute: v65_1, second: v65_2, microsecond: v65_3, offsetSeconds: v65_4, timezoneName: v65_5, fold: v65_6 } = e;
            dataView(memory0).setInt8(base + 8, toUint8(v65_0), true);
            dataView(memory0).setInt8(base + 9, toUint8(v65_1), true);
            dataView(memory0).setInt8(base + 10, toUint8(v65_2), true);
            dataView(memory0).setInt32(base + 12, toUint32(v65_3), true);
            var variant66 = v65_4;
            if (variant66 === null || variant66=== undefined) {
              dataView(memory0).setInt8(base + 16, 0, true);
            } else {
              const e = variant66;
              dataView(memory0).setInt8(base + 16, 1, true);
              dataView(memory0).setInt32(base + 20, toInt32(e), true);
            }
            var variant68 = v65_5;
            if (variant68 === null || variant68=== undefined) {
              dataView(memory0).setInt8(base + 24, 0, true);
            } else {
              const e = variant68;
              dataView(memory0).setInt8(base + 24, 1, true);
              
              var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
              var ptr67= encodeRes.ptr;
              var len67 = encodeRes.len;
              
              dataView(memory0).setUint32(base + 32, len67, true);
              dataView(memory0).setUint32(base + 28, ptr67, true);
            }
            dataView(memory0).setInt8(base + 36, toUint8(v65_6), true);
            break;
          }
          case 'timedelta': {
            const e = variant104.val;
            dataView(memory0).setInt8(base + 0, 19, true);
            var {days: v69_0, seconds: v69_1, microseconds: v69_2 } = e;
            dataView(memory0).setInt32(base + 8, toInt32(v69_0), true);
            dataView(memory0).setInt32(base + 12, toInt32(v69_1), true);
            dataView(memory0).setInt32(base + 16, toInt32(v69_2), true);
            break;
          }
          case 'timezone': {
            const e = variant104.val;
            dataView(memory0).setInt8(base + 0, 20, true);
            var {offsetSeconds: v70_0, name: v70_1 } = e;
            dataView(memory0).setInt32(base + 8, toInt32(v70_0), true);
            var variant72 = v70_1;
            if (variant72 === null || variant72=== undefined) {
              dataView(memory0).setInt8(base + 12, 0, true);
            } else {
              const e = variant72;
              dataView(memory0).setInt8(base + 12, 1, true);
              
              var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
              var ptr71= encodeRes.ptr;
              var len71 = encodeRes.len;
              
              dataView(memory0).setUint32(base + 20, len71, true);
              dataView(memory0).setUint32(base + 16, ptr71, true);
            }
            break;
          }
          case 'exception': {
            const e = variant104.val;
            dataView(memory0).setInt8(base + 0, 21, true);
            var {excType: v73_0, message: v73_1 } = e;
            
            var encodeRes = _utf8AllocateAndEncode(v73_0, realloc1, memory0);
            var ptr74= encodeRes.ptr;
            var len74 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len74, true);
            dataView(memory0).setUint32(base + 8, ptr74, true);
            var variant76 = v73_1;
            if (variant76 === null || variant76=== undefined) {
              dataView(memory0).setInt8(base + 16, 0, true);
            } else {
              const e = variant76;
              dataView(memory0).setInt8(base + 16, 1, true);
              
              var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
              var ptr75= encodeRes.ptr;
              var len75 = encodeRes.len;
              
              dataView(memory0).setUint32(base + 24, len75, true);
              dataView(memory0).setUint32(base + 20, ptr75, true);
            }
            break;
          }
          case 'type-name': {
            const e = variant104.val;
            dataView(memory0).setInt8(base + 0, 22, true);
            
            var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
            var ptr77= encodeRes.ptr;
            var len77 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len77, true);
            dataView(memory0).setUint32(base + 8, ptr77, true);
            break;
          }
          case 'class-type': {
            const e = variant104.val;
            dataView(memory0).setInt8(base + 0, 23, true);
            var {name: v78_0, id: v78_1, hostDefined: v78_2, isDataclass: v78_3, attrs: v78_4 } = e;
            
            var encodeRes = _utf8AllocateAndEncode(v78_0, realloc1, memory0);
            var ptr79= encodeRes.ptr;
            var len79 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len79, true);
            dataView(memory0).setUint32(base + 8, ptr79, true);
            
            var encodeRes = _utf8AllocateAndEncode(v78_1, realloc1, memory0);
            var ptr80= encodeRes.ptr;
            var len80 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 20, len80, true);
            dataView(memory0).setUint32(base + 16, ptr80, true);
            dataView(memory0).setInt8(base + 24, v78_2 ? 1 : 0, true);
            dataView(memory0).setInt8(base + 25, v78_3 ? 1 : 0, true);
            var vec82 = v78_4;
            var len82 = vec82.length;
            var result82 = realloc1(0, 0, 4, len82 * 8);
            for (let i = 0; i < vec82.length; i++) {
              const e = vec82[i];
              const base = result82 + i * 8;var {key: v81_0, value: v81_1 } = e;
              dataView(memory0).setInt32(base + 0, toUint32(v81_0), true);
              dataView(memory0).setInt32(base + 4, toUint32(v81_1), true);
            }
            dataView(memory0).setUint32(base + 32, len82, true);
            dataView(memory0).setUint32(base + 28, result82, true);
            break;
          }
          case 'builtin-function': {
            const e = variant104.val;
            dataView(memory0).setInt8(base + 0, 24, true);
            
            var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
            var ptr83= encodeRes.ptr;
            var len83 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len83, true);
            dataView(memory0).setUint32(base + 8, ptr83, true);
            break;
          }
          case 'path': {
            const e = variant104.val;
            dataView(memory0).setInt8(base + 0, 25, true);
            
            var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
            var ptr84= encodeRes.ptr;
            var len84 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len84, true);
            dataView(memory0).setUint32(base + 8, ptr84, true);
            break;
          }
          case 'file-handle': {
            const e = variant104.val;
            dataView(memory0).setInt8(base + 0, 26, true);
            var {path: v85_0, mode: v85_1, position: v85_2 } = e;
            
            var encodeRes = _utf8AllocateAndEncode(v85_0, realloc1, memory0);
            var ptr86= encodeRes.ptr;
            var len86 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len86, true);
            dataView(memory0).setUint32(base + 8, ptr86, true);
            
            var encodeRes = _utf8AllocateAndEncode(v85_1, realloc1, memory0);
            var ptr87= encodeRes.ptr;
            var len87 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 20, len87, true);
            dataView(memory0).setUint32(base + 16, ptr87, true);
            dataView(memory0).setBigInt64(base + 24, toUint64(v85_2), true);
            break;
          }
          case 'class-instance': {
            const e = variant104.val;
            dataView(memory0).setInt8(base + 0, 27, true);
            var {classType: v88_0, instanceId: v88_1, attrs: v88_2 } = e;
            dataView(memory0).setInt32(base + 8, toUint32(v88_0), true);
            
            var encodeRes = _utf8AllocateAndEncode(v88_1, realloc1, memory0);
            var ptr89= encodeRes.ptr;
            var len89 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 16, len89, true);
            dataView(memory0).setUint32(base + 12, ptr89, true);
            var vec91 = v88_2;
            var len91 = vec91.length;
            var result91 = realloc1(0, 0, 4, len91 * 8);
            for (let i = 0; i < vec91.length; i++) {
              const e = vec91[i];
              const base = result91 + i * 8;var {key: v90_0, value: v90_1 } = e;
              dataView(memory0).setInt32(base + 0, toUint32(v90_0), true);
              dataView(memory0).setInt32(base + 4, toUint32(v90_1), true);
            }
            dataView(memory0).setUint32(base + 24, len91, true);
            dataView(memory0).setUint32(base + 20, result91, true);
            break;
          }
          case 'function': {
            const e = variant104.val;
            dataView(memory0).setInt8(base + 0, 28, true);
            var {name: v92_0, docstring: v92_1 } = e;
            
            var encodeRes = _utf8AllocateAndEncode(v92_0, realloc1, memory0);
            var ptr93= encodeRes.ptr;
            var len93 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len93, true);
            dataView(memory0).setUint32(base + 8, ptr93, true);
            var variant95 = v92_1;
            if (variant95 === null || variant95=== undefined) {
              dataView(memory0).setInt8(base + 16, 0, true);
            } else {
              const e = variant95;
              dataView(memory0).setInt8(base + 16, 1, true);
              
              var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
              var ptr94= encodeRes.ptr;
              var len94 = encodeRes.len;
              
              dataView(memory0).setUint32(base + 24, len94, true);
              dataView(memory0).setUint32(base + 20, ptr94, true);
            }
            break;
          }
          case 'repr': {
            const e = variant104.val;
            dataView(memory0).setInt8(base + 0, 29, true);
            
            var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
            var ptr96= encodeRes.ptr;
            var len96 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len96, true);
            dataView(memory0).setUint32(base + 8, ptr96, true);
            break;
          }
          case 'cycle': {
            const e = variant104.val;
            dataView(memory0).setInt8(base + 0, 30, true);
            
            var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
            var ptr97= encodeRes.ptr;
            var len97 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len97, true);
            dataView(memory0).setUint32(base + 8, ptr97, true);
            break;
          }
          case 'module': {
            const e = variant104.val;
            dataView(memory0).setInt8(base + 0, 31, true);
            var {name: v98_0, id: v98_1, attrs: v98_2 } = e;
            
            var encodeRes = _utf8AllocateAndEncode(v98_0, realloc1, memory0);
            var ptr99= encodeRes.ptr;
            var len99 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len99, true);
            dataView(memory0).setUint32(base + 8, ptr99, true);
            
            var encodeRes = _utf8AllocateAndEncode(v98_1, realloc1, memory0);
            var ptr100= encodeRes.ptr;
            var len100 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 20, len100, true);
            dataView(memory0).setUint32(base + 16, ptr100, true);
            var vec102 = v98_2;
            var len102 = vec102.length;
            var result102 = realloc1(0, 0, 4, len102 * 8);
            for (let i = 0; i < vec102.length; i++) {
              const e = vec102[i];
              const base = result102 + i * 8;var {key: v101_0, value: v101_1 } = e;
              dataView(memory0).setInt32(base + 0, toUint32(v101_0), true);
              dataView(memory0).setInt32(base + 4, toUint32(v101_1), true);
            }
            dataView(memory0).setUint32(base + 28, len102, true);
            dataView(memory0).setUint32(base + 24, result102, true);
            break;
          }
          case 'decimal': {
            const e = variant104.val;
            dataView(memory0).setInt8(base + 0, 32, true);
            
            var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
            var ptr103= encodeRes.ptr;
            var len103 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len103, true);
            dataView(memory0).setUint32(base + 8, ptr103, true);
            break;
          }
          default: {
            throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant104.tag)}\` (received \`${variant104}\`) specified for \`ValueNode\``);
          }
        }
      }
      dataView(memory0).setUint32(ptr0 + 28, len105, true);
      dataView(memory0).setUint32(ptr0 + 24, result105, true);
      dataView(memory0).setInt8(ptr0 + 32, v39_3 ? 1 : 0, true);
      
      var encodeRes = _utf8AllocateAndEncode(v39_4, realloc1, memory0);
      var ptr106= encodeRes.ptr;
      var len106 = encodeRes.len;
      
      dataView(memory0).setUint32(ptr0 + 40, len106, true);
      dataView(memory0).setUint32(ptr0 + 36, ptr106, true);
      break;
    }
    case 'resume-call': {
      const e = variant318.val;
      dataView(memory0).setInt8(ptr0 + 0, 2, true);
      var {callId: v107_0, outcome: v107_1, values: v107_2 } = e;
      dataView(memory0).setInt32(ptr0 + 8, toUint32(v107_0), true);
      var variant112 = v107_1;
      switch (variant112.tag) {
        case 'return-value': {
          const e = variant112.val;
          dataView(memory0).setInt8(ptr0 + 12, 0, true);
          dataView(memory0).setInt32(ptr0 + 16, toUint32(e), true);
          break;
        }
        case 'error': {
          const e = variant112.val;
          dataView(memory0).setInt8(ptr0 + 12, 1, true);
          var {excType: v108_0, message: v108_1 } = e;
          
          var encodeRes = _utf8AllocateAndEncode(v108_0, realloc1, memory0);
          var ptr109= encodeRes.ptr;
          var len109 = encodeRes.len;
          
          dataView(memory0).setUint32(ptr0 + 20, len109, true);
          dataView(memory0).setUint32(ptr0 + 16, ptr109, true);
          
          var encodeRes = _utf8AllocateAndEncode(v108_1, realloc1, memory0);
          var ptr110= encodeRes.ptr;
          var len110 = encodeRes.len;
          
          dataView(memory0).setUint32(ptr0 + 28, len110, true);
          dataView(memory0).setUint32(ptr0 + 24, ptr110, true);
          break;
        }
        case 'pending-future': {
          const e = variant112.val;
          dataView(memory0).setInt8(ptr0 + 12, 2, true);
          dataView(memory0).setInt32(ptr0 + 16, toUint32(e), true);
          break;
        }
        case 'not-found': {
          const e = variant112.val;
          dataView(memory0).setInt8(ptr0 + 12, 3, true);
          
          var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
          var ptr111= encodeRes.ptr;
          var len111 = encodeRes.len;
          
          dataView(memory0).setUint32(ptr0 + 20, len111, true);
          dataView(memory0).setUint32(ptr0 + 16, ptr111, true);
          break;
        }
        case 'not-handled': {
          dataView(memory0).setInt8(ptr0 + 12, 4, true);
          break;
        }
        default: {
          throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant112.tag)}\` (received \`${variant112}\`) specified for \`CallResult\``);
        }
      }
      var {nodes: v113_0 } = v107_2;
      var vec174 = v113_0;
      var len174 = vec174.length;
      var result174 = realloc1(0, 0, 8, len174 * 48);
      for (let i = 0; i < vec174.length; i++) {
        const e = vec174[i];
        const base = result174 + i * 48;var variant173 = e;
        switch (variant173.tag) {
          case 'ellipsis': {
            dataView(memory0).setInt8(base + 0, 0, true);
            break;
          }
          case 'not-implemented': {
            dataView(memory0).setInt8(base + 0, 1, true);
            break;
          }
          case 'none': {
            dataView(memory0).setInt8(base + 0, 2, true);
            break;
          }
          case 'boolean': {
            const e = variant173.val;
            dataView(memory0).setInt8(base + 0, 3, true);
            dataView(memory0).setInt8(base + 8, e ? 1 : 0, true);
            break;
          }
          case 'integer': {
            const e = variant173.val;
            dataView(memory0).setInt8(base + 0, 4, true);
            dataView(memory0).setBigInt64(base + 8, toInt64(e), true);
            break;
          }
          case 'bigint': {
            const e = variant173.val;
            dataView(memory0).setInt8(base + 0, 5, true);
            
            var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
            var ptr114= encodeRes.ptr;
            var len114 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len114, true);
            dataView(memory0).setUint32(base + 8, ptr114, true);
            break;
          }
          case 'float': {
            const e = variant173.val;
            dataView(memory0).setInt8(base + 0, 6, true);
            dataView(memory0).setFloat64(base + 8, +e, true);
            break;
          }
          case 'complex': {
            const e = variant173.val;
            dataView(memory0).setInt8(base + 0, 7, true);
            var {real: v115_0, imag: v115_1 } = e;
            dataView(memory0).setFloat64(base + 8, +v115_0, true);
            dataView(memory0).setFloat64(base + 16, +v115_1, true);
            break;
          }
          case 'text': {
            const e = variant173.val;
            dataView(memory0).setInt8(base + 0, 8, true);
            
            var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
            var ptr116= encodeRes.ptr;
            var len116 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len116, true);
            dataView(memory0).setUint32(base + 8, ptr116, true);
            break;
          }
          case 'bytes': {
            const e = variant173.val;
            dataView(memory0).setInt8(base + 0, 9, true);
            var val117 = e;
            var len117 = Array.isArray(val117) ? val117.length : val117.byteLength;
            var ptr117 = realloc1(0, 0, 1, len117 * 1);
            
            let valData117;
            const valLenBytes117 = len117 * 1;
            if (Array.isArray(val117)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv117 = new DataView(memory0.buffer);
              for (const v of val117) {
                _requireValidNumericPrimitive.bind(null, 'u8')(v);
                dv117.setUint8(ptr117+ offset, v, true);
                offset += 1;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData117 = new Uint8Array(val117.buffer || val117, val117.byteOffset, valLenBytes117);
              const out117 = new Uint8Array(memory0.buffer, ptr117, valLenBytes117);
              out117.set(valData117);
            }
            
            dataView(memory0).setUint32(base + 12, len117, true);
            dataView(memory0).setUint32(base + 8, ptr117, true);
            break;
          }
          case 'list-value': {
            const e = variant173.val;
            dataView(memory0).setInt8(base + 0, 10, true);
            var val118 = e;
            var len118 = val118.length;
            var ptr118 = realloc1(0, 0, 4, len118 * 4);
            
            let valData118;
            const valLenBytes118 = len118 * 4;
            if (Array.isArray(val118)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv118 = new DataView(memory0.buffer);
              for (const v of val118) {
                _requireValidNumericPrimitive.bind(null, 'u32')(v);
                dv118.setUint32(ptr118+ offset, v, true);
                offset += 4;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData118 = new Uint8Array(val118.buffer || val118, val118.byteOffset, valLenBytes118);
              const out118 = new Uint8Array(memory0.buffer, ptr118, valLenBytes118);
              out118.set(valData118);
            }
            
            dataView(memory0).setUint32(base + 12, len118, true);
            dataView(memory0).setUint32(base + 8, ptr118, true);
            break;
          }
          case 'tuple-value': {
            const e = variant173.val;
            dataView(memory0).setInt8(base + 0, 11, true);
            var val119 = e;
            var len119 = val119.length;
            var ptr119 = realloc1(0, 0, 4, len119 * 4);
            
            let valData119;
            const valLenBytes119 = len119 * 4;
            if (Array.isArray(val119)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv119 = new DataView(memory0.buffer);
              for (const v of val119) {
                _requireValidNumericPrimitive.bind(null, 'u32')(v);
                dv119.setUint32(ptr119+ offset, v, true);
                offset += 4;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData119 = new Uint8Array(val119.buffer || val119, val119.byteOffset, valLenBytes119);
              const out119 = new Uint8Array(memory0.buffer, ptr119, valLenBytes119);
              out119.set(valData119);
            }
            
            dataView(memory0).setUint32(base + 12, len119, true);
            dataView(memory0).setUint32(base + 8, ptr119, true);
            break;
          }
          case 'named-tuple': {
            const e = variant173.val;
            dataView(memory0).setInt8(base + 0, 12, true);
            var {typeName: v120_0, fieldNames: v120_1, items: v120_2 } = e;
            
            var encodeRes = _utf8AllocateAndEncode(v120_0, realloc1, memory0);
            var ptr121= encodeRes.ptr;
            var len121 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len121, true);
            dataView(memory0).setUint32(base + 8, ptr121, true);
            var vec123 = v120_1;
            var len123 = vec123.length;
            var result123 = realloc1(0, 0, 4, len123 * 8);
            for (let i = 0; i < vec123.length; i++) {
              const e = vec123[i];
              const base = result123 + i * 8;
              var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
              var ptr122= encodeRes.ptr;
              var len122 = encodeRes.len;
              
              dataView(memory0).setUint32(base + 4, len122, true);
              dataView(memory0).setUint32(base + 0, ptr122, true);
            }
            dataView(memory0).setUint32(base + 20, len123, true);
            dataView(memory0).setUint32(base + 16, result123, true);
            var val124 = v120_2;
            var len124 = val124.length;
            var ptr124 = realloc1(0, 0, 4, len124 * 4);
            
            let valData124;
            const valLenBytes124 = len124 * 4;
            if (Array.isArray(val124)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv124 = new DataView(memory0.buffer);
              for (const v of val124) {
                _requireValidNumericPrimitive.bind(null, 'u32')(v);
                dv124.setUint32(ptr124+ offset, v, true);
                offset += 4;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData124 = new Uint8Array(val124.buffer || val124, val124.byteOffset, valLenBytes124);
              const out124 = new Uint8Array(memory0.buffer, ptr124, valLenBytes124);
              out124.set(valData124);
            }
            
            dataView(memory0).setUint32(base + 28, len124, true);
            dataView(memory0).setUint32(base + 24, ptr124, true);
            break;
          }
          case 'dict': {
            const e = variant173.val;
            dataView(memory0).setInt8(base + 0, 13, true);
            var vec126 = e;
            var len126 = vec126.length;
            var result126 = realloc1(0, 0, 4, len126 * 8);
            for (let i = 0; i < vec126.length; i++) {
              const e = vec126[i];
              const base = result126 + i * 8;var {key: v125_0, value: v125_1 } = e;
              dataView(memory0).setInt32(base + 0, toUint32(v125_0), true);
              dataView(memory0).setInt32(base + 4, toUint32(v125_1), true);
            }
            dataView(memory0).setUint32(base + 12, len126, true);
            dataView(memory0).setUint32(base + 8, result126, true);
            break;
          }
          case 'set': {
            const e = variant173.val;
            dataView(memory0).setInt8(base + 0, 14, true);
            var val127 = e;
            var len127 = val127.length;
            var ptr127 = realloc1(0, 0, 4, len127 * 4);
            
            let valData127;
            const valLenBytes127 = len127 * 4;
            if (Array.isArray(val127)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv127 = new DataView(memory0.buffer);
              for (const v of val127) {
                _requireValidNumericPrimitive.bind(null, 'u32')(v);
                dv127.setUint32(ptr127+ offset, v, true);
                offset += 4;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData127 = new Uint8Array(val127.buffer || val127, val127.byteOffset, valLenBytes127);
              const out127 = new Uint8Array(memory0.buffer, ptr127, valLenBytes127);
              out127.set(valData127);
            }
            
            dataView(memory0).setUint32(base + 12, len127, true);
            dataView(memory0).setUint32(base + 8, ptr127, true);
            break;
          }
          case 'frozen-set': {
            const e = variant173.val;
            dataView(memory0).setInt8(base + 0, 15, true);
            var val128 = e;
            var len128 = val128.length;
            var ptr128 = realloc1(0, 0, 4, len128 * 4);
            
            let valData128;
            const valLenBytes128 = len128 * 4;
            if (Array.isArray(val128)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv128 = new DataView(memory0.buffer);
              for (const v of val128) {
                _requireValidNumericPrimitive.bind(null, 'u32')(v);
                dv128.setUint32(ptr128+ offset, v, true);
                offset += 4;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData128 = new Uint8Array(val128.buffer || val128, val128.byteOffset, valLenBytes128);
              const out128 = new Uint8Array(memory0.buffer, ptr128, valLenBytes128);
              out128.set(valData128);
            }
            
            dataView(memory0).setUint32(base + 12, len128, true);
            dataView(memory0).setUint32(base + 8, ptr128, true);
            break;
          }
          case 'date': {
            const e = variant173.val;
            dataView(memory0).setInt8(base + 0, 16, true);
            var {year: v129_0, month: v129_1, day: v129_2 } = e;
            dataView(memory0).setInt32(base + 8, toInt32(v129_0), true);
            dataView(memory0).setInt8(base + 12, toUint8(v129_1), true);
            dataView(memory0).setInt8(base + 13, toUint8(v129_2), true);
            break;
          }
          case 'datetime': {
            const e = variant173.val;
            dataView(memory0).setInt8(base + 0, 17, true);
            var {year: v130_0, month: v130_1, day: v130_2, hour: v130_3, minute: v130_4, second: v130_5, microsecond: v130_6, offsetSeconds: v130_7, timezoneName: v130_8 } = e;
            dataView(memory0).setInt32(base + 8, toInt32(v130_0), true);
            dataView(memory0).setInt8(base + 12, toUint8(v130_1), true);
            dataView(memory0).setInt8(base + 13, toUint8(v130_2), true);
            dataView(memory0).setInt8(base + 14, toUint8(v130_3), true);
            dataView(memory0).setInt8(base + 15, toUint8(v130_4), true);
            dataView(memory0).setInt8(base + 16, toUint8(v130_5), true);
            dataView(memory0).setInt32(base + 20, toUint32(v130_6), true);
            var variant131 = v130_7;
            if (variant131 === null || variant131=== undefined) {
              dataView(memory0).setInt8(base + 24, 0, true);
            } else {
              const e = variant131;
              dataView(memory0).setInt8(base + 24, 1, true);
              dataView(memory0).setInt32(base + 28, toInt32(e), true);
            }
            var variant133 = v130_8;
            if (variant133 === null || variant133=== undefined) {
              dataView(memory0).setInt8(base + 32, 0, true);
            } else {
              const e = variant133;
              dataView(memory0).setInt8(base + 32, 1, true);
              
              var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
              var ptr132= encodeRes.ptr;
              var len132 = encodeRes.len;
              
              dataView(memory0).setUint32(base + 40, len132, true);
              dataView(memory0).setUint32(base + 36, ptr132, true);
            }
            break;
          }
          case 'time': {
            const e = variant173.val;
            dataView(memory0).setInt8(base + 0, 18, true);
            var {hour: v134_0, minute: v134_1, second: v134_2, microsecond: v134_3, offsetSeconds: v134_4, timezoneName: v134_5, fold: v134_6 } = e;
            dataView(memory0).setInt8(base + 8, toUint8(v134_0), true);
            dataView(memory0).setInt8(base + 9, toUint8(v134_1), true);
            dataView(memory0).setInt8(base + 10, toUint8(v134_2), true);
            dataView(memory0).setInt32(base + 12, toUint32(v134_3), true);
            var variant135 = v134_4;
            if (variant135 === null || variant135=== undefined) {
              dataView(memory0).setInt8(base + 16, 0, true);
            } else {
              const e = variant135;
              dataView(memory0).setInt8(base + 16, 1, true);
              dataView(memory0).setInt32(base + 20, toInt32(e), true);
            }
            var variant137 = v134_5;
            if (variant137 === null || variant137=== undefined) {
              dataView(memory0).setInt8(base + 24, 0, true);
            } else {
              const e = variant137;
              dataView(memory0).setInt8(base + 24, 1, true);
              
              var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
              var ptr136= encodeRes.ptr;
              var len136 = encodeRes.len;
              
              dataView(memory0).setUint32(base + 32, len136, true);
              dataView(memory0).setUint32(base + 28, ptr136, true);
            }
            dataView(memory0).setInt8(base + 36, toUint8(v134_6), true);
            break;
          }
          case 'timedelta': {
            const e = variant173.val;
            dataView(memory0).setInt8(base + 0, 19, true);
            var {days: v138_0, seconds: v138_1, microseconds: v138_2 } = e;
            dataView(memory0).setInt32(base + 8, toInt32(v138_0), true);
            dataView(memory0).setInt32(base + 12, toInt32(v138_1), true);
            dataView(memory0).setInt32(base + 16, toInt32(v138_2), true);
            break;
          }
          case 'timezone': {
            const e = variant173.val;
            dataView(memory0).setInt8(base + 0, 20, true);
            var {offsetSeconds: v139_0, name: v139_1 } = e;
            dataView(memory0).setInt32(base + 8, toInt32(v139_0), true);
            var variant141 = v139_1;
            if (variant141 === null || variant141=== undefined) {
              dataView(memory0).setInt8(base + 12, 0, true);
            } else {
              const e = variant141;
              dataView(memory0).setInt8(base + 12, 1, true);
              
              var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
              var ptr140= encodeRes.ptr;
              var len140 = encodeRes.len;
              
              dataView(memory0).setUint32(base + 20, len140, true);
              dataView(memory0).setUint32(base + 16, ptr140, true);
            }
            break;
          }
          case 'exception': {
            const e = variant173.val;
            dataView(memory0).setInt8(base + 0, 21, true);
            var {excType: v142_0, message: v142_1 } = e;
            
            var encodeRes = _utf8AllocateAndEncode(v142_0, realloc1, memory0);
            var ptr143= encodeRes.ptr;
            var len143 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len143, true);
            dataView(memory0).setUint32(base + 8, ptr143, true);
            var variant145 = v142_1;
            if (variant145 === null || variant145=== undefined) {
              dataView(memory0).setInt8(base + 16, 0, true);
            } else {
              const e = variant145;
              dataView(memory0).setInt8(base + 16, 1, true);
              
              var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
              var ptr144= encodeRes.ptr;
              var len144 = encodeRes.len;
              
              dataView(memory0).setUint32(base + 24, len144, true);
              dataView(memory0).setUint32(base + 20, ptr144, true);
            }
            break;
          }
          case 'type-name': {
            const e = variant173.val;
            dataView(memory0).setInt8(base + 0, 22, true);
            
            var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
            var ptr146= encodeRes.ptr;
            var len146 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len146, true);
            dataView(memory0).setUint32(base + 8, ptr146, true);
            break;
          }
          case 'class-type': {
            const e = variant173.val;
            dataView(memory0).setInt8(base + 0, 23, true);
            var {name: v147_0, id: v147_1, hostDefined: v147_2, isDataclass: v147_3, attrs: v147_4 } = e;
            
            var encodeRes = _utf8AllocateAndEncode(v147_0, realloc1, memory0);
            var ptr148= encodeRes.ptr;
            var len148 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len148, true);
            dataView(memory0).setUint32(base + 8, ptr148, true);
            
            var encodeRes = _utf8AllocateAndEncode(v147_1, realloc1, memory0);
            var ptr149= encodeRes.ptr;
            var len149 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 20, len149, true);
            dataView(memory0).setUint32(base + 16, ptr149, true);
            dataView(memory0).setInt8(base + 24, v147_2 ? 1 : 0, true);
            dataView(memory0).setInt8(base + 25, v147_3 ? 1 : 0, true);
            var vec151 = v147_4;
            var len151 = vec151.length;
            var result151 = realloc1(0, 0, 4, len151 * 8);
            for (let i = 0; i < vec151.length; i++) {
              const e = vec151[i];
              const base = result151 + i * 8;var {key: v150_0, value: v150_1 } = e;
              dataView(memory0).setInt32(base + 0, toUint32(v150_0), true);
              dataView(memory0).setInt32(base + 4, toUint32(v150_1), true);
            }
            dataView(memory0).setUint32(base + 32, len151, true);
            dataView(memory0).setUint32(base + 28, result151, true);
            break;
          }
          case 'builtin-function': {
            const e = variant173.val;
            dataView(memory0).setInt8(base + 0, 24, true);
            
            var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
            var ptr152= encodeRes.ptr;
            var len152 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len152, true);
            dataView(memory0).setUint32(base + 8, ptr152, true);
            break;
          }
          case 'path': {
            const e = variant173.val;
            dataView(memory0).setInt8(base + 0, 25, true);
            
            var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
            var ptr153= encodeRes.ptr;
            var len153 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len153, true);
            dataView(memory0).setUint32(base + 8, ptr153, true);
            break;
          }
          case 'file-handle': {
            const e = variant173.val;
            dataView(memory0).setInt8(base + 0, 26, true);
            var {path: v154_0, mode: v154_1, position: v154_2 } = e;
            
            var encodeRes = _utf8AllocateAndEncode(v154_0, realloc1, memory0);
            var ptr155= encodeRes.ptr;
            var len155 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len155, true);
            dataView(memory0).setUint32(base + 8, ptr155, true);
            
            var encodeRes = _utf8AllocateAndEncode(v154_1, realloc1, memory0);
            var ptr156= encodeRes.ptr;
            var len156 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 20, len156, true);
            dataView(memory0).setUint32(base + 16, ptr156, true);
            dataView(memory0).setBigInt64(base + 24, toUint64(v154_2), true);
            break;
          }
          case 'class-instance': {
            const e = variant173.val;
            dataView(memory0).setInt8(base + 0, 27, true);
            var {classType: v157_0, instanceId: v157_1, attrs: v157_2 } = e;
            dataView(memory0).setInt32(base + 8, toUint32(v157_0), true);
            
            var encodeRes = _utf8AllocateAndEncode(v157_1, realloc1, memory0);
            var ptr158= encodeRes.ptr;
            var len158 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 16, len158, true);
            dataView(memory0).setUint32(base + 12, ptr158, true);
            var vec160 = v157_2;
            var len160 = vec160.length;
            var result160 = realloc1(0, 0, 4, len160 * 8);
            for (let i = 0; i < vec160.length; i++) {
              const e = vec160[i];
              const base = result160 + i * 8;var {key: v159_0, value: v159_1 } = e;
              dataView(memory0).setInt32(base + 0, toUint32(v159_0), true);
              dataView(memory0).setInt32(base + 4, toUint32(v159_1), true);
            }
            dataView(memory0).setUint32(base + 24, len160, true);
            dataView(memory0).setUint32(base + 20, result160, true);
            break;
          }
          case 'function': {
            const e = variant173.val;
            dataView(memory0).setInt8(base + 0, 28, true);
            var {name: v161_0, docstring: v161_1 } = e;
            
            var encodeRes = _utf8AllocateAndEncode(v161_0, realloc1, memory0);
            var ptr162= encodeRes.ptr;
            var len162 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len162, true);
            dataView(memory0).setUint32(base + 8, ptr162, true);
            var variant164 = v161_1;
            if (variant164 === null || variant164=== undefined) {
              dataView(memory0).setInt8(base + 16, 0, true);
            } else {
              const e = variant164;
              dataView(memory0).setInt8(base + 16, 1, true);
              
              var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
              var ptr163= encodeRes.ptr;
              var len163 = encodeRes.len;
              
              dataView(memory0).setUint32(base + 24, len163, true);
              dataView(memory0).setUint32(base + 20, ptr163, true);
            }
            break;
          }
          case 'repr': {
            const e = variant173.val;
            dataView(memory0).setInt8(base + 0, 29, true);
            
            var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
            var ptr165= encodeRes.ptr;
            var len165 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len165, true);
            dataView(memory0).setUint32(base + 8, ptr165, true);
            break;
          }
          case 'cycle': {
            const e = variant173.val;
            dataView(memory0).setInt8(base + 0, 30, true);
            
            var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
            var ptr166= encodeRes.ptr;
            var len166 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len166, true);
            dataView(memory0).setUint32(base + 8, ptr166, true);
            break;
          }
          case 'module': {
            const e = variant173.val;
            dataView(memory0).setInt8(base + 0, 31, true);
            var {name: v167_0, id: v167_1, attrs: v167_2 } = e;
            
            var encodeRes = _utf8AllocateAndEncode(v167_0, realloc1, memory0);
            var ptr168= encodeRes.ptr;
            var len168 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len168, true);
            dataView(memory0).setUint32(base + 8, ptr168, true);
            
            var encodeRes = _utf8AllocateAndEncode(v167_1, realloc1, memory0);
            var ptr169= encodeRes.ptr;
            var len169 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 20, len169, true);
            dataView(memory0).setUint32(base + 16, ptr169, true);
            var vec171 = v167_2;
            var len171 = vec171.length;
            var result171 = realloc1(0, 0, 4, len171 * 8);
            for (let i = 0; i < vec171.length; i++) {
              const e = vec171[i];
              const base = result171 + i * 8;var {key: v170_0, value: v170_1 } = e;
              dataView(memory0).setInt32(base + 0, toUint32(v170_0), true);
              dataView(memory0).setInt32(base + 4, toUint32(v170_1), true);
            }
            dataView(memory0).setUint32(base + 28, len171, true);
            dataView(memory0).setUint32(base + 24, result171, true);
            break;
          }
          case 'decimal': {
            const e = variant173.val;
            dataView(memory0).setInt8(base + 0, 32, true);
            
            var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
            var ptr172= encodeRes.ptr;
            var len172 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len172, true);
            dataView(memory0).setUint32(base + 8, ptr172, true);
            break;
          }
          default: {
            throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant173.tag)}\` (received \`${variant173}\`) specified for \`ValueNode\``);
          }
        }
      }
      dataView(memory0).setUint32(ptr0 + 36, len174, true);
      dataView(memory0).setUint32(ptr0 + 32, result174, true);
      break;
    }
    case 'resume-name-lookup': {
      const e = variant318.val;
      dataView(memory0).setInt8(ptr0 + 0, 3, true);
      var {outcome: v175_0, values: v175_1 } = e;
      var variant179 = v175_0;
      switch (variant179.tag) {
        case 'value': {
          const e = variant179.val;
          dataView(memory0).setInt8(ptr0 + 8, 0, true);
          dataView(memory0).setInt32(ptr0 + 12, toUint32(e), true);
          break;
        }
        case 'undefined': {
          dataView(memory0).setInt8(ptr0 + 8, 1, true);
          break;
        }
        case 'error': {
          const e = variant179.val;
          dataView(memory0).setInt8(ptr0 + 8, 2, true);
          var {excType: v176_0, message: v176_1 } = e;
          
          var encodeRes = _utf8AllocateAndEncode(v176_0, realloc1, memory0);
          var ptr177= encodeRes.ptr;
          var len177 = encodeRes.len;
          
          dataView(memory0).setUint32(ptr0 + 16, len177, true);
          dataView(memory0).setUint32(ptr0 + 12, ptr177, true);
          
          var encodeRes = _utf8AllocateAndEncode(v176_1, realloc1, memory0);
          var ptr178= encodeRes.ptr;
          var len178 = encodeRes.len;
          
          dataView(memory0).setUint32(ptr0 + 24, len178, true);
          dataView(memory0).setUint32(ptr0 + 20, ptr178, true);
          break;
        }
        default: {
          throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant179.tag)}\` (received \`${variant179}\`) specified for \`NameLookupResult\``);
        }
      }
      var {nodes: v180_0 } = v175_1;
      var vec241 = v180_0;
      var len241 = vec241.length;
      var result241 = realloc1(0, 0, 8, len241 * 48);
      for (let i = 0; i < vec241.length; i++) {
        const e = vec241[i];
        const base = result241 + i * 48;var variant240 = e;
        switch (variant240.tag) {
          case 'ellipsis': {
            dataView(memory0).setInt8(base + 0, 0, true);
            break;
          }
          case 'not-implemented': {
            dataView(memory0).setInt8(base + 0, 1, true);
            break;
          }
          case 'none': {
            dataView(memory0).setInt8(base + 0, 2, true);
            break;
          }
          case 'boolean': {
            const e = variant240.val;
            dataView(memory0).setInt8(base + 0, 3, true);
            dataView(memory0).setInt8(base + 8, e ? 1 : 0, true);
            break;
          }
          case 'integer': {
            const e = variant240.val;
            dataView(memory0).setInt8(base + 0, 4, true);
            dataView(memory0).setBigInt64(base + 8, toInt64(e), true);
            break;
          }
          case 'bigint': {
            const e = variant240.val;
            dataView(memory0).setInt8(base + 0, 5, true);
            
            var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
            var ptr181= encodeRes.ptr;
            var len181 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len181, true);
            dataView(memory0).setUint32(base + 8, ptr181, true);
            break;
          }
          case 'float': {
            const e = variant240.val;
            dataView(memory0).setInt8(base + 0, 6, true);
            dataView(memory0).setFloat64(base + 8, +e, true);
            break;
          }
          case 'complex': {
            const e = variant240.val;
            dataView(memory0).setInt8(base + 0, 7, true);
            var {real: v182_0, imag: v182_1 } = e;
            dataView(memory0).setFloat64(base + 8, +v182_0, true);
            dataView(memory0).setFloat64(base + 16, +v182_1, true);
            break;
          }
          case 'text': {
            const e = variant240.val;
            dataView(memory0).setInt8(base + 0, 8, true);
            
            var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
            var ptr183= encodeRes.ptr;
            var len183 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len183, true);
            dataView(memory0).setUint32(base + 8, ptr183, true);
            break;
          }
          case 'bytes': {
            const e = variant240.val;
            dataView(memory0).setInt8(base + 0, 9, true);
            var val184 = e;
            var len184 = Array.isArray(val184) ? val184.length : val184.byteLength;
            var ptr184 = realloc1(0, 0, 1, len184 * 1);
            
            let valData184;
            const valLenBytes184 = len184 * 1;
            if (Array.isArray(val184)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv184 = new DataView(memory0.buffer);
              for (const v of val184) {
                _requireValidNumericPrimitive.bind(null, 'u8')(v);
                dv184.setUint8(ptr184+ offset, v, true);
                offset += 1;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData184 = new Uint8Array(val184.buffer || val184, val184.byteOffset, valLenBytes184);
              const out184 = new Uint8Array(memory0.buffer, ptr184, valLenBytes184);
              out184.set(valData184);
            }
            
            dataView(memory0).setUint32(base + 12, len184, true);
            dataView(memory0).setUint32(base + 8, ptr184, true);
            break;
          }
          case 'list-value': {
            const e = variant240.val;
            dataView(memory0).setInt8(base + 0, 10, true);
            var val185 = e;
            var len185 = val185.length;
            var ptr185 = realloc1(0, 0, 4, len185 * 4);
            
            let valData185;
            const valLenBytes185 = len185 * 4;
            if (Array.isArray(val185)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv185 = new DataView(memory0.buffer);
              for (const v of val185) {
                _requireValidNumericPrimitive.bind(null, 'u32')(v);
                dv185.setUint32(ptr185+ offset, v, true);
                offset += 4;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData185 = new Uint8Array(val185.buffer || val185, val185.byteOffset, valLenBytes185);
              const out185 = new Uint8Array(memory0.buffer, ptr185, valLenBytes185);
              out185.set(valData185);
            }
            
            dataView(memory0).setUint32(base + 12, len185, true);
            dataView(memory0).setUint32(base + 8, ptr185, true);
            break;
          }
          case 'tuple-value': {
            const e = variant240.val;
            dataView(memory0).setInt8(base + 0, 11, true);
            var val186 = e;
            var len186 = val186.length;
            var ptr186 = realloc1(0, 0, 4, len186 * 4);
            
            let valData186;
            const valLenBytes186 = len186 * 4;
            if (Array.isArray(val186)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv186 = new DataView(memory0.buffer);
              for (const v of val186) {
                _requireValidNumericPrimitive.bind(null, 'u32')(v);
                dv186.setUint32(ptr186+ offset, v, true);
                offset += 4;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData186 = new Uint8Array(val186.buffer || val186, val186.byteOffset, valLenBytes186);
              const out186 = new Uint8Array(memory0.buffer, ptr186, valLenBytes186);
              out186.set(valData186);
            }
            
            dataView(memory0).setUint32(base + 12, len186, true);
            dataView(memory0).setUint32(base + 8, ptr186, true);
            break;
          }
          case 'named-tuple': {
            const e = variant240.val;
            dataView(memory0).setInt8(base + 0, 12, true);
            var {typeName: v187_0, fieldNames: v187_1, items: v187_2 } = e;
            
            var encodeRes = _utf8AllocateAndEncode(v187_0, realloc1, memory0);
            var ptr188= encodeRes.ptr;
            var len188 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len188, true);
            dataView(memory0).setUint32(base + 8, ptr188, true);
            var vec190 = v187_1;
            var len190 = vec190.length;
            var result190 = realloc1(0, 0, 4, len190 * 8);
            for (let i = 0; i < vec190.length; i++) {
              const e = vec190[i];
              const base = result190 + i * 8;
              var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
              var ptr189= encodeRes.ptr;
              var len189 = encodeRes.len;
              
              dataView(memory0).setUint32(base + 4, len189, true);
              dataView(memory0).setUint32(base + 0, ptr189, true);
            }
            dataView(memory0).setUint32(base + 20, len190, true);
            dataView(memory0).setUint32(base + 16, result190, true);
            var val191 = v187_2;
            var len191 = val191.length;
            var ptr191 = realloc1(0, 0, 4, len191 * 4);
            
            let valData191;
            const valLenBytes191 = len191 * 4;
            if (Array.isArray(val191)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv191 = new DataView(memory0.buffer);
              for (const v of val191) {
                _requireValidNumericPrimitive.bind(null, 'u32')(v);
                dv191.setUint32(ptr191+ offset, v, true);
                offset += 4;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData191 = new Uint8Array(val191.buffer || val191, val191.byteOffset, valLenBytes191);
              const out191 = new Uint8Array(memory0.buffer, ptr191, valLenBytes191);
              out191.set(valData191);
            }
            
            dataView(memory0).setUint32(base + 28, len191, true);
            dataView(memory0).setUint32(base + 24, ptr191, true);
            break;
          }
          case 'dict': {
            const e = variant240.val;
            dataView(memory0).setInt8(base + 0, 13, true);
            var vec193 = e;
            var len193 = vec193.length;
            var result193 = realloc1(0, 0, 4, len193 * 8);
            for (let i = 0; i < vec193.length; i++) {
              const e = vec193[i];
              const base = result193 + i * 8;var {key: v192_0, value: v192_1 } = e;
              dataView(memory0).setInt32(base + 0, toUint32(v192_0), true);
              dataView(memory0).setInt32(base + 4, toUint32(v192_1), true);
            }
            dataView(memory0).setUint32(base + 12, len193, true);
            dataView(memory0).setUint32(base + 8, result193, true);
            break;
          }
          case 'set': {
            const e = variant240.val;
            dataView(memory0).setInt8(base + 0, 14, true);
            var val194 = e;
            var len194 = val194.length;
            var ptr194 = realloc1(0, 0, 4, len194 * 4);
            
            let valData194;
            const valLenBytes194 = len194 * 4;
            if (Array.isArray(val194)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv194 = new DataView(memory0.buffer);
              for (const v of val194) {
                _requireValidNumericPrimitive.bind(null, 'u32')(v);
                dv194.setUint32(ptr194+ offset, v, true);
                offset += 4;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData194 = new Uint8Array(val194.buffer || val194, val194.byteOffset, valLenBytes194);
              const out194 = new Uint8Array(memory0.buffer, ptr194, valLenBytes194);
              out194.set(valData194);
            }
            
            dataView(memory0).setUint32(base + 12, len194, true);
            dataView(memory0).setUint32(base + 8, ptr194, true);
            break;
          }
          case 'frozen-set': {
            const e = variant240.val;
            dataView(memory0).setInt8(base + 0, 15, true);
            var val195 = e;
            var len195 = val195.length;
            var ptr195 = realloc1(0, 0, 4, len195 * 4);
            
            let valData195;
            const valLenBytes195 = len195 * 4;
            if (Array.isArray(val195)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv195 = new DataView(memory0.buffer);
              for (const v of val195) {
                _requireValidNumericPrimitive.bind(null, 'u32')(v);
                dv195.setUint32(ptr195+ offset, v, true);
                offset += 4;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData195 = new Uint8Array(val195.buffer || val195, val195.byteOffset, valLenBytes195);
              const out195 = new Uint8Array(memory0.buffer, ptr195, valLenBytes195);
              out195.set(valData195);
            }
            
            dataView(memory0).setUint32(base + 12, len195, true);
            dataView(memory0).setUint32(base + 8, ptr195, true);
            break;
          }
          case 'date': {
            const e = variant240.val;
            dataView(memory0).setInt8(base + 0, 16, true);
            var {year: v196_0, month: v196_1, day: v196_2 } = e;
            dataView(memory0).setInt32(base + 8, toInt32(v196_0), true);
            dataView(memory0).setInt8(base + 12, toUint8(v196_1), true);
            dataView(memory0).setInt8(base + 13, toUint8(v196_2), true);
            break;
          }
          case 'datetime': {
            const e = variant240.val;
            dataView(memory0).setInt8(base + 0, 17, true);
            var {year: v197_0, month: v197_1, day: v197_2, hour: v197_3, minute: v197_4, second: v197_5, microsecond: v197_6, offsetSeconds: v197_7, timezoneName: v197_8 } = e;
            dataView(memory0).setInt32(base + 8, toInt32(v197_0), true);
            dataView(memory0).setInt8(base + 12, toUint8(v197_1), true);
            dataView(memory0).setInt8(base + 13, toUint8(v197_2), true);
            dataView(memory0).setInt8(base + 14, toUint8(v197_3), true);
            dataView(memory0).setInt8(base + 15, toUint8(v197_4), true);
            dataView(memory0).setInt8(base + 16, toUint8(v197_5), true);
            dataView(memory0).setInt32(base + 20, toUint32(v197_6), true);
            var variant198 = v197_7;
            if (variant198 === null || variant198=== undefined) {
              dataView(memory0).setInt8(base + 24, 0, true);
            } else {
              const e = variant198;
              dataView(memory0).setInt8(base + 24, 1, true);
              dataView(memory0).setInt32(base + 28, toInt32(e), true);
            }
            var variant200 = v197_8;
            if (variant200 === null || variant200=== undefined) {
              dataView(memory0).setInt8(base + 32, 0, true);
            } else {
              const e = variant200;
              dataView(memory0).setInt8(base + 32, 1, true);
              
              var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
              var ptr199= encodeRes.ptr;
              var len199 = encodeRes.len;
              
              dataView(memory0).setUint32(base + 40, len199, true);
              dataView(memory0).setUint32(base + 36, ptr199, true);
            }
            break;
          }
          case 'time': {
            const e = variant240.val;
            dataView(memory0).setInt8(base + 0, 18, true);
            var {hour: v201_0, minute: v201_1, second: v201_2, microsecond: v201_3, offsetSeconds: v201_4, timezoneName: v201_5, fold: v201_6 } = e;
            dataView(memory0).setInt8(base + 8, toUint8(v201_0), true);
            dataView(memory0).setInt8(base + 9, toUint8(v201_1), true);
            dataView(memory0).setInt8(base + 10, toUint8(v201_2), true);
            dataView(memory0).setInt32(base + 12, toUint32(v201_3), true);
            var variant202 = v201_4;
            if (variant202 === null || variant202=== undefined) {
              dataView(memory0).setInt8(base + 16, 0, true);
            } else {
              const e = variant202;
              dataView(memory0).setInt8(base + 16, 1, true);
              dataView(memory0).setInt32(base + 20, toInt32(e), true);
            }
            var variant204 = v201_5;
            if (variant204 === null || variant204=== undefined) {
              dataView(memory0).setInt8(base + 24, 0, true);
            } else {
              const e = variant204;
              dataView(memory0).setInt8(base + 24, 1, true);
              
              var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
              var ptr203= encodeRes.ptr;
              var len203 = encodeRes.len;
              
              dataView(memory0).setUint32(base + 32, len203, true);
              dataView(memory0).setUint32(base + 28, ptr203, true);
            }
            dataView(memory0).setInt8(base + 36, toUint8(v201_6), true);
            break;
          }
          case 'timedelta': {
            const e = variant240.val;
            dataView(memory0).setInt8(base + 0, 19, true);
            var {days: v205_0, seconds: v205_1, microseconds: v205_2 } = e;
            dataView(memory0).setInt32(base + 8, toInt32(v205_0), true);
            dataView(memory0).setInt32(base + 12, toInt32(v205_1), true);
            dataView(memory0).setInt32(base + 16, toInt32(v205_2), true);
            break;
          }
          case 'timezone': {
            const e = variant240.val;
            dataView(memory0).setInt8(base + 0, 20, true);
            var {offsetSeconds: v206_0, name: v206_1 } = e;
            dataView(memory0).setInt32(base + 8, toInt32(v206_0), true);
            var variant208 = v206_1;
            if (variant208 === null || variant208=== undefined) {
              dataView(memory0).setInt8(base + 12, 0, true);
            } else {
              const e = variant208;
              dataView(memory0).setInt8(base + 12, 1, true);
              
              var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
              var ptr207= encodeRes.ptr;
              var len207 = encodeRes.len;
              
              dataView(memory0).setUint32(base + 20, len207, true);
              dataView(memory0).setUint32(base + 16, ptr207, true);
            }
            break;
          }
          case 'exception': {
            const e = variant240.val;
            dataView(memory0).setInt8(base + 0, 21, true);
            var {excType: v209_0, message: v209_1 } = e;
            
            var encodeRes = _utf8AllocateAndEncode(v209_0, realloc1, memory0);
            var ptr210= encodeRes.ptr;
            var len210 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len210, true);
            dataView(memory0).setUint32(base + 8, ptr210, true);
            var variant212 = v209_1;
            if (variant212 === null || variant212=== undefined) {
              dataView(memory0).setInt8(base + 16, 0, true);
            } else {
              const e = variant212;
              dataView(memory0).setInt8(base + 16, 1, true);
              
              var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
              var ptr211= encodeRes.ptr;
              var len211 = encodeRes.len;
              
              dataView(memory0).setUint32(base + 24, len211, true);
              dataView(memory0).setUint32(base + 20, ptr211, true);
            }
            break;
          }
          case 'type-name': {
            const e = variant240.val;
            dataView(memory0).setInt8(base + 0, 22, true);
            
            var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
            var ptr213= encodeRes.ptr;
            var len213 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len213, true);
            dataView(memory0).setUint32(base + 8, ptr213, true);
            break;
          }
          case 'class-type': {
            const e = variant240.val;
            dataView(memory0).setInt8(base + 0, 23, true);
            var {name: v214_0, id: v214_1, hostDefined: v214_2, isDataclass: v214_3, attrs: v214_4 } = e;
            
            var encodeRes = _utf8AllocateAndEncode(v214_0, realloc1, memory0);
            var ptr215= encodeRes.ptr;
            var len215 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len215, true);
            dataView(memory0).setUint32(base + 8, ptr215, true);
            
            var encodeRes = _utf8AllocateAndEncode(v214_1, realloc1, memory0);
            var ptr216= encodeRes.ptr;
            var len216 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 20, len216, true);
            dataView(memory0).setUint32(base + 16, ptr216, true);
            dataView(memory0).setInt8(base + 24, v214_2 ? 1 : 0, true);
            dataView(memory0).setInt8(base + 25, v214_3 ? 1 : 0, true);
            var vec218 = v214_4;
            var len218 = vec218.length;
            var result218 = realloc1(0, 0, 4, len218 * 8);
            for (let i = 0; i < vec218.length; i++) {
              const e = vec218[i];
              const base = result218 + i * 8;var {key: v217_0, value: v217_1 } = e;
              dataView(memory0).setInt32(base + 0, toUint32(v217_0), true);
              dataView(memory0).setInt32(base + 4, toUint32(v217_1), true);
            }
            dataView(memory0).setUint32(base + 32, len218, true);
            dataView(memory0).setUint32(base + 28, result218, true);
            break;
          }
          case 'builtin-function': {
            const e = variant240.val;
            dataView(memory0).setInt8(base + 0, 24, true);
            
            var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
            var ptr219= encodeRes.ptr;
            var len219 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len219, true);
            dataView(memory0).setUint32(base + 8, ptr219, true);
            break;
          }
          case 'path': {
            const e = variant240.val;
            dataView(memory0).setInt8(base + 0, 25, true);
            
            var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
            var ptr220= encodeRes.ptr;
            var len220 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len220, true);
            dataView(memory0).setUint32(base + 8, ptr220, true);
            break;
          }
          case 'file-handle': {
            const e = variant240.val;
            dataView(memory0).setInt8(base + 0, 26, true);
            var {path: v221_0, mode: v221_1, position: v221_2 } = e;
            
            var encodeRes = _utf8AllocateAndEncode(v221_0, realloc1, memory0);
            var ptr222= encodeRes.ptr;
            var len222 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len222, true);
            dataView(memory0).setUint32(base + 8, ptr222, true);
            
            var encodeRes = _utf8AllocateAndEncode(v221_1, realloc1, memory0);
            var ptr223= encodeRes.ptr;
            var len223 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 20, len223, true);
            dataView(memory0).setUint32(base + 16, ptr223, true);
            dataView(memory0).setBigInt64(base + 24, toUint64(v221_2), true);
            break;
          }
          case 'class-instance': {
            const e = variant240.val;
            dataView(memory0).setInt8(base + 0, 27, true);
            var {classType: v224_0, instanceId: v224_1, attrs: v224_2 } = e;
            dataView(memory0).setInt32(base + 8, toUint32(v224_0), true);
            
            var encodeRes = _utf8AllocateAndEncode(v224_1, realloc1, memory0);
            var ptr225= encodeRes.ptr;
            var len225 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 16, len225, true);
            dataView(memory0).setUint32(base + 12, ptr225, true);
            var vec227 = v224_2;
            var len227 = vec227.length;
            var result227 = realloc1(0, 0, 4, len227 * 8);
            for (let i = 0; i < vec227.length; i++) {
              const e = vec227[i];
              const base = result227 + i * 8;var {key: v226_0, value: v226_1 } = e;
              dataView(memory0).setInt32(base + 0, toUint32(v226_0), true);
              dataView(memory0).setInt32(base + 4, toUint32(v226_1), true);
            }
            dataView(memory0).setUint32(base + 24, len227, true);
            dataView(memory0).setUint32(base + 20, result227, true);
            break;
          }
          case 'function': {
            const e = variant240.val;
            dataView(memory0).setInt8(base + 0, 28, true);
            var {name: v228_0, docstring: v228_1 } = e;
            
            var encodeRes = _utf8AllocateAndEncode(v228_0, realloc1, memory0);
            var ptr229= encodeRes.ptr;
            var len229 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len229, true);
            dataView(memory0).setUint32(base + 8, ptr229, true);
            var variant231 = v228_1;
            if (variant231 === null || variant231=== undefined) {
              dataView(memory0).setInt8(base + 16, 0, true);
            } else {
              const e = variant231;
              dataView(memory0).setInt8(base + 16, 1, true);
              
              var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
              var ptr230= encodeRes.ptr;
              var len230 = encodeRes.len;
              
              dataView(memory0).setUint32(base + 24, len230, true);
              dataView(memory0).setUint32(base + 20, ptr230, true);
            }
            break;
          }
          case 'repr': {
            const e = variant240.val;
            dataView(memory0).setInt8(base + 0, 29, true);
            
            var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
            var ptr232= encodeRes.ptr;
            var len232 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len232, true);
            dataView(memory0).setUint32(base + 8, ptr232, true);
            break;
          }
          case 'cycle': {
            const e = variant240.val;
            dataView(memory0).setInt8(base + 0, 30, true);
            
            var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
            var ptr233= encodeRes.ptr;
            var len233 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len233, true);
            dataView(memory0).setUint32(base + 8, ptr233, true);
            break;
          }
          case 'module': {
            const e = variant240.val;
            dataView(memory0).setInt8(base + 0, 31, true);
            var {name: v234_0, id: v234_1, attrs: v234_2 } = e;
            
            var encodeRes = _utf8AllocateAndEncode(v234_0, realloc1, memory0);
            var ptr235= encodeRes.ptr;
            var len235 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len235, true);
            dataView(memory0).setUint32(base + 8, ptr235, true);
            
            var encodeRes = _utf8AllocateAndEncode(v234_1, realloc1, memory0);
            var ptr236= encodeRes.ptr;
            var len236 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 20, len236, true);
            dataView(memory0).setUint32(base + 16, ptr236, true);
            var vec238 = v234_2;
            var len238 = vec238.length;
            var result238 = realloc1(0, 0, 4, len238 * 8);
            for (let i = 0; i < vec238.length; i++) {
              const e = vec238[i];
              const base = result238 + i * 8;var {key: v237_0, value: v237_1 } = e;
              dataView(memory0).setInt32(base + 0, toUint32(v237_0), true);
              dataView(memory0).setInt32(base + 4, toUint32(v237_1), true);
            }
            dataView(memory0).setUint32(base + 28, len238, true);
            dataView(memory0).setUint32(base + 24, result238, true);
            break;
          }
          case 'decimal': {
            const e = variant240.val;
            dataView(memory0).setInt8(base + 0, 32, true);
            
            var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
            var ptr239= encodeRes.ptr;
            var len239 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len239, true);
            dataView(memory0).setUint32(base + 8, ptr239, true);
            break;
          }
          default: {
            throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant240.tag)}\` (received \`${variant240}\`) specified for \`ValueNode\``);
          }
        }
      }
      dataView(memory0).setUint32(ptr0 + 32, len241, true);
      dataView(memory0).setUint32(ptr0 + 28, result241, true);
      break;
    }
    case 'resume-futures': {
      const e = variant318.val;
      dataView(memory0).setInt8(ptr0 + 0, 4, true);
      var {nativeCancel: v242_0, results: v242_1, values: v242_2 } = e;
      var variant244 = v242_0;
      if (variant244 === null || variant244=== undefined) {
        dataView(memory0).setInt8(ptr0 + 8, 0, true);
      } else {
        const e = variant244;
        dataView(memory0).setInt8(ptr0 + 8, 1, true);
        
        var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
        var ptr243= encodeRes.ptr;
        var len243 = encodeRes.len;
        
        dataView(memory0).setUint32(ptr0 + 16, len243, true);
        dataView(memory0).setUint32(ptr0 + 12, ptr243, true);
      }
      var vec251 = v242_1;
      var len251 = vec251.length;
      var result251 = realloc1(0, 0, 4, len251 * 24);
      for (let i = 0; i < vec251.length; i++) {
        const e = vec251[i];
        const base = result251 + i * 24;var {callId: v245_0, outcome: v245_1 } = e;
        dataView(memory0).setInt32(base + 0, toUint32(v245_0), true);
        var variant250 = v245_1;
        switch (variant250.tag) {
          case 'return-value': {
            const e = variant250.val;
            dataView(memory0).setInt8(base + 4, 0, true);
            dataView(memory0).setInt32(base + 8, toUint32(e), true);
            break;
          }
          case 'error': {
            const e = variant250.val;
            dataView(memory0).setInt8(base + 4, 1, true);
            var {excType: v246_0, message: v246_1 } = e;
            
            var encodeRes = _utf8AllocateAndEncode(v246_0, realloc1, memory0);
            var ptr247= encodeRes.ptr;
            var len247 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len247, true);
            dataView(memory0).setUint32(base + 8, ptr247, true);
            
            var encodeRes = _utf8AllocateAndEncode(v246_1, realloc1, memory0);
            var ptr248= encodeRes.ptr;
            var len248 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 20, len248, true);
            dataView(memory0).setUint32(base + 16, ptr248, true);
            break;
          }
          case 'pending-future': {
            const e = variant250.val;
            dataView(memory0).setInt8(base + 4, 2, true);
            dataView(memory0).setInt32(base + 8, toUint32(e), true);
            break;
          }
          case 'not-found': {
            const e = variant250.val;
            dataView(memory0).setInt8(base + 4, 3, true);
            
            var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
            var ptr249= encodeRes.ptr;
            var len249 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len249, true);
            dataView(memory0).setUint32(base + 8, ptr249, true);
            break;
          }
          case 'not-handled': {
            dataView(memory0).setInt8(base + 4, 4, true);
            break;
          }
          default: {
            throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant250.tag)}\` (received \`${variant250}\`) specified for \`CallResult\``);
          }
        }
      }
      dataView(memory0).setUint32(ptr0 + 24, len251, true);
      dataView(memory0).setUint32(ptr0 + 20, result251, true);
      var {nodes: v252_0 } = v242_2;
      var vec313 = v252_0;
      var len313 = vec313.length;
      var result313 = realloc1(0, 0, 8, len313 * 48);
      for (let i = 0; i < vec313.length; i++) {
        const e = vec313[i];
        const base = result313 + i * 48;var variant312 = e;
        switch (variant312.tag) {
          case 'ellipsis': {
            dataView(memory0).setInt8(base + 0, 0, true);
            break;
          }
          case 'not-implemented': {
            dataView(memory0).setInt8(base + 0, 1, true);
            break;
          }
          case 'none': {
            dataView(memory0).setInt8(base + 0, 2, true);
            break;
          }
          case 'boolean': {
            const e = variant312.val;
            dataView(memory0).setInt8(base + 0, 3, true);
            dataView(memory0).setInt8(base + 8, e ? 1 : 0, true);
            break;
          }
          case 'integer': {
            const e = variant312.val;
            dataView(memory0).setInt8(base + 0, 4, true);
            dataView(memory0).setBigInt64(base + 8, toInt64(e), true);
            break;
          }
          case 'bigint': {
            const e = variant312.val;
            dataView(memory0).setInt8(base + 0, 5, true);
            
            var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
            var ptr253= encodeRes.ptr;
            var len253 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len253, true);
            dataView(memory0).setUint32(base + 8, ptr253, true);
            break;
          }
          case 'float': {
            const e = variant312.val;
            dataView(memory0).setInt8(base + 0, 6, true);
            dataView(memory0).setFloat64(base + 8, +e, true);
            break;
          }
          case 'complex': {
            const e = variant312.val;
            dataView(memory0).setInt8(base + 0, 7, true);
            var {real: v254_0, imag: v254_1 } = e;
            dataView(memory0).setFloat64(base + 8, +v254_0, true);
            dataView(memory0).setFloat64(base + 16, +v254_1, true);
            break;
          }
          case 'text': {
            const e = variant312.val;
            dataView(memory0).setInt8(base + 0, 8, true);
            
            var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
            var ptr255= encodeRes.ptr;
            var len255 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len255, true);
            dataView(memory0).setUint32(base + 8, ptr255, true);
            break;
          }
          case 'bytes': {
            const e = variant312.val;
            dataView(memory0).setInt8(base + 0, 9, true);
            var val256 = e;
            var len256 = Array.isArray(val256) ? val256.length : val256.byteLength;
            var ptr256 = realloc1(0, 0, 1, len256 * 1);
            
            let valData256;
            const valLenBytes256 = len256 * 1;
            if (Array.isArray(val256)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv256 = new DataView(memory0.buffer);
              for (const v of val256) {
                _requireValidNumericPrimitive.bind(null, 'u8')(v);
                dv256.setUint8(ptr256+ offset, v, true);
                offset += 1;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData256 = new Uint8Array(val256.buffer || val256, val256.byteOffset, valLenBytes256);
              const out256 = new Uint8Array(memory0.buffer, ptr256, valLenBytes256);
              out256.set(valData256);
            }
            
            dataView(memory0).setUint32(base + 12, len256, true);
            dataView(memory0).setUint32(base + 8, ptr256, true);
            break;
          }
          case 'list-value': {
            const e = variant312.val;
            dataView(memory0).setInt8(base + 0, 10, true);
            var val257 = e;
            var len257 = val257.length;
            var ptr257 = realloc1(0, 0, 4, len257 * 4);
            
            let valData257;
            const valLenBytes257 = len257 * 4;
            if (Array.isArray(val257)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv257 = new DataView(memory0.buffer);
              for (const v of val257) {
                _requireValidNumericPrimitive.bind(null, 'u32')(v);
                dv257.setUint32(ptr257+ offset, v, true);
                offset += 4;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData257 = new Uint8Array(val257.buffer || val257, val257.byteOffset, valLenBytes257);
              const out257 = new Uint8Array(memory0.buffer, ptr257, valLenBytes257);
              out257.set(valData257);
            }
            
            dataView(memory0).setUint32(base + 12, len257, true);
            dataView(memory0).setUint32(base + 8, ptr257, true);
            break;
          }
          case 'tuple-value': {
            const e = variant312.val;
            dataView(memory0).setInt8(base + 0, 11, true);
            var val258 = e;
            var len258 = val258.length;
            var ptr258 = realloc1(0, 0, 4, len258 * 4);
            
            let valData258;
            const valLenBytes258 = len258 * 4;
            if (Array.isArray(val258)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv258 = new DataView(memory0.buffer);
              for (const v of val258) {
                _requireValidNumericPrimitive.bind(null, 'u32')(v);
                dv258.setUint32(ptr258+ offset, v, true);
                offset += 4;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData258 = new Uint8Array(val258.buffer || val258, val258.byteOffset, valLenBytes258);
              const out258 = new Uint8Array(memory0.buffer, ptr258, valLenBytes258);
              out258.set(valData258);
            }
            
            dataView(memory0).setUint32(base + 12, len258, true);
            dataView(memory0).setUint32(base + 8, ptr258, true);
            break;
          }
          case 'named-tuple': {
            const e = variant312.val;
            dataView(memory0).setInt8(base + 0, 12, true);
            var {typeName: v259_0, fieldNames: v259_1, items: v259_2 } = e;
            
            var encodeRes = _utf8AllocateAndEncode(v259_0, realloc1, memory0);
            var ptr260= encodeRes.ptr;
            var len260 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len260, true);
            dataView(memory0).setUint32(base + 8, ptr260, true);
            var vec262 = v259_1;
            var len262 = vec262.length;
            var result262 = realloc1(0, 0, 4, len262 * 8);
            for (let i = 0; i < vec262.length; i++) {
              const e = vec262[i];
              const base = result262 + i * 8;
              var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
              var ptr261= encodeRes.ptr;
              var len261 = encodeRes.len;
              
              dataView(memory0).setUint32(base + 4, len261, true);
              dataView(memory0).setUint32(base + 0, ptr261, true);
            }
            dataView(memory0).setUint32(base + 20, len262, true);
            dataView(memory0).setUint32(base + 16, result262, true);
            var val263 = v259_2;
            var len263 = val263.length;
            var ptr263 = realloc1(0, 0, 4, len263 * 4);
            
            let valData263;
            const valLenBytes263 = len263 * 4;
            if (Array.isArray(val263)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv263 = new DataView(memory0.buffer);
              for (const v of val263) {
                _requireValidNumericPrimitive.bind(null, 'u32')(v);
                dv263.setUint32(ptr263+ offset, v, true);
                offset += 4;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData263 = new Uint8Array(val263.buffer || val263, val263.byteOffset, valLenBytes263);
              const out263 = new Uint8Array(memory0.buffer, ptr263, valLenBytes263);
              out263.set(valData263);
            }
            
            dataView(memory0).setUint32(base + 28, len263, true);
            dataView(memory0).setUint32(base + 24, ptr263, true);
            break;
          }
          case 'dict': {
            const e = variant312.val;
            dataView(memory0).setInt8(base + 0, 13, true);
            var vec265 = e;
            var len265 = vec265.length;
            var result265 = realloc1(0, 0, 4, len265 * 8);
            for (let i = 0; i < vec265.length; i++) {
              const e = vec265[i];
              const base = result265 + i * 8;var {key: v264_0, value: v264_1 } = e;
              dataView(memory0).setInt32(base + 0, toUint32(v264_0), true);
              dataView(memory0).setInt32(base + 4, toUint32(v264_1), true);
            }
            dataView(memory0).setUint32(base + 12, len265, true);
            dataView(memory0).setUint32(base + 8, result265, true);
            break;
          }
          case 'set': {
            const e = variant312.val;
            dataView(memory0).setInt8(base + 0, 14, true);
            var val266 = e;
            var len266 = val266.length;
            var ptr266 = realloc1(0, 0, 4, len266 * 4);
            
            let valData266;
            const valLenBytes266 = len266 * 4;
            if (Array.isArray(val266)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv266 = new DataView(memory0.buffer);
              for (const v of val266) {
                _requireValidNumericPrimitive.bind(null, 'u32')(v);
                dv266.setUint32(ptr266+ offset, v, true);
                offset += 4;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData266 = new Uint8Array(val266.buffer || val266, val266.byteOffset, valLenBytes266);
              const out266 = new Uint8Array(memory0.buffer, ptr266, valLenBytes266);
              out266.set(valData266);
            }
            
            dataView(memory0).setUint32(base + 12, len266, true);
            dataView(memory0).setUint32(base + 8, ptr266, true);
            break;
          }
          case 'frozen-set': {
            const e = variant312.val;
            dataView(memory0).setInt8(base + 0, 15, true);
            var val267 = e;
            var len267 = val267.length;
            var ptr267 = realloc1(0, 0, 4, len267 * 4);
            
            let valData267;
            const valLenBytes267 = len267 * 4;
            if (Array.isArray(val267)) {
              // Regular array likely containing numbers, write values to memory
              let offset = 0;
              const dv267 = new DataView(memory0.buffer);
              for (const v of val267) {
                _requireValidNumericPrimitive.bind(null, 'u32')(v);
                dv267.setUint32(ptr267+ offset, v, true);
                offset += 4;
              }
            } else {
              // TypedArray / ArrayBuffer-like, direct copy
              valData267 = new Uint8Array(val267.buffer || val267, val267.byteOffset, valLenBytes267);
              const out267 = new Uint8Array(memory0.buffer, ptr267, valLenBytes267);
              out267.set(valData267);
            }
            
            dataView(memory0).setUint32(base + 12, len267, true);
            dataView(memory0).setUint32(base + 8, ptr267, true);
            break;
          }
          case 'date': {
            const e = variant312.val;
            dataView(memory0).setInt8(base + 0, 16, true);
            var {year: v268_0, month: v268_1, day: v268_2 } = e;
            dataView(memory0).setInt32(base + 8, toInt32(v268_0), true);
            dataView(memory0).setInt8(base + 12, toUint8(v268_1), true);
            dataView(memory0).setInt8(base + 13, toUint8(v268_2), true);
            break;
          }
          case 'datetime': {
            const e = variant312.val;
            dataView(memory0).setInt8(base + 0, 17, true);
            var {year: v269_0, month: v269_1, day: v269_2, hour: v269_3, minute: v269_4, second: v269_5, microsecond: v269_6, offsetSeconds: v269_7, timezoneName: v269_8 } = e;
            dataView(memory0).setInt32(base + 8, toInt32(v269_0), true);
            dataView(memory0).setInt8(base + 12, toUint8(v269_1), true);
            dataView(memory0).setInt8(base + 13, toUint8(v269_2), true);
            dataView(memory0).setInt8(base + 14, toUint8(v269_3), true);
            dataView(memory0).setInt8(base + 15, toUint8(v269_4), true);
            dataView(memory0).setInt8(base + 16, toUint8(v269_5), true);
            dataView(memory0).setInt32(base + 20, toUint32(v269_6), true);
            var variant270 = v269_7;
            if (variant270 === null || variant270=== undefined) {
              dataView(memory0).setInt8(base + 24, 0, true);
            } else {
              const e = variant270;
              dataView(memory0).setInt8(base + 24, 1, true);
              dataView(memory0).setInt32(base + 28, toInt32(e), true);
            }
            var variant272 = v269_8;
            if (variant272 === null || variant272=== undefined) {
              dataView(memory0).setInt8(base + 32, 0, true);
            } else {
              const e = variant272;
              dataView(memory0).setInt8(base + 32, 1, true);
              
              var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
              var ptr271= encodeRes.ptr;
              var len271 = encodeRes.len;
              
              dataView(memory0).setUint32(base + 40, len271, true);
              dataView(memory0).setUint32(base + 36, ptr271, true);
            }
            break;
          }
          case 'time': {
            const e = variant312.val;
            dataView(memory0).setInt8(base + 0, 18, true);
            var {hour: v273_0, minute: v273_1, second: v273_2, microsecond: v273_3, offsetSeconds: v273_4, timezoneName: v273_5, fold: v273_6 } = e;
            dataView(memory0).setInt8(base + 8, toUint8(v273_0), true);
            dataView(memory0).setInt8(base + 9, toUint8(v273_1), true);
            dataView(memory0).setInt8(base + 10, toUint8(v273_2), true);
            dataView(memory0).setInt32(base + 12, toUint32(v273_3), true);
            var variant274 = v273_4;
            if (variant274 === null || variant274=== undefined) {
              dataView(memory0).setInt8(base + 16, 0, true);
            } else {
              const e = variant274;
              dataView(memory0).setInt8(base + 16, 1, true);
              dataView(memory0).setInt32(base + 20, toInt32(e), true);
            }
            var variant276 = v273_5;
            if (variant276 === null || variant276=== undefined) {
              dataView(memory0).setInt8(base + 24, 0, true);
            } else {
              const e = variant276;
              dataView(memory0).setInt8(base + 24, 1, true);
              
              var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
              var ptr275= encodeRes.ptr;
              var len275 = encodeRes.len;
              
              dataView(memory0).setUint32(base + 32, len275, true);
              dataView(memory0).setUint32(base + 28, ptr275, true);
            }
            dataView(memory0).setInt8(base + 36, toUint8(v273_6), true);
            break;
          }
          case 'timedelta': {
            const e = variant312.val;
            dataView(memory0).setInt8(base + 0, 19, true);
            var {days: v277_0, seconds: v277_1, microseconds: v277_2 } = e;
            dataView(memory0).setInt32(base + 8, toInt32(v277_0), true);
            dataView(memory0).setInt32(base + 12, toInt32(v277_1), true);
            dataView(memory0).setInt32(base + 16, toInt32(v277_2), true);
            break;
          }
          case 'timezone': {
            const e = variant312.val;
            dataView(memory0).setInt8(base + 0, 20, true);
            var {offsetSeconds: v278_0, name: v278_1 } = e;
            dataView(memory0).setInt32(base + 8, toInt32(v278_0), true);
            var variant280 = v278_1;
            if (variant280 === null || variant280=== undefined) {
              dataView(memory0).setInt8(base + 12, 0, true);
            } else {
              const e = variant280;
              dataView(memory0).setInt8(base + 12, 1, true);
              
              var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
              var ptr279= encodeRes.ptr;
              var len279 = encodeRes.len;
              
              dataView(memory0).setUint32(base + 20, len279, true);
              dataView(memory0).setUint32(base + 16, ptr279, true);
            }
            break;
          }
          case 'exception': {
            const e = variant312.val;
            dataView(memory0).setInt8(base + 0, 21, true);
            var {excType: v281_0, message: v281_1 } = e;
            
            var encodeRes = _utf8AllocateAndEncode(v281_0, realloc1, memory0);
            var ptr282= encodeRes.ptr;
            var len282 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len282, true);
            dataView(memory0).setUint32(base + 8, ptr282, true);
            var variant284 = v281_1;
            if (variant284 === null || variant284=== undefined) {
              dataView(memory0).setInt8(base + 16, 0, true);
            } else {
              const e = variant284;
              dataView(memory0).setInt8(base + 16, 1, true);
              
              var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
              var ptr283= encodeRes.ptr;
              var len283 = encodeRes.len;
              
              dataView(memory0).setUint32(base + 24, len283, true);
              dataView(memory0).setUint32(base + 20, ptr283, true);
            }
            break;
          }
          case 'type-name': {
            const e = variant312.val;
            dataView(memory0).setInt8(base + 0, 22, true);
            
            var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
            var ptr285= encodeRes.ptr;
            var len285 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len285, true);
            dataView(memory0).setUint32(base + 8, ptr285, true);
            break;
          }
          case 'class-type': {
            const e = variant312.val;
            dataView(memory0).setInt8(base + 0, 23, true);
            var {name: v286_0, id: v286_1, hostDefined: v286_2, isDataclass: v286_3, attrs: v286_4 } = e;
            
            var encodeRes = _utf8AllocateAndEncode(v286_0, realloc1, memory0);
            var ptr287= encodeRes.ptr;
            var len287 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len287, true);
            dataView(memory0).setUint32(base + 8, ptr287, true);
            
            var encodeRes = _utf8AllocateAndEncode(v286_1, realloc1, memory0);
            var ptr288= encodeRes.ptr;
            var len288 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 20, len288, true);
            dataView(memory0).setUint32(base + 16, ptr288, true);
            dataView(memory0).setInt8(base + 24, v286_2 ? 1 : 0, true);
            dataView(memory0).setInt8(base + 25, v286_3 ? 1 : 0, true);
            var vec290 = v286_4;
            var len290 = vec290.length;
            var result290 = realloc1(0, 0, 4, len290 * 8);
            for (let i = 0; i < vec290.length; i++) {
              const e = vec290[i];
              const base = result290 + i * 8;var {key: v289_0, value: v289_1 } = e;
              dataView(memory0).setInt32(base + 0, toUint32(v289_0), true);
              dataView(memory0).setInt32(base + 4, toUint32(v289_1), true);
            }
            dataView(memory0).setUint32(base + 32, len290, true);
            dataView(memory0).setUint32(base + 28, result290, true);
            break;
          }
          case 'builtin-function': {
            const e = variant312.val;
            dataView(memory0).setInt8(base + 0, 24, true);
            
            var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
            var ptr291= encodeRes.ptr;
            var len291 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len291, true);
            dataView(memory0).setUint32(base + 8, ptr291, true);
            break;
          }
          case 'path': {
            const e = variant312.val;
            dataView(memory0).setInt8(base + 0, 25, true);
            
            var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
            var ptr292= encodeRes.ptr;
            var len292 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len292, true);
            dataView(memory0).setUint32(base + 8, ptr292, true);
            break;
          }
          case 'file-handle': {
            const e = variant312.val;
            dataView(memory0).setInt8(base + 0, 26, true);
            var {path: v293_0, mode: v293_1, position: v293_2 } = e;
            
            var encodeRes = _utf8AllocateAndEncode(v293_0, realloc1, memory0);
            var ptr294= encodeRes.ptr;
            var len294 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len294, true);
            dataView(memory0).setUint32(base + 8, ptr294, true);
            
            var encodeRes = _utf8AllocateAndEncode(v293_1, realloc1, memory0);
            var ptr295= encodeRes.ptr;
            var len295 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 20, len295, true);
            dataView(memory0).setUint32(base + 16, ptr295, true);
            dataView(memory0).setBigInt64(base + 24, toUint64(v293_2), true);
            break;
          }
          case 'class-instance': {
            const e = variant312.val;
            dataView(memory0).setInt8(base + 0, 27, true);
            var {classType: v296_0, instanceId: v296_1, attrs: v296_2 } = e;
            dataView(memory0).setInt32(base + 8, toUint32(v296_0), true);
            
            var encodeRes = _utf8AllocateAndEncode(v296_1, realloc1, memory0);
            var ptr297= encodeRes.ptr;
            var len297 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 16, len297, true);
            dataView(memory0).setUint32(base + 12, ptr297, true);
            var vec299 = v296_2;
            var len299 = vec299.length;
            var result299 = realloc1(0, 0, 4, len299 * 8);
            for (let i = 0; i < vec299.length; i++) {
              const e = vec299[i];
              const base = result299 + i * 8;var {key: v298_0, value: v298_1 } = e;
              dataView(memory0).setInt32(base + 0, toUint32(v298_0), true);
              dataView(memory0).setInt32(base + 4, toUint32(v298_1), true);
            }
            dataView(memory0).setUint32(base + 24, len299, true);
            dataView(memory0).setUint32(base + 20, result299, true);
            break;
          }
          case 'function': {
            const e = variant312.val;
            dataView(memory0).setInt8(base + 0, 28, true);
            var {name: v300_0, docstring: v300_1 } = e;
            
            var encodeRes = _utf8AllocateAndEncode(v300_0, realloc1, memory0);
            var ptr301= encodeRes.ptr;
            var len301 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len301, true);
            dataView(memory0).setUint32(base + 8, ptr301, true);
            var variant303 = v300_1;
            if (variant303 === null || variant303=== undefined) {
              dataView(memory0).setInt8(base + 16, 0, true);
            } else {
              const e = variant303;
              dataView(memory0).setInt8(base + 16, 1, true);
              
              var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
              var ptr302= encodeRes.ptr;
              var len302 = encodeRes.len;
              
              dataView(memory0).setUint32(base + 24, len302, true);
              dataView(memory0).setUint32(base + 20, ptr302, true);
            }
            break;
          }
          case 'repr': {
            const e = variant312.val;
            dataView(memory0).setInt8(base + 0, 29, true);
            
            var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
            var ptr304= encodeRes.ptr;
            var len304 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len304, true);
            dataView(memory0).setUint32(base + 8, ptr304, true);
            break;
          }
          case 'cycle': {
            const e = variant312.val;
            dataView(memory0).setInt8(base + 0, 30, true);
            
            var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
            var ptr305= encodeRes.ptr;
            var len305 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len305, true);
            dataView(memory0).setUint32(base + 8, ptr305, true);
            break;
          }
          case 'module': {
            const e = variant312.val;
            dataView(memory0).setInt8(base + 0, 31, true);
            var {name: v306_0, id: v306_1, attrs: v306_2 } = e;
            
            var encodeRes = _utf8AllocateAndEncode(v306_0, realloc1, memory0);
            var ptr307= encodeRes.ptr;
            var len307 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len307, true);
            dataView(memory0).setUint32(base + 8, ptr307, true);
            
            var encodeRes = _utf8AllocateAndEncode(v306_1, realloc1, memory0);
            var ptr308= encodeRes.ptr;
            var len308 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 20, len308, true);
            dataView(memory0).setUint32(base + 16, ptr308, true);
            var vec310 = v306_2;
            var len310 = vec310.length;
            var result310 = realloc1(0, 0, 4, len310 * 8);
            for (let i = 0; i < vec310.length; i++) {
              const e = vec310[i];
              const base = result310 + i * 8;var {key: v309_0, value: v309_1 } = e;
              dataView(memory0).setInt32(base + 0, toUint32(v309_0), true);
              dataView(memory0).setInt32(base + 4, toUint32(v309_1), true);
            }
            dataView(memory0).setUint32(base + 28, len310, true);
            dataView(memory0).setUint32(base + 24, result310, true);
            break;
          }
          case 'decimal': {
            const e = variant312.val;
            dataView(memory0).setInt8(base + 0, 32, true);
            
            var encodeRes = _utf8AllocateAndEncode(e, realloc1, memory0);
            var ptr311= encodeRes.ptr;
            var len311 = encodeRes.len;
            
            dataView(memory0).setUint32(base + 12, len311, true);
            dataView(memory0).setUint32(base + 8, ptr311, true);
            break;
          }
          default: {
            throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant312.tag)}\` (received \`${variant312}\`) specified for \`ValueNode\``);
          }
        }
      }
      dataView(memory0).setUint32(ptr0 + 32, len313, true);
      dataView(memory0).setUint32(ptr0 + 28, result313, true);
      break;
    }
    case 'abort-feed': {
      const e = variant318.val;
      dataView(memory0).setInt8(ptr0 + 0, 5, true);
      var {excType: v314_0, message: v314_1 } = e;
      
      var encodeRes = _utf8AllocateAndEncode(v314_0, realloc1, memory0);
      var ptr315= encodeRes.ptr;
      var len315 = encodeRes.len;
      
      dataView(memory0).setUint32(ptr0 + 12, len315, true);
      dataView(memory0).setUint32(ptr0 + 8, ptr315, true);
      
      var encodeRes = _utf8AllocateAndEncode(v314_1, realloc1, memory0);
      var ptr316= encodeRes.ptr;
      var len316 = encodeRes.len;
      
      dataView(memory0).setUint32(ptr0 + 20, len316, true);
      dataView(memory0).setUint32(ptr0 + 16, ptr316, true);
      break;
    }
    case 'dump': {
      dataView(memory0).setInt8(ptr0 + 0, 6, true);
      break;
    }
    case 'load': {
      const e = variant318.val;
      dataView(memory0).setInt8(ptr0 + 0, 7, true);
      var val317 = e;
      var len317 = Array.isArray(val317) ? val317.length : val317.byteLength;
      var ptr317 = realloc1(0, 0, 1, len317 * 1);
      
      let valData317;
      const valLenBytes317 = len317 * 1;
      if (Array.isArray(val317)) {
        // Regular array likely containing numbers, write values to memory
        let offset = 0;
        const dv317 = new DataView(memory0.buffer);
        for (const v of val317) {
          _requireValidNumericPrimitive.bind(null, 'u8')(v);
          dv317.setUint8(ptr317+ offset, v, true);
          offset += 1;
        }
      } else {
        // TypedArray / ArrayBuffer-like, direct copy
        valData317 = new Uint8Array(val317.buffer || val317, val317.byteOffset, valLenBytes317);
        const out317 = new Uint8Array(memory0.buffer, ptr317, valLenBytes317);
        out317.set(valData317);
      }
      
      dataView(memory0).setUint32(ptr0 + 12, len317, true);
      dataView(memory0).setUint32(ptr0 + 8, ptr317, true);
      break;
    }
    case 'reset': {
      dataView(memory0).setInt8(ptr0 + 0, 8, true);
      break;
    }
    default: {
      throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant318.tag)}\` (received \`${variant318}\`) specified for \`Request\``);
    }
  }
  _debugLog('[iface="pydantic:monty/worker", function="dispatch"][Instruction::CallWasm] enter', {
    funcName: 'dispatch',
    paramCount: 1,
    async: false,
    postReturn: true,
  });
  const hostProvided = false;
  
  const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
    componentIdx: 0,
    isAsync: false,
    isManualAsync: false,
    entryFnName: 'workerDispatch',
    getCallbackFn: () => null,
    callbackFnName: null,
    errHandling: 'none',
    callingWasmExport: true,
  });
  
  const started = task.enterSync();
  
  if (0!== null) {
    task.setReturnMemoryIdx(0);
    task.setReturnMemory(() => memory0());
  }
  
  
  let ret;
  
  try {
    ret =   _withGlobalCurrentTaskMeta({
      taskID: task.id(),
      componentIdx: task.componentIdx(),
      fn: () => workerDispatch(ptr0),
    });
  } catch (err) {
    
    _debugLog('[Instruction::CallWasm] error during sync call', {
      taskID: task.id(),
      err,
    });
    task.setErrored(err);
    task.reject(err);
    task.exit();
    throw err;
    
  }
  
  let enum319;
  switch (dataView(memory0).getUint8(ret + 0, true)) {
    case 0: {
      enum319 = 'continue';
      break;
    }
    case 1: {
      enum319 = 'shutdown';
      break;
    }
    default: {
      throw new TypeError('invalid discriminant specified for Status');
    }
  }
  var len499 = dataView(memory0).getUint32(ret + 8, true);
  var base499 = dataView(memory0).getUint32(ret + 4, true);
  var result499 = [];
  for (let i = 0; i < len499; i++) {
    const base = base499 + i * 80;
    let variant498;
    switch (dataView(memory0).getUint8(base + 0, true)) {
      case 0: {
        var bool320 = dataView(memory0).getUint8(base + 8, true);
        var ptr321 = dataView(memory0).getUint32(base + 12, true);
        var len321 = dataView(memory0).getUint32(base + 16, true);
        var result321 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr321, len321));
        variant498= {
          tag: 'print',
          val: {
            stderr: bool320 == 0 ? false : (bool320 == 1 ? true : throwInvalidBool()),
            text: result321,
          }
        };
        break;
      }
      case 1: {
        var ptr322 = dataView(memory0).getUint32(base + 8, true);
        var len322 = dataView(memory0).getUint32(base + 12, true);
        var result322 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr322, len322));
        var len369 = dataView(memory0).getUint32(base + 20, true);
        var base369 = dataView(memory0).getUint32(base + 16, true);
        var result369 = [];
        for (let i = 0; i < len369; i++) {
          const base = base369 + i * 48;
          let variant368;
          switch (dataView(memory0).getUint8(base + 0, true)) {
            case 0: {
              variant368= {
                tag: 'ellipsis',
              };
              break;
            }
            case 1: {
              variant368= {
                tag: 'not-implemented',
              };
              break;
            }
            case 2: {
              variant368= {
                tag: 'none',
              };
              break;
            }
            case 3: {
              var bool323 = dataView(memory0).getUint8(base + 8, true);
              variant368= {
                tag: 'boolean',
                val: bool323 == 0 ? false : (bool323 == 1 ? true : throwInvalidBool())
              };
              break;
            }
            case 4: {
              variant368= {
                tag: 'integer',
                val: dataView(memory0).getBigInt64(base + 8, true)
              };
              break;
            }
            case 5: {
              var ptr324 = dataView(memory0).getUint32(base + 8, true);
              var len324 = dataView(memory0).getUint32(base + 12, true);
              var result324 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr324, len324));
              variant368= {
                tag: 'bigint',
                val: result324
              };
              break;
            }
            case 6: {
              variant368= {
                tag: 'float',
                val: dataView(memory0).getFloat64(base + 8, true)
              };
              break;
            }
            case 7: {
              variant368= {
                tag: 'complex',
                val: {
                  real: dataView(memory0).getFloat64(base + 8, true),
                  imag: dataView(memory0).getFloat64(base + 16, true),
                }
              };
              break;
            }
            case 8: {
              var ptr325 = dataView(memory0).getUint32(base + 8, true);
              var len325 = dataView(memory0).getUint32(base + 12, true);
              var result325 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr325, len325));
              variant368= {
                tag: 'text',
                val: result325
              };
              break;
            }
            case 9: {
              var ptr326 = dataView(memory0).getUint32(base + 8, true);
              var len326 = dataView(memory0).getUint32(base + 12, true);
              var result326 = new Uint8Array(memory0.buffer.slice(ptr326, ptr326 + len326 * 1));
              variant368= {
                tag: 'bytes',
                val: result326
              };
              break;
            }
            case 10: {
              var ptr327 = dataView(memory0).getUint32(base + 8, true);
              var len327 = dataView(memory0).getUint32(base + 12, true);
              var result327 = new Uint32Array(memory0.buffer.slice(ptr327, ptr327 + len327 * 4));
              variant368= {
                tag: 'list-value',
                val: result327
              };
              break;
            }
            case 11: {
              var ptr328 = dataView(memory0).getUint32(base + 8, true);
              var len328 = dataView(memory0).getUint32(base + 12, true);
              var result328 = new Uint32Array(memory0.buffer.slice(ptr328, ptr328 + len328 * 4));
              variant368= {
                tag: 'tuple-value',
                val: result328
              };
              break;
            }
            case 12: {
              var ptr329 = dataView(memory0).getUint32(base + 8, true);
              var len329 = dataView(memory0).getUint32(base + 12, true);
              var result329 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr329, len329));
              var len331 = dataView(memory0).getUint32(base + 20, true);
              var base331 = dataView(memory0).getUint32(base + 16, true);
              var result331 = [];
              for (let i = 0; i < len331; i++) {
                const base = base331 + i * 8;
                var ptr330 = dataView(memory0).getUint32(base + 0, true);
                var len330 = dataView(memory0).getUint32(base + 4, true);
                var result330 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr330, len330));
                result331.push(result330);
              }
              var ptr332 = dataView(memory0).getUint32(base + 24, true);
              var len332 = dataView(memory0).getUint32(base + 28, true);
              var result332 = new Uint32Array(memory0.buffer.slice(ptr332, ptr332 + len332 * 4));
              variant368= {
                tag: 'named-tuple',
                val: {
                  typeName: result329,
                  fieldNames: result331,
                  items: result332,
                }
              };
              break;
            }
            case 13: {
              var len333 = dataView(memory0).getUint32(base + 12, true);
              var base333 = dataView(memory0).getUint32(base + 8, true);
              var result333 = [];
              for (let i = 0; i < len333; i++) {
                const base = base333 + i * 8;
                result333.push({
                  key: dataView(memory0).getInt32(base + 0, true) >>> 0,
                  value: dataView(memory0).getInt32(base + 4, true) >>> 0,
                });
              }
              variant368= {
                tag: 'dict',
                val: result333
              };
              break;
            }
            case 14: {
              var ptr334 = dataView(memory0).getUint32(base + 8, true);
              var len334 = dataView(memory0).getUint32(base + 12, true);
              var result334 = new Uint32Array(memory0.buffer.slice(ptr334, ptr334 + len334 * 4));
              variant368= {
                tag: 'set',
                val: result334
              };
              break;
            }
            case 15: {
              var ptr335 = dataView(memory0).getUint32(base + 8, true);
              var len335 = dataView(memory0).getUint32(base + 12, true);
              var result335 = new Uint32Array(memory0.buffer.slice(ptr335, ptr335 + len335 * 4));
              variant368= {
                tag: 'frozen-set',
                val: result335
              };
              break;
            }
            case 16: {
              variant368= {
                tag: 'date',
                val: {
                  year: dataView(memory0).getInt32(base + 8, true),
                  month: clampGuest(dataView(memory0).getUint8(base + 12, true), 0, 255),
                  day: clampGuest(dataView(memory0).getUint8(base + 13, true), 0, 255),
                }
              };
              break;
            }
            case 17: {
              let variant336;
              switch (dataView(memory0).getUint8(base + 24, true)) {
                case 0: {
                  variant336 = undefined;
                  break;
                }
                case 1: {
                  variant336 = dataView(memory0).getInt32(base + 28, true);
                  break;
                }
                default: {
                  throw new TypeError('invalid variant discriminant for option');
                }
              }
              let variant338;
              switch (dataView(memory0).getUint8(base + 32, true)) {
                case 0: {
                  variant338 = undefined;
                  break;
                }
                case 1: {
                  var ptr337 = dataView(memory0).getUint32(base + 36, true);
                  var len337 = dataView(memory0).getUint32(base + 40, true);
                  var result337 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr337, len337));
                  variant338 = result337;
                  break;
                }
                default: {
                  throw new TypeError('invalid variant discriminant for option');
                }
              }
              variant368= {
                tag: 'datetime',
                val: {
                  year: dataView(memory0).getInt32(base + 8, true),
                  month: clampGuest(dataView(memory0).getUint8(base + 12, true), 0, 255),
                  day: clampGuest(dataView(memory0).getUint8(base + 13, true), 0, 255),
                  hour: clampGuest(dataView(memory0).getUint8(base + 14, true), 0, 255),
                  minute: clampGuest(dataView(memory0).getUint8(base + 15, true), 0, 255),
                  second: clampGuest(dataView(memory0).getUint8(base + 16, true), 0, 255),
                  microsecond: dataView(memory0).getInt32(base + 20, true) >>> 0,
                  offsetSeconds: variant336,
                  timezoneName: variant338,
                }
              };
              break;
            }
            case 18: {
              let variant339;
              switch (dataView(memory0).getUint8(base + 16, true)) {
                case 0: {
                  variant339 = undefined;
                  break;
                }
                case 1: {
                  variant339 = dataView(memory0).getInt32(base + 20, true);
                  break;
                }
                default: {
                  throw new TypeError('invalid variant discriminant for option');
                }
              }
              let variant341;
              switch (dataView(memory0).getUint8(base + 24, true)) {
                case 0: {
                  variant341 = undefined;
                  break;
                }
                case 1: {
                  var ptr340 = dataView(memory0).getUint32(base + 28, true);
                  var len340 = dataView(memory0).getUint32(base + 32, true);
                  var result340 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr340, len340));
                  variant341 = result340;
                  break;
                }
                default: {
                  throw new TypeError('invalid variant discriminant for option');
                }
              }
              variant368= {
                tag: 'time',
                val: {
                  hour: clampGuest(dataView(memory0).getUint8(base + 8, true), 0, 255),
                  minute: clampGuest(dataView(memory0).getUint8(base + 9, true), 0, 255),
                  second: clampGuest(dataView(memory0).getUint8(base + 10, true), 0, 255),
                  microsecond: dataView(memory0).getInt32(base + 12, true) >>> 0,
                  offsetSeconds: variant339,
                  timezoneName: variant341,
                  fold: clampGuest(dataView(memory0).getUint8(base + 36, true), 0, 255),
                }
              };
              break;
            }
            case 19: {
              variant368= {
                tag: 'timedelta',
                val: {
                  days: dataView(memory0).getInt32(base + 8, true),
                  seconds: dataView(memory0).getInt32(base + 12, true),
                  microseconds: dataView(memory0).getInt32(base + 16, true),
                }
              };
              break;
            }
            case 20: {
              let variant343;
              switch (dataView(memory0).getUint8(base + 12, true)) {
                case 0: {
                  variant343 = undefined;
                  break;
                }
                case 1: {
                  var ptr342 = dataView(memory0).getUint32(base + 16, true);
                  var len342 = dataView(memory0).getUint32(base + 20, true);
                  var result342 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr342, len342));
                  variant343 = result342;
                  break;
                }
                default: {
                  throw new TypeError('invalid variant discriminant for option');
                }
              }
              variant368= {
                tag: 'timezone',
                val: {
                  offsetSeconds: dataView(memory0).getInt32(base + 8, true),
                  name: variant343,
                }
              };
              break;
            }
            case 21: {
              var ptr344 = dataView(memory0).getUint32(base + 8, true);
              var len344 = dataView(memory0).getUint32(base + 12, true);
              var result344 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr344, len344));
              let variant346;
              switch (dataView(memory0).getUint8(base + 16, true)) {
                case 0: {
                  variant346 = undefined;
                  break;
                }
                case 1: {
                  var ptr345 = dataView(memory0).getUint32(base + 20, true);
                  var len345 = dataView(memory0).getUint32(base + 24, true);
                  var result345 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr345, len345));
                  variant346 = result345;
                  break;
                }
                default: {
                  throw new TypeError('invalid variant discriminant for option');
                }
              }
              variant368= {
                tag: 'exception',
                val: {
                  excType: result344,
                  message: variant346,
                }
              };
              break;
            }
            case 22: {
              var ptr347 = dataView(memory0).getUint32(base + 8, true);
              var len347 = dataView(memory0).getUint32(base + 12, true);
              var result347 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr347, len347));
              variant368= {
                tag: 'type-name',
                val: result347
              };
              break;
            }
            case 23: {
              var ptr348 = dataView(memory0).getUint32(base + 8, true);
              var len348 = dataView(memory0).getUint32(base + 12, true);
              var result348 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr348, len348));
              var ptr349 = dataView(memory0).getUint32(base + 16, true);
              var len349 = dataView(memory0).getUint32(base + 20, true);
              var result349 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr349, len349));
              var bool350 = dataView(memory0).getUint8(base + 24, true);
              var bool351 = dataView(memory0).getUint8(base + 25, true);
              var len352 = dataView(memory0).getUint32(base + 32, true);
              var base352 = dataView(memory0).getUint32(base + 28, true);
              var result352 = [];
              for (let i = 0; i < len352; i++) {
                const base = base352 + i * 8;
                result352.push({
                  key: dataView(memory0).getInt32(base + 0, true) >>> 0,
                  value: dataView(memory0).getInt32(base + 4, true) >>> 0,
                });
              }
              variant368= {
                tag: 'class-type',
                val: {
                  name: result348,
                  id: result349,
                  hostDefined: bool350 == 0 ? false : (bool350 == 1 ? true : throwInvalidBool()),
                  isDataclass: bool351 == 0 ? false : (bool351 == 1 ? true : throwInvalidBool()),
                  attrs: result352,
                }
              };
              break;
            }
            case 24: {
              var ptr353 = dataView(memory0).getUint32(base + 8, true);
              var len353 = dataView(memory0).getUint32(base + 12, true);
              var result353 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr353, len353));
              variant368= {
                tag: 'builtin-function',
                val: result353
              };
              break;
            }
            case 25: {
              var ptr354 = dataView(memory0).getUint32(base + 8, true);
              var len354 = dataView(memory0).getUint32(base + 12, true);
              var result354 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr354, len354));
              variant368= {
                tag: 'path',
                val: result354
              };
              break;
            }
            case 26: {
              var ptr355 = dataView(memory0).getUint32(base + 8, true);
              var len355 = dataView(memory0).getUint32(base + 12, true);
              var result355 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr355, len355));
              var ptr356 = dataView(memory0).getUint32(base + 16, true);
              var len356 = dataView(memory0).getUint32(base + 20, true);
              var result356 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr356, len356));
              variant368= {
                tag: 'file-handle',
                val: {
                  path: result355,
                  mode: result356,
                  position: BigInt.asUintN(64, BigInt(dataView(memory0).getBigInt64(base + 24, true))),
                }
              };
              break;
            }
            case 27: {
              var ptr357 = dataView(memory0).getUint32(base + 12, true);
              var len357 = dataView(memory0).getUint32(base + 16, true);
              var result357 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr357, len357));
              var len358 = dataView(memory0).getUint32(base + 24, true);
              var base358 = dataView(memory0).getUint32(base + 20, true);
              var result358 = [];
              for (let i = 0; i < len358; i++) {
                const base = base358 + i * 8;
                result358.push({
                  key: dataView(memory0).getInt32(base + 0, true) >>> 0,
                  value: dataView(memory0).getInt32(base + 4, true) >>> 0,
                });
              }
              variant368= {
                tag: 'class-instance',
                val: {
                  classType: dataView(memory0).getInt32(base + 8, true) >>> 0,
                  instanceId: result357,
                  attrs: result358,
                }
              };
              break;
            }
            case 28: {
              var ptr359 = dataView(memory0).getUint32(base + 8, true);
              var len359 = dataView(memory0).getUint32(base + 12, true);
              var result359 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr359, len359));
              let variant361;
              switch (dataView(memory0).getUint8(base + 16, true)) {
                case 0: {
                  variant361 = undefined;
                  break;
                }
                case 1: {
                  var ptr360 = dataView(memory0).getUint32(base + 20, true);
                  var len360 = dataView(memory0).getUint32(base + 24, true);
                  var result360 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr360, len360));
                  variant361 = result360;
                  break;
                }
                default: {
                  throw new TypeError('invalid variant discriminant for option');
                }
              }
              variant368= {
                tag: 'function',
                val: {
                  name: result359,
                  docstring: variant361,
                }
              };
              break;
            }
            case 29: {
              var ptr362 = dataView(memory0).getUint32(base + 8, true);
              var len362 = dataView(memory0).getUint32(base + 12, true);
              var result362 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr362, len362));
              variant368= {
                tag: 'repr',
                val: result362
              };
              break;
            }
            case 30: {
              var ptr363 = dataView(memory0).getUint32(base + 8, true);
              var len363 = dataView(memory0).getUint32(base + 12, true);
              var result363 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr363, len363));
              variant368= {
                tag: 'cycle',
                val: result363
              };
              break;
            }
            case 31: {
              var ptr364 = dataView(memory0).getUint32(base + 8, true);
              var len364 = dataView(memory0).getUint32(base + 12, true);
              var result364 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr364, len364));
              var ptr365 = dataView(memory0).getUint32(base + 16, true);
              var len365 = dataView(memory0).getUint32(base + 20, true);
              var result365 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr365, len365));
              var len366 = dataView(memory0).getUint32(base + 28, true);
              var base366 = dataView(memory0).getUint32(base + 24, true);
              var result366 = [];
              for (let i = 0; i < len366; i++) {
                const base = base366 + i * 8;
                result366.push({
                  key: dataView(memory0).getInt32(base + 0, true) >>> 0,
                  value: dataView(memory0).getInt32(base + 4, true) >>> 0,
                });
              }
              variant368= {
                tag: 'module',
                val: {
                  name: result364,
                  id: result365,
                  attrs: result366,
                }
              };
              break;
            }
            case 32: {
              var ptr367 = dataView(memory0).getUint32(base + 8, true);
              var len367 = dataView(memory0).getUint32(base + 12, true);
              var result367 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr367, len367));
              variant368= {
                tag: 'decimal',
                val: result367
              };
              break;
            }
            default: {
              throw new TypeError('invalid variant discriminant for ValueNode');
            }
          }
          result369.push(variant368);
        }
        var ptr370 = dataView(memory0).getUint32(base + 24, true);
        var len370 = dataView(memory0).getUint32(base + 28, true);
        var result370 = new Uint32Array(memory0.buffer.slice(ptr370, ptr370 + len370 * 4));
        var len371 = dataView(memory0).getUint32(base + 36, true);
        var base371 = dataView(memory0).getUint32(base + 32, true);
        var result371 = [];
        for (let i = 0; i < len371; i++) {
          const base = base371 + i * 8;
          result371.push({
            key: dataView(memory0).getInt32(base + 0, true) >>> 0,
            value: dataView(memory0).getInt32(base + 4, true) >>> 0,
          });
        }
        let variant373;
        switch (dataView(memory0).getUint8(base + 44, true)) {
          case 0: {
            variant373 = undefined;
            break;
          }
          case 1: {
            var ptr372 = dataView(memory0).getUint32(base + 48, true);
            var len372 = dataView(memory0).getUint32(base + 52, true);
            var result372 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr372, len372));
            variant373 = result372;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        var bool374 = dataView(memory0).getUint8(base + 56, true);
        var ptr375 = dataView(memory0).getUint32(base + 60, true);
        var len375 = dataView(memory0).getUint32(base + 64, true);
        var result375 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr375, len375));
        variant498= {
          tag: 'function-call',
          val: {
            functionName: result322,
            values: {
              nodes: result369,
            },
            args: result370,
            kwargs: result371,
            callId: dataView(memory0).getInt32(base + 40, true) >>> 0,
            objectId: variant373,
            allowEagerAwait: bool374 == 0 ? false : (bool374 == 1 ? true : throwInvalidBool()),
            position: {
              filename: result375,
              start: dataView(memory0).getInt32(base + 68, true) >>> 0,
              end: dataView(memory0).getInt32(base + 72, true) >>> 0,
            },
          }
        };
        break;
      }
      case 2: {
        var ptr376 = dataView(memory0).getUint32(base + 8, true);
        var len376 = dataView(memory0).getUint32(base + 12, true);
        var result376 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr376, len376));
        var len423 = dataView(memory0).getUint32(base + 20, true);
        var base423 = dataView(memory0).getUint32(base + 16, true);
        var result423 = [];
        for (let i = 0; i < len423; i++) {
          const base = base423 + i * 48;
          let variant422;
          switch (dataView(memory0).getUint8(base + 0, true)) {
            case 0: {
              variant422= {
                tag: 'ellipsis',
              };
              break;
            }
            case 1: {
              variant422= {
                tag: 'not-implemented',
              };
              break;
            }
            case 2: {
              variant422= {
                tag: 'none',
              };
              break;
            }
            case 3: {
              var bool377 = dataView(memory0).getUint8(base + 8, true);
              variant422= {
                tag: 'boolean',
                val: bool377 == 0 ? false : (bool377 == 1 ? true : throwInvalidBool())
              };
              break;
            }
            case 4: {
              variant422= {
                tag: 'integer',
                val: dataView(memory0).getBigInt64(base + 8, true)
              };
              break;
            }
            case 5: {
              var ptr378 = dataView(memory0).getUint32(base + 8, true);
              var len378 = dataView(memory0).getUint32(base + 12, true);
              var result378 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr378, len378));
              variant422= {
                tag: 'bigint',
                val: result378
              };
              break;
            }
            case 6: {
              variant422= {
                tag: 'float',
                val: dataView(memory0).getFloat64(base + 8, true)
              };
              break;
            }
            case 7: {
              variant422= {
                tag: 'complex',
                val: {
                  real: dataView(memory0).getFloat64(base + 8, true),
                  imag: dataView(memory0).getFloat64(base + 16, true),
                }
              };
              break;
            }
            case 8: {
              var ptr379 = dataView(memory0).getUint32(base + 8, true);
              var len379 = dataView(memory0).getUint32(base + 12, true);
              var result379 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr379, len379));
              variant422= {
                tag: 'text',
                val: result379
              };
              break;
            }
            case 9: {
              var ptr380 = dataView(memory0).getUint32(base + 8, true);
              var len380 = dataView(memory0).getUint32(base + 12, true);
              var result380 = new Uint8Array(memory0.buffer.slice(ptr380, ptr380 + len380 * 1));
              variant422= {
                tag: 'bytes',
                val: result380
              };
              break;
            }
            case 10: {
              var ptr381 = dataView(memory0).getUint32(base + 8, true);
              var len381 = dataView(memory0).getUint32(base + 12, true);
              var result381 = new Uint32Array(memory0.buffer.slice(ptr381, ptr381 + len381 * 4));
              variant422= {
                tag: 'list-value',
                val: result381
              };
              break;
            }
            case 11: {
              var ptr382 = dataView(memory0).getUint32(base + 8, true);
              var len382 = dataView(memory0).getUint32(base + 12, true);
              var result382 = new Uint32Array(memory0.buffer.slice(ptr382, ptr382 + len382 * 4));
              variant422= {
                tag: 'tuple-value',
                val: result382
              };
              break;
            }
            case 12: {
              var ptr383 = dataView(memory0).getUint32(base + 8, true);
              var len383 = dataView(memory0).getUint32(base + 12, true);
              var result383 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr383, len383));
              var len385 = dataView(memory0).getUint32(base + 20, true);
              var base385 = dataView(memory0).getUint32(base + 16, true);
              var result385 = [];
              for (let i = 0; i < len385; i++) {
                const base = base385 + i * 8;
                var ptr384 = dataView(memory0).getUint32(base + 0, true);
                var len384 = dataView(memory0).getUint32(base + 4, true);
                var result384 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr384, len384));
                result385.push(result384);
              }
              var ptr386 = dataView(memory0).getUint32(base + 24, true);
              var len386 = dataView(memory0).getUint32(base + 28, true);
              var result386 = new Uint32Array(memory0.buffer.slice(ptr386, ptr386 + len386 * 4));
              variant422= {
                tag: 'named-tuple',
                val: {
                  typeName: result383,
                  fieldNames: result385,
                  items: result386,
                }
              };
              break;
            }
            case 13: {
              var len387 = dataView(memory0).getUint32(base + 12, true);
              var base387 = dataView(memory0).getUint32(base + 8, true);
              var result387 = [];
              for (let i = 0; i < len387; i++) {
                const base = base387 + i * 8;
                result387.push({
                  key: dataView(memory0).getInt32(base + 0, true) >>> 0,
                  value: dataView(memory0).getInt32(base + 4, true) >>> 0,
                });
              }
              variant422= {
                tag: 'dict',
                val: result387
              };
              break;
            }
            case 14: {
              var ptr388 = dataView(memory0).getUint32(base + 8, true);
              var len388 = dataView(memory0).getUint32(base + 12, true);
              var result388 = new Uint32Array(memory0.buffer.slice(ptr388, ptr388 + len388 * 4));
              variant422= {
                tag: 'set',
                val: result388
              };
              break;
            }
            case 15: {
              var ptr389 = dataView(memory0).getUint32(base + 8, true);
              var len389 = dataView(memory0).getUint32(base + 12, true);
              var result389 = new Uint32Array(memory0.buffer.slice(ptr389, ptr389 + len389 * 4));
              variant422= {
                tag: 'frozen-set',
                val: result389
              };
              break;
            }
            case 16: {
              variant422= {
                tag: 'date',
                val: {
                  year: dataView(memory0).getInt32(base + 8, true),
                  month: clampGuest(dataView(memory0).getUint8(base + 12, true), 0, 255),
                  day: clampGuest(dataView(memory0).getUint8(base + 13, true), 0, 255),
                }
              };
              break;
            }
            case 17: {
              let variant390;
              switch (dataView(memory0).getUint8(base + 24, true)) {
                case 0: {
                  variant390 = undefined;
                  break;
                }
                case 1: {
                  variant390 = dataView(memory0).getInt32(base + 28, true);
                  break;
                }
                default: {
                  throw new TypeError('invalid variant discriminant for option');
                }
              }
              let variant392;
              switch (dataView(memory0).getUint8(base + 32, true)) {
                case 0: {
                  variant392 = undefined;
                  break;
                }
                case 1: {
                  var ptr391 = dataView(memory0).getUint32(base + 36, true);
                  var len391 = dataView(memory0).getUint32(base + 40, true);
                  var result391 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr391, len391));
                  variant392 = result391;
                  break;
                }
                default: {
                  throw new TypeError('invalid variant discriminant for option');
                }
              }
              variant422= {
                tag: 'datetime',
                val: {
                  year: dataView(memory0).getInt32(base + 8, true),
                  month: clampGuest(dataView(memory0).getUint8(base + 12, true), 0, 255),
                  day: clampGuest(dataView(memory0).getUint8(base + 13, true), 0, 255),
                  hour: clampGuest(dataView(memory0).getUint8(base + 14, true), 0, 255),
                  minute: clampGuest(dataView(memory0).getUint8(base + 15, true), 0, 255),
                  second: clampGuest(dataView(memory0).getUint8(base + 16, true), 0, 255),
                  microsecond: dataView(memory0).getInt32(base + 20, true) >>> 0,
                  offsetSeconds: variant390,
                  timezoneName: variant392,
                }
              };
              break;
            }
            case 18: {
              let variant393;
              switch (dataView(memory0).getUint8(base + 16, true)) {
                case 0: {
                  variant393 = undefined;
                  break;
                }
                case 1: {
                  variant393 = dataView(memory0).getInt32(base + 20, true);
                  break;
                }
                default: {
                  throw new TypeError('invalid variant discriminant for option');
                }
              }
              let variant395;
              switch (dataView(memory0).getUint8(base + 24, true)) {
                case 0: {
                  variant395 = undefined;
                  break;
                }
                case 1: {
                  var ptr394 = dataView(memory0).getUint32(base + 28, true);
                  var len394 = dataView(memory0).getUint32(base + 32, true);
                  var result394 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr394, len394));
                  variant395 = result394;
                  break;
                }
                default: {
                  throw new TypeError('invalid variant discriminant for option');
                }
              }
              variant422= {
                tag: 'time',
                val: {
                  hour: clampGuest(dataView(memory0).getUint8(base + 8, true), 0, 255),
                  minute: clampGuest(dataView(memory0).getUint8(base + 9, true), 0, 255),
                  second: clampGuest(dataView(memory0).getUint8(base + 10, true), 0, 255),
                  microsecond: dataView(memory0).getInt32(base + 12, true) >>> 0,
                  offsetSeconds: variant393,
                  timezoneName: variant395,
                  fold: clampGuest(dataView(memory0).getUint8(base + 36, true), 0, 255),
                }
              };
              break;
            }
            case 19: {
              variant422= {
                tag: 'timedelta',
                val: {
                  days: dataView(memory0).getInt32(base + 8, true),
                  seconds: dataView(memory0).getInt32(base + 12, true),
                  microseconds: dataView(memory0).getInt32(base + 16, true),
                }
              };
              break;
            }
            case 20: {
              let variant397;
              switch (dataView(memory0).getUint8(base + 12, true)) {
                case 0: {
                  variant397 = undefined;
                  break;
                }
                case 1: {
                  var ptr396 = dataView(memory0).getUint32(base + 16, true);
                  var len396 = dataView(memory0).getUint32(base + 20, true);
                  var result396 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr396, len396));
                  variant397 = result396;
                  break;
                }
                default: {
                  throw new TypeError('invalid variant discriminant for option');
                }
              }
              variant422= {
                tag: 'timezone',
                val: {
                  offsetSeconds: dataView(memory0).getInt32(base + 8, true),
                  name: variant397,
                }
              };
              break;
            }
            case 21: {
              var ptr398 = dataView(memory0).getUint32(base + 8, true);
              var len398 = dataView(memory0).getUint32(base + 12, true);
              var result398 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr398, len398));
              let variant400;
              switch (dataView(memory0).getUint8(base + 16, true)) {
                case 0: {
                  variant400 = undefined;
                  break;
                }
                case 1: {
                  var ptr399 = dataView(memory0).getUint32(base + 20, true);
                  var len399 = dataView(memory0).getUint32(base + 24, true);
                  var result399 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr399, len399));
                  variant400 = result399;
                  break;
                }
                default: {
                  throw new TypeError('invalid variant discriminant for option');
                }
              }
              variant422= {
                tag: 'exception',
                val: {
                  excType: result398,
                  message: variant400,
                }
              };
              break;
            }
            case 22: {
              var ptr401 = dataView(memory0).getUint32(base + 8, true);
              var len401 = dataView(memory0).getUint32(base + 12, true);
              var result401 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr401, len401));
              variant422= {
                tag: 'type-name',
                val: result401
              };
              break;
            }
            case 23: {
              var ptr402 = dataView(memory0).getUint32(base + 8, true);
              var len402 = dataView(memory0).getUint32(base + 12, true);
              var result402 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr402, len402));
              var ptr403 = dataView(memory0).getUint32(base + 16, true);
              var len403 = dataView(memory0).getUint32(base + 20, true);
              var result403 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr403, len403));
              var bool404 = dataView(memory0).getUint8(base + 24, true);
              var bool405 = dataView(memory0).getUint8(base + 25, true);
              var len406 = dataView(memory0).getUint32(base + 32, true);
              var base406 = dataView(memory0).getUint32(base + 28, true);
              var result406 = [];
              for (let i = 0; i < len406; i++) {
                const base = base406 + i * 8;
                result406.push({
                  key: dataView(memory0).getInt32(base + 0, true) >>> 0,
                  value: dataView(memory0).getInt32(base + 4, true) >>> 0,
                });
              }
              variant422= {
                tag: 'class-type',
                val: {
                  name: result402,
                  id: result403,
                  hostDefined: bool404 == 0 ? false : (bool404 == 1 ? true : throwInvalidBool()),
                  isDataclass: bool405 == 0 ? false : (bool405 == 1 ? true : throwInvalidBool()),
                  attrs: result406,
                }
              };
              break;
            }
            case 24: {
              var ptr407 = dataView(memory0).getUint32(base + 8, true);
              var len407 = dataView(memory0).getUint32(base + 12, true);
              var result407 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr407, len407));
              variant422= {
                tag: 'builtin-function',
                val: result407
              };
              break;
            }
            case 25: {
              var ptr408 = dataView(memory0).getUint32(base + 8, true);
              var len408 = dataView(memory0).getUint32(base + 12, true);
              var result408 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr408, len408));
              variant422= {
                tag: 'path',
                val: result408
              };
              break;
            }
            case 26: {
              var ptr409 = dataView(memory0).getUint32(base + 8, true);
              var len409 = dataView(memory0).getUint32(base + 12, true);
              var result409 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr409, len409));
              var ptr410 = dataView(memory0).getUint32(base + 16, true);
              var len410 = dataView(memory0).getUint32(base + 20, true);
              var result410 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr410, len410));
              variant422= {
                tag: 'file-handle',
                val: {
                  path: result409,
                  mode: result410,
                  position: BigInt.asUintN(64, BigInt(dataView(memory0).getBigInt64(base + 24, true))),
                }
              };
              break;
            }
            case 27: {
              var ptr411 = dataView(memory0).getUint32(base + 12, true);
              var len411 = dataView(memory0).getUint32(base + 16, true);
              var result411 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr411, len411));
              var len412 = dataView(memory0).getUint32(base + 24, true);
              var base412 = dataView(memory0).getUint32(base + 20, true);
              var result412 = [];
              for (let i = 0; i < len412; i++) {
                const base = base412 + i * 8;
                result412.push({
                  key: dataView(memory0).getInt32(base + 0, true) >>> 0,
                  value: dataView(memory0).getInt32(base + 4, true) >>> 0,
                });
              }
              variant422= {
                tag: 'class-instance',
                val: {
                  classType: dataView(memory0).getInt32(base + 8, true) >>> 0,
                  instanceId: result411,
                  attrs: result412,
                }
              };
              break;
            }
            case 28: {
              var ptr413 = dataView(memory0).getUint32(base + 8, true);
              var len413 = dataView(memory0).getUint32(base + 12, true);
              var result413 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr413, len413));
              let variant415;
              switch (dataView(memory0).getUint8(base + 16, true)) {
                case 0: {
                  variant415 = undefined;
                  break;
                }
                case 1: {
                  var ptr414 = dataView(memory0).getUint32(base + 20, true);
                  var len414 = dataView(memory0).getUint32(base + 24, true);
                  var result414 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr414, len414));
                  variant415 = result414;
                  break;
                }
                default: {
                  throw new TypeError('invalid variant discriminant for option');
                }
              }
              variant422= {
                tag: 'function',
                val: {
                  name: result413,
                  docstring: variant415,
                }
              };
              break;
            }
            case 29: {
              var ptr416 = dataView(memory0).getUint32(base + 8, true);
              var len416 = dataView(memory0).getUint32(base + 12, true);
              var result416 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr416, len416));
              variant422= {
                tag: 'repr',
                val: result416
              };
              break;
            }
            case 30: {
              var ptr417 = dataView(memory0).getUint32(base + 8, true);
              var len417 = dataView(memory0).getUint32(base + 12, true);
              var result417 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr417, len417));
              variant422= {
                tag: 'cycle',
                val: result417
              };
              break;
            }
            case 31: {
              var ptr418 = dataView(memory0).getUint32(base + 8, true);
              var len418 = dataView(memory0).getUint32(base + 12, true);
              var result418 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr418, len418));
              var ptr419 = dataView(memory0).getUint32(base + 16, true);
              var len419 = dataView(memory0).getUint32(base + 20, true);
              var result419 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr419, len419));
              var len420 = dataView(memory0).getUint32(base + 28, true);
              var base420 = dataView(memory0).getUint32(base + 24, true);
              var result420 = [];
              for (let i = 0; i < len420; i++) {
                const base = base420 + i * 8;
                result420.push({
                  key: dataView(memory0).getInt32(base + 0, true) >>> 0,
                  value: dataView(memory0).getInt32(base + 4, true) >>> 0,
                });
              }
              variant422= {
                tag: 'module',
                val: {
                  name: result418,
                  id: result419,
                  attrs: result420,
                }
              };
              break;
            }
            case 32: {
              var ptr421 = dataView(memory0).getUint32(base + 8, true);
              var len421 = dataView(memory0).getUint32(base + 12, true);
              var result421 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr421, len421));
              variant422= {
                tag: 'decimal',
                val: result421
              };
              break;
            }
            default: {
              throw new TypeError('invalid variant discriminant for ValueNode');
            }
          }
          result423.push(variant422);
        }
        var ptr424 = dataView(memory0).getUint32(base + 24, true);
        var len424 = dataView(memory0).getUint32(base + 28, true);
        var result424 = new Uint32Array(memory0.buffer.slice(ptr424, ptr424 + len424 * 4));
        var len425 = dataView(memory0).getUint32(base + 36, true);
        var base425 = dataView(memory0).getUint32(base + 32, true);
        var result425 = [];
        for (let i = 0; i < len425; i++) {
          const base = base425 + i * 8;
          result425.push({
            key: dataView(memory0).getInt32(base + 0, true) >>> 0,
            value: dataView(memory0).getInt32(base + 4, true) >>> 0,
          });
        }
        var bool426 = dataView(memory0).getUint8(base + 44, true);
        let variant427;
        switch (dataView(memory0).getUint8(base + 48, true)) {
          case 0: {
            variant427 = undefined;
            break;
          }
          case 1: {
            variant427 = dataView(memory0).getFloat64(base + 56, true);
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        var ptr428 = dataView(memory0).getUint32(base + 64, true);
        var len428 = dataView(memory0).getUint32(base + 68, true);
        var result428 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr428, len428));
        variant498= {
          tag: 'os-call',
          val: {
            functionName: result376,
            values: {
              nodes: result423,
            },
            args: result424,
            kwargs: result425,
            callId: dataView(memory0).getInt32(base + 40, true) >>> 0,
            allowEagerAwait: bool426 == 0 ? false : (bool426 == 1 ? true : throwInvalidBool()),
            systemSleepSecs: variant427,
            position: {
              filename: result428,
              start: dataView(memory0).getInt32(base + 72, true) >>> 0,
              end: dataView(memory0).getInt32(base + 76, true) >>> 0,
            },
          }
        };
        break;
      }
      case 3: {
        var ptr429 = dataView(memory0).getUint32(base + 8, true);
        var len429 = dataView(memory0).getUint32(base + 12, true);
        var result429 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr429, len429));
        let variant431;
        switch (dataView(memory0).getUint8(base + 16, true)) {
          case 0: {
            variant431 = undefined;
            break;
          }
          case 1: {
            var ptr430 = dataView(memory0).getUint32(base + 20, true);
            var len430 = dataView(memory0).getUint32(base + 24, true);
            var result430 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr430, len430));
            variant431 = result430;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        var ptr432 = dataView(memory0).getUint32(base + 28, true);
        var len432 = dataView(memory0).getUint32(base + 32, true);
        var result432 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr432, len432));
        variant498= {
          tag: 'name-lookup',
          val: {
            name: result429,
            objectId: variant431,
            position: {
              filename: result432,
              start: dataView(memory0).getInt32(base + 36, true) >>> 0,
              end: dataView(memory0).getInt32(base + 40, true) >>> 0,
            },
          }
        };
        break;
      }
      case 4: {
        var ptr433 = dataView(memory0).getUint32(base + 8, true);
        var len433 = dataView(memory0).getUint32(base + 12, true);
        var result433 = new Uint32Array(memory0.buffer.slice(ptr433, ptr433 + len433 * 4));
        var ptr434 = dataView(memory0).getUint32(base + 16, true);
        var len434 = dataView(memory0).getUint32(base + 20, true);
        var result434 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr434, len434));
        variant498= {
          tag: 'resolve-futures',
          val: {
            pendingCallIds: result433,
            position: {
              filename: result434,
              start: dataView(memory0).getInt32(base + 24, true) >>> 0,
              end: dataView(memory0).getInt32(base + 28, true) >>> 0,
            },
          }
        };
        break;
      }
      case 5: {
        var len481 = dataView(memory0).getUint32(base + 12, true);
        var base481 = dataView(memory0).getUint32(base + 8, true);
        var result481 = [];
        for (let i = 0; i < len481; i++) {
          const base = base481 + i * 48;
          let variant480;
          switch (dataView(memory0).getUint8(base + 0, true)) {
            case 0: {
              variant480= {
                tag: 'ellipsis',
              };
              break;
            }
            case 1: {
              variant480= {
                tag: 'not-implemented',
              };
              break;
            }
            case 2: {
              variant480= {
                tag: 'none',
              };
              break;
            }
            case 3: {
              var bool435 = dataView(memory0).getUint8(base + 8, true);
              variant480= {
                tag: 'boolean',
                val: bool435 == 0 ? false : (bool435 == 1 ? true : throwInvalidBool())
              };
              break;
            }
            case 4: {
              variant480= {
                tag: 'integer',
                val: dataView(memory0).getBigInt64(base + 8, true)
              };
              break;
            }
            case 5: {
              var ptr436 = dataView(memory0).getUint32(base + 8, true);
              var len436 = dataView(memory0).getUint32(base + 12, true);
              var result436 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr436, len436));
              variant480= {
                tag: 'bigint',
                val: result436
              };
              break;
            }
            case 6: {
              variant480= {
                tag: 'float',
                val: dataView(memory0).getFloat64(base + 8, true)
              };
              break;
            }
            case 7: {
              variant480= {
                tag: 'complex',
                val: {
                  real: dataView(memory0).getFloat64(base + 8, true),
                  imag: dataView(memory0).getFloat64(base + 16, true),
                }
              };
              break;
            }
            case 8: {
              var ptr437 = dataView(memory0).getUint32(base + 8, true);
              var len437 = dataView(memory0).getUint32(base + 12, true);
              var result437 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr437, len437));
              variant480= {
                tag: 'text',
                val: result437
              };
              break;
            }
            case 9: {
              var ptr438 = dataView(memory0).getUint32(base + 8, true);
              var len438 = dataView(memory0).getUint32(base + 12, true);
              var result438 = new Uint8Array(memory0.buffer.slice(ptr438, ptr438 + len438 * 1));
              variant480= {
                tag: 'bytes',
                val: result438
              };
              break;
            }
            case 10: {
              var ptr439 = dataView(memory0).getUint32(base + 8, true);
              var len439 = dataView(memory0).getUint32(base + 12, true);
              var result439 = new Uint32Array(memory0.buffer.slice(ptr439, ptr439 + len439 * 4));
              variant480= {
                tag: 'list-value',
                val: result439
              };
              break;
            }
            case 11: {
              var ptr440 = dataView(memory0).getUint32(base + 8, true);
              var len440 = dataView(memory0).getUint32(base + 12, true);
              var result440 = new Uint32Array(memory0.buffer.slice(ptr440, ptr440 + len440 * 4));
              variant480= {
                tag: 'tuple-value',
                val: result440
              };
              break;
            }
            case 12: {
              var ptr441 = dataView(memory0).getUint32(base + 8, true);
              var len441 = dataView(memory0).getUint32(base + 12, true);
              var result441 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr441, len441));
              var len443 = dataView(memory0).getUint32(base + 20, true);
              var base443 = dataView(memory0).getUint32(base + 16, true);
              var result443 = [];
              for (let i = 0; i < len443; i++) {
                const base = base443 + i * 8;
                var ptr442 = dataView(memory0).getUint32(base + 0, true);
                var len442 = dataView(memory0).getUint32(base + 4, true);
                var result442 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr442, len442));
                result443.push(result442);
              }
              var ptr444 = dataView(memory0).getUint32(base + 24, true);
              var len444 = dataView(memory0).getUint32(base + 28, true);
              var result444 = new Uint32Array(memory0.buffer.slice(ptr444, ptr444 + len444 * 4));
              variant480= {
                tag: 'named-tuple',
                val: {
                  typeName: result441,
                  fieldNames: result443,
                  items: result444,
                }
              };
              break;
            }
            case 13: {
              var len445 = dataView(memory0).getUint32(base + 12, true);
              var base445 = dataView(memory0).getUint32(base + 8, true);
              var result445 = [];
              for (let i = 0; i < len445; i++) {
                const base = base445 + i * 8;
                result445.push({
                  key: dataView(memory0).getInt32(base + 0, true) >>> 0,
                  value: dataView(memory0).getInt32(base + 4, true) >>> 0,
                });
              }
              variant480= {
                tag: 'dict',
                val: result445
              };
              break;
            }
            case 14: {
              var ptr446 = dataView(memory0).getUint32(base + 8, true);
              var len446 = dataView(memory0).getUint32(base + 12, true);
              var result446 = new Uint32Array(memory0.buffer.slice(ptr446, ptr446 + len446 * 4));
              variant480= {
                tag: 'set',
                val: result446
              };
              break;
            }
            case 15: {
              var ptr447 = dataView(memory0).getUint32(base + 8, true);
              var len447 = dataView(memory0).getUint32(base + 12, true);
              var result447 = new Uint32Array(memory0.buffer.slice(ptr447, ptr447 + len447 * 4));
              variant480= {
                tag: 'frozen-set',
                val: result447
              };
              break;
            }
            case 16: {
              variant480= {
                tag: 'date',
                val: {
                  year: dataView(memory0).getInt32(base + 8, true),
                  month: clampGuest(dataView(memory0).getUint8(base + 12, true), 0, 255),
                  day: clampGuest(dataView(memory0).getUint8(base + 13, true), 0, 255),
                }
              };
              break;
            }
            case 17: {
              let variant448;
              switch (dataView(memory0).getUint8(base + 24, true)) {
                case 0: {
                  variant448 = undefined;
                  break;
                }
                case 1: {
                  variant448 = dataView(memory0).getInt32(base + 28, true);
                  break;
                }
                default: {
                  throw new TypeError('invalid variant discriminant for option');
                }
              }
              let variant450;
              switch (dataView(memory0).getUint8(base + 32, true)) {
                case 0: {
                  variant450 = undefined;
                  break;
                }
                case 1: {
                  var ptr449 = dataView(memory0).getUint32(base + 36, true);
                  var len449 = dataView(memory0).getUint32(base + 40, true);
                  var result449 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr449, len449));
                  variant450 = result449;
                  break;
                }
                default: {
                  throw new TypeError('invalid variant discriminant for option');
                }
              }
              variant480= {
                tag: 'datetime',
                val: {
                  year: dataView(memory0).getInt32(base + 8, true),
                  month: clampGuest(dataView(memory0).getUint8(base + 12, true), 0, 255),
                  day: clampGuest(dataView(memory0).getUint8(base + 13, true), 0, 255),
                  hour: clampGuest(dataView(memory0).getUint8(base + 14, true), 0, 255),
                  minute: clampGuest(dataView(memory0).getUint8(base + 15, true), 0, 255),
                  second: clampGuest(dataView(memory0).getUint8(base + 16, true), 0, 255),
                  microsecond: dataView(memory0).getInt32(base + 20, true) >>> 0,
                  offsetSeconds: variant448,
                  timezoneName: variant450,
                }
              };
              break;
            }
            case 18: {
              let variant451;
              switch (dataView(memory0).getUint8(base + 16, true)) {
                case 0: {
                  variant451 = undefined;
                  break;
                }
                case 1: {
                  variant451 = dataView(memory0).getInt32(base + 20, true);
                  break;
                }
                default: {
                  throw new TypeError('invalid variant discriminant for option');
                }
              }
              let variant453;
              switch (dataView(memory0).getUint8(base + 24, true)) {
                case 0: {
                  variant453 = undefined;
                  break;
                }
                case 1: {
                  var ptr452 = dataView(memory0).getUint32(base + 28, true);
                  var len452 = dataView(memory0).getUint32(base + 32, true);
                  var result452 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr452, len452));
                  variant453 = result452;
                  break;
                }
                default: {
                  throw new TypeError('invalid variant discriminant for option');
                }
              }
              variant480= {
                tag: 'time',
                val: {
                  hour: clampGuest(dataView(memory0).getUint8(base + 8, true), 0, 255),
                  minute: clampGuest(dataView(memory0).getUint8(base + 9, true), 0, 255),
                  second: clampGuest(dataView(memory0).getUint8(base + 10, true), 0, 255),
                  microsecond: dataView(memory0).getInt32(base + 12, true) >>> 0,
                  offsetSeconds: variant451,
                  timezoneName: variant453,
                  fold: clampGuest(dataView(memory0).getUint8(base + 36, true), 0, 255),
                }
              };
              break;
            }
            case 19: {
              variant480= {
                tag: 'timedelta',
                val: {
                  days: dataView(memory0).getInt32(base + 8, true),
                  seconds: dataView(memory0).getInt32(base + 12, true),
                  microseconds: dataView(memory0).getInt32(base + 16, true),
                }
              };
              break;
            }
            case 20: {
              let variant455;
              switch (dataView(memory0).getUint8(base + 12, true)) {
                case 0: {
                  variant455 = undefined;
                  break;
                }
                case 1: {
                  var ptr454 = dataView(memory0).getUint32(base + 16, true);
                  var len454 = dataView(memory0).getUint32(base + 20, true);
                  var result454 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr454, len454));
                  variant455 = result454;
                  break;
                }
                default: {
                  throw new TypeError('invalid variant discriminant for option');
                }
              }
              variant480= {
                tag: 'timezone',
                val: {
                  offsetSeconds: dataView(memory0).getInt32(base + 8, true),
                  name: variant455,
                }
              };
              break;
            }
            case 21: {
              var ptr456 = dataView(memory0).getUint32(base + 8, true);
              var len456 = dataView(memory0).getUint32(base + 12, true);
              var result456 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr456, len456));
              let variant458;
              switch (dataView(memory0).getUint8(base + 16, true)) {
                case 0: {
                  variant458 = undefined;
                  break;
                }
                case 1: {
                  var ptr457 = dataView(memory0).getUint32(base + 20, true);
                  var len457 = dataView(memory0).getUint32(base + 24, true);
                  var result457 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr457, len457));
                  variant458 = result457;
                  break;
                }
                default: {
                  throw new TypeError('invalid variant discriminant for option');
                }
              }
              variant480= {
                tag: 'exception',
                val: {
                  excType: result456,
                  message: variant458,
                }
              };
              break;
            }
            case 22: {
              var ptr459 = dataView(memory0).getUint32(base + 8, true);
              var len459 = dataView(memory0).getUint32(base + 12, true);
              var result459 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr459, len459));
              variant480= {
                tag: 'type-name',
                val: result459
              };
              break;
            }
            case 23: {
              var ptr460 = dataView(memory0).getUint32(base + 8, true);
              var len460 = dataView(memory0).getUint32(base + 12, true);
              var result460 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr460, len460));
              var ptr461 = dataView(memory0).getUint32(base + 16, true);
              var len461 = dataView(memory0).getUint32(base + 20, true);
              var result461 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr461, len461));
              var bool462 = dataView(memory0).getUint8(base + 24, true);
              var bool463 = dataView(memory0).getUint8(base + 25, true);
              var len464 = dataView(memory0).getUint32(base + 32, true);
              var base464 = dataView(memory0).getUint32(base + 28, true);
              var result464 = [];
              for (let i = 0; i < len464; i++) {
                const base = base464 + i * 8;
                result464.push({
                  key: dataView(memory0).getInt32(base + 0, true) >>> 0,
                  value: dataView(memory0).getInt32(base + 4, true) >>> 0,
                });
              }
              variant480= {
                tag: 'class-type',
                val: {
                  name: result460,
                  id: result461,
                  hostDefined: bool462 == 0 ? false : (bool462 == 1 ? true : throwInvalidBool()),
                  isDataclass: bool463 == 0 ? false : (bool463 == 1 ? true : throwInvalidBool()),
                  attrs: result464,
                }
              };
              break;
            }
            case 24: {
              var ptr465 = dataView(memory0).getUint32(base + 8, true);
              var len465 = dataView(memory0).getUint32(base + 12, true);
              var result465 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr465, len465));
              variant480= {
                tag: 'builtin-function',
                val: result465
              };
              break;
            }
            case 25: {
              var ptr466 = dataView(memory0).getUint32(base + 8, true);
              var len466 = dataView(memory0).getUint32(base + 12, true);
              var result466 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr466, len466));
              variant480= {
                tag: 'path',
                val: result466
              };
              break;
            }
            case 26: {
              var ptr467 = dataView(memory0).getUint32(base + 8, true);
              var len467 = dataView(memory0).getUint32(base + 12, true);
              var result467 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr467, len467));
              var ptr468 = dataView(memory0).getUint32(base + 16, true);
              var len468 = dataView(memory0).getUint32(base + 20, true);
              var result468 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr468, len468));
              variant480= {
                tag: 'file-handle',
                val: {
                  path: result467,
                  mode: result468,
                  position: BigInt.asUintN(64, BigInt(dataView(memory0).getBigInt64(base + 24, true))),
                }
              };
              break;
            }
            case 27: {
              var ptr469 = dataView(memory0).getUint32(base + 12, true);
              var len469 = dataView(memory0).getUint32(base + 16, true);
              var result469 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr469, len469));
              var len470 = dataView(memory0).getUint32(base + 24, true);
              var base470 = dataView(memory0).getUint32(base + 20, true);
              var result470 = [];
              for (let i = 0; i < len470; i++) {
                const base = base470 + i * 8;
                result470.push({
                  key: dataView(memory0).getInt32(base + 0, true) >>> 0,
                  value: dataView(memory0).getInt32(base + 4, true) >>> 0,
                });
              }
              variant480= {
                tag: 'class-instance',
                val: {
                  classType: dataView(memory0).getInt32(base + 8, true) >>> 0,
                  instanceId: result469,
                  attrs: result470,
                }
              };
              break;
            }
            case 28: {
              var ptr471 = dataView(memory0).getUint32(base + 8, true);
              var len471 = dataView(memory0).getUint32(base + 12, true);
              var result471 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr471, len471));
              let variant473;
              switch (dataView(memory0).getUint8(base + 16, true)) {
                case 0: {
                  variant473 = undefined;
                  break;
                }
                case 1: {
                  var ptr472 = dataView(memory0).getUint32(base + 20, true);
                  var len472 = dataView(memory0).getUint32(base + 24, true);
                  var result472 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr472, len472));
                  variant473 = result472;
                  break;
                }
                default: {
                  throw new TypeError('invalid variant discriminant for option');
                }
              }
              variant480= {
                tag: 'function',
                val: {
                  name: result471,
                  docstring: variant473,
                }
              };
              break;
            }
            case 29: {
              var ptr474 = dataView(memory0).getUint32(base + 8, true);
              var len474 = dataView(memory0).getUint32(base + 12, true);
              var result474 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr474, len474));
              variant480= {
                tag: 'repr',
                val: result474
              };
              break;
            }
            case 30: {
              var ptr475 = dataView(memory0).getUint32(base + 8, true);
              var len475 = dataView(memory0).getUint32(base + 12, true);
              var result475 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr475, len475));
              variant480= {
                tag: 'cycle',
                val: result475
              };
              break;
            }
            case 31: {
              var ptr476 = dataView(memory0).getUint32(base + 8, true);
              var len476 = dataView(memory0).getUint32(base + 12, true);
              var result476 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr476, len476));
              var ptr477 = dataView(memory0).getUint32(base + 16, true);
              var len477 = dataView(memory0).getUint32(base + 20, true);
              var result477 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr477, len477));
              var len478 = dataView(memory0).getUint32(base + 28, true);
              var base478 = dataView(memory0).getUint32(base + 24, true);
              var result478 = [];
              for (let i = 0; i < len478; i++) {
                const base = base478 + i * 8;
                result478.push({
                  key: dataView(memory0).getInt32(base + 0, true) >>> 0,
                  value: dataView(memory0).getInt32(base + 4, true) >>> 0,
                });
              }
              variant480= {
                tag: 'module',
                val: {
                  name: result476,
                  id: result477,
                  attrs: result478,
                }
              };
              break;
            }
            case 32: {
              var ptr479 = dataView(memory0).getUint32(base + 8, true);
              var len479 = dataView(memory0).getUint32(base + 12, true);
              var result479 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr479, len479));
              variant480= {
                tag: 'decimal',
                val: result479
              };
              break;
            }
            default: {
              throw new TypeError('invalid variant discriminant for ValueNode');
            }
          }
          result481.push(variant480);
        }
        variant498= {
          tag: 'complete',
          val: {
            values: {
              nodes: result481,
            },
            value: dataView(memory0).getInt32(base + 16, true) >>> 0,
          }
        };
        break;
      }
      case 6: {
        var ptr482 = dataView(memory0).getUint32(base + 8, true);
        var len482 = dataView(memory0).getUint32(base + 12, true);
        var result482 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr482, len482));
        var ptr483 = dataView(memory0).getUint32(base + 16, true);
        var len483 = dataView(memory0).getUint32(base + 20, true);
        var result483 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr483, len483));
        var ptr484 = dataView(memory0).getUint32(base + 24, true);
        var len484 = dataView(memory0).getUint32(base + 28, true);
        var result484 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr484, len484));
        var len492 = dataView(memory0).getUint32(base + 36, true);
        var base492 = dataView(memory0).getUint32(base + 32, true);
        var result492 = [];
        for (let i = 0; i < len492; i++) {
          const base = base492 + i * 52;
          var ptr485 = dataView(memory0).getUint32(base + 0, true);
          var len485 = dataView(memory0).getUint32(base + 4, true);
          var result485 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr485, len485));
          let variant487;
          switch (dataView(memory0).getUint8(base + 24, true)) {
            case 0: {
              variant487 = undefined;
              break;
            }
            case 1: {
              var ptr486 = dataView(memory0).getUint32(base + 28, true);
              var len486 = dataView(memory0).getUint32(base + 32, true);
              var result486 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr486, len486));
              variant487 = result486;
              break;
            }
            default: {
              throw new TypeError('invalid variant discriminant for option');
            }
          }
          let variant489;
          switch (dataView(memory0).getUint8(base + 36, true)) {
            case 0: {
              variant489 = undefined;
              break;
            }
            case 1: {
              var ptr488 = dataView(memory0).getUint32(base + 40, true);
              var len488 = dataView(memory0).getUint32(base + 44, true);
              var result488 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr488, len488));
              variant489 = result488;
              break;
            }
            default: {
              throw new TypeError('invalid variant discriminant for option');
            }
          }
          var bool490 = dataView(memory0).getUint8(base + 48, true);
          var bool491 = dataView(memory0).getUint8(base + 49, true);
          result492.push({
            filename: result485,
            line: dataView(memory0).getInt32(base + 8, true) >>> 0,
            column: dataView(memory0).getInt32(base + 12, true) >>> 0,
            endLine: dataView(memory0).getInt32(base + 16, true) >>> 0,
            endColumn: dataView(memory0).getInt32(base + 20, true) >>> 0,
            frameName: variant487,
            previewLine: variant489,
            hideCaret: bool490 == 0 ? false : (bool490 == 1 ? true : throwInvalidBool()),
            hideFrameName: bool491 == 0 ? false : (bool491 == 1 ? true : throwInvalidBool()),
          });
        }
        variant498= {
          tag: 'error',
          val: {
            excType: result482,
            message: result483,
            traceback: result484,
            frames: result492,
          }
        };
        break;
      }
      case 7: {
        var ptr493 = dataView(memory0).getUint32(base + 8, true);
        var len493 = dataView(memory0).getUint32(base + 12, true);
        var result493 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr493, len493));
        variant498= {
          tag: 'typing-error',
          val: result493
        };
        break;
      }
      case 8: {
        var ptr494 = dataView(memory0).getUint32(base + 8, true);
        var len494 = dataView(memory0).getUint32(base + 12, true);
        var result494 = new Uint8Array(memory0.buffer.slice(ptr494, ptr494 + len494 * 1));
        variant498= {
          tag: 'dump-result',
          val: result494
        };
        break;
      }
      case 9: {
        variant498= {
          tag: 'ok',
        };
        break;
      }
      case 10: {
        var ptr495 = dataView(memory0).getUint32(base + 8, true);
        var len495 = dataView(memory0).getUint32(base + 12, true);
        var result495 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr495, len495));
        variant498= {
          tag: 'fatal-error',
          val: result495
        };
        break;
      }
      case 11: {
        let variant497;
        switch (dataView(memory0).getUint8(base + 8, true)) {
          case 0: {
            variant497 = undefined;
            break;
          }
          case 1: {
            var ptr496 = dataView(memory0).getUint32(base + 12, true);
            var len496 = dataView(memory0).getUint32(base + 16, true);
            var result496 = new Uint8Array(memory0.buffer.slice(ptr496, ptr496 + len496 * 1));
            variant497 = result496;
            break;
          }
          default: {
            throw new TypeError('invalid variant discriminant for option');
          }
        }
        variant498= {
          tag: 'shutdown',
          val: variant497
        };
        break;
      }
      default: {
        throw new TypeError('invalid variant discriminant for Event');
      }
    }
    result499.push(variant498);
  }
  let variant500;
  switch (dataView(memory0).getUint8(ret + 16, true)) {
    case 0: {
      variant500 = undefined;
      break;
    }
    case 1: {
      variant500 = BigInt.asUintN(64, BigInt(dataView(memory0).getBigInt64(ret + 24, true)));
      break;
    }
    default: {
      throw new TypeError('invalid variant discriminant for option');
    }
  }
  let variant501;
  switch (dataView(memory0).getUint8(ret + 32, true)) {
    case 0: {
      variant501 = undefined;
      break;
    }
    case 1: {
      variant501 = BigInt.asUintN(64, BigInt(dataView(memory0).getBigInt64(ret + 40, true)));
      break;
    }
    default: {
      throw new TypeError('invalid variant discriminant for option');
    }
  }
  let variant502;
  switch (dataView(memory0).getUint8(ret + 56, true)) {
    case 0: {
      variant502 = undefined;
      break;
    }
    case 1: {
      variant502 = BigInt.asUintN(64, BigInt(dataView(memory0).getBigInt64(ret + 64, true)));
      break;
    }
    default: {
      throw new TypeError('invalid variant discriminant for option');
    }
  }
  let variant503;
  switch (dataView(memory0).getUint8(ret + 72, true)) {
    case 0: {
      variant503 = undefined;
      break;
    }
    case 1: {
      variant503 = BigInt.asUintN(64, BigInt(dataView(memory0).getBigInt64(ret + 80, true)));
      break;
    }
    default: {
      throw new TypeError('invalid variant discriminant for option');
    }
  }
  _debugLog('[iface="pydantic:monty/worker", function="dispatch"][Instruction::Return]', {
    funcName: 'dispatch',
    paramCount: 1,
    async: false,
    postReturn: true
  });
  task.resolve([{
    status: enum319,
    events: result499,
    maxSuspensions: variant500,
    maxTotalSleepMicros: variant501,
    feedExecutionMicros: BigInt.asUintN(64, BigInt(dataView(memory0).getBigInt64(ret + 48, true))),
    maxFeedDurationMicros: variant502,
    maxTurnDurationMicros: variant503,
  }]);
  const retCopy = {
    status: enum319,
    events: result499,
    maxSuspensions: variant500,
    maxTotalSleepMicros: variant501,
    feedExecutionMicros: BigInt.asUintN(64, BigInt(dataView(memory0).getBigInt64(ret + 48, true))),
    maxFeedDurationMicros: variant502,
    maxTurnDurationMicros: variant503,
  };
  
  let cstate = getOrCreateAsyncState(0);
  cstate.mayLeave = false;
  postReturn0(ret);
  cstate.mayLeave = true;
  task.exit();
  return retCopy;
  
}
let trampoline0 = _trampoline0.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 0,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline0.manuallyAsync,
  paramLiftFns: [],
  resultLowerFns: [_lowerFlatU64],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline0,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 0,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline0.manuallyAsync,
  paramLiftFns: [],
  resultLowerFns: [_lowerFlatU64],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline0,
},
);
function trampoline1(handle) {
  const handleEntry = rscTableRemove(handleTable1, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable1.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable1.delete(handleEntry.rep);
    } else if (OutputStream[symbolCabiDispose]) {
      OutputStream[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline2(handle) {
  const handleEntry = rscTableRemove(handleTable0, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable0.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable0.delete(handleEntry.rep);
    } else if (Error$1[symbolCabiDispose]) {
      Error$1[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline3(handle) {
  const handleEntry = rscTableRemove(handleTable2, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable2.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable2.delete(handleEntry.rep);
    } else if (InputStream[symbolCabiDispose]) {
      InputStream[symbolCabiDispose](handleEntry.rep);
    }
  }
}
function trampoline4(handle) {
  const handleEntry = rscTableRemove(handleTable3, handle);
  if (handleEntry.own) {
    
    const rsc = captureTable3.get(handleEntry.rep);
    if (rsc) {
      if (rsc[symbolDispose]) rsc[symbolDispose]();
      captureTable3.delete(handleEntry.rep);
    } else if (Descriptor[symbolCabiDispose]) {
      Descriptor[symbolCabiDispose](handleEntry.rep);
    }
  }
}
let trampoline5 = _trampoline5.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 5,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline5.manuallyAsync,
  paramLiftFns: [],
  resultLowerFns: [_lowerFlatOwn({
    componentIdx: 0,
    lowerFn: 
    function lowerImportedOwnedHost_OutputStream(obj) {
      if (!(obj instanceof OutputStream)) {
        throw new TypeError('Resource error: Not a valid \"OutputStream\" resource.');
      }
      let handle = obj[symbolRscHandle];
      if (!handle) {
        const rep = obj[symbolRscRep] || ++captureCnt1;
        captureTable1.set(rep, obj);
        handle = rscTableCreateOwn(handleTable1, rep);
      }
      return handle;
    }
    ,
  })],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline5,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 5,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline5.manuallyAsync,
  paramLiftFns: [],
  resultLowerFns: [_lowerFlatOwn({
    componentIdx: 0,
    lowerFn: 
    function lowerImportedOwnedHost_OutputStream(obj) {
      if (!(obj instanceof OutputStream)) {
        throw new TypeError('Resource error: Not a valid \"OutputStream\" resource.');
      }
      let handle = obj[symbolRscHandle];
      if (!handle) {
        const rep = obj[symbolRscRep] || ++captureCnt1;
        captureTable1.set(rep, obj);
        handle = rscTableCreateOwn(handleTable1, rep);
      }
      return handle;
    }
    ,
  })],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline5,
},
);
let trampoline6 = _trampoline6.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 6,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline6.manuallyAsync,
  paramLiftFns: [],
  resultLowerFns: [_lowerFlatOwn({
    componentIdx: 0,
    lowerFn: 
    function lowerImportedOwnedHost_InputStream(obj) {
      if (!(obj instanceof InputStream)) {
        throw new TypeError('Resource error: Not a valid \"InputStream\" resource.');
      }
      let handle = obj[symbolRscHandle];
      if (!handle) {
        const rep = obj[symbolRscRep] || ++captureCnt2;
        captureTable2.set(rep, obj);
        handle = rscTableCreateOwn(handleTable2, rep);
      }
      return handle;
    }
    ,
  })],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline6,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 6,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline6.manuallyAsync,
  paramLiftFns: [],
  resultLowerFns: [_lowerFlatOwn({
    componentIdx: 0,
    lowerFn: 
    function lowerImportedOwnedHost_InputStream(obj) {
      if (!(obj instanceof InputStream)) {
        throw new TypeError('Resource error: Not a valid \"InputStream\" resource.');
      }
      let handle = obj[symbolRscHandle];
      if (!handle) {
        const rep = obj[symbolRscRep] || ++captureCnt2;
        captureTable2.set(rep, obj);
        handle = rscTableCreateOwn(handleTable2, rep);
      }
      return handle;
    }
    ,
  })],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline6,
},
);
let trampoline7 = _trampoline7.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 7,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline7.manuallyAsync,
  paramLiftFns: [],
  resultLowerFns: [_lowerFlatOwn({
    componentIdx: 0,
    lowerFn: 
    function lowerImportedOwnedHost_OutputStream(obj) {
      if (!(obj instanceof OutputStream)) {
        throw new TypeError('Resource error: Not a valid \"OutputStream\" resource.');
      }
      let handle = obj[symbolRscHandle];
      if (!handle) {
        const rep = obj[symbolRscRep] || ++captureCnt1;
        captureTable1.set(rep, obj);
        handle = rscTableCreateOwn(handleTable1, rep);
      }
      return handle;
    }
    ,
  })],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline7,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 7,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline7.manuallyAsync,
  paramLiftFns: [],
  resultLowerFns: [_lowerFlatOwn({
    componentIdx: 0,
    lowerFn: 
    function lowerImportedOwnedHost_OutputStream(obj) {
      if (!(obj instanceof OutputStream)) {
        throw new TypeError('Resource error: Not a valid \"OutputStream\" resource.');
      }
      let handle = obj[symbolRscHandle];
      if (!handle) {
        const rep = obj[symbolRscRep] || ++captureCnt1;
        captureTable1.set(rep, obj);
        handle = rscTableCreateOwn(handleTable1, rep);
      }
      return handle;
    }
    ,
  })],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline7,
},
);
let trampoline8 = _trampoline8.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 8,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline8.manuallyAsync,
  paramLiftFns: [
  _liftFlatResult({
    caseMetas: [['ok', null, 0, 0, 0],['err', null, 0, 0, 0],],
    variantSize32: 1,
    variantAlign32: 1,
    variantPayloadOffset32: 1,
    variantFlatCount: 1,
  })
  ],
  resultLowerFns: [],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline8,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 8,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline8.manuallyAsync,
  paramLiftFns: [
  _liftFlatResult({
    caseMetas: [['ok', null, 0, 0, 0],['err', null, 0, 0, 0],],
    variantSize32: 1,
    variantAlign32: 1,
    variantPayloadOffset32: 1,
    variantFlatCount: 1,
  })
  ],
  resultLowerFns: [],
  hasResultPointer: false,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: null,
  stringEncoding: 'utf8',
  getMemoryFn: () => null,
  getReallocFn: undefined,
  importFn: _trampoline8,
},
);
let trampoline9 = _trampoline9.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 9,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline9.manuallyAsync,
  paramLiftFns: [],
  resultLowerFns: [_lowerFlatList({
    elemLowerFn: _lowerFlatTuple({ elemLowerMetas: [[_lowerFlatStringAny, 8, 4],[_lowerFlatStringAny, 8, 4],], size32: 16, align32: 4 }),
    elemSize32: 16,
    elemAlign32: 4,
  })],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: () => realloc0,
  importFn: _trampoline9,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 9,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline9.manuallyAsync,
  paramLiftFns: [],
  resultLowerFns: [_lowerFlatList({
    elemLowerFn: _lowerFlatTuple({ elemLowerMetas: [[_lowerFlatStringAny, 8, 4],[_lowerFlatStringAny, 8, 4],], size32: 16, align32: 4 }),
    elemSize32: 16,
    elemAlign32: 4,
  })],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: () => realloc0,
  importFn: _trampoline9,
},
);
let trampoline10 = _trampoline10.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 10,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline10.manuallyAsync,
  paramLiftFns: [],
  resultLowerFns: [_lowerFlatRecord({ fieldMetas: [['seconds', _lowerFlatU64, 8, 8 ],['nanoseconds', _lowerFlatU32, 4, 4 ],], size32: 16, align32: 8 })],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline10,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 10,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline10.manuallyAsync,
  paramLiftFns: [],
  resultLowerFns: [_lowerFlatRecord({ fieldMetas: [['seconds', _lowerFlatU64, 8, 8 ],['nanoseconds', _lowerFlatU32, 4, 4 ],], size32: 16, align32: 8 })],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline10,
},
);
let trampoline11 = _trampoline11.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 11,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline11.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 3)],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', 
    _lowerFlatEnum({
      caseMetas: [['unknown', null, 1, 1, 1],['block-device', null, 1, 1, 1],['character-device', null, 1, 1, 1],['directory', null, 1, 1, 1],['fifo', null, 1, 1, 1],['symbolic-link', null, 1, 1, 1],['regular-file', null, 1, 1, 1],['socket', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 2, 1, 1 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['access', null, 1, 1, 1],['would-block', null, 1, 1, 1],['already', null, 1, 1, 1],['bad-descriptor', null, 1, 1, 1],['busy', null, 1, 1, 1],['deadlock', null, 1, 1, 1],['quota', null, 1, 1, 1],['exist', null, 1, 1, 1],['file-too-large', null, 1, 1, 1],['illegal-byte-sequence', null, 1, 1, 1],['in-progress', null, 1, 1, 1],['interrupted', null, 1, 1, 1],['invalid', null, 1, 1, 1],['io', null, 1, 1, 1],['is-directory', null, 1, 1, 1],['loop', null, 1, 1, 1],['too-many-links', null, 1, 1, 1],['message-size', null, 1, 1, 1],['name-too-long', null, 1, 1, 1],['no-device', null, 1, 1, 1],['no-entry', null, 1, 1, 1],['no-lock', null, 1, 1, 1],['insufficient-memory', null, 1, 1, 1],['insufficient-space', null, 1, 1, 1],['not-directory', null, 1, 1, 1],['not-empty', null, 1, 1, 1],['not-recoverable', null, 1, 1, 1],['unsupported', null, 1, 1, 1],['no-tty', null, 1, 1, 1],['no-such-device', null, 1, 1, 1],['overflow', null, 1, 1, 1],['not-permitted', null, 1, 1, 1],['pipe', null, 1, 1, 1],['read-only', null, 1, 1, 1],['invalid-seek', null, 1, 1, 1],['text-file-busy', null, 1, 1, 1],['cross-device', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 2, 1, 1 ],
    ],
    variantSize32: 2,
    variantAlign32: 1,
    variantPayloadOffset32: 1,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline11,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 11,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline11.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 3)],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', 
    _lowerFlatEnum({
      caseMetas: [['unknown', null, 1, 1, 1],['block-device', null, 1, 1, 1],['character-device', null, 1, 1, 1],['directory', null, 1, 1, 1],['fifo', null, 1, 1, 1],['symbolic-link', null, 1, 1, 1],['regular-file', null, 1, 1, 1],['socket', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 2, 1, 1 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['access', null, 1, 1, 1],['would-block', null, 1, 1, 1],['already', null, 1, 1, 1],['bad-descriptor', null, 1, 1, 1],['busy', null, 1, 1, 1],['deadlock', null, 1, 1, 1],['quota', null, 1, 1, 1],['exist', null, 1, 1, 1],['file-too-large', null, 1, 1, 1],['illegal-byte-sequence', null, 1, 1, 1],['in-progress', null, 1, 1, 1],['interrupted', null, 1, 1, 1],['invalid', null, 1, 1, 1],['io', null, 1, 1, 1],['is-directory', null, 1, 1, 1],['loop', null, 1, 1, 1],['too-many-links', null, 1, 1, 1],['message-size', null, 1, 1, 1],['name-too-long', null, 1, 1, 1],['no-device', null, 1, 1, 1],['no-entry', null, 1, 1, 1],['no-lock', null, 1, 1, 1],['insufficient-memory', null, 1, 1, 1],['insufficient-space', null, 1, 1, 1],['not-directory', null, 1, 1, 1],['not-empty', null, 1, 1, 1],['not-recoverable', null, 1, 1, 1],['unsupported', null, 1, 1, 1],['no-tty', null, 1, 1, 1],['no-such-device', null, 1, 1, 1],['overflow', null, 1, 1, 1],['not-permitted', null, 1, 1, 1],['pipe', null, 1, 1, 1],['read-only', null, 1, 1, 1],['invalid-seek', null, 1, 1, 1],['text-file-busy', null, 1, 1, 1],['cross-device', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 2, 1, 1 ],
    ],
    variantSize32: 2,
    variantAlign32: 1,
    variantPayloadOffset32: 1,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline11,
},
);
let trampoline12 = _trampoline12.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 12,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline12.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 0)],
  resultLowerFns: [
  _lowerFlatOption({
    caseMetas: [
    [ 'none', null, 0, 0, 0 ],
    [ 'some', 
    _lowerFlatEnum({
      caseMetas: [['access', null, 1, 1, 1],['would-block', null, 1, 1, 1],['already', null, 1, 1, 1],['bad-descriptor', null, 1, 1, 1],['busy', null, 1, 1, 1],['deadlock', null, 1, 1, 1],['quota', null, 1, 1, 1],['exist', null, 1, 1, 1],['file-too-large', null, 1, 1, 1],['illegal-byte-sequence', null, 1, 1, 1],['in-progress', null, 1, 1, 1],['interrupted', null, 1, 1, 1],['invalid', null, 1, 1, 1],['io', null, 1, 1, 1],['is-directory', null, 1, 1, 1],['loop', null, 1, 1, 1],['too-many-links', null, 1, 1, 1],['message-size', null, 1, 1, 1],['name-too-long', null, 1, 1, 1],['no-device', null, 1, 1, 1],['no-entry', null, 1, 1, 1],['no-lock', null, 1, 1, 1],['insufficient-memory', null, 1, 1, 1],['insufficient-space', null, 1, 1, 1],['not-directory', null, 1, 1, 1],['not-empty', null, 1, 1, 1],['not-recoverable', null, 1, 1, 1],['unsupported', null, 1, 1, 1],['no-tty', null, 1, 1, 1],['no-such-device', null, 1, 1, 1],['overflow', null, 1, 1, 1],['not-permitted', null, 1, 1, 1],['pipe', null, 1, 1, 1],['read-only', null, 1, 1, 1],['invalid-seek', null, 1, 1, 1],['text-file-busy', null, 1, 1, 1],['cross-device', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 1, 1, 1],
    ],
    variantSize32: 2,
    variantAlign32: 1,
    variantPayloadOffset32: 1,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline12,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 12,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline12.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 0)],
  resultLowerFns: [
  _lowerFlatOption({
    caseMetas: [
    [ 'none', null, 0, 0, 0 ],
    [ 'some', 
    _lowerFlatEnum({
      caseMetas: [['access', null, 1, 1, 1],['would-block', null, 1, 1, 1],['already', null, 1, 1, 1],['bad-descriptor', null, 1, 1, 1],['busy', null, 1, 1, 1],['deadlock', null, 1, 1, 1],['quota', null, 1, 1, 1],['exist', null, 1, 1, 1],['file-too-large', null, 1, 1, 1],['illegal-byte-sequence', null, 1, 1, 1],['in-progress', null, 1, 1, 1],['interrupted', null, 1, 1, 1],['invalid', null, 1, 1, 1],['io', null, 1, 1, 1],['is-directory', null, 1, 1, 1],['loop', null, 1, 1, 1],['too-many-links', null, 1, 1, 1],['message-size', null, 1, 1, 1],['name-too-long', null, 1, 1, 1],['no-device', null, 1, 1, 1],['no-entry', null, 1, 1, 1],['no-lock', null, 1, 1, 1],['insufficient-memory', null, 1, 1, 1],['insufficient-space', null, 1, 1, 1],['not-directory', null, 1, 1, 1],['not-empty', null, 1, 1, 1],['not-recoverable', null, 1, 1, 1],['unsupported', null, 1, 1, 1],['no-tty', null, 1, 1, 1],['no-such-device', null, 1, 1, 1],['overflow', null, 1, 1, 1],['not-permitted', null, 1, 1, 1],['pipe', null, 1, 1, 1],['read-only', null, 1, 1, 1],['invalid-seek', null, 1, 1, 1],['text-file-busy', null, 1, 1, 1],['cross-device', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 1, 1, 1],
    ],
    variantSize32: 2,
    variantAlign32: 1,
    variantPayloadOffset32: 1,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline12,
},
);
let trampoline13 = _trampoline13.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 13,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline13.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 3),_liftFlatU64],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', _lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_OutputStream(obj) {
        if (!(obj instanceof OutputStream)) {
          throw new TypeError('Resource error: Not a valid \"OutputStream\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt1;
          captureTable1.set(rep, obj);
          handle = rscTableCreateOwn(handleTable1, rep);
        }
        return handle;
      }
      ,
    }), 8, 4, 4 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['access', null, 1, 1, 1],['would-block', null, 1, 1, 1],['already', null, 1, 1, 1],['bad-descriptor', null, 1, 1, 1],['busy', null, 1, 1, 1],['deadlock', null, 1, 1, 1],['quota', null, 1, 1, 1],['exist', null, 1, 1, 1],['file-too-large', null, 1, 1, 1],['illegal-byte-sequence', null, 1, 1, 1],['in-progress', null, 1, 1, 1],['interrupted', null, 1, 1, 1],['invalid', null, 1, 1, 1],['io', null, 1, 1, 1],['is-directory', null, 1, 1, 1],['loop', null, 1, 1, 1],['too-many-links', null, 1, 1, 1],['message-size', null, 1, 1, 1],['name-too-long', null, 1, 1, 1],['no-device', null, 1, 1, 1],['no-entry', null, 1, 1, 1],['no-lock', null, 1, 1, 1],['insufficient-memory', null, 1, 1, 1],['insufficient-space', null, 1, 1, 1],['not-directory', null, 1, 1, 1],['not-empty', null, 1, 1, 1],['not-recoverable', null, 1, 1, 1],['unsupported', null, 1, 1, 1],['no-tty', null, 1, 1, 1],['no-such-device', null, 1, 1, 1],['overflow', null, 1, 1, 1],['not-permitted', null, 1, 1, 1],['pipe', null, 1, 1, 1],['read-only', null, 1, 1, 1],['invalid-seek', null, 1, 1, 1],['text-file-busy', null, 1, 1, 1],['cross-device', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 8, 4, 4 ],
    ],
    variantSize32: 8,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline13,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 13,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline13.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 3),_liftFlatU64],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', _lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_OutputStream(obj) {
        if (!(obj instanceof OutputStream)) {
          throw new TypeError('Resource error: Not a valid \"OutputStream\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt1;
          captureTable1.set(rep, obj);
          handle = rscTableCreateOwn(handleTable1, rep);
        }
        return handle;
      }
      ,
    }), 8, 4, 4 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['access', null, 1, 1, 1],['would-block', null, 1, 1, 1],['already', null, 1, 1, 1],['bad-descriptor', null, 1, 1, 1],['busy', null, 1, 1, 1],['deadlock', null, 1, 1, 1],['quota', null, 1, 1, 1],['exist', null, 1, 1, 1],['file-too-large', null, 1, 1, 1],['illegal-byte-sequence', null, 1, 1, 1],['in-progress', null, 1, 1, 1],['interrupted', null, 1, 1, 1],['invalid', null, 1, 1, 1],['io', null, 1, 1, 1],['is-directory', null, 1, 1, 1],['loop', null, 1, 1, 1],['too-many-links', null, 1, 1, 1],['message-size', null, 1, 1, 1],['name-too-long', null, 1, 1, 1],['no-device', null, 1, 1, 1],['no-entry', null, 1, 1, 1],['no-lock', null, 1, 1, 1],['insufficient-memory', null, 1, 1, 1],['insufficient-space', null, 1, 1, 1],['not-directory', null, 1, 1, 1],['not-empty', null, 1, 1, 1],['not-recoverable', null, 1, 1, 1],['unsupported', null, 1, 1, 1],['no-tty', null, 1, 1, 1],['no-such-device', null, 1, 1, 1],['overflow', null, 1, 1, 1],['not-permitted', null, 1, 1, 1],['pipe', null, 1, 1, 1],['read-only', null, 1, 1, 1],['invalid-seek', null, 1, 1, 1],['text-file-busy', null, 1, 1, 1],['cross-device', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 8, 4, 4 ],
    ],
    variantSize32: 8,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline13,
},
);
let trampoline14 = _trampoline14.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 14,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline14.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 3)],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', _lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_OutputStream(obj) {
        if (!(obj instanceof OutputStream)) {
          throw new TypeError('Resource error: Not a valid \"OutputStream\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt1;
          captureTable1.set(rep, obj);
          handle = rscTableCreateOwn(handleTable1, rep);
        }
        return handle;
      }
      ,
    }), 8, 4, 4 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['access', null, 1, 1, 1],['would-block', null, 1, 1, 1],['already', null, 1, 1, 1],['bad-descriptor', null, 1, 1, 1],['busy', null, 1, 1, 1],['deadlock', null, 1, 1, 1],['quota', null, 1, 1, 1],['exist', null, 1, 1, 1],['file-too-large', null, 1, 1, 1],['illegal-byte-sequence', null, 1, 1, 1],['in-progress', null, 1, 1, 1],['interrupted', null, 1, 1, 1],['invalid', null, 1, 1, 1],['io', null, 1, 1, 1],['is-directory', null, 1, 1, 1],['loop', null, 1, 1, 1],['too-many-links', null, 1, 1, 1],['message-size', null, 1, 1, 1],['name-too-long', null, 1, 1, 1],['no-device', null, 1, 1, 1],['no-entry', null, 1, 1, 1],['no-lock', null, 1, 1, 1],['insufficient-memory', null, 1, 1, 1],['insufficient-space', null, 1, 1, 1],['not-directory', null, 1, 1, 1],['not-empty', null, 1, 1, 1],['not-recoverable', null, 1, 1, 1],['unsupported', null, 1, 1, 1],['no-tty', null, 1, 1, 1],['no-such-device', null, 1, 1, 1],['overflow', null, 1, 1, 1],['not-permitted', null, 1, 1, 1],['pipe', null, 1, 1, 1],['read-only', null, 1, 1, 1],['invalid-seek', null, 1, 1, 1],['text-file-busy', null, 1, 1, 1],['cross-device', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 8, 4, 4 ],
    ],
    variantSize32: 8,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline14,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 14,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline14.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 3)],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', _lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_OutputStream(obj) {
        if (!(obj instanceof OutputStream)) {
          throw new TypeError('Resource error: Not a valid \"OutputStream\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt1;
          captureTable1.set(rep, obj);
          handle = rscTableCreateOwn(handleTable1, rep);
        }
        return handle;
      }
      ,
    }), 8, 4, 4 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['access', null, 1, 1, 1],['would-block', null, 1, 1, 1],['already', null, 1, 1, 1],['bad-descriptor', null, 1, 1, 1],['busy', null, 1, 1, 1],['deadlock', null, 1, 1, 1],['quota', null, 1, 1, 1],['exist', null, 1, 1, 1],['file-too-large', null, 1, 1, 1],['illegal-byte-sequence', null, 1, 1, 1],['in-progress', null, 1, 1, 1],['interrupted', null, 1, 1, 1],['invalid', null, 1, 1, 1],['io', null, 1, 1, 1],['is-directory', null, 1, 1, 1],['loop', null, 1, 1, 1],['too-many-links', null, 1, 1, 1],['message-size', null, 1, 1, 1],['name-too-long', null, 1, 1, 1],['no-device', null, 1, 1, 1],['no-entry', null, 1, 1, 1],['no-lock', null, 1, 1, 1],['insufficient-memory', null, 1, 1, 1],['insufficient-space', null, 1, 1, 1],['not-directory', null, 1, 1, 1],['not-empty', null, 1, 1, 1],['not-recoverable', null, 1, 1, 1],['unsupported', null, 1, 1, 1],['no-tty', null, 1, 1, 1],['no-such-device', null, 1, 1, 1],['overflow', null, 1, 1, 1],['not-permitted', null, 1, 1, 1],['pipe', null, 1, 1, 1],['read-only', null, 1, 1, 1],['invalid-seek', null, 1, 1, 1],['text-file-busy', null, 1, 1, 1],['cross-device', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 8, 4, 4 ],
    ],
    variantSize32: 8,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 2,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline14,
},
);
let trampoline15 = _trampoline15.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 15,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline15.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 3)],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', _lowerFlatRecord({ fieldMetas: [['type', 
    _lowerFlatEnum({
      caseMetas: [['unknown', null, 1, 1, 1],['block-device', null, 1, 1, 1],['character-device', null, 1, 1, 1],['directory', null, 1, 1, 1],['fifo', null, 1, 1, 1],['symbolic-link', null, 1, 1, 1],['regular-file', null, 1, 1, 1],['socket', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 1, 1 ],['linkCount', _lowerFlatU64, 8, 8 ],['size', _lowerFlatU64, 8, 8 ],['dataAccessTimestamp', 
    _lowerFlatOption({
      caseMetas: [
      [ 'none', null, 0, 0, 0 ],
      [ 'some', _lowerFlatRecord({ fieldMetas: [['seconds', _lowerFlatU64, 8, 8 ],['nanoseconds', _lowerFlatU32, 4, 4 ],], size32: 16, align32: 8 }), 16, 8, 2],
      ],
      variantSize32: 24,
      variantAlign32: 8,
      variantPayloadOffset32: 8,
      variantFlatCount: 3,
    })
    , 24, 8 ],['dataModificationTimestamp', 
    _lowerFlatOption({
      caseMetas: [
      [ 'none', null, 0, 0, 0 ],
      [ 'some', _lowerFlatRecord({ fieldMetas: [['seconds', _lowerFlatU64, 8, 8 ],['nanoseconds', _lowerFlatU32, 4, 4 ],], size32: 16, align32: 8 }), 16, 8, 2],
      ],
      variantSize32: 24,
      variantAlign32: 8,
      variantPayloadOffset32: 8,
      variantFlatCount: 3,
    })
    , 24, 8 ],['statusChangeTimestamp', 
    _lowerFlatOption({
      caseMetas: [
      [ 'none', null, 0, 0, 0 ],
      [ 'some', _lowerFlatRecord({ fieldMetas: [['seconds', _lowerFlatU64, 8, 8 ],['nanoseconds', _lowerFlatU32, 4, 4 ],], size32: 16, align32: 8 }), 16, 8, 2],
      ],
      variantSize32: 24,
      variantAlign32: 8,
      variantPayloadOffset32: 8,
      variantFlatCount: 3,
    })
    , 24, 8 ],], size32: 96, align32: 8 }), 104, 8, 8 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['access', null, 1, 1, 1],['would-block', null, 1, 1, 1],['already', null, 1, 1, 1],['bad-descriptor', null, 1, 1, 1],['busy', null, 1, 1, 1],['deadlock', null, 1, 1, 1],['quota', null, 1, 1, 1],['exist', null, 1, 1, 1],['file-too-large', null, 1, 1, 1],['illegal-byte-sequence', null, 1, 1, 1],['in-progress', null, 1, 1, 1],['interrupted', null, 1, 1, 1],['invalid', null, 1, 1, 1],['io', null, 1, 1, 1],['is-directory', null, 1, 1, 1],['loop', null, 1, 1, 1],['too-many-links', null, 1, 1, 1],['message-size', null, 1, 1, 1],['name-too-long', null, 1, 1, 1],['no-device', null, 1, 1, 1],['no-entry', null, 1, 1, 1],['no-lock', null, 1, 1, 1],['insufficient-memory', null, 1, 1, 1],['insufficient-space', null, 1, 1, 1],['not-directory', null, 1, 1, 1],['not-empty', null, 1, 1, 1],['not-recoverable', null, 1, 1, 1],['unsupported', null, 1, 1, 1],['no-tty', null, 1, 1, 1],['no-such-device', null, 1, 1, 1],['overflow', null, 1, 1, 1],['not-permitted', null, 1, 1, 1],['pipe', null, 1, 1, 1],['read-only', null, 1, 1, 1],['invalid-seek', null, 1, 1, 1],['text-file-busy', null, 1, 1, 1],['cross-device', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 104, 8, 8 ],
    ],
    variantSize32: 104,
    variantAlign32: 8,
    variantPayloadOffset32: 8,
    variantFlatCount: 13,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline15,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 15,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline15.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 3)],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', _lowerFlatRecord({ fieldMetas: [['type', 
    _lowerFlatEnum({
      caseMetas: [['unknown', null, 1, 1, 1],['block-device', null, 1, 1, 1],['character-device', null, 1, 1, 1],['directory', null, 1, 1, 1],['fifo', null, 1, 1, 1],['symbolic-link', null, 1, 1, 1],['regular-file', null, 1, 1, 1],['socket', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 1, 1 ],['linkCount', _lowerFlatU64, 8, 8 ],['size', _lowerFlatU64, 8, 8 ],['dataAccessTimestamp', 
    _lowerFlatOption({
      caseMetas: [
      [ 'none', null, 0, 0, 0 ],
      [ 'some', _lowerFlatRecord({ fieldMetas: [['seconds', _lowerFlatU64, 8, 8 ],['nanoseconds', _lowerFlatU32, 4, 4 ],], size32: 16, align32: 8 }), 16, 8, 2],
      ],
      variantSize32: 24,
      variantAlign32: 8,
      variantPayloadOffset32: 8,
      variantFlatCount: 3,
    })
    , 24, 8 ],['dataModificationTimestamp', 
    _lowerFlatOption({
      caseMetas: [
      [ 'none', null, 0, 0, 0 ],
      [ 'some', _lowerFlatRecord({ fieldMetas: [['seconds', _lowerFlatU64, 8, 8 ],['nanoseconds', _lowerFlatU32, 4, 4 ],], size32: 16, align32: 8 }), 16, 8, 2],
      ],
      variantSize32: 24,
      variantAlign32: 8,
      variantPayloadOffset32: 8,
      variantFlatCount: 3,
    })
    , 24, 8 ],['statusChangeTimestamp', 
    _lowerFlatOption({
      caseMetas: [
      [ 'none', null, 0, 0, 0 ],
      [ 'some', _lowerFlatRecord({ fieldMetas: [['seconds', _lowerFlatU64, 8, 8 ],['nanoseconds', _lowerFlatU32, 4, 4 ],], size32: 16, align32: 8 }), 16, 8, 2],
      ],
      variantSize32: 24,
      variantAlign32: 8,
      variantPayloadOffset32: 8,
      variantFlatCount: 3,
    })
    , 24, 8 ],], size32: 96, align32: 8 }), 104, 8, 8 ],
    [ 'err', 
    _lowerFlatEnum({
      caseMetas: [['access', null, 1, 1, 1],['would-block', null, 1, 1, 1],['already', null, 1, 1, 1],['bad-descriptor', null, 1, 1, 1],['busy', null, 1, 1, 1],['deadlock', null, 1, 1, 1],['quota', null, 1, 1, 1],['exist', null, 1, 1, 1],['file-too-large', null, 1, 1, 1],['illegal-byte-sequence', null, 1, 1, 1],['in-progress', null, 1, 1, 1],['interrupted', null, 1, 1, 1],['invalid', null, 1, 1, 1],['io', null, 1, 1, 1],['is-directory', null, 1, 1, 1],['loop', null, 1, 1, 1],['too-many-links', null, 1, 1, 1],['message-size', null, 1, 1, 1],['name-too-long', null, 1, 1, 1],['no-device', null, 1, 1, 1],['no-entry', null, 1, 1, 1],['no-lock', null, 1, 1, 1],['insufficient-memory', null, 1, 1, 1],['insufficient-space', null, 1, 1, 1],['not-directory', null, 1, 1, 1],['not-empty', null, 1, 1, 1],['not-recoverable', null, 1, 1, 1],['unsupported', null, 1, 1, 1],['no-tty', null, 1, 1, 1],['no-such-device', null, 1, 1, 1],['overflow', null, 1, 1, 1],['not-permitted', null, 1, 1, 1],['pipe', null, 1, 1, 1],['read-only', null, 1, 1, 1],['invalid-seek', null, 1, 1, 1],['text-file-busy', null, 1, 1, 1],['cross-device', null, 1, 1, 1],],
      variantSize32: 1,
      variantAlign32: 1,
      variantPayloadOffset32: 1,
      variantFlatCount: 1,
    })
    , 104, 8, 8 ],
    ],
    variantSize32: 104,
    variantAlign32: 8,
    variantPayloadOffset32: 8,
    variantFlatCount: 13,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline15,
},
);
let trampoline16 = _trampoline16.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 16,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline16.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 1)],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', _lowerFlatU64, 16, 8, 8 ],
    [ 'err', _lowerFlatVariant({
      caseMetas: [[ 'last-operation-failed', _lowerFlatOwn({
        componentIdx: 0,
        lowerFn: 
        function lowerImportedOwnedHost_Error$1(obj) {
          if (!(obj instanceof Error$1)) {
            throw new TypeError('Resource error: Not a valid \"Error$1\" resource.');
          }
          let handle = obj[symbolRscHandle];
          if (!handle) {
            const rep = obj[symbolRscRep] || ++captureCnt0;
            captureTable0.set(rep, obj);
            handle = rscTableCreateOwn(handleTable0, rep);
          }
          return handle;
        }
        ,
      }), 4, 4, 1 ],[ 'closed', null, 0, 0, 0 ],],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
    } ), 16, 8, 8 ],
    ],
    variantSize32: 16,
    variantAlign32: 8,
    variantPayloadOffset32: 8,
    variantFlatCount: 3,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline16,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 16,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline16.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 1)],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', _lowerFlatU64, 16, 8, 8 ],
    [ 'err', _lowerFlatVariant({
      caseMetas: [[ 'last-operation-failed', _lowerFlatOwn({
        componentIdx: 0,
        lowerFn: 
        function lowerImportedOwnedHost_Error$1(obj) {
          if (!(obj instanceof Error$1)) {
            throw new TypeError('Resource error: Not a valid \"Error$1\" resource.');
          }
          let handle = obj[symbolRscHandle];
          if (!handle) {
            const rep = obj[symbolRscRep] || ++captureCnt0;
            captureTable0.set(rep, obj);
            handle = rscTableCreateOwn(handleTable0, rep);
          }
          return handle;
        }
        ,
      }), 4, 4, 1 ],[ 'closed', null, 0, 0, 0 ],],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
    } ), 16, 8, 8 ],
    ],
    variantSize32: 16,
    variantAlign32: 8,
    variantPayloadOffset32: 8,
    variantFlatCount: 3,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline16,
},
);
let trampoline17 = _trampoline17.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 17,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline17.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 1),_liftFlatList({
    elemLiftFn: _liftFlatU8,
    elemAlign32: 1,
    elemSize32: 1,
    typedArray: Uint8Array,
  })],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', null, 12, 4, 4 ],
    [ 'err', _lowerFlatVariant({
      caseMetas: [[ 'last-operation-failed', _lowerFlatOwn({
        componentIdx: 0,
        lowerFn: 
        function lowerImportedOwnedHost_Error$1(obj) {
          if (!(obj instanceof Error$1)) {
            throw new TypeError('Resource error: Not a valid \"Error$1\" resource.');
          }
          let handle = obj[symbolRscHandle];
          if (!handle) {
            const rep = obj[symbolRscRep] || ++captureCnt0;
            captureTable0.set(rep, obj);
            handle = rscTableCreateOwn(handleTable0, rep);
          }
          return handle;
        }
        ,
      }), 4, 4, 1 ],[ 'closed', null, 0, 0, 0 ],],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
    } ), 12, 4, 4 ],
    ],
    variantSize32: 12,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 3,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline17,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 17,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline17.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 1),_liftFlatList({
    elemLiftFn: _liftFlatU8,
    elemAlign32: 1,
    elemSize32: 1,
    typedArray: Uint8Array,
  })],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', null, 12, 4, 4 ],
    [ 'err', _lowerFlatVariant({
      caseMetas: [[ 'last-operation-failed', _lowerFlatOwn({
        componentIdx: 0,
        lowerFn: 
        function lowerImportedOwnedHost_Error$1(obj) {
          if (!(obj instanceof Error$1)) {
            throw new TypeError('Resource error: Not a valid \"Error$1\" resource.');
          }
          let handle = obj[symbolRscHandle];
          if (!handle) {
            const rep = obj[symbolRscRep] || ++captureCnt0;
            captureTable0.set(rep, obj);
            handle = rscTableCreateOwn(handleTable0, rep);
          }
          return handle;
        }
        ,
      }), 4, 4, 1 ],[ 'closed', null, 0, 0, 0 ],],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
    } ), 12, 4, 4 ],
    ],
    variantSize32: 12,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 3,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline17,
},
);
let trampoline18 = _trampoline18.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 18,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline18.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 1),_liftFlatList({
    elemLiftFn: _liftFlatU8,
    elemAlign32: 1,
    elemSize32: 1,
    typedArray: Uint8Array,
  })],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', null, 12, 4, 4 ],
    [ 'err', _lowerFlatVariant({
      caseMetas: [[ 'last-operation-failed', _lowerFlatOwn({
        componentIdx: 0,
        lowerFn: 
        function lowerImportedOwnedHost_Error$1(obj) {
          if (!(obj instanceof Error$1)) {
            throw new TypeError('Resource error: Not a valid \"Error$1\" resource.');
          }
          let handle = obj[symbolRscHandle];
          if (!handle) {
            const rep = obj[symbolRscRep] || ++captureCnt0;
            captureTable0.set(rep, obj);
            handle = rscTableCreateOwn(handleTable0, rep);
          }
          return handle;
        }
        ,
      }), 4, 4, 1 ],[ 'closed', null, 0, 0, 0 ],],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
    } ), 12, 4, 4 ],
    ],
    variantSize32: 12,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 3,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline18,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 18,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline18.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 1),_liftFlatList({
    elemLiftFn: _liftFlatU8,
    elemAlign32: 1,
    elemSize32: 1,
    typedArray: Uint8Array,
  })],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', null, 12, 4, 4 ],
    [ 'err', _lowerFlatVariant({
      caseMetas: [[ 'last-operation-failed', _lowerFlatOwn({
        componentIdx: 0,
        lowerFn: 
        function lowerImportedOwnedHost_Error$1(obj) {
          if (!(obj instanceof Error$1)) {
            throw new TypeError('Resource error: Not a valid \"Error$1\" resource.');
          }
          let handle = obj[symbolRscHandle];
          if (!handle) {
            const rep = obj[symbolRscRep] || ++captureCnt0;
            captureTable0.set(rep, obj);
            handle = rscTableCreateOwn(handleTable0, rep);
          }
          return handle;
        }
        ,
      }), 4, 4, 1 ],[ 'closed', null, 0, 0, 0 ],],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
    } ), 12, 4, 4 ],
    ],
    variantSize32: 12,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 3,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline18,
},
);
let trampoline19 = _trampoline19.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 19,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline19.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 1)],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', null, 12, 4, 4 ],
    [ 'err', _lowerFlatVariant({
      caseMetas: [[ 'last-operation-failed', _lowerFlatOwn({
        componentIdx: 0,
        lowerFn: 
        function lowerImportedOwnedHost_Error$1(obj) {
          if (!(obj instanceof Error$1)) {
            throw new TypeError('Resource error: Not a valid \"Error$1\" resource.');
          }
          let handle = obj[symbolRscHandle];
          if (!handle) {
            const rep = obj[symbolRscRep] || ++captureCnt0;
            captureTable0.set(rep, obj);
            handle = rscTableCreateOwn(handleTable0, rep);
          }
          return handle;
        }
        ,
      }), 4, 4, 1 ],[ 'closed', null, 0, 0, 0 ],],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
    } ), 12, 4, 4 ],
    ],
    variantSize32: 12,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 3,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline19,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 19,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline19.manuallyAsync,
  paramLiftFns: [_liftFlatBorrow.bind(null, 1)],
  resultLowerFns: [
  _lowerFlatResult({
    caseMetas: [
    [ 'ok', null, 12, 4, 4 ],
    [ 'err', _lowerFlatVariant({
      caseMetas: [[ 'last-operation-failed', _lowerFlatOwn({
        componentIdx: 0,
        lowerFn: 
        function lowerImportedOwnedHost_Error$1(obj) {
          if (!(obj instanceof Error$1)) {
            throw new TypeError('Resource error: Not a valid \"Error$1\" resource.');
          }
          let handle = obj[symbolRscHandle];
          if (!handle) {
            const rep = obj[symbolRscRep] || ++captureCnt0;
            captureTable0.set(rep, obj);
            handle = rscTableCreateOwn(handleTable0, rep);
          }
          return handle;
        }
        ,
      }), 4, 4, 1 ],[ 'closed', null, 0, 0, 0 ],],
      variantSize32: 8,
      variantAlign32: 4,
      variantPayloadOffset32: 4,
      variantFlatCount: 2,
    } ), 12, 4, 4 ],
    ],
    variantSize32: 12,
    variantAlign32: 4,
    variantPayloadOffset32: 4,
    variantFlatCount: 3,
  })
  ],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: undefined,
  importFn: _trampoline19,
},
);
let trampoline20 = _trampoline20.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 20,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline20.manuallyAsync,
  paramLiftFns: [_liftFlatU64],
  resultLowerFns: [_lowerFlatList({
    elemLowerFn: _lowerFlatU8,
    elemSize32: 1,
    elemAlign32: 1,
  })],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: () => realloc0,
  importFn: _trampoline20,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 20,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline20.manuallyAsync,
  paramLiftFns: [_liftFlatU64],
  resultLowerFns: [_lowerFlatList({
    elemLowerFn: _lowerFlatU8,
    elemSize32: 1,
    elemAlign32: 1,
  })],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: () => realloc0,
  importFn: _trampoline20,
},
);
let trampoline21 = _trampoline21.manuallyAsync ? new WebAssembly.Suspending(_lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 21,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline21.manuallyAsync,
  paramLiftFns: [],
  resultLowerFns: [_lowerFlatList({
    elemLowerFn: _lowerFlatTuple({ elemLowerMetas: [[_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_Descriptor(obj) {
        if (!(obj instanceof Descriptor)) {
          throw new TypeError('Resource error: Not a valid \"Descriptor\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt3;
          captureTable3.set(rep, obj);
          handle = rscTableCreateOwn(handleTable3, rep);
        }
        return handle;
      }
      ,
    }), 4, 4],[_lowerFlatStringAny, 8, 4],], size32: 12, align32: 4 }),
    elemSize32: 12,
    elemAlign32: 4,
  })],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: () => realloc0,
  importFn: _trampoline21,
},
)) : _lowerImportBackwardsCompat.bind(
null,
{
  trampolineIdx: 21,
  componentIdx: 0,
  isAsync: false,
  isManualAsync: _trampoline21.manuallyAsync,
  paramLiftFns: [],
  resultLowerFns: [_lowerFlatList({
    elemLowerFn: _lowerFlatTuple({ elemLowerMetas: [[_lowerFlatOwn({
      componentIdx: 0,
      lowerFn: 
      function lowerImportedOwnedHost_Descriptor(obj) {
        if (!(obj instanceof Descriptor)) {
          throw new TypeError('Resource error: Not a valid \"Descriptor\" resource.');
        }
        let handle = obj[symbolRscHandle];
        if (!handle) {
          const rep = obj[symbolRscRep] || ++captureCnt3;
          captureTable3.set(rep, obj);
          handle = rscTableCreateOwn(handleTable3, rep);
        }
        return handle;
      }
      ,
    }), 4, 4],[_lowerFlatStringAny, 8, 4],], size32: 12, align32: 4 }),
    elemSize32: 12,
    elemAlign32: 4,
  })],
  hasResultPointer: true,
  funcTypeIsAsync: false,
  getCallbackFn: () => null,
  getPostReturnFn: () => null,
  isCancellable: false,
  memoryIdx: 0,
  stringEncoding: 'utf8',
  getMemoryFn: () => memory0,
  getReallocFn: () => realloc0,
  importFn: _trampoline21,
},
);
Promise.all([module0, module1, module2, module3]).catch(() => {});
({ exports: exports0 } = yield instantiateCore(yield module2));
({ exports: exports1 } = yield instantiateCore(yield module0, {
  wasi_snapshot_preview1: {
    clock_time_get: exports0['3'],
    environ_get: exports0['1'],
    environ_sizes_get: exports0['2'],
    fd_write: exports0['4'],
    proc_exit: exports0['5'],
    random_get: exports0['0'],
    sched_yield: exports0['6'],
  },
}));
({ exports: exports2 } = yield instantiateCore(yield module1, {
  __main_module__: {
    cabi_realloc: exports1.cabi_realloc,
  },
  env: {
    memory: exports1.memory,
  },
  'wasi:cli/environment@0.2.3': {
    'get-environment': exports0['7'],
  },
  'wasi:cli/exit@0.2.3': {
    exit: trampoline8,
  },
  'wasi:cli/stderr@0.2.3': {
    'get-stderr': trampoline5,
  },
  'wasi:cli/stdin@0.2.3': {
    'get-stdin': trampoline6,
  },
  'wasi:cli/stdout@0.2.3': {
    'get-stdout': trampoline7,
  },
  'wasi:clocks/monotonic-clock@0.2.3': {
    now: trampoline0,
  },
  'wasi:clocks/wall-clock@0.2.3': {
    now: exports0['8'],
  },
  'wasi:filesystem/preopens@0.2.3': {
    'get-directories': exports0['19'],
  },
  'wasi:filesystem/types@0.2.3': {
    '[method]descriptor.append-via-stream': exports0['12'],
    '[method]descriptor.get-type': exports0['9'],
    '[method]descriptor.stat': exports0['13'],
    '[method]descriptor.write-via-stream': exports0['11'],
    '[resource-drop]descriptor': trampoline4,
    'filesystem-error-code': exports0['10'],
  },
  'wasi:io/error@0.2.3': {
    '[resource-drop]error': trampoline2,
  },
  'wasi:io/streams@0.2.3': {
    '[method]output-stream.blocking-flush': exports0['17'],
    '[method]output-stream.blocking-write-and-flush': exports0['16'],
    '[method]output-stream.check-write': exports0['14'],
    '[method]output-stream.write': exports0['15'],
    '[resource-drop]input-stream': trampoline3,
    '[resource-drop]output-stream': trampoline1,
  },
  'wasi:random/random@0.2.3': {
    'get-random-bytes': exports0['18'],
  },
}));
memory0 = exports1.memory;
realloc0 = exports2.cabi_import_realloc;

try {
  realloc0Async = WebAssembly.promising(exports2.cabi_import_realloc);
} catch(err) {
  realloc0Async = exports2.cabi_import_realloc;
}

({ exports: exports3 } = yield instantiateCore(yield module3, {
  '': {
    $imports: exports0.$imports,
    '0': exports2.random_get,
    '1': exports2.environ_get,
    '10': trampoline12,
    '11': trampoline13,
    '12': trampoline14,
    '13': trampoline15,
    '14': trampoline16,
    '15': trampoline17,
    '16': trampoline18,
    '17': trampoline19,
    '18': trampoline20,
    '19': trampoline21,
    '2': exports2.environ_sizes_get,
    '3': exports2.clock_time_get,
    '4': exports2.fd_write,
    '5': exports2.proc_exit,
    '6': exports2.sched_yield,
    '7': trampoline9,
    '8': trampoline10,
    '9': trampoline11,
  },
}));
realloc1 = exports1.cabi_realloc;

try {
  realloc1Async = WebAssembly.promising(exports1.cabi_realloc);
} catch(err) {
  realloc1Async = exports1.cabi_realloc;
}

postReturn0 = exports1['cabi_post_pydantic:monty/worker#dispatch'];

try {
  postReturn0Async = WebAssembly.promising(exports1['cabi_post_pydantic:monty/worker#dispatch']);
} catch(err) {
  postReturn0Async = exports1['cabi_post_pydantic:monty/worker#dispatch'];
}

workerCancellationContract = exports1['pydantic:monty/worker#cancellation-contract'];
workerDispatch = exports1['pydantic:monty/worker#dispatch'];
const worker = {
  cancellationContract: cancellationContract,
  dispatch: dispatch,
  
};

return { worker, 'pydantic:monty/worker': worker,  };
})();
let promise, resolve, reject;
function runNext (value) {
  try {
    let done;
    do {
      ({ value, done } = gen.next(value));
    } while (!(value instanceof Promise) && !done);
    if (done) {
      if (resolve) return resolve(value);
      else return value;
    }
    if (!promise) promise = new Promise((_resolve, _reject) => (resolve = _resolve, reject = _reject));
    value.then(nextVal => done ? resolve() : runNext(nextVal), reject);
  }
  catch (e) {
    if (reject) reject(e);
    else throw e;
  }
}
const maybeSyncReturn = runNext(null);
return promise || maybeSyncReturn;
};
