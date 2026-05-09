import { createHashRouter, Navigate } from "react-router-dom";
import { PortalLayout } from "@/layout/PortalLayout";
import { KeysTab } from "@/pages/KeysTab";
import { LoginTab } from "@/pages/LoginTab";
import { LicensingTab } from "@/pages/LicensingTab";
import { ReferenceTab } from "@/pages/ReferenceTab";
import { RootRedirect } from "@/pages/RootRedirect";
import { SandboxTab } from "@/pages/SandboxTab";

export const router = createHashRouter([
  {
    path: "/",
    element: <PortalLayout />,
    children: [
      { index: true, element: <RootRedirect /> },
      { path: "reference", element: <ReferenceTab /> },
      { path: "licensing", element: <LicensingTab /> },
      { path: "home", element: <Navigate to="/keys" replace /> },
      { path: "usage", element: <Navigate to="/keys" replace /> },
      { path: "login", element: <LoginTab /> },
      { path: "register", element: <Navigate to="/login" replace /> },
      { path: "keys", element: <KeysTab /> },
      { path: "sandbox", element: <SandboxTab /> },
    ],
  },
]);
