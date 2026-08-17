import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { AppShell } from "../../lib/ui/components/AppShell";
import { DataState } from "../../lib/ui/components/DataState";
import { FormRow } from "../../lib/ui/components/FormRow";
import { useUncertainCreationKey } from "../../lib/api/useUncertainCreationKey";
import { useAuth } from "../providers/AuthProvider";
import { useOrganization } from "../providers/OrganizationProvider";

export function OrganizationSetupPage() {
  const { createOwnerOrganization, signOut } = useAuth();
  const { adminOrganizations } = useOrganization();
  const navigate = useNavigate();
  const creationKey = useUncertainCreationKey();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (adminOrganizations.length > 0) {
    return <Navigate to="/" replace />;
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const intent = { name: name.trim() };
    setError(null);
    setSubmitting(true);
    try {
      await createOwnerOrganization(intent.name, creationKey.keyFor(intent));
      creationKey.confirm(intent);
      navigate("/", { replace: true });
    } catch (caught) {
      creationKey.retainAfterFailure(intent, caught);
      setError(caught instanceof Error ? caught.message : "Unable to create the organization.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="ui-login-screen">
      <AppShell compact>
        <section className="ui-login-card">
          <p className="ui-eyebrow">First-run setup</p>
          <h1 className="ui-page-title">Create your organization</h1>
          <p className="ui-copy">Your account becomes the first owner. You can invite additional administrators afterward.</p>
          <form className="ui-form" onSubmit={handleSubmit}>
            <FormRow label="Organization name"><input autoFocus required value={name} onChange={(event) => setName(event.target.value)} /></FormRow>
            <button className="ui-button ui-button-primary" disabled={submitting} type="submit">{submitting ? "Creating organization…" : "Create organization"}</button>
            {error ? <DataState tone="danger" title="Organization setup failed" description={error} compact /> : null}
          </form>
          <button className="ui-button ui-button-secondary" onClick={() => void signOut()} type="button">Sign out</button>
        </section>
      </AppShell>
    </div>
  );
}
