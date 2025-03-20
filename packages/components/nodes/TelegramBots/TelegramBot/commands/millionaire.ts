//millionaire.ts
import { Command } from './types';
import { Markup } from 'telegraf';
import { GameAgent } from '../agents/GameAgent';
import { BaseMessage, AIMessage, HumanMessage, MessageContent, SystemMessage } from '@langchain/core/messages'
import { logError, logInfo } from '../loggingUtility';
import { ExtendedIMessage, PhotoMessageOptions, PhotoSource } from '../commands/types';
import { existsSync } from 'fs';
import * as path from 'path';



export const millionaireCommand: Command = {
    name: 'millionaire',
    description: 'Start a game of Who Wants to be a Millionaire',
    execute: async (
        adapter,
        conversationManager,
        memory,
        userId,
        sessionId,
        promptManager,
        telegramBot
    ) => {
        const methodName = 'millionaireCommand';
        const context = adapter.getMessageContext();
        const chatId = context.chatId;
        logInfo(methodName, `Starting millionaire game for user ${userId}`);

        if (!conversationManager) {
            await adapter.reply("Bot is not fully initialized. Please try again later.");
            return;
        }

        // Disable RAG mode before starting game
        conversationManager.disableRAGMode(userId);
        await adapter.replyWithAutoDelete("RAG mode disabled for game session.", 5000);

        const agentManager = conversationManager.getAgentManager();
        if (!agentManager) {
            logError(methodName, 'AgentManager is not initialized', '');
            await adapter.reply("Game system is not initialized. Please try again later.");
            return;
        }

        try {
            // Get chat history for question generation
            const chatHistory = memory ?
                convertToBaseMessages(await memory.getChatMessagesExtended(userId, sessionId, true)) :
                [];

            if (!Array.isArray(chatHistory) || chatHistory.length === 0) {
                await adapter.reply("We need some conversation history to generate questions! Let's chat a bit first using RAG mode.");
                return;
            }


            // Get the game agent
            const gameAgent = agentManager.getAgent('game') as GameAgent;
            logInfo(methodName, `Got game agent: ${!!gameAgent}`);

            if (!gameAgent || !(gameAgent instanceof GameAgent)) {
                logError(methodName, 'Failed to get GameAgent', new Error('Invalid agent type'));
                await adapter.replyWithAutoDelete("Game system is not available. Please try again later.", 60000);
                return;
            }

            // Check existing game state
            let existingGameState = gameAgent.getGameState(userId);
            logInfo(methodName, `Existing game state for user ${userId}:`, existingGameState);

            if (existingGameState?.isActive) {
                await adapter.reply(
                    "You already have an active game. Would you like to continue or start a new one?",
                    {
                        reply_markup: Markup.inlineKeyboard([
                            [
                                Markup.button.callback('Continue Game', `millionaire_continue:${userId}`),
                                Markup.button.callback('New Game', `millionaire_new:${userId}`)
                            ]
                        ]).reply_markup
                    }
                );
                return;
            }

            // Initialize new game with chat history
            console.log(`[${methodName}] Initializing new game for user ${userId}`);
            const gameState = await gameAgent.initializeGame(userId, chatHistory, adapter);
            console.log(`[${methodName}] Game initialized:`, gameState);

            // Get user's first name from the context
            const context = adapter.getMessageContext();
            const firstName = context.first_name || context.raw?.from?.first_name || 'Contestant';

            // Helper function to get asset path
            const getAssetPath = (filename: string): string => {
                // Assets are stored in an 'assets' directory next to the current file
                return path.join(__dirname, '..', 'assets', filename);
            };

            // Use MP4 path
            const videoPath = getAssetPath('Millionaire3.mp4');
            // Check if file exists
            if (!existsSync(videoPath)) {
                throw new Error('Game intro video not found');
            }

            const video = { source: videoPath };

            // Format welcome message with user's name
           const welcomeMessage = `Welcome <b>${firstName}</b> to Who <b>Wants to be a Millionaire!</b> 🎮

                <b>Terra Australis Edition!</b>
            
Based on our previous conversation, I've prepared some interesting questions for you.

You'll be playing for increasing prize money up to <b>$1,000,000!</b> 💰
Remember, you have three lifelines:
- <b>50:50</b> 💫
- <b>Phone a Friend</b> 📞
- <b>Ask the Audience</b> 👥

Safe havens are at $1,000 and $32,000.

Are you ready to begin? Preparing game and your first question...`;

            // Use replyWithVideo instead of replyWithPhoto
            await adapter.replyWithVideo(
                video,
                {
                    caption: welcomeMessage,
                    parse_mode: 'HTML',
                } as PhotoMessageOptions,
                { messageType: 'game_welcome' }
            );
            await adapter.replyWithAutoDelete("💰", 1800000);

        } catch (error) {
            logError(methodName, `Error starting game for user ${userId}:`, error);
            await adapter.replyWithAutoDelete("Sorry, there was an error starting the game. Please try again later.", 30000);
        }
    }
};

function convertToBaseMessages(messages: BaseMessage[] | ExtendedIMessage[]): BaseMessage[] {
    return messages.map(msg => {
        if (msg instanceof BaseMessage) {
            return msg;
        }

        // Convert ExtendedIMessage to BaseMessage
        const content = convertMessageContentToString(msg.text || msg.message);
        if (msg.type === 'userMessage') {
            return new HumanMessage({ content });
        } else {
            return new AIMessage({ content });
        }
    });
}

function convertMessageContentToString(content: MessageContent | undefined): string {
    if (!content) {
        return '';
    }
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content.map(item => {
            if (typeof item === 'string') {
                return item;
            }
            if (typeof item === 'object' && item !== null) {
                // Type assertion for object type
                const objItem = item as { [key: string]: unknown };
                if ('text' in objItem) {
                    return String(objItem.text);
                }
                if ('content' in objItem) {
                    return String(objItem.content);
                }
                return JSON.stringify(objItem);
            }
            return String(item);
        }).join(' ');
    }
    // Handle object type content with type assertion
    if (typeof content === 'object' && content !== null) {
        const objContent = content as { [key: string]: unknown };
        if ('text' in objContent) {
            return String(objContent.text);
        }
        if ('content' in objContent) {
            return String(objContent.content);
        }
        return JSON.stringify(objContent);
    }
    return String(content);
}