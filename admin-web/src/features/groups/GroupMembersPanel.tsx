import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { Badge } from "../../lib/ui/components/Badge";
import { DataState } from "../../lib/ui/components/DataState";
import { FormRow } from "../../lib/ui/components/FormRow";
import { Table } from "../../lib/ui/components/Table";
import type { GroupMember, GroupSummary, OrganizationMember } from "../../lib/api/types";

export function GroupMembersPanel({
  group,
  organizationMembers,
  members,
  loading,
  error,
  saving,
  onRetry,
  onRename,
  onDelete,
  onAddMember,
  onRemoveMember,
  setNotice,
}: {
  group: GroupSummary;
  organizationMembers: OrganizationMember[];
  members: GroupMember[];
  loading: boolean;
  error: string | null;
  saving: boolean;
  onRetry: () => void;
  onRename: (name: string) => Promise<unknown>;
  onDelete: () => Promise<unknown>;
  onAddMember: (userId: string) => Promise<unknown>;
  onRemoveMember: (userId: string) => Promise<unknown>;
  setNotice: Dispatch<SetStateAction<{ tone: "neutral" | "danger"; title: string; description: string } | null>>;
}) {
  const [name, setName] = useState(group.name);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [removingUserId, setRemovingUserId] = useState<string | null>(null);

  useEffect(() => {
    setName(group.name);
  }, [group.groupId, group.name]);

  const availableMembers = useMemo(
    () => organizationMembers.filter((member) => !members.some((groupMember) => groupMember.userId === member.userId)),
    [members, organizationMembers],
  );

  useEffect(() => {
    setSelectedUserId(availableMembers[0]?.userId ?? "");
  }, [availableMembers]);

  return (
    <section className="ui-card ui-section-stack">
      <header className="ui-section-header">
        <div className="ui-actions-spread">
          <div>
            <h3 className="ui-section-title">Group members</h3>
            <p className="ui-copy">Groups stay flat in MVP. Membership assignment stays constrained to current organization members.</p>
          </div>
          <Badge tone="accent">{members.length} member{members.length === 1 ? "" : "s"}</Badge>
        </div>
      </header>

      <form
        className="ui-section-stack"
        onSubmit={(event) => {
          event.preventDefault();
          void onRename(name)
            .then(() => {
              setNotice({ tone: "neutral", title: "Group updated", description: `${name} is now the saved group name.` });
            })
            .catch((caught) => {
              setNotice({
                tone: "danger",
                title: "Group update failed",
                description: caught instanceof Error ? caught.message : "The group name could not be updated.",
              });
            });
        }}
      >
        <div className="ui-inline-grid ui-inline-grid--actions">
          <FormRow label="Group name">
            <input aria-label="Group name" value={name} onChange={(event) => setName(event.target.value)} />
          </FormRow>
          <div className="ui-actions-row ui-actions-row--end">
            <button className="ui-button ui-button-secondary" disabled={saving} type="submit">
              {saving ? "Saving…" : "Save name"}
            </button>
            <button
              className="ui-button ui-button-secondary"
              disabled={saving}
              type="button"
              onClick={() => {
                if (!window.confirm(`Delete group ${group.name}?`)) {
                  return;
                }

                void onDelete().catch((caught) => {
                  setNotice({
                    tone: "danger",
                    title: "Group deletion failed",
                    description: caught instanceof Error ? caught.message : "The group could not be deleted.",
                  });
                });
              }}
            >
              Delete group
            </button>
          </div>
        </div>
      </form>

      <form
        className="ui-section-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (!selectedUserId) {
            return;
          }

          void onAddMember(selectedUserId)
            .then(() => {
              const added = organizationMembers.find((member) => member.userId === selectedUserId);
              setNotice({
                tone: "neutral",
                title: "Member added",
                description: `${added?.email ?? "The selected member"} now belongs to ${group.name}.`,
              });
            })
            .catch((caught) => {
              setNotice({
                tone: "danger",
                title: "Member assignment failed",
                description: caught instanceof Error ? caught.message : "The selected member could not be added.",
              });
            });
        }}
      >
        <div className="ui-inline-grid ui-inline-grid--actions">
          <FormRow label="Add organization member">
            <select aria-label="Add member to group" disabled={saving || availableMembers.length === 0} value={selectedUserId} onChange={(event) => setSelectedUserId(event.target.value)}>
              {availableMembers.length === 0 ? <option value="">No more members available</option> : null}
              {availableMembers.map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.email}
                </option>
              ))}
            </select>
          </FormRow>
          <div className="ui-actions-row ui-actions-row--end">
            <button className="ui-button ui-button-primary" disabled={saving || !selectedUserId} type="submit">
              Add member
            </button>
          </div>
        </div>
      </form>

      {loading ? <DataState title="Loading group members" description="Reviewing the current membership for the selected group." /> : null}

      {error ? (
        <div className="ui-section-stack">
          <DataState tone="danger" title="Group members could not be loaded" description={error} />
          <div className="ui-actions-row">
            <button className="ui-button ui-button-secondary" type="button" onClick={onRetry}>
              Retry group members
            </button>
          </div>
        </div>
      ) : null}

      {!loading && !error && members.length === 0 ? (
        <DataState title="No assigned members yet" description="Add an organization member to make this group useful for later workspace access grants." />
      ) : null}

      {!loading && !error && members.length > 0 ? (
        <Table columns={["Member", "Status", "Actions"]}>
          {members.map((member) => (
            <tr key={member.userId}>
              <td>
                <div className="ui-cell-stack">
                  <strong>{member.name || member.email}</strong>
                  <span className="ui-muted">{member.email}</span>
                </div>
              </td>
              <td>
                <Badge tone="neutral">Assigned</Badge>
              </td>
              <td>
                <button
                  className="ui-button ui-button-secondary"
                  disabled={saving || removingUserId === member.userId}
                  type="button"
                  onClick={() => {
                    setRemovingUserId(member.userId);
                    void onRemoveMember(member.userId)
                      .then(() => {
                        setNotice({
                          tone: "neutral",
                          title: "Member removed",
                          description: `${member.email} was removed from ${group.name}.`,
                        });
                      })
                      .catch((caught) => {
                        setNotice({
                          tone: "danger",
                          title: "Member removal failed",
                          description: caught instanceof Error ? caught.message : "The member could not be removed from the group.",
                        });
                      })
                      .finally(() => setRemovingUserId(null));
                  }}
                >
                  {removingUserId === member.userId ? "Removing…" : "Remove"}
                </button>
              </td>
            </tr>
          ))}
        </Table>
      ) : null}
    </section>
  );
}
