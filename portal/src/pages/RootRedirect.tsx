import { useQuery } from "@tanstack/react-query";
import { Navigate } from "react-router-dom";
import { fetchMe } from "@/api/auth";
import { portalMeKey } from "@/queries/keys";

export function RootRedirect() {
  const { data, isPending } = useQuery({
    queryKey: portalMeKey,
    queryFn: fetchMe,
  });

  if (isPending) {
    return (
      <div className="portal-shell">
        <p className="portal-hint portal-hint--flush">Loading…</p>
      </div>
    );
  }

  return data?.user ? <Navigate to="/keys" replace /> : <Navigate to="/reference" replace />;
}
