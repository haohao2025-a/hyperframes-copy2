/**
 * `hyperframes auth login` — write a HeyGen credential to
 * `~/.heygen/credentials`.
 *
 * This first cut ships the `--api-key` path only. Running `auth login`
 * without `--api-key` prints a pointer at the OAuth PKCE work that
 * lands in a follow-up.
 *
 * Inputs:
 *   - `--api-key=<value>` — take the value inline (note: may leak into
 *     shell history).
 *   - `--api-key` with stdin piped — read one line from stdin.
 *   - `--api-key` interactive — `@clack/prompts` password input.
 *
 * Write semantics:
 *   - Read the existing credential file first; preserve any `oauth`
 *     block so saving a new API key doesn't wipe an OAuth session.
 *   - Sanity-check that the input is non-empty and header-safe (no
 *     CR/LF) before touching disk. The backend's `/v3/users/me` is
 *     the source of truth for whether the key is actually valid —
 *     we do NOT shape-check the prefix (real keys come in multiple
 *     formats: `sk_V2_…`, `hg_…`, partner keys, etc.).
 *   - Verify via `GET /v3/users/me`. On 401, roll back to the previous
 *     state — leaving a confirmed-invalid key on disk would silently
 *     break subsequent commands. On other errors (network blip, 5xx)
 *     keep the new key so retries don't require re-typing.
 */

import { defineCommand } from "citty";
import { stdin as input } from "node:process";
import {
  AuthClient,
  deleteStore,
  isAuthError,
  isHeaderSafe,
  readStore,
  writeStore,
  type Credentials,
} from "../../auth/index.js";
import { c } from "../../ui/colors.js";

const STDIN_TIMEOUT_MS = 30_000;
// Smallest plausible length for a real API key. We don't validate the
// prefix or character set — the backend's /v3/users/me is the source
// of truth and rolls back on rejection. The only must-check is
// header-safety (CR/LF), which `isHeaderSafe` covers.
const MIN_KEY_LENGTH = 8;

export default defineCommand({
  meta: {
    name: "login",
    description: "Sign in to HeyGen by saving an API key (OAuth coming soon)",
  },
  args: {
    "api-key": {
      type: "string",
      description:
        "API key value. Pass `--api-key` with no value to read from stdin or interactively.",
    },
  },
  // fallow-ignore-next-line complexity
  async run({ args }) {
    const inlineKey = args["api-key"];
    if (inlineKey === undefined) {
      printOAuthPlaceholder();
      process.exit(1);
    }

    const key = await collectApiKey(inlineKey);
    if (!key) {
      console.error(c.error("No API key provided."));
      process.exit(1);
    }
    if (!isHeaderSafe(key)) {
      // CR/LF in the value would smuggle headers when the key is sent
      // via `x-api-key`. The backend handles "wrong key" itself, but
      // header-injection has to be caught here.
      console.error(c.error("API key must not contain newline or control characters."));
      process.exit(1);
    }
    if (key.length < MIN_KEY_LENGTH) {
      console.error(c.error(`API key looks too short (got ${key.length} chars).`));
      process.exit(1);
    }

    const previous = await snapshotStore();
    const next: Credentials = { ...previous, api_key: key };
    await writeStore(next);

    const verifyOk = await verifyAndReport(key);
    if (!verifyOk) {
      await rollback(previous);
      process.exit(1);
    }
  },
});

function printOAuthPlaceholder(): void {
  console.error(
    `${c.warn("Browser-based login isn't ready yet.")} ` +
      `Re-run with ${c.accent("--api-key")} to save an API key, ` +
      `or pipe one in:\n` +
      `  ${c.accent("echo $HEYGEN_API_KEY | hyperframes auth login --api-key")}`,
  );
}

async function snapshotStore(): Promise<Credentials> {
  try {
    const { credentials } = await readStore();
    return { ...credentials };
  } catch {
    // Existing file is unreadable; treat as empty so the new key still
    // lands cleanly. The previous bytes are lost either way.
    return {};
  }
}

async function rollback(previous: Credentials): Promise<void> {
  try {
    if (previous.api_key || previous.oauth) {
      await writeStore(previous);
      console.error(c.dim("Rolled back to the previous credential."));
    } else {
      // No prior credential — restore true absence. Leaving the
      // rejected key on disk would make the next `auth status` /
      // command silently resolve a known-bad key.
      await deleteStore();
      console.error(c.dim("Removed the rejected credential."));
    }
  } catch (err) {
    console.error(c.error(`Failed to roll back: ${(err as Error).message}`));
  }
}

/**
 * Returns `true` on successful verify, `false` on a 401. Other errors
 * (network blip, 5xx) bubble out — the caller leaves the new key in
 * place since the issue is transient.
 */
// fallow-ignore-next-line complexity
async function verifyAndReport(key: string): Promise<boolean> {
  const client = new AuthClient();
  try {
    const user = await client.getCurrentUser({ type: "api_key", key, source: "file_json" });
    const identity = user.email ?? user.username ?? "(unknown user)";
    console.log(c.success(`✓ API key saved. Authenticated as ${identity}.`));
    return true;
  } catch (err) {
    if (isAuthError(err) && err.code === "UNAUTHENTICATED") {
      console.error(
        `${c.warn("HeyGen rejected the API key.")}\n` +
          `  ${c.dim(err.message)}\n` +
          `Run ${c.accent("hyperframes auth login --api-key")} again with a valid key.`,
      );
      return false;
    }
    throw err;
  }
}

/**
 * Citty's arg type for `--api-key` is `string`, so:
 *   - `--api-key=hg_x` → `"hg_x"`
 *   - `--api-key ""` / `--api-key` with no value → `""` → fall through
 *     to stdin/prompt.
 */
async function collectApiKey(inline: string): Promise<string> {
  if (inline.length > 0) return inline.trim();
  if (!input.isTTY) {
    return (await readAllWithTimeout(input, STDIN_TIMEOUT_MS)).trim();
  }
  return await promptForKey();
}

/**
 * Read all of stdin, or bail with an empty string after `timeoutMs`.
 * Hanging forever when stdin is non-TTY but unattached (Docker `-d`,
 * some CI shells) is worse than a clear timeout.
 */
async function readAllWithTimeout(
  stream: NodeJS.ReadableStream,
  timeoutMs: number,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for stdin (${timeoutMs}ms). Pipe the key explicitly.`));
    }, timeoutMs);
    stream.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    stream.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    stream.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function promptForKey(): Promise<string> {
  const clack = await import("@clack/prompts");
  const value = await clack.password({
    message: "Enter HeyGen API key",
    validate: (v) => {
      if (!v || v.length < MIN_KEY_LENGTH) return "API key looks too short";
      if (!isHeaderSafe(v)) return "API key must not contain newline or control characters";
      return undefined;
    },
  });
  if (clack.isCancel(value)) {
    console.error("Aborted.");
    process.exit(1);
  }
  return value.trim();
}
