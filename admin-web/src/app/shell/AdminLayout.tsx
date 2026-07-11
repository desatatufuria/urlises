import { NavLink, Outlet } from "react-router-dom";
import { AppShell } from "../../lib/ui/components/AppShell";
import { Badge } from "../../lib/ui/components/Badge";
import { useAuth } from "../providers/AuthProvider";
import { useOrganization } from "../providers/OrganizationProvider";

const navItems = [
  { to: "/members", label: "Members" },
  { to: "/invitations", label: "Invitations" },
  { to: "/groups", label: "Groups" },
  { to: "/workspaces", label: "Workspaces" },
  { to: "/access", label: "Access" },
] as const;

export function AdminLayout() {
  const { principal, signOut } = useAuth();
  const { activeOrganization, adminOrganizations, setActiveOrganizationId } = useOrganization();

  return (
    <AppShell
      eyebrow="Operator shell"
      title={activeOrganization?.organizationName ?? "Admin Web"}
      subtitle="Minimal control plane for organization members, invitations, groups, workspaces, and access only."
      headerActions={
        <>
          <Badge tone="neutral">{activeOrganization?.role ?? "admin"}</Badge>
          <button className="ui-button ui-button-secondary" onClick={() => void signOut()} type="button">
            Sign out
          </button>
        </>
      }
      sidebar={
        <>
          <label className="ui-field-label">
            Active organization
            <select
              aria-label="Active organization"
              className="ui-select"
              value={activeOrganization?.organizationId ?? ""}
              onChange={(event) => setActiveOrganizationId(event.target.value)}
            >
              {adminOrganizations.map((organization) => (
                <option key={organization.organizationId} value={organization.organizationId}>
                  {organization.organizationName}
                </option>
              ))}
            </select>
          </label>
          <nav aria-label="Admin sections" className="ui-nav">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                className={({ isActive }) => `ui-nav__link${isActive ? " ui-nav__link--active" : ""}`}
                to={item.to}
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="ui-meta-card">
            <p className="ui-meta-label">Signed in as</p>
            <strong>{principal?.name ?? principal?.email}</strong>
            <p className="ui-muted">Out-of-scope areas stay hidden by design.</p>
          </div>
        </>
      }
    >
      <Outlet />
    </AppShell>
  );
}
