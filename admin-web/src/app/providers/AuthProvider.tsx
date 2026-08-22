import { createContext, useCallback, useContext, useEffect, useMemo, useState, type PropsWithChildren } from "react";
import { getMe, getSetupStatus, login, logout as apiLogout, register } from "../../lib/api/auth";
import { createOrganization, listOrganizations } from "../../lib/api/organizations";
import { ApiError, getStoredClientId, regenerateStoredClientId, setStoredClientId } from "../../lib/api/client";
import type { AdminPrincipal, AdminSession, LoginPayload, OrganizationMembership, RegistrationPayload } from "../../lib/api/types";

const CLIENT_ALREADY_BOUND_MESSAGE = "client ID is already bound to another user";

const STORAGE_KEY = "admin-web/session";

export interface AuthSnapshot {
  session: AdminSession | null;
  principal: AdminPrincipal | null;
  organizations: OrganizationMembership[];
}

type AuthStatus = "loading" | "setupRequired" | "anonymous" | "authenticated";

interface AuthContextValue extends AuthSnapshot {
  status: AuthStatus;
  signIn: (payload: LoginPayload) => Promise<void>;
  signUp: (payload: RegistrationPayload) => Promise<void>;
  createOwnerOrganization: (name: string, idempotencyKey: string) => Promise<OrganizationMembership>;
  signOut: () => Promise<void>;
  refreshOrganizations: () => Promise<OrganizationMembership[]>;
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

async function loadSessionSnapshot(session: AdminSession): Promise<AuthSnapshot> {
  setStoredClientId(session.clientId);
  const [principal, organizations] = await Promise.all([
    getMe(session.accessToken),
    listOrganizations(session.accessToken),
  ]);
  return { session, principal, organizations };
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
        try {
          setStatus((await getSetupStatus()).required ? "setupRequired" : "anonymous");
        } catch {
          setStatus("anonymous");
        }
        return;
      }

      try {
        const nextSnapshot = await loadSessionSnapshot(stored.session);
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
      deviceName: payload.deviceName?.trim() || "URLises Control",
    });

    const nextSnapshot = await loadSessionSnapshot(session);
    setSnapshot(nextSnapshot);
    persistSnapshot(nextSnapshot);
    setStatus("authenticated");
  }, []);

  const signUp = useCallback(async (payload: RegistrationPayload) => {
    const deviceName = payload.deviceName?.trim() || "URLises Control";
    let session: AdminSession;
    try {
      session = await register({ ...payload, clientId: getStoredClientId(), deviceName });
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409 && caught.message === CLIENT_ALREADY_BOUND_MESSAGE) {
        // A brand-new account can't legitimately own this browser's stored
        // device binding — it must be stale from a different account. Mint
        // a fresh client ID and retry once rather than surfacing a
        // confusing error for something the user has no way to fix.
        session = await register({ ...payload, clientId: regenerateStoredClientId(), deviceName });
      } else {
        throw caught;
      }
    }
    const nextSnapshot = await loadSessionSnapshot(session);
    setSnapshot(nextSnapshot);
    persistSnapshot(nextSnapshot);
    setStatus("authenticated");
  }, []);

  const createOwnerOrganization = useCallback(async (name: string, idempotencyKey: string) => {
    if (!snapshot.session) throw new Error("An authenticated session is required.");
    const organization = await createOrganization(snapshot.session.accessToken, name, idempotencyKey);
    const nextSnapshot = { ...snapshot, organizations: [...snapshot.organizations, organization] };
    setSnapshot(nextSnapshot);
    persistSnapshot(nextSnapshot);
    return organization;
  }, [snapshot]);

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
		if (!snapshot.session) return [];
		const organizations = await listOrganizations(snapshot.session.accessToken);
		const nextSnapshot = { ...snapshot, organizations };
		setSnapshot(nextSnapshot);
		persistSnapshot(nextSnapshot);
		return organizations;
	}, [snapshot]);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...snapshot,
      status,
      signIn,
      signUp,
      createOwnerOrganization,
      signOut,
      refreshOrganizations,
    }),
    [createOwnerOrganization, refreshOrganizations, signIn, signOut, signUp, snapshot, status],
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
