import { NavLink } from "react-router-dom";
import { Badge } from "../../lib/ui/components/Badge";
import { ThemeToggle } from "../../lib/ui/components/ThemeToggle";
import { useColorScheme } from "../../lib/ui/useColorScheme";
import { useAuth } from "../providers/AuthProvider";
import { useOrganization } from "../providers/OrganizationProvider";

export const navItems = [
  { to: "/", label: "Overview", end: true },
  { to: "/members", label: "People" },
  { to: "/groups", label: "Groups" },
  { to: "/workspaces", label: "Workspaces" },
  { to: "/access", label: "Access" },
  { to: "/activity", label: "Activity" },
  { to: "/secrets", label: "Secrets" },
  { to: "/trash", label: "Trash" },
  { to: "/account", label: "Account" },
] as const;

/**
 * The shared header/nav/org-selector/theme/sign-out bar rendered inside
 * AppShell's `context` slot. Extracted out of AdminLayout so pages that
 * deliberately sit outside AdminLayout's route (e.g. TrashPage, reachable
 * even with zero live organizations) can still offer full navigation
 * instead of stranding the user with only the browser back button.
 */
export function AdminShellContext() {
  const { principal, signOut } = useAuth();
  const { activeOrganization, adminOrganizations, setActiveOrganizationId } = useOrganization();
  const { preference, setPreference } = useColorScheme();

  return (
    <>
      <div className="ui-context-identity"><strong>URLises</strong><span>{activeOrganization?.organizationName ?? "Control"}</span></div>
      <nav aria-label="Admin sections" className="ui-nav">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            className={({ isActive }) => `ui-nav__link${isActive ? " ui-nav__link--active" : ""}`}
            end={item.to === "/"}
            to={item.to}
          >
            {item.label}
          </NavLink>
        ))}
        {adminOrganizations.length > 0 ? <NavLink className={({ isActive }) => `ui-nav__link${isActive ? " ui-nav__link--active" : ""}`} to="/organizations/new">Create organization</NavLink> : null}
      </nav>
      <div className="ui-context-actions">
        <select aria-label="Active organization" className="ui-select" value={activeOrganization?.organizationId ?? ""} onChange={(event) => setActiveOrganizationId(event.target.value)}>
          {adminOrganizations.map((organization) => <option key={organization.organizationId} value={organization.organizationId}>{organization.organizationName}</option>)}
        </select>
        <ThemeToggle preference={preference} onChange={setPreference} />
        <Badge tone="neutral">{activeOrganization?.role ?? "admin"}</Badge>
        <button aria-label={`Sign out ${principal?.name ?? principal?.email ?? ""}`} className="ui-button ui-button-secondary" onClick={() => void signOut()} type="button">Sign out</button>
      </div>
    </>
  );
}
