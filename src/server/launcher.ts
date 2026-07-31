/**
 * Per-NEOP container launch — a spawned NEOP becomes its own ENTITY.
 *
 * The fleet's specs live on the shared /data volume; until now every run
 * executed in-process inside the plane's container. This module launches a
 * SIBLING container from the same image whose sole purpose is one NEOP's
 * contract run: `node dist/bin/neop.js run <slug>`. It talks to the Docker
 * Engine API over the unix socket directly (Node http over socketPath — no
 * docker CLI in the image, no dependencies).
 *
 * Posture: mounting the docker socket into the plane is the OPERATOR's choice
 * in compose (it is host-root-equivalent — the launch feature simply stays 501
 * without it). The children the plane launches are tighter than the plane
 * itself: CapDrop ALL, no-new-privileges, no socket of their own (a launched
 * NEOP cannot launch anything), fixed Cmd array (the slug is validated against
 * a strict shape and the fleet — never shell-interpolated).
 */

import { request } from "node:http";
import { existsSync } from "node:fs";

export interface LaunchConfig {
  /** image to boot — the same one the plane runs (compose pins `image:`). */
  image: string;
  /** named volume carrying /data (repo + registry + outbox + sessions). */
  volume: string;
  socketPath: string;
  /** plane environment to forward (allowlisted) into the child. */
  env: Record<string, string | undefined>;
}

/** Exact-name allowlist + prefixes a runner legitimately needs. Nothing else crosses. */
const ENV_FORWARD = ["OPENROUTER_API_KEY", "NEOP_PROVIDER", "NEOP_WORK_MODEL", "NEOP_VERIFY_MODEL", "NEOP_MODE", "NEOP_AUTONOMY"];
const ENV_FORWARD_PREFIX = ["NEOP_ADAPTER_", "NEOP_SECRET_"];

export function forwardEnv(env: Record<string, string | undefined>): string[] {
  const out: string[] = ["NEOP_REGISTRY_DIR=/data/repo/registry", "NEOP_REPO_ROOT=/data/repo"];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || v === "") continue;
    if (ENV_FORWARD.includes(k) || ENV_FORWARD_PREFIX.some((p) => k.startsWith(p))) out.push(`${k}=${v}`);
  }
  return out;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;

/** Pure: the container-create payload for one NEOP run. Throws on a bad slug. */
export function createSpec(slug: string, cfg: LaunchConfig): { name: string; body: Record<string, unknown> } {
  if (!SLUG_RE.test(slug)) throw new Error(`bad slug "${slug}" — expected <client>/<name>`);
  const name = `neop-run-${slug.replace("/", "-")}-${Date.now().toString(36)}`;
  return {
    name,
    body: {
      Image: cfg.image,
      Cmd: ["node", "dist/bin/neop.js", "run", slug],
      WorkingDir: "/app",
      Env: forwardEnv(cfg.env),
      Labels: { "neop.launch": "1", "neop.slug": slug },
      HostConfig: {
        Binds: [`${cfg.volume}:/data`],
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        AutoRemove: false, // kept for exit code + logs; reap cleans up
      },
    },
  };
}

export interface LaunchStatus {
  running: boolean;
  exitCode: number | null;
  /** the run's final JSON (status/reason/audit) parsed from the container log, once exited. */
  outcome: Record<string, unknown> | null;
  logsTail: string;
}

/** Minimal Docker Engine API client over the unix socket. */
export class DockerLauncher {
  constructor(private readonly cfg: LaunchConfig) {}

  available(): boolean {
    return existsSync(this.cfg.socketPath);
  }

  private api(method: string, path: string, body?: unknown): Promise<{ status: number; body: Buffer }> {
    return new Promise((resolvePromise, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = request(
        {
          socketPath: this.cfg.socketPath,
          method,
          path,
          headers: payload
            ? { "Content-Type": "application/json", "Content-Length": payload.length }
            : {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolvePromise({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        },
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async launch(slug: string): Promise<{ id: string; name: string }> {
    const spec = createSpec(slug, this.cfg);
    const create = await this.api("POST", `/containers/create?name=${encodeURIComponent(spec.name)}`, spec.body);
    if (create.status !== 201) throw new Error(`docker create failed (${create.status}): ${create.body.toString().slice(0, 200)}`);
    const id = (JSON.parse(create.body.toString()) as { Id: string }).Id;
    const start = await this.api("POST", `/containers/${id}/start`);
    if (start.status !== 204) throw new Error(`docker start failed (${start.status}): ${start.body.toString().slice(0, 200)}`);
    return { id, name: spec.name };
  }

  /** Demux docker's multiplexed log stream (8-byte frame headers). */
  private demux(raw: Buffer): string {
    const parts: string[] = [];
    let i = 0;
    while (i + 8 <= raw.length) {
      const size = raw.readUInt32BE(i + 4);
      parts.push(raw.subarray(i + 8, i + 8 + size).toString("utf8"));
      i += 8 + size;
    }
    return parts.length ? parts.join("") : raw.toString("utf8");
  }

  async status(id: string): Promise<LaunchStatus> {
    if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error("bad container id");
    const inspect = await this.api("GET", `/containers/${id}/json`);
    if (inspect.status !== 200) throw new Error(`no such launch (${inspect.status})`);
    const state = (JSON.parse(inspect.body.toString()) as { State: { Running: boolean; ExitCode: number } }).State;
    let outcome: Record<string, unknown> | null = null;
    let logsTail = "";
    if (!state.Running) {
      const logs = await this.api("GET", `/containers/${id}/logs?stdout=1&stderr=1&tail=200`);
      // docker log bytes are not guaranteed clean text — strip control chars
      // (frame-header remnants, ANSI) so the payload is safe for any JSON parser
      const text = this.demux(logs.body).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
      logsTail = text.slice(-2000);
      // the CLI's last stdout is the outcome JSON — parse the final {...} block
      const m = text.match(/\{[\s\S]*\}\s*$/);
      if (m) {
        try {
          outcome = JSON.parse(m[0]) as Record<string, unknown>;
        } catch {
          /* partial tail — logsTail still tells the story */
        }
      }
    }
    return { running: state.Running, exitCode: state.Running ? null : state.ExitCode, outcome, logsTail };
  }

  /** Block until the container exits (Docker's own wait endpoint — one call, no polling). */
  async wait(id: string): Promise<number> {
    if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error("bad container id");
    const res = await this.api("POST", `/containers/${id}/wait`);
    if (res.status !== 200) throw new Error(`docker wait failed (${res.status})`);
    return (JSON.parse(res.body.toString()) as { StatusCode: number }).StatusCode;
  }

  /** After exit: capture logs+outcome ONCE, then remove the container. */
  async harvest(id: string): Promise<LaunchStatus> {
    const st = await this.status(id);
    await this.remove(id).catch(() => {/* already gone is fine */});
    return st;
  }

  /** Remove a finished launch container (logs are already on the /data volume). */
  async remove(id: string): Promise<void> {
    if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error("bad container id");
    await this.api("DELETE", `/containers/${id}?force=false`);
  }
}
