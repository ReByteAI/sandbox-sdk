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

// vm-lifecycle/VmProvider.tsx
var VmProvider_exports = {};
__export(VmProvider_exports, {
  VM_POLL: () => VM_POLL,
  VmProvider: () => VmProvider,
  parseVmError: () => parseVmError,
  useVm: () => useVm
});
module.exports = __toCommonJS(VmProvider_exports);
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
  parseVmError,
  useVm
});
//# sourceMappingURL=VmProvider.js.map