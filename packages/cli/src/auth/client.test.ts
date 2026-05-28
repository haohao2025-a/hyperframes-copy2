import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthClient, apiBaseUrl, buildAuthHeaders } from "./client.js";
import { isAuthError } from "./errors.js";
import type { ResolvedCredential } from "./resolver.js";

function jsonFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

function textFetch(body: string, status: number): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch;
}

function apiKeyCred(): ResolvedCredential {
  return { type: "api_key", key: "hg_x", source: "env" };
}

function makeClient(fetchImpl: typeof fetch): AuthClient {
  return new AuthClient({ baseUrl: "https://api.test.example", fetchImpl });
}

describe("auth/client", () => {
  const original = process.env["HEYGEN_API_URL"];

  beforeEach(() => {
    delete process.env["HEYGEN_API_URL"];
  });

  afterEach(() => {
    if (original !== undefined) process.env["HEYGEN_API_URL"] = original;
    else delete process.env["HEYGEN_API_URL"];
  });

  it("apiBaseUrl defaults to https://api.heygen.com", () => {
    expect(apiBaseUrl()).toBe("https://api.heygen.com");
  });

  it("apiBaseUrl honors HEYGEN_API_URL and strips trailing slash", () => {
    process.env["HEYGEN_API_URL"] = "https://api.dev.heygen.com/";
    expect(apiBaseUrl()).toBe("https://api.dev.heygen.com");
  });

  it("buildAuthHeaders uses Bearer for oauth", () => {
    const cred: ResolvedCredential = {
      type: "oauth",
      access_token: "at_123",
      source: "file_json",
      refreshable: false,
    };
    expect(buildAuthHeaders(cred)).toEqual({ authorization: "Bearer at_123" });
  });

  it("buildAuthHeaders uses x-api-key for api_key", () => {
    expect(buildAuthHeaders(apiKeyCred())).toEqual({ "x-api-key": "hg_x" });
  });

  it("getCurrentUser parses a wrapped {data: {...}} payload", async () => {
    const client = makeClient(
      jsonFetch({
        code: 100,
        message: "ok",
        data: {
          username: "alice",
          email: "alice@example.com",
          billing_type: "subscription",
          subscription: {
            plan: "team",
            credits: {
              premium_credits: { remaining: 4200, resets_at: "2026-12-01T00:00:00Z" },
              add_on_credits: { remaining: 9 },
            },
          },
        },
      }),
    );
    const user = await client.getCurrentUser(apiKeyCred());
    expect(user.username).toBe("alice");
    expect(user.email).toBe("alice@example.com");
    expect(user.subscription?.plan).toBe("team");
    expect(user.subscription?.credits?.premium_credits?.remaining).toBe(4200);
    expect(user.subscription?.credits?.premium_credits?.resets_at).toBe("2026-12-01T00:00:00Z");
    expect(user.subscription?.credits?.add_on_credits?.remaining).toBe(9);
  });

  it("getCurrentUser parses an unwrapped payload", async () => {
    const client = makeClient(jsonFetch({ email: "bob@example.com" }));
    const user = await client.getCurrentUser(apiKeyCred());
    expect(user.email).toBe("bob@example.com");
  });

  it("getCurrentUser throws ErrUnauthenticated on 401", async () => {
    const client = makeClient(textFetch("invalid token", 401));
    await expect(client.getCurrentUser(apiKeyCred())).rejects.toSatisfy((err) => {
      return isAuthError(err) && (err as { code: string }).code === "UNAUTHENTICATED";
    });
  });

  it("getCurrentUser throws ErrApi on 5xx", async () => {
    const client = makeClient(textFetch("upstream", 503));
    await expect(client.getCurrentUser(apiKeyCred())).rejects.toSatisfy((err) => {
      return isAuthError(err) && (err as { code: string }).code === "API_ERROR";
    });
  });

  it("getCurrentUser throws ErrApi when 2xx body is not valid JSON", async () => {
    const fetchImpl = (async () =>
      new Response("<html>not json</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);
    await expect(client.getCurrentUser(apiKeyCred())).rejects.toSatisfy((err) => {
      return isAuthError(err) && (err as { code: string }).code === "API_ERROR";
    });
  });

  it("getCurrentUser returns empty UserInfo when payload.data is an array", async () => {
    const client = makeClient(jsonFetch({ code: 0, data: [{ email: "x@y" }] }));
    const user = await client.getCurrentUser(apiKeyCred());
    expect(user).toEqual({});
  });

  it("getCurrentUser scrubs hg_ keys and JWTs from 401 detail", async () => {
    const fetchImpl = textFetch(
      'invalid request — got header "x-api-key: hg_supersecret_abc123"',
      401,
    );
    const client = makeClient(fetchImpl);
    try {
      await client.getCurrentUser(apiKeyCred());
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain("hg_supersecret_abc123");
      expect(msg).toContain("<redacted>");
      return;
    }
    throw new Error("expected rejection");
  });

  it("getCurrentUser redacts the full Authorization: Bearer value (not just the scheme)", async () => {
    const fetchImpl = textFetch(
      "rejected — echoed Authorization: Bearer at_opaque_secret_999",
      401,
    );
    const client = makeClient(fetchImpl);
    try {
      await client.getCurrentUser(apiKeyCred());
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain("at_opaque_secret_999");
      expect(msg).not.toContain("Bearer at_opaque_secret_999");
      expect(msg).toContain("<redacted>");
      return;
    }
    throw new Error("expected rejection");
  });

  it("getCurrentUser sends the right header for oauth credentials", async () => {
    let captured: Record<string, string> = {};
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      captured = (init?.headers as Record<string, string>) ?? {};
      return new Response(JSON.stringify({ email: "alice@example.com" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    await client.getCurrentUser({
      type: "oauth",
      access_token: "at_xyz",
      source: "file_json",
      refreshable: false,
    });
    expect(captured["authorization"]).toBe("Bearer at_xyz");
  });
});
