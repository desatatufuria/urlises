import { useAuth } from "../../app/providers/AuthProvider";
import { useOrganization } from "../../app/providers/OrganizationProvider";
import { DataState } from "../../lib/ui/components/DataState";
import { Table } from "../../lib/ui/components/Table";
import { formatActivityEvent } from "./format";
import { useOrgActivity } from "./queries";

function formatDateTime(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export function ActivityPage() {
  const { session } = useAuth();
  const { activeOrganization } = useOrganization();
  const token = session?.accessToken;
  const organizationId = activeOrganization?.organizationId;

  const activityQuery = useOrgActivity(organizationId, token);

  if (!token || !organizationId) {
    return (
      <DataState
        tone="danger"
        title="Organization context missing"
        description="Choose an admin organization before reviewing the activity feed."
      />
    );
  }

  const events = activityQuery.data?.pages.flatMap((page) => page.events) ?? [];

  return (
    <section className="ui-section-stack">
      <header className="ui-section-header">
        <h1 className="ui-page-title">Activity</h1>
        <p className="ui-copy">
          A record of notable changes across this organization — invitations, access grants, and membership changes.
        </p>
      </header>

      {activityQuery.isPending ? (
        <DataState title="Loading activity" description="Fetching this organization's activity feed from the backend." />
      ) : null}

      {activityQuery.isError ? (
        <div className="ui-section-stack">
          <DataState
            tone="danger"
            title="Activity could not be loaded"
            description={activityQuery.error instanceof Error ? activityQuery.error.message : "Request failed."}
          />
          <div className="ui-actions-row">
            <button className="ui-button ui-button-secondary" type="button" onClick={() => void activityQuery.refetch()}>
              Retry
            </button>
          </div>
        </div>
      ) : null}

      {!activityQuery.isPending && !activityQuery.isError && events.length === 0 ? (
        <DataState
          title="No activity yet"
          description="Notable changes to this organization — invitations, access grants, and membership changes — will appear here."
        />
      ) : null}

      {!activityQuery.isPending && !activityQuery.isError && events.length > 0 ? (
        <>
          <Table columns={["When", "Actor", "Event"]}>
            {events.map((event) => (
              <tr key={event.id}>
                <td>{formatDateTime(event.createdAt)}</td>
                <td>{event.actorName ?? event.actorEmail ?? <span className="ui-muted">—</span>}</td>
                <td>{formatActivityEvent(event)}</td>
              </tr>
            ))}
          </Table>

          {activityQuery.hasNextPage ? (
            <div className="ui-actions-row">
              <button
                className="ui-button ui-button-secondary"
                type="button"
                disabled={activityQuery.isFetchingNextPage}
                onClick={() => void activityQuery.fetchNextPage()}
              >
                {activityQuery.isFetchingNextPage ? "Loading more…" : "Load more"}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
