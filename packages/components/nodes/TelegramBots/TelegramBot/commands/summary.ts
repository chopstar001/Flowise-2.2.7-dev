// commands/summary.ts
import { Command } from './types';
import { ConversationManager } from '../ConversationManager';
import { IExtendedMemory, ExtendedIMessage, MessageContext } from './types';
import { MessageType } from '../../../../src/Interface';
import { PromptManager } from '../PromptManager';
import { TelegramBot_Agents } from '../TelegramBot_Agents';
import { ContextAdapter } from '../ContextAdapter';
import { logInfo, logError, logWarn } from '../loggingUtility';

export const summaryCommand: Command = {
    name: 'summary',
    description: 'Generate a summary of the recent conversation in this chat',
    adminOnly: true,
    execute: async (adapter: ContextAdapter, conversationManager: ConversationManager, memory: IExtendedMemory | null, userId: string, sessionId: string, promptManager: PromptManager | null, telegramBot: TelegramBot_Agents) => {
        const methodName = 'summaryCommand';

        if (!conversationManager) {
            await adapter.reply("Bot is not fully initialized. Please try again later.");
            return;
        }

        // Get the QuestionAnalyzer from the TelegramBot instance
        const questionAnalyzer = telegramBot.getQuestionAnalyzer();
        if (!questionAnalyzer) {
            await adapter.reply("Summary generation is currently unavailable.");
            return;
        }

        try {
            // Send initial message
            const waitMessage = await adapter.reply("🔄 Analyzing conversation and generating summary...");

            // Get chat history
            const chatHistory = await telegramBot.getChatHistory(adapter);

            if (!chatHistory) {
                await adapter.reply("Not enough conversation history to generate a meaningful summary. Please try again after more messages have been exchanged.");
                
                // Try to clean up the wait message
                try {
                    await adapter.deleteMessage(waitMessage.message_id);
                } catch (error) {
                    // Ignore deletion errors
                }
                
                return;
            }

            // Get the chat ID for the summary
            const context = adapter.getMessageContext();
            const chatId = context.chatId.toString();

            // Generate the summary
            const summary = await questionAnalyzer.generateGroupChatSummary(
                chatId,
                chatHistory,
                true // Force new summary (Reverted)
            );

            if (!summary) {
                await adapter.reply("I'm sorry, but I couldn't generate a summary at this time. Please try again later.");
                
                // Try to clean up the wait message
                try {
                    await adapter.deleteMessage(waitMessage.message_id);
                } catch (error) {
                    // Ignore deletion errors
                }
                
                return;
            }

            // Format the summary with some structure and styling
            const formattedSummary = `📝 **Conversation Summary**\n\n${summary}\n\n_Summary generated at ${new Date().toLocaleString()}_`;

            // Delete the wait message
            try {
                await adapter.deleteMessage(waitMessage.message_id);
            } catch (error) {
                logWarn(methodName, 'Error deleting wait message', {error});
                // Continue even if deletion fails
            }

            // Send the formatted summary
            await adapter.reply(formattedSummary, { parse_mode: 'Markdown' });

            // Store in memory if available
            if (memory) {
                const messageChunks = promptManager?.splitAndTruncateMessage(formattedSummary) || [formattedSummary];
                
                for (let i = 0; i < messageChunks.length; i++) {
                    const chunk = messageChunks[i];
                    // Convert messages to the expected format { text: string; type: MessageType }
                    const messagesToAdd: { text: string; type: MessageType }[] = [
                        { text: i === 0 ? '/summary' : 'Continued...', type: 'userMessage' as MessageType },
                        { text: chunk, type: 'apiMessage' as MessageType }
                    ];
                    
                    // Call addChatMessages with correct arguments
                    await memory.addChatMessages(messagesToAdd, sessionId, userId);
                }
            }

            logInfo(methodName, 'Generated and sent conversation summary', {
                userId,
                sessionId,
                chatId,
                messageCount: chatHistory.length,
                summaryLength: summary.length
            });
        } catch (error) {
            logError(methodName, 'Error generating conversation summary', error as Error);
            await adapter.reply("I encountered an error while generating the summary. Please try again later.");
        }
    }
};