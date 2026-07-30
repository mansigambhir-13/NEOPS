/**
 * QB2 — the spec. One NEOP is one file: `neops/<client>/<slug>/spec.md`.
 * Frontmatter binds it to a template + optional tools + owner; the body is the
 * instance charter, appended to the template's prose at boot.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { splitFrontmatter } from "./registry.js";

export interface Spec {
  /** "<client>/<slug>" — the identity and the namespace. */
  slug: string;
  template: string;
  owner: string;
  withOptional: string[];
  /** tool → version, stamped at spawn (open decision #2: pinned in v1). */
  pins?: Record<string, string>;
  body: string;
  file: string;
}

export function specPath(repoRoot: string, slug: string): string {
  if (!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(slug)) {
    throw new Error(`slug "${slug}" must be <client>/<slug> (kebab-case both)`);
  }
  return join(repoRoot, "neops", slug, "spec.md");
}

export function parseSpec(text: string, file: string): Spec {
  const { meta, body } = splitFrontmatter(text, file);
  const req = (k: string): string => {
    const v = meta[k];
    if (typeof v !== "string" || !v.trim()) throw new Error(`${file}: spec "${k}" is required`);
    return v.trim();
  };
  return {
    slug: req("slug"),
    // models (and humans) naturally write "coding@1.0.0" — the pin lives in `pins`,
    // so strip a version suffix rather than failing resolution on it
    template: req("template").replace(/@[\w.^~-]+$/, ""),
    owner: req("owner"),
    withOptional: Array.isArray(meta.with_optional) ? meta.with_optional.map(String) : [],
    ...(meta.pins && typeof meta.pins === "object" ? { pins: meta.pins as Record<string, string> } : {}),
    body,
    file,
  };
}

export function loadSpec(repoRoot: string, slug: string): Spec {
  const p = specPath(repoRoot, slug);
  if (!existsSync(p)) throw new Error(`no spec for "${slug}" — expected ${p}`);
  return parseSpec(readFileSync(p, "utf8"), p);
}

export function writeSpec(
  repoRoot: string,
  spec: Omit<Spec, "file" | "body"> & { body?: string },
): string {
  const p = specPath(repoRoot, spec.slug);
  mkdirSync(dirname(p), { recursive: true });
  const pins = spec.pins
    ? ["pins:", ...Object.entries(spec.pins).map(([k, v]) => `  ${k}: "${v}"`)]
    : [];
  const doc = [
    "---",
    `slug: ${spec.slug}`,
    `template: ${spec.template}`,
    `owner: ${spec.owner}`,
    `with_optional: [${spec.withOptional.join(", ")}]`,
    ...pins,
    "---",
    "",
    spec.body?.trim() || `# ${spec.slug}\n\nInstance of the ${spec.template} template.`,
    "",
  ].join("\n");
  writeFileSync(p, doc, "utf8");
  return p;
}
