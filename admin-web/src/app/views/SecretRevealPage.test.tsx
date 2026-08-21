import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SecretRevealPage } from "./SecretRevealPage";
import { deriveWrappingKey, encrypt, exportContentKey, generateContentKey, wrapKey } from "../../lib/crypto";

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

// No AuthProvider/OrganizationProvider on purpose: SecretRevealPage must
// never call useAuth(). If it did, useAuth() would throw
// "useAuth must be used within AuthProvider" and every test below would
// fail immediately on render.
function renderReveal(path: string, options: { strict?: boolean } = {}) {
  const tree = (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/s/:token" element={<SecretRevealPage />} />
      </Routes>
    </MemoryRouter>
  );

  return render(options.strict ? <StrictMode>{tree}</StrictMode> : tree);
}

async function setLocation(pathname: string, hash: string) {
  window.history.replaceState(null, "", `${pathname}${hash}`);
}

describe("SecretRevealPage", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    window.history.replaceState(null, "", "/");
  });

  it("fetches the literal /secrets/{token} path, never the full window.location.href, even when the URL contains an unrelated fragment", async () => {
    await setLocation("/s/abc123", "#k=should-never-reach-fetch");
    fetchMock.mockImplementation(() => jsonResponse({ ciphertext: "Y2lwaGVy", iv: "aXY=", wrappedContentKey: null, passphraseSalt: null, kdfIterations: null }));

    renderReveal("/s/abc123");

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [firstCall] = fetchMock.mock.calls;
    const requestedUrl = String(firstCall[0]);

    expect(requestedUrl.endsWith("/secrets/abc123")).toBe(true);
    expect(requestedUrl).not.toContain("should-never-reach-fetch");
    expect(requestedUrl).not.toContain("#");
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain("should-never-reach-fetch");
    }
  });

  it("never passes the fragment/hash to console.log, console.warn, or console.error", async () => {
    await setLocation("/s/abc123", "#k=super-secret-fragment-value");
    fetchMock.mockImplementation(() => jsonResponse({ ciphertext: "not-valid-base64!!", iv: "not-valid-base64!!", wrappedContentKey: null, passphraseSalt: null, kdfIterations: null }));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    renderReveal("/s/abc123");

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await screen.findByText(/did not match|couldn.t be decrypted|missing decryption key/i);

    for (const spy of [logSpy, warnSpy, errorSpy]) {
      for (const call of spy.mock.calls) {
        for (const arg of call) {
          expect(String(arg)).not.toContain("super-secret-fragment-value");
        }
      }
    }

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("leaves the secret in pending state and never calls burn when the passphrase is wrong", async () => {
    const contentKey = await generateContentKey();
    const { ciphertext, iv } = await encrypt(contentKey, "the real payload");
    const { key: wrappingKey, salt, iterations } = await deriveWrappingKey("correct passphrase");
    const wrappedContentKey = await wrapKey(wrappingKey, contentKey);

    await setLocation("/s/tok-wrongpass", "");
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith("/secrets/tok-wrongpass/burn") && init?.method === "POST") {
        return jsonResponse({ status: "read" });
      }
      if (url.endsWith("/secrets/tok-wrongpass")) {
        return jsonResponse({ ciphertext, iv, wrappedContentKey, passphraseSalt: salt, kdfIterations: iterations });
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderReveal("/s/tok-wrongpass");

    const passphraseInput = await screen.findByLabelText(/passphrase/i);
    const user = userEvent.setup();
    await user.type(passphraseInput, "totally wrong passphrase");
    await user.click(screen.getByRole("button", { name: /unlock|decrypt|reveal/i }));

    await screen.findByRole("heading", { name: /incorrect passphrase/i });

    expect(screen.queryByText("the real payload")).not.toBeInTheDocument();
    const burnCalls = fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith("/secrets/tok-wrongpass/burn") && init?.method === "POST");
    expect(burnCalls).toHaveLength(0);
    // The passphrase field is still present — the page is still waiting, not errored out.
    expect(screen.getByLabelText(/passphrase/i)).toBeInTheDocument();
  });

  it("shows the masked ready state after a successful fragment-key decrypt without burning yet, even under StrictMode's double-invoked effects", async () => {
    const contentKey = await generateContentKey();
    const rawKey = await exportContentKey(contentKey);
    const { ciphertext, iv } = await encrypt(contentKey, "the real payload for strict mode");

    await setLocation("/s/tok-strict", `#k=${encodeURIComponent(rawKey)}`);
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith("/secrets/tok-strict/burn") && init?.method === "POST") {
        return jsonResponse({ status: "read" });
      }
      if (url.endsWith("/secrets/tok-strict")) {
        return jsonResponse({ ciphertext, iv, wrappedContentKey: null, passphraseSalt: null, kdfIterations: null });
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderReveal("/s/tok-strict", { strict: true });

    await screen.findByText("the real payload for strict mode");

    const burnCallsBeforeReveal = fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith("/secrets/tok-strict/burn") && init?.method === "POST");
    expect(burnCallsBeforeReveal).toHaveLength(0);
  });

  it("burns exactly once when Reveal is clicked after a successful fragment-key decrypt, and unmasks the content, even under StrictMode double-clicks", async () => {
    const contentKey = await generateContentKey();
    const rawKey = await exportContentKey(contentKey);
    const { ciphertext, iv } = await encrypt(contentKey, "the real payload for strict mode");

    await setLocation("/s/tok-strict", `#k=${encodeURIComponent(rawKey)}`);
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith("/secrets/tok-strict/burn") && init?.method === "POST") {
        return jsonResponse({ status: "read" });
      }
      if (url.endsWith("/secrets/tok-strict")) {
        return jsonResponse({ ciphertext, iv, wrappedContentKey: null, passphraseSalt: null, kdfIterations: null });
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderReveal("/s/tok-strict", { strict: true });

    await screen.findByText("the real payload for strict mode");

    const user = userEvent.setup();
    const revealButton = screen.getByRole("button", { name: /reveal/i });
    await user.click(revealButton);
    await user.click(revealButton);

    await waitFor(() => {
      const burnCalls = fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith("/secrets/tok-strict/burn") && init?.method === "POST");
      expect(burnCalls).toHaveLength(1);
    });

    await screen.findByRole("heading", { name: /secret revealed/i });
  });

  it("shows the masked ready state after a correct passphrase without burning, and burns exactly once when Reveal is clicked afterward", async () => {
    const contentKey = await generateContentKey();
    const { ciphertext, iv } = await encrypt(contentKey, "the passphrase payload");
    const { key: wrappingKey, salt, iterations } = await deriveWrappingKey("correct passphrase");
    const wrappedContentKey = await wrapKey(wrappingKey, contentKey);

    await setLocation("/s/tok-goodpass", "");
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith("/secrets/tok-goodpass/burn") && init?.method === "POST") {
        return jsonResponse({ status: "read" });
      }
      if (url.endsWith("/secrets/tok-goodpass")) {
        return jsonResponse({ ciphertext, iv, wrappedContentKey, passphraseSalt: salt, kdfIterations: iterations });
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    renderReveal("/s/tok-goodpass");

    const passphraseInput = await screen.findByLabelText(/passphrase/i);
    const user = userEvent.setup();
    await user.type(passphraseInput, "correct passphrase");
    await user.click(screen.getByRole("button", { name: /unlock/i }));

    await screen.findByText("the passphrase payload");

    const burnCallsBeforeReveal = fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith("/secrets/tok-goodpass/burn") && init?.method === "POST");
    expect(burnCallsBeforeReveal).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: /reveal/i }));

    await waitFor(() => {
      const burnCalls = fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith("/secrets/tok-goodpass/burn") && init?.method === "POST");
      expect(burnCalls).toHaveLength(1);
    });

    await screen.findByRole("heading", { name: /secret revealed/i });
  });

  it("renders distinct copy for a 404 (not found) response", async () => {
    await setLocation("/s/missing-token", "");
    fetchMock.mockImplementation(() => jsonResponse({ error: "not found" }, 404));

    renderReveal("/s/missing-token");

    expect(await screen.findByText(/not found/i)).toBeInTheDocument();
    expect(screen.queryByText(/already read|expired/i)).not.toBeInTheDocument();
  });

  it("renders distinct copy for a 410 (already burned or expired) response", async () => {
    await setLocation("/s/gone-token", "");
    fetchMock.mockImplementation(() => jsonResponse({ error: "gone" }, 410));

    renderReveal("/s/gone-token");

    expect(await screen.findByRole("heading", { name: /already read or expired/i })).toBeInTheDocument();
    expect(screen.queryByText(/^not found$/i)).not.toBeInTheDocument();
  });
});
