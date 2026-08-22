import { useState, type FormEvent } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../providers/AuthProvider";
import { AppShell } from "../../lib/ui/components/AppShell";
import { DataState } from "../../lib/ui/components/DataState";
import { FormRow } from "../../lib/ui/components/FormRow";
import type { LoginPayload } from "../../lib/api/types";

export function LoginPage() {
  const { status, signIn } = useAuth();
  const [searchParams] = useSearchParams();
  const invitation = searchParams.get("invitation");
  const invitedEmail = searchParams.get("email");
  const returnTo = invitation
    ? `/invitations/${encodeURIComponent(invitation)}${invitedEmail ? `?email=${encodeURIComponent(invitedEmail)}` : ""}`
    : "/";
  const [form, setForm] = useState<LoginPayload>({ email: invitedEmail ?? "", password: "", deviceName: "URLises Control" });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (status === "authenticated") {
    return <Navigate to={returnTo} replace />;
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      await signIn(form);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to sign in.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="ui-login-screen">
      <AppShell
        compact
      >
        <section className="ui-login-card">
          <p className="ui-eyebrow">{invitation ? "Invitation" : "URLises operator access"}</p>
          <h1 className="ui-page-title">{invitation ? "You're invited to join URLises" : "Sign in to URLises Control"}</h1>
          <p className="ui-copy">
            {invitation ? "Sign in if you already have an account, or create one below to accept the invitation." : "Restrained controls for organization admins only."}
          </p>
          <form className="ui-form" onSubmit={handleSubmit}>
          <FormRow label="Email">
            <input
              autoComplete="email"
              name="email"
              type="email"
              value={form.email}
              onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
            />
          </FormRow>
          <FormRow label="Password">
            <input
              autoComplete="current-password"
              name="password"
              type="password"
              value={form.password}
              onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
            />
          </FormRow>
          <FormRow label="Device name" hint="Helps you recognize this session later.">
            <input
              name="deviceName"
              type="text"
              value={form.deviceName ?? ""}
              onChange={(event) => setForm((current) => ({ ...current, deviceName: event.target.value }))}
            />
          </FormRow>
          <button className="ui-button ui-button-primary" disabled={submitting} type="submit">
            {submitting ? "Signing in…" : "Sign in"}
          </button>
          {error ? <DataState tone="danger" title="Sign-in failed" description={error} compact /> : null}
        </form>
        {status === "setupRequired" || invitation ? (
          <p className="ui-copy">
            <Link to={{ pathname: "/register", search: searchParams.toString() }}>
              {invitation ? "Create an account to accept this invitation" : "Create the first owner account"}
            </Link>
          </p>
        ) : null}
        </section>
      </AppShell>
    </div>
  );
}
