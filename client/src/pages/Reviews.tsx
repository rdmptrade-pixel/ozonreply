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
  Send,
  Camera,
  Edit3,
  Check,
  X,
  RefreshCw,
  ChevronUp,
} from "lucide-react";

interface ReviewWithResponse {
  id: number;
  ozonReviewId: string;
  productId: string;
  productName: string;
  authorName: string;
  rating: number;
  reviewText: string;
  reviewDate: string;
  hasPhotos: boolean;
  status: string;
  ozonSku?: string;
  ozonStatus?: string;  // UNPROCESSED | PROCESSED
  isAnswered?: boolean;
  response?: {
    id: number;
    responseText: string;
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

const RATING_OPTIONS = [
  { value: "all", label: "Все оценки" },
  { value: "1", label: "★☆☆☆☆ (1)" },
  { value: "2", label: "★★☆☆☆ (2)" },
  { value: "3", label: "★★★☆☆ (3)" },
  { value: "4", label: "★★★★☆ (4)" },
  { value: "5", label: "★★★★★ (5)" },
];

const statusLabel: Record<string, string> = {
  new: "Новый",
  generating: "Генерация...",
  pending_approval: "Ожидает",
  approved: "Ожидает",
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

function StarRating({ rating }: { rating: number }) {
  return (
    <span className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((s) => (
        <span key={s} className={`text-sm ${s <= rating ? "star-filled" : "star-empty"}`}>★</span>
      ))}
    </span>
  );
}

function ReviewCard({ review }: { review: ReviewWithResponse }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(review.response?.responseText ?? "");

  const generateMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/reviews/${review.id}/generate`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/reviews"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Ответ сгенерирован" });
    },
    onError: (e: Error) => toast({ title: "Ошибка генерации", description: e.message, variant: "destructive" }),
  });

  const approveMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/reviews/${review.id}/approve`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/reviews"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Ответ утверждён" });
    },
    onError: (e: Error) => toast({ title: "Ошибка", description: e.message, variant: "destructive" }),
  });

  const rejectMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/reviews/${review.id}/reject`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/reviews"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Отзыв отклонён" });
    },
    onError: (e: Error) => toast({ title: "Ошибка", description: e.message, variant: "destructive" }),
  });

  const publishMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/reviews/${review.id}/publish`);
      const data = await res.json();
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/reviews"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      if (data?.status === "published") {
        toast({ title: "Ответ опубликован на Ozon ✓" });
      } else {
        toast({ title: "Ответ опубликован" });
      }
    },
    onError: (e: Error) => {
      // Extract the actual Ozon error message
      const msg = e.message.replace(/^\d+:\s*/, "");
      let parsed: any = null;
      try { parsed = JSON.parse(msg); } catch {}
      const description = parsed?.error ?? parsed?.message ?? msg;
      console.error("Publish error:", description);
      toast({
        title: "Ошибка публикации на Ozon",
        description,
        variant: "destructive",
      });
    },
  });

  const saveEditMutation = useMutation({
    mutationFn: () =>
      apiRequest("PATCH", `/api/reviews/${review.id}/response`, { responseText: editText }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/reviews"], exact: false });
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
    <Card className="mb-3" data-testid={`review-card-${review.id}`}>
      <CardHeader className="pb-2 pt-3 px-3 md:pt-4 md:pb-3 md:px-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-sm">{review.productName}</span>
              {review.hasPhotos && (
                <span className="text-xs text-muted-foreground flex items-center gap-0.5">
                  <Camera size={12} /> фото
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 mt-1 flex-wrap">
              <StarRating rating={review.rating} />
              <span className="text-xs text-muted-foreground">{review.authorName || "Аноним"}</span>
              <span className="text-xs text-muted-foreground">{formatDate(review.reviewDate)}</span>
              {review.ozonSku && (
                <span className="text-xs text-muted-foreground font-mono">SKU: {review.ozonSku}</span>
              )}
              {review.ozonStatus && (
                <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                  review.ozonStatus === "PROCESSED"
                    ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                    : "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
                }`}>
                  {review.ozonStatus === "PROCESSED" ? "С ответом" : "Без ответа"}
                </span>
              )}
            </div>
          </div>
          <Badge className={`text-xs ${statusClass[review.status]}`} variant="secondary">
            {statusLabel[review.status] ?? review.status}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="px-3 pb-3 md:px-4 md:pb-4 space-y-3">
        {/* Review text */}
        {review.reviewText && (
          <div className="p-3 rounded-lg bg-muted/50 text-sm">
            <p className="text-xs font-medium text-muted-foreground mb-1">Отзыв покупателя</p>
            <p className="leading-relaxed">{review.reviewText}</p>
          </div>
        )}

        {/* Response */}
        {review.response && (
          <div className="p-3 rounded-lg bg-primary/5 border border-primary/20 text-sm">
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-xs font-medium text-primary flex items-center gap-1">
                <Sparkles size={12} />
                {review.response.aiGenerated ? "Ответ ИИ" : "Ответ вручную"}
              </p>
              {!editing && review.status === "pending_approval" && (
                <button
                  onClick={() => {
                    setEditText(review.response?.responseText ?? "");
                    setEditing(true);
                  }}
                  className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
                  data-testid={`btn-edit-${review.id}`}
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
                  data-testid={`textarea-response-${review.id}`}
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={() => saveEditMutation.mutate()}
                    disabled={saveEditMutation.isPending}
                    className="flex-1 h-8 text-xs"
                    data-testid={`btn-save-${review.id}`}
                  >
                    <Check size={12} className="mr-1" /> Сохранить
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditing(false)}
                    className="flex-1 h-8 text-xs"
                    data-testid={`btn-cancel-${review.id}`}
                  >
                    <X size={12} className="mr-1" /> Отмена
                  </Button>
                </div>
              </div>
            ) : (
              <p className="leading-relaxed">{review.response.responseText}</p>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-col gap-2 pt-1">
          {review.status === "new" && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => generateMutation.mutate()}
              disabled={generateMutation.isPending}
              className="w-full h-8 text-xs"
              data-testid={`btn-generate-${review.id}`}
            >
              <Sparkles size={12} className={generateMutation.isPending ? "animate-spin mr-1" : "mr-1"} />
              Сгенерировать ответ
            </Button>
          )}
          {review.status === "generating" && (
            <Button size="sm" variant="outline" disabled className="w-full h-8 text-xs">
              <RefreshCw size={12} className="animate-spin mr-1" />
              Генерация...
            </Button>
          )}
          {(review.status === "pending_approval" || review.status === "approved") && (
            <div className="flex gap-2 w-full">
              <Button
                size="sm"
                onClick={() => approveMutation.mutate()}
                disabled={approveMutation.isPending}
                className="flex-1 h-8 text-xs bg-green-600 hover:bg-green-700 text-white"
                data-testid={`btn-approve-${review.id}`}
              >
                {approveMutation.isPending && <RefreshCw size={12} className="animate-spin mr-1" />}
                Одобрить
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => generateMutation.mutate()}
                disabled={generateMutation.isPending}
                className="flex-1 h-8 text-xs overflow-hidden"
                data-testid={`btn-regenerate-${review.id}`}
              >
                {generateMutation.isPending && <RefreshCw size={12} className="animate-spin mr-1" />}
                Заново
              </Button>
            </div>
          )}
          {review.status === "published" && (
            <span className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
              <Check size={12} /> Опубликовано на Ozon
            </span>
          )}
          {review.status === "rejected" && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => generateMutation.mutate()}
              disabled={generateMutation.isPending}
              className="h-7 text-xs"
              data-testid={`btn-retry-${review.id}`}
            >
              <RefreshCw size={12} className="mr-1" /> Попробовать снова
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default function Reviews() {
  const [statusFilter, setStatusFilter] = useState("all");
  const [ratingFilter, setRatingFilter] = useState("all");
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

  const { data: reviews, isLoading, refetch } = useQuery<ReviewWithResponse[]>({
    queryKey: ["/api/reviews", statusFilter, ratingFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (ratingFilter !== "all") params.set("rating", ratingFilter);
      const qs = params.toString();
      const url = `${API_BASE}/api/reviews${qs ? "?" + qs : ""}`;
      const r = await fetch(url);
      return r.json();
    },
    staleTime: 10_000,
    refetchOnMount: true,
  });

  const [processing, setProcessing] = useState(false);

  const handleRefresh = async () => {
    setProcessing(true);
    try {
      // Kick off auto-publish for any stuck 'new' reviews (4-5★ no text)
      await apiRequest("POST", "/api/reviews/process-stuck");
      // Short delay so background queue registers before we re-poll stats
      await new Promise(r => setTimeout(r, 800));
    } catch {}
    await refetch();
    queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
    setProcessing(false);
  };

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Отзывы</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {reviews?.length ?? 0} {getCountLabel(reviews?.length ?? 0)}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={handleRefresh}
          disabled={isLoading || processing}
          className="h-8 text-xs shrink-0"
          data-testid="btn-refresh-reviews"
        >
          <RefreshCw size={13} className={(isLoading || processing) ? "animate-spin mr-1" : "mr-1"} />
          Обновить
        </Button>
      </div>

      {/* Filters */}
      <div className="grid grid-cols-2 gap-2 mb-4">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-9 text-xs" data-testid="filter-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={ratingFilter} onValueChange={setRatingFilter}>
          <SelectTrigger className="h-9 text-xs" data-testid="filter-rating">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RATING_OPTIONS.map((o) => (
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
      ) : reviews?.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-sm">Нет отзывов с выбранными фильтрами</p>
        </div>
      ) : (
        reviews?.map((r) => <ReviewCard key={r.id} review={r} />)
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
  if (n % 10 === 1 && n % 100 !== 11) return "отзыв";
  if ([2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)) return "отзыва";
  return "отзывов";
}
