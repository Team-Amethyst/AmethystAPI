import { readFileSync } from "fs";
import { join } from "path";

let cached: string | null = null;

/**
 * Label for operators and `context_v2` — not the pricing algorithm itself.
 * Resolution order: `VALUATION_MODEL_VERSION` → short git SHA env → `package.json` name@version.
 */
export function getValuationModelVersion(): string {
  if (cached !== null) {
    return cached;
  }
  const explicit = process.env.VALUATION_MODEL_VERSION?.trim();
  if (explicit) {
    cached = explicit;
    return cached;
  }
  const sha =
    process.env.GITHUB_SHA?.trim() ||
    process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
    process.env.GIT_COMMIT?.trim();
  if (sha) {
    cached = sha.length > 12 ? sha.slice(0, 12) : sha;
    return cached;
  }
  try {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8")
    ) as { name?: string; version?: string };
    const ver = pkg.version ?? "0.0.0";
    const name = pkg.name ?? "amethyst-api";
    cached = `${name}@${ver}`;
    return cached;
  } catch {
    cached = "amethyst-api@unknown";
    return cached;
  }
}
