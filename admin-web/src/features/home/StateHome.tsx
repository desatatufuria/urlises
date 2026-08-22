import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../../app/providers/AuthProvider";
import { useOrganization } from "../../app/providers/OrganizationProvider";
import { ApiError } from "../../lib/api/client";
import { Badge } from "../../lib/ui/components/Badge";
import { ConfirmByTyping } from "../../lib/ui/components/ConfirmByTyping";
import { ContextPanel } from "../../lib/ui/components/ContextPanel";
import { DataState } from "../../lib/ui/components/DataState";
import { useGroups } from "../groups/queries";
import { useOrganizationInvitations, useOrganizationMembers } from "../members/queries";
import { useDeleteOrganizationMutation } from "../organizations/mutations";
import { useWorkspaces } from "../workspaces/queries";

const ORPHAN_GUARD_MESSAGE = "This organization can't be deleted because it would leave a member without any organization.";

export function StateHome() {
  const { session } = useAuth();
  const { activeOrganization } = useOrganization();
  const token = session?.accessToken;
  const organizationId = activeOrganization?.organizationId;
  const members = useOrganizationMembers(token, organizationId);
  const invitations = useOrganizationInvitations(token, organizationId);
  const groups = useGroups(token, organizationId);
  const workspaces = useWorkspaces(token, organizationId);
  const pending = invitations.data?.filter((invitation) => invitation.status === "pending") ?? [];

  const [searchParams, setSearchParams] = useSearchParams();
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteOrganizationMutation = useDeleteOrganizationMutation(token, organizationId);
  const deletePanelOpen = searchParams.get("panel") === "delete-organization";
  const closeDeletePanel = () => setSearchParams((current) => { const next = new URLSearchParams(current); next.delete("panel"); return next; });
  const openDeletePanel = () => { setDeleteError(null); setSearchParams({ panel: "delete-organization" }); };

  return <section className="ui-section-stack">
    <header className="ui-page-intro"><p className="ui-eyebrow">Organization state</p><h1 className="ui-page-title">{activeOrganization?.organizationName}</h1><p className="ui-copy">A compact view of the people and structures currently available to this organization.</p></header>
    {invitations.isError ? <DataState tone="danger" title="Invitations could not be loaded" description="The pending invitation state is unavailable. Retry from People." /> : null}
    {!invitations.isPending && !invitations.isError && pending.length > 0 ? <section className="ui-attention"><div><p className="ui-eyebrow">Needs attention</p><h2 className="ui-section-title">{pending.length} pending invitation{pending.length === 1 ? "" : "s"}</h2><p className="ui-copy">These invitations are waiting for a response.</p></div><Link className="ui-button ui-button-primary" to="/members">Review people</Link></section> : null}
    {!invitations.isPending && !invitations.isError && pending.length === 0 ? <section className="ui-attention ui-attention--quiet"><div><p className="ui-eyebrow">People</p><h2 className="ui-section-title">No pending invitations</h2><p className="ui-copy">Invite someone when the organization is ready to grow.</p></div><Link className="ui-button ui-button-secondary" to="/members?panel=invite">Invite person</Link></section> : null}
    <section className="ui-summary-list" aria-label="Organization summary">
      <Link to="/members"><span>People</span><strong>{members.isPending ? "..." : members.data?.length ?? 0}</strong></Link>
      <Link to="/groups"><span>Groups</span><strong>{groups.isPending ? "..." : groups.data?.length ?? 0}</strong></Link>
      <Link to="/workspaces"><span>Workspaces</span><strong>{workspaces.isPending ? "..." : workspaces.data?.length ?? 0}</strong></Link>
      <Link to="/members"><span>Pending invitations</span><Badge tone={pending.length ? "accent" : "neutral"}>{invitations.isPending ? "..." : pending.length}</Badge></Link>
    </section>
    {activeOrganization ? <section className="ui-danger-zone"><p className="ui-eyebrow">Danger zone</p><h2 className="ui-section-title">Delete this organization</h2><p className="ui-copy">Permanently removes {activeOrganization.organizationName}, its people, groups, and workspaces. This cannot be undone.</p>{deleteError ? <DataState tone="danger" compact title="Organization deletion failed" description={deleteError} /> : null}<button className="ui-button ui-button-danger" type="button" onClick={openDeletePanel}>Delete organization…</button></section> : null}
    {deletePanelOpen && activeOrganization ? <ContextPanel title="Delete organization" onClose={closeDeletePanel}>
      <p className="ui-copy">{`This permanently deletes ${activeOrganization.organizationName} and everything in it. This cannot be undone.`}</p>
      <ConfirmByTyping
        expected={activeOrganization.organizationName}
        confirmLabel="Delete organization"
        disabled={deleteOrganizationMutation.isPending}
        onConfirm={() => {
          setDeleteError(null);
          deleteOrganizationMutation.mutate(undefined, {
            onSuccess: () => closeDeletePanel(),
            onError: (error) => {
              setDeleteError(error instanceof ApiError && error.status === 409 ? ORPHAN_GUARD_MESSAGE : error instanceof Error ? error.message : "The organization could not be deleted.");
            },
          });
        }}
      />
    </ContextPanel> : null}
  </section>;
}
