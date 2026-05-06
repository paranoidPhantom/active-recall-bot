import { Bot, InlineKeyboard, MediaUpload } from "gramio";
import * as db from "./db";
import * as ai from "./ai";
import * as imageStorage from "./imageStorage";
import { renderQuestionToImage } from "./renderer";

const token = process.env.BOT_TOKEN;
const adminId = parseInt(process.env.ADMIN_ID || "0");

if (!token) {
    console.error("Error: BOT_TOKEN environment variable is not set.");
    console.error("Please create a .env file with BOT_TOKEN=your_token_here");
    process.exit(1);
}

const bot = new Bot(token)
    // Middleware to check auth and save username
    .use(async (context, next) => {
        if (!context.from?.id) return;
        
        // Save username map if present
        if (context.from.username) {
            db.saveUsername(context.from.id, context.from.username);
        }

        // Authentication logic relaxed:
        // Everyone can use /study, /ask.
        // Only admins/trusted can ADD questions (handle text messages).
        return next();
    })

    .command("add", (context) => {
        if (context.from?.id !== adminId) return; // Double check admin
        const args = context.text?.split(" ") || [];
        const target = args[1];
        if (!target) return context.send("Использование: /add <uid|@username>");

        let targetId: number | null = null;
        if (target.startsWith("@")) {
            targetId = db.getUserIdByUsername(target);
        } else {
            targetId = parseInt(target);
        }

        if (!targetId || isNaN(targetId)) {
            return context.send("Неверный ID пользователя или неизвестное имя пользователя (пользователь должен сначала запустить бота).");
        }

        db.setTrusted(targetId, true);
        return context.send(`Пользователь ${targetId} теперь доверенный. ✅`);
    })

    .command("remove", (context) => {
        if (context.from?.id !== adminId) return;
        const args = context.text?.split(" ") || [];
        const target = args[1];
        if (!target) return context.send("Использование: /remove <uid|@username>");

        let targetId: number | null = null;
        if (target.startsWith("@")) {
            targetId = db.getUserIdByUsername(target);
        } else {
            targetId = parseInt(target);
        }

        if (!targetId || isNaN(targetId)) {
            return context.send("Неверный ID пользователя или неизвестное имя пользователя.");
        }

        db.setTrusted(targetId, false);
        return context.send(`Пользователь ${targetId} больше не доверенный. ❌`);
    })

    .command("start", (context) => {
        const userId = context.from?.id;
        if (!userId) return;

        const keys = db.getAllStudyKeys();
        
        // Default to first key if available
        let selectedKey = db.getUserStudyKey(userId) ?? keys[0];

        // Check for optional base64 argument
        const args = context.text?.split(" ") || [];
        if (args.length > 1) {
            try {
                const decoded = Buffer.from(args[1], 'base64').toString();
                if (keys.includes(decoded)) {
                    selectedKey = decoded;
                }
            } catch (e) {
                // Ignore invalid base64
            }
        }

        if (selectedKey) {
            db.setUserStudyKey(userId, selectedKey);
        }

        const questionCount = selectedKey ? db.getQuestionCount(selectedKey) : 0;

        const keyboard = new InlineKeyboard();
        // Pagination could be needed if many keys, but simple list for now
        keys.forEach(key => {
            keyboard.text(key, `study_select:${key}`).row();
        });

        const isTrusted = db.isTrusted(userId) || userId === adminId;
        const trustedMsg = isTrusted ? "\n\n🔑 *Вы доверенный пользователь.*\n• Используйте /study <тема> для переключения или создания темы.\n• Отправляйте текст или заметки, чтобы добавить вопросы в текущую тему.\n• Управляйте вопросами через /view и /clean." : "";

        // Get leaderboard for current topic
        let leaderboardMsg = "";
        if (selectedKey) {
          try {
            const currentLeaderboard = db.getLatestLeaderboardForStudyKey(selectedKey);

            if (currentLeaderboard && Object.keys(currentLeaderboard.leaderboard).length > 0) {
              const entries = Object.entries(currentLeaderboard.leaderboard)
                .sort((a, b) => b[1] - a[1]) // Sort by count descending
                .slice(0, 5); // Top 5 only

              leaderboardMsg = "\n\n🏆 *Топ игроков:*\n";
              entries.forEach(([username, count], index) => {
                const medal = index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : "▫️";
                // Russian pluralization for вопрос
                const questionWord = count === 1 ? "вопрос" :
                                   count >= 2 && count <= 4 ? "вопроса" :
                                   "вопросов";
                // Escape Markdown special characters in username
                const escapedUsername = username.replace(/[\_\*\[\]\(\)\~\`\>\#\+\-\=\|\{\}\.\!]/g, "\\$&");
                leaderboardMsg += `${medal} ${escapedUsername}: ${count} ${questionWord}\n`;
              });
            }
          } catch (error) {
            console.error("Error fetching leaderboard:", error);
          }
        }

        const welcomeMsg = keys.length > 0
            ? `Добро пожаловать! \nТекущая тема: *${selectedKey}* (${questionCount} вопросов).${leaderboardMsg}\n\nИспользуйте /ask чтобы начать тренировку, или выберите другую тему ниже:${trustedMsg}`
            : `Добро пожаловать! Темы не найдены. \nЕсли вы админ, используйте /study <тема> и отправьте текст для создания вопросов.${trustedMsg}`;

        return context.send(welcomeMsg, { reply_markup: keyboard, parse_mode: "Markdown" });
    })
    
    .command("study", (context) => {
        const key = context.text?.split(" ").slice(1).join(" ");
        if (!key) {
            return context.send("Пожалуйста укажите тему. Использование: /study <тема>");
        }
        db.setUserStudyKey(context.from?.id || 0, key);
        return context.send(`Тема установлена: ${key}. Отправьте мне текст/заметки для генерации вопросов!`);
    })

    .command("clean", (context) => {
        const userId = context.from?.id;
        if (!userId) return;

        // AUTH CHECK FOR CLEANING - STRICTLY ADMIN ONLY
        if (userId !== adminId) {
            return context.send("Эта команда доступна только главному администратору.");
        }

        const studyKey = db.getUserStudyKey(userId);
        if (!studyKey) {
            return context.send("Вы еще не выбрали тему. Используйте /study <тема> сначала.");
        }

        const keyboard = new InlineKeyboard()
            .text("Да, удалить все", `clean:${studyKey}:confirm`)
            .text("Отмена", `clean:${studyKey}:cancel`);

        return context.send(`Вы уверены, что хотите удалить ВСЕ вопросы по теме '${studyKey}'?`, { reply_markup: keyboard });
    })

    .command("rename", (context) => {
        const userId = context.from?.id;
        if (!userId) return;

        if (userId !== adminId) {
            return context.send("Эта команда доступна только главному администратору.");
        }

        const newName = context.text?.split(" ").slice(1).join(" ");
        if (!newName) {
            return context.send("Использование: /rename <новое_название>");
        }

        const currentKey = db.getUserStudyKey(userId);
        if (!currentKey) {
            return context.send("Сначала выберите тему, которую хотите переименовать, через /study.");
        }

        if (currentKey === newName) {
            return context.send("Новое название совпадает с текущим.");
        }

        db.renameStudyKey(currentKey, newName);
        return context.send(`✅ Тема '${currentKey}' успешно переименована в '${newName}'.`);
    })

    .command("view", async (context) => {
        const userId = context.from?.id;
        if (!userId) return;

        // AUTH CHECK
        const isTrusted = db.isTrusted(userId) || userId === adminId;
        if (!isTrusted) return context.send("У вас нет прав просматривать список вопросов.");

        const studyKey = db.getUserStudyKey(userId);
        if (!studyKey) return context.send("Тема не выбрана. Используйте /study <тема>.");

        await sendQuestionsList(context, studyKey, 1);
    })

    .command("ask", (context) => {
        const args = context.text?.split(" ") || [];
        const questionId = args[1] ? parseInt(args[1]) : undefined;
        return sendRandomQuestion(bot, context.chat.id, context.from?.id, questionId);
    })

    .on("message", async (context) => {
        if (!context.text) return;
        
        // Ignore commands (starting with /)
        if (context.text.startsWith("/")) return;

        const userId = context.from?.id;
        if (!userId) return;

        // AUTH CHECK FOR ADDING QUESTIONS
        const isTrusted = db.isTrusted(userId) || userId === adminId;
        if (!isTrusted) {
            return context.send("У вас нет прав добавлять новые вопросы. Вы можете только учить существующие темы.");
        }

        const studyKey = db.getUserStudyKey(userId);
        if (!studyKey) {
            return context.send("Вы еще не выбрали тему. Используйте /study <тема> сначала.");
        }

        const msg = await context.send(`Анализирую текст для темы '${studyKey}'... ⏳`);
        
        try {
            const questions = await ai.generateQuestions(context.text, studyKey);
            
            if (questions.length === 0) {
                // GramIO send returns the message object, but edit might be on context or we need to use bot.api
                // The issue is likely the type returned by context.send vs what we expect.
                // In GramIO, we might need to use the API directly to edit if the returned object doesn't have helpers.
                // Or simply send a new message. For now, let's just send a new message to be safe.
                return context.send("Не удалось сгенерировать вопросы из этого текста. Попробуйте добавить больше деталей.");
            }

            for (const q of questions) {
                const questionId = db.saveQuestion(studyKey, q.question, q.options, q.correct_index);
                // Pre-generate and save image
                try {
                    const imageBuffer = await renderQuestionToImage(q.question, q.options);
                    await imageStorage.saveQuestionImage(questionId, imageBuffer);
                } catch (imgError) {
                    console.error(`Failed to generate image for question ${questionId}:`, imgError);
                    // We continue, so the question is saved, but image might be missing (fallback will handle it)
                }
            }

            // Remove the "Analyzing..." message
            try {
                await bot.api.deleteMessage({
                    chat_id: msg.chat.id,
                    message_id: msg.id
                });
            } catch (e) {
                // Ignore if unable to delete
            }

            return context.send(`✅ Сохранено ${questions.length} новых вопросов для темы '${studyKey}'. Используйте /ask для тренировки!`);
        } catch (e) {
            console.error(e);
            return context.send("Ошибка генерации вопросов. Пожалуйста попробуйте снова.");
        }
    })

    .on("callback_query", async (context) => {
        const data = context.data;
        if (!data) return;

        // Clean confirmation handler
        if (data.startsWith("clean:")) {
            const parts = data.split(":");
            const studyKey = parts[1];
            const action = parts[2];

            if (action === "confirm") {
                db.clearQuestions(studyKey);
                await context.answer({ text: "Вопросы удалены." });
                if (context.message) {
                    try {
                        await bot.api.editMessageText({
                            chat_id: context.message.chat.id,
                            message_id: context.message.id, // GramIO maps message_id to id
                            text: `🗑️ Все вопросы по теме '${studyKey}' были удалены.`
                        });
                    } catch (e) {
                        console.error("Error editing message:", e);
                    }
                }
            } else {
                await context.answer({ text: "Отменено." });
                if (context.message) {
                    try {
                        await bot.api.editMessageText({
                            chat_id: context.message.chat.id,
                            message_id: context.message.id, // GramIO maps message_id to id
                            text: `Операция отменена. Вопросы по теме '${studyKey}' сохранены.`
                        });
                    } catch (e) {
                        console.error("Error editing message:", e);
                    }
                }
            }
            return;
        }

        // Study selection handler
        if (data.startsWith("study_select:")) {
            const key = data.split(":")[1];
            if (key) {
                db.setUserStudyKey(context.from?.id || 0, key);
                await context.answer({ text: `Выбрано: ${key}` });
                
                if (context.message) {
                    try {
                        await bot.api.editMessageText({
                            chat_id: context.message.chat.id,
                            message_id: context.message.id,
                            text: `✅ Тема установлена: *${key}*\n\nИспользуйте /ask чтобы начать тренировку!`,
                            parse_mode: "Markdown"
                        });
                    } catch (e) { console.error(e); }
                }
            }
            return;
        }

        // View pagination and delete handler
        // page:<studyKey>:<page>
        if (data.startsWith("page:")) {
            const parts = data.split(":");
            const studyKey = parts[1];
            const page = parseInt(parts[2]);
            await sendQuestionsList(context, studyKey, page, true); // edit mode
            return;
        }

        // del:<questionId>:<studyKey>:<page>
        if (data.startsWith("del:")) {
            const userId = context.from?.id;
            if (!userId) return;

            // AUTH CHECK FOR DELETING QUESTIONS
            const isTrusted = db.isTrusted(userId) || userId === adminId;
            if (!isTrusted) {
                 await context.answer({ text: "Только администратор может удалять вопросы.", show_alert: true });
                 return;
            }

            const parts = data.split(":");
            const qId = parseInt(parts[1]);
            const studyKey = parts[2];
            const page = parseInt(parts[3]);
            
            db.deleteQuestion(qId);
            imageStorage.deleteQuestionImage(qId).catch(err => console.error("Failed to delete image:", err));

            await context.answer({ text: "Вопрос удален." });
            await sendQuestionsList(context, studyKey, page, true);
            return;
        }

        // format: q:<question_id>:<selected_index>
        if (data.startsWith("vote:")) {
            const parts = data.split(":");
            // vote:questionId:up/down
            const questionId = parseInt(parts[1]);
            const voteType = parts[2];
            const userId = context.from?.id;

            if (userId && !isNaN(questionId)) {
                db.addVote(userId, questionId, voteType === "up");
                const stats = db.getQuestionStats(questionId);
                const totalVotes = stats.thumbs_up + stats.thumbs_down;
                const rating = totalVotes > 0 ? Math.round((stats.thumbs_up / totalVotes) * 100) : 0;
                
                await context.answer({ text: voteType === "up" ? "Спасибо за лайк! 👍" : "Спасибо за отзыв. 👎" });
                
                if (context.message) {
                   try {
                       // Update text with new stats and remove buttons
                       const currentText = context.message.text || "";
                       // Try to preserve the question text. Usually it's "✅ Question ... \n\nCorrect! ..."
                       // We can just reconstruct it or regex replace the rating line.
                       // Simpler: assume the format we set in "q:" handler.
                       // "✅ " + qText + "\n\nОтвет правильный! Рейтинг: 👍 ${up} / 👎 ${down}"
                       
                       // Let's just grab the question text from the message by stripping the footer?
                       // Or just replace the footer.
                       const lines = currentText.split("\n\n");
                       const questionPart = lines[0]; // "✅ Question..."
                       
                       await bot.api.editMessageCaption({
                           chat_id: context.message.chat.id,
                           message_id: context.message.id,
                           caption: `✅ Правильно!\n\nРейтинг: ${rating}%\nВы проголосовали: ${voteType === "up" ? "👍" : "👎"}`,
                           reply_markup: new InlineKeyboard() // empty
                       });
                   } catch (e) {
                       console.error("Error editing vote message:", e);
                   }
                }
            }
            return;
        }

        // Answer callback handler
        const parts = data.split(":");
        // format: q:<question_id>:<correct_index>:<selected_index>
        if (parts[0] === "q" && parts.length === 4) {
            const questionId = parseInt(parts[1]);
            const correctIndex = parseInt(parts[2]);
            const selectedIndex = parseInt(parts[3]);
            const message = context.message;
            
            if (!message) return;

            if (selectedIndex === correctIndex) {
                await context.answer({ text: "Правильно! 🎉" });
                
                const stats = db.getQuestionStats(questionId);
                const totalVotes = stats.thumbs_up + stats.thumbs_down;
                const rating = totalVotes > 0 ? Math.round((stats.thumbs_up / totalVotes) * 100) : 0;

                const voteKeyboard = new InlineKeyboard()
                    .text(`👍 (${stats.thumbs_up})`, `vote:${questionId}:up`)
                    .text(`👎 (${stats.thumbs_down})`, `vote:${questionId}:down`);

                try {
                    // Show correct letter
                    await bot.api.editMessageCaption({
                        chat_id: message.chat.id,
                        message_id: message.id,
                        caption: `✅ Правильно! (Ответ: ${String.fromCharCode(65 + correctIndex)})\n\nРейтинг: ${rating}%`,
                        reply_markup: voteKeyboard
                    });
                } catch (e) {
                    console.error("Error editing message:", e);
                }

                // Ask new question
                const chatId = message.chat.id;
                const userId = context.from?.id;
                await sendRandomQuestion(bot, chatId, userId);
            } else {
                await context.answer({ text: "Неверно! Попробуйте еще раз. ❌" });
                
                // Remove the clicked button
                const currentKeyboard = message.reply_markup?.inline_keyboard;
                if (currentKeyboard) {
                    const newKeyboard = new InlineKeyboard();
                    
                     for (const row of currentKeyboard) {
                        const keptButtons = row.filter(btn => btn.callback_data !== data);
                        if (keptButtons.length > 0) {
                            newKeyboard.row();
                            for (const btn of keptButtons) {
                                newKeyboard.text(btn.text, btn.callback_data || "ignore");
                            }
                        }
                    }
                    
                    try {
                         await bot.api.editMessageReplyMarkup({
                            chat_id: message.chat.id,
                            message_id: message.id,
                            reply_markup: newKeyboard
                        });
                    } catch (e) {
                        console.error("Failed to edit message", e);
                    }
                }
            }
            return;
        }
    })

    .onStart(({ info }) => console.log(`Bot ${info.username} started!`));


// Helper to send a question
async function sendRandomQuestion(bot: Bot, chatId: number, userId: number | undefined, specificQuestionId?: number) {
    if (!userId) return;

    const studyKey = db.getUserStudyKey(userId);
    if (!studyKey) {
        return bot.api.sendMessage({ chat_id: chatId, text: "Тема не выбрана. Используйте /study <тема>." });
    }

    let question;
    if (specificQuestionId && !isNaN(specificQuestionId)) {
        question = db.getQuestionById(specificQuestionId);
        if (!question) {
            return bot.api.sendMessage({ chat_id: chatId, text: `Вопрос #${specificQuestionId} не найден.` });
        }
    } else {
        question = db.getRandomQuestion(studyKey, userId);
    }

    if (!question) {
        return bot.api.sendMessage({ chat_id: chatId, text: `Вопросов по теме '${studyKey}' не найдено. Отправьте мне текст для генерации (если есть права)!` });
    }

    const options = question.options; // Already parsed by db.getRandomQuestion
    
    let imageSource: string | Buffer;
    
    if (imageStorage.imageExists(question.id)) {
        imageSource = imageStorage.getQuestionImagePath(question.id);
    } else {
        // Fallback: Generate on the fly and save
        try {
            const imageBuffer = await renderQuestionToImage(question.question_text, options);
            await imageStorage.saveQuestionImage(question.id, imageBuffer);
            imageSource = imageBuffer;
        } catch (e) {
            console.error("Failed to render image:", e);
            return bot.api.sendMessage({ chat_id: chatId, text: "Ошибка при рендеринге вопроса." });
        }
    }

    const keyboard = new InlineKeyboard();
    // Use A, B, C... buttons
    options.forEach((_, idx) => {
        const letter = String.fromCharCode(65 + idx); // A, B, C...
        // payload: q:<question_id>:<correct_index>:<this_index>
        keyboard.text(letter, `q:${question.id}:${question.correct_index}:${idx}`);
        if ((idx + 1) % 4 === 0) keyboard.row(); // Max 4 per row
    });

    // Determine how to send the photo based on source type
    const photo = typeof imageSource === 'string' 
        ? MediaUpload.path(imageSource) 
        : MediaUpload.buffer(imageSource, "question.png");

    return bot.api.sendPhoto({
        chat_id: chatId,
        photo: photo,
        reply_markup: keyboard
    });
}

// Startup Logic for cleaning right answers
if (process.env.CLEAN_RIGHT_ANSWERS === "true") {
    console.log("🔄 Starting answer shuffle process...");
    try {
        const questions = db.getAllQuestionsRaw();
        console.log(`Found ${questions.length} questions to process.`);
        
        for (const q of questions) {
            let options: string[];
            try {
                options = JSON.parse(q.options);
            } catch (e) {
                console.error(`Failed to parse options for question ${q.id}`, e);
                continue;
            }

            const correctAnswer = options[q.correct_index];
            
            // Fisher-Yates shuffle
            for (let i = options.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [options[i], options[j]] = [options[j], options[i]];
            }

            const newCorrectIndex = options.indexOf(correctAnswer);
            
            if (newCorrectIndex === -1) {
                console.error(`Correct answer lost for question ${q.id}`);
                continue;
            }

            db.updateQuestionOptions(q.id, options, newCorrectIndex);

            // Regenerate image
            try {
                const imageBuffer = await renderQuestionToImage(q.question_text, options);
                await imageStorage.saveQuestionImage(q.id, imageBuffer);
                if (q.id % 10 === 0) console.log(`Processed question ${q.id}...`);
            } catch (e) {
                console.error(`Failed to regenerate image for question ${q.id}`, e);
            }
        }
        console.log("✅ Finished shuffling answers and regenerating images.");
    } catch (error) {
        console.error("Error during answer shuffle:", error);
    }
}

bot.start();

// Start leaderboard generation job that runs every minute
console.log("🔄 Starting leaderboard generation scheduler (runs every minute)...");
setInterval(() => {
  try {
    console.log("📊 Generating leaderboards...");
    db.generateLeaderboards();
  } catch (error) {
    console.error("Error generating leaderboards:", error);
  }
}, 60 * 1000); // 60 seconds = 1 minute

// Generate initial leaderboards on startup
try {
  db.generateLeaderboards();
  console.log("📊 Initial leaderboards generated");
} catch (error) {
  console.error("Error generating initial leaderboards:", error);
}

function escapeHtml(unsafe: string): string {
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

async function sendQuestionsList(context: any, studyKey: string, page: number, isEdit = false) {
    const { questions, total, totalPages } = db.getQuestions(studyKey, page, 5);
    
    if (questions.length === 0 && page > 1) {
        // Fallback to previous page if current is empty (e.g. after deleting last item)
        return sendQuestionsList(context, studyKey, page - 1, isEdit);
    }
    
    if (questions.length === 0) {
        const text = `В теме '${studyKey}' пока нет вопросов.`;
        if (isEdit) return context.message && bot.api.editMessageText({ chat_id: context.message.chat.id, message_id: context.message.id, text });
        return context.send(text);
    }

    let text = `📋 <b>Вопросы по теме '${escapeHtml(studyKey)}'</b> (Стр. ${page}/${totalPages}):\n\n`;
    const keyboard = new InlineKeyboard();

    questions.forEach((q) => {
        const options = JSON.parse(q.options) as string[];
        const correct = options[q.correct_index];
        text += `🔹 <b>${q.id}</b>: ${escapeHtml(q.question_text)}\n✅ <b>Ответ</b>: ${escapeHtml(correct)} (👍${q.thumbs_up}/👎${q.thumbs_down})\n\n`;
    });

    // Add delete buttons grid
    let rowCount = 0;
    questions.forEach((q) => {
        keyboard.text(`🗑 ${q.id}`, `del:${q.id}:${studyKey}:${page}`);
        rowCount++;
        if (rowCount % 4 === 0) keyboard.row(); // 4 buttons per row
    });
    if (rowCount % 4 !== 0) keyboard.row();

    // Navigation
    if (page > 1) keyboard.text("⬅️ Назад", `page:${studyKey}:${page - 1}`);
    if (page < totalPages) keyboard.text("Вперед ➡️", `page:${studyKey}:${page + 1}`);

    if (isEdit && context.message) {
        try {
            await bot.api.editMessageText({
                chat_id: context.message.chat.id,
                message_id: context.message.id,
                text,
                reply_markup: keyboard,
                parse_mode: "HTML"
            });
        } catch (e) { console.error(e); }
    } else {
        await context.send(text, { reply_markup: keyboard, parse_mode: "HTML" });
    }
}
