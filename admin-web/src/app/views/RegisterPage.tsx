import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { AppShell } from "../../lib/ui/components/AppShell";
import { DataState } from "../../lib/ui/components/DataState";
import { FormRow } from "../../lib/ui/components/FormRow";
import { useAuth } from "../providers/AuthProvider";

export function RegisterPage() {
  const { signUp, status } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: "", email: "", password: "", confirmPassword: "", deviceName: "URLises Control" });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (status === "loading") {
    return <DataState tone="neutral" title="Checking installation" description="Determining whether the first owner account is required." />;
  }
  if (status === "authenticated") {
    return <Navigate to="/" replace />;
  }
  if (status === "anonymous") {
    return <Navigate to="/login" replace />;
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (form.password !== form.confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      await signUp(form);
      navigate("/setup/organization", { replace: true });
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
          <p className="ui-eyebrow">First-run setup</p>
          <h1 className="ui-page-title">Create the first owner</h1>
          <p className="ui-copy">Use your own credentials. No default administrator password is stored in the image.</p>
          <form className="ui-form" onSubmit={handleSubmit}>
            <FormRow label="Name"><input autoComplete="name" required value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} /></FormRow>
            <FormRow label="Email"><input autoComplete="email" required type="email" value={form.email} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} /></FormRow>
            <FormRow label="Password"><input autoComplete="new-password" required type="password" value={form.password} onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))} /></FormRow>
            <FormRow label="Confirm password"><input autoComplete="new-password" required type="password" value={form.confirmPassword} onChange={(event) => setForm((current) => ({ ...current, confirmPassword: event.target.value }))} /></FormRow>
            <FormRow label="Device name"><input value={form.deviceName} onChange={(event) => setForm((current) => ({ ...current, deviceName: event.target.value }))} /></FormRow>
            <button className="ui-button ui-button-primary" disabled={submitting} type="submit">{submitting ? "Creating account…" : "Create owner account"}</button>
            {error ? <DataState tone="danger" title="Account setup failed" description={error} compact /> : null}
          </form>
          <p className="ui-copy">Already created the account? <Link to="/login">Sign in to continue</Link>.</p>
        </section>
      </AppShell>
    </div>
  );
}
