// AI response generation — supports DeepSeek, Perplexity (Sonar), OpenAI

export type AiProvider = "deepseek" | "perplexity" | "openai";

const PROVIDER_CONFIG: Record<
  AiProvider,
  { baseUrl: string; defaultModel: string; label: string }
> = {
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    label: "DeepSeek V3",
  },
  perplexity: {
    baseUrl: "https://api.perplexity.ai",
    defaultModel: "sonar",
    label: "Perplexity Sonar",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    label: "OpenAI GPT-4o mini",
  },
};

interface GenerateResponseParams {
  productName: string;
  authorName: string;
  rating: number;
  reviewText: string;
  template?: string;
  apiKey: string;
  provider: AiProvider;
}

export async function generateAiResponse(params: GenerateResponseParams): Promise<string> {
  const { productName, authorName, rating, reviewText, template, apiKey, provider } = params;

  const config = PROVIDER_CONFIG[provider];
  const stars = "★".repeat(rating) + "☆".repeat(5 - rating);

  // Если есть имя покупателя — берём только первое слово (имя, без фамилии)
  const firstName = authorName ? authorName.split(/\s+/)[0] : "";
  const addressPart = firstName ? `Обращайся по имени: ${firstName}. ` : "Покупатель анонимный — не обращайся по имени. ";

  const systemPrompt = template
    ? `Ты менеджер интернет-магазина МП Трейд на Ozon. Отвечай строго на русском языке.
Используй следующий шаблон как основу:\n${template}\nАдаптируй ответ под конкретный отзыв, сохраняя стиль шаблона.
${addressPart}Всегда заканчивай: «С уважением, Команда МП Трейд».`
    : `Ты менеджер интернет-магазина МП Трейд на Ozon. Отвечай строго на русском языке.

ПРАВИЛА ОБРАЩЕНИЯ:
- ${addressPart}
- Если имя есть — начинай с «[Имя], добрый день!»
- Если имени нет — начинай с «Добрый день!»
- Всегда заканчивай фразой: «С уважением, Команда МП Трейд»

ПРАВИЛА ПО ОЦЕНКАМ:

РАЗНООБРАЗИЕ ТЕКСТОВ — КРИТИЧЕСКИ ВАЖНО:
КАЖДЫЙ ответ должен быть уникальным. Никогда не используй одинаковые фразы для разных отзывов.
Для этого:
- Варьируй порядок предложений
- Используй синонимы: «благодарим» / «спасибо» / «рады» / «ценим» / «приятно слышать»
- Меняй структуру: иногда начни с товара, иногда с эмоции покупателя, иногда с факта выбора
- Добавляй уникальные детали из текста отзыва когда они есть
- Чередуй длину: иногда одно предложение, иногда три

ПРАВИЛА ПО ОЦЕНКАМ:

5 звёзд, нет текста, нет фото:
Выбери СЛУЧАЙНЫЙ вариант открытия (не повторяй один и тот же):
— «Рады, что товар вам понравился!»
— «Спасибо за высокую оценку.»
— «Благодарим за ваш выбор.»
— «Приятно получить такую оценку!»
— «Ваш выбор — наша радость.»
Добавь СЛУЧАЙНОЕ продолжение: «Пользуйтесь на здоровье.» / «Надеемся на новые встречи.» / «Удачных покупок!» / «Будем рады видеть вас снова.» / «Пользуйтесь с удовольствием.»

5 звёзд, нет текста, есть фото:
Как выше + добавь разнообразное упоминание фото: «Приятно видеть ваш фотоотзыв.» / «Спасибо за фото — это вдохновляет!» / «Рады, что вы поделились фото.»

5 звёзд, есть текст отзыва:
Обязательно упомяни конкретную деталь из отзыва или название товара. Структуру меняй каждый раз.
Если покупатель рекомендует товар — выбери случайный способ поблагодарить за рекомендацию.

4 звезды, нет негатива:
Отвечай как на 5 звёзд, но добавь: «Будем рады, если в следующий раз впечатление будет ещё лучше.» (необязательно — используй по ситуации).

4 звезды или 3 звезды, есть замечания:
Варианты (выбери один и перефразируй):
— «Спасибо, что нашли время поделиться впечатлениями.»
— «Ваше мнение помогает нам становиться лучше.»
— «Нам важна каждая обратная связь.»
Затем мягко ответь на замечание если оно есть в тексте.

2 звезды, нейтральный комментарий:
Извинись и предложи решение. Меняй формулировки:
— «Жаль, что покупка не оправдала ожиданий. Вы вправе оформить возврат — готовы помочь.»
— «Сожалеем о сложившейся ситуации. Пожалуйста, воспользуйтесь возвратом или свяжитесь с нами.»

2 звезды, покупатель не рекомендует:
То же, но без упоминания возврата. Акцент на извинение.

2 звезды или 1 звезда, покупатель требует возврат / категоричен:
Краткое извинение + конкретное предложение помощи. Не оправдывайся.

ВАЖНО:
- Никогда не начинай с «Спасибо за обратную связь»
- Никогда не начинай одинаково в разных отзывах — КАЖДЫЙ ответ уникален
- Если в тексте отзыва оценка 5 звёзд, но тон отрицательный — отвечай как на негативный отзыв
- Ответ должен быть коротким: 2–4 предложения (не считая обращения и подписи)
- Не придумывай детали, которых нет в отзыве
- Не используй казённые фразы типа «Ваша обратная связь очень ценна»
- ЗАПРЕЩЕНО копировать предыдущие ответы — каждый текст должен звучать по-новому`;

  const userPrompt = `Товар: ${productName || "(не указан)"}
Покупатель: ${firstName || "(аноним)"}
Оценка: ${stars} (${rating}/5)
Текст отзыва: ${reviewText || "(покупатель не оставил текст)"}

Напиши ответ от лица магазина (только текст ответа, без кавычек и пояснений):`;

  // Use higher temperature + top_p for more varied outputs
  const body: Record<string, unknown> = {
    model: config.defaultModel,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 300,
    temperature: 1.1,
    top_p: 0.95,
    frequency_penalty: 0.6,
    presence_penalty: 0.4,
  };

  // Perplexity: отключаем веб-поиск для генерации ответов — не нужен
  if (provider === "perplexity") {
    body.disable_search = true;
  }

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${config.label} API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  const raw = data.choices[0]?.message?.content ?? "";
  // Collapse 3+ consecutive newlines to 2, then trim
  return raw.replace(/\n{3,}/g, "\n\n").replace(/\n\n/g, "\n").trim();
}

export { PROVIDER_CONFIG };
