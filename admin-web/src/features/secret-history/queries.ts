import { useQuery } from "@tanstack/react-query";
import { listMySecrets } from "../../lib/api/secrets";

export function useMySecrets(token?: string) {
  return useQuery({
    queryKey: ["secrets", "mine"] as const,
    queryFn: () => listMySecrets(token!),
    enabled: Boolean(token),
  });
}
