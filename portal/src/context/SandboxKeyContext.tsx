import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export type SandboxAccountKey = {
  label: string;
  tier: string;
  fullKey: string;
  isActive?: boolean;
};

type Ctx = {
  accountKeys: SandboxAccountKey[];
  setAccountKeys: (keys: SandboxAccountKey[]) => void;
  pushIssuedKey: (k: SandboxAccountKey) => void;
  clearKeys: () => void;
};

const SandboxKeyContext = createContext<Ctx | null>(null);

export function SandboxKeyProvider({ children }: { children: ReactNode }) {
  const [accountKeys, setAccountKeys] = useState<SandboxAccountKey[]>([]);

  const pushIssuedKey = useCallback((k: SandboxAccountKey) => {
    setAccountKeys((prev) => [k, ...prev]);
  }, []);

  const clearKeys = useCallback(() => setAccountKeys([]), []);

  const value = useMemo(
    () => ({ accountKeys, setAccountKeys, pushIssuedKey, clearKeys }),
    [accountKeys, pushIssuedKey, clearKeys]
  );

  return <SandboxKeyContext.Provider value={value}>{children}</SandboxKeyContext.Provider>;
}

export function useSandboxKeys() {
  const v = useContext(SandboxKeyContext);
  if (!v) throw new Error("useSandboxKeys outside SandboxKeyProvider");
  return v;
}
