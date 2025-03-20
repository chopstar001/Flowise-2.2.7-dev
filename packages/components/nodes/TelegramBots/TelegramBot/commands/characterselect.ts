import { Command } from './types'

export const characterSelectCommand: Command = {
    name: 'characterselect',
    description: 'Select a character persona',
    execute: async (ctx, conversationManager, memory, sessionId) => {
        if (!conversationManager) {
            await ctx.reply("Bot is not fully initialized. Please try again later.");
            return;
        }
        await ctx.reply("Character selection is not implemented yet.");
    }
}