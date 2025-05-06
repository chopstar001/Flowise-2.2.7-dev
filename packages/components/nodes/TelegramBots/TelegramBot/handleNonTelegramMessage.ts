// handleNonTelegramMessage.ts

import { ContextAdapter } from './ContextAdapter';
import { logInfo, logWarn, logError } from './loggingUtility';
import { ConversationManager } from './ConversationManager';
import { AgentManager } from './AgentManager';
import { TelegramBot_Agents } from './TelegramBot_Agents';
import { Message } from 'telegraf/typings/core/types/typegram';
import { FormattedResponse, InteractionType } from './commands/types';  // Add import
import { DocumentProcessingAgent } from './agents/DocumentProcessingAgent'; // Import agent
import { v4 as uuidv4 } from 'uuid'; // Import uuid

export async function handleNonTelegramMessage(
    adapter: ContextAdapter,
    conversationManager: ConversationManager,
    agentManager: AgentManager,
    botInstance: TelegramBot_Agents,
    interactionType: InteractionType
): Promise<string | FormattedResponse> {
    const methodName = 'handleNonTelegramMessage';
    const context = adapter.getMessageContext();

    try {
        // Check message source - allow both flowise and webapp
        if (context.source !== 'flowise' && context.source !== 'webapp') {
            logWarn(methodName, `Unexpected message source`, { source: context.source });
            return "Unsupported message source";
        }

        // Get session info - this will handle ID normalization
        const { userId, sessionId, metadata } = await conversationManager.getSessionInfo(adapter);

        // For webapp, we should already have auth from the token validation
        const isWebappAuth = context.source === 'webapp' && metadata?.auth_type === 'telegram';

        // Check for Telegram authentication
        const isTelegramAuth = isWebappAuth || (
            userId.startsWith('telegram_') ||
            userId.startsWith('tg_') ||
            metadata?.auth_type === 'telegram' ||
            context.raw?.auth?.type === 'telegram'
        );

        logInfo(methodName, `Processing message from source: ${context.source}`, {
            userId,
            sessionId,
            isTelegramAuth,
            isWebappAuth,
            originalUserId: context.userId,
            authType: metadata?.auth_type,
            rawAuthType: context.raw?.auth?.type
        });

        // --- START: Add WebApp Command Handling ---
        const overrideConfig = context.raw?.overrideConfig as any;
        if (overrideConfig?.command === 'get_doc_fields') {
            logInfo(methodName, 'Handling get_doc_fields command from WebApp', { overrideConfig });
            const { templatePath } = overrideConfig;
            if (!templatePath) {
                return botInstance.formatResponse({ error: 'Missing templatePath in command parameters' }, context);
            }
            try {
                const docAgent = agentManager.getAgent('document_processor') as DocumentProcessingAgent;
                if (!docAgent) throw new Error('DocumentProcessingAgent not found');

                // Temporarily cast to any to access potentially private method
                const configResult = await (docAgent as any).loadTemplateConfig(templatePath);
                const { mergedMap, requiredKeys } = configResult;
                if (!mergedMap) throw new Error('Template configuration not found');

                // Filter map to get required field definitions
                const requiredFieldDefinitions: any = { entities: {}, global_placeholders: {} };
                 (requiredKeys || []).forEach((key: string) => {
                    // Temporarily cast to any to access potentially private method
                    const fieldConfig = (docAgent as any).getFieldConfig(key, mergedMap);
                    if (fieldConfig) {
                        const parts = key.split('.');
                        const baseKey = parts[0].replace(/\[\]$/, '');
                        if (mergedMap.entities[baseKey]) {
                            if (!requiredFieldDefinitions.entities[baseKey]) {
                                requiredFieldDefinitions.entities[baseKey] = {
                                    ...mergedMap.entities[baseKey], // Copy entity description, etc.
                                    fields: {}
                                };
                                delete requiredFieldDefinitions.entities[baseKey].fields; // Remove original fields object
                            }
                            if (!requiredFieldDefinitions.entities[baseKey].fields) {
                                 requiredFieldDefinitions.entities[baseKey].fields = {};
                            }
                            requiredFieldDefinitions.entities[baseKey].fields[parts.slice(1).join('.')] = fieldConfig;
                        } else if (mergedMap.global_placeholders[key]) {
                            requiredFieldDefinitions.global_placeholders[key] = fieldConfig;
                        }
                    }
                 });

                logInfo(methodName, 'Returning field definitions to WebApp', { count: requiredKeys?.length || 0 });
                // Return definitions within metadata for the webapp to parse
                return botInstance.formatResponse({
                    text: 'Field definitions retrieved.', // Simple text confirmation
                    content: 'Field definitions retrieved.',
                    metadata: { fieldDefinitions: requiredFieldDefinitions }
                }, context);
            } catch (error) {
                logError(methodName, 'Error handling get_doc_fields:', error);
                return botInstance.formatResponse({ error: `Error getting fields: ${error.message}` }, context);
            }
        } else if (overrideConfig?.command === 'submit_doc_data') {
            logInfo(methodName, 'Handling submit_doc_data command from WebApp', { overrideConfig });
            const { docSessionId, formData } = overrideConfig;
            if (!docSessionId || !formData) {
                return botInstance.formatResponse({ error: 'Missing docSessionId or formData in command parameters' }, context);
            }
            try {
                const docAgent = agentManager.getAgent('document_processor') as DocumentProcessingAgent;
                if (!docAgent) throw new Error('DocumentProcessingAgent not found');

                // Use public method to get state
                const state = docAgent.getState(docSessionId);

                if (!state || state.status !== 'awaiting_webapp_data') {
                    logError(methodName, 'Invalid or expired docSessionId for submit.', new Error('Invalid session'), { docSessionId, status: state?.status });
                    docAgent.deleteState(docSessionId); // Clean up potentially stale state using public method
                    return botInstance.formatResponse({ error: 'Session not found or invalid. Please start again.' }, context);
                }

                state.collectedData = formData;
                state.status = 'generating_document';

                // Generate document (assuming generateDocument is public or accessible)
                const generatedDocument = await (docAgent as any).generateDocument(state); // Use 'any' if needed

                // Send back to Telegram
                const originalChatId = state.chatId; // Retrieve stored chatId from state
                if (originalChatId && botInstance.bot) {
                    logInfo(methodName, `Sending generated document to original chat ID: ${originalChatId}`);
                    const chunks = botInstance.promptManager!.splitAndTruncateMessage(generatedDocument);
                    for (const chunk of chunks) {
                        await botInstance.bot.telegram.sendMessage(originalChatId, chunk, { parse_mode: 'Markdown' });
                        await new Promise(resolve => setTimeout(resolve, 150));
                    }
                    docAgent.deleteState(docSessionId); // Clean up state on success using public method
                    logInfo(methodName, 'Document sent and state cleaned up.', { docSessionId });
                    // Return success to WebApp
                    return botInstance.formatResponse({ text: 'Document generated and sent to your Telegram chat!' }, context);
                } else {
                    logError(methodName, 'Could not send document back to Telegram.', new Error('Missing chatId or bot instance'), { originalChatId, hasBot: !!botInstance.bot });
                    docAgent.deleteState(docSessionId); // Clean up state using public method
                    return botInstance.formatResponse({ error: 'Document generated, but failed to send back to Telegram.' }, context);
                }
            } catch (error) {
                logError(methodName, 'Error handling submit_doc_data:', error);
                 // Attempt to clean up state even on error
                 try {
                     const docAgent = agentManager.getAgent('document_processor') as DocumentProcessingAgent;
                     if (docAgent) {
                         docAgent.deleteState(docSessionId); // Use public method
                     }
                 } catch (cleanupError) {
                     logError(methodName, 'Error cleaning up state after submit error:', cleanupError);
                 }
                return botInstance.formatResponse({ error: `Error generating document: ${error.message}` }, context);
            }
        }
        // --- END: Add WebApp Command Handling ---


        // Set context properties (moved after command check)
        context.isReply = context.raw.isReply || false;
        context.isAI = context.raw.isAI || false;
        if (context.raw.replyTo) {
            context.replyToMessage = {
                message_id: context.raw.replyTo.id,
                text: context.raw.replyTo.text || ''
            };
        }

        // Handle RAG mode logic - applicable for both auth types and flowise
        const isRagModeEnabled = agentManager.isRAGModeEnabled(userId);
        if (isRagModeEnabled && (context.input.toLowerCase() === 'yes' || context.input.toLowerCase() === 'no')) {
            conversationManager.handleRagModeResponse(userId, context.input);
            const responseMessage = context.input.toLowerCase() === 'yes'
                ? "RAG mode has been disabled. You can re-enable it anytime with the /ragmode command."
                : "RAG mode remains enabled. Feel free to continue your conversation!";
            await adapter.reply(responseMessage);
            return responseMessage;
        }

        // Clean the message input
        let cleanedMessage = context.input.trim();
        logInfo(methodName, `Cleaned message:`, {
            message: cleanedMessage,
            isTelegramAuth,
            isWebappAuth,
            isFlowise: context.source === 'flowise',
            userId
        });

        let response: string = '';
        try {
            if (isTelegramAuth || isWebappAuth || context.source === 'flowise') {
                const processMessage: Message.TextMessage = {
                    message_id: context.raw.message?.message_id || Date.now(),
                    date: Math.floor(Date.now() / 1000),
                    text: context.input,
                    from: {
                        id: parseInt(userId.replace(/^(telegram_|tg_|flowise_)/, '')),
                        is_bot: false,
                        first_name: context.raw?.auth?.first_name || context.first_name || 'Unknown',
                        username: context.raw?.auth?.username || context.username
                    },
                    chat: {
                        id: typeof context.chatId === 'string' ? parseInt(context.chatId) : context.chatId,
                        type: 'private',
                        first_name: context.raw?.auth?.first_name || context.first_name || 'Unknown'
                    }
                };

                response = await botInstance.processMessage(
                    adapter,
                    processMessage,
                    context.isAI,
                    context.isReply,
                    interactionType,
                    context.replyToMessage
                );

                // For webapp, include token stats
                if (context.source === 'webapp') {
                    const normalizedUserId = `tg_${userId.replace(/^(telegram_|tg_)/, '')}`;
                    const userStats = await botInstance.getAccountManager().getUserStats(normalizedUserId);

                    // Create response with text and content at top level
                    const formattedResponse: FormattedResponse = {
                        text: response,  // Direct string response
                        content: response,  // Direct string response
                        metadata: {
                            source: 'webapp',
                            timestamp: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' }),
                            tokenStats: userStats ? {
                                quota: userStats.token_quota,
                                used: userStats.token_usage || 0,
                                remaining: userStats.available_tokens || 0,
                                messages: userStats.total_messages || 0,
                                lastReset: new Date(userStats.last_reset || Date.now()).toISOString(),
                                nextReset: userStats.next_reset_date ?
                                         new Date(userStats.next_reset_date).toISOString() :
                                         null,
                                subscription: userStats.subscription_tier
                            } : undefined
                        },
                        question: context.input,
                        chatId: context.chatId?.toString(),
                        chatMessageId: context.messageId?.toString() || Date.now().toString(),
                        isStreamValid: false,
                        sessionId: context.chatId.toString(),
                        memoryType: botInstance.getMemoryType()
                    };

                    // Log the response structure
                    logInfo(methodName, 'Formatted webapp response:', {
                        hasText: !!formattedResponse.text,
                        hasContent: !!formattedResponse.content,
                        hasTokenStats: !!formattedResponse.metadata?.tokenStats,
                        responsePreview: formattedResponse.text?.substring(0, 100)
                    });

                    return formattedResponse;
                }
            }

        } catch (error) {
            logError(methodName, `Error processing message:`, error as Error);
            await botInstance.handleProcessingError(adapter, error);
            response = "An error occurred while processing your message.";
        }

        return response;
    } catch (error) {
        logError(methodName, `Error in message handling`, error as Error);
        return "An unexpected error occurred while processing your message";
    }
}