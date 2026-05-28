/**
 * Typed errors for the auth layer. Callers branch on `code` so commands
 * can map specific failures to friendly UX without parsing messages.
 */

export type AuthErrorCode = "NOT_CONFIGURED" | "INVALID_STORE" | "API_ERROR" | "UNAUTHENTICATED";

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly hint?: string;

  constructor(code: AuthErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.hint = hint;
  }
}

export const ErrNotConfigured = () =>
  new AuthError(
    "NOT_CONFIGURED",
    "No HeyGen credentials found",
    "Run `hyperframes auth login` to sign in.",
  );

export const ErrInvalidStore = (detail: string) =>
  new AuthError(
    "INVALID_STORE",
    `Credential file is unreadable: ${detail}`,
    "Delete ~/.heygen/credentials and run `hyperframes auth login` to re-create it.",
  );

export const ErrUnauthenticated = (detail?: string) =>
  new AuthError(
    "UNAUTHENTICATED",
    detail ? `HeyGen rejected the credential: ${detail}` : "HeyGen rejected the credential",
    "Run `hyperframes auth login` to re-authenticate.",
  );

export const ErrApi = (status: number, detail: string) =>
  new AuthError("API_ERROR", `HeyGen API error (${status}): ${detail}`);

export function isAuthError(err: unknown): err is AuthError {
  return err instanceof AuthError;
}
