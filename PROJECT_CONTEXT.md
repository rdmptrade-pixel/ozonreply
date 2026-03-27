# OzonReply — Контекст проекта для AI-сессий

## Что это

SaaS-сервис автоматических ответов на отзывы Ozon. Получает отзывы через API Ozon → генерирует ответы через AI (DeepSeek/OpenAI/Perplexity) → публикует обратно на Ozon. Имеет веб-панель управления и интеграцию с Google Sheets.

---

## Стек

| Слой | Технология |
|------|-----------|
| Backend | Node.js + Express 5 + TypeScript |
| Frontend | React 18 + TypeScript + Vite |
| UI | Radix UI + Tailwind CSS + shadcn/ui |
| БД | SQLite (локально) / PostgreSQL (прод, Drizzle ORM) |
| AI | DeepSeek (основной), OpenAI, Perplexity (настраивается) |
| Хостинг | Timeweb App Platform |
| Авторизация | Passport.js + express-session + JWT |
| Таблицы | Google Sheets API (exceljs) |

---

## Структура файлов

```
ozonreply/
├── server/
│   ├── index.ts          # Точка входа, Express сервер, порт 5000
│   ├── routes.ts         # ВСЕ API маршруты (52 КБ — главный файл логики)
│   ├── ai.ts             # Генерация ответов через AI (DeepSeek/OpenAI/Perplexity)
│   ├── ozon.ts           # Интеграция с API Ozon (получение отзывов, публикация)
│   ├── auth.ts           # Аутентификация пользователей
│   ├── sheets.ts         # Интеграция с Google Sheets
│   ├── storage.ts        # Абстракция хранилища (SQLite/PostgreSQL)
│   └── storage-pg.ts     # PostgreSQL реализация хранилища
│
├── client/src/
│   ├── App.tsx           # Роутинг (wouter)
│   ├── pages/
│   │   ├── Dashboard.tsx   # Главная панель (27 КБ)
│   │   ├── Reviews.tsx     # Список отзывов с ответами (18 КБ)
│   │   ├── Settings.tsx    # Настройки API ключей и параметров (17 КБ)
│   │   ├── AdminPanel.tsx  # Панель администратора (16 КБ)
│   │   └── Auth.tsx        # Страница входа/регистрации
│   └── lib/
│       ├── AuthContext.tsx  # Контекст авторизации
│       └── auth.ts         # Утилиты авторизации
│
├── shared/
│   └── schema.ts         # Схема БД: таблицы reviews, responses, типы Settings
│
├── Dockerfile            # Docker для деплоя
├── .env.example          # Шаблон переменных окружения
└── drizzle.config.ts     # Конфиг миграций БД
```

---

## Схема базы данных

**reviews** — отзывы с Ozon:
- `ozonReviewId` — уникальный ID отзыва на Ozon
- `productId`, `productName`, `ozonSku` — данные товара
- `authorName`, `rating`, `reviewText`, `reviewDate` — данные отзыва
- `status` — new | generating | pending_approval | approved | published | rejected
- `isAnswered`, `autoPublished` — флаги состояния

**responses** — сгенерированные ответы:
- `reviewId` — FK на reviews
- `responseText` — текст ответа (редактируемый)
- `originalAiText` — исходный текст от AI (для сравнения)
- `aiGenerated` — флаг AI-генерации
- `approvedAt`, `publishedAt` — временные метки

**Settings** (JSON файл):
- `ozonClientId`, `ozonApiKey` — доступ к API Ozon
- `aiProvider` + ключи — deepseek / openai / perplexity
- `googleSheetsId` — ID таблицы Google Sheets
- `responseTemplate` — шаблон для генерации ответов
- `autoPublish` — автопубликация без одобрения
- `syncInterval` — интервал синхронизации (минуты)

---

## Переменные окружения (.env)

```env
DATABASE_URL=postgresql://user:password@host:5432/dbname
DATABASE_SSL=false
OZON_CLIENT_ID=135416
OZON_API_KEY=...
AI_PROVIDER=deepseek
DEEPSEEK_API_KEY=...
JWT_SECRET=...
```

---

## Запуск

```bash
npm install
npm run dev          # разработка, порт 5000
npm run build        # сборка для прода
npm start            # запуск прода
npm run db:push      # применить миграции БД
```

---

## Ключевые API эндпоинты (из routes.ts)

- `POST /api/auth/login` — авторизация
- `GET /api/reviews` — список отзывов
- `POST /api/reviews/sync` — синхронизация с Ozon
- `POST /api/reviews/:id/generate` — генерация ответа AI
- `POST /api/reviews/:id/publish` — публикация ответа на Ozon
- `GET /api/settings` — получить настройки
- `PUT /api/settings` — сохранить настройки
- `GET /api/dashboard/stats` — статистика для дашборда
