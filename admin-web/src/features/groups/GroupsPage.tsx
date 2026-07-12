import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../../app/providers/AuthProvider";
import { useOrganization } from "../../app/providers/OrganizationProvider";
import { Badge } from "../../lib/ui/components/Badge";
import { DataState } from "../../lib/ui/components/DataState";
import { FormRow } from "../../lib/ui/components/FormRow";
import { useOrganizationMembers } from "../members/queries";
import { GroupMembersPanel } from "./GroupMembersPanel";
import { ContextPanel } from "../../lib/ui/components/ContextPanel";
import {
  useAddGroupMemberMutation,
  useCreateGroupMutation,
  useDeleteGroupMutation,
  useRemoveGroupMemberMutation,
  useUpdateGroupMutation,
} from "./mutations";
import { useGroupMembers, useGroups } from "./queries";

export function GroupsPage() {
  const { session } = useAuth();
  const { activeOrganization } = useOrganization();
  const [newGroupName, setNewGroupName] = useState("");
  const [notice, setNotice] = useState<{ tone: "neutral" | "danger"; title: string; description: string } | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedGroupId = searchParams.get("group");
  const groupOpen = searchParams.get("panel") === "group";
  const createOpen = searchParams.get("panel") === "group-create";
  const closePanel = () => setSearchParams((current) => { const next = new URLSearchParams(current); next.delete("panel"); next.delete("group"); return next; });

  const token = session?.accessToken;
  const organizationId = activeOrganization?.organizationId;
  const groupsQuery = useGroups(token, organizationId);
  const organizationMembersQuery = useOrganizationMembers(token, organizationId);
  const createGroupMutation = useCreateGroupMutation(token, organizationId);
  const selectedGroup = useMemo(
    () => groupsQuery.data?.find((group) => group.groupId === selectedGroupId) ?? null,
    [groupsQuery.data, selectedGroupId],
  );
  const groupMembersQuery = useGroupMembers(token, selectedGroup?.groupId);
  const updateGroupMutation = useUpdateGroupMutation(token, organizationId);
  const deleteGroupMutation = useDeleteGroupMutation(token, organizationId);
  const addMemberMutation = useAddGroupMemberMutation(token, selectedGroup?.groupId);
  const removeMemberMutation = useRemoveGroupMemberMutation(token, selectedGroup?.groupId);

  useEffect(() => {
    const groups = groupsQuery.data ?? [];
    if (!groupsQuery.isPending && selectedGroupId && !groups.some((group) => group.groupId === selectedGroupId)) closePanel();
  }, [groupsQuery.data, groupsQuery.isPending, selectedGroupId]);

  if (!token || !organizationId) {
    return <DataState tone="danger" title="Organization context missing" description="Choose an admin organization before managing groups." />;
  }

  if (organizationMembersQuery.isError) {
    return (
      <section className="ui-section-stack">
        <DataState tone="danger" title="Members could not be loaded" description={organizationMembersQuery.error instanceof Error ? organizationMembersQuery.error.message : "Request failed."} />
        <button className="ui-button ui-button-secondary" type="button" onClick={() => void organizationMembersQuery.refetch()}>Retry members</button>
      </section>
    );
  }

  return (
    <section className="ui-section-stack">
      <header className="ui-section-header">
        <div className="ui-actions-spread"><div><h1 className="ui-page-title">Groups</h1><p className="ui-copy">Create flat groups and assign current organization members.</p></div><button className="ui-button ui-button-primary" type="button" onClick={() => setSearchParams({ panel: "group-create" })}>New group</button></div>
      </header>

      {notice ? <DataState compact tone={notice.tone} title={notice.title} description={notice.description} /> : null}

      <section className="ui-grouped-section ui-section-stack">
          <header className="ui-section-header">
            <div className="ui-actions-spread">
              <div>
                <h3 className="ui-section-title">Group list</h3>
                <p className="ui-copy">Select a group to rename it, inspect its members, or adjust assignments.</p>
              </div>
              <Badge tone="neutral">{groupsQuery.data?.length ?? 0} groups</Badge>
            </div>
          </header>

          {groupsQuery.isPending ? <DataState title="Loading groups" description="Reviewing existing flat groups for the active organization." /> : null}

          {groupsQuery.isError ? (
            <div className="ui-section-stack">
              <DataState tone="danger" title="Groups could not be loaded" description={groupsQuery.error instanceof Error ? groupsQuery.error.message : "Request failed."} />
              <div className="ui-actions-row">
                <button className="ui-button ui-button-secondary" type="button" onClick={() => void groupsQuery.refetch()}>
                  Retry groups
                </button>
              </div>
            </div>
          ) : null}

          {!groupsQuery.isPending && !groupsQuery.isError && (groupsQuery.data?.length ?? 0) === 0 ? (
            <DataState title="No groups yet" description="Create the first flat group to prepare reusable membership sets for the access slice." />
          ) : null}

          {!groupsQuery.isPending && !groupsQuery.isError && (groupsQuery.data?.length ?? 0) > 0 ? (
            <div className="ui-list-grid">
              {groupsQuery.data?.map((group) => (
                <button
                  key={group.groupId}
                  className="ui-list-button"
                  type="button"
                  onClick={() => setSearchParams({ panel: "group", group: group.groupId })}
                >
                  <div className="ui-cell-stack">
                    <strong>{group.name}</strong>
                    <span className="ui-muted">{group.createdAt ? `Created ${new Date(group.createdAt).toLocaleDateString()}` : "Ready for membership assignment"}</span>
                  </div>
                  <Badge tone="neutral">Open</Badge>
                </button>
              ))}
            </div>
          ) : null}
      </section>
      {groupOpen && selectedGroup ? <ContextPanel title={selectedGroup.name} onClose={closePanel}>
          <GroupMembersPanel
            error={groupMembersQuery.isError ? (groupMembersQuery.error instanceof Error ? groupMembersQuery.error.message : "Request failed.") : null}
            group={selectedGroup}
            loading={groupMembersQuery.isPending}
            members={groupMembersQuery.data ?? []}
            organizationMembers={organizationMembersQuery.data ?? []}
            saving={
              updateGroupMutation.isPending ||
              deleteGroupMutation.isPending ||
              addMemberMutation.isPending ||
              removeMemberMutation.isPending ||
              organizationMembersQuery.isPending
            }
            setNotice={setNotice}
            onAddMember={(userId) => addMemberMutation.mutateAsync({ userId })}
            onDelete={async () => {
              await deleteGroupMutation.mutateAsync(selectedGroup.groupId);
              setNotice({ tone: "neutral", title: "Group deleted", description: `${selectedGroup.name} was removed from the organization.` });
              closePanel();
            }}
            onRemoveMember={(userId) => removeMemberMutation.mutateAsync(userId)}
            onRename={(name) => updateGroupMutation.mutateAsync({ groupId: selectedGroup.groupId, name: name.trim() })}
            onRetry={() => void groupMembersQuery.refetch()}
          />
      </ContextPanel> : null}
      {createOpen ? <ContextPanel title="Create group" onClose={closePanel}><form className="ui-section-stack" onSubmit={(event) => { event.preventDefault(); setNotice(null); void createGroupMutation.mutateAsync({ name: newGroupName.trim() }).then((group) => { setNewGroupName(""); setNotice({ tone: "neutral", title: "Group created", description: `${group.name} is ready for member assignment.` }); setSearchParams({ panel: "group", group: group.groupId }); }).catch((caught) => setNotice({ tone: "danger", title: "Group creation failed", description: caught instanceof Error ? caught.message : "The group could not be created." })); }}><FormRow label="Group name" hint="Nested groups stay out of scope."><input aria-label="New group name" required value={newGroupName} onChange={(event) => setNewGroupName(event.target.value)} /></FormRow><button className="ui-button ui-button-primary" disabled={createGroupMutation.isPending} type="submit">{createGroupMutation.isPending ? "Creating…" : "Create group"}</button></form></ContextPanel> : null}
    </section>
  );
}
