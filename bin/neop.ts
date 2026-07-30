/**
 * The Quick Build CLI (QB0 surface).
 *
 *   neop index                     regenerate registry/INDEX.md
 *   neop check                     load registry, report problems, verify INDEX fresh
 *   neop resolve <template> [--with tool1,tool2]   print the resolved contract
 *
 * Later phases add: build (Foreman), spawn, list, dev, promote, reap.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadRegistry, resolveTemplate, generateIndex } from "../src/quickbuild/registry.js";

const registryDir = resolve(process.env.NEOP_REGISTRY_DIR ?? "./registry");
const [, , cmd, ...args] = process.argv;

function arg(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function main(): number {
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
      // every template must resolve cleanly with no optionals and with ALL optionals
      let failures = reg.problems.length;
      for (const id of reg.templates.keys()) {
        for (const withOptional of [[], reg.templates.get(id)!.tools.optional]) {
          try {
            resolveTemplate(reg, id, { withOptional });
          } catch (e) {
            // a taint refusal on all-optionals is a finding, not necessarily a bug —
            // but check reports it so the template author has to look at it
            console.error(`resolve ${id}${withOptional.length ? " (+optionals)" : ""}: ${(e as Error).message}`);
            failures += 1;
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
    default:
      console.error("usage: neop <index|check|resolve> — QB0 surface; build/spawn/promote come with later phases");
      return 1;
  }
}

process.exit(main());
