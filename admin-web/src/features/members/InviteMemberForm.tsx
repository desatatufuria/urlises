import { useState, type FormEvent } from "react";
import { FormRow } from "../../lib/ui/components/FormRow";
import type { OrganizationRole } from "../../lib/api/types";

const roleOptions: OrganizationRole[] = ["admin", "member"];

export function InviteMemberForm({
  submitting,
  onSubmit,
}: {
  submitting: boolean;
  onSubmit: (input: { email: string; role: OrganizationRole }) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrganizationRole>("member");

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await onSubmit({ email: email.trim(), role });
    setEmail("");
    setRole("member");
  };

  return (
    <form className="ui-form ui-section-stack" onSubmit={(event) => void handleSubmit(event)}>
      <div className="ui-inline-grid">
        <FormRow label="Email" hint="The backend will reject duplicates or malformed invites.">
          <input
            aria-label="Invite email"
            autoComplete="email"
            name="inviteEmail"
            required
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </FormRow>
        <FormRow label="Role">
          <select aria-label="Invite role" value={role} onChange={(event) => setRole(event.target.value as OrganizationRole)}>
            {roleOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </FormRow>
      </div>
      <div className="ui-actions-row">
        <button className="ui-button ui-button-primary" disabled={submitting} type="submit">
          {submitting ? "Sending invite…" : "Invite member"}
        </button>
      </div>
    </form>
  );
}
