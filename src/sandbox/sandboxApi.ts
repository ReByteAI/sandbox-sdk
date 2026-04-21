/**
 * # Sandbox Lifecycle & State Machine
 *
 * ## States
 *
 *   - **running** — VM is active, executing commands, serving ports.
 *   - **paused**  — VM is suspended. Disk state is in GCS. May or may not have memory snapshot.
 *   - **dead**    — VM is terminated. Cannot be resumed. (Not queryable via API.)
 *
 * ## Operations & Transitions
 *
 * ```
 *                    create
 *                  ┌─────────► running ◄────────────────────────┐
 *                  │               │                             │
 *                  │    ┌──────────┼──────────────┐              │
 *                  │    │ kill     │ pause    │ hibernate│
 *                  │    ▼          ▼              ▼              │
 *                  │  dead      paused          paused           │
 *                  │          (snapshot)     (rootfs-only)       │
 *                  │               │              │              │
 *                  │               └──────┬───────┘              │
 *                  │                      │ connect              │
 *                  │                      └──────────────────────┘
 * ```
 *
 * ## Operation Details
 *
 * ### `create(template, opts)`
 * Creates a new sandbox VM from a template. The VM boots and becomes `running`.
 * - Returns a connected `Sandbox` instance ready for commands/files.
 * - `opts.timeoutMs` — how long before the sandbox is auto-killed (default: 5 min).
 * - `opts.autoPauseMode` — if set to "pause" or "hibernate", sandbox auto-pauses on timeout
 *   instead of being killed. "pause" saves full memory state, "hibernate" saves rootfs only.
 *
 * ### `kill()`
 * Immediately terminates the VM. State transitions to `dead`.
 * - All in-memory state and processes are lost.
 * - Disk state is NOT saved. The sandbox cannot be resumed.
 * - Idempotent: killing an already-dead sandbox returns `false`.
 *
 * ### `pause()` — Full Snapshot Pause
 * Saves the **complete VM state** (memory + disk + VM registers) to GCS, then stops the VM.
 * - State: `running` → `paused`
 * - What's saved to GCS: `memfile` + `memfile.header` + `snapfile` + `rootfs` + `rootfs.header` + `snapshot.json`
 * - On resume: **instant restore** (~100-500ms) — VM resumes exactly where it left off.
 *   In-flight processes, open sockets, and memory contents are all preserved.
 * - Use when you need to preserve the exact execution state (running servers, open
 *   connections, in-memory caches).
 * - Returns `false` if already paused (409 Conflict).
 * - **Auto-pause**: When `autoPauseMode: "pause"` is set on create/connect, the gateway
 *   automatically performs a full pause when the timeout expires (instead of killing).
 *   Use `"hibernate"` for rootfs-only auto-pause.
 *
 * ### `hibernate()` — Rootfs-Only Pause (Disk Only)
 * Saves **only the disk state** (rootfs diff) to GCS. No memory or VM-state snapshot.
 * - State: `running` → `paused`
 * - What's saved to GCS: `rootfs` + `rootfs.header` + `snapshot.json` (NO memfile, NO snapfile)
 * - On resume: **cold boot** (~5-7s) — VM boots fresh from template, but with disk
 *   modifications preserved. All processes, memory, and sockets are lost.
 * - ~40-50% faster than full pause (skips memory snapshot).
 * - On resume, the orchestrator detects no memfile in GCS and cold boots automatically.
 * - Use when you only need file persistence (written configs, installed packages,
 *   downloaded data) and don't need running processes preserved.
 *
 * ### `connect(sandboxId, opts)` — Resume or Reconnect
 * Connects to an existing sandbox. If the sandbox is `paused`, it is automatically resumed.
 * - If **running**: just connects (no state change). Timeout may be extended.
 * - If **paused (full snapshot)**: resumes from snapshot (~100-500ms). Processes continue.
 * - If **paused (hibernated)**: cold boots (~5-7s). Disk state preserved,
 *   processes restart fresh.
 * - `opts.coldStart` — force cold boot even for full snapshots (fallback if snapshot
 *   resume fails).
 * - `opts.autoPauseMode` — set auto-pause mode for this session (not persisted across
 *   pause/resume cycles; must be specified on each connect).
 * - `opts.timeoutMs` — set/extend the sandbox timeout.
 *
 * ## Quick Reference
 *
 * | Operation       | Memory saved? | Disk saved? | Resume speed | Resume method   |
 * |-----------------|---------------|-------------|--------------|-----------------|
 * | `pause()`   | Yes           | Yes         | ~100-500ms   | Snapshot restore|
 * | `hibernate()`| No           | Yes         | ~5-7s        | Cold boot       |
 * | `kill()`        | No            | No          | N/A          | Cannot resume   |
 * | Auto-pause      | Depends on mode| Yes        | Depends      | Mode-dependent  |
 */

import { ApiClient, components, handleApiError } from '../api'
import {
  ConnectionConfig,
  ConnectionOpts,
  DEFAULT_SANDBOX_TIMEOUT_MS,
} from '../connectionConfig'
import { compareVersions } from 'compare-versions'
import { NotFoundError, TemplateError } from '../errors'
import { timeoutToSeconds } from '../utils'
import type { McpServer as BaseMcpServer } from './mcp'

/**
 * Extended MCP server configuration that includes base servers
 * and allows dynamic GitHub-based MCP servers with custom run and install commands.
 */
export type McpServer = BaseMcpServer | GitHubMcpServer

export type GitHubMcpServer = {
  [key: `github/${string}`]: {
    /**
     * Command to run the MCP server. Must start a stdio-compatible server.
     */
    runCmd: string
    /**
     * Command to install dependencies for the MCP server. Working directory is the root of the github repository.
     */
    installCmd?: string
    /**
     * Environment variables to set in the MCP process.
     */
    envs?: Record<string, string>
  }
}

/**
 * Egress (outbound) network configuration.
 *
 * Priority order for egress checking:
 *   1. allowedDomains → if hostname matches, ALLOW (bypass all)
 *   2. allowOut       → if IP matches, ALLOW (bypass deny)
 *   3. denyOut        → if IP matches, DENY
 *   4. Default: ALLOW
 *
 * Common patterns:
 *   - Allow all (default): empty config
 *   - Deny all: denyOut = ["0.0.0.0/0"]
 *   - Whitelist domains: allowedDomains = ["*.github.com"], denyOut = ["0.0.0.0/0"]
 *   - Whitelist IPs: allowOut = ["8.8.8.8/32"], denyOut = ["0.0.0.0/0"]
 */
export type SandboxNetworkEgressOpts = {
  /**
   * List of allowed CIDR blocks or IP addresses for egress traffic.
   * Allowed addresses always take precedence over blocked addresses.
   *
   * Examples: ["8.8.8.8/32", "10.0.0.0/8"]
   *
   * @default []
   */
  allowOut?: string[]

  /**
   * List of denied CIDR blocks or IP addresses for egress traffic.
   * Use ["0.0.0.0/0"] for whitelist mode (deny all except allowed).
   *
   * Examples: ["0.0.0.0/0", "192.168.0.0/16"]
   *
   * @default []
   */
  denyOut?: string[]

  /**
   * List of allowed domains for egress traffic.
   * Supports exact match, wildcard "*", and suffix "*.example.com".
   * Domains bypass all CIDR checks.
   *
   * Examples: ["github.com", "*.googleapis.com", "api.openai.com"]
   *
   * @default []
   */
  allowedDomains?: string[]
}

export type SandboxNetworkOpts = {
  /**
   * Egress (outbound) network restrictions.
   * Controls which external addresses the sandbox can connect to.
   */
  egress?: SandboxNetworkEgressOpts

  /**
   * Specify if the sandbox URLs should be accessible only with authentication.
   * @default true
   */
  allowPublicTraffic?: boolean

  /** Specify host mask which will be used for all sandbox requests in the header.
   * You can use the ${PORT} variable that will be replaced with the actual port number of the service.
   *
   * @default ${PORT}-sandboxid.rebyte.app
   */
  maskRequestHost?: string

  /**
   * UDP media ingress configuration (WebRTC/RTP).
   * When enabled, a public UDP port is allocated on the node and forwarded to the VM.
   */
  udpIngress?: UdpIngressOpts
}

/**
 * UDP media ingress options.
 *
 * When enabled, a public UDP port is allocated and identity-mapped into the VM
 * (external port = internal port). This is required for WebRTC (pion ICE).
 * The allocated port is returned in `udpEndpoint.port`.
 */
export type UdpIngressOpts = {
  /** Enable UDP ingress. */
  enabled: boolean
  /**
   * @deprecated Ignored — identity mapping is always used (external port = internal port).
   * Kept for backwards compatibility.
   */
  internalPort?: number
}

/**
 * Allocated public UDP endpoint for media ingress.
 * Returned when a sandbox is created or resumed with UDP ingress enabled.
 */
export type UdpEndpoint = {
  /** Node public IP address. */
  ip: string
  /** Allocated external UDP port on the node. */
  port: number
  /** Internal UDP port in the VM. */
  internalPort: number
}

/**
 * Options for request to the Sandbox API.
 */
export interface SandboxApiOpts
  extends Partial<
    Pick<
      ConnectionOpts,
      'apiKey' | 'headers' | 'debug' | 'domain' | 'requestTimeoutMs'
    >
  > {}

/**
 * Options for creating a new Sandbox.
 */
export interface SandboxOpts extends ConnectionOpts {
  /**
   * Custom metadata for the sandbox.
   *
   * @default {}
   */
  metadata?: Record<string, string>

  /**
   * Custom environment variables for the sandbox.
   *
   * Used when executing commands and code in the sandbox.
   * Can be overridden with the `envs` argument when executing commands or code.
   *
   * @default {}
   */
  envs?: Record<string, string>

  /**
   * Timeout for the sandbox in **milliseconds**.
   * Maximum time a sandbox can be kept alive is 24 hours (86_400_000 milliseconds) for Pro users and 1 hour (3_600_000 milliseconds) for Hobby users.
   *
   * @default 300_000 // 5 minutes
   */
  timeoutMs?: number

  /**
   * Secure all traffic coming to the sandbox controller with auth token
   *
   * @default true
   */
  secure?: boolean

  /**
   * Allow sandbox to access the internet. If set to `False`, it works the same as setting network `denyOut` to `[0.0.0.0/0]`.
   *
   * @default true
   */
  allowInternetAccess?: boolean

  /**
   * MCP server to enable in the sandbox
   * @default undefined
   */
  mcp?: McpServer

  /**
   * Sandbox network configuration
   */
  network?: SandboxNetworkOpts

  /**
   * Sandbox URL. Used for local development
   */
  sandboxUrl?: string

  /**
   * Custom sandbox ID. If not provided, one will be generated.
   * Use this to create sandboxes with predictable IDs.
   */
  sandboxId?: string

  /**
   * Webhook URL for lifecycle event notifications.
   *
   * When set, the gateway will POST JSON payloads to this URL when lifecycle
   * events occur (started, stopped, paused, hibernated, resumed).
   *
   * The webhook is persisted across pause/resume cycles. On resume, you can
   * override it by specifying a new `webhookUrl` in connect options.
   *
   * Delivery: fire-and-forget with 3 retries (exponential backoff: 2s, 4s, 8s).
   *
   * @default undefined
   */
  webhookUrl?: string

  /**
   * How to handle timeout expiration.
   * - `"pause"` (default) — full snapshot (memory + disk). Fast resume (~100-500ms).
   * - `"hibernate"` — rootfs-only (disk only). Cold boot on resume (~5-7s).
   *
   * @default "pause"
   */
  autoPauseMode?: 'pause' | 'hibernate'
}

/**
 * Options for connecting to (and optionally resuming) a Sandbox.
 *
 * When connecting to a paused sandbox, the resume method is chosen based on what the
 * snapshot contains. If memfile exists in GCS → snapshot restore. Otherwise → cold boot.
 *
 * You can override this with `coldStart: true` to always cold boot.
 */
export type SandboxConnectOpts = ConnectionOpts & {
  /**
   * Timeout for the sandbox in **milliseconds**.
   * For running sandboxes, the timeout will update only if the new timeout is longer than the existing one.
   * Maximum time a sandbox can be kept alive is 24 hours (86_400_000 milliseconds) for Pro users and 1 hour (3_600_000 milliseconds) for Hobby users.
   *
   * @default 300_000 // 5 minutes
   */
  timeoutMs?: number

  /**
   * How to handle timeout expiration. If set, sandbox is auto-paused on timeout instead of killed.
   * - `"pause"` — full snapshot (memory + disk). Fast resume (~100-500ms).
   * - `"hibernate"` — rootfs-only (disk only). Cold boot on resume (~5-7s).
   *
   * If not set, sandbox is killed on timeout (default behavior).
   * Must be re-specified on each connect — it is NOT persisted across pause/resume cycles.
   */
  autoPauseMode?: 'pause' | 'hibernate'

  /**
   * Force a cold start (fresh boot from template) instead of restoring from snapshot.
   *
   * Normally used as a fallback when snapshot resume fails. Cold boot takes ~5-7s
   * vs ~100-500ms for snapshot restore, but disk state (rootfs) is still preserved.
   *
   * Note: For hibernated snapshots (no memfile), cold boot happens automatically —
   * you only need to set this when you want to force cold boot on a full snapshot.
   *
   * @default false
   */
  coldStart?: boolean

  /**
   * Resume from a specific snapshot (build ID) instead of the latest.
   *
   * Use this to restore a sandbox to a particular point-in-time snapshot.
   * The build ID must belong to the specified sandbox, otherwise a 404 is returned.
   *
   * @default undefined (uses latest snapshot)
   */
  buildId?: string

  /**
   * Webhook URL for lifecycle event notifications.
   * Overrides the webhook URL stored in the snapshot config (if any).
   *
   * @default undefined (uses webhook URL from snapshot, if set)
   */
  webhookUrl?: string
}

/**
 * State of the sandbox.
 */
export type SandboxState = 'running' | 'paused'

export interface SandboxListOpts extends SandboxApiOpts {
  /**
   * Filter the list of sandboxes, e.g. by metadata `metadata:{"key": "value"}`, if there are multiple filters they are combined with AND.
   *
   */
  query?: {
    metadata?: Record<string, string>
    /**
     * Filter the list of sandboxes by state.
     * @default ['running', 'paused']
     */
    state?: Array<SandboxState>
  }

  /**
   * Number of sandboxes to return per page.
   *
   * @default 100
   */
  limit?: number

  /**
   * Token to the next page.
   */
  nextToken?: string
}

export interface SandboxMetricsOpts extends SandboxApiOpts {
  /**
   * Start time for the metrics, defaults to the start of the sandbox
   */
  start?: string | Date
  /**
   * End time for the metrics, defaults to the current time
   */
  end?: string | Date
}

/**
 * Information about a sandbox.
 */
export interface SandboxInfo {
  /**
   * Sandbox ID.
   */
  sandboxId: string

  /**
   * Template ID.
   */
  templateId: string

  /**
   * Template name.
   */
  name?: string

  /**
   * Saved sandbox metadata.
   */
  metadata: Record<string, string>

  /**
   * Sandbox start time.
   */
  startedAt: Date

  /**
   * Sandbox expiration date.
   */
  endAt: Date

  /**
   * Sandbox state.
   *
   * @string can be `running` or `paused`
   */
  state: SandboxState

  /**
   * Sandbox CPU count.
   */
  cpuCount: number

  /**
   * Sandbox Memory size in MiB.
   */
  memoryMB: number

  /**
   * Envd version.
   */
  envdVersion: string

  /**
   * Webhook URL for lifecycle event notifications, if configured.
   */
  webhookUrl?: string

  /**
   * Build ID this sandbox started from (snapshot identifier).
   * `undefined` for fresh creates (no snapshot).
   */
  buildId?: string

  /**
   * Whether this sandbox was cold-started (rootfs only) vs full restored (local memfile).
   * `undefined` for fresh creates or paused sandboxes not currently running.
   */
  coldStart?: boolean
}

/**
 * Sandbox resource usage metrics.
 */
export interface SandboxMetrics {
  /**
   * Timestamp of the metrics.
   */
  timestamp: Date

  /**
   * CPU usage in percentage.
   */
  cpuUsedPct: number

  /**
   * Number of CPU cores.
   */
  cpuCount: number

  /**
   * Memory usage in bytes.
   */
  memUsed: number

  /**
   * Total memory available in bytes.
   */
  memTotal: number

  /**
   * Used disk space in bytes.
   */
  diskUsed: number

  /**
   * Total disk space available in bytes.
   */
  diskTotal: number
}

export class SandboxApi {
  protected constructor() {}

  /**
   * Kill (terminate) the sandbox specified by sandbox ID.
   *
   * Immediately stops the VM. All processes, memory, and unsaved state are lost.
   * Disk state is NOT saved — the sandbox cannot be resumed after kill.
   * Use `pause()` or `hibernate()` instead if you need to resume later.
   *
   * @param sandboxId sandbox ID.
   * @param opts connection options.
   *
   * @returns `true` if the sandbox was found and killed, `false` if not found (already dead).
   */
  static async kill(
    sandboxId: string,
    opts?: SandboxApiOpts
  ): Promise<boolean> {
    const config = new ConnectionConfig(opts)
    const client = new ApiClient(config)

    const res = await client.api.DELETE('/sandboxes/{sandboxID}', {
      params: {
        path: {
          sandboxID: sandboxId,
        },
      },
      signal: config.getSignal(opts?.requestTimeoutMs),
    })

    if (res.error?.code === 404) {
      return false
    }

    const err = handleApiError(res)
    if (err) {
      throw err
    }

    return true
  }

  /**
   * Get sandbox information like sandbox ID, template, metadata, started at/end at date.
   *
   * @param sandboxId sandbox ID.
   * @param opts connection options.
   *
   * @returns sandbox information.
   */
  static async getInfo(
    sandboxId: string,
    opts?: SandboxApiOpts
  ): Promise<SandboxInfo> {
    const fullInfo = await this.getFullInfo(sandboxId, opts)
    delete fullInfo.envdAccessToken
    delete fullInfo.sandboxDomain

    return fullInfo
  }

  /**
   * Get the metrics of the sandbox.
   *
   * @param sandboxId sandbox ID.
   * @param opts sandbox metrics options.
   *
   * @returns  List of sandbox metrics containing CPU, memory and disk usage information.
   */
  static async getMetrics(
    sandboxId: string,
    opts?: SandboxMetricsOpts
  ): Promise<SandboxMetrics[]> {
    const config = new ConnectionConfig(opts)
    const client = new ApiClient(config)

    const res = await client.api.GET('/sandboxes/{sandboxID}/metrics', {
      params: {
        path: {
          sandboxID: sandboxId,
          start: opts?.start,
          end: opts?.end,
        },
      },
      signal: config.getSignal(opts?.requestTimeoutMs),
    })

    const err = handleApiError(res)
    if (err) {
      throw err
    }

    return (
      res.data?.map((metric: components['schemas']['SandboxMetric']) => ({
        timestamp: new Date(metric.timestamp),
        cpuUsedPct: metric.cpuUsedPct,
        cpuCount: metric.cpuCount,
        memUsed: metric.memUsed,
        memTotal: metric.memTotal,
        diskUsed: metric.diskUsed,
        diskTotal: metric.diskTotal,
      })) ?? []
    )
  }

  /**
   * Set the timeout of the specified sandbox.
   * After the timeout expires the sandbox will be automatically killed.
   *
   * This method can extend or reduce the sandbox timeout set when creating the sandbox or from the last call to {@link Sandbox.setTimeout}.
   *
   * Maximum time a sandbox can be kept alive is 24 hours (86_400_000 milliseconds) for Pro users and 1 hour (3_600_000 milliseconds) for Hobby users.
   *
   * @param sandboxId sandbox ID.
   * @param timeoutMs timeout in **milliseconds**.
   * @param opts connection options.
   */
  static async setTimeout(
    sandboxId: string,
    timeoutMs: number,
    opts?: SandboxApiOpts
  ): Promise<void> {
    const config = new ConnectionConfig(opts)
    const client = new ApiClient(config)

    const res = await client.api.POST('/sandboxes/{sandboxID}/timeout', {
      params: {
        path: {
          sandboxID: sandboxId,
        },
      },
      body: {
        timeout: timeoutToSeconds(timeoutMs),
      },
      signal: config.getSignal(opts?.requestTimeoutMs),
    })

    if (res.error?.code === 404) {
      throw new NotFoundError(`Sandbox ${sandboxId} not found`)
    }

    const err = handleApiError(res)
    if (err) {
      throw err
    }
  }

  static async getFullInfo(sandboxId: string, opts?: SandboxApiOpts) {
    const config = new ConnectionConfig(opts)
    const client = new ApiClient(config)

    const res = await client.api.GET('/sandboxes/{sandboxID}', {
      params: {
        path: {
          sandboxID: sandboxId,
        },
      },
      signal: config.getSignal(opts?.requestTimeoutMs),
    })

    if (res.error?.code === 404) {
      throw new NotFoundError(`Sandbox ${sandboxId} not found`)
    }

    const err = handleApiError(res)
    if (err) {
      throw err
    }

    if (!res.data) {
      throw new Error('Sandbox not found')
    }

    return {
      sandboxId: res.data.sandboxID,
      templateId: res.data.templateID,
      ...(res.data.alias && { name: res.data.alias }),
      metadata: res.data.metadata ?? {},
      envdVersion: res.data.envdVersion,
      envdAccessToken: res.data.envdAccessToken,
      startedAt: new Date(res.data.startedAt),
      endAt: new Date(res.data.endAt),
      state: res.data.state,
      cpuCount: res.data.cpuCount,
      memoryMB: res.data.memoryMB,
      sandboxDomain: res.data.domain || undefined,
      webhookUrl: (res.data as any).webhookUrl || undefined,
      buildId: (res.data as any).buildID || undefined,
      coldStart: (res.data as any).coldStart ?? undefined,
    }
  }

  /**
   * @beta This feature is in beta and may change in the future.
   *
   * Full snapshot pause: saves memory + disk + VM state to GCS.
   *
   * On resume (via `connect()`), the VM restores exactly where it left off (~100-500ms).
   * Running processes, open sockets, and memory contents are all preserved.
   *
   * This is also the operation performed automatically by auto-pause when the sandbox
   * timeout expires (if `autoPauseMode` was set on create/connect).
   *
   * See module-level documentation for the full lifecycle state machine.
   *
   * @param sandboxId sandbox ID.
   * @param opts connection options.
   *
   * @returns `true` if the sandbox got paused, `false` if the sandbox was already paused.
   */
  static async pause(
    sandboxId: string,
    opts?: SandboxApiOpts
  ): Promise<string | false> {
    const config = new ConnectionConfig(opts)
    const client = new ApiClient(config)

    const res = await client.api.POST('/sandboxes/{sandboxID}/pause', {
      params: {
        path: {
          sandboxID: sandboxId,
        },
      },
      signal: config.getSignal(opts?.requestTimeoutMs),
    })

    if (res.error?.code === 404) {
      throw new NotFoundError(`Sandbox ${sandboxId} not found`)
    }

    if (res.error?.code === 409) {
      // Sandbox is already paused
      return false
    }

    const err = handleApiError(res)
    if (err) {
      throw err
    }

    // Return build_id from response (snapshot identifier)
    const data = res.data as any
    return data?.buildId || true as any
  }

  /**
   * @beta This feature is in beta and may change in the future.
   *
   * Hibernate (rootfs-only pause): saves only disk state to GCS, no memory snapshot.
   *
   * ~40-50% faster than full pause since it skips the memory/VM-state snapshot.
   * On resume (via `connect()`), the VM cold boots (~5-7s) with disk modifications
   * preserved but all processes and memory lost.
   *
   * Use this when you only need file persistence (installed packages, written configs,
   * downloaded data) and don't need running processes preserved.
   *
   * GCS artifacts: rootfs + rootfs.header + snapshot.json (NO memfile, NO snapfile).
   * On resume, the orchestrator detects no memfile and cold boots automatically.
   *
   * See module-level documentation for the full lifecycle state machine.
   *
   * @param sandboxId sandbox ID.
   * @param opts connection options.
   *
   * @returns `true` if the sandbox got hibernated, `false` if already paused/hibernated.
   */
  static async hibernate(
    sandboxId: string,
    opts?: SandboxApiOpts
  ): Promise<string | false> {
    const config = new ConnectionConfig(opts)
    const client = new ApiClient(config)

    const res = await client.api.POST('/sandboxes/{sandboxID}/hibernate' as any, {
      params: {
        path: {
          sandboxID: sandboxId,
        },
      },
      signal: config.getSignal(opts?.requestTimeoutMs),
    })

    if (res.error?.code === 404) {
      throw new NotFoundError(`Sandbox ${sandboxId} not found`)
    }

    if (res.error?.code === 409) {
      return false
    }

    const err = handleApiError(res)
    if (err) {
      throw err
    }

    // Return build_id from response (snapshot identifier)
    const data = res.data as any
    return data?.buildId || true as any
  }

  protected static async createSandbox(
    template: string,
    timeoutMs: number,
    opts?: SandboxOpts
  ) {
    const config = new ConnectionConfig(opts)
    const client = new ApiClient(config)

    // Extract udpIngress from network opts — gateway expects it at top level
    const { udpIngress, ...networkRest } = opts?.network ?? {} as SandboxNetworkOpts
    const networkBody = Object.keys(networkRest).length > 0 ? networkRest : undefined

    const res = await client.api.POST('/sandboxes', {
      body: {
        autoPauseMode: opts?.autoPauseMode ?? 'pause',
        templateID: template,
        sandboxID: opts?.sandboxId,
        metadata: opts?.metadata,
        mcp: opts?.mcp as Record<string, unknown> | undefined,
        envVars: opts?.envs,
        timeout: timeoutToSeconds(timeoutMs),
        secure: opts?.secure ?? true,
        allow_internet_access: opts?.allowInternetAccess ?? true,
        network: networkBody,
        udpIngress,
        webhookUrl: opts?.webhookUrl,
      } as any,
      signal: config.getSignal(opts?.requestTimeoutMs),
    })

    const err = handleApiError(res)
    if (err) {
      throw err
    }

    if (compareVersions(res.data!.envdVersion, '0.1.0') < 0) {
      await this.kill(res.data!.sandboxID, opts)
      throw new TemplateError(
        'You need to update the template to use the new SDK.'
      )
    }

    return {
      sandboxId: res.data!.sandboxID,
      sandboxDomain: res.data!.domain || undefined,
      envdVersion: res.data!.envdVersion,
      envdAccessToken: res.data!.envdAccessToken,
      trafficAccessToken: res.data!.trafficAccessToken || undefined,
      udpEndpoint: (res.data as any)?.udpEndpoint as UdpEndpoint | undefined,
    }
  }

  /**
   * Connect to an existing sandbox. Automatically resumes paused sandboxes.
   *
   * Resume behavior depends on what the snapshot contains:
   * - **Full snapshot** (pause / auto-pause with mode "pause"): instant restore (~100-500ms).
   * - **Hibernated** (hibernate / auto-pause with mode "hibernate"): cold boot (~5-7s).
   *
   * The orchestrator checks GCS for memfile. If present → snapshot restore. If not → cold boot.
   *
   * @param sandboxId sandbox ID.
   * @param opts connection options. `coldStart` forces cold boot even for full snapshots.
   *   `autoPauseMode` sets auto-pause mode for this session (must be specified on each connect).
   */
  protected static async connectSandbox(
    sandboxId: string,
    opts?: SandboxConnectOpts
  ) {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS

    const config = new ConnectionConfig(opts)
    const client = new ApiClient(config)

    const res = await client.api.POST('/sandboxes/{sandboxID}/connect', {
      params: {
        path: {
          sandboxID: sandboxId,
        },
      },
      body: {
        timeout: timeoutToSeconds(timeoutMs),
        autoPauseMode: opts?.autoPauseMode ?? 'pause',
        coldStart: opts?.coldStart ?? false,
        buildID: opts?.buildId,
        webhookUrl: opts?.webhookUrl,
      } as any,
      signal: config.getSignal(opts?.requestTimeoutMs),
    })

    if (res.error?.code === 404) {
      throw new NotFoundError(`Paused sandbox ${sandboxId} not found`)
    }

    const err = handleApiError(res)
    if (err) {
      throw err
    }

    return {
      sandboxId: res.data!.sandboxID,
      sandboxDomain: res.data!.domain || undefined,
      envdVersion: res.data!.envdVersion,
      envdAccessToken: res.data!.envdAccessToken,
      trafficAccessToken: res.data!.trafficAccessToken || undefined,
      udpEndpoint: (res.data as any)?.udpEndpoint as UdpEndpoint | undefined,
    }
  }
}

/**
 * Paginator for listing sandboxes.
 *
 * @example
 * ```ts
 * const paginator = Sandbox.list()
 *
 * while (paginator.hasNext) {
 *   const sandboxes = await paginator.nextItems()
 *   console.log(sandboxes)
 * }
 * ```
 */
export class SandboxPaginator {
  private _hasNext: boolean
  private _nextToken?: string

  private readonly config: ConnectionConfig
  private client: ApiClient

  private query: SandboxListOpts['query']
  private readonly limit?: number

  constructor(opts?: SandboxListOpts) {
    this.config = new ConnectionConfig(opts)
    this.client = new ApiClient(this.config)

    this._hasNext = true
    this._nextToken = opts?.nextToken

    this.query = opts?.query
    this.limit = opts?.limit
  }

  /**
   * Returns True if there are more items to fetch.
   */
  get hasNext(): boolean {
    return this._hasNext
  }

  /**
   * Returns the next token to use for pagination.
   */
  get nextToken(): string | undefined {
    return this._nextToken
  }

  /**
   * Get the next page of sandboxes.
   *
   * @throws Error if there are no more items to fetch. Call this method only if `hasNext` is `true`.
   *
   * @returns List of sandboxes
   */
  async nextItems(): Promise<SandboxInfo[]> {
    if (!this.hasNext) {
      throw new Error('No more items to fetch')
    }

    let metadata = undefined
    if (this.query?.metadata) {
      const encodedPairs: Record<string, string> = Object.fromEntries(
        Object.entries(this.query.metadata).map(([key, value]) => [
          encodeURIComponent(key),
          encodeURIComponent(value),
        ])
      )

      metadata = new URLSearchParams(encodedPairs).toString()
    }

    const res = await this.client.api.GET('/sandboxes', {
      params: {
        query: {
          metadata,
          state: this.query?.state,
          limit: this.limit,
          nextToken: this.nextToken,
        },
      },
      // requestTimeoutMs is already passed here via the connectionConfig.
      signal: this.config.getSignal(),
    })

    const err = handleApiError(res)
    if (err) {
      throw err
    }

    this._nextToken = res.response.headers.get('x-next-token') || undefined
    this._hasNext = !!this._nextToken

    return (res.data ?? []).map(
      (sandbox: components['schemas']['ListedSandbox']) => ({
        sandboxId: sandbox.sandboxID,
        templateId: sandbox.templateID,
        ...(sandbox.alias && { name: sandbox.alias }),
        metadata: sandbox.metadata ?? {},
        startedAt: new Date(sandbox.startedAt),
        endAt: new Date(sandbox.endAt),
        state: sandbox.state,
        cpuCount: sandbox.cpuCount,
        memoryMB: sandbox.memoryMB,
        envdVersion: sandbox.envdVersion,
      })
    )
  }
}
