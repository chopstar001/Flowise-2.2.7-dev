// start.ts

import { Command, ExtendedIMessage, IExtendedMemory, SessionData } from './types';
import { MessageType } from '../../../../src/Interface';
import { PromptManager } from '../PromptManager';
import { ConversationManager } from '../ConversationManager';
import { TelegramBot_Agents } from '../TelegramBot_Agents';
import { ContextAdapter } from '../ContextAdapter';
import { logInfo, logError, logWarn } from '../loggingUtility';
import { handlePlatformSpecificResponse } from '../utils/utils';
import { sendConfirmationMessage } from '../utils/confirmationUtil';
// Import types from their correct locations
import { SessionInfo } from './types'; // Import SessionInfo from types.ts
import {
    AUTH_TYPES,
    SUBSCRIPTION_TIERS,
    type AuthType,
    type SubscriptionTier,
    type CreateUserDTO,
    SessionCreationDTO,
    type UserData,
    type SessionWithUser // Import SessionWithUser from DatabaseService
} from '../services/DatabaseService';
export const startCommand: Command = {
    name: 'start',
    description: 'Start the bot and get an introduction',
    execute: async (
        adapter: ContextAdapter,
        conversationManager: ConversationManager,
        memory: IExtendedMemory | null,
        userId: string, // Original userId from adapter/context
        sessionId: string, // Original sessionId from adapter/context
        promptManager: PromptManager | null,
        botInstance: TelegramBot_Agents
    ) => {
        const methodName = 'startCommand';
        let deleteConfirmation: (() => Promise<boolean>) | null = null;

        try {
            logInfo(methodName, `Executing start command`, { userId, sessionId });

            // Step 1: Get session identifiers from ConversationManager
            const initialSessionInfo: SessionInfo = await conversationManager.getSessionInfo(adapter);
            const normalizedUserId = initialSessionInfo.userId;
            const normalizedSessionId = initialSessionInfo.sessionId;

            // Step 2: Call DatabaseService to get/create user and session, returning SessionWithUser
            const sessionWithUser: SessionWithUser = await botInstance.databaseService.getOrCreateSession(initialSessionInfo);
            const userAccount = sessionWithUser.userAccount; // Extract userAccount

            // Check if userAccount was successfully retrieved/created by DatabaseService
            if (!userAccount) {
                 logError(methodName, `User account could not be found or created after getOrCreateSession for ${normalizedUserId}`, { sessionInfo: initialSessionInfo });
                 await adapter.reply("Sorry, there was an issue initializing your account. Please try again.");
                 return;
            }

            // Use the potentially updated session info from the database result if needed,
            // otherwise continue using initialSessionInfo for logging consistency if preferred.
            const finalSessionInfo = sessionWithUser; // Or stick with initialSessionInfo

            logInfo(methodName, `User and session verified/created`, {
                normalizedUserId,
                normalizedSessionId,
                sessionStatus: finalSessionInfo.status,
                sessionSource: finalSessionInfo.source,
                sessionInterface: finalSessionInfo.metadata?.interface,
                userTokenQuota: userAccount.token_quota // Access token_quota from userAccount
            });
            const context = adapter.getMessageContext();

            // userTokenQuota is now derived directly from the extracted userAccount
            const userTokenQuota = userAccount.token_quota ?? botInstance.DEFAULT_TOKEN_QUOTA;

            const isAuthFlow = context.input.toLowerCase().includes('auth');

            logInfo(methodName, `Executing start command`, {
                userId, // Log original userId
                sessionId, // Log original sessionId
                interface: isAuthFlow ? 'telegram-auth' : 'telegram',
                timestamp: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })
            });
            // Send confirmation message
            const [confirmationMessage, deleteConfirmationFn] = await sendConfirmationMessage(adapter);
            deleteConfirmation = deleteConfirmationFn;
            const isWebapp = context.source === 'webapp';
            let welcomeMessage: string;
            if (isAuthFlow) {
                welcomeMessage = `👋 Welcome ${context.raw?.from?.first_name || 'there'}!

                I'm here to help you authenticate for the web application. Your account is ready with ${userTokenQuota} tokens available.

                You can now return to the web application by clicking on "🌐 Open Web Chat" button below, and continue your conversation there.

                Need help? Just type /help to see available commands.`;
            } else {
                // Get welcome message
                let knowledgeBaseOverview: string;
                try {
                    knowledgeBaseOverview = await conversationManager.getVectorStoreOverview();
                } catch (error) {
                    console.error(`[${methodName}] Error getting vector store overview:`, error);
                    knowledgeBaseOverview = "I'm having trouble accessing my knowledge base at the moment.";
                }

                // Use the fetched quota here
                welcomeMessage = `👋 Welcome ${context.raw?.from?.first_name || 'there'}, to your AI assistant! I'm here to help you with various tasks and answer your questions. Your account is ready with ${userTokenQuota} tokens available.

${knowledgeBaseOverview}

Here are some things you can do:
- 🔍 Ask me questions about the topics mentioned above
- 🧠 Use /ragmode to toggle Retrieval-Augmented Generation for more detailed answers
- 🌐 Use /searchweb to search the internet for up-to-date information
- ❓ Use /help to see a full list of available commands

How can I assist you today?`;
            }

            // Send welcome message
            if (!promptManager) {
                logWarn(methodName, 'PromptManager is null when executing start command');
                await adapter.reply(welcomeMessage);
                return;
            }

            // Split and send welcome message
            const messageChunks = promptManager.splitAndTruncateMessage(welcomeMessage, 2200);
            for (const chunk of messageChunks) {
                await adapter.reply(chunk);
            }

            // Store in memory only if session is active
            if (memory && finalSessionInfo.status === 'active') { // Use finalSessionInfo here
                try {
                    await botInstance.databaseService.ensureChatMessagesTable();
                    // Store each chunk separately
                    for (let i = 0; i < messageChunks.length; i++) {
                        const chunk = messageChunks[i];
                        try {
                            const timestamp = Date.now();  // Use milliseconds timestamp
                            // Convert messages to the expected format { text: string; type: MessageType }
                            const messagesToAdd: { text: string; type: MessageType }[] = [
                                {
                                    text: i === 0 ? '/start' : 'Continued...',
                                    type: 'userMessage' as MessageType
                                },
                                {
                                    text: chunk,
                                    type: 'apiMessage' as MessageType
                                }
                            ];
                            // Call addChatMessages with correct arguments
                            await memory.addChatMessages(messagesToAdd, normalizedSessionId, normalizedUserId);

                            console.log(`[${methodName}] Stored memory chunk ${i + 1}/${messageChunks.length}`, {
                                timestamp,
                                timestampFormatted: new Date(timestamp).toLocaleString('en-AU', {
                                    timeZone: 'Australia/Brisbane'
                                }),
                                interface: isWebapp ? 'webapp' : 'telegram'
                            });
                        } catch (error) {
                            console.error(`[${methodName}] Error storing memory chunk ${i + 1}/${messageChunks.length}:`, error);
                        }
                    }
                } catch (error) {
                    console.error(`[${methodName}] Error in memory operations:`, error);
                }
            }
            // Update logging
            logInfo(methodName, `Executing start command`, {
                userId, // Log original userId
                sessionId, // Log original sessionId
                interface: isWebapp ? 'webapp' : 'telegram',
                timestamp: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })
            });
            // Send menus
            try {
                console.log(`[${methodName}] Creating and sending menus`);

                await handlePlatformSpecificResponse(
                    adapter,
                    async () => {
                        // Create menus first
                        const inlineMenu = await botInstance.menuManager.createStartInlineMenu(adapter);
                        const keyboardMenu = await botInstance.menuManager.createStartKeyboardMenu(adapter);

                        // Send menus one at a time with proper error handling
                        try {
                            console.log(`[${methodName}] Sending inline menu`);
                            await adapter.reply("You can use these quick access buttons:", {
                                reply_markup: inlineMenu.reply_markup,
                                parse_mode: 'HTML'
                            });
                        } catch (error) {
                            console.error(`[${methodName}] Error sending inline menu:`, error);
                        }

                        try {
                            console.log(`[${methodName}] Sending keyboard menu`);
                            await adapter.reply("Or use these keyboard shortcuts:", {
                                reply_markup: keyboardMenu.reply_markup,
                                parse_mode: 'HTML'
                            });
                        } catch (error) {
                            console.error(`[${methodName}] Error sending keyboard menu:`, error);
                        }
                    },
                    [
                        { command: '/help', description: 'Show help information' },
                        { command: '/start', description: 'Start or restart the bot' }
                    ]
                );

                console.log(`[${methodName}] Menus sent successfully`);
            } catch (error) {
                console.error(`[${methodName}] Error in menu creation:`, error);
                // Continue execution even if menu sending fails
            }

        } catch (error) {
            logError(methodName, `Error in start command`, error, { userId, sessionId });
            await adapter.reply("I'm having trouble processing your request at the moment. Please try again later.");
        } finally {
            if (deleteConfirmation) {
                await deleteConfirmation();
            }
        }
    }
};