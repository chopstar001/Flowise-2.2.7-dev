import { Command } from './types';
import { ConversationManager } from '../ConversationManager';
import { IExtendedMemory, ExtendedIMessage, MessageContext } from './types';
import { MessageType } from '../../../../src/Interface';
import { PromptManager } from '../PromptManager';
import { RAGAgent } from '../agents/RAGAgent';
import { TelegramBot_Agents } from '../TelegramBot_Agents';
import { ContextAdapter } from '../ContextAdapter';
import { logInfo, logError, logWarn } from '../loggingUtility';
import { handlePlatformSpecificResponse } from '../utils/utils';

export const ragModeCommand: Command = {
    name: 'ragmode',
    description: 'Toggle Q&A Retrieval-Augmented Generation (RAG) mode',
    execute: async (adapter: ContextAdapter, conversationManager: ConversationManager, memory: IExtendedMemory | null, userId: string, sessionId: string, promptManager: PromptManager | null, telegramBot: TelegramBot_Agents) => {
        const methodName = 'ragModeCommand';

        if (!conversationManager) {
            await adapter.reply("Bot is not fully initialized. Please try again later.");
            return;
        }

        const agentManager = conversationManager.getAgentManager();
        if (!agentManager) {
            await adapter.reply("Agent Manager is not initialized. Cannot toggle RAG mode.");
            return;
        }

        const ragAgent = agentManager.getAgent('rag') as RAGAgent;
        if (!ragAgent || !('isRAGModeEnabled' in ragAgent) || !('toggleRAGMode' in ragAgent)) {
            await adapter.reply("RAG Agent is not available or doesn't support mode toggling.");
            return;
        }

        const currentMode = ragAgent.isRAGModeEnabled(userId);
        const newMode = !currentMode;
        ragAgent.toggleRAGMode(userId, newMode);

        // Get the context and check if this was called from a callback query
        const context = adapter.getMessageContext();
        
        // If this was called from a callback query, we should update the menu
        if (adapter.isCallbackQuery() && adapter.context.raw?.callbackQuery?.message) {
            // Answer the callback query first
            await adapter.answerCallbackQuery(newMode ? "RAG Q&A mode has been turned on." : "RAG Q&A mode has been turned off.");
            
            // Get the message that contains the menu
            const message = adapter.context.raw.callbackQuery.message;
            const botId = telegramBot?.bot?.botInfo?.id;
            
            if (botId && telegramBot.menuManager) {
                // Determine if this is a group chat
                const chatType = getChatType(context);
                const isGroupChat = chatType !== 'private';
                
                // Get the original message content
                const messageText = 'text' in message ? message.text : '';
                
                try {
                    // Create updated menu with new RAG status
                    const updatedMenu = telegramBot.menuManager.createStandardChatMenu(
                        isGroupChat,
                        botId,
                        {
                            isResponse: true,
                            hasContent: messageText.length > 0,
                            contentLength: messageText.length,
                            isRagEnabled: newMode
                        }
                    );
                    
                    // Update the message with the new menu
                    await adapter.editMessageText(
                        messageText,
                        {
                            parse_mode: 'HTML',
                            reply_markup: updatedMenu.reply_markup
                        }
                    );
                    
                    logInfo(methodName, `Successfully refreshed menu with RAG mode: ${newMode ? 'ON' : 'OFF'}`);
                    
                    // Send a brief auto-delete confirmation message
                    const confirmMessage = await adapter.reply(
                        newMode 
                            ? "✅ RAG mode enabled. I'll now use my knowledge base to provide more detailed answers."
                            : "❌ RAG mode disabled. I'll now respond based on my general knowledge."
                    );
                    
                    // Auto-delete the confirmation after 5 seconds
                    setTimeout(async () => {
                        try {
                            await adapter.deleteMessage(confirmMessage.message_id);
                        } catch (error) {
                            logError(methodName, 'Error deleting confirmation message:', error);
                        }
                    }, 5000);
                    
                    // Return early since we've handled the response
                    return;
                } catch (error) {
                    logError(methodName, 'Error refreshing menu:', error);
                    // Fall through to standard reply if menu refresh fails
                }
            }
        }
        
        // If we get here, either this wasn't a callback query or menu refresh failed
        // Continue with the standard response as before
        
        // Get the user's first name for the reply
        const userFirstName = context.first_name || 'User';

        const replyMessage = newMode
            ? `✅ RAG (Q&A) mode is now enabled for user: '${userFirstName}'. I will use contextual information to provide more detailed answers.`
            : `⭕️ RAG mode is now disabled for user: '${userFirstName}'. I will provide answers based on my general knowledge.`;

        // Send the message and store the sent message object
        const sentMessage = await adapter.reply(replyMessage);

        // Set a timer to delete the message after 30 seconds
        setTimeout(async () => {
            try {
                await adapter.deleteMessage(sentMessage.message_id);
            } catch (error) {
                logError(methodName, 'Error deleting RAG mode confirmation message:', error);
            }
        }, 30000); // 30000 milliseconds = 30 seconds

        if (memory && promptManager) {
            const messageChunks = promptManager.splitAndTruncateMessage(replyMessage);
            for (let i = 0; i < messageChunks.length; i++) {
                const chunk = messageChunks[i];
                const chunkMessages: ExtendedIMessage[] = [
                    { message: i === 0 ? '/ragmode' : 'Continued...', text: i === 0 ? '/ragmode' : 'Continued...', type: 'userMessage' as MessageType },
                    { message: chunk, text: chunk, type: 'apiMessage' as MessageType }
                ];
                await memory.addChatMessagesExtended(chunkMessages, userId, sessionId);
            }
        }

        logInfo(methodName, `RAG mode ${newMode ? 'enabled' : 'disabled'} for user ${userId} in session ${sessionId}`);
        
        // If this was called from a callback query but we didn't successfully refresh the menu
        if (context.callbackQuery && !adapter.context.raw?.callbackQuery?.message) {
            await adapter.answerCallbackQuery(newMode ? "RAG Q&A mode has been turned on." : "RAG Q&A mode has been turned off.");
        }

        // Optionally, message for group chats
        const chatType = context.raw?.chat?.type;
        if (chatType === 'group' || chatType === 'supergroup') {
            const groupMessage = await adapter.reply("👉 Note: RAG (Q&A) mode has been toggled in a group chat. This affects how I respond to your messages in this group.");
            
            // Set a timer to delete the group message after 30 seconds
            setTimeout(async () => {
                try {
                    await adapter.deleteMessage(groupMessage.message_id);
                } catch (error) {
                    logError(methodName, 'Error deleting RAG mode group chat message:', error);
                }
            }, 30000); // 30000 milliseconds = 30 seconds
        }
    }
};

// Helper function to properly get chat type from MessageContext
function getChatType(context: MessageContext): 'private' | 'group' | 'supergroup' | 'channel' | undefined {
    // First check in raw.chat
    if (context.raw?.chat?.type) {
        return context.raw.chat.type;
    }
    // Then check in raw.message.chat
    if (context.raw?.message?.chat?.type) {
        return context.raw.message.chat.type;
    }
    // If nothing found, default to undefined
    return undefined;
}