import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError } from "../../lib/api/client";
import { useUncertainCreationKey } from "../../lib/api/useUncertainCreationKey";
import { FormRow } from "../../lib/ui/components/FormRow";
import { useAuth } from "../providers/AuthProvider";
import { useOrganization } from "../providers/OrganizationProvider";

export function OrganizationCreatePage() {
  const { createOwnerOrganization } = useAuth();
  const { setActiveOrganizationId } = useOrganization();
  const navigate = useNavigate();
  const creationKey = useUncertainCreationKey();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const intent = { name: name.trim() };

  const submit = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const membership = await createOwnerOrganization(intent.name, creationKey.keyFor(intent));
      creationKey.confirm(intent);
      setActiveOrganizationId(membership.organizationId);
      navigate("/", { replace: true });
    } catch (caught) {
      creationKey.retainAfterFailure(intent, caught);
      setUncertain(!(caught instanceof ApiError));
      setError(caught instanceof ApiError ? caught.message : "Creation may have completed. Retry safely to confirm.");
    } finally {
      setSubmitting(false);
    }
  };

  return <section className="ui-section-stack">
    <header className="ui-page-intro"><p className="ui-eyebrow">Organization</p><h1 className="ui-page-title">Create organization</h1><p className="ui-copy">You will become its owner.</p></header>
    <form className="ui-form" onSubmit={submit}>
      <FormRow label="Organization name"><input autoFocus required value={name} onChange={(event) => setName(event.target.value)} /></FormRow>
      <div aria-atomic="true" role="alert">{error}</div>
      <button className="ui-button ui-button-primary" disabled={submitting} type="submit">{submitting ? "Creating organization…" : "Create organization"}</button>
      {uncertain ? <button className="ui-button ui-button-secondary" disabled={submitting} onClick={() => void submit()} type="button">Retry creation</button> : null}
      <Link className="ui-button ui-button-secondary" onClick={() => creationKey.cancel(intent)} to="/">Cancel</Link>
    </form>
  </section>;
}
