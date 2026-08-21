// Dedicated create-secret window, opened programmatically by popup.ts via
// chrome.windows.create. Reuses the exact same zero-knowledge crypto flow
// popup.ts used to run inline (shared/crypto.ts) and the same background
// message contract (session/get, secrets/create, secrets/send-email), just
// with more room than the popup's collapsible panel allowed.
//
// DOM wiring in this file is intentionally not unit tested, matching this
// repo's existing coverage boundary: popup.ts's DOM glue isn't directly
// unit tested either — the pure/testable logic it depends on
// (content-limit.ts, shared/api.ts, background/projection.ts) is.

import { DEFAULT_PUBLIC_BASE_URL } from "../shared/runtime.js";
import { deriveWrappingKey, encrypt, exportContentKey, generateContentKey, wrapKey } from "../shared/crypto.js";
import { sendMessage } from "../shared/messaging.js";
import type { UiState } from "../shared/types.js";
import { estimateContentLimitStatus } from "./content-limit.js";

const signedOutNotice = document.querySelector<HTMLElement>("#signed-out-notice")!;
const createFormSection = document.querySelector<HTMLElement>("#create-form-section")!;
const createSecretForm = document.querySelector<HTMLFormElement>("#create-secret-form")!;
const createSecretSubmit = document.querySelector<HTMLButtonElement>("#create-secret-submit")!;
const secretContentInput = document.querySelector<HTMLTextAreaElement>("#secret-content")!;
const contentLimitHint = document.querySelector<HTMLElement>("#content-limit-hint")!;
const secretPassphraseInput = document.querySelector<HTMLInputElement>("#secret-passphrase")!;
const secretTtlSelect = document.querySelector<HTMLSelectElement>("#secret-ttl")!;
const secretCreateError = document.querySelector<HTMLElement>("#secret-create-error")!;

const secretLinkResult = document.querySelector<HTMLElement>("#secret-link-result")!;
const secretLinkOutput = document.querySelector<HTMLInputElement>("#secret-link-output")!;
const copySecretLinkButton = document.querySelector<HTMLButtonElement>("#copy-secret-link")!;

const sendEmailForm = document.querySelector<HTMLFormElement>("#send-email-form")!;
const recipientEmailInput = document.querySelector<HTMLInputElement>("#recipient-email")!;
const sendEmailFeedback = document.querySelector<HTMLElement>("#send-email-feedback")!;
const sendEmailError = document.querySelector<HTMLElement>("#send-email-error")!;

let publicBaseUrl = DEFAULT_PUBLIC_BASE_URL;
let createdToken: string | undefined;
let createdFragmentKey: string | undefined;

secretContentInput.addEventListener("input", renderContentLimitHint);

createSecretForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void runCreateSecret().catch(showSecretCreateError);
});

copySecretLinkButton.addEventListener("click", () => {
  void copySecretLink();
});

sendEmailForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void runSendSecretEmail().catch(showSendEmailError);
});

renderContentLimitHint();
void bootstrap().catch(showSecretCreateError);

async function bootstrap(): Promise<void> {
  const ui = await sendMessage<UiState>({ type: "session/get" });
  if (ui.state.settings.publicBaseUrl) {
    publicBaseUrl = ui.state.settings.publicBaseUrl;
  }
  const signedIn = Boolean(ui.state.session);
  signedOutNotice.classList.toggle("hidden", signedIn);
  createFormSection.classList.toggle("hidden", !signedIn);
}

function renderContentLimitHint(): void {
  const contentByteLength = new TextEncoder().encode(secretContentInput.value).byteLength;
  const status = estimateContentLimitStatus(contentByteLength);
  const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

  if (status.level === "over") {
    contentLimitHint.textContent = `${kb(status.estimatedCiphertextBase64Bytes)} of ${kb(status.capBytes)} max — too large, trim the content before creating the link.`;
  } else if (status.level === "warning") {
    contentLimitHint.textContent = `${kb(status.estimatedCiphertextBase64Bytes)} of ${kb(status.capBytes)} max — getting close to the limit.`;
  } else {
    contentLimitHint.textContent = secretContentInput.value ? `${secretContentInput.value.length} characters` : "";
  }
  contentLimitHint.classList.toggle("ui-error", status.level === "over");
  createSecretSubmit.disabled = status.level === "over";
}

async function runCreateSecret(): Promise<void> {
  clearSecretCreateError();
  const content = secretContentInput.value;
  if (!content) {
    return;
  }

  const contentByteLength = new TextEncoder().encode(content).byteLength;
  if (estimateContentLimitStatus(contentByteLength).level === "over") {
    throw new Error("Content is too large — trim it below the 64 KB limit and try again.");
  }

  const passphrase = secretPassphraseInput.value;
  const ttlSeconds = Number(secretTtlSelect.value);

  const contentKey = await generateContentKey();
  const { ciphertext, iv } = await encrypt(contentKey, content);

  let wrappedContentKey: string | undefined;
  let passphraseSalt: string | undefined;
  let kdfIterations: number | undefined;
  let fragmentKey: string | undefined;

  if (passphrase) {
    const wrapping = await deriveWrappingKey(passphrase);
    wrappedContentKey = await wrapKey(wrapping.key, contentKey);
    passphraseSalt = wrapping.salt;
    kdfIterations = wrapping.iterations;
  } else {
    fragmentKey = await exportContentKey(contentKey);
  }

  const response = await sendMessage<UiState & { secret: { id: string; token: string; createdAt: string; expiresAt: string } }>({
    type: "secrets/create",
    payload: { ciphertext, iv, wrappedContentKey, passphraseSalt, kdfIterations, ttlSeconds },
  });

  if (response.state.settings.publicBaseUrl) {
    publicBaseUrl = response.state.settings.publicBaseUrl;
  }
  createdToken = response.secret.token;
  createdFragmentKey = fragmentKey;
  renderSecretLink(response.secret.token, fragmentKey);
  clearSendEmailFeedback();
  createSecretForm.reset();
  renderContentLimitHint();
}

function buildFragment(fragmentKey?: string): string | undefined {
  return fragmentKey ? `k=${encodeURIComponent(fragmentKey)}` : undefined;
}

function renderSecretLink(token: string, fragmentKey?: string): void {
  const fragment = buildFragment(fragmentKey);
  const link = `${publicBaseUrl}/s/${token}${fragment ? `#${fragment}` : ""}`;
  secretLinkOutput.value = link;
  secretLinkResult.classList.remove("hidden");
  copySecretLinkButton.textContent = "Copy";
}

async function copySecretLink(): Promise<void> {
  const link = secretLinkOutput.value;
  if (!link) {
    return;
  }

  try {
    await navigator.clipboard.writeText(link);
  } catch {
    secretLinkOutput.select();
    document.execCommand("copy");
  }

  copySecretLinkButton.textContent = "Copied";
  setTimeout(() => {
    copySecretLinkButton.textContent = "Copy";
  }, 2000);
}

async function runSendSecretEmail(): Promise<void> {
  clearSendEmailFeedback();
  if (!createdToken) {
    showSendEmailError(new Error("Create a secret first."));
    return;
  }
  const recipientEmail = recipientEmailInput.value.trim();
  if (!recipientEmail) {
    return;
  }

  await sendMessage<UiState>({
    type: "secrets/send-email",
    payload: { token: createdToken, recipientEmail, fragment: buildFragment(createdFragmentKey) },
  });

  sendEmailFeedback.textContent = `Sent to ${recipientEmail}.`;
  sendEmailForm.reset();
}

function showSecretCreateError(error: unknown): void {
  secretCreateError.textContent = error instanceof Error ? error.message : "Could not create this secret";
}

function clearSecretCreateError(): void {
  secretCreateError.textContent = "";
}

function showSendEmailError(error: unknown): void {
  sendEmailError.textContent = error instanceof Error ? error.message : "Could not send this secret by email";
}

function clearSendEmailFeedback(): void {
  sendEmailFeedback.textContent = "";
  sendEmailError.textContent = "";
}
