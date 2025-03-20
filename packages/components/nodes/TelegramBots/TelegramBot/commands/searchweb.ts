import { Command } from './types'

export const searchWebCommand: Command = {
    name: 'searchweb',
    description: 'Search the web',
    execute: async (ctx, conversationManager, memory, sessionId) => {
        if (!conversationManager) {
            await ctx.reply("Bot is not fully initialized. Please try again later.");
            return;
        }
        await ctx.reply("Web search functionality is not implemented yet.");
    }
}