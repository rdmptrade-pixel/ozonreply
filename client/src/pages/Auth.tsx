import { useState } from "react";
import { useAuth } from "@/lib/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { ShoppingBag, Eye, EyeOff, Clock, ExternalLink } from "lucide-react";

type Mode = "login" | "register" | "success";

export default function AuthPage() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<Mode>("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    if (mode === "login") {
      const res = await login(email, password);
      if (!res.ok) setError(res.error ?? "Ошибка");
    } else {
      if (!name.trim()) { setError("Введите имя"); setLoading(false); return; }
      const res = await register(email, password, name);
      if (!res.ok) { setError(res.error ?? "Ошибка"); setLoading(false); return; }
      // Auto-login after successful registration
      const loginRes = await login(email, password);
      if (!loginRes.ok) setMode("success"); // fallback: show pending screen
    }
    setLoading(false);
  };

  // ── Success screen after registration ──────────────────────────────────────
  if (mode === "success") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-sm text-center">
          <CardContent className="pt-8 pb-8 space-y-4">
            <div className="w-14 h-14 rounded-full bg-yellow-100 dark:bg-yellow-900/30 flex items-center justify-center mx-auto">
              <Clock size={28} className="text-yellow-600 dark:text-yellow-400" />
            </div>
            <div>
              <h2 className="text-lg font-bold">Заявка отправлена</h2>
              <p className="text-sm text-muted-foreground mt-1.5">
                Ваш аккаунт ожидает одобрения администратора.
                После одобрения вы сможете войти.
              </p>
            </div>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => { setMode("login"); setEmail(""); setPassword(""); setName(""); }}
            >
              Вернуться ко входу
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Login / Register form ──────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4" translate="no">
      {/* Logo */}
      <div className="flex items-center gap-2.5 mb-6">
        <div className="w-10 h-10 rounded-xl bg-primary flex items-center justify-center">
          <ShoppingBag size={20} className="text-primary-foreground" />
        </div>
        <div>
          <div className="font-bold text-base leading-tight" translate="no">AI Автомат</div>
          <div className="text-xs text-muted-foreground leading-tight">Управление отзывами</div>
        </div>
      </div>



      <Card className="w-full max-w-sm">
        <CardHeader className="pb-4">
          <CardTitle className="text-lg">
            {mode === "login" ? "Вход в систему" : "Регистрация"}
          </CardTitle>
          <CardDescription className="text-xs">
            {mode === "login"
              ? "Введите email и пароль для входа"
              : "Создайте аккаунт для работы с сервисом"}
          </CardDescription>
        </CardHeader>

        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === "register" && (
              <div className="space-y-1.5">
                <Label className="text-sm">Имя</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Иван Иванов"
                  autoComplete="name"
                  data-testid="input-name"
                />
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="login-email" className="text-sm">Email</Label>
              <Input
                id="login-email"
                type="email"
                name="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                data-testid="input-email"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={mode === "login" ? "login-password" : "register-password"} className="text-sm">Пароль</Label>
              <div className="relative">
                <Input
                  id={mode === "login" ? "login-password" : "register-password"}
                  type={showPassword ? "text" : "password"}
                  name={mode === "login" ? "password" : "new-password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={mode === "register" ? "Минимум 6 символов" : "••••••••"}
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  className="pr-10"
                  data-testid="input-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>

            {error && (
              <p className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-lg">
                {error}
              </p>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={loading}
              data-testid="btn-auth-submit"
            >
              {loading
                ? "Загрузка..."
                : mode === "login"
                ? "Войти"
                : "Зарегистрироваться"}
            </Button>
          </form>

          <div className="mt-4 text-center">
            {mode === "login" ? (
              <p className="text-sm text-muted-foreground">
                Нет аккаунта?{" "}
                <button
                  onClick={() => { setMode("register"); setError(""); }}
                  className="text-primary hover:underline font-medium"
                  data-testid="btn-switch-register"
                >
                  Зарегистрироваться
                </button>
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Уже есть аккаунт?{" "}
                <button
                  onClick={() => { setMode("login"); setError(""); }}
                  className="text-primary hover:underline font-medium"
                  data-testid="btn-switch-login"
                >
                  Войти
                </button>
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
