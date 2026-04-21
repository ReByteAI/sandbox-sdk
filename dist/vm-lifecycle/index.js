"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// vm-lifecycle/index.ts
var vm_lifecycle_exports = {};
__export(vm_lifecycle_exports, {
  VM_POLL: () => VM_POLL,
  VmProvider: () => VmProvider,
  ensureVmRunning: () => ensureVmRunning,
  parseVmError: () => parseVmError,
  useVm: () => useVm
});
module.exports = __toCommonJS(vm_lifecycle_exports);

// vm-lifecycle/ensureVmRunning.ts
var import_rebyte_sandbox = require("rebyte-sandbox");
var TRANSIENT_CONNECT_ERRORS = /* @__PURE__ */ new Set([
  import_rebyte_sandbox.ErrorCode.CONCURRENT_OPERATION,
  import_rebyte_sandbox.ErrorCode.SANDBOX_PAUSING,
  import_rebyte_sandbox.ErrorCode.INVALID_STATE_TRANSITION
]);
function respondError(res, status, message, retryable, code) {
  res.status(status).json({ message, retryable, code });
}
function ensureVmRunning(opts) {
  var _a, _b, _c;
  const timeoutMs = (_a = opts.timeoutMs) != null ? _a : 5 * 6e4;
  const maxRetries = (_b = opts.maxRetries) != null ? _b : 15;
  const retryIntervalMs = (_c = opts.retryIntervalMs) != null ? _c : 4e3;
  return async (req, res, next) => {
    var _a2, _b2;
    const sandboxId = opts.getSandboxId(req);
    if (!sandboxId) {
      respondError(res, 400, "missing sandboxId", false, "missing_sandbox_id");
      return;
    }
    let config;
    try {
      config = await opts.getConfig(req);
    } catch (err) {
      respondError(res, 500, (_a2 = err.message) != null ? _a2 : "config error", false, "config_error");
      return;
    }
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const sandbox = await import_rebyte_sandbox.Sandbox.connect(sandboxId, config);
        await sandbox.setTimeout(timeoutMs);
        if (opts.waitForReady) await opts.waitForReady(sandbox);
        req.sandbox = sandbox;
        next();
        return;
      } catch (err) {
        const code = err instanceof import_rebyte_sandbox.SandboxError ? err.errorCode : void 0;
        const transient = code !== void 0 && TRANSIENT_CONNECT_ERRORS.has(code);
        if (!transient || attempt === maxRetries) {
          const message = (_b2 = err.message) != null ? _b2 : "vm not ready";
          if (err instanceof import_rebyte_sandbox.NotFoundError) {
            respondError(res, 404, message, false, code);
          } else if (transient && attempt === maxRetries) {
            respondError(res, 504, message, true, code);
          } else {
            respondError(res, 503, message, true, code);
          }
          return;
        }
        await new Promise((r) => setTimeout(r, retryIntervalMs));
      }
    }
  };
}

// vm-lifecycle/VmProvider.tsx
var import_react = require("react");
var import_react_query = require("@tanstack/react-query");
var import_jsx_runtime = require("react/jsx-runtime");
var VM_POLL = {
  READY_MS: 3e4,
  NOT_READY_MS: 2e3
};
function parseVmError(error) {
  var _a;
  const data = (_a = error == null ? void 0 : error.response) == null ? void 0 : _a.data;
  if (data == null ? void 0 : data.message) {
    return {
      message: data.message,
      retryable: data.retryable !== false,
      code: data.code
    };
  }
  return {
    message: error instanceof Error ? error.message : "Failed to start VM",
    retryable: true
  };
}
var VmContext = (0, import_react.createContext)(null);
function useVm() {
  const v = (0, import_react.useContext)(VmContext);
  if (!v) throw new Error("useVm must be used within <VmProvider>");
  return v;
}
function VmProvider({
  sandboxId,
  api,
  children
}) {
  const qc = (0, import_react_query.useQueryClient)();
  const ensureKey = (0, import_react.useMemo)(() => ["vmEnsure", sandboxId != null ? sandboxId : ""], [sandboxId]);
  const healthKey = (0, import_react.useMemo)(() => ["vmHealth", sandboxId != null ? sandboxId : ""], [sandboxId]);
  const ensureQ = (0, import_react_query.useQuery)({
    queryKey: ensureKey,
    queryFn: () => api.ensure(sandboxId),
    enabled: !!sandboxId,
    refetchOnWindowFocus: true,
    refetchInterval: (q) => {
      if (q.state.error && !parseVmError(q.state.error).retryable) return false;
      return q.state.data ? VM_POLL.READY_MS : VM_POLL.NOT_READY_MS;
    },
    retry: false
  });
  const ensureOk = !!ensureQ.data;
  const hasHealth = !!api.health;
  const healthQ = (0, import_react_query.useQuery)({
    queryKey: healthKey,
    queryFn: () => api.health(sandboxId),
    enabled: !!sandboxId && ensureOk && hasHealth,
    refetchOnWindowFocus: true,
    refetchInterval: (q) => q.state.data ? VM_POLL.READY_MS : VM_POLL.NOT_READY_MS,
    retry: false
  });
  const isReady = hasHealth ? !!healthQ.data : ensureOk;
  const vmError = (0, import_react.useMemo)(
    () => ensureQ.error ? parseVmError(ensureQ.error) : null,
    [ensureQ.error]
  );
  const ensureRunning = (0, import_react.useCallback)(() => {
    if (!sandboxId) return;
    qc.resetQueries({ queryKey: ensureKey });
    qc.invalidateQueries({ queryKey: ensureKey });
    qc.invalidateQueries({ queryKey: healthKey });
  }, [sandboxId, qc, ensureKey, healthKey]);
  const value = (0, import_react.useMemo)(
    () => {
      var _a;
      return {
        sandboxId: sandboxId != null ? sandboxId : "",
        isReady,
        health: (_a = healthQ.data) != null ? _a : null,
        vmError,
        ensureRunning
      };
    },
    [sandboxId, isReady, healthQ.data, vmError, ensureRunning]
  );
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(VmContext.Provider, { value, children });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  VM_POLL,
  VmProvider,
  ensureVmRunning,
  parseVmError,
  useVm
});
//# sourceMappingURL=index.js.map