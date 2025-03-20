import { Command } from './types';
import { ContextAdapter } from '../ContextAdapter';
import { ConversationManager } from '../ConversationManager';
import { IExtendedMemory } from './types';
import { PromptManager } from '../PromptManager';
import { TelegramBot_Agents } from '../TelegramBot_Agents';
import { logInfo, logError, logWarn } from '../loggingUtility';
import { handlePlatformSpecificResponse } from '../utils/utils';

export const stopCommand: Command = {
    name: 'stop',
    description: 'Stop the bot (Admin only)',
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
        const methodName = 'stopCommand';

        if (!conversationManager) {
            await adapter.reply("Bot is not fully initialized. Cannot process stop command.");
            return;
        }

        const context = adapter.getMessageContext();

        if (!conversationManager.isAdmin(userId)) {
            logWarn(methodName, `Non-admin user ${userId} attempted to stop the bot`);
            await adapter.reply("Sorry, only administrators can stop the bot.");
            return;
        }

        logInfo(methodName, `Admin ${userId} is attempting to stop the bot`);

        try {
            await adapter.reply("Stopping the bot. Goodbye!");
            
            // Handle platform-specific responses
            await handlePlatformSpecificResponse(
                adapter,
                async () => {
                    // Telegram-specific actions
                    if (telegramBot.bot) {
                        await telegramBot.bot.telegram.close();
                    }
                },
                [] // No options needed for stop command
            );

            // Perform any additional cleanup
            if (conversationManager.onBotStop) {
                await conversationManager.onBotStop();
            }

            // Stop the bot
            telegramBot.stop();

            logInfo(methodName, `Bot stopped successfully by admin ${userId}`);
        } catch (error) {
            logError(methodName, `Error stopping the bot`, error as Error);
            await adapter.reply("An error occurred while trying to stop the bot. Please check the logs and try again.");
        }
    }
};