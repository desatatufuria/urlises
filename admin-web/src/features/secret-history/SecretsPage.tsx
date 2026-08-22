import { useAuth } from "../../app/providers/AuthProvider";
import { Badge } from "../../lib/ui/components/Badge";
import { DataState } from "../../lib/ui/components/DataState";
import { Table } from "../../lib/ui/components/Table";
import type { SecretHistoryEntry } from "../../lib/api/secrets";
import { useMySecrets } from "./queries";

function formatDateTime(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function statusBadgeTone(status: SecretHistoryEntry["status"]) {
  if (status === "read") {
    return "accent" as const;
  }
  if (status === "expired") {
    return "danger" as const;
  }
  return "neutral" as const;
}

export function SecretsPage() {
  const { session } = useAuth();
  const token = session?.accessToken;
  const secretsQuery = useMySecrets(token);

  if (!token) {
    return <DataState tone="danger" title="Session required" description="Sign in again to review your secret history." />;
  }

  return (
    <section className="ui-section-stack">
      <header className="ui-section-header">
        <h1 className="ui-page-title">My secrets</h1>
        <p className="ui-copy">
          Secrets you&apos;ve created and shared from the extension — created time, and whether they were read. Only
          secrets you personally created are shown here. Use the URLises extension&apos;s &quot;Create a secret&quot; window
          to share a new one.
        </p>
      </header>

      {secretsQuery.isPending ? (
        <DataState title="Loading your secrets" description="Fetching your personal secret history from the backend." />
      ) : null}

      {secretsQuery.isError ? (
        <div className="ui-section-stack">
          <DataState
            tone="danger"
            title="Secret history could not be loaded"
            description={secretsQuery.error instanceof Error ? secretsQuery.error.message : "Request failed."}
          />
          <div className="ui-actions-row">
            <button className="ui-button ui-button-secondary" type="button" onClick={() => void secretsQuery.refetch()}>
              Retry
            </button>
          </div>
        </div>
      ) : null}

      {!secretsQuery.isPending && !secretsQuery.isError && (secretsQuery.data?.length ?? 0) === 0 ? (
        <DataState
          title="No secrets yet"
          description="You haven't created any secrets yet — use the URLises extension's 'Create a secret' window to share one."
        />
      ) : null}

      {!secretsQuery.isPending && !secretsQuery.isError && (secretsQuery.data?.length ?? 0) > 0 ? (
        <Table columns={["Created", "Status", "Sent to", "Read at"]}>
          {secretsQuery.data?.map((entry) => (
            <tr key={entry.id}>
              <td>{formatDateTime(entry.createdAt)}</td>
              <td>
                <Badge tone={statusBadgeTone(entry.status)}>{entry.status}</Badge>
              </td>
              <td>{entry.sentToEmail ? entry.sentToEmail : <span className="ui-muted">—</span>}</td>
              <td>{entry.status === "read" && entry.readAt ? formatDateTime(entry.readAt) : <span className="ui-muted">—</span>}</td>
            </tr>
          ))}
        </Table>
      ) : null}
    </section>
  );
}
