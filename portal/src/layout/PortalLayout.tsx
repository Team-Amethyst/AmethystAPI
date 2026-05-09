import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { fetchMe } from "@/api/auth";
import { fetchHealth } from "@/api/health";
import { portalMeKey } from "@/queries/keys";
import { ROUTE_LABELS } from "./routeMeta";

export function PortalLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const tab = (location.pathname.replace(/^\//, "") || "reference").split("/")[0] || "reference";

  useEffect(() => {
    document.body.dataset.portalTab = tab;
    const label = ROUTE_LABELS[tab] || "Portal";
    document.title = `${label} — Amethyst Engine`;
  }, [tab]);

  useEffect(() => {
    document.body.classList.toggle("nav-drawer-open", drawerOpen);
    return () => document.body.classList.remove("nav-drawer-open");
  }, [drawerOpen]);

  const { data: health } = useQuery({
    queryKey: ["portal", "health"],
    queryFn: fetchHealth,
    refetchInterval: 60_000,
  });

  const { data: profile } = useQuery({
    queryKey: portalMeKey,
    queryFn: fetchMe,
  });

  useEffect(() => {
    document.body.classList.toggle("logged-in", Boolean(profile?.user));
    return () => document.body.classList.remove("logged-in");
  }, [profile?.user]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const operational = health && typeof health.service === "string" && health.service.toLowerCase().includes("amethyst");

  return (
    <>
      <header>
        <div className="header-inner">
          <div className="header-brand-wrap">
            <button
              type="button"
              className="nav-menu-btn"
              id="navMenuBtn"
              aria-label="Open menu"
              aria-expanded={drawerOpen}
              aria-controls="appSidebar"
              onClick={() => setDrawerOpen((o) => !o)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <line x1="4" y1="6" x2="20" y2="6" />
                <line x1="4" y1="12" x2="20" y2="12" />
                <line x1="4" y1="18" x2="20" y2="18" />
              </svg>
            </button>
            <button type="button" className="logo-btn" id="logoHomeBtn" onClick={() => navigate("/reference")}>
              <svg className="logo-mark" width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
                <path
                  d="M11 2L3 7.5V14.5L11 20L19 14.5V7.5L11 2Z"
                  fill="#5b21b6"
                  stroke="#7c3aed"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
                <path d="M11 2L11 20M3 7.5L19 7.5M3 14.5L19 14.5" stroke="#a78bfa" strokeWidth="1" strokeOpacity="0.45" />
              </svg>
              Amethyst Engine
            </button>
          </div>
          <div className="header-meta">
            <div className="status-dot">
              <span className={`dot ${operational ? "online" : ""}`} id="statusDot" />
              <span id="statusText">{operational ? "operational" : health ? "degraded" : "checking…"}</span>
            </div>
            {profile?.user ? (
              <button
                type="button"
                className="account-chip online"
                id="accountChipBtn"
                aria-label="Account and API keys"
                onClick={() => navigate("/keys")}
              >
                {profile.user.displayName}
              </button>
            ) : null}
            <span className="version-badge">v1.0.2</span>
          </div>
        </div>
      </header>

      <div className="nav-backdrop" id="navBackdrop" hidden={!drawerOpen} aria-hidden={!drawerOpen} onClick={() => setDrawerOpen(false)} />

      <div className="app-body">
        <aside className="app-sidebar" id="appSidebar" aria-label="Developer portal">
          <nav className="sidebar-nav">
            <div className="sidebar-rail">
              <div className="sidebar-kicker">Product docs</div>
              <NavLink
                to="/reference"
                className={({ isActive }) => `sidebar-link portal-tab-trigger${isActive ? " active" : ""}`}
                onClick={() => setDrawerOpen(false)}
              >
                API Reference
              </NavLink>
              <NavLink
                to="/licensing"
                className={({ isActive }) => `sidebar-link portal-tab-trigger${isActive ? " active" : ""}`}
                onClick={() => setDrawerOpen(false)}
              >
                Licensing
              </NavLink>

              <div className="sidebar-divider" role="presentation" />

              <div className="sidebar-kicker">Try the API</div>
              <p className="sidebar-section-hint sidebar-hint-tools">Key in header only.</p>
              <NavLink
                to="/usage"
                className={({ isActive }) => `sidebar-link portal-tab-trigger${isActive ? " active" : ""}`}
                onClick={() => setDrawerOpen(false)}
              >
                Usage
              </NavLink>
              <NavLink
                to="/sandbox"
                className={({ isActive }) => `sidebar-link portal-tab-trigger${isActive ? " active" : ""}`}
                onClick={() => setDrawerOpen(false)}
              >
                Playground
              </NavLink>

              <div className="sidebar-divider" role="presentation" />

              {!profile?.user ? (
                <div id="sidebarKeysGate" className="sidebar-keys-gate">
                  <div className="sidebar-kicker">Account</div>
                  <p className="sidebar-section-hint">Session for issuing keys.</p>
                  <NavLink
                    to="/keys"
                    className={({ isActive }) => `sidebar-link portal-tab-trigger${isActive ? " active" : ""}`}
                    onClick={() => setDrawerOpen(false)}
                  >
                    API keys
                  </NavLink>
                </div>
              ) : (
                <div id="sidebarKeysSignedIn" className="sidebar-keys-signed">
                  <div className="sidebar-kicker">Account</div>
                  <NavLink
                    to="/home"
                    className={({ isActive }) => `sidebar-link portal-tab-trigger${isActive ? " active" : ""}`}
                    onClick={() => setDrawerOpen(false)}
                  >
                    Home
                  </NavLink>
                  <NavLink
                    to="/keys"
                    className={({ isActive }) => `sidebar-link portal-tab-trigger${isActive ? " active" : ""}`}
                    onClick={() => setDrawerOpen(false)}
                  >
                    API keys
                  </NavLink>
                </div>
              )}
            </div>
          </nav>
        </aside>

        <main className="main-area">
          <Outlet />
        </main>
      </div>
    </>
  );
}
