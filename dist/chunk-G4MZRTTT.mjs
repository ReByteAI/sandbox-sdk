// vm-lifecycle/VmProvider.tsx
import { createContext, useContext, useMemo } from "react";
import { jsx } from "react/jsx-runtime";
var VmContext = createContext(null);
function useVm() {
  const v = useContext(VmContext);
  if (!v) throw new Error("useVm must be used within <VmProvider>");
  return v;
}
function VmProvider({ sandboxId, children }) {
  const value = useMemo(
    () => ({ sandboxId: sandboxId != null ? sandboxId : "" }),
    [sandboxId]
  );
  return /* @__PURE__ */ jsx(VmContext.Provider, { value, children });
}

export {
  useVm,
  VmProvider
};
//# sourceMappingURL=chunk-G4MZRTTT.mjs.map