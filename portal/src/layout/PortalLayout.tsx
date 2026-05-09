import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { fetchMe, logout } from "@/api/auth";
import { fetchHealth } from "@/api/health";
import { keysStatusKey, portalAccountKeysKey, portalMeKey } from "@/queries/keys";
import { ROUTE_LABELS } from "./routeMeta";

const PORTAL_VERSION = "v1.0.2";

function initialsFromDisplayName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) {
    const w = parts[0];
    return (w.length <= 2 ? w : w.slice(0, 2)).toUpperCase();
  }
  const a = parts[0][0] ?? "";
  const b = parts[parts.length - 1][0] ?? "";
  return `${a}${b}`.toUpperCase();
}

export function PortalLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

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

  const { data: profile, isFetched: profileFetched } = useQuery({
    queryKey: portalMeKey,
    queryFn: fetchMe,
  });

  /** Remount route content when auth identity changes (e.g. sign out resets wizard state). Stable while /me is loading. */
  const outletAuthKey = !profileFetched ? "auth-pending" : profile?.user?.id ?? "signed-out";

  const logoutMut = useMutation({
    mutationFn: logout,
    onSuccess: async () => {
      setUserMenuOpen(false);
      await queryClient.invalidateQueries({ queryKey: portalMeKey });
      await queryClient.invalidateQueries({ queryKey: portalAccountKeysKey });
      await queryClient.invalidateQueries({ queryKey: keysStatusKey });
    },
  });

  useEffect(() => {
    document.body.classList.toggle("logged-in", Boolean(profile?.user));
    return () => document.body.classList.remove("logged-in");
  }, [profile?.user]);

  useEffect(() => {
    if (!userMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [userMenuOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (userMenuOpen) {
        setUserMenuOpen(false);
        return;
      }
      setDrawerOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [userMenuOpen]);

  const operational = health && typeof health.service === "string" && health.service.toLowerCase().includes("amethyst");

  const statusDotClass = operational ? "is-live" : health ? "is-degraded" : "is-pending";
  const statusLabel = operational ? "Operational" : health ? "Degraded" : "Checking…";

  return (
    <>
      <header className="portal-site-header">
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
            <button
              type="button"
              className="logo-btn"
              id="logoHomeBtn"
              onClick={() => {
                setUserMenuOpen(false);
                navigate("/reference");
              }}
            >
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
          <div className="header-toolbar" role="toolbar" aria-label="Portal toolbar">
            <div className="header-status" title="API service health">
              <span className={`header-status-dot ${statusDotClass}`} id="statusDot" aria-hidden />
              <span className="header-status-text" id="statusText">
                {statusLabel}
              </span>
            </div>
            <span className="header-version" title={`Portal release ${PORTAL_VERSION}`}>
              {PORTAL_VERSION}
            </span>
            {profileFetched && !profile?.user ? (
              <NavLink to="/login" className="header-sign-in" id="headerSignInLink">
                Sign in
              </NavLink>
            ) : null}
            {profile?.user ? (
              <div className="header-user-menu" ref={userMenuRef}>
                <button
                  type="button"
                  className={`header-user-trigger${userMenuOpen ? " is-open" : ""}`}
                  id="accountChipBtn"
                  aria-label={`Account menu — ${profile.user.displayName}`}
                  aria-expanded={userMenuOpen}
                  aria-haspopup="menu"
                  aria-controls="headerUserMenu"
                  onClick={() => setUserMenuOpen((open) => !open)}
                >
                  <span className="header-user-avatar" aria-hidden>
                    {initialsFromDisplayName(profile.user.displayName)}
                  </span>
                  <span className="header-user-name">{profile.user.displayName}</span>
                  <span className="header-user-chevron" aria-hidden>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </span>
                </button>
                {userMenuOpen ? (
                  <div id="headerUserMenu" role="menu" className="header-user-dropdown" aria-labelledby="accountChipBtn">
                    <div className="header-menu-meta" role="presentation">
                      <div className="header-menu-display">{profile.user.displayName}</div>
                      <div className="header-menu-email">{profile.user.email}</div>
                    </div>
                    <button
                      type="button"
                      role="menuitem"
                      className="header-menu-item"
                      onClick={() => {
                        navigate("/keys");
                        setUserMenuOpen(false);
                      }}
                    >
                      API keys
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="header-menu-item"
                      onClick={() => {
                        navigate("/sandbox");
                        setUserMenuOpen(false);
                      }}
                    >
                      Playground
                    </button>
                    <div className="header-menu-sep" role="separator" />
                    <button
                      type="button"
                      role="menuitem"
                      className="header-menu-item header-menu-item--signout"
                      id="headerSignOutBtn"
                      disabled={logoutMut.isPending}
                      onClick={() => logoutMut.mutate()}
                    >
                      {logoutMut.isPending ? "Signing out…" : "Sign out"}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <div className="nav-backdrop" id="navBackdrop" hidden={!drawerOpen} aria-hidden={!drawerOpen} onClick={() => setDrawerOpen(false)} />

      <div className="app-body">
        <aside className="app-sidebar" id="appSidebar" aria-label="Developer portal">
          <nav className="sidebar-nav">
            <div className="sidebar-rail">
              <div className="sidebar-kicker">Documentation</div>
              <NavLink
                to="/reference"
                className={({ isActive }) => `sidebar-link portal-tab-trigger${isActive ? " active" : ""}`}
                onClick={() => {
                  setDrawerOpen(false);
                  setUserMenuOpen(false);
                }}
              >
                API Reference
              </NavLink>
              <NavLink
                to="/licensing"
                className={({ isActive }) => `sidebar-link portal-tab-trigger${isActive ? " active" : ""}`}
                onClick={() => {
                  setDrawerOpen(false);
                  setUserMenuOpen(false);
                }}
              >
                Licensing
              </NavLink>

              <div className="sidebar-divider" role="presentation" />

              <div className="sidebar-kicker">Tools</div>
              <p className="sidebar-section-hint sidebar-hint-tools">Live requests against the API.</p>
              <NavLink
                to="/sandbox"
                className={({ isActive }) => `sidebar-link portal-tab-trigger${isActive ? " active" : ""}`}
                onClick={() => {
                  setDrawerOpen(false);
                  setUserMenuOpen(false);
                }}
              >
                Playground
              </NavLink>

              <div className="sidebar-divider" role="presentation" />

              <div className="sidebar-kicker">Account</div>
              <p className="sidebar-section-hint">Keys and usage; sign in from the navbar when needed.</p>
              <NavLink
                to="/keys"
                className={({ isActive }) => `sidebar-link portal-tab-trigger${isActive ? " active" : ""}`}
                onClick={() => {
                  setDrawerOpen(false);
                  setUserMenuOpen(false);
                }}
              >
                API keys
              </NavLink>
            </div>
          </nav>
        </aside>

        <main className="main-area">
          <Outlet key={outletAuthKey} />
        </main>
      </div>
    </>
  );
}
