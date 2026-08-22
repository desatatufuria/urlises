import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { AppShell } from "../../lib/ui/components/AppShell";
import { DataState } from "../../lib/ui/components/DataState";
import { FormRow } from "../../lib/ui/components/FormRow";
import { useAuth } from "../providers/AuthProvider";

export function RegisterPage() {
  const { signUp, status } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const invitation = searchParams.get("invitation");
  const invitedEmail = searchParams.get("email");
  const returnTo = invitation
    ? `/invitations/${encodeURIComponent(invitation)}${invitedEmail ? `?email=${encodeURIComponent(invitedEmail)}` : ""}`
    : "/setup/organization";
  const [form, setForm] = useState({ name: "", email: invitedEmail ?? "", password: "", confirmPassword: "", deviceName: "URLises Control" });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (status === "loading") {
    return <DataState tone="neutral" title="Checking installation" description="Determining whether the first owner account is required." />;
  }
  if (status === "authenticated") {
    return <Navigate to={returnTo} replace />;
  }
  if (status === "anonymous" && !invitation) {
    return <Navigate to="/login" replace />;
  }

  const emailLocked = Boolean(invitation && invitedEmail);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (form.password !== form.confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      await signUp(invitation ? { ...form, invitationToken: invitation } : form);
      navigate(returnTo, { replace: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to create the owner account.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="ui-login-screen">
      <AppShell compact>
        <section className="ui-login-card">
          <p className="ui-eyebrow">{invitation ? "Invitation" : "First-run setup"}</p>
          <h1 className="ui-page-title">{invitation ? "Create your account to join this organization" : "Create the first owner"}</h1>
          <p className="ui-copy">
            {invitation
              ? "Create your credentials to accept the invitation and join this organization."
              : "You choose your own password — there's no default to change later."}
          </p>
          <form className="ui-form" onSubmit={handleSubmit}>
            <FormRow label="Name"><input autoComplete="name" required value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} /></FormRow>
            <FormRow
              label="Email"
              hint={emailLocked ? "This invitation was sent to this address, so it cannot be changed here." : undefined}
            >
              <input
                autoComplete="email"
                required
                type="email"
                readOnly={emailLocked}
                aria-readonly={emailLocked || undefined}
                value={form.email}
                onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
              />
            </FormRow>
            <FormRow label="Password"><input autoComplete="new-password" required type="password" value={form.password} onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))} /></FormRow>
            <FormRow label="Confirm password"><input autoComplete="new-password" required type="password" value={form.confirmPassword} onChange={(event) => setForm((current) => ({ ...current, confirmPassword: event.target.value }))} /></FormRow>
            <FormRow label="Device name"><input value={form.deviceName} onChange={(event) => setForm((current) => ({ ...current, deviceName: event.target.value }))} /></FormRow>
            <button className="ui-button ui-button-primary" disabled={submitting} type="submit">{submitting ? "Creating account…" : invitation ? "Create account and join" : "Create owner account"}</button>
            {error ? <DataState tone="danger" title="Account setup failed" description={error} compact /> : null}
          </form>
          <p className="ui-copy">
            Already created the account? <Link to={{ pathname: "/login", search: searchParams.toString() }}>Sign in to continue</Link>.
          </p>
        </section>
      </AppShell>
    </div>
  );
}
