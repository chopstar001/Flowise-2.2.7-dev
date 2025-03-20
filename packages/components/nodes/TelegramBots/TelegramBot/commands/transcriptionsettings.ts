// commands/transcriptionsettings.ts

import { Command } from './types';
import { ConversationManager } from '../ConversationManager';
import { IExtendedMemory, ExtendedIMessage, MessageContext } from './types';
import { MessageType } from '../../../../src/Interface';
import { PromptManager } from '../PromptManager';
import { TelegramBot_Agents } from '../TelegramBot_Agents';
import { ContextAdapter } from '../ContextAdapter';
import { logInfo, logError, logWarn } from '../loggingUtility';
import { Markup } from 'telegraf';
import { InlineKeyboardMarkup, ReplyKeyboardMarkup, InlineKeyboardButton } from 'telegraf/typings/core/types/typegram';
import { Context } from 'telegraf';
import { CallbackQuery, Update } from 'telegraf/typings/core/types/typegram';



export interface TranscriptionSettings {
    provider: 'local-cuda' | 'local-cpu' | 'assemblyai' | 'google';
    modelSize: 'tiny' | 'base' | 'small' | 'medium' | 'large';
    language: string;
}

export const transcriptionSettingsCommand: Command = {
    name: 'transcription_settings',
    description: 'Configure transcription settings for media processing',
    adminOnly: true,
    execute: async (
        adapter: ContextAdapter,
        conversationManager: ConversationManager,
        memory: IExtendedMemory | null,
        userId: string,
        sessionId: string,
        promptManager: PromptManager | null,
        telegramBot: TelegramBot_Agents
    ) => {
        const methodName = 'transcriptionSettingsCommand';

        if (!conversationManager) {
            await adapter.reply("Bot is not fully initialized. Please try again later.");
            return;
        }

        try {
            // Get current settings from user preferences
            const settings = getUserTranscriptionSettings(userId, conversationManager);

            // Create keyboard with current settings highlighted
            const keyboard = createTranscriptionSettingsKeyboard(settings, telegramBot.bot?.botInfo?.id);

            // Create descriptive message
            const message = formatTranscriptionSettingsMessage(settings);

            // Send the message with keyboard
            await adapter.reply(message, {
                parse_mode: 'Markdown',
                reply_markup: keyboard.reply_markup
            });

            logInfo(methodName, `Displayed transcription settings for user ${userId}`);
        } catch (error) {
            logError(methodName, 'Error displaying transcription settings:', error, { userId });
            await adapter.reply("Sorry, there was an error accessing your transcription settings. Please try again later.");
        }
    }
};

// Helper function to get user transcription settings
export function getUserTranscriptionSettings(userId: string, conversationManager: ConversationManager): TranscriptionSettings {
    // Default settings
    const defaultSettings: TranscriptionSettings = {
        provider: 'local-cuda',
        modelSize: 'medium',
        language: 'auto'
    };

    try {
        // Try to get settings from cache
        const cacheKey = `transcription_settings:${userId}`;
        const cachedSettings = conversationManager.cache.get<TranscriptionSettings>(cacheKey);

        if (cachedSettings) {
            return cachedSettings;
        }

        return defaultSettings;
    } catch (error) {
        logError('getUserTranscriptionSettings', 'Error getting user settings:', error, { userId });
        return defaultSettings;
    }
}

// Helper function to update user transcription settings
export function updateUserTranscriptionSettings(
    userId: string,
    settings: Partial<TranscriptionSettings>,
    conversationManager: ConversationManager
): TranscriptionSettings {
    const methodName = 'updateUserTranscriptionSettings';

    try {
        const cacheKey = `transcription_settings:${userId}`;

        // Get current settings or use defaults
        const currentSettings = getUserTranscriptionSettings(userId, conversationManager);

        // Update with new settings
        const updatedSettings: TranscriptionSettings = {
            ...currentSettings,
            ...settings
        };

        // Save to cache (14 days TTL)
        conversationManager.cache.set(cacheKey, updatedSettings, 14 * 24 * 60 * 60);

        logInfo(methodName, `Updated transcription settings for user ${userId}`, {
            provider: updatedSettings.provider,
            modelSize: updatedSettings.modelSize,
            language: updatedSettings.language
        });

        return updatedSettings;
    } catch (error) {
        logError(methodName, 'Error updating settings:', error, { userId });
        throw error;
    }
}

// Helper to create keyboard for transcription settings
export function createTranscriptionSettingsKeyboard(
    settings: TranscriptionSettings, 
    botId?: number
): ReturnType<typeof Markup.inlineKeyboard> {
    // Add indicators for currently selected options
    const providerButtons = [
      [
        Markup.button.callback(
          `${settings.provider === 'local-cuda' ? '✅ ' : ''}Local GPU (CUDA)`, 
          `ts_provider:${botId}:local-cuda`
        ),
        Markup.button.callback(
          `${settings.provider === 'local-cpu' ? '✅ ' : ''}Local CPU`, 
          `ts_provider:${botId}:local-cpu`
        )
      ],
      [
        Markup.button.callback(
          `${settings.provider === 'assemblyai' ? '✅ ' : ''}AssemblyAI ($0.002/min)`, 
          `ts_provider:${botId}:assemblyai`
        ),
        Markup.button.callback(
          `${settings.provider === 'google' ? '✅ ' : ''}Google ($0.016/min)`, 
          `ts_provider:${botId}:google`
        )
      ]
    ];

    const modelButtons = [
        Markup.button.callback(
            `${settings.modelSize === 'tiny' ? '✅ ' : ''}Tiny (Fast)`,
            `ts_model:${botId}:tiny`
        ),
        Markup.button.callback(
            `${settings.modelSize === 'base' ? '✅ ' : ''}Base`,
            `ts_model:${botId}:base`
        ),
        Markup.button.callback(
            `${settings.modelSize === 'small' ? '✅ ' : ''}Small`,
            `ts_model:${botId}:small`
        )
    ];

    const modelButtons2 = [
        Markup.button.callback(
            `${settings.modelSize === 'medium' ? '✅ ' : ''}Medium (Balanced)`,
            `ts_model:${botId}:medium`
        ),
        Markup.button.callback(
            `${settings.modelSize === 'large' ? '✅ ' : ''}Large (Accurate)`,
            `ts_model:${botId}:large`
        )
    ];

    const languageButtons = [
        Markup.button.callback(
            `${settings.language === 'auto' ? '✅ ' : ''}Auto-detect`,
            `ts_lang:${botId}:auto`
        ),
        Markup.button.callback(
            `${settings.language === 'en' ? '✅ ' : ''}English`,
            `ts_lang:${botId}:en`
        ),
        Markup.button.callback('More languages...', `ts_more_langs:${botId}:1`)
    ];

    // Add a close button
    const actionButtons = [
        Markup.button.callback('Close', `ts_close:${botId}`)
    ];

    return Markup.inlineKeyboard([
        ...providerButtons,
        modelButtons,
        modelButtons2,
        languageButtons,
        actionButtons
    ]);
}

// Helper to format the message for transcription settings
export function formatTranscriptionSettingsMessage(settings: TranscriptionSettings): string {
    const providerDescriptions: Record<string, string> = {
        'local-cuda': 'Using your GPU for fast processing',
        'local-cpu': 'Using your CPU (slower but no GPU required)',
        'assemblyai': 'External API, very low cost ($0.002/min)',
        'google': 'External API, high accuracy ($0.016/min)'
    };

    const modelDescriptions: Record<string, string> = {
        'tiny': 'Very fast, lower accuracy (1GB VRAM)',
        'base': 'Fast, decent accuracy (1GB VRAM)',
        'small': 'Good balance for simpler content (2GB VRAM)',
        'medium': 'Recommended for most content (5GB VRAM)',
        'large': 'Highest accuracy, slower speed (10GB VRAM)'
    };

    const languageDisplay = settings.language === 'auto' ? 'Auto-detect' :
        settings.language === 'en' ? 'English' : settings.language;

    // Format the message
    return (
        `⚙️ *Transcription Settings*\n\n` +
        `Configure how media files are transcribed for better accuracy and performance.\n\n` +
        `*Current Settings:*\n` +
        `• Provider: ${settings.provider} - ${providerDescriptions[settings.provider] || ''}\n` +
        `• Model: ${settings.modelSize} - ${modelDescriptions[settings.modelSize] || ''}\n` +
        `• Language: ${languageDisplay}\n\n` +
        `Your RTX 3090 GPU has 24GB of VRAM, which can easily handle even the largest models.\n\n` +
        `Select an option below to change your settings:`
    );
}

// Add this to CommandHandler class to handle the callback queries
export function registerTranscriptionSettingsCallbacks(commandHandler: any): void {
    const { bot, conversationManager, promptManager } = commandHandler;

    if (!bot) return;

    // Provider selection with proper typing
    bot.action(/^ts_provider:(\d+):(.+)$/, async (ctx: Context<Update>) => {
        const matches = ctx.match as RegExpExecArray;
        const botId = parseInt(matches[1]);
        const thisBotId = bot.botInfo?.id;

        // Create adapter for this context
        const adapter = new ContextAdapter(ctx, promptManager);

        // Only process if this is for our bot
        if (botId !== thisBotId) {
            await adapter.answerCallbackQuery("Not for this bot");
            return;
        }

        const provider = matches[2];
        const { userId } = await conversationManager.getSessionInfo(adapter);

        try {
            // Update settings
            const updatedSettings = updateUserTranscriptionSettings(
                userId,
                { provider: provider as TranscriptionSettings['provider'] },
                conversationManager
            );

            // Update message
            await adapter.editMessageText(
                formatTranscriptionSettingsMessage(updatedSettings),
                {
                    parse_mode: 'Markdown',
                    reply_markup: createTranscriptionSettingsKeyboard(updatedSettings, botId).reply_markup
                }
            );

            await adapter.answerCallbackQuery(`Transcription provider set to: ${provider}`);
        } catch (error) {
            logError('ts_provider_callback', 'Error updating provider:', error as Error, { userId });
            await adapter.answerCallbackQuery('Error updating settings');
        }
    });

    // Model selection with proper typing
    bot.action(/^ts_model:(\d+):(.+)$/, async (ctx: Context<Update>) => {
        const matches = ctx.match as RegExpExecArray;
        const botId = parseInt(matches[1]);
        const thisBotId = bot.botInfo?.id;
        const adapter = new ContextAdapter(ctx, promptManager);

        // Only process if this is for our bot
        if (botId !== thisBotId) {
            await adapter.answerCallbackQuery("Not for this bot");
            return;
        }

        const modelSize = matches[2];
        const { userId } = await conversationManager.getSessionInfo(adapter);

        try {
            // Update settings
            const updatedSettings = updateUserTranscriptionSettings(
                userId,
                { modelSize: modelSize as TranscriptionSettings['modelSize'] },
                conversationManager
            );

            // Update message
            await adapter.editMessageText(
                formatTranscriptionSettingsMessage(updatedSettings),
                {
                    parse_mode: 'Markdown',
                    reply_markup: createTranscriptionSettingsKeyboard(updatedSettings, botId).reply_markup
                }
            );

            await adapter.answerCallbackQuery(`Transcription model set to: ${modelSize}`);
        } catch (error) {
            logError('ts_model_callback', 'Error updating model size:', error as Error, { userId });
            await adapter.answerCallbackQuery('Error updating settings');
        }
    });

    // Language selection with proper typing
    bot.action(/^ts_lang:(\d+):(.+)$/, async (ctx: Context<Update>) => {
        const matches = ctx.match as RegExpExecArray;
        const botId = parseInt(matches[1]);
        const thisBotId = bot.botInfo?.id;

        const adapter = new ContextAdapter(ctx, promptManager);

        // Only process if this is for our bot
        if (botId !== thisBotId) {
            await adapter.answerCallbackQuery("Not for this bot");
            return;
        }

        const language = matches[2];
        const { userId } = await conversationManager.getSessionInfo(adapter);

        try {
            // Update settings
            const updatedSettings = updateUserTranscriptionSettings(
                userId,
                { language },
                conversationManager
            );

            // Update message
            await adapter.editMessageText(
                formatTranscriptionSettingsMessage(updatedSettings),
                {
                    parse_mode: 'Markdown',
                    reply_markup: createTranscriptionSettingsKeyboard(updatedSettings, botId).reply_markup
                }
            );

            await adapter.answerCallbackQuery(`Language set to: ${language === 'auto' ? 'Auto-detect' : language}`);
        } catch (error) {
            logError('ts_lang_callback', 'Error updating language:', error as Error, { userId });
            await adapter.answerCallbackQuery('Error updating settings');
        }
    });

    // More languages pagination with proper typing
    bot.action(/^ts_more_langs:(\d+):(\d+)$/, async (ctx: Context<Update>) => {
        const matches = ctx.match as RegExpExecArray;
        const botId = parseInt(matches[1]);
        const thisBotId = bot.botInfo?.id;

        const adapter = new ContextAdapter(ctx, promptManager);

        // Only process if this is for our bot
        if (botId !== thisBotId) {
            await adapter.answerCallbackQuery("Not for this bot");
            return;
        }

        const page = parseInt(matches[2]);
        const { userId } = await conversationManager.getSessionInfo(adapter);

        // Common languages by page (simplified for example)
        const languagePages = [
            [], // Page 0 (not used)
            [['English', 'en'], ['Spanish', 'es'], ['French', 'fr']],
            [['German', 'de'], ['Italian', 'it'], ['Portuguese', 'pt']],
            [['Russian', 'ru'], ['Japanese', 'ja'], ['Chinese', 'zh']]
        ];

        const totalPages = languagePages.length - 1;
        const currentSettings = getUserTranscriptionSettings(userId, conversationManager);

        try {
            // Create language selection keyboard for this page
            const languageButtons = languagePages[page].map(([name, code]) =>
                Markup.button.callback(
                    `${currentSettings.language === code ? '✅ ' : ''}${name}`,
                    `ts_lang:${botId}:${code}`
                )
            );

            // Add navigation buttons
            const navButtons = [];
            if (page > 1) {
                navButtons.push(Markup.button.callback('⬅️ Previous', `ts_more_langs:${botId}:${page - 1}`));
            }
            if (page < totalPages) {
                navButtons.push(Markup.button.callback('Next ➡️', `ts_more_langs:${botId}:${page + 1}`));
            }

            const backButton = [Markup.button.callback('Back to Main Settings', `ts_back_main:${botId}`)];

            // Create keyboard
            const keyboard = Markup.inlineKeyboard([
                languageButtons,
                navButtons,
                backButton
            ]);

            // Update message with language selection
            await adapter.editMessageText(
                `⚙️ *Transcription Settings - Languages*\n\n` +
                `Select a language for transcription (Page ${page}/${totalPages}):\n\n` +
                `Current language: ${currentSettings.language === 'auto' ? 'Auto-detect' : currentSettings.language}`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard.reply_markup
                }
            );

            await adapter.answerCallbackQuery('');
        } catch (error) {
            logError('ts_more_langs_callback', 'Error showing language page:', error as Error, { userId });
            await adapter.answerCallbackQuery('Error loading languages');
        }
    });

    // Back to main settings with proper typing
    bot.action(/^ts_back_main:(\d+)$/, async (ctx: Context<Update>) => {
        const matches = ctx.match as RegExpExecArray;
        const botId = parseInt(matches[1]);
        const thisBotId = bot.botInfo?.id;

        const adapter = new ContextAdapter(ctx, promptManager);

        // Only process if this is for our bot
        if (botId !== thisBotId) {
            await adapter.answerCallbackQuery("Not for this bot");
            return;
        }

        const { userId } = await conversationManager.getSessionInfo(adapter);

        try {
            const settings = getUserTranscriptionSettings(userId, conversationManager);

            // Update message to show main settings
            await adapter.editMessageText(
                formatTranscriptionSettingsMessage(settings),
                {
                    parse_mode: 'Markdown',
                    reply_markup: createTranscriptionSettingsKeyboard(settings, botId).reply_markup
                }
            );

            await adapter.answerCallbackQuery('');
        } catch (error) {
            logError('ts_back_main_callback', 'Error returning to main settings:', error as Error, { userId });
            await adapter.answerCallbackQuery('Error loading main settings');
        }
    });

    // Close button with proper typing
    bot.action(/^ts_close:(\d+)$/, async (ctx: Context<Update>) => {
        const matches = ctx.match as RegExpExecArray;
        const botId = parseInt(matches[1]);
        const thisBotId = bot.botInfo?.id;

        if (botId !== thisBotId) {
            await ctx.answerCbQuery();
            return;
        }

        const adapter = new ContextAdapter(ctx, promptManager);

        try {
            // Delete the message
            await adapter.deleteMessage();
            await adapter.answerCallbackQuery('Transcription settings closed');
        } catch (error) {
            logError('ts_close_callback', 'Error closing settings:', error as Error);
            await adapter.answerCallbackQuery('Error closing settings');
        }
    });
}

// Export utility functions for use in other files
export const TranscriptionSettingsUtil = {
    getUserSettings: getUserTranscriptionSettings,
    updateSettings: updateUserTranscriptionSettings
};
