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
import type { SecretRecipient, UiState } from "../shared/types.js";
import { estimateContentLimitStatus } from "./content-limit.js";
import { filterRecipients } from "./recipient-filter.js";

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
const createAnotherSecretButton = document.querySelector<HTMLButtonElement>("#create-another-secret")!;

const sendEmailForm = document.querySelector<HTMLFormElement>("#send-email-form")!;
const recipientEmailInput = document.querySelector<HTMLInputElement>("#recipient-email")!;
const sendEmailFeedback = document.querySelector<HTMLElement>("#send-email-feedback")!;
const sendEmailError = document.querySelector<HTMLElement>("#send-email-error")!;

const recipientPicker = document.querySelector<HTMLElement>("#recipient-picker")!;
const recipientFilterInput = document.querySelector<HTMLInputElement>("#recipient-filter")!;
const recipientOptionsList = document.querySelector<HTMLUListElement>("#recipient-options")!;
const recipientPickerHint = document.querySelector<HTMLElement>("#recipient-picker-hint")!;

let publicBaseUrl = DEFAULT_PUBLIC_BASE_URL;
let createdToken: string | undefined;
let createdFragmentKey: string | undefined;

// RecipientDirectoryState mirrors design.md's state machine exactly: the
// picker is a progressive-enhancement layer over the free-text
// #recipient-email input, never a gate on it (see the degradation table in
// renderRecipientPicker below).
type RecipientDirectoryState =
  | { status: "loading" }
  | { status: "ready"; candidates: SecretRecipient[] }
  | { status: "error" };

let recipientDirectoryState: RecipientDirectoryState = { status: "loading" };

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

createAnotherSecretButton.addEventListener("click", () => {
  resetToCreateForm();
});

recipientFilterInput.addEventListener("input", renderRecipientPicker);

// One delegated listener on the list itself, not per-item: the list is
// rebuilt on every keystroke (renderRecipientPicker), so per-item listeners
// would leak. See design.md's "Selection wiring" section.
recipientOptionsList.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const option = target.closest<HTMLElement>("[data-email]");
  if (!option?.dataset.email) {
    return;
  }
  recipientEmailInput.value = option.dataset.email;
  recipientFilterInput.value = "";
  renderRecipientPicker();
  recipientEmailInput.focus();
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

  // Fire-and-forget: awaiting this would delay the signed-in/signed-out
  // gate render above on every open (design.md Decision 13). The picker
  // renders in its own "loading" state until this resolves.
  void loadRecipients();
}

// loadRecipients fetches the directory once per window open via the
// background message bus (never shared/api.ts directly — see design.md's
// architecture note: api.ts signs requests with the background's in-memory
// runtime token, which is never populated in this window).
async function loadRecipients(): Promise<void> {
  try {
    const candidates = await sendMessage<SecretRecipient[]>({ type: "secrets/recipients" });
    recipientDirectoryState = { status: "ready", candidates };
  } catch {
    recipientDirectoryState = { status: "error" };
  }
  renderRecipientPicker();
}

// renderRecipientPicker implements design.md's six-row degradation table.
// #recipient-email is never disabled in any state -- the picker is a
// progressive enhancement over free-text entry, never a gate on it.
function renderRecipientPicker(): void {
  if (recipientDirectoryState.status === "loading") {
    recipientPicker.classList.add("hidden");
    recipientPickerHint.textContent = "";
    return;
  }

  if (recipientDirectoryState.status === "error") {
    recipientPicker.classList.add("hidden");
    recipientPickerHint.textContent = "Colleague search is unavailable — type the address.";
    return;
  }

  const candidates = recipientDirectoryState.candidates;
  if (candidates.length === 0) {
    // A solo user (zero orgs) sees no broken widget at all.
    recipientPicker.classList.add("hidden");
    recipientPickerHint.textContent = "";
    return;
  }

  const query = recipientFilterInput.value;
  const matches = filterRecipients(candidates, query);

  recipientPicker.classList.remove("hidden");
  recipientOptionsList.replaceChildren(
    ...matches.map((candidate) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ui-button-ghost";
      button.dataset.email = candidate.email;
      button.textContent = candidate.name ? `${candidate.name} — ${candidate.email}` : candidate.email;
      item.appendChild(button);
      return item;
    }),
  );

  if (!query.trim()) {
    recipientPickerHint.textContent = `Type to search ${candidates.length} colleagues.`;
  } else if (matches.length === 0) {
    recipientPickerHint.textContent = "No colleague matches — type the full address.";
  } else {
    recipientPickerHint.textContent = "";
  }
}

// clearRecipientPicker resets the filter input and collapses the option
// list. sendEmailForm.reset() cannot reach #recipient-filter because the
// picker lives outside the form (Decision 12), so this is called explicitly
// from resetToCreateForm() and after a successful send.
function clearRecipientPicker(): void {
  recipientFilterInput.value = "";
  renderRecipientPicker();
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
  createFormSection.classList.add("hidden");
}

function resetToCreateForm(): void {
  createdToken = undefined;
  createdFragmentKey = undefined;
  secretLinkResult.classList.add("hidden");
  clearSendEmailFeedback();
  clearSecretCreateError();
  clearRecipientPicker();
  createFormSection.classList.remove("hidden");
  secretContentInput.focus();
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
  clearRecipientPicker();
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
