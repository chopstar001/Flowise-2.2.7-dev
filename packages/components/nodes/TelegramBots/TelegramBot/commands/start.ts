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
import {
    AUTH_TYPES,
    SUBSCRIPTION_TIERS,
    type AuthType,
    type SubscriptionTier,
    type CreateUserDTO,
    SessionCreationDTO,
    type UserData
} from '../services/DatabaseService';
export const startCommand: Command = {
    name: 'start',
    description: 'Start the bot and get an introduction',
    execute: async (
        adapter: ContextAdapter,
        conversationManager: ConversationManager,
        memory: IExtendedMemory | null,
        userId: string,
        sessionId: string,
        promptManager: PromptManager | null,
        botInstance: TelegramBot_Agents
    ) => {
        const methodName = 'startCommand';
        let deleteConfirmation: (() => Promise<boolean>) | null = null;

        try {
            logInfo(methodName, `Executing start command`, { userId, sessionId });
            // Add database verification
            console.log(`[${methodName}] Verifying database state before proceeding`);

            // Check user table
            const userRecord = await botInstance.databaseService.getUserById(userId);
            console.log(`[${methodName}] User record check:`, {
                userId,
                exists: !!userRecord,
                details: userRecord
            });

            // Check session table
            const sessionRecord = await botInstance.databaseService.getSession(sessionId);
            console.log(`[${methodName}] Session record check:`, {
                sessionId,
                exists: !!sessionRecord,
                details: sessionRecord
            });

            // Initialize user account first
            const userAccount = await botInstance.initializeTelegramUser(adapter);
            const normalizedUserId = userAccount.id;

            // Verify the session exists and is active
            const sessionInfo = await conversationManager.getSessionInfo(adapter);
            const normalizedSessionId = sessionInfo.sessionId;

            // Verify normalized IDs
            console.log(`[${methodName}] ID normalization check:`, {
                originalUserId: userId,
                normalizedUserId,
                originalSessionId: sessionId,
                normalizedSessionId,
                sessionStatus: sessionInfo.status
            });

            // Verify database state after normalization
            const verifyUserRecord = await botInstance.databaseService.getUserById(normalizedUserId);
            const verifySessionRecord = await botInstance.databaseService.getSession(normalizedSessionId);

            console.log(`[${methodName}] Database state after normalization:`, {
                userExists: !!verifyUserRecord,
                sessionExists: !!verifySessionRecord,
                userDetails: verifyUserRecord,
                sessionDetails: verifySessionRecord
            });
            // If either record is missing, recreate them
            if (!verifyUserRecord || !verifySessionRecord) {
                console.log(`[${methodName}] Missing records detected, attempting to recreate`);

                if (!verifyUserRecord) {
                    await botInstance.databaseService.createUser({
                        id: normalizedUserId,
                        type: 'telegram',
                        subscription_tier: 'free',
                        token_quota: botInstance.databaseService.DEFAULT_TOKEN_QUOTA,
                        metadata: {
                            original_id: userId,
                            source: 'telegram',
                            created_at: new Date().toISOString()
                        }
                    });
                    console.log(`[${methodName}] Recreated user record`);
                }

                if (!verifySessionRecord) {
                    const context = adapter.getMessageContext();
                    const isWebapp = context.source === 'webapp';

                    const newSession: SessionCreationDTO = {
                        id: normalizedSessionId,
                        userId: normalizedUserId,
                        type: 'private',
                        source: 'telegram',  // Always use telegram as source
                        chatId: adapter.getMessageContext().chatId.toString(),
                        created_at: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' }),
                        last_active: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' }),
                        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' }),
                        status: 'active',
                        metadata: {
                            original_request: adapter.getMessageContext(),
                            flowId: botInstance.flowId,
                            interface: isWebapp ? 'webapp' : 'telegram',  // Track interface type
                            requiresAuth: isWebapp  // Track auth requirement
                        },
                        flowwiseChatflowId: botInstance.flowId
                    };

                    await botInstance.databaseService.createSession(newSession);
                    console.log(`[${methodName}] Recreated session record with interface:`, {
                        interface: isWebapp ? 'webapp' : 'telegram'
                    });
                }

                // Verify again after recreation
                const finalUserRecord = await botInstance.databaseService.getUserById(normalizedUserId);
                const finalSessionRecord = await botInstance.databaseService.getSession(normalizedSessionId);

                console.log(`[${methodName}] Final database state:`, {
                    userExists: !!finalUserRecord,
                    sessionExists: !!finalSessionRecord,
                    userDetails: finalUserRecord,
                    sessionDetails: finalSessionRecord
                });
            }

            const context = adapter.getMessageContext();
            const isAuthFlow = context.input.toLowerCase().includes('auth');

            logInfo(methodName, `Executing start command`, {
                userId,
                sessionId,
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

                I'm here to help you authenticate for the web application. Your account is ready with ${userAccount.token_quota} tokens available.
                
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

                welcomeMessage = `👋 Welcome ${context.raw?.from?.first_name || 'there'}, to your AI assistant! I'm here to help you with various tasks and answer your questions. Your account is ready with ${userAccount.token_quota} tokens available.

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
            if (memory && sessionInfo.status === 'active') {
                try {
                    await botInstance.databaseService.ensureChatMessagesTable();
                    // Store each chunk separately
                    for (let i = 0; i < messageChunks.length; i++) {
                        const chunk = messageChunks[i];
                        try {
                            const timestamp = Date.now();  // Use milliseconds timestamp
                            await memory.addChatMessagesExtended([
                                {
                                    message: i === 0 ? '/start' : 'Continued...',
                                    text: i === 0 ? '/start' : 'Continued...',
                                    type: 'userMessage',
                                    metadata: {
                                        userId: normalizedUserId,
                                        sessionId: normalizedSessionId,
                                        timestamp,  // Use number timestamp
                                        chunkIndex: i,
                                        totalChunks: messageChunks.length,
                                        interface: isWebapp ? 'webapp' : 'telegram',
                                        timestampFormatted: new Date(timestamp).toLocaleString('en-AU', {
                                            timeZone: 'Australia/Brisbane'
                                        })  // Keep formatted time as additional info
                                    }
                                } as ExtendedIMessage,
                                {
                                    message: chunk,
                                    text: chunk,
                                    type: 'apiMessage',
                                    metadata: {
                                        userId: normalizedUserId,
                                        sessionId: normalizedSessionId,
                                        timestamp,  // Use number timestamp
                                        chunkIndex: i,
                                        totalChunks: messageChunks.length,
                                        interface: isWebapp ? 'webapp' : 'telegram',
                                        timestampFormatted: new Date(timestamp).toLocaleString('en-AU', {
                                            timeZone: 'Australia/Brisbane'
                                        })  // Keep formatted time as additional info
                                    }
                                } as ExtendedIMessage
                            ], normalizedUserId, normalizedSessionId);

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
                userId,
                sessionId,
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