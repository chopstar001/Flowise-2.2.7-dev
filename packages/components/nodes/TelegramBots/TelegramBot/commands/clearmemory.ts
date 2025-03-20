//  clearmemory.ts

import { Command } from './types'
import { logInfo, logError } from '../loggingUtility';
import { Markup } from 'telegraf';

export const clearMemoryCommand: Command = {
    name: 'clearmemory',
    description: 'Clear conversation memory for this chat',
    execute: async (ctx, conversationManager, memory, userId, sessionId) => {
        const methodName = 'clearMemoryCommand';
        if (!conversationManager || !memory) {
            await ctx.reply("Bot is not fully initialized. Please try again later.");
            return;
        }
        const chatId = ctx.chat?.id;
        //const chatType = ctx.chat?.type;

        if (!userId || !chatId) {
            await ctx.reply("Unable to identify user or chat. Cannot clear memory.");
            return;
        }
        try {
            logInfo(methodName, `Initiating memory clear request for user ${userId} in session ${sessionId}`);
            
            const chatType = ctx.chat?.type;
            const confirmMessage = chatType === 'private' 
                ? "Are you sure you want to clear your private chat memory?"
                : "Are you sure you want to clear the memory for this group chat?";

            // Extract numeric portions from IDs
            const numericUserId = userId.replace(/\D/g, '');
            const numericSessionId = sessionId.replace(/\D/g, '');
            
            // Create callback data with only numeric IDs
            const confirmData = `confirm_${numericUserId}_${numericSessionId}`;
            const cancelData = `cancel_${numericUserId}_${numericSessionId}`;
            
            // Create keyboard using telegraf's Markup properly
            const keyboard = Markup.inlineKeyboard([
                Markup.button.callback('Yes, clear memory', confirmData),
                Markup.button.callback('No, keep memory', cancelData)
            ]);

            await ctx.reply(confirmMessage, keyboard);
            logInfo(methodName, `Sent confirmation request to user ${userId} in ${chatType} chat`);
        } catch (error) {
            logError(methodName, `Error initiating memory clear for user ${userId}:`, error);
            await ctx.reply("An error occurred while processing your request. Please try again later.");
        }
    }
};