import { createHashRouter } from "react-router-dom";
import { PortalLayout } from "@/layout/PortalLayout";
import { KeysTab } from "@/pages/KeysTab";
import { LicensingTab } from "@/pages/LicensingTab";
import { ProtectedHome } from "@/pages/ProtectedHome";
import { ReferenceTab } from "@/pages/ReferenceTab";
import { RootRedirect } from "@/pages/RootRedirect";
import { SandboxTab } from "@/pages/SandboxTab";
import { UsageTab } from "@/pages/UsageTab";

export const router = createHashRouter([
  {
    path: "/",
    element: <PortalLayout />,
    children: [
      { index: true, element: <RootRedirect /> },
      { path: "reference", element: <ReferenceTab /> },
      { path: "licensing", element: <LicensingTab /> },
      { path: "home", element: <ProtectedHome /> },
      { path: "keys", element: <KeysTab /> },
      { path: "usage", element: <UsageTab /> },
      { path: "sandbox", element: <SandboxTab /> },
    ],
  },
]);
