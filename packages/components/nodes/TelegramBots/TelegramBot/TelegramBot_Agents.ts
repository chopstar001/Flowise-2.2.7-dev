// TelegramBot_Agents.ts

import { ICommonObject, INode, INodeData, INodeParams, FlowiseMemory, IVisionChatModal, IMessage as FlowiseIMessage, MessageType } from '../../../src/Interface';
import { Telegraf, Context, Markup } from 'telegraf';
import { BaseMessage, HumanMessage, AIMessage, SystemMessage, MessageContent } from '@langchain/core/messages';
import { message } from 'telegraf/filters';
import { VectorStore } from '@langchain/core/vectorstores';
import { Update, User, Chat, Message, ChatMember, InputFile } from 'telegraf/typings/core/types/typegram';
import { ExtraReplyMessage } from 'telegraf/typings/telegram-types';
import { QuestionAnalyzer, QuestionAnalysisResult } from './QuestionAnalyzer';
import {
    logDebug,
    logInfo,
    logWarn,
    logError,
    logMessageProcessingStart,
    logChatHistory
} from './loggingUtility';
import { BaseRetriever } from '@langchain/core/retrievers';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { Tool } from 'langchain/tools';
import { Document } from 'langchain/document';
import { ConversationManager } from './ConversationManager';
import { CustomRetriever, DummyRetriever } from './CustomRetriever';
import { getBaseClasses, getCredentialData, getCredentialParam } from '../../../src/utils';
import { CommandHandler } from './CommandHandler';
import { MemoryManager } from './MemoryManager';
import { MemoryType, BotInfo, IExtendedMemory, ExtendedIMessage, IUpdateMemory, GroupMemberInfo, UserQuestionData, MessageContext, AuthRequest, TelegramAuthData, SessionData, WalletAuthData, UserAccount, UserDataRetriever, UserStats, WebAuthResponse, WebAuthData, SafeOptions, FormattedResponse, SessionInfo, ChatRequest, WebappChatIdData, type ConversationOperation, ConversationMetadata, RateLimits, RawMessageInput, SavedConversation, ConversationMessage, ZepFact, ZepMessage, ZepSummary, ZepMemoryResponse } from './commands/types';
import { InteractionType, EnhancedResponse, SourceCitation, UserCitationData, PatternContextData, ScoredDocument, LifelineType, GameState, PatternData, ContextRequirement } from './commands/types';
import { messageContentToString } from './utils/utils';
import { addImagesToMessages, llmSupportsVision } from '../../../src/multiModalUtils';
import ToolManager from './ToolManager';
import { FileManager } from './FileManager';
import { YouTubeTool } from './tools/YouTubeTool';
import { RumbleTool } from './tools/RumbleTool';
import PromptManager from './PromptManager';
import { AgentManager } from './AgentManager';
import { ContextAdapter } from './ContextAdapter';
import { RAGAgent } from './agents/RAGAgent';
import { MenuManager } from './MenuManager';
import { AccountManager } from './AccountManager';
import { FormatConverter } from './utils/FormatConverter';
import { handleNonTelegramMessage } from './handleNonTelegramMessage';
import { v4 as uuidv4 } from 'uuid';
import { formatResponse } from '../../outputparsers/OutputParserHelpers';
import NodeCache from 'node-cache';
import { Mutex } from 'async-mutex';
import {
    DatabaseService,
    AUTH_TYPES,
    SUBSCRIPTION_TIERS,
    type AuthType,
    type SubscriptionTier,
    type CreateUserDTO,
    type UserData
} from './services/DatabaseService';
import { AuthService } from './services/AuthService';
import { GameAgent } from './agents/GameAgent';
import { PatternPromptAgent } from './agents/PatternPromptAgent';
import { DocumentProcessingAgent } from './agents/DocumentProcessingAgent'; // <-- Import Agent
import { documentProcessingAgentPlugin } from './plugins/DocumentProcessingAgentPlugin'; // <-- Import Plugin
import { exec } from 'child_process';
import { promisify } from 'util';
import { TranscriptionSettings, TranscriptionSettingsUtil } from './commands/transcriptionsettings';
import * as path from 'path';
import * as fs from 'fs';
import axios from 'axios';
import { TranscriptionService } from './services/TranscriptionService';
import crypto from 'crypto'; // Added for initData validation


const botInstanceCache = new NodeCache({ stdTTL: 0, checkperiod: 600, useClones: false });
const botInitializationLocks: { [key: string]: Mutex } = {};
const flowIdMap = new Map<string, string>(); // Maps botKey to flowId
const execAsync = promisify(exec);

// --- START: Telegram InitData Validation Utility ---
/**
 * Validates the hash of Telegram Web App initData.
 * @param botToken - The Telegram bot token.
 * @param initData - The initData string from the web app.
 * @returns An object containing { isValid: boolean, user?: any }
 */
const validateTelegramInitData = (botToken: string, initData: string): { isValid: boolean; user?: any } => {
    const methodName = 'validateTelegramInitData';
    if (!botToken || !initData) {
        logError(methodName, 'Missing botToken or initData', new Error('Missing required parameters'));
        return { isValid: false };
    }

    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        if (!hash) {
            logWarn(methodName, 'No hash found in initData');
            return { isValid: false };
        }

        const dataToCheck: string[] = [];
        const sortedKeys = Array.from(urlParams.keys()).sort();

        sortedKeys.forEach((key) => {
            if (key !== 'hash') {
                const value = urlParams.get(key);
                if (value !== null) {
                    dataToCheck.push(`${key}=${value}`);
                }
            }
        });

        const dataCheckString = dataToCheck.join('\n');
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
        const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        const isValid = calculatedHash === hash;

        let user = null;
        if (isValid && urlParams.has('user')) {
            const userJson = urlParams.get('user');
            if (userJson) {
                try {
                    user = JSON.parse(userJson);
                } catch (parseError) {
                    logError(methodName, 'Error parsing user data from initData', parseError as Error);
                }
            }
        }

        logInfo(methodName, `Validation result: ${isValid}`, { calculatedHash, receivedHash: hash, userFound: !!user });
        return { isValid, user };

    } catch (error) {
        logError(methodName, 'Error validating initData', error as Error);
        return { isValid: false };
    }
};
// --- END: Telegram InitData Validation Utility ---


function getOrCreateFlowId(botKey: string): string {
    let flowId = flowIdMap.get(botKey);
    if (!flowId) {
        flowId = uuidv4();
        flowIdMap.set(botKey, flowId);
        console.log(`[FlowID: ${flowId}] Created new flowId for botKey ${botKey}`);
    } else {
        console.log(`[FlowID: ${flowId}] Retrieved existing flowId for botKey ${botKey}`);
    }
    return flowId;
}

interface CachedQuestionData {
    userId: string;
    sessionId: string;
    question: string;
    analysis: QuestionAnalysisResult;
    timestamp: number;
}
interface INodeOutput {
    label: string;
    name: string;
    baseClasses: string[];
    condition?: (data: INodeData) => boolean;
}


type ExtendedMetadata = Record<string, any> & {
    processed?: boolean;
    originalLength?: number;
    processedLength?: number;
};
let response: AIMessage;
// Removed Singleton TestLogger for brevity

export class TelegramBot_Agents implements INode, IUpdateMemory {
    label: string;
    name: string;
    version: number;
    description: string;
    type: string;
    icon: string;
    category: string;
    baseClasses: string[];
    inputs: INodeParams[];
    outputs: INodeOutput[];
    credential: INodeParams;

    private updateProcess: NodeJS.Timeout | null = null;
    private isRunning: boolean = false;
    private chatflowId: string | null = null;
    private chatflowPool: any; // We'll type this properly once we have access to the types
    private initializationPromise: Promise<void> | null = null;
    private lastUpdateId: number = 0;
    private isInitialized: boolean = false;
    private initializing: boolean = false;
    private commandHandler: CommandHandler;
    private conversationManager: ConversationManager | null = null;
    private retriever: BaseRetriever;
    private userDataRetriever: BaseRetriever | null = null;
    private chatModel: BaseChatModel;
    private SpModel: BaseChatModel;
    private summationModel: BaseChatModel;
    private utilityModel: BaseChatModel;
    private knownBotIds: Set<number> = new Set();
    private botToken: string;
    private botId: number | null = null;
    private knownBotUsernames: Set<string> = new Set(['BotB_username', 'AnotherBot_username']);
    private ragSystemPrompt: string | undefined;
    private gameSystemPrompt: string | undefined;
    private generalSystemPrompt: string | undefined;
    private humanMessageTemplate: string | undefined;
    private summarizeSystemPrompt: string | undefined;
    private gameSummarizeSystemPrompt: string | undefined;
    private welcomeMessage: string;
    private idleTimeout: number;
    private adminIds: number[] = [];
    private userLastActivity: Map<number, number> = new Map();
    private memory: IExtendedMemory | null = null; // User-specific memory
    private memoryGroup: IExtendedMemory | null = null; // Group-specific memory
    public bot: Telegraf<Context<Update>> | null = null;
    private agentManager: AgentManager;
    private collaboratingAgents: TelegramBot_Agents[] = [];
    private toolManager: ToolManager;
    private fileManager: FileManager;
    public promptManager: PromptManager | null;
    private ragAgent: RAGAgent;
    private groupMembers: Map<number, Map<number, GroupMemberInfo>> = new Map();
    private botIds: number[] = [];
    public botInfo: BotInfo[];
    public menuManager: MenuManager;
    private transcriptionService: TranscriptionService;
    private awaitingQuestionSelection: Map<number, boolean> = new Map();
    private userQuestions: Map<number, UserQuestionData> = new Map();
    private userQuestionSets: Map<number, Map<string, UserQuestionData>> = new Map();
    private userCitationSets: Map<number, Map<string, UserCitationData>> = new Map();
    private tools: Tool[]
    public flowId: string; // Unique identifier for the flow
    private chatFlowMap: Map<number, string> = new Map(); // Maps chatId to flowId
    private progressMessages: Map<string, string> = new Map();
    private sentConfirmations: Map<string, number> = new Map();
    public readonly DEFAULT_TOKEN_QUOTA = 25000; // Adjust as needed
    private accountManager: AccountManager;
    public databaseService: DatabaseService;
    private questionAnalyzer: QuestionAnalyzer;
    public authService: AuthService;
    private updateBuffer: Map<string, {
        updates: Context<Update>[];
        lastUpdate: number;
        processingTimer: NodeJS.Timeout | null;
    }> = new Map();

    private readonly MESSAGE_JOINING_WINDOW = 5000; // 5 seconds (up from 3)
    private readonly MAX_BUFFERED_UPDATES = 15; // Increased from 10
    private botMessageRegistry: Map<string, Set<number>> = new Map();
    private readonly MESSAGE_HISTORY_LIMIT = 1000; // Max messages to track per chat
    private readonly CONVERSATION_TIMEOUT = 5 * 60 * 1000; // 5 minutes
    private periodicLoggers: Map<string, NodeJS.Timeout> = new Map();



    public getBotToken(): string {
        return this.botToken;
    }
    // Add to TelegramBot_Agents class
    public getBot(): Telegraf<Context<Update>> {
        return this.bot!;
    }
    public getToolManager(): ToolManager {
        return this.toolManager;
    }

    public getAccountManager(): AccountManager {
        return this.accountManager;
    }

    public getMemoryType(): IExtendedMemory | null {
        return this.memory;
    }

    public getAgentManager(): AgentManager | null {
        return this.agentManager || null;
    }

    // Add public getter for TranscriptionService
    public getTranscriptionService(): TranscriptionService | null {
        // --> ADD LOGGING <--
        console.log(`[getTranscriptionService] Returning this.transcriptionService:`, !!this.transcriptionService);
        // --> END LOGGING <--
        return this.transcriptionService;
    }

    // Add getter for group memory
    public getGroupMemory(): IExtendedMemory | null {
        return this.memoryGroup;
    }

    // Add getter for summation model
    public getSummationModel(): BaseChatModel | null {
        return this.summationModel;
    }

    // Add getter for chat model
    public getChatModel(): BaseChatModel | null {
        return this.chatModel;
    }

    constructor(flowId?: string) {
        this.chatflowId = this.chatflowId || null;
        this.chatflowPool = (global as any).chatflowPool;
        this.flowId = flowId || uuidv4();
        this.label = 'Telegram Bot with Retrieval Chain';
        this.name = 'telegramBotRetrievalChain';
        this.version = 1.0;
        this.type = 'TelegramBot';
        this.icon = 'telegram.svg';
        this.category = 'Agents';
        this.baseClasses = [this.type, 'Composer'];
        this.description = 'Versatile Telegram bot with optional RAG capabilities. Supports custom prompts, handles human/AI interactions. Ideal for customer service, information retrieval, and inter-bot communication. Requires Telegram API credentials.';
        this.credential = {
            label: 'Telegram API',
            name: 'telegramApi',
            type: 'credential',
            credentialNames: ['telegramApi']
        };
        this.inputs = [
            {
                label: 'Memory',
                name: 'memory',
                type: 'BaseChatMemory',
                optional: true
            },
            {
                label: 'Chat Model',
                name: 'chatModel',
                type: 'BaseChatModel',
                optional: false
            },
            {
                label: 'Special Purpose Model',
                name: 'SpModel',
                type: 'BaseChatModel',
                optional: true
            },
            {
                label: 'Summation Model',
                name: 'summationModel',
                type: 'BaseChatModel',
                optional: true
            },
            {
                label: 'Utility Model',
                name: 'utilityModel',
                type: 'BaseChatModel',
                optional: true
            },
            {
                label: 'Retriever',
                name: 'retriever',
                type: 'BaseRetriever',
                optional: true
            },
            {
                label: 'Tools',
                name: 'tools',
                type: 'Tool',
                list: true,
                optional: true
            },
            {
                label: 'Admin User IDs',
                name: 'adminIds',
                type: 'string',
                description: 'Comma-separated list of Telegram user IDs who can use admin commands',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Bot Information',
                name: 'botInfo',
                type: 'string',
                description: 'Comma-separated list of bot information in format: botId:botFirstName:botUsername',
                optional: true,
                additionalParams: true
            },
            {
                label: 'RAG System Prompt',
                name: 'ragSystemPrompt',
                type: 'string',
                rows: 4,
                placeholder: PromptManager.defaultRAGSystemPrompt(),
                optional: true,
                additionalParams: true
            },
            {
                label: 'General System Prompt',
                name: 'generalSystemPrompt',
                type: 'string',
                rows: 4,
                placeholder: PromptManager.defaultGeneralSystemPrompt(),
                optional: true,
                additionalParams: true
            },
            {
                label: 'Human Message Template',
                name: 'humanMessageTemplate',
                type: 'string',
                rows: 2,
                placeholder: PromptManager.defaultHumanMessageTemplate(),
                optional: true,
                additionalParams: true
            },
            {
                label: 'Persona Prompt',
                name: 'personaPrompt',
                type: 'string',
                rows: 4,
                placeholder: PromptManager.defaultPersonaPrompt(),
                optional: true,
                additionalParams: true
            },
            {
                label: 'Enable Persona',
                name: 'enablePersona',
                type: 'boolean',
                default: false,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Summarize System Prompt',
                name: 'summarizeSystemPrompt',
                type: 'string',
                rows: 4,
                placeholder: PromptManager.defaultSummarizeSystemPrompt(),
                optional: true,
                additionalParams: true
            },
            {
                label: 'Game Summarize System Prompt',
                name: 'gameSummarizeSystemPrompt',
                type: 'string',
                rows: 6,
                placeholder: PromptManager.defaultGameSummarizeSystemPrompt(),
                optional: true,
                additionalParams: true
            },
            {
                label: 'Game System Prompt',
                name: 'gameSyetemPrompt',
                type: 'string',
                rows: 6,
                placeholder: PromptManager.defaultGameSystemPrompt(),
                optional: true,
                additionalParams: true
            },
            {
                label: 'Tool Agent System Prompt',
                name: 'toolAgentSystemPrompt',
                type: 'string',
                rows: 6,
                optional: true,
                additionalParams: true,
                placeholder: PromptManager.defaultToolAgentSystemPrompt()
            },
            {
                label: 'Summarize System Prompt [AI summary guidelines]',
                name: 'maxMessageLength',
                type: 'number',
                default: 4000,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Remove Disclaimers in RAG Mode',
                name: 'removeDisclaimersRAG',
                type: 'boolean',
                default: true,
                description: 'When enabled, removes disclaimers and notes from RAG responses',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Dynamic Context Base Length [Initial context size]',
                name: 'dynamicContextBaseLength',
                type: 'number',
                default: 7000,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Minimum Complexity Factor [Context scaling (0-1)]',
                name: 'minComplexityFactor',
                type: 'number',
                step: 0.1,
                default: 0.9,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Max Chat History Tokens [Conversation memory limit]',
                name: 'maxChatHistoryTokens',
                type: 'number',
                default: 4000,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Top Relevant Documents [Max docs for context]',
                name: 'topRelevantDocs',
                type: 'number',
                default: 15,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Relevance Score Threshold [Min. relevance for inclusion (0-1)]',
                name: 'relevanceScoreThreshold',
                type: 'number',
                step: 0.02,
                default: 0.1,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Context Window Size [Max context tokens]',
                name: 'contextWindowSize',
                type: 'number',
                default: 6000,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Welcome Message [Initial bot greeting]',
                name: 'welcomeMessage',
                type: 'string',
                rows: 2,
                placeholder: 'Welcome! How can I assist you today?',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Idle Timeout [Session expiry time (seconds)]',
                name: 'idleTimeout',
                type: 'number',
                default: 300,
                optional: true,
                additionalParams: true
            },
        ]
        this.inputs.push(
            {
                label: 'Collaborating Agents',
                name: 'collaborators',
                type: 'TelegramBot_Agents',
                list: true,
                optional: true
            },
            {
                label: 'Default Token Quota',
                name: 'defaultTokenQuota',
                type: 'number',
                default: 10000,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Auth Secret Key',
                name: 'authSecret',
                type: 'password',
                optional: true,
                additionalParams: true
            }
        );

    }


    public async init(nodeData: INodeData, flowData: string, options: ICommonObject): Promise<void> {
        console.log(`[Init entered:] Looking to Initialize`);

        try {
            // Initialize database and auth services ONLY if they don't exist
            if (!this.databaseService) {
                logInfo('init', 'DatabaseService not found, initializing...');
                this.databaseService = new DatabaseService(this.flowId);
                await this.databaseService.initialize();
                // This method already creates all necessary tables in the correct order
                await this.databaseService.createBotTables();
                logInfo('init', 'DatabaseService initialized.');
            } else {
                logInfo('init', 'DatabaseService already exists, skipping initialization.');
            }

            if (!this.authService) {
                logInfo('init', 'AuthService not found, initializing...');
                if (!this.databaseService) {
                     throw new Error("DatabaseService must be initialized before AuthService");
                }
                this.authService = new AuthService(this.databaseService);
                logInfo('init', 'AuthService initialized.');
            } else {
                 logInfo('init', 'AuthService already exists, skipping initialization.');
            }

            // Initialize AccountManager (depends on DB and Auth services)
            // Ensure it's also only initialized once or updated if needed
            if (!this.accountManager) {
                logInfo('init', 'AccountManager not found, initializing...');
                if (!this.databaseService || !this.authService) {
                    throw new Error("DatabaseService and AuthService must be initialized before AccountManager");
                }
                // Correct constructor call syntax and provide default quota
                this.accountManager = new AccountManager(
                    this.databaseService,
                    this.conversationManager!, // Assuming conversationManager is initialized elsewhere or handled
                    this.flowId,
                    nodeData.inputs?.defaultTokenQuota as number ?? this.DEFAULT_TOKEN_QUOTA, // Use default if undefined
                    this.authService
                );
                logInfo('init', 'AccountManager initialized.');
            } else {
                logInfo('init', 'AccountManager already exists, skipping initialization.');
                // Optionally update AccountManager if needed, e.g., quota changes
                // this.accountManager.updateSettings(...)
            }

            // Removed erroneous logInfo call

            logInfo('init', 'Services initialized successfully', {
                hasDatabase: !!this.databaseService,
                hasAccountManager: !!this.accountManager
            });
        } catch (error) {
            logError('init', 'Error initializing services:', error as Error);
            // Reset state on error
            this.isInitialized = false;
            this.isRunning = false;
            throw error;
        }

        if (this.initializing) {
            console.log(`[FlowID: ${this.flowId}] Initialization in progress. Awaiting completion.`);
            return this.initializationPromise!;
        }

        if (this.isInitialized) {
            console.log(`[FlowID: ${this.flowId}] Already initialized. Skipping initialization.`);
            return;
        }

        this.initializing = true;

        const chatflowid = options.chatflowid || 'default_chatflow';

        // Use chatflowid as the unique identifier for botKey
        const botKey = chatflowid;
        const flowId = getOrCreateFlowId(botKey);
        this.flowId = flowId;

        // Store the instance in cache
        if (botKey) {
            botInstanceCache.set(botKey, this);
            console.log(`Bot instance stored in cache with key: ${botKey}`);
        } else {
            console.warn('Bot key is undefined. Bot instance will not be cached.');
        }




        this.initializationPromise = this.performInitialization(nodeData, flowData, options)
            .then(() => {
                this.isInitialized = true;
                console.log(`[FlowID: ${this.flowId}] Initialization completed successfully`);
            })
            .catch((error) => {
                if (error.code === 409) {
                    console.warn(`[FlowID: ${this.flowId}] Bot is already running. Setting isInitialized to true.`);
                    this.isInitialized = true;
                } else {
                    this.isInitialized = false;
                    console.error(`[FlowID: ${this.flowId}] Initialization failed:`, error);
                    throw error;
                }
            })
            .finally(() => {
                this.initializing = false;
                this.initializationPromise = null;
                console.log(`[FlowID: ${this.flowId}] Initialization promise cleared.`);
            });

        return this.initializationPromise;
    }

/**
     * Initializes or re-initializes essential services (DB, Auth, AccountMgr) on the instance.
     */
    private async _reinitializeServices(nodeData: INodeData, options: ICommonObject): Promise<void> {
        const methodName = '_reinitializeServices';
        logInfo(methodName, 'Ensuring essential services are initialized...');

        try {
            // Initialize database service if needed
            if (!this.databaseService) {
                logInfo(methodName, 'DatabaseService missing, initializing...');
                this.databaseService = new DatabaseService(this.flowId);
                await this.databaseService.initialize();
                await this.databaseService.createBotTables();
                logInfo(methodName, 'DatabaseService initialized.');
            } else {
                 logInfo(methodName, 'DatabaseService already exists.');
            }

            // Initialize auth service if needed
            if (!this.authService) {
                logInfo(methodName, 'AuthService missing, initializing...');
                 if (!this.databaseService) {
                     throw new Error("DatabaseService must be initialized before AuthService");
                 }
                this.authService = new AuthService(this.databaseService);
                logInfo(methodName, 'AuthService initialized.');
            } else {
                 logInfo(methodName, 'AuthService already exists.');
            }

            // Initialize account manager if needed
            if (!this.accountManager) {
                logInfo(methodName, 'AccountManager missing, initializing...');
                 if (!this.databaseService || !this.authService) {
                     throw new Error("DatabaseService and AuthService must be initialized before AccountManager");
                 }
                this.accountManager = new AccountManager(
                    this.databaseService,
                    this.conversationManager!, // Assumes conversationManager is handled elsewhere
                    this.flowId,
                    nodeData.inputs?.defaultTokenQuota as number ?? this.DEFAULT_TOKEN_QUOTA,
                    this.authService
                );
                logInfo(methodName, 'AccountManager initialized.');
            } else {
                 logInfo(methodName, 'AccountManager already exists.');
                 // Optionally update settings if needed
                 // this.accountManager.updateSettings(...)
            }

            logInfo(methodName, 'Essential services check complete.');

        } catch (error) {
            logError(methodName, 'Error initializing services:', error as Error);
            // Reset state partially? Or let the caller handle full reset?
            // For now, just re-throw to indicate failure.
            throw error;
        }
    }


    private async performInitialization(nodeData: INodeData, flowData: string, options: ICommonObject, interactionType?: InteractionType): Promise<void> {
        const methodName = 'performInitialization';

        try {
            // Add early validation
            if (!nodeData) {
                console.log(`[${methodName}] No nodeData provided`);
                return;
            }
            // Safe access to nodeData
            const inputs = nodeData.inputs || {};
            const credential = nodeData.credential || {};

            logInfo(methodName, 'Starting initialization with:', {
                flowId: this.flowId,
                hasInputs: Object.keys(inputs).length > 0,
                hasCredential: Object.keys(credential).length > 0
            });

            console.log("Starting initialization of TelegramBot_Agents node");
            console.log("Node inputs:", nodeData.inputs);

            console.log("Checking inputs...");
            // In performInitialization method

            /**
             * Initialize chat models with proper error handling and fallbacks
             */
            // Initialize primary chat model (required)
            this.chatModel = nodeData.inputs?.chatModel as BaseChatModel;
            if (!this.chatModel) {
                throw new Error('Missing required input: chatModel');
            }

            // Initialize special purpose model with fallback to chatModel
            this.SpModel = nodeData.inputs?.SpModel as BaseChatModel;
            if (!this.SpModel) {
                console.warn('No separate SpModel provided. Using chatModel as fallback.');
                this.SpModel = this.chatModel;
            }

            // Initialize summation model with fallback
            this.summationModel = nodeData.inputs?.summationModel as BaseChatModel;
            if (!this.summationModel) {
                console.warn('No separate summation model provided. Using chatModel for summation tasks.');
                this.summationModel = this.chatModel;
            }

            // Initialize utility model with fallback
            this.utilityModel = nodeData.inputs?.utilityModel as BaseChatModel;
            if (!this.utilityModel) {
                console.warn('No separate utilityModel model provided. Using chatModel for utility tasks.');
                this.utilityModel = this.chatModel;
            }
            // Initialize QuestionAnalyzer
            if (this.utilityModel) {
                this.questionAnalyzer = new QuestionAnalyzer(
                    this.utilityModel,
                    this.summationModel,
                    this.chatModel,
                    this.SpModel,
                    this.flowId,
                    this.conversationManager
                );
                console.log(`[FlowID: ${this.flowId}] QuestionAnalyzer initialized`);

                // Only set up cleanup after questionAnalyzer is initialized
                this.setupCleanupTasks();
            } else {
                // In case we need cleanup tasks even without questionAnalyzer
                this.setupCleanupTasks();
            }

            // Initialize memory
            console.log("Memory input:", nodeData.inputs?.memory);
            if (nodeData.inputs?.memory) {
                console.log("External memory provided:", nodeData.inputs.memory);
                this.memory = this.adaptMemory(nodeData.inputs.memory);
            } else {
                console.log("No external memory provided, using MemoryManager");
                this.memory = new MemoryManager();
            }
            console.log("Memory type:", this.memory.getMemoryType());
            console.log("Initialized memory:", this.memory.constructor.name);
            console.log(this.memory ? "Using provided memory solution." : "No memory solution provided. Using default or none.");

            // Initialize the separate memory manager for group chats
            this.memoryGroup = new MemoryManager();
            console.log("Initialized group memory manager:", this.memoryGroup.constructor.name);
            this.promptManager = new PromptManager(
                nodeData.inputs?.ragSystemPrompt as string || PromptManager.defaultRAGSystemPrompt(),
                nodeData.inputs?.generalSystemPrompt as string || PromptManager.defaultGeneralSystemPrompt(),
                nodeData.inputs?.humanMessageTemplate as string || PromptManager.defaultHumanMessageTemplate(),
                nodeData.inputs?.summarizeSystemPrompt as string || PromptManager.defaultSummarizeSystemPrompt(),
                nodeData.inputs?.gameSummarizeSystemPrompt as string || PromptManager.defaultGameSummarizeSystemPrompt(),
                nodeData.inputs?.personaPrompt as string || PromptManager.defaultPersonaPrompt(),
                nodeData.inputs?.toolAgentSystemPrompt as string || PromptManager.defaultToolAgentSystemPrompt(),
                nodeData.inputs?.gameSystemPrompt as string || PromptManager.defaultGameSystemPrompt(), // Moved to correct position
                nodeData.inputs?.maxChatHistoryTokens as number || 3000,
                nodeData.inputs?.maxMessageLength as number || 4000,
                nodeData.inputs?.enablePersona as boolean || false
            );
            // Initialize system prompts
            this.ragSystemPrompt = nodeData.inputs?.ragSystemPrompt as string || PromptManager.defaultRAGSystemPrompt();
            this.generalSystemPrompt = nodeData.inputs?.generalSystemPrompt as string || PromptManager.defaultGeneralSystemPrompt();
            this.humanMessageTemplate = nodeData.inputs?.humanMessageTemplate as string || PromptManager.defaultHumanMessageTemplate();
            this.summarizeSystemPrompt = nodeData.inputs?.summarizeSystemPrompt as string || PromptManager.defaultSummarizeSystemPrompt();
            this.gameSummarizeSystemPrompt = nodeData.inputs?.gameSummarizeSystemPrompt as string || PromptManager.defaultGameSummarizeSystemPrompt();

            this.gameSystemPrompt = nodeData.inputs?.gameSystemPrompt as string || PromptManager.defaultGameSystemPrompt();

            // Initialize other parameters
            const removeDisclaimersRAG = nodeData.inputs?.removeDisclaimersRAG as boolean ?? false; // Set to false by default
            const maxMessageLength = nodeData.inputs?.maxMessageLength as number || 4000;
            const dynamicContextBaseLength = nodeData.inputs?.dynamicContextBaseLength as number || 7000;
            const minComplexityFactor = nodeData.inputs?.minComplexityFactor as number || 0.9;
            const maxChatHistoryTokens = nodeData.inputs?.maxChatHistoryTokens as number || 4000;
            const topRelevantDocs = nodeData.inputs?.topRelevantDocs as number || 40;
            const relevanceScoreThreshold = nodeData.inputs?.relevanceScoreThreshold as number || 0.2;
            const contextWindowSize = nodeData.inputs?.contextWindowSize as number || 6000;
            const welcomeMessage = nodeData.inputs?.welcomeMessage as string || 'Welcome! How can I assist you today?';
            const idleTimeout = nodeData.inputs?.idleTimeout as number || 300;
            const toolAgentSystemPrompt = nodeData.inputs?.toolAgentSystemPrompt as string || PromptManager.defaultToolAgentSystemPrompt();

            // Initialize ToolManager first, before any agents
            console.log("Initializing ToolManager...");
            const tools: Tool[] = nodeData.inputs?.tools as Tool[] || [];
            this.toolManager = new ToolManager(tools);
            // Extract tools from nodeData.inputs.tools

            if (tools.length === 0) {
                logWarn('performInitialization', 'No tools provided in nodeData.inputs.tools. Initializing with an empty array.');
            } else {
                logInfo('performInitialization', `Tools provided: ${tools.map(tool => tool.name).join(', ')}`);
            }
            const availableTools = this.toolManager.getToolNames();
            console.log(`[${this.flowId}] Available tools: ${availableTools.join(', ') || 'none'}`);

            this.agentManager = new AgentManager(this.flowId, this.toolManager, this.promptManager);

            this.menuManager = new MenuManager(this, this.flowId); // Pass flowId as string



            // Initialize Bot and Admin IDs
            const botInfoInput = nodeData.inputs?.botInfo as string | undefined;
            console.log('Bot info input:', botInfoInput);
            this.botInfo = this.parseBotInfoInput(botInfoInput);
            console.log('Parsed bot info:', this.botInfo);


            // Extract bot IDs from botInfo for backward compatibility
            this.botIds = this.botInfo.map(bot => bot.id);
            console.log('Extracted bot IDs:', this.botIds);

            // Parse admin IDs
            const adminIdsInput = nodeData.inputs?.adminIds as string;
            this.adminIds = adminIdsInput ? adminIdsInput.split(',').map(id => parseInt(id.trim())) : [];                //const adminIds = adminIdsInput ? adminIdsInput.split(',').map(id => parseInt(id.trim())) : [];
            // Handle vision capabilities
            if (llmSupportsVision(this.chatModel)) {
                const visionChatModel = this.chatModel as IVisionChatModal;
                const messageContent = await addImagesToMessages(nodeData, options, visionChatModel.multiModalOption);
                if (messageContent?.length) {
                    visionChatModel.setVisionModel();
                    // Update the system message or prompt to include vision capabilities
                } else {
                    visionChatModel.revertToOriginalModel();
                }
            }

            // Handle retrievers
            this.userDataRetriever = nodeData.inputs?.userDataStore as BaseRetriever;
            if (this.userDataRetriever) {
                console.log('User data store initialized');
            }

            if (nodeData.inputs?.retriever) {
                console.log("Using provided retriever with enhanced logging.");
                const topRelevantDocs = nodeData.inputs?.topRelevantDocs as number || 10;
                const retriever = nodeData.inputs.retriever as BaseRetriever;

                // Try to get vectorStore from the retriever if it's available
                const vectorStore = (retriever as any).vectorStore ||
                    (retriever as any).client ||
                    (retriever as any).store;

                if (!vectorStore) {
                    console.error("Could not find vectorStore in retriever. Cannot initialize CustomRetriever.");
                    console.log("Retriever type:", retriever.constructor.name);
                    console.log("Available properties:", Object.keys(retriever));
                    this.retriever = new DummyRetriever();
                } else {
                    this.retriever = new CustomRetriever({
                        retriever: retriever,
                        vectorStore: vectorStore,
                        topRelevantDocs: topRelevantDocs,
                        postProcessor: this.postProcessDocuments.bind(this),
                        chatModel: this.chatModel,
                        summationModel: this.summationModel,
                        utilityModel: this.utilityModel,
                        verbose: nodeData.inputs.verbose || true,
                    });
                }
            } else {
                console.log("No retriever provided. Using DummyRetriever. RAG functionality will be limited.");
                this.retriever = new DummyRetriever();
            }

            console.log("Initializing TelegramBot_Agents with inputs:", {
                inputKeys: Object.keys(nodeData.inputs || {}),
                hasMemory: !!nodeData.inputs?.memory,
                hasChatModel: !!nodeData.inputs?.chatModel,
                hasSummationModel: !!nodeData.inputs?.summationModel,
                hasRetriever: !!nodeData.inputs?.retriever,
                hasTools: Array.isArray(nodeData.inputs?.tools) ? nodeData.inputs.tools.length : 0,
                adminIds: nodeData.inputs?.adminIds,
                botInfo: nodeData.inputs?.botInfo,
                // Include other safe-to-log properties as needed
            });

            //And we the bots, shall...., Collaborate!
            // In performInitialization method
            if (nodeData.inputs?.collaborators) {
                const collaboratorsData = nodeData.inputs.collaborators as INodeData[];
                for (const collaboratorData of collaboratorsData) {
                    const collaboratorFlowId = uuidv4(); // Generate unique flowId for collaborator
                    const collaboratorBot = new TelegramBot_Agents(collaboratorFlowId);
                    await collaboratorBot.init(collaboratorData, flowData, options);
                    this.collaboratingAgents.push(collaboratorBot);

                    const collaboratorAgentManager = new AgentManager(collaboratorFlowId, this.toolManager, this.promptManager);
                    this.agentManager.addCollaborator(collaboratorAgentManager);

                    // Correct method call
                    collaboratorAgentManager.setTelegramBot(collaboratorBot);

                    console.log(`[FlowID: ${this.flowId}] Collaborating agent initialized with FlowID: ${collaboratorFlowId}`);
                }
            }

            // Initialize MemoryManager and ConversationManager
            //const memoryManager = new MemoryManager();

            console.log('Initializing ConversationManager...');
            this.conversationManager = new ConversationManager({
                retriever: this.retriever,
                userDataRetriever: this.userDataRetriever,
                chatModel: this.chatModel,
                SpModel: this.SpModel,
                summationModel: this.summationModel,
                utilityModel: this.utilityModel,
                tools: this.tools,
                welcomeMessage: nodeData.inputs?.welcomeMessage as string || 'Welcome! How can I assist you today?',
                maxMessageLength,
                dynamicContextBaseLength,
                minComplexityFactor,
                maxChatHistoryTokens,
                topRelevantDocs,
                relevanceScoreThreshold,
                contextWindowSize,
                adminIds: this.adminIds,
                enablePersona: nodeData.inputs?.enablePersona as boolean || false,
                toolAgentSystemPrompt: nodeData.inputs?.toolAgentSystemPrompt as string || PromptManager.defaultToolAgentSystemPrompt(),
                agentManager: this.agentManager,
                menuManager: this.menuManager,
                promptManager: this.promptManager,
                flowId: this.flowId,
                flowIdMap: flowIdMap,
                databaseService: this.databaseService

            });
            console.log("Initialized memory:", this.memory.constructor.name);
            this.ragAgent = new RAGAgent(
                this.flowId,
                this.conversationManager,
                this.toolManager,
                this.promptManager,
                removeDisclaimersRAG
            );

            // Initialize AgentManager
            // In TelegramBot_Agents constructor or initialization
            this.agentManager.setTelegramBot(this);  // Important: Set the telegram bot reference
            this.agentManager.registerAgent('rag', this.ragAgent);
            this.agentManager.setConversationManager(this.conversationManager);
            this.conversationManager.setRAGAgent(this.ragAgent);  // Set RAGAgent after creation

            // --- Load Document Processing Agent Plugin ---
            this.agentManager.loadPlugin(documentProcessingAgentPlugin);
            const docAgent = this.agentManager.getAgent('document_processor');
            if (docAgent instanceof DocumentProcessingAgent) {
                if (this.databaseService) {
                    docAgent.setDatabaseService(this.databaseService);
                    logInfo(methodName, 'Successfully injected DatabaseService into DocumentProcessingAgent.');
                } else {
                    logError(methodName, 'DatabaseService not initialized, cannot inject into DocumentProcessingAgent.', new Error('DatabaseService is null'));
                    // Optionally remove the agent if DB service is critical
                    // this.agentManager.unregisterAgent('document_processor');
                }
            } else if (docAgent) {
                logWarn(methodName, 'Agent with type "document_processor" exists but is not an instance of DocumentProcessingAgent.');
            } else {
                logWarn(methodName, 'DocumentProcessingAgent not found after loading plugin.');
            }
            // --- End Plugin Loading ---


            // Set memory in ConversationManager
            this.conversationManager.setMemory(this.memory);
            this.welcomeMessage = welcomeMessage;
            this.idleTimeout = idleTimeout;
            //this.memory = memoryManager;
            this.conversationManager.onBotStop = async () => {
                // Perform any necessary cleanup
                this.isInitialized = false;
                this.bot = null;
                // Any other cleanup operations...
            };
            const ragAgent = this.agentManager.getAgent('rag') as RAGAgent;
            if (ragAgent) {
                const loggingTimer = ragAgent.startActiveUserLogging();
                // Store the timer reference for cleanup during stop
                this.periodicLoggers = this.periodicLoggers || new Map();
                this.periodicLoggers.set('ragStatus', loggingTimer);
            }
            console.log("Prompts initialized:");
            console.log("RAG System Prompt:", this.ragSystemPrompt);
            console.log("General System Prompt:", this.generalSystemPrompt);
            console.log("Human Message Template:", this.humanMessageTemplate);

            // Handle credential
            const credentialId = nodeData.credential;
            if (!credentialId) {
                throw new Error('Telegram API credential not found');
            }

            const credentialData = await getCredentialData(credentialId, options);
            if (!credentialData) {
                throw new Error(`Failed to fetch credential data for id: ${credentialId}`);
            }

            this.botToken = getCredentialParam('botToken', credentialData, nodeData);
            if (!this.botToken) {
                throw new Error('Bot token not found in credential data');
            }
            if (this.bot) {
                try {
                    await this.bot.stop('reinitializing Bot');
                    this.bot = null; // Add this line
                } catch (error) {
                    console.warn(`Error stopping existing bot: ${error.message}`);
                }
            }

            // Initialize Telegram bot
            if (!this.bot) {
                this.bot = new Telegraf<Context>(this.botToken, {
                    handlerTimeout: 600000 // 10 minutes in milliseconds
                });

                try {
                    const botInfo = await this.bot.telegram.getMe();
                    this.setupActionHandlers();
                    this.setupMessageHandlers(interactionType!);
                    this.botId = botInfo.id;
                    // Initialize message registry
                    await this.initializeMessageRegistry();
                    console.log(`[FlowID: ${this.flowId}] Bot initialized with ID: ${this.botId}`);
                } catch (error) {
                    console.error(`[FlowID: ${this.flowId}] Error getting bot info:`, error);
                    throw error;
                }

                if (!this.isRunning) {
                    console.log(`[FlowID: ${this.flowId}] Bot launch initiated`);
                    // Do not await bot.launch()
                    this.bot.launch()
                        .then(() => {
                            console.log(`[FlowID: ${this.flowId}] Bot has stopped.`);
                            this.isRunning = false;
                        })
                        .catch((error) => {
                            if (error.code === 409) {
                                console.warn(`[FlowID: ${this.flowId}] Bot is already running. Setting isRunning to true.`);
                                this.isRunning = true;
                            } else {
                                console.error(`[FlowID: ${this.flowId}] Failed to launch bot:`, error);
                                this.isRunning = false;
                            }
                        });
                    this.isRunning = true;
                    console.log(`[FlowID: ${this.flowId}] Bot launched successfully.`);
                } else {
                    console.log(`[FlowID: ${this.flowId}] Bot is already running. Skipping launch.`);
                }
            } else {
                console.log(`[FlowID: ${this.flowId}] Bot already initialized and running. Skipping bot initialization and launch.`);
            }

            // await this.checkRetrieverConfiguration();

            // Initialize TranscriptionService EARLIER
            console.log(`Initializing TranscriptionService`);
            try {
                this.transcriptionService = new TranscriptionService({
                    defaultProvider: 'local-cuda', // Use your RTX 3090 by default
                    whisperPath: '/usr/bin/whisper', // Use the correct path we found
                    apiKeys: {
                        'assemblyai': process.env.ASSEMBLYAI_API_KEY || '',
                        'google': process.env.GOOGLE_API_KEY || ''
                    }
                });
                console.log(`TranscriptionService initialized successfully`);
                // --> ADD LOGGING <--
                console.log(`[${methodName}] this.transcriptionService assigned:`, !!this.transcriptionService);
                // --> END LOGGING <--
            } catch (error) {
                console.error(`Error initializing TranscriptionService:`, error);
                throw error; // Re-throw to prevent the tool from initializing with a broken transcription service
            }

            // Initialize CommandHandler AFTER TranscriptionService
            if (this.bot && this.conversationManager) {
                console.log('Bot and ConversationManager initialized. Initializing CommandHandler...');
                this.commandHandler = new CommandHandler(
                    this.bot,
                    this.conversationManager,
                    this.memory,
                    this.promptManager,
                    this.agentManager,
                    this.menuManager,
                    this.toolManager,
                    this.fileManager, // FileManager should also be initialized before CommandHandler if needed by commands
                    this.flowId,
                    {
                        telegramBot: this // Pass the current instance which now has transcriptionService
                    }
                );
                console.log('CommandHandler created. Registering commands...');
                await this.commandHandler.registerCommands();
                this.commandHandler.createCommandMenus();
                console.log('Commands registered successfully.');
            } else {
                throw new Error('Bot or ConversationManager is not initialized. Cannot create CommandHandler.');
            }
            if (this.agentManager) {
                if (!this) {
                    console.warn('TelegramBot not initialized when creating agents');
                    return;
                }

                const toolManager = this.getToolManager();
                if (!toolManager) {
                    console.warn('ToolManager not available when creating agents');
                    return;
                }


                // Register YouTube tool if API key is available
                if (process.env.YOUTUBE_API_KEY) {
                    const youtubeTool = new YouTubeTool(process.env.YOUTUBE_API_KEY);
                    this.toolManager.addTool(youtubeTool);
                    console.log(`[${this.flowId}] YouTube tool registered successfully`);
                } else {
                    console.warn(`[${this.flowId}] YouTube API key not found in environment variables, YouTube functionality will be disabled`);
                }
                // When initializing FileManager in TelegramBot_Agents:
                // Initialize FileManager EARLIER (before CommandHandler)
                const botName = this.botInfo.length > 0 ? this.botInfo[0].firstName : 'Telegram Bot';
                this.fileManager = new FileManager(this.botToken, botName);
                // setupFileHandlers call moved later, after CommandHandler is ready
                console.log('FileManager initialized');
                // Setup file handlers if FFmpeg is available
                this.checkTranscriptionRequirements().then(available => {
                    if (available) {
                        this.setupFileHandlers();
                        console.log('Media transcription handlers initialized');
                    } else {
                        console.warn('Transcription requirements not met, file handlers not initialized');
                    }
                });
                if (this.agentManager) {
                    const toolManager = this.getToolManager();

                    // Register YouTube tool if API key is available
                    if (process.env.YOUTUBE_API_KEY) {
                        const youtubeTool = new YouTubeTool(process.env.YOUTUBE_API_KEY);
                        toolManager.addTool(youtubeTool);
                        console.log(`[${this.flowId}] YouTube tool registered successfully`);
                    } else {
                        console.warn(`[${this.flowId}] YouTube API key not found in environment variables, YouTube functionality will be limited`);
                    }

                    // Register Rumble tool (will check for yt-dlp internally)
                    const rumbleTool = new RumbleTool('./temp/rumble');
                    toolManager.addTool(rumbleTool);
                    console.log(`[${this.flowId}] Rumble tool registered (yt-dlp capabilities will be determined at runtime)`);

                    // Optionally, check and log yt-dlp status
                    this.checkYtDlpAvailability().then(available => {
                        if (available) {
                            console.log(`[${this.flowId}] yt-dlp is available, full Rumble functionality enabled`);
                        } else {
                            console.warn(`[${this.flowId}] yt-dlp is not available, Rumble transcript extraction will be limited`);
                            console.warn(`To enable full Rumble support, please install yt-dlp: https://github.com/yt-dlp/yt-dlp#installation`);
                        }
                    });
                }

                // Create and register the game agent
                const gameAgent = new GameAgent(
                    this.flowId,
                    this.conversationManager,
                    toolManager,
                    this.promptManager
                );
                this.agentManager.registerAgent('game', gameAgent);

                // Create and register the pattern agent
                const patternAgent = new PatternPromptAgent(
                    this.flowId,
                    this.conversationManager,
                    toolManager,
                    this.promptManager
                );
                this.agentManager.registerAgent('pattern', patternAgent);

                const ragAgent = this.agentManager.getAgent('rag') as RAGAgent;
                if (ragAgent) {
                    // Instead of calling startActiveUserLogging directly, use our wrapper method
                    this.setPeriodicLogger('ragActivityReport', () => {
                        try {
                            const report = ragAgent.generateRagUsageReport();
                            console.log(`[RAG Activity Report] ${JSON.stringify(report)}`);
                        } catch (error) {
                            console.error(`[RAG Activity Report] Error generating report:`, error);
                        }
                    }, 15 * 60 * 1000); // 15 minutes

                    console.log(`[FlowID: ${this.flowId}] Initialized RAG activity status logging`);
                }
            }
            // After both this.questionAnalyzer and this.conversationManager are initialized
            if (this.questionAnalyzer && this.conversationManager) {
                this.questionAnalyzer.setConversationManager(this.conversationManager);
            }
            // Set component references (CommandHandler now exists)
            this.commandHandler.setConversationManager(this.conversationManager);
            this.commandHandler.setMemory(this.memory);
            this.commandHandler.setPromptManager(this.promptManager);
            this.commandHandler.setAgentManager(this.agentManager);
            this.commandHandler.setMenuManager(this.menuManager);

            // Setup file handlers AFTER CommandHandler is initialized
            this.setupFileHandlers();
            console.log('File handlers initialized');

            this.isInitialized = true;
            options.telegramBotInstance = this;
            this.setupCleanupTasks();
            console.log('PromptManager state:', this.promptManager ? 'Initialized' : 'Not initialized');
            console.log('[performInitialization] TelegramBot_Agents initialization completed successfully');
        } catch (error) {
            console.error("Error in initialization:", error);
            this.isInitialized = false;
            throw error;
        }
    }
    private initializeQuestionAnalyzer(): void {
        // Inside the TelegramBot_Agents init or performInitialization method

        // Initialize QuestionAnalyzer with all required models
        if (this.utilityModel && this.summationModel && this.chatModel && this.SpModel) {
            this.questionAnalyzer = new QuestionAnalyzer(
                this.utilityModel,
                this.summationModel,
                this.chatModel,
                this.SpModel,
                this.flowId,
                this.conversationManager

            );
            console.log(`[FlowID: ${this.flowId}] QuestionAnalyzer initialized with all models`);
        } else {
            console.warn(`[FlowID: ${this.flowId}] Could not initialize QuestionAnalyzer - required models not available`);
        }
    }

    /**
     * Updates conversation tracking information when bot sends or receives messages
     */
    private updateConversationTracking(
        adapter: ContextAdapter,
        isBotMessage: boolean,
        botMentioned: boolean = false
    ): void {
        if (!this.questionAnalyzer) return;

        const context = adapter.getMessageContext();
        const chatId = context.chatId.toString();
        const userId = context.userId.toString();

        // Update conversation tracking in the question analyzer
        this.questionAnalyzer.updateConversationContext(
            chatId,
            userId,
            isBotMessage,
            botMentioned
        );
    }

    /**
     * Checks if a conversation is active in a given chat
     */
    private isActiveConversation(chatId: string): boolean {
        if (!this.questionAnalyzer) return false;

        const conversationContext = this.questionAnalyzer.getConversationContext(chatId);
        return conversationContext.isOngoing;
    }
    // Add the postProcessDocuments method to the TelegramBot_Agents class, to do with MultiQueryTelegramBot node if not connected, May not be used here:

    private async postProcessDocuments(
        docs: Document<ExtendedMetadata>[],
        query: string,
        verbose: boolean
    ): Promise<Document<ExtendedMetadata>[]> {
        // Implement your post-processing logic here
        // This could involve using the LLM to extract relevant information, etc.
        // For now, we'll just return the documents as-is
        return docs;
    }
    /**
     * Returns the QuestionAnalyzer instance
     */
    public getQuestionAnalyzer(): QuestionAnalyzer | null {
        return this.questionAnalyzer;
    }

    private setupMessageHandlers(progressKey: string, interactionType?: InteractionType): void {
        if (!this.bot) {
            console.error('setupMessageHandlers: Bot is not initialized');
            return;
        }

        console.log('Setting up message handlers');

        // Add a debounce map to track message processing
        const processingDebounce = new Map<string, {
            timeout: NodeJS.Timeout;
            updates: Context<Update>[];
            timestamp: number;
        }>();

        this.bot.on('message', async (ctx: Context<Update>) => {
            console.log('Received message:', ctx.message);

            // Check if this is a text message
            if (!ctx.message || !('text' in ctx.message) || !ctx.message.text) {
                // For non-text messages, process normally
                const adapter = new ContextAdapter(ctx, this.promptManager);
                await this.handleMessage(adapter, this.conversationManager!, this.agentManager);
                return;
            }

            // Generate buffer key from chat and user IDs
            const chatId = ctx.chat?.id;
            const userId = ctx.from?.id;
            if (!chatId || !userId) {
                // If we can't identify the chat/user, process normally
                const adapter = new ContextAdapter(ctx, this.promptManager);
                await this.handleMessage(adapter, this.conversationManager!, this.agentManager);
                return;
            }

            const bufferKey = `${chatId}:${userId}`;

            // Handle commands immediately (don't buffer)
            if (ctx.message.text.startsWith('/')) {
                const adapter = new ContextAdapter(ctx, this.promptManager);
                await this.handleMessage(adapter, this.conversationManager!, this.agentManager);
                return;
            }

            // Always add to buffer, then process with debounce
            let debounceInfo = processingDebounce.get(bufferKey);

            if (!debounceInfo) {
                // Create new debounce entry
                const timeout = setTimeout(async () => {
                    const info = processingDebounce.get(bufferKey);
                    if (info) {
                        console.log(`[setupMessageHandlers] Processing ${info.updates.length} updates after debounce for ${bufferKey}`);
                        processingDebounce.delete(bufferKey);

                        // Add all messages to the buffer
                        for (const update of info.updates) {
                            await this.bufferTelegramUpdate(bufferKey, update, false); // Don't process immediately
                        }

                        // Now process the full buffer
                        await this.processTelegramUpdates(bufferKey);
                    }
                }, 1000); // 1 second debounce - wait to see if more parts arrive

                debounceInfo = {
                    timeout,
                    updates: [ctx],
                    timestamp: Date.now()
                };

                processingDebounce.set(bufferKey, debounceInfo);
            } else {
                // Add to existing debounce entry
                clearTimeout(debounceInfo.timeout);
                debounceInfo.updates.push(ctx);

                // Reset the timeout
                debounceInfo.timeout = setTimeout(async () => {
                    const info = processingDebounce.get(bufferKey);
                    if (info) {
                        console.log(`[setupMessageHandlers] Processing ${info.updates.length} updates after debounce reset for ${bufferKey}`);
                        processingDebounce.delete(bufferKey);

                        // Add all messages to the buffer
                        for (const update of info.updates) {
                            await this.bufferTelegramUpdate(bufferKey, update, false); // Don't process immediately
                        }

                        // Now process the full buffer
                        await this.processTelegramUpdates(bufferKey);
                    }
                }, 1000); // 1 second debounce after each new message

                debounceInfo.timestamp = Date.now();
                processingDebounce.set(bufferKey, debounceInfo);
            }
        });

        // Other handlers remain the same
        this.bot.on('callback_query', (ctx: Context<Update>) => {
            console.log('Received unhandled callback query:', ctx.callbackQuery);
            const adapter = new ContextAdapter(ctx, this.promptManager);
            return this.handleCallbackQuery(adapter, interactionType!, progressKey);
        });

        console.log('Message handlers set up successfully');
    }

    /**
    * Buffers a Telegram update that might be part of a split message
    * @param processImmediately Whether to process immediately if buffer reaches threshold
    */
    private async bufferTelegramUpdate(
        bufferKey: string,
        ctx: Context<Update>,
        processImmediately: boolean = true
    ): Promise<void> {
        const existingBuffer = this.updateBuffer.get(bufferKey);
        const currentTime = Date.now();

        // Case 1: No existing buffer - start one
        if (!existingBuffer) {
            console.log(`[bufferTelegramUpdate] Starting buffer for ${bufferKey}`);

            // Schedule processing timeout only if we're processing immediately
            let timer: NodeJS.Timeout | null = null;
            if (processImmediately) {
                timer = setTimeout(() => {
                    this.processTelegramUpdates(bufferKey);
                }, this.MESSAGE_JOINING_WINDOW);
            }

            // Create new buffer
            this.updateBuffer.set(bufferKey, {
                updates: [ctx],
                lastUpdate: currentTime,
                processingTimer: timer
            });

            return;
        }

        // Case 2: Add to existing buffer
        existingBuffer.updates.push(ctx);
        existingBuffer.lastUpdate = currentTime;

        console.log(`[bufferTelegramUpdate] Added update ${existingBuffer.updates.length} to buffer for ${bufferKey}`);

        // Clear existing timer and set a new one if processing immediately
        if (existingBuffer.processingTimer) {
            clearTimeout(existingBuffer.processingTimer);
            existingBuffer.processingTimer = null;
        }

        if (processImmediately) {
            existingBuffer.processingTimer = setTimeout(() => {
                this.processTelegramUpdates(bufferKey);
            }, this.MESSAGE_JOINING_WINDOW);
        }

        // Safety check - if we've exceeded the update limit, process immediately if needed
        if (processImmediately && existingBuffer.updates.length >= this.MAX_BUFFERED_UPDATES) {
            console.log(`[bufferTelegramUpdate] Max updates reached for ${bufferKey}, processing now`);

            // Clear timer since we're processing now
            if (existingBuffer.processingTimer) {
                clearTimeout(existingBuffer.processingTimer);
                existingBuffer.processingTimer = null;
            }

            // Process immediately
            await this.processTelegramUpdates(bufferKey);
        }
    }

    /**
 * Processes buffered Telegram updates by joining their text
 */
    private async processTelegramUpdates(bufferKey: string): Promise<void> {
        const buffer = this.updateBuffer.get(bufferKey);
        if (!buffer || buffer.updates.length === 0) {
            console.warn(`[processTelegramUpdates] No buffer found for ${bufferKey}`);
            return;
        }

        console.log(`[processTelegramUpdates] Processing ${buffer.updates.length} updates for ${bufferKey}`);

        try {
            // Extract text from all updates - only keep ones with text
            const textParts = buffer.updates
                .filter(ctx => ctx.message && 'text' in ctx.message && ctx.message.text)
                .map(ctx => (ctx.message as any).text as string);

            if (textParts.length === 0) {
                console.warn(`[processTelegramUpdates] No text parts found in buffer for ${bufferKey}`);
                this.updateBuffer.delete(bufferKey);
                return;
            }

            // Only proceed with joining if we have multiple parts
            const shouldJoinParts = textParts.length > 1;

            // Join text parts if we have multiple parts
            const joinedText = shouldJoinParts
                ? this.joinMessageParts(textParts)
                : textParts[0];

            console.log(`[processTelegramUpdates] ${shouldJoinParts ? 'Joined' : 'Using'} ${textParts.length} parts (${joinedText.length} chars) for ${bufferKey}`);

            // Use the first update as the base
            const baseCtx = buffer.updates[0];

            // Special handling for telegram updates
            if (baseCtx.message && 'text' in baseCtx.message) {
                // Create a deep copy of the context to avoid modifying the original
                const modifiedCtx = JSON.parse(JSON.stringify(baseCtx));

                // Add joined text info
                modifiedCtx.__joinedText = joinedText;
                modifiedCtx.__originalText = baseCtx.message.text;
                modifiedCtx.__isJoinedMessage = true;
                modifiedCtx.__partCount = textParts.length;

                // Process with special handler
                await this.handleJoinedMessage(baseCtx, joinedText, textParts.length);
            } else {
                console.warn(`[processTelegramUpdates] Base update has no text message for ${bufferKey}`);

                // Process original as fallback
                const adapter = new ContextAdapter(baseCtx, this.promptManager);
                await this.handleMessage(adapter, this.conversationManager!, this.agentManager);
            }
        } catch (error) {
            console.error(`[processTelegramUpdates] Error processing updates for ${bufferKey}:`, error);

            // Fallback to first update
            if (buffer.updates.length > 0) {
                const firstUpdate = buffer.updates[0];
                const adapter = new ContextAdapter(firstUpdate, this.promptManager);
                await this.handleMessage(adapter, this.conversationManager!, this.agentManager);
            }
        } finally {
            // Clear buffer
            this.updateBuffer.delete(bufferKey);
        }
    }

    /**
 * Special handler for joined messages that preserves the original context
 */
    private async handleJoinedMessage(
        ctx: Context<Update>,
        joinedText: string,
        partCount: number
    ): Promise<void> {
        console.log(`[handleJoinedMessage] Processing joined message with ${joinedText.length} chars from ${partCount} parts`);

        try {
            // Create a deep copy of the original context to avoid modifying it
            // Instead of creating a new custom context, modify the original one's message text
            if (ctx.message && 'text' in ctx.message) {
                // Store the original text for debugging/reference
                const originalText = ctx.message.text;

                // Modify the message text directly in the original context
                ctx.message.text = joinedText;

                // Add metadata to the context for debugging and tracking
                (ctx as any).__joinedText = joinedText;
                (ctx as any).__originalText = originalText;
                (ctx as any).__isJoinedMessage = true;
                (ctx as any).__partCount = partCount;

                console.log(`[handleJoinedMessage] Modified original context with joined text (${joinedText.length} chars)`);

                // Use the original context with the modified text
                const adapter = new ContextAdapter(ctx, this.promptManager);

                // Process the joined message using the proper context
                await this.handleMessage(adapter, this.conversationManager!, this.agentManager);
            } else {
                throw new Error('Original message context does not contain text');
            }
        } catch (error) {
            console.error('[handleJoinedMessage] Error processing joined message:', error);

            // Try to send an error message
            try {
                await ctx.reply("I'm sorry, I had difficulty processing your multi-part message. Please try sending it differently.");
            } catch (replyError) {
                console.error('[handleJoinedMessage] Error sending error reply:', replyError);
            }
        }
    }

    /**
     * Intelligently joins message parts into a single coherent message
     */
    private joinMessageParts(parts: string[]): string {
        if (parts.length === 1) return parts[0];

        // Log the parts we're joining for debugging
        console.log(`[joinMessageParts] Joining ${parts.length} parts:`);
        parts.forEach((part, i) => {
            console.log(`Part ${i + 1} (${part.length} chars): ${part.substring(0, 50)}...`);
        });

        return parts.map((part, index) => {
            // Clean up continuation markers
            let cleaned = part.trim();

            // Remove trailing ellipsis/dash from all but the last part
            if (index < parts.length - 1) {
                cleaned = cleaned.replace(/(\.\.\.|…|---)$/, '');
            }

            // Remove leading ellipsis/dash from all but the first part
            if (index > 0) {
                cleaned = cleaned.replace(/^(\.\.\.|…|---)/, '');
            }

            return cleaned;
        }).join('\n\n'); // Join with double newlines for better formatting
    }


    async waitForInitialization(): Promise<void> {
        if (this.initializationPromise) {
            await this.initializationPromise;
        } else {
            throw new Error('Initialization is not in progress.');
        }
    }



    private parseBotInfoInput(input: string | undefined): BotInfo[] {
        if (!input) {
            console.warn('No bot information provided. Using an empty array.');
            return [];
        }

        console.log('Parsing bot info input:', input);

        const botInfo = input.split(',').map(botString => {
            const [id, firstName, username] = botString.trim().split(':');
            if (!id) {
                console.warn(`Invalid bot info format: ${botString}. Skipping this entry.`);
                return null;
            }
            const botInfoEntry = {
                id: parseInt(id),
                firstName: firstName || `Bot ${id}`,
                username: username || `bot_${id}`,
                is_bot: true,
                is_admin: false // Assuming bots are not admins by default
            };
            console.log('Parsed bot info:', botInfoEntry);
            return botInfoEntry;
        }).filter((bot): bot is BotInfo => bot !== null);

        console.log('Total parsed bot info entries:', botInfo.length);
        return botInfo;
    }
    public getBotIds(): number[] {
        if (!this.botInfo || !Array.isArray(this.botInfo)) {
            console.warn('Bot info is not properly initialized');
            return [];
        }
        return this.botInfo.map(bot => bot.id);
    }
    // Method to get bot IDs (for compatibility with existing code)
    // public getBotIds(): number[] {
    //     return this.botInfo.map(bot => bot.id);
    // }

    // New method to get all bot info
    public getAllBotInfo(): BotInfo[] {
        return this.botInfo;
    }

    private setupActionHandlers(): void {
        console.log('Entering setupActionHandlers method');
        if (!this.bot) {
            console.error('setupActionHandlers: Bot is not initialized');
            return;
        }

        this.bot.action(/confirm_(\d+)_(.+)/, (ctx) => {
            console.log('Confirm clear memory action triggered with data:', ctx.match);
            return this.handleConfirmClearMemory(ctx);
        });

        this.bot.action(/cancel_(\d+)_(.+)/, (ctx) => {
            console.log('Cancel clear memory action triggered with data:', ctx.match);
            return this.handleCancelClearMemory(ctx);
        });

        this.bot.action(/confirm_all_(\d+)/, (ctx) => {
            console.log('Confirm clear all memory action triggered with data:', ctx.match);
            return this.handleConfirmClearAllMemory(ctx);
        });

        this.bot.action(/cancel_all_(\d+)/, (ctx) => {
            console.log('Cancel clear all memory action triggered with data:', ctx.match);
            return this.handleCancelClearAllMemory(ctx);
        });

        console.log('Action handlers set up successfully');
    }

    private setupFileHandlers(): void {
        if (!this.bot) {
            console.error('setupActionHandlers: Bot is not initialized');
            return;
        }
        // Handle audio files using filter utilities
        this.bot.on(message('audio', 'voice'), async (ctx) => {
            const adapter = new ContextAdapter(ctx, this.promptManager);
            await this.detectAndOfferProcessing(adapter, 'audio');
        });

        // Handle video files using filter utilities
        this.bot.on(message('video', 'video_note'), async (ctx) => {
            const adapter = new ContextAdapter(ctx, this.promptManager);
            await this.detectAndOfferProcessing(adapter, 'video');
        });

        // Handle document uploads that might be media files
        this.bot.on(message('document'), async (ctx) => {
            const adapter = new ContextAdapter(ctx, this.promptManager);
            await this.detectAndOfferDocumentProcessing(adapter);
        });
    }
    /**
  * Gets the group members for a chat
  * Attempts to fetch them if not available in memory
  */
    public async getGroupMembers(chatId: number | string): Promise<Map<number, GroupMemberInfo> | undefined> {
        const methodName = 'getGroupMembers';
        const chatIdNum = typeof chatId === 'string' ? parseInt(chatId, 10) : chatId;

        // Try to get cached members first
        let members = this.groupMembers.get(chatIdNum);

        // If we don't have members and bot is available, try to fetch them
        if (!members && this.bot) {
            try {
                logInfo(methodName, `No cached members for chat ${chatIdNum}, attempting to fetch`);

                // Create a new map for this chat
                members = new Map<number, GroupMemberInfo>();

                // Fetch administrators first as they're always accessible
                const admins = await this.bot.telegram.getChatAdministrators(chatIdNum);

                // Add admins to the map
                for (const admin of admins) {
                    members.set(admin.user.id, {
                        is_bot: admin.user.is_bot,
                        is_admin: true,
                        username: admin.user.username,
                        first_name: admin.user.first_name
                    });
                }

                // Add known bots from botInfo
                for (const bot of this.botInfo) {
                    if (!members.has(bot.id)) {
                        members.set(bot.id, {
                            is_bot: true,
                            is_admin: false,
                            username: bot.username,
                            first_name: bot.firstName
                        });
                    }
                }

                // Store in cache
                this.groupMembers.set(chatIdNum, members);

                logInfo(methodName, `Fetched ${members.size} members for chat ${chatIdNum}`);
            } catch (error) {
                logError(methodName, `Error fetching members for chat ${chatIdNum}`, error as Error);
                // Return undefined if we couldn't fetch members
                return undefined;
            }
        }

        return members;
    }
    private async handleConfirmClearMemory(ctx: Context) {
        console.log('Entering handleConfirmClearMemory');
        const adapter = new ContextAdapter(ctx, this.promptManager);
        const methodName = 'handleConfirmClearMemory';
        const context = adapter.getMessageContext();

        if (!this.conversationManager || !this.agentManager || !this.promptManager) {
            logError(methodName, 'Essential managers are not initialized', new Error('Essential managers are null'));
            return "I'm sorry, but I'm not ready to Delete messages yet 🧐.";
        }



        if (!ctx.match) {
            console.error(`${methodName}: No match found in context`);
            await adapter.answerCallbackQuery('An error occurred. Please try again.');
            return;
        }

        console.log(`${methodName}: Match data:`, ctx.match);
        const { userId, sessionId } = await this.conversationManager.getSessionInfo(adapter);
        //   const [, userId, sessionId] = ctx.match;

        if (!this.memory) {
            console.error(`${methodName}: Memory is not initialized`);
            await adapter.answerCallbackQuery('Bot memory is not initialized. Please try again later.');
            await adapter.editMessageText('An error occurred. Bot memory is not initialized.');
            return;
        }

        try {
            await this.memory.clearChatMessagesExtended(userId, sessionId);
            await adapter.answerCallbackQuery('Memory cleared successfully.');
            await adapter.editMessageText('Your chat memory has been cleared.');
            console.log(`${methodName}: Memory cleared successfully for user ${userId} in session ${sessionId}`);
        } catch (error) {
            console.error(`${methodName}: Error clearing memory for user ${userId}:`, error);
            await adapter.answerCallbackQuery('An error occurred while clearing memory.');
            await adapter.editMessageText('An error occurred while clearing memory. Please try again later.');
        }
    }

    private async handleCancelClearMemory(ctx: Context) {
        const adapter = new ContextAdapter(ctx, this.promptManager);
        await adapter.answerCallbackQuery('Memory clear cancelled.');
        await adapter.editMessageText('Memory clear cancelled. Your chat history remains intact.');
    }



    private async handleConfirmClearAllMemory(ctx: Context) {
        const adapter = new ContextAdapter(ctx, this.promptManager);
        const methodName = 'handleConfirmClearAllMemory';

        if (!ctx.match) {
            logError(methodName, 'No match found in context', new Error('Match is null'));
            await adapter.answerCallbackQuery('An error occurred. Please try again.');
            return;
        }

        const [, userId] = ctx.match;
        const adminId = parseInt(userId);

        if (!this.conversationManager || !this.memory) {
            logError(methodName, 'ConversationManager or Memory is not initialized', '');
            await adapter.answerCallbackQuery('Bot is not fully initialized. Please try again later.');
            await adapter.editMessageText('An error occurred. Bot is not fully initialized.');
            return;
        }

        try {
            logInfo(methodName, `Admin ${adminId} attempting to clear all memory`);

            // Use the clearAllChatMessages method if available
            if (typeof this.memory.clearAllChatMessages === 'function') {
                console.log(`[${methodName}] Using memory.clearAllChatMessages()`);
                await this.memory.clearAllChatMessages();
                console.log(`[${methodName}] Successfully cleared all chat messages`);
            } else {
                // Fallback to clear if clearAllChatMessages is not available
                console.log(`[${methodName}] clearAllChatMessages not available, using clear()`);
                await this.memory.clear();
                console.log(`[${methodName}] Cleared using available method`);
            }

            logInfo(methodName, `All memory cleared successfully by admin ${adminId}`);

            await adapter.answerCallbackQuery('All memory cleared successfully.');
            await adapter.editMessageText('All chat memories have been cleared.');

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            logError(methodName, `Error clearing all memory`, error as Error);

            await adapter.answerCallbackQuery('An error occurred while clearing memory.');
            await adapter.editMessageText(`An error occurred while clearing memory: ${errorMessage}`);
        }
    }

    private async handleCancelClearAllMemory(ctx: Context) {
        const adapter = new ContextAdapter(ctx, this.promptManager);
        const methodName = 'handleCancelClearAllMemory';

        try {
            await adapter.answerCallbackQuery('Clear all memory cancelled.');
            await adapter.editMessageText('Clear all memory cancelled. All chat histories remain intact.');
            logInfo(methodName, 'Clear all memory action cancelled');
        } catch (error) {
            logError(methodName, 'Error handling cancel clear all memory', error as Error);
            await adapter.answerCallbackQuery('An error occurred. Please try again.');
        }
    }

    private adaptMemory(externalMemory: any): IExtendedMemory {
        const methodName = 'adaptMemory';

        const getMemoryClient = async () => {
            try {
                // Check the type of memory we're dealing with
                const memoryType = externalMemory.getMemoryType?.();
                console.log(`[${methodName}] Memory type:`, memoryType);

                // Generic promise check
                const hasPromise = Object.keys(externalMemory).some(key =>
                    key.toLowerCase().includes('client') &&
                    externalMemory[key] instanceof Promise
                );

                if (hasPromise) {
                    console.log(`[${methodName}] Found async client initialization`);
                    for (const [key, value] of Object.entries(externalMemory)) {
                        if (value instanceof Promise) {
                            console.log(`[${methodName}] Waiting for client initialization:`, key);
                            const client = await value;
                            return client;
                        }
                    }
                }

                // If no promise found, return the memory object itself
                return externalMemory;
            } catch (error) {
                console.warn(`[${methodName}] Error getting memory client:`, error);
                return externalMemory;
            }
        };

        // Removed initializeSession helper function as it's no longer needed

        // Check for Zep capabilities
        const isZepMemory = externalMemory.getMemoryType?.()?.includes('Zep') ||
            Object.keys(externalMemory).some(key =>
                key.toLowerCase().includes('zep') ||
                (externalMemory[key] && typeof externalMemory[key] === 'object' &&
                    externalMemory[key].constructor &&
                    externalMemory[key].constructor.name?.includes('Zep'))
            );

        console.log(`[${methodName}] Memory has Zep capabilities:`, isZepMemory);

        // Now return the enhanced memory object
        return {
            ...externalMemory,

            getChatMessagesExtended: async (userId: string, sessionId: string, returnBaseMessages?: boolean, prependMessages?: ExtendedIMessage[], overrideUserId = '') => { // Removed skipUserFilter, will use overrideUserId sentinel
                const client = await getMemoryClient();
                console.log(`[adaptMemory] Getting messages with client type:`, client?.constructor?.name);

                try {
                    // Clean the session ID
                    const cleanedSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');

                    // Removed call to initializeSession
                    const effectiveUserId = overrideUserId || userId; // Use override if provided

                    let messages;

                    // Try different methods to get chat messages
                    if (typeof client.getMemory === 'function') {
                        // For local Zep
                        console.log(`[adaptMemory] Using getMemory method`);
                        const memory = await client.getMemory(cleanedSessionId);
                        messages = memory?.messages || [];
                    } else if (typeof client.getChatMessages === 'function') {
                        // For cloud Zep / StandaloneZepMemory
                        console.log(`[adaptMemory] Using getChatMessages method`);
                        // Pass effectiveUserId as the overrideUserId argument
                        messages = await client.getChatMessages(cleanedSessionId, returnBaseMessages, prependMessages, effectiveUserId);
                    } else if (typeof client.memory?.getMessages === 'function') {
                        // Another possible method
                        console.log(`[adaptMemory] Using memory.getMessages method`);
                        const result = await client.memory.getMessages(cleanedSessionId);
                        messages = result?.messages || [];
                    } else if (typeof client.memory?.get === 'function') {
                        // Try memory.get method
                        console.log(`[adaptMemory] Using memory.get method`);
                        const memory = await client.memory.get(cleanedSessionId);
                        messages = memory?.messages || [];
                    } else {
                        console.error(`[adaptMemory] No suitable method found to retrieve messages`);
                        return [];
                    }

                    console.log(`[adaptMemory] Retrieved ${messages.length} raw messages using available method`);

                    // Filter messages by effectiveUserId if available in metadata
                    const effectiveUserIdForFilter = overrideUserId || userId; // Ensure we use the correct ID for filtering
                    const filteredMessages = messages.filter((msg: any) => {
                        const hasUserIdMetadata = !!msg.metadata?.userId;
                        const matchesUserId = msg.metadata?.userId === effectiveUserIdForFilter;
                        const keep = !hasUserIdMetadata || matchesUserId;

                        // Optional: Add debug logging for filtering decision
                        // if (hasUserIdMetadata) {
                        //     console.log(`[adaptMemory Filtering] msgUserId=${msg.metadata?.userId}, effectiveUserId=${effectiveUserIdForFilter}, keep=${keep}`);
                        // }

                        return keep;
                    });
                    console.log(`[adaptMemory] Filtered ${messages.length} messages down to ${filteredMessages.length} for userId=${effectiveUserIdForFilter}`);


                    // Clean the FILTERED messages based on their type
                    const cleanedMessages = filteredMessages.map((msg: any) => {
                        if (msg instanceof BaseMessage) {
                            // For BaseMessage instances, create a new instance
                            const cleanedContent = this.cleanMessageContent(
                                typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
                            );

                            if (msg.getType() === 'human') {
                                return new HumanMessage(cleanedContent, msg.additional_kwargs);
                            } else if (msg.getType() === 'ai') {
                                return new AIMessage(cleanedContent, msg.additional_kwargs);
                            } else {
                                return new SystemMessage(cleanedContent, msg.additional_kwargs);
                            }
                        } else {
                            // For other message types (like FlowiseIMessage)
                            const cleanedMessage = { ...msg };
                            if (typeof msg.message === 'string') {
                                cleanedMessage.message = this.cleanMessageContent(msg.message);
                            }
                            if (typeof msg.text === 'string') {
                                cleanedMessage.text = this.cleanMessageContent(msg.text);
                            }
                            return cleanedMessage;
                        }
                    });


                    if (returnBaseMessages) {
                        return cleanedMessages;
                    }

                    return this.convertToExtendedIMessages(cleanedMessages);
                } catch (error) {
                    console.error(`[adaptMemory] Error getting messages:`, error);
                    return [];
                }
            },

            // Removed addChatMessagesExtended definition as it should use the standard addChatMessages

            clearChatMessagesExtended: async (userId: string, sessionId: string) => {
                if (typeof externalMemory.clearChatMessages === 'function') {
                    if (!this.memory) {
                        console.log(`[${methodName}] Bot memory is not initialized. Please try again later.`);
                        return;
                    }
                    try {
                        const key = sessionId.startsWith('flowise_') ? sessionId : sessionId;
                        await this.memory.clear();
                        console.log(`[${methodName}] Cleared messages for key:`, key);
                    } catch (error) {
                        console.warn(`[${methodName}] Error clearing chat messages:`, error);
                    }
                }
            },

            clearAllChatMessages: async () => {
                const clearAllMethodName = 'adaptMemory.clearAllChatMessages';
                console.log(`[${clearAllMethodName}] Starting to clear all chat sessions`);

                try {
                    // Only use externalMemory.clearAllChatMessages if it exists
                    if (typeof externalMemory.clearAllChatMessages === 'function') {
                        console.log(`[${clearAllMethodName}] Using externalMemory.clearAllChatMessages()`);
                        await externalMemory.clearAllChatMessages();
                        return;
                    }

                    // If no proper method is available, log a warning
                    console.warn(`[${clearAllMethodName}] externalMemory does not have a clearAllChatMessages method implemented`);
                    console.warn(`[${clearAllMethodName}] Only the current session's memory will be cleared`);

                    // Fall back to clearing just the current session and log clearly that this is a limited action
                    if (typeof externalMemory.clearChatMessages === 'function') {
                        console.log(`[${clearAllMethodName}] Falling back to clearing only current session via clearChatMessages`);
                        await externalMemory.clearChatMessages();
                    } else if (typeof externalMemory.clear === 'function') {
                        console.log(`[${clearAllMethodName}] Falling back to clearing only current session via clear()`);
                        await externalMemory.clear();
                    } else {
                        console.warn(`[${clearAllMethodName}] No method available to clear memory at all`);
                    }
                } catch (error) {
                    console.warn(`[${clearAllMethodName}] Error in clearAllChatMessages:`, error);
                }
            },

            // Keep existing FlowiseMemory properties and method bindings...
            getMemoryType: () => typeof externalMemory.getMemoryType === 'function'
                ? externalMemory.getMemoryType()
                : `Adapted${externalMemory.constructor.name || 'ExternalMemory'}`,
            returnMessages: externalMemory.returnMessages ?? true,
            inputKey: externalMemory.inputKey || 'input',
            outputKey: externalMemory.outputKey || 'output',
            humanPrefix: externalMemory.humanPrefix || 'Human',
            aiPrefix: externalMemory.aiPrefix || 'AI',
            memoryKey: externalMemory.memoryKey || 'chat_history',
            memoryKeys: externalMemory.memoryKeys || ['chat_history'],

            // Bind original methods
            getChatMessages: externalMemory.getChatMessages?.bind(externalMemory),
            addChatMessages: externalMemory.addChatMessages?.bind(externalMemory),
            clearChatMessages: externalMemory.clearChatMessages?.bind(externalMemory),
            saveContext: externalMemory.saveContext?.bind(externalMemory),
            loadMemoryVariables: externalMemory.loadMemoryVariables?.bind(externalMemory),
            clear: externalMemory.clear?.bind(externalMemory),

            // Add Zep-specific methods that still exist after refactor
            getFullZepMemory: externalMemory.getFullZepMemory?.bind(externalMemory),
            getChatFacts: externalMemory.getChatFacts?.bind(externalMemory), // Bind getChatFacts
            getSessionSummary: externalMemory.getSessionSummary?.bind(externalMemory),
            // Removed searchKnowledgeGraph as it was likely tied to the SDK/graph features

            // Removed bindings for graph-specific methods
        };
    }

    private cleanMessageContent(content: string): string {
        if (!content) return '';

        try {
            // Clean up ZEP IDs and related text
            return content
                .replace(/user zep_[a-f0-9]+|zep_[a-f0-9]+/g, 'user')
                .replace(/(human who is a user|the user): User has the id of zep_[a-f0-9]+/g, '$1')
                .replace(/\s+/g, ' ')
                .trim();
        } catch (error) {
            console.error('Error cleaning message content:', error);
            return content;
        }
    }

    private convertToExtendedIMessages(messages: any[]): ExtendedIMessage[] {
        return messages.map(msg => {
            try {
                if (msg instanceof BaseMessage) {
                    const text = this.cleanMessageContent(
                        typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
                    );
                    return {
                        type: msg.getType() === 'human' ? 'userMessage' : 'apiMessage',
                        message: text,
                        text: text,
                        additional_kwargs: msg.additional_kwargs
                    };
                } else if ('message' in msg || 'text' in msg) {
                    // Handle FlowiseIMessage or similar
                    const text = this.cleanMessageContent(
                        (msg.message || msg.text || '').toString()
                    );
                    return {
                        type: msg.type || 'apiMessage',
                        message: text,
                        text: text,
                        additional_kwargs: msg.additional_kwargs
                    };
                }
                throw new Error(`Unsupported message type: ${typeof msg}`);
            } catch (error) {
                console.error('Error converting message:', error);
                return {
                    type: 'apiMessage',
                    message: 'Error processing message',
                    text: 'Error processing message'
                };
            }
        });
    }

    private convertToFlowiseIMessages(messages: (ExtendedIMessage | BaseMessage)[]): { text: string; type: MessageType; input?: { content: string }; output?: { content: string } }[] {
        const methodName = 'convertToFlowiseIMessages';
        console.log(`[${methodName}] Converting ${messages.length} messages`);

        return messages.map((msg, index) => {
            if (this.isExtendedIMessage(msg)) {
                const text = messageContentToString(msg.message || msg.text || '');
                const result: { text: string; type: MessageType; input?: { content: string }; output?: { content: string } } = {
                    type: msg.type,
                    text,
                    input: {
                        content: text
                    }
                };

                if (msg.type === 'apiMessage') {
                    result.output = {
                        content: text
                    };
                }

                console.log(`[${methodName}] Converted ExtendedIMessage ${index + 1}:`, {
                    type: result.type,
                    hasInput: !!result.input,
                    hasOutput: !!result.output
                });

                return result;
            } else if (this.isBaseMessage(msg)) {
                const text = messageContentToString(msg.content);
                const type = msg.getType() === 'human' ? 'userMessage' : 'apiMessage';
                const result: { text: string; type: MessageType; input?: { content: string }; output?: { content: string } } = {
                    type,
                    text,
                    input: {
                        content: text
                    }
                };

                if (type === 'apiMessage') {
                    result.output = {
                        content: text
                    };
                }

                console.log(`[${methodName}] Converted BaseMessage ${index + 1}:`, {
                    originalType: msg.getType(),
                    convertedType: type,
                    hasInput: !!result.input,
                    hasOutput: !!result.output
                });

                return result;
            }

            console.warn(`[${methodName}] Unknown message type for message ${index + 1}:`, msg);
            throw new Error("Unsupported message type");
        });
    }
    private isExtendedIMessage(msg: any): msg is ExtendedIMessage {
        return msg &&
            'type' in msg &&
            ('message' in msg || 'text' in msg) &&
            (msg.message !== null && msg.message !== undefined ||
                msg.text !== null && msg.text !== undefined);
    }

    private isBaseMessage(msg: any): msg is BaseMessage {
        return msg instanceof BaseMessage &&
            msg.content !== null &&
            msg.content !== undefined;
    }

    public convertToBaseMessages(messages: ExtendedIMessage[]): BaseMessage[] {
        console.log(`[convertToBaseMessages] Starting conversion of ${messages.length} messages to BaseMessages`);

        const baseMessages = messages.filter(msg => {
            const content = messageContentToString(msg.text || msg.message);
            return content !== null && content !== undefined && content.trim() !== '';
        }).map((msg, index) => {
            let baseMsg: BaseMessage;
            const content = messageContentToString(msg.text || msg.message);

            switch (msg.type) {
                case 'userMessage':
                    baseMsg = new HumanMessage(content);
                    break;
                case 'apiMessage':
                    baseMsg = new AIMessage(content);
                    break;
                default:
                    console.warn(`[convertToBaseMessages] Unknown message type at index ${index}, defaulting to SystemMessage`);
                    baseMsg = new SystemMessage(content);
            }

            // Add input/output structure to additional_kwargs
            baseMsg.additional_kwargs = {
                ...msg.additional_kwargs,
                input: {
                    content
                },
                output: msg.type === 'apiMessage' ? {
                    content
                } : undefined
            };

            console.log(`[convertToBaseMessages] Converted message ${index + 1}:`, JSON.stringify({
                type: baseMsg.getType(),
                content: this.conversationManager!.getContentPreview(baseMsg.content),
                additional_kwargs: baseMsg.additional_kwargs
            }, null, 2));

            return baseMsg;
        });

        console.log(`[convertToBaseMessages] Completed conversion, resulting in ${baseMessages.length} BaseMessages`);
        return baseMessages;
    }
    public togglePersona(enable: boolean): void {
        if (this.conversationManager) {
            this.conversationManager.togglePersona(enable);
        } else {
            console.warn('ConversationManager not initialized. Cannot toggle persona.');
        }
    }

    public async stop(signal?: string): Promise<void> {
        console.log(`[FlowID: ${this.flowId}] Stopping TelegramBot_Agents${signal ? ` due to ${signal}` : ''}...`);

        try {
            // Clear update process
            if (this.updateProcess) {
                clearInterval(this.updateProcess);
                this.updateProcess = null;
                console.log(`[FlowID: ${this.flowId}] Update process cleared.`);
            }

            // Stop the bot
            if (this.bot && this.isRunning) {
                console.log(`[FlowID: ${this.flowId}] Stopping bot${signal ? ` due to ${signal}` : ''}...`);
                try {
                    await this.bot.stop(signal);
                    console.log(`[FlowID: ${this.flowId}] Bot stopped successfully.`);
                } catch (error) {
                    console.error(`[FlowID: ${this.flowId}] Error stopping bot:`, error);
                }
            }

            if (this.periodicLoggers) {
                for (const [name, timer] of this.periodicLoggers.entries()) {
                    clearInterval(timer);
                    console.log(`[FlowID: ${this.flowId}] Cleared periodic logger: ${name}`);
                }
                this.periodicLoggers.clear();
            }

            // Clean up managers
            await this.cleanupManagers();

            // Reset state
            this.isInitialized = false;
            this.isRunning = false;
            this.bot = null;
            this.memory = null;
            this.botInfo = [];

            // Remove this flow's data from chat-to-flow mapping
            this.removeChatFlowMapping();

            console.log(`[FlowID: ${this.flowId}] TelegramBot_Agents stopped successfully.`);
        } catch (error) {
            console.error(`[FlowID: ${this.flowId}] Error during stop process:`, error);
        }
    }

    private async cleanupManagers(): Promise<void> {
        console.log(`[FlowID: ${this.flowId}] Cleaning up managers...`);

        // Clear periodic loggers
        for (const [name, timer] of this.periodicLoggers.entries()) {
            clearInterval(timer);
            console.log(`[FlowID: ${this.flowId}] Cleared periodic logger: ${name}`);
        }
        this.periodicLoggers.clear();

        if (this.conversationManager) {
            await this.conversationManager.cleanup();
            (this.conversationManager as any) = null;
        }

        if (this.conversationManager) {
            await this.conversationManager.cleanup();
            (this.conversationManager as any) = null;
        }

        if (this.promptManager) {
            this.promptManager.cleanup();
            (this.promptManager as any) = null;
        }

        if (this.agentManager) {
            await this.agentManager.cleanup();
            (this.agentManager as any) = null;
        }

        if (this.menuManager) {
            this.menuManager.cleanup();
            (this.menuManager as any) = null;
        }

        if (this.commandHandler) {
            await this.commandHandler.cleanup();
            this.commandHandler = new CommandHandler(
                null as any, // bot
                null as any, // conversationManager
                null as any, // memory
                null as any, // promptManager
                null as any, // agentManager
                null as any, // menuManager
                null as any, // flowId
                null as any, // toolManager
                null as any, // fileManager
                { telegramBot: this }
            );
        }

        if (this.toolManager) {
            await this.toolManager.cleanup();
            (this.toolManager as any) = null;
        }

        console.log(`[FlowID: ${this.flowId}] Managers cleaned up successfully.`);
    }
    // In TelegramBot_Agents.ts, add a new method:
    /**
     * Adds or updates a periodic logger
     * @param name Unique name for the logger
     * @param interval Function to execute periodically
     * @param intervalMs Time between executions in milliseconds
     */
    public setPeriodicLogger(name: string, interval: () => void, intervalMs: number): void {
        // Clear any existing timer with this name
        const existingTimer = this.periodicLoggers.get(name);
        if (existingTimer) {
            clearInterval(existingTimer);
            console.log(`[FlowID: ${this.flowId}] Cleared existing periodic logger: ${name}`);
        }

        // Set the new timer
        const timer = setInterval(interval, intervalMs);
        this.periodicLoggers.set(name, timer);
        console.log(`[FlowID: ${this.flowId}] Set periodic logger: ${name}, interval: ${intervalMs}ms`);
    }

    /**
     * Removes a periodic logger
     * @param name Name of the logger to remove
     */
    public clearPeriodicLogger(name: string): void {
        const timer = this.periodicLoggers.get(name);
        if (timer) {
            clearInterval(timer);
            this.periodicLoggers.delete(name);
            console.log(`[FlowID: ${this.flowId}] Removed periodic logger: ${name}`);
        }
    }

    /**
     * Checks if a periodic logger exists
     * @param name Name of the logger to check
     * @returns True if the logger exists
     */
    public hasPeriodicLogger(name: string): boolean {
        return this.periodicLoggers.has(name);
    }

    private removeChatFlowMapping(): void {
        for (const [chatId, flowId] of this.chatFlowMap.entries()) {
            if (flowId === this.flowId) {
                this.chatFlowMap.delete(chatId);
                console.log(`[FlowID: ${this.flowId}] Removed mapping for chatId: ${chatId}`);
            }
        }
    }

    private async processAIMessage(adapter: ContextAdapter, input: string): Promise<void> {
        const context = adapter.getMessageContext();
        const { userId, sessionId } = await this.conversationManager!.getSessionInfo(context);
        console.log(`Processing AI message for user ${userId} in session ${sessionId}`);
        // Implement AI message processing logic here
        // This could involve updating the conversation state or performing specific actions

        // For example:
        // await this.conversationManager.updateAIMessage(userId, sessionId, message);
        // Or any other specific actions you want to perform for AI messages
    }

    public async handleProcessingError(adapter: ContextAdapter, error: unknown): Promise<void> {
        const methodName = 'handleProcessingError';
        const context = adapter.getMessageContext();
        const { userId, sessionId } = await this.conversationManager!.getSessionInfo(context);

        logError(
            methodName,
            `Error processing message`,
            error,
            { userId, sessionId, messageId: context.messageId }
        );

        const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
        await adapter.reply(`I'm sorry, but I encountered an error while processing your message. Please try again later. If the problem persists, contact support.`);
    }

    private cleanMessage(context: MessageContext): string {
        // Safely check if chat exists and is private
        const isPrivateChat = context.raw?.chat?.type === 'private';

        // If no input, return empty string
        if (!context.input) return '';

        return isPrivateChat ?
            context.input.trim() :
            context.input.replace(new RegExp(`@${this.bot?.botInfo?.username}\\b`, 'i'), '').trim();
    }


    public async updateProgress(adapter: ContextAdapter, progressKey: string, stage: string): Promise<boolean> {
        try {
            if (!adapter.isTelegramMessage()) {
                return false;
            }

            return await adapter.updateProgress(this.flowId, progressKey, stage);
        } catch (error) {
            // Just log the error but don't let it stop processing
            console.warn(`[${this.flowId}] Error updating progress: ${error.message}`);
            return false;
        }
    }

    private splitMessage(text: string, maxLength: number): string[] {
        const chunks: string[] = [];
        let remainingText = text;

        while (remainingText.length > 0) {
            if (remainingText.length <= maxLength) {
                chunks.push(remainingText);
                break;
            }

            let chunk = remainingText.substring(0, maxLength);
            let splitIndex = chunk.lastIndexOf('\n');
            if (splitIndex === -1) splitIndex = chunk.lastIndexOf(' ');
            if (splitIndex === -1) splitIndex = maxLength;

            chunks.push(remainingText.substring(0, splitIndex));
            remainingText = remainingText.substring(splitIndex).trim();
        }

        return chunks;
    }

    private async handleCallbackQuery(adapter: ContextAdapter, interactionType: InteractionType, progressKey: string): Promise<void> {
        const methodName = 'handleCallbackQuery';
        const context = adapter.getMessageContext();
        if (!context.callbackQuery || !('data' in context.callbackQuery) || !context.callbackQuery.data) {
            console.error('Received callback query without data');
            return;
        }

        const data = context.callbackQuery.data.trim();
        console.log('Received callback query data:', data);

        // Handle question answer requests
        if (data.startsWith('answer_question:') || data.startsWith('ignore_question:')) {
            const [action, messageIdStr] = data.split(':');
            const messageId = parseInt(messageIdStr, 10);

            // Acknowledge the callback
            await adapter.safeAnswerCallbackQuery('Got it!');

            if (action === 'ignore_question') {
                try {
                    // Add diagnostic logging
                    console.log(`[${methodName}] Adapter context structure:`, JSON.stringify({
                        hasContext: !!adapter.context,
                        hasCallbackQuery: !!adapter.context?.callbackQuery,
                        callbackQueryKeys: adapter.context?.callbackQuery ? Object.keys(adapter.context.callbackQuery) : [],
                        hasMessage: !!adapter.context?.callbackQuery?.message,
                        messageKeys: adapter.context?.callbackQuery?.message ? Object.keys(adapter.context.callbackQuery.message) : [],
                        directMessageId: adapter.context?.callbackQuery?.message?.message_id,
                    }, null, 2));
                    // First acknowledge the callback query
                    await adapter.safeAnswerCallbackQuery('Question ignored');

                    // Parse the original message ID from the callback data
                    const [, originalMessageIdStr] = data.split(':');
                    const originalMessageId = parseInt(originalMessageIdStr, 10);

                    // Log the parsed data for debugging
                    console.log(`[${methodName}] Handling ignore_question for message ${originalMessageId}`);

                    // We need to delete the callback message (the one with the buttons)
                    // Get it directly from the telegramContext which has the unmodified structure
                    if (adapter.telegramContext?.callbackQuery?.message) {
                        const callbackMessageId = adapter.telegramContext.callbackQuery.message.message_id;
                        console.log(`[${methodName}] Deleting callback message with ID: ${callbackMessageId}`);

                        try {
                            await adapter.telegramContext.telegram.deleteMessage(
                                adapter.context.chatId,
                                callbackMessageId
                            );
                            console.log(`[${methodName}] Successfully deleted callback message ${callbackMessageId}`);
                        } catch (deleteError) {
                            console.error(`[${methodName}] Error deleting callback message:`, deleteError);
                            // Continue execution even if deletion fails
                        }
                    } else {
                        console.warn(`[${methodName}] Could not find callback message to delete`);
                    }

                    // Optionally, you could also try to delete the original message 
                    // (though this often requires admin privileges in groups)
                    /*
                    try {
                        await adapter.telegramContext.telegram.deleteMessage(
                            adapter.context.chatId,
                            originalMessageId
                        );
                        console.log(`[${methodName}] Successfully deleted original message ${originalMessageId}`);
                    } catch (deleteOriginalError) {
                        console.warn(`[${methodName}] Could not delete original message:`, deleteOriginalError);
                    }
                    */

                    return;
                } catch (error) {
                    console.error(`[${methodName}] Error handling ignore_question:`, error);
                    return;
                }
            }

            // For "answer_question", retrieve the stored question
            const cacheKey = `pending_question:${messageId}`;
            const questionData = this.conversationManager?.cache.get<CachedQuestionData>(cacheKey);

            if (!questionData) {
                await adapter.reply("I'm sorry, but I can't retrieve that question anymore.");
                return;
            }

            const { question, analysis, userId, sessionId } = questionData;



            // Set RAG mode if the analysis recommends it
            if (analysis.requiresRagMode) {
                const ragAgent = this.agentManager.getAgent('rag') as RAGAgent;
                if (ragAgent) {
                    ragAgent.toggleRAGMode(userId, true);
                    logInfo(methodName, 'Enabled RAG mode for question', { userId });
                }
            }

            // Process the question
            try {
                let sentConfirmation;
                // Get chat history
                const chatHistory = await this.getChatHistory(adapter);
                const chatId = adapter.getMessageContext().chatId;
                const processingText = "⏳ Processing your question...";
                sentConfirmation = await adapter.reply(processingText);
                const progressKey = `${chatId}:${sentConfirmation.message_id}`;


                // Prepare a detailed reply that acknowledges the question
                const fullQuestion = `Question from the group chat: "${question}"`;
                const initialConfirmation = this.getRandomConfirmationMessage();
                this.progressMessages.set(progressKey, initialConfirmation);


                try {
                    sentConfirmation = await adapter.reply(initialConfirmation);
                    // const progressKey = `${chatId}:${messageId}`;
                    this.sentConfirmations.set(progressKey, sentConfirmation.message_id);
                    // this.progressMessages.set(progressKey, initialConfirmation);
                    console.log(`[${methodName}] Set initial progress for key: ${progressKey}`);
                } catch (error) {
                    console.error('Error sending confirmation message:', error);
                }
                try {

                    if (sentConfirmation) {
                        console.log(methodName, `Attempting to update progress for Answer Question`);
                        const updated = await this.updateProgress(adapter, progressKey, "⌛️");
                        console.log(methodName, `Progress update result: ${updated}`);
                        console.log(`[${methodName}] Progress update for progressKey: ${progressKey}`);

                    }

                    // Process with our existing methods
                    const enhancedResponse = await this.processUserInput(
                        adapter,
                        fullQuestion,
                        chatHistory,
                        false, // isAI
                        false, // isReply
                        { message_id: messageId, text: question }, // Original question as replyToMessage
                        false, // isFollowUp
                        interactionType,
                        progressKey
                    );
                    if (sentConfirmation) {
                        console.log(methodName, `Attempting to update progress Finalizing the response`);
                        await this.updateProgress(adapter, progressKey, "✔️Finalizing the response...💥");
                    }

                    // Delete the "I'm working on it" message from the callback
                    if (context.callbackQuery?.message) {
                        try {
                            await adapter.deleteMessage();
                        } catch (error) {
                            console.warn('Failed to delete callback message:', error.message);
                        }
                    }

                    this.conversationManager?.cache.del(cacheKey);

                } catch (error) {
                    logError(methodName, 'Error processing question from callback', error as Error);

                    // Try to inform the user of the error
                    try {
                        if (context.callbackQuery?.message) {
                            await adapter.editMessageText(
                                "I'm sorry, but I encountered an error while processing this question."
                            );
                        } else {
                            await adapter.reply("I'm sorry, but I encountered an error while processing this question.");
                        }
                    } catch (replyError) {
                        console.error('Error sending error message:', replyError);
                    }
                } finally {
                    // Clean up any progress message
                    if (sentConfirmation) {
                        try {
                            // Wait a short time before deleting the confirmation message
                            setTimeout(async () => {
                                try {
                                    await adapter.deleteMessage(sentConfirmation.message_id);
                                    const finalProgressKey = progressKey;
                                    this.progressMessages.delete(finalProgressKey);
                                    this.sentConfirmations.delete(finalProgressKey);
                                    console.log(`[${methodName}] Cleaned up progress messages`);
                                } catch (cleanupError) {
                                    console.warn('Failed to clean up confirmation message:', cleanupError.message);
                                }
                            }, 3000); // 3 seconds delay
                        } catch (error) {
                            console.error('Error scheduling confirmation message cleanup:', error);
                        }
                    }
                }
            } catch (error) {
                logError(methodName, 'Error processing question from callback', error as Error);

                if (context.callbackQuery?.message) {
                    // Use adapter's method to edit the message
                    await adapter.editMessageText(
                        "I'm sorry, but I encountered an error while processing this question."
                    );
                }
            }

            return;
        }
        if (data.startsWith('prev_question:') || data.startsWith('next_question:') || data.startsWith('select_question:')) {
            const [action, setId] = data.split(':');
            const key = this.getChatKey(context);
            const questionSets = this.userQuestionSets.get(key);
            const questionData = questionSets?.get(setId);

            if (!questionData) {
                await adapter.safeAnswerCallbackQuery("This question set is no longer available.");
                return;
            }

            if (Date.now() > questionData.expirationTime) {
                await adapter.safeAnswerCallbackQuery("This question set has expired. Please generate new questions.");
                await this.cleanupQuestionSet(key, setId);
                return;
            }

            const now = Date.now();
            if (now - questionData.lastActionTime < 500) { // 500ms cooldown
                await adapter.safeAnswerCallbackQuery("Please wait a moment before your next action.");
                return;
            }
            questionData.lastActionTime = now;

            try {
                await adapter.safeAnswerCallbackQuery("💬");

                switch (action) {
                    case 'prev_question':
                        questionData.currentPage = (questionData.currentPage - 1 + questionData.questions.length) % questionData.questions.length;
                        await this.sendPaginatedQuestion(adapter, questionData, false);
                        break;
                    case 'next_question':
                        questionData.currentPage = (questionData.currentPage + 1) % questionData.questions.length;
                        await this.sendPaginatedQuestion(adapter, questionData, false);
                        break;
                    case 'select_question':
                        const selectedQuestion = questionData.questions[questionData.currentPage];
                        console.log(`Chat ${key} selected question: ${selectedQuestion}`);
                        await this.handleFollowUpQuestion(adapter, selectedQuestion);
                        break;
                }
            } catch (error) {
                console.error('Error handling question pagination:', error);
                if (error.description && error.description.includes('message to edit not found')) {
                    await adapter.safeAnswerCallbackQuery("This message is no longer available. Please generate new questions.");
                    await this.cleanupQuestionSet(key, setId);
                } else {
                    await adapter.safeAnswerCallbackQuery("An error occurred. Please try again.");
                }
            }
        } else if (data.startsWith('prev_citation:') || data.startsWith('next_citation:') || data.startsWith('close_citations:')) {
            const [action, setId] = data.split(':');
            const key = this.getCitationKey(context);
            const citationSets = this.userCitationSets.get(key);
            const citationData = citationSets?.get(setId);

            if (!citationData) {
                await adapter.safeAnswerCallbackQuery("This citation set is no longer available.");
                return;
            }

            if (Date.now() > citationData.expirationTime) {
                await adapter.safeAnswerCallbackQuery("This citation set has expired.");
                await this.cleanupCitationSet(key, setId);
                return;
            }

            const now = Date.now();
            if (now - citationData.lastActionTime < 500) { // 500ms cooldown
                await adapter.safeAnswerCallbackQuery("Please wait a moment before your next action.");
                return;
            }
            citationData.lastActionTime = now;

            try {
                await adapter.safeAnswerCallbackQuery("💬");

                switch (action) {
                    case 'prev_citation':
                        citationData.currentPage = (citationData.currentPage - 1 + citationData.citations.length) % citationData.citations.length;
                        await this.sendPaginatedCitation(adapter, citationData, false);
                        break;
                    case 'next_citation':
                        citationData.currentPage = (citationData.currentPage + 1) % citationData.citations.length;
                        await this.sendPaginatedCitation(adapter, citationData, false);
                        break;
                    case 'close_citations':
                        await this.cleanupCitationSet(key, setId);
                        await adapter.safeAnswerCallbackQuery("Citations closed.");
                        break;
                }
            } catch (error) {
                console.error('Error handling citation pagination:', error);
                if (error.description && error.description.includes('message to edit not found')) {
                    await adapter.safeAnswerCallbackQuery("This message is no longer available.");
                    await this.cleanupCitationSet(key, setId);
                } else {
                    await adapter.safeAnswerCallbackQuery("An error occurred. Please try again.");
                }
            }
        } else if (data.startsWith('fq:')) {
            await this.handleFollowUpQuestion(adapter, data.slice(3));
        } else if (data.startsWith('select_')) {
            const selectedBotId = parseInt(data.split('_')[1]);
            const botInfo = this.getAllBotInfo();
            const currentBotId = this.getBotIds()[0]; // Assuming the first ID is the current bot
            const selectedBot = botInfo.find(bot => bot.id === selectedBotId);

            if (selectedBot) {
                if (selectedBot.id === currentBotId) {
                    // This is the current bot, execute the start command
                    await this.commandHandler.executeCommandByName(adapter, 'start');
                } else {
                    // This is another bot, provide instructions to start it
                    const startCommand = `/start@${selectedBot.username}`;
                    await adapter.answerCallbackQuery(`To start ${selectedBot.firstName}, please use: ${startCommand}`);
                    await adapter.reply(`To activate ${selectedBot.firstName}, please click or tap this command: ${startCommand}`);
                }
            } else {
                await adapter.answerCallbackQuery("Sorry, I couldn't find the selected bot.");
            }
        } else if (data === 'help_command') {
            await this.commandHandler.executeCommandByName(adapter, 'help');
        } else if (data.startsWith('show_commands:')) {
            const [, botIdStr] = data.split(':');
            const callbackBotId = parseInt(botIdStr, 10);
            const thisBotId = this.bot?.botInfo?.id;

            if (thisBotId && callbackBotId === thisBotId) {
                await this.commandHandler.showCommandMenu(adapter, callbackBotId);
            } else {
                // This callback query is not for this bot, so we'll just acknowledge it
                await adapter.answerCallbackQuery('');
            }
        } else if (data.startsWith('execute_command:')) {
            const [, botId, commandName] = data.split(':');
            console.log(`Executing command: ${commandName}, for bot ID: ${botId}`);
            const thisBotId = this.bot?.botInfo?.id;
            if (thisBotId && parseInt(botId) === thisBotId) {
                await this.commandHandler.executeCommandByName(adapter, commandName);
            } else {
                console.warn(`Command mismatch. Expected Bot ID: ${thisBotId}, Received: ${botId}`);
                await adapter.answerCallbackQuery("This command is for a different bot.");
            }
        } else if (data.startsWith('change_page:')) {
            const [, botId, page] = data.split(':');
            await this.commandHandler.showCommandMenu(adapter, parseInt(botId), parseInt(page));
        } else if (data.startsWith('follow_up:')) {
            const question = data.split('follow_up:')[1];
            await adapter.answerCallbackQuery('');
            if (!this.conversationManager) {
                return;
            }
            if (context.callbackQuery.message && 'text' in context.callbackQuery.message) {
                const userId = context.userId.toString() || 'unknown';
                const { sessionId } = await this.conversationManager.getSessionInfo(adapter);
                const chatHistory = await this.getChatHistory(adapter);

                if (this.conversationManager) {
                    // We'll pass the question to handleMessage and let it handle the processing
                    await this.commandHandler.handleMessage(adapter, question);
                } else {
                    await adapter.reply("I'm sorry, but I'm not able to process follow-up questions at the moment.");
                }
            }
        } else if (data === 'remove_menu') {
            try {
                const deleted = await adapter.deleteMessage();
                if (deleted) {
                    console.log(`Menu removed successfully`);
                    await adapter.answerCallbackQuery('Menu removed successfully');
                } else {
                    console.error('Unable to remove menu');
                    await adapter.answerCallbackQuery('Unable to remove menu');
                }
            } catch (error) {
                console.error('Error removing menu:', error);
                await adapter.answerCallbackQuery('Error removing menu');
            }
        } else if (data.startsWith('millionaire_')) {
            const command = data.split('millionaire_')[1];
            if (this.commandHandler) {
                try {
                    const { userId, sessionId } = await this.conversationManager!.getSessionInfo(adapter);
                    console.warn(methodName, `Processing Command: ${command}, from source: ${context.source}`, { userId, sessionId });

                    const chatId = context.chatId;
                    const agentManager = this.getAgentManager();
                    if (!agentManager) {
                        throw new Error('AgentManager not available');
                    }

                    const gameAgent = agentManager.getAgent('game') as GameAgent;
                    if (!gameAgent) {
                        throw new Error('Game agent not available');
                    }

                    if (!chatId) {
                        throw new Error('Chat ID not available');
                    }

                    // Special case for 'new' command - allow anyone to start a new game
                    if (command === 'new') {
                        console.log(methodName, `Allowing new game creation for user ${userId}`);
                    }
                    // For all other commands, verify session ownership
                    else if (!gameAgent['isSessionOwner'](userId.toString(), chatId)) {
                        await adapter.answerCallbackQuery(
                            "Only the player who started the game can interact with it");
                        return;
                    }

                    if (progressKey) {
                        console.log(methodName, `Attempting to update progress for millionaire callback`);
                        const updated = await this.updateProgress(adapter, progressKey, "💰");
                        console.log(methodName, `Progress update result: ${updated}`);
                    }

                    // Route to CommandHandler's handleMillionaireCommand
                    await this.commandHandler.handleMillionaireCommand(
                        adapter,
                        command,
                        context.userId.toString()
                    );

                    return;
                } catch (error) {
                    // Error handling remains the same
                    console.error('Error handling millionaire callback:', error);
                    let errorMessage = "An error occurred processing your game action.";
                    if (error instanceof Error) {
                        if (error.message.includes('session')) {
                            errorMessage = error.message;
                        }
                    }
                    await adapter.answerCallbackQuery(errorMessage);
                }
            } else {
                console.error('CommandHandler not available for millionaire callback');
                await adapter.answerCallbackQuery(
                    "Game system is currently unavailable.",

                );
            }

        }
        // In handleCallbackQuery
        else if (data.startsWith('pattern_')) {
            const methodName = 'handleCallbackQuery';

            // Parse the command using a more reliable approach that handles multiple parameters
            const match = data.match(/^pattern_([^:]+)(?::(.+))?$/);
            if (!match) {
                console.warn(`[${methodName}] Invalid pattern command format:`, data);
                await adapter.answerCallbackQuery('Invalid pattern command');
                return;
            }

            const action = match[1]; // e.g., 'use', 'more', 'category', etc.
            const parameter = match[2]; // This might contain additional colons for nested parameters

            console.log(`[${methodName}] Pattern action: ${action}, parameter: ${parameter}`);
            await this.commandHandler?.handlePatternAction(adapter, action, parameter);
            return;
        }
        // In TelegramBot_Agents.ts handleCallbackQuery method:
        else if (data.startsWith('yt_')) {
            const methodName = 'handleCallbackQuery';
            const match = data.match(/^yt_([^:]+)(?::(.+))?$/);
            if (!match) {
                console.warn(`[${methodName}] Invalid YouTube command format:`, data);
                await adapter.answerCallbackQuery('Invalid YouTube command');
                return;
            }

            const action = match[1]; // e.g., 'get'
            const params = match[2] ? match[2].split(':') : []; // videoId, action

            if (action === 'get' && params.length >= 2) {
                const videoId = params[0];
                const youtubeAction = params[1]; // transcript, timestamps, metadata, comments
                console.log(`[${methodName}] YouTube action: ${action}, videoId: ${videoId}, youtubeAction: ${youtubeAction}`);

                // Make sure CommandHandler is available
                if (this.commandHandler) {
                    await this.commandHandler.handleYouTubeAction(adapter, videoId, youtubeAction);
                } else {
                    await adapter.reply("Sorry, the YouTube feature is not available right now.");
                }
                return;
            }

            await adapter.answerCallbackQuery('Invalid YouTube action');
            return;
        }

        // In CommandHandler.ts, within your handleCallbackQuery method or similar

        else if (data.startsWith('rumble_get:')) {
            const methodName = 'handleCallbackQuery';
            const match = data.match(/^rumble_get:([^:]+):(.+)$/);
            if (!match) {
                console.warn(`[${methodName}] Invalid Rumble command format:`, data);
                await adapter.answerCallbackQuery('Invalid Rumble command');
                return;
            }

            const videoId = match[1]; // e.g., 'v6qhrac'
            const rumbleAction = match[2]; // e.g., 'transcript'
            console.log(`[${methodName}] Rumble action: get, videoId: ${videoId}, rumbleAction: ${rumbleAction}`);

            // Call the handler directly since we're in the CommandHandler class
            await this.commandHandler.handleRumbleAction(adapter, videoId, rumbleAction);
            return;
        }
        // Add handler for processfile callbacks
        else if (data.startsWith('processfile:')) {
            const methodName = 'handleCallbackQuery';
            console.log(`[${methodName}] Process file action detected: ${data}`);

            // Ensure CommandHandler is available
            if (this.commandHandler) {
                // Delegate the full data string to the CommandHandler's method
                await this.commandHandler.handleProcessFileAction(adapter, data);
            } else {
                console.error(`[${methodName}] CommandHandler not available for processfile action`);
                await adapter.safeAnswerCallbackQuery('File processing system unavailable');
            }
            return; // Handled
        }
        // After other callback handlers
        else if (data.startsWith('standard_menu:')) {
            const methodName = 'handleCallbackQuery';
            // Parse the command using the same approach as pattern handler
            const match = data.match(/^standard_menu:([^:]+)(?::(.+))?$/);
            if (!match) {
                console.warn(`[${methodName}] Invalid standard menu command format:`, data);
                await adapter.answerCallbackQuery('Invalid menu command');
                return;
            }

            const action = match[1]; // e.g., 'main', 'query', 'select_bot', 'settings'
            const parameter = match[2]; // This might be a botId or other parameter
            console.log(`[${methodName}] Standard menu action: ${action}, parameter: ${parameter}`);

            // Ensure we have a commandHandler
            if (!this.commandHandler) {
                console.error(`[${methodName}] CommandHandler not available for standard menu action`);
                await adapter.answerCallbackQuery('Menu system unavailable');
                return;
            }

            // Call the appropriate handler method
            try {
                // Convert parameter to number if it's supposed to be a botId
                const botId = parameter ? parseInt(parameter, 10) : undefined;

                // Handle different standard menu actions
                switch (action) {
                    case 'main':
                        if (botId && !isNaN(botId)) {
                            await this.commandHandler.showCommandMenu(adapter, botId);
                        } else {
                            // Default to first bot if parameter is missing
                            const defaultBotId = this.getAllBotInfo()[0]?.id;
                            if (defaultBotId) {
                                await this.commandHandler.showCommandMenu(adapter, defaultBotId);
                            } else {
                                await adapter.answerCallbackQuery('No bot available');
                            }
                        }
                        break;

                    case 'query':
                        // Send a prompt asking for the query
                        await adapter.reply(
                            "What would you like to know? I'm ready to help!",
                            { reply_markup: { force_reply: true } }
                        );
                        break;

                    case 'select_bot':
                        // Show bot selection menu
                        if (this.commandHandler.menuManager) {
                            const botInfo = this.getAllBotInfo();
                            const keyboard = this.commandHandler.menuManager.createBotSelectionMenu(botInfo);
                            await adapter.reply('Select a bot to interact with:', {
                                reply_markup: keyboard.reply_markup
                            });
                        } else {
                            await adapter.answerCallbackQuery('Bot selection unavailable');
                        }
                        break;

                    case 'settings':
                        // Create settings menu - define this method in CommandHandler
                        if (botId && !isNaN(botId)) {
                            await this.commandHandler.handleStandardMenuAction(adapter, 'settings', botId);
                        } else {
                            await adapter.answerCallbackQuery('Settings unavailable');
                        }
                        break;

                    default:
                        // Pass the action to the command handler's general handler if it exists
                        if (typeof this.commandHandler.handleStandardMenuAction === 'function') {
                            await this.commandHandler.handleStandardMenuAction(adapter, action, parseInt(parameter || '0'));
                        } else {
                            console.warn(`[${methodName}] Unknown standard menu action: ${action}`);
                            await adapter.answerCallbackQuery('Unknown menu action');
                        }
                }
            } catch (error) {
                console.error(`[${methodName}] Error handling standard menu action:`, error);
                await adapter.answerCallbackQuery('Error processing menu action');
            }

            return;
        }
        // In TelegramBot_Agents.ts handleCallbackQuery method:
        else if (data.startsWith('ts_')) {
            const methodName = 'handleCallbackQuery';
            const match = data.match(/^ts_([^:]+)(?::(\d+)(?::(.+))?)?$/);
            if (!match) {
                console.warn(`[${methodName}] Invalid Transcription Settings format:`, data);
                await adapter.answerCallbackQuery('Invalid Transcription Settings command');
                return;
            }

            const action = match[1]; // e.g., 'provider', 'model', 'lang', etc.
            const botId = match[2] ? parseInt(match[2]) : undefined;
            const value = match[3]; // e.g., 'local-cuda', 'medium', 'en', etc.

            // Verify it's meant for this bot
            if (botId !== this.bot?.botInfo?.id) {
                await adapter.answerCallbackQuery('Not for this bot');
                return;
            }

            console.log(`[${methodName}] Transcription Settings: action=${action}, value=${value}`);

            // Make sure CommandHandler is available
            if (this.commandHandler) {
                await this.commandHandler.handleTranscriptionSettingsAction(adapter, action, value);
            } else {
                await adapter.reply("Sorry, the Transcription Settings feature is not available right now.");
            }
            return;
        }
        // In handleCallbackQuery method
        else if (data.startsWith('media_')) {
            const methodName = 'handleCallbackQuery';
            const match = data.match(/^media_([^:]+)(?::(.+))?$/);

            if (!match) {
                console.warn(`[${methodName}] Invalid media command format:`, data);
                await adapter.answerCallbackQuery('Invalid media command');
                return;
            }

            const action = match[1]; // 'transcribe' or 'ignore'
            const params = match[2] ? match[2].split(':') : []; // cacheKey, mediaType

            if (action === 'transcribe' && params.length >= 1) {
                const cacheKey = params[0];
                const mediaType = params.length > 1 ? params[1] : 'unknown';

                console.log(`[${methodName}] Media action: ${action}, cacheKey: ${cacheKey}, mediaType: ${mediaType}`);
                await this.handleMediaTranscription(adapter, cacheKey, mediaType);
                return;
            }
            else if (action === 'ignore' && params.length >= 1) {
                const cacheKey = params[0];

                // Clean up the cache entry
                this.conversationManager!.cache.del(cacheKey);

                await adapter.answerCallbackQuery('File ignored');

                // Remove the prompt message if possible
                if (adapter.context.callbackQuery && 'message' in adapter.context.callbackQuery
                    && adapter.context.callbackQuery.message) {
                    const messageId = adapter.context.callbackQuery.message.message_id;
                    await adapter.deleteMessage(messageId);
                }
                return;
            }

            await adapter.answerCallbackQuery('Unknown media action');
            return;
        }
        else if (data.startsWith('thinking_')) {
            await this.commandHandler.handleThinkingCallback(adapter, data);
            return;
        }
        else if (data.startsWith('summary_')) {
            const parts = data.split('_');
            const action = parts[1];
            const chatId = parts.length > 2 ? parts[2] : context.chatId.toString();

            await adapter.answerCallbackQuery('Processing...');

            if (action === 'generate') {
                await this.handleSummaryGeneration(adapter, chatId);
            } else if (action === 'cancel') {
                await adapter.editMessageText('Summary generation cancelled.');

                // Auto-delete after a short delay
                setTimeout(async () => {
                    try {
                        await adapter.deleteMessage();
                    } catch (e) {
                        // Ignore deletion errors
                    }
                }, 5000);
            }
        }
        // --- START: Add Document Processing Agent Callback Handling ---
        else if (data.startsWith('docproc_')) {
            const docAgent = this.agentManager?.getAgent('document_processor') as DocumentProcessingAgent | undefined;
            if (docAgent && typeof docAgent.handleDocProcCallback === 'function') {
                logInfo(methodName, `Delegating callback to DocumentProcessingAgent`, { data });
                // We don't need to return anything here as the agent handles the response
                await docAgent.handleDocProcCallback(adapter, data); // Pass the full data string
            } else {
                logWarn(methodName, `DocumentProcessingAgent not found or handleDocProcCallback method missing`, { agentExists: !!docAgent });
                await adapter.answerCallbackQuery('Document processing feature is currently unavailable.');
            }
            return; // Callback handled (or error sent)
        }
        // --- END: Add Document Processing Agent Callback Handling ---
        else {
            console.warn('Received unknown callback query:', data);
            await adapter.answerCallbackQuery("I don't know how to handle this action.");
        }
    }


    async handleMessage(
        adapter: ContextAdapter,
        conversationManager: ConversationManager,
        agentManager: AgentManager,
        disablePatternSuggestion: boolean = false,
        interactionType?: InteractionType,
    ): Promise<string | FormattedResponse> { // Ensure return type is string
        const methodName = 'handleMessage';

        //console.log(methodName, ": Entering handleMessage");
        console.log('handleMessage: PromptManager state:', this.promptManager ? 'Initialized' : 'Not initialized');
        const context = adapter.getMessageContext();
        const { sessionId } = await this.conversationManager!.getSessionInfo(context);

        console.log(`[${methodName}] Entering handleMessage with payload:`, {
            context: {
                input: adapter.context,
                userId: adapter.getMessageContext().userId,
                chatId: adapter.getMessageContext().chatId,
                source: adapter.getMessageContext().source,
                auth: adapter.getMessageContext().raw?.auth,
                messageType: adapter.getMessageContext().raw?.message?.type,
                chatType: adapter.getMessageContext().raw?.chat?.type
            },
            hasConversationManager: !!conversationManager,
            hasAgentManager: !!agentManager,
            promptManagerState: this.promptManager ? 'Initialized' : 'Not initialized'
        });


        if (!context.raw.message || !context.raw.chat) {
            console.error('Invalid message or chat context');
            return "Error: Invalid message or chat context";
        }

        const message = context.raw.message;
        const chatId = context.chatId;

        const containsMedia = this.messageContainsMedia(context);
        if (containsMedia) {
            console.log(`[${methodName}] Media detected in message, offering transcription options`);
            await this.handleMediaDetection(adapter, message);
            return "Media detection handled";
        }

        // Continue with URL checking, etc.
        if (message.text && await this.checkForMediaUrl(message.text, adapter)) {
            return ''; // Media URL detected and handled, don't process further
        }

        // Get the botKey (chatflowId) from flowIdMap
        const flowIdEntry = Array.from(flowIdMap.entries())
            .find(([_, fId]) => fId === this.flowId);
        const botKey = flowIdEntry ? flowIdEntry[0] : undefined;

        // Log chatflowId resolution
        console.log(`[${methodName}] ChatflowId Resolution:`, {
            botKey,
            flowId: this.flowId,
            raw: {
                flowwise_chatflow_id: context.raw?.flowwise_chatflow_id,
                metadata_chatflowId: context.raw?.metadata?.chatflowId,
                options_chatflowid: (context.raw?.options as ICommonObject)?.chatflowid
            }
        });

        // Use botKey as chatflowId
        const chatflowId = botKey || this.flowId; // fallback to flowId if botKey not available

        // Use the already normalized userId from executeRun if available
        let userId: string;
        let numericUserId: number;

        if (context.source === 'flowise') {
            // For Flowise, use chatflowId-based ID from botKey
            userId = `flowise_${chatflowId}`;
            numericUserId = parseInt(context.userId.toString(), 10);
        } else {
            // For Telegram, get the normalized ID that was set in executeRun
            const normalizedId = context.userId.toString();
            if (normalizedId.startsWith('telegram_')) {
                userId = normalizedId;
                numericUserId = parseInt(normalizedId.replace('telegram_', ''), 10);
            } else if (normalizedId.match(/^[0-9]+$/)) {
                userId = `telegram_${normalizedId}`;
                numericUserId = parseInt(normalizedId, 10);
            } else {
                userId = normalizedId;
                numericUserId = parseInt(normalizedId.replace(/\D/g, ''), 10);
            }
        }

        // Early source check for non-Telegram messages
        if (context.source === 'flowise' || context.source === 'webapp') {
            const response = await handleNonTelegramMessage(adapter, conversationManager, agentManager, this, interactionType!);
            if (Math.random() < 0.01) {
                await this.triggerCleanup();
            }

            if (typeof response === 'string') {
                logInfo(methodName, `String response received from handleNonTelegramMessage:`, {
                    source: context.source,
                    responsePreview: response.substring(0, 100)
                });
                return response;
            }

            logInfo(methodName, `Formatted response received from handleNonTelegramMessage:`, {
                source: context.source,
                responseType: 'FormattedResponse',
                hasText: !!response.text,
                hasContent: !!response.content,
                hasTokenStats: !!response.metadata?.tokenStats,
                responsePreview: response.text?.substring(0, 100)
            });

            if (context.source === 'webapp' && response.text && response.content) {
                return {
                    ...response,
                    text: response.text,
                    content: response.content
                } as FormattedResponse;
            }

            return response;
        }

        // For Telegram messages, proceed with validation
        if (!context.raw.message || !context.raw.chat) {
            console.error('Invalid message or chat context');
            return "Error: Invalid message or chat context";
        }

        // Bot checks only for Telegram messages
        if (!this.bot) {
            console.log('No Bots Here!.');
            return "Error: Bot not on the job!";
        }



        logInfo(methodName, `Processing message from source: ${context.source}`, {
            userId,
            chatId: context.chatId,
            chatflowId: chatflowId || 'not available'
        });

        const flowId = this.flowId;
        console.log(`[FlowID: ${flowId}] Received message: ${adapter.context}`);

        //const senderId = context.userId;
        const senderUsername = context.username;
        const isReply = 'reply_to_message' in message && !!message.reply_to_message;

        // Check if this chat already has a flowId


        if (!userId) {
            console.error('Sender ID is undefined');
            return "Error: Sender ID is undefined";
        }

        const botUsername = this.bot.botInfo?.username;
        if (!botUsername) {
            console.error('Bot username is undefined');
            return "Error: Bot username is undefined";
        }

        // Ignore messages from other bots (except potentially for logging below)
        const isFromOtherBot = message.from?.is_bot && message.from.username !== botUsername;
        // We might still want to log messages from other bots to the group history

        // --- START: Log ALL Group Text Messages to memoryGroup ---
        // Declare chatType and isGroup once, early
        const chatType = context.raw.chat?.type;
        const isGroup = chatType === 'group' || chatType === 'supergroup';
        let originalText: string | undefined;

        if ('text' in message && message.text) {
            originalText = message.text; // Capture original text
        }

        if (isGroup && originalText && this.memoryGroup) {
            // Log any text message in a group to the group memory, including from other bots if desired
            // For now, let's log messages from humans and this bot's instance if needed later
            if (!isFromOtherBot || message.from?.id === this.botId) { // Log human messages and own messages
                try {
                    const groupSessionId = context.chatId.toString();
                    const senderUserId = context.userId.toString(); // Actual sender
                    const messageTimestamp = message.date ? new Date(message.date * 1000).toISOString() : new Date().toISOString(); // Handle potentially undefined date

                    // Create a BaseMessage (specifically HumanMessage for user inputs)
                    const groupBaseMessage = new HumanMessage({
                        content: originalText,
                        additional_kwargs: {
                            message_id: message.message_id,
                            senderUserId: senderUserId,
                            timestamp: messageTimestamp,
                            // Add sender's first name if available
                            senderFirstName: message.from?.first_name
                        }
                    });

                    // Convert to the format expected by addChatMessages
                    // Ensure this format matches what addChatMessages expects
                    const groupExtendedMessage = [{
                        text: originalText,
                        type: 'userMessage' as MessageType, // Log as user message
                        additional_kwargs: groupBaseMessage.additional_kwargs
                    }];


                    await this.memoryGroup.addChatMessages(groupExtendedMessage, groupSessionId, senderUserId);
                    logInfo(methodName, `Logged message to group memory`, { chatId: groupSessionId, senderUserId: senderUserId });
                } catch (groupLogError) {
                    logError(methodName, 'Failed to log message to group memory', groupLogError as Error, { chatId: context.chatId });
                }
            }
        }
        // --- END: Log ALL Group Text Messages ---

        // Now, proceed with the original logic for ignoring other bots if needed for *processing*
        if (isFromOtherBot) {
            return "Not our bot. Ignore processing."; // Return after potentially logging
        }

        console.log("Received message:", JSON.stringify(message, null, 2));

        if (userId) {
            this.updateUserActivity(numericUserId);
            if (this.isUserSessionExpired(numericUserId)) {
                await this.handleSessionExpired(adapter);
                return "Times up buddy";
            }
        }
        // Add this line to update user activity
        const ragAgent = agentManager.getAgent('rag') as RAGAgent;
        if (ragAgent) {
            ragAgent.refreshUserActivity(userId);
        }
        // Use the already declared chatType and isGroup
        const isPrivateChat = chatType === 'private';
        // isGroup is already declared above

        // Use the potentially captured originalText, or get it from context if not captured above
        let text: string = originalText || context.input;
        let isCaption = false;
        if (!originalText && 'caption' in message && message.caption) {
            text = message.caption;
            isCaption = true;
        }

        // Handle question selection

        if (this.awaitingQuestionSelection.get(numericUserId)) {
            const selectedNumber = parseInt(text);
            const userData = this.userQuestions.get(numericUserId);
            if (userData && !isNaN(selectedNumber) && selectedNumber > 0 && selectedNumber <= userData.questions.length) {
                const selectedQuestion = userData.questions[selectedNumber - 1];
                // Process the selected question
                await this.prepareAndProcessUserInput(adapter, selectedQuestion);
                // Clear the selection flag and stored questions
                this.awaitingQuestionSelection.delete(numericUserId);
                this.userQuestions.delete(numericUserId);
            } else {
                await adapter.reply('Invalid selection. Please try again or type a new message to cancel question selection.');
                return "Invalid selection. Please try again or type a new message to cancel question selection.";
            }
        }

        // Handle commands and special cases (Start, Show Commands, Help)
        if (await this.handleSpecialCases(adapter, text, isGroup, botUsername)) {
            return "";
        }

        // const ragAgent = this.agentManager.getAgent('rag') as RAGAgent;
        const isRagModeEnabled = ragAgent.isRAGModeEnabled(userId.toString());

        let replyToMessage: { message_id: number; text: string } | undefined;
        let isDirectedAtThisBot = false;

        const botId = this.bot.botInfo?.id;

        if (!botUsername || !botId) {
            console.error('Bot username or ID is undefined');
            return "Bot username or ID is undefined";
        }

        // Check if the message is a reply to this bot's message
        if (isReply && message.reply_to_message?.from?.id === botId) {
            replyToMessage = {
                message_id: message.reply_to_message.message_id,
                text: 'text' in message.reply_to_message ? message.reply_to_message.text || '' : ''
            };
            isDirectedAtThisBot = true;
        }

        // Determine if we should process this message
        const isActiveConversation = this.isActiveConversation ?
            this.isActiveConversation(chatId.toString()) :
            false;

        // Update shouldProcess to include media detection
        let shouldProcess = isPrivateChat ||
            text.includes(`@${botUsername}`) ||
            isDirectedAtThisBot ||
            (isGroup && isRagModeEnabled) ||
            (isGroup && isActiveConversation);


        if (!shouldProcess && isGroup) {
            console.log(`[${methodName}] Not processing group message because:`, {
                isPrivateChat,
                includesBotUsername: text.includes(`@${botUsername}`),
                isDirectedAtThisBot,
                isRagModeEnabled,
                isActiveConversation
            });
            // Check if the message mentions this bot
            const botMentionRegex = new RegExp(`@${botUsername}\\b`, 'i');
            if (botMentionRegex.test(text)) {
                isDirectedAtThisBot = true;
                // Remove the bot mention from the text
                text = text.replace(botMentionRegex, '').trim();
            }
            // Check if this matches question detection criteria
            if (!shouldProcess && this.questionAnalyzer) {
                try {
                    const chatHistory = await this.getChatHistory(adapter);
                    const groupMembers = await this.getGroupMembers(chatId);

                    const analysis = await this.questionAnalyzer.analyzeQuestion(
                        text,
                        context,
                        chatHistory,
                        groupMembers
                    );

                    console.log(`[${methodName}] Question analysis:`, {
                        isQuestion: analysis.isQuestion,
                        confidence: analysis.confidence,
                        recommendedAction: analysis.recommendedAction
                    });

                    // If it's a question we should offer help for, update shouldProcess
                    if (analysis.isQuestion &&
                        analysis.confidence > 0.7 &&
                        analysis.recommendedAction === 'offer_help') {

                        console.log(`[${methodName}] Offering help for question`);

                        // Create an inline keyboard to offer help
                        const keyboard = Markup.inlineKeyboard([
                            [
                                Markup.button.callback('Yes, please answer', `answer_question:${message.message_id}`),
                                Markup.button.callback('No thanks', `ignore_question:${message.message_id}`)
                            ]
                        ]);

                        // If RAG mode is recommended, mention it
                        const ragMention = analysis.requiresRagMode ?
                            "I can search our knowledge base for information on this." :
                            "I can try to answer this from my general knowledge.";

                        // Send the offer
                        await adapter.reply(
                            `I noticed a question. ${ragMention} Would you like me to answer?`,
                            { replyToMessageId: message.message_id, reply_markup: keyboard.reply_markup }
                        );

                        // Store the question for later
                        this.storeQuestionForLater(userId, sessionId, message.message_id, text, analysis, 'handleMessage');

                        return "Question detection handled";
                    }
                    else if (!analysis.isQuestion &&
                        analysis.confidence > 0.7 &&
                        analysis.recommendedAction === 'offer_help') {

                        console.log(`[${methodName}] Offering help for Statement`);

                        // Create an inline keyboard to offer help
                        const keyboard = Markup.inlineKeyboard([
                            [
                                Markup.button.callback('Yes, please Proceed', `answer_question:${message.message_id}`),
                                Markup.button.callback('No thanks', `ignore_question:${message.message_id}`)
                            ]
                        ]);

                        // Send the offer
                        await adapter.reply(
                            `I noticed a rather lengthy input. I can offer patterns that may assist with processing this information, would you like to proceed?`,
                            { replyToMessageId: message.message_id, reply_markup: keyboard.reply_markup }
                        );

                        // Store the question for later
                        this.storeQuestionForLater(userId, sessionId, message.message_id, text, analysis, 'handleMessage');

                        return "Question detection handled";
                    }
                    // In processMessage:
                    else if (analysis.isQuestion &&
                        analysis.confidence > 0.7 &&
                        (analysis.recommendedAction === 'answer' || analysis.recommendedAction === 'continue_conversation')) {

                        console.log(`[${methodName}] Analysis recommends answering directly, processing message`);

                        // Set RAG mode if needed
                        if (analysis.requiresRagMode) {
                            const ragAgent = this.agentManager.getAgent('rag') as RAGAgent;
                            if (ragAgent) {
                                ragAgent.toggleRAGMode(userId, true);
                                console.log(`[${methodName}] Enabled RAG mode based on analysis`);
                            }
                        }

                        // Process the message directly
                        shouldProcess = true;
                    }
                } catch (error) {
                    console.error(`[${methodName}] Error in question analysis:`, error);
                }
            }
        }

        if (shouldProcess) {
            let processedText = isRagModeEnabled ? `[RAG] ${text}` : text;

            console.log(`Processing message from sender ${numericUserId} (username: ${context.username}) in chat ${chatId}`);
            console.log(`Sender info: ${JSON.stringify(message.from, null, 2)}`);
            console.log(`Processed message: "${processedText}"`);

            if (!this.conversationManager) {
                logError(methodName, 'ConversationManager is not initialized', new Error('ConversationManager is null'));
                await adapter.reply("I'm sorry, but I'm not ready to process messages yet.");
                return "I'm sorry, but I'm not ready to process messages yet.";
            }

            // Check if this is a response to the RAG mode continuation prompt
            if (isRagModeEnabled && (text.toLowerCase() === 'yes' || text.toLowerCase() === 'no')) {
                await this.handleRagModeResponse(adapter, text);
                return '';
            }

            const { userId, sessionId } = await this.conversationManager.getSessionInfo(adapter);
            logInfo(methodName, `Processing message from source: ${context.source}`, { userId, sessionId });


            const messageId = message.message_id;
            const progressKey = `${chatId}:${messageId}`;

            try {

                const initialConfirmation = this.getRandomConfirmationMessage();
                this.progressMessages.set(progressKey, initialConfirmation);

                let sentConfirmation;
                try {
                    sentConfirmation = await adapter.reply(initialConfirmation);
                    const newProgressKey = `${chatId}:${sentConfirmation.message_id}`;
                    this.sentConfirmations.set(newProgressKey, sentConfirmation.message_id);
                    this.progressMessages.set(newProgressKey, initialConfirmation);
                    console.log(`[${methodName}] Set initial progress for key: ${newProgressKey}`);
                } catch (error) {
                    console.error('Error sending confirmation message:', error);
                }

                if (sentConfirmation) {
                    await this.updateProgress(adapter, `${chatId}:${sentConfirmation.message_id}`, "✉️ Preparing to process your message...");
                    console.log(`[${methodName}] Progress update for progressKey: ${progressKey}`);

                }

                let cleanedMessage = this.cleanMessage(context);
                console.log(`Cleaned message: "${cleanedMessage}"`);

                const isPrivateChat = context.raw.chat.type === 'private';
                const isGroup = !isPrivateChat;
                let isAI = isGroup ?
                    (await this.isBotInGroup(chatId, userId) && numericUserId !== this.botId) :
                    this.isAIUser(message.from);

                try {
                    if (!context.raw.message) {
                        throw new Error('Invalid message format');
                    }

                    // Helper function to determine chat type
                    const getChatType = (type?: string): Chat['type'] => {
                        switch (type) {
                            case 'private':
                            case 'group':
                            case 'supergroup':
                                return type;
                            default:
                                return 'private';  // default to private if unknown
                        }
                    };

                    // Create a properly typed message object
                    const telegramMessage: Message.TextMessage = {
                        message_id: context.raw.message.message_id,
                        date: Math.floor(Date.now() / 1000),
                        chat: {
                            id: this.parseId(context.chatId),
                            type: getChatType(context.raw.chat?.type),
                            ...(context.raw.chat?.title && { title: context.raw.chat.title }),
                            ...(context.raw.chat?.username && { username: context.raw.chat.username }),
                            ...(context.raw.chat?.first_name && { first_name: context.raw.chat.first_name }),
                            ...(context.raw.chat?.last_name && { last_name: context.raw.chat.last_name })
                        } as Chat,  // Use Chat type from Telegraf
                        from: {
                            id: this.parseId(context.userId),
                            is_bot: false,
                            first_name: context.first_name || 'Unknown',
                            ...(context.username && { username: context.username })
                        },
                        text: context.input  // Required for TextMessage
                    };

                    await this.processMessage(
                        adapter,
                        telegramMessage,
                        isAI,
                        context.isReply,
                        interactionType,
                        context.replyToMessage,
                        sentConfirmation ? `${context.chatId}:${sentConfirmation.message_id}` : undefined
                    );
                    if (sentConfirmation) {
                        await this.updateProgress(adapter, `${chatId}:${sentConfirmation.message_id}`, "✔️Finalizing the response...💥");
                        console.log(`[${methodName}] Progress updated for progressKey: ${progressKey}`);

                    }

                    console.log(`[${methodName}] AI response generated`);


                } catch (error) {
                    console.error(`[${methodName}] Error:`, error);
                    await this.handleProcessingError(adapter, error);
                } finally {
                    if (sentConfirmation) {
                        try {
                            // Wait a short time before deleting the confirmation message
                            setTimeout(async () => {
                                await adapter.deleteMessage(sentConfirmation.message_id);
                                this.progressMessages.delete(`${chatId}:${sentConfirmation.message_id}`);
                                this.sentConfirmations.delete(`${chatId}:${sentConfirmation.message_id}`);
                                console.log(`[${methodName}] Cleaned up progress messages for key: ${chatId}:${sentConfirmation.message_id}`);
                            }, 3000); // 3 seconds delay
                        } catch (error) {
                            console.error('Error deleting confirmation message:', error);
                        }
                    }
                }
            } catch (error) {
                logError(methodName, `Error handling message`, error as Error, { userId: userId, chatId });
                return "An unexpected error occurred while processing your message";
            }
        }
        return "handleMessage processed";
    }

    // TelegramBot_Agents.ts

    public async processMessage(
        adapter: ContextAdapter,
        message: any,
        isAI: boolean,
        isReply: boolean,
        interactionType?: InteractionType,
        replyToMessage?: { message_id: number; text: string },
        progressKey?: string
    ): Promise<string> {
        const methodName = 'processMessage';
        const context = adapter.getMessageContext();

        if (!this.conversationManager || !this.agentManager || !this.promptManager) {
            logError(methodName, 'Essential managers are not initialized', new Error('Essential managers are null'));
            return "I'm sorry, but I'm not ready to process messages yet.";
        }

        const { userId, sessionId } = await this.conversationManager.getSessionInfo(adapter);
        logInfo(methodName, `Received message`, { userId, sessionId, source: context.source, isAI, isReply });

        const containsMedia = !!(
            message.video ||
            message.video_note ||
            message.audio ||
            message.voice ||
            (message.document &&
                message.document.mime_type &&
                (message.document.mime_type.startsWith('audio/') ||
                    message.document.mime_type.startsWith('video/')))
        );

        if (containsMedia) {
            logInfo(methodName, 'Media detected in message, offering transcription', {
                mediaType: message.video ? 'video' :
                    message.audio ? 'audio' :
                        message.document ? 'document' : 'other'
            });
            await this.handleMediaDetection(adapter, message);
            return "Media detection handled";
        }

        // Extract userInput
        let userInput: string;
        if ('text' in message) {
            userInput = message.text;
        } else if ('caption' in message && ('photo' in message || 'video' in message || 'document' in message)) {
            userInput = message.caption || '';
        } else {
            logWarn(methodName, 'Received message is not a text or caption-based message', { userId, sessionId });
            return 'Sorry, I can only process text messages or media with captions.';
        }

        // Check for media files and offer transcription
        if ((message.video || message.video_note || message.audio || message.voice ||
            (message.document && message.document.mime_type &&
                (message.document.mime_type.startsWith('audio/') || message.document.mime_type.startsWith('video/'))))) {

            await this.handleMediaDetection(adapter, message);
            return "Media processing offered";
        }
        // Initialize question analyzer if needed
        if (!this.questionAnalyzer && this.utilityModel) {
            this.initializeQuestionAnalyzer();
        }

        // Check if this is a group chat
        const isGroupChat = context.raw?.chat?.type === 'group' || context.raw?.chat?.type === 'supergroup';
        const chatId = context.chatId;

        // Check for bot mention
        const botUsername = this.bot?.botInfo?.username;
        const isBotMentioned = botUsername ? userInput.includes(`@${botUsername}`) : false;

        // Update conversation tracking for this user message
        this.updateConversationTracking(adapter, false, isBotMentioned);

        // For group chats, implement the question detection logic
        // For group chats, implement the question detection logic with optimized analyzer
        if (isGroupChat && !isReply && context.source === 'telegram' && this.questionAnalyzer) {
            // Get group members
            const groupMemberMap = await (typeof chatId === 'number' ?
                this.getGroupMembers(chatId) :
                this.getGroupMembers(parseInt(chatId.toString(), 10)));

            // Check if message is explicitly directed at the bot
            const isDirectedAtBot = isBotMentioned ||
                (replyToMessage && this.isBotMessage(chatId, replyToMessage.message_id));

            // Check if we're in an active conversation
            const isActiveChat = this.isActiveConversation(chatId.toString());

            if (!isDirectedAtBot && !isActiveChat) {
                // Get chat history for context
                const chatHistory = await this.getChatHistory(adapter);

                // Use optimized progressive analysis
                const analysis = await this.questionAnalyzer.analyzeQuestionProgressively(
                    userInput,
                    context,
                    chatHistory,
                    groupMemberMap
                );

                logInfo(methodName, 'Question analysis result', {
                    isQuestion: analysis.isQuestion,
                    confidence: analysis.confidence,
                    action: analysis.recommendedAction
                });

                // Handle based on recommended action
                if (analysis.recommendedAction === 'stay_silent') {
                    // Just silently return
                    logInfo(methodName, 'Detected question but staying silent', {
                        reason: analysis.reasoning
                    });
                    return "Question detected but staying silent";
                }
                else if (analysis.recommendedAction === 'offer_help') {
                    // Create an inline keyboard to offer help
                    const keyboard = Markup.inlineKeyboard([
                        [
                            Markup.button.callback('Yes, please answer', `answer_question:${message.message_id}`),
                            Markup.button.callback('No thanks', `ignore_question:${message.message_id}`)
                        ]
                    ]);

                    // If RAG mode is recommended, mention it
                    const ragMention = analysis.requiresRagMode ?
                        "I can search our knowledge base for information on this." :
                        "I can try to answer this from my general knowledge.";

                    // Send the offer
                    await adapter.reply(
                        `I noticed a question. ${ragMention} Would you like me to answer?`,
                        { replyToMessageId: message.message_id, reply_markup: keyboard.reply_markup }
                    );

                    // Store the question for later handling if they say "yes"
                    this.storeQuestionForLater(userId, sessionId, message.message_id, userInput, analysis);

                    // Return early - we'll handle the actual response when they click "Yes"
                    return "Question detection handled";
                }
            }
        }

        logDebug(methodName, `Processed user input`, { userId, sessionId, userInput: userInput });

        try {
            // Validate request (if needed)
            const validation = await this.accountManager.validateMessageRequest(
                userId,
                userInput,
                context.source,
                context.raw?.auth
            );

            if (!validation.isValid) {
                return validation.error || "Unable to process message";
            }

            if (isAI) {
                logInfo(methodName, `Processing AI message`, { userId, sessionId });
                await this.processAIMessage(adapter, userInput);
                return "AI message processed successfully";
            } else {
                const aiResponse = await this.prepareAndProcessUserInput(
                    adapter,
                    userInput,
                    interactionType,
                    progressKey
                );
                // Only update token usage for webapp source
                if (context.source === 'webapp') {
                    // Update token usage with response text
                    await this.accountManager.updateTokenUsageFromText(userId, aiResponse, context.source);

                    logInfo(methodName, `Response processed:`, {
                        responsePreview: aiResponse.substring(0, 100),
                        userId,
                        source: context.source
                    });
                }

                return aiResponse;
            }
        } catch (error) {
            logError(methodName, `Error processing message for user ${userId} in session ${sessionId}:`, error as Error);
            await this.handleProcessingError(adapter, error);
            return "An error occurred while processing your message. Please try again.";
        }
    }

    private async prepareAndProcessUserInput(
        adapter: ContextAdapter,
        input: string,
        interactionType?: InteractionType,
        progressKey?: string
    ): Promise<string> { // Ensure it returns string
        const methodName = 'prepareAndProcessUserInput';

        const context = adapter.getMessageContext();
        const { userId, chatId, isAI, isReply, replyToMessage } = context;
        const chatHistory = await this.getChatHistory(adapter);

        logInfo(methodName, `Preparing to process input`, {
            userId, chatId, isAI, isReply, inputPreview: input.substring(0, 100)
        });

        if (isAI === true) {
            await this.processAIMessage(adapter, input);
            const aiResponse = "AI message processed successfully";
            logInfo(methodName, `AI message processed`, { response: aiResponse });
            return aiResponse;
        } else {
            // Get the question analysis if available (from pending questions or fresh analysis)
            let questionAnalysis: QuestionAnalysisResult | null = null;
            const isGroupChat = context.raw?.chat?.type === 'group' || context.raw?.chat?.type === 'supergroup';

            if (isGroupChat) {
                const originalMessageId = typeof context.raw?.message?.message_id === 'number' ?
                    context.raw.message.message_id :
                    (typeof context.messageId === 'number' ? context.messageId : 0);

                // Define the cached question data type
                interface CachedQuestionData {
                    userId: string;
                    sessionId: string;
                    question: string;
                    analysis: QuestionAnalysisResult;
                    timestamp: number;
                    source?: string; // Make source optional
                }

                // Check both caching mechanisms:
                // 1. First try to get from pending questions (callback query)
                const pendingCacheKey = `pending_question:${originalMessageId}`;
                const pendingData = this.conversationManager?.cache.get<CachedQuestionData>(pendingCacheKey);

                // 2. Then try to get from content-based cache
                const contentCacheKey = `question_analysis:${Buffer.from(input).toString('base64').substring(0, 40)}`;
                const contentData = this.conversationManager?.cache.get<{ result: QuestionAnalysisResult, timestamp: number }>(contentCacheKey);

                // First check if we have pending data (priority)
                if (pendingData && pendingData.analysis) {
                    questionAnalysis = pendingData.analysis;
                    logInfo(methodName, 'Using cached pending question analysis', {
                        confidence: questionAnalysis.confidence,
                        action: questionAnalysis.recommendedAction,
                        source: pendingData.source || 'pending_cache',
                        cacheAge: Math.round((Date.now() - pendingData.timestamp) / 1000) + 's'
                    });

                    // Remove from pending cache once we've processed it
                    this.conversationManager?.cache.del(pendingCacheKey);
                }
                // Then check if we have recent content-based cache (less than 5 min old)
                else if (contentData && contentData.result &&
                    (Date.now() - contentData.timestamp < 5 * 60 * 1000)) {

                    questionAnalysis = contentData.result;
                    logInfo(methodName, 'Using cached content-based question analysis', {
                        confidence: questionAnalysis.confidence,
                        action: questionAnalysis.recommendedAction,
                        source: 'content_cache',
                        cacheAge: Math.round((Date.now() - contentData.timestamp) / 1000) + 's'
                    });
                }
                // Finally, do a fresh analysis if needed
                else {
                    const botUsername = this.bot?.botInfo?.username;
                    const isBotMentioned = botUsername ? input.includes(`@${botUsername}`) : false;
                    const isDirectedAtBot = isBotMentioned || isReply;

                    // Only do analysis if not explicitly directed at the bot
                    if (!isDirectedAtBot) {
                        try {
                            const groupMembers = await this.getGroupMembers(
                                typeof chatId === 'string' ? parseInt(chatId, 10) : chatId
                            );

                            questionAnalysis = await this.questionAnalyzer.analyzeQuestionProgressively(
                                input,
                                context,
                                chatHistory,
                                groupMembers
                            );

                            if (questionAnalysis) {
                                logInfo(methodName, 'Performed fresh question analysis', {
                                    confidence: questionAnalysis.confidence,
                                    action: questionAnalysis.recommendedAction
                                });

                                // Cache the fresh analysis result in both systems
                                // 1. Store in content cache for reuse
                                this.conversationManager?.cache.set(contentCacheKey, {
                                    result: questionAnalysis,
                                    timestamp: Date.now()
                                }, 5 * 60); // 5 minutes TTL

                                logDebug(methodName, 'Cached fresh analysis in content cache', {
                                    cacheKey: contentCacheKey,
                                    expires: '5 minutes'
                                });
                            } else {
                                logWarn(methodName, 'Question analysis returned null');
                            }
                        } catch (error) {
                            logError(methodName, 'Error analyzing question', error as Error);
                            // questionAnalysis remains null
                        }
                    }
                }
            }

            // Handle RAG mode requirements regardless of analysis source
            if (questionAnalysis?.requiresRagMode) {
                const ragAgent = this.agentManager.getAgent('rag') as RAGAgent;
                if (ragAgent) {
                    ragAgent.toggleRAGMode(userId as string, true);
                    logInfo(methodName, 'Enabled RAG mode based on question analysis', {
                        userId: userId as string,
                        confidence: questionAnalysis.confidence
                    });
                }
            }

            // Also check for explicit RAG mode request in message (works in any chat type)
            if (input.toLowerCase().includes('ragmode') || input.toLowerCase().includes('rag mode')) {
                const ragAgent = this.agentManager.getAgent('rag') as RAGAgent;
                if (ragAgent) {
                    ragAgent.toggleRAGMode(userId as string, true);
                    logInfo(methodName, 'Enabled RAG mode based on explicit request in message', {
                        userId: userId as string,
                        trigger: input.includes('ragmode') ? 'ragmode' : 'rag mode'
                    });
                }
            }

            // Determine base interaction type
            let detectedInteractionType = interactionType;
            if (!detectedInteractionType) {
                detectedInteractionType = await this.conversationManager!.determineInteractionType(input, userId as string);
            }

            // Determine base context requirement
            let contextRequirement = await this.conversationManager!.detectContextRequirement(
                input, detectedInteractionType, userId as string
            );

            // If we have question analysis, use it to adjust our detection
            if (questionAnalysis) {
                // Update interaction type and context requirement based on analysis
                const { interactionType: updatedType, contextRequirement: updatedReq } =
                    this.conversationManager!.updateInteractionFromQuestionAnalysis(
                        questionAnalysis,
                        detectedInteractionType,
                        contextRequirement
                    );

                detectedInteractionType = updatedType;
                contextRequirement = updatedReq;

                logInfo(methodName, 'Adjusted interaction based on question analysis', {
                    interactionType: detectedInteractionType,
                    contextRequirement: contextRequirement
                });
            }

            console.log(`[${methodName}:${this.flowId}] Calling processUserInput`);
            const enhancedResponse = await this.processUserInput(
                adapter,
                input,
                chatHistory,
                isAI,
                isReply,
                replyToMessage,
                false, // isFollowUp
                interactionType,
                progressKey
            );
            console.log(`[${methodName}:${this.flowId}] Received response from processUserInput`);

            const response = enhancedResponse.response.join('\n');
            logInfo(methodName, `Response from processUserInput:`, { responsePreview: response.substring(0, 100) });
            return response;
        }
    }

    public async processUserInput(
        adapter: ContextAdapter,
        input: string,
        chatHistory: BaseMessage[],
        isAI: boolean,
        isReply: boolean,
        replyToMessage?: { message_id: number; text: string },
        isFollowUp: boolean = false,
        interactionType?: InteractionType,
        progressKey?: string
    ): Promise<EnhancedResponse> {
        const methodName = 'processUserInput';
        const context = adapter.getMessageContext();
        const { userId, sessionId } = await this.conversationManager!.getSessionInfo(context);
        // Update RAG activity
        const ragAgent = this.agentManager.getAgent('rag') as RAGAgent;
        if (ragAgent) {
            ragAgent.refreshUserActivity(userId);
        }
        console.log(`[${methodName}:${this.flowId}] Starting for user input: "${input.substring(0, 50)}..."`);
        console.log(`[${methodName}:${this.flowId}] isAI: ${isAI}, isReply: ${isReply}, isFollowUp: ${isFollowUp}`);

        try {

            // Check game state first
            const gameAgent = this.agentManager.getAgent('game') as GameAgent;
            const gameState = gameAgent?.getGameState?.(userId);

            let enhancedResponse: EnhancedResponse;

            // Determine processing path
            if (gameState?.isActive) {
                // Game Processing Path
                const fullGameState = gameAgent.getGameState(userId, true);
                console.log(`[${methodName}:${this.flowId}] Processing game interaction`);
                enhancedResponse = await this.processGameInteraction(
                    adapter,
                    input,
                    chatHistory,
                    isReply,
                    userId,
                    fullGameState!,
                    gameAgent,
                    replyToMessage,
                    progressKey
                );
            } else {
                // Normal Chat Processing Path
                console.log(`[${methodName}:${this.flowId}] Processing normal chat interaction`);
                enhancedResponse = await this.processNormalInteraction(
                    adapter,
                    input,
                    chatHistory,
                    isReply,
                    userId,
                    replyToMessage,
                    isFollowUp,
                    interactionType,
                    progressKey
                );
            }

            // Handle response and memory updates
            const responseMessageId = await this.handleEnhancedResponse(adapter, enhancedResponse, progressKey);

            // Update memory
            await this.updateMemoryWithResponse(
                adapter,
                input,
                enhancedResponse,
                context,
                userId,
                sessionId,
                isReply,
                isFollowUp,
                replyToMessage,
                responseMessageId
            );

            return enhancedResponse;
        } catch (error) {
            logError(methodName, `Error processing input:`, error as Error, { userId, sessionId });
            throw error;
        }
    }

    private async processGameInteraction(
        adapter: ContextAdapter,
        input: string,
        chatHistory: BaseMessage[],
        isReply: boolean,
        userId: string,
        gameState: GameState,
        gameAgent: GameAgent,
        replyToMessage?: { message_id: number; text: string },
        progressKey?: string
    ): Promise<EnhancedResponse> {
        if (progressKey) {
            await this.updateProgress(adapter, progressKey, "🎮 Processing game action...");
        }

        // Let the game agent handle the interaction
        const gameResponse = await this.conversationManager!.generateResponse(
            input,
            chatHistory,
            isReply,
            userId,
            adapter,
            replyToMessage,
            progressKey
        );

        return {
            response: Array.isArray(gameResponse) ? gameResponse : [gameResponse],
            sourceCitations: undefined,
            followUpQuestions: undefined,
            externalAgentSuggestion: undefined,
            gameMetadata: {
                gameState: gameState,
                keyboard: gameAgent.createGameKeyboard(gameState)
            }
        };
    }

    private async processNormalInteraction(
        adapter: ContextAdapter,
        input: string,
        chatHistory: BaseMessage[],
        isReply: boolean,
        userId: string,
        replyToMessage?: { message_id: number; text: string },
        isFollowUp: boolean = false,
        interactionType?: InteractionType,
        progressKey?: string
    ): Promise<EnhancedResponse> {
        const isRAGEnabled = this.agentManager.isRAGModeEnabled(userId);

        if (isRAGEnabled) {
            if (progressKey) {
                await this.updateProgress(adapter, progressKey, "🖥 Generating with context...");
                console.log(`[processNormalInteraction] Progress updated for progressKey: ${progressKey}`);

            }

            return await this.conversationManager!.processWithRAGAgent(
                input,
                chatHistory,
                interactionType!,
                userId,
                adapter,
                replyToMessage,
                progressKey
            );
        } else {
            if (progressKey) {
                await this.updateProgress(adapter, progressKey, "💭 Generating response...");
                console.log(`[processNormalInteraction] Progress updated for progressKey: ${progressKey}`);
            }

            const response = await this.conversationManager!.generateResponse(
                input,
                chatHistory,
                isReply,
                userId,
                adapter,
                replyToMessage,
                progressKey
            );

            return {
                response: Array.isArray(response) ? response : [response],
                sourceCitations: undefined,
                followUpQuestions: undefined,
                externalAgentSuggestion: undefined,
                gameMetadata: {
                    gameState: null,
                    keyboard: null
                }
            };
        }
    }
    private async updateMemoryWithResponse(
        adapter: ContextAdapter,
        input: string,
        enhancedResponse: EnhancedResponse,
        context: MessageContext,
        userId: string,
        sessionId: string,
        isReply: boolean,
        isFollowUp: boolean,
        replyToMessage?: { message_id: number; text: string },
        responseMessageId?: number
    ): Promise<void> {
        const methodName = 'updateMemoryWithResponse';

        try {
            // Log message IDs for debugging
            logInfo(methodName, 'Message IDs for memory update:', {
                userMessageId: context.messageId,
                responseMessageId,
                replyToMessageId: replyToMessage?.message_id,
                sessionId,
                userId
            });

            // Validate message IDs
            const userMessageId = context.messageId ?
                (typeof context.messageId === 'string' ? parseInt(context.messageId) : context.messageId) :
                undefined;

            const validReplyToMessageId = replyToMessage?.message_id ?
                (typeof replyToMessage.message_id === 'string' ? parseInt(replyToMessage.message_id) : replyToMessage.message_id) :
                undefined;

            // Create messages with full context
            const messages: BaseMessage[] = [];

            // Add human message with full context
            messages.push(new HumanMessage(input, {
                additional_kwargs: {
                    message_id: userMessageId,
                    reply_to_message_id: validReplyToMessageId,
                    session_id: sessionId,
                    user_id: userId,
                    timestamp: new Date().toISOString(),
                    is_reply: isReply,
                    is_followup: isFollowUp
                }
            }));

            // Add AI message with full context
            messages.push(new AIMessage(enhancedResponse.response.join('\n'), {
                additional_kwargs: {
                    message_id: responseMessageId,
                    session_id: sessionId,
                    user_id: userId,
                    timestamp: new Date().toISOString(),
                    related_to_message_id: userMessageId,
                    is_followup_response: isFollowUp,
                    // Add game-specific metadata if it exists
                    game_state: enhancedResponse.gameMetadata?.gameState ?
                        JSON.stringify(enhancedResponse.gameMetadata.gameState) : undefined
                }
            }));

            // Update memory with validation
            try {
                await this.updateMemory(adapter, messages);
                logInfo(methodName, 'Memory updated successfully', {
                    userId,
                    sessionId,
                    messageCount: messages.length,
                    hasGameState: !!enhancedResponse.gameMetadata?.gameState
                });
            } catch (error) {
                logError(methodName, 'Error updating memory:', error as Error, {
                    userId,
                    sessionId,
                    messageIds: {
                        user: userMessageId,
                        response: responseMessageId,
                        replyTo: validReplyToMessageId
                    }
                });
                // Don't throw here - we want to continue even if memory update fails
            }
        } catch (error) {
            logError(methodName, 'Error in memory update process:', error as Error, {
                userId,
                sessionId
            });
            // Still don't throw - memory updates shouldn't break the main flow
        }
    }
    public async handleEnhancedResponse(adapter: ContextAdapter, enhancedResponse: EnhancedResponse, progressKey?: string): Promise<number | undefined> {
        const methodName = 'handleEnhancedResponse';
        const context = adapter.getMessageContext();
        const { userId, sessionId } = await this.conversationManager!.getSessionInfo(context);
        const chatId = context.chatId;

        logInfo(methodName, `Processing enhanced response`, { userId, sessionId });

        try {
            // Check if this is a game response
            if (enhancedResponse.gameMetadata?.gameState) {
                logInfo(methodName, `Processing game response`, {
                    userId,
                    sessionId,
                    gameLevel: enhancedResponse.gameMetadata.gameState.currentLevel,
                    gameStatus: enhancedResponse.gameMetadata.gameState.status
                });

                if (progressKey && adapter) {
                    await this.updateProgress(adapter, progressKey, "🎮 Processing game response...");
                }

                // Check if we should skip sending the message (flag in gameState)
                if (enhancedResponse.gameMetadata.gameState.responseAlreadySent) {
                    console.log('[handleEnhancedResponse] Skipping game response send as it was already handled');
                    return enhancedResponse.gameMetadata.gameState.lastMessageId; // Return the messageId from gameState
                }

                // Add debug logging
                console.log('Game keyboard markup:', enhancedResponse.gameMetadata.keyboard);

                // Send response with game keyboard
                const response = await adapter.reply(
                    enhancedResponse.response.join('\n'),
                    {
                        reply_markup: enhancedResponse.gameMetadata.keyboard
                    }
                );

                return response.message_id;
            }

            // Check for pattern keyboard
            const patternKeyboard = this.conversationManager!.cache.get(`pattern_keyboard:${userId}`);
            if (patternKeyboard) {
                // Clear the keyboard from cache
                this.conversationManager!.cache.del(`pattern_keyboard:${userId}`);

                // Send response with pattern keyboard
                const sentMessage = await adapter.reply(
                    enhancedResponse.response.join('\n'),
                    {
                        parse_mode: 'Markdown',
                        reply_markup: patternKeyboard
                    }
                );

                // Store this response for future pattern processing
                await this.storeResponseForPatterns(userId, enhancedResponse.response.join('\n'), sentMessage);

                return sentMessage.message_id;
            }

            // Handle non-game, non-pattern responses with standard menu
            if (progressKey && adapter) {
                await this.updateProgress(adapter, progressKey, "💯 Enhanced Response ready to send...");
                console.log(`[${methodName}] Progress updated for progressKey: ${progressKey}`);
            }

            // Determine if we should add standard menu
            // Don't add menu to very short responses, error messages, or if explicitly disabled
            const responseText = enhancedResponse.response.join('\n');
            const shouldAddMenu = responseText.length > 50 &&
                !responseText.includes('Error:') &&
                !responseText.startsWith('❌') &&
                !enhancedResponse.skipStandardMenu;

            // Get standard menu if needed
            let replyMarkup = undefined;
            if (shouldAddMenu && this.commandHandler && this.commandHandler.menuManager) {
                const isGroupChat = adapter.getChatType() === 'group' || adapter.getChatType() === 'supergroup';
                const botId = adapter.getBotInfo()?.id || this.botId;
                const ragAgent = this.agentManager.getAgent('rag') as RAGAgent;
                const isRagEnabled = ragAgent ? ragAgent.isRAGModeEnabled(userId) : false;


                // Get the standard menu keyboard - add response context for menu generation
                replyMarkup = this.commandHandler.menuManager.createStandardChatMenu(
                    isGroupChat,
                    botId!,
                    {  // Add context information
                        isResponse: true,
                        hasContent: true,
                        contentLength: responseText.length,
                        isRagEnabled: isRagEnabled  // Pass the RAG status

                    }
                ).reply_markup;

                console.log(`[${methodName}] Adding standard menu to response in ${isGroupChat ? 'group' : 'private'} chat`);
            }

            // Send the main response with standard menu if appropriate
            const messageId = await this.sendResponseWithMenu(adapter, enhancedResponse.response, replyMarkup);

            // Important: Store this response for future pattern processing
            // Create a simulated message object for storage since we don't have the actual message object
            const sentMessage = { message_id: messageId };
            if (messageId) {
                // Try to get context information if available
                let relevantContext: string | undefined = undefined;

                // Check the context cache directly
                const contextCacheKey = `relevant_context:${userId}`;
                const contextCacheEntry = this.conversationManager!.cache.get<{ relevantContext: string; timestamp: number }>(contextCacheKey);

                if (contextCacheEntry?.relevantContext) {
                    relevantContext = contextCacheEntry.relevantContext;
                    console.log(`[${methodName}] Found cached context for storage, length: ${relevantContext.length}`);
                }

                // Store the response data with the context if available
                await this.storeResponseForPatterns(userId, responseText, sentMessage, relevantContext);
            }

            // Handle source citations - with null check
            if (enhancedResponse.sourceCitations && enhancedResponse.sourceCitations.length > 0) {
                logInfo(methodName, `Sending paginated citations`, {
                    userId,
                    sessionId,
                    citationCount: enhancedResponse.sourceCitations.length
                });
                if (progressKey && adapter) {
                    await this.updateProgress(adapter, progressKey, "📚 stacking source citations...");
                    console.log(`[${methodName}] Progress updated for progressKey: ${progressKey}`);
                }
                await this.sendPaginatedCitations(adapter, enhancedResponse.sourceCitations);
            }

            // Handle follow-up questions - with null check
            if (enhancedResponse.followUpQuestions && enhancedResponse.followUpQuestions.length > 0) {
                logInfo(methodName, `Sending paginated follow-up questions`, {
                    userId,
                    sessionId,
                    questionCount: enhancedResponse.followUpQuestions.length
                });
                if (progressKey && adapter) {
                    await this.updateProgress(adapter, progressKey, "📚 stacking follow-up questions...");
                    console.log(`[${methodName}] Progress updated for progressKey: ${progressKey}`);
                }
                await this.sendPaginatedQuestions(adapter, enhancedResponse.followUpQuestions);
            }

            // Handle external agent suggestion
            if (enhancedResponse.externalAgentSuggestion) {
                logInfo(methodName, `Sending external agent suggestion`, { userId, sessionId });
                await adapter.reply(`🤖 An external agent might be able to assist further: ${enhancedResponse.externalAgentSuggestion}`);
            }

            // After sending a message, record its ID
            if (messageId) {
                // Record this as a bot message
                this.recordBotMessage(chatId, messageId);

                // Update conversation tracking
                this.updateConversationTracking(adapter, true);

                logInfo(methodName, `Recorded bot message ID for tracking`, {
                    chatId,
                    messageId,
                    responseType: enhancedResponse.gameMetadata ? 'game' : 'standard'
                });
            }

            return messageId;
        } catch (error) {
            logError(methodName, `Error processing enhanced response`, error as Error, { userId, sessionId });
            await adapter.reply("I'm sorry, but I encountered an error while processing the response. Please try again.");
            return undefined;
        }
    }

    /**
     * Stores response data for later pattern processing
     * @param userId The user ID
     * @param responseText The full response text
     * @param sentMessage The sent message object (for message ID)
     */
    /**
 * Stores response data for later pattern processing
 * @param userId The user ID
 * @param responseText The full response text
 * @param sentMessage The sent message object (for message ID)
 * @param relevantContext Optional context used to generate the response
 */
    private async storeResponseForPatterns(
        userId: string,
        responseText: string,
        sentMessage: any,
        relevantContext?: string // Change parameter name for clarity
    ): Promise<void> {
        const methodName = 'storeResponseForPatterns';

        try {
            if (!this.conversationManager || !responseText || !sentMessage) {
                console.warn(`[${methodName}] Missing required data, skipping storage`);
                return;
            }

            // Store in pattern data cache
            const patternDataKey = `pattern_data:${userId}`;
            let patternData = this.conversationManager.cache.get<PatternData>(patternDataKey) || {
                originalInput: '',
                processedOutputs: {},
                currentPatternState: {}
            };

            // Create response output object with proper type
            const responseOutput: PatternData['processedOutputs']['latest_response'] = {
                output: responseText,
                timestamp: Date.now(),
                messageIds: [sentMessage.message_id]
            };

            // Store the response as a special output type
            patternData.processedOutputs['latest_response'] = responseOutput;

            // Also update originalInput if it's empty or smaller than this response
            // This ensures we have meaningful content for pattern processing
            if (!patternData.originalInput || patternData.originalInput.length < responseText.length) {
                patternData.originalInput = responseText;
            }

            // Initialize contextInfo if needed
            if (!patternData.contextInfo) {
                patternData.contextInfo = {};
            }

            // Get and store the relevant context if not provided
            let contextToUse = relevantContext;
            if (!contextToUse) {
                try {
                    // Try to get context from various cache keys
                    const relevantContextKey = `relevant_context:${userId}`;
                    const contextualizedQueryKey = `contextualized_query:${userId}`;

                    const contextCacheEntry = this.conversationManager.cache.get(relevantContextKey);
                    if (contextCacheEntry && typeof contextCacheEntry === 'object' && 'relevantContext' in contextCacheEntry) {
                        contextToUse = contextCacheEntry.relevantContext as string;
                    } else {
                        // Try other keys if the first one doesn't work
                        const otherContextEntries = [
                            this.conversationManager.cache.get(`RelevantContext:${userId}`),
                            this.conversationManager.cache.get(`context:${userId}`),
                            this.conversationManager.cache.get(contextualizedQueryKey)
                        ];

                        for (const entry of otherContextEntries) {
                            if (entry) {
                                if (typeof entry === 'object' && 'relevantContext' in entry) {
                                    contextToUse = entry.relevantContext as string;
                                    break;
                                } else if (typeof entry === 'string') {
                                    contextToUse = entry;
                                    break;
                                }
                            }
                        }
                    }

                    if (contextToUse) {
                        console.log(`[${methodName}] Found context to use for source citations, length: ${contextToUse.length}`);

                        // Store the context in pattern data
                        patternData.contextInfo.relevantContext = contextToUse;
                        patternData.contextInfo.lastUpdated = Date.now();

                        // Also store it separately for redundancy
                        this.conversationManager.cache.set(`response_context:${userId}`, contextToUse, 7200);
                    }
                } catch (contextError) {
                    console.warn(`[${methodName}] Error getting context:`, contextError);
                }
            } else {
                // Store the provided context
                patternData.contextInfo.relevantContext = contextToUse;
                patternData.contextInfo.lastUpdated = Date.now();
            }

            // Update the pattern data in cache
            this.conversationManager.cache.set(patternDataKey, patternData, 7200);

            // Store a compact context for pattern suggestions
            const contextData: PatternContextData = {
                input: responseText,
                interactionType: 'general_input',
                contextRequirement: 'chat',
                timestamp: Date.now(),
                originalMessageId: sentMessage.message_id,
                currentPatternState: '',
                metadata: {
                    userId,
                    messageId: sentMessage.message_id
                }
            };

            this.conversationManager.cache.set(`pattern_context:${userId}`, contextData, 7200);

            // Generate and store source citations if context is available
            if (contextToUse && this.agentManager) {
                try {
                    const ragAgent = this.agentManager.getAgent('rag') as RAGAgent;
                    if (ragAgent && typeof (ragAgent as any).generateSourceCitations === 'function') {
                        const sourceCitations = await (ragAgent as any).generateSourceCitations(contextToUse);

                        if (sourceCitations && sourceCitations.length > 0) {
                            console.log(`[${methodName}] Generated ${sourceCitations.length} source citations`);

                            // Store citations in separate cache
                            this.conversationManager.cache.set(
                                `source_citations:${userId}:${sentMessage.message_id}`,
                                sourceCitations,
                                7200
                            );

                            // Also store in pattern data for easier access
                            // We need to be careful about type safety here
                            const typedOutput = patternData.processedOutputs['latest_response'];
                            typedOutput.sourceCitations = sourceCitations;

                            // Update pattern data again with the citations
                            this.conversationManager.cache.set(patternDataKey, patternData, 7200);
                        }
                    }
                } catch (citationError) {
                    console.warn(`[${methodName}] Error generating source citations:`, citationError);
                }
            } else {
                console.log(`[${methodName}] No context available for generating source citations`);
            }

            console.log(`[${methodName}] Successfully stored response (${responseText.length} chars) for user ${userId}`);
        } catch (error) {
            console.error(`[${methodName}] Error storing response data:`, error);
            // Non-critical operation, so we log but don't throw
        }
    }
    // NEW METHOD: Helper to send response with menu
    private async sendResponseWithMenu(adapter: ContextAdapter, response: string | string[], replyMarkup?: any): Promise<number | undefined> {
        const methodName = 'sendResponseWithMenu';
        console.log(`[${methodName}:${this.flowId}:] Sending Response ${replyMarkup ? 'with menu' : 'without menu'}`);

        const responseChunks = Array.isArray(response) ? response : this.promptManager!.splitAndTruncateMessage(response);
        let lastMessageId: number | undefined;

        for (let i = 0; i < responseChunks.length; i++) {
            const chunk = responseChunks[i];
            const isLastChunk = i === responseChunks.length - 1;

            let formattedChunk: string;
            if (adapter.getMessageContext().source === 'telegram') {
                formattedChunk = FormatConverter.genericToHTML(chunk);
            } else {
                formattedChunk = FormatConverter.genericToMarkdown(chunk);
            }

            // Only add the menu to the last chunk
            const markup = isLastChunk ? replyMarkup : undefined;

            const sentMessage = await adapter.reply(formattedChunk, {
                parse_mode: adapter.getMessageContext().source === 'telegram' ? 'HTML' : undefined,
                reply_markup: markup
            });

            lastMessageId = sentMessage.message_id;

            await new Promise(resolve => setTimeout(resolve, 100));
        }

        return lastMessageId;
    }

    private async sendResponse(adapter: ContextAdapter, response: string | string[]): Promise<number | undefined> {
        const methodName = 'sendResponse';
        console.log(`[${methodName}:${this.flowId}:] Sending Response`);

        const responseChunks = Array.isArray(response) ? response : this.promptManager!.splitAndTruncateMessage(response);
        let lastMessageId: number | undefined;

        for (const chunk of responseChunks) {
            let formattedChunk: string;
            if (adapter.getMessageContext().source === 'telegram') {
                formattedChunk = FormatConverter.genericToHTML(chunk);
            } else {
                formattedChunk = FormatConverter.genericToMarkdown(chunk);
            }

            const sentMessage = await adapter.reply(formattedChunk, {
                parse_mode: adapter.getMessageContext().source === 'telegram' ? 'HTML' : undefined
            });
            lastMessageId = sentMessage.message_id;
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        return lastMessageId;
    }

    // In TelegramBot_Agents.ts
    public formatResponse(
        input: string | FormattedResponse,
        context: MessageContext,
        stats?: {
            tokenUsage?: number;
            userStats?: UserStats;
        }
    ): string | FormattedResponse {
        const methodName = 'formatResponse';
        logInfo(methodName, 'Formatting response', {
            source: context.source,
            inputPreview: typeof input === 'string' ? input.substring(0, 100) : 'object'
        });

        switch (context.source) {
            case 'telegram':
                return typeof input === 'string' ? input : input.text || input.content || input.error || '';

            case 'webapp':
                // If input is already a formatted response, ensure text/content are strings
                if (typeof input !== 'string') {
                    if (input.requireAuth) {
                        return {
                            text: '🔒 Authentication Required',
                            content: '🔒 Authentication Required',
                            error: input.error,
                            requireAuth: true,
                            showAuthModal: true,
                            metadata: {
                                type: 'auth_error',
                                timestamp: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' }),
                                ...input.metadata
                            },
                            question: context.input,
                            chatId: context.chatId,
                            chatMessageId: context.messageId || Date.now().toString(),
                            isStreamValid: false,
                            sessionId: context.chatId,
                            memoryType: this.memory
                        } as FormattedResponse;
                    }

                    // Ensure existing response has string text/content
                    return {
                        ...input,
                        text: this.ensureStringResponse(input.text),
                        content: this.ensureStringResponse(input.content)
                    };
                }

                // Create new response from string input
                return {
                    text: input,
                    content: input,
                    metadata: {
                        source: 'webapp',
                        timestamp: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' }),
                        tokenStats: stats?.userStats ? {
                            quota: stats.userStats.token_quota,
                            used: stats.userStats.token_usage || 0,
                            remaining: stats.userStats.available_tokens || 0,
                            messages: stats.userStats.total_messages || 0,
                            lastReset: new Date(stats.userStats.last_reset || Date.now()).toISOString(),
                            nextReset: stats.userStats.next_reset_date ?
                                new Date(stats.userStats.next_reset_date).toISOString() :
                                null,
                            subscription: stats.userStats.subscription_tier
                        } : undefined
                    },
                    question: context.input,
                    chatId: context.chatId,
                    chatMessageId: context.messageId || Date.now().toString(),
                    isStreamValid: false,
                    sessionId: context.chatId,
                    memoryType: this.memory
                } as FormattedResponse;

            case 'flowise':
                // For flowise, maintain specific response structure
                return {
                    text: typeof input === 'string' ? input : input.text,
                    content: typeof input === 'string' ? input : input.content,
                    metadata: {
                        source: 'flowise',
                        timestamp: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })
                    },
                    question: context.input,
                    chatId: context.chatId,
                    chatMessageId: context.messageId || Date.now().toString(),
                    isStreamValid: false,
                    sessionId: context.chatId,
                    memoryType: this.memory
                } as FormattedResponse;

            default:
                logWarn(methodName, `Unexpected message source`, { source: context.source });
                return input;
        }
    }
    private async handleFollowUpQuestion(adapter: ContextAdapter, question: string, interactionType?: InteractionType): Promise<void> {
        const methodName = 'handleFollowUpQuestion';
        const context = adapter.getMessageContext();
        const userId = context.userId.toString();
        const chatId = context.chatId.toString();

        let sentConfirmation: { message_id: number } | undefined;
        let progressKey: string | undefined;

        try {
            logInfo(methodName, `Processing follow-up question`, { question, userId, chatId });

            // Send initial confirmation message
            const confirmationMessage = this.getRandomConfirmationMessage();
            const sentMessage = await adapter.reply(confirmationMessage);
            sentConfirmation = { message_id: sentMessage.message_id };

            // Generate the progressKey using the sent message's ID
            progressKey = `${chatId}:${sentMessage.message_id}`;

            // Update progress
            await adapter.updateProgress(this.flowId, progressKey, "🤔 Thinking about your follow-up question...");

            // Get chat history
            const chatHistory = await this.getChatHistory(adapter);

            // Process the question
            const enhancedResponse = await this.processUserInput(
                adapter,
                question,
                chatHistory,
                false, // isAI
                true,  // isReply
                undefined, // replyToMessage
                true, // isFollowUp
                interactionType!,
                progressKey // Pass the progressKey here
            );

            // Handle the response
            //await this.handleEnhancedResponse(adapter, enhancedResponse, progressKey);

            logInfo(methodName, 'Follow-up question processed successfully', { question, userId, chatId });

        } catch (error) {
            logError(methodName, 'Error processing follow-up question', error as Error, { userId, chatId });
            await adapter.reply("I'm sorry, but I encountered an error while processing your follow-up question. Please try asking again.");
        } finally {
            if (sentConfirmation) {
                try {
                    await adapter.deleteMessage(sentConfirmation.message_id);
                } catch (error) {
                    logError(methodName, 'Error deleting confirmation message', error as Error, { userId, chatId });
                }
            }
        }
    }

    private async handleSpecialCases(adapter: ContextAdapter, text: string, isGroup: boolean, botUsername: string): Promise<boolean> {
        const methodName = 'handleSpecialCases';
        console.log(`[${methodName}] Entering handleSpecialCases`);

        const context = adapter.getMessageContext();

        // Handle "Start" commands for different bots
        if (isGroup && (text.startsWith('Start ') || text.startsWith('/start'))) {
            const botName = text.startsWith('Start ') ? text.substring(6) : text.split('@')[1];
            const allBotInfo = this.getAllBotInfo();
            const currentBotInfo = allBotInfo.find(bot => bot.id === this.bot?.botInfo?.id);

            const selectedBot = botName ? allBotInfo.find(bot => bot.firstName === botName || bot.username === botName) : currentBotInfo;

            if (selectedBot && selectedBot.id === currentBotInfo?.id) {
                await this.commandHandler.executeCommandByName(adapter, 'start');
            } else if (selectedBot) {
                const startCommand = `/start@${selectedBot.username}`;
                await adapter.reply(`🚀 To activate ${selectedBot.firstName}, please click or tap this command: ${startCommand}`);
            } else {
                await adapter.reply("❌ I couldn't find that bot. Please try again.");
            }
            return true;
        }

        // Handle keyboard menu options
        if (text.toLowerCase().includes('show commands') || text.toLowerCase().includes('show_commands')) {
            console.log('[handleSpecialCases] Processing show commands request');
            const botId = this.bot?.botInfo?.id;

            if (!botId) {
                console.warn('[handleSpecialCases] Bot ID not available for show commands action');
                await adapter.reply("Unable to show commands. Bot ID not found.");
                return true;
            }

            try {
                await this.commandHandler.showCommandMenu(adapter, botId);
                return true;
            } catch (error) {
                console.error('[handleSpecialCases] Error showing command menu:', error);
                await adapter.reply("Sorry, there was an error displaying the commands menu.");
                return true;
            }
        }

        if (text.startsWith('Help') || text.startsWith('help_command')) {
            await this.commandHandler.executeCommandByName(adapter, 'help');
            return true;
        }

        // Handle commands
        if (text.startsWith('/')) {
            if (isGroup && !this.isCommandForThisBot(text, botUsername)) {
                console.log(`Command not for this bot: ${text}`);
                return false;
            }

            const [fullCommand, ...args] = text.split(' ');
            const [commandName] = fullCommand.slice(1).split('@');

            // Special handling for game commands
            if (commandName === 'millionaire') {
                if (this.commandHandler) {
                    try {
                        await this.commandHandler.executeCommandByName(adapter, commandName);
                        // Return false to continue processing through the normal pipeline
                        return false;
                    } catch (error) {
                        console.error(`Error executing game command ${commandName}:`, error);
                        await adapter.reply("I'm sorry, but I encountered an error while processing your command. Please try again later.");
                        return true;
                    }
                }
            }

            if (this.commandHandler) {
                try {
                    await this.commandHandler.executeCommandByName(adapter, commandName);
                } catch (error) {
                    console.error(`Error executing command ${commandName}:`, error);
                    await adapter.reply("I'm sorry, but I encountered an error while processing your command. Please try again later.");
                }
                return true;  // Return true only after handling a command
            } else {
                console.error('CommandHandler is not initialized');
                await adapter.reply("I'm sorry, but I'm not ready to process commands yet.");
                return true;  // Return true for command failure too
            }
        }

        // If we get here, no special cases were handled
        console.log(`[${methodName}] No special cases detected, returning false`);
        return false;  // Return false if no special cases were matched
    }

    private isCommandForThisBot(text: string, botUsername: string): boolean {
        const commandRegex = new RegExp(`^\/[a-z0-9_]+(@${botUsername})?($|\s)`, 'i');
        return commandRegex.test(text) && (!text.includes('@') || text.includes(`@${botUsername}`));
    }
    private async handleRagModeResponse(adapter: ContextAdapter, text: string): Promise<void> {
        const context = adapter.getMessageContext();
        const { userId } = await this.conversationManager!.getSessionInfo(context);
        const ragAgent = this.agentManager.getAgent('rag') as RAGAgent;


        this.conversationManager!.handleRagModeResponse(userId, text);
        let responseMessage: string;
        if (text.toLowerCase() === 'yes') {
            ragAgent.toggleRAGMode(userId, false);
            responseMessage = "RAG mode has been disabled. You can re-enable it anytime with the /ragmode command.";
        } else {
            ragAgent.refreshUserActivity(userId);
            responseMessage = "RAG mode remains enabled. Feel free to continue your conversation!";
        }

        // Send the response message
        await adapter.reply(responseMessage);

        // Restore the original keyboard
        const replyKeyboard = this.menuManager.createStartKeyboardMenu(adapter);
        await adapter.reply("Here's your original menu:", { reply_markup: replyKeyboard });
    }
    private async sendPaginatedCitations(adapter: ContextAdapter, citations: SourceCitation[]): Promise<void> {
        const context = adapter.getMessageContext();
        if (!context.chatId) {
            console.error('Context does not contain chat information');
            return;
        }

        const key = this.getCitationKey(context);
        let citationSets = this.userCitationSets.get(key);
        if (!citationSets) {
            citationSets = new Map();
            this.userCitationSets.set(key, citationSets);
        }

        const newSetId = Date.now().toString();

        const citationData: UserCitationData = {
            citations,
            currentPage: 0,
            lastActionTime: Date.now(),
            setId: newSetId,
            expirationTime: Date.now() + 48 * 60 * 60 * 1000, // 6 hours from now
            messageId: 0,
            chatId: typeof context.chatId === 'string' ? parseInt(context.chatId, 10) : context.chatId
        };

        citationSets.set(newSetId, citationData);

        console.log(`Generated new setId: ${newSetId} for citations in chat key: ${key}`);

        await this.sendPaginatedCitation(adapter, citationData, true);

        this.scheduleCitationSetCleanup(key, newSetId);
    }

    private async sendPaginatedCitation(adapter: ContextAdapter, citationData: UserCitationData, isInitialDisplay: boolean = false): Promise<void> {
        const { citations, currentPage, setId } = citationData;
        const totalPages = citations.length;
        const currentCitation = citations[currentPage];

        console.log(`Sending paginated citation. SetId: ${setId}, Page: ${currentPage + 1}/${totalPages}`);

        const escapeHTML = (text: string) => {
            return text
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        };

        let message = `📚 <b>Source Citation ${currentPage + 1} of ${totalPages}:</b>\n\n`;

        if (currentCitation.title) {
            message += `📙 <b>Title:</b> ${escapeHTML(currentCitation.title)}\n`;
        }

        if (currentCitation.fileName) {
            message += `🗂 <b>File:</b> ${escapeHTML(currentCitation.fileName)}\n`;
        }

        if (currentCitation.author) {
            message += `👤 <b>Author:</b> ${escapeHTML(currentCitation.author)}\n`;
        }

        if (currentCitation.relevance !== undefined) {
            message += `🎯 <b>Relevance Score:</b> ${currentCitation.relevance.toFixed(3)}\n`;
        }

        const keyboard = Markup.inlineKeyboard([
            [
                Markup.button.callback('⬅️ Previous', `prev_citation:${setId}`),
                Markup.button.callback('Next ➡️', `next_citation:${setId}`)
            ],
            [Markup.button.callback('Close Citations', `close_citations:${setId}`)]
        ]);

        try {
            if (isInitialDisplay) {
                const sentMessage = await adapter.replyWithHTML(message, { reply_markup: keyboard.reply_markup });
                citationData.messageId = sentMessage.message_id;
            } else if (adapter.context.raw?.callbackQuery && 'message' in adapter.context.raw.callbackQuery && adapter.context.raw.callbackQuery.message) {
                const editedMessage = await adapter.editMessageText(message, {
                    parse_mode: 'HTML',
                    reply_markup: keyboard.reply_markup
                });
                if (typeof editedMessage === 'object' && 'message_id' in editedMessage) {
                    citationData.messageId = editedMessage.message_id;
                }
            } else {
                const sentMessage = await adapter.replyWithHTML(message, { reply_markup: keyboard.reply_markup });
                citationData.messageId = sentMessage.message_id;
            }
        } catch (error) {
            console.error('Error handling paginated citation:', error);
            try {
                const sentMessage = await adapter.replyWithHTML(message, { reply_markup: keyboard.reply_markup });
                citationData.messageId = sentMessage.message_id;
            } catch (retryError) {
                console.error('Error sending citation after initial failure:', retryError);
            }
        }
    }


    private async sendPaginatedQuestions(adapter: ContextAdapter, questions: string[]): Promise<void> {
        const context = adapter.getMessageContext();
        if (!context.chatId) {
            console.error('Context does not contain chat information');
            return;
        }

        const key = this.getChatKey(context);
        let questionSets = this.userQuestionSets.get(key);
        if (!questionSets) {
            questionSets = new Map();
            this.userQuestionSets.set(key, questionSets);
        }

        const newSetId = Date.now().toString();

        const questionData: UserQuestionData = {
            questions,
            currentPage: 0,
            lastActionTime: Date.now(),
            setId: newSetId,
            expirationTime: Date.now() + 48 * 60 * 60 * 1000, // 48 hours from now
            messageId: 0,
            chatId: this.parseId(context.chatId)
        };

        questionSets.set(newSetId, questionData);

        console.log(`Generated new setId: ${newSetId} for chat key: ${key}`);

        await this.sendPaginatedQuestion(adapter, questionData, true);

        this.scheduleQuestionSetCleanup(key, newSetId);
    }

    private async sendPaginatedQuestion(adapter: ContextAdapter, questionData: UserQuestionData, isInitialDisplay: boolean = false): Promise<void> {
        const { questions, currentPage, setId } = questionData;
        const totalPages = questions.length;
        const currentQuestion = questions[currentPage];

        console.log(`Sending paginated question. SetId: ${setId}, Page: ${currentPage + 1}/${totalPages}`);

        let message = `💡 <b>Follow-up Question ${currentPage + 1} of ${totalPages}:</b>\n\n${currentQuestion}`;

        const keyboard = Markup.inlineKeyboard([
            [
                Markup.button.callback('⬅️ Previous', `prev_question:${setId}`),
                Markup.button.callback('Next ➡️', `next_question:${setId}`)
            ],
            [Markup.button.callback('Select This Question', `select_question:${setId}`)],
            [Markup.button.callback('🔄 Toggle On/Off "RAG" Q&A Mode', `execute_command:${this.botId}:ragmode`)]
        ]);

        try {
            if (isInitialDisplay) {
                const sentMessage = await adapter.replyWithHTML(message, { reply_markup: keyboard.reply_markup });
                questionData.messageId = sentMessage.message_id;
            } else if (adapter.context.raw?.callbackQuery && 'message' in adapter.context.raw.callbackQuery && adapter.context.raw.callbackQuery.message) {
                const editedMessage = await adapter.editMessageText(message, {
                    parse_mode: 'HTML',
                    reply_markup: keyboard.reply_markup
                });
                if (typeof editedMessage === 'object' && 'message_id' in editedMessage) {
                    questionData.messageId = editedMessage.message_id;
                }
            } else {
                const sentMessage = await adapter.replyWithHTML(message, { reply_markup: keyboard.reply_markup });
                questionData.messageId = sentMessage.message_id;
            }
        } catch (error) {
            console.error('Error handling paginated question:', error);
            try {
                const sentMessage = await adapter.replyWithHTML(message, { reply_markup: keyboard.reply_markup });
                questionData.messageId = sentMessage.message_id;
            } catch (retryError) {
                console.error('Error sending question after initial failure:', retryError);
            }
        }
    }
    private confirmationMessages: string[] = [
        "🤔 Processing your request, please wait...",
        "🔍 I'm working on that for you. This might take a moment...",
        "🧠 Analyzing your message. I'll respond shortly...",
        "💡 Thinking... I'll have an answer for you soon.",
        "⏳ Your request is being processed. Thank you for your patience.",
        "🚀 I'm on it! Give me a few seconds to formulate a response.",
        "🔢 Calculating the best response for you. Won't be long!",
        "🤓 Hmm, that's an interesting one. Let me think about it...",
        "📩 Request received! I'm processing it now.",
        "⚙️ Working on your query. I'll be with you in a moment."
    ];
    private getCitationKey(context: MessageContext): number {
        if (!context.chatId) throw new Error('Chat ID not found');
        if (context.source === 'telegram' && context.raw?.chat?.type === 'private') {
            if (!context.userId) throw new Error('User ID not found');
            return this.parseId(context.userId);
        } else {
            return this.parseId(context.chatId);
        }
    }

    private getChatKey(context: MessageContext): number {
        const chatId = context.chatId;
        if (typeof chatId === 'undefined') {
            throw new Error('Chat ID not found');
        }
        if (context.source === 'telegram' && context.raw?.chat?.type === 'private') {
            const userId = context.userId;
            if (typeof userId === 'undefined') {
                throw new Error('User ID not found');
            }
            return this.parseId(userId);
        } else {
            return this.parseId(chatId);
        }
    }
    private scheduleCitationSetCleanup(key: number, setId: string): void {
        const citationSets = this.userCitationSets.get(key);
        const citationData = citationSets?.get(setId);
        if (!citationData) return;

        const timeUntilExpiration = citationData.expirationTime - Date.now();
        setTimeout(() => {
            this.cleanupCitationSet(key, setId);
        }, timeUntilExpiration);
    }

    private async cleanupCitationSet(key: number, setId: string): Promise<void> {
        const citationSets = this.userCitationSets.get(key);
        const citationData = citationSets?.get(setId);
        if (citationData) {
            try {
                if (this.bot) {
                    await this.bot.telegram.deleteMessage(citationData.chatId, citationData.messageId);
                }
            } catch (error) {
                console.error(`Failed to delete citation message for key ${key}, setId ${setId}:`, error);
            } finally {
                citationSets?.delete(setId);
                if (citationSets?.size === 0) {
                    this.userCitationSets.delete(key);
                }
            }
        }
        console.log(`Cleaned up citation set for key ${key}, setId ${setId}`);
    }
    private scheduleQuestionSetCleanup(key: number, setId: string): void {
        const questionSets = this.userQuestionSets.get(key);
        const questionData = questionSets?.get(setId);
        if (!questionData) return;

        const timeUntilExpiration = questionData.expirationTime - Date.now();
        setTimeout(() => {
            this.cleanupQuestionSet(key, setId);
        }, timeUntilExpiration);
    }

    private async cleanupQuestionSet(key: number, setId: string): Promise<void> {
        const questionSets = this.userQuestionSets.get(key);
        const questionData = questionSets?.get(setId);
        if (questionData) {
            try {
                if (this.bot) {
                    await this.bot.telegram.deleteMessage(questionData.chatId, questionData.messageId);
                }
            } catch (error) {
                console.error(`Failed to delete question message for key ${key}, setId ${setId}:`, error);
            } finally {
                questionSets?.delete(setId);
                if (questionSets?.size === 0) {
                    this.userQuestionSets.delete(key);
                }
            }
        }
        console.log(`Cleaned up question set for key ${key}, setId ${setId}`);
    }

    public getRandomConfirmationMessage(): string {
        const randomIndex = Math.floor(Math.random() * this.confirmationMessages.length);
        return this.confirmationMessages[randomIndex];
    }
    public setConversationManager(manager: ConversationManager): void {
        this.conversationManager = manager;
    }
    private updateUserActivity(userId: number): void {
        this.userLastActivity.set(userId, Date.now());
    }

    private isUserSessionExpired(userId: number): boolean {
        const lastActivity = this.userLastActivity.get(userId);
        if (!lastActivity) return false;
        return (Date.now() - lastActivity) / 1000 > this.idleTimeout;
    }

    private async handleSessionExpired(adapter: ContextAdapter): Promise<void> {
        await adapter.reply("⏰ Your session has expired due to inactivity. Please start a new conversation.");
        // Optionally, clear the user's conversation history here
    }

    public getAllKnownBots(): { id: number; username?: string; first_name?: string }[] {
        const allBots = this.botIds.map(id => ({ id }));
        if (this.bot && this.bot.botInfo) {
            allBots.push({
                id: this.bot.botInfo.id,
                ...(this.bot.botInfo.username && { username: this.bot.botInfo.username }),
                ...(this.bot.botInfo.first_name && { first_name: this.bot.botInfo.first_name })
            });
        }
        return allBots;
    }
    private async isBotInGroup(chatId: string | number, userId: string | number): Promise<boolean> {
        if (chatId === undefined || userId === undefined) {
            console.error('chatId or userId is undefined');
            return false;
        }
        console.log(`Checking if user ${userId} is a bot in chat ${chatId}`);

        if (!this.bot || this.botId === null) {
            console.error('Bot is not properly initialized');
            return false;
        }

        const numericChatId = typeof chatId === 'string' ? parseInt(chatId, 10) : chatId;
        const numericUserId = typeof userId === 'string' ? parseInt(userId, 10) : userId;

        if (isNaN(numericChatId) || isNaN(numericUserId)) {
            console.error('Invalid chatId or userId');
            return false;
        }

        if (numericUserId === this.botId) {
            console.log(`User ${userId} is this bot, not considering as external bot`);
            return false;
        }

        let members = this.groupMembers.get(numericChatId);
        if (!members) {
            console.log(`No members found for chat ${chatId}, initializing`);
            members = new Map();
            this.groupMembers.set(numericChatId, members);
        }

        let memberInfo = members.get(numericUserId);
        if (!memberInfo) {
            console.log(`User ${userId} not found in cache, fetching info`);
            try {
                const chatMember = await this.bot.telegram.getChatMember(numericChatId, numericUserId);
                console.log(`Chat member info for ${userId}:`, JSON.stringify(chatMember, null, 2));

                memberInfo = {
                    is_bot: chatMember.user.is_bot,
                    is_admin: ['administrator', 'creator'].includes(chatMember.status)
                };
                members.set(numericUserId, memberInfo);

                console.log(`User ${userId} is bot: ${memberInfo.is_bot}, is admin: ${memberInfo.is_admin}`);
            } catch (error) {
                console.error(`Error fetching info for user ${userId}:`, error);
                return false;
            }
        } else {
            console.log(`User ${userId} found in cache`);
        }

        console.log(`User ${userId} is bot: ${memberInfo.is_bot}, is admin: ${memberInfo.is_admin}`);
        return memberInfo.is_bot;
    }

    private isAIUser(user: User | undefined): boolean {
        if (!user) return false;

        const userId = user.id;
        const username = user.username?.toLowerCase() || '';

        // Check known bot IDs (if we decide to keep this feature)
        if (this.knownBotIds && this.knownBotIds.has(userId)) return true;

        // Check username patterns
        if (username.endsWith('bot')) return true;

        // Check for specific bot-like properties
        if (user.is_bot) return true;

        // Additional heuristics can be added here
        // For example, checking for specific patterns in the first_name or last_name

        return false;
    }

    public async updateMemory(adapter: ContextAdapter, messages: BaseMessage[], messageId?: number): Promise<void | { sessionId: string }> {
        const methodName = 'updateMemory';

        // Early validation
        if (!messages?.length || !this.conversationManager || !this.memory) {
            logInfo(methodName, 'Skipping memory update - invalid inputs or not initialized');
            return;
        }

        const context = adapter.getMessageContext();
        const { userId, sessionId } = await this.conversationManager.getSessionInfo(context);
        // Check if this is a game interaction by looking at game state
        const gameAgent = this.agentManager.getAgent('game') as GameAgent | undefined; if (gameAgent) {
            const gameState = gameAgent?.getGameState ? gameAgent.getGameState(userId) : undefined;
            if (gameState && gameState.isActive) {
                console.log(`[${methodName}] Skipping memory update for active game`);
                return; // Skip memory update entirely for game interactions
            }
        }
        try {
            logDebug(methodName, `Updating memory`, {
                userId,
                sessionId,
                source: context.source,
                messageId
            });

            // First check if session exists
            let session;
            try {
                session = await this.memory.getChatMessagesExtended(userId, sessionId);
            } catch (error) {
                // If session doesn't exist, try to create it
                if (error?.message?.includes('not found')) {
                    logDebug(methodName, `Session not found, creating new session`, {
                        userId,
                        sessionId
                    });

                    // Initialize session if memory supports it
                    if (typeof this.memory.saveContext === 'function') {
                        await this.memory.saveContext(
                            { userId, sessionId },
                            { init: true }
                        );
                    }
                } else {
                    throw error;
                }
            }

            // Convert messages to the format expected by addChatMessages: { text: string; type: MessageType }[]
            const extendedMessages: { text: string; type: MessageType }[] = messages
                .filter(msg => msg.content) // Ensure content exists
                .flatMap((message) => {
                    // Ensure content is a string
                    const contentString = messageContentToString(message.content);
                    const isHuman = message.getType() === 'human';
                    const messageType: MessageType = isHuman ? 'userMessage' : 'apiMessage';

                    // Split potentially long messages (though Zep might handle this)
                    // Keeping split logic for now, but ensure output matches expected type
                    return this.splitMessage(contentString, 1000).map((chunk) => ({
                        text: chunk, // Use 'text' field
                        type: messageType // Use 'type' field
                        // No need for input/output/metadata here as addChatMessages in StandaloneZepMemory adds its own
                    }));
                });

            if (!extendedMessages.length) {
                logInfo(methodName, 'No valid messages to update');
                return;
            }

            // Add messages to memory
            // Use addChatMessages with overrides instead of the removed addChatMessagesExtended
            // --- Update User-Specific Memory (Existing Logic) ---
            await this.memory.addChatMessages(extendedMessages, sessionId, userId);
            logDebug(methodName, `User-specific memory updated successfully`, { userId, sessionId, messageCount: extendedMessages.length });

            // --- Additionally Update Group-Wide Memory if applicable ---
            const chatType = context.raw?.chat?.type;
            const isGroupChat = chatType === 'group' || chatType === 'supergroup';

            if (isGroupChat) {
                const groupSessionId = context.chatId.toString(); // Use chatId as the session key for groups
                const senderUserId = context.userId.toString(); // Use the actual sender's ID

                // --- Prepare messages specifically for group memory ---
                // Create new BaseMessage instances with added metadata in additional_kwargs
                const groupBaseMessagesWithSender = messages.map(baseMsg => {
                    const newKwargs = {
                        ...(baseMsg.additional_kwargs || {}), // Keep existing kwargs
                        senderUserId: senderUserId,         // Add actual sender ID
                        originalUserId: userId,             // Add original user context
                        originalSessionId: sessionId        // Add original session context
                    };
                    // Create a new instance of the same type with updated kwargs
                    if (baseMsg instanceof HumanMessage) {
                        return new HumanMessage({ content: baseMsg.content, additional_kwargs: newKwargs });
                    } else if (baseMsg instanceof AIMessage) {
                        return new AIMessage({ content: baseMsg.content, additional_kwargs: newKwargs });
                    } else { // Includes SystemMessage and potentially others
                        return new SystemMessage({ content: baseMsg.content, additional_kwargs: newKwargs });
                    }
                });

                // Convert these new BaseMessages to the ExtendedIMessage format
                const groupExtendedMessagesWithSender: ExtendedIMessage[] = groupBaseMessagesWithSender
                    .filter(msg => msg.content)
                    .flatMap((message) => {
                        const contentString = messageContentToString(message.content);
                        const isHuman = message.getType() === 'human';
                        const messageType: MessageType = isHuman ? 'userMessage' : 'apiMessage';

                        // Split message if needed and create ExtendedIMessage objects
                        return this.splitMessage(contentString, 1000).map((chunk): ExtendedIMessage => ({
                            message: chunk, // Add the required 'message' property
                            text: chunk,    // Keep 'text' for compatibility if needed elsewhere
                            type: messageType,
                            additional_kwargs: message.additional_kwargs // Pass through the updated kwargs
                        }));
                    });


                if (this.memoryGroup) { // Add null check for memoryGroup
                    try {
                        // Use addChatMessagesExtended to ensure correct key generation with "GROUP" placeholder
                        // Pass the correctly prepared groupExtendedMessagesWithSender
                        // Call addChatMessages again, but with chatId as sessionId
                        // The third argument (senderUserId) might be used differently by the memory implementation
                        // depending on how it handles group vs individual sessions.
                        // Use "GROUP" as userId placeholder for group-wide memory key generation
                        // Use addChatMessagesExtended to ensure correct key generation with "GROUP" placeholder
                        await this.memoryGroup.addChatMessagesExtended(groupExtendedMessagesWithSender, "GROUP", groupSessionId);
                        logInfo(methodName, `Group-wide memory updated successfully`, { chatId: groupSessionId, messageCount: groupExtendedMessagesWithSender.length }); // Removed senderUserId from log as it's now in metadata
                    } catch (groupMemoryError) {
                        logError(methodName, 'Error updating group-wide memory:', groupMemoryError as Error, {
                            chatId: groupSessionId,
                            senderUserId: senderUserId
                        });
                        // Do not throw; failure to update group memory shouldn't stop the flow
                    }
                } else {
                    logWarn(methodName, 'memoryGroup is not initialized, cannot update group-wide memory.');
                    // Do not throw; failure to update group memory shouldn't stop the flow
                }
            }

            return context.source === 'flowise' ? { sessionId } : undefined;

        } catch (error) {
            logError(methodName, 'Error updating memory:', error as Error, {
                userId,
                sessionId,
                source: context.source
            });
        }
    }
    // flowise chats, delete chat history
    public async clearChatHistory(adapter: ContextAdapter): Promise<void> {
        const methodName = 'clearChatHistory';
        const context = adapter.getMessageContext();
        if (!this.conversationManager || !this.memory) {
            logError(methodName, 'ConversationManager or Memory is not initialized', new Error('ConversationManager or Memory is null'));
            return;
        }

        const { userId, sessionId } = await this.conversationManager.getSessionInfo(context);

        try {
            if (context.source === 'flowise') {
                // For Flowise, use only the sessionId
                await this.memory.clearChatMessages(sessionId);
                logDebug(methodName, `Flowise chat history cleared`, { sessionId });
            } else {
                // For non-Flowise sessions, use the combined userId:sessionId
                const combinedSessionId = `${userId}:${sessionId}`;
                await this.memory.clearChatMessages(combinedSessionId);
                logDebug(methodName, `Chat history cleared`, { userId, sessionId });
            }
        } catch (error) {
            logError(methodName, `Error clearing chat history`, error as Error, { userId, sessionId });
        }
    }
    public async getChatHistory(adapter: ContextAdapter): Promise<BaseMessage[]> {
        const methodName = 'getChatHistory';
        const context = adapter.getMessageContext();

        if (!this.conversationManager || !this.memory) {
            logError(methodName, 'ConversationManager or Memory is not initialized', new Error('ConversationManager or Memory is null'));
            return [];
        }

        const { userId, sessionId } = await this.conversationManager!.getSessionInfo(adapter);
        logDebug(methodName, `Starting to retrieve chat history for user ${userId} in session ${sessionId}`);

        // Dump all messages before retrieval if using MemoryManager
        if (this.memory instanceof MemoryManager) {
            logInfo(methodName, 'Using MemoryManager, dumping all messages');
            this.memory.dumpAllMessages();
        }

        try {

            // Retrieve messages using the extended method (will be filtered by userId by default in adaptMemory)
            const messages = await this.memory.getChatMessagesExtended(
                userId,
                sessionId,
                true // returnBaseMessages = true
                // No prependMessages or overrideUserId needed here for standard history retrieval
            ) as ExtendedIMessage[];
            logDebug(methodName, `Retrieved ${messages.length} messages for user ${userId} in session ${sessionId}`);

            // Log each retrieved message
            messages.forEach((msg, index) => {
                console.log(`[getChatHistory] Raw message ${index + 1}:`, JSON.stringify(msg, null, 2));
            });

            const baseMessages = this.convertToBaseMessages(messages);
            logDebug(methodName, `Converted ${baseMessages.length} messages to BaseMessage format`);

            // Log each converted message
            baseMessages.forEach((msg, index) => {
                if (!this.conversationManager) {
                    logError(methodName, 'ConversationManager', new Error('ConversationManager is null'));
                    return;
                }
                console.log(`[getChatHistory] Converted message ${index + 1}:`, JSON.stringify({
                    type: msg.getType(),
                    content: this.conversationManager.getContentPreview(msg.content),
                    additional_kwargs: msg.additional_kwargs
                }, null, 2));
            });

            const serializedHistory = this.serializeChatHistory(baseMessages);
            logDebug(methodName, `Serialized chat history: ${serializedHistory}`);

            return baseMessages;
        } catch (error) {
            logError(methodName, `Error retrieving chat history for user ${userId} in session ${sessionId}:`, error as Error);
            return [];
        }
    }


    private serializeChatHistory(chatHistory: BaseMessage[]): string {
        console.log(`[serializeChatHistory] Starting serialization of ${chatHistory.length} messages`);

        const serialized = JSON.stringify(chatHistory.map((msg, index) => {
            const serializedMsg = {
                type: msg.getType(),
                content: msg.content
            };
            console.log(`[serializeChatHistory] Serialized message ${index + 1}: ${JSON.stringify(serializedMsg)}`);
            return serializedMsg;
        }));

        console.log(`[serializeChatHistory] Completed serialization, result length: ${serialized.length} characters`);
        return serialized;
    }



    // Update the WebappChatIdData interface (assuming it's here or in types.ts)
    // interface WebappChatIdData {
    //     source: 'webapp';
    //     userId: string;
    //     firstName: string;
    //     sessionId: string;
    //     authToken?: string; // Make optional initially for backward compatibility if needed
    // }

    private parseWebappChatId(chatId: string): WebappChatIdData | null {
        const methodName = 'parseWebappChatId';
        try {
            // Expected format: webapp|userId|firstName|sessionId|authToken
            // e.g., "webapp|1414981328|Marcus|66f57296-b5fa-4f39-afd2-c25580950169|someAuthToken..."
            const parts = chatId.split('|');
            logInfo(methodName, `Parsing chatId: "${chatId}"`, { partsCount: parts.length });

            // Check for the new format with 5 parts
            if (parts[0] === 'webapp' && parts.length >= 5) {
                const data: WebappChatIdData = {
                    source: 'webapp',
                    userId: parts[1],
                    firstName: parts[2],
                    sessionId: parts[3],
                    authToken: parts[4] // Extract the auth token
                };
                 logInfo(methodName, 'Successfully parsed webapp chatId with auth token', { data });
                return data;
            }
            // Fallback for the old format (4 parts) if needed during transition
            else if (parts[0] === 'webapp' && parts.length === 4) {
                 logWarn(methodName, 'Parsed webapp chatId using old format (missing auth token)', { chatId });
                 return {
                     source: 'webapp',
                     userId: parts[1],
                     firstName: parts[2],
                     sessionId: parts[3],
                     authToken: undefined // No token in old format
                 };
            }
            logWarn(methodName, 'ChatId does not match expected webapp format', { chatId });
            return null;
        } catch (error) {
             logError(methodName, 'Error parsing webapp chatId', error as Error, { chatId });
            return null;
        }
    }

    public async run(
        nodeData: INodeData,
        input: string | SafeOptions,
        options: ICommonObject
    ): Promise<string | ICommonObject> {
        const methodName = 'run';
        // *** CAPTURE ORIGINAL INPUT OBJECT ***
        const originalInputObject = (typeof input === 'object' && input !== null) ? { ...input } : null;
        logInfo(methodName, 'Captured originalInputObject:', { hasObject: !!originalInputObject });

        try {
            // *** NEW DETAILED LOGGING START ***
            logInfo(methodName, '--- START: Full Input/Options Dump ---');
            try {
                // *** ADDED: Log options specifically for command string input ***
                if (typeof input === 'string' && input.startsWith('COMMAND:')) {
                    // Use a safe stringify function to handle potential circular references
                    const safeStringify = (obj: any) => {
                        const cache = new Set();
                        return JSON.stringify(obj, (key, value) => {
                            // Remove potentially sensitive or large objects that cause issues
                            if (key === 'logger' || key === 'appDataSource' || key === 'databaseEntities' || key === 'analytic' || key === 'uploads' || key === 'req' || typeof value === 'function') {
                                return `[Removed: ${key}]`;
                            }
                            if (typeof value === 'object' && value !== null) {
                                if (cache.has(value)) {
                                    return '[Circular]';
                                }
                                cache.add(value);
                            }
                            return value;
                        }, 2); // Indent for readability
                    };
                    logInfo(methodName, '>>> Options object when input is COMMAND string:', { optionsDump: safeStringify(options) });
                }
                // Use safeSerialize helper if available, otherwise basic JSON.stringify
                const safeStringify = (obj: any) => {
                    const cache = new Set();
                    return JSON.stringify(obj, (key, value) => {
                        if (typeof value === 'object' && value !== null) {
                            if (cache.has(value)) {
                                // Circular reference found, discard key
                                return '[Circular]';
                            }
                            // Store value in our collection
                            cache.add(value);
                        }
                        // Remove potentially sensitive or large objects
                        if (key === 'logger' || key === 'appDataSource' || key === 'databaseEntities' || key === 'analytic' || key === 'uploads' || key === 'req') {
                            return `[Removed: ${key}]`;
                        }
                        return value;
                    }, 2); // Indent for readability
                };
                logInfo(methodName, 'Full Input Object:', { inputDump: safeStringify(input) });
                logInfo(methodName, 'Full Options Object:', { optionsDump: safeStringify(options) });
            } catch (dumpError) {
                logError(methodName, 'Error during full input/options dump', dumpError as Error);
                // Log basic types if stringify fails
                logInfo(methodName, 'Basic Input Type:', { type: typeof input });
                logInfo(methodName, 'Basic Options Keys:', { keys: Object.keys(options) });
            }
            logInfo(methodName, '--- END: Full Input/Options Dump ---');
            // *** NEW DETAILED LOGGING END ***

            // --- START: DETAILED OPTIONS LOGGING ---
            logInfo(methodName, '--- START: Inspecting options object ---');
            logInfo(methodName, `Options keys: ${Object.keys(options).join(', ')}`);
            if (options.req) {
                logInfo(methodName, `options.req exists. Keys: ${Object.keys(options.req).join(', ')}`);
                if (options.req.headers) {
                    logInfo(methodName, `options.req.headers: ${JSON.stringify(options.req.headers)}`);
                } else {
                    logInfo(methodName, 'options.req.headers does NOT exist.');
                }
            } else {
                logInfo(methodName, 'options.req does NOT exist.');
            }
            if (options.requestHeaders) {
                 logInfo(methodName, `options.requestHeaders: ${JSON.stringify(options.requestHeaders)}`);
            } else {
                 logInfo(methodName, 'options.requestHeaders does NOT exist.');
            }
             logInfo(methodName, '--- END: Inspecting options object ---');
            // --- END: DETAILED OPTIONS LOGGING ---


            // Detailed input logging
            logInfo(methodName, 'Raw input received:', {
                inputType: typeof input,
                isString: typeof input === 'string',
                isObject: typeof input === 'object' && input !== null,
                isEmpty: typeof input === 'string' && input.trim() === '',
                rawValue: typeof input === 'string' ? input : JSON.stringify(input),
                hasCommand: typeof input === 'object' && input !== null && 'command' in input,
                command: typeof input === 'object' && input !== null && 'command' in input ? input.command : undefined
            });

            // Null check with logging
            if (input === null || input === undefined) {
                logInfo(methodName, 'Early return - null input', {
                    isNull: input === null,
                    isUndefined: input === undefined
                });
                return {
                    text: '',
                    error: 'No input provided'
                };
            }
            // If input is an empty string but options contain command data
            if (typeof input === 'string' && input.trim() === '' && options) {
                logInfo(methodName, 'Checking options for command data:', {
                    hasCommand: 'command' in options,
                    command: options.command,
                    hasParams: !!options.commandParams
                });

                // If we find command data in options, construct proper input object
                if ('command' in options && options.command?.startsWith('conversation_')) {
                    input = {
                        question: '',
                        command: options.command,
                        commandParams: options.commandParams,
                        sessionId: options.sessionId || `session_${options.chatflowid || 'default'}`,
                        userId: options.userId || '',
                        chatId: options.chatId || `chat_${options.chatflowid || 'default'}`,
                        source: options.source || 'webapp',
                        chatType: options.chatType || 'private',
                        messageId: Date.now(),
                        auth: options.auth
                    };

                    logInfo(methodName, 'Reconstructed input from options:', {
                        hasCommand: true,
                        command: input.command,
                        source: input.source
                    });
                }
            }
            // Create safe options object without circular references early
            const safeOptions = Object.keys(options).reduce((acc, key) => {
                if (key !== 'logger' && key !== 'appDataSource' && typeof options[key] !== 'function') {
                    acc[key] = options[key];
                }
                return acc;
            }, {} as ICommonObject);

            const chatflowid = safeOptions.chatflowid || 'default_chatflow';
            const botKey = chatflowid;
            const flowId = getOrCreateFlowId(botKey);

            // Parse input if it's a JSON string
            let parsedInput: SafeOptions;
            if (typeof input === 'string') {
                try {
                    // Check for encoded command in question field
                    const commandData = this.decodeCommand(input.trim());
                    if (commandData) {
                        logInfo(methodName, 'Detected encoded command:', {
                            command: commandData.command,
                            hasParams: !!commandData.params,
                            params: commandData.params
                        });

                        // Parse webapp data from chatId first
                        const webappData = options.chatId ? this.parseWebappChatId(options.chatId) : null;
                        if (webappData) {
                            logInfo(methodName, 'Found webapp user data:', {
                                userId: webappData.userId,
                                firstName: webappData.firstName,
                                sessionId: webappData.sessionId
                            });

                            const normalizedUserId = `tg_${webappData.userId}`;

                            // *** MODIFIED: Include authToken and authUserId from original payload if available ***
                            // We need to access the original payload. Assuming 'input' might be the original object if not a string,
                            // or we might need to check 'options' if the original object structure isn't preserved.
                            // Let's assume 'input' holds the original object structure if it wasn't a string initially.
                            // A more robust solution might involve passing the original payload explicitly.
                            const originalPayload = (typeof options?.input === 'object' && options.input !== null) ? options.input : {};

                            // Create SafeOptions with command data and user info
                            parsedInput = {
                                question: input,  // Keep original encoded command
                                sessionId: webappData.sessionId,
                                userId: normalizedUserId,
                                chatId: options.chatId,
                                source: 'webapp',
                                chatType: 'private',
                                messageId: Date.now(),
                                command: commandData.command,
                                commandParams: commandData.params,
                                firstName: webappData.firstName,
                                auth: {
                                    type: AUTH_TYPES.TELEGRAM,
                                    id: normalizedUserId,
                                    username: webappData.firstName
                                },
                                // *** CORRECTED: Use data parsed from chatId (webappData) ***
                                authToken: webappData.authToken, // Use token from parsed webappData
                                authUserId: normalizedUserId      // Use the normalized user ID derived from webappData
                            };
                            logInfo(methodName, 'Included authToken/authUserId in parsedInput for webapp command (from webappData)', {
                                authTokenSource: webappData.authToken ? 'webappData' : 'missing',
                                authUserIdSource: normalizedUserId ? 'webappData' : 'missing',
                                hasAuthToken: !!parsedInput.authToken,
                                hasAuthUserId: !!parsedInput.authUserId
                            });
                        } else {
                            // Fallback if no webapp data (e.g., Flowise source)
                            parsedInput = {
                                question: input,
                                sessionId: options.sessionId || `session_${options.chatflowid || 'default'}`,
                                userId: options.userId || '',
                                chatId: options.chatId || `chat_${options.chatflowid || 'default'}`,
                                source: options.source || 'webapp',
                                chatType: options.chatType || 'private',
                                messageId: Date.now(),
                                command: commandData.command,
                                commandParams: commandData.params,
                                auth: options.auth
                                // Note: authToken/authUserId might be missing here for non-webapp sources
                            };
                        }
                    } else if (input.trim().startsWith('{')) {
                        logInfo(methodName, 'Attempting to parse JSON string');
                        const jsonParsed = JSON.parse(input);
                        if (typeof jsonParsed === 'object' && jsonParsed !== null) {
                            parsedInput = { ...jsonParsed };
                            logInfo(methodName, 'Successfully parsed JSON input:', {
                                hasCommand: 'command' in parsedInput,
                                command: parsedInput.command,
                                source: parsedInput.source
                            });
                        } else {
                            parsedInput = this.createDefaultSafeOptions(input, safeOptions);
                        }
                    } else {
                        // *** MODIFIED START: Check options if input string is empty ***
                        if (input.trim() === '' && options && 'command' in options && options.command) {
                            logInfo(methodName, 'Empty string input, reconstructing from options command data');
                            parsedInput = {
                                question: '', // Keep question empty
                                command: options.command,
                                commandParams: options.commandParams,
                                sessionId: options.sessionId || `session_${options.chatflowid || 'default'}`,
                                userId: options.userId || '',
                                chatId: options.chatId || `chat_${options.chatflowid || 'default'}`,
                                source: options.source || 'webapp',
                                chatType: options.chatType || 'private',
                                messageId: Date.now(),
                                auth: options.auth
                            };
                        } else {
                            // If input string is not empty or options lack command, create default
                            parsedInput = this.createDefaultSafeOptions(input, safeOptions);
                        }
                        // *** MODIFIED END ***
                    }
                } catch (err) {
                    logInfo(methodName, 'Input parsing failed:', {
                        error: err instanceof Error ? err.message : 'Unknown error',
                        input: input.length > 100 ? `${input.substring(0, 100)}...` : input
                    });
                    // Fallback to default on error
                    parsedInput = this.createDefaultSafeOptions(typeof input === 'string' ? input : '', safeOptions);
                }
            } else if (typeof input === 'object' && input !== null) { // Explicitly check for object type here
                // *** ADDED LOGGING START ***
                logInfo(methodName, 'Received object input. Logging keys and content:', {
                    inputKeys: Object.keys(input),
                    inputContent: JSON.stringify(input, (key, value) => { // Add replacer to handle potential circular refs
                        if (key === 'logger' || key === 'appDataSource') return '[Removed]';
                        return value;
                    }, 2) // Pretty print for readability
                });
                // *** ADDED LOGGING END ***

                // Log the entire input object for debugging webapp requests (Keep existing log too)
                logInfo(methodName, 'Received object input (potential webapp request):', { inputObject: JSON.stringify(input, null, 2) });
                parsedInput = { ...input };
            } else {
                 // Handle unexpected input types defensively
                 logWarn(methodName, 'Unexpected input type encountered:', { inputType: typeof input });
                 parsedInput = this.createDefaultSafeOptions('', safeOptions); // Create default for safety
            }


            // Log final parsed input state
            logInfo(methodName, 'Final parsed input state:', {
                source: parsedInput.source,
                userId: parsedInput.userId,
                hasAuth: !!parsedInput.auth,
                command: parsedInput.command,
                hasParams: !!parsedInput.commandParams
            });

            // --- START: Subsequent Web App Request Token Validation (from Payload) ---
            // Only validate token if it's a webapp source AND not the initial auth request
            if (parsedInput.source === 'webapp' && !parsedInput.telegramInitData) {
                 // *** ADDED: Ensure authService exists before validation ***
                 if (!this.authService) {
                     logWarn(methodName, 'AuthService is missing before token validation. Attempting re-initialization...');
                     try {
                         await this._reinitializeServices(nodeData, options);
                         logInfo(methodName, 'Re-initialization of services completed.');
                         if (!this.authService) {
                             throw new Error('AuthService still missing after re-initialization attempt.');
                         }
                     } catch (reinitError) {
                         logError(methodName, 'Failed to re-initialize services during run', reinitError as Error);
                         // Return an error response as we cannot proceed without authService
                         return { text: '🔒 Internal Server Error', error: 'Authentication service unavailable', requireAuth: true, showAuthModal: true };
                     }
                 }
                 // *** END ADDED ***

                 // *** ADDED LOGGING: Check authService status ***
                 logInfo(methodName, 'Checking authService before token validation:', {
                     authServiceExists: !!this.authService,
                     authServiceType: typeof this.authService,
                     hasValidateTokenMethod: typeof this.authService?.validateToken === 'function'
                 });

                 // Get token and user ID from the PAYLOAD now
                 const tokenFromPayload = parsedInput.authToken as string | undefined;
                 const userIdFromPayload = parsedInput.authUserId as string | undefined; // This should match parsedInput.userId if set correctly

                 logInfo(methodName, 'Processing subsequent webapp request, checking token from PAYLOAD', { userId: userIdFromPayload, hasToken: !!tokenFromPayload });

                 if (!tokenFromPayload || !userIdFromPayload) {
                     logWarn(methodName, 'Missing authToken or authUserId in request payload for subsequent webapp request.');
                     // Return auth required error immediately if token/userId missing in payload
                     const userStats = userIdFromPayload ? await this.databaseService.getStatsForUser(userIdFromPayload) : null;
                     const userRecord = userIdFromPayload ? await this.databaseService.getUserById(userIdFromPayload) : null;
                     const tokenStats = userRecord && userStats ? { /* ... construct tokenStats ... */ } : null; // Construct as before if needed
                     return {
                         text: '🔒 Authentication Required', error: 'Missing authentication token or user ID', requireAuth: true, showAuthModal: true,
                         metadata: { type: 'auth_error', timestamp: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' }), tokenStats }
                     } as FormattedResponse;
                 }

                 // Validate the token from the payload
                 const isTokenValid = await this.authService.validateToken(userIdFromPayload, tokenFromPayload);
                 if (!isTokenValid) {
                     logWarn(methodName, 'Invalid authToken provided in webapp request payload', { userId: userIdFromPayload });
                      // Return auth required error if token invalid
                     const userStats = await this.databaseService.getStatsForUser(userIdFromPayload);
                     const userRecord = await this.databaseService.getUserById(userIdFromPayload);
                     const tokenStats = userRecord && userStats ? { /* ... construct tokenStats ... */ } : null; // Construct as before if needed
                     return {
                         text: '🔒 Authentication Required', error: 'Invalid or expired token', requireAuth: true, showAuthModal: true,
                         metadata: { type: 'auth_error', timestamp: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' }), tokenStats }
                     } as FormattedResponse;
                 }

                 logInfo(methodName, 'Webapp token from payload validated successfully', { userId: userIdFromPayload });

                 // Ensure the main userId used for processing matches the validated ID
                 if (parsedInput.userId !== userIdFromPayload) {
                    logWarn(methodName, 'Mismatch between input userId and validated payload authUserId', { inputUserId: parsedInput.userId, payloadUserId: userIdFromPayload });
                    parsedInput.userId = userIdFromPayload; // Trust the validated payload ID
                 }
            }
            // --- END: Subsequent Web App Request Token Validation ---


            // Early command detection and handling
            if ('command' in parsedInput && parsedInput.command?.startsWith('conversation_')) {
                if (this.isValidConversationOperation(parsedInput.command)) {
                    logInfo(methodName, 'Command-only payload detected:', {
                        command: parsedInput.command,
                        hasParams: !!parsedInput.commandParams,
                        userId: parsedInput.userId
                    });

                    // Initialize bot for command handling
                    let telegramBot: TelegramBot_Agents | undefined;
                    const botKey = safeOptions.chatflowid || 'default_chatflow';
                    const flowId = getOrCreateFlowId(botKey);

                    if (!botInitializationLocks[botKey]) {
                        botInitializationLocks[botKey] = new Mutex();
                    }

                    await botInitializationLocks[botKey].runExclusive(async () => {
                        logInfo(methodName, 'Starting bot initialization for command');
                        telegramBot = await this.getOrCreateBotInstance(botKey, flowId, nodeData, safeOptions);
                    });

                    if (!telegramBot) {
                        throw new Error("Failed to initialize bot for command handling");
                    }

                    // For command-only requests, skip memory update
                    const commandOptions = {
                        ...safeOptions,
                        skipMemoryUpdate: true
                    };

                    // Handle command directly
                    return await telegramBot.executeRun(nodeData, parsedInput, commandOptions);
                } else {
                    logWarn(methodName, 'Invalid conversation command:', { command: parsedInput.command });
                }
            }
            // Initialize bot with mutex lock
            let telegramBot: TelegramBot_Agents | undefined;
            if (!botInitializationLocks[botKey]) {
                botInitializationLocks[botKey] = new Mutex();
            }

            await botInitializationLocks[botKey].runExclusive(async () => {
                logInfo(methodName, 'Starting bot initialization');
                telegramBot = await this.getOrCreateBotInstance(botKey, flowId, nodeData, options);
                logInfo(methodName, 'Bot initialization complete:', {
                    success: !!telegramBot,
                    isInitialized: telegramBot?.isInitialized,
                    isRunning: telegramBot?.isRunning
                });
            });

            if (!telegramBot) {
                throw new Error("Failed to retrieve or initialize bot instance.");
            }

            // Store chatflowId if not already set
            if (!this.chatflowId && options.chatflowId) {
                this.chatflowId = options.chatflowId;
                logInfo(methodName, 'Setting chatflow ID:', { chatflowId: this.chatflowId });
            }

            // Check chatflow state before initialization
            if (this.chatflowId && this.chatflowPool) {
                const existingFlow = this.chatflowPool.activeChatflows[this.chatflowId];

                if (!existingFlow || !existingFlow.inSync) {
                    logInfo(methodName, 'Chatflow needs reinitialization:', {
                        chatflowId: this.chatflowId,
                        exists: !!existingFlow,
                        inSync: existingFlow?.inSync
                    });
                    this.isInitialized = false;
                } else {
                    logInfo(methodName, 'Using existing chatflow:', {
                        chatflowId: this.chatflowId,
                        inSync: true
                    });
                }
            }

            // Ensure initialization with current nodeData and options
            if (!this.isInitialized) {
                await this.ensureInitialization(nodeData, options);
            }

            // Check if this is an auth request
            if (typeof parsedInput === 'object' && 'type' in parsedInput && parsedInput.type === AUTH_TYPES.TELEGRAM) {
                logInfo(methodName, 'Processing auth request');

                // Create proper TelegramAuthData
                const telegramAuthData: TelegramAuthData = {
                    id: parseInt(parsedInput.userId),
                    first_name: parsedInput.firstName || '',
                    username: parsedInput.firstName || '',
                    auth_date: Math.floor(Date.now() / 1000),
                    hash: ''
                };

                const authRequest: AuthRequest = {
                    type: AUTH_TYPES.TELEGRAM,
                    data: telegramAuthData,
                    timestamp: Date.now(),
                    sessionId: parsedInput.sessionId || `session_${chatflowid}`,
                    metadata: {
                        chatflowId: chatflowid,
                        source: 'webapp',
                        webAuthData: {
                            type: AUTH_TYPES.TELEGRAM,
                            telegramUser: {
                                id: telegramAuthData.id,
                                username: telegramAuthData.username,
                                first_name: telegramAuthData.first_name
                            },
                            source: 'webapp'
                        } as WebAuthData
                    }
                };
                return await this.executeAuthRequest(authRequest, options);
            }

            // Try to parse webapp data from chatId
            const webappData = options.chatId ? this.parseWebappChatId(options.chatId) : null;
            let webappAuthToken: string | undefined; // Variable to store the token from chatId

            if (webappData) {
                logInfo(methodName, 'Found webapp data in chatId', {
                    userId: webappData.userId,
                    firstName: webappData.firstName,
                    sessionId: webappData.sessionId,
                    hasAuthToken: !!webappData.authToken // Log if token was parsed
                });
                webappAuthToken = webappData.authToken; // Store the token

                const normalizedUserId = `tg_${webappData.userId}`;
                const userRecord = await this.databaseService.getUserById(normalizedUserId);

                // --- Token Validation (Using token from chatId) ---
                let isTokenValid = false;
                if (webappAuthToken && this.authService) {
                     isTokenValid = await this.authService.validateToken(normalizedUserId, webappAuthToken);
                     logInfo(methodName, 'Webapp token validation result (from chatId):', { userId: normalizedUserId, tokenProvided: !!webappAuthToken, isValid: isTokenValid });
                } else {
                     // Log warning if token is missing in chatId or authService is unavailable
                     logWarn(methodName, 'Webapp token from chatId or authService missing for validation', { userId: normalizedUserId, hasToken: !!webappAuthToken, hasAuthService: !!this.authService });
                }
                // --- End Token Validation ---
                const userStats = await this.databaseService.getStatsForUser(normalizedUserId);

                if (!isTokenValid) { // Check the validation result
                    const tokenStats = userRecord && userStats ? {
                        quota: userRecord?.token_quota || 0, // Add null checks
                        used: userStats?.token_usage || 0,
                        remaining: userStats.available_tokens || 0,
                        total: userStats.total_tokens || 0,
                        messages: userStats.total_messages || 0,
                        lastReset: new Date(userStats.last_reset || Date.now()).toISOString(),
                        nextReset: userStats.next_reset_date ?
                            new Date(userStats.next_reset_date).toISOString() :
                            null,
                        subscription: userRecord.subscription_tier
                    } : null;

                    logInfo(methodName, 'Auth required for webapp access:', {
                        userId: normalizedUserId,
                        hasStats: !!tokenStats
                    });

                    return {
                        text: '🔒 Authentication Required',
                        error: 'Authentication required',
                        requireAuth: true,
                        showAuthModal: true,
                        metadata: {
                            type: 'auth_error',
                            timestamp: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' }),
                            tokenStats
                        }
                    } as FormattedResponse;
                }

                logInfo(methodName, 'Proceeding with valid token:', {
                    userId: normalizedUserId,
                    sessionId: webappData.sessionId,
                    tokenQuota: userStats?.token_quota,
                    tokenUsage: userStats?.token_usage
                });

                // Update parsedInput with webapp data while preserving existing data
                parsedInput = {
                    ...parsedInput,
                    sessionId: webappData.sessionId,
                    userId: normalizedUserId,
                    chatId: options.chatId,
                    source: 'webapp', // Set source to webapp
                    chatType: 'private',
                    firstName: webappData.firstName,
                    auth: {
                        type: AUTH_TYPES.TELEGRAM,
                        id: normalizedUserId,
                        username: webappData.firstName
                    },
                    metadata: {
                        tokenStats: {
                            quota: userRecord.token_quota,
                            used: userStats.token_usage || 0,
                            remaining: userStats.available_tokens || 0,
                            total: userStats.total_tokens || 0,
                            messages: userStats.total_messages || 0,
                            lastReset: new Date(userStats.last_reset || Date.now()).toISOString(),
                            nextReset: userStats.next_reset_date ?
                                new Date(userStats.next_reset_date).toISOString() :
                                null,
                            subscription: userRecord.subscription_tier
                        }
                    }
                };
            } else if (!parsedInput.source) {
                // Only set source to flowise if not already set and not webapp
                parsedInput.source = 'flowise';
            }

            logInfo(methodName, 'Final input data', {
                source: parsedInput.source,
                userId: parsedInput.userId,
                chatId: parsedInput.chatId,
                hasAuth: !!parsedInput.auth
            });

            const enhancedOptions = parsedInput.source === 'webapp' ? {
                ...options,
                isWebApp: true,
                userId: parsedInput.userId,
                auth: parsedInput.auth
            } : options;

            return await telegramBot.executeRun(nodeData, parsedInput, enhancedOptions);

        } catch (error) {
            logError(methodName, `Error processing request`, error as Error);
            return formatResponse(`Failed to process request: ${error.message}`);
        }
    }



    private async getOrCreateBotInstance(
        botKey: string,
        flowId: string,
        nodeData: INodeData,
        options: ICommonObject
    ): Promise<TelegramBot_Agents | undefined> {
        const methodName = 'getOrCreateBotInstance';

        let bot = botInstanceCache.get<TelegramBot_Agents>(botKey);

        if (!bot) {
            // --- Create New Instance ---
            logInfo(methodName, `Creating new bot instance`, { botKey, flowId });
            bot = new TelegramBot_Agents(flowId);
            try {
                // Full initialization for a new instance
                await bot.init(nodeData, '', options);
                botInstanceCache.set(botKey, bot);
                logInfo(methodName, `Bot instance created and cached`, { botKey });
            } catch (error) {
                logError(methodName, `Error initializing new bot`, error as Error);
                botInstanceCache.del(botKey); // Remove potentially broken instance from cache
                throw error; // Re-throw to signal failure
            }
        } else {
            // --- Use Cached Instance ---
            logInfo(methodName, `Retrieved existing bot instance from cache`, { botKey });

            // Check if essential services are missing on the cached instance
            if (!bot.databaseService || !bot.authService || !bot.accountManager) {
                logWarn(methodName, `Cached instance is missing essential services. Re-initializing services...`, {
                    botKey,
                    hasDB: !!bot.databaseService,
                    hasAuth: !!bot.authService,
                    hasAccountMgr: !!bot.accountManager
                });
                try {
                    // Re-initialize only the services on the existing instance
                    await bot._reinitializeServices(nodeData, options);
                    // Explicitly set flags after successful service re-initialization
                    bot.isInitialized = true;
                    bot.isRunning = true; // Assuming if services are re-init, bot should be considered running
                    logInfo(methodName, `Successfully re-initialized services on cached instance`, { botKey });
                } catch (serviceError) {
                    logError(methodName, `Error re-initializing services on cached bot`, serviceError as Error);
                    // If service re-init fails, remove from cache and force full re-init next time
                    botInstanceCache.del(botKey);
                    throw new Error(`Failed to re-initialize services on cached bot instance: ${(serviceError as Error).message}`);
                }
            } else {
                 logInfo(methodName, `Cached instance has all essential services.`);
                 // Ensure flags are correctly set even if services existed
                 bot.isInitialized = true;
                 bot.isRunning = true;
            }

            // Ensure the flowId is up-to-date on the cached instance
            if (bot.flowId !== flowId) {
                 logWarn(methodName, `Updating flowId on cached instance`, { oldFlowId: bot.flowId, newFlowId: flowId });
                 bot.flowId = flowId;
            }
        }

        return bot;
    }

    public async executeAuthRequest(request: AuthRequest, options: ICommonObject): Promise<ICommonObject> {
        const methodName = 'executeAuthRequest';
        try {
            logInfo(methodName, 'Processing auth request:', {
                type: request.type,
                hasData: !!request.data,
                hasToken: !!request.token
            });

            switch (request.type) {
                case AUTH_TYPES.TELEGRAM: {
                    const telegramData = request.data as TelegramAuthData;
                    if (!telegramData.id) {
                        return {
                            error: 'Missing Telegram user ID',
                            requireAuth: true
                        };
                    }

                    try {
                        // Use normalizeUserId for proper ID formatting (will add tg_ prefix)
                        const normalizedUserId = await this.databaseService.normalizeUserId(
                            telegramData.id.toString(),
                            AUTH_TYPES.TELEGRAM
                        );

                        logInfo(methodName, 'Processing user:', {
                            originalId: telegramData.id,
                            normalizedId: normalizedUserId
                        });

                        // Begin transaction
                        await this.databaseService.beginTransaction();

                        try {
                            // Check if user exists first
                            const existingUser = await this.databaseService.getUserById(normalizedUserId);

                            if (!existingUser) {
                                // Create user with proper DTO structure
                                const createUserDTO: CreateUserDTO = {
                                    id: normalizedUserId,  // Use normalized ID with tg_ prefix
                                    type: AUTH_TYPES.TELEGRAM,
                                    telegram_id: telegramData.id,
                                    telegram_username: telegramData.username || telegramData.first_name,
                                    subscription_tier: SUBSCRIPTION_TIERS.FREE,
                                    token_quota: this.databaseService.DEFAULT_TOKEN_QUOTA,
                                    metadata: {
                                        original_id: telegramData.id.toString(),
                                        source: 'webapp',
                                        created_at: new Date().toISOString(),
                                        auth_type: AUTH_TYPES.TELEGRAM,
                                        first_name: telegramData.first_name
                                    }
                                };

                                await this.databaseService.createUser(createUserDTO);

                                logInfo(methodName, 'Created new user:', {
                                    userId: normalizedUserId,
                                    type: AUTH_TYPES.TELEGRAM
                                });
                            }

                            // Generate new auth token using normalized ID
                            const token = await this.authService.generateTempAuthToken(normalizedUserId);

                            await this.databaseService.commitTransaction();

                            return {
                                success: true,
                                token,
                                userId: telegramData.id,
                                normalizedUserId  // Include normalized ID in response
                            };

                        } catch (error) {
                            await this.databaseService.rollbackTransaction();
                            throw error;
                        }
                    } catch (error) {
                        logError(methodName, 'Error creating user or token:', error as Error);
                        throw error;
                    }
                }

                case AUTH_TYPES.WALLET:
                case AUTH_TYPES.EMAIL:
                case AUTH_TYPES.FLOWISE:
                    return {
                        success: true,
                        source: request.type
                    };

                default:
                    return {
                        error: 'Unsupported auth type',
                        requireAuth: true
                    };
            }
        } catch (error) {
            logError(methodName, 'Auth request failed', error as Error);
            return {
                error: 'Auth request failed',
                requireAuth: true
            };
        }
    }

    /**
     * Executes the run operation for the TelegramBot_Agents class.
     *
     * This method is responsible for handling the execution of a message request, including:
     * - Ensuring the bot instance is properly initialized
     * - Handling web authentication for Flowise requests
     * - Creating a context adapter for the message
     * - Validating the message request
     * - Processing the message through the conversation manager and agent manager
     * - Updating the token usage for the user
     * - Formatting the response to be returned
     *
     * @param nodeData - The node data for the current execution.
     * @param input - The input message to be processed.
     * @param options - Additional options for the execution, such as the source of the request.
     * @returns The response from the bot, either as a string or an object.
     */
    // TelegramBot_Agents.ts

    private async executeRun(
        nodeData: INodeData,
        input: SafeOptions,
        options: ICommonObject
    ): Promise<string | ICommonObject> {
        const methodName = 'executeRun';
        logInfo(methodName, `Entering executeRun`, { source: input.source, userId: input.userId });

        try {
            const chatflowid = options.chatflowid;

            // --- START: Web App Authentication Handling ---
            if (input.telegramInitData) {
                logInfo(methodName, 'Detected telegramInitData, attempting web app authentication.');
                const botToken = this.getBotToken(); // Assuming this method exists and returns the token

                if (!botToken) {
                    logError(methodName, 'Bot token is missing, cannot validate initData', new Error('Bot token unavailable'));
                    return { error: 'Bot configuration error', requireAuth: true };
                }

                // Use the top-level validateTelegramInitData function
                const { isValid, user: telegramUser } = validateTelegramInitData(botToken, input.telegramInitData);

                if (isValid && telegramUser) {
                    try {
                        // Ensure services are available (might be redundant if ensureInitialization is called later, but safer here)
                        if (!this.databaseService || !this.authService) {
                             throw new Error('Database or Auth service not initialized for web app auth');
                        }

                        const normalizedUserId = await this.databaseService.normalizeUserId(telegramUser.id.toString(), AUTH_TYPES.TELEGRAM);
                        logInfo(methodName, 'initData valid, processing user', { telegramId: telegramUser.id, normalizedUserId });

                        // Ensure user exists in DB
                        const userAccount = await this.databaseService.getOrCreateUser({
                            id: normalizedUserId,
                            type: AUTH_TYPES.TELEGRAM,
                            telegram_id: telegramUser.id,
                            telegram_username: telegramUser.username || telegramUser.first_name,
                            subscription_tier: 'free',
                            token_quota: this.databaseService.DEFAULT_TOKEN_QUOTA,
                            metadata: { source: 'telegram-webapp-auth', initDataUser: telegramUser }
                        });

                        // Generate persistent tokens using the public method
                        const tokens = await this.authService.generatePersistentTokens(normalizedUserId);
                        logInfo(methodName, 'Tokens generated successfully', { userId: normalizedUserId });

                        // Return special auth success response
                        return {
                            isAuthSuccess: true,
                            user: userAccount, // Return full user data
                            token: tokens.accessToken,
                            refreshToken: tokens.refreshToken,
                            // Include other necessary fields for the frontend
                            chatId: input.chatId,
                            sessionId: input.sessionId,
                            source: 'webapp-auth-success' // Indicate source
                        };
                    } catch (authError) {
                        logError(methodName, 'Error during web app user processing/token generation', authError as Error);
                        return { error: 'Authentication processing failed', requireAuth: true };
                    }
                } else {
                    logWarn(methodName, 'Invalid telegramInitData received.');
                    return { error: 'Invalid Telegram InitData', requireAuth: true };
                }
            }
            // --- END: Web App Initial Authentication ---

            // --- START: Subsequent Web App Request Token Validation ---
            let tokenFromHeader: string | undefined;
            let userIdFromHeader: string | undefined;

            // Try getting headers from options.req first (more standard)
            if (options.req?.headers) {
                tokenFromHeader = options.req.headers['x-auth-token'] as string || options.req.headers['X-Auth-Token'] as string;
                userIdFromHeader = options.req.headers['x-user-id'] as string || options.req.headers['X-User-Id'] as string;
                logInfo(methodName, 'Checked options.req.headers', { hasToken: !!tokenFromHeader, hasUserId: !!userIdFromHeader });
            }

            // Fallback to options.requestHeaders if not found in options.req
            if (!tokenFromHeader && options.requestHeaders) {
                 tokenFromHeader = options.requestHeaders['x-auth-token'] || options.requestHeaders['X-Auth-Token'];
                 logInfo(methodName, 'Checked options.requestHeaders (fallback)', { hasToken: !!tokenFromHeader });
            }
             if (!userIdFromHeader && options.requestHeaders) {
                 userIdFromHeader = options.requestHeaders['x-user-id'] || options.requestHeaders['X-User-Id'];
                 logInfo(methodName, 'Checked options.requestHeaders for userId (fallback)', { hasUserId: !!userIdFromHeader });
            }


            // --- START: Existing Command Handling ---
            const commandData = typeof input.question === 'string' ?
                this.decodeCommand(input.question) : null;

            if (commandData) {
                logInfo(methodName, 'Processing encoded command:', {
                    command: commandData.command,
                    hasParams: !!commandData.params,
                    userId: input.userId
                });

                if (this.isValidConversationOperation(commandData.command)) {
                    // Process command parameters based on command type
                    let processedParams = { ...commandData.params };

                    // Handle special parameter processing for different commands
                    if (commandData.command === 'conversation_save') {
                        try {
                            // Parse messages if it's a string
                            if (typeof processedParams.messages === 'string') {
                                processedParams.messages = JSON.parse(processedParams.messages);
                                logInfo(methodName, 'Successfully parsed messages array:', {
                                    messageCount: processedParams.messages.length
                                });
                            }
                        } catch (err) {
                            logError(methodName, 'Failed to parse messages:', err as Error);
                            throw new Error('Invalid messages format');
                        }
                    }

                    try {
                        const commandResponse = await this.handleConversationCommand(
                            commandData.command,
                            processedParams,
                            input.userId?.toString() || ''
                        );

                        logInfo(methodName, 'Encoded command processed:', {
                            success: true,
                            hasMetadata: !!commandResponse.metadata,
                            responseKeys: Object.keys(commandResponse)
                        });

                        // Return command response without initializing message pipeline
                        return {
                            text: 'Command processed successfully',
                            content: 'Command processed successfully',
                            metadata: {
                                type: 'command_response',
                                command: commandData.command,
                                timestamp: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' }),
                                ...commandResponse.metadata
                            },
                            chatId: input.chatId,
                            chatMessageId: input.messageId?.toString() || Date.now().toString(),
                            isStreamValid: false,
                            sessionId: input.sessionId,
                            source: input.source,
                            memoryType: this.memory
                        } as FormattedResponse;
                    } catch (error) {
                        logError(methodName, 'Command processing error:', error as Error);
                        return {
                            text: 'Failed to process command',
                            content: 'Failed to process command',
                            error: error instanceof Error ? error.message : 'Unknown error',
                            metadata: {
                                type: 'command_error',
                                command: commandData.command,
                                timestamp: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })
                            },
                            chatId: input.chatId,
                            chatMessageId: input.messageId?.toString() || Date.now().toString(),
                            isStreamValid: false,
                            sessionId: input.sessionId,
                            source: input.source,
                            memoryType: this.memory
                        } as FormattedResponse;
                    }
                }
            }
            // If no encoded command, check for direct command            
            if ('command' in input && input.command?.startsWith('conversation_')) {
                logInfo(methodName, 'Processing conversation command', {
                    command: input.command,
                    hasParams: !!input.commandParams,
                    userId: input.userId
                });

                const commandResponse = await this.handleConversationCommand(
                    input.command,
                    input.commandParams,
                    input.userId?.toString() || ''
                );

                logInfo(methodName, 'Conversation command processed', {
                    success: true,
                    hasMetadata: !!commandResponse.metadata,
                    responseKeys: Object.keys(commandResponse)
                });

                // Return command response without initializing message pipeline
                return {
                    text: 'Command processed successfully',
                    content: 'Command processed successfully',
                    metadata: {
                        type: 'command_response',
                        command: input.command,
                        timestamp: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' }),
                        ...commandResponse.metadata
                    },
                    chatId: input.chatId,
                    chatMessageId: input.messageId?.toString() || Date.now().toString(),
                    isStreamValid: false,
                    sessionId: input.sessionId,
                    source: input.source,
                    memoryType: this.memory
                } as FormattedResponse;
            }


            // Create message context based on source
            /**
             * Creates a message context object based on the provided SafeOptions data.
             * The message context is used to represent the incoming message and associated metadata.
             *
             * @param data - The SafeOptions data containing the message details.
             * @returns The created MessageContext object.
             */
            const createMessageContext = (data: SafeOptions): MessageContext => {
                return {
                    source: data.source,
                    chatId: data.chatId,
                    messageId: data.messageId,
                    userId: data.userId,
                    username: data.firstName,  // Use firstName as username if available
                    first_name: data.firstName,
                    input: data.question,     // The actual input string
                    raw: {
                        message: {
                            text: data.question,
                            message_id: typeof data.messageId === 'string' ? parseInt(data.messageId) : data.messageId || Date.now(),
                            date: Math.floor(Date.now() / 1000),
                            chat: {
                                id: data.chatId,
                                type: data.chatType,
                                // Add any additional chat properties from data if available
                                ...(data.raw?.chat || {})
                            },
                            from: {
                                id: typeof data.userId === 'string' ? parseInt(data.userId) : data.userId,
                                is_bot: false,
                                first_name: data.firstName || '',
                                username: data.firstName,  // Use firstName as username if available
                                // Add any additional user properties from data if available
                                ...(data.raw?.from || {})
                            }
                        },
                        chat: {
                            id: data.chatId,
                            type: data.chatType,
                            // Add any additional chat properties from data if available
                            ...(data.raw?.chat || {})
                        },
                        from: {
                            id: typeof data.userId === 'string' ? parseInt(data.userId) : data.userId,
                            is_bot: false,
                            first_name: data.firstName || '',
                            username: data.firstName,
                            // Add any additional user properties from data if available
                            ...(data.raw?.from || {})
                        },
                        flowwise_chatflow_id: data.chatflowId,
                        metadata: {
                            chatflowId: data.chatflowId,
                            auth: data.auth,
                            source: data.source
                        }
                    },
                    // Optional callback query data
                    callbackQuery: data.callbackQuery,
                    isAI: false,
                    isReply: false,
                    replyToMessage: data.replyToMessage
                };
            };
            let inputData: SafeOptions;
            const webappData = options.chatId ? this.parseWebappChatId(options.chatId) : null;

            if (webappData) {
                // Use normalized userId with tg_ prefix
                const normalizedUserId = `tg_${webappData.userId}`;

                logInfo(methodName, 'Processing webapp request:', {
                    userId: normalizedUserId,
                    firstName: webappData.firstName,
                    sessionId: webappData.sessionId
                });

                // Use normalized ID for token validation
                const hasValidToken = await this.databaseService.hasValidAuthToken(normalizedUserId);
                if (!hasValidToken) {
                    logInfo(methodName, 'Auth required for webapp access:', {
                        userId: normalizedUserId
                    });
                    return {
                        error: 'Invalid or expired token',
                        requireAuth: true,
                        question: typeof input === 'string' ? input : input.question,
                        chatId: options.chatId,
                        chatMessageId: options.messageId,
                        isStreamValid: false,
                        sessionId: options.chatId,
                        memoryType: this.memory
                    };
                }

                inputData = {
                    question: typeof input === 'string' ? input : (input as SafeOptions).question,
                    sessionId: webappData.sessionId,
                    userId: normalizedUserId,  // Use normalized ID
                    chatId: options.chatId,
                    source: 'webapp',  // Keep webapp as source
                    chatType: 'private',
                    messageId: Date.now().toString(),
                    firstName: webappData.firstName,
                    auth: {
                        type: AUTH_TYPES.TELEGRAM,  // Use telegram auth type
                        id: normalizedUserId,
                        username: webappData.firstName
                    },
                    interface: 'webapp'  // Track the interface in inputData
                };

            } else if (options.source === AUTH_TYPES.TELEGRAM) {
                const normalizedUserId = `tg_${options.userId}`;

                inputData = {
                    question: typeof input === 'string' ? input : (input as SafeOptions).question,
                    sessionId: options.sessionId || `session_${chatflowid}`,
                    userId: normalizedUserId,
                    chatId: options.chatId || '',
                    source: AUTH_TYPES.TELEGRAM,  // Keep telegram as source
                    chatType: options.chatType || 'private',
                    messageId: options.messageId?.toString() || Date.now().toString(),
                    firstName: options.firstName,
                    auth: {
                        type: AUTH_TYPES.TELEGRAM,
                        id: normalizedUserId,
                        username: options.firstName || ''
                    }
                };
            } else {
                // Flowise case remains the same
                inputData = {
                    question: typeof input === 'string' ? input : (input as SafeOptions).question,
                    sessionId: `session_${chatflowid}`,
                    userId: options.userId || '',
                    chatId: options.chatId || `chat_${chatflowid}`,
                    source: 'flowise',
                    chatType: 'private',
                    messageId: Date.now().toString(),
                    auth: {
                        type: 'flowise',
                        id: options.userId || '',
                        username: 'flowise_user'
                    }
                };
            }

            // Create context with proper typing
            const context = createMessageContext(inputData);

            // Create session data
            const now = new Date().toISOString();
            const sessionData: SessionInfo = {
                id: inputData.sessionId,
                userId: inputData.userId,  // Already normalized
                sessionId: inputData.sessionId,
                type: inputData.chatType,
                source: inputData.source,  // Keep original source (webapp/telegram)
                chat_id: inputData.chatId,
                flowwiseChatflowId: chatflowid,
                created_at: now,
                last_active: now,
                expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
                status: 'active',
                auth: {
                    type: inputData.auth?.type || inputData.source,
                    id: inputData.userId,
                    username: inputData.auth?.username || inputData.firstName || `${inputData.source}_user`
                },
                metadata: {
                    chatflowid,
                    original_request: inputData,
                    auth_type: inputData.auth?.type,
                    lastActive: now,
                    requiresAuth: inputData.source === 'webapp'  // Auth required for webapp source
                }
            };

            logInfo(methodName, 'Creating session with data', {
                sessionId: sessionData.sessionId,
                userId: sessionData.userId,
                chatId: sessionData.chat_id,
                source: sessionData.source,
                requiresAuth: sessionData.metadata.requiresAuth
            });

            // Add validation before creating session
            if (!sessionData.chat_id) {
                logWarn(methodName, 'Missing chat_id, using fallback', {
                    sessionId: sessionData.sessionId,
                    source: sessionData.source
                });
                sessionData.chat_id = sessionData.sessionId;
            }

            // Get or create session
            const session = await this.databaseService.getOrCreateSession(
                sessionData,
                inputData.source === 'flowise'  // Skip user creation for flowise source
            );

            const adapter = new ContextAdapter(context, this.promptManager!);

            // Get session info
            const sessionInfo = await this.conversationManager!.getSessionInfo(adapter);

            // Process the message
            const aiResponse = await this.handleMessage(adapter, this.conversationManager!, this.agentManager);

            // Handle different response types based on source
            // Handle different response types based on source
            if (context.source === 'webapp' || context.source === 'flowise') {
                // If handleMessage already returned a FormattedResponse, use it directly
                if (typeof aiResponse !== 'string') { // Check if aiResponse is the FormattedResponse object
                     logInfo(methodName, `Returning pre-formatted response for source: ${context.source}`);
                     // Ensure token stats are added if available (might be redundant if already added, but safe)
                     // *** Use the normalized userId from inputData for the final stats check ***
                     const userStats = await this.accountManager.getUserStats(inputData.userId); // Use normalized ID
                     if (userStats && aiResponse.metadata) {
                         // Ensure metadata.tokenStats exists and initialize with defaults if not
                         if (!aiResponse.metadata.tokenStats) {
                             aiResponse.metadata.tokenStats = {
                                 quota: 0,
                                 used: 0,
                                 remaining: 0,
                                 messages: 0,
                                 lastReset: new Date(0).toISOString(), // Use epoch as default
                                 nextReset: null,
                                 subscription: 'unknown'
                             };
                         }
                         const QUOTA = userStats.token_quota || 25000; // Use actual quota if available
                         aiResponse.metadata.tokenStats = {
                             quota: QUOTA,
                             used: userStats.token_usage || 0,
                             remaining: Math.max(0, QUOTA - (userStats.token_usage || 0)),
                             messages: userStats.total_messages || 0,
                             lastReset: new Date(userStats.last_reset || Date.now()).toISOString(),
                             nextReset: userStats.next_reset_date ? new Date(userStats.next_reset_date).toISOString() : null,
                             subscription: userStats.subscription_tier // Assuming subscription_tier is on userStats or userRecord
                         };
                     }
                     return aiResponse; // Return the FormattedResponse directly
                } else {
                    // If handleMessage returned a string (unexpected for webapp/flowise now, but handle defensively)
                    logWarn(methodName, `handleMessage returned string for ${context.source}, formatting now.`);
                    // *** FIXED: Use the normalized userId from inputData ***
                    const userStats = await this.accountManager.getUserStats(inputData.userId); // Use normalized ID
                    // Handle null case for userStats before passing to formatResponse
                    return this.formatResponse(aiResponse, context, { userStats: userStats || undefined });
                }
            }

            // For Telegram source, formatResponse returns a string
            return this.formatResponse(aiResponse, context); // formatResponse handles string conversion for Telegram
        } catch (error) {
            logError(methodName, 'Error in executeRun:', error as Error);
            throw error;
        }
    }

    private async ensureInitialization(nodeData: INodeData, options: ICommonObject): Promise<void> {
        const methodName = 'ensureInitialization';
        logInfo(methodName, 'Starting initialization check...', {
            isInitialized: this.isInitialized,
            isRunning: this.isRunning,
            initializing: this.initializing,
            hasDatabase: !!this.databaseService,
            hasAuth: !!this.authService,
            hasAccountMgr: !!this.accountManager
        });

        // *** MODIFIED CHECK ***
        // Consider initialized if flag is true AND essential services exist
        const alreadyInitialized = this.isInitialized && this.isRunning && this.databaseService && this.authService && this.accountManager;

        if (alreadyInitialized) {
            logInfo(methodName, 'Bot is already initialized and running with essential services.');
            return;
        }

        // If initialization is in progress, wait for it
        if (this.initializing) {
            logInfo(methodName, 'Initialization in progress. Waiting for completion...');
            await this.waitForInitialization();
            logInfo(methodName, 'Initialization wait completed');
            // Re-check after waiting, as state might have changed
             if (this.isInitialized && this.isRunning && this.databaseService && this.authService && this.accountManager) {
                 logInfo(methodName, 'Initialization completed during wait.');
                 return;
             } else {
                 logWarn(methodName, 'Initialization did not complete successfully after waiting.');
                 // Proceed to re-initialize if still needed
             }
        }

        // *** MODIFIED CONDITION ***
        // Initialize if not considered already initialized
        if (!alreadyInitialized) {
            logInfo(methodName, 'Starting initialization...', {
                reason: !this.isInitialized ? 'Flag false' :
                        !this.isRunning ? 'Not running' :
                        !this.databaseService ? 'Missing DB' :
                        !this.authService ? 'Missing Auth' :
                        !this.accountManager ? 'Missing AccountMgr' :
                        'Unknown'
            });
            try {
                this.initializing = true;
                await this.init(nodeData, '', options); // init now checks internally before creating services
                this.isInitialized = true; // Set flag after successful init
                this.isRunning = true;
                // Verify services after initialization
                if (!this.databaseService || !this.authService || !this.accountManager) {
                     throw new Error('Essential services failed to initialize');
                }
                logInfo(methodName, 'Initialization completed successfully');
            } catch (error) {
                logError(methodName, 'Initialization failed:', error as Error);
                // Explicitly reset flags on error
                this.isInitialized = false;
                this.isRunning = false;
                throw error; // Rethrow the error after resetting flags
            } finally {
                this.initializing = false;
            }
        } else {
             logInfo(methodName, 'Already in valid state, no action needed');
        }

        logInfo(methodName, 'Initialization check finished', {
            isInitialized: this.isInitialized,
            isRunning: this.isRunning,
            initializing: this.initializing,
            hasDatabase: !!this.databaseService
        });
    }

    private createMessageContext(input: SafeOptions): MessageContext {
        return {
            source: input.source,
            chatId: input.chatId,
            messageId: input.messageId,
            userId: input.userId,
            username: input.firstName,
            first_name: input.firstName,
            input: input.question,
            raw: {
                message: {
                    text: input.question,
                    message_id: typeof input.messageId === 'string' ? parseInt(input.messageId) : input.messageId || Date.now(),
                    date: Math.floor(Date.now() / 1000),
                    chat: {
                        id: input.chatId,
                        type: input.chatType,
                        ...(input.raw?.chat || {})
                    },
                    from: {
                        id: typeof input.userId === 'string' ? parseInt(input.userId) : input.userId,
                        is_bot: false,
                        first_name: input.firstName || '',
                        username: input.firstName,
                        ...(input.raw?.from || {})
                    }
                },
                chat: {
                    id: input.chatId,
                    type: input.chatType,
                    ...(input.raw?.chat || {})
                },
                from: {
                    id: typeof input.userId === 'string' ? parseInt(input.userId) : input.userId,
                    is_bot: false,
                    first_name: input.firstName || '',
                    username: input.firstName,
                    ...(input.raw?.from || {})
                },
                flowwise_chatflow_id: input.chatflowId,
                metadata: {
                    chatflowId: input.chatflowId,
                    auth: input.auth,
                    source: input.source
                }
            },
            callbackQuery: input.callbackQuery,
            isAI: false,
            isReply: false,
            replyToMessage: undefined
        };
    }

    private parseId(id: string | number | undefined): number {
        if (typeof id === 'number') {
            return id;
        }
        if (typeof id === 'string') {
            const parsed = parseInt(id, 10);
            if (!isNaN(parsed)) {
                return parsed;
            }
        }
        return Date.now(); // Fallback to current timestamp if parsing fails
    }
    // Helper method to ensure response text/content are strings
    private ensureStringResponse(response: string | FormattedResponse | any): string {
        if (typeof response === 'string') {
            return response;
        }
        if (typeof response === 'object') {
            return response.text || response.content || '';
        }
        return '';
    }


    public async initializeTelegramUser(adapter: ContextAdapter): Promise<UserAccount> {
        const methodName = 'initializeTelegramUser';
        const context = adapter.getMessageContext();
        const telegramId = typeof context.userId === 'string' ? parseInt(context.userId) : context.userId;

        try {
            // Ensure database is initialized
            await this.databaseService.initialize();

            const normalizedUserId = `tg_${telegramId}`;
            console.log(`[${methodName}] Initializing user:`, {
                telegramId,
                normalizedUserId,
                username: context.username
            });
            const userData: CreateUserDTO = {
                id: `telegram_${telegramId}`,
                type: AUTH_TYPES.TELEGRAM,
                telegram_id: telegramId,
                telegram_username: context.username || undefined,  // Ensure undefined instead of null
                subscription_tier: SUBSCRIPTION_TIERS.FREE,
                token_quota: this.DEFAULT_TOKEN_QUOTA,
                metadata: {
                    auth_timestamp: Date.now(),
                    auth_type: AUTH_TYPES.TELEGRAM,
                    first_name: context.raw?.from?.first_name,
                    source: 'telegram'
                }
            };

            // Create or get user
            const userRecord = await this.databaseService.getOrCreateUser(userData);
            console.log(`[${methodName}] User record created/retrieved:`, {
                userId: userRecord.id,
                type: userRecord.type
            });

            // Only after user is created, handle auth tokens
            if (userRecord) {
                try {
                    const authTokens = await this.authService.authenticateTelegram({
                        id: telegramId,
                        username: context.username
                    });

                    // Store the tokens
                    await this.databaseService.storeAuthTokens(
                        userRecord.id,
                        authTokens.accessToken,
                        authTokens.refreshToken
                    );
                } catch (tokenError) {
                    // Log token error but don't fail the whole initialization
                    console.warn(`Token generation failed but user was created:`, tokenError);
                }
            }
            const user = await this.databaseService.getUserById(userRecord.id);
            // Get user stats
            const userStats = await this.databaseService.getStatsForUser(userRecord.id);

            // Construct UserAccount with proper typing
            const userAccount: UserAccount = {
                id: userRecord.id,
                type: userRecord.type as AuthType,
                telegramId: telegramId,  // Use the original telegramId
                telegramUsername: context.username || undefined,
                subscription_tier: userRecord.subscription_tier,
                token_quota: user.token_quota,
                token_usage: userRecord.token_usage || 0,  // Ensure number
                tokens_purchased: userRecord.tokens_purchased || 0,
                created_at: new Date(userRecord.created_at || Date.now()),
                last_active: new Date(userRecord.last_active || Date.now()),
                last_reset: new Date(userRecord.last_reset || Date.now()),
                metadata: {
                    auth_timestamp: Date.now(),
                    auth_type: AUTH_TYPES.TELEGRAM,
                    auth_data: {
                        id: telegramId,
                        username: context.username,
                        first_name: context.raw?.from?.first_name
                    },
                    source: 'telegram',
                    deviceInfo: context.raw?.from?.language_code ? {
                        language: context.raw.from.language_code
                    } : undefined
                },
                stats: {
                    id: userRecord.id,
                    subscription_tier: userRecord.subscription_tier,
                    token_quota: user.token_quota,
                    token_usage: userStats.token_usage || 0,
                    total_tokens: userStats.total_tokens || 0,
                    total_messages: userStats.total_messages || 0,
                    available_tokens: userStats.available_tokens || 0,
                    last_reset: new Date(userStats.last_reset || Date.now()),
                    next_reset_date: userStats.next_reset_date ? new Date(userStats.next_reset_date) : null,
                    last_active: new Date(userStats.last_active || Date.now()),
                    active_sessions: userStats.active_sessions || 0,
                    telegram_username: context.username || ''  // Required by UserStats interface
                }
            };

            // Initialize auth tokens
            await this.authService.authenticateTelegram({
                id: telegramId,
                username: context.username,
                // first_name: context.raw?.from?.first_name
            });

            logInfo(methodName, 'Telegram user initialized successfully', {
                userId: userAccount.id,
                telegramId: userAccount.telegramId
            });

            return userAccount;

        } catch (error) {
            console.error(`[${methodName}] Failed to initialize telegram user:`, {
                error,
                telegramId,
                username: context.username
            });
            throw error;
        }
    }

    private async handleConversationCommand(
        command: ConversationOperation,
        params: any,
        userId: string
    ): Promise<Partial<FormattedResponse>> {
        const methodName = 'handleConversationCommand';

        if (!command || !userId) {
            const error = new Error('Missing required parameters');
            logError(methodName, 'Invalid parameters:', error, { command, userId });
            return {
                error: 'Missing required parameters',
                metadata: {
                    errorDetails: {
                        code: 'INVALID_PARAMETERS',
                        message: 'Command and userId are required'
                    }
                }
            };
        }

        try {
            logInfo(methodName, 'Processing command:', {
                command,
                userId,
                hasParams: !!params
            });

            // If params is a SafeOptions object with a question field, try to decode it
            if (params && typeof params === 'object' && 'question' in params) {
                const decodedCommand = this.decodeCommand(params.question);
                if (decodedCommand) {
                    console.log(`[${methodName}] Decoded command from question:`, decodedCommand);
                    command = decodedCommand.command;
                    params = decodedCommand.params;
                }
            }

            // Validate and transform parameters
            if (params) {
                console.log(`[${methodName}] Original parameters:`, params);

                // Handle numeric parameters
                if ('limit' in params && typeof params.limit === 'string') {
                    params.limit = parseInt(params.limit, 10);
                }
                if ('offset' in params && typeof params.offset === 'string') {
                    params.offset = parseInt(params.offset, 10);
                }

                // Ensure tags is always an array
                if (command === 'conversation_save') {
                    if (!params.tags) {
                        params.tags = [];
                    } else if (!Array.isArray(params.tags)) {
                        params.tags = [params.tags].filter(Boolean);
                    }

                    // Validate messages array
                    if (!Array.isArray(params.messages)) {
                        throw new Error('Messages must be an array');
                    }
                }

                console.log(`[${methodName}] Parsed parameters:`, params);
            }

            if (!params) {
                throw new Error('No parameters provided for command');
            }

            // Validate command and parameters
            this.validateConversationCommand(command, params);

            // Check rate limits
            await this.checkRateLimit(userId, command);

            // Process command
            switch (command) {
                case 'conversation_list': {
                    const [conversations, total] = await Promise.all([
                        this.databaseService.getSavedConversations(
                            userId,
                            {
                                limit: params.limit,
                                offset: params.offset,
                                tag: params.tag,
                                favoritesOnly: params.favoritesOnly
                            }
                        ),
                        this.databaseService.getConversationCount(userId)
                    ]);

                    console.log(`[${methodName}] Retrieved conversations:`, conversations);

                    // Map conversations to include title
                    const conversationList = conversations.map(conv => {
                        const title = conv.title || 'Untitled Conversation';
                        console.log(`[${methodName}] Processing conversation:`, {
                            id: conv.id,
                            originalTitle: conv.title,
                            assignedTitle: title
                        });
                        return {
                            ...conv,
                            title
                        };
                    });

                    const hasTitle = conversationList.some(conv => conv.title && conv.title !== 'Untitled Conversation');
                    console.log(`[${methodName}] Processed conversations:`, {
                        total,
                        hasTitle,
                        conversationCount: conversationList.length
                    });

                    return {
                        metadata: {
                            conversations: {
                                list: conversationList,
                                total,
                                hasTitle
                            }
                        }
                    };
                }

                case 'conversation_save': {
                    let titleToSave = params.title?.trim();
                    const messagesToSave = params.messages; // Assuming messages are already parsed array here

                    // --- START: Title Generation Logic ---
                    if (!titleToSave && messagesToSave && messagesToSave.length > 0) {
                        logInfo(methodName, 'Title is empty, attempting generation...', { userId });
                        try {
                            // Prepare context for title generation (e.g., first user message + first bot response)
                            const firstUserMsg = messagesToSave.find((msg: ConversationMessage) => msg.role === 'user');
                            const firstBotMsg = messagesToSave.find((msg: ConversationMessage) => msg.role === 'assistant' || msg.role === 'bot'); // Allow 'bot' role too
                            let contextForTitle = '';
                            if (firstUserMsg) contextForTitle += `User: ${firstUserMsg.content.substring(0, 200)}\n`;
                            if (firstBotMsg) contextForTitle += `Assistant: ${firstBotMsg.content.substring(0, 200)}`;

                            if (contextForTitle && this.utilityModel) {
                                const titlePrompt = `Generate a very short, concise title (max 5 words) for the following conversation snippet:\n\n${contextForTitle}\n\nTitle:`;
                                const titleResponse = await this.utilityModel.invoke(titlePrompt);
                                const generatedTitle = messageContentToString(titleResponse.content).replace(/["']/g, '').trim(); // Clean up quotes

                                if (generatedTitle) {
                                    titleToSave = generatedTitle.substring(0, 100); // Limit title length
                                    logInfo(methodName, 'Generated title:', { userId, title: titleToSave });
                                } else {
                                    logWarn(methodName, 'LLM returned empty title, using default.', { userId });
                                    titleToSave = `Chat from ${new Date().toLocaleString()}`;
                                }
                            } else {
                                logWarn(methodName, 'Could not generate title context or utilityModel unavailable, using default.', { userId, hasContext: !!contextForTitle, hasModel: !!this.utilityModel });
                                titleToSave = `Chat from ${new Date().toLocaleString()}`;
                            }
                        } catch (genError) {
                            logError(methodName, 'Error generating title:', genError as Error, { userId });
                            titleToSave = `Chat from ${new Date().toLocaleString()}`; // Fallback on error
                        }
                    } else if (!titleToSave) {
                        // Handle case where title is empty AND there are no messages (shouldn't happen often)
                        logWarn(methodName, 'Title empty and no messages found, using default title.', { userId });
                        titleToSave = `Chat from ${new Date().toLocaleString()}`;
                    }
                    // --- END: Title Generation Logic ---

                    const conversationId = await this.databaseService.saveConversation(
                        userId,
                        titleToSave, // Use the potentially generated title
                        messagesToSave,
                        {
                            description: params.description,
                            tags: params.tags,
                            isFavorite: params.isFavorite
                        }
                    );
                    return {
                        metadata: {
                            conversations: {
                                current: {
                                    id: conversationId,
                                    status: 'saved'
                                }
                            }
                        }
                    };
                }

                case 'conversation_load': {
                    const messages = await this.databaseService.getConversationMessages(
                        params.conversationId,
                        userId
                    );
                    return {
                        metadata: {
                            conversations: {
                                current: {
                                    id: params.conversationId,
                                    messages
                                }
                            }
                        }
                    };
                }

                case 'conversation_update': {
                    if (!params.conversationId) {
                        throw new Error('Conversation ID is required for update');
                    }

                    // Parse and sanitize messages
                    let messages: ConversationMessage[] = [];
                    try {
                        // Log initial state
                        logInfo(methodName, 'Processing messages input:', {
                            type: typeof params.messages,
                            isArray: Array.isArray(params.messages),
                            isString: typeof params.messages === 'string'
                        });

                        // Handle messages based on type
                        let rawMessages: RawMessageInput[] = [];
                        if (params.messages) {
                            if (Array.isArray(params.messages)) {
                                rawMessages = params.messages;
                            } else if (typeof params.messages === 'string') {
                                // If it's a string, try to parse it directly
                                rawMessages = JSON.parse(params.messages);
                                if (!Array.isArray(rawMessages)) {
                                    throw new Error('Parsed messages must be an array');
                                }
                            } else {
                                throw new Error('Messages must be an array or valid JSON string');
                            }
                        }

                        // Get current time in Brisbane timezone
                        const now = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' });

                        // Process each message
                        messages = rawMessages.map((msg: RawMessageInput, index: number): ConversationMessage => {
                            // For new messages (those without timestamps), use current time
                            const isNewMessage = !msg.timestamp;

                            // Ensure we have the basic required fields
                            const processed: ConversationMessage = {
                                role: msg.role || 'user',
                                content: msg.content || msg.message || '',
                                timestamp: msg.timestamp || new Date().toISOString()
                            };

                            // Log each message processing
                            logInfo(methodName, `Processing message ${index}:`, {
                                originalRole: msg.role,
                                finalRole: processed.role,
                                contentLength: processed.content.length,
                                timestamp: processed.timestamp,
                                isNewMessage
                            });

                            return processed;
                        });

                        // Sort messages to ensure proper order
                        messages.sort((a, b) => {
                            const timeA = new Date(a.timestamp).getTime();
                            const timeB = new Date(b.timestamp).getTime();
                            return timeA - timeB;
                        });

                        // Log final message count and latest messages
                        const latestMessages = messages.slice(-2);
                        logInfo(methodName, 'Messages processed:', {
                            totalMessages: messages.length,
                            latestMessages: latestMessages.map(msg => ({
                                role: msg.role,
                                contentLength: msg.content.length,
                                timestamp: msg.timestamp
                            }))
                        });

                    } catch (error) {
                        logError(methodName, 'Failed to process messages:', error as Error, {
                            messageType: typeof params.messages,
                            isString: typeof params.messages === 'string',
                            isArray: Array.isArray(params.messages)
                        });
                        throw new Error(`Invalid message format: ${(error as Error).message}`);
                    }

                    // Single source of truth for update parameters
                    const updateOptions: Partial<SavedConversation> = {
                        title: params.title || undefined,
                        description: params.description || '',
                        tags: params.tags ? (Array.isArray(params.tags) ? params.tags : [params.tags]) : [],
                        isFavorite: params.isFavorite === 'true' ? true :
                            params.isFavorite === 'false' ? false :
                                params.isFavorite
                    };

                    // Log update operation
                    logInfo(methodName, 'Updating conversation:', {
                        conversationId: params.conversationId,
                        userId,
                        messageCount: messages.length,
                        ...updateOptions
                    });

                    // Perform update and get updated conversation
                    const updatedConversation = await this.databaseService.updateAndGetConversation(
                        params.conversationId,
                        userId,
                        messages,
                        updateOptions
                    );

                    // Log update verification
                    const updatedMessages = updatedConversation?.messages || [];
                    logInfo(methodName, 'Update verification:', {
                        conversationId: params.conversationId,
                        messageCount: updatedMessages.length,
                        latestMessages: updatedMessages.slice(-2).map(msg => ({
                            role: msg.role,
                            contentLength: msg.content.length,
                            timestamp: msg.timestamp
                        }))
                    });

                    const response: Partial<ConversationMetadata> = {
                        conversations: {
                            current: {
                                id: params.conversationId,
                                messages: updatedMessages
                            }
                        }
                    };

                    return {
                        metadata: response
                    };
                }

            }
        } catch (error) {
            // Enhanced error handling
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            const errorCode = error.name === 'RateLimitError' ? 'RATE_LIMIT_EXCEEDED' :
                              error.name === 'ValidationError' ? 'INVALID_PARAMETERS' :
                              'INTERNAL_ERROR';
            const userFriendlyMessage = errorCode === 'RATE_LIMIT_EXCEEDED' ? 'Rate limit exceeded for this action.' :
                                        errorCode === 'INVALID_PARAMETERS' ? 'Invalid parameters provided for the command.' :
                                        'An internal error occurred while processing the command.';

            const errorDetails = {
                code: errorCode,
                message: errorMessage, // Technical message
                userMessage: userFriendlyMessage, // User-friendly message
                operation: command,
                timestamp: new Date().toISOString(),
                userId,
                flowId: this.flowId
            };

            // Refined error response structure
            const errorResponse: Partial<FormattedResponse> = {
                error: errorMessage, // Simple error message for the main field
                metadata: {
                    errorDetails: {
                        ...errorDetails, // Include all details here
                        params: this.safeSerialize(params), // Add serialized params for debugging
                        // stackTrace: error instanceof Error ? error.stack : undefined // Optionally include stack trace here if needed for frontend debugging
                    },
                    method: 'handleConversationCommand',
                    message: 'Command processing failed' // General status message
                }
            };

            // Enhanced error logging
            const logDetails = {
                command,
                userId,
                flowId: this.flowId,
                params: this.safeSerialize(params),
                error: error instanceof Error ? {
                    name: error.name,
                    message: error.message,
                    stack: error.stack
                } : {
                    message: 'Unknown error',
                    rawError: error
                }
            };

            logError(methodName, 'Command processing failed:', error instanceof Error ? error : new Error('Unknown error'), logDetails);

            // Return structured error response
            return {
                ...errorResponse,
                metadata: {
                    ...errorResponse.metadata,
                    method: 'handleConversationCommand',
                    message: 'Command processing failed'
                }
            };
        }
    }


    private validateConversationCommand(command: string, params: any): void {
        const methodName = 'validateConversationCommand';

        switch (command) {
            case 'conversation_list':
                if (params.limit && (typeof params.limit !== 'number' || params.limit > 100)) {
                    throw new Error('Invalid limit parameter. Must be a number <= 100');
                }
                break;

            case 'conversation_save':
                // Removed title validation - Backend generates title if empty
                if (!Array.isArray(params.messages) || params.messages.length === 0) {
                    throw new Error('Messages array is required and must not be empty');
                }
                break;

            case 'conversation_load':
                if (!params.conversationId?.trim()) {
                    throw new Error('Conversation ID is required');
                }
                break;

            case 'conversation_update':
                if (!params.conversationId?.trim()) {
                    throw new Error('Conversation ID is required for update');
                }
                if (!params.messages) {
                    throw new Error('Messages are required for update');
                }
                break;

            default:
                throw new Error(`Unknown conversation command: ${command}`);
        }
    }

    // Add rate limiting
    private async checkRateLimit(userId: string, operation: ConversationOperation): Promise<void> {
        const methodName = 'checkRateLimit';

        const limits: RateLimits = {
            'conversation_save': { max: 10, window: 60 * 60 }, // 10 saves per hour
            'conversation_list': { max: 30, window: 60 }, // 30 lists per minute
            'conversation_load': { max: 60, window: 60 }, // 60 loads per minute
            'conversation_update': { max: 30, window: 60 } // 30 updates per minute
        };

        const limit = limits[operation];
        if (!limit) {
            throw new Error(`Unknown operation: ${operation}`);
        }

        const key = `rate_limit:${userId}:${operation}`;
        const currentCount = await this.databaseService.getRateLimit(key);

        if (currentCount > limit.max) {
            throw new Error(`Rate limit exceeded for ${operation}`);
        }
    }

    private async triggerCleanup(): Promise<void> {
        const methodName = 'triggerCleanup';
        try {
            // Only run cleanup during low-usage hours
            const hour = new Date().getHours();
            if (hour >= 2 && hour <= 4) { // Between 2 AM and 4 AM
                await this.cleanupOldConversations();
            }
        } catch (error) {
            logError(methodName, 'Error triggering cleanup:', error as Error);
        }
    }

    private async cleanupOldConversations(): Promise<void> {
        const methodName = 'cleanupOldConversations';
        const CLEANUP_AGE = 60 * 24 * 60 * 60 * 1000; // 60 days

        try {
            const deletedCount = await this.databaseService.deleteOldConversations(CLEANUP_AGE);
            logInfo(methodName, `Cleaned up old conversations`, { deletedCount });

            // Also cleanup rate limits older than 24 hours
            await this.databaseService.cleanupRateLimits(24 * 60 * 60 * 1000);
        } catch (error) {
            logError(methodName, 'Error cleaning up conversations:', error as Error);
        }
    }

    // Update destroy method
    public destroy(): void {
        for (const buffer of this.updateBuffer.values()) {
            if (buffer.processingTimer) {
                clearTimeout(buffer.processingTimer);
            }
        }
        this.updateBuffer.clear();
        // Remove interval cleanup
        // if (this.cleanupInterval) {
        //     clearInterval(this.cleanupInterval);
        //     this.cleanupInterval = null;
        // }
    }

    // Helper function to safely serialize objects
    private safeSerialize(obj: any): any {
        const seen = new WeakSet();
        return JSON.parse(JSON.stringify(obj, (key, value) => {
            if (key === 'logger' || key === 'appDataSource') {
                return '[Circular]';
            }
            if (typeof value === 'object' && value !== null) {
                if (seen.has(value)) {
                    return '[Circular]';
                }
                seen.add(value);
            }
            return value;
        }));
    }


    private isValidConversationOperation(command: string): command is ConversationOperation {
        const validOperations = [
            'conversation_list',
            'conversation_save',
            'conversation_load',
            'conversation_update'
        ] as const;

        console.log(`[TelegramBot] Validating conversation operation: ${command}`);
        const isValid = validOperations.includes(command as ConversationOperation);
        console.log(`[TelegramBot] Operation validation result: ${isValid}`);

        return validOperations.includes(command as ConversationOperation);
    }
    private createDefaultSafeOptions(
        input: string | SafeOptions,
        safeOptions: ICommonObject
    ): SafeOptions {
        if (typeof input === 'object' && input !== null) {
            // If input is already an object, preserve all properties
            return { ...input };
        }

        // If input is a string, create new SafeOptions
        return {
            question: typeof input === 'string' ? input : '',
            sessionId: `session_${safeOptions.chatflowid || 'default'}`,
            userId: '',
            chatId: safeOptions.chatId || `chat_${safeOptions.chatflowid || 'default'}`,
            source: 'flowise',
            chatType: 'private',
            messageId: Date.now(),
            // Include any command-related properties from options
            ...(safeOptions.command && { command: safeOptions.command }),
            ...(safeOptions.commandParams && { commandParams: safeOptions.commandParams })
        };
    }
    private decodeCommand(question: string | undefined): { command: ConversationOperation; params: any } | null {
        const methodName = 'decodeCommand';
        console.log(`[${methodName}] Attempting to decode:`, { question });

        if (!question || typeof question !== 'string') {
            console.log(`[${methodName}] Invalid input:`, { question });
            return null;
        }

        if (!question.startsWith('COMMAND:')) {
            console.log(`[${methodName}] Not a command string:`, { question });
            return null;
        }

        try {
            const [commandStr, ...paramParts] = question.slice('COMMAND:'.length).split('|');
            console.log(`[${methodName}] Split command parts:`, { commandStr, paramParts });

            // Validate command type
            if (!this.isValidConversationOperation(commandStr)) {
                console.log(`[${methodName}] Invalid command:`, { commandStr });
                throw new Error(`Invalid command: ${commandStr}`);
            }

            const params = paramParts.reduce((acc, param) => {
                const [key, value] = param.split('=');
                try {
                    if (key === 'messages') {
                        // Parse stringified message array
                        acc[key] = JSON.parse(value);
                    } else if (key === 'tags') {
                        // Convert tags string to array
                        acc[key] = value ? value.split(',').map(tag => tag.trim()) : [];
                    } else if (key === 'limit' || key === 'offset') {
                        // Parse numeric values
                        acc[key] = parseInt(value, 10);
                    } else {
                        acc[key] = value;
                    }
                } catch (parseError) {
                    console.warn(`[${methodName}] Error parsing parameter:`, { key, value, error: parseError });
                    acc[key] = value; // Keep original value on parse error
                }
                return acc;
            }, {} as Record<string, any>);

            console.log(`[${methodName}] Decoded command:`, { command: commandStr, params });

            return {
                command: commandStr as ConversationOperation,
                params
            };
        } catch (error) {
            logError(methodName, 'Failed to decode command:', error as Error);
            return null;
        }
    }

    public async checkForYouTubeUrl(input: string, adapter: ContextAdapter): Promise<boolean> {
        // Try multiple regex patterns to capture different YouTube URL formats
        // Standard video pattern including shorts
        const standardMatch = input.match(/(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:(?:watch\?v=)|(?:shorts\/)|(?:embed\/)|(?:v\/))|\S*?[?&]v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/i);

        // Live URL pattern
        const liveMatch = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/live\/)([a-zA-Z0-9_-]+)/i.exec(input);

        // Determine videoId from either pattern
        let videoId: string | null = null;

        if (standardMatch && standardMatch[1]) {
            videoId = standardMatch[1];
            console.log(`Detected standard YouTube video ID: ${videoId}`);
        } else if (liveMatch && liveMatch[1]) {
            videoId = liveMatch[1];
            console.log(`Detected YouTube live video ID: ${videoId}`);
        }

        if (!videoId) return false;

        try {
            // Show action menu for YouTube video with the original button layout
            await adapter.reply("🎬 I noticed a YouTube video link! Would you like me to retrieve data from this video?", {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: "📝 Get Transcript", callback_data: `yt_get:${videoId}:transcript` },
                            { text: "📊 Get Transcript w/ Timestamps", callback_data: `yt_get:${videoId}:timestamps` }
                        ],
                        [
                            { text: "ℹ️ Get Video Info", callback_data: `yt_get:${videoId}:metadata` },
                            { text: "💬 Get Comments", callback_data: `yt_get:${videoId}:comments` }
                        ]
                    ]
                }
            });

            return true; // URL was detected and handled
        } catch (error) {
            console.error("Error handling YouTube URL:", error);
            return false;
        }
    }

    // In TelegramBot_Agents.ts

    /**
     * Checks if a message contains a Rumble URL and offers extraction options
     */
    public async checkForRumbleUrl(input: string, adapter: ContextAdapter): Promise<boolean> {
        // Enhanced Rumble URL patterns
        const patterns = [
            // Standard URL format: v{alphanumeric}-title.html
            /(?:https?:\/\/)?(?:www\.)?rumble\.com\/v([a-zA-Z0-9]{5,})-[\w\.-]+\.html/i,

            // Embed URL format
            /(?:https?:\/\/)?(?:www\.)?rumble\.com\/embed\/([a-zA-Z0-9]{5,})/i,

            // Alternative format with full v-prefixed ID
            /(?:https?:\/\/)?(?:www\.)?rumble\.com\/(v[a-zA-Z0-9]{5,})-[\w\.-]+\.html/i,

            // Short URL format (if any)
            /(?:https?:\/\/)?(?:www\.)?rumble\.com\/([a-zA-Z0-9]{6,})\/?$/i
        ];

        let videoId: string | null = null;
        let fullMatch: string | null = null;

        // Try each pattern until we find a match
        for (const pattern of patterns) {
            const match = input.match(pattern);
            if (match) {
                // If we matched the pattern with full v-prefixed ID
                if (pattern.toString().includes('(v[a-zA-Z0-9]')) {
                    videoId = match[1]; // Use the complete v-prefixed ID
                } else {
                    // For other patterns, we might need to add the 'v' prefix if not present
                    videoId = match[1].startsWith('v') ? match[1] : `v${match[1]}`;
                }
                fullMatch = match[0];
                console.log(`Detected Rumble video ID: ${videoId} using pattern: ${pattern}`);
                break;
            }
        }

        // If we still don't have a match, try a more general approach for edge cases
        if (!videoId) {
            // Very permissive pattern to catch edge cases
            const lastResortMatch = input.match(/rumble\.com\/([a-zA-Z0-9]{1,2}[a-zA-Z0-9]{4,})/i);
            if (lastResortMatch) {
                videoId = lastResortMatch[1].startsWith('v') ? lastResortMatch[1] : `v${lastResortMatch[1]}`;
                fullMatch = lastResortMatch[0];
                console.log(`Detected Rumble video ID (last resort): ${videoId}`);
            }
        }

        if (!videoId) {
            console.log('No Rumble video ID detected in input');
            return false;
        }

        try {
            // Normalize videoId - some Rumble IDs include the 'v' prefix, some don't
            // For API usage, we want consistency
            const normalizedId = videoId.startsWith('v') ? videoId : `v${videoId}`;

            // Log the full context for debugging
            console.log(`Found Rumble URL: ${fullMatch}`);
            console.log(`Normalized video ID for API: ${normalizedId}`);

            // Show action menu for Rumble video
            await adapter.reply("🎬 I noticed a Rumble video link! Would you like me to retrieve data from this video?", {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: "📝 Get Transcript", callback_data: `rumble_get:${normalizedId}:transcript` },
                            { text: "ℹ️ Get Video Info", callback_data: `rumble_get:${normalizedId}:metadata` }
                        ],
                        [
                            { text: "⬇️ Download Video", callback_data: `rumble_get:${normalizedId}:download` }
                        ]
                    ]
                }
            });

            return true; // URL was detected and handled
        } catch (error) {
            console.error("Error handling Rumble URL:", error);
            return false;
        }
    }

    /**
     * Checks if a message contains any recognized media URL
     */
    private async checkForMediaUrl(input: string, adapter: ContextAdapter): Promise<boolean> {
        // Check for YouTube URLs
        if (await this.checkForYouTubeUrl(input, adapter)) {
            return true;
        }

        // Check for Rumble URLs
        if (await this.checkForRumbleUrl(input, adapter)) {
            return true;
        }

        // Add more media platforms here as needed

        return false; // No recognized media URLs found
    }

    private async checkYtDlpAvailability(): Promise<boolean> {
        try {
            const result = await execAsync('yt-dlp --version');
            console.log(`yt-dlp version: ${result.stdout.trim()}`);
            return true;
        } catch (error) {
            console.warn(`yt-dlp not found: ${error.message}`);
            return false;
        }
    }
    /**
 * Sends a document to a chat
 * @param chatId Unique identifier for the target chat
 * @param document Document to send (file path or InputFile object)
 * @param options Additional options for the document
 */

    private sanitizeMessageContent(content: string): string {
        if (!content) return '';

        try {
            const steps = [];
            let result = content;

            // Log initial state
            steps.push({
                step: 'initial',
                length: result.length,
                sample: result.substring(0, 50)
            });

            // Remove control characters
            result = result.replace(/[\u0000-\u0019]+/g, match =>
                match === '\n' ? '\n' : match === '\r' ? '\r' : match === '\t' ? '\t' : '');
            steps.push({
                step: 'remove_control',
                length: result.length,
                sample: result.substring(0, 50)
            });

            // Handle escaped characters
            result = result
                .replace(/\\n/g, '\n')
                .replace(/\\r/g, '\r')
                .replace(/\\t/g, '\t')
                .replace(/\\\\/g, '\\')
                .replace(/\\"/g, '"');

            steps.push({
                step: 'unescape',
                length: result.length,
                sample: result.substring(0, 50)
            });

            // Trim result
            result = result.trim();
            steps.push({
                step: 'trim',
                length: result.length,
                sample: result.substring(0, 50)
            });

            logInfo('sanitizeMessageContent', 'Content processing steps:', {
                steps,
                finalLength: result.length
            });

            return result;
        } catch (error) {
            logError('sanitizeMessageContent', 'Failed to sanitize content:', error as Error);
            return content.trim();
        }
    }
    /**
     * Generates follow-up question suggestions for the current response
     * @param adapter The context adapter
     * @param botId The current bot ID
     */
    public async generateFollowUpSuggestions(adapter: ContextAdapter, botId: number): Promise<void> {
        const methodName = 'generateFollowUpSuggestions';


        try {

            const context = adapter.getMessageContext();
            const { userId, sessionId } = await this.conversationManager!.getSessionInfo(context);
            const chatId = context.chatId.toString();
            await adapter.safeAnswerCallbackQuery('Generating follow-up questions...');

            // Get chat history for context
            const chatHistoryResult = await this.memory!.getChatMessagesExtended(userId, sessionId);
            const chatHistory = this.commandHandler.convertToChatHistory(chatHistoryResult);

            // Get latest response content - first check pattern data cache
            const patternData = this.conversationManager!.cache.get<PatternData>(`pattern_data:${userId}`);
            let relevantContext = '';

            // If we have latest_response in pattern data, use that
            if (patternData?.processedOutputs?.latest_response?.output) {
                relevantContext = patternData.processedOutputs.latest_response.output;
                console.log(`[${methodName}] Using latest_response from pattern data, length: ${relevantContext.length}`);
            }
            // Otherwise, try to get context from RAG cache
            else {
                const contextCacheKey = `relevant_context:${userId}`;
                const contextCacheEntry = this.conversationManager!.cache.get<{ relevantContext: string; timestamp: number }>(contextCacheKey);

                if (contextCacheEntry?.relevantContext) {
                    relevantContext = contextCacheEntry.relevantContext;
                    console.log(`[${methodName}] Using context from RAG cache, length: ${relevantContext.length}`);
                }
            }

            if (!relevantContext) {
                console.warn(`[${methodName}] No relevant context found for generating follow-up questions`);
                await adapter.reply("I don't have enough context to generate meaningful follow-up questions.");
                return;
            }

            // Generate follow-up questions
            const followUpQuestions = await this.conversationManager!.generateFollowUpQuestions(
                relevantContext,
                chatHistory,
                true // Enhanced mode with more questions
            );

            if (!followUpQuestions || followUpQuestions.length === 0) {
                await adapter.reply("I couldn't generate relevant follow-up questions based on our conversation.");
                return;
            }

            // Use the existing pagination system
            // Generate a unique ID for this question set
            const setId = `followup_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

            // Store the questions using the existing userQuestionSets structure
            const key = this.getChatKey(context);
            if (!this.userQuestionSets.has(key)) {
                this.userQuestionSets.set(key, new Map());
            }

            const questionSets = this.userQuestionSets.get(key)!;

            // Create question data structure
            const questionData: UserQuestionData = {
                questions: followUpQuestions,
                currentPage: 0,
                lastActionTime: Date.now(),
                setId,
                expirationTime: Date.now() + 30 * 60 * 1000, // 30 minutes expiration
                messageId: 0, // Will be set after sending
                chatId: typeof context.chatId === 'number' ? context.chatId : parseInt(context.chatId.toString())
            };

            // Store the question set
            questionSets.set(setId, questionData);

            // Send the paginated questions using the existing method
            await this.sendPaginatedQuestion(adapter, questionData, true);

            console.log(`[${methodName}] Generated and sent ${followUpQuestions.length} follow-up questions for user ${userId}`);
        } catch (error) {
            console.error(`[${methodName}] Error:`, error);
            await adapter.safeAnswerCallbackQuery('Error generating follow-up questions');
            await adapter.reply("Sorry, I encountered an error while generating follow-up questions.");
        }
    }

    /**
   * Handles showing source citations on demand
   * @param adapter The context adapter
   * @param botId The current bot ID
   */
    public async showSourceCitations(adapter: ContextAdapter, botId: number): Promise<void> {
        const methodName = 'showSourceCitations';

        try {
            const context = adapter.getMessageContext();
            const { userId, sessionId } = await this.conversationManager!.getSessionInfo(adapter);

            await adapter.safeAnswerCallbackQuery('Retrieving source citations...');

            // Try multiple strategies to find relevant context
            let relevantContext: string | undefined;
            let rawDocs: ScoredDocument[] | undefined;

            // First try to get raw docs
            const rawDocsCache = this.conversationManager!.cache.get<{
                documents: ScoredDocument[];
                timestamp: number;
            }>(`raw_docs:${this.conversationManager!.flowId}`);

            if (rawDocsCache?.documents && rawDocsCache.documents.length > 0) {
                console.log(`[${methodName}] Found ${rawDocsCache.documents.length} raw docs in cache`);
                rawDocs = rawDocsCache.documents;

                // Format these documents into the expected format for generateSourceCitations
                relevantContext = rawDocsCache.documents
                    .filter(doc => doc.score > 0)
                    .sort((a, b) => b.score - a.score)
                    .map(doc => {
                        return `[Relevance: ${doc.score.toFixed(3)}]\n${doc.content}\n--- Metadata: ${JSON.stringify(doc.metadata)}`;
                    })
                    .join("\n\n");
            } else {
                // Fall back to the standard context cache
                const contextCacheKey = `relevant_context:${userId}`;
                const contextCacheEntry = this.conversationManager!.cache.get<{ relevantContext: string; timestamp: number }>(contextCacheKey);

                if (contextCacheEntry?.relevantContext) {
                    console.log(`[${methodName}] Found relevant context in cache, length: ${contextCacheEntry.relevantContext.length}`);
                    relevantContext = contextCacheEntry.relevantContext;
                } else {
                    console.log(`[${methodName}] No relevant context or raw docs found in cache`);
                }
            }

            // If we don't have context, we can't generate citations
            if (!relevantContext) {
                console.warn(`[${methodName}] No relevant context found for generating citations`);
                await adapter.reply("I don't have source information to cite for this response.");
                return;
            }

            // Get the RAG agent to generate citations
            const ragAgent = this.agentManager!.getAgent('rag') as RAGAgent;
            if (!ragAgent) {
                console.warn(`[${methodName}] RAG agent not available`);
                await adapter.reply("Source citations are not available at this time.");
                return;
            }

            // Generate citations using the RAG agent's method
            let sourceCitations: SourceCitation[] = [];

            try {
                if (rawDocs && typeof (ragAgent as any).generateSourceCitationsFromDocs === 'function') {
                    // Use the raw docs directly if available and the agent supports it
                    console.log(`[${methodName}] Generating citations directly from ${rawDocs.length} raw docs`);
                    sourceCitations = await (ragAgent as any).generateSourceCitationsFromDocs(rawDocs);
                } else if (typeof (ragAgent as any).generateSourceCitations === 'function') {
                    // Otherwise use the formatted context
                    console.log(`[${methodName}] Generating citations from formatted context, length: ${relevantContext.length}`);
                    sourceCitations = await (ragAgent as any).generateSourceCitations(relevantContext);
                } else {
                    console.warn(`[${methodName}] No citation generation method available in RAG agent`);
                    await adapter.reply("Source citation generation is not available.");
                    return;
                }

                console.log(`[${methodName}] Generated ${sourceCitations.length} source citations`);
            } catch (error) {
                console.error(`[${methodName}] Error generating citations:`, error);
                await adapter.reply("I encountered an error while generating source citations.");
                return;
            }

            if (!sourceCitations || sourceCitations.length === 0) {
                await adapter.reply("I couldn't find any relevant source citations for this response.");
                return;
            }

            // Use the existing sendPaginatedCitations method to display citations
            await this.sendPaginatedCitations(adapter, sourceCitations);

            console.log(`[${methodName}] Successfully sent ${sourceCitations.length} paginated citations for user ${userId}`);
        } catch (error) {
            console.error(`[${methodName}] Error:`, error);
            await adapter.safeAnswerCallbackQuery('Error retrieving source citations');
            await adapter.reply("Sorry, I encountered an error while retrieving source citations.");
        }
    }
    /**
   * Stores a question for later processing when the user confirms they want an answer
   * @param userId The user ID
   * @param sessionId The session ID
   * @param messageId The message ID of the question
   * @param question The question text
   * @param analysis The question analysis result
   * @param source The source of the request (which method called this)
   */
    private storeQuestionForLater(
        userId: string,
        sessionId: string,
        messageId: number,
        question: string,
        analysis: QuestionAnalysisResult,
        source: 'handleMessage' | 'processMessage' = 'handleMessage'
    ): void {
        const methodName = 'storeQuestionForLater';

        if (!this.conversationManager) {
            logError(methodName, 'ConversationManager not available', '');
            return;
        }

        // Define the type for cached question data
        interface CachedQuestionData {
            userId: string;
            sessionId: string;
            question: string;
            analysis: QuestionAnalysisResult;
            timestamp: number;
            source?: string; // Make source optional
        }

        // Create a cache key
        const cacheKey = `pending_question:${messageId}`;

        // Store for 30 minutes
        const cacheData: CachedQuestionData = {
            userId,
            sessionId,
            question,
            analysis,
            timestamp: Date.now(),
            source
        };

        this.conversationManager.cache.set(cacheKey, cacheData, 30 * 60); // 30 minutes TTL

        // Also store in content-based cache for potential reuse
        const contentCacheKey = `question_analysis:${Buffer.from(question).toString('base64').substring(0, 40)}`;
        this.conversationManager.cache.set(contentCacheKey, {
            result: analysis,
            timestamp: Date.now()
        }, 5 * 60); // 5 minutes TTL

        logInfo(methodName, `Stored question for later processing`, {
            messageId,
            question: question.substring(0, 50) + (question.length > 50 ? '...' : ''),
            requiresRag: analysis.requiresRagMode,
            source
        });
    }


    /**
 * Records a message sent by the bot
 * @param chatId The chat where the message was sent
 * @param messageId The ID of the message
 */
    private recordBotMessage(chatId: string | number, messageId: number): void {
        const chatKey = chatId.toString();

        if (!this.botMessageRegistry.has(chatKey)) {
            this.botMessageRegistry.set(chatKey, new Set());
        }

        const chatMessages = this.botMessageRegistry.get(chatKey)!;
        chatMessages.add(messageId);

        // Limit the size of the set to prevent memory issues
        if (chatMessages.size > this.MESSAGE_HISTORY_LIMIT) {
            // Remove oldest entries - since Sets don't track order, we'll just take a portion
            const messagesToKeep = Array.from(chatMessages).slice(-Math.floor(this.MESSAGE_HISTORY_LIMIT * 0.8));
            this.botMessageRegistry.set(chatKey, new Set(messagesToKeep));
        }

        logDebug('recordBotMessage', `Recorded bot message ${messageId} in chat ${chatKey}`);
    }

    /**
     * Checks if a message was sent by this bot
     * @param chatId The chat to check
     * @param messageId The message ID to check
     * @returns True if the message was sent by this bot
     */
    private isBotMessage(chatId: string | number, messageId: number): boolean {
        const chatKey = chatId.toString();
        const chatMessages = this.botMessageRegistry.get(chatKey);

        if (!chatMessages) {
            return false;
        }

        return chatMessages.has(messageId);
    }

    /**
  * Initializes the bot message registry from conversation history
  */
    private async initializeMessageRegistry(): Promise<void> {
        const methodName = 'initializeMessageRegistry';
        logInfo(methodName, 'Initializing bot message registry');

        try {
            // Attempt to restore from memory if available
            if (this.memory && typeof this.memory.getChatMessagesExtended === 'function' && this.databaseService) {
                // Get active sessions
                const activeSessions = await this.databaseService.getActiveSessions(100);

                for (const session of activeSessions) {
                    try {
                        const userId = session.userId;
                        const sessionId = session.id;
                        const chatId = session.chat_id;

                        if (!userId || !sessionId || !chatId) continue;

                        // Get chat messages
                        const messages = await this.memory.getChatMessagesExtended(userId, sessionId);

                        // Find bot messages - need to handle both types
                        const botMessages = messages.filter(msg => {
                            // For ExtendedIMessage
                            if ('type' in msg && msg.type === 'apiMessage') {
                                return true;
                            }
                            // For BaseMessage
                            if ('_getType' in msg && typeof msg.getType === 'function') {
                                return msg.getType() === 'ai';
                            }
                            return false;
                        });

                        // Record message IDs
                        for (const msg of botMessages) {
                            // Fix the type checking for messageId
                            if ('additional_kwargs' in msg && msg.additional_kwargs?.message_id) {
                                const messageIdValue = msg.additional_kwargs.message_id;
                                // Ensure messageId is a number
                                if (typeof messageIdValue === 'number') {
                                    this.recordBotMessage(chatId, messageIdValue);
                                } else if (typeof messageIdValue === 'string') {
                                    const parsedId = parseInt(messageIdValue, 10);
                                    if (!isNaN(parsedId)) {
                                        this.recordBotMessage(chatId, parsedId);
                                    }
                                }
                            }
                        }

                        logInfo(methodName, `Initialized ${botMessages.length} bot messages for chat ${chatId}`);
                    } catch (error) {
                        logError(methodName, `Error initializing message registry for session ${session.id}`, error as Error);
                        // Continue with next session
                    }
                }
            }
        } catch (error) {
            logError(methodName, 'Error initializing message registry', error as Error);
        }
    }
    // Add to TelegramBot_Agents.ts

    /**
 * Schedules periodic cleanup tasks
 */
    private setupCleanupTasks(): void {
        // Every 10 minutes, clean up expired conversations
        setInterval(() => {
            // Add a null check before accessing questionAnalyzer
            if (this.questionAnalyzer) {
                try {
                    this.questionAnalyzer.cleanupExpiredConversations();
                    console.log(`[FlowID: ${this.flowId}] Cleaned up expired conversations`);
                } catch (error) {
                    console.error(`[FlowID: ${this.flowId}] Error cleaning up conversations:`, error);
                }
            } else {
                // Log that questionAnalyzer is not available yet
                console.log(`[FlowID: ${this.flowId}] Skipping conversation cleanup - questionAnalyzer not initialized`);
            }

            // Clean up message registry to prevent memory leaks
            try {
                // Also check if this method exists before calling it
                if (typeof this.cleanupMessageRegistry === 'function') {
                    this.cleanupMessageRegistry();
                    console.log(`[FlowID: ${this.flowId}] Cleaned up message registry`);
                }
            } catch (error) {
                console.error(`[FlowID: ${this.flowId}] Error cleaning up message registry:`, error);
            }
        }, 10 * 60 * 1000); // 10 minutes
    }

    /**
     * Cleans up old message registry entries
     */
    private cleanupMessageRegistry(): void {
        // Keep only last 100 messages per chat, or messages from last 24 hours
        const now = Date.now();
        const MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours

        for (const [chatId, messageIds] of this.botMessageRegistry.entries()) {
            if (messageIds.size > 100) {
                const messagesToKeep = Array.from(messageIds).slice(-100);
                this.botMessageRegistry.set(chatId, new Set(messagesToKeep));
            }
        }
    }
    // In TelegramBot_Agents.ts:
    public configureRagMode(options: { inactivityTimeout?: number }): void {
        const ragAgent = this.agentManager.getAgent('rag') as RAGAgent;
        if (!ragAgent) {
            console.warn('RAG Agent not available for configuration');
            return;
        }

        if (options.inactivityTimeout) {
            ragAgent.setInactivityTimeout(options.inactivityTimeout);
        }
    }

    // Add this method to TelegramBot_Agents class

    /**
     * Suggests a conversation summary when appropriate
     * Called periodically during user interactions
     */
    private async checkAndSuggestSummary(adapter: ContextAdapter): Promise<void> {
        const methodName = 'checkAndSuggestSummary';
        const context = adapter.getMessageContext();
        const chatId = context.chatId.toString();

        // Only applies to group chats
        if (context.raw?.chat?.type !== 'group' && context.raw?.chat?.type !== 'supergroup') {
            return;
        }

        // Get the QuestionAnalyzer
        if (!this.questionAnalyzer) {
            return;
        }

        try {
            // Get chat history
            const chatHistory = await this.getChatHistory(adapter);

            // Check if summary should be suggested
            if (this.questionAnalyzer.shouldSuggestSummary(chatId, chatHistory.length)) {
                logInfo(methodName, 'Suggesting conversation summary', {
                    chatId,
                    messageCount: chatHistory.length
                });

                // Create an inline keyboard with summary options
                const keyboard = Markup.inlineKeyboard([
                    [
                        Markup.button.callback('✅ Generate Summary', `summary_generate:${chatId}`),
                        Markup.button.callback('❌ No Thanks', `summary_cancel:${chatId}`)
                    ]
                ]);

                // Send the suggestion
                await adapter.reply(
                    "I've noticed this conversation has been going for a while. Would you like me to generate a summary of the key points discussed?",
                    { reply_markup: keyboard.reply_markup }
                );

                // Store summary suggestion state to avoid repeated offers
                this.conversationManager!.cache.set(`summary_suggested:${chatId}`, Date.now(), 3600); // Don't suggest again for 1 hour
            }
        }
        catch (error) {
            logError(methodName, 'Error checking for summary suggestion', error as Error);
        }
    }

    /**
 * Handles the generation of a conversation summary
 */
    private async handleSummaryGeneration(adapter: ContextAdapter, chatId: string): Promise<void> {
        const methodName = 'handleSummaryGeneration';

        try {
            // Update message to show progress
            await adapter.editMessageText('🔄 Analyzing conversation and generating summary...');

            // Get chat history
            const chatHistory = await this.getChatHistory(adapter);

            if (!this.questionAnalyzer) {
                await adapter.editMessageText('Summary generation is currently unavailable.');
                return;
            }

            // Generate the summary
            const summary = await this.questionAnalyzer.generateGroupChatSummary(
                chatId,
                chatHistory,
                true // Force new summary
            );

            if (!summary) {
                await adapter.editMessageText("I'm sorry, but I couldn't generate a summary at this time. Please try again later.");
                return;
            }

            // Format the summary with some structure and styling
            const formattedSummary = `📝 **Conversation Summary**\n\n${summary}\n\n_Summary generated at ${new Date().toLocaleString()}_`;

            // Send the formatted summary as a new message for better visibility
            await adapter.reply(formattedSummary, { parse_mode: 'Markdown' });

            // Update original message
            await adapter.editMessageText('Summary generated and displayed below. ✅');

            // Clean up after a short delay
            setTimeout(async () => {
                try {
                    await adapter.deleteMessage();
                } catch (error) {
                    // Ignore deletion errors
                }
            }, 5000);

            logInfo(methodName, 'Generated and sent conversation summary', {
                chatId,
                messageCount: chatHistory.length,
                summaryLength: summary.length
            });
        }
        catch (error) {
            logError(methodName, 'Error generating conversation summary', error as Error);
            await adapter.editMessageText("I encountered an error while generating the summary. Please try again later.");
        }
    }

    /**
 * Detects media type and offers appropriate processing options
 */
    private async detectAndOfferProcessing(
        adapter: ContextAdapter,
        mediaType: 'audio' | 'video'
    ): Promise<void> {
        try {
            const message = adapter.context.raw.message as any;

            // Extract file details based on media type
            let fileId: string | undefined;
            let fileSize: number = 0;
            let duration: number = 0;
            let fileName: string = '';

            if (mediaType === 'audio') {
                fileId = message?.audio?.file_id || message?.voice?.file_id;
                fileSize = message?.audio?.file_size || message?.voice?.file_size || 0;
                duration = message?.audio?.duration || message?.voice?.duration || 0;
                fileName = message?.audio?.title || message?.audio?.file_name || `voice_${Date.now()}`;
            } else { // video
                fileId = message?.video?.file_id || message?.video_note?.file_id;
                fileSize = message?.video?.file_size || message?.video_note?.file_size || 0;
                duration = message?.video?.duration || message?.video_note?.duration || 0;
                fileName = message?.video?.file_name || `video_${Date.now()}`;
            }

            if (!fileId) {
                return; // Skip if no file ID was found
            }

            // Create processing options menu
            const keyboard = Markup.inlineKeyboard([
                [
                    Markup.button.callback('📝 Transcribe Audio', `media_transcribe:${fileId}:${mediaType}`),
                ],
                [
                    Markup.button.callback('❌ Ignore', `media_ignore:${fileId}`)
                ]
            ]);

            // Add file information to message
            const fileSizeMB = fileSize > 0 ? (fileSize / (1024 * 1024)).toFixed(2) + ' MB' : 'Unknown size';
            const durationText = duration > 0 ? this.formatDuration(duration) : 'Unknown duration';

            await adapter.reply(
                `📂 Detected ${mediaType} file: ${fileName}\n` +
                `Size: ${fileSizeMB}, Duration: ${durationText}\n\n` +
                `Would you like to process this file?`,
                { reply_markup: keyboard.reply_markup }
            );
        } catch (error) {
            console.error(`Error offering ${mediaType} processing:`, error);
        }
    }

    /**
     * Handles document files, checking for supported media types
     */
    private async detectAndOfferDocumentProcessing(adapter: ContextAdapter): Promise<void> {
        try {
            const message = adapter.context.raw.message as any;

            // Check if this is a media file we can process
            const document = message?.document;
            if (!document || !document.file_id) {
                return; // Not a document or missing file_id
            }

            const mimeType = document.mime_type || '';
            const fileName = document.file_name || `file_${Date.now()}`;
            const fileSize = document.file_size || 0;

            // Detect file type based on mime type or extension
            const isAudio = mimeType.startsWith('audio/') ||
                /\.(mp3|wav|ogg|m4a|flac)$/i.test(fileName);

            const isVideo = mimeType.startsWith('video/') ||
                /\.(mp4|mov|avi|mkv|webm)$/i.test(fileName);

            // Skip if not audio or video
            if (!isAudio && !isVideo) {
                console.log(`Skipping document with mime type: ${mimeType}, filename: ${fileName}`);
                return;
            }

            // Create processing options menu
            const fileType = isAudio ? 'audio' : 'video';
            const keyboard = Markup.inlineKeyboard([
                [
                    Markup.button.callback('📝 Transcribe Audio', `media_transcribe:${document.file_id}:${fileType}`),
                ],
                [
                    Markup.button.callback('❌ Ignore', `media_ignore:${document.file_id}`)
                ]
            ]);

            // Add file information to message
            const fileSizeMB = fileSize > 0 ? (fileSize / (1024 * 1024)).toFixed(2) + ' MB' : 'Unknown size';

            await adapter.reply(
                `📂 Detected ${fileType} file: ${fileName}\n` +
                `Size: ${fileSizeMB}\n\n` +
                `Would you like to process this file?`,
                { reply_markup: keyboard.reply_markup }
            );
        } catch (error) {
            console.error('Error offering document processing:', error);
        }
    }

    /**
  * Handles media transcription request
  */
    private async handleMediaTranscription(
        adapter: ContextAdapter,
        cacheKey: string,
        mediaType: string
    ): Promise<void> {
        const methodName = 'handleMediaTranscription';
        let statusMessageId: number | undefined; // Declare here for wider scope

        // --- Initial Checks ---
        if (!this.conversationManager) {
            logError(methodName, 'ConversationManager is not initialized', new Error('ConversationManager is null'));
            await adapter.reply("I'm sorry, but I'm not ready to process Media yet.");
            return;
        }
        if (!this.fileManager) {
            logError(methodName, 'FileManager is not initialized', new Error('FileManager is null'));
            // Check if it's a callback to answer appropriately
            if (adapter.context.callbackQuery) {
                await adapter.answerCallbackQuery('⚠️ Error: File processing system is not ready.');
            }
            await adapter.reply('⚠️ Error: File processing system is not ready.');
            return;
        }

        // --- Main Processing ---
        try {
            // Answer the callback query first if applicable
            if (adapter.context.callbackQuery) {
                await adapter.answerCallbackQuery('Preparing to transcribe...');
            }
            // Retrieve the file ID from the cache
            const fileId = this.conversationManager.cache.get<string>(cacheKey);

            if (!fileId) {
                console.error('File ID not found in cache for key:', cacheKey);
                await adapter.reply('⚠️ Unable to process: the media reference has expired. Please send the media again.');
                return;
            }

            // Update the message if we're responding to a callback query
            // statusMessageId is now declared in the outer scope
            if (adapter.context.callbackQuery && 'message' in adapter.context.callbackQuery
                && adapter.context.callbackQuery.message) {
                statusMessageId = adapter.context.callbackQuery.message.message_id;
                await adapter.editMessageText('⏳ Downloading file for transcription...', statusMessageId);
            }

            try {
                // Try to get file link
                const fileLink = await adapter.context.raw.telegram.getFileLink(fileId);
                logInfo(methodName, `Got file link for fileId: ${fileId}`); // Log fileId for context

                // FileManager is checked earlier, no need to check again here

                // Download the file to a temporary location
                await adapter.editMessageText('⏳ Downloading file...', statusMessageId);
                // Generate a temporary filename using fileId
                const tempFilename = `telegram_media_${fileId}_${Date.now()}`;
                const tempFilePath = await this.fileManager.downloadFile(fileLink.href, tempFilename); // Provide filename

                if (typeof tempFilePath === 'string' && tempFilePath) {
                    logInfo(methodName, `File downloaded to temporary path: ${tempFilePath}`);
                    // Call the method to handle the actual transcription
                    await this.processMediaTranscription(adapter, tempFilePath, statusMessageId);
                    // Note: processMediaTranscription handles further status updates,
                    // transcription, result storage, and cleanup of the temp file.
                } else {
                    logError(methodName, 'Failed to download file or get temporary path', new Error('downloadFile returned invalid path'));
                    await adapter.editMessageText('⚠️ Error: Failed to download the file for processing.', statusMessageId);
                    // Clean up the cache entry as we can't proceed
                    this.conversationManager.cache.del(cacheKey);
                    return;
                }
            } catch (error) {
                // Check if this is a "file too big" error
                if (error.description && error.description.includes("file is too big")) {
                    console.log("File is too large for Telegram's getFile API (> 20MB)");

                    // Update status message
                    if (statusMessageId) {
                        await adapter.editMessageText(
                            "⚠️ This file is too large for direct transcription through Telegram (>20MB).\n\n" +
                            "For larger files, please:\n" +
                            "1. Download the file to your device\n" +
                            "2. Upload to a transcription service like AssemblyAI or Whisper\n" +
                            "3. Or use our web interface which supports larger files",
                            statusMessageId
                        );
                    } else {
                        await adapter.reply(
                            "⚠️ This file is too large for direct transcription through Telegram (>20MB).\n\n" +
                            "For larger files, please use our web interface which supports larger files, or a dedicated transcription service."
                        );
                    }

                    // Clean up the cache entry
                    this.conversationManager.cache.del(cacheKey);
                    return;
                }

                // If it's a different error, rethrow it
                throw error;
            }

        } catch (error: any) {
            logError(methodName, `Error handling media transcription for cacheKey: ${cacheKey}`, error);

            // Try to answer callback query if it exists
            if (adapter.context.callbackQuery) {
                try {
                    await adapter.answerCallbackQuery('An error occurred. Please try again.');
                } catch (answerError) {
                    logError(methodName, 'Failed to answer callback query on error', answerError);
                }
            }

            // Send a generic error message to the chat
            // Use editMessageText if possible, otherwise reply
            const genericErrorMessage = '⚠️ An error occurred while processing the media. Please try again later.';
            if (statusMessageId) {
                try {
                    await adapter.editMessageText(genericErrorMessage, statusMessageId);
                } catch (editError) {
                    logError(methodName, `Failed to edit message on final error for cacheKey: ${cacheKey}`, editError);
                    await adapter.reply(genericErrorMessage); // Fallback reply
                }
            } else {
                await adapter.reply(genericErrorMessage);
            }

            // Clean up the cache entry as processing failed
            if (this.conversationManager) { // Ensure manager exists before accessing cache
                this.conversationManager.cache.del(cacheKey);
                logInfo(methodName, `Cache key ${cacheKey} deleted due to error in final catch block.`);
            }
        }
    }
    /**
     * Process media transcription with status updates
     */
    private async processMediaTranscription(
        adapter: ContextAdapter,
        filePath: string,
        statusMessageId?: number
    ): Promise<void> {
        const methodName = 'processMediaTranscription';
        if (!this.conversationManager) {
            logError(methodName, 'ConversationManager is not initialized', new Error('ConversationManager is null'));
            await adapter.reply("I'm sorry, but I'm not ready to process Media yet.");
            return;
        }
        try {
            // If we don't have a status message ID yet, create one
            if (!statusMessageId) {
                const statusMsg = await adapter.reply("⏳ Starting transcription process...");
                if (statusMsg && 'message_id' in statusMsg) {
                    statusMessageId = statusMsg.message_id;
                }
            } else {
                // Update existing message
                await adapter.editMessageText("⏳ Starting transcription process...", statusMessageId);
            }

            // Get user's transcription settings
            const { userId } = await this.conversationManager.getSessionInfo(adapter);
            const settings = TranscriptionSettingsUtil.getUserSettings(userId, this.conversationManager);

            // Create a status update function
            const updateStatus = async (status: string) => {
                if (statusMessageId) {
                    try {
                        await adapter.editMessageText(status, statusMessageId);
                    } catch (error) {
                        console.warn('Error updating status message:', error);
                    }
                }
            };

            // Create TranscriptionService instance
            const transcriptionService = new TranscriptionService({
                defaultProvider: settings.provider,
                apiKeys: {
                    'assemblyai': process.env.ASSEMBLYAI_API_KEY || '',
                    'google': process.env.GOOGLE_API_KEY || ''
                }
            });

            // Use the service to transcribe the file
            const transcriptionResult = await transcriptionService.transcribeMediaFile(
                filePath,
                {
                    provider: settings.provider,
                    modelSize: settings.modelSize,
                    language: settings.language
                },
                updateStatus
            );

            // Update status with success
            await updateStatus("✅ Transcription completed!");

            // Store the transcription result and display to the user
            await this.storeTranscriptionResult(adapter, userId, transcriptionResult, filePath);
        } catch (error) {
            console.error('Error in processMediaTranscription:', error);

            if (statusMessageId) {
                await adapter.editMessageText(
                    `❌ Transcription failed: ${error.message}`,
                    statusMessageId
                );
            } else {
                await adapter.reply(`❌ Transcription failed: ${error.message}`);
            }
        } finally {
            // Schedule cleanup of the original file
            setTimeout(() => {
                try {
                    if (fs.existsSync(filePath)) {
                        fs.unlinkSync(filePath);
                        console.log(`Cleaned up temporary file: ${filePath}`);
                    }
                } catch (error) {
                    console.warn(`Error cleaning up file ${filePath}:`, error);
                }
            }, 3600000); // 1 hour
        }
    }

    /**
     * Store and process transcription result
     */
    private async storeTranscriptionResult(
        adapter: ContextAdapter,
        userId: string,
        transcriptionResult: string,
        filePath: string
    ): Promise<void> {
        const methodName = 'storeTranscriptionResult';
        if (!this.conversationManager) {
            logError(methodName, 'ConversationManager is not initialized', new Error('ConversationManager is null'));
            await adapter.reply("I'm sorry, but I'm not ready to process Media yet.");
            return;
        }
        const fileId = path.basename(filePath, path.extname(filePath));

        // Create pattern suggestion for processing
        const patternSuggestion = {
            pattern: 'summarize',
            description: 'Create a concise summary of the transcribed content',
            confidence: 0.9,
            alternativePatterns: [
                'extract_insights',
                'create_qa_pairs',
                'organize_notes'
            ]
        };

        // Store in pattern context
        const contextData = {
            input: transcriptionResult,
            interactionType: 'general_input' as InteractionType,
            contextRequirement: 'chat' as ContextRequirement,
            timestamp: Date.now(),
            currentPatternState: '',
            metadata: {
                source: 'uploaded_media',
                fileId: fileId,
                suggestion: patternSuggestion
            }
        };

        this.conversationManager.cache.set(`pattern_context:${userId}`, contextData, 14400);

        // Update pattern data
        let patternData = this.conversationManager.cache.get<PatternData>(`pattern_data:${userId}`);
        if (!patternData) {
            patternData = {
                originalInput: transcriptionResult,
                processedOutputs: {},
                currentPatternState: {}
            };
        } else {
            patternData.originalInput = transcriptionResult;
        }

        patternData.sourceInfo = {
            type: 'uploaded_media',
            title: `Transcription of ${path.basename(filePath)}`,
            url: '',
            metadata: {
                fileId,
                fileType: path.extname(filePath),
                transcriptionTime: new Date().toISOString()
            }
        };

        this.conversationManager.cache.set(`pattern_data:${userId}`, patternData, 14400);

        // Send a preview
        const preview = transcriptionResult.substring(0, 500) + (transcriptionResult.length > 500 ? '...' : '');
        await adapter.reply(`📝 Transcription preview:\n\n${preview}`);

        // For longer transcriptions, use FileManager to save and send as a file
        if (transcriptionResult.length > 2000) {
            await this.fileManager.saveAndSendAsText(
                adapter,
                transcriptionResult,
                `transcription_${fileId}`
            );
        }

        // Show pattern menu
        if (this.commandHandler && this.menuManager) {
            const keyboard = this.menuManager.createPatternSelectionMenu(
                patternSuggestion,
                patternSuggestion.alternativePatterns
            ).reply_markup;

            await adapter.reply(
                `What would you like to do with this transcription?`,
                {
                    parse_mode: 'HTML',
                    reply_markup: keyboard
                }
            );
        }
    }
    /**
     * Handles detected media files and offers processing options
     */
    /**
 /**
 * Handles detected media files and offers processing options
 */
    private async handleMediaDetection(adapter: ContextAdapter, message: any): Promise<void> {
        const methodName = 'handleMediaDetection';
        if (!this.conversationManager) {
            logError(methodName, 'ConversationManager is not initialized', new Error('ConversationManager is null'));
            await adapter.reply("I'm sorry, but I'm not ready to process Media yet.");
            return;
        }
        try {
            // Determine media type and get file ID
            let mediaType: 'audio' | 'video' | 'document' = 'document';
            let fileId: string | undefined;

            if (message.video || message.video_note) {
                mediaType = 'video';
                fileId = message.video?.file_id || message.video_note?.file_id;
            } else if (message.audio || message.voice) {
                mediaType = 'audio';
                fileId = message.audio?.file_id || message.voice?.file_id;
            } else if (message.document) {
                fileId = message.document.file_id;
                // Try to determine if it's audio or video based on mime type
                const mimeType = message.document.mime_type || '';
                if (mimeType.startsWith('audio/')) {
                    mediaType = 'audio';
                } else if (mimeType.startsWith('video/')) {
                    mediaType = 'video';
                }
            }

            if (!fileId) {
                console.log('No file ID found in media message');
                return;
            }

            // Get some basic info about the media
            let duration = 0;
            let fileSize = 0;
            let fileName = '';

            if (mediaType === 'video') {
                duration = message.video?.duration || message.video_note?.duration || 0;
                fileSize = message.video?.file_size || message.video_note?.file_size || 0;
                fileName = message.video?.file_name || `video_${Date.now()}`;
            } else if (mediaType === 'audio') {
                duration = message.audio?.duration || message.voice?.duration || 0;
                fileSize = message.audio?.file_size || message.voice?.file_size || 0;
                fileName = message.audio?.title || message.audio?.file_name || `audio_${Date.now()}`;
            } else if (mediaType === 'document') {
                fileSize = message.document.file_size || 0;
                fileName = message.document.file_name || `file_${Date.now()}`;
            }

            // Check if file is too large for Telegram's getFile API (>20MB)
            const fileSizeMB = fileSize > 0 ? fileSize / (1024 * 1024) : 0;
            const isFileTooLarge = fileSizeMB > 19.5; // Set threshold slightly under 20MB to be safe

            // Format size and duration for display
            const fileSizeDisplay = fileSizeMB > 0 ? fileSizeMB.toFixed(2) + ' MB' : 'Unknown size';
            const durationText = duration > 0 ? this.formatDuration(duration) : 'Unknown duration';

            // Check if this is a forwarded message
            let sourceInfo = '';
            if (message.forward_from_chat) {
                const chatTitle = message.forward_from_chat.title || message.forward_from_chat.username || 'an external chat';
                sourceInfo = `\nForwarded from: ${chatTitle}`;
            } else if (message.forward_from) {
                const fromName = message.forward_from.first_name || message.forward_from.username || 'someone';
                sourceInfo = `\nForwarded from: ${fromName}`;
            }

            if (isFileTooLarge) {
                // For large files, just notify the user about the size limitation
                await adapter.reply(
                    `📂 Detected ${mediaType} file: ${fileName}\n` +
                    `Size: ${fileSizeDisplay}${mediaType !== 'document' ? `, Duration: ${durationText}` : ''}${sourceInfo}\n\n` +
                    `⚠️ This file is too large for direct transcription through Telegram (>20MB).\n\n` +
                    `For larger files, please use our web interface which supports larger files, or a dedicated transcription service.`
                );
                return;
            }

            // For smaller files, proceed with offering transcription
            // Store the file ID in memory cache for 10 minutes
            const cacheKey = `fileId_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
            this.conversationManager.cache.set(cacheKey, fileId, 600); // 10 minutes TTL

            // Create keyboard with the cache key
            const keyboard = Markup.inlineKeyboard([
                [
                    Markup.button.callback('📝 Transcribe Audio', `media_transcribe:${cacheKey}:${mediaType}`),
                ],
                [
                    Markup.button.callback('❌ Ignore', `media_ignore:${cacheKey}`)
                ]
            ]);

            // Send the offer
            await adapter.reply(
                `📂 Detected ${mediaType} file: ${fileName}\n` +
                `Size: ${fileSizeDisplay}${mediaType !== 'document' ? `, Duration: ${durationText}` : ''}${sourceInfo}\n\n` +
                `Would you like me to transcribe the audio from this ${mediaType}?`,
                { reply_markup: keyboard.reply_markup }
            );
        } catch (error) {
            console.error('Error handling media detection:', error);
        }
    }
    /**
     * Format seconds into readable duration
     */
    private formatDuration(seconds: number): string {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);

        if (hours > 0) {
            return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        } else {
            return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        }
    }

    /**
     * Check if required dependencies for transcription are available
     */
    private async checkTranscriptionRequirements(): Promise<boolean> {
        try {
            // Check for FFmpeg
            await execAsync('ffmpeg -version');
            console.log('FFmpeg is available for audio extraction');
            return true;
        } catch (error) {
            console.warn('FFmpeg is not available, media transcription will be disabled');
            return false;
        }
    }

    /**
 * Checks if the message contains media files that can be processed
 */
    private messageContainsMedia(context: MessageContext): boolean {
        const message = context.raw?.message as any;

        if (!message) return false;

        // Check for different media types
        return !!(
            message.video ||
            message.video_note ||
            message.audio ||
            message.voice ||
            (message.document &&
                message.document.mime_type &&
                (message.document.mime_type.startsWith('audio/') ||
                    message.document.mime_type.startsWith('video/')))
        );
    }

}

class SimpleInMemoryRetriever extends BaseRetriever {
    private documents: Document[];
    lc_namespace: string[] = ["langchain", "retrievers", "simple_memory"];

    constructor() {
        super();
        this.documents = [
            new Document({ pageContent: "Flowise is a drag & drop tool to build LLM apps", metadata: { source: "Flowise docs" } }),
            new Document({ pageContent: "LangChain is a framework for developing applications powered by language models", metadata: { source: "LangChain docs" } }),
            new Document({ pageContent: "Telegram is a cloud-based instant messaging service", metadata: { source: "Telegram website" } }),
        ];
    }

    async getRelevantDocuments(query: string): Promise<Document[]> {
        return this.documents.filter(doc =>
            doc.pageContent.toLowerCase().includes(query.toLowerCase())
        );
    }

}

module.exports = { nodeClass: TelegramBot_Agents }