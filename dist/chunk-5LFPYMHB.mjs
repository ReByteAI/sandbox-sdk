// vm-lifecycle/VmProvider.tsx
import {
  createContext,
  useCallback,
  useContext,
  useMemo
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { jsx } from "react/jsx-runtime";
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
var VmContext = createContext(null);
function useVm() {
  const v = useContext(VmContext);
  if (!v) throw new Error("useVm must be used within <VmProvider>");
  return v;
}
function VmProvider({
  sandboxId,
  api,
  children
}) {
  const qc = useQueryClient();
  const ensureKey = useMemo(() => ["vmEnsure", sandboxId != null ? sandboxId : ""], [sandboxId]);
  const healthKey = useMemo(() => ["vmHealth", sandboxId != null ? sandboxId : ""], [sandboxId]);
  const ensureQ = useQuery({
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
  const healthQ = useQuery({
    queryKey: healthKey,
    queryFn: () => api.health(sandboxId),
    enabled: !!sandboxId && ensureOk && hasHealth,
    refetchOnWindowFocus: true,
    refetchInterval: (q) => q.state.data ? VM_POLL.READY_MS : VM_POLL.NOT_READY_MS,
    retry: false
  });
  const isReady = hasHealth ? !!healthQ.data : ensureOk;
  const vmError = useMemo(
    () => ensureQ.error ? parseVmError(ensureQ.error) : null,
    [ensureQ.error]
  );
  const ensureRunning = useCallback(() => {
    if (!sandboxId) return;
    qc.resetQueries({ queryKey: ensureKey });
    qc.invalidateQueries({ queryKey: ensureKey });
    qc.invalidateQueries({ queryKey: healthKey });
  }, [sandboxId, qc, ensureKey, healthKey]);
  const value = useMemo(
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
  return /* @__PURE__ */ jsx(VmContext.Provider, { value, children });
}

export {
  VM_POLL,
  parseVmError,
  useVm,
  VmProvider
};
//# sourceMappingURL=chunk-5LFPYMHB.mjs.map