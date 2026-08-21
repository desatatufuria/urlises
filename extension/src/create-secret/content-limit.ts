// Pure helper for the create-secret page's live character-count/limit
// heads-up. Kept side-effect free (no DOM access) so it can be unit tested
// directly, mirroring popup/advanced-toggle.ts and popup/status-detail.ts.

/** AES-GCM appends a fixed 16-byte auth tag to the ciphertext before it is
 * base64-encoded, independent of plaintext length. */
export const GCM_TAG_BYTES = 16;

/** Server-side hard cap on the base64-encoded ciphertext wire value — see
 * backend/internal/secrethide/handler.go's maxCiphertextBase64Bytes. */
export const MAX_CIPHERTEXT_BASE64_BYTES = 64 * 1024;

/** Fraction of the cap at which the UI should start warning the user,
 * before they hit a hard failure on submit. */
const WARNING_THRESHOLD = 0.9;

export type ContentLimitLevel = "ok" | "warning" | "over";

export interface ContentLimitStatus {
  estimatedCiphertextBase64Bytes: number;
  capBytes: number;
  level: ContentLimitLevel;
}

/**
 * Estimates the base64-encoded ciphertext size that AES-GCM-encrypting
 * `contentByteLength` bytes of plaintext will produce (GCM tag overhead +
 * base64's 4/3 expansion), and classifies it against the server's hard cap
 * so the UI can warn before submit instead of only failing after.
 */
export function estimateContentLimitStatus(contentByteLength: number): ContentLimitStatus {
  const cipherBytes = contentByteLength + GCM_TAG_BYTES;
  const estimatedCiphertextBase64Bytes = Math.ceil(cipherBytes / 3) * 4;
  const level: ContentLimitLevel =
    estimatedCiphertextBase64Bytes > MAX_CIPHERTEXT_BASE64_BYTES
      ? "over"
      : estimatedCiphertextBase64Bytes > MAX_CIPHERTEXT_BASE64_BYTES * WARNING_THRESHOLD
        ? "warning"
        : "ok";
  return { estimatedCiphertextBase64Bytes, capBytes: MAX_CIPHERTEXT_BASE64_BYTES, level };
}
