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

// vm-lifecycle/ensureVmRunning.ts
var ensureVmRunning_exports = {};
__export(ensureVmRunning_exports, {
  ensureVmRunning: () => ensureVmRunning
});
module.exports = __toCommonJS(ensureVmRunning_exports);
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ensureVmRunning
});
//# sourceMappingURL=ensureVmRunning.js.map