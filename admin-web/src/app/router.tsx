import { Navigate, Outlet, createBrowserRouter, type RouteObject } from "react-router-dom";
import { AdminLayout } from "./shell/AdminLayout";
import { useAuth } from "./providers/AuthProvider";
import { useOrganization } from "./providers/OrganizationProvider";
import { DataState } from "../lib/ui/components/DataState";
import { AccessPage } from "../features/access/AccessPage";
import { GroupsPage } from "../features/groups/GroupsPage";
import { MembersPage } from "../features/members/MembersPage";
import { WorkspacesPage } from "../features/workspaces/WorkspacesPage";
import { SecretsPage } from "../features/secret-history/SecretsPage";
import { StateHome } from "../features/home/StateHome";
import { LoginPage } from "./views/LoginPage";
import { OrganizationSetupPage } from "./views/OrganizationSetupPage";
import { OrganizationCreatePage } from "./views/OrganizationCreatePage";
import { RegisterPage } from "./views/RegisterPage";
import { InvitationAcceptPage } from "./views/InvitationAcceptPage";
import { SecretRevealPage } from "./views/SecretRevealPage";

function LoadingScreen() {
  return <DataState tone="neutral" title="Restoring operator session" description="Checking your admin session and organization scope." />;
}

function RequireSession() {
  const { status } = useAuth();

  if (status === "loading") {
    return <LoadingScreen />;
  }

  if (status === "anonymous") {
    return <Navigate to="/login" replace />;
  }
  if (status === "setupRequired") {
    return <Navigate to="/register" replace />;
  }

  return <Outlet />;
}

function RequireAdminOrganization() {
  const { organizations } = useAuth();
  const { adminOrganizations, activeOrganization } = useOrganization();

  if (organizations.length === 0) {
    return <Navigate to="/setup/organization" replace />;
  }

  if (adminOrganizations.length === 0) {
    return (
      <DataState
        tone="danger"
        title="Organization admin access required"
        description="This shell is limited to owner and admin memberships. Bookmark or tenant controls stay out of scope here."
      />
    );
  }

  if (!activeOrganization) {
    return <LoadingScreen />;
  }

  return <Outlet />;
}

export const appRoutes: RouteObject[] = [
  {
    path: "/login",
    element: <LoginPage />,
  },
  {
    path: "/register",
    element: <RegisterPage />,
  },
  {
    path: "/invitations/:token",
    element: <InvitationAcceptPage />,
  },
  {
    // Fully anonymous, public route: no RequireSession, no session concept
    // at all. SecretRevealPage must never call useAuth(), unlike
    // InvitationAcceptPage which — although also a top-level sibling here —
    // is internally auth-aware.
    path: "/s/:token",
    element: <SecretRevealPage />,
  },
  {
    path: "/",
    element: <RequireSession />,
    children: [
      {
        path: "setup/organization",
        element: <OrganizationSetupPage />,
      },
      {
        element: <RequireAdminOrganization />,
        children: [
          {
            path: "/",
            element: <AdminLayout />,
            children: [
              { index: true, element: <StateHome /> },
              { path: "organizations/new", element: <OrganizationCreatePage /> },
              {
                path: "members",
                element: <MembersPage />,
              },
              {
                path: "groups",
                element: <GroupsPage />,
              },
              {
                path: "workspaces",
                element: <WorkspacesPage />,
              },
              {
                path: "access",
                element: <AccessPage />,
              },
              {
                path: "secrets",
                element: <SecretsPage />,
              },
            ],
          },
        ],
      },
    ],
  },
  {
    path: "*",
    element: <Navigate to="/" replace />,
  },
];

export function createAppRouter() {
  return createBrowserRouter(appRoutes);
}
