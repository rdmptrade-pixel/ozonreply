# OzonReply — Инфраструктура

## Хостинг

- **Платформа:** Timeweb App Platform
- **Деплой:** автоматический при push в ветку `main` на GitHub
- **Репозиторий:** https://github.com/rdmptrade-pixel/ozonreply

## База данных

- **Прод:** PostgreSQL на Timeweb
- **Локально:** SQLite (файл `data/reviews.db`)
- **ORM:** Drizzle ORM
- **Миграции:** `npm run db:push`

## Timeweb API

- **Документация:** https://timeweb.cloud/api-docs
- **Применение:** настройка сервера, управление БД, переменные окружения
- **API ключ:** хранится у владельца (не коммитить в репо!)

## Переменные окружения на Timeweb (задаются в панели управления)

```
DATABASE_URL=postgresql://...
DATABASE_SSL=false
OZON_CLIENT_ID=135416
OZON_API_KEY=...
AI_PROVIDER=deepseek
DEEPSEEK_API_KEY=...
JWT_SECRET=...
```

## Подключённые коннекторы (Perplexity Computer)

| Сервис | Статус | Как использовать |
|--------|--------|-----------------|
| GitHub | CONNECTED | git push, работа с репозиторием через bash + api_credentials=["github"] |
| Timeweb | нет коннектора | через REST API с API ключом |

## Workflow деплоя

1. Внести изменения в код в workspace
2. `git add . && git commit -m "..." && git push origin main`
3. Timeweb автоматически подхватывает push и деплоит

## Команды для работы с репозиторием

```bash
# Клонировать в workspace (если нет)
git clone https://github.com/rdmptrade-pixel/ozonreply.git

# Пушить изменения
cd /home/user/workspace/ozonreply
git add . && git commit -m "описание" && git push origin main
```
