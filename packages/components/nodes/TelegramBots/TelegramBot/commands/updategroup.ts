// updategroup.ts
import { Command } from './types';
import { Context } from 'telegraf';
import { ConversationManager } from '../ConversationManager';
import { IExtendedMemory } from './types';
import { PromptManager } from '../PromptManager';
import { ChatMember } from 'telegraf/typings/core/types/typegram';
import { TelegramBot_Agents } from '../TelegramBot_Agents';

export const updateGroupCommand: Command = {
    name: 'updategroup',
    description: 'Update the list of group members and bots',
    execute: async (ctx, conversationManager, memory, userId, sessionId, promptManager, telegramBot) => {
        if (!ctx.chat) {
            await ctx.reply('Unable to update group members. Please try again.');
            return;
        }

    }
};