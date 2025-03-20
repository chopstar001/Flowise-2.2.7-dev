// help.ts 
import { PromptManager } from '../PromptManager';
import { TelegramBot_Agents } from '../TelegramBot_Agents';
import { ContextAdapter } from '../ContextAdapter';
import { logInfo, logError, logWarn } from '../loggingUtility';
import { handlePlatformSpecificResponse } from '../utils/utils';
import { sendConfirmationMessage } from '../utils/confirmationUtil';
import { ExtendedIMessage, Command } from './types';

export const helpCommand: Command = {
    name: 'help',
    description: '📚 Display available commands and bot capabilities',
    execute: async (adapter: ContextAdapter, conversationManager, memory, userId, sessionId, promptManager, botInstance: TelegramBot_Agents) => {
        const methodName = 'helpCommand';
        let deleteConfirmation: (() => Promise<boolean>) | null = null;

        try {
            logInfo(methodName, `Executing help command for user ${userId} in session: ${sessionId}`);

            const [confirmationMessage, deleteConfirmationFn] = await sendConfirmationMessage(adapter);
            deleteConfirmation = deleteConfirmationFn;

            const commandList = conversationManager.getCommands()
                .map(cmd => `/${cmd.name} - ${cmd.description}`)
                .join('\n');

            let knowledgeBaseOverview: string;
            try {
                knowledgeBaseOverview = await conversationManager.getVectorStoreOverview();
                knowledgeBaseOverview = addEmojisToOverview(knowledgeBaseOverview);
            } catch (error) {
                logError(methodName, "Error getting vector store overview:", error);
                knowledgeBaseOverview = "🚫 I'm having trouble accessing my knowledge base at the moment.";
            }

            const helpMessage = `
<b>🤖 Welcome to Your AI Assistant!</b>

I'm here to help you with various tasks and answer your questions. Here's what I can do:

<b>📚 Knowledge Base:</b>
${knowledgeBaseOverview}`;

            if (promptManager) {
                const messageChunks = promptManager.splitAndTruncateMessage(helpMessage, 4000);
                for (const chunk of messageChunks) {
                    await adapter.replyWithHTML(chunk);
                }
            } else {
                console.warn('[help.ts]PromptManager is not initialized. Sending message without splitting.');
                await adapter.replyWithHTML(helpMessage);
                return;
            }

            // Handle platform-specific responses
            await handlePlatformSpecificResponse(
                adapter,
                async () => {
                    // Get all available commands
                    const commands = conversationManager.getCommands();
                    const commandList = commands
                        .map(cmd => `/${cmd.name} - ${cmd.description}`)
                        .join('\n');

                    const helpMessage = `🤖 *Available Commands*\n\n${commandList}\n\n` +
                        `💡 *Additional Features*\n` +
                        `• Use RAG mode for detailed answers (/ragmode)\n` +
                        `• Search the web for information (/searchweb)\n` +
                        `• Reply to messages for context-aware responses\n` +
                        `• Send images for visual analysis\n\n` +
                        `🔍 *Tips*\n` +
                        `• Start your message with @ to mention specific bots\n` +
                        `• Use the inline menu for quick access to features\n` +
                        `• Check your token usage with /stats\n\n` +
                        `Need more help? Feel free to ask specific questions!\n\n`; +
                        `How can I assist you today?`;

                    // Send help message first
                    await adapter.reply(helpMessage, { parse_mode: 'Markdown' });

                    try {
                        console.log(`[${methodName}] Creating menus`);
                        
                        // Create and send inline menu
                        const inlineMenu = await botInstance.menuManager.createStartInlineMenu(adapter);
                        await adapter.reply("Quick access buttons:", { 
                            reply_markup: inlineMenu.reply_markup,
                            parse_mode: 'HTML'
                        });

                        // Create and send keyboard menu
                        const keyboardMenu = await botInstance.menuManager.createStartKeyboardMenu(adapter);
                        await adapter.reply("Keyboard shortcuts:", { 
                            reply_markup: keyboardMenu.reply_markup,
                            parse_mode: 'HTML'
                        });

                        console.log(`[${methodName}] Menus sent successfully`);
                    } catch (error) {
                        console.error(`[${methodName}] Error sending menus:`, error);
                        // Continue execution even if menu sending fails
                    }

                    // Store in memory if available
                    if (memory) {
                        try {
                            await memory.addChatMessagesExtended([
                                {
                                    message: '/help',
                                    text: '/help',
                                    type: 'userMessage',
                                    metadata: {
                                        userId,
                                        sessionId,
                                        timestamp: Date.now()
                                    }
                                } as ExtendedIMessage,
                                {
                                    message: helpMessage,
                                    text: helpMessage,
                                    type: 'apiMessage',
                                    metadata: {
                                        userId,
                                        sessionId,
                                        timestamp: Date.now()
                                    }
                                } as ExtendedIMessage
                            ], userId, sessionId);
                        } catch (error) {
                            console.error(`[${methodName}] Error storing in memory:`, error);
                            // Continue execution even if memory storage fails
                        }
                    }
                },
                [
                    { command: '/help', description: 'Show help information' },
                    { command: '/start', description: 'Start or restart the bot' },
                    { command: '/ragmode', description: 'Toggle RAG mode' },
                    { command: '/searchweb', description: 'Search the web' },
                    { command: '/stats', description: 'Show your usage statistics' }
                ]
            );
        } catch (error) {
            console.error(`[${methodName}] Error executing help command:`, error);
            await adapter.reply("I'm having trouble showing the help information. Please try again later.");
        } finally {
            if (deleteConfirmation) {
                await deleteConfirmation();
            }
        }
    }
};

function addEmojisToOverview(overview: string): string {
    const lines = overview.split('\n');
    const emojiLines = lines.map(line => {
        if (line.toLowerCase().includes('introduction')) return `🎉 ${line}`;
        if (line.toLowerCase().includes('main topics') || line.toLowerCase().includes('areas of knowledge')) return `🗂️ ${line}`;
        if (line.toLowerCase().includes('books') || line.toLowerCase().includes('documents')) return `📚 ${line}`;
        if (line.toLowerCase().includes('conclusion') || line.toLowerCase().includes('summary')) return `🎓 ${line}`;
        return `ℹ️ ${line}`;
    });
    return emojiLines.join('\n');
}