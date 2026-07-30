/**
 * The Quick Build CLI.
 *
 *   neop index | check | resolve <template> [--with a,b]        QB0 registry
 *   neop spawn <template> <client>/<slug> [--owner x] [--with]  QB2 write spec
 *   neop dev <client>/<slug> [--contract id]                    QB2 run, irreversible stubbed
 *   neop run <client>/<slug> [--contract id]                    QB2 run, live tools
 *   neop list | reap <client>/<slug>                            fleet
 *   neop build "<requirement>" [--from-ref sha] [--owner x]     QB4 the Foreman
 *   neop promote <client>/<slug>                                QB5 commit the spec
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadRegistry, resolveTemplate, generateIndex } from "../src/quickbuild/registry.js";
import { listFleet, promoteNeop, reapNeop, runContract, runForeman, spawnNeop } from "../src/quickbuild/spawn.js";
import { buildModels } from "../src/pi/provider.js";
import { modelConfigFromEnv } from "../src/pi/config.js";

const registryDir = resolve(process.env.NEOP_REGISTRY_DIR ?? "./registry");
const repoRoot = resolve(process.env.NEOP_REPO_ROOT ?? ".");
const [, , cmd, ...args] = process.argv;

function arg(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<number> {
  const reg = loadRegistry(registryDir);
  for (const p of reg.problems) console.error(`problem: ${p}`);

  switch (cmd) {
    case "index": {
      const index = generateIndex(reg);
      writeFileSync(join(registryDir, "INDEX.md"), index, "utf8");
      console.log(`INDEX.md written — ${reg.tools.size} tools, ${reg.templates.size} templates`);
      return reg.problems.length ? 1 : 0;
    }
    case "check": {
      // every template must resolve cleanly with NO optionals; the all-optionals
      // pass may legitimately REFUSE (a template that ships pre-split, like sales,
      // offers optionals that must never be picked together) — that's a warning,
      // any other error is a failure
      let failures = reg.problems.length;
      for (const id of reg.templates.keys()) {
        for (const withOptional of [[], reg.templates.get(id)!.tools.optional]) {
          try {
            resolveTemplate(reg, id, { withOptional });
          } catch (e) {
            const msg = (e as Error).message;
            if (withOptional.length && /REFUSED/.test(msg)) {
              console.error(`note: ${id} (+all optionals) refuses by design — ${msg.slice(0, 100)}…`);
            } else {
              console.error(`resolve ${id}${withOptional.length ? " (+optionals)" : ""}: ${msg}`);
              failures += 1;
            }
          }
        }
      }
      const indexPath = join(registryDir, "INDEX.md");
      const fresh = existsSync(indexPath) && readFileSync(indexPath, "utf8") === generateIndex(reg);
      if (!fresh) {
        console.error("INDEX.md is stale or missing — run `neop index`");
        failures += 1;
      }
      console.log(failures ? `check: ${failures} problem(s)` : `check: clean — ${reg.tools.size} tools, ${reg.templates.size} templates`);
      return failures ? 1 : 0;
    }
    case "resolve": {
      const id = args[0];
      if (!id) {
        console.error("usage: neop resolve <template> [--with tool1,tool2]");
        return 1;
      }
      const withOptional = (arg("--with") ?? "").split(",").filter(Boolean);
      const r = resolveTemplate(reg, id, { withOptional });
      console.log(
        JSON.stringify(
          {
            template: `${r.templateId}@${r.templateVersion}`,
            tools: r.tools.map((t) => `${t.name}@${t.version} (${t.actionClass}${t.taint === "untrusted" ? ", UNTRUSTED" : ""})`),
            forbidden: r.forbidden,
            pins: r.pins,
            groundTruth: r.groundTruth,
            resources: r.resources,
            contracts: r.contracts,
            systemPromptChars: r.systemPrompt.length,
          },
          null,
          2,
        ),
      );
      return 0;
    }
    case "spawn": {
      const [template, slug] = args;
      if (!template || !slug) {
        console.error("usage: neop spawn <template> <client>/<slug> [--owner name] [--with a,b]");
        return 1;
      }
      const { spec, pins } = spawnNeop(repoRoot, reg, {
        slug,
        template,
        owner: arg("--owner") ?? "operator",
        withOptional: (arg("--with") ?? "").split(",").filter(Boolean),
      });
      console.log(`spawned ${slug} → ${spec}`);
      console.log(`pins: ${Object.entries(pins).map(([k, v]) => `${k}@${v}`).join(", ")}`);
      return 0;
    }
    case "dev":
    case "run": {
      const slug = args[0];
      if (!slug) {
        console.error(`usage: neop ${cmd} <client>/<slug> [--contract id]`);
        return 1;
      }
      const contractId = arg("--contract");
      const r = await runContract({
        repoRoot,
        registryDir,
        slug,
        ...(contractId ? { contractId } : {}),
        models: buildModels(modelConfigFromEnv()),
        dev: cmd === "dev",
      });
      for (const l of r.devLog) console.log(l);
      console.log(JSON.stringify({ status: r.outcome.status, reason: r.outcome.reason, verdict: r.outcome.verdict?.reasons, audit: r.auditFile, worktree: r.outcome.status === "landed" ? "(removed)" : r.worktree }, null, 2));
      return r.outcome.status === "landed" ? 0 : 1;
    }
    case "list": {
      for (const e of listFleet(repoRoot)) {
        console.log(`${e.slug}  template=${e.template}  owner=${e.owner}  worktrees=${e.worktrees.length}`);
      }
      return 0;
    }
    case "reap": {
      const slug = args[0];
      if (!slug) {
        console.error("usage: neop reap <client>/<slug>");
        return 1;
      }
      const { removed } = reapNeop(repoRoot, slug);
      console.log(removed.length ? `reaped: ${removed.join(", ")}` : "nothing running");
      return 0;
    }
    case "build": {
      const requirement = args.filter((a) => !a.startsWith("--")).join(" ");
      if (!requirement) {
        console.error('usage: neop build "<requirement>" [--from-ref sha] [--owner name]');
        return 1;
      }
      const fromRef = arg("--from-ref");
      const r = await runForeman({
        repoRoot,
        ...(fromRef ? { fromRef } : {}),
        requirement,
        owner: arg("--owner") ?? "operator",
        models: buildModels(modelConfigFromEnv()),
      });
      console.log(JSON.stringify({ status: r.outcome.status, reason: r.outcome.reason, verdict: r.outcome.verdict?.reasons, audit: r.auditFile }, null, 2));
      return r.outcome.status === "landed" ? 0 : 1;
    }
    case "promote": {
      const slug = args[0];
      if (!slug) {
        console.error("usage: neop promote <client>/<slug>");
        return 1;
      }
      console.log(promoteNeop(repoRoot, slug));
      console.log("PR when ready: gh pr create --title 'neop: " + slug + "'");
      return 0;
    }
    default:
      console.error("usage: neop <index|check|resolve|spawn|dev|run|list|reap|build|promote>");
      return 1;
  }
}

main().then((code) => process.exit(code));
