import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  CheckCircle2,
  XCircle,
  Clock,
  Trash2,
  Shield,
  User,
  ShieldOff,
  RefreshCw,
  AlertTriangle,
} from "lucide-react";
import type { UserPublic } from "@/lib/auth";

const statusLabel: Record<string, string> = {
  pending: "Ожидает",
  approved: "Одобрен",
  rejected: "Отклонён",
};

const statusClass: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
  approved: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  rejected: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
};

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString("ru", {
      day: "numeric", month: "short", year: "numeric",
    });
  } catch { return iso; }
}

export default function AdminPanel() {
  const { user: me } = useAuth();
  const { toast } = useToast();
  const [clearDialogOpen, setClearDialogOpen] = useState(false);

  const clearAllMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/reviews/clear-all"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/reviews"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/analytics"], exact: false });
      setClearDialogOpen(false);
      toast({ title: "Все данные удалены" });
    },
    onError: (e: Error) => toast({ title: "Ошибка", description: e.message, variant: "destructive" }),
  });

  const { data: users, isLoading } = useQuery<UserPublic[]>({
    queryKey: ["/api/admin/users"],
  });

  const patchMutation = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Record<string, string> }) =>
      apiRequest("PATCH", `/api/admin/users/${id}`, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      toast({ title: "Изменено" });
    },
    onError: (e: Error) => toast({ title: "Ошибка", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/users/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      toast({ title: "Пользователь удалён" });
    },
    onError: (e: Error) => toast({ title: "Ошибка", description: e.message, variant: "destructive" }),
  });

  const pending = users?.filter((u) => u.status === "pending") ?? [];
  const others = users?.filter((u) => u.status !== "pending") ?? [];

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto">
      <div className="mb-5">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <Shield size={20} className="text-primary" />
          Управление пользователями
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Одобряйте заявки на регистрацию и управляйте доступом
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full" />)}
        </div>
      ) : (
        <div className="space-y-5">

          {/* Pending requests */}
          {pending.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-2 flex items-center gap-2">
                <Clock size={14} />
                Ожидают одобрения ({pending.length})
              </h2>
              <div className="space-y-2">
                {pending.map((u) => (
                  <Card key={u.id} className="border-yellow-200 dark:border-yellow-800/50">
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div>
                          <p className="font-medium text-sm">{u.name}</p>
                          <p className="text-xs text-muted-foreground">{u.email}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            Зарегистрирован: {formatDate(u.createdAt)}
                          </p>
                        </div>
                        <div className="flex gap-2 flex-wrap">
                          <Button
                            size="sm"
                            className="h-8 text-xs bg-green-600 hover:bg-green-700 text-white"
                            onClick={() => patchMutation.mutate({ id: u.id, patch: { status: "approved" } })}
                            disabled={patchMutation.isPending}
                            data-testid={`btn-approve-${u.id}`}
                          >
                            <CheckCircle2 size={13} className="mr-1" />
                            Одобрить
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 text-xs text-destructive border-destructive/40 hover:bg-destructive/10"
                            onClick={() => patchMutation.mutate({ id: u.id, patch: { status: "rejected" } })}
                            disabled={patchMutation.isPending}
                            data-testid={`btn-reject-${u.id}`}
                          >
                            <XCircle size={13} className="mr-1" />
                            Отклонить
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {/* All other users */}
          <div>
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-2 flex items-center gap-2">
              <User size={14} />
              Все пользователи ({users?.length ?? 0})
            </h2>
            <div className="space-y-2">
              {others.map((u) => {
                const isMe = u.id === me?.id;
                return (
                  <Card key={u.id}>
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div className="flex items-start gap-3">
                          <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                            <span className="text-sm font-semibold text-primary">
                              {u.name[0]?.toUpperCase()}
                            </span>
                          </div>
                          <div>
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="font-medium text-sm">{u.name}</p>
                              {isMe && (
                                <span className="text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded font-medium">
                                  Вы
                                </span>
                              )}
                              {u.role === "admin" && (
                                <span className="text-xs bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 px-1.5 py-0.5 rounded font-medium flex items-center gap-0.5">
                                  <Shield size={10} /> Админ
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground">{u.email}</p>
                            <div className="flex items-center gap-2 mt-1 flex-wrap">
                              <Badge className={`text-xs ${statusClass[u.status]}`} variant="secondary">
                                {statusLabel[u.status] ?? u.status}
                              </Badge>
                              <span className="text-xs text-muted-foreground">
                                с {formatDate(u.createdAt)}
                              </span>
                            </div>
                          </div>
                        </div>

                        {!isMe && (
                          <div className="flex gap-1.5 flex-wrap">
                            {/* Toggle admin role */}
                            {u.role === "admin" ? (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-8 text-xs"
                                onClick={() => patchMutation.mutate({ id: u.id, patch: { role: "user" } })}
                                disabled={patchMutation.isPending}
                                title="Снять права админа"
                              >
                                <ShieldOff size={13} className="mr-1" />
                                Снять админа
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-8 text-xs"
                                onClick={() => patchMutation.mutate({ id: u.id, patch: { role: "admin" } })}
                                disabled={patchMutation.isPending}
                                title="Назначить администратором"
                              >
                                <Shield size={13} className="mr-1" />
                                Сделать админом
                              </Button>
                            )}
                            {/* Toggle status */}
                            {u.status === "approved" ? (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-8 text-xs text-destructive border-destructive/40 hover:bg-destructive/10"
                                onClick={() => patchMutation.mutate({ id: u.id, patch: { status: "rejected" } })}
                                disabled={patchMutation.isPending}
                              >
                                <XCircle size={13} className="mr-1" />
                                Заблокировать
                              </Button>
                            ) : u.status === "rejected" ? (
                              <Button
                                size="sm"
                                className="h-8 text-xs bg-green-600 hover:bg-green-700 text-white"
                                onClick={() => patchMutation.mutate({ id: u.id, patch: { status: "approved" } })}
                                disabled={patchMutation.isPending}
                              >
                                <CheckCircle2 size={13} className="mr-1" />
                                Разблокировать
                              </Button>
                            ) : null}
                            {/* Delete */}
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 text-xs text-destructive border-destructive/30 hover:bg-destructive/10"
                              onClick={() => {
                                if (confirm(`Удалить пользователя ${u.name}?`)) {
                                  deleteMutation.mutate(u.id);
                                }
                              }}
                              disabled={deleteMutation.isPending}
                              title="Удалить пользователя"
                            >
                              <Trash2 size={13} />
                            </Button>
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}

              {others.length === 0 && pending.length === 0 && (
                <div className="text-center py-10 text-muted-foreground text-sm">
                  Пользователей нет
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Danger zone ─────────────────────────────────────────────────── */}
      <div className="mt-6">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-2 flex items-center gap-2">
          <AlertTriangle size={14} className="text-destructive" />
          Опасная зона
        </h2>
        <Card className="border-destructive/30">
          <CardContent className="p-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <p className="text-sm font-medium">Очистить все данные</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Удалить все отзывы и ответы. Настройки и пользователи сохранятся.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setClearDialogOpen(true)}
                disabled={clearAllMutation.isPending}
                className="h-9 text-destructive border-destructive/30 hover:bg-destructive/5 hover:border-destructive/60 text-xs shrink-0"
                data-testid="btn-clear-all"
              >
                <Trash2 size={13} className="mr-1.5" />
                Очистить
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Clear confirmation dialog */}
      <Dialog open={clearDialogOpen} onOpenChange={setClearDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 size={18} /> Очистить все данные?
            </DialogTitle>
            <DialogDescription>
              Будут удалены все отзывы и ответы. Настройки и пользователи сохранятся.<br /><br />
              <strong>Действие нельзя отменить.</strong>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setClearDialogOpen(false)}>Отмена</Button>
            <Button
              variant="destructive"
              onClick={() => clearAllMutation.mutate()}
              disabled={clearAllMutation.isPending}
              data-testid="btn-confirm-clear-all"
            >
              {clearAllMutation.isPending
                ? <RefreshCw size={14} className="animate-spin mr-1.5" />
                : <Trash2 size={14} className="mr-1.5" />}
              Да, удалить всᄅ
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
