/**
 * Model routing config (§7.4) — provider + model ids stay OUT of code and behind
 * config/env, so no key is needed to build or test. A live run supplies the
 * provider's own key (e.g. ANTHROPIC_API_KEY), resolved by pi-ai's provider auth.
 *
 * The working turn gets the big model; verification gets a small/cheap one. Both
 * default to sensible Anthropic ids but any provider that pi-ai knows works via env.
 */

/** Resolved model routing for one worker. */
export interface ModelConfig {
  /** pi-ai provider id, e.g. "anthropic", "openai". */
  provider: string;
  /** Model id for the working turn (the doer). */
  work: string;
  /** Model id for the cold verifier (§6.1) — smaller/cheaper. */
  verify: string;
}

/** Defaults used when the environment does not pin a provider/model. */
export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  provider: "anthropic",
  work: "claude-sonnet-5",
  verify: "claude-haiku-4-5",
};

/**
 * Read model routing from the environment, falling back to {@link DEFAULT_MODEL_CONFIG}.
 * Kept pure over an injected `env` map so it is testable without touching process.env.
 */
export function modelConfigFromEnv(env: Record<string, string | undefined> = process.env): ModelConfig {
  return {
    provider: env.NEOP_PROVIDER?.trim() || DEFAULT_MODEL_CONFIG.provider,
    work: env.NEOP_WORK_MODEL?.trim() || DEFAULT_MODEL_CONFIG.work,
    verify: env.NEOP_VERIFY_MODEL?.trim() || DEFAULT_MODEL_CONFIG.verify,
  };
}
