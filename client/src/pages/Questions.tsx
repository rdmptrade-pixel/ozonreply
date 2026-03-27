import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient, API_BASE } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sparkles,
  Edit3,
  Check,
  X,
  RefreshCw,
  ChevronUp,
  HelpCircle,
} from "lucide-react";

interface QuestionWithResponse {
  id: number;
  ozonQuestionId: string;
  productId: string;
  productName: string;
  ozonSku?: string;
  authorName: string;
  questionText: string;
  questionDate: string;
  status: string;
  isAnswered?: boolean;
  response?: {
    id: number;
    responseText: string;
    originalAiText: string;
    aiGenerated: boolean;
    approvedAt: string | null;
    publishedAt: string | null;
  };
}

const STATUS_OPTIONS = [
  { value: "all", label: "Все статусы" },
  { value: "new", label: "Новые" },
  { value: "generating", label: "Генерация" },
  { value: "pending_approval", label: "Ожидают утверждения" },
  { value: "approved", label: "Утверждены" },
  { value: "published", label: "Опубликованы" },
  { value: "rejected", label: "Отклонены" },
];

const statusLabel: Record<string, string> = {
  new: "Новый",
  generating: "Генерация...",
  pending_approval: "Ожидает",
  approved: "Утверждён",
  published: "Опубликован",
  rejected: "Отклонён",
};

const statusClass: Record<string, string> = {
  new: "status-new",
  generating: "status-generating",
  pending_approval: "status-pending",
  approved: "status-approved",
  published: "status-published",
  rejected: "status-rejected",
};

function QuestionCard({ question }: { question: QuestionWithResponse }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(question.response?.responseText ?? "");

  const generateMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/questions/${question.id}/generate`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/questions"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Ответ сгенерирован" });
    },
    onError: (e: Error) => toast({ title: "Ошибка генерации", description: e.message, variant: "destructive" }),
  });

  const approveMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/questions/${question.id}/approve`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/questions"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Ответ утверждён" });
    },
    onError: (e: Error) => toast({ title: "Ошибка", description: e.message, variant: "destructive" }),
  });

  const rejectMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/questions/${question.id}/reject`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/questions"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Вопрос отклонён" });
    },
    onError: (e: Error) => toast({ title: "Ошибка", description: e.message, variant: "destructive" }),
  });

  const publishMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/questions/${question.id}/publish`);
      const data = await res.json();
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/questions"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      if (data?.status === "published") {
        toast({ title: "Ответ опубликован на Ozon ✓" });
      } else {
        toast({ title: "Ответ опубликован" });
      }
    },
    onError: (e: Error) => {
      const msg = e.message.replace(/^\d+:\s*/, "");
      let parsed: any = null;
      try { parsed = JSON.parse(msg); } catch {}
      const description = parsed?.error ?? parsed?.message ?? msg;
      toast({ title: "Ошибка публикации на Ozon", description, variant: "destructive" });
    },
  });

  const saveEditMutation = useMutation({
    mutationFn: () =>
      apiRequest("PATCH", `/api/questions/${question.id}/response`, { responseText: editText }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/questions"], exact: false });
      setEditing(false);
      toast({ title: "Ответ сохранён" });
    },
    onError: (e: Error) => toast({ title: "Ошибка", description: e.message, variant: "destructive" }),
  });

  const formatDate = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleDateString("ru-RU", {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
    } catch {
      return dateStr;
    }
  };

  return (
    <Card className="mb-3" data-testid={`question-card-${question.id}`}>
      <CardHeader className="pb-2 pt-3 px-3 md:pt-4 md:pb-3 md:px-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <HelpCircle size={14} className="text-primary shrink-0" />
              <span className="font-semibold text-sm">{question.productName || "Товар"}</span>
            </div>
            <div className="flex items-center gap-3 mt-1 flex-wrap">
              <span className="text-xs text-muted-foreground">{question.authorName || "Покупатель"}</span>
              <span className="text-xs text-muted-foreground">{formatDate(question.questionDate)}</span>
              {question.ozonSku && (
                <span className="text-xs text-muted-foreground font-mono">SKU: {question.ozonSku}</span>
              )}
            </div>
          </div>
          <Badge className={`text-xs ${statusClass[question.status]}`} variant="secondary">
            {statusLabel[question.status] ?? question.status}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="px-3 pb-3 md:px-4 md:pb-4 space-y-3">
        {/* Question text */}
        <div className="p-3 rounded-lg bg-muted/50 text-sm">
          <p className="text-xs font-medium text-muted-foreground mb-1">Вопрос покупателя</p>
          <p className="leading-relaxed">{question.questionText}</p>
        </div>

        {/* Response */}
        {question.response && (
          <div className="p-3 rounded-lg bg-primary/5 border border-primary/20 text-sm">
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-xs font-medium text-primary flex items-center gap-1">
                <Sparkles size={12} />
                {question.response.aiGenerated ? "Ответ ИИ" : "Ответ вручную"}
              </p>
              {!editing && (question.status === "pending_approval" || question.status === "approved") && (
                <button
                  onClick={() => {
                    setEditText(question.response?.responseText ?? "");
                    setEditing(true);
                  }}
                  className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
                  data-testid={`btn-edit-q-${question.id}`}
                >
                  <Edit3 size={11} /> Редактировать
                </button>
              )}
            </div>
            {editing ? (
              <div className="space-y-2">
                <Textarea
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  className="min-h-[80px] text-sm"
                  data-testid={`textarea-q-response-${question.id}`}
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={() => saveEditMutation.mutate()}
                    disabled={saveEditMutation.isPending}
                    className="flex-1 h-8 text-xs"
                  >
                    <Check size={12} className="mr-1" /> Сохранить
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditing(false)}
                    className="flex-1 h-8 text-xs"
                  >
                    <X size={12} className="mr-1" /> Отмена
                  </Button>
                </div>
              </div>
            ) : (
              <p className="leading-relaxed">{question.response.responseText}</p>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-col gap-2 pt-1">
          {question.status === "new" && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => generateMutation.mutate()}
              disabled={generateMutation.isPending}
              className="w-full h-8 text-xs"
              data-testid={`btn-generate-q-${question.id}`}
            >
              <Sparkles size={12} className={generateMutation.isPending ? "animate-spin mr-1" : "mr-1"} />
              Сгенерировать ответ
            </Button>
          )}
          {question.status === "generating" && (
            <Button size="sm" variant="outline" disabled className="w-full h-8 text-xs">
              <RefreshCw size={12} className="animate-spin mr-1" />
              Генерация...
            </Button>
          )}
          {(question.status === "pending_approval" || question.status === "approved") && (
            <div className="flex gap-2 w-full">
              <Button
                size="sm"
                onClick={() => approveMutation.mutate()}
                disabled={approveMutation.isPending}
                className="flex-1 h-8 text-xs bg-green-600 hover:bg-green-700 text-white"
                data-testid={`btn-approve-q-${question.id}`}
              >
                {approveMutation.isPending && <RefreshCw size={12} className="animate-spin mr-1" />}
                Одобрить
              </Button>
              <Button
                size="sm"
                onClick={() => publishMutation.mutate()}
                disabled={publishMutation.isPending || !question.response}
                className="flex-1 h-8 text-xs"
                data-testid={`btn-publish-q-${question.id}`}
              >
                {publishMutation.isPending && <RefreshCw size={12} className="animate-spin mr-1" />}
                Опубликовать
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => generateMutation.mutate()}
                disabled={generateMutation.isPending}
                className="flex-1 h-8 text-xs"
                data-testid={`btn-regenerate-q-${question.id}`}
              >
                {generateMutation.isPending && <RefreshCw size={12} className="animate-spin mr-1" />}
                Заново
              </Button>
            </div>
          )}
          {question.status === "published" && (
            <span className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
              <Check size={12} /> Опубликовано на Ozon
            </span>
          )}
          {question.status === "rejected" && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => generateMutation.mutate()}
              disabled={generateMutation.isPending}
              className="h-7 text-xs"
              data-testid={`btn-retry-q-${question.id}`}
            >
              <RefreshCw size={12} className="mr-1" /> Попробовать снова
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default function Questions() {
  const [statusFilter, setStatusFilter] = useState("all");
  const [showScrollTop, setShowScrollTop] = useState(false);

  useEffect(() => {
    const el = document.querySelector("main") || window;
    const onScroll = () => setShowScrollTop((el instanceof Window ? el.scrollY : (el as Element).scrollTop) > 300);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const scrollToTop = () => {
    const el = document.querySelector("main");
    if (el) el.scrollTo({ top: 0, behavior: "smooth" });
    else window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const { data: questions, isLoading, refetch } = useQuery<QuestionWithResponse[]>({
    queryKey: ["/api/questions", statusFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      const qs = params.toString();
      const url = `${API_BASE}/api/questions${qs ? "?" + qs : ""}`;
      const r = await fetch(url);
      return r.json();
    },
    staleTime: 10_000,
    refetchOnMount: true,
  });

  const [syncing, setSyncing] = useState(false);
  const { toast } = useToast();

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await apiRequest("POST", "/api/questions/sync");
      const data = await res.json();
      toast({ title: `Синхронизация завершена: ${data.synced} новых вопросов` });
      await refetch();
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
    } catch (e: any) {
      toast({ title: "Ошибка синхронизации", description: e.message, variant: "destructive" });
    }
    setSyncing(false);
  };

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Вопросы</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {questions?.length ?? 0} {getCountLabel(questions?.length ?? 0)}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={handleSync}
          disabled={isLoading || syncing}
          className="h-8 text-xs shrink-0"
          data-testid="btn-sync-questions"
        >
          <RefreshCw size={13} className={(isLoading || syncing) ? "animate-spin mr-1" : "mr-1"} />
          Синхронизировать
        </Button>
      </div>

      {/* Filters */}
      <div className="mb-4">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-9 text-xs" data-testid="filter-q-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-40 w-full rounded-lg" />)}
        </div>
      ) : questions?.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <HelpCircle size={32} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">Нет вопросов с выбранными фильтрами</p>
          <p className="text-xs mt-1">Нажмите «Синхронизировать» чтобы загрузить вопросы из Ozon</p>
        </div>
      ) : (
        questions?.map((q) => <QuestionCard key={q.id} question={q} />)
      )}

      {/* Scroll to top button */}
      {showScrollTop && (
        <button
          onClick={scrollToTop}
          className="fixed bottom-20 right-4 md:bottom-6 md:right-6 z-50 w-10 h-10 rounded-full bg-primary text-primary-foreground shadow-lg flex items-center justify-center hover:bg-primary/90 transition-all"
          aria-label="Наверх"
        >
          <ChevronUp size={20} />
        </button>
      )}
    </div>
  );
}

function getCountLabel(n: number) {
  if (n % 10 === 1 && n % 100 !== 11) return "вопрос";
  if ([2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)) return "вопроса";
  return "вопросов";
}
