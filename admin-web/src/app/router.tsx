import { Navigate, Outlet, createBrowserRouter, type RouteObject } from "react-router-dom";
import { AdminLayout } from "./shell/AdminLayout";
import { useAuth } from "./providers/AuthProvider";
import { useOrganization } from "./providers/OrganizationProvider";
import { DataState } from "../lib/ui/components/DataState";
import { AccessPage } from "../features/access/AccessPage";
import { GroupsPage } from "../features/groups/GroupsPage";
import { MembersPage } from "../features/members/MembersPage";
import { WorkspacesPage } from "../features/workspaces/WorkspacesPage";
import { LoginPage } from "./views/LoginPage";

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

  return <Outlet />;
}

function RequireAdminOrganization() {
  const { adminOrganizations, activeOrganization } = useOrganization();

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
    path: "/",
    element: <RequireSession />,
    children: [
      {
        element: <RequireAdminOrganization />,
        children: [
          {
            path: "/",
            element: <AdminLayout />,
            children: [
              { index: true, element: <Navigate to="/members" replace /> },
              {
                path: "members",
                element: <MembersPage />,
              },
              {
                path: "invitations",
                element: <MembersPage focus="invitations" />,
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
