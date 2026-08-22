import { NavLink, Outlet } from "react-router-dom";
import { AppShell } from "../../lib/ui/components/AppShell";
import { Badge } from "../../lib/ui/components/Badge";
import { useColorScheme } from "../../lib/ui/useColorScheme";
import type { ColorSchemePreference } from "../../lib/ui/colorScheme";
import { useAuth } from "../providers/AuthProvider";
import { useOrganization } from "../providers/OrganizationProvider";

const colorSchemeOptions: { value: ColorSchemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const navItems = [
  { to: "/", label: "Overview", end: true },
  { to: "/members", label: "People" },
  { to: "/groups", label: "Groups" },
  { to: "/workspaces", label: "Workspaces" },
  { to: "/access", label: "Access" },
  { to: "/activity", label: "Activity" },
  { to: "/secrets", label: "Secrets" },
] as const;

export function AdminLayout() {
  const { principal, signOut } = useAuth();
  const { activeOrganization, adminOrganizations, setActiveOrganizationId } = useOrganization();
  const { preference, setPreference } = useColorScheme();

  return (
    <AppShell context={<>
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
      <div className="ui-context-actions"><select aria-label="Active organization" className="ui-select" value={activeOrganization?.organizationId ?? ""} onChange={(event) => setActiveOrganizationId(event.target.value)}>{adminOrganizations.map((organization) => <option key={organization.organizationId} value={organization.organizationId}>{organization.organizationName}</option>)}</select><select aria-label="Color scheme" className="ui-select" value={preference} onChange={(event) => setPreference(event.target.value as ColorSchemePreference)}>{colorSchemeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><Badge tone="neutral">{activeOrganization?.role ?? "admin"}</Badge><button aria-label={`Sign out ${principal?.name ?? principal?.email ?? ""}`} className="ui-button ui-button-secondary" onClick={() => void signOut()} type="button">Sign out</button></div>
    </>}>
      <Outlet />
    </AppShell>
  );
}
