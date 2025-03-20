// clearallmemory.ts

import { Command } from './types';
import { logInfo, logError } from '../loggingUtility';
import { Markup } from 'telegraf';
import { ContextAdapter } from '../ContextAdapter';
import { IExtendedMemory } from './types';

export const clearAllMemoryCommand: Command = {
    name: 'clearallmemory',
    description: 'Clear all conversation memory (Admin only)',
    adminOnly: true,
    execute: async (
        adapter: ContextAdapter, 
        conversationManager,
        memory: IExtendedMemory | null,
        userId: string,
        sessionId: string
    ) => {
        const methodName = 'clearAllMemoryCommand';

        if (!conversationManager || !memory) {
            await adapter.reply("Bot is not fully initialized. Please try again later.");
            return;
        }

        // Extract numeric user ID
        const numericUserId = userId.replace(/\D/g, '');
        const adminId = parseInt(numericUserId);

        if (!conversationManager.isAdmin(adminId)) {
            await adapter.reply("Sorry, only administrators can use this command.");
            return;
        }

        try {
            logInfo(methodName, `Admin ${adminId} is attempting to clear all memory`);

            // Create confirmation buttons with numeric IDs
            const confirmData = `confirm_all_${adminId}`;
            const cancelData = `cancel_all_${adminId}`;
            
            // Create keyboard with clearly labeled buttons
            const keyboard = Markup.inlineKeyboard([
                [
                    Markup.button.callback('✅ Yes, clear ALL memory', confirmData),
                    Markup.button.callback('❌ No, cancel', cancelData)
                ]
            ]);

            // Send confirmation message with warning emoji
            await adapter.reply(
                "⚠️ WARNING: You are about to clear ALL conversation memory!\n\n" +
                "This action will:\n" +
                "- Delete all chat histories\n" +
                "- Remove all stored conversations\n" +
                "- Cannot be undone\n\n" +
                "Are you sure you want to proceed?",
                { reply_markup: keyboard.reply_markup }
            );

            logInfo(methodName, `Sent confirmation request to admin ${adminId}`);

        } catch (error) {
            logError(methodName, `Error initiating memory clear for admin ${adminId}:`, error);
            await adapter.reply("An error occurred while processing your request. Please try again later.");
        }
    }
};