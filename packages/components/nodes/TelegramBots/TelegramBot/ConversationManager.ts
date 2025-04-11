import axios from 'axios';
import { ChatPromptTemplate, SystemMessagePromptTemplate, HumanMessagePromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
import { BaseRetriever } from '@langchain/core/retrievers';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { BaseMessage, AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages'
import { Context, Telegraf, Markup } from 'telegraf';
//import { Tool } from 'langchain/tools';
import { AgentExecutor, createStructuredChatAgent } from 'langchain/agents';
import { QuestionAnalyzer, QuestionAnalysisResult } from './QuestionAnalyzer';
import {
    logDebug,
    logInfo,
    logWarn,
    logError,
    logMessageProcessingStart,
    logChatHistory
} from './loggingUtility';
import * as commandModules from './commands';
import { IExtendedMemory, ExtendedIMessage, InteractionType, Command, ContextRequirement, EnhancedResponse, SourceCitation, ScoredDocument, MessageContext, DocumentMetadata, IStorage, SessionData, SessionInfo, createInitialGameState, ZepFact, ZepMessage, ZepSummary, ZepMemoryResponse } from './commands/types'
import NodeCache from 'node-cache';
import { Tool } from '@langchain/core/tools';
import PromptManager from './PromptManager';
import { AgentManager } from './AgentManager';
import { TelegramBot_Agents } from './TelegramBot_Agents';
//import { BaseAgent, RAGAgent, ToolAgent, ConversationAgent } from './agents';
import { RAGAgent } from './agents';
import { MessageContent, MessageContentComplex } from '@langchain/core/messages';
import { InputFile } from 'telegraf/typings/core/types/typegram';
import { ContextAdapter, } from './ContextAdapter';
import { MenuManager, } from './MenuManager';
import { CacheKeys } from './utils/cache';
import { cleanModelResponse, CleanedResponse, hasThinkTags, messageContentToString } from './utils/utils';
import { invokeModelWithFallback } from './utils/modelUtility';
import { CustomRetriever } from './CustomRetriever';
import { ThinkingManager } from './ThinkingManager';
import { PatternPromptAgent } from './agents/PatternPromptAgent';
import { ThinkingDisplayMode, ThinkingPreferences, ThinkingBlock } from './utils/types/ThinkingTypes';
import { CommandHandler } from './CommandHandler';

import { GameAgent } from './agents/GameAgent';
import { DatabaseService } from './services/DatabaseService';
//import { FlowiseStorage } from './FlowiseStorage';
import {
    AUTH_TYPES,
    SUBSCRIPTION_TIERS,
    type AuthType,
    type SubscriptionTier,
    type CreateUserDTO,
    type UserData
} from './services/DatabaseService';
import {
    Question,
    QuestionData,
    GameState,
    GameButtons,
    GameType,
    GameConfig,
    MillionaireState,
    GameSession,
    LifelineType,
    QuestionDifficulty,
    PhoneAFriendResult,
    FiftyFiftyResult,
    AskTheAudienceResult,
    GameResponse,
    LifelineResult,
    PatternContextData,
    PatternData  // Add this import
} from './commands/types';

interface ConversationManagerParams {
    retriever: BaseRetriever;
    userDataRetriever: BaseRetriever;
    chatModel: BaseChatModel;
    SpModel: BaseChatModel;
    summationModel: BaseChatModel;
    utilityModel: BaseChatModel;
    tools: Tool[];
    welcomeMessage: string;
    maxMessageLength: number;
    dynamicContextBaseLength: number;
    minComplexityFactor: number;
    maxChatHistoryTokens: number;
    topRelevantDocs: number;
    relevanceScoreThreshold: number;
    contextWindowSize: number;
    adminIds: number[];
    enablePersona: boolean;
    toolAgentSystemPrompt?: string;
    promptManager: PromptManager;
    agentManager: AgentManager,
    menuManager: MenuManager;
    flowId: string,
    flowIdMap: Map<string, string>;
    databaseService?: DatabaseService; // Add this line

}

type AnyDocument = {
    pageContent?: string;
    content?: string;
    [key: string]: any;
};
type MessageType = 'userMessage' | 'apiMessage';

interface IMessage {
    message?: string;
    text?: string;
    type: MessageType;
}

export class ConversationManager {
    private bot: Telegraf<Context>;
    private retriever: BaseRetriever;
    public chatModel: BaseChatModel;
    public SpModel: BaseChatModel;
    public summationModel: BaseChatModel;
    public utilityModel: BaseChatModel;
    private tools: Tool[];
    private dynamicContextBaseLength: number;
    private minComplexityFactor: number;
    private maxChatHistoryTokens: number;
    private topRelevantDocs: number;
    private relevanceScoreThreshold: number;
    private contextWindowSize: number;
    private agentExecutor: AgentExecutor | null = null;
    private enablePersona: boolean; // Add this line
    private ragQuestionCount: number;
    private vectorStoreOverview: string = '';
    private lastOverviewUpdate: number = 0;
    private welcomeMessage: string;
    private adminIds: number[];
    private memory: IExtendedMemory;
    private readonly OVERVIEW_UPDATE_INTERVAL = 3600000; // 1 hour in milliseconds
    private commands: Command[];
    private searchResultsCache: NodeCache;
    private promptManager: PromptManager;
    private questionAnalyzer: QuestionAnalyzer;
    public menuManager: MenuManager | null;
    private agentManager: AgentManager;
    private ragAgent: RAGAgent;
    private conversationTypeHistory: Map<string, string[]> = new Map();
    private readonly RAG_PROMPT_THRESHOLD = 3;
    private groupMembers: Map<number, Map<number, { is_bot: boolean, is_admin: boolean, username?: string, first_name?: string }>> = new Map();
    public cache: NodeCache;
    public flowId: string;
    private readonly flowIdMap: Map<string, string>;
    public databaseService: DatabaseService | null = null; // Add this line
    private telegramBot: TelegramBot_Agents | null = null;
    private thinkingManager: ThinkingManager;
    private topicExtractionLock = new Map<string, Promise<any>>();
    private contextSummaryLock = new Map<string, Promise<any>>();
    private commandHandler: CommandHandler;
    public setCommandHandler(commandHandler: CommandHandler): void {
        this.commandHandler = commandHandler;
    }







    constructor(params: ConversationManagerParams) {
        this.retriever = params.retriever;
        this.chatModel = params.chatModel;
        this.SpModel = params.SpModel;
        this.summationModel = params.summationModel;
        this.utilityModel = params.utilityModel;
        this.tools = params.tools || [];
        this.dynamicContextBaseLength = params.dynamicContextBaseLength;
        this.minComplexityFactor = params.minComplexityFactor;
        this.maxChatHistoryTokens = params.maxChatHistoryTokens;
        this.topRelevantDocs = params.topRelevantDocs;
        this.relevanceScoreThreshold = params.relevanceScoreThreshold;
        this.contextWindowSize = params.contextWindowSize;
        this.enablePersona = params.enablePersona;
        this.ragQuestionCount = 0;
        this.welcomeMessage = params.welcomeMessage;
        this.adminIds = params.adminIds;
        this.promptManager = params.promptManager;
        this.cache = new NodeCache({ stdTTL: 900, checkperiod: 300 }); // Cache for 15 minutes        
        this.flowId = params.flowId;
        this.flowIdMap = params.flowIdMap;
        this.thinkingManager = new ThinkingManager(this.flowId);
        this.questionAnalyzer = new QuestionAnalyzer(
            this.utilityModel,
            this.summationModel,
            this.chatModel,
            this.SpModel,
            this.flowId,
            this,  // Passing 'this' as conversationManager
        );
        this.agentManager = params.agentManager;
        if (!this.agentManager) {
            throw new Error('AgentManager is required for ConversationManager');
        }
        this.promptManager = params.promptManager;
        if (!this.promptManager) {
            throw new Error('PromptManager must be provided to ConversationManager');
        }
        this.menuManager = params.menuManager;
        if (!this.menuManager) {
            console.warn('MenuManager is not provided to ConversationManager. Pattern menu functionality will be limited.');
        }
        // Validate PromptManager has required prompts
        this.validatePromptManager();

        if (this.agentManager) {
            if (!this.telegramBot) {
                console.warn('TelegramBot not initialized when creating GameAgent');
                return;
            }
            const toolManager = this.telegramBot.getToolManager();
            if (!toolManager) {
                console.warn('ToolManager not available when creating GameAgent');
                return;
            }
            const gameAgent = new GameAgent(
                this.flowId,
                this,
                toolManager,
                this.promptManager
            );
            this.agentManager.registerAgent('game', gameAgent);

            const patternAgent = new PatternPromptAgent(
                this.flowId,
                this,
                toolManager,
                this.promptManager
            );
            this.agentManager.registerAgent('pattern', patternAgent);

        }

        this.ragAgent = this.agentManager.getAgent('rag') as RAGAgent;
        if (!this.ragAgent) {
            console.warn('RAGAgent is not available in AgentManager. RAG functionality will be limited.');
        }
        // Initialize DatabaseService if provided
        if (params.databaseService) {
            this.databaseService = params.databaseService;
        } else {
            // Create new DatabaseService instance
            this.databaseService = new DatabaseService(this.flowId);
        }
        this.commands = Object.values(commandModules) as Command[];
        this.searchResultsCache = new NodeCache({ stdTTL: 1800 });

        // Log the initialization
        console.log('[ConversationManager] Initialized commands:', {
            commandCount: this.commands.length,
            commandList: this.commands.map(c => c.name)
        });

        if (!Array.isArray(this.commands)) {
            console.warn('Commands are not properly loaded. Initializing with an empty array.');
            this.commands = [];
        }

        this.commands = this.commands.filter(cmd => {
            const isValid = cmd &&
                typeof cmd.name === 'string' &&
                typeof cmd.description === 'string' &&
                typeof cmd.execute === 'function';

            if (!isValid) {
                console.warn(`Invalid command structure found:`, cmd);
            }
            return isValid;
        });

        if (!this.promptManager) {
            throw new Error('PromptManager must be provided to ConversationManager');
        }

        console.log('ConversationManager constructor called, promptManager:', !!this.promptManager);
        this.initializeAgentExecutor();



    }

    async addToMemory(adapter: ContextAdapter, messages: IMessage[]): Promise<void> {
        const context = adapter.getMessageContext();
        const { userId, sessionId } = await this.getSessionInfo(context);
        const combinedId = `${userId}:${sessionId}`;

        if (this.memory) {
            const formattedMessages = messages.map((msg: IMessage) => {
                let text: string;
                let type: MessageType;

                if ('text' in msg && typeof msg.text === 'string') {
                    text = msg.text;
                    type = msg.type as MessageType;
                } else if ('message' in msg && typeof msg.message === 'string') {
                    text = msg.message;
                    type = msg.type as MessageType;
                } else {
                    // Fallback for unexpected message format
                    text = 'Unexpected message format';
                    type = 'apiMessage' as MessageType;
                    console.warn('Unexpected message format:', msg);
                }

                return { text, type };
            });

            try {
                // Pass sessionId and userId separately as overrides
                // Call the standard addChatMessages with overrides
                // Call the standard addChatMessages with overrides
                await this.memory.addChatMessages(formattedMessages, sessionId, userId);
                console.log(`Messages added to memory for user ${userId} in session ${sessionId}`);
            } catch (error) {
                console.error(`Error adding messages to memory for user ${userId} in session ${sessionId}:`, error);
            }
        } else {
            console.warn('Memory is not initialized. Unable to add to memory.');
        }
    }
    public setCommands(commands: Command[]): void {
        this.commands = commands;
        console.log(`[ConversationManager] Commands set: ${commands.length} commands registered`);
    }
    public getThinkingManager(): ThinkingManager | null {
        return this.thinkingManager;
    }
    public setGroupMembers(chatId: number, members: Map<number, { is_bot: boolean, is_admin: boolean, username?: string, first_name?: string }>) {
        this.groupMembers.set(chatId, members);
        console.log(`Set group members for chat ${chatId}. Total members: ${members.size}`);
    }

    public getGroupMembers(chatId: number): Map<number, { is_bot: boolean, is_admin: boolean, username?: string, first_name?: string }> | undefined {
        const members = this.groupMembers.get(chatId);
        if (members) {
            console.log(`Retrieved group members for chat ${chatId}. Total members: ${members.size}`);
            members.forEach((info, id) => {
                console.log(`User ID ${id}:`, JSON.stringify(info));
            });
        } else {
            console.log(`No group members found for chat ${chatId}`);
        }
        return members;
    }
    public getGroupMemberByName(chatId: number, name: string): { username?: string; first_name?: string; is_bot: boolean; is_admin: boolean; } | undefined {
        const members = this.groupMembers.get(chatId);
        if (!members) return undefined;
        return Array.from(members.values()).find(member => member.first_name === name);
    }
    public getGroupMember(chatId: number, userId: number): { is_bot: boolean, is_admin: boolean, username?: string, first_name?: string } | undefined {
        const member = this.groupMembers.get(chatId)?.get(userId);
        if (member) {
            console.log(`Retrieved group member for chat ${chatId}, user ${userId}:`, JSON.stringify(member));
        } else {
            console.log(`No group member found for chat ${chatId}, user ${userId}`);
        }
        return member;
    }
    /*
        public updateGroupMembers(chatId: number, memberInfo: Map<number, { is_bot: boolean, is_admin: boolean, username?: string, first_name?: string }>) {
            this.groupMembers.set(chatId, memberInfo);
            console.log(`Updated group members for chat ${chatId}. Total members: ${memberInfo.size}`);
        }
    */
    public setRAGAgent(ragAgent: RAGAgent) {
        this.ragAgent = ragAgent;
    }
    public isRAGModeEnabled(userId: string): boolean {
        return this.ragAgent ? this.ragAgent.isRAGModeEnabled(userId) : false;
    }
    public getAgentManager(): AgentManager | null {
        return this.agentManager;
    }
    public getToolByName(name: string): Tool | undefined {
        return this.tools.find(tool => tool.name === name);
    }



    async getSessionInfo(input: ContextAdapter | MessageContext): Promise<SessionInfo> {
        const methodName = 'getSessionInfo';
        const context = input instanceof ContextAdapter ? input.getMessageContext() : input;


        // Get the botKey (chatflowId) from flowIdMap using proper typing
        const flowIdEntry = Array.from(this.flowIdMap.entries())
            .find(([_, fId]) => fId === this.flowId);
        const botKey = flowIdEntry ? flowIdEntry[0] : undefined;

        console.log(`[${methodName}] ID Resolution:`, {
            flowId: this.flowId,
            botKey,
            raw: context.raw,
        });

        // Use botKey as chatflowId since it's the actual chatflowId
        const chatflowId = botKey || this.flowId; // fallback to flowId if botKey not found

        const now = new Date().toISOString();
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

        // Determine if this is a Telegram-authenticated request (including webapp)
        const isTelegramAuth = (
            context.userId.toString().startsWith('telegram_') ||
            context.raw?.auth?.type === AUTH_TYPES.TELEGRAM ||
            context.source === 'webapp'  // Webapp uses Telegram auth
        );

        // Helper function to get chat type from context
        const getChatType = (): 'private' | 'group' => {
            // Check both possible locations for chat type
            const chatType = context.raw?.message?.chat?.type || context.raw?.chat?.type;

            switch (chatType) {
                case 'private':
                    return 'private';
                case 'group':
                case 'supergroup':
                case 'channel':
                    return 'group';
                default:
                    return 'private';  // Default to private if no type found
            }
        };

        // Helper function to parse webapp chatId
        const parseWebappChatId = (chatId: string): { userId: string; sessionId: string } | null => {
            const parts = chatId.split('|');
            if (parts[0] === 'webapp' && parts.length >= 4) {
                return {
                    userId: parts[1],
                    sessionId: parts[3]
                };
            }
            return null;
        };

        // Ensure we have string values for IDs
        const contextUserId = context.userId?.toString() || '';
        const contextChatId = context.chatId?.toString() || '';

        // Get base sessionId and userId based on source
        let sessionId: string;
        let userId: string;
        let metadata: Record<string, any> = {};

        switch (context.source) {
            case AUTH_TYPES.TELEGRAM:
                // Add last 6 charcters of chatflowId to sessionId
                const sessionSuffix = this.getLastSixDigits(chatflowId);
                // For direct Telegram requests
                userId = `telegram_${contextUserId}`;
                sessionId = getChatType() === 'private' ?
                    `telegram-private-tg_${contextUserId}_cf-${sessionSuffix}` :
                    `user-${contextUserId}:telegram-group-${contextChatId}_cf-${sessionSuffix}`;
                metadata.auth_type = AUTH_TYPES.TELEGRAM;
                break;

            case 'webapp':
                // For webapp (which uses Telegram auth)
                const webappData = parseWebappChatId(contextChatId);
                // Add last 6 charcters of chatflowId to sessionId
                const webappSessionSuffix = this.getLastSixDigits(chatflowId);
                if (webappData) {
                    userId = webappData.userId;
                    // if we want the web session to be the same as our private telegram session: 
                    sessionId = `telegram-private-${contextUserId}_cf-${webappSessionSuffix}`;
                } else {
                    userId = contextUserId;
                    sessionId = `${contextChatId}_cf-${webappSessionSuffix}`;
                }
                metadata = {
                    auth_type: AUTH_TYPES.TELEGRAM,
                    source: 'webapp',
                    isWebapp: true
                };
                break;

            case 'flowise':
                userId = `flowise_${chatflowId}`;
                sessionId = `flowise_${chatflowId}`;
                metadata = {
                    ...metadata,
                    chatflowId,
                    source: 'flowise'
                };
                break;

            default:
                userId = contextUserId;
                sessionId = `session_${contextChatId}`;
        }

        // Build session info with all required properties
        const sessionInfo: SessionInfo = {
            id: sessionId,                     // Required: session ID
            userId: userId,                    // Required: in camelCase as per interface
            sessionId: sessionId,              // Required: sessionId is also needed
            type: getChatType(),              // Required: 'private' | 'group'
            source: context.source,            // Required: 'telegram' | 'flowise' | 'webapp'
            chat_id: contextChatId,           // Optional: in snake_case
            flowwiseChatflowId: chatflowId,   // Optional: in camelCase
            status: 'active',                 // Required: session status
            created_at: now,                  // Required: in snake_case
            last_active: now,                 // Required: in snake_case
            expires_at: expiresAt,            // Required: in snake_case
            auth: {                           // Required: auth object
                type: isTelegramAuth ? AUTH_TYPES.TELEGRAM : context.source,
                id: userId,
                username: isTelegramAuth ?
                    (context.raw?.firstName?.toString() || context.raw?.username?.toString() || 'unknown') :
                    `${context.source}_user`
            },
            metadata: {                       // Optional: metadata
                ...metadata,
                original_request: context.raw,
                isTelegramAuth,
                initialized_at: now
            }
        };


        // Add auth information if available
        if (isTelegramAuth) {
            sessionInfo.auth = {
                type: AUTH_TYPES.TELEGRAM,
                id: userId,
                username: context.raw?.firstName?.toString() || context.raw?.username?.toString()
            };
        }

        logInfo(methodName, 'Created session info:', {
            source: sessionInfo.source,
            userId: sessionInfo.userId,
            sessionId: sessionInfo.id,
            chatId: sessionInfo.chat_id,
            status: sessionInfo.status,
            isTelegramAuth,
            isWebapp: context.source === 'webapp',
            hasAuth: !!sessionInfo.auth
        });

        return sessionInfo;
    }
    private getLastSixDigits(chatflowId: string | undefined): string {
        if (!chatflowId) return '';
        // Extract just the alphanumeric characters from the end
        const match = chatflowId.match(/[a-zA-Z0-9]{6}$/);
        return match ? match[0] : '';
    }
    public async cleanup(): Promise<void> {
        console.log(`[FlowID: ${this.flowId}] Starting ConversationManager cleanup...`);

        // Clear any ongoing conversations
        // This is a placeholder - implement according to your conversation tracking mechanism
        // this.activeConversations.clear();

        if (this.databaseService) {
            await this.databaseService.cleanup();
        }
        // Clear the retriever if it has a cleanup method
        if (this.retriever && typeof (this.retriever as any).cleanup === 'function') {
            await (this.retriever as any).cleanup();
        }

        // Clear the chat model if it has a cleanup method
        if (this.chatModel && typeof (this.chatModel as any).cleanup === 'function') {
            await (this.chatModel as any).cleanup();
        }

        // Clear the vector store overview cache
        this.vectorStoreOverview = '';
        this.lastOverviewUpdate = 0;

        // Clear the conversation type history
        this.conversationTypeHistory.clear();

        // Clear group members
        this.groupMembers.clear();

        console.log(`[FlowID: ${this.flowId}] ConversationManager cleanup completed.`);
    }

    async getMemory(adapter: ContextAdapter): Promise<IMessage[]> {
        const context = adapter.getMessageContext();
        const { userId, sessionId } = await this.getSessionInfo(context);
        if (this.memory) {
            try {
                // Call the extended method, passing sessionId first, then userId as override
                // Call extended method: (userId, sessionId, returnBaseMessages?, prependMessages?, overrideUserId?)
                // Call extended method, passing userId as the overrideUserId (5th argument)
                // Call extended method, passing userId as the overrideUserId (5th argument)
                const messages = await this.memory.getChatMessagesExtended(userId, sessionId, false, undefined, userId);
                return messages.map((msg: any) => {
                    if (typeof msg === 'object' && msg !== null) {
                        if ('message' in msg && 'type' in msg) {
                            // It's already in IMessage format
                            return msg as IMessage;
                        } else if ('text' in msg && 'type' in msg) {
                            // It's in the { text: string; type: MessageType } format
                            return {
                                message: msg.text,
                                type: msg.type
                            };
                        } else if ('content' in msg && '_getType' in msg) {
                            // It's a BaseMessage
                            return {
                                message: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
                                type: msg._getType() === 'human' ? 'userMessage' : 'apiMessage'
                            };
                        }
                    }
                    // If none of the above conditions are met, return a default message
                    console.warn('Unexpected message format:', msg);
                    return {
                        message: 'Unexpected message format',
                        type: 'apiMessage'
                    };
                });
            } catch (error) {
                console.error(`Error getting memory for user ${userId} in session ${sessionId}:`, error);
                return [];
            }
        } else {
            console.warn('Memory is not initialized. Unable to get memory.');
            return [];
        }
    }

    async clearMemory(adapter: ContextAdapter): Promise<void> {
        const context = adapter.getMessageContext();
        const { userId, sessionId } = await this.getSessionInfo(context); if (this.memory) {
            try {
                // Call the standard clearChatMessages, only sessionId is needed
                await this.memory.clearChatMessages(sessionId);
                console.log(`Cleared memory for user ${userId} in session ${sessionId}`);
            } catch (error) {
                console.error(`Error clearing memory for user ${userId} in session ${sessionId}:`, error);
            }
        } else {
            console.warn('Memory is not initialized. Unable to clear memory.');
        }
    }

    async clearAllMemory(): Promise<void> {
        if (this.memory) {
            await this.memory.clearAllChatMessages();
        } else {
            console.warn('Memory is not initialized. Unable to clear all memory.');
        }
    }
    

    isAdmin(userId: string | number): boolean {
        const userIdNum = typeof userId === 'string' ? parseInt(userId, 10) : userId;
        return !isNaN(userIdNum) && this.adminIds.includes(userIdNum);
    }

    public getCommands(): Command[] {
        console.log('[ConversationManager] getCommands called', {
            commandsExist: !!this.commands,
            commandCount: this.commands?.length,
            commandList: this.commands?.map(c => c.name)
        });
        if (!this.commands || this.commands.length === 0) {
            console.warn('[ConversationManager] Commands not properly initialized');
            // You might want to re-initialize here or return default commands
            return Object.values(commandModules);
        }
        return this.commands;
    }
    public onBotStop: (() => Promise<void>) | null = null;

    public getWelcomeMessage(username: string): string {
        return this.welcomeMessage.replace('{username}', username);
    }
    public setMemory(memory: IExtendedMemory) {
        this.memory = memory;
    }

    private async initializeAgentExecutor(): Promise<void> {
        if (this.tools.length > 0) {
            try {
                console.log(`Initializing AgentExecutor with ${this.tools.length} tools`);

                const toolNames = this.tools.map(tool => tool.name).join(", ");
                console.log(`Tool names: ${toolNames}`);

                const prompt = ChatPromptTemplate.fromMessages([
                    SystemMessagePromptTemplate.fromTemplate(
                        "You are a helpful AI assistant. Use the following tools to answer the human's questions: {tool_names}"
                    ),
                    new MessagesPlaceholder("chat_history"),
                    HumanMessagePromptTemplate.fromTemplate("{input}"),
                    new MessagesPlaceholder("agent_scratchpad"),
                ]);

                console.log("Creating structured chat agent...");
                const agent = await createStructuredChatAgent({
                    llm: this.chatModel,
                    tools: this.tools,
                    prompt: prompt,
                });
                console.log("Structured chat agent created successfully");

                this.agentExecutor = new AgentExecutor({
                    agent,
                    tools: this.tools,
                    verbose: true,
                });

                console.log("AgentExecutor initialized successfully");
            } catch (error) {
                console.error("Error initializing AgentExecutor:", error);
                if (error instanceof Error) {
                    console.error("Error message:", error.message);
                    console.error("Error stack:", error.stack);
                }
            }
        } else {
            console.log("No tools available. Skipping AgentExecutor initialization.");
        }
    }
    /**
     * Generates a response based on the user's input, chat history, and other contextual information.
     *
     * @param userInput - The user's input or query.
     * @param chatHistory - The chat history as an array of `BaseMessage` objects.
     * @param isReply - Indicates whether the user's input is a reply to a previous message.
     * @param userId - The unique identifier for the user.
     * @param replyToMessage - An optional object containing the message ID and text of the message being replied to.
     * @param adapter - An optional `ContextAdapter` instance to customize the context retrieval process.
     * @param progressKey - An optional key to track the progress of the operation.
     * @returns An array of response strings, which may be split into multiple chunks.
     */
    public async generateResponse(
        userInput: string,
        chatHistory: BaseMessage[],
        isReply: boolean = false,
        userId: string,
        adapter: ContextAdapter,
        replyToMessage?: { message_id: number; text: string },
        progressKey?: string,
        thinkingPreferences?: Partial<ThinkingPreferences>,
        disablePatternSuggestion: boolean = false
    ): Promise<string[]> {
        console.log('generateResponse called, promptManager exists:', !!this.promptManager);
        const methodName = 'generateResponse';
        console.log(`[${methodName}] Starting response generation for input: "${userInput}", isReply: ${isReply}`);

        // Determine interaction type and standalone question early
        // Declarations moved inside the try block below
        console.log(`[${methodName}] replyToMessage:`, replyToMessage);
try {
    // Determine interaction type and standalone question early inside the try block
    const interactionType = await this.determineInteractionType(userInput, userId);
    let standaloneQuestion = userInput; // Initialize with userInput, use let
    console.log(`[${methodName}] Initial interaction type: ${interactionType}`);

    if (!this.promptManager) {
        throw new Error('PromptManager is not initialized');
    }

            const gameAgent = this.agentManager.getAgent('game') as GameAgent;
            const gameState = gameAgent?.getGameState?.(userId);

            const gameKeywords = ['play a game', 'play game', 'millionaire', 'start game', 'start a game', 'start new game', 'join game'];
            const isGameInput = gameKeywords.some(keyword =>
                userInput.toLowerCase().includes(keyword)
            );

            // If it's a game input, direct them to use the /millionaire command
            if (isGameInput && !gameState?.isActive) {
                console.log(`[${methodName}] Detected game-related query`);
                this.disableRAGMode(userId);
                await adapter.replyWithAutoDelete("Would you like to play Who Wants to be a Millionaire? click on the command below to start a new game! 🎮", 60000);
                await adapter.replyWithAutoDelete("/millionaire", 60000);

                return [
                    "🎲"
                ];
            }

            //Early Game Detection and status
            const StopGameKeywords = ['end game', 'stop game', 'finish game', 'quit game'];
            const isStopGameInput = StopGameKeywords.some(keyword =>
                userInput.toLowerCase().includes(keyword)
            );

            if (isStopGameInput && gameState?.isActive) {
                console.log(`[${methodName}] ,User wishes to end the game`);
                // End Game
                logInfo(methodName, `Ending game for user ${userId}`);
                const newGameState = createInitialGameState(userId);
                newGameState.isActive = false;
                newGameState.status = 'game_over';
                // Store the new game state
                gameAgent.gameStates.set(userId, newGameState);

                logInfo(methodName, `Game state for user ${userId}`, {
                    level: newGameState.currentLevel,
                    status: newGameState.status,
                    isActive: newGameState.isActive
                });
                return [
                    "🎉"
                ];
            }
            console.log(`[${methodName}] About to determine interaction type`);
            // Remove redundant declaration, use the one from line 762
            console.log(`[${methodName}] Determined interaction type: ${interactionType}`);



            const shouldPrompt = await this.shouldPromptRagMode(userId);
            if (shouldPrompt && !gameState?.isActive) {
                return this.promptRagModeContinuation(userId);
            }

            // Pass the determined interactionType to detectContextRequirement
            console.log(`[${methodName}] About to detect context requirement`);
            const contextRequirement = await this.detectContextRequirement(userInput, interactionType, userId);
            console.log(`[${methodName}] Interaction type: ${interactionType}, Context requirement: ${contextRequirement}, Is RAG query: ${contextRequirement === 'rag'}`);
            console.log(`[${methodName}] Detected context requirement: ${contextRequirement}`);
            // Check if we should suggest a pattern
            // Check if we should suggest a pattern
            if (!disablePatternSuggestion && adapter.isTelegramMessage() && await this.shouldSuggestPattern(userInput, interactionType, adapter.getMessageContext())) {
                console.log(`[${methodName}] isTelegramMessage about to determine shouldSuggestPattern`);
                try {
                    const context = adapter.getMessageContext();
                    const hasFile = context.raw?.message ? (
                        'document' in context.raw.message ||
                        'photo' in context.raw.message
                    ) : false;

                    // Get pattern suggestion from agent
                    const patternAgent = this.agentManager.getAgent('pattern') as PatternPromptAgent;
                    if (!patternAgent) {
                        throw new Error('Pattern agent not available');
                    }

                    const suggestion = await patternAgent.suggestPattern(userInput, "", interactionType);
                    if (!suggestion) {
                        throw new Error('No pattern suggestion available');
                    }

                    // Convert messageId to number if it's a string
                    const originalMessageId = typeof context.messageId === 'string'
                        ? parseInt(context.messageId, 10)
                        : context.messageId;

                    const contextData: PatternContextData = {
                        input: userInput,
                        interactionType,
                        contextRequirement,
                        timestamp: Date.now(),
                        chatHistory: chatHistory.slice(-5),
                        originalMessageId: originalMessageId, // Now this will be a number or undefined
                        currentPatternState: '', // Add this required property with an empty string as default
                        processed: false,
                        processedContent: undefined,
                        metadata: {
                            isReply,
                            replyToMessage,
                            userId,
                            messageId: context.messageId, // This can remain as string | number in metadata
                            hasFile,
                            fileType: this.getFileTypeFromContext(context),
                            suggestion: suggestion
                        }
                    };

                    // delete old cache
                    const cachedData = this.cache.get(`pattern_context:${userId}`);
                    if (cachedData) {
                        this.cache.del(`pattern_context:${userId}`);
                    }

                    console.warn(`[generateResponse] Creating pattern context for user ${userId}:`, {
                        inputLength: contextData.input.length,
                        timestamp: new Date(contextData.timestamp).toISOString(),
                        interactionType: contextData.interactionType,
                        originalMessageId: contextData.originalMessageId
                    });

                    // Right after setting the cache
                    this.cache.set(
                        `pattern_context:${userId}`,
                        contextData,
                        1800
                    );

                    // Add the storePatternInput call here
                    this.storePatternInput(userId, userInput);

                    // To:
                    if (this.commandHandler && typeof this.commandHandler.storePatternInput === 'function') {
                        this.commandHandler.storePatternInput(userId, userInput);
                    } else {
                        // Fallback: directly store the input if CommandHandler isn't available
                        const cacheKey = `pattern_data:${userId}`;
                        let patternData = this.cache.get<PatternData>(cacheKey) || {
                            originalInput: userInput,
                            processedOutputs: {},
                            currentPatternState: {}
                        };
                        patternData.originalInput = userInput;
                        this.cache.set(cacheKey, patternData, 14400); // 4 hours

                        console.log(`[${methodName}] Directly stored input for user ${userId}, length: ${userInput.length}`);
                    }

                    // Verify it was stored properly
                    const storedData = this.cache.get(`pattern_context:${userId}`);
                    console.warn(`[generateResponse] Pattern context storage check:`, {
                        userId,
                        wasStored: !!storedData,
                        matches: storedData === contextData
                    });

                    // Also verify the pattern data was stored
                    const patternData = this.cache.get<PatternData>(`pattern_data:${userId}`);
                    console.warn(`[generateResponse] Pattern data storage check:`, {
                        userId,
                        wasStored: !!patternData,
                        inputLength: patternData?.originalInput?.length
                    });

                    // Use MenuManager to create the pattern menu
                    if (!this.menuManager) {
                        throw new Error('MenuManager is not available');
                    }

                    // Create keyboard with MenuManager
                    const keyboard = this.menuManager.createPatternSelectionMenu(
                        suggestion,
                        suggestion.alternativePatterns
                    ).reply_markup;

                    // Store the keyboard in the context for handleEnhancedResponse to use
                    this.cache.set(
                        `pattern_keyboard:${userId}`,
                        keyboard,
                        14400  // 4 hours
                    );

                    if (suggestion.result) {
                        console.log(`[getPatternSuggestions] Pattern ${suggestion.pattern} was processed immediately, returning result`);
                        return [suggestion.result];
                    }

                    // Return just the message array
                    return [
                        `📝 I notice this content might benefit from specialized processing:\n\n` +
                        `*Suggested Pattern:* ${suggestion.pattern}\n` +
                        `*Category:* ${suggestion.category}\n` +
                        `*Confidence:* ${Math.round(suggestion.confidence * 100)}%\n\n` +
                        `*Description:* ${suggestion.description}\n\n` +
                        (suggestion.reasoning ? `*Reasoning:* ${suggestion.reasoning}\n\n` : '')
                    ];

                } catch (error) {
                    console.error(`[${methodName}] Error in pattern suggestion:`, error);

                    // Check for specific error types
                    if (error.message === 'No pattern suggestion available') {
                        console.log(`[${methodName}] No suitable pattern found, continuing with normal processing`);
                    } else if (error.message === 'Pattern agent not available') {
                        console.log(`[${methodName}] Pattern agent unavailable, continuing with normal processing`);
                    } else {
                        console.error(`[${methodName}] Unexpected error in pattern suggestion:`, error);
                    }

                    // Fall through to normal processing
                }
            }

            const truncatedHistory = await this.promptManager.truncateChatHistory(chatHistory);
            const isRAGQuery = contextRequirement === 'rag';

            console.log(`[${methodName}] Interaction type: ${interactionType}, Context requirement: ${contextRequirement}, Is RAG query: ${isRAGQuery}`);
            console.log(`[${methodName}] Truncated chat history to ${truncatedHistory.length} messages`);

            const prompt = this.promptManager.getContextAwarePrompt(contextRequirement, truncatedHistory);
            // Keep standaloneQuestion as userInput unless it's a RAG query
            let context = "";

            if (isRAGQuery && !gameState?.isActive) {
                // this.ragQuestionCount++;
                // Calculate the actual standalone question ONLY for RAG
                standaloneQuestion = await this.getStandaloneQuestion(userInput, truncatedHistory, interactionType, adapter);
                // Pass the calculated standaloneQuestion
                // Add the standaloneQuestion argument here
                context = await this.getDynamicContext(standaloneQuestion, truncatedHistory, interactionType, userId, adapter, standaloneQuestion, replyToMessage, progressKey);
                console.log(`[${methodName}] Standalone question: ${standaloneQuestion}`);
                console.log(`[${methodName}] Retrieved context (preview): ${context.substring(0, 200)}...`);
            }

            let response: string;
            if (this.shouldUseTool(userInput) && this.agentExecutor) {
                console.log(`[${methodName}] Using tool agent for response generation`);
                response = await this.executeToolAgent(userInput, context, truncatedHistory);
            } else {
                console.log(`[${methodName}] Generating answer using ${contextRequirement} method`);
                switch (contextRequirement) {
                    case 'rag':
                        // Use the calculated standaloneQuestion for RAG answer generation
                        response = await this.generateAnswer(standaloneQuestion, context, truncatedHistory, interactionType, userId, adapter, replyToMessage, undefined, progressKey, thinkingPreferences);
                        if (!this.responseIncludesContext(response, context)) {
                            console.warn(`[${methodName}] Response does not include context, attempting to regenerate`);
                            // Use the calculated standaloneQuestion for RAG regeneration
                            response = await this.regenerateWithExplicitContext(standaloneQuestion, context, truncatedHistory, prompt, interactionType);
                        }
                        /*
                        if (this.ragQuestionCount % 6 === 0) {
                            const followUpQuestions = await this.generateFollowUpQuestions(context, truncatedHistory);
                            if (followUpQuestions.length > 0) {
                                response += "\n\n🤔 Here are some follow-up questions you might find interesting:\n" +
                                    followUpQuestions.map(q => `• ${q}`).join('\n');
                            }
                        }
                            */
                        break;
                    case 'chat':
                        response = await this.generateAnswer(userInput, "", truncatedHistory, interactionType, userId, adapter, replyToMessage, undefined, progressKey, thinkingPreferences);
                        break;
                    case 'none':
                        response = await this.generateSimpleResponse(userInput, truncatedHistory, interactionType);
                        break;
                    case 'tool':
                        // Implement tool-based response generation
                        response = await this.generateAnswer(userInput, "", truncatedHistory, interactionType, userId, adapter, replyToMessage, undefined, progressKey, thinkingPreferences);
                        break;
                    case 'game':
                        console.warn(`[${methodName}] Case Game Processing`);
                        const gameAgent = this.agentManager.getAgent('game') as GameAgent;

                        if (!gameState?.isActive) {
                            console.log(`[${methodName}] @Case game: Detected game-related query`);
                            this.disableRAGMode(userId);
                            await adapter.replyWithAutoDelete("Ah, maybe you'd like to play, 'Who Wants to be a Millionaire'? A fun way to test our knowledge on what we have discussed thus far? click on the command below to begin! 🎮", 60000);
                            await adapter.replyWithAutoDelete("/millionaire", 60000);

                            return [
                                "🎲"
                            ];
                        }
                        if (gameAgent) {
                            const result = await gameAgent.processQuery(userInput, context, truncatedHistory, interactionType, userId, adapter, progressKey);
                            return result.response;  // Just return the response part
                        } else {
                            console.warn(`[${methodName}] Game agent not available, falling back to chat`);
                            response = await this.generateAnswer(userInput, "", truncatedHistory, interactionType, userId, adapter, replyToMessage, undefined, progressKey);
                        }
                        break;
                }
            }

            console.log(`[${methodName}] Generated response (preview): ${response.substring(0, 200)}...`);
            // Use the potentially updated standaloneQuestion for tracking
            await this.promptManager.trackContextSuccess(context, standaloneQuestion, response);

            const responseChunks = this.promptManager.splitAndTruncateMessage(response);
            console.log(`[${methodName}] Split response into ${responseChunks.length} chunks`);

            // Add emotes to the response chunks
            const emoteResponseChunks = responseChunks.map(chunk => this.addEmotesToResponse(chunk));

            return emoteResponseChunks;
        } catch (error) {
            console.error(`[${methodName}] Error generating response:`, error);
            throw error;
        }
    }

    private addEmotesToResponse(response: string): string {
        // Add appropriate emotes based on the content of the response
        if (response.toLowerCase().includes('error') || response.toLowerCase().includes('sorry')) {
            return `❗ ${response}`;
        } else if (response.toLowerCase().includes('success') || response.toLowerCase().includes('completed')) {
            return `✅ ${response}`;
        } else if (response.toLowerCase().includes('warning') || response.toLowerCase().includes('caution')) {
            return `⚠️ ${response}`;
        } else if (response.toLowerCase().includes('question') || response.toLowerCase().includes('?')) {
            return `❓ ${response}`;
        } else {
            return `💬 ${response}`;
        }
    }


    // In ConversationManager or similar
    /**
     * Processes a query using the RAG (Retrieval Augmented Generation) agent.
     *
     * @param input - The user's input or query.
     * @param chatHistory - The chat history as an array of `BaseMessage` objects.
     * @param userId - The unique identifier for the user.
     * @param replyToMessage - An optional object containing the message ID and text of the message being replied to.
     * @param adapter - An optional `ContextAdapter` instance to customize the context retrieval process.
     * @param progressKey - An optional key to track the progress of the operation.
     * @returns An `EnhancedResponse` object containing the generated response.
     */
    public async processWithRAGAgent(
        input: string,
        chatHistory: BaseMessage[],
        interactionType: InteractionType,
        userId: string,
        adapter: ContextAdapter,
        replyToMessage?: { message_id: number; text: string },
        progressKey?: string
    ): Promise<EnhancedResponse> {
        const methodName = 'processWithRAGAgent';
        console.log(`[${methodName}] CM: Entering processWithRAGAgent`);
        // Calculate standaloneQuestion within this function's scope
        const standaloneQuestion = await this.getStandaloneQuestion(input, chatHistory, interactionType, adapter);
        console.log(`[${methodName}] Standalone question determined: "${standaloneQuestion}"`);
        const ragAgent = this.agentManager.getAgent('rag') as RAGAgent;

        // Cache keys
        const contextCacheKey = CacheKeys.RelevantContext(userId);
        const queryCacheKey = CacheKeys.ContextualizedQuery(userId);

        // Try to get the relevant context from cache
        const contextCacheEntry = this.cache.get<{ relevantContext: string; timestamp: number }>(contextCacheKey);
        let context: string;

        const currentTime = Date.now();
        const cacheDuration = 2 * 60 * 1000; // 2 minutes in milliseconds

        if (contextCacheEntry && (currentTime - contextCacheEntry.timestamp) < cacheDuration) {
            // Cache hit and valid
            console.log(`[${methodName}] Cache hit for relevantContext with key: "${contextCacheKey}"`);
            context = contextCacheEntry.relevantContext;
        } else {
            // Cache miss or expired
            console.log(`[${methodName}] Cache miss or expired for relevantContext with key: "${contextCacheKey}"`);
            // Retrieve relevantContext using getRelevantContext
            // Pass standaloneQuestion to direct call
            context = await this.getRelevantContext(input, chatHistory, interactionType, userId, adapter, standaloneQuestion, replyToMessage, progressKey);
        }

        // Ensure context is a string
        if (typeof context !== 'string') {
            console.error(`[${methodName}] Retrieved context is not a string. Type: ${typeof context}`);
            // Handle the unexpected type, e.g., recompute the context
            // Pass standaloneQuestion to direct call
            context = await this.getRelevantContext(input, chatHistory, interactionType, userId, adapter, standaloneQuestion, replyToMessage, progressKey);
        }

        return await ragAgent.processQuery(input, context, chatHistory, interactionType, userId, adapter, progressKey);
    }

    public handleReplyContext(userInput: string, chatHistory: BaseMessage[], replyToMessage?: { message_id: number; text: string }): { contextualizedInput: string, relevantHistory: BaseMessage[] } {
        console.log(`[handleReplyContext] Processing reply. Chat history length: ${chatHistory.length}`);

        let contextualizedInput = userInput;
        let relevantHistory = chatHistory;

        if (replyToMessage) {
            console.log(`[handleReplyContext] Reply to message found:`, JSON.stringify(replyToMessage, null, 2));

            // Create a new message representing the replied-to message
            const repliedToMessage = new AIMessage(replyToMessage.text, {
                additional_kwargs: { message_id: replyToMessage.message_id }
            });

            // Add the replied-to message to the chat history
            relevantHistory = [...chatHistory, repliedToMessage];

            // Contextualize the input
            contextualizedInput = `Regarding the message: "${replyToMessage.text}"\nUser's reply: ${userInput}`;
        } else {
            console.log(`[handleReplyContext] No specific reply-to message found. Using full chat history.`);
        }

        return { contextualizedInput, relevantHistory };
    }
    /**
         * Generates a dynamic context based on the question complexity and retrieved documents.
         * Calls getRelevantContext and may summarize the context if it's too long.
         */
    private async getDynamicContext(
        question: string,
        chatHistory: BaseMessage[],
        interactionType: InteractionType,
        userId: string,
        adapter: ContextAdapter,
        standaloneQuestion: string, // Moved before optional params
        replyToMessage?: { message_id: number; text: string },
        progressKey?: string
    ): Promise<string> {
        const methodName = 'getDynamicContext';
        // Remove internal calculation, use the passed parameter
        console.log(`[${methodName}] Using passed standalone question: "${standaloneQuestion}"`);

        // Use the cache key for relevant context - TODO: Make this key specific?
        const contextCacheKey = CacheKeys.RelevantContext(userId);

        // Try to get the relevant context from cache
        const contextCacheEntry = this.cache.get<{ relevantContext: string; timestamp: number }>(contextCacheKey);
        let relevantContext: string;

        const currentTime = Date.now();
        const cacheDuration = 2 * 60 * 1000; // 2 minutes in milliseconds

        if (contextCacheEntry && (currentTime - contextCacheEntry.timestamp) < cacheDuration) {
            // Cache hit and valid
            console.log(`[${methodName}] Cache hit for key: "${contextCacheKey}"`);
            relevantContext = contextCacheEntry.relevantContext;
        } else {
            // Cache miss or expired
            console.log(`[${methodName}] Cache miss or expired for key: "${contextCacheKey}"`);
            // Retrieve relevantContext using getRelevantContext
            // Pass standaloneQuestion in the correct position
            // Pass the received standaloneQuestion
            // Pass the received standaloneQuestion
            relevantContext = await this.getRelevantContext(question, chatHistory, interactionType, userId, adapter, standaloneQuestion, replyToMessage, progressKey);
        }

        // Ensure relevantContext is a string
        if (typeof relevantContext !== 'string') {
            console.error(`[${methodName}] Retrieved relevantContext is not a string. Type: ${typeof relevantContext}`);
            // Handle the unexpected type, e.g., recompute the context
            // Pass standaloneQuestion in the correct position
            relevantContext = await this.getRelevantContext(question, chatHistory, interactionType, userId, adapter, standaloneQuestion, replyToMessage, progressKey);
        }

        console.log(`[getDynamicContext] relevantContext from cache: ${relevantContext}`);
        const contextComplexity = this.assessContextComplexity(relevantContext);
        const questionComplexity = this.assessQuestionComplexity(question);

        console.log(`[getDynamicContext] Context complexity: ${contextComplexity}, Question complexity: ${questionComplexity}`);

        const baseLength = this.dynamicContextBaseLength;
        const complexityFactor = Math.max((questionComplexity + contextComplexity) / 2, this.minComplexityFactor);
        const dynamicLength = Math.min(Math.round(this.contextWindowSize * complexityFactor), this.contextWindowSize);

        console.log(`[getDynamicContext] Dynamic length calculated: ${dynamicLength}`);

        let finalContext: string;
        if (relevantContext.length <= dynamicLength) {
            finalContext = relevantContext;
        } else {
            finalContext = await this.summarizeText(relevantContext, question, dynamicLength, 'context', interactionType, adapter);
        }

        console.log(`[getDynamicContext] Final context length: ${finalContext.length}`);
        console.log(`[getDynamicContext] Retrieved context preview: "${finalContext.substring(0, 200)}..."`);
        return finalContext;
    }



    private async generateAnswer(
        question: string,
        context: string,
        chatHistory: BaseMessage[],
        interactionType: InteractionType,
        userId: string,
        adapter: ContextAdapter,
        replyToMessage?: { message_id: number; text: string },
        sourceCitations?: SourceCitation[],
        progressKey?: string,
        thinkingPreferences?: Partial<ThinkingPreferences>
    ): Promise<string> {
        const methodName = 'generateAnswer';
        console.log('PromptManager state:', this.promptManager ? 'Initialized' : 'Not initialized');
        const isRAGEnabled = this.agentManager.isRAGModeEnabled(userId);
        const contextRequirement: ContextRequirement = context ? 'rag' : 'chat';
        if (context) {
            // Log that we're using this context
            console.log(`[${methodName}] Context will be used for response generation (${context.length} chars)`);

            // Explicitly save this context again with the user ID
            // Remove redundant caching of relevant context here.
            // It's already cached correctly with a question-specific key in getRelevantContext.
        } else {
            console.warn(`[${methodName}] No context available for this response generation`);
        }

        try {
            if (progressKey && adapter) {
                console.log(`[${methodName}:${this.flowId}] Updating progress: Preparing response`);
                await this.updateProgress(adapter, progressKey, "🧠 Preparing the response...");
                console.log(`[${methodName}] Progress updated for progressKey: ${progressKey}`);
            }
            let systemPrompt = this.promptManager.constructSystemPrompt(interactionType, contextRequirement);
           // const recentContextSummary = this.promptManager.generateRecentContextSummary(chatHistory);

            // Use the cache key for contextualized query
            // Use question-specific key for contextualized query cache
            // Note: 'question' parameter here is the standaloneQuestion when called from RAG path
            const queryCacheKey = CacheKeys.ContextualizedQuery(userId, question);

            // --- Retrieve and delete contextualized query from cache ---
            let contextualizedQuery: string | undefined = this.cache.get<string>(queryCacheKey);

            if (contextualizedQuery) {
                // Cache HIT: Use the cached query and delete it immediately
                console.log(`[${methodName}] Cache HIT for contextualizedQuery with key: "${queryCacheKey}". Using cached value.`);
                this.cache.del(queryCacheKey); // Delete after retrieval
                console.log(`[${methodName}] Deleted cached contextualizedQuery with key: "${queryCacheKey}".`);
            } else {
                // Cache MISS: This shouldn't happen if getRelevantContext cached it. Log a warning.
                // Fallback to using the original 'question' (standaloneQuestion) directly.
                // DO NOT recompute/recache here.
                
                console.warn(`[${methodName}] Cache MISS for contextualizedQuery key: "${queryCacheKey}". Generating a contextualizedQuery.`);
               // contextualizedQuery = question; // Fallback
                contextualizedQuery = await this.constructContextualizedQuery(question, chatHistory, interactionType, adapter, replyToMessage);

            }
            // --- End retrieval/deletion ---

          //  if (this.enablePersona) {
          //     systemPrompt = `${systemPrompt}\n\n${this.promptManager.getPersonaPrompt()}`;
         //   }
            if (progressKey && adapter) {
                console.log(`[${methodName}:${this.flowId}] Updating progress: Preparing response`);
                await this.updateProgress(adapter, progressKey, "📚");
                console.log(`[${methodName}] Progress updated for progressKey: ${progressKey}`);
            }

            let finalContext = context; // Start with the base context

            // Conditionally enhance context with facts if memory supports it
            if (this.memory && typeof (this.memory as any).getChatFacts === 'function') {
                logInfo(methodName, 'Memory supports facts, attempting enhancement.');
                finalContext = await this.enhanceContextWithFacts(context, question, adapter);
            } else {
                logInfo(methodName, 'Memory does not support facts, skipping enhancement.');
                // finalContext remains the original context
            }

            const userMessage = new HumanMessage(
                this.promptManager.constructUserPrompt(contextualizedQuery, finalContext, interactionType)
            );
            const messages: BaseMessage[] = [
                new SystemMessage(systemPrompt), // Remove recentContextSummary here
                userMessage
            ];

            console.log(`[${methodName}] Total messages to send: ${messages.length}`);
            console.log(`[${methodName}] Estimated token count: ${this.estimateTokenCount(messages)}`);
            // Add this logging section
            console.log(`[${methodName}] Messages to be sent to the model:`);
            messages.forEach((msg, index) => {
                console.log(`Message ${index + 1}:`);
                console.log(`  Type: ${msg.getType()}`);
                console.log(`  Content: ${this.truncateContent(msg.content as string)}`);
                if (msg.additional_kwargs) {
                    console.log(`  Additional kwargs: ${JSON.stringify(msg.additional_kwargs)}`);
                }
            });

            let pendingThinkingBlocks: ThinkingBlock[] | undefined;

            const response: AIMessage = await invokeModelWithFallback(
                this.chatModel,
                this.summationModel,
                this.utilityModel,
                messages,
                { initialTimeout: 85000, maxTimeout: 240000, retries: 2 }
            );

            // First, handle the content and think tags
            let content: string;
            if (hasThinkTags(response.content)) {
                const cleaned = cleanModelResponse(response.content, true);

                if (cleaned.thinking && cleaned.thinking.length > 0) {
                    // Instead of displaying immediately, store for later
                    pendingThinkingBlocks = cleaned.thinking.map(thought => ({
                        content: thought,
                        metadata: {
                            timestamp: new Date().toISOString(),
                            category: this.detectThinkingCategory(thought)
                        }
                    }));
                }

                content = cleaned.content;
            } else {
                content = messageContentToString(response.content);
            }

            // Validate content type
            if (typeof content !== 'string') {
                throw new Error('Unexpected response type from chat model');
            }

            // Apply post-processing if needed
            if (this.shouldPostProcess(question, interactionType)) {
                if (progressKey && adapter) {
                    console.log(`[${methodName}:${this.flowId}] Updating progress: Applying post processing`);
                    await this.updateProgress(adapter, progressKey, "🧐 Applying post processing...✈️");
                    console.log(`[${methodName}] Progress updated for progressKey: ${progressKey}`);
                }
                content = await this.postProcessResponse(content, question, interactionType);
            }

            // Add source citations if available
            if (sourceCitations && sourceCitations.length > 0) {
                content += this.formatCitationsWithGenericFormat(sourceCitations);
                console.log(`[${methodName}] Adding source Citations`);
            }

            // Update progress
            if (progressKey && adapter) {
                console.log(`[${methodName}:${this.flowId}] Updating progress: Response ready`);
                await this.updateProgress(adapter, progressKey, "💯");
                console.log(`[${methodName}] Progress updated for progressKey: ${progressKey}`);
            }

            // Now that all processing is complete, display thinking if we have any
            if (pendingThinkingBlocks && pendingThinkingBlocks.length > 0) {
                try {
                    // Add a small delay to ensure main response is processed
                    await new Promise(resolve => setTimeout(resolve, 500));
                    await this.thinkingManager.displayThinking(
                        adapter,
                        pendingThinkingBlocks,
                        thinkingPreferences
                    );
                } catch (thinkingError) {
                    console.error(`[${methodName}] Error displaying thinking process:`, thinkingError);
                    // Don't throw - continue with main response even if thinking display fails
                }
            }

            console.log('PromptManager state:', this.promptManager ? 'Initialized' : 'Not initialized');
            console.log(`[${methodName}] Final response preview: "${content.substring(0, 100)}..."`);

            return content;
        } catch (error) {
            console.error(`[${methodName}] Error generating answer:`, error);
            throw new Error(`Failed to generate answer: ${error.message}`);
        }
    }

    private detectThinkingCategory(thought: string): string {
        // Simple category detection based on keywords
        if (thought.match(/analyz|examin|compar|pattern|data/i)) return 'analysis';
        if (thought.match(/reason|because|therefore|hence|thus/i)) return 'reasoning';
        if (thought.match(/decide|choose|select|pick|determine/i)) return 'decision';
        if (thought.match(/research|study|investigate|explore/i)) return 'research';
        if (thought.match(/calculat|compute|estimate|number/i)) return 'calculation';
        return 'general';
    }
    private formatThinkingProcess(thinking: string[]): string {
        const emojis = ['🤔', '💭', '🧐', '💡', '🔍'];
        return thinking
            .map((thought, index) => {
                const emoji = emojis[index % emojis.length];
                return `${emoji} ${thought}`;
            })
            .join('\n');
    }

    private truncateContent(content: string, maxLength: number = 10000): string {
        if (content.length <= maxLength) {
            return content;
        }
        return content.substring(0, maxLength) + '...';
    }
    public togglePersona(enable: boolean): void {
        this.enablePersona = enable;
        console.log(`Persona ${enable ? 'enabled' : 'disabled'}`);
    }


    public getContentPreview(content: MessageContent): string {
        if (typeof content === 'string') {
            return content.substring(0, 50) + '...';
        } else if (Array.isArray(content)) {
            return content.map(item => this.getComplexContentPreview(item)).join(', ').substring(0, 50) + '...';
        } else if (typeof content === 'object' && content !== null) {
            return this.getComplexContentPreview(content);
        }
        return String(content).substring(0, 50) + '...';
    }

    private getComplexContentPreview(item: MessageContentComplex): string {
        if ('type' in item) {
            switch (item.type) {
                case 'text':
                    return `Text: ${item.text.substring(0, 30)}...`;
                case 'image_url':
                    return `Image: ${item.image_url.url.substring(0, 30)}...`;
                default:
                    return `Unknown type: ${JSON.stringify(item).substring(0, 30)}...`;
            }
        } else {
            return JSON.stringify(item).substring(0, 30) + '...';
        }
    }

    private trackConversationType(userId: string, type: InteractionType): void {
        const history = this.conversationTypeHistory.get(userId) || [];
        history.push(type);
        this.conversationTypeHistory.set(userId, history.slice(-this.RAG_PROMPT_THRESHOLD));
    }
    private readonly RAG_PROMPT_INTERVAL = 5; // Number of messages before prompting again
    private lastRagPrompt: Map<string, number> = new Map();

    private async shouldPromptRagMode(userId: string): Promise<boolean> {
        const history = this.conversationTypeHistory.get(userId) || [];
        const lastPrompt = this.lastRagPrompt.get(userId) || 0;
        const currentCount = history.length;

        const consecutiveChatInteractions = history.filter(type => type === 'general_input' || type === 'short_input').length;

        console.log(`[shouldPromptRagMode] User ${userId} - History: ${history.join(', ')}, Last prompt: ${lastPrompt}, Current count: ${currentCount}, Consecutive chat: ${consecutiveChatInteractions}`);

        const isEnabled = await Promise.resolve(this.agentManager.isRAGModeEnabled(userId));
        return isEnabled &&
            consecutiveChatInteractions >= this.RAG_PROMPT_THRESHOLD &&
            currentCount - lastPrompt >= this.RAG_PROMPT_INTERVAL &&
            !history.includes('rag');
    }
    private async promptRagModeContinuation(userId: string): Promise<string[]> {
        console.log(`[promptRagModeContinuation] Asking user ${userId} if they want to continue in RAG mode`);
        const message = "🤔 Are you looking for somthing else? Would you like to disable RAG mode for now? Reply with 'Yes' to disable or 'No' to keep it enabled.";
        return [message];
    }

    public handleRagModeResponse(userId: string, response: string): void {
        const ragAgent = this.agentManager.getAgent('rag') as RAGAgent;
        if (!ragAgent) {
            console.warn('RAGAgent is not available. Cannot handle RAG mode response.');
            return;
        }

        if (response.toLowerCase() === 'yes') {
            ragAgent.toggleRAGMode(userId, false);
            console.log(`[handleRagModeResponse] RAG mode disabled for user ${userId}`);
        } else {
            console.log(`[handleRagModeResponse] RAG mode remains enabled for user ${userId}`);
        }

        // Reset conversation type history and update last prompt time
        this.conversationTypeHistory.set(userId, []);
        this.lastRagPrompt.set(userId, this.conversationTypeHistory.get(userId)?.length || 0);
    }

    public disableRAGMode(userId: string): void {
        const ragAgent = this.agentManager.getAgent('rag') as RAGAgent;
        if (ragAgent) {
            ragAgent.toggleRAGMode(userId, false);
            logInfo('disableRAGMode', `RAG mode disabled for user ${userId}`);
        }
    }

    public async determineInteractionType(userInput: string, userId: string): Promise<InteractionType> {
        const methodName = 'determineInteractionType';
        console.log(`[${methodName}] Analyzing input for user ${userId}: "${userInput}"`);

        //Early Game Detection and status
        const gameAgent = this.agentManager.getAgent('game') as GameAgent;
        const gameState = gameAgent?.getGameState?.(userId);

        if (gameState?.isActive) {
            console.log(`[${methodName}] Game state already active, returning game InteractionType`);
            return 'game';
        }

        // Helper function to validate and parse interaction type
        const parseInteractionType = (content: string): InteractionType | null => {
            const validTypes: InteractionType[] = [
                'greeting', 'command', 'factual_question', 'explanatory_question',
                'general_question', 'statement', 'continuation', 'short_input',
                'general_input', 'game'
            ];
            const type = content.trim().toLowerCase() as InteractionType;
            return validTypes.includes(type) ? type : null;
        };

        // Helper function to get interaction type with one retry
        const getInteractionTypeWithRetry = async (prompt: ChatPromptTemplate): Promise<InteractionType | null> => {
            const messages = await prompt.formatMessages({ input: userInput });

            // First try
            const result = await invokeModelWithFallback(
                this.utilityModel,
                this.summationModel,
                this.chatModel,
                messages,
                { initialTimeout: 30000, maxTimeout: 60000, retries: 1 }
            );

            let type = parseInteractionType(this.thinkingManager.cleanThinkTags(result.content) as string);


            // If first try didn't return a valid type, give one more chance with explicit instruction
            if (type === null) {
                console.log(`[${methodName}] Invalid type received: "${result.content}". Retrying with explicit instruction.`);

                // Add explicit instruction for retry
                const retryPrompt = ChatPromptTemplate.fromMessages([
                    SystemMessagePromptTemplate.fromTemplate(
                        `Your previous response was invalid. You MUST return ONLY ONE of these exact words:
                        greeting, command, factual_question, explanatory_question, general_question,
                        statement, continuation, short_input, general_input, game
    
                        No explanation, no other text. Just ONE of these words.
                        If unsure, return 'general_input'.`
                    ),
                    ...messages
                ]);

                const retryResult = await invokeModelWithFallback(
                    this.utilityModel,
                    this.summationModel,
                    this.chatModel,
                    await retryPrompt.formatMessages({ input: userInput }),
                    { initialTimeout: 30000, maxTimeout: 60000, retries: 1 }
                );

                type = parseInteractionType(this.thinkingManager.cleanThinkTags(retryResult.content) as string);

            }

            return type;
        };

        try {
            const initialPrompt = ChatPromptTemplate.fromMessages([
                SystemMessagePromptTemplate.fromTemplate(
                    `Classify this input into ONE of these types:
                    greeting, command, factual_question, explanatory_question, general_question,
                    statement, continuation, short_input, general_input, game
    
                    If Game-related content (return 'game' for):
                    - Starting/joining/leaving games
                    - Game commands or actions
                    - Questions about game rules/status
                    - Score or points inquiries
                    - Level or progress questions
    
                    Return ONLY the classification word, no explanation.`
                ),
                HumanMessagePromptTemplate.fromTemplate("{input}")
            ]);

            const interactionType = await getInteractionTypeWithRetry(initialPrompt);

            if (interactionType === null) {
                console.log(`[${methodName}] Failed to get valid type after retry. Using fallback.`);
                const fallbackType = this.fallbackDetermineInteractionType(userInput, userId);
                this.trackConversationType(userId, fallbackType);
                return fallbackType;
            }

            console.log(`[${methodName}] Final classification: ${interactionType}`);
            this.trackConversationType(userId, interactionType);
            return interactionType;

        } catch (error) {
            console.error(`[${methodName}] Classification failed: ${error.message}`);
            const fallbackType = this.fallbackDetermineInteractionType(userInput, userId);
            this.trackConversationType(userId, fallbackType);
            return fallbackType;
        }
    }

    /**
     * Determines the type of interaction based on the user's input and chat history.
     * Used to tailor the response generation process.
     */
    public fallbackDetermineInteractionType(userInput: string, userId: string): InteractionType {
        //console.log(`[determineInteractionType] Analyzing input for user ${userId}: "${userInput}"`);
        const lowercaseInput = userInput.toLowerCase().trim();
        const words = lowercaseInput.split(/\s+/);
        // console.log(`[determineInteractionType] Lowercase input: "${lowercaseInput}"`);
        console.log(`[determineInteractionType] Word count: ${words.length}`);

        // Define patterns and keywords
        const greetings = ['hello', 'hi', 'hey', 'good morning', 'good afternoon', 'good evening'];
        const questionStarters = ['what', 'why', 'how', 'when', 'where', 'who', 'which', 'can', 'could', 'would', 'is', 'are', 'do', 'does'];
        const commandStarters = ['please', 'could you', 'would you', 'can you'];
        const statementStarters = ['i think', 'i believe', 'in my opinion', 'i feel'];
        const continuationPhrases = ['and', 'also', 'additionally', 'moreover', 'furthermore', 'besides'];
        const gameKeywords = ['play', 'game', 'start', 'join', 'score', 'points', 'level', 'millionaire', 'trivia', 'quiz', 'answer', 'question', 'lifeline'];
        const gameCommands = ['/play', '/start', '/join', '/game', '/score', '/stats', '/help'];

        let interactionType: InteractionType;

        // Check for game-related content first
        if (gameCommands.some(cmd => lowercaseInput.startsWith(cmd)) ||
            gameKeywords.some(keyword => lowercaseInput.includes(keyword))) {
            interactionType = 'game';
            console.log(`[determineInteractionType] Detected game interaction from keywords/commands`);
            return interactionType;
        }

        if (greetings.some(greeting => lowercaseInput.startsWith(greeting))) {
            interactionType = 'greeting';
        } else if (lowercaseInput.startsWith('/')) {
            interactionType = 'command';
        } else if (questionStarters.some(starter => lowercaseInput.startsWith(starter)) || lowercaseInput.endsWith('?')) {
            if (lowercaseInput.includes('what') || lowercaseInput.includes('who') || lowercaseInput.includes('where')) {
                interactionType = 'factual_question';
            } else if (lowercaseInput.includes('how') || lowercaseInput.includes('why')) {
                interactionType = 'explanatory_question';
            } else {
                interactionType = 'general_question';
            }
        } else if (commandStarters.some(starter => lowercaseInput.startsWith(starter))) {
            interactionType = 'command';
        } else if (statementStarters.some(starter => lowercaseInput.startsWith(starter))) {
            interactionType = 'statement';
        } else if (continuationPhrases.some(phrase => words.includes(phrase))) {
            interactionType = 'continuation';
        } else if (words.length < 3) {
            interactionType = 'short_input';
        } else {
            interactionType = 'general_input';
        }

        console.log(`[determineInteractionType] Detected interaction type: ${interactionType}`);
        this.trackConversationType(userId, interactionType);

        return interactionType;
    }

    public getEffectiveInteractionType(baseType: InteractionType, userId: string): InteractionType {
        const isRagModeEnabled = this.agentManager.isRAGModeEnabled(userId);
        return isRagModeEnabled ? 'rag' : baseType;
    }
    public async detectContextRequirement(
        userInput: string,
        baseType: InteractionType,
        userId: string
    ): Promise<ContextRequirement> {
        const methodName = 'detectContextRequirement';
        console.log(`[${methodName}] Analyzing input: "${userInput}", Base type: ${baseType}`);

        // Early return for game type
        if (baseType === 'game') {
            console.log(`[${methodName}] Base type is game, returning game context requirement`);
            return 'game';
        }

        // Helper function to validate and parse context requirement
        const parseContextRequirement = (content: string): ContextRequirement | null => {
            const validTypes: ContextRequirement[] = ['rag', 'chat', 'none', 'tool', 'game'];
            const type = content.trim().toLowerCase() as ContextRequirement;
            return validTypes.includes(type) ? type : null;
        };

        // Helper function to get context requirement with one retry
        const getContextRequirementWithRetry = async (prompt: ChatPromptTemplate): Promise<ContextRequirement | null> => {
            const messages = await prompt.formatMessages({ input: userInput, baseType });

            // First try
            const result = await invokeModelWithFallback(
                this.utilityModel,
                this.summationModel,
                this.chatModel,
                messages,
                { initialTimeout: 30000, maxTimeout: 60000, retries: 1 }
            );

            let type = parseContextRequirement(this.thinkingManager.cleanThinkTags(result.content) as string);

            // If first try didn't return a valid type, give one more chance
            if (type === null) {
                console.log(`[${methodName}] Invalid type received: "${result.content}". Retrying with explicit instruction.`);

                // Add explicit instruction for retry
                const retryPrompt = ChatPromptTemplate.fromMessages([
                    SystemMessagePromptTemplate.fromTemplate(
                        `Your previous response was invalid. You MUST return ONLY ONE of these exact words:
                        rag, chat, none, tool, game
        
                        No explanation, no other text. Just ONE of these words.
                        If unsure, return 'chat'.`
                    ),
                    ...messages
                ]);

                const retryResult = await invokeModelWithFallback(
                    this.utilityModel,
                    this.summationModel,
                    this.chatModel,
                    await retryPrompt.formatMessages({ input: userInput, baseType }),
                    { initialTimeout: 30000, maxTimeout: 60000, retries: 1 }
                );

                type = parseContextRequirement(this.thinkingManager.cleanThinkTags(retryResult.content) as string);
            }

            return type;
        };

        try {
            const initialPrompt = ChatPromptTemplate.fromMessages([
                SystemMessagePromptTemplate.fromTemplate(
                    `Given this input and its interaction type (${baseType}), determine if it requires:
    
                    rag: Needs information retrieval (for factual or detailed questions)
                    chat: Simple conversation (no extra context needed)
                    none: Explicitly avoid using context
                    tool: Requires specific tool usage
                    game: Game-related state and rules
    
                    Guidelines based on interaction type:
                    - factual_question usually needs 'rag'
                    - explanatory_question usually needs 'rag'
                    - greeting usually needs 'chat'
                    - short_input usually needs 'chat'
                    - command might need 'tool'
                    - game-related content always needs 'game'
    
                    Return ONLY ONE word from: rag, chat, none, tool, game
                    No explanation or additional text.`
                ),
                HumanMessagePromptTemplate.fromTemplate(
                    `Input: {input}\nInteraction Type: {baseType}\n\nContext Requirement:`
                )
            ]);

            const contextRequirement = await getContextRequirementWithRetry(initialPrompt);

            if (contextRequirement === null) {
                console.log(`[${methodName}] Failed to get valid type after retry. Using fallback.`);
                return this.fallbackDetectContextRequirement(userInput, baseType, userId);
            }

            console.log(`[${methodName}] Determined context requirement: ${contextRequirement}`);
            return contextRequirement;

        } catch (error) {
            console.error(`[${methodName}] Error determining context requirement:`, error);
            return this.fallbackDetectContextRequirement(userInput, baseType, userId);
        }
    }
    private async fallbackDetectContextRequirement(userInput: string, baseType: InteractionType, userId: string): Promise<ContextRequirement> {
        const methodName = 'fallbackDetectContextRequirement';
        const isRagEnabled = await Promise.resolve(this.agentManager.isRAGModeEnabled(userId));
        const effectiveType = isRagEnabled ? 'rag' : baseType;

        console.log(`[${methodName}] Analyzing input: "${userInput}", Base type: ${baseType}, Effective type: ${effectiveType}`);
        const lowercaseInput = userInput.toLowerCase();

        // Check for game-related content first
        const gameKeywords = ['play', 'game', 'start', 'join', 'score', 'points', 'level', 'millionaire', 'trivia', 'quiz', 'answer', 'lifeline'];
        const gameCommands = ['/play', '/start', '/join', '/game', '/score', '/stats', '/help'];

        if (gameCommands.some(cmd => lowercaseInput.startsWith(cmd)) ||
            gameKeywords.some(keyword => lowercaseInput.includes(keyword)) ||
            baseType === 'game') {
            console.log(`[${methodName}] Game interaction detected, returning game context requirement`);
            return 'game';
        }

        // Check for explicit instructions first
        if (lowercaseInput.includes('no context') || lowercaseInput.includes('ignore context')) {
            console.log(`[${methodName}] Explicit instruction to ignore context detected`);
            return 'none';
        }
        if (lowercaseInput.includes('use context') || lowercaseInput.includes('with context')) {
            console.log(`[${methodName}] Explicit instruction to use context detected`);
            return 'rag';
        }

        // If effective type is 'rag', return 'rag'
        if (effectiveType === 'rag') {
            console.log(`[${methodName}] Effective type is RAG, returning RAG context requirement`);
            return 'rag';
        }

        // Define RAG keywords and patterns
        const ragKeywords = ['what', 'who', 'when', 'where', 'why', 'how', 'explain', 'describe', 'elaborate', 'tell me about', 'give me information on'];
        const ragPatterns = [/\b(can|could) you (tell|explain|describe|elaborate)/i, /\b(what|who|when|where|why|how) (is|are|was|were)\b/i];

        // Check for RAG indicators
        const hasRagKeyword = ragKeywords.some(keyword => lowercaseInput.includes(keyword));
        const matchesRagPattern = ragPatterns.some(pattern => pattern.test(lowercaseInput));

        console.log(`[${methodName}] RAG keyword check: ${hasRagKeyword}, RAG pattern check: ${matchesRagPattern}`);

        if (hasRagKeyword || matchesRagPattern) {
            console.log(`[${methodName}] RAG indicators detected, suggesting RAG`);
            return 'rag';
        }

        // Handle different interaction types
        let contextRequirement: ContextRequirement;
        switch (baseType) {
            case 'greeting':
            case 'short_input':
                contextRequirement = 'chat';
                break;
            case 'continuation':
            case 'factual_question':
            case 'explanatory_question':
                contextRequirement = 'rag';
                break;
            case 'general_question':
            case 'command':
            case 'statement':
                contextRequirement = userInput.split(' ').length >= 5 ? 'rag' : 'chat';
                break;
            case 'general_input':
            default:
                contextRequirement = 'chat';
                break;
        }

        console.log(`[${methodName}] Determined context requirement: ${contextRequirement}`);
        return contextRequirement;
    }
    private async generateSimpleResponse(userInput: string, chatHistory: BaseMessage[], interactionType: string): Promise<string> {
        const methodName = 'generateSimpleResponse';
        try {
            const contextualPrompt = this.promptManager.generateRecentContextSummary(chatHistory);
            let systemPrompt = `You are a helpful AI assistant. Engage in friendly conversation and provide information on a wide range of topics. 
                The current interaction type is: ${interactionType}.
                ${contextualPrompt}
                If you're unsure about something, don't hesitate to say so.`;

            if (this.enablePersona) {
                systemPrompt = `${systemPrompt}\n\n${this.promptManager.getPersonaPrompt()}`;
            }

            const systemMessage = new SystemMessage(systemPrompt);
            const userMessage = new HumanMessage(userInput);

            const messages: BaseMessage[] = [
                systemMessage,
                ...chatHistory.slice(-5), // Limit to last 5 messages for efficiency
                userMessage
            ];

            console.log(`[${methodName}] Persona enabled: ${this.enablePersona}`);
            console.log(`[${methodName}] Interaction type: ${interactionType}`);
            console.log(`[${methodName}] Chat history length: ${chatHistory.length}`);
            console.log(`[${methodName}] Formatted messages: ${JSON.stringify(messages.map(m => ({ type: m._getType(), contentPreview: (m.content as string).substring(0, 50) })), null, 2)}`);

            const response: AIMessage = await invokeModelWithFallback(
                this.chatModel,
                this.summationModel,
                this.utilityModel,
                messages,
                { initialTimeout: 45000, maxTimeout: 180000, retries: 2 }
            );
            let content = this.thinkingManager.cleanThinkTags(response.content) as string;

            if (typeof content !== 'string') {
                throw new Error('Unexpected response type from chat model');
            }
            console.log(`[${methodName}] Raw response type: ${response._getType()}, content preview: "${(response.content as string).substring(0, 100)}..."`);

            return response.content as string;
        } catch (error) {
            console.error(`[${methodName}] Error generating response:`, error);
            throw new Error(`Failed to generate simple response: ${error.message}`);
        }
    }
    async generateFollowUpQuestions(context: string, chatHistory: BaseMessage[], isEnhancedMode: boolean = false): Promise<string[]> {
        console.log("[CM]Entering generateFollowUpQuestions");
        const methodName = 'generateFollowUpQuestions';
        try {
            let systemPrompt = `You are an AI assistant tasked with generating relevant follow-up questions based on the given context and chat history. Your goal is to create ${isEnhancedMode ? '5' : '3'} insightful questions that:
            1. Explore key concepts mentioned in the context or recent conversation.
            2. Encourage deeper understanding of the topic.
            3. Are diverse and cover different aspects of the subject.
            ${isEnhancedMode ? '4. Probe into potential applications or implications of the discussed topics.' : ''}
            ${isEnhancedMode ? '5. Encourage critical thinking and analysis.' : ''}
            Provide only the questions, without any additional text or numbering.`;

            if (this.enablePersona) {
                systemPrompt = `${systemPrompt}\n\n${this.promptManager.getPersonaPrompt()}`;
            }

            const systemMessage = new SystemMessage(systemPrompt);

            const userMessage = new HumanMessage(`Context:
            ${context}

            Chat History:
            ${this.formatChatHistory(chatHistory.slice(-5))}

            Based on this information, generate ${isEnhancedMode ? '5' : '3'} relevant follow-up questions.`);

            const messages: BaseMessage[] = [systemMessage, userMessage];

            console.log(`[${methodName}] Persona enabled: ${this.enablePersona}`);
            console.log(`[${methodName}] Enhanced mode: ${isEnhancedMode}`);
            console.log(`[${methodName}] Context length: ${context.length}`);
            console.log(`[${methodName}] Chat history length: ${chatHistory.length}`);

            const response: AIMessage = await invokeModelWithFallback(
                this.chatModel,
                this.summationModel,
                this.utilityModel,
                messages,
                { initialTimeout: 45000, maxTimeout: 180000, retries: 2 }
            );
            let content = response.content;

            if (typeof content !== 'string') {
                throw new Error('Unexpected response type from chat model');
            }
            const cleaned = cleanModelResponse(response.content, true);

            // Log the thinking process if it exists
            if (cleaned.thinking) {
                logDebug(methodName, 'Model thinking process:', {
                    thinking: cleaned.thinking
                });
            }

            // Process the cleaned content to extract questions
            const questions = cleaned.content
                .split('\n')
                .filter(q => q.trim() !== '')
                .map(q => q.trim());

            logInfo(methodName, `Generated ${questions.length} follow-up questions`);
            logDebug(methodName, 'Questions preview:', questions.map(q => q.substring(0, 50)).join(' | '));

            return questions;
        } catch (error) {
            console.error(`[${methodName}] Error generating follow-up questions:`, error);
            return [];
        }
    }
    /**
     * Regenerates a response with an explicit context provided.
     *
     * This method is used to generate a response to a question, using the provided context and chat history.
     * The context is explicitly included in the prompt, and the response is generated based on this context.
     *
     * @param question - The question to be answered.
     * @param context - The context to be used in generating the response.
     * @param chatHistory - The chat history to be used in generating the response.
     * @param prompt - The chat prompt template to be used.
     * @param interactionType - The type of interaction (e.g. "question-answer").
     * @returns The generated response.
     */
    private async regenerateWithExplicitContext(
        question: string,
        context: string,
        chatHistory: BaseMessage[],
        prompt: ChatPromptTemplate,
        interactionType: InteractionType,
        adapter?: ContextAdapter,
        progressKey?: string
    ): Promise<string> {
        const methodName = 'regenerateWithExplicitContext';

        try {
            if (progressKey && adapter) {
                await this.updateProgress(adapter, progressKey, "🔄 Regenerating response with explicit context...");
                console.log(`[${methodName}] Progress updated for progressKey: ${progressKey}`);
            }

            // More structured prompt template
            const regenerationPrompt = ChatPromptTemplate.fromMessages([
                SystemMessagePromptTemplate.fromTemplate(
                    `You are an AI assistant focused on providing accurate, context-based answers.
                    Your task is to generate a new response that MUST use the provided context.
                    
                    Rules:
                    1. ONLY use information from the provided context
                    2. If a detail isn't in the context, don't include it
                    3. Reference specific details from the context
                    4. Keep your response focused and concise
                    
                    Interaction Type: {interactionType}`
                ),
                new MessagesPlaceholder("chat_history"),
                HumanMessagePromptTemplate.fromTemplate(
                    `Context:
                    {context}
                    
                    Question: {question}
                    
                    Generate a response that explicitly uses this context:`
                )
            ]);

            const messages = await regenerationPrompt.formatMessages({
                context,
                question,
                interactionType,
                chat_history: chatHistory.slice(-3) // Only use last 3 messages for context
            });

            if (progressKey && adapter) {
                await this.updateProgress(adapter, progressKey, "✍️ Crafting new response...");
                console.log(`[${methodName}] Progress updated for progressKey: ${progressKey}`);

            }

            // Use summationModel first as it might be more careful with context
            const response: AIMessage = await invokeModelWithFallback(
                this.summationModel,
                this.chatModel,
                this.utilityModel,
                messages,
                {
                    initialTimeout: 45000,
                    maxTimeout: 180000,
                    retries: 2,
                    skipUtilityModel: true // Skip utility model for full response generation
                }
            );

            const content = this.thinkingManager.cleanThinkTags(response.content) as string;
            if (typeof content !== 'string') {
                throw new Error('Unexpected response type from model');
            }

            // Verify the regenerated response uses context
            const usesContext = await this.responseIncludesContext(
                content,
                context,
                adapter,
                progressKey
            );
            if (!usesContext) {
                console.warn(`[${methodName}] Regenerated response still doesn't use context properly`);
                if (progressKey && adapter) {
                    await this.updateProgress(adapter, progressKey, "⚠️ Unable to generate context-based response");
                    console.log(`[${methodName}] Progress updated for progressKey: ${progressKey}`);
                }

                // Last resort: Generate a response that explicitly quotes the context
                return this.generateFallbackResponse(question, context);
            }

            if (progressKey && adapter) {
                await this.updateProgress(adapter, progressKey, "✅ Successfully regenerated response");
                console.log(`[${methodName}] Progress updated for progressKey: ${progressKey}`);
            }

            return content;

        } catch (error) {
            console.error(`[${methodName}] Error during regeneration:`, error);

            if (progressKey && adapter) {
                await this.updateProgress(adapter, progressKey, "❌ Error regenerating response");
                console.log(`[${methodName}] Progress updated for progressKey: ${progressKey}`);
            }

            // Return a safe fallback response
            return this.generateFallbackResponse(question, context);
        }
    }

    private generateFallbackResponse(question: string, context: string): string {
        // Create a simple, safe response that directly quotes the context
        return `Based on the available information: ${context.slice(0, 200)}... [Context truncated for brevity]
    
    This context provides some relevant information, though it may not fully answer your specific question about: ${question}`;
    }



    private shouldUseTool(question: string): boolean {
        const methodName = 'shouldUseTool';

        // Only suggest using a tool if we have an agent executor
        if (!this.agentExecutor) {
            console.log(`[${methodName}] No agent executor available`);
            return false;
        }

        // Check if the input is a command that requires a tool
        if (question.startsWith('/searchweb')) {
            console.log(`[${methodName}] Detected /searchweb command`);
            return true;
        }

        // Check for tool-specific keywords
        const toolKeywords = this.tools.flatMap(tool => {
            const keywords = tool.description.toLowerCase().split(' ');
            return [...keywords, tool.name.toLowerCase()];
        });

        const shouldUse = toolKeywords.some(keyword => question.toLowerCase().includes(keyword));

        console.log(`[${methodName}] Question: "${question}", Should use tool: ${shouldUse}, Matched keywords: ${toolKeywords.filter(kw => question.toLowerCase().includes(kw))}`);

        return shouldUse;
    }
    private async executeToolAgent(question: string, context: string, chatHistory: BaseMessage[]): Promise<string> {
        const methodName = 'executeToolAgent';
        console.log(`[${methodName}] Executing tool agent with question: "${question}"`);

        if (!this.agentExecutor) {
            console.error(`[${methodName}] Tool agent not initialized`);
            throw new Error("Tool agent not initialized");
        }

        try {
            const result = await this.agentExecutor.invoke({
                input: question,
                chat_history: chatHistory,
                context: context,
            });
            console.log(`[${methodName}] Tool agent result:`, result);
            return result.output as string;
        } catch (error) {
            console.error(`[${methodName}] Error executing tool agent:`, error);
            throw error;
        }
    }
    public async refreshVectorStoreOverview(): Promise<void> {
        const currentTime = Date.now();
        if (currentTime - this.lastOverviewUpdate > this.OVERVIEW_UPDATE_INTERVAL) {
            this.vectorStoreOverview = await this.getVectorStoreOverview();
            this.lastOverviewUpdate = currentTime;
            console.log('[refreshVectorStoreOverview] Vector store overview refreshed');
        } else {
            console.log('[refreshVectorStoreOverview] Using cached vector store overview');
        }
    }


    private getDocumentContent(doc: AnyDocument): string {
        if (typeof doc.pageContent === 'string') {
            return doc.pageContent;
        } else if (typeof doc.content === 'string') {
            return doc.content;
        } else {
            console.warn('[getDocumentContent] Unable to extract content from document', doc);
            return 'Content not available';
        }
    }

    private async getDocumentTitlesAndSummaries(sampleDocs: AnyDocument[]): Promise<string> {
        const titlePrompt = `Based on the following document samples, identify any book titles, document titles, main topics or table of contents. If possible, provide a brief summary for each. Present this as a bulleted list:
    
        ${sampleDocs.map(doc => this.getDocumentContent(doc)).join('\n\n')}`;

        const systemMessage = new SystemMessage("You are an AI assistant tasked with identifying titles, table of contents if exist, and summarizing key points from a knowledge base. Format your response using proper HTML tags (<b> for bold, <i> for italic) and ensure tags are properly nested.");
        const humanMessage = new HumanMessage(titlePrompt);

        const response: AIMessage = await invokeModelWithFallback(
            this.summationModel,
            this.chatModel,
            this.utilityModel,
            [systemMessage, humanMessage],
            { initialTimeout: 30000, maxTimeout: 120000, retries: 2 }
        );
        const summary = this.thinkingManager.cleanThinkTags(response.content) as string;

        if (typeof summary !== 'string') {
            throw new Error('Unexpected response type from summarization model');
        }

        // Clean up HTML tags to ensure proper nesting
        return summary.replace(/<b><i>(.*?)<\/b><\/i>/g, '<i><b>$1</b></i>')
            .replace(/<i><b>(.*?)<\/i><\/b>/g, '<b><i>$1</i></b>');
    }

    public async getVectorStoreOverview(): Promise<string> {
        console.log('[getVectorStoreOverview] Checking if overview needs refreshing');

        const currentTime = Date.now();
        if (currentTime - this.lastOverviewUpdate > this.OVERVIEW_UPDATE_INTERVAL || this.vectorStoreOverview === '') {
            console.log('[getVectorStoreOverview] Refreshing vector store overview');

            if (!this.retriever) {
                console.warn('[getVectorStoreOverview] No retriever available');
                return "I don't have access to any specific information at the moment.";
            }

            try {
                // This query is designed to retrieve a broad sample of documents
                const sampleDocs = await this.retriever.invoke("Give me a diverse sample of your contents");

                if (sampleDocs.length === 0) {
                    console.warn('[getVectorStoreOverview] No documents retrieved from vector store');
                    return "I don't have any specific information available at the moment.";
                }

                const titlesAndSummaries = await this.getDocumentTitlesAndSummaries(sampleDocs);

                const overviewPrompt = `Based on the following information about the knowledge base, provide a comprehensive overview:
    
                Titles and Summaries:
                ${titlesAndSummaries}
    
                Additional Content:
                ${sampleDocs.map(doc => this.getDocumentContent(doc)).join('\n\n')}
    
                Please structure the overview as follows:
                1. A brief introduction to the knowledge base.
                2. A list of main topics or areas of knowledge available.
                3. Any specific books or documents identified, with brief descriptions if available.
                4. A concluding statement about the breadth or depth of the knowledge base.`;

                const systemMessage = new SystemMessage("You are an AI assistant tasked with providing a detailed overview of a knowledge base. Your goal is to give users a clear understanding of the information available to them.");
                const humanMessage = new HumanMessage(overviewPrompt);

                const response: AIMessage = await invokeModelWithFallback(
                    this.chatModel,
                    this.summationModel,
                    this.utilityModel,
                    [systemMessage, humanMessage],
                    { initialTimeout: 45000, maxTimeout: 180000, retries: 2 }
                );

                this.vectorStoreOverview = this.thinkingManager.cleanThinkTags(response.content) as string;

                if (typeof this.vectorStoreOverview !== 'string') {
                    throw new Error('Unexpected response type from chat model');
                }

                console.log('[getVectorStoreOverview] Generated new overview:', this.vectorStoreOverview);
                console.log('[getVectorStoreOverview] PromptManager state:', this.promptManager ? 'Initialized' : 'Not initialized');
                this.lastOverviewUpdate = currentTime;
            } catch (error) {
                console.error('[getVectorStoreOverview] Error generating vector store overview:', error);
                return "I'm having trouble accessing my knowledge base at the moment.";
            }
        } else {
            console.log('[getVectorStoreOverview] Using cached vector store overview');
        }

        return this.vectorStoreOverview;
    }
    private async getStandaloneQuestion(
        question: string,
        chatHistory: BaseMessage[],
        interactionType: InteractionType,
        adapter: ContextAdapter
      ): Promise<string> {
        // If the question is already brief and standalone, just return it
        if (question.length < 30 && !question.includes("it") && !question.includes("that") && !question.includes("this") && !question.includes("they")) {
          console.log(`[getStandaloneQuestion] Question already standalone: "${question}"`);
          return question;
        }
      
        const recentHistory = this.getRecentRelevantHistory(chatHistory, 1);
        const historySummary = await this.summarizeHistory(recentHistory, question, 350, interactionType, adapter);
      
        const condensedPrompt = ChatPromptTemplate.fromMessages([
          SystemMessagePromptTemplate.fromTemplate(
            "Your task is to reformat the user's question for use in RAG, into a standalone question that makes sense without additional context. " +
            "IMPORTANT RULES:\n" +
            "1. DO NOT add any information that isn't explicitly in the question or recent context.\n" +
            "2. DO NOT expand terms or add definitions or descriptions.\n" +
            "3. ONLY incorporate pronouns or references from recent context if they're needed for clarity.\n" +
            "4. STRICTLY maintain the exact same level of specificity as the original question.\n" +
            "5. If the question is already standalone (doesn't contain pronouns like 'it', 'this', etc.), return it UNCHANGED.\n" +
            "6. If the question relates to matters in law or rights, be careful in distinguishing between 'lawful' (land jurisdiction) and 'legal' (sea/admiralty jurisdiction). If in doubt, default to 'lawful.' For example, prefer phrases like 'lawful authority,' 'lawful systems,' or 'lawful person.' Avoid using the term 'legal' unless it is clearly appropriate.\n\n" +
            "Examples:\n" +
            "Context: We were discussing Mars.\n" +
            "Question: 'How large is it?' -> 'How large is Mars?'\n\n" +
            "Question: 'What is Terra Australis?' -> 'From the provided context, What is Terra Australis?'\n\n" +
            "Context: We were discussing the book 1984.\n" +
            "Question: 'Who wrote this?' -> 'From the provided context, Who wrote 1984?'\n\n" +
            "Context: We were discussing contracts.\n" +
            "Question: 'Are they legal?' -> 'From the provided context, Are mentioned contracts legal or lawful?'"
          ),
          HumanMessagePromptTemplate.fromTemplate(
            "Recent context: {history}\n\nQuestion: {question}\n\nStandalone question:"
          )
        ]);
      
        const formattedPrompt = await condensedPrompt.formatMessages({
          history: historySummary,
          question: question,
        });
      
        const response: AIMessage = await invokeModelWithFallback(
          this.utilityModel,
          this.chatModel,
          this.summationModel,
          formattedPrompt,
          {
            initialTimeout: 30000,
            maxTimeout: 60000,
            retries: 2
          }
        );
      
        const content = this.thinkingManager.cleanThinkTags(response.content) as string;
        if (typeof content !== 'string') {
          throw new Error('Unexpected response type from standalone question model');
        }
      
        // Additional safeguards
        
        // 1. Check for significant expansion of the question
        if (content.length > question.length * 2 && question.length > 15) {
          console.log(`[getStandaloneQuestion] Rejecting expanded question. Original: "${question}" Expansion: "${content}"`);
          return question;
        }
        
        // 2. Check if the model is trying to add factual information
        const factualExpansionIndicators = [
          "which is", "also known as", "referring to", "defined as", 
          "considered", "recognized as", "historically", "hypothetical",
          "referenced in", "discovered by", "established in"
        ];
        
        const containsFactualExpansion = factualExpansionIndicators.some(phrase => 
          content.toLowerCase().includes(phrase) && !question.toLowerCase().includes(phrase)
        );
        
        if (containsFactualExpansion) {
          console.log(`[getStandaloneQuestion] Detected factual expansion. Original: "${question}" Expansion: "${content}"`);
          return question;
        }
      
        console.log(`[getStandaloneQuestion] Original: "${question}"\nStandalone: "${content}"`);
        return content;
      }
    /**
     * Retrieves the most recent and relevant messages from the chat history.
     * Used to provide context for the current query.
     */
    private getRecentRelevantHistory(chatHistory: BaseMessage[], count: number): BaseMessage[] {
        return chatHistory.slice(-count);
    }

    /**
     * Summarizes the chat history to a concise representation.
     * Used to provide a brief context of the conversation for relevance determination.
     * @param history The full chat history to summarize
     * @param targetLength The desired maximum length of the summary
     * @returns A summarized version of the chat history
     */
    private async summarizeHistory(history: BaseMessage[], question: string, targetLength: number, interactionType: InteractionType, adapter: ContextAdapter): Promise<string> {
        const historyText = history.map(msg => `${msg.getType()}: ${msg.content}`).join('\n');
        return this.summarizeText(historyText, question, targetLength, 'history', interactionType, adapter);
    }

    /**
 * Summarizes a given text (context or history) to a specified target length.
 * Used by getDynamicContext to manage context length.
 */
    private async summarizeText(
        text: string,
        question: string,
        targetLength: number,
        type: 'context' | 'history',
        interactionType: InteractionType,
        adapter: ContextAdapter  // Add adapter as optional parameter
    ): Promise<string> {
        const methodName = 'summarizeText';

        console.warn(methodName, `Summarizing ${type} of length ${text.length} for question: "${question}" interaction type: "${interactionType}" `);

        if (text.length <= targetLength) {
            console.log(methodName, `${type} already within target length. No summarization needed.`);
            return text;
        }

        // Check for active game state
        let systemPrompt = this.promptManager.getSummarizePrompt();

        if (adapter) {
            if (interactionType === 'game') {
                systemPrompt = PromptManager.defaultGameSummarizeSystemPrompt();
            }
        }

        const systemMessage = new SystemMessage(systemPrompt);
        const userMessage = new HumanMessage(
            `User Question: ${question}\n\n` +
            `${type.charAt(0).toUpperCase() + type.slice(1)} to summarize:\n${text}\n\n` +
            `Please provide a summary of the above ${type}, focusing on the key points that are most relevant to the question while also capturing important context and details. ` +
            `The summary should aim to be informative, but try to keep it within ${targetLength} characters. Feel free to be flexible to ensure clarity and completeness.` +
            `Use the following formatting conventions in your response:
            - Surround text with ** for bold
            - Surround text with * for italic
            - Use - at the start of a line for bullet points
            - Use 1., 2., 3., etc. for numbered lists
            - Use > at the start of a line for blockquotes
            
            For headings, use the following format:
            **Main Heading**
            *Subheading*
            
            Provide your summary using these formatting conventions.`
        );


        const messages: BaseMessage[] = [systemMessage, userMessage];

        try {
            const response: AIMessage = await invokeModelWithFallback(
                this.summationModel,
                this.chatModel,
                this.utilityModel,
                messages,
                { initialTimeout: 30000, maxTimeout: 120000, retries: 2 }
            );
            //const summary = response.content as string;
            const summary = this.thinkingManager.cleanThinkTags(response.content as string);


            if (typeof summary !== 'string') {
                throw new Error('Unexpected response type from summarization model');
            }


            console.log(`[summarizeText] Generated summary of length ${summary.length} characters`);

            if (summary.length > targetLength) {
                console.warn(`[summarizeText] Generated summary exceeds target length. Truncating.`);
                return summary.substring(0, targetLength) + '...';
            }

            return summary;
        } catch (error) {
            console.error(`[summarizeText] Error generating ${type} summary:`, error);
            return this.fallbackSummarizeText(text, targetLength);
        }
    }
    private fallbackSummarizeText(context: string, targetLength: number): string {
        // Original summarization method as fallback
        const sentences = context.split(/[.!?]+/).filter(s => s.trim().length > 0);
        let summary = '';
        let currentLength = 0;

        for (const sentence of sentences) {
            if (currentLength + sentence.length > targetLength) {
                if (summary.length === 0) {
                    return sentence.trim() + '...';
                }
                break;
            }
            summary += sentence.trim() + '. ';
            currentLength += sentence.length;
        }
        return summary.trim();
    }


    private assessContextComplexity(context: string): number {
        const wordCount = context.split(/\s+/).length;
        const sentenceCount = Math.max(context.split(/[.!?]+/).length, 1);
        const avgSentenceLength = wordCount / sentenceCount;
        // Adjusted to give more weight to longer sentences
        const complexity = Math.min(Math.max(avgSentenceLength / 20, 0.5), 1);
        console.log(`[assessContextComplexity] Average sentence length: ${avgSentenceLength}, Complexity: ${complexity}`);
        return complexity;
    }

    private assessQuestionComplexity(question: string): number {
        const complexityIndicators = ['what', 'why', 'how', 'explain', 'describe', 'compare', 'analyze', 'evaluate', 'discuss', 'elaborate', 'define', 'interpret', 'synthesize'];
        const wordCount = question.split(/\s+/).length;
        const indicatorCount = complexityIndicators.filter(indicator => question.toLowerCase().includes(indicator)).length;
        // Adjusted to give more weight to indicator words
        const complexity = Math.min((indicatorCount / complexityIndicators.length * 1.5 + wordCount / 20) / 2, 1);
        console.log(`[assessQuestionComplexity] Word count: ${wordCount}, Indicator count: ${indicatorCount}, Complexity: ${complexity}`);
        return complexity;
    }
    /**
     * Retrieves relevant context for a given question based on chat history and reply context.
     * This method queries the retriever, scores documents, and returns the most relevant context.
     */
    public async getRelevantContext(
        question: string,
        chatHistory: BaseMessage[],
        interactionType: InteractionType,
        userId: string,
        adapter: ContextAdapter,
        standaloneQuestion: string, // Moved before optional params
        replyToMessage?: { message_id: number; text: string },
        progressKey?: string
    ): Promise<string> {
        const methodName = 'getRelevantContext';
        console.log(`[${methodName}] Starting for question: "${question}"`);
        console.log(`[${methodName}] Chat history length: ${chatHistory.length}`);
        console.log(`[${methodName}] User ID: ${userId}`);
        console.log(`[${methodName}] Reply to message: ${replyToMessage ? JSON.stringify(replyToMessage) : 'None'}`);

        if (!this.retriever) {
            console.log(`[${methodName}] No retriever available. Returning empty context.`);
            return "";
        }

        // Standalone question is now passed as a parameter
        const standaloneQuestionForCache = standaloneQuestion; // Use the passed parameter

        // Cache keys (now incorporating standaloneQuestion)
        const contextCacheKey = CacheKeys.RelevantContext(userId, standaloneQuestionForCache);
        const queryCacheKey = CacheKeys.ContextualizedQuery(userId, standaloneQuestionForCache);

        console.log(`[${methodName}] Context cache key: ${contextCacheKey}`);
        console.log(`[${methodName}] Query cache key: ${queryCacheKey}`);

        
                // 1. Always compute the contextualized query for the current input question
                console.log(`[${methodName}] Constructing query for current input: "${question}"`);
                const contextualizedQuery = await this.constructContextualizedQuery(question, chatHistory, interactionType, adapter, replyToMessage, progressKey);
                console.log(`[${methodName}] Constructed query: "${contextualizedQuery.substring(0, 100)}..."`);
                // Cache the computed query with a short TTL (e.g., 300 seconds = 5 minutes)
                this.cache.set(queryCacheKey, contextualizedQuery, 300);
                console.log(`[${methodName}] Stored contextualizedQuery in cache with key: ${queryCacheKey}`);
        
                // 2. Check the context cache
                const contextCacheEntry = this.cache.get<{ relevantContext: string; timestamp: number }>(contextCacheKey);
                let relevantContext: string | undefined;
                const currentTime = Date.now();
                const contextCacheDuration = 60 * 60 * 1000; // 1 hour TTL for context
                const isContextCacheValid = contextCacheEntry && (currentTime - contextCacheEntry.timestamp) < contextCacheDuration;
        
                if (isContextCacheValid) {
                    // Cache hit for context
                    console.log(`[${methodName}] Cache hit for relevant context. Age: ${(currentTime - contextCacheEntry.timestamp) / 1000} seconds`);
                    relevantContext = contextCacheEntry.relevantContext;
                } else {
                    // Cache miss or expired for context
                    console.log(`[${methodName}] Cache miss or expired for relevant context. Retrieving new context using current query.`);
        
                    // Retrieve documents using the NEW query computed above
                    if (this.retriever instanceof CustomRetriever) {
                        this.retriever.setRetrievalContext(this.flowId, adapter, progressKey);
                    }
                    console.log(`[${methodName}] Invoking retriever with current contextualized query.`);
                    const docs = await this.retriever.invoke(contextualizedQuery); // Use the just-computed query
                    console.log(`[${methodName}] Retrieved ${docs.length} documents`);
        
                    if (docs.length === 0) {
                        console.log(`[${methodName}] No documents retrieved. Setting empty context.`);
                        relevantContext = "";
                    } else {
                        console.log(`[${methodName}] Scoring and filtering documents.`);
                        const scoredDocs = docs.map(doc => {
                            const relevanceScore = this.calculateRelevanceScore(doc.metadata.score ?? 0);
                            const vectorStoreScore = doc.metadata.score ?? 0;
                            const combinedScore = (relevanceScore * 0.1) + (vectorStoreScore * 0.9);
                            return { content: doc.pageContent, score: combinedScore, metadata: doc.metadata };
                        });
        
                        const relevantDocs = scoredDocs.filter(doc => doc.score >= this.relevanceScoreThreshold);
                        const sortedDocs = relevantDocs.sort((a, b) => b.score - a.score);
                        const topDocs = sortedDocs.slice(0, this.topRelevantDocs);
        
                        console.log(`[${methodName}] Relevant documents: ${relevantDocs.length}, Top documents: ${topDocs.length}`);
        
                        if (topDocs.length === 0) {
                            console.log(`[${methodName}] No documents met the relevance threshold. Setting empty context.`);
                            relevantContext = "";
                        } else {
                            console.log(`[${methodName}] Top document scores:`, topDocs.map(doc => ({
                                score: doc.score,
                                preview: doc.content.substring(0, 50) + '...'
                            })));
                            relevantContext = this.formatRelevantContext(topDocs);
                        }
                    }
        
                    // Store the newly computed context
                    this.cache.set(contextCacheKey, { relevantContext, timestamp: currentTime }, contextCacheDuration); // Use longer TTL for context
                    console.log(`[${methodName}] New relevant context stored in cache.`);
                }
        
                // Ensure relevantContext is defined before returning
                if (relevantContext === undefined) {
                    console.warn(`[${methodName}] relevantContext is undefined at the end. Returning empty string.`);
                    relevantContext = "";
                }
        console.log(`[${methodName}] Relevant context length: ${relevantContext.length} characters`);
        console.log(`[${methodName}] Relevant context preview: ${relevantContext.substring(0, 100)}...`);

        // Reverted: Fact enhancement moved to generateAnswer for better separation of concerns.
        return relevantContext;
    }

    /**
     * Formats the relevant context retrieved from top-scoring documents.
     * Includes relevance scores and metadata in the formatted output.
     * @param topDocs An array of top-scoring documents with their content, score, and metadata
     * @returns A formatted string containing the most relevant context
     */
    // In formatRelevantContext method in ConversationManager.ts
    private formatRelevantContext(topDocs: ScoredDocument[]): string {
        if (topDocs.length === 0) {
            return "No relevant context found.";
        }

        // Format the context for our response generation pipeline
        const formattedContext = topDocs
            .filter(doc => doc.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 8)
            .map(doc => {
                // The critical part - maintain the [Relevance:X.XXX] prefix format
                return `[Relevance: ${doc.score.toFixed(3)}]\n${doc.content}\n--- Metadata: ${JSON.stringify(doc.metadata)}`;
            })
            .join("\n\n");

        // Store the raw documents separately for citation generation
        // This is the new part
        this.cache.set(`raw_docs:${this.flowId}`, {
            documents: topDocs,
            timestamp: Date.now()
        }, 3600); // 1 hour TTL

        return formattedContext;
    }


    public async constructContextualizedQuery(
        question: string,
        chatHistory: BaseMessage[],
        interactionType: InteractionType,
        adapter: ContextAdapter,
        replyToMessage?: { message_id: number; text: string },
        progressKey?: string,
    ): Promise<string> {
        const methodName = 'constructContextualizedQuery';
        console.log(`[${methodName}] Starting contextualization for question: "${question}"`);
        console.log(`[${methodName}] Chat history length: ${chatHistory.length}`);
        console.log(`[${methodName}] Reply to message: ${replyToMessage ? JSON.stringify(replyToMessage) : 'None'}`);
        if (progressKey && adapter) {
            console.log(`[${methodName}:${this.flowId}] Updating progress: constructContextualizedQuery`);
            await this.updateProgress(adapter, progressKey, "📜 Constructing and contextualizing the query...");
            console.log(`[${methodName}] Progress updated for progressKey: ${progressKey}`);
        }
        let contextualizedQuery = question;
        let contextParts: string[] = [];

        // Removed redundant fact enhancement call here. Facts are now added in generateAnswer.

        // Add recent chat history context
        const recentHistory = this.getRecentRelevantHistory(chatHistory, 6); // Get last 6 messages
        console.log(`[${methodName}] Recent history messages: ${recentHistory.length}`);
        let historySummary = '';
        if (recentHistory.length > 0) {
            console.log(`[${methodName}] Summarizing chat history`);
            historySummary = await this.summarizeHistory(recentHistory, question, 4000, interactionType, adapter);
            historySummary = `Recent conversation summary:\n${historySummary}\n\n`;
        } else {
            console.log(`[${methodName}] No recent history to add to context`);
        }

        // Handle reply context
        if (replyToMessage && (!recentHistory.length || recentHistory[recentHistory.length - 1].content !== replyToMessage.text)) {
            console.log(`[${methodName}] Processing reply context`);
            const summarizedReply = await this.summarizeText(replyToMessage.text, question, 4000, 'context', interactionType, adapter);
            contextParts.push(`Replied to:\n${summarizedReply}`);
        }

        let contextPrefix = historySummary;
        if (contextParts.length > 0) {
            const additionalContext = contextParts.join('\n\n');
            contextPrefix += `Additional context:\n${additionalContext}\n\n`;
        }

        contextualizedQuery = `${contextPrefix}User Question: ${question}`;
        console.log(`[${methodName}] Final contextualized query: ${contextualizedQuery.substring(0, 200)}...`);

        return contextualizedQuery;
    }

    private calculateRelevanceScore(vectorStoreScore: number): number {
        // Apply a simple normalization if needed
        return Math.min(Math.max(vectorStoreScore, 0), 1);
    }

    private formatCitationsWithGenericFormat(citations: SourceCitation[]): string {
        let formattedCitations = "**Sources:**\n";
        citations.forEach((citation, index) => {
            formattedCitations += `${index + 1}. **${this.escapeSpecialChars(citation.author)}**: "${this.escapeSpecialChars(citation.title)}", File: ${this.escapeSpecialChars(citation.fileName)}, Relevance: ${citation.relevance.toFixed(3)}\n`;
        });
        return formattedCitations;
    }

    private escapeSpecialChars(text: string): string {
        return text.replace(/[*_[\]()~`>#+=|{}.!-]/g, '\\$&');
    }
    public shouldPostProcess(question: string, interactionType: InteractionType): boolean {
        const controversialKeywords = [
            // Political topics
            'politics', 'government', 'election', 'democracy', 'socialism', 'communism', 'capitalism',
            'liberal', 'conservative', 'republican', 'democrat', 'fascism', 'anarchism',

            // Religious topics
            'religion', 'god', 'atheism', 'islam', 'christianity', 'judaism', 'hinduism', 'buddhism',
            'scientology', 'cult',

            // Social issues
            'racism', 'sexism', 'discrimination', 'inequality', 'gender', 'sexuality', 'lgbtq',
            'abortion', 'immigration', 'refugee', 'climate change', 'global warming',

            // Controversial concepts
            'conspiracy', 'theory', 'controversial', 'debate', 'opinion', 'bias', 'propaganda',
            'fake news', 'misinformation', 'disinformation',

            // Legal and ethical issues
            'sovereign citizen', 'claims', 'law', 'lawful', 'legal', 'crime', 'justice', 'ethics', 'morality', 'human rights',
            'privacy', 'censorship', 'freedom of speech', 'trust', 'liability', 'tort', 'contract', 'trustee', 'legal authority',
            'lawful person', 'authority', 'court', 'jurisdiction',

            // Health and science controversies
            'vaccine', 'autism', 'gmo', 'alternative medicine', 'evolution', 'flat earth',

            // Economic issues
            'poverty', 'wealth', 'tax', 'welfare', 'minimum wage', 'union', 'strike',

            // Historical controversies
            'colonialism', 'slavery', 'genocide', 'war crime', 'holocaust',

            // Technology and society
            'artificial intelligence', 'surveillance', 'data privacy', 'cybersecurity',

            // Cultural issues
            'cultural appropriation', 'cancel culture', 'political correctness',

            // Substance-related topics
            'drugs', 'alcohol', 'addiction', 'legalization',

            // Conflict-related terms
            'war', 'terrorism', 'extremism', 'radicalization',

            // Media and entertainment controversies
            'censorship', 'obscenity', 'violence in media',

            // Environmental issues
            'pollution', 'deforestation', 'endangered species', 'nuclear energy'
        ];

        // Check if any of the keywords are present in the question
        const containsControversialKeyword = controversialKeywords.some(keyword =>
            question.toLowerCase().includes(keyword.toLowerCase())
        );

        // Return true if a controversial keyword is found or if it's an explanatory question
        return containsControversialKeyword || interactionType === 'explanatory_question';
    }

    public async postProcessResponse(
        response: string,
        question: string,
        interactionType: InteractionType
    ): Promise<string> {
        const methodName = 'postProcessResponse';
        console.log(`[${methodName}] Entered PostProcessResponse`);

        const postProcessPrompt = ChatPromptTemplate.fromMessages([
            SystemMessagePromptTemplate.fromTemplate(
                `Review the following response and adjust it to:
             1. Remove any biased language or subjective opinions.
             2. Ensure all viewpoints are presented objectively, without favoring any particular stance.
             3. Importantly, Remove any disclaimers, caveats, or warnings about the reliability or nature of the information.
             4. Present the information directly, without qualifiers like "it's important to note" or "keep in mind". If they exsit, remove them.
             5. Remove any new information or interpretations not present in the original response.
             6. Maintain the core factual content of the original response.
             7. For matters relating to law or rights, clearly distinguish "lawful" (land jurisdiction) from "legal" (sea/admiralty jurisdiction), aligning with:
                - Lawful: natural rights, constitutional matters, and the people's authority.
                - Legal: corporate entities, administrative law, and statutory obligations.
                - Remain neutral unless the question specifies a particular stance.
             8. Enhance readability with emojis and Markdown without altering core content.
      
             Only make changes if they remove opinions or disclaimers, or if they clarify jurisdictional distinctions. 
             If the response is already neutral and jurisdictionally clear, return it unchanged.`
            ),
            HumanMessagePromptTemplate.fromTemplate(
                "Question: {question}\n" +
                "Interaction Type: {interactionType}\n\n" +
                "Response to review: {response}\n\n" +
                "Adjusted response:"
            )
        ]);

        const formattedPrompt = await postProcessPrompt.formatMessages({ question, interactionType, response });
        const postProcessedResponse: AIMessage = await invokeModelWithFallback(
            this.summationModel,
            this.chatModel,
            this.utilityModel,
            formattedPrompt,
            { initialTimeout: 30000, maxTimeout: 120000, retries: 2 }
        );
        //let content = postProcessedResponse.content as string;
        const content = this.thinkingManager.cleanThinkTags(postProcessedResponse.content) as string;

        if (typeof content !== 'string') {
            throw new Error('Unexpected response type from summarization model');
        }

        return content;
    }

    private estimateTokenCount(messages: BaseMessage[]): number {
        // This is a very rough estimate. You might want to use a more accurate tokenizer.
        return messages.reduce((count, msg) => count + (msg.content as string).split(/\s+/).length, 0);
    }

    private formatChatHistory(chatHistory: BaseMessage[]): string {
        return chatHistory.map(msg => `${msg.getType()}: ${(msg.content as string).substring(0, 50)}...`).join('\n');
    }

    private async responseIncludesContext(response: string, context: string, adapter?: ContextAdapter, progressKey?: string): Promise<boolean> {
        const methodName = 'responseIncludesContext';

        // Helper function to validate and parse rating
        const parseRating = (content: string): number | null => {
            const rating = parseInt(content.trim());
            return !isNaN(rating) && rating >= 1 && rating <= 5 ? rating : null;
        };

        // Helper function to get rating with one retry
        const getRatingWithRetry = async (prompt: ChatPromptTemplate): Promise<number | null> => {
            const messages = await prompt.formatMessages({ context, response });

            // First try
            const result = await invokeModelWithFallback(
                this.summationModel,
                this.utilityModel,
                this.chatModel,
                messages,
                { initialTimeout: 30000, maxTimeout: 120000, retries: 1 }
            );
            let rating = parseRating(
                this.thinkingManager.cleanThinkTags(result.content || '') as string
            );
            // If first try didn't return a valid number, give one more chance
            if (rating === null) {
                console.log(`[${methodName}] Invalid rating received: "${result.content}". Retrying with explicit numeric instruction.`);

                // Add explicit instruction for retry
                const retryPrompt = ChatPromptTemplate.fromMessages([
                    SystemMessagePromptTemplate.fromTemplate(
                        `Your previous response was invalid. You MUST return ONLY a number from 1 to 5.
                        No explanation, no other text. Just the number.
                        Return ONLY 1, 2, 3, 4, or 5.`
                    ),
                    ...messages
                ]);

                const retryResult = await invokeModelWithFallback(
                    this.utilityModel,
                    this.summationModel,
                    this.chatModel,
                    await retryPrompt.formatMessages({ context, response }),
                    { initialTimeout: 30000, maxTimeout: 100000, retries: 1 }
                );
                rating = parseRating(
                    this.thinkingManager.cleanThinkTags(retryResult.content || '') as string
                );
            }

            return rating;
        };

        try {
            const ratingPrompt = ChatPromptTemplate.fromMessages([
                SystemMessagePromptTemplate.fromTemplate(
                    `Rate from 1-5 how well this response incorporates the key information from its source context.
                    Return ONLY the number 1-5.`
                ),
                HumanMessagePromptTemplate.fromTemplate(
                    `Context:
                    {context}
     
                    Response:
                    {response}
     
                    Rating (1-5):`
                )
            ]);

            const rating = await getRatingWithRetry(ratingPrompt);

            if (rating === null) {
                console.log(`[${methodName}] Failed to get valid rating after retry. Using fallback.`);
                if (progressKey && adapter) {
                    await this.updateProgress(adapter, progressKey, "⁉️ Failed to get valid rating after retry. Using fallback.");
                    console.log(`[${methodName}] Progress updated for progressKey: ${progressKey}`);
                }
                return this.fallbackContextCheck(response, context);
            }

            console.log(`[${methodName}] Final rating: ${rating}/5`);
            if (progressKey && adapter) {
                await this.updateProgress(adapter, progressKey, `🎯 Context relevance rating: ${rating}/5`);
                console.log(`[${methodName}] Progress updated for progressKey: ${progressKey}`);
            }
            return rating >= 3;

        } catch (error) {
            console.error(`[${methodName}] Error checking context inclusion:`, error);
            return this.fallbackContextCheck(response, context);
        }
    }

    private fallbackContextCheck(response: string, context: string): boolean {
        const methodName = 'fallbackContextCheck';
        try {
            const contextWords = context.toLowerCase().split(/\s+/);
            // Improved significant word filtering:
            // - Words longer than 4 chars
            // - Not in stopwords
            // - Includes numbers
            const significantWords = contextWords.filter(word =>
                (word.length > 4 && !this.promptManager.stopWords.has(word)) ||
                /\d+/.test(word)  // Include numbers as significant
            );

            const responseLower = response.toLowerCase();
            const matchedWords = significantWords.filter(word =>
                responseLower.includes(word)
            );

            const matchRatio = matchedWords.length / significantWords.length;

            console.log(`[${methodName}] Match ratio: ${matchRatio} (${matchedWords.length}/${significantWords.length} words)`);

            // Slightly lower threshold (12%) for fallback
            return matchRatio >= 0.12;
        } catch (error) {
            console.error(`[${methodName}] Error in fallback check:`, error);
            return false;
        }
    }

    private async updateProgress(adapter: ContextAdapter, progressKey: string, stage: string): Promise<boolean> {
        if (adapter.isTelegramMessage()) {
            console.log(`[ConversationManager:${this.flowId}] Updating progress: ${stage}`);
            return await adapter.updateProgress(this.flowId, progressKey, stage);
        }
        return false;
    }

    private validatePromptManager(): void {
        const debug = this.promptManager.getGameSystemPromptDebug();
        if (!debug.hasPrompt) {
            console.warn('Game system prompt not properly initialized in PromptManager');
        }
        console.log('PromptManager validation:', {
            hasGamePrompt: debug.hasPrompt,
            gamePromptPreview: debug.preview?.substring(0, 50)
        });
    }


    /**
   * Generates a conversation-based game question for "Who Wants to be a Millionaire"
   * using ONLY the recent non-game "RAG" conversation..
   *
   * The prompt instructs the model to output the correctAnswer as a letter (A–D).
   * This method then converts that letter to a numeric index.
   *
   * @param difficulty - The desired difficulty level.
   * @param chatHistory - The chat history used as context.
   * @returns A JSON string representing a Question.
   */
    public async generateGameQuestion(
        adapter: ContextAdapter,
        difficulty: QuestionDifficulty,
        chatHistory: BaseMessage[],
        requiredCount: number = 15,
        maxAttempts: number = 4
    ): Promise<string> {
        const methodName = 'generateGameQuestion';
        let attempts = 0;
        let validatedQuestions: Question[] = [];

        // Helper to extract only the JSON part from the response
        const extractJSON = (text: string): string => {
            const firstBrace = text.indexOf('{');
            const lastBrace = text.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                return text.substring(firstBrace, lastBrace + 1);
            }
            return text;
        };

        while (attempts < maxAttempts) {
            try {
                const remainingCount = requiredCount - validatedQuestions.length;
                console.log(
                    `[${methodName}] Attempt ${attempts + 1}/${maxAttempts} to generate ${remainingCount} questions`
                );

                // Calculate difficulty distribution for remaining questions
                const difficultyBreakdown = this.getDifficultyBreakdown(
                    validatedQuestions.length,
                    requiredCount
                );


                // Construct the prompt with strict instructions
                const prompt = ChatPromptTemplate.fromMessages([
                    SystemMessagePromptTemplate.fromTemplate(
                        `Generate ${remainingCount} well thought out and unique questions for Who Wants to be a Millionaire.
                      Your entire response must be JSON objects with the following exact structure:
                      ${difficultyBreakdown}
                      
                      Rules for Question Generation:
                      1. Each question MUST be a unique topic/subject based on the provided conversation context (that is not game related).
                      2. Each question MUST have EXACTLY ONE correct answer - no ambiguity allowed
                      3. All other options must be clearly incorrect but plausible
                      4. Options should not overlap in meaning
                      5. Avoid subjective questions or matters of opinion
                      6. Questions should be factual and verifiable
                      7. Options should be similar in length and style
                      8. Avoid using "All of the above" or "None of the above"
                      9. Each option should be unique and mutually exclusive
                      
                      Question Format Requirements:
                      - Clear, unambiguous wording
                      - Four distinct multiple-choice options (A, B, C, D)
                      - One definitively correct answer
                      - Appropriate difficulty level
                      - Brief, clear explanation of why the correct answer is right
                
      
                        Respond ONLY with a proper JSON object in this exact format:
                            {{
                                "questions": [
                                    {{
                                        "question": "Question based on the conversation?",
                                        "options": [
                                            "A) First option from conversation",
                                            "B) Second option from conversation",
                                            "C) Third option from conversation",
                                            "D) Fourth option from conversation"
                                        ],
                                        "correctAnswer": "A",
                                        "explanation": "Explanation referencing the conversation",
                                        "category": "Topic from conversation",
                                        "difficulty": "${difficulty}",
                                        "conversationReference": "Brief quote or reference to relevant part of conversation"
                                    }}
                                ]
                            }}
            
                            
                            ⚠️ Critical Requirements:
                            - Ensure ONLY ONE option can be correct
                            - Follow exact JSON format
                            - No text outside JSON structure`
                    ),
                    new MessagesPlaceholder("chat_history")
                ]);

                // Invoke the model with fallback mechanism
                const response = await invokeModelWithFallback(
                    this.SpModel,
                    this.chatModel,
                    this.summationModel,
                    await prompt.formatMessages({ chat_history: chatHistory }),
                    { initialTimeout: 240000, maxTimeout: 300000, retries: 2 }
                );

                // Clean the response and extract the JSON portion
                let cleanedContent = this.thinkingManager.cleanThinkTags(response.content) as string;
                cleanedContent = extractJSON(cleanedContent);

                // Attempt to parse the cleaned JSON string
                let parsedResponse;
                try {
                    parsedResponse = JSON.parse(cleanedContent);
                } catch (error) {
                    console.error(`[${methodName}] 🚨 Failed to parse JSON:`, cleanedContent);
                    attempts++;
                    continue; // Retry if parsing fails
                }

                // Validate the JSON structure and content
                const validation = await this.validateQuestionFormat(
                    JSON.stringify(parsedResponse),
                    requiredCount,
                    validatedQuestions
                );
                validatedQuestions = validation.questions;

                if (!validation.needsMore) {
                    console.log(`[${methodName}] Successfully generated all ${requiredCount} questions`);
                    await adapter.replyWithAutoDelete(`Successfully generated all ${requiredCount} questions 👍`, 60000);
                    return JSON.stringify(validation.questions);
                }

                console.log(`[${methodName}] Need ${validation.remaining} more questions`);
                await adapter.replyWithAutoDelete(`Mate! just ${validation.remaining} more questions....`, 60000);
                await adapter.replyWithAutoDelete("⌛️", 40000);


                console.log(`[${methodName}] Current questions:`, JSON.stringify(validatedQuestions, null, 2));
                attempts++;
            } catch (error) {
                console.error(`[${methodName}] 🤔 Error in attempt ${attempts + 1}:`, error);
                attempts++;
            }
        }

        // Fallback: Fill remaining questions if necessary
        while (validatedQuestions.length < requiredCount) {
            const fallbackQuestion = this.getFallbackQuestion(validatedQuestions.length + 1);
            if (!validatedQuestions.some(q => q.question === fallbackQuestion.question)) {
                validatedQuestions.push(fallbackQuestion);
            }
        }

        return JSON.stringify(validatedQuestions);
    }


    private getDifficultyBreakdown(currentCount: number, totalRequired: number): string {
        const methodName = 'getDifficultyBreakdown';

        // Define total numbers needed for each difficulty
        const distribution = {
            easy: 5,
            medium: 5,
            hard: 3,
            very_hard: 2
        };

        // Count existing questions by difficulty
        const existing = {
            easy: 0,
            medium: 0,
            hard: 0,
            very_hard: 0
        };

        // Calculate what's still needed
        let breakdown = '';
        if (currentCount === 0) {
            // If no questions yet, return full distribution
            breakdown = `- Easy questions: ${distribution.easy}
                        - Medium questions: ${distribution.medium}
                        - Hard questions: ${distribution.hard}
                        - Very Hard questions: ${distribution.very_hard}`;
        } else {
            // Calculate remaining needs
            const remaining = {
                easy: Math.max(0, distribution.easy - existing.easy),
                medium: Math.max(0, distribution.medium - existing.medium),
                hard: Math.max(0, distribution.hard - existing.hard),
                very_hard: Math.max(0, distribution.very_hard - existing.very_hard)
            };

            // Only include difficulties that still need questions
            const needs = [];
            if (remaining.easy > 0) needs.push(`Easy questions: ${remaining.easy}`);
            if (remaining.medium > 0) needs.push(`Medium questions: ${remaining.medium}`);
            if (remaining.hard > 0) needs.push(`Hard questions: ${remaining.hard}`);
            if (remaining.very_hard > 0) needs.push(`Very Hard questions: ${remaining.very_hard}`);


            breakdown = needs.map(need => `- ${need}`).join('\n');
            console.warn(`[${methodName}] Difficulty Breakdown: ${breakdown}`);

        }

        return breakdown;
    }


    private convertAnswerToIndex(answer: string): number {
        console.warn(`[CM:convertAnswerToIndex] Received answer: "${answer}"`);

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
    private validateQuestionFormat(
        response: string,
        requiredCount: number = 15,
        existingQuestions: Question[] = []
    ): Promise<{
        questions: Question[],
        needsMore: boolean,
        remaining: number
    }> {
        const methodName = 'validateQuestionFormat';

        try {
            console.log(`[${methodName}] Processing response of length ${response.length}`);
            const cleanedJSON = this.cleanJSON(response);
            let parsed;
            let validQuestions: Question[] = [];

            try {
                parsed = JSON.parse(cleanedJSON);
                if (parsed.questions && Array.isArray(parsed.questions)) {
                    console.log(`[${methodName}] Found ${parsed.questions.length} questions to validate`);
                    validQuestions = this.processQuestions(parsed.questions);
                    console.log(`[${methodName}] ${validQuestions.length} questions passed validation`);
                }
            } catch (parseError) {
                console.error(`[${methodName}] Initial parse failed, attempting recovery`, parseError);
                try {
                    const recovered = this.recoverCompleteQuestions(cleanedJSON);
                    parsed = JSON.parse(recovered);
                    if (parsed.questions && Array.isArray(parsed.questions)) {
                        validQuestions = this.processQuestions(parsed.questions);
                        console.log(`[${methodName}] Recovered ${validQuestions.length} valid questions`);
                    }
                } catch (recoveryError) {
                    console.error(`[${methodName}] Recovery failed:`, recoveryError);
                }
            }

            // Important: If we already have enough questions, don't ask for more
            const allQuestions = [...existingQuestions, ...validQuestions];
            const remaining = Math.max(0, requiredCount - allQuestions.length);

            console.log(`[${methodName}] Final results:`, {
                existing: existingQuestions.length,
                new: validQuestions.length,
                total: allQuestions.length,
                remaining,
                required: requiredCount
            });

            if (allQuestions.length >= requiredCount) {
                console.log(`[${methodName}] ✅ Have all required questions (${allQuestions.length}/${requiredCount})`);
            }

            return Promise.resolve({
                questions: allQuestions,
                needsMore: remaining > 0,
                remaining
            });

        } catch (error) {
            console.error(`[${methodName}] Validation error:`, error);
            return Promise.resolve({
                questions: existingQuestions,
                needsMore: true,
                remaining: requiredCount - existingQuestions.length
            });
        }
    }

    private processQuestions(questions: any[]): Question[] {
        console.log(`Processing ${questions.length} questions`);
        let validCount = 0;
        let invalidCount = 0;

        const processed = questions
            .filter((q: QuestionData) => {
                const isValid = this.isValidQuestionData(q);
                if (isValid) validCount++; else invalidCount++;
                return isValid;
            })
            .map((q: QuestionData) => {
                // Validate difficulty is one of the allowed values
                const difficulty: QuestionDifficulty =
                    ['easy', 'medium', 'hard', 'very_hard'].includes(q.difficulty)
                        ? q.difficulty as QuestionDifficulty
                        : 'medium'; // Default fallback

                return {
                    question: q.question,
                    options: q.options,
                    correctAnswer: typeof q.correctAnswer === 'string' ?
                        this.convertAnswerToIndex(q.correctAnswer) : q.correctAnswer,
                    explanation: q.explanation,
                    category: q.category,
                    difficulty,
                    conversationReference: q.conversationReference,
                    usedLifelines: []
                };
            });
        console.log(`Processed questions: ${validCount} valid, ${invalidCount} invalid`);
        return processed;
    }

    private cleanJSON(json: string): string {
        const methodName = 'cleanJSON';

        // Remove markdown code block markers
        let cleaned = json.replace(/```json\n?/g, '').replace(/```\n?/g, '');

        // Basic cleaning
        cleaned = cleaned.trim();

        console.log(`[${methodName}] Cleaned JSON, length: ${cleaned.length}`);
        return cleaned;
    }

    private recoverCompleteQuestions(partialJson: string): string {
        const methodName = 'recoverCompleteQuestions';
        const validQuestions: any[] = [];

        // Pattern to match complete question objects including variation in spacing/formatting
        const questionPattern = /\{\s*"question"[\s\S]*?"conversationReference"\s*:\s*"[^"]*"\s*\}/g;
        const matches = partialJson.match(questionPattern);

        if (matches) {
            console.log(`[${methodName}] Found ${matches.length} potential question objects`);

            // Try to parse each question object individually
            matches.forEach((questionStr, index) => {
                try {
                    const question = JSON.parse(questionStr);
                    // Verify it has all required fields
                    if (this.isValidQuestionData(question)) {
                        validQuestions.push(question);
                        console.log(`[${methodName}] Question ${index + 1} is valid`);
                    }
                } catch (error) {
                    console.warn(`[${methodName}] Failed to parse question ${index + 1}:`, error);
                }
            });
        }

        if (validQuestions.length === 0) {
            // Try more lenient pattern if no valid questions found
            const lenientPattern = /\{\s*"question"[\s\S]*?("difficulty"\s*:\s*"[^"]*")\s*\}/g;
            const lenientMatches = partialJson.match(lenientPattern);

            if (lenientMatches) {
                console.log(`[${methodName}] Found ${lenientMatches.length} potential questions with lenient matching`);
                lenientMatches.forEach((questionStr, index) => {
                    try {
                        const fixedStr = questionStr.replace(/,\s*$/, ''); // Remove trailing comma
                        const question = JSON.parse(fixedStr);
                        if (this.isValidQuestionData(question)) {
                            validQuestions.push(question);
                            console.log(`[${methodName}] Question ${index + 1} is valid (lenient match)`);
                        }
                    } catch (error) {
                        console.warn(`[${methodName}] Failed to parse lenient question ${index + 1}`);
                    }
                });
            }
        }

        console.log(`[${methodName}] Successfully recovered ${validQuestions.length} valid questions`);

        if (validQuestions.length === 0) {
            throw new Error('No valid questions could be recovered');
        }

        return JSON.stringify({ questions: validQuestions });
    }


    private isValidQuestionData(data: QuestionData): boolean {
        try {
            // Check if data exists and is an object
            if (!data || typeof data !== 'object') {
                console.log('Data is not an object');
                return false;
            }

            // Required fields with type checking
            const validations = [
                // Question must be a non-empty string
                {
                    field: 'question',
                    check: () => typeof data.question === 'string' && data.question.trim().length > 0
                },
                // Options must be an array of exactly 4 non-empty strings
                {
                    field: 'options',
                    check: () => Array.isArray(data.options) &&
                        data.options.length === 4 &&
                        data.options.every((opt: string) => typeof opt === 'string' && opt.trim().length > 0)
                },
                // correctAnswer can be either a number (0-3) or a letter (A-D)
                {
                    field: 'correctAnswer',
                    check: () => {
                        if (typeof data.correctAnswer === 'number') {
                            return data.correctAnswer >= 0 && data.correctAnswer <= 3;
                        }
                        if (typeof data.correctAnswer === 'string') {
                            return ['A', 'B', 'C', 'D'].includes(data.correctAnswer);
                        }
                        return false;
                    }
                },
                // difficulty must be one of the allowed values
                {
                    field: 'difficulty',
                    check: () => typeof data.difficulty === 'string' &&
                        ['easy', 'medium', 'hard', 'very_hard'].includes(data.difficulty)
                },
                // explanation must be a non-empty string
                {
                    field: 'explanation',
                    check: () => typeof data.explanation === 'string' && data.explanation.trim().length > 0
                },
                // category must be a non-empty string
                {
                    field: 'category',
                    check: () => typeof data.category === 'string' && data.category.trim().length > 0
                },
                // conversationReference must be a non-empty string
                {
                    field: 'conversationReference',
                    check: () => typeof data.conversationReference === 'string' && data.conversationReference.trim().length > 0
                }
            ];

            // Run all validations
            for (const validation of validations) {
                if (!validation.check()) {
                    console.log(`Validation failed for field: ${validation.field}`);
                    return false;
                }
            }

            return true;
        } catch (error) {
            console.error('Error in question validation:', error);
            return false;
        }
    }

    private getFallbackQuestion(level: number): Question {
        const difficulties: Record<number, QuestionDifficulty> = {
            1: 'easy', 2: 'easy', 3: 'easy', 4: 'easy', 5: 'easy',
            6: 'medium', 7: 'medium', 8: 'medium', 9: 'medium', 10: 'medium',
            11: 'hard', 12: 'hard', 13: 'hard',
            14: 'very_hard', 15: 'very_hard'
        };

        return {
            question: this.getFallbackQuestionForLevel(level),
            options: [
                "A) Who Wants to be a Millionaire",
                "B) Jeopardy",
                "C) Trivial Pursuit",
                "D) Family Feud"
            ],
            correctAnswer: 0,
            explanation: "This is a fallback question due to generation error.",
            category: "Game Information",
            difficulty: difficulties[level] || 'easy',
            usedLifelines: []
        };
    }

    private getFallbackQuestionForLevel(level: number): string {
        const questions = [
            "What game show are we currently playing?",
            "What happens when you reach a safe haven in this game?",
            "How many lifelines are available in this game?",
            "What is the top prize in Who Wants to be a Millionaire?",
            // Add more fallback questions as needed
        ];
        return questions[level % questions.length];
    }

    public async shouldSuggestPattern(
        input: string,
        interactionType: InteractionType,
        context: MessageContext
    ): Promise<boolean> {
        const methodName = 'shouldSuggestPattern';

        console.warn(`[${methodName}] Entered shouldSuggestPattern`);

        // Enhance file detection to be more specific
        const hasFile = context.raw.message ? (
            'document' in context.raw.message ||
            'photo' in context.raw.message ||
            'video' in context.raw.message ||
            'voice' in context.raw.message ||
            'audio' in context.raw.message
        ) : false;

        // Get file type if present
        const fileType = hasFile ? this.getFileType(context.raw.message) : undefined;

        const isLongText = input.length > 500;
        const hasCodeBlocks = input.includes('```');
        const hasUrls = /https?:\/\/[^\s]+/.test(input);

        return (
            hasFile ||
            isLongText ||
            hasCodeBlocks ||
            (hasUrls && input.length > 200)
        );
    }

    private async getPatternSuggestions(
        input: string,
        interactionType: InteractionType,
        adapter: ContextAdapter
    ): Promise<void> {
        const patternAgent = this.agentManager.getAgent('pattern') as PatternPromptAgent;
        if (!patternAgent) return;

        const suggestion = await patternAgent.suggestPattern(input, "", interactionType);
        if (!suggestion) return;

        let message = `📝 I notice this content might benefit from specialized processing:\n\n`;
        message += `*Suggested Pattern:* ${suggestion.pattern}\n`;
        message += `*Category:* ${suggestion.category}\n`;
        message += `*Confidence:* ${Math.round(suggestion.confidence * 100)}%\n\n`;
        message += `*Description:* ${suggestion.description}\n\n`;

        if (suggestion.reasoning) {
            message += `*Reasoning:* ${suggestion.reasoning}\n\n`;
        }

        // Create keyboard using Markup and explicitly get reply_markup
        const inlineKeyboard = Markup.inlineKeyboard([
            [Markup.button.callback(`✨ Use ${suggestion.pattern}`, `pattern_use:${suggestion.pattern}`)],
            ...(suggestion.alternativePatterns?.length ? [
                suggestion.alternativePatterns.slice(0, 2).map(p =>
                    Markup.button.callback(`🔄 Try ${p}`, `pattern_use:${p}`)
                )
            ] : []),
            [
                Markup.button.callback('📋 More Patterns', 'pattern_more'),
                Markup.button.callback('⏭️ Process Normally', 'pattern_skip')
            ]
        ]).reply_markup;  // Important: get reply_markup property

        await adapter.reply(message, {
            parse_mode: 'Markdown',
            reply_markup: inlineKeyboard
        });
    }

    private getFileType(message: any): string | undefined {
        if ('document' in message) return message.document.mime_type;
        if ('photo' in message) return 'image/jpeg';
        if ('video' in message) return 'video/mp4';
        if ('voice' in message) return 'audio/ogg';
        if ('audio' in message) return message.audio.mime_type;
        return undefined;
    }
    private getFileTypeFromContext(context: MessageContext): string | undefined {
        const message = context.raw.message;
        if (!message) return undefined;

        if ('document' in message) {
            return message.document.mime_type;
        }
        if ('photo' in message) {
            return 'image/jpeg';
        }
        if ('video' in message) {
            return 'video/mp4';
        }
        if ('voice' in message) {
            return 'audio/ogg';
        }
        if ('audio' in message) {
            return message.audio.mime_type;
        }
        return undefined;
    }

    /**
 * Stores input data for pattern processing
 * @param userId The user ID
 * @param input The input to store
 */
    private storePatternInput(userId: string, input: string): void {
        // First, check if this is a pattern suggestion message
        const isPatternSuggestion = input.includes('📝 I notice this content might benefit from specialized processing') ||
            input.includes('Suggested Pattern:');

        if (isPatternSuggestion) {
            console.warn(`[storePatternInput] Attempted to store a pattern suggestion message as original input for user ${userId}`);

            // Check if we already have original input that's not a suggestion
            const cacheKey = `pattern_data:${userId}`;
            const existingData = this.cache.get<PatternData>(cacheKey);

            if (existingData?.originalInput &&
                !existingData.originalInput.includes('📝 I notice this content') &&
                !existingData.originalInput.includes('Suggested Pattern:')) {

                console.log(`[storePatternInput] Keeping existing original input (${existingData.originalInput.length} chars)`);
                return; // Keep the existing original input
            }

            // If we don't have valid original input, check recent history
            console.log(`[storePatternInput] Searching for real original content...`);

            // Store the suggestion separately for reference
            this.cache.set(`pattern_suggestion:${userId}`, input, 3600);

            // Don't store the suggestion as originalInput
            // We'll handle fallback in pattern processing methods
            return;
        }

        // Regular case - not a pattern suggestion
        const cacheKey = `pattern_data:${userId}`;
        let patternData = this.cache.get<PatternData>(cacheKey) || {
            originalInput: input,
            processedOutputs: {},
            currentPatternState: {}
        };

        // Update input
        patternData.originalInput = input;

        // Store with extended TTL for large content
        this.cache.set(cacheKey, patternData, 3600); // 1 hour

        console.log(`[storePatternInput] Stored input for user ${userId}, length: ${input.length}`);
    }
    public async sendDocument(
        chatId: number | string,
        document: string | { source: string | Buffer },
        options: any = {}
    ): Promise<any> {
        console.log(`Entering sendDocument`);

        try {
            // Handle different document formats
            let documentToSend: string | InputFile;

            if (typeof document === 'string') {
                // If it's a string, use it directly
                documentToSend = document;
            } else if (document && typeof document === 'object' && 'source' in document) {
                // If it has a source property
                if (typeof document.source === 'string') {
                    // String source - use as path
                    documentToSend = document.source;
                } else if (Buffer.isBuffer(document.source)) {
                    // Buffer source - create input file with buffer
                    documentToSend = { source: document.source };
                } else {
                    // Fallback
                    throw new Error('Invalid document source format');
                }
            } else {
                throw new Error('Invalid document format');
            }

            // Call the Telegram API with the correctly formatted document
            return await this.bot!.telegram.sendDocument(chatId, documentToSend, options);
        } catch (error) {
            console.error(`Error in sendDocument:`, error);
            throw error;
        }
    }

    /**
    * Updates the interaction type and context requirement based on question analysis
    * @param questionAnalysis The question analysis result
    * @param baseInteractionType The initial interaction type
    * @param baseContextRequirement The initial context requirement
    * @returns Updated interaction details
    */
    public updateInteractionFromQuestionAnalysis(
        questionAnalysis: QuestionAnalysisResult,
        baseInteractionType: InteractionType,
        baseContextRequirement: ContextRequirement
    ): { interactionType: InteractionType, contextRequirement: ContextRequirement } {
        const methodName = 'updateInteractionFromQuestionAnalysis';

        // If it's not confidently a question, don't modify
        if (!questionAnalysis.isQuestion || questionAnalysis.confidence < 0.7) {
            return { interactionType: baseInteractionType, contextRequirement: baseContextRequirement };
        }

        // Determine the appropriate interaction type based on analysis
        let interactionType: InteractionType = baseInteractionType;
        let contextRequirement: ContextRequirement = baseContextRequirement;

        // Update interaction type
        if (questionAnalysis.knowledgeRequired === 'specific') {
            interactionType = 'explanatory_question';
        } else if (questionAnalysis.knowledgeRequired === 'general') {
            interactionType = 'factual_question';
        } else {
            interactionType = 'general_question';
        }

        // Update context requirement
        if (questionAnalysis.requiresRagMode) {
            contextRequirement = 'rag';
        } else if (questionAnalysis.knowledgeRequired === 'specific') {
            contextRequirement = 'rag';
        } else {
            contextRequirement = 'chat';
        }

        logInfo(methodName, 'Updated interaction details based on question analysis', {
            originalInteraction: baseInteractionType,
            originalContext: baseContextRequirement,
            newInteraction: interactionType,
            newContext: contextRequirement,
            reasoning: questionAnalysis.reasoning
        });

        return { interactionType, contextRequirement };
    }

    // In ConversationManager.ts

/**
 * Retrieves facts from the knowledge graph that are relevant to the current conversation
 */
public async getRelevantFacts(
    adapter: ContextAdapter,
    question: string
): Promise<ZepFact[]> {
    const methodName = 'getRelevantFacts';
    const context = adapter.getMessageContext();
    const { userId, sessionId } = await this.getSessionInfo(context);

    let graphitiFacts: ZepFact[] = [];
    let memoryFacts: ZepFact[] = [];

    // 1. Get facts from Graphiti API (/search)
    try {
        const payload = {
            query: question,
            session_id: sessionId,
            user_id: userId // Include session/user context if potentially useful for search
        };
        logInfo(methodName, `Searching facts via Graphiti API for query: "${question}" with payload:`, payload);
        const response = await axios.post('http://localhost:8003/search', payload);
        if (response.data && Array.isArray(response.data.facts)) {
            logInfo(methodName, `Received ${response.data.facts.length} facts from Graphiti service.`);
            graphitiFacts = response.data.facts;
        } else {
            logWarn(methodName, 'Received unexpected response format from Graphiti service:', response.data);
        }
    } catch (error) {
        logError(methodName, 'Error retrieving facts from Graphiti API:', error as Error);
        // Continue even if Graphiti fails, might get facts from memory
    }

    // 2. Get facts from Zep Memory object
    if (this.memory && typeof (this.memory as any).getChatFacts === 'function') {
        try {
            logInfo(methodName, `Attempting to retrieve Zep facts from memory object for session: ${sessionId}`);
            const factsFromMemory: ZepFact[] = await (this.memory as any).getChatFacts(sessionId);
            if (factsFromMemory && factsFromMemory.length > 0) {
                logInfo(methodName, `Received ${factsFromMemory.length} facts from memory object.`);
                memoryFacts = factsFromMemory;
            } else {
                logInfo(methodName, 'No Zep facts returned from memory object.');
            }
        } catch (factError) {
            logError(methodName, 'Error retrieving Zep facts from memory object:', factError as Error);
            // Continue even if memory retrieval fails
        }
    } else {
        logWarn(methodName, 'Memory object or getChatFacts method not available.');
    }

    // 3. Combine and de-duplicate facts
    const combinedFacts = [...graphitiFacts, ...memoryFacts];
    const uniqueFactsMap = new Map<string, ZepFact>();
    combinedFacts.forEach(fact => {
        if (fact && fact.uuid && !uniqueFactsMap.has(fact.uuid)) {
            uniqueFactsMap.set(fact.uuid, fact);
        }
    });

    const uniqueFacts = Array.from(uniqueFactsMap.values());
    logInfo(methodName, `Returning ${uniqueFacts.length} unique facts after combining sources.`);

    return uniqueFacts;
}

/**
 * Retrieves conversation summary from the knowledge graph
 */
public async getConversationSummary(
    adapter: ContextAdapter
): Promise<ZepSummary | null> {
    const methodName = 'getConversationSummary';
    const context = adapter.getMessageContext();
    const { userId, sessionId } = await this.getSessionInfo(context);
    
    if (!this.memory || typeof (this.memory as any).getSessionSummary !== 'function') {
        logWarn(methodName, 'Memory doesn\'t support summary retrieval');
        return null;
    }
    
    try {
        logInfo(methodName, `Retrieving conversation summary for session: ${sessionId}`);
        return await (this.memory as any).getSessionSummary(userId, sessionId);
    } catch (error) {
        logError(methodName, 'Error retrieving conversation summary:', error as Error);
        return null;
    }
}

/**
 * Enhances context with relevant facts from the knowledge graph
 */
public async enhanceContextWithFacts(
    context: string,
    question: string,
    adapter: ContextAdapter
): Promise<string> {
    const methodName = 'enhanceContextWithFacts';
    
    try {
        const facts = await this.getRelevantFacts(adapter, question);
        if (!facts || facts.length === 0) {
            logInfo(methodName, 'No relevant facts found to enhance context');
            return context;
        }
        
        // Format facts as additional context - Assuming Graphiti /search returns relevant facts directly
        const factsContext = facts
            .map(fact =>
                `- Fact: ${fact.fact || fact.content}` // Changed prefix for clarity
            ).join("\n"); // Changed separator to newline for list format
        
        if (!factsContext) {
            return context; // No facts found or formatted
        }
        
        logInfo(methodName, `Formatted ${facts.length} potential facts for model consideration`);
        // Updated header to guide the model on relevance assessment
        return `${context}\n\nConsider the following potentially relevant facts extracted from the users knowledge graph. Use them only if they directly help answer the user's question:\n${factsContext}`;
    } catch (error) {
        logError(methodName, 'Error enhancing context with facts:', error as Error);
        return context;
    }
}

/**
 * Enhances context with conversation summary
 */
public async enhanceContextWithSummary(
    context: string,
    adapter: ContextAdapter
): Promise<string> {
    const methodName = 'enhanceContextWithSummary';
    
    try {
        const summary = await this.getConversationSummary(adapter);
        if (!summary || !summary.content) {
            logInfo(methodName, 'No conversation summary available');
            return context;
        }
        
        logInfo(methodName, `Enhanced context with conversation summary (${summary.content.length} chars)`);
        return `${context}\n\n--- Conversation Summary ---\n${summary.content}`;
    } catch (error) {
        logError(methodName, 'Error enhancing context with summary:', error as Error);
        return context;
    }
}

/**
 * Searches for related facts across all user sessions
 */
public async searchAcrossSessions(
    query: string,
    adapter: ContextAdapter,
    limit: number = 5
): Promise<ZepFact[]> {
    const methodName = 'searchAcrossSessions';
    const context = adapter.getMessageContext();
    const { userId } = await this.getSessionInfo(context);
    
    if (!this.memory || typeof (this.memory as any).searchKnowledgeGraph !== 'function') {
        logWarn(methodName, 'Memory doesn\'t support knowledge graph search');
        return [];
    }
    
    try {
        logInfo(methodName, `Searching across sessions for: "${query}"`);
        return await (this.memory as any).searchKnowledgeGraph(query, userId, limit);
    } catch (error) {
        logError(methodName, 'Error searching across sessions:', error as Error);
        return [];
    }
}
}
//export const splitAndTruncateMessage = ConversationManager.splitAndTruncateMessage;