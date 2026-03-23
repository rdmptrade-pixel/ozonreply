import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { setToken, getToken, type UserPublic } from "./auth";
import { API_BASE, queryClient } from "./queryClient";

interface AuthContextValue {
  user: UserPublic | null;
  token: string | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => void;
  register: (email: string, password: string, name: string) => Promise<{ ok: boolean; error?: string }>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserPublic | null>(null);
  const [token, setTokenState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // On mount: restore session from localStorage/sessionStorage (survives page reload)
  useEffect(() => {
    const t = getToken();
    if (t) {
      // Validate token
      fetch(`${API_BASE}/api/auth/me`, {
        headers: { Authorization: `Bearer ${t}` },
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data?.user) {
            setUser(data.user);
            setTokenState(t);
          } else {
            setToken(null);
          }
        })
        .catch(() => setToken(null))
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) return { ok: false, error: data.error ?? "Ошибка входа" };

      setToken(data.token);
      setTokenState(data.token);
      setUser(data.user);
      queryClient.clear();
      return { ok: true };
    } catch {
      return { ok: false, error: "Ошибка соединения с сервером" };
    }
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setTokenState(null);
    setUser(null);
    queryClient.clear();
  }, []);

  const register = useCallback(async (email: string, password: string, name: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, name }),
      });
      const data = await res.json();
      if (!res.ok) return { ok: false, error: data.error ?? "Ошибка регистрации" };
      return { ok: true };
    } catch {
      return { ok: false, error: "Ошибка соединения с сервером" };
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, loading, login, logout, register }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
