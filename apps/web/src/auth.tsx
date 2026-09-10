import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

interface AuthState {
  loading: boolean;
  configured: boolean;
  authenticated: boolean;
  user: AuthUser | null;
  redirectUri: string | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  loading: true,
  configured: false,
  authenticated: false,
  user: null,
  redirectUri: null,
  refresh: async () => undefined,
  logout: async () => undefined,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Omit<AuthState, "refresh" | "logout">>({
    loading: true,
    configured: false,
    authenticated: false,
    user: null,
    redirectUri: null,
  });

  const refresh = useCallback(async () => {
    try {
      const s = await api.authStatus();
      setState({
        loading: false,
        configured: s.configured,
        authenticated: s.authenticated,
        user: s.user,
        redirectUri: s.redirectUri,
      });
    } catch {
      setState({
        loading: false,
        configured: false,
        authenticated: false,
        user: null,
        redirectUri: null,
      });
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setState((prev) => ({ ...prev, authenticated: false, user: null }));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <AuthContext.Provider value={{ ...state, refresh, logout }}>{children}</AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
