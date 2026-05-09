import { useQuery } from "@tanstack/react-query";
import { Navigate } from "react-router-dom";
import { fetchMe } from "@/api/auth";
import { portalMeKey } from "@/queries/keys";
import { HomeTab } from "./HomeTab";

export function ProtectedHome() {
  const { data, isPending } = useQuery({
    queryKey: portalMeKey,
    queryFn: fetchMe,
  });

  if (isPending) {
    return (
      <div className="portal-shell">
        <p className="portal-hint" style={{ margin: 0 }}>
          Loading…
        </p>
      </div>
    );
  }

  if (!data?.user) {
    return <Navigate to="/keys" replace />;
  }

  return <HomeTab />;
}
