import { createContext, useContext, useEffect, useMemo, useState, type PropsWithChildren } from "react";
import { useAuth } from "./AuthProvider";
import type { OrganizationMembership } from "../../lib/api/types";

const STORAGE_KEY = "admin-web/active-organization-id";

interface OrganizationContextValue {
  activeOrganization: OrganizationMembership | null;
  adminOrganizations: OrganizationMembership[];
  setActiveOrganizationId: (organizationId: string) => void;
}

const OrganizationContext = createContext<OrganizationContextValue | null>(null);

const ADMIN_ROLES = new Set(["owner", "admin"]);

function readStoredOrganizationId() {
  if (typeof window === "undefined") {
    return null;
  }

	try { return window.localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

export function OrganizationProvider({ children, initialOrganizationId }: PropsWithChildren<{ initialOrganizationId?: string }>) {
  const { organizations } = useAuth();
  const adminOrganizations = useMemo(
    () => organizations.filter((membership) => ADMIN_ROLES.has(membership.role)),
    [organizations],
  );
  const [activeOrganizationId, setActiveOrganizationIdState] = useState<string | null>(initialOrganizationId ?? null);

  useEffect(() => {
    const storedId = initialOrganizationId ?? readStoredOrganizationId();
    const resolved = adminOrganizations.find((organization) => organization.organizationId === storedId) ?? adminOrganizations[0] ?? null;
    setActiveOrganizationIdState(resolved?.organizationId ?? null);
  }, [adminOrganizations, initialOrganizationId]);

  const value = useMemo<OrganizationContextValue>(() => {
    const activeOrganization = adminOrganizations.find((organization) => organization.organizationId === activeOrganizationId) ?? null;

    return {
      activeOrganization,
      adminOrganizations,
      setActiveOrganizationId: (organizationId: string) => {
        setActiveOrganizationIdState(organizationId);
        if (typeof window !== "undefined") {
			try { window.localStorage.setItem(STORAGE_KEY, organizationId); } catch { /* selection remains in memory */ }
        }
      },
    };
  }, [activeOrganizationId, adminOrganizations]);

  return <OrganizationContext.Provider value={value}>{children}</OrganizationContext.Provider>;
}

export function useOrganization() {
  const context = useContext(OrganizationContext);
  if (!context) {
    throw new Error("useOrganization must be used within OrganizationProvider");
  }

  return context;
}
