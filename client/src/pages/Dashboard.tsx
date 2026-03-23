import { useState, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient, API_BASE } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import {
  RefreshCw,
  AlertTriangle,
  ExternalLink,
  Wallet,
  Star,
  CalendarDays,
  Download,
} from "lucide-react";

interface Stats {
  total: number;
  new: number;
  pendingApproval: number;
  approved: number;
  published: number;
  rejected: number;
  autoPublished: number;
}

interface AiBalance {
  available: boolean;
  balance: number | null;
  currency?: string;
  provider?: string;
  error?: string;
}

interface AnalyticsSeries {
  day: string;
  total: number;
  auto: number;
  manual: number;
  pending: number;
}

interface AnalyticsData {
  series: AnalyticsSeries[];
  ratingDist: Record<number, number>;
  from: string;
  to: string;
}

type Period = "day" | "week" | "month" | "custom";

const PERIOD_LABELS: Record<Period, string> = {
  day: "День",
  week: "Неделя",
  month: "Месяц",
  custom: "Период",
};

const STAR_COLORS: Record<number, string> = {
  1: "#ef4444",
  2: "#f97316",
  3: "#eab308",
  4: "#84cc16",
  5: "#22c55e",
};

function formatDay(day: string, period: Period): string {
  if (period === "day") return day; // already "HH:00"
  // day is "YYYY-MM-DD"
  const [, m, d] = day.split("-");
  return `${d}.${m}`;
}

// Custom tooltip for the chart
function ChartTooltip({ active, payload, label, period }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-card shadow-lg p-3 text-xs space-y-1 min-w-[140px]">
      <p className="font-semibold text-foreground mb-1.5">{label}</p>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.color }} />
            <span className="text-muted-foreground">{p.name}</span>
          </span>
          <span className="font-semibold tabular-nums">{p.value}</span>
        </div>
      ))}
    </div>
  );
}

export default function Dashboard() {
  const { toast } = useToast();
  const [premiumError, setPremiumError] = useState(false);
  const [fetchingOzon, setFetchingOzon] = useState(false);
  const [fetchProgress, setFetchProgress] = useState<{ fetched: number; new: number } | null>(null);
  const [fetchLimit, setFetchLimit] = useState<string>("1000");

  // Export state
  const [exportFrom, setExportFrom] = useState<string>(() => {
    const d = new Date();
    d.setDate(1); // first of current month
    return d.toISOString().slice(0, 10);
  });
  const [exportTo, setExportTo] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [exporting, setExporting] = useState(false);

  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const params = new URLSearchParams();
      if (exportFrom) params.set("from", exportFrom);
      if (exportTo) params.set("to", exportTo);
      const url = `${API_BASE}/api/export/excel?${params.toString()}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(await resp.text());
      const blob = await resp.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `ozonreply_${exportFrom}_${exportTo}.xlsx`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e: any) {
      toast({ title: "Ошибка экспорта", description: e?.message ?? String(e), variant: "destructive" });
    } finally {
      setExporting(false);
    }
  }, [exportFrom, exportTo, toast]);

  // Analytics state
  const [period, setPeriod] = useState<Period>("month");
  const [customFrom, setCustomFrom] = useState<string>(() => {
    const d = new Date();
    d.setDate(d.getDate() - 29);
    return d.toISOString().slice(0, 10);
  });
  const [customTo, setCustomTo] = useState<string>(() => new Date().toISOString().slice(0, 10));

  const { data: bgStatus } = useQuery<{ busy: boolean; tasks: number }>({
    queryKey: ["/api/background-status"],
    refetchInterval: 3000,
    staleTime: 0,
  });

  const isBackgroundBusy = bgStatus?.busy ?? false;

  const { data: stats, isLoading: statsLoading } = useQuery<Stats>({
    queryKey: ["/api/stats"],
    refetchInterval: isBackgroundBusy ? 3000 : 30000,
  });

  const { data: aiBalance, isLoading: balanceLoading } = useQuery<AiBalance>({
    queryKey: ["/api/ai/balance"],
    refetchInterval: 5 * 60 * 1000,
    staleTime: 60 * 1000,
  });

  // Build analytics query key based on period + custom dates
  // Pass browser timezone offset so backend groups by local time, not UTC
  const tzOffset = new Date().getTimezoneOffset(); // e.g. -180 for MSK (UTC+3)

  const analyticsQueryKey = period === "custom"
    ? ["/api/analytics", period, customFrom, customTo, tzOffset]
    : ["/api/analytics", period, tzOffset];

  const analyticsUrl = period === "custom"
    ? `/api/analytics?period=custom&from=${customFrom}&to=${customTo}&tzOffset=${tzOffset}`
    : `/api/analytics?period=${period}&tzOffset=${tzOffset}`;

  const { data: analytics, isLoading: analyticsLoading } = useQuery<AnalyticsData>({
    queryKey: analyticsQueryKey,
    queryFn: () => apiRequest("GET", analyticsUrl).then((r) => r.json()),
    staleTime: 60 * 1000,
  });

  const startFetchOzon = useCallback(async () => {
    if (fetchingOzon) return;
    setFetchingOzon(true);
    setFetchProgress({ fetched: 0, new: 0 });
    setPremiumError(false);

    try {
      const url = `${API_BASE}/api/reviews/fetch-from-ozon-stream`;
      const limitVal = fetchLimit === "0" ? 0 : parseInt(fetchLimit, 10);
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: limitVal }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: response.statusText }));
        if (err?.code === "PREMIUM_PLUS_REQUIRED") {
          setPremiumError(true);
        } else {
          toast({ title: "Ошибка загрузки", description: err?.error ?? response.statusText, variant: "destructive" });
        }
        setFetchingOzon(false);
        setFetchProgress(null);
        return;
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const data = JSON.parse(trimmed);
            if (data.type === "progress") {
              setFetchProgress({ fetched: data.fetched, new: data.new });
            } else if (data.type === "done") {
              queryClient.invalidateQueries({ queryKey: ["/api/reviews"], exact: false });
              queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
              queryClient.invalidateQueries({ queryKey: ["/api/analytics"], exact: false });
              const autoPub = (data.autoPublishPending as number) ?? 0;
              let msg = data.new > 0
                ? `Загружено ${(data.new as number).toLocaleString("ru")} новых отзывов`
                : "Новых отзывов нет — всё актуально";
              if (autoPub > 0) msg += ` · Автопубликация: ${autoPub}`;
              if (data.new > autoPub) msg += ` · Генерация ответов запущена`;
              toast({ title: msg });
            } else if (data.type === "error") {
              if (data.code === "PREMIUM_PLUS_REQUIRED") setPremiumError(true);
              else toast({ title: "Ошибка загрузки", description: data.error, variant: "destructive" });
            }
          } catch {}
        }
      }
    } catch (e: any) {
      toast({ title: "Ошибка соединения", description: e?.message ?? String(e), variant: "destructive" });
    } finally {
      setFetchingOzon(false);
      setFetchProgress(null);
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
        queryClient.invalidateQueries({ queryKey: ["/api/reviews"], exact: false });
        queryClient.invalidateQueries({ queryKey: ["/api/analytics"], exact: false });
      }, 3000);
    }
  }, [fetchingOzon, fetchLimit, toast]);

  const pending = (stats?.pendingApproval ?? 0) + (stats?.approved ?? 0);

  // Chart data — format day labels
  const chartData = (analytics?.series ?? []).map((s) => ({
    ...s,
    label: formatDay(s.day, period),
  }));

  const totalInPeriod = chartData.reduce((acc, s) => acc + s.total, 0);
  const autoInPeriod = chartData.reduce((acc, s) => acc + s.auto, 0);
  const manualInPeriod = chartData.reduce((acc, s) => acc + s.manual, 0);
  const pendingInPeriod = chartData.reduce((acc, s) => acc + s.pending, 0);

  const ratingDist = analytics?.ratingDist ?? {};
  const totalRated = Object.values(ratingDist).reduce((a, b) => a + b, 0);

  return (
    <div className="p-4 md:p-6 max-w-2xl mx-auto space-y-5">

      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Дашборд</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Управление отзывами на Ozon</p>
        </div>
        {/* AI Balance — inline in header */}
        <div className="flex items-center gap-1.5 shrink-0">
          <Wallet size={13} className="text-muted-foreground" />
          {balanceLoading ? (
            <span className="text-xs text-muted-foreground">—</span>
          ) : aiBalance?.balance !== null && aiBalance?.balance !== undefined ? (
            <span className={`font-semibold tabular-nums text-sm ${
              aiBalance.balance < 1 ? "text-destructive" :
              aiBalance.balance < 3 ? "text-yellow-600 dark:text-yellow-400" :
              "text-green-600 dark:text-green-400"
            }`}>
              ${aiBalance.balance.toFixed(2)}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </div>
      </div>

      {/* Premium error */}
      {premiumError && (
        <Alert variant="destructive">
          <AlertTriangle size={16} />
          <AlertTitle>Требуется подписка Premium Plus</AlertTitle>
          <AlertDescription className="mt-1 space-y-2 text-sm">
            <p>Загрузка отзывов через API доступна только по подписке Ozon Premium Plus.</p>
            <a
              href="https://seller.ozon.ru/app/subscriptions"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 underline font-medium"
            >
              Оформить Premium Plus <ExternalLink size={12} />
            </a>
            <Button variant="outline" size="sm" className="block mt-2" onClick={() => setPremiumError(false)}>
              Закрыть
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Fetch progress */}
      {fetchingOzon && fetchProgress && (
        <div className="p-4 rounded-xl border border-primary/20 bg-primary/5">
          <div className="flex items-center justify-between mb-2 text-sm">
            <span className="flex items-center gap-2 font-medium">
              <RefreshCw size={14} className="animate-spin text-primary" />
              Загрузка и генерация ответов...
            </span>
            <span className="text-muted-foreground">+{fetchProgress.new.toLocaleString("ru")} новых</span>
          </div>
          <Progress value={undefined} className="h-1" />
        </div>
      )}

      {/* Stats grid — 4 карточки в ряд */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[
          { label: "Всего", value: stats?.total ?? 0 },
          { label: "Ожидают", value: pending },
          { label: "Опубликованы", value: stats?.published ?? 0 },
          { label: "Автопубликация", value: stats?.autoPublished ?? 0 },
        ].map(({ label, value }) => (
          <Card key={label} className="border-border/60">
            <CardContent className="p-3 md:p-4">
              <p className="text-xs text-muted-foreground leading-tight mb-1.5">{label}</p>
              {statsLoading
                ? <Skeleton className="h-7 w-10" />
                : <p className="text-2xl font-bold leading-none">{value}</p>
              }
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Main action */}
      <div className="space-y-3">
        <div className="flex gap-2">
          <Button
            onClick={startFetchOzon}
            disabled={fetchingOzon || isBackgroundBusy}
            className="flex-1 h-11 text-sm font-medium"
            data-testid="btn-fetch-ozon"
          >
            <RefreshCw size={15} className={(fetchingOzon || isBackgroundBusy) ? "animate-spin mr-2" : "mr-2"} />
            {fetchingOzon ? "Загрузка..." : isBackgroundBusy ? "Генерация..." : "Загрузить с Ozon"}
          </Button>
          <Select value={fetchLimit} onValueChange={setFetchLimit} disabled={fetchingOzon || isBackgroundBusy}>
            <SelectTrigger className="h-11 w-24 sm:w-36 text-xs shrink-0" data-testid="select-fetch-limit">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="100">100</SelectItem>
              <SelectItem value="500">500</SelectItem>
              <SelectItem value="1000">1 000</SelectItem>
              <SelectItem value="2000">2 000</SelectItem>
              <SelectItem value="5000">5 000</SelectItem>
              <SelectItem value="0">Все</SelectItem>
            </SelectContent>
          </Select>
        </div>


      </div>

      {/* ── Excel Export ───────────────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-card/50 p-4">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-1.5">
          <Download size={12} />
          Экспорт в Excel
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={exportFrom}
            onChange={(e) => setExportFrom(e.target.value)}
            className="h-9 px-2 rounded-lg border border-border bg-background text-xs text-foreground flex-1 min-w-[130px]"
          />
          <span className="text-xs text-muted-foreground">—</span>
          <input
            type="date"
            value={exportTo}
            onChange={(e) => setExportTo(e.target.value)}
            className="h-9 px-2 rounded-lg border border-border bg-background text-xs text-foreground flex-1 min-w-[130px]"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={handleExport}
            disabled={exporting}
            className="h-9 text-xs shrink-0 gap-1.5"
            data-testid="btn-export-excel"
          >
            {exporting
              ? <RefreshCw size={13} className="animate-spin" />
              : <Download size={13} />}
            {exporting ? "Скачивается..." : "Скачать .xlsx"}
          </Button>
        </div>
      </div>

      {/* ── Analytics Chart ────────────────────────────────────────────────── */}
      <Card className="border-border/60">
        <CardHeader className="pb-3 pt-4 px-4">
          {/* Title row */}
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <CalendarDays size={14} className="text-muted-foreground" />
            Статистика отзывов
          </CardTitle>
          {/* Period selector — grid 4 cols, equal width, fits any screen */}
          <div className="grid grid-cols-4 gap-1 mt-2">
            {(["day", "week", "month", "custom"] as Period[]).map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`py-1.5 rounded-md text-xs font-medium transition-colors text-center ${
                  period === p
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                }`}
              >
                {PERIOD_LABELS[p]}
              </button>
            ))}
          </div>

          {/* Custom date inputs */}
          {period === "custom" && (
            <div className="flex items-center gap-2 mt-2">
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="h-8 px-2 rounded-md border border-border bg-background text-xs text-foreground w-36"
              />
              <span className="text-xs text-muted-foreground">—</span>
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="h-8 px-2 rounded-md border border-border bg-background text-xs text-foreground w-36"
              />
            </div>
          )}

          {/* Period summary counters */}
          {!analyticsLoading && (
            <div className="flex items-center gap-x-3 gap-y-1 flex-wrap mt-1 pt-3 border-t border-border/50 text-xs">
              <span><span className="text-muted-foreground">Новых: </span><span className="font-semibold tabular-nums">{totalInPeriod.toLocaleString("ru")}</span></span>
              <span><span className="text-muted-foreground">Авто: </span><span className="font-semibold tabular-nums text-blue-600 dark:text-blue-400">{autoInPeriod.toLocaleString("ru")}</span></span>
              <span><span className="text-muted-foreground">Вручную: </span><span className="font-semibold tabular-nums text-violet-600 dark:text-violet-400">{manualInPeriod.toLocaleString("ru")}</span></span>
              <span><span className="text-muted-foreground">Ожидают: </span><span className="font-semibold tabular-nums text-amber-600 dark:text-amber-400">{pendingInPeriod.toLocaleString("ru")}</span></span>
            </div>
          )}
        </CardHeader>

        <CardContent className="px-2 pb-4">
          {analyticsLoading ? (
            <Skeleton className="h-48 w-full rounded-lg" />
          ) : chartData.length === 0 || totalInPeriod === 0 ? (
            <div className="h-48 flex items-center justify-center text-sm text-muted-foreground">
              Нет данных за выбранный период
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={chartData} margin={{ top: 4, right: 8, left: -28, bottom: 0 }}>
                <defs>
                  <linearGradient id="gradTotal" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#94a3b8" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#94a3b8" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gradAuto" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gradManual" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gradPending" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" strokeOpacity={0.5} vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                  tickLine={false}
                  axisLine={false}
                  interval={period === "month" ? 4 : period === "week" ? 0 : 3}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                />
                <Tooltip content={<ChartTooltip period={period} />} />
                <Area
                  type="monotone"
                  dataKey="total"
                  name="Новые"
                  stroke="#94a3b8"
                  strokeWidth={1.5}
                  fill="url(#gradTotal)"
                  dot={false}
                  activeDot={{ r: 3 }}
                />
                <Area
                  type="monotone"
                  dataKey="auto"
                  name="Авто"
                  stroke="#3b82f6"
                  strokeWidth={1.5}
                  fill="url(#gradAuto)"
                  dot={false}
                  activeDot={{ r: 3 }}
                />
                <Area
                  type="monotone"
                  dataKey="manual"
                  name="Вручную"
                  stroke="#8b5cf6"
                  strokeWidth={1.5}
                  fill="url(#gradManual)"
                  dot={false}
                  activeDot={{ r: 3 }}
                />
                <Area
                  type="monotone"
                  dataKey="pending"
                  name="Ожидают"
                  stroke="#f59e0b"
                  strokeWidth={1.5}
                  fill="url(#gradPending)"
                  dot={false}
                  activeDot={{ r: 3 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}

          {/* Custom legend — always fits on one line */}
          {!analyticsLoading && totalInPeriod > 0 && (
            <div className="flex items-center justify-center gap-3 pt-2 text-xs text-muted-foreground flex-wrap">
              {[
                { color: "#94a3b8", label: "Новые" },
                { color: "#3b82f6", label: "Авто" },
                { color: "#8b5cf6", label: "Вручную" },
                { color: "#f59e0b", label: "Ожидают" },
              ].map(({ color, label }) => (
                <span key={label} className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                  {label}
                </span>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Rating distribution ────────────────────────────────────────────── */}
      {!analyticsLoading && totalRated > 0 && (
        <Card className="border-border/60">
          <CardContent className="p-4">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-1.5">
              <Star size={12} />
              Оценки за период
            </p>
            <div className="space-y-2">
              {[5, 4, 3, 2, 1].map((star) => {
                const count = ratingDist[star] ?? 0;
                const pct = totalRated > 0 ? Math.round((count / totalRated) * 100) : 0;
                return (
                  <div key={star} className="flex items-center gap-2">
                    <span className="text-xs tabular-nums w-4 text-right text-muted-foreground">{star}</span>
                    <Star size={10} className="shrink-0" style={{ color: STAR_COLORS[star], fill: STAR_COLORS[star] }} />
                    <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-500"
                        style={{ width: `${pct}%`, background: STAR_COLORS[star] }}
                      />
                    </div>
                    <span className="text-xs tabular-nums w-6 text-right font-semibold">{count}</span>
                    <span className="text-xs tabular-nums w-7 text-right text-muted-foreground">{pct}%</span>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* How it works */}
      <div className="rounded-xl border border-border bg-card/50 p-4">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Как работает</p>
        <div className="space-y-2">
          {[
            "Нажмите «Загрузить с Ozon» — отзывы скачаются и ответы сгенерируются автоматически",
            "Перейдите в «Отзывы», при необходимости отредактируйте ответ",
            "Нажмите «Опубликовать» — ответ уйдёт на Ozon и запишется в таблицу",
            "Отзывы 4–5★ без текста публикуются полностью автоматически",
          ].map((text, i) => (
            <div key={i} className="flex items-start gap-2.5 text-sm text-muted-foreground">
              <span className="w-5 h-5 rounded-full bg-primary/10 text-primary text-xs flex items-center justify-center shrink-0 font-semibold mt-0.5">
                {i + 1}
              </span>
              <span>{text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
