import { createContext, useCallback, useContext, useEffect, useMemo, useState, type PropsWithChildren } from "react";
import { getMe, login, logout as apiLogout } from "../../lib/api/auth";
import { listOrganizations } from "../../lib/api/organizations";
import { getStoredClientId, setStoredClientId } from "../../lib/api/client";
import type { AdminPrincipal, AdminSession, LoginPayload, OrganizationMembership } from "../../lib/api/types";

const STORAGE_KEY = "admin-web/session";

export interface AuthSnapshot {
  session: AdminSession | null;
  principal: AdminPrincipal | null;
  organizations: OrganizationMembership[];
}

type AuthStatus = "loading" | "anonymous" | "authenticated";

interface AuthContextValue extends AuthSnapshot {
  status: AuthStatus;
  signIn: (payload: LoginPayload) => Promise<void>;
	signOut: () => Promise<void>;
	refreshOrganizations: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function readStoredSnapshot(): AuthSnapshot | null {
  if (typeof window === "undefined") {
    return null;
  }

	let raw: string | null = null;
	try { raw = window.localStorage.getItem(STORAGE_KEY); } catch { return null; }
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as AuthSnapshot;
  } catch {
		try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* storage is optional */ }
    return null;
  }
}

function persistSnapshot(snapshot: AuthSnapshot | null) {
  if (typeof window === "undefined") {
    return;
  }

  if (!snapshot) {
		try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* storage is optional */ }
    return;
  }

	try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot)); } catch { /* memory session remains usable */ }
}

export function AuthProvider({ children, initialSnapshot }: PropsWithChildren<{ initialSnapshot?: AuthSnapshot }>) {
  const [snapshot, setSnapshot] = useState<AuthSnapshot>(initialSnapshot ?? { session: null, principal: null, organizations: [] });
  const [status, setStatus] = useState<AuthStatus>(initialSnapshot ? "authenticated" : "loading");

  useEffect(() => {
    if (initialSnapshot) {
      return;
    }

    const restore = async () => {
      const stored = readStoredSnapshot();
      if (!stored?.session) {
        setStatus("anonymous");
        return;
      }

      try {
        setStoredClientId(stored.session.clientId);
        const [principal, organizations] = await Promise.all([
          getMe(stored.session.accessToken),
          listOrganizations(stored.session.accessToken),
        ]);

        const nextSnapshot = { session: stored.session, principal, organizations };
        setSnapshot(nextSnapshot);
        persistSnapshot(nextSnapshot);
        setStatus("authenticated");
      } catch {
        persistSnapshot(null);
        setSnapshot({ session: null, principal: null, organizations: [] });
        setStatus("anonymous");
      }
    };

    void restore();
  }, [initialSnapshot]);

  const signIn = useCallback(async (payload: LoginPayload) => {
    const session = await login({
      ...payload,
      clientId: getStoredClientId(),
      deviceName: payload.deviceName?.trim() || "Admin Web",
    });

    setStoredClientId(session.clientId);

    const [principal, organizations] = await Promise.all([
      getMe(session.accessToken),
      listOrganizations(session.accessToken),
    ]);

    const nextSnapshot = { session, principal, organizations };
    setSnapshot(nextSnapshot);
    persistSnapshot(nextSnapshot);
    setStatus("authenticated");
  }, []);

	const signOut = useCallback(async () => {
    if (snapshot.session?.accessToken) {
      await apiLogout(snapshot.session.accessToken).catch(() => undefined);
    }
		persistSnapshot(null);
		if (typeof window !== "undefined") window.dispatchEvent(new Event("admin-web:signout"));
    setSnapshot({ session: null, principal: null, organizations: [] });
    setStatus("anonymous");
	}, [snapshot.session?.accessToken]);

	const refreshOrganizations = useCallback(async () => {
		if (!snapshot.session) return;
		const organizations = await listOrganizations(snapshot.session.accessToken);
		const nextSnapshot = { ...snapshot, organizations };
		setSnapshot(nextSnapshot);
		persistSnapshot(nextSnapshot);
	}, [snapshot]);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...snapshot,
      status,
		signIn,
		signOut,
		refreshOrganizations,
    }),
	[refreshOrganizations, signIn, signOut, snapshot, status],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }

  return context;
}
