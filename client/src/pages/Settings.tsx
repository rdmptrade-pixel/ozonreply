import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Eye, EyeOff, Save, ExternalLink, CheckCircle2, Plus, Zap } from "lucide-react";

interface Settings {
  id: number;
  ozonClientId: string;
  ozonApiKey: string;
  openaiApiKey: string;
  deepseekApiKey: string;
  perplexityApiKey: string;
  aiProvider: string;
  googleSheetsId: string;
  responseTemplate: string;
  questionTemplate: string;
  autoPublish: boolean;
  syncInterval: number;
}

function ApiKeyInput({
  label,
  value,
  onChange,
  placeholder,
  testId,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  testId?: string;
  hint?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="space-y-1.5">
      <Label className="text-sm">{label}</Label>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <div className="relative">
        <Input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="pr-10 font-mono text-xs"
          data-testid={testId}
        />
        <button
          type="button"
          onClick={() => setShow(!show)}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          {show ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
      {value && (
        <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
          <CheckCircle2 size={12} /> Ключ введён
        </p>
      )}
    </div>
  );
}

const PROVIDERS = [
  {
    id: "deepseek",
    name: "DeepSeek",
    model: "deepseek-chat (V3)",
    description: "Мощная модель, дешевле OpenAI. Рекомендуется.",
    docsUrl: "https://platform.deepseek.com/api_keys",
    docsLabel: "platform.deepseek.com",
    placeholder: "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  },
  {
    id: "perplexity",
    name: "Perplexity Sonar",
    model: "sonar",
    description: "Быстрая модель с доступом к интернету. Ключ от Perplexity API.",
    docsUrl: "https://www.perplexity.ai/settings/api",
    docsLabel: "perplexity.ai/settings/api",
    placeholder: "pplx-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  },
  {
    id: "openai",
    name: "OpenAI",
    model: "gpt-4o-mini",
    description: "GPT-4o mini — проверенное решение.",
    docsUrl: "https://platform.openai.com/api-keys",
    docsLabel: "platform.openai.com",
    placeholder: "sk-proj-...",
  },
];

export default function Settings() {
  const { toast } = useToast();
  const { data: saved, isLoading } = useQuery<Settings>({ queryKey: ["/api/settings"] });

  const [form, setForm] = useState<Omit<Settings, "id">>({
    ozonClientId: "",
    ozonApiKey: "",
    openaiApiKey: "",
    deepseekApiKey: "",
    perplexityApiKey: "",
    aiProvider: "deepseek",
    googleSheetsId: "",
    responseTemplate: "",
    questionTemplate: "",
    autoPublish: false,
    syncInterval: 30,
  });

  useEffect(() => {
    if (saved) {
      setForm({
        ozonClientId: saved.ozonClientId ?? "",
        ozonApiKey: saved.ozonApiKey ?? "",
        openaiApiKey: saved.openaiApiKey ?? "",
        deepseekApiKey: saved.deepseekApiKey ?? "",
        perplexityApiKey: saved.perplexityApiKey ?? "",
        aiProvider: saved.aiProvider ?? "deepseek",
        googleSheetsId: saved.googleSheetsId ?? "",
        responseTemplate: saved.responseTemplate ?? "",
        questionTemplate: saved.questionTemplate ?? "",
        autoPublish: saved.autoPublish ?? false,
        syncInterval: saved.syncInterval ?? 30,
      });
    }
  }, [saved]);

  const saveMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/settings", form),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({ title: "Настройки сохранены" });
    },
    onError: (e: Error) => toast({ title: "Ошибка", description: e.message, variant: "destructive" }),
  });

  const updateHeadersMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/sheets/update-headers"),
    onSuccess: () => toast({ title: "Структура таблицы обновлена", description: "Заголовки обновлены до актуальной схемы" }),
    onError: (e: Error) => toast({ title: "Ошибка обновления", description: e.message, variant: "destructive" }),
  });

  const createSheetMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/sheets/create"),
    onSuccess: async (data: any) => {
      const json = await data.json();
      if (json.spreadsheetId) {
        setForm((f) => ({ ...f, googleSheetsId: json.spreadsheetId }));
        queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
        toast({ title: "Таблица создана и сохранена!", description: "Откройте её по ссылке ниже" });
      }
    },
    onError: (e: Error) => toast({ title: "Ошибка создания таблицы", description: e.message, variant: "destructive" }),
  });

  const set = (key: keyof typeof form, value: string | boolean | number) => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  const sheetsUrl = form.googleSheetsId
    ? `https://docs.google.com/spreadsheets/d/${form.googleSheetsId}`
    : null;

  const activeProvider = PROVIDERS.find((p) => p.id === form.aiProvider) ?? PROVIDERS[0];
  const activeKeyField = form.aiProvider === "deepseek"
    ? "deepseekApiKey"
    : form.aiProvider === "perplexity"
    ? "perplexityApiKey"
    : "openaiApiKey";
  const activeKeyValue = form[activeKeyField as keyof typeof form] as string;

  return (
    <div className="p-4 md:p-6 max-w-2xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-bold">Настройки</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Настройте интеграции и параметры сервиса</p>
      </div>

      <div className="space-y-4">
        {/* Ozon API */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Ozon Seller API</CardTitle>
            <CardDescription className="text-xs">
              Личный кабинет Ozon → Настройки → API ключи
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-sm">Client-ID</Label>
              <Input
                value={form.ozonClientId}
                onChange={(e) => set("ozonClientId", e.target.value)}
                placeholder="Например: 123456"
                data-testid="input-ozon-client-id"
              />
            </div>
            <ApiKeyInput
              label="API Key"
              value={form.ozonApiKey}
              onChange={(v) => set("ozonApiKey", v)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              testId="input-ozon-api-key"
            />
          </CardContent>
        </Card>

        {/* AI Provider selection */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Zap size={16} className="text-primary" />
              Провайдер ИИ для генерации ответов
            </CardTitle>
            <CardDescription className="text-xs">
              Выберите сервис и введите API ключ
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <RadioGroup
              value={form.aiProvider}
              onValueChange={(v) => set("aiProvider", v)}
              className="space-y-2"
              data-testid="radio-ai-provider"
            >
              {PROVIDERS.map((p) => (
                <div
                  key={p.id}
                  className={`flex items-start gap-3 p-2.5 md:p-3 rounded-lg border transition-colors cursor-pointer ${
                    form.aiProvider === p.id
                      ? "border-primary bg-primary/5"
                      : "border-border hover:bg-muted/40"
                  }`}
                  onClick={() => set("aiProvider", p.id)}
                >
                  <RadioGroupItem value={p.id} id={`provider-${p.id}`} className="mt-0.5" />
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <label htmlFor={`provider-${p.id}`} className="text-sm font-medium cursor-pointer">
                        {p.name}
                      </label>
                      <span className="text-xs text-muted-foreground font-mono bg-muted px-1.5 py-0.5 rounded">
                        {p.model}
                      </span>
                      {p.id === "deepseek" && (
                        <span className="text-xs bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 px-1.5 py-0.5 rounded font-medium">
                          Рекомендуем
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">{p.description}</p>
                  </div>
                </div>
              ))}
            </RadioGroup>

            {/* Key input for active provider */}
            <div className="pt-1">
              <ApiKeyInput
                label={`${activeProvider.name} API Key`}
                value={activeKeyValue}
                onChange={(v) => set(activeKeyField as keyof typeof form, v)}
                placeholder={activeProvider.placeholder}
                testId="input-ai-api-key"
                hint={`Получите на ${activeProvider.docsLabel}`}
              />
              <a
                href={activeProvider.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary hover:underline flex items-center gap-1 mt-1.5"
              >
                <ExternalLink size={11} /> Открыть {activeProvider.docsLabel}
              </a>
            </div>
          </CardContent>
        </Card>

        {/* Google Sheets */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Google Таблица для утверждения</CardTitle>
            <CardDescription className="text-xs">
              Создайте таблицу автоматически или вставьте ID вручную из URL таблицы
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-sm">ID таблицы Google Sheets</Label>
              <Input
                value={form.googleSheetsId}
                onChange={(e) => set("googleSheetsId", e.target.value)}
                placeholder="1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms"
                data-testid="input-sheets-id"
              />
            </div>
            {!form.googleSheetsId && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => createSheetMutation.mutate()}
                disabled={createSheetMutation.isPending}
                data-testid="btn-create-sheet"
              >
                <Plus size={14} className="mr-1.5" />
                {createSheetMutation.isPending ? "Создаём..." : "Создать новую таблицу автоматически"}
              </Button>
            )}
            {sheetsUrl && (
              <div className="flex items-center gap-3 flex-wrap">
                <a
                  href={sheetsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-primary hover:underline flex items-center gap-1"
                >
                  <ExternalLink size={12} /> Открыть таблицу
                </a>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => updateHeadersMutation.mutate()}
                  disabled={updateHeadersMutation.isPending}
                  data-testid="btn-update-headers"
                >
                  {updateHeadersMutation.isPending ? "Обновляем..." : "Обновить структуру таблицы"}
                </Button>
              </div>
            )}
            <div className="p-3 rounded-lg bg-muted/50 text-xs text-muted-foreground space-y-1">
              <p className="font-medium text-foreground">Как утверждать ответы в таблице:</p>
              <p>1. «Экспорт в Таблицу» — отзывы и ответы появятся в таблице</p>
              <p>2. В колонке «Статус утверждения» напишите: <strong>утверждено</strong> или <strong>отклонено</strong></p>
              <p>3. «Синхронизировать с Таблицей» — статусы вернутся в сервис</p>
            </div>
          </CardContent>
        </Card>

        {/* AI Template */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Шаблон ответа ИИ</CardTitle>
            <CardDescription className="text-xs">
              Необязательно. Опишите стиль, тон или конкретные инструкции для ИИ.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Textarea
              value={form.responseTemplate}
              onChange={(e) => set("responseTemplate", e.target.value)}
              placeholder={`Например: Отвечай официально, упоминай название магазина «ТехноМаркет». При негативных отзывах предлагай замену или возврат. Контакт поддержки: support@technomarket.ru`}
              className="min-h-[100px] text-sm"
              data-testid="input-template"
            />
          </CardContent>
        </Card>

        {/* Q&A Template */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Настройки Q&amp;A</CardTitle>
            <CardDescription className="text-xs">
              Шаблон для ответов на вопросы покупателей. Если не задан — используется стандартный промт.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Textarea
              value={form.questionTemplate}
              onChange={(e) => set("questionTemplate", e.target.value)}
              placeholder={`Например: Отвечай официально и технически точно. Упоминай магазин «ТехноМаркет». Если вопрос о совместимости — уточни модель устройства покупателя.`}
              className="min-h-[100px] text-sm"
              data-testid="input-question-template"
            />
          </CardContent>
        </Card>

        {/* Auto-publish */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Публикация</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Авто-публикация после утверждения</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Утверждённые ответы автоматически публикуются на Ozon
                </p>
              </div>
              <Switch
                checked={form.autoPublish}
                onCheckedChange={(v) => set("autoPublish", v)}
                data-testid="switch-auto-publish"
              />
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Интервал синхронизации (мин)</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Как часто проверять таблицу на новые утверждения
                </p>
              </div>
              <Input
                type="number"
                min={5}
                max={1440}
                value={form.syncInterval}
                onChange={(e) => set("syncInterval", Number(e.target.value))}
                className="w-20 text-sm"
                data-testid="input-sync-interval"
              />
            </div>
          </CardContent>
        </Card>

        <Button
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending || isLoading}
          className="w-full"
          data-testid="btn-save-settings"
        >
          <Save size={14} className="mr-2" />
          {saveMutation.isPending ? "Сохраняем..." : "Сохранить настройки"}
        </Button>
      </div>
    </div>
  );
}
