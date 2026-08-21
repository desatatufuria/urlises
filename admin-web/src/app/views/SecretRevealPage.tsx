import { useEffect, useRef, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { burnSecret, getSecret } from "../../lib/api/secrets";
import { ApiError } from "../../lib/api/client";
import { decrypt, deriveWrappingKey, importContentKey, unwrapKey } from "../../lib/crypto";
import { AppShell } from "../../lib/ui/components/AppShell";
import { DataState } from "../../lib/ui/components/DataState";
import { FormRow } from "../../lib/ui/components/FormRow";
import type { SecretBlob } from "../../lib/api/types";

// SecretRevealPage is a fully anonymous, public page — it has no session
// concept at all, unlike InvitationAcceptPage. It MUST NOT import or call
// useAuth() (directly or transitively): the recipient of a share link never
// has, and must never need, an admin session.
//
// The URL fragment (`#k=...`, the zero-knowledge content key) must never
// reach fetch, a logger, or any state that could be serialized. The fetch
// path is always the literal `/secrets/${token}` string built from
// useParams().token — never from window.location.href — and
// window.location.hash is read separately, only once decrypt setup begins.

type RevealStatus = "loading" | "pending" | "revealed" | "not-found" | "gone" | "error";

const FRAGMENT_KEY_PATTERN = /#k=([^&]+)/;

export function SecretRevealPage() {
  const { token = "" } = useParams<{ token: string }>();
  const [status, setStatus] = useState<RevealStatus>("loading");
  const [blob, setBlob] = useState<SecretBlob | null>(null);
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [decryptError, setDecryptError] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const attempted = useRef(false);
  const burned = useRef(false);

  useEffect(() => {
    if (attempted.current || !token) {
      return;
    }
    attempted.current = true;

    void (async () => {
      let fetchedBlob: SecretBlob;
      try {
        fetchedBlob = await getSecret(token);
      } catch (caught: unknown) {
        if (caught instanceof ApiError && caught.status === 404) {
          setStatus("not-found");
        } else if (caught instanceof ApiError && caught.status === 410) {
          setStatus("gone");
        } else {
          setStatus("error");
        }
        return;
      }

      setBlob(fetchedBlob);
      setStatus("pending");

      if (!fetchedBlob.wrappedContentKey) {
        await attemptFragmentDecrypt(fetchedBlob);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function completeReveal(text: string) {
    setPlaintext(text);
    setStatus("revealed");
    setDecryptError(null);

    if (burned.current) {
      return;
    }
    burned.current = true;

    try {
      await burnSecret(token);
    } catch {
      // The recipient already has the plaintext locally; a failed burn
      // acknowledgement is best-effort and must not block the reveal.
    }
  }

  async function copyPlaintext() {
    if (plaintext === null) {
      return;
    }

    try {
      await navigator.clipboard.writeText(plaintext);
    } catch {
      return;
    }

    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function attemptFragmentDecrypt(fetchedBlob: SecretBlob) {
    const match = FRAGMENT_KEY_PATTERN.exec(window.location.hash);
    if (!match) {
      setDecryptError("Missing decryption key in the link. This link's decryption key did not match the stored secret.");
      return;
    }

    try {
      const key = await importContentKey(decodeURIComponent(match[1]));
      const text = await decrypt(key, fetchedBlob.ciphertext, fetchedBlob.iv);
      await completeReveal(text);
    } catch {
      setDecryptError("This link's decryption key did not match the stored secret.");
    }
  }

  async function handlePassphraseSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!blob || !blob.wrappedContentKey || !blob.passphraseSalt || blob.kdfIterations == null) {
      return;
    }

    setDecryptError(null);

    try {
      const { key: wrappingKey } = await deriveWrappingKey(passphrase, blob.passphraseSalt, blob.kdfIterations);
      const contentKey = await unwrapKey(wrappingKey, blob.wrappedContentKey);
      const text = await decrypt(contentKey, blob.ciphertext, blob.iv);
      await completeReveal(text);
    } catch {
      setDecryptError("Incorrect passphrase — it didn't match. Try again.");
    }
  }

  return (
    <div className="ui-login-screen">
      <AppShell compact>
        <section className="ui-login-card">
          <p className="ui-eyebrow">Shared secret</p>
          <h1 className="ui-page-title">One-time secret</h1>
          {status === "loading" ? <DataState tone="neutral" title="Loading secret" description="Fetching the encrypted secret." /> : null}

          {status === "not-found" ? <DataState tone="danger" title="Secret not found" description="This link is incomplete or the secret was removed." /> : null}

          {status === "gone" ? (
            <DataState tone="danger" title="Secret already read or expired" description="This secret was already read, or it expired. It can only be viewed once." />
          ) : null}

          {status === "error" ? <DataState tone="danger" title="Could not load this secret" description="Something went wrong fetching this secret." /> : null}

          {status === "revealed" && plaintext !== null ? (
            <>
              <DataState tone="neutral" title="Secret revealed" description="This secret has now been burned and cannot be viewed again." compact />
              <pre className={visible ? "ui-copy" : "ui-copy ui-secret-mask"}>{plaintext}</pre>
              <div className="ui-actions">
                <button className="ui-button ui-button-secondary" type="button" onClick={() => setVisible((current) => !current)}>
                  {visible ? "Hide" : "Reveal"}
                </button>
                <button className="ui-button ui-button-secondary" type="button" onClick={() => void copyPlaintext()}>
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            </>
          ) : null}

          {status === "pending" && blob?.wrappedContentKey ? (
            <form className="ui-form" onSubmit={(event) => void handlePassphraseSubmit(event)}>
              <FormRow label="Passphrase" hint="This secret is passphrase-protected.">
                <input
                  autoComplete="off"
                  name="passphrase"
                  type="password"
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.target.value)}
                />
              </FormRow>
              <button className="ui-button ui-button-primary" type="submit">
                Unlock secret
              </button>
              {decryptError ? <DataState tone="danger" title="Incorrect passphrase" description={decryptError} compact /> : null}
            </form>
          ) : null}

          {status === "pending" && blob && !blob.wrappedContentKey ? <DataState tone="danger" title="Decryption failed" description={decryptError ?? "Waiting to decrypt this secret."} compact /> : null}
        </section>
      </AppShell>
    </div>
  );
}
