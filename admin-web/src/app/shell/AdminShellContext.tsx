import { NavLink, useLocation } from "react-router-dom";
import { Badge } from "../../lib/ui/components/Badge";
import { DropdownMenu } from "../../lib/ui/components/DropdownMenu";
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
] as const;

// Collapsed into the "History" nav submenu instead of sitting flat in
// navItems -- Activity is the audit trail of what happened, Trash is what's
// no longer there pending recovery, Secrets is a personal read-only history
// of what you've shared; all three are "look back", not day-to-day
// navigation, so they share one dropdown.
const historyItems = [
  { to: "/activity", label: "Activity" },
  { to: "/trash", label: "Trash" },
  { to: "/secrets", label: "Secrets" },
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
  const { pathname } = useLocation();

  const historyActive = pathname.startsWith("/activity") || pathname.startsWith("/trash") || pathname.startsWith("/secrets");
  const accountLabel = principal?.name ?? principal?.email ?? "Account";

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
        <DropdownMenu
          label="History"
          triggerClassName={`ui-nav__link ui-dropdown__nav-trigger${historyActive ? " ui-nav__link--active" : ""}`}
        >
          {(close) => (
            <>
              {historyItems.map((item) => (
                <NavLink key={item.to} className="ui-dropdown__item" to={item.to} onClick={close}>
                  {item.label}
                </NavLink>
              ))}
            </>
          )}
        </DropdownMenu>
        {adminOrganizations.length > 0 ? <NavLink className={({ isActive }) => `ui-nav__link${isActive ? " ui-nav__link--active" : ""}`} to="/organizations/new">Create organization</NavLink> : null}
      </nav>
      <div className="ui-context-actions">
        <DropdownMenu
          ariaLabel={accountLabel}
          label={(
            <>
              <span className="ui-account-trigger__label">{accountLabel}</span>
              <span aria-hidden="true">▾</span>
            </>
          )}
          panelClassName="ui-dropdown__panel--end"
          triggerClassName="ui-button ui-button-secondary ui-account-trigger"
        >
          {(close) => (
            <>
              <div className="ui-dropdown__meta">
                <Badge tone="neutral">{activeOrganization?.role ?? "admin"}</Badge>
                <span className="ui-muted">{activeOrganization?.organizationName ?? "Control"}</span>
              </div>
              <select
                aria-label="Active organization"
                className="ui-select"
                value={activeOrganization?.organizationId ?? ""}
                onChange={(event) => {
                  setActiveOrganizationId(event.target.value);
                  close();
                }}
              >
                {adminOrganizations.map((organization) => <option key={organization.organizationId} value={organization.organizationId}>{organization.organizationName}</option>)}
              </select>
              <ThemeToggle preference={preference} onChange={setPreference} />
              <NavLink className="ui-dropdown__item" to="/account" onClick={close}>Account</NavLink>
              <div className="ui-dropdown__divider">
                <button aria-label={`Sign out ${principal?.name ?? principal?.email ?? ""}`} className="ui-button ui-button-secondary" onClick={() => { close(); void signOut(); }} type="button">Sign out</button>
              </div>
            </>
          )}
        </DropdownMenu>
      </div>
    </>
  );
}
