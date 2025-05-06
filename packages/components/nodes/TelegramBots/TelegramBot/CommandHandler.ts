import { Context, Telegraf, Markup } from 'telegraf';
import { ConversationManager } from './ConversationManager';
import { FileManager } from './FileManager';
import { MessageType } from '../../../src/Interface'
import { IExtendedMemory, Command, ExtendedIMessage, SourceCitation, EnhancedResponse, BotInfo, InteractionType } from './commands/types';
//import * as commands from './commands';
import { BotCommand, Update, InlineKeyboardMarkup } from 'telegraf/typings/core/types/typegram';
import { PromptManager } from './PromptManager';
import { ToolManager } from './ToolManager';
import { AgentManager } from './AgentManager';
import { RAGAgent } from './agents/RAGAgent';
import { TelegramBot_Agents } from './TelegramBot_Agents';
import { BaseMessage, HumanMessage, AIMessage, SystemMessage, MessageContent, isAIMessage } from '@langchain/core/messages';
import { MenuManager, } from './MenuManager';
import { ContextAdapter, } from './ContextAdapter';
import { ExtraEditMessageText } from 'telegraf/typings/telegram-types';
import { ThinkingDisplayMode, ThinkingPreferences, ThinkingBlock } from './utils/types/ThinkingTypes';
import { GameAgent } from './agents/GameAgent';
import { PatternPromptAgent } from './agents/PatternPromptAgent';
import * as commandModules from './commands';
// At the top of CommandHandler.ts with other imports
import {
    LifelineType,
    PatternContextData,
    PatternData,
    ContextRequirement,
    TranscriptionEstimate,
    TranscriptionOptions // Import TranscriptionOptions
} from './commands/types';
import { fsync } from 'fs';
// At the top of CommandHandler.ts with other imports
import {
    transcriptionSettingsCommand,
    createTranscriptionSettingsKeyboard,
    formatTranscriptionSettingsMessage,
    TranscriptionSettingsUtil,
    TranscriptionSettings // Import TranscriptionSettings type
} from './commands/transcriptionsettings';
import { decodeFilename } from './commands/processfolder'; // Add this import
import * as path from 'path'; // Ensure path is imported

// Helper function to escape characters for Telegram HTML parsing
const escapeTelegramHTML = (text: string): string => {
    if (!text) return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
};

const transcriptionEstimates = new Map<string, TranscriptionEstimate>();

export class CommandHandler {
    private bot: Telegraf<Context>;
    private conversationManager: ConversationManager | null;
    private memory: IExtendedMemory | null;
    private promptManager: PromptManager | null;
    private agentManager: AgentManager | null;
    private telegramBot: TelegramBot_Agents | null;
    private botIds: number[] = [];
    private botCommandMenus: Map<number, Markup.Markup<InlineKeyboardMarkup>>;
    private botInfo: BotInfo[];
    public menuManager: MenuManager | null;
    private flowId: string;
    private toolManager: ToolManager;
    private fileManager: FileManager;



    constructor(
        bot: Telegraf<Context>,
        conversationManager: ConversationManager | null,
        memory: IExtendedMemory | null,
        promptManager: PromptManager | null,
        agentManager: AgentManager | null,
        menuManager: MenuManager | null,
        toolManager: ToolManager | null,
        fileManager: FileManager | null,

        flowId: string,
        config?: {
            telegramBot: TelegramBot_Agents,
        }

    ) {
        this.bot = bot;
        this.conversationManager = conversationManager;
        this.memory = memory;
        this.promptManager = promptManager;
        this.agentManager = agentManager;
        this.menuManager = menuManager;
        this.toolManager;
        this.telegramBot = config?.telegramBot || null;
        this.botIds = this.telegramBot?.getBotIds() || [];
        this.botCommandMenus = new Map();
        this.botInfo = this.telegramBot?.getAllBotInfo() || [];
        this.flowId = flowId;
        const botToken = config?.telegramBot.getBotToken();
        this.fileManager = new FileManager(botToken);


        console.log(`[CommandHandler:${flowId}] Initialized with:`, {
            hasBot: !!bot,
            hasConversationManager: !!conversationManager,
            hasMemory: !!memory,
            hasPromptManager: !!promptManager,
            hasAgentManager: !!agentManager,
            hasMenuManager: !!menuManager,
            hasToolManager: !!toolManager,
            hasTelegramBot: !!config?.telegramBot
        });
    }


    async hideCommandMenu(ctx: Context) {
        // Logic to remove the inline keyboard
    }
    public setConversationManager(conversationManager: ConversationManager) {
        this.conversationManager = conversationManager;
    }

    public setMemory(memory: IExtendedMemory) {
        this.memory = memory;
    }

    public setPromptManager(promptManager: PromptManager) {
        this.promptManager = promptManager;
    }

    public setAgentManager(agentManager: AgentManager) {
        this.agentManager = agentManager;
    }

    public setMenuManager(menuManager: MenuManager) {
        this.menuManager = menuManager;
    }
    private getToolManager(): ToolManager | null {
        if (this.telegramBot) {
            return this.telegramBot.getToolManager();
        }
        return null;
    }
    async registerCommands(): Promise<void> {
        if (!this.conversationManager) {
            console.error('ConversationManager is not initialized. Cannot register commands.');
            return;
        }

        try {
            // Initialize bot commands array
            const botCommands: BotCommand[] = [];

            // Get commands only after all setup is complete
            const commands = Object.values(commandModules);

            if (!Array.isArray(commands)) {
                console.error('Commands not in array format. Received:', commands);
                return;
            }

            if (commands.length === 0) {
                console.warn('No commands to register.');
                return;
            }

            // Register each command
            for (const command of commands) {
                if (this.isValidCommand(command)) {
                    this.bot.command(command.name, async (ctx) => {
                        if (ctx.message && 'text' in ctx.message) {
                            const fullCommand = ctx.message.text.split(' ')[0];
                            const [commandName, targetBot] = fullCommand.split('@');
                            if (!targetBot || targetBot === this.bot.botInfo?.username) {
                                const adapter = new ContextAdapter(ctx, this.promptManager);
                                await this.executeCommand(adapter, command);
                            }
                        }
                    });
                    console.log(`Registered command: ${command.name}`);

                    botCommands.push({
                        command: command.name,
                        description: command.description
                    });
                } else {
                    console.error('Invalid command structure:', command);
                }
            }
            this.bot.action(/^millionaire_(.+)$/, async (ctx) => {
                const methodName = 'millionaireCallback';
                console.log(`[${methodName}] Processing millionaire callback`);

                const adapter = new ContextAdapter(ctx, this.promptManager);
                const userId = ctx.from?.id.toString();
                if (!userId) {
                    console.warn(`[${methodName}] Could not identify user from context`);
                    await adapter.reply("Could not identify user.");
                    return;
                }

                const command = ctx.match[1];
                console.log(`[${methodName}] Processing command: ${command} for user: ${userId}`);

                try {
                    await this.handleMillionaireCommand(adapter, command, userId);
                } catch (error) {
                    console.error(`[${methodName}] Error handling millionaire command:`, error);
                    await adapter.reply("An error occurred during the game. Please try again.");
                }
            });
            this.bot.action(/thinking_mode_(.+)/, async (ctx) => {
                const adapter = new ContextAdapter(ctx, this.promptManager);
                const mode = ctx.match[1];

                // Update user preferences
                // Implement preference storage mechanism

                await adapter.answerCallbackQuery(`Thinking display mode set to: ${mode}`);
            });

            this.bot.action('thinking_show_more', async (ctx) => {
                const adapter = new ContextAdapter(ctx, this.promptManager);
                // Implement show more logic using cached thinking content
            });

            this.bot.action('thinking_hide', async (ctx) => {
                const adapter = new ContextAdapter(ctx, this.promptManager);
                await ctx.deleteMessage();
            });

            // Register the action handler for RAG mode toggle
            this.bot.action(/^ragmode:/, (ctx) => {
                const adapter = new ContextAdapter(ctx, this.promptManager);
                return this.handleRagModeToggle(adapter);
            });

            // Register handlers for bot selection and command execution
            this.bot.action(/^select_bot:/, (ctx) => {
                const adapter = new ContextAdapter(ctx, this.promptManager);
                return this.handleBotSelection(adapter);
            });

            this.bot.action(/^execute_command:/, (ctx) => {
                const adapter = new ContextAdapter(ctx, this.promptManager);
                return this.handleCommandExecution(adapter);
            });
            this.bot.action(/^pattern_(.+)$/, async (ctx) => {
                const fullAction = ctx.match[1];
                const adapter = new ContextAdapter(ctx, this.promptManager);

                console.log(`[CommandHandler] Received pattern action: ${fullAction}`);

                // Split action and parameter
                let action: string;
                let parameter: string | undefined;

                if (fullAction.includes(':')) {
                    const parts = fullAction.split(':');
                    action = parts[0];
                    parameter = parts.slice(1).join(':'); // Rejoin in case parameter itself contains ':'
                } else {
                    action = fullAction;
                }

                // Handle the action
                await this.handlePatternAction(adapter, action, parameter);
            });
            // Input chunk navigation - separate handler for clarity
            this.bot.action(/^pattern_input_chunk:(.+)$/, async (ctx) => {
                const direction = ctx.match[1]; // prev, next, first, last
                const adapter = new ContextAdapter(ctx, this.promptManager);

                console.log(`[CommandHandler] Input chunk navigation: ${direction}`);

                await this.navigateInputChunks(
                    adapter,
                    adapter.getMessageContext().userId.toString(),
                    direction
                );
            });
            this.bot.action(/^yt_get:([^:]+):(.+)$/, async (ctx) => {
                const videoId = ctx.match[1];
                const action = ctx.match[2];
                const adapter = new ContextAdapter(ctx, this.promptManager);
                await this.handleYouTubeAction(adapter, videoId, action);
            });
            this.bot.action(/^rumble_get:([^:]+):(.+)$/, async (ctx) => {
                const adapter = new ContextAdapter(ctx, this.promptManager);
                const videoId = ctx.match[1];
                const action = ctx.match[2];
                await this.handleRumbleAction(adapter, videoId, action);
            });
            this.bot.action(/^standard_menu:(.+):(\d+)$/, async (ctx) => {
                const adapter = new ContextAdapter(ctx, this.promptManager);
                const [action, botId] = ctx.match?.slice(1) || ['', ''];

                await this.handleStandardMenuAction(adapter, action, parseInt(botId));
            });

            // Register the transcription settings action handler
            this.bot.action(/^ts_([^:]+)(?::(\d+)(?::(.+))?)?$/, async (ctx) => {
                const adapter = new ContextAdapter(ctx, this.promptManager);
                const action = ctx.match[1];
                const value = ctx.match[3];
                await this.handleTranscriptionSettingsAction(adapter, action, value);
            });
            // Ensure processfile action handlers are registered within registerCommands
            this.bot.action(/^processfile:(.+)$/, async (ctx) => {
                 if (!ctx.match || !ctx.match[1]) return; // Add null check for safety
                 const adapter = new ContextAdapter(ctx, this.promptManager);
                 const callbackData = ctx.match[1];
                 await this.handleProcessFileAction(adapter, `processfile:${callbackData}`);
             });
             this.bot.action('processfile_cancel', async (ctx) => {
                 const adapter = new ContextAdapter(ctx, this.promptManager);
                 await this.handleProcessFileAction(adapter, 'processfile:cancel');
            });
            // Add the new action handler registration for processfile
            this.bot.action(/^processfile:(.+)$/, async (ctx) => {
                const adapter = new ContextAdapter(ctx, this.promptManager);
                const callbackData = ctx.match[1]; // Extract data after "processfile:"
                // Pass the full callback data string including the prefix
                await this.handleProcessFileAction(adapter, `processfile:${callbackData}`);
            });

             // Add handler for the cancel button specifically
             this.bot.action('processfile_cancel', async (ctx) => {
                const adapter = new ContextAdapter(ctx, this.promptManager);
                // Call the handler with a specific cancel action format
                await this.handleProcessFileAction(adapter, 'processfile:cancel');
            });
            await this.bot.telegram.setMyCommands(botCommands);
            console.log('Bot commands set successfully');

            // Update ConversationManager with registered commands
            this.conversationManager.setCommands(commands);
            console.log('Commands registered in ConversationManager');

        } catch (error) {
            console.error('Error registering commands:', error);
            throw error;
        }
    }
    public async executeCommandByName(adapter: ContextAdapter, commandName: string): Promise<void> {
        const command = Object.values(commandModules).find(cmd => cmd.name === commandName);
        if (command) {
            await this.executeCommand(adapter, command);
        } else {
            await adapter.reply("Unknown command. Type /help for a list of available commands.");
        }
    }
    public createCommandMenus(): void {
        this.botInfo.forEach(bot => {
            const botCommands = Object.values(commandModules);
            const keyboard = Markup.inlineKeyboard(
                botCommands.map(cmd => [
                    Markup.button.callback(`/${cmd.name}`, `execute_command:${bot.id}:${cmd.name}`)
                ])
            );
            this.botCommandMenus.set(bot.id, keyboard);
        });
    }

    public async showCommandMenu(adapter: ContextAdapter, botId: number, page: number = 0): Promise<void> {
        console.log(`Showing command menu for bot ID: ${botId}, page: ${page}`);

        const bot = this.botInfo.find(b => b.id === botId);
        if (!bot) {
            console.warn(`[CommandHandler] Bot not found for ID: ${botId}`);
            if (adapter.isCallbackQuery()) {
                await adapter.answerCallbackQuery("Bot not found.");
            }
            return;
        }

        // Debug check for managers
        if (!this.conversationManager) {
            console.error('[CommandHandler] conversationManager is not initialized');
            return;
        }
        if (!this.menuManager) {
            console.error('[CommandHandler] menuManager is not initialized');
            return;
        }

        // Get and verify commands
        const commands = this.conversationManager.getCommands();
        console.log('[CommandHandler] Retrieved commands:', {
            commandsExist: !!commands,
            commandCount: commands?.length,
            commandList: commands?.map(c => c.name)
        });

        if (!commands || commands.length === 0) {
            console.warn('[CommandHandler] No commands available from ConversationManager');
            await adapter.reply("Commands are currently unavailable. Please try again later.");
            return;
        }

        // Create menu with verified commands
        const commandMenu = this.menuManager.createBotCommandMenu(botId, commands, page);

        const text = `Available commands for ${bot.firstName} (Page ${page + 1}):`;
        const extra: any = {
            reply_markup: commandMenu.reply_markup
        };

        try {
            let sentMessage;
            if (adapter.isCallbackQuery()) {
                sentMessage = await adapter.editMessageText(text, extra);
            } else {
                sentMessage = await adapter.reply(text, extra);
            }

            if (sentMessage && typeof sentMessage === 'object' && 'message_id' in sentMessage) {
                this.menuManager.setMenuTimeout(adapter, sentMessage.message_id, 60000);
            }
            console.log(`Command menu displayed for bot: ${bot.firstName}, page: ${page}`);
        } catch (error) {
            console.error('Error displaying command menu:', error);
            if (adapter.isCallbackQuery()) {
                await adapter.answerCallbackQuery("Unable to display command menu. Please try again.");
            } else {
                await adapter.reply("Unable to display command menu. Please try again.");
            }
        }
    }

    private async executeCommand(adapter: ContextAdapter, command: Command): Promise<void> {
        const methodName = 'executeCommand';
        console.log(`[${methodName}] Entering executeCommand`);

        if (!this.conversationManager) {
            await adapter.reply("Bot is not fully initialized. Please try again later.");
            return;
        }

        try {
            const { userId, sessionId } = await this.conversationManager.getSessionInfo(adapter.getMessageContext());
            if (this.telegramBot) {
                console.warn(`[${methodName}] Executing Command: ${command.name}`);

                // Update the Command interface to accept ContextAdapter instead of Context
                await command.execute(
                    adapter,
                    this.conversationManager,
                    this.memory,
                    userId,
                    sessionId,
                    this.promptManager,
                    this.telegramBot
                );
            } else {
                console.error(`TelegramBot instance is null for command: ${command.name}`);
                await adapter.reply("Unable to process command due to a configuration issue.");
            }
        } catch (error) {
            console.error(`Error executing command ${command.name}:`, error);
            await adapter.reply("An error occurred while processing your command. Please try again later.");
        }
    }

    private async handleBotSelection(adapter: ContextAdapter): Promise<void> {
        const context = adapter.getMessageContext();
        if (!context.callbackQuery || !context.callbackQuery.data) return;
        const botId = parseInt(context.callbackQuery.data.split(':')[1]);
        await this.showCommandMenu(adapter, botId);
    }

    private async handleCommandExecution(adapter: ContextAdapter): Promise<void> {
        const context = adapter.getMessageContext();
        if (!context.callbackQuery || !context.callbackQuery.data) return;
        const [, , commandName] = context.callbackQuery.data.split(':');
        await this.executeCommandByName(adapter, commandName);
    }


    public createCommandMenu(botId: number): void {
        const botCommands = Object.values(commandModules);
        const keyboard = Markup.inlineKeyboard(
            botCommands.map(cmd => [Markup.button.callback(`/${cmd.name}`, `execute_command:${botId}:${cmd.name}`)])
        );
        this.botCommandMenus.set(botId, keyboard);
    }



    async handleMessage(adapter: ContextAdapter, input?: string, interactionType?: InteractionType, replyToMessage?: { message_id: number; text: string },
    ): Promise<void> {
        console.log("[CommandHandler]Entering handleMessage");
        if (!this.conversationManager || !this.memory) {
            await adapter.reply("Bot is not fully initialized. Please try again later.");
            return;
        }

        const context = adapter.getMessageContext();
        const { userId, sessionId } = await this.conversationManager.getSessionInfo(context);

        // If input is not provided, try to get it from the message
        if (!input) {
            if (!context.raw.message || !('text' in context.raw.message)) {
                await adapter.reply("I can only process text messages.");
                return;
            }
            input = context.raw.message.text;
        }

        // Ensure input is not undefined
        if (input === undefined) {
            await adapter.reply("I couldn't understand your message. Please try again.");
            return;
        }

        const chatHistoryResult = await this.memory.getChatMessagesExtended(userId, sessionId);
        const chatHistory: BaseMessage[] = this.convertToChatHistory(chatHistoryResult);

        // Always process the input to get the enhancedResponse
        const enhancedResponse = await this.conversationManager.processWithRAGAgent(input, chatHistory, interactionType!, userId, adapter, replyToMessage);

        // Send the main response
        await adapter.reply(enhancedResponse.response.join('\n'));

        // Handle source citations
        if (enhancedResponse.sourceCitations && enhancedResponse.sourceCitations.length > 0) {
            const citationsText = enhancedResponse.sourceCitations.map((citation: SourceCitation) =>
                `📚 ${citation.text} (Source: ${citation.source})`
            ).join('\n\n');
            await adapter.reply(`Sources:\n${citationsText}`);
        }

        // Handle follow-up questions
        if (enhancedResponse.followUpQuestions && enhancedResponse.followUpQuestions.length > 0) {
            const keyboard = Markup.inlineKeyboard(
                enhancedResponse.followUpQuestions.map((question: string) =>
                    [Markup.button.callback(`🔍 ${question}`, `follow_up:${question}`)]
                )
            );
            await adapter.reply('🤔 Would you like to explore any of these follow-up questions?', {
                reply_markup: keyboard.reply_markup
            });
        }

        // Handle external agent suggestion
        if (enhancedResponse.externalAgentSuggestion) {
            await adapter.reply(`🤖 An external agent might be able to assist further: ${enhancedResponse.externalAgentSuggestion}`);
        }

        // Update memory
        if (this.telegramBot && 'updateMemory' in this.telegramBot) {
            await this.telegramBot.updateMemory(adapter, [
                new HumanMessage(input),
                new AIMessage(enhancedResponse.response.join('\n'))
            ]);
        }
    }

    public convertToChatHistory(chatHistoryResult: any[]): BaseMessage[] {
        return chatHistoryResult.map(msg => {
            if (this.isExtendedIMessage(msg)) {
                const content = this.getMessageContent(msg);
                if (msg.type === 'userMessage') {
                    return new HumanMessage(content);
                } else if (msg.type === 'apiMessage') {
                    return new AIMessage(content);
                } else {
                    return new SystemMessage(content);
                }
            } else if (msg instanceof BaseMessage) {
                return msg;
            } else {
                return new SystemMessage('Unknown message type');
            }
        });
    }



    getCommandList(): string {
        return Object.values(commandModules)
            .map(cmd => `/${cmd.name} - ${cmd.description}`)
            .join('\n');
    }

    private isValidCommand(command: any): command is Command {
        return command &&
            typeof command.name === 'string' &&
            typeof command.description === 'string' &&
            typeof command.execute === 'function';
    }
    private async handleRagModeToggle(adapter: ContextAdapter): Promise<void> {
        try {
            const context = adapter.getMessageContext();
            if (!context.callbackQuery || !('data' in context.callbackQuery)) {
                console.error('Invalid callback query');
                await adapter.answerCallbackQuery('Invalid request. Please try again.');
                return;
            }

            const botId = context.callbackQuery.data.split(':')[1];
            const chatId = context.chatId;

            if (!chatId) {
                console.error('Chat ID is undefined');
                await adapter.answerCallbackQuery('Unable to process request. Chat information is missing.');
                return;
            }

            if (!this.telegramBot) {
                console.error('TelegramBot instance is not available');
                await adapter.answerCallbackQuery('Bot is not fully initialized. Please try again later.');
                return;
            }

            const botInfo = this.telegramBot.getAllBotInfo().find(bot => bot.id.toString() === botId);
            if (!botInfo) {
                await adapter.answerCallbackQuery('Selected bot not found.');
                return;
            }

            if (this.agentManager) {
                const ragAgent = this.agentManager.getAgent('rag') as RAGAgent;
                if (ragAgent && 'isRAGModeEnabled' in ragAgent && 'toggleRAGMode' in ragAgent) {
                    const currentStatus = ragAgent.isRAGModeEnabled(botId);
                    ragAgent.toggleRAGMode(botId, !currentStatus);
                    const newStatus = !currentStatus;

                    await adapter.answerCallbackQuery(`RAG mode ${newStatus ? 'enabled' : 'disabled'} for @${botInfo.username || botInfo.firstName}`);
                    await adapter.editMessageText(`RAG mode ${newStatus ? 'enabled' : 'disabled'} for @${botInfo.username || botInfo.firstName}`);
                } else {
                    await adapter.answerCallbackQuery('Unable to toggle RAG mode. RAG Agent not properly configured.');
                }
            } else {
                await adapter.answerCallbackQuery('Unable to toggle RAG mode. AgentManager not initialized.');
            }
        } catch (error) {
            console.error('Error in handleRagModeToggle:', error);
            await adapter.answerCallbackQuery('An error occurred while processing your request. Please try again later.');
        }
    }

    private isExtendedIMessage(msg: any): msg is ExtendedIMessage {
        return (
            typeof msg === 'object' &&
            msg !== null &&
            'type' in msg &&
            ('text' in msg || 'message' in msg)
        );
    }

    private getMessageContent(msg: ExtendedIMessage): string {
        const content = msg.text || msg.message;
        if (typeof content === 'string') {
            return content;
        } else if (Array.isArray(content)) {
            return content.map(item => this.stringifyContent(item)).join(' ');
        } else if (content && typeof content === 'object') {
            return this.stringifyContent(content);
        } else {
            return '';
        }
    }

    private stringifyContent(item: any): string {
        if (typeof item === 'string') {
            return item;
        } else if (typeof item === 'object' && item !== null) {
            if ('text' in item) {
                return item.text;
            } else if ('image_url' in item) {
                return `[Image: ${item.image_url.url}]`;
            } else {
                return JSON.stringify(item);
            }
        } else {
            return String(item);
        }
    }

    private isRAGAgent(agent: any): agent is RAGAgent {
        return (
            typeof agent === 'object' &&
            agent !== null &&
            'isRAGModeEnabled' in agent &&
            'toggleRAGMode' in agent &&
            typeof agent.isRAGModeEnabled === 'function' &&
            typeof agent.toggleRAGMode === 'function'
        );
    }



    // In CommandHandler.ts
    public async handleMillionaireCommand(adapter: ContextAdapter, command: string, _userId: string) {
        const methodName = 'handleMillionaireCommand';
        const context = adapter.getMessageContext();
        try {
            const [action, parameter] = command.split(':');
            // Try to answer the callback query but don't let it stop execution
            await adapter.answerCallbackQuery(`Action Received: "${parameter}", processing....`);
        } catch (callbackError: unknown) { // Add type annotation
            // If this fails (due to double-click or timeout), just log and continue
            // Type check before accessing properties
            const description = (callbackError as any)?.response?.description;
            if (typeof description === 'string' && (description.includes('query is too old') || description.includes('query ID is invalid'))) {
                console.log(`[${methodName}] Callback already answered or expired:`, description);
                // Continue execution - don't return
            } else {
                // For other unexpected callback errors, log but continue
                console.warn(`[${methodName}] Unexpected callback error:`, callbackError instanceof Error ? callbackError.message : String(callbackError));
            }
        }
        const { userId, sessionId } = await this.conversationManager!.getSessionInfo(adapter);
        const chatId = context.chatId;
        console.log(`[${methodName}] Processing command:`, {
            originalUserId: userId,
            userId,
            command,
            timestamp: new Date().toISOString()
        });

        const gameAgent = this.agentManager?.getAgent('game') as GameAgent;
        if (!gameAgent) {
            console.error(`[${methodName}] Game agent not available`);
            await adapter.replyWithAutoDelete("Game system is not available. Please try again later.", 30000);
            return;
        }

        try {
            const [action, parameter] = command.split(':');
            const gameState = gameAgent.getGameState(userId);

            if (!gameState?.isActive) {
                throw new Error('No active game');
            }

            switch (action) {
                case 'answer':
                    if (!gameState.currentQuestion || !gameState.lastMessageId) {
                        throw new Error('No active question');
                    }
                    console.log(`[${methodName}, Received answer: "${parameter}"`);
                    const numericAnswer = this.convertAnswerToIndex(parameter);
                    if (numericAnswer === -1) {
                        await adapter.replyWithAutoDelete("[handleMillionaireCommand] Invalid answer received. Please try again.", 30000);
                        return;
                    }
                    if (!gameAgent['isSessionOwner'](userId, chatId)) {
                        await this.safeAnswerCallback(adapter, 'Only the player who started the game can interact with it');
                        return;
                    }
                    // Submit answer will handle message editing internally
                    const result = await gameAgent.submitAnswer(adapter, userId, numericAnswer);

                    if (result.correct && gameState.lastMessageId) {
                        // Progress to next question will handle message editing internally
                        const nextResponse = await gameAgent.progressToNextQuestion(adapter, userId);
                        // No need to send new message, the GameAgent will handle editing the existing one
                    }
                    break;

                case 'lifeline':
                    if (!gameState.currentQuestion || !gameState.lastMessageId) {
                        throw new Error('No active question');
                    }
                    if (!gameAgent['isSessionOwner'](userId, chatId)) {
                        await this.safeAnswerCallback(adapter, 'Only the player who started the game can interact with it');
                        return;
                    }

                    let lifelineType: LifelineType;
                    switch (parameter) {
                        case '5050':
                            lifelineType = 'fiftyFifty';
                            break;
                        case 'phone':
                            lifelineType = 'phoneAFriend';
                            break;
                        case 'audience':
                            lifelineType = 'askTheAudience';
                            break;
                        default:
                            throw new Error(`Invalid lifeline type: ${parameter}`);
                    }

                    console.log(`[${methodName}] Using lifeline:`, {
                        userId: userId,
                        lifelineType,
                        questionId: gameState.currentQuestion?.question,
                        messageId: gameState.lastMessageId
                    });

                    // useLifeline will handle message editing internally
                    if (gameState.lastMessageId) {
                        await gameAgent.useLifeline(adapter, userId, lifelineType);
                    }
                    break;

                case 'new':
                    if (gameState.isActive) {
                        await adapter.replyWithAutoDelete("[handleMillionaireCommand] Game already in session!", 30000);
                        return;
                    }
                    await adapter.reply("/millionaire");
                    break;

                case 'quit':
                    await gameAgent.exitGame(adapter, userId, 'user_exit');
                    break;

                default:
                    await adapter.replyWithAutoDelete("Invalid game command. Please try again.", 30000);
                    break;
            }
        } catch (error: unknown) { // Add type annotation
            console.error(`[${methodName}] Error:`, error instanceof Error ? error.message : String(error));
            let errorMessage = "An error occurred during the game. Please try again.";
            if (error instanceof Error) {
                errorMessage = error.message === 'No active game' ?
                    "No active game found. Use /millionaire to start a new game." :
                    error.message === 'No active question' ?
                        "No active question. Use /millionaire to start a new game." :
                        error.message; // Use the actual error message if it's not one of the specific cases
            }

            await adapter.replyWithAutoDelete(errorMessage, 30000);
        }
    }

    private convertAnswerToIndex(answer: string): number {
        console.warn(`[CommandHandler, convertAnswerToIndex] Received answer: "${answer}"`);

        const answerMap: { [key: string]: number } = {
            'A': 0,
            'B': 1,
            'C': 2,
            'D': 3
        };

        const index = answerMap[answer] ?? -1;

        if (index === -1) {
            console.warn(`[convertAnswerToIndex] Unexpected answer value: "${answer}". Returning -1.`);
        } else {
            console.log(`[convertAnswerToIndex] Mapped answer "${answer}" to index: ${index}`);
        }

        return index;
    }
    public async handleThinkingCallback(adapter: ContextAdapter, data: string): Promise<void> {
        const context = adapter.getMessageContext();
        const messageId = context.messageId?.toString();

        if (!messageId) {
            await this.safeAnswerCallback(adapter, 'Message ID not available');
            return;
        }

        try {
            if (!this.conversationManager) {
                await this.safeAnswerCallback(adapter, 'System not ready');
                return;
            }

            const thinkingManager = this.conversationManager.getThinkingManager();
            if (!thinkingManager) {
                await this.safeAnswerCallback(adapter, 'Thinking system not available');
                return;
            }

            if (data === 'thinking_toggle') {
                await thinkingManager.handleThinkingToggle(adapter, messageId);
            } else if (data.startsWith('thinking_mode_')) {
                const mode = data.replace('thinking_mode_', '') as ThinkingDisplayMode;
                await this.updateThinkingPreferences(adapter, mode);
            } else {
                await this.safeAnswerCallback(adapter, 'Unknown thinking action');
            }
        } catch (error) {
            console.error('Error in handleThinkingCallback:', error);
            await this.safeAnswerCallback(adapter, 'Error processing thinking action');
        }
    }


    private async safeAnswerCallback(adapter: ContextAdapter, text: string): Promise<void> {
        try {
            await adapter.answerCallbackQuery(text);
        } catch (error: unknown) { // Add type annotation
            // If the callback query is expired, try to send a regular message instead
            const description = (error as any)?.response?.description;
            if (typeof description === 'string' && (description.includes('query is too old') || description.includes('query ID is invalid'))) {
                try {
                    // Send a temporary message instead
                    await adapter.replyWithAutoDelete(text, 5000);
                } catch (msgError: unknown) { // Add type annotation
                    console.warn('Failed to send fallback message:', msgError instanceof Error ? msgError.message : String(msgError));
                }
            } else {
                console.warn('Failed to answer callback:', error instanceof Error ? error.message : String(error));
            }
        }
    }


    private async updateThinkingPreferences(adapter: ContextAdapter, mode: ThinkingDisplayMode): Promise<void> {
        const context = adapter.getMessageContext();
        const userId = context.userId.toString();

        if (!this.conversationManager) {
            await this.safeAnswerCallback(adapter, 'System not ready');
            return;
        }

        const thinkingManager = this.conversationManager.getThinkingManager();
        if (!thinkingManager) {
            await this.safeAnswerCallback(adapter, 'Thinking system not available');
            return;
        }

        // Update preferences in ThinkingManager
        await thinkingManager.updatePreferences(userId, {
            displayMode: mode,
            showThinking: mode !== ThinkingDisplayMode.HIDDEN,
            thinkingDuration: 12 * 60 * 60 * 1000, // 12 hours
            format: 'detailed',
            autoDelete: mode !== ThinkingDisplayMode.DEBUG_ONLY
        });

        await adapter.reply(`Thinking display mode updated to: ${mode}`);
    }


    public setupThinkingHandlers(): void {
        this.bot.action(/thinking_toggle/, async (ctx) => {
            const adapter = new ContextAdapter(ctx, this.promptManager);
            await this.handleThinkingCallback(adapter, 'thinking_toggle');
        });

        this.bot.action(/thinking_mode_(.+)/, async (ctx) => {
            const adapter = new ContextAdapter(ctx, this.promptManager);
            const mode = ctx.match[1];
            await this.handleThinkingCallback(adapter, `thinking_mode_${mode}`);
        });
    }



    private truncateDescription(description: string, maxLength: number = 30): string {
        return description.length > maxLength
            ? description.substring(0, maxLength) + '...'
            : description;
    }

    // In CommandHandler class
    /**
 * Processes input normally when a pattern is skipped
 * @param adapter The context adapter
 * @param cachedContext Cached pattern context data
 */
    public async processWithoutPattern(
        adapter: ContextAdapter,
        cachedContext: PatternContextData
    ): Promise<void> {
        const methodName = 'processWithoutPattern';
        console.log(`[${methodName}] Starting normal processing for skipped pattern`);

        if (!this.conversationManager) {
            console.error(`[${methodName}] ConversationManager not initialized`);
            await adapter.reply("System is not fully initialized.");
            return;
        }

        try {
            // Get context information
            const { isReply = false, replyToMessage } = cachedContext.metadata || {};
            const interactionType = cachedContext.interactionType || 'general_input';

            console.log(`[${methodName}] Calling processUserInput with context:`, {
                inputLength: cachedContext.input.length,
                chatHistoryLength: cachedContext.chatHistory?.length || 0,
                isReply,
                interactionType
            });

            // Process the input through the main pipeline
            const enhancedResponse = await this.telegramBot!.processUserInput(
                adapter,
                cachedContext.input,
                cachedContext.chatHistory || [],
                false, // isAI
                isReply,
                replyToMessage,
                false, // isFollowUp
                interactionType as InteractionType,
                undefined // progressKey
            );

            // Let handleEnhancedResponse take care of the response display
            // This ensures the menu is added consistently
            await this.telegramBot!.handleEnhancedResponse(adapter, enhancedResponse);

            console.log(`[${methodName}] Completed normal processing after pattern skip`);
        } catch (error) {
            console.error(`[${methodName}] Error:`, error);
            await adapter.reply("Sorry, there was an error processing your request normally.");
        }
    }


    public async handlePatternAction(
        adapter: ContextAdapter,
        action: string,
        parameter?: string
    ): Promise<void> {
        const methodName = 'handlePatternAction';
        try {
            const { userId, sessionId } = await this.conversationManager!.getSessionInfo(adapter);

            // Get user ID for context cache lookup
            const callbackUserId = adapter.context.raw?.callbackQuery?.from?.id || userId;
            console.log(`[${methodName}] Looking for pattern context with user ID: ${callbackUserId}, fallback ID: ${userId}`);

            // Try both user IDs when looking up context data
            let contextData = this.conversationManager?.cache.get<PatternContextData>(`pattern_context:${userId}`);
            if (!contextData && userId !== callbackUserId) {
                contextData = this.conversationManager?.cache.get<PatternContextData>(`pattern_context:${callbackUserId}`);
            }

            if (!contextData) {
                await adapter.answerCallbackQuery('Pattern context not found. Please try again.');
                return;
            }

            // Get or initialize pattern data
            let patternData = this.conversationManager!.cache.get<PatternData>(`pattern_data:${userId}`);
            if (!patternData) {
                patternData = {
                    originalInput: '',
                    processedOutputs: {},
                    currentPatternState: {}
                };
            }

            if (contextData?.input) {
                // Check if this is a pattern suggestion message
                const isPatternSuggestion = contextData.input.includes('📝 I notice this content might benefit from specialized processing') ||
                    contextData.input.includes('Suggested Pattern:');

                if (isPatternSuggestion) {
                    console.warn(`[${methodName}] Context data contains a pattern suggestion message. Not storing as original input.`);

                    // Only update pattern data if we don't already have valid original content
                    if (!patternData.originalInput ||
                        patternData.originalInput.includes('📝 I notice this content') ||
                        patternData.originalInput.includes('Suggested Pattern:')) {

                        // Try to find the original content this suggestion refers to
                        console.log(`[${methodName}] Looking for original content referenced by suggestion...`);

                        // Check recent processed outputs for non-suggestion content
                        if (patternData.processedOutputs) {
                            const outputs = Object.entries(patternData.processedOutputs)
                                .filter(([key, value]) =>
                                    value.output &&
                                    !value.output.includes('📝 I notice this content') &&
                                    !value.output.includes('Suggested Pattern:')
                                )
                                .sort((a, b) => b[1].timestamp - a[1].timestamp); // newest first

                            if (outputs.length > 0) {
                                const [key, value] = outputs[0];
                                console.log(`[${methodName}] Found potential original content in "${key}" output`);
                                patternData.originalInput = value.output;
                            }
                        }

                        // If still no valid original content, use a placeholder
                        if (!patternData.originalInput ||
                            patternData.originalInput.includes('📝 I notice this content') ||
                            patternData.originalInput.includes('Suggested Pattern:')) {

                            // Try to extract a topic from the suggestion
                            let topic = "unknown content";
                            const contentMatch = contextData.input.match(/analyze and summarize ([^,\.]+)|content focusing on ([^,\.]+)|content is a ([^,\.]+)/i);
                            if (contentMatch) {
                                topic = contentMatch[1] || contentMatch[2] || contentMatch[3] || topic;
                            }

                            patternData.originalInput = `This is a placeholder for ${topic} because the original content could not be recovered.`;
                            console.warn(`[${methodName}] Using placeholder content: "${patternData.originalInput}"`);
                        }

                        // Update pattern data with our best guess of original content
                        this.conversationManager!.cache.set(`pattern_data:${userId}`, patternData, 14400); // 4 hours
                    }

                    // Store the suggestion separately for reference
                    this.conversationManager!.cache.set(`pattern_suggestion:${userId}`, contextData.input, 14400); // 4 hours
                } else {
                    // Not a pattern suggestion, store normally
                    this.storePatternInput(userId, contextData.input);
                    patternData.originalInput = contextData.input;
                    console.log(`[${methodName}] Stored original input in pattern data, length: ${contextData.input.length}`);
                }
            }
            const agentManager = this.conversationManager!.getAgentManager();
            if (!agentManager) {
                throw new Error('AgentManager not available');
            }

            const patternAgent = agentManager.getAgent('pattern') as PatternPromptAgent;
            if (!patternAgent) {
                throw new Error('Pattern agent not available');
            }

            // Get the message ID of the menu message (from callback query or context data)
            const menuMessageId = contextData.originalMessageId || adapter.context.messageId;

            // For pattern processing, we'll still need the original content
            const contentToProcess = contextData?.input || '';
            let useProcessedContent = false;

            // If we're applying a pattern, we might want to use already processed content
            if (action === 'use') {
                useProcessedContent = true;
            }

            // Get the appropriate content based on the action
            const contentToUse = this.getContentForProcessing(adapter, userId, '', useProcessedContent);

            console.log(`[${methodName}] Content to use for ${action} (first 50 chars): ${contentToUse?.substring(0, 50) || 'none'}...`);

            if (action === 'use' && parameter) {
                await this.handlePatternUse(adapter, patternAgent, userId, parameter, contentToUse);
            }
            else if (action === 'more') {
                const patternAgent = agentManager.getAgent('pattern') as PatternPromptAgent;
                const categories = patternAgent.getCategories();
                const keyboard = this.menuManager!.createPatternCategoriesMenu(categories).reply_markup;

                await adapter.editMessageText(
                    '📋 <b>Select a Pattern Category</b>\n\nChoose a category to see available processing patterns:',
                    {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    }
                );
            }
            else if (action === 'category' && parameter) {
                await this.showCategoryPatterns(adapter, patternAgent, parameter, menuMessageId);
            }
            else if (action === 'back_to_menu') {
                await this.showOriginalPatternMenu(adapter, userId, menuMessageId);
            }
            else if (action === 'categories') {
                const isAlreadyOnCategories = adapter.context.raw?.callbackQuery?.message?.text?.includes("Select a Pattern Category");

                if (!isAlreadyOnCategories) {
                    await this.showPatternCategories(adapter, patternAgent, menuMessageId);
                } else {
                    await adapter.safeAnswerCallbackQuery("Already showing categories");
                }
            }
            else if (action === 'back') {
                await this.showPatternCategories(adapter, patternAgent, menuMessageId);
            }
            else if (action === 'skip') {
                await this.handlePatternSkip(adapter, userId);
            }
            else if (action === 'delete') {
                // Simply delete the current message without any additional processing
                try {
                    // Try to get the message ID directly from the callback query
                    const messageId = adapter.context.raw?.callbackQuery?.message?.message_id;
                    
                    if (messageId) {
                        // First acknowledge the callback to prevent loading spinner
                        await adapter.safeAnswerCallbackQuery('Closing menu');
                        
                        // Then delete the message
                        const deleted = await adapter.deleteMessage(messageId);
                        console.log(`[${methodName}] Menu message deleted: ${deleted}`);
                    } else {
                        console.warn(`[${methodName}] Could not find message ID for deletion`);
                        await adapter.safeAnswerCallbackQuery('Could not close menu');
                    }
                } catch (error) {
                    console.error(`[${methodName}] Error deleting menu message:`, error);
                    await adapter.safeAnswerCallbackQuery('Error closing menu');
                }
            }
            else if (action === 'next_page' && parameter) {
                const [category, pageStr] = parameter.split(':');
                const page = parseInt(pageStr) || 0;
                await this.showCategoryPatterns(adapter, patternAgent, category, menuMessageId, page + 1);
            }
            else if (action === 'prev_page' && parameter) {
                const [category, pageStr] = parameter.split(':');
                const page = parseInt(pageStr) || 0;
                if (page > 0) {
                    await this.showCategoryPatterns(adapter, patternAgent, category, menuMessageId, page - 1);
                }
            }
            else if (action === 'view_batch' && parameter) {
                const [batchKey, indexStr] = parameter.split(':');
                const index = parseInt(indexStr) || 0;
                await this.viewBatchResult(adapter, userId, batchKey, index);
            }
            else if (action === 'chunk' && parameter) {
                const [patternName, direction] = parameter.split(':');
                await this.navigateResultChunks(adapter, userId, patternName, direction);
            }
            else if (action === 'browse_input') {
                await this.navigateInputChunks(adapter, userId, 'first');
            }
            else if (action === 'input_chunk') {
                await this.navigateInputChunks(adapter, userId, parameter || 'next');
            }
            else if (action === 'select_chunk') {
                const chunkIndex = parseInt(parameter || '0');
                patternData.currentPatternState.selectedInputChunk = chunkIndex;
                this.conversationManager!.cache.set(`pattern_data:${userId}`, patternData, 14400); // 4 hours
                await this.showOriginalPatternMenu(adapter, userId, menuMessageId, '', true);  // Pass empty string for content and true for useSelectedChunk
            }
            else if (action === 'select_all_chunks') {
                await this.showPatternMenuForAllChunks(adapter, userId, menuMessageId);
            }
            else if (action === 'process_all' && parameter) {
                const patternName = parameter;
                await this.processAllChunks(adapter, userId, patternName);
            }
            else if (action === 'apply_to_chunk') {
                const [sourceName, chunkIndexStr] = parameter?.split(':') || ['', '0'];
                const chunkIndex = parseInt(chunkIndexStr);
                const sourceData = patternData.processedOutputs[sourceName];

                if (sourceData?.chunks && sourceData.chunks.length > chunkIndex) {
                    // Show pattern menu but with the selected chunk as source
                    await this.showPatternMenuForChunk(adapter, userId, sourceName, chunkIndex, menuMessageId);
                } else {
                    await adapter.answerCallbackQuery('Selected chunk not available');
                }
            }
            else if (action === 'choose_output') {
                await this.showProcessedOutputsMenu(adapter, userId, menuMessageId);
            }
            else if (action === 'advanced') {
                await this.showAdvancedPatternMenu(adapter, userId, menuMessageId);
            }
            else if (action === 'select_output') {
                // Set the selected output as the source for the next pattern
                const outputName = parameter || '';

                if (patternData.processedOutputs && patternData.processedOutputs[outputName]) {
                    // If the output has chunks, show navigation
                    if (patternData.processedOutputs[outputName].chunks &&
                        patternData.processedOutputs[outputName].chunks!.length > 1) {
                        await this.navigateResultChunks(adapter, userId, outputName, 'first');
                    } else {
                        // Set this output as the source and show pattern menu
                        patternData.currentPatternState.useProcessedOutput = outputName;
                        this.conversationManager!.cache.set(`pattern_data:${userId}`, patternData, 14400); // 4 hours
                        await this.showOriginalPatternMenu(adapter, userId, menuMessageId);
                    }
                } else {
                    await adapter.answerCallbackQuery('Selected output not found');
                }
            }
            else if (action === 'use_full_input') {
                // Clear any previous selection and show pattern menu
                if (patternData) {
                    delete patternData.currentPatternState.useProcessedOutput;
                    delete patternData.currentPatternState.selectedInputChunk;
                    this.conversationManager!.cache.set(`pattern_data:${userId}`, patternData, 14400); // 4 hours
                }
                await this.showOriginalPatternMenu(adapter, userId, menuMessageId);
            }
            else if (action === 'download' && parameter) {
                // Parameter will be in format "patternName:format"
                const parts = parameter.split(':');

                // Get the first part as pattern name
                const patternName = parts[0];
                console.log(`Download pattern name from parameter: ${patternName}`);

                // Get the second part as format, default to 'text'
                const format = parts.length > 1 ? parts[1] : 'text';

                await this.handlePatternDownload(adapter, patternName, format);
            }
            // In the handlePatternAction method in CommandHandler.ts, update the 'browse_input' case:
            else if (action === 'browse_input') {
                await this.handleBrowseInputChunks(adapter, userId);
            }
            else {
                console.warn(`[${methodName}] Unknown pattern action:`, action);
                await adapter.answerCallbackQuery('Unknown pattern action');
            }

        } catch (error) {
            console.error('Error handling pattern callback:', error);
            let errorMessage = "An error occurred processing your pattern selection.";
            if (error instanceof Error) {
                errorMessage = error.message;
            }
            await adapter.answerCallbackQuery(errorMessage);
        }
    }

    private async handlePatternUse(
        adapter: ContextAdapter,
        patternAgent: PatternPromptAgent,
        userId: string,
        patternName: string,
        contentToUse?: string
    ): Promise<void> {
        const methodName = 'handlePatternUse';
        console.log(`[${methodName}] Processing pattern use:`, patternName);

        // Get pattern data from cache
        const patternDataKey = `pattern_data:${userId}`;
        let patternData = this.conversationManager!.cache.get<PatternData>(patternDataKey);

        // Also try with telegram_ prefix
        if (!patternData) {
            const telegramUserId = `telegram_${userId}`;
            patternData = this.conversationManager!.cache.get<PatternData>(`pattern_data:${telegramUserId}`);
            if (patternData) {
                console.log(`[${methodName}] Found pattern data with telegram_ prefix`);
                // Use this userId for further operations
                userId = telegramUserId;
            }
        }

        // If no pattern data, check for context data
        const contextDataKey = `pattern_context:${userId}`;
        const contextData = this.conversationManager!.cache.get<PatternContextData>(contextDataKey);

        if (!patternData && contextData?.input) {
            // Initialize pattern data from context data
            patternData = {
                originalInput: contextData.input,
                processedOutputs: {},
                currentPatternState: {}
            };
            this.conversationManager!.cache.set(patternDataKey, patternData, 14400); // 4 hours
        }

        if (!patternData) {
            await adapter.answerCallbackQuery('Pattern data not available. Please try again.');
            return;
        }

        // IMPORTANT CHECK: Determine if we're dealing with a pattern suggestion message
        let isPatternSuggestion = false;
        let messageText = '';

        if (adapter.isCallbackQuery() && adapter.context.raw?.callbackQuery?.message) {
            const message = adapter.context.raw.callbackQuery.message;
            if ('text' in message) {
                messageText = message.text;

                // Check if this is a pattern suggestion message
                if (messageText.includes('📝 I notice this content might benefit from specialized processing') ||
                    messageText.includes('Suggested Pattern:')) {
                    isPatternSuggestion = true;
                    console.log(`[${methodName}] Detected pattern suggestion message`);
                }
            }
        }

        // If this is a pattern suggestion message, make sure we're not using it as input
        if (isPatternSuggestion && patternData.originalInput === messageText) {
            console.warn(`[${methodName}] Original input is the pattern suggestion message itself! Attempting to find true original content...`);

            // Try to find the original content
            if (contentToUse && contentToUse !== messageText) {
                // If contentToUse was passed and it's not the suggestion message, use it
                console.log(`[${methodName}] Using provided contentToUse parameter (${contentToUse.length} chars)`);
                patternData.originalInput = contentToUse;
                this.conversationManager!.cache.set(patternDataKey, patternData, 14400); // 4 hours
            } else {
                // Check recent outputs in reverse order (newest first) to find non-suggestion content
                const outputs = Object.entries(patternData.processedOutputs || {})
                    .sort((a, b) => b[1].timestamp - a[1].timestamp);

                for (const [key, output] of outputs) {
                    if (key !== 'latest_response' && output.output && output.output !== messageText) {
                        console.log(`[${methodName}] Found potential original content in ${key} output (${output.output.length} chars)`);
                        patternData.originalInput = output.output;
                        this.conversationManager!.cache.set(patternDataKey, patternData, 14400); // 4 hours
                        break;
                    }
                }

                // If still using the suggestion, check for pattern context in other users
                if (patternData.originalInput === messageText) {
                    console.warn(`[${methodName}] Still using suggestion message, checking pattern context...`);

                    // Try pattern context again, possibly from other IDs
                    const normalizedId = userId.replace('telegram_', '');
                    const altContextData = this.conversationManager!.cache.get<PatternContextData>(`pattern_context:${normalizedId}`);

                    if (altContextData?.input && altContextData.input !== messageText) {
                        console.log(`[${methodName}] Found alternate content in pattern context (${altContextData.input.length} chars)`);
                        patternData.originalInput = altContextData.input;
                        this.conversationManager!.cache.set(patternDataKey, patternData, 14400); // 4 hours
                    }
                }
            }
        }

        // Determine the input to use for processing
        let input: string;
        let inputSource = 'original input';

        // Check for selected chunk first
        if (patternData.currentPatternState.selectedInputChunk !== undefined &&
            patternData.inputChunks?.chunks) {
            const chunkIndex = patternData.currentPatternState.selectedInputChunk;
            if (chunkIndex >= 0 && chunkIndex < patternData.inputChunks.chunks.length) {
                input = patternData.inputChunks.chunks[chunkIndex];
                inputSource = `input chunk ${chunkIndex + 1}`;
                console.log(`[${methodName}] Using input chunk ${chunkIndex + 1} as input`);
            } else {
                input = patternData.originalInput;
                console.log(`[${methodName}] Selected chunk out of range, using original input`);
            }
        }
        // Then check for processed output
        else if (patternData.currentPatternState.useProcessedOutput) {
            const sourceName = patternData.currentPatternState.useProcessedOutput;
            const sourceOutput = patternData.processedOutputs[sourceName]?.output;

            if (sourceOutput) {
                input = sourceOutput;
                inputSource = `processed output "${sourceName}"`;
                console.log(`[${methodName}] Using processed output from ${sourceName} as input`);
            } else {
                input = patternData.originalInput;
                console.log(`[${methodName}] Source output not found, using original input`);
            }
        } else {
            // Use original input
            input = patternData.originalInput;
            console.log(`[${methodName}] Using original input`);
        }

        // Add a safety check for pattern suggestion messages
        if (input.includes('📝 I notice this content might benefit from specialized processing') ||
            input.includes('Suggested Pattern:')) {
            console.warn(`[${methodName}] Selected input appears to be a pattern suggestion message! Using fallback mechanisms...`);

            // If contentToUse was provided and it's not a suggestion, use it
            if (contentToUse &&
                !contentToUse.includes('📝 I notice this content might benefit from specialized processing') &&
                !contentToUse.includes('Suggested Pattern:')) {
                console.log(`[${methodName}] Using provided contentToUse as fallback (${contentToUse.length} chars)`);
                input = contentToUse;
                inputSource = 'provided content parameter';
            } else if (adapter.isCallbackQuery() && adapter.context.raw?.callbackQuery?.message?.text) {
                // Try to extract actual content from the message if possible
                const message = adapter.context.raw.callbackQuery.message.text;

                // If the pattern suggestion itself references content, try to extract that
                const contentMatch = message.match(/content focusing on ([^,\.]+)/i);
                if (contentMatch && contentMatch[1]) {
                    console.log(`[${methodName}] Extracted content topic: "${contentMatch[1]}"`);
                    // This is just a placeholder fallback - not ideal
                    input = `Information about ${contentMatch[1]}`;
                    inputSource = 'extracted topic from suggestion';
                }
            }
        }

        await adapter.safeAnswerCallbackQuery(`Processing with ${patternName} pattern...`);

        // Show processing status in menu with more detail
        const menuMessageId = adapter.context.messageId;
        try {
            if (menuMessageId) {
                await adapter.editMessageText(
                    `🔄 <b>Processing with ${patternName} pattern...</b>\n\n` +
                    `Using ${inputSource} (${Math.round(input.length / 100) / 10}KB)\n\n` +
                    `This may take a moment.`,
                    { parse_mode: 'HTML' }
                );
            }
        } catch (error) {
            console.warn(`[${methodName}] Error updating menu message:`, error);
            // Continue processing - this is just a UI issue
        }

        // Variables for tracking retries
        let retryCount = 0;
        const maxRetries = 2;
        let result: string | null = null;
        let processingError: Error | null = null;
        const startTime = Date.now();

        try {
            // Processing with retry logic
            while (retryCount <= maxRetries && !result) {
                try {
                    if (retryCount > 0) {
                        // Show retry message
                        try {
                            await adapter.reply(
                                `⚠️ Connection issue detected. Retry attempt ${retryCount}/${maxRetries}...`,
                                { parse_mode: 'HTML' }
                            );
                        } catch (msgError) {
                            console.warn(`[${methodName}] Error sending retry message:`, msgError);
                        }

                        // Use exponential backoff for retries
                        const backoffTime = 2000 * Math.pow(2, retryCount - 1);
                        await new Promise(resolve => setTimeout(resolve, backoffTime));
                    }

                    // Process based on input size
                    if (input.length > 100000) {  // Extremely large inputs         
                        try {
                            await adapter.reply(
                                `⚠️ This content is extremely large (${Math.round(input.length / 1000)}KB).\n\n` +
                                `Processing in chunks... This may take several minutes.`,
                                { parse_mode: 'HTML' }
                            );
                        } catch (msgError) {
                            console.warn(`[${methodName}] Error sending large input message:`, msgError);
                        }

                        // Process in chunks
                        const inputChunks = this.splitInput(input);
                        console.log(`[${methodName}] Processing large input in ${inputChunks.length} chunks`);

                        // Process each chunk with individual retry logic
                        const chunkResults: string[] = [];
                        for (let i = 0; i < inputChunks.length; i++) {
                            // Update progress occasionally (not every chunk to avoid rate limits)
                            if (i % 3 === 0) {
                                try {
                                    const percent = Math.round((i / inputChunks.length) * 100);
                                    await adapter.reply(
                                        `📊 Progress update: Processing chunk ${i + 1}/${inputChunks.length} (${percent}%)`,
                                        { parse_mode: 'HTML' }
                                    );
                                } catch (progError) {
                                    console.warn(`[${methodName}] Error sending progress update:`, progError);
                                }
                            }

                            // Process this chunk with its own retry logic
                            let chunkRetries = 0;
                            let chunkResult: string | null = null;

                            while (chunkRetries <= 1 && !chunkResult) { // Max 1 retry per chunk
                                try {
                                    chunkResult = await patternAgent.processWithPattern(
                                        patternName,
                                        inputChunks[i],
                                        adapter
                                    );
                                } catch (chunkError) {
                                    console.warn(`[${methodName}] Error processing chunk ${i + 1}:`, chunkError);

                                    if (chunkRetries < 1) {
                                        // Wait before retry
                                        await new Promise(resolve => setTimeout(resolve, 3000));
                                        chunkRetries++;
                                    } else {
                                        // If we've retried and still failed, use a placeholder
                                        chunkResult = `[Error processing this section. The content was too complex or connection was interrupted.]`;
                                    }
                                }
                            }

                            chunkResults.push(chunkResult || '[Processing error]');
                        }

                        // Combine results
                        result = this.combineChunkResults(patternName, chunkResults);
                    } else {
                        // Normal processing for reasonable sized inputs
                        result = await patternAgent.processWithPattern(patternName, input, adapter);
                    }

                    // If we get here without an error, processing succeeded
                    break;

                } catch (error) {
                    processingError = error instanceof Error ? error : new Error(String(error));
                    console.error(`[${methodName}] Processing attempt ${retryCount + 1} failed:`, error);

                    // Check if this is a network error that we should retry
                    const errorString = String(error);
                    const shouldRetry = errorString.includes('ECONNRESET') ||
                        errorString.includes('aborted') ||
                        errorString.includes('timeout') ||
                        errorString.includes('rate limit');

                    if (shouldRetry && retryCount < maxRetries) {
                        retryCount++;
                    } else {
                        // Either not a retriable error or we've hit max retries
                        throw error;
                    }
                }
            }

            // At this point, we should have a result or have thrown an error
            if (!result) {
                throw new Error("Failed to process pattern after retries");
            }

            // Show completion message with stats
            const processingTime = Math.round((Date.now() - startTime) / 100) / 10;
            try {
                await adapter.reply(
                    `✅ <b>Processing complete!</b>\n\n` +
                    `<b>Pattern:</b> ${patternName}\n` +
                    `<b>Input size:</b> ${Math.round(input.length / 100) / 10}KB\n` +
                    `<b>Output size:</b> ${Math.round(result.length / 100) / 10}KB\n` +
                    `<b>Time:</b> ${processingTime}s`,
                    { parse_mode: 'HTML' }
                );
            } catch (msgError) {
                console.warn(`[${methodName}] Error sending completion message:`, msgError);
            }

            // Store the result
            if (!patternData.processedOutputs) {
                patternData.processedOutputs = {};
            }

            patternData.processedOutputs[patternName] = {
                output: result,
                timestamp: Date.now()
            };

            // Update pattern state tracking
            if (!patternData.currentPatternState) {
                patternData.currentPatternState = {};
            }
            patternData.currentPatternState.lastProcessedPattern = patternName;

            // For display purposes, check if we need to split the output for Telegram
            // For single messages
            if (result.length <= 4000) {
                // Send content as is without trying to edit it later
                let sentMessage;
                try {
                    sentMessage = await adapter.reply(result, { parse_mode: 'HTML' });
                } catch (msgError) {
                    console.warn(`[${methodName}] Error sending result message:`, msgError);
                    try {
                        sentMessage = await adapter.reply(result);
                    } catch (plainError) {
                        console.error(`[${methodName}] Error sending plain result:`, plainError);
                        throw new Error("Failed to send result message");
                    }
                }

                // Store the message ID if available
                if (sentMessage && 'message_id' in sentMessage) {
                    patternData.processedOutputs[patternName].messageIds = [sentMessage.message_id];
                }

                // Wait a moment before sending menu to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 1500));

                // Create menu buttons
                const buttons = [];
                buttons.push([
                    Markup.button.callback('🔝 Main Menu', 'pattern_back_to_menu'),
                    Markup.button.callback('🔄 Use Original Input', 'pattern_use_full_input')
                ]);
                buttons.push([
                    Markup.button.callback('📄 Download as Text', `pattern_download:${patternName}:text`),
                    Markup.button.callback('📑 Download as PDF', `pattern_download:${patternName}:pdf`),
                ]);
                buttons.push([
                    Markup.button.callback('📋 More Patterns', 'pattern_categories'),
                    Markup.button.callback('❌ Cancel', 'pattern_delete')
                ]);

                const keyboard = Markup.inlineKeyboard(buttons);

                // Send a separate message with menu buttons
                try {
                    const menuMessage = await adapter.reply(
                        `📝 <b>Result processed with ${patternName}</b>`,
                        {
                            parse_mode: 'HTML',
                            reply_markup: keyboard.reply_markup
                        }
                    );

                    // Store this menu message ID too
                    if (menuMessage && 'message_id' in menuMessage) {
                        if (!patternData.processedOutputs[patternName]) {
                            patternData.processedOutputs[patternName] = {
                                output: result,
                                timestamp: Date.now()
                            };
                        }
                        patternData.processedOutputs[patternName].menuMessageId = menuMessage.message_id;
                    }
                } catch (menuError) {
                    console.warn(`[${methodName}] Error sending menu message:`, menuError);
                }
            } else {
                // Split output for display and send in chunks
                const outputChunks = this.splitOutput(result);
                patternData.processedOutputs[patternName].chunks = outputChunks;

                const messageIds: number[] = [];

                // Send each output chunk with appropriate delay to avoid rate limiting
                for (let i = 0; i < outputChunks.length; i++) {
                    const isLastChunk = i === outputChunks.length - 1;
                    const chunkText = outputChunks[i] + (isLastChunk ? '' : '\n[continued in next message...]');

                    // Wait between messages
                    if (i > 0) {
                        await new Promise(resolve => setTimeout(resolve, 1500));
                    }

                    // Send chunk without trying to add buttons to it
                    let sentMessage;
                    try {
                        // Add chunk number header to help users track the sequence
                        const headerText = outputChunks.length > 1 ?
                            `<b>Part ${i + 1} of ${outputChunks.length}</b>\n\n` : '';

                        sentMessage = await adapter.reply(
                            headerText + chunkText,
                            { parse_mode: 'HTML' }
                        );
                    } catch (chunkError) {
                        console.warn(`[${methodName}] Error sending chunk ${i + 1}:`, chunkError);

                        // Try without HTML formatting
                        try {
                            const plainHeader = outputChunks.length > 1 ?
                                `Part ${i + 1} of ${outputChunks.length}\n\n` : '';

                            sentMessage = await adapter.reply(plainHeader + chunkText);
                        } catch (plainError) {
                            console.error(`[${methodName}] Error sending plain chunk:`, plainError);
                            continue; // Skip this chunk and continue
                        }
                    }

                    // Store message ID if available
                    if (sentMessage && 'message_id' in sentMessage) {
                        messageIds.push(sentMessage.message_id);
                    }

                    // Add longer delay between chunks to respect rate limits
                    if (!isLastChunk) {
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                }

                // Store all message IDs
                if (messageIds.length > 0) {
                    patternData.processedOutputs[patternName].messageIds = messageIds;

                    // Wait before sending menu message
                    await new Promise(resolve => setTimeout(resolve, 1500));

                    // Create navigation buttons
                    const buttons = [];

                    // Add navigation controls for multi-chunk results
                    if (outputChunks.length > 1) {
                        buttons.push([
                            Markup.button.callback('⏮️ First', `pattern_chunk:${patternName}:first`),
                            Markup.button.callback('⏪ Previous', `pattern_chunk:${patternName}:prev`),
                            Markup.button.callback('Next ⏩', `pattern_chunk:${patternName}:next`),
                            Markup.button.callback('⏭️ Last', `pattern_chunk:${patternName}:last`)
                        ]);
                    }

                    // Action buttons
                    buttons.push([
                        Markup.button.callback('🔝 Main Menu', 'pattern_back_to_menu'),
                        Markup.button.callback('📋 Apply Another Pattern', `pattern_categories`)
                    ]);

                    buttons.push([
                        Markup.button.callback('📄 Download as Text', `pattern_download:${patternName}:text`),
                        Markup.button.callback('📑 Download as PDF', `pattern_download:${patternName}:pdf`),
                        Markup.button.callback('✅ Done', 'pattern_skip')
                    ]);

                    const keyboard = Markup.inlineKeyboard(buttons);

                    // Send a separate menu message after all chunks
                    try {
                        let menuText = `📝 <b>Result processed with ${patternName}</b>`;
                        if (outputChunks.length > 1) {
                            menuText += ` (${outputChunks.length} parts)`;
                        }
                        menuText += `\n\nNavigate between parts or apply another pattern to the content.`;

                        const menuMessage = await adapter.reply(
                            menuText,
                            {
                                parse_mode: 'HTML',
                                reply_markup: keyboard.reply_markup
                            }
                        );

                        // Store menu message ID
                        if (menuMessage && 'message_id' in menuMessage) {
                            if (!patternData.processedOutputs[patternName]) {
                                patternData.processedOutputs[patternName] = {
                                    output: result,
                                    timestamp: Date.now()
                                };
                            }
                            patternData.processedOutputs[patternName].menuMessageId = menuMessage.message_id;
                        }
                    } catch (menuError) {
                        console.warn(`[${methodName}] Error sending navigation menu:`, menuError);

                        // Try a simpler menu if HTML parsing failed
                        try {
                            await adapter.reply(
                                `Navigation for ${patternName} results`,
                                {
                                    reply_markup: keyboard.reply_markup
                                }
                            );
                        } catch (simpleMenuError) {
                            console.error(`[${methodName}] Failed to send simple menu:`, simpleMenuError);
                        }
                    }
                }
            }

            // Update pattern data in cache
            this.conversationManager!.cache.set(patternDataKey, patternData, 14400); // 4 hours
            this.storePatternOutput(userId, patternName, result);
        } catch (error) {
            console.error(`[${methodName}] Error:`, error);

            // Enhanced error handling with recovery options
            // Attempt to show error message
            try {
                const errorMessage = error instanceof Error
                    ? error.message
                    : 'Unknown error occurred';

                // Categorize errors for better user feedback
                let userMessage: string;
                let errorType: string;

                if (errorMessage.includes('ECONNRESET') || errorMessage.includes('aborted')) {
                    userMessage = 'Connection to AI service was interrupted. Please try again.';
                    errorType = 'connection';
                } else if (errorMessage.includes('timeout') || errorMessage.includes('timed out')) {
                    userMessage = 'Processing took too long and timed out. Try smaller content or a different pattern.';
                    errorType = 'timeout';
                } else if (errorMessage.includes('too many tokens') || errorMessage.includes('context length')) {
                    userMessage = 'Content is too large for this pattern. Try using smaller chunks.';
                    errorType = 'content_size';
                } else if (errorMessage.includes('rate limit') || errorMessage.includes('Too Many Requests')) {
                    userMessage = 'Rate limit reached. Please wait a moment before trying again.';
                    errorType = 'rate_limit';
                } else {
                    userMessage = 'Error processing with this pattern. Please try another.';
                    errorType = 'general';
                }

                // Send as new message to avoid edit rate limiting
                await adapter.reply(
                    `❌ <b>Error processing with ${patternName}</b>\n\n` +
                    `${userMessage}\n\n` +
                    `<i>Type: ${errorType}</i>`,
                    {
                        parse_mode: 'HTML',
                        reply_markup: Markup.inlineKeyboard([
                            [Markup.button.callback('🔄 Try Another Pattern', 'pattern_categories')],
                            [Markup.button.callback('🔍 Browse Input Chunks', 'pattern_browse_input')],
                            [Markup.button.callback('❌ Cancel', 'pattern_delete')]
                        ]).reply_markup
                    }
                );
            } catch (msgError) {
                console.error(`[${methodName}] Error sending error message:`, msgError);

                // Last resort - try a simple message
                try {
                    await adapter.reply(`Error processing request. Please try again later.`);
                } catch (e) {
                    console.error(`[${methodName}] Failed to send error message:`, e);
                }
            }
        }
    }

    // Helper method to split large inputs into manageable chunks
    private splitInput(input: string): string[] {
        const chunks: string[] = [];
        const maxChunkSize = 3800;  // Slightly less than 4000 to allow for some overhead

        // If input is small enough, return as is
        if (input.length <= maxChunkSize) {
            return [input];
        }

        let remaining = input;
        while (remaining.length > 0) {
            let chunkSize = Math.min(maxChunkSize, remaining.length);

            // Try to find a good breakpoint
            if (chunkSize < remaining.length) {
                // Look for paragraph breaks (preferred)
                const paragraphBreak = remaining.lastIndexOf('\n\n', chunkSize);
                if (paragraphBreak > chunkSize - 500) {
                    chunkSize = paragraphBreak + 2;
                } else {
                    // Look for sentence breaks
                    const sentenceBreak = remaining.lastIndexOf('. ', chunkSize);
                    if (sentenceBreak > chunkSize - 200) {
                        chunkSize = sentenceBreak + 2;
                    } else {
                        // Fallback to word breaks
                        const wordBreak = remaining.lastIndexOf(' ', chunkSize);
                        if (wordBreak > chunkSize - 50) {
                            chunkSize = wordBreak + 1;
                        }
                    }
                }
            }

            // Add context to help with processing
            let chunk = remaining.substring(0, chunkSize);
            if (chunks.length > 0) {
                chunk = `[CONTINUATION - PART ${chunks.length + 1}]\n\n${chunk}`;
            }
            if (chunkSize < remaining.length) {
                chunk += `\n\n[TO BE CONTINUED]`;
            }

            chunks.push(chunk);
            remaining = remaining.substring(chunkSize);
        }

        return chunks;
    }

    // Helper method to intelligently combine multiple chunk results
    private combineChunkResults(patternName: string, chunkResults: string[]): string {
        if (chunkResults.length === 1) {
            return chunkResults[0];
        }

        // Different combining strategies based on pattern type
        switch (patternName) {
            case 'summarize':
                // For summarize, we might want to create a meta-summary
                return this.combineSummaries(chunkResults);

            case 'extract_wisdom':
            case 'extract_insights':
                // For extraction patterns, concatenate with section headers
                return this.combineExtractions(chunkResults);

            case 'analyze_prose':
            case 'analyze_paper':
                // For analysis patterns, combine with section headers and synthesis
                return this.combineAnalyses(chunkResults);

            default:
                // Default combination with section breaks
                return chunkResults.map((result, index) =>
                    `## Part ${index + 1}\n\n${result}`
                ).join('\n\n---\n\n');
        }
    }

    // Specialized combiners for different pattern types
    private combineSummaries(summaries: string[]): string {
        // If there are only a few summaries, just join them
        if (summaries.length <= 3) {
            return summaries.join('\n\n---\n\n');
        }

        // For many chunks, create a meta-summary with key points from each
        const combinedSummary = `# Combined Summary\n\n`;

        // Extract key points from each summary
        const keyPoints = summaries.map((summary, index) => {
            // Split into paragraphs and take first one as main point
            const paragraphs = summary.split('\n\n');
            return `## Key Points from Part ${index + 1}:\n\n${paragraphs[0]}\n`;
        }).join('\n\n');

        return combinedSummary + keyPoints;
    }

    private combineExtractions(extractions: string[]): string {
        // Join extractions with clear section headers
        return extractions.map((extraction, index) =>
            `# Section ${index + 1} Insights\n\n${extraction}`
        ).join('\n\n---\n\n');
    }

    private combineAnalyses(analyses: string[]): string {
        // Start with a combined header
        let combined = `# Combined Analysis\n\n`;

        // Add each analysis as a section
        combined += analyses.map((analysis, index) =>
            `## Section ${index + 1} Analysis\n\n${analysis}`
        ).join('\n\n---\n\n');

        // Add a synthesis section
        combined += '\n\n---\n\n## Overall Synthesis\n\n';
        combined += 'The above sections analyze different parts of the content. ' +
            'The complete analysis provides a comprehensive understanding of the material.';

        return combined;
    }


    private async handlePatternSkip(
        adapter: ContextAdapter,
        userId: string
    ): Promise<void> {
        console.log(`[handlePatternSkip] Processing skip action`);
        await adapter.answerCallbackQuery('Processing normally...');

        // Update the message to indicate normal processing
        if (adapter.context.messageId) {
            try {
                await adapter.editMessageText(
                    `Processing content normally...\n\nThis may take a moment.`,
                    {
                        parse_mode: 'Markdown'
                    }
                );
            } catch (error) {
                console.warn('Error updating message, continuing with processing:', error);
            }
        }

        const contextData = this.conversationManager!.cache.get<PatternContextData>(`pattern_context:${userId}`);
        if (contextData) {
            await this.processWithoutPattern(adapter, contextData);
            // Clean up the cache after processing
            this.conversationManager!.cache.del(`pattern_context:${userId}`);
        } else {
            await adapter.reply("Sorry, I couldn't find your original message. Please try again.");
        }
    }


    private getContentForProcessing(
        adapter: ContextAdapter,
        userId: string,
        currentContent: string = '',
        useProcessedIfAvailable: boolean = false
    ): string {
        const methodName = 'getContentForProcessing';

        // First try with both regular and telegram_ prefix
        const userIds = [userId, `telegram_${userId}`];
        let content = '';

        for (const id of userIds) {
            // First check for pattern data (for processed content)
            if (useProcessedIfAvailable) {
                const patternData = this.conversationManager?.cache.get<PatternData>(`pattern_data:${id}`);
                if (patternData) {
                    const lastPattern = patternData.currentPatternState.lastProcessedPattern;
                    if (lastPattern && patternData.processedOutputs[lastPattern]?.output) {
                        console.log(`[${methodName}] Using previously processed content from ${lastPattern}`);
                        content = patternData.processedOutputs[lastPattern].output;
                        break;
                    }
                }
            }

            // Then check pattern data for original input
            const patternData = this.conversationManager?.cache.get<PatternData>(`pattern_data:${id}`);
            if (patternData?.originalInput) {
                console.log(`[${methodName}] Using original input from pattern data for ${id}`);
                content = patternData.originalInput;
                break;
            }

            // Then check context data for input
            const contextData = this.conversationManager?.cache.get<PatternContextData>(`pattern_context:${id}`);
            if (contextData?.input) {
                console.log(`[${methodName}] Using input from context data for ${id}`);
                content = contextData.input;
                break;
            }
        }

        // If a valid content was found, check if it's a pattern suggestion
        if (content && (
            content.includes('📝 I notice this content might benefit from specialized processing') ||
            content.includes('Suggested Pattern:')
        )) {
            console.warn(`[${methodName}] Found content appears to be a pattern suggestion message!`);
            content = ''; // Reset to force fallback mechanisms
        }

        // If provided current content, use that
        if (!content && currentContent) {
            console.log(`[${methodName}] Using provided current content`);
            content = currentContent;
        }

        // Last resort: extract from callback query message
        if (!content && adapter.context.raw?.callbackQuery?.message?.text) {
            const messageText = adapter.context.raw.callbackQuery.message.text;

            // Check if the message is a pattern suggestion
            if (messageText.includes('📝 I notice this content might benefit from specialized processing') ||
                messageText.includes('Suggested Pattern:')) {
                console.warn(`[${methodName}] Callback message is a pattern suggestion, cannot extract content`);
            } else {
                const menuHeaderIndex = messageText.indexOf('\n\n-----\n');
                const extractedContent = menuHeaderIndex !== -1 ?
                    messageText.substring(0, menuHeaderIndex) :
                    messageText;
                console.log(`[${methodName}] Extracted content from callback message`);
                content = extractedContent;
            }
        }

        if (!content) {
            console.warn(`[${methodName}] Could not retrieve content for processing`);
        } else {
            console.log(`[${methodName}] Retrieved content of length: ${content.length}`);
        }

        return content || '';
    }

    private async navigateResultChunks(
        adapter: ContextAdapter,
        userId: string,
        patternName: string,
        direction: string
    ): Promise<void> {
        const methodName = 'navigateResultChunks';
        const patternData = this.conversationManager!.cache.get<PatternData>(`pattern_data:${userId}`);

        if (!patternData || !patternData.processedOutputs[patternName]) {
            await adapter.answerCallbackQuery('Result not available');
            return;
        }

        const result = patternData.processedOutputs[patternName];

        // Check if chunks exist
        if (!result.chunks || result.chunks.length === 0) {
            // If there are no chunks, we might need to create them from the output
            if (result.output) {
                result.chunks = this.splitOutput(result.output);
            } else {
                await adapter.answerCallbackQuery('No content chunks available');
                return;
            }
        }

        // Initialize current chunk if not set
        if (result.currentChunk === undefined) {
            result.currentChunk = 0;
        }

        // Calculate new chunk index
        let newChunk = result.currentChunk;
        if (direction === 'next' && newChunk < result.chunks.length - 1) {
            newChunk++;
        } else if (direction === 'prev' && newChunk > 0) {
            newChunk--;
        } else if (direction === 'first') {
            newChunk = 0;
        } else if (direction === 'last') {
            newChunk = result.chunks.length - 1;
        }

        if (newChunk === result.currentChunk) {
            await adapter.answerCallbackQuery('No more chunks in that direction');
            return;
        }

        // Update current chunk index
        result.currentChunk = newChunk;
        this.conversationManager!.cache.set(`pattern_data:${userId}`, patternData, 14400);

        // Update the message with new chunk
        try {
            // Update callback message with current chunk content and pagination controls
            const buttons = [
                [
                    Markup.button.callback('⬅️ Previous', `pattern_chunk:${patternName}:prev`),
                    Markup.button.callback(`${newChunk + 1}/${result.chunks.length}`, 'pattern_noop'),
                    Markup.button.callback('Next ➡️', `pattern_chunk:${patternName}:next`)
                ],
                [
                    Markup.button.callback('🔍 Apply Pattern to This Chunk', `pattern_apply_to_chunk:${patternName}:${newChunk}`),
                    Markup.button.callback('📊 Process All Chunks', `pattern_select_all_chunks`)
                ],
                [
                    Markup.button.callback('🔝 Main Menu', 'pattern_back_to_menu'),
                    Markup.button.callback('🔍 Browse Input Chunks', 'pattern_browse_input'),
                ],
                [
                    Markup.button.callback('📄 Download as Text', `pattern_download:${patternName}:text`),
                    Markup.button.callback('📑 Download as PDF', `pattern_download:${patternName}:pdf`),
                    Markup.button.callback('✅ Done', 'pattern_skip')
                ]
            ];

            const keyboard = Markup.inlineKeyboard(buttons);

            await adapter.editMessageText(
                `${result.chunks[newChunk]}\n\n-----\n📝 <b>Part ${newChunk + 1} of ${result.chunks.length}</b>`,
                {
                    parse_mode: 'HTML',
                    reply_markup: keyboard.reply_markup
                }
            );

            await adapter.answerCallbackQuery(`Showing chunk ${newChunk + 1} of ${result.chunks.length}`);
        } catch (error) {
            console.error(`[${methodName}] Error navigating:`, error);
            await adapter.answerCallbackQuery('Error navigating chunks');
        }
    }

    public storePatternInput(userId: string, input: string): void {
        // Get existing pattern data or create new
        const cacheKey = `pattern_data:${userId}`;
        let patternData = this.conversationManager!.cache.get<PatternData>(cacheKey) || {
            originalInput: input,
            processedOutputs: {},
            currentPatternState: {}
        };

        // Update input
        patternData.originalInput = input;

        // Store with extended TTL for large content
        this.conversationManager!.cache.set(cacheKey, patternData, 14400);  // 4 hour

        console.log(`[storePatternInput] Stored input for user ${userId}, length: ${input.length}`);
    }






    ////////////////////////////////////////////////////////////////////////////////////////////////////////


    private async showOriginalPatternMenu(
        adapter: ContextAdapter,
        userId: string,
        messageId?: number | string,
        currentContent: string = '',
        useSelectedChunk: boolean = false
    ): Promise<void> {
        const methodName = 'showOriginalPatternMenu';

        // Get pattern data from cache
        let patternData = this.conversationManager!.cache.get<PatternData>(`pattern_data:${userId}`);

        // Create default pattern data if none exists
        if (!patternData) {
            console.log(`[${methodName}] No pattern data found for user ${userId}, creating default object`);
            patternData = {
                originalInput: '',
                processedOutputs: {},
                currentPatternState: {}
            };
        }

        // Get the cached contextData to retrieve the original suggestion if possible
        const contextData = this.conversationManager!.cache.get<PatternContextData>(`pattern_context:${userId}`);
        const originalSuggestion = (contextData?.metadata as any)?.suggestion;

        // Determine which content to show in the menu
        let displayContent = '';

        // If useSelectedChunk is true and we have a selected chunk, use that
        if (useSelectedChunk && patternData.currentPatternState?.selectedInputChunk !== undefined) {
            const chunkIndex = patternData.currentPatternState.selectedInputChunk;

            // Check if we have input chunks available
            if (patternData.inputChunks?.chunks && patternData.inputChunks.chunks.length > chunkIndex) {
                // Use the selected input chunk
                const selectedChunk = patternData.inputChunks.chunks[chunkIndex];

                // Create a preview (truncated if needed)
                const maxPreviewLength = 300;
                displayContent = selectedChunk.length > maxPreviewLength ?
                    selectedChunk.substring(0, maxPreviewLength) + '...\n[Content truncated for display]' :
                    selectedChunk;

                console.log(`[${methodName}] Using selected input chunk ${chunkIndex + 1}`);
            }
        } else if (currentContent) {
            // If currentContent is provided, use that
            displayContent = currentContent;
        } else {
            // Get content preview for debugging only - don't include in the message
            const contentPreview = this.getContentForProcessing(adapter, userId, '');
            console.log(`[${methodName}] Content preview (first 50 chars): ${contentPreview?.substring(0, 50) || 'none'}...`);
        }

        // Ensure patternAgent is available
        const patternAgent = this.agentManager?.getAgent('pattern') as PatternPromptAgent;
        if (!patternAgent) {
            throw new Error('Pattern agent not available');
        }

        // Create message with content preview if available
        let message = '';

        // If we're using a selected chunk, show that info
        if (useSelectedChunk && patternData.currentPatternState?.selectedInputChunk !== undefined) {
            const chunkIndex = patternData.currentPatternState.selectedInputChunk;
            message = `📝 <b>Apply pattern to selected chunk ${chunkIndex + 1}</b>\n\n`;

            if (displayContent) {
                message += `<b>Preview:</b>\n${displayContent}\n\n`;
            }

            message += `<b>Select a pattern to apply:</b>`;
        } else {
            // Standard menu without preview
            message = '📝 <b>Try another pattern on the content:</b>';
        }

        // Make sure menuManager is available
        if (!this.menuManager) {
            throw new Error('MenuManager is not available');
        }

        // Use MenuManager to create the pattern menu
        const keyboard = this.menuManager.createPatternSelectionMenu(
            originalSuggestion,
            originalSuggestion?.alternativePatterns,
        ).reply_markup;

        // Update the message
        try {
            if (messageId) {
                try {
                    // First, check if the message already has this exact content and markup
                    let needsUpdate = true;

                    // If this is a callback query, check current message text and markup
                    if (adapter.isCallbackQuery() && adapter.context.raw?.callbackQuery?.message) {
                        const currentMessage = adapter.context.raw.callbackQuery.message;

                        // Check if the message text is the same
                        if (currentMessage.text === message) {
                            // Compare inline keyboard markup if exists
                            const currentMarkup = currentMessage.reply_markup?.inline_keyboard;
                            const newMarkup = keyboard.inline_keyboard;

                            // Simple comparison - check if they have the same structure
                            // For a more detailed comparison, you'd need to compare each button
                            if (currentMarkup && newMarkup &&
                                JSON.stringify(currentMarkup) === JSON.stringify(newMarkup)) {
                                console.log(`[${methodName}] Message content and markup unchanged, skipping edit`);
                                needsUpdate = false;
                            }
                        }
                    }

                    // Only edit if the message content or markup has changed
                    if (needsUpdate) {
                        await adapter.editMessageText(
                            message,
                            {
                                parse_mode: 'HTML',
                                reply_markup: keyboard
                            }
                        );
                    } else {
                        // Answer the callback query to remove the loading indicator
                        await adapter.safeAnswerCallbackQuery('Menu refreshed');
                    }
                } catch (error: unknown) { // Add type annotation
                    // Check if this is a "message is not modified" error
                    const description = (error as any)?.response?.description;
                    if (typeof description === 'string' && description.includes('message is not modified')) {
                        console.log(`[${methodName}] Message already has this content and markup, no need to update`);
                        // Just acknowledge the callback to remove the loading indicator
                        await adapter.safeAnswerCallbackQuery('Menu unchanged');
                    } else {
                        // For other errors, log and send a new message
                        console.warn(`[${methodName}] Error updating message, sending new one:`, error instanceof Error ? error.message : String(error));
                        await adapter.reply(message, {
                            parse_mode: 'HTML',
                            reply_markup: keyboard
                        });
                    }
                }
            } else {
                await adapter.reply(message, {
                    parse_mode: 'HTML',
                    reply_markup: keyboard
                });
            }
        } catch (error) {
            console.error(`[${methodName}] Error sending pattern menu:`, error);
            await adapter.safeAnswerCallbackQuery('Error displaying pattern menu');
        }
    }
    // In CommandHandler.ts

    private async showPatternCategories(
        adapter: ContextAdapter,
        patternAgent: PatternPromptAgent,
        messageId?: number | string,
        currentContent: string = ''
    ): Promise<void> {
        console.log(`[showPatternCategories] Showing pattern categories`);

        const categories = patternAgent.getCategories();

        // Use MenuManager to create the categories menu
        const keyboard = this.menuManager!.createPatternCategoriesMenu(categories).reply_markup;

        await adapter.answerCallbackQuery('Showing pattern categories...');

        // Create message with preserved content (with truncation if needed)
        let message = '';
        if (currentContent) {
            // Truncate content if too long to avoid MESSAGE_TOO_LONG errors
            const maxDisplayLength = 300; // Shorter for UI purposes
            if (currentContent.length > maxDisplayLength) {
                message = currentContent.substring(0, maxDisplayLength) + '...\n\n-----\n';
            } else {
                message = currentContent + '\n\n-----\n';
            }
        }

        message += '📋 <b>Select a Pattern Category</b>\n\nChoose a category to see available processing patterns:';

        if (messageId) {
            // Update existing message
            try {
                await adapter.editMessageText(
                    message,
                    {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    }
                );
            } catch (error: unknown) { // Add type annotation
                console.warn('Error updating message, sending new one:', error instanceof Error ? error.message : String(error));
                // If message is too long, send a new message without the content
                const description = (error as any)?.response?.description;
                if (typeof description === 'string' && description.includes('MESSAGE_TOO_LONG')) {
                    await adapter.reply(
                        '📋 <b>Select a Pattern Category</b>\n\nChoose a category to see available processing patterns:',
                        {
                            parse_mode: 'HTML',
                            reply_markup: keyboard
                        }
                    );
                } else {
                    await adapter.reply(message, {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    });
                }
            }
        } else {
            // Send new message
            await adapter.reply(message, {
                parse_mode: 'HTML',
                reply_markup: keyboard
            });
        }
    }

    private async showCategoryPatterns(
        adapter: ContextAdapter,
        patternAgent: PatternPromptAgent,
        category: string,
        messageId?: number | string,
        page: number = 0,
        currentContent: string = ''
    ): Promise<void> {
        console.log(`[showCategoryPatterns] Showing patterns for category:`, category);

        const patterns = patternAgent.getPatternsByCategory(category);
        const patternsPerPage = 6; // Show 6 patterns per page
        const totalPages = Math.ceil(patterns.length / patternsPerPage);

        // Ensure page is within bounds
        page = Math.max(0, Math.min(page, totalPages - 1));

        // Get patterns for current page
        const patternsForPage = patterns.slice(page * patternsPerPage, (page + 1) * patternsPerPage);

        // Use MenuManager to create the patterns menu
        const keyboard = this.menuManager!.createCategoryPatternsMenu(
            patternsForPage,
            category,
            page,
            totalPages
        ).reply_markup;

        await adapter.safeAnswerCallbackQuery(`Showing ${category} patterns...`);

        // Create message with preserved content (with truncation if needed)
        let message = '';
        if (currentContent) {
            // Truncate content if too long to avoid MESSAGE_TOO_LONG errors
            const maxDisplayLength = 300; // Shorter for UI purposes
            if (currentContent.length > maxDisplayLength) {
                message = currentContent.substring(0, maxDisplayLength) + '...\n\n-----\n';
            } else {
                message = currentContent + '\n\n-----\n';
            }
        }

        message += `📋 <b>${this.menuManager!.formatCategoryName(category)} Patterns</b>\n\n` +
            `Page ${page + 1}/${totalPages}\n\n` +
            `Select a pattern to process your content:`;

        if (messageId) {
            // Update existing message
            try {
                await adapter.editMessageText(
                    message,
                    {
                        parse_mode: 'HTML',  // Changed to HTML for consistency
                        reply_markup: keyboard
                    }
                );
            } catch (error: unknown) { // Add type annotation
                console.warn('Error updating message, sending new one:', error instanceof Error ? error.message : String(error));
                // If message is too long, send a new message without the content
                const description = (error as any)?.response?.description;
                if (typeof description === 'string' && description.includes('MESSAGE_TOO_LONG')) {
                    await adapter.reply(
                        `📋 <b>${this.menuManager!.formatCategoryName(category)} Patterns</b>\n\n` +
                        `Page ${page + 1}/${totalPages}\n\n` +
                        `Select a pattern to process your content:`,
                        {
                            parse_mode: 'HTML',
                            reply_markup: keyboard
                        }
                    );
                } else {
                    await adapter.reply(message, {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    });
                }
            }
        } else {
            // Send new message
            await adapter.reply(message, {
                parse_mode: 'HTML',
                reply_markup: keyboard
            });
        }
    }

    // In CommandHandler.ts

    private async showAdvancedPatternMenu(
        adapter: ContextAdapter,
        userId: string,
        messageId?: number | string
    ): Promise<void> {
        const methodName = 'showAdvancedPatternMenu';

        const patternData = this.conversationManager!.cache.get<PatternData>(`pattern_data:${userId}`);
        if (!patternData) {
            await adapter.answerCallbackQuery('Pattern data not available');
            return;
        }

        const patternAgent = this.agentManager!.getAgent('pattern') as PatternPromptAgent;
        if (!patternAgent) {
            throw new Error('Pattern agent not available');
        }

        // Basic info about available content
        let availableContent = '';

        // Check if we have original input
        if (patternData.originalInput) {
            availableContent += `- Original input (${patternData.originalInput.length} chars)\n`;
        }

        // Check if we have input chunks
        if (patternData.inputChunks?.chunks?.length) {
            availableContent += `- Input chunks (${patternData.inputChunks.chunks.length} chunks)\n`;
        }

        // Check if we have processed outputs
        const outputPatterns = Object.keys(patternData.processedOutputs || {});
        if (outputPatterns.length > 0) {
            availableContent += `- Processed outputs: ${outputPatterns.join(', ')}\n`;
        }

        // Use MenuManager to create the advanced pattern menu
        const hasInputChunks = !!patternData.inputChunks?.chunks?.length;
        const hasProcessedOutputs = outputPatterns.length > 0;
        const keyboard = this.menuManager!.createAdvancedPatternMenu(
            hasInputChunks,
            hasProcessedOutputs,
            outputPatterns
        ).reply_markup;

        // Create the menu message
        const message = `📝 <b>Advanced Pattern Processing</b>\n\n` +
            `Choose which content to process and how:\n\n` +
            `${availableContent}\n` +
            `Select an option to continue:`;

        try {
            if (messageId) {
                await adapter.editMessageText(
                    message,
                    {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    }
                );
            } else {
                await adapter.reply(
                    message,
                    {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    }
                );
            }
        } catch (error) {
            console.warn(`[${methodName}] Error showing menu:`, error);
            // Try without the availableContent section if it might be too long
            const shorterMessage = `📝 <b>Advanced Pattern Processing</b>\n\nChoose which content to process and how:`;

            if (messageId) {
                await adapter.editMessageText(
                    shorterMessage,
                    {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    }
                );
            } else {
                await adapter.reply(
                    shorterMessage,
                    {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    }
                );
            }
        }
    }

    private async showOutputActionsMenu(
        adapter: ContextAdapter,
        userId: string,
        patternName: string,
        messageId?: number | string
    ): Promise<void> {
        const methodName = 'showOutputActionsMenu';

        // Use MenuManager to create the output actions menu
        const keyboard = this.menuManager!.createOutputActionsMenu(patternName).reply_markup;

        const menuMessage = `✨ <b>Processing complete with ${patternName}</b>\n\nWhat would you like to do next?`;

        if (messageId) {
            try {
                await adapter.editMessageText(
                    menuMessage,
                    {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    }
                );
            } catch (error) {
                console.warn(`[${methodName}] Error editing message:`, error);
                await adapter.reply(menuMessage, {
                    parse_mode: 'HTML',
                    reply_markup: keyboard
                });
            }
        } else {
            await adapter.reply(menuMessage, {
                parse_mode: 'HTML',
                reply_markup: keyboard
            });
        }
    }

    private async processAllChunks(
        adapter: ContextAdapter,
        userId: string,
        patternName: string
    ): Promise<void> {
        const methodName = 'processAllChunks';

        const patternData = this.conversationManager!.cache.get<PatternData>(`pattern_data:${userId}`);
        if (!patternData) {
            await adapter.answerCallbackQuery('Pattern data not available');
            return;
        }

        // Ensure input chunks exist
        if (!patternData.inputChunks?.chunks || patternData.inputChunks.chunks.length === 0) {
            await adapter.answerCallbackQuery('No input chunks available for processing');
            return;
        }

        const chunks = patternData.inputChunks.chunks;
        const chunkCount = chunks.length;

        await adapter.safeAnswerCallbackQuery(`Processing all content with ${patternName}...`);

        // Show processing message
        const menuMessageId = adapter.context.messageId;
        if (menuMessageId) {
            try {
                await adapter.editMessageText(
                    `🔄 Combining ${chunkCount} chunks and processing with ${patternName}...\n\nThis may take a while.`,
                    { parse_mode: 'HTML' }
                );
            } catch (error) {
                console.warn(`[${methodName}] Error updating message:`, error);
            }
        }

        const patternAgent = this.agentManager!.getAgent('pattern') as PatternPromptAgent;
        if (!patternAgent) {
            throw new Error('Pattern agent not available');
        }

        // Combine all chunks with appropriate separators
        const combinedContent = this.combineChunksWithSeparators(chunks);
        console.log(`[${methodName}] Combined ${chunkCount} chunks into single content of ${combinedContent.length} characters`);

        // Update progress
        if (menuMessageId) {
            try {
                await adapter.editMessageText(
                    `🔄 Processing combined content (${Math.round(combinedContent.length / 1024)}KB) with ${patternName}...\n\nThis may take a while.`,
                    { parse_mode: 'HTML' }
                );
            } catch (error) {
                console.warn(`[${methodName}] Error updating progress:`, error);
            }
        }

        let result: string;
        let processingError: Error | null = null;

        try {
            // Process the combined content
            result = await patternAgent.processWithPattern(patternName, combinedContent, adapter);
            console.log(`[${methodName}] Successfully processed combined content, result length: ${result.length}`);
        } catch (error) {
            console.error(`[${methodName}] Error processing combined content:`, error);
            processingError = error instanceof Error ? error : new Error(String(error));

            // If processing as a whole fails, we'll try processing in chunks as fallback
            if (menuMessageId) {
                try {
                    await adapter.editMessageText(
                        `⚠️ Combined processing failed. Falling back to chunk-by-chunk processing...\n\nThis may take a while.`,
                        { parse_mode: 'HTML' }
                    );
                } catch (editError) {
                    console.warn(`[${methodName}] Error updating message:`, editError);
                }
            }

            // Process in chunks as fallback
            return this.processChunksIndividually(adapter, userId, patternName, chunks, patternAgent, patternData);
        }

        // Store the result
        const batchKey = `${patternName}_combined_${Date.now()}`;
        patternData.processedOutputs[batchKey] = {
            output: result,
            timestamp: Date.now(),
            isBatch: false // This is now a single combined result
        };

        // Split for display if needed
        if (result.length > 4000) {
            patternData.processedOutputs[batchKey].chunks = this.splitOutput(result);
        }

        this.conversationManager!.cache.set(`pattern_data:${userId}`, patternData, 14400); // 4 hours

        // Create appropriate menu based on result size
        let keyboard;
        if (result.length > 4000) {
            // If result was split for display, show navigation menu
            keyboard = this.menuManager!.createChunkNavigationMenu(
                batchKey,
                0,
                patternData.processedOutputs[batchKey].chunks!.length
            ).reply_markup;
        } else {
            // Otherwise show simple completion menu
            keyboard = this.menuManager!.createOutputActionsMenu(patternName).reply_markup;
        }

        // Show completion message and menu
        try {
            await adapter.editMessageText(
                `✅ <b>Processing complete!</b>\n\n` +
                `Successfully processed ${Math.round(combinedContent.length / 1024)}KB of content with "${patternName}".\n\n` +
                `Result size: ${Math.round(result.length / 1024)}KB`,
                {
                    parse_mode: 'HTML',
                    reply_markup: keyboard
                }
            );
        } catch (error) {
            console.warn(`[${methodName}] Error showing completion message:`, error);

            // Fallback: send a new message
            await adapter.reply(
                `✅ <b>Processing complete!</b>\n\n` +
                `Successfully processed combined content with "${patternName}".\n\n` +
                `Result size: ${Math.round(result.length / 1024)}KB`,
                {
                    parse_mode: 'HTML',
                    reply_markup: keyboard
                }
            );
        }

        // Display the result (first chunk if split)
        try {
            if (patternData.processedOutputs[batchKey].chunks) {
                // Display first chunk
                const firstChunk = patternData.processedOutputs[batchKey].chunks![0];
                await adapter.reply(
                    `<b>Result (Part 1 of ${patternData.processedOutputs[batchKey].chunks!.length}):</b>\n\n${firstChunk}`,
                    { parse_mode: 'HTML' }
                );
            } else {
                // Display entire result
                await adapter.reply(
                    `<b>Result:</b>\n\n${result}`,
                    { parse_mode: 'HTML' }
                );
            }
        } catch (error) {
            console.error(`[${methodName}] Error displaying result:`, error);
            // Try without HTML parsing if it failed
            try {
                await adapter.reply(`Processing completed. Result may be too complex to display directly.`);
            } catch (e) {
                console.error(`[${methodName}] Failed to send plain message:`, e);
            }
        }
    }

    // Helper method to intelligently combine chunks with appropriate separators
    private combineChunksWithSeparators(chunks: string[]): string {
        if (chunks.length === 1) {
            return chunks[0];
        }

        // Use page break and section indicators to help the model understand structure
        return chunks.map((chunk, index) => {
            // Add section header
            return `\n\n# Section ${index + 1}\n\n${chunk}`;
        }).join('\n\n----------\n\n');
    }

    // Fallback method to process chunks individually when combined processing fails
    private async processChunksIndividually(
        adapter: ContextAdapter,
        userId: string,
        patternName: string,
        chunks: string[],
        patternAgent: PatternPromptAgent,
        patternData: PatternData
    ): Promise<void> {
        const methodName = 'processChunksIndividually';
        const chunkCount = chunks.length;

        // Process each chunk individually
        const results: Array<{
            chunk: number;
            result?: string;
            error?: string;
        }> = [];

        const menuMessageId = adapter.context.messageId;

        for (let i = 0; i < chunkCount; i++) {
            // Update progress message
            if (menuMessageId) {
                try {
                    await adapter.editMessageText(
                        `🔄 Processing chunk ${i + 1}/${chunkCount} with ${patternName}...\n\nThis may take a while.`,
                        { parse_mode: 'HTML' }
                    );
                } catch (error) {
                    console.warn(`[${methodName}] Error updating progress:`, error);
                }
            }

            // Process the current chunk
            try {
                const result = await patternAgent.processWithPattern(patternName, chunks[i], adapter);
                results.push({ chunk: i, result });
            } catch (error) {
                console.error(`[${methodName}] Error processing chunk ${i}:`, error);
                results.push({ chunk: i, error: error instanceof Error ? error.message : String(error) });
            }

            // Small delay between chunks to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        // Store individual results
        const batchKey = `${patternName}_batch_${Date.now()}`;
        patternData.processedOutputs[batchKey] = {
            output: `Batch processing results for ${patternName} on ${chunkCount} chunks`,
            timestamp: Date.now(),
            batchResults: results.map(r => r.result || `Error: ${r.error}`),
            chunks: results.map(r => r.result || `Error: ${r.error}`),
            isBatch: true
        };

        this.conversationManager!.cache.set(`pattern_data:${userId}`, patternData, 14400); // 4 hours

        // Use MenuManager to create the batch completion menu
        const keyboard = this.menuManager!.createBatchCompletionMenu(batchKey).reply_markup;

        // Show completion message and menu
        try {
            await adapter.editMessageText(
                `✅ <b>Fallback processing complete!</b>\n\n` +
                `Successfully processed ${results.filter(r => r.result).length}/${chunkCount} chunks individually with ${patternName}.`,
                {
                    parse_mode: 'HTML',
                    reply_markup: keyboard
                }
            );
        } catch (error) {
            console.warn(`[${methodName}] Error showing completion message:`, error);

            // Fallback: send a new message
            await adapter.reply(
                `✅ <b>Fallback processing complete!</b>\n\n` +
                `Successfully processed ${results.filter(r => r.result).length}/${chunkCount} chunks individually with ${patternName}.`,
                {
                    parse_mode: 'HTML',
                    reply_markup: keyboard
                }
            );
        }

        // Send a summary of the individual processing
        const summaryChunks = [];
        for (let i = 0; i < results.length; i += 5) {
            const chunkSummary = results.slice(i, i + 5).map(r => {
                if (r.result) {
                    // For each result, take just the first line or first 100 chars
                    const preview = r.result.split('\n')[0].substring(0, 100);
                    return `Chunk ${r.chunk + 1}: ${preview}${preview.length >= 100 ? '...' : ''}`;
                } else {
                    return `Chunk ${r.chunk + 1}: Error: ${r.error}`;
                }
            }).join('\n\n');

            summaryChunks.push(chunkSummary);
        }

        // Send the summary chunks
        for (const summary of summaryChunks) {
            await adapter.reply(
                `<b>Individual Processing Summary (${patternName}):</b>\n\n${summary}`,
                { parse_mode: 'HTML' }
            );
        }
    }


    private async navigateInputChunks(
        adapter: ContextAdapter,
        userId: string,
        direction: string
    ): Promise<void> {
        const methodName = 'navigateInputChunks';
        console.log(`[${methodName}] Starting navigation with direction: "${direction}" for user: ${userId}`);

        // Get the pattern data
        const patternDataKey = `pattern_data:${userId}`;
        let patternData = this.conversationManager?.cache.get<PatternData>(patternDataKey);

        if (!patternData) {
            console.log(`[${methodName}] Pattern data not found, initializing from context data`);
            const contextDataKey = `pattern_context:${userId}`;
            const contextData = this.conversationManager?.cache.get<PatternContextData>(contextDataKey);

            if (contextData?.input) {
                patternData = {
                    originalInput: contextData.input,
                    processedOutputs: {},
                    currentPatternState: {}
                };
                this.conversationManager?.cache.set(patternDataKey, patternData, 14400); // 4 hours
            } else {
                await adapter.answerCallbackQuery('Input data not available');
                return;
            }
        }

        // Create input chunks if they don't exist yet
        if (!patternData.inputChunks || !patternData.inputChunks.chunks || patternData.inputChunks.chunks.length === 0) {
            if (patternData.originalInput) {
                console.log(`[${methodName}] Creating input chunks from original input of ${patternData.originalInput.length} bytes`);
                const newChunks = this.splitInput(patternData.originalInput);
                console.log(`[${methodName}] Created ${newChunks.length} chunks`);

                patternData.inputChunks = {
                    chunks: newChunks,
                    currentChunk: 0,
                    lastAccessed: Date.now()
                };
                this.conversationManager?.cache.set(patternDataKey, patternData, 14400); // 4 hours
            } else {
                console.warn(`[${methodName}] No original input available to create chunks`);
                await adapter.answerCallbackQuery('No input content available');
                return;
            }
        }

        // Now that we're sure chunks exist, calculate new chunk index
        let currentIndex = patternData.inputChunks.currentChunk || 0;
        let newIndex = currentIndex;

        console.log(`[${methodName}] Current index: ${currentIndex}, total chunks: ${patternData.inputChunks.chunks.length}, direction: ${direction}`);

        // Calculate new index based on direction
        if (direction === 'next' && currentIndex < patternData.inputChunks.chunks.length - 1) {
            newIndex = currentIndex + 1;
        } else if (direction === 'prev' && currentIndex > 0) {
            newIndex = currentIndex - 1;
        } else if (direction === 'first') {
            newIndex = 0;
        } else if (direction === 'last') {
            newIndex = patternData.inputChunks.chunks.length - 1;
        } else {
            await adapter.answerCallbackQuery(`No more input chunks in that direction`);
            return;
        }

        if (newIndex === currentIndex && direction !== 'first') {
            await adapter.answerCallbackQuery(`Already at ${direction === 'next' || direction === 'last' ? 'last' : 'first'} chunk`);
            return;
        }

        // Update pattern data
        patternData.inputChunks.currentChunk = newIndex;
        patternData.inputChunks.lastAccessed = Date.now();
        this.conversationManager?.cache.set(patternDataKey, patternData, 14400); // 4 hours

        // Create the navigation keyboard
        const keyboard = this.menuManager!.createInputChunkNavigationMenu(
            newIndex,
            patternData.inputChunks.chunks.length
        ).reply_markup;

        try {
            // Get chunk content
            const chunkContent = patternData.inputChunks.chunks[newIndex];

            // Display the chunk with navigation controls
            await adapter.editMessageText(
                `${chunkContent}\n\n` +
                `-----\n` +
                `📝 <b>Input Chunk ${newIndex + 1} of ${patternData.inputChunks.chunks.length}</b>`,
                {
                    parse_mode: 'HTML',
                    reply_markup: keyboard
                }
            );

            await adapter.answerCallbackQuery(`Showing input chunk ${newIndex + 1} of ${patternData.inputChunks.chunks.length}`);
        } catch (error) {
            console.error(`[${methodName}] Error displaying input chunk:`, error);
            await adapter.answerCallbackQuery('Error displaying input chunk');

            // Try to recover with a simple message
            try {
                await adapter.reply(`Error displaying chunk ${newIndex + 1}. Please try navigating again.`);
            } catch (replyError) {
                console.error(`[${methodName}] Error sending recovery message:`, replyError);
            }
        }
    }

    private async showPatternMenuForChunk(
        adapter: ContextAdapter,
        userId: string,
        sourceName: string,
        chunkIndex: number,
        messageId?: number | string
    ): Promise<void> {
        const methodName = 'showPatternMenuForChunk';

        const patternData = this.conversationManager!.cache.get<PatternData>(`pattern_data:${userId}`);
        if (!patternData) {
            await adapter.answerCallbackQuery('Pattern data not available');
            return;
        }

        // Check if the source data exists
        let chunkContent: string;

        if (sourceName === 'original') {
            // Using a chunk from the original input
            if (patternData.inputChunks?.chunks &&
                patternData.inputChunks.chunks.length > chunkIndex) {
                chunkContent = patternData.inputChunks.chunks[chunkIndex];
            } else {
                await adapter.answerCallbackQuery('Original input chunk not found');
                return;
            }
        } else {
            // Using a chunk from a previous pattern output
            const sourceOutput = patternData.processedOutputs[sourceName];
            if (sourceOutput?.chunks && sourceOutput.chunks.length > chunkIndex) {
                chunkContent = sourceOutput.chunks[chunkIndex];
            } else {
                await adapter.answerCallbackQuery('Source chunk not found');
                return;
            }
        }

        // Store the selection in the current pattern state
        patternData.currentPatternState.useProcessedOutput = sourceName;
        patternData.currentPatternState.selectedInputChunk = chunkIndex;
        this.conversationManager!.cache.set(`pattern_data:${userId}`, patternData, 14400); // 4 hours

        // Create standard patterns list
        const standardPatterns = [
            { name: 'summarize', emoji: '📝' },
            { name: 'improve_writing', emoji: '✍️' },
            { name: 'extract_wisdom', emoji: '💡' },
            { name: 'write_essay', emoji: '📚' }
        ];

        // Use MenuManager to create the pattern menu for chunk
        const keyboard = this.menuManager!.createChunkPatternMenu(standardPatterns).reply_markup;

        // Display source info
        const sourceInfo = sourceName === 'original' ?
            `Original Input (Chunk ${chunkIndex + 1})` :
            `${sourceName} Result (Chunk ${chunkIndex + 1})`;

        // Show a preview of the chunk content (truncated if needed)
        const maxPreviewLength = 300;
        const contentPreview = chunkContent.length > maxPreviewLength ?
            chunkContent.substring(0, maxPreviewLength) + '...' :
            chunkContent;

        const message = `📝 <b>Apply Pattern to Chunk</b>\n\n` +
            `<b>Source:</b> ${sourceInfo}\n\n` +
            `<b>Preview:</b>\n${contentPreview}\n\n` +
            `<b>Select a pattern to apply:</b>`;

        try {
            if (messageId) {
                await adapter.editMessageText(
                    message,
                    {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    }
                );
            } else {
                await adapter.reply(
                    message,
                    {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    }
                );
            }
        } catch (error) {
            console.warn(`[${methodName}] Error showing menu:`, error);

            // Try with shorter preview if it might be too long
            const shorterMessage = `📝 <b>Apply Pattern to Chunk</b>\n\n` +
                `<b>Source:</b> ${sourceInfo}\n\n` +
                `<b>Select a pattern to apply:</b>`;

            if (messageId) {
                await adapter.editMessageText(
                    shorterMessage,
                    {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    }
                );
            } else {
                await adapter.reply(
                    shorterMessage,
                    {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    }
                );
            }
        }
    }

    private async viewBatchResult(
        adapter: ContextAdapter,
        userId: string,
        batchKey: string,
        index: number
    ): Promise<void> {
        const methodName = 'viewBatchResult';

        const patternData = this.conversationManager!.cache.get<PatternData>(`pattern_data:${userId}`);
        if (!patternData || !patternData.processedOutputs[batchKey]) {
            await adapter.answerCallbackQuery('Batch results not available');
            return;
        }

        const batch = patternData.processedOutputs[batchKey];
        if (!batch.batchResults || !Array.isArray(batch.batchResults)) {
            await adapter.answerCallbackQuery('Invalid batch data format');
            return;
        }

        const results = batch.batchResults;
        if (index < 0 || index >= results.length) {
            await adapter.answerCallbackQuery('Result index out of range');
            return;
        }

        const result = results[index];

        // Use MenuManager to create the batch result navigation menu
        const keyboard = this.menuManager!.createBatchResultNavigationMenu(
            batchKey,
            index,
            results.length
        ).reply_markup;

        // Send the result
        await adapter.reply(
            `<b>Chunk ${index + 1} Result:</b>\n\n${result}`,
            {
                parse_mode: 'HTML',
                reply_markup: keyboard
            }
        );

        await adapter.answerCallbackQuery(`Showing result for chunk ${index + 1}`);
    }

    private async showPatternMenuForAllChunks(
        adapter: ContextAdapter,
        userId: string,
        messageId?: number | string
    ): Promise<void> {
        const methodName = 'showPatternMenuForAllChunks';

        const patternData = this.conversationManager!.cache.get<PatternData>(`pattern_data:${userId}`);
        if (!patternData) {
            await adapter.answerCallbackQuery('Pattern data not available');
            return;
        }

        // Ensure input chunks exist
        if (!patternData.inputChunks?.chunks || patternData.inputChunks.chunks.length === 0) {
            // If no chunks yet, create them
            console.warn(`[${methodName}] No existing chunks found, creating chunks from original input`);
            if (patternData.originalInput) {
                const newChunks = this.splitInput(patternData.originalInput);
                console.warn(`[${methodName}] Created ${newChunks.length} chunks from original input of length ${patternData.originalInput.length}`);
                patternData.inputChunks = {
                    chunks: newChunks,
                    currentChunk: 0,
                    lastAccessed: Date.now()
                };
                console.warn(`[${methodName}] First chunk preview: "${newChunks[0]?.substring(0, 50)}..."`);

                this.conversationManager!.cache.set(`pattern_data:${userId}`, patternData, 14400); // 4 hours
            } else {
                console.warn(`[${methodName}] No original input available to create chunks`);

                await adapter.answerCallbackQuery('No input content available for chunking');
                return;
            }
        }

        const chunkCount = patternData.inputChunks.chunks.length;

        // Use MenuManager to create the batch processing menu
        const keyboard = this.menuManager!.createBatchProcessingMenu(chunkCount).reply_markup;

        const message = `📝 <b>Batch Process All Chunks</b>\n\n` +
            `The content has been split into ${chunkCount} chunks.\n\n` +
            `Select a pattern to apply to all chunks:`;

        try {
            if (messageId) {
                await adapter.editMessageText(
                    message,
                    {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    }
                );
            } else {
                await adapter.reply(
                    message,
                    {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    }
                );
            }
        } catch (error) {
            console.warn(`[${methodName}] Error showing menu:`, error);
        }
    }
    private async showProcessedOutputsMenu(
        adapter: ContextAdapter,
        userId: string,
        messageId?: number | string
    ): Promise<void> {
        const methodName = 'showProcessedOutputsMenu';

        const patternData = this.conversationManager!.cache.get<PatternData>(`pattern_data:${userId}`);
        if (!patternData || !patternData.processedOutputs) {
            await adapter.answerCallbackQuery('No processed outputs available');
            return;
        }

        const outputPatterns = Object.keys(patternData.processedOutputs);
        if (outputPatterns.length === 0) {
            await adapter.answerCallbackQuery('No processed outputs available');
            return;
        }

        // Use MenuManager to create the processed outputs menu
        const keyboard = this.menuManager!.createProcessedOutputsMenu(outputPatterns).reply_markup;

        const message = `📝 <b>Choose a Processed Result</b>\n\n` +
            `Select a previous result to use as input for a new pattern:`;

        try {
            if (messageId) {
                await adapter.editMessageText(
                    message,
                    {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    }
                );
            } else {
                await adapter.reply(
                    message,
                    {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    }
                );
            }
        } catch (error) {
            console.warn(`[${methodName}] Error showing menu:`, error);
        }
    }
    private formatCategoryName(category: string): string {
        return category.charAt(0).toUpperCase() + category.slice(1);
    }
    public async cleanup(): Promise<void> {
        console.log(`[FlowID: ${this.flowId}] Starting CommandHandler cleanup...`);

        // Unregister all commands from the bot
        if (this.bot) {
            // This is a placeholder - the actual method to unregister commands may vary
            // depending on the Telegraf API or your implementation
            // await this.bot.unregisterAllCommands();
        }

        // Clear command cache if any
        // this.commandCache.clear();

        // Clear any stored state
        this.botIds = [];
        this.botCommandMenus.clear();
        this.botInfo = [];

        console.log(`[FlowID: ${this.flowId}] CommandHandler cleanup completed.`);
    }

    // Add the splitOutput method
    private splitOutput(output: string): string[] {
        // Intelligent splitting that respects markdown and paragraphs
        const chunks: string[] = [];
        let remaining = output;

        while (remaining.length > 0) {
            let chunkSize = Math.min(4000, remaining.length);

            // Find suitable break points (paragraph, sentence, or word)
            if (chunkSize < remaining.length) {
                const paragraphBreak = remaining.lastIndexOf('\n\n', chunkSize);
                const sentenceBreak = remaining.lastIndexOf('. ', chunkSize);
                const wordBreak = remaining.lastIndexOf(' ', chunkSize);

                if (paragraphBreak > chunkSize - 200) {
                    chunkSize = paragraphBreak + 2;
                } else if (sentenceBreak > chunkSize - 100) {
                    chunkSize = sentenceBreak + 2;
                } else if (wordBreak > chunkSize - 50) {
                    chunkSize = wordBreak + 1;
                }
            }

            chunks.push(remaining.substring(0, chunkSize));
            remaining = remaining.substring(chunkSize);
        }

        return chunks;
    }

    private storePatternOutput(
        userId: string,
        patternName: string,
        output: string,
        options?: {
            sourceName?: string;
            sourceChunkIndex?: number;
        }
    ): void {
        const cacheKey = `pattern_data:${userId}`;
        let patternData = this.conversationManager!.cache.get<PatternData>(cacheKey);

        if (!patternData) {
            console.warn(`[storePatternOutput] No pattern data found for user ${userId}`);
            return;
        }

        // Initialize or update the output entry for this pattern
        if (!patternData.processedOutputs) {
            patternData.processedOutputs = {};
        }

        patternData.processedOutputs[patternName] = {
            output,
            timestamp: Date.now(),
            chunks: output.length > 4000 ? this.splitOutput(output) : undefined,
            sourceName: options?.sourceName,
            sourceChunkIndex: options?.sourceChunkIndex
        };

        // Update pattern state
        patternData.currentPatternState.lastProcessedPattern = patternName;

        // Store in cache
        this.conversationManager!.cache.set(cacheKey, patternData, 14400); // 4 hours

        console.log(`[storePatternOutput] Stored output for pattern ${patternName}, user ${userId}, length: ${output.length}`);
    }


    public async handleYouTubeAction(adapter: ContextAdapter, videoId: string, youtubeAction: string): Promise<void> {
        const methodName = 'handleYouTubeAction';
        console.log(`[${methodName}] Processing action for videoId: ${videoId}, action: ${youtubeAction}`);

        try {
            // Get user ID for storing content
            const { userId } = await this.conversationManager!.getSessionInfo(adapter);

            // Show loading message
            await adapter.reply("⏳ Fetching content from YouTube... This may take a moment.");

            // Map the action to the tool action
            const actionMap: { [key: string]: string } = {
                'transcript': 'transcript',
                'timestamps': 'transcript_with_timestamps',
                'metadata': 'metadata',
                'comments': 'comments'
            };

            const toolAction = actionMap[youtubeAction] || 'transcript';

            // Get the tool manager using our helper method
            const toolManager = this.getToolManager();
            if (!toolManager) {
                throw new Error('ToolManager is not available');
            }

            // Check if YouTube tool is available
            const toolNames = toolManager.getToolNames();
            const hasYouTubeTool = toolNames.includes('youtube_tool');

            if (!hasYouTubeTool) {
                await adapter.reply("❌ YouTube tool is not available. Please check your configuration.");
                return;
            }

            // Always use the watch?v= format for API calls regardless of the original URL format
            const youtubeUrl = `https://youtube.com/watch?v=${videoId}`;

            // Prepare the input for the tool
            const input = JSON.stringify({
                url: youtubeUrl,
                action: toolAction,
                language: 'en'
            });

            console.log(`[${methodName}] Executing YouTube tool with URL: ${youtubeUrl}, action: ${toolAction}`);
            const result = await toolManager.executeTool('youtube_tool', input);

            // Check for errors
            if (result.startsWith('Error:')) {
                await adapter.reply(`❌ ${result}`);
                return;
            }

            // Create pattern data for future processing
            const patternDataKey = `pattern_data:${userId}`;
            let patternData = this.conversationManager!.cache.get<PatternData>(patternDataKey) || {
                originalInput: '',
                processedOutputs: {},
                currentPatternState: {}
            };

            // Store the result as originalInput for pattern processing
            patternData.originalInput = result;

            // Also store it as a processed output with the key "raw_transcript"
            patternData.processedOutputs["raw_transcript"] = {
                output: result,
                timestamp: Date.now()
            };

            // Add video metadata to the pattern data
            patternData.sourceInfo = {
                type: 'youtube',
                url: youtubeUrl,
                title: `YouTube ${toolAction} (ID: ${videoId})`,
                metadata: {
                    videoId: videoId,
                    fetchedWith: toolAction,
                    fetchTime: new Date().toISOString()
                }
            };

            this.conversationManager!.cache.set(patternDataKey, patternData, 14400); // 4 hours

            // For storing in context cache for pattern suggestions with YouTube-specific suggestion
            const youtubePatternSuggestion = {
                pattern: toolAction === 'transcript' ? 'summarize_youtube_transcript' : 'analyze_youtube_content',
                confidence: 0.95,
                alternativePatterns: [
                    'extract_insights',
                    'summarize',
                    'create_qa_pairs'
                ]
            };

            const contextData = {
                input: result,
                interactionType: 'general_input',
                contextRequirement: 'chat',
                timestamp: Date.now(),
                metadata: {
                    source: 'youtube',
                    videoId: videoId,
                    action: toolAction,
                    suggestion: youtubePatternSuggestion
                }
            };
            this.conversationManager!.cache.set(`pattern_context:${userId}`, contextData, 14400); // 4 hours

            // Format the content for display based on action
            let response = "";
            let parseMode: "HTML" | "Markdown" | undefined = undefined;

            if (toolAction === 'metadata' || toolAction === 'comments') {
                try {
                    // Format JSON for display
                    const parsed = JSON.parse(result);

                    // For metadata, extract and show the video title if available
                    let videoTitle = "";
                    if (toolAction === 'metadata' && parsed.title) {
                        videoTitle = `\n\n**Title:** ${parsed.title}`;
                    }

                    response = `📝 Retrieved ${youtubeAction} from YouTube video:${videoTitle}\n\n`;
                    response += "```json\n" + JSON.stringify(parsed, null, 2).substring(0, 3000) + "\n```";
                    if (JSON.stringify(parsed, null, 2).length > 3000) {
                        response += "\n\n[Content truncated for display]";
                    }
                    parseMode = "Markdown";
                } catch (e) {
                    response = result.substring(0, 3500);
                    if (result.length > 3500) {
                        response += "\n\n[Content truncated for display]";
                    }
                }
            } else {
                // For transcript, show a preview
                const preview = result.length > 800 ?
                    result.substring(0, 800) + "...\n\n[Content truncated for preview]" :
                    result;

                response = `📝 Retrieved ${youtubeAction} from YouTube video:\n\n${preview}`;

                // For longer transcripts, also send as a downloadable file
                if (result.length > 2000) {
                    // Ensure FileManager is initialized
                    if (!this.fileManager) {
                        this.fileManager = new FileManager(this.telegramBot?.getBotToken());
                    }

                    // Create a descriptive filename
                    const filename = `youtube_transcript_${videoId}_${new Date().toISOString().slice(0, 10)}`;
                    await this.fileManager.saveAndSendAsText(adapter, result, filename);
                }

            }

            // Use MenuManager to create a pattern selection menu
            // First ensure we have a reference to the MenuManager
            if (!this.menuManager) {
                throw new Error('MenuManager is not available');
            }

            // Create a pattern selection menu with YouTube-specific suggestions
            const keyboard = this.menuManager.createPatternSelectionMenu(
                youtubePatternSuggestion,
                youtubePatternSuggestion.alternativePatterns
            ).reply_markup;

            // Send the response with pattern selection menu
            await adapter.reply(response, {
                parse_mode: parseMode,
                reply_markup: keyboard
            });

        } catch (error) {
            console.error(`[${methodName}] Error:`, error);
            await adapter.reply(`❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    public async handleRumbleAction(adapter: ContextAdapter, videoId: string, rumbleAction: string): Promise<void> {
        const methodName = 'handleRumbleAction';
        console.log(`[${methodName}] Processing action for videoId: ${videoId}, action: ${rumbleAction}`);

        // Status message tracking
        let statusMessageId: number | undefined;

        // Status update function
        // Status update function with timestamp to ensure content changes
        const updateStatus = async (text: string) => {
            try {
                // Replace HTML line breaks with newlines for Telegram
                const formattedText = text.replace(/<br>/g, '\n');

                // Add a hidden timestamp to ensure content changes
                const timestamp = Date.now();
                const messageWithTimestamp = `${formattedText}\n\u200B${timestamp}`; // Zero-width space followed by timestamp

                if (statusMessageId) {
                    // Pass message ID directly as second parameter
                    await adapter.editMessageText(messageWithTimestamp, statusMessageId);
                } else {
                    // Create new status message
                    const statusMsg = await adapter.reply(`⏳ ${formattedText}`);
                    if (statusMsg && 'message_id' in statusMsg) {
                        statusMessageId = statusMsg.message_id;
                    }
                }
            } catch (error) {
                console.warn(`[${methodName}] Failed to update status:`, error);
                // Non-critical error, continue execution
            }
        };

        // Timer for status updates
        let statusTimer: NodeJS.Timeout | null = null;
        let processingStartTime: number | null = null;

        try {
            // Get user ID for storing content
            const { userId } = await this.conversationManager!.getSessionInfo(adapter);

            // Ensure FileManager is initialized
            if (!this.fileManager) {
                this.fileManager = new FileManager(this.telegramBot?.getBotToken());
            }

            // Show initial status message
            const statusMsg = await adapter.reply("⏳ Fetching content from Rumble... This may take a moment.");
            if (statusMsg && 'message_id' in statusMsg) {
                statusMessageId = statusMsg.message_id;
            }

            // Show initial status message
            await updateStatus("Fetching content from Rumble... This may take a moment.");

            // Get the tool manager
            const toolManager = this.getToolManager();
            if (!toolManager) {
                throw new Error('ToolManager is not available');
            }

            // Check if Rumble tool is available
            const toolNames = toolManager.getToolNames();
            const hasRumbleTool = toolNames.includes('rumble_tool');

            if (!hasRumbleTool) {
                await adapter.reply("❌ Rumble tool is not available. Please check your configuration.");
                return;
            }

            // Get user's transcription settings
            let transcriptionOptions = {};
            try {
                if (TranscriptionSettingsUtil && typeof TranscriptionSettingsUtil.getUserSettings === 'function') {
                    const settings = TranscriptionSettingsUtil.getUserSettings(userId, this.conversationManager!);
                    transcriptionOptions = {
                        provider: settings.provider,
                        modelSize: settings.modelSize,
                        language: settings.language
                    };
                    console.log(`[${methodName}] Using user transcription settings:`, transcriptionOptions);
                }
            } catch (settingsError) {
                console.warn(`[${methodName}] Error getting transcription settings:`, settingsError);
            }

            // Set up a periodic status update for long-running transcription
            processingStartTime = Date.now();
            let elapsedMinutes = 0;

            // For long transcription operations, update status every 30 seconds
            statusTimer = setInterval(async () => {
                elapsedMinutes = Math.floor((Date.now() - processingStartTime!) / 60000);
                
                // Check if we have a transcription estimate
                let estimateMsg = '';
                try {
                    const globalEstimates = (global as any).transcriptionEstimates;
                    if (globalEstimates && globalEstimates instanceof Map) {
                        const estimate = globalEstimates.get(videoId);
                        if (estimate && (Date.now() - estimate.timestamp) < 5 * 60 * 1000) { // Only use if less than 5 minutes old
                            estimateMsg = `\nEstimated total time: ${estimate.estimatedMinutes} minutes`;
                        }
                    }
                } catch (e) {
                    console.warn('Error checking for transcription estimate:', e);
                }
                
                await updateStatus(
                    `Still processing Rumble video...\n` +
                    `⏱️ Elapsed time: ${elapsedMinutes} minutes${estimateMsg}\n` +
                    `Please be patient for large videos.`
                );
            }, 30000); // Update every 30 seconds

            // Prepare the input for the tool
            const input = JSON.stringify({
                url: videoId,
                action: rumbleAction,
                transcriptionOptions
            });

            console.log(`[${methodName}] Executing Rumble tool with videoId: ${videoId}, action: ${rumbleAction}`);
            // Update status to indicate we're moving to the transcription phase
            await updateStatus("Downloading and processing video from Rumble...\nThis may take several minutes for longer videos.");
            const result = await toolManager.executeTool('rumble_tool', input);

            // Stop status updates
            if (statusTimer) {
                clearInterval(statusTimer);
                statusTimer = null;
            }

            // Clean up status message
            if (statusMessageId) {
                try {
                    await adapter.deleteMessage(statusMessageId);
                    statusMessageId = undefined;
                } catch (error) {
                    console.warn(`[${methodName}] Failed to delete status message:`, error);
                }
            }

            // Check for errors or "Video not found" message
            if (result.startsWith('Error:') ||
                result.includes('Video not found') ||
                result.includes('Failed to download')) {
                // Sanitize the result to avoid HTML parsing errors
                const safeResult = result
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;');

                await adapter.reply(`❌ ${safeResult}`, { parse_mode: undefined });
                return;
            }

            // Create pattern data for future processing
            const patternDataKey = `pattern_data:${userId}`;
            let patternData = this.conversationManager!.cache.get<PatternData>(patternDataKey) || {
                originalInput: '',
                processedOutputs: {},
                currentPatternState: {}
            };

            // Store the result as originalInput for pattern processing
            patternData.originalInput = result;

            // Also store it as a processed output
            patternData.processedOutputs["raw_rumble_data"] = {
                output: result,
                timestamp: Date.now()
            };

            // Add video metadata to the pattern data
            patternData.sourceInfo = {
                type: 'rumble',
                url: `https://rumble.com/embed/${videoId}`,
                title: `Rumble ${rumbleAction} (ID: ${videoId})`,
                metadata: {
                    videoId: videoId,
                    fetchedWith: rumbleAction,
                    fetchTime: new Date().toISOString()
                }
            };

            this.conversationManager!.cache.set(patternDataKey, patternData, 14400); // 4 hours

            // For storing in context cache for pattern suggestions with Rumble-specific suggestion
            const rumblePatternSuggestion = {
                pattern: rumbleAction === 'transcript' ? 'summarize_video_transcript' : 'analyze_video_content',
                confidence: 0.95,
                alternativePatterns: [
                    'extract_insights',
                    'summarize',
                    'create_qa_pairs'
                ]
            };

            const contextData = {
                input: result,
                interactionType: 'general_input',
                contextRequirement: 'chat',
                timestamp: Date.now(),
                metadata: {
                    source: 'rumble',
                    videoId: videoId,
                    action: rumbleAction,
                    suggestion: rumblePatternSuggestion
                }
            };
            this.conversationManager!.cache.set(`pattern_context:${userId}`, contextData, 14400); // 4 hours

            // Handle the result based on action type
            if (rumbleAction === 'metadata') {
                try {
                    // Format JSON for display
                    const parsed = JSON.parse(result);
                    const title = parsed.title ? `\n\n**Title:** ${parsed.title}` : '';

                    const response = `📋 Retrieved metadata from Rumble video:${title}\n\n`;
                    const formattedJson = "```json\n" + JSON.stringify(parsed, null, 2).substring(0, 3000) + "\n```";

                    // Send the formatted response directly - these are typically small
                    await adapter.reply(response + formattedJson, { parse_mode: "Markdown" });
                } catch (e) {
                    await adapter.reply(result);
                }
            } else if (rumbleAction === 'transcript') {
                try {
                    // For transcripts, always send as a file for consistency
                    // First send a preview message with the beginning of the transcript
                    const preview = result.substring(0, 500) + "...";
                    await adapter.reply(`📝 Retrieved transcript from Rumble video:\n\n${preview}\n\nSending full transcript as a file...`);

                    // Create a descriptive filename that includes the video ID
                    const filename = `rumble_transcript_${videoId}_${new Date().toISOString().slice(0, 10)}`;
                    await this.fileManager.saveAndSendAsText(adapter, result, filename);

                    // Show the pattern suggestion menu
                    if (this.menuManager) {
                        const keyboard = this.menuManager.createPatternSelectionMenu(
                            rumblePatternSuggestion,
                            rumblePatternSuggestion.alternativePatterns
                        ).reply_markup;

                        await adapter.reply(
                            `📝 How would you like to process this transcript?`,
                            {
                                parse_mode: 'HTML',
                                reply_markup: keyboard
                            }
                        );
                    }
                } catch (fileError) {
                    console.error(`[${methodName}] Error sending transcript as file:`, fileError);

                    // If file sending fails, fall back to a message about processing the content
                    await adapter.reply(
                        "⚠️ Unable to send the full transcript as a file. " +
                        "You can still process the transcript using the pattern menu below."
                    );

                    // Still show the pattern menu
                    if (this.menuManager) {
                        const keyboard = this.menuManager.createPatternSelectionMenu(
                            rumblePatternSuggestion,
                            rumblePatternSuggestion.alternativePatterns
                        ).reply_markup;

                        await adapter.reply(
                            `📝 How would you like to process this transcript?`,
                            {
                                parse_mode: 'HTML',
                                reply_markup: keyboard
                            }
                        );
                    }
                }
            } else {
                // For other actions like download
                await adapter.reply(result);
            }
        } catch (error) {
            if (statusTimer) {
                clearInterval(statusTimer);
                statusTimer = null;
            }
            console.error(`[${methodName}] Error:`, error);

            // Clean up status message if it exists
            if (statusMessageId) {
                try {
                    await adapter.deleteMessage(statusMessageId);
                } catch (deleteError) {
                    console.warn(`[${methodName}] Error deleting status message:`, deleteError);
                }
            }

            // Handle specific error types
            if (error.response?.status === 410 ||
                (error.message && error.message.includes('410'))) {
                await adapter.reply(
                    "📵 This Rumble video appears to be unavailable or has been removed.\n\n" +
                    "The server returned a 410 Gone error, which means the video has been deleted or moved."
                );
            } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
                await adapter.reply("📶 Unable to connect to Rumble's servers. Please check your internet connection and try again later.");
            } else if ((error as any)?.response?.status === 429 || (error instanceof Error && error.message.includes('429'))) {
                // Rate limit error handling
                await adapter.reply("⏳ Telegram rate limit reached. Please try again in a few moments.");
            } else {
                await adapter.reply(`❌ Error: ${error instanceof Error ? error.message : 'Unknown error occurred while processing the Rumble request'}`);
            }
        }
    }

    private async showPatternSuggestionMenu(
        adapter: ContextAdapter,
        userId: string,
        suggestion: any
    ): Promise<void> {
        // Check if MenuManager is available
        if (!this.menuManager) {
            console.warn('MenuManager is not available for pattern suggestions');
            return;
        }

        try {
            // Create a pattern selection menu with video-specific suggestions
            const keyboard = this.menuManager.createPatternSelectionMenu(
                suggestion,
                suggestion.alternativePatterns
            ).reply_markup;

            // Send the pattern menu
            await adapter.reply(
                `📝 How would you like to process this content?\n\nI recommend the <b>${suggestion.pattern}</b> pattern, which is ideal for video transcripts.`,
                {
                    parse_mode: 'HTML',
                    reply_markup: keyboard
                }
            );
        } catch (error) {
            console.error('Error showing pattern suggestion menu:', error);
        }
    }


    private async handlePatternDownload(
        adapter: ContextAdapter,
        patternName: string,
        format: string = 'text'
    ): Promise<void> {
        try {
            // Get the correct user ID format
            const context = adapter.getMessageContext();
            const { userId } = await this.conversationManager!.getSessionInfo(context);

            console.log(`Processing download for user ${userId}, pattern ${patternName}, format ${format}`);

            // Try both user ID formats
            let patternData = this.conversationManager?.cache.get<PatternData>(`pattern_data:${userId}`);

            if (!patternData) {
                console.warn(`No pattern data found for user ${userId}`);
                await adapter.safeAnswerCallbackQuery('Pattern data not available');
                return;
            }

            let content: string;
            let title: string;

            // Special case for 'merged_chunks'
            if (patternName === 'merged_chunks') {
                if (!patternData.inputChunks?.chunks || patternData.inputChunks.chunks.length === 0) {
                    await adapter.safeAnswerCallbackQuery('Input chunks not available');
                    return;
                }

                // Combine all chunks
                content = this.combineChunksWithSeparators(patternData.inputChunks.chunks);
                title = `merged_content_${new Date().toISOString().slice(0, 10)}`;

                console.log(`[handlePatternDownload] Created merged content of ${content.length} characters`);
            }
            // Special case for individual chunk download
            else if (patternName.startsWith('chunk_')) {
                const chunkIndex = parseInt(patternName.replace('chunk_', ''));

                if (!patternData.inputChunks?.chunks || chunkIndex >= patternData.inputChunks.chunks.length) {
                    await adapter.safeAnswerCallbackQuery('Chunk not available');
                    return;
                }

                content = patternData.inputChunks.chunks[chunkIndex];
                title = `input_chunk_${chunkIndex + 1}_${new Date().toISOString().slice(0, 10)}`;
            }
            // Special case for 'original' input
            else if (patternName === 'original') {
                if (!patternData.originalInput) {
                    console.warn(`No original input found for user ${userId}`);
                    await adapter.safeAnswerCallbackQuery('Original input not available');
                    return;
                }
                content = patternData.originalInput;
                const contentType = 'original';
                title = `${contentType}_input_${new Date().toISOString().slice(0, 10)}`;
            }
            // Regular case for pattern outputs
            else {
                if (!patternData.processedOutputs || !patternData.processedOutputs[patternName]) {
                    console.warn(`Pattern "${patternName}" not found in available patterns: ${Object.keys(patternData.processedOutputs || {}).join(', ')}`);

                    // If the exact pattern is not found, check for a similar one (just in case)
                    const availablePatterns = Object.keys(patternData.processedOutputs || {});
                    if (availablePatterns.length > 0) {
                        const suggestion = `Available patterns: ${availablePatterns.join(', ')}`;
                        await adapter.safeAnswerCallbackQuery(`Pattern "${patternName}" not found. ${suggestion}`);
                    } else {
                        await adapter.safeAnswerCallbackQuery(`No processed patterns available`);
                    }
                    return;
                }

                content = patternData.processedOutputs[patternName].output;
                if (!content) {
                    console.warn(`No content found in pattern ${patternName}`);
                    await adapter.safeAnswerCallbackQuery('No content available to download');
                    return;
                }

                // Use patternName for the filename
                const contentType = this.getContentTypeFromPatternName(patternName);
                title = `${contentType}_${patternName}_${new Date().toISOString().slice(0, 10)}`;
            }

            await adapter.safeAnswerCallbackQuery(`Preparing ${format} file...`);
            console.log(`Preparing to save content with title: ${title}, format: ${format}, content length: ${content.length}`);

            if (format === 'pdf') {
                // Get the pattern agent
                const patternAgent = this.agentManager?.getAgent('pattern') as PatternPromptAgent;

                if (patternAgent) {
                    try {
                        // Format the content for PDF
                        const pdfContent = await patternAgent.processForPDF('format_for_pdf', content, adapter);
                        // Pass either the structured content object or the fallback string to saveAndSendAsPDF
                        // Note: This will require updating saveAndSendAsPDF in FileManager to accept the object type.
                        await this.fileManager.saveAndSendAsPDF(adapter, pdfContent, title);
                    } catch (error: unknown) { // Add type annotation
                        // Fall back to regular content if formatting fails
                        console.warn(`Failed to format content for PDF: ${error instanceof Error ? error.message : String(error)}`);
                        await this.fileManager.saveAndSendAsPDF(adapter, content, title);
                    }
                } else {
                    await this.fileManager.saveAndSendAsPDF(adapter, content, title);
                }
            } else {
                await this.fileManager.saveAndSendAsText(adapter, content, title);
            }
        } catch (error: unknown) { // Add type annotation
            console.error('Error handling pattern download:', error instanceof Error ? error.message : String(error));
            await adapter.safeAnswerCallbackQuery('Error creating file for download');
        }
    }

    // Helper method to determine content type from pattern name
    private getContentTypeFromPatternName(patternName: string): string {
        if (patternName.includes('summarize') || patternName.includes('summary')) {
            return 'summary';
        } else if (patternName.includes('analyze') || patternName.includes('analysis')) {
            return 'analysis';
        } else if (patternName.includes('extract')) {
            return 'extract';
        } else if (patternName.includes('transcript')) {
            return 'transcript';
        } else {
            return 'content';
        }
    }

    // Add to CommandHandler.ts

    /**
     * Sets up handlers for the standard menu actions
     */
    setupStandardMenuHandlers(): void {
        this.bot.action(/^standard_menu:(.+):(\d+)$/, async (ctx) => {
            const adapter = new ContextAdapter(ctx, this.promptManager);
            const [action, botId] = ctx.match?.slice(1) || ['', ''];

            await this.handleStandardMenuAction(adapter, action, parseInt(botId));
        });
    }

    /**
  * Handles actions from the standard menu
  * @param adapter The context adapter
  * @param action The action selected
  * @param botId The associated bot ID
  * @param parameter Optional parameter for the action
  */
    public async handleStandardMenuAction(
        adapter: ContextAdapter,
        action: string,
        botId: number,
        parameter?: string
    ): Promise<void> {
        const methodName = 'handleStandardMenuAction';
        console.log(`[${methodName}] Processing action: ${action} with botId: ${botId}, parameter: ${parameter || 'none'}`);

        try {
            await adapter.safeAnswerCallbackQuery('Processing...');
            const context = adapter.getMessageContext();
            const userId = context.userId.toString();

            switch (action) {
                case 'commands':
                    // Show commands menu
                    await this.showCommandMenu(adapter, botId);
                    break;

                case 'query':
                    // Prompt user to ask a question
                    await adapter.reply(
                        "What would you like to know? I'm ready to help!",
                        { reply_markup: { force_reply: true } }
                    );
                    break;

                case 'select_bot':
                    // Show bot selection menu for group chats
                    if (this.telegramBot) {
                        const botInfo = this.telegramBot.getAllBotInfo();
                        const keyboard = this.menuManager!.createBotSelectionMenu(botInfo);
                        await adapter.reply('Select a bot to interact with:', {
                            reply_markup: keyboard.reply_markup
                        });
                    }
                    break;

                case 'settings':
                    // Show settings menu
                    await this.showSettingsMenu(adapter, botId);
                    break;
                case 'sources':
                    // Show source citations for the response
                    await this.telegramBot!.showSourceCitations(adapter, botId);
                    break;

                case 'help':
                    // Show help message
                    await adapter.reply(
                        "# Help Guide\n\n" +
                        "Here are some things I can do:\n\n" +
                        "- Answer questions on various topics\n" +
                        "- Process text with different patterns\n" +
                        "- Play Who Wants to be a Millionaire\n" +
                        "- Help with research and information retrieval\n\n" +
                        "Try commands like:\n" +
                        "- /help - Show this help message\n" +
                        "- /millionaire - Play a quiz game\n" +
                        "- /rag - Toggle knowledge retrieval mode\n" +
                        "- /patterns - Apply processing patterns to text",
                        { parse_mode: 'Markdown' }
                    );
                    break;

                case 'pattern':
                    // Create pattern context from the current message or response
                    await this.handlePatternFromResponse(adapter, botId);
                    break;

                case 'follow_up':
                    // Generate follow-up questions for the current response
                    await this.telegramBot!.generateFollowUpSuggestions(adapter, botId);
                    break;

                case 'download':
                    // Use the existing handlePatternDownload but with 'latest_response' as the pattern
                    // This effectively downloads the latest response in the specified format
                    if (parameter) {
                        await this.handlePatternDownload(adapter, 'latest_response', parameter);
                    } else {
                        await adapter.safeAnswerCallbackQuery('Missing format parameter');
                    }
                    break;

                default:
                    console.warn(`[${methodName}] Unknown standard menu action: ${action}`);
                    await adapter.safeAnswerCallbackQuery('This feature is not available yet.');
            }
        } catch (error: unknown) { // Add type annotation
            console.error(`[${methodName}] Error handling standard menu action ${action}:`, error instanceof Error ? error.message : String(error));
            await this.safeAnswerCallback(adapter, 'An error occurred. Please try again.');
        }
    }

    /**
     * Shows a settings menu with key user preferences
     */
    // Update in CommandHandler.ts

    private async showSettingsMenu(adapter: ContextAdapter, botId: number): Promise<void> {
        const userId = adapter.getMessageContext().userId.toString();

        // Determine current RAG mode status
        const isRagEnabled = this.agentManager!.isRAGModeEnabled(userId);

        // Get thinking preferences using the correct method name
        const thinkingManager = this.conversationManager!.getThinkingManager();
        const thinkingPrefs = thinkingManager?.getPreferences(userId);
        const showThinking = thinkingPrefs?.showThinking || false;

        // Create settings menu
        const keyboard = Markup.inlineKeyboard([
            [
                Markup.button.callback(
                    `RAG Mode: ${isRagEnabled ? '✅ ON' : '❌ OFF'}`,
                    `ragmode:${botId}`
                )
            ],
            [
                Markup.button.callback(
                    `Thinking Process: ${showThinking ? '✅ ON' : '❌ OFF'}`,
                    `thinking_toggle`
                )
            ],
            [
                Markup.button.callback('🔙 Back', `standard_menu:main:${botId}`)
            ]
        ]);

        await adapter.reply('⚙️ *Settings*\n\nAdjust how I work for you:', {
            parse_mode: 'Markdown',
            reply_markup: keyboard.reply_markup
        });
    }

    /**
 * Handles setting up pattern processing from a response
 * @param adapter The context adapter
 * @param botId The current bot ID
 */
    private async handlePatternFromResponse(adapter: ContextAdapter, botId: number): Promise<void> {
        const methodName = 'handlePatternFromResponse';
        console.log(`[${methodName}] Setting up pattern processing from response`);

        try {
            const context = adapter.getMessageContext();
            const userId = context.userId.toString();

            // Check if we have stored pattern data first
            const patternDataKey = `pattern_data:${userId}`;
            const patternData = this.conversationManager!.cache.get<PatternData>(patternDataKey);

            // Check for latest response in pattern data
            let messageContent: string = '';
            let messageId: number | undefined;

            if (patternData?.processedOutputs?.latest_response) {
                messageContent = patternData.processedOutputs.latest_response.output;
                messageId = patternData.processedOutputs.latest_response.messageIds?.[0];
                console.log(`[${methodName}] Using stored latest response: ${messageContent.length} chars`);
            }

            // If no stored data, fall back to extracting from current message
            if (!messageContent) {
                console.log(`[${methodName}] No stored response found, trying to extract from message`);

                // If this is a callback query, get content from the message it's attached to
                if (adapter.isCallbackQuery() && context.raw?.callbackQuery?.message) {
                    const message = context.raw.callbackQuery.message;
                    if ('text' in message) {
                        messageContent = message.text;
                        messageId = message.message_id;
                    } else if ('caption' in message && message.caption) {
                        messageContent = message.caption;
                        messageId = message.message_id;
                    }
                }
            }

            if (!messageContent) {
                await adapter.safeAnswerCallbackQuery('Could not retrieve message content to process');
                return;
            }

            console.log(`[${methodName}] Retrieved content of length: ${messageContent.length}`);

            // The rest of the pattern processing code remains the same...
            // Pattern agent and suggestion code as in the previous implementation

            // Get pattern suggestion
            const patternAgent = this.agentManager?.getAgent('pattern') as PatternPromptAgent;
            if (!patternAgent) {
                await adapter.safeAnswerCallbackQuery('Pattern processing is not available');
                return;
            }

            // Ensure the content is stored for pattern processing
            if (!patternData || patternData.originalInput !== messageContent) {
                // Update pattern data
                const updatedPatternData = patternData || {
                    originalInput: messageContent,
                    processedOutputs: {},
                    currentPatternState: {}
                };

                updatedPatternData.originalInput = messageContent;
                this.conversationManager!.cache.set(patternDataKey, updatedPatternData, 14400); // 4 hours

                // Store pattern context
                const contextData = {
                    input: messageContent,
                    interactionType: 'general_input' as InteractionType,
                    contextRequirement: 'chat' as ContextRequirement,
                    timestamp: Date.now(),
                    originalMessageId: messageId || context.messageId,
                    currentPatternState: '',
                    metadata: {
                        userId,
                        messageId: messageId || context.messageId,
                        isResponse: true
                    }
                };

                this.conversationManager!.cache.set(`pattern_context:${userId}`, contextData, 14400); // 4 hours
            }

            // Get pattern suggestion and show the menu
            const suggestion = await patternAgent.suggestPattern(messageContent, "", 'general_input');
            await adapter.reply("⌛️ Getting patterns ready....");
            if (!suggestion) {
                // Show general pattern menu code...
                if (this.menuManager) {
                    const categories = patternAgent.getCategories();
                    const keyboard = this.menuManager.createPatternCategoriesMenu(categories).reply_markup;

                    await adapter.reply(
                        '📋 <b>Select a Pattern Category</b>\n\nChoose a category to see available processing patterns:',
                        {
                            parse_mode: 'HTML',
                            reply_markup: keyboard
                        }
                    );
                } else {
                    await adapter.reply("Pattern processing is available, but no specific suggestion could be generated.");
                }
                return;
            }

            // Create pattern selection menu with suggestion
            if (this.menuManager) {
                const keyboard = this.menuManager.createPatternSelectionMenu(
                    suggestion,
                    suggestion.alternativePatterns
                ).reply_markup;

                await adapter.reply(
                    `📝 I suggest processing this content with the <b>${suggestion.pattern}</b> pattern:\n\n` +
                    `<b>Description:</b> ${suggestion.description}\n\n` +
                    `Choose a pattern to apply:`,
                    {
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    }
                );
            } else {
                await adapter.reply(`Pattern processing is available. Consider using the ${suggestion.pattern} pattern.`);
            }

        } catch (error) {
            console.error(`[${methodName}] Error:`, error);
            await adapter.safeAnswerCallbackQuery('Error setting up pattern processing');
        }
    }
    private async handleBrowseInputChunks(
        adapter: ContextAdapter,
        userId: string
    ): Promise<void> {
        const methodName = 'handleBrowseInputChunks';
        console.log(`[${methodName}] Starting chunk browsing for user ${userId}`);

        // Get the pattern data
        const patternData = this.conversationManager!.cache.get<PatternData>(`pattern_data:${userId}`);
        if (!patternData) {
            await adapter.answerCallbackQuery('No pattern data available');
            return;
        }

        // Ensure we have original input
        if (!patternData.originalInput) {
            await adapter.answerCallbackQuery('No original input available to browse');
            return;
        }

        // Create input chunks if they don't exist yet
        if (!patternData.inputChunks || !patternData.inputChunks.chunks || patternData.inputChunks.chunks.length === 0) {
            console.log(`[${methodName}] Creating input chunks from original input`);

            // Using the splitInput method which should exist in your CommandHandler
            const chunks = this.splitInput(patternData.originalInput);

            patternData.inputChunks = {
                chunks,
                currentChunk: 0,
                lastAccessed: Date.now()
            };

            // Save updated pattern data
            this.conversationManager!.cache.set(`pattern_data:${userId}`, patternData, 14400); // 4 hours

            console.log(`[${methodName}] Created ${chunks.length} chunks from input of length ${patternData.originalInput.length}`);
        }

        // Now navigate to the first chunk
        await this.navigateInputChunks(adapter, userId, 'first');
    }

    // In CommandHandler.ts, add this new method
    public async handleTranscriptionSettingsAction(adapter: ContextAdapter, action: string, value?: string): Promise<void> {
        const methodName = 'handleTranscriptionSettingsAction';
        console.log(`[${methodName}] Processing action: ${action}, value: ${value}`);

        try {
            // Get user ID for storing settings
            const { userId } = await this.conversationManager!.getSessionInfo(adapter);

            // Get current settings
            const currentSettings = TranscriptionSettingsUtil.getUserSettings(userId, this.conversationManager!);

            // Process the action
            switch (action) {
                case 'provider':
                    if (value && ['local-cuda', 'local-cpu', 'assemblyai', 'google'].includes(value)) {
                        // Check if this is the same as current setting
                        if (currentSettings.provider === value) {
                            // No change needed, just acknowledge the callback
                            await adapter.answerCallbackQuery(`Already using ${value} provider`);
                            return;
                        }

                        // Update the settings with new value
                        const updatedSettings = TranscriptionSettingsUtil.updateSettings(
                            userId,
                            { provider: value as any },
                            this.conversationManager!
                        );

                        // Update the message
                        try {
                            await this.updateTranscriptionSettingsMessage(adapter, updatedSettings);
                        } catch (editError: unknown) { // Add type annotation
                            // If edit fails due to "not modified", just ignore
                            if (!(editError instanceof Error && editError.message?.includes('message is not modified'))) {
                                throw editError; // Rethrow if it's a different error
                            }
                        }

                        await adapter.answerCallbackQuery(`Transcription provider set to: ${value}`);
                    } else {
                        await adapter.answerCallbackQuery('Invalid provider selection');
                    }
                    break;

                case 'model':
                    if (value && ['tiny', 'base', 'small', 'medium', 'large'].includes(value)) {
                        const updatedSettings = TranscriptionSettingsUtil.updateSettings(
                            userId,
                            { modelSize: value as any },
                            this.conversationManager!
                        );

                        // Update the message
                        await this.updateTranscriptionSettingsMessage(adapter, updatedSettings);
                        await adapter.answerCallbackQuery(`Transcription model set to: ${value}`);
                    } else {
                        await adapter.answerCallbackQuery('Invalid model selection');
                    }
                    break;

                case 'lang':
                    if (value) {
                        const updatedSettings = TranscriptionSettingsUtil.updateSettings(
                            userId,
                            { language: value },
                            this.conversationManager!
                        );

                        // Update the message
                        await this.updateTranscriptionSettingsMessage(adapter, updatedSettings);
                        await adapter.answerCallbackQuery(`Language set to: ${value === 'auto' ? 'Auto-detect' : value}`);
                    } else {
                        await adapter.answerCallbackQuery('Invalid language selection');
                    }
                    break;

                case 'more_langs':
                    if (value) {
                        const page = parseInt(value);
                        await this.showLanguagePage(adapter, userId, page);
                        await adapter.answerCallbackQuery('Language selection page');
                    } else {
                        await adapter.answerCallbackQuery('Invalid page');
                    }
                    break;

                case 'back_main':
                    await this.updateTranscriptionSettingsMessage(adapter, currentSettings);
                    await adapter.answerCallbackQuery('Returned to main settings');
                    break;

                case 'close':
                    await adapter.deleteMessage();
                    await adapter.answerCallbackQuery('Transcription settings closed');
                    break;

                default:
                    await adapter.answerCallbackQuery('Unknown action');
                    break;
            }
        } catch (error) {
            console.error(`[${methodName}] Error:`, error);
            await adapter.answerCallbackQuery('Error processing request');
        }
    }

    // Helper methods for the handler
    private async updateTranscriptionSettingsMessage(adapter: ContextAdapter, settings: any): Promise<void> {
        // Don't require anything - use the functions imported at the top of the file
        await adapter.editMessageText(
            formatTranscriptionSettingsMessage(settings),
            {
                parse_mode: 'Markdown',
                reply_markup: createTranscriptionSettingsKeyboard(settings, this.bot?.botInfo?.id).reply_markup
            }
        );
    }

    private async showLanguagePage(adapter: ContextAdapter, userId: string, page: number): Promise<void> {

        // Define proper tuple type for language entries
        type LanguageEntry = [string, string]; // [display name, language code]

        // Common languages by page with proper typing
        const languagePages: LanguageEntry[][] = [
            [], // Page 0 (not used)
            [['English', 'en'], ['Spanish', 'es'], ['French', 'fr']],
            [['German', 'de'], ['Italian', 'it'], ['Portuguese', 'pt']],
            [['Russian', 'ru'], ['Japanese', 'ja'], ['Chinese', 'zh']]
        ];

        const totalPages = languagePages.length - 1;
        const currentSettings = TranscriptionSettingsUtil.getUserSettings(userId, this.conversationManager!);

        // Then use the correct typing in the map function
        const languageButtons = languagePages[page].map((entry: LanguageEntry) => {
            const [name, code] = entry;
            return Markup.button.callback(
                `${currentSettings.language === code ? '✅ ' : ''}${name}`,
                `ts_lang:${this.bot?.botInfo?.id}:${code}`
            );
        });

        // Add navigation buttons
        const navButtons = [];
        if (page > 1) {
            navButtons.push(Markup.button.callback('⬅️ Previous', `ts_more_langs:${this.bot?.botInfo?.id}:${page - 1}`));
        }
        if (page < totalPages) {
            navButtons.push(Markup.button.callback('Next ➡️', `ts_more_langs:${this.bot?.botInfo?.id}:${page + 1}`));
        }

        const backButton = [Markup.button.callback('Back to Main Settings', `ts_back_main:${this.bot?.botInfo?.id}`)];

        // Create keyboard
        const keyboard = Markup.inlineKeyboard([
            languageButtons,
            navButtons,
            backButton
        ]);

        // Update message with language selection
        await adapter.editMessageText(
            `⚙️ *Transcription Settings - Languages*\n\n` +
            `Select a language for transcription (Page ${page}/${totalPages}):\n\n` +
            `Current language: ${currentSettings.language === 'auto' ? 'Auto-detect' : currentSettings.language}`,
            {
                parse_mode: 'Markdown',
                reply_markup: keyboard.reply_markup
            }
        );
    } // End of showLanguagePage

    // Add the handleProcessFileAction method INSIDE the class
    public async handleProcessFileAction(adapter: ContextAdapter, data: string): Promise<void> {
        const methodName = 'handleProcessFileAction';
        console.log(`[${methodName}] Received action data: ${data}`);

        const parts = data.split(':');
        // Expecting "processfile:{index}" or "processfile:cancel"
        if (parts.length < 2 || parts[0] !== 'processfile') {
            console.warn(`[${methodName}] Invalid callback data format: ${data}`);
            await adapter.safeAnswerCallbackQuery('Invalid action data.');
            return;
        }

        const identifier = parts[1]; // This is the index or 'cancel'
        const subAction = parts[2] || 'transcribe'; // Default to transcribe (though not used with index)

        // Handle cancel action
        if (identifier === 'cancel') {
            try {
                await adapter.editMessageText('File processing cancelled.');
                // Optionally delete the message after a delay
                setTimeout(() => adapter.deleteMessage().catch(e => console.warn("Failed to delete cancel message:", e)), 5000);
            } catch (e) { console.error("Error cancelling:", e); }
            await adapter.safeAnswerCallbackQuery('Cancelled.');
            return;
        }

        // --- Retrieve filename from cache using index ---
        const fileIndex = parseInt(identifier, 10);
        if (isNaN(fileIndex)) {
            console.error(`[${methodName}] Invalid file index received: ${identifier}`);
            await adapter.safeAnswerCallbackQuery('Invalid file selection.');
            return;
        }

        const context = adapter.getMessageContext();
        const { userId } = await this.conversationManager!.getSessionInfo(adapter);
        // Get the message ID of the *original message containing the buttons*
        const messageId = context.raw?.callbackQuery?.message?.message_id;

        if (!messageId) {
            console.error(`[${methodName}] Could not get message ID from callback query context.`);
            await adapter.safeAnswerCallbackQuery('Error identifying the original message.');
            return;
        }

        const filesCacheKey = `processfolder_files:${userId}:${messageId}`;
        const cachedFiles = this.conversationManager!.cache.get<string[]>(filesCacheKey);

        if (!cachedFiles || fileIndex < 0 || fileIndex >= cachedFiles.length) {
            console.error(`[${methodName}] File list not found in cache or index out of bounds. Key: ${filesCacheKey}, Index: ${fileIndex}`);
            await adapter.safeAnswerCallbackQuery('File selection expired or invalid. Please run /processfolder again.');
            // Attempt to clean up the potentially broken menu
            try { await adapter.deleteMessage(messageId); } catch (e) { /* ignore */ }
            return;
        }

        const fileName = cachedFiles[fileIndex];
        console.log(`[${methodName}] Retrieved filename from cache: ${fileName} at index ${fileIndex}`);
        // --- End filename retrieval ---

        console.log(`[${methodName}] Action: ${subAction}, Filename: ${fileName}`);

        // User ID and message ID already retrieved above for cache lookup

        if (!messageId) {
            console.error(`[${methodName}] Could not get message ID from context.`);
            await adapter.safeAnswerCallbackQuery('Error identifying message.');
            return;
        }

        // Retrieve cached command arguments
        const argsCacheKey = `processfolder_args:${userId}:${messageId}`;
        const cachedArgs = this.conversationManager!.cache.get<Partial<TranscriptionOptions>>(argsCacheKey) || {};
        console.log(`[${methodName}] Retrieved cached args for message ${messageId}:`, cachedArgs);

        // Get user's saved settings
        const userSettings = TranscriptionSettingsUtil.getUserSettings(userId, this.conversationManager!);

        // Merge settings: cached command args override user settings
        const finalOptions: TranscriptionOptions = {
            provider: cachedArgs.provider || userSettings.provider,
            modelSize: cachedArgs.modelSize || userSettings.modelSize,
            language: cachedArgs.language || userSettings.language,
            // outputDirectory is handled internally by processSingleFileAndMove
        };

        // Get transcription service
        const transcriptionService = this.telegramBot?.getTranscriptionService();
        if (!transcriptionService) {
            await adapter.editMessageText('❌ Transcription service is unavailable.');
            await adapter.safeAnswerCallbackQuery('Service unavailable.');
            return;
        }

        // Construct full file path using the path from the service
        const inputFolderPath = transcriptionService.inputFolderPath;
        const fullFilePath = path.join(inputFolderPath, fileName);

        console.log(`[${methodName}] Full file path: ${fullFilePath}`);
        console.log(`[${methodName}] Using final options:`, finalOptions);

        // Edit the original message to show processing status
        let statusMessage = `⏳ Processing \`${fileName}\`...`;
        try {
            // Ensure messageId is passed correctly
             const editOptions: ExtraEditMessageText = { parse_mode: 'Markdown' };
             const finalEditOptions = { // Remove explicit type ExtraEditMessageText
                 ...editOptions,
                 message_id: typeof messageId === 'number' ? messageId : undefined
             } as any; // Cast the object literal itself to any
             await adapter.editMessageText(statusMessage, finalEditOptions); // No need to cast here anymore

    } catch (e: unknown) { // Add type annotation
        console.warn(`[${methodName}] Error editing message initially:`, e instanceof Error ? e.message : String(e));
        // If editing fails, try sending a new status message
        await adapter.reply(statusMessage);
        }
        await adapter.safeAnswerCallbackQuery('Processing...'); // Acknowledge the button press

        // Define status callback for the service
        const statusCallback = async (rawStatus: string) => {
            // Declare sanitizedStatus outside the try block
            let sanitizedStatus = '';
            try {
                // Sanitize the status before appending
                sanitizedStatus = escapeTelegramHTML(rawStatus);
                // Append new status, keeping previous lines if possible
                // Use HTML for status messages now
                statusMessage += `\n${sanitizedStatus}`;
                 // Truncate if too long for Telegram
                if (statusMessage.length > 4000) {
                    statusMessage = "..." + statusMessage.substring(statusMessage.length - 3997);
                }
                 // Ensure messageId is passed correctly and use HTML parse mode
                 const editOptions: ExtraEditMessageText = { parse_mode: 'HTML' };
                 const finalEditOptions = { // Remove explicit type ExtraEditMessageText
                     ...editOptions,
                     message_id: typeof messageId === 'number' ? messageId : undefined
                 } as any; // Cast the object literal itself to any
                 await adapter.editMessageText(statusMessage, finalEditOptions); // No need to cast here anymore
            } catch (error: unknown) { // Add type annotation
                console.warn(`[${methodName}] Error updating status via editMessageText: ${error instanceof Error ? error.message : String(error)}`);
                 // Fallback: send new message if edit fails (also sanitize)
                 try {
                    await adapter.reply(sanitizedStatus); // Send sanitized status
                 } catch (replyError: unknown) { // Add type annotation
                    console.error(`[${methodName}] Failed to send status update as new message: ${replyError instanceof Error ? replyError.message : String(replyError)}`);
                 }
            }
        };

        // Execute transcription
        try {
            const transcriptionResult = await transcriptionService.processSingleFileAndMove(
                fullFilePath,
                finalOptions,
                statusCallback
            );

            // --- Start: Caching logic for pattern processing ---
            const patternDataKey = `pattern_data:${userId}`;
            let patternData = this.conversationManager!.cache.get<PatternData>(patternDataKey) || {
                originalInput: '',
                processedOutputs: {},
                currentPatternState: {}
            };

            // Store the result as originalInput for pattern processing
            patternData.originalInput = transcriptionResult;

            // Also store it as a processed output
            patternData.processedOutputs["raw_processed_file_transcript"] = {
                output: transcriptionResult,
                timestamp: Date.now()
            };

            // Add file metadata to the pattern data
            patternData.sourceInfo = {
                type: 'processed_file',
                url: `file://${fileName}`, // Represent as a file URI
                title: `Processed File: ${fileName}`,
                metadata: {
                    fileName: fileName,
                    processedTime: new Date().toISOString()
                }
            };

            this.conversationManager!.cache.set(patternDataKey, patternData, 14400); // 4 hours

            // Define a pattern suggestion for processed transcripts
            const processedFilePatternSuggestion = {
                pattern: 'summarize_transcript', // Example pattern
                confidence: 0.9,
                alternativePatterns: [
                    'extract_insights',
                    'summarize',
                    'create_qa_pairs'
                ]
            };

            // For storing in context cache for pattern suggestions
            const contextData = {
                input: transcriptionResult,
                interactionType: 'general_input' as InteractionType,
                contextRequirement: 'chat' as ContextRequirement,
                timestamp: Date.now(),
                metadata: {
                    source: 'processed_file',
                    fileName: fileName,
                    suggestion: processedFilePatternSuggestion
                }
            };
            this.conversationManager!.cache.set(`pattern_context:${userId}`, contextData, 14400); // 4 hours
            // --- End: Caching logic ---
            // Try sending the transcript as a file and show pattern menu
            try {
                // Send a preview message
                const preview = transcriptionResult.substring(0, 500) + "...";
                await adapter.reply(`✅ Successfully transcribed \`${fileName}\`.\n\nPreview:\n${preview}\n\nSending full transcript as a file...`, { parse_mode: 'Markdown' });

                // Create a descriptive filename
                const baseFileName = fileName.substring(0, fileName.lastIndexOf('.')) || fileName;
                const transcriptFilename = `processed_transcript_${baseFileName}_${new Date().toISOString().slice(0, 10)}`;

                // Ensure FileManager is initialized
                if (!this.fileManager) {
                    this.fileManager = new FileManager(this.telegramBot?.getBotToken());
                }
                await this.fileManager.saveAndSendAsText(adapter, transcriptionResult, transcriptFilename);

                // Show the pattern suggestion menu
                if (this.menuManager) {
                    const keyboard = this.menuManager.createPatternSelectionMenu(
                        processedFilePatternSuggestion,
                        processedFilePatternSuggestion.alternativePatterns
                    ).reply_markup;

                    await adapter.reply(
                        `📝 How would you like to process this transcript?`,
                        {
                            parse_mode: 'HTML',
                            reply_markup: keyboard
                        }
                    );
                }
            } catch (fileError) {
                console.error(`[${methodName}] Error sending transcript as file for ${fileName}:`, fileError);

                // If file sending fails, fall back to a message about processing the content
                await adapter.reply(
                    `⚠️ Successfully transcribed \`${fileName}\`, but unable to send the full transcript as a file. ` +
                    "You can still process the transcript using the pattern menu below.",
                    { parse_mode: 'Markdown' }
                );

                // Still show the pattern menu
                if (this.menuManager) {
                    const keyboard = this.menuManager.createPatternSelectionMenu(
                        processedFilePatternSuggestion,
                        processedFilePatternSuggestion.alternativePatterns
                    ).reply_markup;

                    await adapter.reply(
                        `📝 How would you like to process this transcript?`,
                        {
                            parse_mode: 'HTML',
                            reply_markup: keyboard
                        }
                    );
                }
            } finally {
                 // Clean up cached args AND files for this message regardless of file sending success/failure
                 this.conversationManager!.cache.del(argsCacheKey);
                 this.conversationManager!.cache.del(filesCacheKey);
                 // Delete the original processing status message
                 if (messageId) {
                    try { await adapter.deleteMessage(messageId); } catch(e) { /* ignore */ }
                 }
            }
        } catch (error) {
            console.error(`[${methodName}] Error during transcription process for ${fileName}:`, error);
            const finalErrorMessage = `❌ Error processing \`${fileName}\`: ${error.message}`;
            try {
                 // Ensure messageId is passed correctly
                 const editOptions: ExtraEditMessageText = { parse_mode: 'Markdown' };
                 const finalEditOptions = { // Remove explicit type ExtraEditMessageText
                     ...editOptions,
                     message_id: typeof messageId === 'number' ? messageId : undefined
                 } as any; // Cast the object literal itself to any
                 await adapter.editMessageText(finalErrorMessage, finalEditOptions); // No need to cast here anymore
            } catch (e: unknown) { // Add type annotation
                await adapter.reply(finalErrorMessage); // Fallback reply
            }
            // Clean up cached args AND files even on error
            this.conversationManager!.cache.del(argsCacheKey);
            this.conversationManager!.cache.del(filesCacheKey);
        }
    }


    
    

}