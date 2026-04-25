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
  VmProvider: () => VmProvider,
  useVm: () => useVm
});
module.exports = __toCommonJS(vm_lifecycle_exports);

// vm-lifecycle/VmProvider.tsx
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var VmContext = (0, import_react.createContext)(null);
function useVm() {
  const v = (0, import_react.useContext)(VmContext);
  if (!v) throw new Error("useVm must be used within <VmProvider>");
  return v;
}
function VmProvider({ sandboxId, children }) {
  const value = (0, import_react.useMemo)(
    () => ({ sandboxId: sandboxId != null ? sandboxId : "" }),
    [sandboxId]
  );
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(VmContext.Provider, { value, children });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  VmProvider,
  useVm
});
//# sourceMappingURL=index.js.map