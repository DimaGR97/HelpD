console.log("STARTED FROM:", __filename, "AT", new Date().toISOString());
const express = require("express");
const qrcode = require("qrcode");
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const nodemailer = require("nodemailer");
const { exec } = require("child_process");
const { Client, LocalAuth } = require("whatsapp-web.js");


// Puppeteer rejects all pending CDP requests with TargetCloseError when the
// browser tab closes on WhatsApp logout. These are unhandled promises internal
// to whatsapp-web.js — catch them here so Node doesn't crash the process.
process.on("unhandledRejection", (reason) => {
    const name = reason?.constructor?.name ?? "";
    const msg = reason?.message ?? "";
    if (name === "TargetCloseError" || msg.includes("Target closed") || msg.includes("Protocol error")) {
        return;
    }
    console.error("Unhandled rejection:", reason);
});

// Корректное завершение при остановке сервиса (NSSM "stop"/"restart",
// Ctrl+C и т.п.). Без этого node.exe завершается мгновенно, а дочерний
// chrome.exe, запущенный puppeteer для WhatsApp, не получает команду
// закрыться и остаётся "осиротевшим" процессом — он продолжает держать
// открытые файловые хендлы (в частности лог-файл, куда NSSM пишет вывод
// сервиса), из-за чего следующий "nssm restart"/"nssm start" падает с
// ошибкой "The process cannot access the file because it is being used by
// another process." Явно закрываем клиент (а с ним и Chrome) перед выходом,
// чтобы такой процесс-сирота не оставался.
let shuttingDown = false;
async function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`>>> Получен сигнал ${signal}, закрываю WhatsApp-клиент...`);

    try {
        if (client) {
            await client.destroy();
        }
    } catch (error) {
        console.error("Ошибка при закрытии клиента при остановке:", error.message);
    }

    process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// --------------------------------------------------
// App
// --------------------------------------------------
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --------------------------------------------------
// Files
// --------------------------------------------------
const USERS_FILE = path.join(__dirname, "users.json");
const CONVERSATIONS_FILE = path.join(__dirname, "conversations.json");
const TICKETS_FILE = path.join(__dirname, "tickets.json");
const SETTINGS_FILE = path.join(__dirname, "settings.json");
const EXCLUDED_USERS_FILE = path.join(__dirname, "excluded-users.json");
const COMPANY_GROUPS_FILE = path.join(__dirname, "company-groups.json");

// Категории, которые нельзя добавлять, редактировать или удалять через админку —
// 11 и 12 зашиты в логику бота (чат со специалистом / отмена заявки),
// 0 зарезервирован под команду выхода из диалога.
const RESERVED_CATEGORY_KEYS = new Set(["0", "11", "12", "13"]);

// --------------------------------------------------
// Defaults
// --------------------------------------------------
const DEFAULT_SETTINGS = {
    ticketToEmail: process.env.TICKET_TO_EMAIL || "",
    fallbackFromEmail: process.env.SMTP_FROM || process.env.SMTP_USER || "support@example.com",
    smtpHost: process.env.SMTP_HOST || "",
    smtpPort: process.env.SMTP_PORT || "587",
    smtpUser: process.env.SMTP_USER || "",
    smtpPass: process.env.SMTP_PASS || "",
    smtpSecure: String(process.env.SMTP_SECURE || "false").toLowerCase() === "true",
    telegramResetBotUsername: process.env.TELEGRAM_RESET_BOT_USERNAME || "",
    // Домены, которые считаются "настоящей" рабочей почтой (не вымышленной).
    // Совпадение проверяется и по поддоменам (например, mail.almaly.kz тоже
    // засчитается как almaly.kz). Редактируется в /admin/settings.
    trustedEmailDomains: ["almaly.kz"],

    // Если оператор отправляет пользователю ровно эту фразу через сам
    // WhatsApp Business (например, через быстрый ответ /end) — последняя
    // незакрытая заявка этого номера автоматически помечается закрытой.
    // Работает без админ-панели, срабатывает на реальное исходящее
    // сообщение с привязанного номера. Редактируется в /admin/settings.
    closeTicketTriggerText: process.env.CLOSE_TICKET_TRIGGER_TEXT
        || "Спасибо за ваше обращение в службу IT, всегда рады помочь",

    // Текст письма, которое уходит в ticketToEmail в момент срабатывания
    // closeTicketTriggerText — уведомляет osTicket, что обращение уже
    // отработано оператором прямо в WhatsApp, и заявку можно закрыть.
    // См. sendOperatorClosedNotificationEmail. Редактируется в /admin/settings.
    closeTicketNotificationEmailText: process.env.CLOSE_TICKET_NOTIFICATION_TEXT
        || "Данное обращение отработано через WhatsApp BOT. Можно закрыть заявку.",

    // Через сколько часов бездействия (ни пользователь, ни оператор ничего
    // не писали) диалог в режиме "Чат со специалистом" автоматически
    // закрывается — см. closeStaleSpecialistChats. Без этого пользователь,
    // однажды попавший в этот режим, мог остаться в нём навсегда: следующее
    // обращение просто повторно уходило в handleSpecialistMode вместо того,
    // чтобы начать новую заявку. 0 или пустая строка — отключает автозакрытие.
    // Редактируется в /admin/settings.
    specialistChatTimeoutHours: Number(process.env.SPECIALIST_CHAT_TIMEOUT_HOURS || 24),

    // Сколько минут после закрытия заявки бот "молчит" в ответ на обычные
    // сообщения этого номера (например "спасибо", "ок") — чтобы такой ответ
    // не запускал новую заявку/регистрацию сразу после закрытия предыдущей.
    // Действует только пока нет активного диалога (см. getRecentlyClosedTicket
    // и место вызова в обработчике сообщений). Явные команды начать заново
    // ("новая заявка", "меню", "старт") этот период игнорируют.
    // 0 или пустая строка — отключает период тишины полностью.
    // Редактируется в /admin/settings.
    ticketClosedSilenceMinutes: Number(process.env.TICKET_CLOSED_SILENCE_MINUTES || 3),

    // Если оператор отправляет пользователю ровно эту фразу напрямую через
    // WhatsApp Business (например, через быстрый ответ "/Список исключений") —
    // номер автоматически добавляется в исключения (бот перестаёт отвечать
    // этому номеру), независимо от того, зарегистрирован пользователь в
    // системе или нет — совпадение идёт по реальному message.to, а не по
    // вручную введённому номеру. Редактируется в /admin/settings.
    excludeUserTriggerText: process.env.EXCLUDE_USER_TRIGGER_TEXT
        || "В нашем с вами чате отключен бот по регистрации обращений. Открыт чат со специалистом.",

    // Обратная фраза — быстрый ответ (например "/Активировать бота в чате"),
    // который убирает номер из исключений и снова включает бота для этого
    // номера. Редактируется в /admin/settings.
    includeUserTriggerText: process.env.INCLUDE_USER_TRIGGER_TEXT
        || "Бот по регистрации обращений снова активирован в этом чате.",

    texts: {
        startNewUser: "Для обработки заявки отправьте ваши данные.\nФИО на русском:",
        askFullNameEn: "ФИ на английском:",
        askPosition: "Должность:",
        askCompany: "Компания:",
        askEmail: "Электронная почта:",
        askPhone: "Номер телефона:",
        askProblem: "Опишите проблему:",
        invalidEmail: "Введите корректный email.",
        invalidPhone: "Введите номер телефона в формате +7XXXXXXXXXX или 8XXXXXXXXXX (10 цифр после кода).",
        invalidChoice: "Нужно отправить число от 1 до 13.",
        exitInfo: "Чтобы выйти из чата, отправьте: 0 или выход",
        cancelInfo: "Чтобы отменить заявку и начать заново, отправьте: 12",
        specialistIntro: "Вы перешли в чат со специалистом. Опишите ваш вопрос.",
        specialistInfo: "Чтобы выйти из чата со специалистом, отправьте: 0 или выход",
        ticketSuccess: "✅ Заявка успешно создана\nНаш специалист свяжется с вами в ближайшее время.",
        ticketMailFail: "Заявка создана, но письмо на почту не отправилось. Возможно указан неверный Email адрес. Если все же верно - ожидайте ответа от специалиста. Хотите проверить или исправить данные анкеты?\nОшибка: {{error}}",
        registeredProblemIntro: "Здравствуйте, {{name}} 👋\nСначала опишите проблему:",
        categoryMenuIntro: "Выберите категорию заявки:",
        categoryMenuFooter: "Отправьте число от 1 до 13.",
        category1SubIntro: "Выберите действие:\n\n1 - 🔑 Сброс пароля учетной записи (переход в Telegram-бот)\n2 - 📝 Оставить заявку на доступ к другим сервисам\n\n0 - Назад к выбору категории",
        telegramResetInfo: "Для сброса пароля перейдите в Telegram-бот:\n{{link}}\n\nЕсли после сброса пароля потребуется помощь — напишите нам снова.",
        telegramResetMissing: "Telegram-бот для сброса пароля пока не настроен. Обратитесь к администратору.",
        category1SubInvalid: "Выберите 1, 2 или 0."
    },

    categories: {
        "1": "🔑 Учетные записи / Доступы, пароли",
    "2": "📧 Почта Outlook",
    "3": "🖨️ Принтер(печать) / периферия",
    "4": "💻 Компьютер / ноутбук",
    "5": "🌐 Интернет / VPN",
    "6": "📊 1С и финансовые системы",
    "7": "📞 Телефония",
    "8": "📹 Переговорные / видеосвязь",
    "9": "➕➖ Новый сотрудник / Увольнение",
    "10": "💬 Консультация / другое",
    "11": "👨‍💻 Чат со специалистом",
    "12": "❌ Отмена заявки",
    "13": "📋 Посмотреть статус заявок"
}
};

// --------------------------------------------------
// Helpers
// --------------------------------------------------
function openBrowser(url) {
    const command = process.platform === "win32"
        ? `start "" "${url}"`
        : process.platform === "darwin"
            ? `open "${url}"`
            : `xdg-open "${url}"`;

    exec(command);
}

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function formatDate(value) {
    if (!value) return "-";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "-";
    return d.toLocaleString("ru-RU");
}

// Готовит WhatsApp id для показа в админке. Обычные контакты — id вида
// "<цифры>@c.us" — это и есть номер телефона, просто оформляем с "+".
// WhatsApp иногда подставляет вместо номера "LID" (id вида "<цифры>@lid") —
// это внутренний идентификатор WhatsApp, а НЕ номер телефона: цифры там
// никак не расшифровываются в номер. Раньше в админке такие id просто
// печатались как есть и выглядели как обычный (просто очень длинный) номер —
// это вводило в заблуждение. Теперь явно помечаем такие записи, чтобы не
// путать администратора, плюс кнопка на странице исключений пытается
// узнать настоящий номер через WhatsApp API (получится не всегда — для
// части LID-контактов сам WhatsApp намеренно скрывает номер).
function formatWhatsAppIdForDisplay(id) {
    const raw = String(id || "").trim();
    if (!raw) return { display: "-", isLid: false, user: "" };

    const at = raw.indexOf("@");
    if (at === -1) return { display: raw, isLid: false, user: raw };

    const user = raw.slice(0, at);
    const domain = raw.slice(at + 1);

    if (domain === "c.us" && /^\d+$/.test(user)) {
        return { display: `+${user}`, isLid: false, user };
    }

    if (domain === "lid") {
        return { display: `LID ${user}`, isLid: true, user };
    }

    if (domain === "g.us") {
        return { display: `Группа ${user}`, isLid: false, user };
    }

    return { display: raw, isLid: false, user };
}

function applyTemplate(text, vars = {}) {
    let result = String(text ?? "");
    for (const [key, value] of Object.entries(vars)) {
        result = result.replaceAll(`{{${key}}}`, String(value ?? ""));
    }
    return result;
}

function readJson(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2), "utf-8");
            return fallback;
        }
        const raw = fs.readFileSync(filePath, "utf-8");
        if (!raw.trim()) return fallback;
        return JSON.parse(raw);
    } catch (error) {
        console.error(`Ошибка чтения ${filePath}:`, error.message);
        return fallback;
    }
}

function writeJson(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (error) {
        console.error(`Ошибка записи ${filePath}:`, error.message);
    }
}

function isValidEmail(email) {
    const value = String(email || "").trim();
    return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(value);
}

// Раньше здесь была проверка через DNS MX-запись домена — оказалась
// ненадёжной: у настоящего корпоративного домена (almaly.kz) публичной
// MX-записи может не быть (внутренняя почта), поэтому она ошибочно
// считалась "несуществующей". Вместо DNS используем список доверенных
// доменов, который админ ведёт сам в /admin/settings — надёжно и не зависит
// от внешней сети.
function getTrustedEmailDomains() {
    return (settings.trustedEmailDomains || [])
        .map(d => String(d || "").trim().toLowerCase())
        .filter(Boolean);
}

function isTrustedEmailDomain(email) {
    const value = String(email || "").trim().toLowerCase();
    const at = value.indexOf("@");
    if (at === -1) return false;

    const domain = value.slice(at + 1).trim();
    if (!domain) return false;

    return getTrustedEmailDomains().some(
        trusted => domain === trusted || domain.endsWith(`.${trusted}`)
    );
}

function isValidPhone(phone) {
    const raw = String(phone || "").trim();
    // Убираем пробелы/скобки/дефисы, оставляя только "+" и цифры.
    const cleaned = raw.replace(/[^\d+]/g, "");
    // Разрешены только +7XXXXXXXXXX или 8XXXXXXXXXX — ровно 10 цифр
    // номера после кода (итого 11 цифр), как у мобильного РФ/РК.
    return /^(\+7\d{10}|8\d{10})$/.test(cleaned);
}

function normalizePhone(phone) {
    const raw = String(phone || "").trim();
    const cleaned = raw.replace(/[^\d+]/g, "");

    if (/^8\d{10}$/.test(cleaned)) {
        return `+7${cleaned.slice(1)}`;
    }

    if (/^\+7\d{10}$/.test(cleaned)) {
        return cleaned;
    }

    const digits = cleaned.replace(/\D/g, "");
    if (!digits) return raw;
    return cleaned.startsWith("+") ? cleaned : digits;
}

// Приводит номер к формату WhatsApp ID (например "79991234567@c.us"),
// в котором хранятся ключи users/conversations и message.from.
// Это нужно, чтобы номер, введённый вручную в форме исключений,
// совпадал с реальным идентификатором отправителя сообщения.
function normalizeWhatsAppId(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (raw.includes("@")) return raw;

    // Приводим номер к тому же единому формату, что и normalizePhone()
    // (7XXXXXXXXXX без "+"), чтобы номер, добавленный вручную в
    // исключения ДО регистрации пользователя (например, введённый как
    // 87051234567 или +77051234567), гарантированно совпадал со
    // строкой message.from реального входящего сообщения WhatsApp —
    // иначе исключение молча не срабатывало из-за разницы "8" vs "7".
    const cleaned = raw.replace(/[^\d+]/g, "");

    let digits;
    if (/^8\d{10}$/.test(cleaned)) {
        digits = `7${cleaned.slice(1)}`;
    } else if (/^\+7\d{10}$/.test(cleaned)) {
        digits = cleaned.slice(1);
    } else if (/^7\d{10}$/.test(cleaned)) {
        digits = cleaned;
    } else {
        digits = cleaned.replace(/\D/g, "");
    }

    return digits ? `${digits}@c.us` : "";
}

function isExitCommand(text) {
    const value = String(text || "").trim().toLowerCase();
    return value === "0" || value === "выход" || value === "exit" || value === "quit";
}

function isCancelCommand(text) {
    const value = String(text || "").trim().toLowerCase();
    return value === "12" || value === "отмена" || value === "cancel" || value === "restart";
}

function isMyTicketsCommand(text) {
    const value = String(text || "").trim().toLowerCase();
    return value === "заявки" || value === "мои заявки" || value === "статус" || value === "мои статусы";
}

// Позволяет пользователю на любом шаге первичной регистрации (до "Опишите
// проблему") явно попросить оператора/специалиста, не дожидаясь окончания
// анкеты. См. escapeRegistrationToSpecialist — прерывает регистрацию,
// сохраняя уже введённые поля как черновик, и переводит в чат со специалистом.
function isSpecialistEscapeCommand(text) {
    const value = String(text || "").trim().toLowerCase();
    return ["оператор", "специалист", "человек", "поддержка"].includes(value);
}

// Явная просьба начать заново — работает даже во время "периода тишины"
// после закрытия заявки (см. getRecentlyClosedTicket), чтобы пользователь
// не был вынужден ждать таймаут, если ему прямо сейчас нужна новая заявка.
function isForceNewRequestCommand(text) {
    const value = String(text || "").trim().toLowerCase();
    return ["новая заявка", "новое обращение", "меню", "старт"].includes(value);
}

function getStatusLabel(status) {
    const labels = {
        new: "🆕 Новая",
        in_progress: "🔧 В работе",
        closed: "✅ Завершена",
        specialist_chat: "💬 Чат со специалистом"
    };
    return labels[status] || status || "-";
}

function firstWords(text, count) {
    const words = String(text || "").trim().split(/\s+/).filter(Boolean);
    if (!words.length) return "";
    if (words.length <= count) return words.join(" ");
    return `${words.slice(0, count).join(" ")}…`;
}

function mergeSettings(loaded) {
    const source = loaded && typeof loaded === "object" ? loaded : {};
    return {
        ...DEFAULT_SETTINGS,
        ...source,
        texts: {
            ...DEFAULT_SETTINGS.texts,
            ...(source.texts || {})
        },
        categories: {
            ...DEFAULT_SETTINGS.categories,
            ...(source.categories || {})
        }
    };
}

// initialProblem — то самое первое сообщение, с которого начался диалог.
// Часто клиент сразу пишет суть проблемы ("Здравствуйте, у меня перестала
// работать..."), а не просто здоровается — раньше этот текст никак не
// сохранялся (бот в ответ просто спрашивал "ФИО на русском:"). Теперь он
// становится черновиком data.problem: если пользователь дойдёт до штатного
// шага "Опишите проблему" — ответ там его перезапишет как обычно; а если
// регистрация прервётся раньше (см. createInterruptedRegistrationTicket/
// handleSpecialistMode) — описание проблемы всё равно не потеряется.
function createEmptyState(initialProblem = "") {
    return {
        step: "fullNameRu",
        mode: "ticket",
        data: initialProblem ? { problem: initialProblem } : {}
    };
}

function createProblemState(savedUser = {}) {
    return {
        step: "problem",
        mode: "ticket",
        data: { ...savedUser },
        // registeredProblemIntro уже поздоровался с пользователем по имени —
        // getCategoryMenu не должен здороваться повторно, см. case "problem".
        greetedForProblem: true
    };
}

function createSpecialistState(savedUser = {}) {
    return {
        step: "specialistChat",
        mode: "specialist",
        data: { ...savedUser }
    };
}

// Обновляет метку времени последней активности в чате со специалистом —
// используется фоновой задачей closeStaleSpecialistChats, чтобы понять,
// что диалог "завис" и его пора автоматически закрыть (см. ниже). Вызывается
// каждый раз, когда диалог переходит в шаг "specialistChat" и каждый раз,
// когда пользователь пишет что-то, находясь в этом шаге.
function touchSpecialistChatActivity(userState) {
    userState.specialistChatLastActivityAt = new Date().toISOString();
}

// Поля анкеты, обязательные для "полной" регистрации. Позволяет отличить
// полностью заполненного пользователя (можно сразу переходить к "Опишите
// проблему") от черновика анкеты, прерванного досрочным переходом в чат со
// специалистом (см. escapeRegistrationToSpecialist) — для такого пользователя
// анкету нужно донести, а не считать её пройденной.
const REQUIRED_REGISTRATION_FIELDS = ["fullNameRu", "fullNameEn", "position", "company", "email", "phone"];

function isRegistrationComplete(phone) {
    const user = users[phone];
    if (!user) return false;
    return REQUIRED_REGISTRATION_FIELDS.every(field => Boolean(user[field]));
}

// Возвращает последнюю закрытую заявку этого номера, если она закрылась
// не раньше settings.ticketClosedSilenceMinutes назад — иначе null. Пока
// заявка "свежезакрыта", бот не должен реагировать на обычные сообщения
// вроде "спасибо"/"ок" запуском новой заявки/регистрации (см. место вызова
// в обработчике сообщений, шаг перед "if (!userState)"). Действует
// одинаково для любого закрытия — и через /admin, и через закрывающую
// фразу оператора.
function getRecentlyClosedTicket(phone) {
    const silenceMinutes = Number(settings.ticketClosedSilenceMinutes) || 0;
    if (!silenceMinutes) return null;

    const ticket = tickets
        .slice()
        .reverse()
        .find(t => t.phone === phone && t.status === "closed" && t.closedAt);

    if (!ticket) return null;

    const closedAt = new Date(ticket.closedAt).getTime();
    if (!closedAt || Number.isNaN(closedAt)) return null;

    const withinWindow = Date.now() - closedAt < silenceMinutes * 60 * 1000;
    return withinWindow ? ticket : null;
}

// --------------------------------------------------
// Группы компаний — сопоставление по ключевым словам/маске
// --------------------------------------------------

// Возвращает id первой группы, чьё ключевое слово встречается
// (регистронезависимо, как подстрока) в тексте поля "Компания".
// Порядок групп в company-groups.json определяет приоритет при
// пересечении правил разных групп.
function matchCompanyGroupId(company) {
    const text = String(company || "").trim().toLowerCase();
    if (!text) return null;

    for (const group of companyGroups) {
        const keywords = Array.isArray(group.keywords) ? group.keywords : [];
        const matched = keywords.some(rawKeyword => {
            const keyword = String(rawKeyword || "").trim().toLowerCase();
            return keyword && text.includes(keyword);
        });

        if (matched) return group.id;
    }

    return null;
}

function getCompanyGroupLabel(groupId) {
    if (!groupId) return "Без группы";
    const group = companyGroups.find(g => g.id === groupId);
    return group ? group.name : "Без группы";
}

// Проставляет/пересчитывает группу пользователя по текущему полю "Компания".
// Вызывается при регистрации и при любом изменении анкеты (в т.ч. из админки).
function assignCompanyGroup(userRecord) {
    if (!userRecord) return userRecord;
    userRecord.companyGroupId = matchCompanyGroupId(userRecord.company);
    return userRecord;
}

// Пересчитывает группу для ВСЕХ пользователей — вызывается после
// добавления/изменения/удаления группы, т.к. правила сопоставления изменились.
function recomputeAllCompanyGroups() {
    for (const phone of Object.keys(users)) {
        assignCompanyGroup(users[phone]);
    }
    saveUsers();
}

function buildTicketFromState(phone, state, category, mode = "ticket") {
    return {
        id: Date.now(),
        createdAt: new Date().toISOString(),
        phone,
        fullNameRu: state.data.fullNameRu || "",
        fullNameEn: state.data.fullNameEn || "",
        position: state.data.position || "",
        company: state.data.company || "",
        email: state.data.email || "",
        phoneNumber: state.data.phone || "",
        problem: state.data.problem || "",
        // Результат MX-проверки почты на шаге askEmail — влияет только
        // на то, кто будет "отправителем" письма в osTicket и что
        // напишется в поле "Режим" (см. sendTicketEmail).
        // Проверяем домен здесь и сейчас, по актуальному email — а не по
        // флагу из состояния диалога: для уже зарегистрированных
        // пользователей шаг ввода email не повторяется, и этот флаг
        // просто никогда не проставлялся, из-за чего Режим всегда был
        // "ticketBot", даже для доверенных доменов.
        emailValidated: isTrustedEmailDomain(state.data.email || users[phone]?.email || ""),
        // AnyDesk не спрашивается у пользователя в WhatsApp — админ вносит его
        // вручную в карточке пользователя, а сюда он просто подтягивается.
        anyDesk: users[phone]?.anyDesk || "",
        category,
        mode,
        status: mode === "specialist" ? "specialist_chat" : "new",
        notes: []
    };
}

// Единая точка создания и отправки заявки — используется и обычным потоком
// выбора категории, и подменю "Доступы/пароли" (категория 1), чтобы не
// дублировать логику отправки письма и обработку ошибок в двух местах.
async function finalizeTicketCreation(phone, userState, category) {
    userState.data.category = category;

    const ticket = buildTicketFromState(phone, userState, category, "ticket");
    tickets.push(ticket);
    saveTickets();

    users[phone] = {
        ...(users[phone] || {}),
        fullNameRu: userState.data.fullNameRu,
        fullNameEn: userState.data.fullNameEn,
        position: userState.data.position,
        company: userState.data.company,
        email: userState.data.email,
        phone: userState.data.phone
    };
    assignCompanyGroup(users[phone]);
    saveUsers();

    try {
        await sendValidationEmail(userState.data.email);
    } catch (error) {
        console.error("[EMAIL VALIDATION]", userState.data.email, error.message);
    }

    await sendBotMessage(phone, "⏳ Отправляю заявку, подождите...");

    try {
        console.log("========== MAIL DEBUG ==========");
        console.log("ticketToEmail:", settings.ticketToEmail);
        console.log("smtpHost:", settings.smtpHost);
        console.log("smtpPort:", settings.smtpPort);
        console.log("user email:", userState.data.email);
        console.log("================================");

        const mailResult = await sendTicketEmailWithFallback(ticket);
        if (mailResult?.messageId) {
            ticket.emailMessageId = mailResult.messageId;
            saveTickets();
        }
    } catch (error) {
        userState.step = "mailFailMenu";
        conversations.set(phone, userState);
        saveConversations();

        await sendBotMessage(
            phone,
`⚠️ Заявка создана, но письмо на почту не отправилось.

Возможно указан неверный Email адрес.
Если Email указан верно — ожидайте ответа специалиста.

Что необходимо сделать?

1 - Проверить данные анкеты
2 - Изменить Email
0 - Завершить

Техническая ошибка:
${error.message}`
        );

        return false;
    }

    await sendBotMessage(phone, settings.texts.ticketSuccess);

    // Раньше здесь стоял conversations.delete(phone) — из-за этого ЛЮБОЕ
    // следующее сообщение пользователя (даже "Спасибо") воспринималось как
    // начало новой заявки (бот видел зарегистрированного пользователя и
    // сразу слал "Сначала опишите проблему"). Вместо удаления переводим
    // диалог в cancelMenu — то же меню, что показывается при отмене
    // заявки — так что дальнейший ответ пользователя не запустит новый
    // цикл сам по себе, а покажет явный выбор действия.
    userState.step = "cancelMenu";
    conversations.set(phone, userState);
    saveConversations();

    await sendBotMessage(
        phone,
`Что хотите сделать дальше?

1 - Создать новую заявку
2 - Проверить данные анкеты
3 - Чат со специалистом
4 - Мои заявки
0 - Выход`
    );

    return true;
}

// fullNameEn передаётся только когда пользователя ещё не приветствовали в
// этом обращении (см. флаг greetedForProblem) — иначе меню категорий
// дублировало "Здравствуйте" сразу после registeredProblemIntro, который
// уже поздоровался с пользователем перед вопросом "Опишите проблему".
function getCategoryMenu(fullNameEn = "") {
    const namePart = fullNameEn ? `, ${fullNameEn}` : "";
    const greeting = fullNameEn ? [`Здравствуйте${namePart} 👋`] : [];

    const mainCategories = [];
    const serviceCategories = [];

    Object.entries(settings.categories || {})
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .forEach(([key, val]) => {

            if (key === "11" || key === "12" || key === "13") {
                serviceCategories.push(`${key}. ${val}`);
            } else {
                mainCategories.push(`${key}. ${val}`);
            }

        });

    return [
        ...greeting,
        settings.texts.categoryMenuIntro,

        ...mainCategories,
        "",
        "━━━━━━━━━━━━━━",

        ...serviceCategories,

        "",
        "Для перехода в чат со специалистом выберите 11",
        "Для отмены заявки выберите 12",
        "Для просмотра статуса заявок выберите 13",

        "",
        settings.texts.categoryMenuFooter,
        settings.texts.exitInfo,
        settings.texts.cancelInfo
    ].join("\n");
}

function getCategoryByChoice(choice) {
    return settings.categories[String(choice).trim()] || null;
}

// --------------------------------------------------
// Data
// --------------------------------------------------
let settings = mergeSettings(readJson(SETTINGS_FILE, {}));
let users = readJson(USERS_FILE, {});
let conversations = new Map(Object.entries(readJson(CONVERSATIONS_FILE, {})));
let tickets = readJson(TICKETS_FILE, []);
let excludedUsers = readJson(EXCLUDED_USERS_FILE, []);
let companyGroups = readJson(COMPANY_GROUPS_FILE, []);

function saveSettings() {
    writeJson(SETTINGS_FILE, settings);
}
function saveUsers() {
    writeJson(USERS_FILE, users);
}
function saveConversations() {
    writeJson(CONVERSATIONS_FILE, Object.fromEntries(conversations));
}
function saveTickets() {
    writeJson(TICKETS_FILE, tickets);
}
function saveExcludedUsers() {
    writeJson(EXCLUDED_USERS_FILE, excludedUsers);
}
function saveCompanyGroups() {
    writeJson(COMPANY_GROUPS_FILE, companyGroups);
}

// --------------------------------------------------
// SMTP
// --------------------------------------------------
let transporter = nodemailer.createTransport({
    host: settings.smtpHost || process.env.SMTP_HOST,
    port: Number(settings.smtpPort || process.env.SMTP_PORT || 587),
    secure: settings.smtpSecure !== undefined
        ? settings.smtpSecure
        : (String(process.env.SMTP_SECURE || "false").toLowerCase() === "true"),
    requireTLS: false,
    logger: false,
    debug: false
});

function updateTransporter() {
    transporter = nodemailer.createTransport({
        host: settings.smtpHost || process.env.SMTP_HOST,
        port: Number(settings.smtpPort || process.env.SMTP_PORT || 587),
        secure: settings.smtpSecure !== undefined
            ? settings.smtpSecure
            : (String(process.env.SMTP_SECURE || "false").toLowerCase() === "true"),
        requireTLS: false,
        logger: false,
        debug: false
    });
}

async function sendTicketEmail(ticket, fromEmail) {
    const toEmail = settings.ticketToEmail || process.env.TICKET_TO_EMAIL;
    if (!toEmail) {
        throw new Error("Не задан recipient: ticketToEmail или TICKET_TO_EMAIL");
    }

    const mailFrom = fromEmail || settings.fallbackFromEmail || process.env.SMTP_FROM || process.env.SMTP_USER || "support@example.com";

    // Показывает в письме, ушло ли оно реально от имени почты клиента (её
    // видно и в osTicket как "Создано") или пришлось откатиться на общий
    // ящик WPPService — см. sendTicketEmailWithFallback.
    const sentAsUser = Boolean(
        ticket.email && mailFrom.trim().toLowerCase() === String(ticket.email).trim().toLowerCase()
    );

    const info = await transporter.sendMail({
        from: mailFrom,
        replyTo: ticket.email || mailFrom,
        to: toEmail,
        subject: ticket.category,
        html: `
            <h2>Новая заявка</h2>
            <p><b>Категория:</b> ${escapeHtml(ticket.category)}</p>
            <p><b>Проблема:</b> ${escapeHtml(ticket.problem)}</p>
            <p>&nbsp;</p>
            <p><b>ФИО:</b> ${escapeHtml(ticket.fullNameRu)}</p>
            <p><b>Full Name:</b> ${escapeHtml(ticket.fullNameEn)}</p>
            <p><b>Должность:</b> ${escapeHtml(ticket.position)}</p>
            <p><b>Компания:</b> ${escapeHtml(ticket.company)}</p>
            <p><b>Email:</b> ${escapeHtml(ticket.email)}</p>
            <p><b>Телефон:</b> ${escapeHtml(ticket.phoneNumber)}</p>
            <p><b>AnyDesk:</b> ${escapeHtml(ticket.anyDesk || "")}</p>
            <p><b>Дата:</b> ${escapeHtml(formatDate(ticket.createdAt))}</p>
            <p><b>Режим:</b> ${sentAsUser ? "wppservice" : "ticketBot"}</p>
        `
    });

    // messageId возвращается наружу (см. sendTicketEmailWithFallback) и
    // сохраняется в ticket.emailMessageId — используется, чтобы письмо о
    // закрытии заявки через WhatsApp Business (см.
    // sendOperatorClosedNotificationEmail) можно было подшить в ту же ветку
    // переписки через заголовки In-Reply-To/References.
    return info;
}

async function sendTicketEmailWithFallback(ticket) {
    const fallbackEmail = settings.fallbackFromEmail || process.env.SMTP_FROM || process.env.SMTP_USER || "support@example.com";

    // Заявка всегда должна выглядеть как пришедшая от самого пользователя
    // (в osTicket поле "Создано" берётся из From) — иначе непонятно, кто
    // реально писал, хотя email введён в анкете. Раньше здесь ещё
    // требовалось, чтобы домен почты был в trustedEmailDomains — но этот
    // список содержит только свои внутренние домены (almaly.kz, aatd.kz),
    // из-за чего реальная рабочая почта клиента из другой компании
    // (например, kazdc.kz) отбраковывалась, и письмо всегда уходило от
    // WPPService. Единственное, что действительно нужно проверить здесь —
    // что адрес синтаксически корректен (isValidEmail), иначе почтовый
    // сервер его просто не примет как From. Если отправка от имени клиента
    // всё же не пройдёт (сервер отклонит "чужой" домен) — ниже есть
    // автоматический повторный запрос от fallbackEmail.
    const validUserEmail = ticket.email && isValidEmail(ticket.email)
        ? ticket.email
        : null;

    const attempts = [];
    if (validUserEmail) attempts.push(validUserEmail);
    if (fallbackEmail && fallbackEmail !== validUserEmail) attempts.push(fallbackEmail);

    let lastError = null;
    for (const fromEmail of attempts) {
        try {
            const info = await sendTicketEmail(ticket, fromEmail);
            return { sent: true, fromEmail, messageId: info?.messageId };
        } catch (error) {
            console.error(`Ошибка отправки через ${fromEmail}:`, error.message);
            lastError = error;
        }
    }

    throw lastError || new Error("Не удалось отправить письмо через доступные адреса");
}

// Уведомляет ту же переписку в osTicket, что обращение уже отработано
// оператором прямо в WhatsApp (через быстрый ответ /end, см.
// closeTicketTriggerText) — чтобы сотрудник поддержки увидел это в тикете и
// закрыл его и на стороне osTicket. Письмо уходит на тот же адрес
// (ticketToEmail); если известен Message-ID исходного письма по этой заявке
// (ticket.emailMessageId, см. sendTicketEmail), добавляем In-Reply-To /
// References — это помогает почтовой системе подшить письмо в ту же ветку,
// если её механизм переписки это поддерживает. Если Message-ID неизвестен
// (например, письмо по заявке не отправлялось или не удалось), письмо всё
// равно уходит — просто без гарантии, что оно попадёт в тот же тред.
async function sendOperatorClosedNotificationEmail(ticket) {
    const toEmail = settings.ticketToEmail || process.env.TICKET_TO_EMAIL;
    if (!toEmail) return;

    const fromEmail = settings.fallbackFromEmail || process.env.SMTP_FROM || process.env.SMTP_USER || "support@example.com";

    const mailOptions = {
        from: fromEmail,
        to: toEmail,
        subject: `Re: ${ticket.category || "Заявка"} (№${getTicketSeqNumber(ticket.id)})`,
        html: `
            <p>${escapeHtml(settings.closeTicketNotificationEmailText)}</p>
            <p>&nbsp;</p>
            <p><b>Заявка №:</b> ${escapeHtml(getTicketSeqNumber(ticket.id))}</p>
            <p><b>Категория:</b> ${escapeHtml(ticket.category || "")}</p>
            <p><b>Телефон:</b> ${escapeHtml(ticket.phoneNumber || ticket.phone || "")}</p>
        `
    };

    if (ticket.emailMessageId) {
        mailOptions.inReplyTo = ticket.emailMessageId;
        mailOptions.references = ticket.emailMessageId;
    }

    await transporter.sendMail(mailOptions);
}

// Проблему клиент может описать в разных местах диалога: сразу первым
// сообщением (см. createEmptyState), на штатном шаге "Опишите проблему"
// (data.problem) и/или уже в чате со специалистом. Склеиваем то, что
// реально известно, не теряя ни один источник и не дублируя одинаковый
// текст (например, если "Опишите проблему" так и не переспрашивали, и
// data.problem — это то же самое первое сообщение).
function combineProblemText(...parts) {
    const seen = new Set();
    const unique = [];

    for (const part of parts) {
        const trimmed = String(part || "").trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        unique.push(trimmed);
    }

    return unique.join("\n\n");
}

// Вызывается ровно один раз — в момент, когда оператор вмешался в
// переписку (написал клиенту напрямую), пока клиент ещё не закончил
// регистрацию/заявку (см. INCOMPLETE_TICKET_STEPS в client.on("message_create")).
// Раз уж диалог теперь останавливается и бот замолкает, обращение не
// должно потеряться для osTicket — фиксируем то, что успели узнать, как
// отдельную заявку категории "Другое" с описанием проблемы (если клиент
// успел его написать) или пояснением, что регистрация была прервана.
// ticket.interruptedRegistration=true — пометка для closeTicketByOperatorPhrase:
// такие заявки не считаются "обработанными через бот" по закрывающей фразе
// оператора (см. пояснение там же), т.к. по факту с клиентом с нуля
// разбирался человек, а не бот.
async function createInterruptedRegistrationTicket(phone, state) {
    const ticket = buildTicketFromState(phone, state, "Другое", "ticket");
    ticket.problem = combineProblemText(state.data.problem)
        || "Клиент не успел описать проблему — регистрация прервана вмешательством оператора.";
    ticket.interruptedRegistration = true;

    tickets.push(ticket);
    saveTickets();

    try {
        const mailResult = await sendTicketEmailWithFallback(ticket);
        if (mailResult?.messageId) {
            ticket.emailMessageId = mailResult.messageId;
            saveTickets();
        }
    } catch (error) {
        console.error("Ошибка фиксации прерванной регистрации в osTicket:", error.message);
    }

    return ticket;
}

async function sendValidationEmail(email) {

    await transporter.sendMail({
        from: settings.fallbackFromEmail,
        to: email,
        subject: "Проверка адреса электронной почты",
        html: `
            <p>Ваш адрес электронной почты зарегистрирован в системе Service Desk.</p>
            <p>Если вы получили это письмо, никаких действий выполнять не нужно.</p>
        `
    });

}
// --------------------------------------------------
// WhatsApp
// --------------------------------------------------
let qrImage = null;
let isReady = false;
let botStatus = "connecting"; // connecting | qr | ready | disconnected | auth_failure
let restartingClient = false;
let client = null;


async function resetConversationToStart(phone, savedUser = null) {
    conversations.delete(phone);
    saveConversations();

    if (savedUser && isRegistrationComplete(phone)) {
        const state = createProblemState(savedUser);
        conversations.set(phone, state);
        saveConversations();

        await sendBotMessage(
            phone,
            applyTemplate(settings.texts.registeredProblemIntro, {
                name: savedUser.fullNameEn || ""
            })
        );
        return;
    }

    // Анкета есть, но не все обязательные поля заполнены (диалог был прерван
    // досрочным переходом в чат со специалистом, см.
    // escapeRegistrationToSpecialist) — донабираем недостающие поля, а не
    // спрашиваем анкету с нуля.
    if (savedUser) {
        await resumeIncompleteRegistration(phone);
        return;
    }

    conversations.set(phone, createEmptyState());
    saveConversations();

    await sendBotMessage(phone, settings.texts.startNewUser);
}

// Продолжает анкету с первого незаполненного поля черновика (users[phone]),
// а не с начала. Используется после выхода из чата со специалистом, если
// регистрация была прервана досрочно (escapeRegistrationToSpecialist), и
// везде, где resetConversationToStart вызывается для "недорегистрированного"
// пользователя.
async function resumeIncompleteRegistration(phone) {
    const draft = users[phone] || {};

    const order = [
        ["fullNameRu", settings.texts.startNewUser],
        ["fullNameEn", settings.texts.askFullNameEn],
        ["position", settings.texts.askPosition],
        ["company", settings.texts.askCompany],
        ["email", settings.texts.askEmail],
        ["phone", settings.texts.askPhone]
    ];

    const missing = order.find(([field]) => !draft[field]);

    const state = {
        step: missing ? missing[0] : "problem",
        mode: "ticket",
        data: { ...draft }
    };

    conversations.set(phone, state);
    saveConversations();

    const prompt = missing ? missing[1] : settings.texts.askProblem;

    await sendBotMessage(
        phone,
        `Продолжим регистрацию, которую вы не закончили ранее.\n\n${prompt}`
    );
}

// Прерывает первичную регистрацию (шаги fullNameRu…phone, до "Опишите
// проблему") и переводит диалог в чат со специалистом — либо по явной
// просьбе пользователя (isSpecialistEscapeCommand), либо автоматически, если
// пользователь несколько раз подряд не может пройти шаг (см. invalidAttempts
// в обработке email/phone). Уже введённые поля анкеты сохраняются в users[]
// как черновик, поэтому после выхода из чата со специалистом бот предложит
// донабрать анкету с прерванного места (см. resumeIncompleteRegistration и
// шаг "specialistChat" в обработчике сообщений).
async function escapeRegistrationToSpecialist(phone, userState, introText) {
    users[phone] = { ...(users[phone] || {}), ...userState.data };
    assignCompanyGroup(users[phone]);
    saveUsers();

    userState.step = "specialistChat";
    userState.mode = "specialist";
    touchSpecialistChatActivity(userState);
    conversations.set(phone, userState);
    saveConversations();

    await sendBotMessage(phone, introText || settings.texts.specialistIntro);
}

// --------------------------------------------------
// "Мои заявки" — просмотр статуса заявок пользователя в WhatsApp
// --------------------------------------------------
function getUserTickets(phone) {
    return tickets
        .filter(t => t.phone === phone)
        .slice()
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// Короткий порядковый номер заявки для показа людям (вместо длинного
// timestamp-id) — считается по позиции в общем массиве в порядке создания.
// Сам ticket.id как был, так и остаётся внутренним уникальным идентификатором
// (используется в маршрутах /admin/tickets/:id/status и т.д.) — не трогаем.
function getTicketSeqNumber(ticketId) {
    const index = tickets.findIndex(t => t.id === ticketId);
    return index === -1 ? ticketId : index + 1;
}

async function sendMyTicketsList(phone, userState) {
    const userTickets = getUserTickets(phone);

    if (!userTickets.length) {
        await sendBotMessage(phone, "У вас пока нет заявок.");
        await resetConversationToStart(phone, users[phone] || null);
        return;
    }

    userState.data.myTicketsIds = userTickets.map(t => t.id);
    userState.step = "myTicketsList";
    conversations.set(phone, userState);
    saveConversations();

    const lines = userTickets.map((t, index) => {
        const num = index + 1;
        const notes = Array.isArray(t.notes) ? t.notes : [];
        const lastNote = notes.length ? notes[notes.length - 1] : null;

        const problemSnippet = firstWords(t.problem, 5);
        const commentSnippet = lastNote?.text ? firstWords(lastNote.text, 5) : "";

        let line = `${num}. (№${getTicketSeqNumber(t.id)}) ${t.category || "Без категории"}`;
        if (problemSnippet) line += ` — «${problemSnippet}»`;
        line += ` — ${formatDate(t.createdAt)} — ${getStatusLabel(t.status)}`;
        if (commentSnippet) line += ` — Комментарий: «${commentSnippet}»`;

        return line;
    });

    await sendBotMessage(
        phone,
        [
            "📋 Ваши заявки:",
            "",
            ...lines,
            "",
            "Отправьте номер заявки, чтобы посмотреть детали.",
            "0 - Назад"
        ].join("\n")
    );
}

async function sendTicketDetail(phone, ticket) {
    const notes = Array.isArray(ticket.notes) ? ticket.notes : [];
    const lastNote = notes.length ? notes[notes.length - 1] : null;

    const lines = [
        `📄 Заявка №${getTicketSeqNumber(ticket.id)}: ${ticket.category || "Без категории"}`,
        `Описание: ${ticket.problem || "-"}`,
        `Статус: ${getStatusLabel(ticket.status)}`
    ];

    if (lastNote?.text) {
        lines.push(`Комментарий специалиста: ${lastNote.text}`);
    }

    lines.push(
        "",
        `Дата создания: ${formatDate(ticket.createdAt)}`,
        "",
        "Чтобы посмотреть другую заявку, отправьте её номер из списка.",
        "0 - Завершить"
    );

    await sendBotMessage(phone, lines.join("\n"));
}

// whatsapp-web.js эмитит "message_create" на ЛЮБОЕ исходящее сообщение с
// номера бота — в том числе на те, что бот сам отправляет через
// client.sendMessage(), а не только на те, что оператор вручную набрал в
// WhatsApp Business. Без этого списка обработчик "message_create" не мог
// отличить свой же ответ бота от ручного вмешательства оператора и после
// каждого сообщения бота сбрасывал диалог в "awaitingOperatorChoice" —
// пользователь получал меню "к вам подключился оператор" вместо
// продолжения сценария (например, сразу после вопроса "ФИО на русском:").
// Здесь запоминаем текст перед отправкой (синхронно, до await), а
// message_create вычёркивает совпадение и выходит, не трогая диалог.
const pendingBotMessages = new Map(); // phone -> [{ text, ts }]

function trackBotOutgoing(phone, text) {
    const list = pendingBotMessages.get(phone) || [];
    list.push({ text, ts: Date.now() });
    pendingBotMessages.set(phone, list);
}

// Возвращает true и вычёркивает запись, если text — это сообщение, которое
// бот сам недавно отправил на phone (см. trackBotOutgoing). Заодно чистит
// устаревшие записи (на случай, если сообщение по какой-то причине не
// пришло как fromMe — например, ошибка отправки), чтобы список не рос
// бесконечно.
const PENDING_BOT_MESSAGE_TTL_MS = 30_000;
function consumePendingBotMessage(phone, text) {
    const list = pendingBotMessages.get(phone);
    if (!list || list.length === 0) return false;

    const now = Date.now();
    const fresh = list.filter(entry => now - entry.ts < PENDING_BOT_MESSAGE_TTL_MS);

    const idx = fresh.findIndex(entry => entry.text === text);
    const matched = idx !== -1;
    if (matched) {
        fresh.splice(idx, 1);
    }

    if (fresh.length === 0) {
        pendingBotMessages.delete(phone);
    } else {
        pendingBotMessages.set(phone, fresh);
    }

    return matched;
}

async function sendBotMessage(phone, text) {
    // message_create даёт message.body уже через .trim() — трекаем текст в
    // том же виде, иначе случайные пробелы по краям сломают сравнение.
    trackBotOutgoing(phone, String(text ?? "").trim());
    return client.sendMessage(phone, text);
}

// Переводит диалог пользователя в режим полного молчания бота после того,
// как с ним связался оператор (комментарий к заявке, смена статуса, ручное
// сообщение из /admin/dialogs или напрямую в WhatsApp Business). Пока
// пользователь в этом состоянии, бот не отвечает ВООБЩЕ ничего — см. шаг
// "awaitingOperatorChoice" в обработчике сообщений. Выйти из режима можно
// только через закрывающую фразу оператора (settings.closeTicketTriggerText,
// см. client.on("message_create", ...)), которая закрывает заявку и удаляет
// это состояние — со следующего сообщения бот снова готов вести обычный
// сценарий/новую заявку.
function setAwaitingOperatorChoice(phone, ticketId = null) {
    const prevState = conversations.get(phone);
    conversations.set(phone, {
        step: "awaitingOperatorChoice",
        mode: "ticket",
        data: prevState?.data || {},
        operatorTicketId: ticketId || null
    });
    saveConversations();
}

// Единая точка добавления номера в исключения — используется и формой в
// /admin/excluded-users, и WhatsApp-триггером (быстрый ответ оператора).
// Работает для ЛЮБОГО номера/id, зарегистрирован пользователь или нет.
// Сбрасывает текущий диалог, чтобы бот точно "замолчал" сразу же, а не
// продолжил недописанный сценарий по старому состоянию.
function addExcludedUser(phone, name = "", realPhone = "") {
    if (!phone) return false;
    if (excludedUsers.some(u => u.phone === phone)) return false;

    excludedUsers.push({
        phone,
        name: name || users[phone]?.fullNameRu || "",
        // Настоящий номер телефона, если он не совпадает с самим WhatsApp id
        // (актуально для "LID"-контактов, см. formatWhatsAppIdForDisplay) —
        // можно вписать вручную при добавлении, отредактировать позже, либо
        // он подставится сам, если получится определить через WhatsApp API.
        realPhone: String(realPhone || "").trim(),
        addedAt: new Date().toISOString()
    });
    saveExcludedUsers();

    conversations.delete(phone);
    saveConversations();

    return true;
}

// Обратная операция — убирает номер из исключений (снова включает бота
// для этого номера) и сбрасывает диалог, чтобы следующий ответ пользователя
// начинал сценарий с чистого листа, а не подхватывал устаревшее состояние.
function removeExcludedUser(phone) {
    const before = excludedUsers.length;
    excludedUsers = excludedUsers.filter(u => u.phone !== phone);

    if (excludedUsers.length === before) return false;

    saveExcludedUsers();

    conversations.delete(phone);
    saveConversations();

    return true;
}

// Убирает лишние пробелы и регистр при сравнении фразы оператора с
// настройкой closeTicketTriggerText — чтобы случайный лишний пробел или
// разница в регистре (например, автозамена в WhatsApp) не мешали срабатыванию.
function normalizeForCompare(text) {
    return String(text || "")
        .trim()
        .replace(/\s+/g, " ")
        .toLowerCase();
}

// Закрывает последнюю незакрытую заявку пользователя — вызывается, когда
// оператор со своего WhatsApp Business отправляет пользователю заранее
// оговорённую закрывающую фразу (например, через быстрый ответ /end).
// В отличие от закрытия через /admin/tickets/:id/status, здесь сообщение
// пользователю оператор уже отправил сам напрямую через WhatsApp — бот
// только фиксирует закрытие внутри системы и не отправляет ничего от себя.
function closeTicketByOperatorPhrase(phone) {
    // Диалог для этого номера больше не актуален — следующее сообщение
    // пользователя должно начинать обычный сценарий бота с чистого листа
    // (в частности, выводит его из "awaitingOperatorChoice", см.
    // setAwaitingOperatorChoice). Снимаем состояние независимо от того,
    // нашлась ли ниже открытая заявка — иначе, если оператор написал
    // закрывающую фразу без открытой заявки на этом номере, диалог
    // остался бы молчать навсегда.
    conversations.delete(phone);
    saveConversations();

    // Заявки, автосозданные при прерывании регистрации (interruptedRegistration,
    // см. createInterruptedRegistrationTicket), сюда намеренно не попадают:
    // с клиентом с нуля разбирался оператор вручную, а не бот, поэтому
    // закрывающая фраза не должна ставить на них "внутреннюю метку"
    // (см. sendOperatorClosedNotificationEmail) — это ввело бы в заблуждение,
    // будто обращение отработал бот. Такую заявку оператор закрывает сам,
    // как обычно, через /admin или напрямую в osTicket.
    const ticket = tickets
        .slice()
        .reverse()
        .find(t => t.phone === phone && t.status !== "closed" && !t.interruptedRegistration);

    if (!ticket) return null;

    ticket.status = "closed";
    ticket.closedAt = new Date().toISOString();
    ticket.notes = ticket.notes || [];
    ticket.notes.push({
        at: new Date().toISOString(),
        text: "Заявка закрыта оператором напрямую через WhatsApp Business.",
        author: "operator-whatsapp"
    });
    saveTickets();

    return ticket;
}

// Вызывается из панели администратора при смене статуса заявки
// и/или добавлении комментария — это и есть "окончательный ответ",
// который пользователь получает в WhatsApp при закрытии заявки.
async function notifyUserAboutTicket(ticket, comment) {
    if (!ticket?.phone) return;

    if (!isReady) {
        console.error(`Не удалось уведомить ${ticket.phone}: WhatsApp не подключен`);
        return;
    }

    const lines = [
        `📋 Обновление по заявке №${getTicketSeqNumber(ticket.id)}`,
        `Статус: ${getStatusLabel(ticket.status)}`
    ];

    if (comment) {
        lines.push("", "Комментарий специалиста:", comment);
    }

    lines.push("", "Чтобы посмотреть все свои заявки, отправьте: заявки");

    try {
        await sendBotMessage(ticket.phone, lines.join("\n"));
        // Оператор написал пользователю — следующий ответ не должен
        // попасть в обычный сценарий бота (регистрация/новая заявка).
        setAwaitingOperatorChoice(ticket.phone, ticket.id);
    } catch (error) {
        console.error("Ошибка отправки уведомления по заявке:", error.message);
    }
}

async function handleSpecialistMode(phone, userState, text) {
    // Каждое сообщение пользователя в этом режиме продлевает "жизнь" чата
    // со специалистом — иначе фоновая задача closeStaleSpecialistChats
    // закрыла бы активный диалог только потому, что он был начат давно.
    touchSpecialistChatActivity(userState);

    const fields = [
    { name: "fullNameRu", label: "ФИО на русском" },
    { name: "fullNameEn", label: "ФИО на английском" },
    { name: "position", label: "Должность" },
    { name: "company", label: "Компания" },
    { name: "email", label: "Email" },
    { name: "phone", label: "Телефон" }
];
    // Если диалог был явно привязан к конкретной заявке (оператор написал
    // по заявке №X — см. setAwaitingOperatorChoice) — используем именно её.
    // Иначе — старое поведение как fallback (заявка со статусом
    // "Чат со специалистом" для этого номера).
    let ticket = userState.operatorTicketId
        ? tickets.find(t => t.id === userState.operatorTicketId)
        : tickets
            .slice()
            .reverse()
            .find(t => t.phone === phone && t.status === "specialist_chat");

    if (!ticket) {
        // Чат со специалистом раньше вообще не фиксировался как заявка,
        // если сюда попадали не через комментарий/статус оператора (а,
        // например, сам клиент выбрал "11" в меню категорий или его
        // эскейпнули из середины регистрации) — переписка терялась и
        // никогда не попадала в osTicket. Создаём заявку тихо, на первом
        // же сообщении: категория как у пункта "11", а в описание
        // проблемы попадает всё, что уже известно (ответ на штатный шаг
        // "Опишите проблему" и/или самое первое сообщение диалога, см.
        // createEmptyState) плюс вот это сообщение — см. combineProblemText.
        ticket = buildTicketFromState(
            phone,
            userState,
            settings.categories["11"] || "👨‍💻 Чат со специалистом",
            "specialist"
        );
        ticket.problem = combineProblemText(userState.data.problem, text);

        tickets.push(ticket);
        saveTickets();

        userState.operatorTicketId = ticket.id;

        try {
            const mailResult = await sendTicketEmailWithFallback(ticket);
            if (mailResult?.messageId) {
                ticket.emailMessageId = mailResult.messageId;
                saveTickets();
            }
        } catch (error) {
            console.error("Ошибка фиксации чата со специалистом в osTicket:", error.message);
        }
    } else {
        ticket.notes = ticket.notes || [];
        ticket.notes.push({
            at: new Date().toISOString(),
            text
        });
        saveTickets();
    }

    if (text === "проверить данные") {
  const userData = users[phone];

    const userDataMessage = fields
        .map(field => `${field.label}: ${userData[field.name] || "-"}`)
        .join("\n");

    await sendBotMessage(
        phone,
        `Ваши данные:\n${userDataMessage}\n\nКакое поле вы хотите изменить? Отправьте название поля.`
    );

    userState.step = "editUserData";
    userState.data = { ...userData };
    conversations.set(phone, userState);
    saveConversations();
    return;
}

// ...

if (userState.step === "editUserData") {
    const fieldName = text.trim().toLowerCase();
    const field = fields.find(f => f.name.toLowerCase() === fieldName);

    if (field) {
        await sendBotMessage(phone, `Введите новое значение для поля "${field.label}":`);
        userState.step = `editUserData:${field.name}`;
        conversations.set(phone, userState);
        saveConversations();
    } else {
        await sendBotMessage(phone, "Некорректное название поля. Попробуйте еще раз.");
    }
    return;
}

const editFieldMatch = userState.step.match(/^editUserData:(.+)$/);
if (editFieldMatch) {
    const fieldName = editFieldMatch[1];
    userState.data[fieldName] = text.trim();

    const userDataMessage = fields
        .map(field => `${field.label}: ${userState.data[field.name] || "-"}`)
        .join("\n");

    await sendBotMessage(
        phone,
        `Данные обновлены:\n${userDataMessage}\n\nХотите изменить что-то еще? Если нет, отправьте "готово".`
    );

    userState.step = "editUserData";
    conversations.set(phone, userState);
    saveConversations();
    return;
}

if (userState.step === "editUserData" && text.trim().toLowerCase() === "готово") {
    const before = { ...(users[phone] || {}) };
    users[phone] = { ...(users[phone] || {}), ...userState.data };
    assignCompanyGroup(users[phone]);
    saveUsers();

    console.log(
        `[USER] ${phone} изменил анкету сам через чат со специалистом (${new Date().toISOString()}).\n` +
        `  До: ${JSON.stringify(before)}\n` +
        `  После: ${JSON.stringify(users[phone])}`
    );

    await sendBotMessage(phone, "Данные успешно обновлены.");
    userState.step = "specialistChat";
    touchSpecialistChatActivity(userState);
    conversations.set(phone, userState);
    saveConversations();
    return;
}

    conversations.set(phone, userState);
    saveConversations();

    // никаких ответов каждый раз не отправляем
}
async function restartWhatsAppClient() {
    if (restartingClient) return;
    restartingClient = true;

    try {
        if (client) {
            await client.destroy().catch(() => {});
        }
    } catch (error) {
        console.error("Destroy error:", error.message);
    }

    setTimeout(async () => {
        try {
            createWhatsAppClient();
            await client.initialize();
        } catch (error) {
            restartingClient = false;
            console.error("Reinitialize failed:", error.message);
        }
    }, 3000);
}
function createWhatsAppClient() {
    client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            headless: true,
            executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage"
            ]
        }
    });

    client.on("qr", async (qr) => {
        console.log(">>> QR EVENT RECEIVED", new Date().toISOString());
        qrImage = await qrcode.toDataURL(qr);
        botStatus = "qr";
        isReady = false;
    });

    client.on("ready", () => {
        console.log(">>> CLIENT READY", new Date().toISOString());
        isReady = true;
        botStatus = "ready";
        qrImage = null;
        restartingClient = false;
    });

    client.on("disconnected", async (reason) => {
        console.log(">>> DISCONNECTED:", reason, new Date().toISOString());
        isReady = false;
        botStatus = "disconnected";
        qrImage = null;
        await restartWhatsAppClient();
    });

    client.on("auth_failure", async (msg) => {
        console.log(">>> AUTH FAILURE:", msg, new Date().toISOString());
        isReady = false;
        botStatus = "auth_failure";
        qrImage = null;
        await restartWhatsAppClient();
    });

    // "message" ловит только входящие сообщения. "message_create" ловит и
    // входящие, и исходящие (в т.ч. отправленные вручную с телефона через
    // сам WhatsApp Business, а не через админ-панель/API бота). Именно
    // это нужно, чтобы поймать закрывающую фразу оператора и закрыть заявку,
    // даже если ответ пользователю был написан напрямую в приложении.
    client.on("message_create", async (message) => {
        if (!message.fromMe) return;
        if (!message.to || message.to.includes("@g.us")) return;

        const phone = message.to;
        const text = (message.body || "").trim();
        if (!text) return;

        // Это сообщение отправил сам бот (через sendBotMessage) — не
        // операторское вмешательство, дальше обрабатывать не нужно.
        if (consumePendingBotMessage(phone, text)) return;

        if (normalizeForCompare(text) === normalizeForCompare(settings.closeTicketTriggerText)) {
            const closedTicket = closeTicketByOperatorPhrase(phone);
            if (closedTicket) {
                console.log(`Заявка №${getTicketSeqNumber(closedTicket.id)} закрыта оператором через WhatsApp Business (${phone})`);

                try {
                    await sendOperatorClosedNotificationEmail(closedTicket);
                } catch (error) {
                    console.error("Ошибка отправки уведомления о закрытии заявки в почту:", error.message);
                }
            }
            return;
        }

        // Быстрый ответ "/Список исключений" — оператор вручную отключает
        // бота для этого номера прямо из WhatsApp Business, без захода в
        // админку. Работает и до, и после регистрации пользователя, т.к.
        // сравнение идёт по реальному id получателя (message.to).
        if (normalizeForCompare(text) === normalizeForCompare(settings.excludeUserTriggerText)) {
            const added = addExcludedUser(phone);
            if (added) {
                console.log(`Номер ${phone} добавлен в исключения оператором через WhatsApp Business`);
            }
            return;
        }

        // Обратный быстрый ответ "/Активировать бота в чате" — включает
        // бота обратно для этого номера.
        if (normalizeForCompare(text) === normalizeForCompare(settings.includeUserTriggerText)) {
            const removed = removeExcludedUser(phone);
            if (removed) {
                console.log(`Номер ${phone} убран из исключений оператором через WhatsApp Business`);
            }
            return;
        }

        // Любое другое сообщение, которое оператор написал пользователю
        // напрямую через сам WhatsApp Business (а не через одну из фраз выше
        // и не через админку) — это ручное вмешательство человека в разговор.
        // Раньше бот об этом ничего не знал: следующий ответ пользователя
        // попадал в тот же шаг диалога, в котором тот застыл (например,
        // "cancelMenu" после успешной заявки) и получал автоматическое
        // "Выберите: 1-4/0" в ответ на что-то вроде видео с кодом AnyDesk.
        // Теперь любое такое сообщение переводит диалог в "ожидание выбора
        // после оператора" (как и вмешательство через админку) — бот
        // замолкает, пока пользователь сам не определится, что делать
        // дальше. Исключение — если пользователь уже в чате со специалистом:
        // там это ожидаемая нормальная переписка, поэтому просто продлеваем
        // таймаут неактивности, а не сбрасываем диалог.
        const existingState = conversations.get(phone);
        if (existingState && existingState.step === "specialistChat") {
            touchSpecialistChatActivity(existingState);
            conversations.set(phone, existingState);
            saveConversations();
            return;
        }

        // Оператор написал, пока пользователь ещё не закончил анкету/заявку
        // (шаги регистрации, описание проблемы или ещё не выбрал категорию).
        // Во-первых, сохраняем уже введённые поля как черновик в users[]
        // (так же, как это делает escapeRegistrationToSpecialist) — без
        // этого, когда диалог после закрывающей фразы оператора
        // (closeTicketByOperatorPhrase) начнётся заново,
        // resumeIncompleteRegistration посмотрит только в users[] и не
        // увидит уже введённых полей — они бы потерялись, хотя формально
        // были введены. Во-вторых — раз регистрация прервана и заявка так и
        // не была оформлена штатным путём, фиксируем обращение в osTicket
        // отдельной заявкой категории "Другое" (см.
        // createInterruptedRegistrationTicket), чтобы оно не потерялось —
        // дальше с клиентом работает оператор напрямую, бот просто молчит.
        const INCOMPLETE_TICKET_STEPS = new Set([
            "fullNameRu", "fullNameEn", "position", "company", "email", "phone",
            "problem", "category", "category1Sub"
        ]);
        let interruptedTicket = null;
        if (existingState && INCOMPLETE_TICKET_STEPS.has(existingState.step) && existingState.data) {
            users[phone] = { ...(users[phone] || {}), ...existingState.data };
            assignCompanyGroup(users[phone]);
            saveUsers();

            interruptedTicket = await createInterruptedRegistrationTicket(phone, existingState);
        }

        const relatedTicket = interruptedTicket || tickets
            .slice()
            .reverse()
            .find(t => t.phone === phone);

        setAwaitingOperatorChoice(phone, relatedTicket ? relatedTicket.id : null);
    });

    client.on("message", async (message) => {
        if (message.from.includes("@g.us")) return;

        const phone = message.from;
        const excludedUser = excludedUsers.find(
    u => u.phone === phone
);

if (excludedUser) {
    return;
}
        const text = (message.body || "").trim();
        if (!text) return;

        const savedUser = users[phone];
        let userState = conversations.get(phone);

        if (isExitCommand(text)) {
            conversations.delete(phone);
            saveConversations();
            await sendBotMessage(phone, "Чат закрыт. Чтобы начать заново, отправьте любое сообщение.");
            return;
        }

        if (
    isCancelCommand(text) &&
    userState &&
    userState.step !== "category"
) {
   
   await resetConversationToStart(phone, savedUser || null);
    return;
}

if (
    isMyTicketsCommand(text) &&
    (!userState || !["category", "email", "phone"].includes(userState.step))
) {
    if (!userState) {
        userState = createEmptyState();
        conversations.set(phone, userState);
        saveConversations();
    }

    await sendMyTicketsList(phone, userState);
    return;
}

// С пользователем только что связался оператор (комментарий к заявке,
// смена статуса или ручное сообщение из /admin/dialogs) — бот полностью
// замолкает в WhatsApp и не отвечает вообще ничего, сколько бы клиент ни
// писал: раз оператор ведёт переписку сам, бот не должен встревать меню
// или подсказками. Если оператор вмешался посреди незаконченной
// регистрации/заявки, обращение уже зафиксировано в osTicket отдельной
// заявкой "Другое" в момент постановки на паузу (см.
// createInterruptedRegistrationTicket в client.on("message_create")) — здесь
// просто молчим дальше. Единственный выход из этого режима — оператор явно
// произносит закрывающую фразу (settings.closeTicketTriggerText) прямо в
// WhatsApp Business; это ловится в client.on("message_create", ...), где
// conversations для этого номера удаляется — со следующего сообщения
// клиента бот снова в обычном режиме "нет активного диалога" и готов
// принять новую заявку.
if (userState && userState.step === "awaitingOperatorChoice") {
    return;
}

if (!userState) {
            // Заявка недавно закрыта (например, оператор отправил /end) —
            // короткий ответ вроде "спасибо"/"ок" не должен тут же запускать
            // новую заявку/регистрацию. Молчим до истечения периода тишины,
            // если только это не явная команда начать заново.
            if (!isForceNewRequestCommand(text) && getRecentlyClosedTicket(phone)) {
                return;
            }

            if (savedUser && isRegistrationComplete(phone)) {
                userState = createProblemState(savedUser);
                conversations.set(phone, userState);
                saveConversations();

                await sendBotMessage(
                    phone,
                    applyTemplate(settings.texts.registeredProblemIntro, {
                        name: savedUser.fullNameRu || ""
                    })
                );
                return;
            }

            if (savedUser) {
                await resumeIncompleteRegistration(phone);
                return;
            }

            conversations.set(phone, createEmptyState(text));
            saveConversations();
            await sendBotMessage(phone, settings.texts.startNewUser);
            return;
        }

        if (userState.step === "cancelMenu") {

    switch (text.trim()) {

        case "1":
            userState.step = "problem";

            conversations.set(phone, userState);
            saveConversations();

            await sendBotMessage(
                phone,
                "Опишите проблему:"
            );
            return;

        case "2":

const user = users[phone] || {};

await sendBotMessage(
    phone,
`Ваши данные:

1 - ФИО: ${user.fullNameRu || "-"}
2 - ФИО EN: ${user.fullNameEn || "-"}
3 - Должность: ${user.position || "-"}
4 - Компания: ${user.company || "-"}
5 - Email: ${user.email || "-"}
6 - Телефон: ${user.phone || "-"}

Отправьте номер поля для изменения.
0 - Назад`
);
userState.step = "selectEditField";

conversations.set(phone, userState);
saveConversations();

return;

userState.step = "selectEditField";

conversations.set(phone, userState);
saveConversations();

return;

        case "3":

            userState.step = "specialistChat";
            userState.mode = "specialist";
            touchSpecialistChatActivity(userState);

            conversations.set(phone, userState);
            saveConversations();

            await sendBotMessage(
                phone,
                settings.texts.specialistIntro
            );

            return;

        case "4":

            await sendMyTicketsList(phone, userState);
            return;

        case "0":

            conversations.delete(phone);
            saveConversations();

            await sendBotMessage(
                phone,
                "Чат завершен."
            );

            return;

        default:

            await sendBotMessage(
                phone,
`Выберите:

1 - Новая заявка
2 - Проверить данные
3 - Чат со специалистом
4 - Мои заявки
0 - Выход`
            );

            return;
    }
}

        if (userState.step === "specialistChat") {
            if (text === "0" || text.toLowerCase() === "выход") {
                conversations.delete(phone);
                saveConversations();

                // Регистрация была прервана досрочным переходом к специалисту
                // (см. escapeRegistrationToSpecialist) — донабираем анкету с
                // прерванного места, а не просто закрываем чат.
                if (users[phone] && !isRegistrationComplete(phone)) {
                    await resumeIncompleteRegistration(phone);
                    return;
                }

                await sendBotMessage(phone, "Чат со специалистом завершен. Вы вышли из системы.");
                return;
            }

            await handleSpecialistMode(phone, userState, text);
            return;
        }

        if (userState.step === "category1Sub") {
            const choice = text.trim();

            if (choice === "0") {
                userState.step = "category";
                conversations.set(phone, userState);
                saveConversations();
                // Возврат из подменю к списку категорий — пользователя уже
                // приветствовали при первом входе в этот список, повторное
                // "Здравствуйте" тут ни к чему.
                await sendBotMessage(phone, getCategoryMenu());
                return;
            }

            if (choice === "1") {
                const link = settings.telegramResetBotUsername
                    ? `https://t.me/${settings.telegramResetBotUsername}`
                    : null;

                await sendBotMessage(
                    phone,
                    link
                        ? applyTemplate(settings.texts.telegramResetInfo, { link })
                        : settings.texts.telegramResetMissing
                );

                conversations.delete(phone);
                saveConversations();
                return;
            }

            if (choice === "2") {
                const category = getCategoryByChoice("1") || "🔑 Учетные записи / Доступы, пароли";
                await finalizeTicketCreation(phone, userState, category);
                return;
            }

            await sendBotMessage(phone, settings.texts.category1SubInvalid);
            return;
        }

        if (userState.step === "selectEditField") {

    const fields = {
        "1": "fullNameRu",
        "2": "fullNameEn",
        "3": "position",
        "4": "company",
        "5": "email",
        "6": "phone"
    };

    if (text === "0") {
        userState.step = "cancelMenu";

        conversations.set(phone, userState);
        saveConversations();

        await sendBotMessage(
            phone,
`Выберите:

1 - Новая заявка
2 - Проверить данные
3 - Чат со специалистом
4 - Мои заявки
0 - Выход`
        );

        return;
    }

    if (!fields[text]) {
        await sendBotMessage(
            phone,
            "Выберите число от 1 до 6."
        );
        return;
    }

    userState.editField = fields[text];
    userState.step = "editFieldValue";

    conversations.set(phone, userState);
    saveConversations();

    await sendBotMessage(
        phone,
        "Введите новое значение:"
    );

    return;
}
if (userState.step === "editFieldValue") {

    const field = userState.editField;

    if (!field) {
        userState.step = "cancelMenu";
        conversations.set(phone, userState);
        saveConversations();
        return;
    }

    users[phone] = users[phone] || {};

    const previousValue = users[phone][field];
    users[phone][field] = text.trim();

if (userState.data) {
    userState.data[field] = text.trim();
}

saveUsers();

console.log(
    `[USER] ${phone} изменил поле "${field}" сам через чат бота (${new Date().toISOString()}): ` +
    `"${previousValue ?? ""}" -> "${users[phone][field]}"`
);
conversations.set(phone, userState);
saveConversations();

delete userState.editField;

if (userState.stepBeforeEdit === "mailFailMenu") {

    delete userState.stepBeforeEdit;

    userState.step = "mailFailMenu";

    conversations.set(phone, userState);
    saveConversations();

    await sendBotMessage(
        phone,
`✅ Данные успешно обновлены.

Что необходимо сделать?

1 - Проверить данные анкеты
2 - Изменить данные
0 - Завершить`
    );

    return;
}

userState.step = "cancelMenu";

conversations.set(phone, userState);
saveConversations();

await sendBotMessage(
    phone,
    "✅ Данные успешно обновлены."
);

return;
}

if (userState.step === "mailFailMenu") {

    switch (text.trim()) {

        case "1":

    const user = users[phone] || {};

    await sendBotMessage(
        phone,
`Ваши данные:

1 - ФИО: ${user.fullNameRu || "-"}
2 - ФИО EN: ${user.fullNameEn || "-"}
3 - Должность: ${user.position || "-"}
4 - Компания: ${user.company || "-"}
5 - Email: ${user.email || "-"}
6 - Телефон: ${user.phone || "-"}

Выберите номер поля для изменения.

0 - Назад`
    );

    userState.stepBeforeEdit = "mailFailMenu";
    userState.step = "selectEditField";

    conversations.set(phone, userState);
    saveConversations();

    return;

        case "2":

    userState.stepBeforeEdit = "mailFailMenu";
    userState.step = "selectEditField";

            conversations.set(phone, userState);
            saveConversations();

            await sendBotMessage(
                phone,
`Что необходимо изменить?

1 - ФИО
2 - ФИО EN
3 - Должность
4 - Компания
5 - Email
6 - Телефон`
            );

            return;

        case "0":

            conversations.delete(phone);
            saveConversations();

            await sendBotMessage(
                phone,
                "Диалог завершен."
            );

            return;

        default:

            await sendBotMessage(
                phone,
                "Выберите 1, 2 или 0."
            );

            return;
    }
}

if (userState.step === "editAfterMailFail") {

    await sendBotMessage(
        phone,
`Что необходимо изменить?

1 - ФИО на русском
2 - ФИ на английском
3 - Должность
4 - Компания
5 - Email
6 - Телефон
0 - Завершить`
    );

    userState.step = "selectEditField";
    conversations.set(phone, userState);
    saveConversations();

    return;
}

if (userState.step === "myTicketsList") {
    const rawChoice = text.trim();

    if (rawChoice === "0") {
        await resetConversationToStart(phone, users[phone] || null);
        return;
    }

    const ids = userState.data.myTicketsIds || [];
    const index = Number(rawChoice) - 1;

    if (!Number.isInteger(index) || index < 0 || index >= ids.length) {
        await sendBotMessage(phone, "Отправьте номер заявки из списка или 0 для возврата.");
        return;
    }

    const ticket = tickets.find(t => t.id === ids[index]);
    if (!ticket) {
        await sendBotMessage(phone, "Заявка не найдена, возможно она была удалена.");
        await resetConversationToStart(phone, users[phone] || null);
        return;
    }

    userState.data.selectedTicketId = ticket.id;
    userState.step = "myTicketsDetail";
    conversations.set(phone, userState);
    saveConversations();

    await sendTicketDetail(phone, ticket);
    return;
}

if (userState.step === "myTicketsDetail") {
    const rawChoice = text.trim();

    if (rawChoice === "0") {
        userState.step = "cancelMenu";
        conversations.set(phone, userState);
        saveConversations();

        await sendBotMessage(
            phone,
`❌ Действия завершены.

Выберите дальнейшее действие:

1 - Создать новую заявку
2 - Проверить данные анкеты
3 - Чат со специалистом
4 - Мои заявки
0 - Выход`
        );
        return;
    }

    const ids = userState.data.myTicketsIds || [];
    const index = Number(rawChoice) - 1;

    if (Number.isInteger(index) && index >= 0 && index < ids.length) {
        const ticket = tickets.find(t => t.id === ids[index]);

        if (ticket) {
            userState.data.selectedTicketId = ticket.id;
            conversations.set(phone, userState);
            saveConversations();

            await sendTicketDetail(phone, ticket);
            return;
        }
    }

    await sendBotMessage(phone, "Выберите порядковый номер заявки или нажмите 0 для выхода.");
    return;
}

// Явная просьба переключиться на оператора на любом шаге первичной
// регистрации — не заставляем долистывать анкету до конца, если человек
// прямо просит специалиста. См. escapeRegistrationToSpecialist.
if (
    ["fullNameRu", "fullNameEn", "position", "company", "email", "phone"].includes(userState.step) &&
    isSpecialistEscapeCommand(text)
) {
    await escapeRegistrationToSpecialist(
        phone,
        userState,
        `Хорошо, соединяю вас со специалистом.\n\n${settings.texts.specialistIntro}\n\nПосле завершения беседы бот попросит закончить регистрацию.`
    );
    return;
}

        switch (userState.step) {
            case "fullNameRu":
                userState.data.fullNameRu = text;
                userState.step = "fullNameEn";
                conversations.set(phone, userState);
                saveConversations();
                await sendBotMessage(phone, settings.texts.askFullNameEn);
                break;

            case "fullNameEn":
                userState.data.fullNameEn = text;
                userState.step = "position";
                conversations.set(phone, userState);
                saveConversations();
                await sendBotMessage(phone, settings.texts.askPosition);
                break;

            case "position":
                userState.data.position = text;
                userState.step = "company";
                conversations.set(phone, userState);
                saveConversations();
                await sendBotMessage(phone, settings.texts.askCompany);
                break;

            case "company":
                userState.data.company = text;
                userState.step = "email";
                conversations.set(phone, userState);
                saveConversations();
                await sendBotMessage(phone, settings.texts.askEmail);
                break;

            case "email": {
                if (!isValidEmail(text)) {
                    userState.invalidAttempts = (userState.invalidAttempts || 0) + 1;

                    // Три подряд некорректных ответа — вероятно, пользователь
                    // застрял на этом шаге (или игнорирует правильный формат).
                    // Переключаем на специалиста вместо того, чтобы бесконечно
                    // повторять один и тот же вопрос.
                    if (userState.invalidAttempts >= 3) {
                        await escapeRegistrationToSpecialist(
                            phone,
                            userState,
                            `Похоже, возникли сложности с заполнением анкеты (Email).\n\n${settings.texts.specialistIntro}\n\nПосле завершения беседы бот попросит закончить регистрацию.`
                        );
                        return;
                    }

                    conversations.set(phone, userState);
                    saveConversations();
                    await sendBotMessage(phone, settings.texts.invalidEmail);
                    return;
                }

                userState.data.email = text;
                userState.invalidAttempts = 0;

                userState.step = "phone";
                conversations.set(phone, userState);
                saveConversations();
                await sendBotMessage(phone, settings.texts.askPhone);
                break;
            }

            case "phone":
                if (!isValidPhone(text)) {
                    userState.invalidAttempts = (userState.invalidAttempts || 0) + 1;

                    if (userState.invalidAttempts >= 3) {
                        await escapeRegistrationToSpecialist(
                            phone,
                            userState,
                            `Похоже, возникли сложности с заполнением анкеты (Телефон).\n\n${settings.texts.specialistIntro}\n\nПосле завершения беседы бот попросит закончить регистрацию.`
                        );
                        return;
                    }

                    conversations.set(phone, userState);
                    saveConversations();
                    await sendBotMessage(phone, settings.texts.invalidPhone);
                    return;
                }

                userState.data.phone = normalizePhone(text);
                userState.invalidAttempts = 0;
                userState.step = "problem";
                conversations.set(phone, userState);
                saveConversations();
                await sendBotMessage(phone, settings.texts.askProblem);
                break;

            case "problem": {
                userState.data.problem = text;
                userState.step = "category";

                // Анкета считается завершённой сразу после описания проблемы —
                // сохраняем её в users[] здесь, а не только после выбора
                // категории и отправки письма (как было раньше). Иначе если
                // пользователь не доходит до конца выбора категории (например,
                // обрывает диалог командой "0" в ещё не настроенном пункте
                // меню — см. category1Sub), анкета не сохранялась, и следующее
                // сообщение запускало регистрацию с нуля вместо "Сначала
                // опишите проблему".
                users[phone] = {
                    ...(users[phone] || {}),
                    fullNameRu: userState.data.fullNameRu,
                    fullNameEn: userState.data.fullNameEn,
                    position: userState.data.position,
                    company: userState.data.company,
                    email: userState.data.email,
                    phone: userState.data.phone
                };
                assignCompanyGroup(users[phone]);
                saveUsers();

                conversations.set(phone, userState);
                saveConversations();
                // Для только что зарегистрированного пользователя это первое
                // приветствие (registeredProblemIntro тут не отправлялся);
                // для уже зарегистрированного greetedForProblem уже стоит,
                // и повторного "Здравствуйте" не будет.
                await sendBotMessage(
                    phone,
                    getCategoryMenu(userState.greetedForProblem ? "" : userState.data.fullNameEn)
                );
                break;
            }

            case "category": {
                const rawChoice = String(text).trim();

                if (rawChoice === "12") {

    userState.step = "cancelMenu";

    conversations.set(phone, userState);
    saveConversations();

    await sendBotMessage(
        phone,
`❌ Заявка отменена.

Выберите дальнейшее действие:

1 - Создать новую заявку
2 - Проверить данные анкеты
3 - Чат со специалистом
4 - Мои заявки
0 - Выход`
    );

    return;
                }

                const category = getCategoryByChoice(rawChoice);
                if (!category) {
                    await sendBotMessage(phone, settings.texts.invalidChoice);
                    return;
                }

                if (rawChoice === "11") {
                   users[phone] = {
    ...(users[phone] || {}),
    fullNameRu: userState.data.fullNameRu || users[phone]?.fullNameRu,
    fullNameEn: userState.data.fullNameEn || users[phone]?.fullNameEn,
    position: userState.data.position || users[phone]?.position,
    company: userState.data.company || users[phone]?.company,
    email: userState.data.email || users[phone]?.email,
    phone: userState.data.phone || users[phone]?.phone
};
assignCompanyGroup(users[phone]);

saveUsers();

                    userState.step = "specialistChat";
                    userState.mode = "specialist";
                    touchSpecialistChatActivity(userState);
                    conversations.set(phone, userState);
                    saveConversations();

                    await sendBotMessage(phone, settings.texts.specialistIntro);
                    return;
                }

                if (rawChoice === "13") {
                    await sendMyTicketsList(phone, userState);
                    return;
                }

                if (rawChoice === "1") {
                    userState.step = "category1Sub";
                    conversations.set(phone, userState);
                    saveConversations();
                    await sendBotMessage(phone, settings.texts.category1SubIntro);
                    return;
                }

                await finalizeTicketCreation(phone, userState, category);
                break;
            }

            default:
                conversations.delete(phone);
                saveConversations();
                break;
              }
    });

    return client;
}




createWhatsAppClient();
client.initialize();

// --------------------------------------------------
// Фоновые задачи
// --------------------------------------------------

// Закрывает диалоги, застрявшие в режиме "Чат со специалистом" дольше
// settings.specialistChatTimeoutHours без единого сообщения — ни от
// пользователя, ни от оператора (см. touchSpecialistChatActivity). Диалог
// просто удаляется, поэтому следующее сообщение пользователя обрабатывается
// как обычное обращение: полностью зарегистрированный пользователь увидит
// "Сначала опишите проблему" (т.е. попадёт в оформление новой заявки), а
// пользователь с недозаполненной анкетой — донаберёт её (см.
// resumeIncompleteRegistration). Пользователю дополнительно отправляется
// сообщение о том, что чат закрыт по неактивности, чтобы это не выглядело
// как "бот перестал отвечать".
async function closeStaleSpecialistChats() {
    const timeoutHours = Number(settings.specialistChatTimeoutHours) || 0;
    if (!timeoutHours) return;

    const cutoff = Date.now() - timeoutHours * 60 * 60 * 1000;

    for (const [phone, state] of Array.from(conversations.entries())) {
        if (state?.step !== "specialistChat") continue;

        const lastActivity = state.specialistChatLastActivityAt
            ? new Date(state.specialistChatLastActivityAt).getTime()
            : 0;

        // Если метки времени по какой-то причине нет (например, диалог был
        // создан до появления этой функции) — не закрываем сразу же, а
        // считаем точкой отсчёта именно этот момент, чтобы дать шанс
        // нормально продолжить разговор.
        if (!lastActivity) {
            state.specialistChatLastActivityAt = new Date().toISOString();
            conversations.set(phone, state);
            saveConversations();
            continue;
        }

        if (lastActivity > cutoff) continue;

        conversations.delete(phone);
        saveConversations();

        console.log(`Чат со специалистом автоматически закрыт по неактивности (${timeoutHours} ч.): ${phone}`);

        if (isReady && client) {
            try {
                await sendBotMessage(
                    phone,
                    "⏳ Чат со специалистом автоматически закрыт из-за отсутствия активности.\n\nЧтобы создать новую заявку, напишите любое сообщение."
                );
            } catch (error) {
                console.error("Ошибка уведомления об автозакрытии чата со специалистом:", error.message);
            }
        }
    }
}

setInterval(() => {
    closeStaleSpecialistChats().catch(error => {
        console.error("Ошибка автозакрытия чатов со специалистом:", error.message);
    });
}, 30 * 60 * 1000);

// --------------------------------------------------
// Admin UI
// --------------------------------------------------
function renderSidebar(active = "dashboard") {
    const items = [
        { id: "dashboard", icon: "📊", label: "Дашборд", href: "/admin" },
        { id: "tickets", icon: "🧾", label: "Заявки", href: "/admin/tickets" },
        { id: "dialogs", icon: "💬", label: "Диалоги", href: "/admin/dialogs" },
        {
            id: "users-group",
            icon: "👥",
            label: "Пользователи",
            children: [
                { id: "users", label: "Все пользователи", href: "/admin/users" },
                { id: "excluded", label: "🚫 Список исключений", href: "/admin/excluded-users" }
            ]
        },
        { id: "messages", icon: "✉️", label: "Сообщения", href: "/admin/messages" },
        { id: "categories", icon: "📁", label: "Категории", href: "/admin/categories" },
        { id: "settings", icon: "⚙️", label: "Настройки", href: "/admin/settings" }
    ];

    return `
        <aside class="sidebar">
            <div class="brand">
                <div class="brand-logo">WA</div>
                <div>
                    <div class="brand-name">WA Bot</div>
                    <div class="brand-sub">Панель управления</div>
                </div>
            </div>
            <nav class="nav">
                ${items.map(item => {
                    if (item.children) {
                        return `
                            <div class="nav-group">
                                <div class="nav-group-label">
                                    <span>${item.icon}</span>
                                    <span>${item.label}</span>
                                </div>
                                <div class="nav-sub">
                                    ${item.children.map(child => `
                                        <a class="nav-item nav-subitem ${active === child.id ? "active" : ""}" href="${child.href}">
                                            <span>${child.label}</span>
                                        </a>
                                    `).join("")}
                                </div>
                            </div>
                        `;
                    }

                    return `
                        <a class="nav-item ${active === item.id ? "active" : ""}" href="${item.href}">
                            <span>${item.icon}</span>
                            <span>${item.label}</span>
                        </a>
                    `;
                }).join("")}
            </nav>
        </aside>
    `;
}

function renderLayout({ active, title, topAction = "", content }) {
    const totalTickets = tickets.length;
    const newTicketsCount = tickets.filter(t => t.status === "new").length;
    const dialogsCount = conversations.size;
    const usersCount = Object.keys(users).length;

    return `
    <html lang="ru">
    <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>WA Bot — ${escapeHtml(title)}</title>
        <style>
            * { box-sizing: border-box; }
            body {
                margin: 0;
                font-family: Arial, sans-serif;
                background: #0f1117;
                color: #e5e7eb;
            }
            a { color: inherit; text-decoration: none; }
            .layout {
                display: grid;
                grid-template-columns: 260px 1fr;
                min-height: 100vh;
            }
            .sidebar {
                background: #1b1f2a;
                border-right: 1px solid #2a3140;
                padding: 18px 14px;
            }
            .brand {
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 10px 10px 18px;
                border-bottom: 1px solid #2a3140;
                margin-bottom: 14px;
            }
            .brand-logo {
                width: 36px;
                height: 36px;
                border-radius: 12px;
                background: linear-gradient(135deg, #22c55e, #16a34a);
                display: grid;
                place-items: center;
                font-weight: 800;
                color: white;
            }
            .brand-name {
                font-size: 18px;
                font-weight: 700;
                color: #22c55e;
            }
            .brand-sub {
                font-size: 12px;
                color: #94a3b8;
                margin-top: 4px;
            }
            .nav {
                display: flex;
                flex-direction: column;
                gap: 6px;
                margin-top: 10px;
            }
            .nav-item {
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 12px 12px;
                border-radius: 12px;
                color: #cbd5e1;
                transition: .15s ease;
                font-size: 15px;
            }
            .nav-item:hover,
            .nav-item.active {
                background: #2a3140;
                color: #fff;
            }
            .nav-group-label {
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 12px 12px 4px;
                color: #94a3b8;
                font-size: 15px;
            }
            .nav-sub {
                display: flex;
                flex-direction: column;
                gap: 4px;
                margin: 2px 0 4px 18px;
                padding-left: 12px;
                border-left: 1px solid #2a3140;
            }
            .nav-subitem {
                font-size: 14px;
                padding: 9px 12px;
            }
            .group-filter-bar {
                display: flex;
                flex-wrap: wrap;
                gap: 10px;
                padding: 4px 0 14px;
            }
            .group-pill {
                display: inline-flex;
                align-items: center;
                gap: 8px;
                padding: 8px 14px;
                border-radius: 999px;
                background: #1b2130;
                border: 1px solid #2a3140;
                color: #cbd5e1;
                font-size: 13px;
                font-weight: 600;
                text-decoration: none;
                white-space: nowrap;
            }
            .group-pill:hover {
                border-color: #4b5b76;
                color: #fff;
            }
            .group-pill.active {
                background: #22c55e;
                border-color: #22c55e;
                color: #06210f;
            }
            .group-pill-count {
                background: rgba(255,255,255,0.15);
                border-radius: 999px;
                padding: 1px 8px;
                font-size: 12px;
            }
            .group-pill.active .group-pill-count {
                background: rgba(0,0,0,0.18);
            }
            .main {
                padding: 18px 20px 24px;
            }
            .topbar {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 20px;
                gap: 12px;
            }
            .title {
                font-size: 22px;
                font-weight: 700;
                color: #fff;
            }
            .btn {
                border: 0;
                background: #2a3140;
                color: #fff;
                padding: 10px 14px;
                border-radius: 10px;
                cursor: pointer;
                font-weight: 600;
            }
            .btn:hover { background: #374151; }
            .btn-primary { background: #2563eb; }
            .btn-primary:hover { background: #1d4ed8; }
            .btn-danger { background: #dc2626; }
            .btn-danger:hover { background: #b91c1c; }
            .cards {
                display: grid;
                grid-template-columns: repeat(4, minmax(0, 1fr));
                gap: 16px;
                margin-bottom: 18px;
            }
            .card {
                background: #1b1f2a;
                border: 1px solid #2a3140;
                border-radius: 14px;
                padding: 18px;
            }
            .card-title {
                color: #94a3b8;
                font-size: 14px;
                margin-bottom: 18px;
            }
            .card-value {
                font-size: 30px;
                font-weight: 700;
                color: #fff;
            }
            .section {
                background: #1b1f2a;
                border: 1px solid #2a3140;
                border-radius: 14px;
                overflow: hidden;
            }
            .section-head {
                padding: 16px 18px;
                font-size: 16px;
                font-weight: 700;
                border-bottom: 1px solid #2a3140;
                color: #fff;
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
            }
            .section-body {
                padding: 18px;
            }
            .table-wrap { overflow: auto; }
            table {
                width: 100%;
                border-collapse: collapse;
            }
            th, td {
                text-align: left;
                padding: 14px 16px;
                border-bottom: 1px solid #2a3140;
                white-space: nowrap;
                vertical-align: top;
            }
            th {
                color: #94a3b8;
                font-size: 13px;
                font-weight: 700;
            }
            td {
                color: #e5e7eb;
                font-size: 14px;
            }
            .grid-2 {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 18px;
                margin-top: 18px;
            }
            .grid-1 {
                display: grid;
                grid-template-columns: 1fr;
                gap: 18px;
                margin-top: 18px;
            }
            .mini-list {
                padding: 14px 18px 18px;
            }
            .mini-item {
                padding: 12px 0;
                border-bottom: 1px solid #2a3140;
            }
            .mini-item:last-child {
                border-bottom: 0;
            }
            .muted {
                color: #94a3b8;
                font-size: 13px;
            }
            .status-new { color: #f59e0b; }
            .status-in_progress { color: #38bdf8; }
            .status-closed { color: #22c55e; }
            .status-specialist_chat { color: #a78bfa; }
            .form-grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 14px;
            }
            .field {
                display: flex;
                flex-direction: column;
                gap: 7px;
                margin-bottom: 14px;
            }
            label {
                font-size: 13px;
                color: #cbd5e1;
                font-weight: 700;
            }
            input, textarea, select {
                width: 100%;
                background: #0f1117;
                color: #e5e7eb;
                border: 1px solid #334155;
                border-radius: 10px;
                padding: 11px 12px;
                outline: none;
                font-size: 14px;
            }
            textarea {
                min-height: 100px;
                resize: vertical;
            }
            .help {
                color: #94a3b8;
                font-size: 12px;
                line-height: 1.4;
            }
            .stack {
                display: flex;
                gap: 10px;
                flex-wrap: wrap;
                align-items: center;
            }
            .badge {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                padding: 6px 10px;
                border-radius: 999px;
                background: #2a3140;
                font-size: 12px;
                color: #e5e7eb;
            }
            .split {
                display: grid;
                grid-template-columns: 1.2fr .8fr;
                gap: 18px;
            }
            .quick-box {
                background: #11151d;
                border: 1px solid #2a3140;
                border-radius: 12px;
                padding: 14px;
                margin-bottom: 14px;
            }
            @media (max-width: 1100px) {
                .layout { grid-template-columns: 1fr; }
                .sidebar { display: none; }
                .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
                .grid-2, .split, .form-grid { grid-template-columns: 1fr; }
            }
            @media (max-width: 700px) {
                .cards { grid-template-columns: 1fr; }
            }
            @keyframes spin {
                from { transform: rotate(0deg); }
                to { transform: rotate(360deg); }
            }
        </style>
    </head>
    <body>
        <div id="qr-overlay" style="
            display:none;
            position:fixed;
            inset:0;
            background:#0f1117;
            z-index:99999;
            align-items:center;
            justify-content:center;
            flex-direction:column;
            padding:24px;
            color:#fff;
        ">
            <div style="
                max-width:420px;
                width:100%;
                background:#1b1f2a;
                border:1px solid #2a3140;
                border-radius:20px;
                padding:24px;
                text-align:center;
                box-shadow:0 20px 60px rgba(0,0,0,.45);
            ">
                <h2 style="margin:0 0 12px;">Сессия WhatsApp потеряна</h2>
                <p id="qr-status-text" style="margin:0 0 18px; color:#94a3b8;">
                    Ожидание нового QR-кода...
                </p>
                <div style="display:flex; justify-content: center;"> 
                <img id="qr-image" alt="QR" style="
                    width:280px;
                    height:280px;
                    object-fit:contain;
                    background:#fff;
                    border-radius:16px;
                    padding:12px;
                    display:none;
                " /></div>
               
                <div style="margin-top:16px; color:#94a3b8; font-size:14px;">
                    Отсканируй QR в WhatsApp
                </div>
            </div>
        </div>

        <script>
            async function refreshBotStatus() {
                try {
                    const res = await fetch("/admin/bot-status", { cache: "no-store" });
                    const data = await res.json();

                    const overlay = document.getElementById("qr-overlay");
                    const img = document.getElementById("qr-image");
                    const text = document.getElementById("qr-status-text");

                    const showOverlay = !data.isReady || data.botStatus !== "ready";
                    overlay.style.display = showOverlay ? "flex" : "none";

                    if (data.qrImage) {
                        img.src = data.qrImage;
                        img.style.display = "block";
                        text.textContent = "Сканируй QR-код, чтобы восстановить соединение.";
                    } else {
                        img.removeAttribute("src");
                        img.style.display = "none";

                        if (data.botStatus === "auth_failure") {
                            text.textContent = "Ошибка авторизации. Нужно заново подключить WhatsApp.";
                        } else if (data.botStatus === "disconnected") {
                            text.textContent = "Соединение пропало. Жду новый QR-код...";
                        } else {
                            text.textContent = "Ожидание нового QR-кода...";
                        }
                    }
                } catch (e) {
                    const overlay = document.getElementById("qr-overlay");
                    if (overlay) overlay.style.display = "flex";
                }
            }

            refreshBotStatus();
            setInterval(refreshBotStatus, 2000);

            document.addEventListener("submit", function (e) {
                const form = e.target;
                if (!(form instanceof HTMLFormElement)) return;

                const submitButton = form.querySelector('button[type="submit"]');
                if (submitButton) {
                    submitButton.disabled = true;
                    submitButton.dataset.prevHtml = submitButton.innerHTML;
                    submitButton.innerHTML = "⏳ Отправка...";
                }
            });
        </script>

        <div class="layout">
            ${renderSidebar(active)}
            <main class="main">
                <div class="topbar">
                    <div class="title">${escapeHtml(title)}</div>
                    <div class="stack">
                        ${topAction}
                        <form method="GET" action="" style="margin:0;">
                            <button class="btn" type="submit">↻ Обновить</button>
                        </form>
                    </div>
                </div>

                <div class="cards">
                    <div class="card">
                        <div class="card-title">Всего заявок</div>
                        <div class="card-value">${totalTickets}</div>
                    </div>
                    <div class="card">
                        <div class="card-title">Новых заявок</div>
                        <div class="card-value">${newTicketsCount}</div>
                    </div>
                    <div class="card">
                        <div class="card-title">Активных диалогов</div>
                        <div class="card-value">${dialogsCount}</div>
                    </div>
                    <div class="card">
                        <div class="card-title">Пользователей</div>
                        <div class="card-value">${usersCount}</div>
                    </div>
                </div>

                ${content}
            </main>
        </div>
    </body>
    </html>
    `;
}

function renderDashboardPage() {
    const lastTickets = tickets.slice().reverse().slice(0, 10);

    const rows = lastTickets.length
        ? lastTickets.map(ticket => `
            <tr>
                <td>${escapeHtml(ticket.id)}</td>
                <td>${escapeHtml(ticket.fullNameRu || "-")}</td>
                <td>${escapeHtml(ticket.phone || ticket.phoneNumber || "-")}</td>
                <td>${escapeHtml(ticket.category || "-")}</td>
                <td class="status-${escapeHtml(ticket.status || "new")}">${escapeHtml(ticket.status || "-")}</td>
                <td>${escapeHtml(formatDate(ticket.createdAt))}</td>
            </tr>
        `).join("")
        : `<tr><td colspan="6" style="padding:18px;color:#94a3b8;">Заявок пока нет</td></tr>`;

    const content = `
        <div class="section">
            <div class="section-head">
                <span>Последние заявки</span>
                <span class="muted">Всего: ${tickets.length}</span>
            </div>
            <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>ID</th>
                            <th>ФИО</th>
                            <th>Телефон</th>
                            <th>Категория</th>
                            <th>Статус</th>
                            <th>Дата</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>

        <div class="grid-2">
            <div class="section">
                <div class="section-head">Активные диалоги</div>
                <div class="mini-list">
                    ${
        conversations.size
            ? Array.from(conversations.entries()).slice(0, 10).map(([phone, state]) => `
                                <div class="mini-item">
                                    <div><b>${escapeHtml(phone)}</b></div>
                                    <div class="muted">Шаг: ${escapeHtml(state?.step || "-")}</div>
                                    <div class="muted">Режим: ${escapeHtml(state?.mode || "-")}</div>
                                </div>
                            `).join("")
            : `<div class="mini-item muted">Активных диалогов нет</div>`
    }
                </div>
            </div>

            <div class="section">
                <div class="section-head">Пользователи</div>
                <div class="mini-list">
                    ${
        Object.entries(users).slice(0, 10).map(([phone, user]) => `
                            <div class="mini-item">
                                <div><b>${escapeHtml(user?.fullNameRu || "Без имени")}</b></div>
                                <div class="muted">${escapeHtml(phone)}</div>
                                <div class="muted">${escapeHtml(user?.email || "-")}</div>
                            </div>
                        `).join("") || `<div class="mini-item muted">Пользователей нет</div>`
    }
                </div>
            </div>
        </div>

        <div class="section" style="margin-top:18px;">
            <div class="section-head">Быстрый доступ</div>
            <div class="section-body">
                <div class="stack">
                    <span class="badge">0 — выход</span>
                    <span class="badge">11 — специалист</span>
                    <span class="badge">12 — отмена заявки</span>
                    <span class="badge">email и телефон валидируются</span>
                    <span class="badge">fallback SMTP выключен</span>
                </div>
            </div>
        </div>
    `;

    return renderLayout({
        active: "dashboard",
        title: "Дашборд",
        topAction: `<a class="btn btn-primary" href="/">Открыть бот</a>`,
        content
    });
}

function renderTicketsPage() {
    const rows = tickets.slice().reverse().map(ticket => {
        const notes = Array.isArray(ticket.notes) ? ticket.notes : [];
        const lastNote = notes.length ? notes[notes.length - 1] : null;

        return `
        <tr>
            <td>${escapeHtml(getTicketSeqNumber(ticket.id))}</td>
            <td>${escapeHtml(ticket.fullNameRu || "-")}</td>
            <td>${escapeHtml(ticket.phone || ticket.phoneNumber || "-")}</td>
            <td>${escapeHtml(ticket.email || "-")}</td>
            <td>${escapeHtml(ticket.category || "-")}</td>
            <td style="max-width:260px;white-space:normal;">${escapeHtml(ticket.problem || "-")}</td>
            <td class="status-${escapeHtml(ticket.status || "new")}">${escapeHtml(ticket.status || "-")}</td>
            <td>${escapeHtml(formatDate(ticket.createdAt))}</td>
            <td style="max-width:220px;white-space:normal;">${lastNote ? escapeHtml(lastNote.text) : "-"}</td>
            <td>
                <form method="POST" action="/admin/tickets/${encodeURIComponent(ticket.id)}/status" style="display:flex;flex-direction:column;gap:6px;min-width:220px;">
                    <select name="status">
                        <option value="new" ${ticket.status === "new" ? "selected" : ""}>new</option>
                        <option value="in_progress" ${ticket.status === "in_progress" ? "selected" : ""}>in_progress</option>
                        <option value="closed" ${ticket.status === "closed" ? "selected" : ""}>closed</option>
                        <option value="specialist_chat" ${ticket.status === "specialist_chat" ? "selected" : ""}>specialist_chat</option>
                    </select>
                    <textarea name="comment" rows="2" placeholder="Комментарий пользователю (уйдёт в WhatsApp)..."></textarea>
                    <button class="btn btn-primary" type="submit">Сохранить и уведомить</button>
                </form>
            </td>
        </tr>
    `;
    }).join("");

    const content = `
        <div class="section">
            <div class="section-head">
                <span>Заявки</span>
                <span class="muted">${tickets.length}</span>
            </div>
            <div class="section-body" style="padding-top:0; padding-bottom:10px;">
                <a class="btn" href="/admin/tickets/export.csv">⬇️ Экспорт в Excel (CSV)</a>
            </div>
            <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>№</th>
                            <th>ФИО</th>
                            <th>Телефон</th>
                            <th>Email</th>
                            <th>Категория</th>
                            <th>Проблема</th>
                            <th>Статус</th>
                            <th>Дата</th>
                            <th>Последний комментарий</th>
                            <th>Действия</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows || `<tr><td colspan="10" style="padding:18px;color:#94a3b8;">Заявок пока нет</td></tr>`}
                    </tbody>
                </table>
            </div>
        </div>
    `;

    return renderLayout({
        active: "tickets",
        title: "Заявки",
        topAction: `<a class="btn" href="/admin">← Назад</a>`,
        content
    });
}

function renderDialogsPage() {
    const dialogsRows = Array.from(conversations.entries()).map(([phone, state]) => `
        <tr>
            <td>${escapeHtml(formatWhatsAppIdForDisplay(phone).display)}</td>
            <td>${escapeHtml(state?.step || "-")}</td>
            <td>${escapeHtml(state?.mode || "-")}</td>
            <td>${escapeHtml(state?.data?.fullNameRu || "-")}</td>
            <td style="white-space:nowrap;">
                <form method="POST" action="/admin/dialogs/${encodeURIComponent(phone)}/reset-to-new" style="display:inline; margin-right:8px;">
                    <button class="btn btn-primary" type="submit">📝 Новая заявка</button>
                </form>
                <form method="POST" action="/admin/dialogs/${encodeURIComponent(phone)}/delete" style="display:inline;">
                    <button class="btn btn-danger" type="submit">Закрыть</button>
                </form>
            </td>
        </tr>
    `).join("");

    const content = `
        <div class="split">
            <div class="section">
                <div class="section-head">
                    <span>Активные диалоги</span>
                    <span class="muted">${conversations.size}</span>
                </div>
                <div class="table-wrap">
                    <table>
                        <thead>
                            <tr>
                                <th>Телефон</th>
                                <th>Шаг</th>
                                <th>Режим</th>
                                <th>Имя</th>
                                <th>Действия</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${dialogsRows || `<tr><td colspan="5" style="padding:18px;color:#94a3b8;">Диалогов нет</td></tr>`}
                        </tbody>
                    </table>
                </div>
            </div>

            <div class="section">
                <div class="section-head">Отправить сообщение вручную</div>
                <div class="section-body">
                    <form method="POST" action="/admin/send-message">
                        <div class="field">
                            <label>Телефон WhatsApp</label>
                            <input name="phone" placeholder="79991234567@c.us" />
                        </div>
                        <div class="field">
                            <label>Сообщение</label>
                            <textarea name="message" placeholder="Текст сообщения..."></textarea>
                        </div>
                        <button class="btn btn-primary" type="submit">Отправить</button>
                    </form>
                    <p class="help" style="margin-top:12px;">
                        Сообщение уйдёт напрямую в WhatsApp. Формат номера лучше передавать как в чате, например <b>79991234567@c.us</b>.
                    </p>
                </div>
            </div>
        </div>
    `;

    return renderLayout({
        active: "dialogs",
        title: "Диалоги",
        topAction: `<a class="btn" href="/admin">← Назад</a>`,
        content
    });
}

function renderUsersPage(groupFilter) {
    const activeFilter = groupFilter ? String(groupFilter) : "";

    const allUsers = Object.entries(users);
    const filteredUsers = activeFilter
        ? allUsers.filter(([, user]) => {
            if (activeFilter === "__none__") {
                return !user?.companyGroupId || !companyGroups.some(g => g.id === user.companyGroupId);
            }
            return user?.companyGroupId === activeFilter;
        })
        : allUsers;

    const rows = filteredUsers.map(([phone, user]) => {
        const isExcluded = excludedUsers.some(u => u.phone === phone);

        return `
        <tr>
            <td>${escapeHtml(formatWhatsAppIdForDisplay(phone).display)}</td>
            <td>${escapeHtml(user?.fullNameRu || "-")}</td>
            <td>${escapeHtml(user?.fullNameEn || "-")}</td>
            <td>${escapeHtml(user?.email || "-")}</td>
            <td>${escapeHtml(user?.phone || "-")}</td>
            <td>${escapeHtml(user?.company || "-")}</td>
            <td>${escapeHtml(getCompanyGroupLabel(user?.companyGroupId))}</td>
            <td>${escapeHtml(user?.anyDesk || "-")}</td>
            <td style="text-align:right; white-space:nowrap;">

    <a
        class="btn"
        href="/admin/users/${encodeURIComponent(phone)}/edit"
        style="margin-right:8px;"
    >
        ✏️ Редактировать
    </a>

    ${isExcluded ? `<span class="muted" style="margin-right:8px;">🚫 в исключениях</span>` : `
    <form
        method="POST"
        action="/admin/excluded-users/add"
        style="display:inline; margin-right:8px;"
    >
        <input type="hidden" name="phone" value="${escapeHtml(phone)}">
        <input type="hidden" name="name" value="${escapeHtml(user?.fullNameRu || "")}">
        <button class="btn">🚫 В исключения</button>
    </form>
    `}

    <form
        method="POST"
        action="/admin/users/${encodeURIComponent(phone)}/delete"
        style="display:inline;"
        onsubmit="return confirm('Удалить пользователя?')"
    >
        <button class="btn">Удалить</button>
    </form>

</td>
        </tr>
    `;
    }).join("");

    const noGroupCount = allUsers.filter(([, u]) => !u?.companyGroupId || !companyGroups.some(g => g.id === u.companyGroupId)).length;

    // Панель тегов-групп, как на референсе: "Все пользователи" всегда первой,
    // дальше — каждая группа с числом пользователей, кликабельно фильтрует таблицу.
    const filterPills = [
        `<a class="group-pill ${activeFilter === "" ? "active" : ""}" href="/admin/users">Все пользователи <span class="group-pill-count">${allUsers.length}</span></a>`,
        ...companyGroups.map(group => {
            const count = allUsers.filter(([, u]) => u?.companyGroupId === group.id).length;
            return `<a class="group-pill ${activeFilter === group.id ? "active" : ""}" href="/admin/users?group=${encodeURIComponent(group.id)}">${escapeHtml(group.name)} <span class="group-pill-count">${count}</span></a>`;
        }),
        `<a class="group-pill ${activeFilter === "__none__" ? "active" : ""}" href="/admin/users?group=__none__">Без группы <span class="group-pill-count">${noGroupCount}</span></a>`
    ].join("");

    const filteredPhones = new Set(filteredUsers.map(([phone]) => phone));
    const relatedTickets = tickets
        .filter(t => filteredPhones.has(t.phone))
        .slice()
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const ticketRows = relatedTickets.map(t => {
        const notes = Array.isArray(t.notes) ? t.notes : [];
        const lastNote = notes.length ? notes[notes.length - 1] : null;

        return `
        <tr>
            <td>${escapeHtml(t.id)}</td>
            <td>${escapeHtml(t.fullNameRu || "-")}</td>
            <td>${escapeHtml(t.category || "-")}</td>
            <td style="max-width:260px;white-space:normal;">${escapeHtml(t.problem || "-")}</td>
            <td class="status-${escapeHtml(t.status || "new")}">${escapeHtml(t.status || "-")}</td>
            <td>${escapeHtml(formatDate(t.createdAt))}</td>
            <td style="max-width:220px;white-space:normal;">${lastNote ? escapeHtml(lastNote.text) : "-"}</td>
        </tr>
    `;
    }).join("");

    const content = `
        <div class="section">
            <div class="section-head">
                <span>Пользователи</span>
                <span class="muted">${filteredUsers.length}${activeFilter ? ` из ${allUsers.length}` : ""}</span>
            </div>
            <div class="section-body" style="padding-bottom:0;">
                <div class="group-filter-bar">
                    ${filterPills}
                </div>
                <a href="/admin/company-groups" class="help" style="display:inline-block; margin:10px 0 4px;">⚙️ Управление группами (добавить/переименовать/удалить)</a>
            </div>
            <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>WhatsApp</th>
                            <th>ФИО RU</th>
                            <th>Full Name EN</th>
                            <th>Email</th>
                            <th>Телефон</th>
                            <th>Компания</th>
                            <th>Группа</th>
                            <th>AnyDesk</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows || `<tr><td colspan="9" style="padding:18px;color:#94a3b8;">Пользователей нет</td></tr>`}
                    </tbody>
                </table>
            </div>
        </div>

        <div class="section" style="margin-top:20px;">
            <div class="section-head">
                <span>Заявки${activeFilter ? " — по текущему фильтру выше" : ""}</span>
                <span class="muted">${relatedTickets.length}</span>
            </div>
            <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>ID</th>
                            <th>ФИО</th>
                            <th>Категория</th>
                            <th>Проблема</th>
                            <th>Статус</th>
                            <th>Дата</th>
                            <th>Последний комментарий</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${ticketRows || `<tr><td colspan="7" style="padding:18px;color:#94a3b8;">Заявок нет</td></tr>`}
                    </tbody>
                </table>
            </div>
        </div>
    `;

    return renderLayout({
        active: "users",
        title: "Пользователи",
        topAction: `<a class="btn" href="/admin">← Назад</a>`,
        content
    });
}

function renderExcludedUsersPage() {
    const rows = excludedUsers.map(u => {
        const formatted = formatWhatsAppIdForDisplay(u.phone);
        const rowId = `wa-id-${escapeHtml(u.phone).replace(/[^a-zA-Z0-9]/g, "_")}`;
        const phoneInputId = `real-phone-${rowId}`;

        const whatsappCell = formatted.isLid
            ? `
                <span id="${rowId}">🔒 ${escapeHtml(formatted.display)}</span>
                <div class="muted" style="margin-top:4px;">не номер телефона — внутренний id WhatsApp</div>
                <button
                    type="button"
                    class="btn"
                    style="margin-top:6px; padding:4px 8px; font-size:12px;"
                    onclick="resolveWhatsAppId('${encodeURIComponent(u.phone)}', '${rowId}', '${phoneInputId}', this)"
                >
                    🔍 Попробовать узнать номер
                </button>
            `
            : escapeHtml(formatted.display);

        return `
        <tr>
            <td>${whatsappCell}</td>
            <td>
                <form method="POST" action="/admin/excluded-users/${encodeURIComponent(u.phone)}/edit" style="display:flex; flex-direction:column; gap:6px; min-width:200px;">
                    <input name="name" value="${escapeHtml(u.name || "")}" placeholder="Комментарий (например, ФИО)" />
                    <input id="${phoneInputId}" name="realPhone" value="${escapeHtml(u.realPhone || "")}" placeholder="Номер телефона (если известен)" />
                    <button class="btn" type="submit" style="align-self:flex-start; padding:4px 10px; font-size:12px;">Сохранить</button>
                </form>
            </td>
            <td>${escapeHtml(formatDate(u.addedAt))}</td>
            <td style="text-align:right; white-space:nowrap;">
                <form
                    method="POST"
                    action="/admin/excluded-users/${encodeURIComponent(u.phone)}/delete"
                    style="display:inline;"
                    onsubmit="return confirm('Убрать номер из списка исключений? Бот снова начнёт отвечать этому пользователю.')"
                >
                    <button class="btn">Убрать из исключений</button>
                </form>
            </td>
        </tr>
    `;
    }).join("");

    const content = `
        <div class="section">
            <div class="section-head">
                <span>🚫 Список исключений</span>
                <span class="muted">${excludedUsers.length}</span>
            </div>
            <div class="section-body">
                <p class="muted" style="margin-top:0;">
                    Бот не будет обрабатывать сообщения от номеров из этого списка —
                    входящие сообщения будут просто игнорироваться (без ответа и без создания заявок).
                </p>
                <p class="muted" style="margin-top:0;">
                    Номер можно добавить <b>заранее, до того как человек впервые напишет боту</b> —
                    регистрация не требуется. Форматы <b>87051234567</b>, <b>+77051234567</b> и
                    <b>77051234567</b> считаются одним и тем же номером.
                </p>
                <p class="muted" style="margin-top:0;">
                    🔒 Если вместо номера видите "LID <длинные цифры>" — это не номер телефона,
                    а внутренний идентификатор WhatsApp (используется для части контактов вместо
                    настоящего номера). Кнопка "Попробовать узнать номер" делает запрос к WhatsApp —
                    иногда номер удаётся получить, иногда WhatsApp его принципиально не раскрывает.
                </p>

                <form method="POST" action="/admin/excluded-users/add">
                    <div class="field">
                        <label>Номер WhatsApp</label>
                        <input
                            name="phone"
                            placeholder="79991234567 или 79991234567@c.us"
                            required
                        >
                    </div>
                    <div class="field">
                        <label>Комментарий (например, ФИО) — необязательно</label>
                        <input name="name" placeholder="Например: Иванов И.И.">
                    </div>
                    <div class="field">
                        <label>Номер телефона (если известен) — необязательно</label>
                        <input name="realPhone" placeholder="Например: +77051234567">
                    </div>
                    <button class="btn btn-primary" type="submit">Добавить в исключения</button>
                </form>
            </div>

            <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>WhatsApp</th>
                            <th>Комментарий / Телефон</th>
                            <th>Добавлен</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows || `<tr><td colspan="4" style="padding:18px;color:#94a3b8;">Список исключений пуст</td></tr>`}
                    </tbody>
                </table>
            </div>
        </div>

        <script>
            async function resolveWhatsAppId(encodedId, targetElId, phoneInputId, buttonEl) {
                buttonEl.disabled = true;
                const prevText = buttonEl.textContent;
                buttonEl.textContent = "⏳ Ищу...";

                try {
                    const res = await fetch("/admin/resolve-whatsapp-id/" + encodedId);
                    const data = await res.json();
                    const target = document.getElementById(targetElId);

                    if (data.ok && data.number) {
                        target.textContent = "✅ +" + data.number;
                        buttonEl.remove();

                        const phoneInput = document.getElementById(phoneInputId);
                        if (phoneInput) {
                            phoneInput.value = data.number;
                        }

                        // Сохраняем найденный номер сразу же, не дожидаясь,
                        // пока администратор сам нажмёт "Сохранить" в форме.
                        try {
                            await fetch("/admin/excluded-users/" + encodedId + "/edit", {
                                method: "POST",
                                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                                body: "realPhone=" + encodeURIComponent(data.number)
                            });
                        } catch (saveError) {
                            console.error("Не удалось автосохранить номер:", saveError);
                        }
                    } else {
                        buttonEl.textContent = prevText;
                        buttonEl.disabled = false;
                        alert(data.error || "Не удалось определить номер.");
                    }
                } catch (error) {
                    buttonEl.textContent = prevText;
                    buttonEl.disabled = false;
                    alert("Ошибка запроса: " + error.message);
                }
            }
        </script>
    `;

    return renderLayout({
        active: "excluded",
        title: "Список исключений",
        topAction: `<a class="btn" href="/admin/users">← Все пользователи</a>`,
        content
    });
}

function renderCompanyGroupsPage() {
    const usersList = Object.values(users);

    const noGroupCount = usersList.filter(u => !u?.companyGroupId || !companyGroups.some(g => g.id === u.companyGroupId)).length;

    const rows = companyGroups.map(group => {
        const count = usersList.filter(u => u?.companyGroupId === group.id).length;
        const keywordsText = (group.keywords || []).join(", ");

        return `
        <tr>
            <td style="min-width:220px;">
                <form method="POST" action="/admin/company-groups/${encodeURIComponent(group.id)}/edit" style="display:flex; flex-direction:column; gap:8px;">
                    <input name="name" value="${escapeHtml(group.name)}" placeholder="Название группы" />
                    <input name="keywords" value="${escapeHtml(keywordsText)}" placeholder="ключевые слова через запятую" />
                    <button class="btn btn-primary" type="submit">Сохранить</button>
                </form>
            </td>
            <td style="text-align:center;">${count}</td>
            <td style="text-align:right; white-space:nowrap;">
                <form method="POST" action="/admin/company-groups/${encodeURIComponent(group.id)}/delete" onsubmit="return confirm('Удалить группу «${escapeHtml(group.name)}»? Пользователи из неё станут «Без группы» (или попадут в другую подходящую группу).')">
                    <button class="btn" style="color:#ef4444; border-color:#ef4444; background:none;">❌ Удалить</button>
                </form>
            </td>
        </tr>
    `;
    }).join("");

    const content = `
        <div class="section">
            <div class="section-head">
                <span>🏷️ Группы компаний</span>
                <span class="muted">${companyGroups.length}</span>
            </div>
            <div class="section-body">
                <p class="help" style="margin-top:0;">
                    При регистрации и при любом изменении анкеты бот проверяет поле "Компания" —
                    если оно содержит одно из ключевых слов группы (без учёта регистра, как часть текста),
                    пользователь попадает в эту группу. Если совпадений нет — пользователь остаётся
                    в статусе <b>«Без группы»</b>. При пересечении правил разных групп побеждает
                    группа, стоящая в списке выше.
                </p>

                <form method="POST" action="/admin/company-groups/add" style="display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end; margin-bottom:20px; padding:15px; background:#0f1117; border-radius:8px;">
                    <div class="field" style="flex:1; min-width:180px; margin:0;">
                        <label>Название группы</label>
                        <input name="name" placeholder="Например: Ромашка Групп" required />
                    </div>
                    <div class="field" style="flex:2; min-width:220px; margin:0;">
                        <label>Ключевые слова (через запятую)</label>
                        <input name="keywords" placeholder="Например: ромашка, romashka" required />
                    </div>
                    <button class="btn btn-primary" type="submit">Добавить группу</button>
                </form>
            </div>

            <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>Группа / ключевые слова</th>
                            <th style="text-align:center;">Пользователей</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows || `<tr><td colspan="3" style="padding:18px;color:#94a3b8;">Групп пока нет</td></tr>`}
                        <tr>
                            <td class="muted">Без группы (не подошло ни одно правило)</td>
                            <td style="text-align:center;" class="muted">${noGroupCount}</td>
                            <td></td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
    `;

    return renderLayout({
        active: "company-groups",
        title: "Группы компаний",
        topAction: `<a class="btn" href="/admin/users">← Все пользователи</a>`,
        content
    });
}

function renderMessagesPage() {
    const t = settings.texts || {};
    const fields = [
        ["startNewUser", "Старт нового пользователя"],
        ["askFullNameEn", "ФИО на английском"],
        ["askPosition", "Должность"],
        ["askCompany", "Компания"],
        ["askEmail", "Запрос email"],
        ["askPhone", "Запрос телефона"],
        ["askProblem", "Запрос описания проблемы"],
        ["invalidEmail", "Ошибка email"],
        ["invalidPhone", "Ошибка телефона"],
        ["invalidChoice", "Ошибка выбора"],
        ["exitInfo", "Подсказка выхода"],
        ["cancelInfo", "Подсказка отмены"],
        ["specialistIntro", "Чат со специалистом"],
        ["specialistInfo", "Подсказка чата"],
        ["ticketSuccess", "Успешная заявка"],
        ["ticketMailFail", "Ошибка отправки письма"],
        ["registeredProblemIntro", "Проблема после регистрации"],
        ["categoryMenuIntro", "Вступление меню категорий"],
        ["categoryMenuFooter", "Футер меню категорий"],
        ["category1SubIntro", "Подменю категории 1 (Доступы/пароли)"],
        ["telegramResetInfo", "Ссылка на Telegram-бот сброса пароля"],
        ["telegramResetMissing", "Если Telegram-бот не настроен"],
        ["category1SubInvalid", "Ошибка выбора в подменю категории 1"]
    ];

    const inputs = fields.map(([key, label]) => `
        <div class="field">
            <label>${escapeHtml(label)}</label>
            <textarea name="${escapeHtml(key)}">${escapeHtml(t[key] || "")}</textarea>
        </div>
    `).join("");

    const content = `
        <div class="section">
            <div class="section-head">Тексты сообщений бота</div>
            <div class="section-body">
                <form method="POST" action="/admin/settings">
                    <input type="hidden" name="section" value="messages" />
                    <div class="grid-1">
                        ${inputs}
                    </div>
                    <button class="btn btn-primary" type="submit">Сохранить тексты</button>
                </form>
            </div>
        </div>
    `;

    return renderLayout({
        active: "messages",
        title: "Сообщения",
        topAction: `<a class="btn" href="/admin">← Назад</a>`,
        content
    });
}

function renderCategoriesPage() {
    const categoryFields = Object.entries(settings.categories || {}).sort((a, b) => Number(a[0]) - Number(b[0]));

    const content = `
        <div class="section">
            <div class="section-head">Категории и меню</div>
            <div class="section-body">
                <p class="help" style="margin-top:0;">
                    Пункты <b>11</b>, <b>12</b> и <b>13</b> зарезервированы под "Чат со специалистом",
                    "Отмена заявки" и "Посмотреть статус заявок" — их нельзя редактировать или удалять.
                    Пункт <b>0</b> зарезервирован под выход из диалога.
                    Категория <b>1</b> (Доступы/пароли) при выборе показывает дополнительное подменю
                    (сброс пароля через Telegram-бот / заявка на доступ) — эта логика не зависит от текста категории.
                </p>

                <!--
                    Важно: форма сохранения категорий НЕ оборачивает мини-формы удаления —
                    вложенные <form> внутри <form> невалидны в HTML и браузер путал,
                    какую именно форму отправлять (из-за этого не работало "Сохранить категории").
                    Вместо вложенности поля привязаны к этой форме через атрибут form="categoriesForm".
                -->
                <form id="categoriesForm" method="POST" action="/admin/settings">
                    <input type="hidden" name="section" value="categories" />
                </form>

                <div class="grid-1">
                    ${categoryFields.map(([key, value]) => {
                        const isReserved = RESERVED_CATEGORY_KEYS.has(key);
                        return `
                        <div class="field">
                            <label>Категория ${escapeHtml(key)} ${isReserved ? "🔒" : ""}</label>
                            <div style="display:flex; gap:10px;">
                                <input
                                    name="category_${escapeHtml(key)}"
                                    value="${escapeHtml(value)}"
                                    style="flex:1;"
                                    form="categoriesForm"
                                    ${isReserved ? "disabled" : ""}
                                />
                                ${isReserved
                                    ? `<span class="muted" style="white-space:nowrap; align-self:center;">зарезервировано</span>`
                                    : `<form method="POST" action="/admin/categories/${encodeURIComponent(key)}/delete" style="margin:0;" onsubmit="return confirm('Удалить категорию?')">
                                        <button type="submit" class="btn" style="color:#ef4444; border-color:#ef4444; background:none;">❌</button>
                                    </form>`
                                }
                            </div>
                        </div>
                    `;
                    }).join("")}
                    <div class="field" style="margin-top:20px; padding:15px; background:#0f1117; border-radius:8px;">
                        <label style="color:#64748b; font-weight:600;">Добавить новую категорию</label>
                        <div style="display:flex; gap:10px; margin-top:8px;">
                            <input name="new_category_key" placeholder="ID (например 14)" style="width:120px;" form="categoriesForm" />
                            <input name="new_category_value" placeholder="Название категории" style="flex:1;" form="categoriesForm" />
                        </div>
                        <p class="help" style="margin-top:8px;">
                            Нельзя использовать ID 0, 11, 12 или 13 — они зарезервированы системой.
                        </p>
                    </div>
                    <button class="btn btn-primary" type="submit" form="categoriesForm" style="margin-top:20px;">Сохранить категории</button>
                </div>
            </div>
        </div>
    `;

    return renderLayout({
        active: "categories",
        title: "Категории",
        topAction: `<a class="btn" href="/admin">← Назад</a>`,
        content
    });
}

function renderSettingsPage() {
    const content = `
        <div class="section">
            <div class="section-head">SMTP и общие настройки</div>
            <div class="section-body">
                <form method="POST" action="/admin/settings">
                    <input type="hidden" name="section" value="general" />

                    <div class="form-grid">
                        <div class="field">
                            <label>Куда отправлять заявки (To)</label>
                            <input name="ticketToEmail" value="${escapeHtml(settings.ticketToEmail || "")}" />
                        </div>
                        <div class="field">
                            <label>Резервный отправитель (From Fallback)</label>
                            <input name="fallbackFromEmail" value="${escapeHtml(settings.fallbackFromEmail || "")}" />
                        </div>
                        <div class="field">
                            <label>SMTP Host</label>
                            <input name="smtpHost" value="${escapeHtml(settings.smtpHost || "")}" placeholder="${escapeHtml(process.env.SMTP_HOST || "")}" />
                        </div>
                        <div class="field">
                            <label>SMTP Port</label>
                            <input name="smtpPort" value="${escapeHtml(settings.smtpPort || "")}" placeholder="${escapeHtml(process.env.SMTP_PORT || "587")}" />
                        </div>
                        <div class="field">
                            <label>SMTP User</label>
                            <input name="smtpUser" value="${escapeHtml(settings.smtpUser || "")}" placeholder="${escapeHtml(process.env.SMTP_USER || "")}" />
                        </div>
                        <div class="field">
                            <label>SMTP Password</label>
                            <input name="smtpPass" type="password" value="${escapeHtml(settings.smtpPass || "")}" />
                        </div>
                        <div class="field">
                            <label>SMTP Secure (TLS)</label>
                            <select name="smtpSecure">
                                <option value="true" ${settings.smtpSecure === true ? "selected" : ""}>Да (SSL/TLS)</option>
                                <option value="false" ${settings.smtpSecure === false ? "selected" : ""}>Нет (STARTTLS/Plain)</option>
                            </select>
                        </div>
                        <div class="field">
                            <label>Telegram-бот сброса пароля (username без @)</label>
                            <input name="telegramResetBotUsername" value="${escapeHtml(settings.telegramResetBotUsername || "")}" placeholder="reset_password_bot" />
                        </div>
                        <div class="field">
                            <label>Доверенные домены почты (по одному на строку)</label>
                            <textarea name="trustedEmailDomains" rows="3" placeholder="almaly.kz">${escapeHtml((settings.trustedEmailDomains || []).join("\n"))}</textarea>
                            <p class="help" style="margin-top:6px;">
                                Если почта пользователя оканчивается на один из этих доменов (включая поддомены) —
                                заявка в osTicket уходит от имени пользователя, поле "Режим" = wppservice.
                                Иначе — от имени бота, "Режим" = ticketBot.
                            </p>
                        </div>
                        <div class="field">
                            <label>Фраза закрытия заявки через WhatsApp Business</label>
                            <textarea name="closeTicketTriggerText" rows="2">${escapeHtml(settings.closeTicketTriggerText || "")}</textarea>
                            <p class="help" style="margin-top:6px;">
                                Если оператор отправит пользователю ровно эту фразу вручную через сам
                                WhatsApp Business (например, настроив её как быстрый ответ <b>/end</b>) —
                                последняя незакрытая заявка этого номера автоматически станет "closed".
                                Регистр и лишние пробелы не важны, но текст должен совпадать полностью.
                            </p>
                        </div>
                        <div class="field">
                            <label>Автозакрытие чата со специалистом (часов бездействия)</label>
                            <input name="specialistChatTimeoutHours" value="${escapeHtml(settings.specialistChatTimeoutHours ?? "")}" placeholder="24" />
                            <p class="help" style="margin-top:6px;">
                                Если ни пользователь, ни оператор не написали ничего дольше этого времени,
                                чат со специалистом закрывается автоматически, и следующее сообщение
                                пользователя начнёт новую заявку. Проверяется каждые 30 минут.
                                0 или пусто — автозакрытие выключено.
                            </p>
                        </div>
                        <div class="field">
                            <label>Период тишины после закрытия заявки (минут)</label>
                            <input name="ticketClosedSilenceMinutes" value="${escapeHtml(settings.ticketClosedSilenceMinutes ?? "")}" placeholder="5" />
                            <p class="help" style="margin-top:6px;">
                                Пока не истёк этот срок после закрытия заявки, бот не отвечает
                                на обычные сообщения этого номера (например "спасибо") — чтобы
                                это не запускало новую заявку/регистрацию. Команды <b>новая заявка</b>,
                                <b>меню</b> или <b>старт</b> обходят этот период. 0 или пусто — выключено.
                            </p>
                        </div>
                        <div class="field">
                            <label>Текст письма-уведомления при закрытии заявки через WhatsApp Business</label>
                            <textarea name="closeTicketNotificationEmailText" rows="2">${escapeHtml(settings.closeTicketNotificationEmailText || "")}</textarea>
                            <p class="help" style="margin-top:6px;">
                                Когда срабатывает фраза закрытия заявки (поле выше), помимо закрытия
                                заявки внутри бота на <b>Куда отправлять заявки (To)</b> уходит ещё одно
                                письмо с этим текстом — чтобы сотрудник поддержки увидел в osTicket,
                                что обращение уже отработано через WhatsApp, и закрыл заявку и там.
                            </p>
                        </div>
                        <div class="field">
                            <label>Фраза отключения бота (добавление в исключения) через WhatsApp Business</label>
                            <textarea name="excludeUserTriggerText" rows="2">${escapeHtml(settings.excludeUserTriggerText || "")}</textarea>
                            <p class="help" style="margin-top:6px;">
                                Если оператор отправит пользователю ровно эту фразу напрямую через
                                WhatsApp Business (например, настроив её как быстрый ответ
                                <b>/Список исключений</b>) — номер автоматически добавится в исключения.
                                Работает даже если пользователь ещё не зарегистрирован в системе.
                            </p>
                        </div>
                        <div class="field">
                            <label>Фраза включения бота обратно (удаление из исключений) через WhatsApp Business</label>
                            <textarea name="includeUserTriggerText" rows="2">${escapeHtml(settings.includeUserTriggerText || "")}</textarea>
                            <p class="help" style="margin-top:6px;">
                                Если оператор отправит пользователю ровно эту фразу напрямую через
                                WhatsApp Business (например, настроив её как быстрый ответ
                                <b>/Активировать бота в чате</b>) — номер уберётся из исключений,
                                и бот снова начнёт отвечать этому пользователю.
                            </p>
                        </div>
                    </div>

                    <div class="quick-box">
                        <div class="stack">
                            <span class="badge">0 — выход</span>
                            <span class="badge">11 — специалист</span>
                            <span class="badge">12 — отмена</span>
                        </div>
                        <p class="help" style="margin-top:12px;">
                            Для вашего сервера SMTP AUTH отключён — поэтому отправка работает без блока auth.
                        </p>
                    </div>

                    <button class="btn btn-primary" type="submit">Сохранить настройки</button>
                </form>
            </div>
        </div>
    `;

    return renderLayout({
        active: "settings",
        title: "Настройки",
        topAction: `<a class="btn" href="/admin">← Назад</a>`,
        content
    });
}
function renderEditUserPage(phone, user) {

    const content = `
        <div class="section">
            <div class="section-head">
                Редактирование пользователя
            </div>

            <div class="section-body">

                <form method="POST"
                      action="/admin/users/${encodeURIComponent(phone)}/edit">

                    <div class="field">
                        <label>ФИО RU</label>
                        <input name="fullNameRu"
                               value="${escapeHtml(user.fullNameRu || "")}">
                    </div>

                    <div class="field">
                        <label>ФИО EN</label>
                        <input name="fullNameEn"
                               value="${escapeHtml(user.fullNameEn || "")}">
                    </div>

                    <div class="field">
                        <label>Должность</label>
                        <input name="position"
                               value="${escapeHtml(user.position || "")}">
                    </div>

                    <div class="field">
                        <label>Компания</label>
                        <input name="company"
                               value="${escapeHtml(user.company || "")}">
                    </div>

                    <div class="field">
                        <label>Email</label>
                        <input name="email"
                               value="${escapeHtml(user.email || "")}">
                    </div>

                    <div class="field">
                        <label>Телефон</label>
                        <input name="phone"
                               value="${escapeHtml(user.phone || "")}">
                    </div>

                    <div class="field">
                        <label>AnyDesk</label>
                        <input name="anyDesk"
                               value="${escapeHtml(user.anyDesk || "")}"
                               placeholder="Например: 123 456 789">
                    </div>

                    <button class="btn btn-primary" type="submit">
                        Сохранить
                    </button>

                </form>

            </div>
        </div>
    `;

    return renderLayout({
        active: "users",
        title: "Редактирование пользователя",
        content
    });
}
// --------------------------------------------------
// Routes
// --------------------------------------------------
app.get("/", (req, res) => {
    res.redirect("/admin");
});

app.get("/admin/bot-status", (req, res) => {
    res.json({
        isReady,
        botStatus,
        qrImage
    });
});

// Пытается узнать настоящий номер телефона по WhatsApp id — актуально для
// "LID"-контактов (id вида "<цифры>@lid"), где сами цифры номером не
// являются. Успех не гарантирован: часть LID-контактов WhatsApp
// принципиально не раскрывает номер через API (это защита приватности,
// например для участников сообществ) — тогда возвращаем понятную причину,
// а не молча показываем тот же LID.
app.get("/admin/resolve-whatsapp-id/:id", async (req, res) => {
    const id = decodeURIComponent(req.params.id);

    if (!isReady || !client) {
        return res.json({ ok: false, error: "WhatsApp не подключен" });
    }

    try {
        const contact = await client.getContactById(id);
        const lidUser = id.split("@")[0];

        const candidate = [contact?.number, contact?.id?.user]
            .map(v => String(v || "").trim())
            .find(v => v && /^\d+$/.test(v) && v !== lidUser);

        if (candidate) {
            return res.json({ ok: true, number: candidate });
        }

        return res.json({ ok: false, error: "WhatsApp не раскрывает номер для этого контакта" });
    } catch (error) {
        res.json({ ok: false, error: error.message });
    }
});

app.get("/admin", (req, res) => {
    res.send(renderDashboardPage());
});

app.get("/admin/tickets", (req, res) => {
    res.send(renderTicketsPage());
});

// Экспорт заявок в CSV (открывается Excel'ем как обычная таблица).
// Специально не используется отдельная npm-библиотека для "настоящего" .xlsx —
// CSV не требует новых зависимостей и открывается Excel/LibreOffice без проблем.
function csvCell(value) {
    const text = String(value ?? "");
    // Если в значении есть запятая, кавычка или перенос строки — оборачиваем
    // в кавычки и экранируем внутренние кавычки удвоением (стандарт CSV).
    if (/[",\n;]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
}

app.get("/admin/tickets/export.csv", (req, res) => {
    const header = [
        "№", "ФИО", "Full Name", "Должность", "Компания", "Телефон", "Email",
        "AnyDesk", "Категория", "Проблема", "Статус", "Дата создания", "Последний комментарий"
    ];

    const lines = [header.map(csvCell).join(";")];

    tickets.forEach(ticket => {
        const notes = Array.isArray(ticket.notes) ? ticket.notes : [];
        const lastNote = notes.length ? notes[notes.length - 1] : null;

        lines.push([
            getTicketSeqNumber(ticket.id),
            ticket.fullNameRu || "",
            ticket.fullNameEn || "",
            ticket.position || "",
            ticket.company || "",
            ticket.phone || ticket.phoneNumber || "",
            ticket.email || "",
            ticket.anyDesk || "",
            ticket.category || "",
            ticket.problem || "",
            getStatusLabel(ticket.status),
            formatDate(ticket.createdAt),
            lastNote ? lastNote.text : ""
        ].map(csvCell).join(";"));
    });

    // \uFEFF — BOM, без него Excel на Windows показывает кириллицу кракозябрами.
    const csvContent = "\uFEFF" + lines.join("\r\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="tickets-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csvContent);
});

app.get("/admin/dialogs", (req, res) => {
    res.send(renderDialogsPage());
});

app.get("/admin/users", (req, res) => {
    res.send(renderUsersPage(req.query.group));
});
app.get("/admin/users/:phone/edit", (req, res) => {

    const phone = decodeURIComponent(req.params.phone);
    const user = users[phone];

    if (!user) {
        return res.redirect("/admin/users");
    }

    res.send(
        renderEditUserPage(phone, user)
    );
});
app.get("/admin/company-groups", (req, res) => {
    res.send(renderCompanyGroupsPage());
});

app.get("/admin/excluded-users", (req, res) => {
    res.send(renderExcludedUsersPage());
});

app.get("/admin/messages", (req, res) => {
    res.send(renderMessagesPage());
});

app.get("/admin/categories", (req, res) => {
    res.send(renderCategoriesPage());
});

app.get("/admin/settings", (req, res) => {
    res.send(renderSettingsPage());
});

app.post("/admin/tickets/:id/status", async (req, res) => {
    const ticketId = String(req.params.id);
    const status = String(req.body.status || "").trim();
    const comment = String(req.body.comment || "").trim();

    const ticket = tickets.find(t => String(t.id) === ticketId);

    if (ticket && ["new", "in_progress", "closed", "specialist_chat"].includes(status)) {
        const statusChanged = ticket.status !== status;
        ticket.status = status;

        if (statusChanged && status === "closed") {
            ticket.closedAt = new Date().toISOString();
        }

        if (comment) {
            ticket.notes = ticket.notes || [];
            ticket.notes.push({
                at: new Date().toISOString(),
                text: comment,
                author: "admin"
            });
        }

        saveTickets();

        // Пользователь получает уведомление в WhatsApp, если оставлен
        // комментарий, либо если заявка только что переведена в "closed".
        if (comment || (statusChanged && status === "closed")) {
            await notifyUserAboutTicket(ticket, comment);
        }
    }

    res.redirect("/admin/tickets");
});

app.post("/admin/dialogs/:phone/delete", (req, res) => {
    const phone = decodeURIComponent(req.params.phone);
    conversations.delete(phone);
    saveConversations();
    res.redirect("/admin/dialogs");
});

// Оператор принудительно завершает текущий диалог (специалист/ожидание
// выбора/что угодно) и сразу переводит бота в обычный режим новой заявки —
// пользователю сразу приходит стандартное приветствие бота, без необходимости
// самому выбирать "1" в меню.
app.post("/admin/dialogs/:phone/reset-to-new", async (req, res) => {
    const phone = decodeURIComponent(req.params.phone);

    try {
        await resetConversationToStart(phone, users[phone] || null);
    } catch (error) {
        console.error("Ошибка сброса диалога в новую заявку:", error.message);
    }

    res.redirect("/admin/dialogs");
});

// Раньше здесь удалялась только анкета (users[phone]) — диалог
// (conversations[phone]) не трогался. Из-за этого, если у номера оставалось
// незавершённое состояние (например, "cancelMenu" или любой шаг анкеты),
// бот на следующее сообщение продолжал СТАРЫЙ диалог с уже введёнными
// данными из этого состояния — снаружи выглядело так, будто удаление
// пользователя вообще ничего не сделало. Теперь при удалении сбрасывается
// и диалог — следующее сообщение с этого номера начинает регистрацию
// с чистого листа, как для нового клиента. Заявки (tickets) НЕ удаляются —
// это исторический след обращений, который должен сохраняться независимо
// от того, что происходит с профилем. Всё это подробно логируется в
// консоль (а значит и в лог сервиса NSSM) — на случай разбирательств,
// кто и когда удалил профиль и что именно было удалено.
app.post("/admin/users/:phone/delete", (req, res) => {
    const phone = decodeURIComponent(req.params.phone);

    const deletedProfile = users[phone] || null;
    const hadConversation = conversations.has(phone);
    const conversationSnapshot = hadConversation ? conversations.get(phone) : null;
    const ticketCount = tickets.filter(t => t.phone === phone).length;

    delete users[phone];
    saveUsers();

    conversations.delete(phone);
    saveConversations();

    console.log(
        `[ADMIN] Удалён пользователь ${phone} (${new Date().toISOString()}).\n` +
        `  Анкета до удаления: ${JSON.stringify(deletedProfile)}\n` +
        `  Диалог сброшен: ${hadConversation ? "да, был на шаге \"" + (conversationSnapshot?.step || "?") + "\"" : "нет, диалога не было"}\n` +
        `  Заявки (tickets) НЕ удалены, оставлено записей: ${ticketCount}`
    );

    res.redirect("/admin/users");
});

// Раньше у формы редактирования пользователя (/admin/users/:phone/edit)
// не было обработчика POST — сохранение никуда не отправлялось.
app.post("/admin/users/:phone/edit", (req, res) => {
    const phone = decodeURIComponent(req.params.phone);

    if (!users[phone]) {
        return res.redirect("/admin/users");
    }

    // Для разбирательств ("кто и что поменял в анкете") логируем в консоль
    // (а значит и в лог сервиса NSSM) полный снимок анкеты до и после
    // правки — см. такое же логирование в /admin/users/:phone/delete.
    const before = { ...users[phone] };

    users[phone] = {
        ...users[phone],
        fullNameRu: String(req.body.fullNameRu || "").trim(),
        fullNameEn: String(req.body.fullNameEn || "").trim(),
        position: String(req.body.position || "").trim(),
        company: String(req.body.company || "").trim(),
        email: String(req.body.email || "").trim(),
        phone: String(req.body.phone || "").trim(),
        anyDesk: String(req.body.anyDesk || "").trim()
    };
    assignCompanyGroup(users[phone]);

    saveUsers();

    console.log(
        `[ADMIN] Изменена анкета пользователя ${phone} (${new Date().toISOString()}).\n` +
        `  До: ${JSON.stringify(before)}\n` +
        `  После: ${JSON.stringify(users[phone])}`
    );

    res.redirect("/admin/users");
});

function parseKeywords(raw) {
    return String(raw || "")
        .split(",")
        .map(k => k.trim())
        .filter(Boolean);
}

app.post("/admin/company-groups/add", (req, res) => {
    const name = String(req.body.name || "").trim();
    const keywords = parseKeywords(req.body.keywords);

    if (name && keywords.length) {
        companyGroups.push({
            id: Date.now().toString(),
            name,
            keywords
        });
        saveCompanyGroups();
        recomputeAllCompanyGroups();
    }

    res.redirect("/admin/company-groups");
});

app.post("/admin/company-groups/:id/edit", (req, res) => {
    const id = String(req.params.id);
    const group = companyGroups.find(g => g.id === id);

    if (group) {
        group.name = String(req.body.name || "").trim() || group.name;
        group.keywords = parseKeywords(req.body.keywords);
        saveCompanyGroups();
        recomputeAllCompanyGroups();
    }

    res.redirect("/admin/company-groups");
});

app.post("/admin/company-groups/:id/delete", (req, res) => {
    const id = String(req.params.id);
    companyGroups = companyGroups.filter(g => g.id !== id);
    saveCompanyGroups();
    recomputeAllCompanyGroups();
    res.redirect("/admin/company-groups");
});

app.post("/admin/excluded-users/add", (req, res) => {
    const phone = normalizeWhatsAppId(req.body.phone);
    const name = String(req.body.name || "").trim();
    const realPhone = String(req.body.realPhone || "").trim();

    addExcludedUser(phone, name, realPhone);

    res.redirect("/admin/excluded-users");
});

// Правка комментария и/или "настоящего" номера у уже существующей записи в
// исключениях — нужно в первую очередь для LID-контактов (см.
// formatWhatsAppIdForDisplay), у которых сам WhatsApp id номером не
// является: администратор может вписать номер вручную, если знает его, а
// кнопка "Попробовать узнать номер" на странице сохраняет сюда же
// автоматически, если WhatsApp согласится его раскрыть.
app.post("/admin/excluded-users/:phone/edit", (req, res) => {
    const phone = decodeURIComponent(req.params.phone);
    const entry = excludedUsers.find(u => u.phone === phone);

    if (entry) {
        if (typeof req.body.name !== "undefined") {
            entry.name = String(req.body.name || "").trim();
        }
        if (typeof req.body.realPhone !== "undefined") {
            entry.realPhone = String(req.body.realPhone || "").trim();
        }
        saveExcludedUsers();
    }

    res.redirect("/admin/excluded-users");
});

app.post("/admin/excluded-users/:phone/delete", (req, res) => {
    const phone = decodeURIComponent(req.params.phone);
    removeExcludedUser(phone);
    res.redirect("/admin/excluded-users");
});

app.post("/admin/categories/:key/delete", (req, res) => {
    const key = String(req.params.key);

    if (RESERVED_CATEGORY_KEYS.has(key)) {
        return res.status(403).send("Нельзя удалить зарезервированную категорию (0, 11, 12)");
    }

    delete settings.categories[key];
    saveSettings();
    res.redirect("/admin/categories");
});

app.post("/admin/send-message", async (req, res) => {
    const phone = String(req.body.phone || "").trim();
    const messageText = String(req.body.message || "").trim();

    if (!phone || !messageText) {
        return res.redirect("/admin/dialogs");
    }

    try {
        await client.sendMessage(phone, messageText);

        // Ручное сообщение оператора — такое же "вмешательство человека",
        // как и комментарий к заявке: следующий ответ пользователя не
        // должен попасть в обычный сценарий бота. Привязываем к последней
        // заявке этого номера, если она есть (нужно для notes в
        // handleSpecialistMode при выборе "11").
        const relatedTicket = tickets
            .slice()
            .reverse()
            .find(t => t.phone === phone);

        setAwaitingOperatorChoice(phone, relatedTicket ? relatedTicket.id : null);
    } catch (error) {
        console.error("Ошибка ручной отправки сообщения:", error.message);
    }

    res.redirect("/admin/dialogs");
});

app.post("/admin/settings", (req, res) => {
    const section = String(req.body.section || "general");

    if (section === "general") {
        settings.ticketToEmail = String(req.body.ticketToEmail || "").trim();
        settings.fallbackFromEmail = String(req.body.fallbackFromEmail || "").trim();
        settings.smtpHost = String(req.body.smtpHost || "").trim();
        settings.smtpPort = String(req.body.smtpPort || "").trim();
        settings.smtpUser = String(req.body.smtpUser || "").trim();
        settings.smtpPass = String(req.body.smtpPass || "").trim();
        settings.smtpSecure = req.body.smtpSecure === "true";
        settings.telegramResetBotUsername = String(req.body.telegramResetBotUsername || "").trim().replace(/^@/, "");

        settings.trustedEmailDomains = String(req.body.trustedEmailDomains || "")
            .split(/[\n,;]+/)
            .map(d => d.trim().toLowerCase().replace(/^@/, ""))
            .filter(Boolean);

        if (typeof req.body.closeTicketTriggerText !== "undefined") {
            settings.closeTicketTriggerText = String(req.body.closeTicketTriggerText || "").trim();
        }

        if (typeof req.body.closeTicketNotificationEmailText !== "undefined") {
            settings.closeTicketNotificationEmailText = String(req.body.closeTicketNotificationEmailText || "").trim();
        }

        if (typeof req.body.specialistChatTimeoutHours !== "undefined") {
            const parsed = Number(String(req.body.specialistChatTimeoutHours || "").trim());
            settings.specialistChatTimeoutHours = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
        }

        if (typeof req.body.ticketClosedSilenceMinutes !== "undefined") {
            const parsed = Number(String(req.body.ticketClosedSilenceMinutes || "").trim());
            settings.ticketClosedSilenceMinutes = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
        }

        if (typeof req.body.excludeUserTriggerText !== "undefined") {
            settings.excludeUserTriggerText = String(req.body.excludeUserTriggerText || "").trim();
        }

        if (typeof req.body.includeUserTriggerText !== "undefined") {
            settings.includeUserTriggerText = String(req.body.includeUserTriggerText || "").trim();
        }

        updateTransporter();
    }

    const textKeys = [
        "startNewUser",
        "askFullNameEn",
        "askPosition",
        "askCompany",
        "askEmail",
        "askPhone",
        "askProblem",
        "invalidEmail",
        "invalidPhone",
        "invalidChoice",
        "exitInfo",
        "cancelInfo",
        "specialistIntro",
        "specialistInfo",
        "ticketSuccess",
        "ticketMailFail",
        "registeredProblemIntro",
        "categoryMenuIntro",
        "categoryMenuFooter",
        "category1SubIntro",
        "telegramResetInfo",
        "telegramResetMissing",
        "category1SubInvalid"
    ];

    for (const key of textKeys) {
        if (typeof req.body[key] !== "undefined") {
            settings.texts[key] = String(req.body[key] ?? "");
        }
    }

    // Категории 0, 11, 12 зарезервированы — их текст нельзя менять через форму,
    // даже если поле придёт в запросе (например, вручную собранным POST).
    for (const key of Object.keys(settings.categories || {})) {
        if (RESERVED_CATEGORY_KEYS.has(key)) continue;

        const formKey = `category_${key}`;
        if (typeof req.body[formKey] !== "undefined") {
            settings.categories[key] = String(req.body[formKey] ?? "");
        }
    }

    const newKey = String(req.body.new_category_key || "").trim();
    const newValue = String(req.body.new_category_value || "").trim();
    if (
        newKey &&
        newValue &&
        !RESERVED_CATEGORY_KEYS.has(newKey) &&
        /^\d+$/.test(newKey)
    ) {
        settings.categories[newKey] = newValue;
    }

    saveSettings();
    res.redirect(section === "categories" ? "/admin/categories" : (section === "messages" ? "/admin/messages" : "/admin/settings"));
});

// --------------------------------------------------
// Start
// --------------------------------------------------
app.listen(3000, () => {
    openBrowser("http://localhost:3000");
});