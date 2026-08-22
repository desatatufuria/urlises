import { Outlet } from "react-router-dom";
import { AppShell } from "../../lib/ui/components/AppShell";
import { AdminShellContext } from "./AdminShellContext";

export function AdminLayout() {
  return (
    <AppShell context={<AdminShellContext />}>
      <Outlet />
    </AppShell>
  );
}
