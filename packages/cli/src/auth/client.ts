/**
 * Minimal typed HTTP client for HeyGen endpoints needed by the auth
 * commands. Hand-written rather than codegen'd because the surface is
 * one endpoint (`/v3/users/me`) and pulling in an OpenAPI pipeline is
 * disproportionate.
 *
 * Reads `HEYGEN_API_URL` (default `https://api.heygen.com`) so dev
 * testing is one env var away.
 *
 * Auth header selection:
 *   - OAuth → `Authorization: Bearer <token>`
 *   - API key → `x-api-key: <key>`
 *
 * The backend `/v3/users/me` accepts both. See
 * `movio/api_service/app/controller/user_v3.py`.
 */

import { ErrApi, ErrUnauthenticated } from "./errors.js";
import type { ResolvedCredential } from "./resolver.js";

const DEFAULT_BASE_URL = "https://api.heygen.com";

export function apiBaseUrl(): string {
  const override = process.env["HEYGEN_API_URL"];
  return override && override.length > 0 ? override.replace(/\/+$/, "") : DEFAULT_BASE_URL;
}

export type BillingType = "wallet" | "subscription" | "usage_based" | string;

export interface WalletInfo {
  currency?: string;
  remaining_balance?: number;
  auto_reload?: boolean;
}

/**
 * The API returns `credits.{premium,add_on}_credits` as nested objects
 * (`{ remaining, resets_at? }`), not bare numbers — discovered live
 * against api.heygen.com. Modelling them as nested objects so the row
 * formatter can render them properly instead of `[object Object]`.
 */
export interface CreditBalance {
  remaining?: number;
  resets_at?: string;
}

export interface SubscriptionInfo {
  plan?: string;
  credits?: {
    premium_credits?: CreditBalance;
    add_on_credits?: CreditBalance;
  };
}

export interface UsageBasedInfo {
  spending_current_usd?: number;
  spending_cap_usd?: number;
}

/** Subset of the backend response we surface to users today. */
export interface UserInfo {
  username?: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  billing_type?: BillingType;
  wallet?: WalletInfo;
  subscription?: SubscriptionInfo;
  usage_based?: UsageBasedInfo;
}

export interface AuthClientOptions {
  /** Override base URL (otherwise `HEYGEN_API_URL` / default). */
  baseUrl?: string;
  /** Inject a custom fetch (used by tests). */
  fetchImpl?: typeof fetch;
}

export class AuthClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AuthClientOptions = {}) {
    this.base = (opts.baseUrl ?? apiBaseUrl()).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * `GET /v3/users/me`. Throws `ErrUnauthenticated` on 401, `ErrApi`
   * on any other non-2xx or non-JSON body.
   */
  async getCurrentUser(credential: ResolvedCredential): Promise<UserInfo> {
    const url = `${this.base}/v3/users/me`;
    const headers = buildAuthHeaders(credential);
    const res = await this.fetchImpl(url, { method: "GET", headers });

    if (res.status === 401) {
      const detail = await safeText(res);
      throw ErrUnauthenticated(detail || `${res.status} ${res.statusText}`);
    }
    if (!res.ok) {
      throw ErrApi(res.status, (await safeText(res)) || res.statusText);
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch (err) {
      throw ErrApi(res.status, `non-JSON body: ${(err as Error).message}`);
    }
    return extractUserInfo(payload);
  }
}

export function buildAuthHeaders(credential: ResolvedCredential): Record<string, string> {
  if (credential.type === "oauth") {
    return { authorization: `Bearer ${credential.access_token}` };
  }
  return { "x-api-key": credential.key };
}

async function safeText(res: Response): Promise<string> {
  try {
    const body = (await res.text()).slice(0, 500);
    return scrubCredentials(body);
  } catch {
    return "";
  }
}

/**
 * Strip credential-shaped substrings from error bodies before they
 * surface in user-facing messages or `--json` output. Some proxies
 * echo request headers in their error pages and we never want a
 * HeyGen API key, OAuth bearer, or JWT to land in scrollback / CI
 * logs because of one of those echoes.
 */
function scrubCredentials(s: string): string {
  return (
    s
      .replace(/hg_[A-Za-z0-9_-]{4,}/g, "hg_<redacted>")
      // Redact the ENTIRE header value to end-of-line — `Bearer <token>`
      // is two whitespace-separated words, so a `\S+` would leave the
      // opaque token exposed after the scheme.
      .replace(/(authorization|x-api-key)[ \t]*[:=][ \t]*[^\r\n]+/gi, "$1: <redacted>")
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "<jwt-redacted>")
  );
}

/**
 * The backend wraps responses in `{code, message, data: {...}}` for some
 * endpoints and returns raw fields directly for others. Handle both.
 */
function extractUserInfo(payload: unknown): UserInfo {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const obj = payload as Record<string, unknown>;
  const wrapped = obj["data"];
  const data =
    wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)
      ? (wrapped as Record<string, unknown>)
      : obj;
  return {
    username: pickString(data, "username"),
    email: pickString(data, "email"),
    first_name: pickString(data, "first_name"),
    last_name: pickString(data, "last_name"),
    billing_type: pickString(data, "billing_type"),
    wallet: pickObject(data, "wallet") as WalletInfo | undefined,
    subscription: pickObject(data, "subscription") as SubscriptionInfo | undefined,
    usage_based: pickObject(data, "usage_based") as UsageBasedInfo | undefined,
  };
}

function pickString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

function pickObject(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const v = obj[key];
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}
