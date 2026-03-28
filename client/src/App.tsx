import { Switch, Route, Link, Router as WouterRouter, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { AuthProvider, useAuth } from "@/lib/AuthContext";
import { Toaster } from "@/components/ui/toaster";
import { PerplexityAttribution } from "@/components/PerplexityAttribution";
import Dashboard from "@/pages/Dashboard";
import Reviews from "@/pages/Reviews";
import Questions from "@/pages/Questions";
import Settings from "@/pages/Settings";
import AdminPanel from "@/pages/AdminPanel";
import AuthPage from "@/pages/Auth";
import NotFound from "@/pages/not-found";
import {
  LayoutDashboard,
  MessageSquare,
  HelpCircle,
  Settings as SettingsIcon,
  ShoppingBag,
  Moon,
  Sun,
  Shield,
  LogOut,
} from "lucide-react";
import { useState, useEffect } from "react";

// ── Desktop sidebar nav item ──────────────────────────────────────────────────
function NavItem({ href, icon: Icon, label }: { href: string; icon: React.ElementType; label: string }) {
  const [location] = useLocation();
  const isActive = location === href || (href !== "/" && location.startsWith(href));
  return (
    <Link
      href={href}
      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
        isActive
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-secondary hover:text-foreground"
      }`}
      data-testid={`nav-${label}`}
    >
      <Icon size={18} />
      <span>{label}</span>
    </Link>
  );
}

// ── Mobile bottom tab bar item ────────────────────────────────────────────────
function TabItem({ href, icon: Icon, label }: { href: string; icon: React.ElementType; label: string }) {
  const [location] = useLocation();
  const isActive = location === href || (href !== "/" && location.startsWith(href));
  return (
    <Link
      href={href}
      className={`flex flex-col items-center gap-0.5 flex-1 py-2 text-xs font-medium transition-colors ${
        isActive ? "text-primary" : "text-muted-foreground"
      }`}
      data-testid={`tab-${label}`}
    >
      <Icon size={22} strokeWidth={isActive ? 2.2 : 1.8} />
      <span>{label}</span>
    </Link>
  );
}

// ── Full layout ───────────────────────────────────────────────────────────────
function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const [dark, setDark] = useState(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  const isAdmin = user?.role === "admin" || user?.role === "superadmin";

  return (
    <div className="flex min-h-screen bg-background">

      {/* ── Desktop sidebar (hidden on mobile) ── */}
      <aside className="hidden md:flex w-56 border-r border-border bg-card flex-col shrink-0 sticky top-0 h-screen">
        {/* Logo */}
        <div className="px-4 py-5 border-b border-border">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center shrink-0">
              <ShoppingBag size={16} className="text-primary-foreground" />
            </div>
            <div>
              <div className="font-semibold text-sm leading-tight" translate="no">AI Автомат</div>
              <div className="text-xs text-muted-foreground leading-tight">Управление отзывами</div>
            </div>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-3 space-y-1" data-testid="sidebar-nav">
          <NavItem href="/" icon={LayoutDashboard} label="Дашборд" />
          <NavItem href="/reviews" icon={MessageSquare} label="Отзывы" />
          <NavItem href="/questions" icon={HelpCircle} label="Вопросы" />
          <NavItem href="/settings" icon={SettingsIcon} label="Настройки" />
          {isAdmin && <NavItem href="/admin" icon={Shield} label="Пользователи" />}
        </nav>

        {/* Footer */}
        <div className="p-3 border-t border-border space-y-1">
          {/* User info */}
          {user && (
            <div className="px-3 py-2 text-xs text-muted-foreground truncate">
              {user.name}
              {user?.role === "superadmin" && (
                <span className="ml-1.5 text-purple-500 font-medium">· Суперадмин</span>
              )}
              {user?.role === "admin" && (
                <span className="ml-1.5 text-primary font-medium">· Админ</span>
              )}
            </div>
          )}
          <button
            onClick={() => setDark(!dark)}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
            data-testid="toggle-theme"
          >
            {dark ? <Sun size={16} /> : <Moon size={16} />}
            <span>{dark ? "Светлая тема" : "Тёмная тема"}</span>
          </button>
          <button
            onClick={logout}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
            data-testid="btn-logout"
          >
            <LogOut size={16} />
            <span>Выйти</span>
          </button>
          <PerplexityAttribution />
        </div>
      </aside>

      {/* ── Main content ── */}
      <div className="flex-1 flex flex-col min-h-screen overflow-hidden">

        {/* Mobile top header */}
        <header className="md:hidden flex items-center justify-between px-4 py-3 border-b border-border bg-card shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-md bg-primary flex items-center justify-center">
              <ShoppingBag size={14} className="text-primary-foreground" />
            </div>
            <span className="font-semibold text-sm" translate="no">AI Автомат</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setDark(!dark)}
              className="p-2 rounded-lg text-muted-foreground hover:bg-secondary transition-colors"
              data-testid="toggle-theme-mobile"
            >
              {dark ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <button
              onClick={logout}
              className="p-2 rounded-lg text-muted-foreground hover:bg-secondary transition-colors"
              data-testid="btn-logout-mobile"
            >
              <LogOut size={18} />
            </button>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-auto">
          <div className="pb-20 md:pb-0">
            {children}
          </div>
        </main>

        {/* Mobile bottom tab bar */}
        <nav
          className="md:hidden fixed bottom-0 left-0 right-0 flex border-t border-border bg-card/95 backdrop-blur-sm z-50"
          style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
          data-testid="bottom-nav"
        >
          <TabItem href="/" icon={LayoutDashboard} label="Дашборд" />
          <TabItem href="/reviews" icon={MessageSquare} label="Отзывы" />
          <TabItem href="/questions" icon={HelpCircle} label="Вопросы" />
          <TabItem href="/settings" icon={SettingsIcon} label="Настройки" />
          {isAdmin && <TabItem href="/admin" icon={Shield} label="Пользов." />}
        </nav>
      </div>

    </div>
  );
}

// ── Auth guard ────────────────────────────────────────────────────────────────
function AppRoutes() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-muted-foreground text-sm">Загрузка...</div>
      </div>
    );
  }

  if (!user) {
    return <AuthPage />;
  }

  return (
    <WouterRouter hook={useHashLocation}>
      <Layout>
        <Switch>
          <Route path="/" component={Dashboard} />
          <Route path="/reviews" component={Reviews} />
          <Route path="/questions" component={Questions} />
          <Route path="/settings" component={Settings} />
          <Route path="/admin" component={AdminPanel} />
          <Route component={NotFound} />
        </Switch>
      </Layout>
    </WouterRouter>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <AppRoutes />
        <Toaster />
      </AuthProvider>
    </QueryClientProvider>
  );
}
