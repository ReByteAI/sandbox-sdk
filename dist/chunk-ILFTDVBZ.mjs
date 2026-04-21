// vm-lifecycle/ensureVmRunning.ts
import { Sandbox, SandboxError, NotFoundError, ErrorCode } from "rebyte-sandbox";
var TRANSIENT_CONNECT_ERRORS = /* @__PURE__ */ new Set([
  ErrorCode.CONCURRENT_OPERATION,
  ErrorCode.SANDBOX_PAUSING,
  ErrorCode.INVALID_STATE_TRANSITION
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
        const sandbox = await Sandbox.connect(sandboxId, config);
        await sandbox.setTimeout(timeoutMs);
        if (opts.waitForReady) await opts.waitForReady(sandbox);
        req.sandbox = sandbox;
        next();
        return;
      } catch (err) {
        const code = err instanceof SandboxError ? err.errorCode : void 0;
        const transient = code !== void 0 && TRANSIENT_CONNECT_ERRORS.has(code);
        if (!transient || attempt === maxRetries) {
          const message = (_b2 = err.message) != null ? _b2 : "vm not ready";
          if (err instanceof NotFoundError) {
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

export {
  ensureVmRunning
};
//# sourceMappingURL=chunk-ILFTDVBZ.mjs.map