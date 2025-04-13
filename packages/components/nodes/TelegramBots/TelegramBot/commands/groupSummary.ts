// packages/components/nodes/TelegramBots/TelegramBot/commands/groupSummary.ts

import { Command } from './types';
import { ContextAdapter } from '../ContextAdapter';
import { ConversationManager } from '../ConversationManager';
import { IExtendedMemory, ExtendedIMessage } from './types'; // Import ExtendedIMessage
import { PromptManager } from '../PromptManager';
import { TelegramBot_Agents } from '../TelegramBot_Agents';
import { AIMessage, HumanMessage, SystemMessage, BaseMessage } from '@langchain/core/messages';
import { logInfo, logError, logWarn } from '../loggingUtility';
import { Message } from 'telegraf/typings/core/types/typegram';

// Helper function to check if an object is an ExtendedIMessage
function isExtendedIMessage(msg: any): msg is ExtendedIMessage {
    return typeof msg === 'object' && msg !== null && 'type' in msg && ('message' in msg || 'text' in msg);
}

export const groupSummaryCommand: Command = {
    name: 'groupsummary',
    description: '[Group Only] Generates a summary of the entire group conversation history.',
    execute: async (
        adapter: ContextAdapter,
        conversationManager: ConversationManager,
        memory: IExtendedMemory | null, // Allow null
        userId: string, // User invoking the command
        sessionId: string, // User-specific session ID (not used directly here)
        promptManager: PromptManager | null, // Allow null
        telegramBot: TelegramBot_Agents // Instance of the main class to access memoryGroup
    ) => {
        const methodName = 'groupSummaryCommand.execute';
        const context = adapter.getMessageContext();
        const chatId = context.chatId.toString(); // Use the actual chat ID

        logInfo(methodName, 'Executing group summary command', { userId, chatId });

        // Add null check for promptManager
        if (!promptManager) {
            logError(methodName, 'PromptManager is not initialized', null, { chatId });
            await adapter.reply('❌ Error: Prompt manager is not available.');
            return;
        }

        // Check if it's a group chat
        const chatType = context.raw?.chat?.type;
        if (chatType !== 'group' && chatType !== 'supergroup') {
            await adapter.reply('This command can only be used in group chats.');
            return;
        }

        // Access the group-specific memory instance - TEMPORARILY COMMENTED OUT
        // const groupMemory = telegramBot.memoryGroup; // Access the dedicated group memory
        // TODO: Replace with getter: const groupMemory = telegramBot.getGroupMemory();
        const groupMemory = telegramBot.getGroupMemory(); // Use getter

        if (!groupMemory) {
            logError(methodName, 'Group memory (memoryGroup) is not initialized', null, { chatId });
            await adapter.reply('❌ Error: Group conversation history is not available.');
            return;
        }

        let statusMessageId: number | undefined; // Store only the ID
        try {
            // 1. Get Group Chat History
            const initialStatus = await adapter.reply('⏳ Generating group conversation summary...');
            statusMessageId = initialStatus?.message_id; // Get the ID

            // Fetch history, potentially containing a mix of types
            const groupHistoryMessages = await groupMemory.getChatMessagesExtended(
                "GROUP", // Use the "GROUP" placeholder userId to retrieve group-specific history
                chatId,  // Use chatId as the session key
                true     // Request BaseMessages, but be prepared for ExtendedIMessage too
            );

            if (!groupHistoryMessages || groupHistoryMessages.length === 0) {
                 if (statusMessageId) await adapter.editMessageText('No group conversation history found to summarize.', statusMessageId);
                return;
            }

            // Convert all messages to BaseMessage, handling both types
            const baseMessages = groupHistoryMessages.map((msg: BaseMessage | ExtendedIMessage): BaseMessage => {
                if (msg instanceof BaseMessage) {
                    return msg; // Already a BaseMessage
                } else if (isExtendedIMessage(msg)) {
                    // Convert ExtendedIMessage to BaseMessage
                    const content = msg.message || msg.text || '';
                    if (msg.type === 'userMessage') return new HumanMessage({ content: content, additional_kwargs: msg.additional_kwargs });
                    if (msg.type === 'apiMessage') return new AIMessage({ content: content, additional_kwargs: msg.additional_kwargs });
                    // Fallback for other ExtendedIMessage types if necessary
                    return new SystemMessage({ content: content, additional_kwargs: msg.additional_kwargs });
                } else {
                    // Handle unexpected types
                    console.warn(`[${methodName}] Unexpected message type in group history:`, msg);
                    return new SystemMessage('[Unsupported Message Format]');
                }
            }).filter((msg): msg is BaseMessage => msg !== null); // Ensure filter checks for BaseMessage


            // 2. Prepare for Summarization - TEMPORARILY COMMENTED OUT
            // const summationModel = telegramBot.summationModel || telegramBot.chatModel;
            // TODO: Replace with getters: const summationModel = telegramBot.getSummationModel() || telegramBot.getChatModel();
            const summationModel = telegramBot.getSummationModel() || telegramBot.getChatModel(); // Use getters

            if (!summationModel) {
                 if (statusMessageId) await adapter.editMessageText('❌ Error: Summarization model is not available.', statusMessageId);
                return;
            }

            // Use correct method name getSummarizePrompt
            const summaryPrompt = promptManager.getSummarizePrompt(); // Corrected method name
            // Include sender info if available in additional_kwargs
            const conversationText = baseMessages
                .map(msg => {
                    // Extract sender info from additional_kwargs added during memory update
                    const senderId = msg.additional_kwargs?.senderUserId || 'Unknown';
                    // Attempt to get a name if available (this depends on what's stored)
                    const senderName = msg.additional_kwargs?.senderFirstName || `User_${senderId}`;
                    return `${msg.constructor.name.replace('Message','')} (${senderName}): ${msg.content}`;
                })
                .join('\n');

            // 3. Generate Summary
             if (statusMessageId) await adapter.editMessageText('🧠 Analyzing group conversation...', statusMessageId);
            const summaryMessages = [
                new SystemMessage(summaryPrompt),
                new HumanMessage(`Please summarize the following group conversation:\n\n${conversationText}`)
            ];

            logInfo(methodName, 'Invoking summation model for group chat', { chatId, historyLength: conversationText.length });
            const summaryResult = await summationModel.invoke(summaryMessages);
            const summaryText = summaryResult.content as string;

            // 4. Send Summary
             if (statusMessageId) await adapter.deleteMessage(statusMessageId); // Delete status message

            if (summaryText) {
                logInfo(methodName, 'Group summary generated successfully', { chatId, summaryLength: summaryText.length });
                const chunks = promptManager.splitAndTruncateMessage(summaryText);
                await adapter.reply(`📝 **Group Conversation Summary**:\n\n${chunks[0]}`, { parse_mode: 'Markdown' }); // Send first chunk with title
                for (let i = 1; i < chunks.length; i++) {
                    await adapter.reply(chunks[i]); // Send subsequent chunks
                }
            } else {
                await adapter.reply('Could not generate a summary for this group conversation.');
            }

        } catch (error) {
            logError(methodName, 'Error generating group summary', error as Error, { userId, chatId });
             try {
                 // Use optional chaining for statusMessageId
                 if (statusMessageId) {
                    await adapter.editMessageText('❌ An error occurred while generating the group summary.', statusMessageId);
                 } else {
                    await adapter.reply('❌ An error occurred while generating the group summary.');
                 }
            } catch (editError) {
                 console.error(`[${methodName}] Failed to edit status message on error:`, editError);
                 await adapter.reply('❌ An error occurred while generating the group summary.'); // Fallback reply
            }
        }
    }
};