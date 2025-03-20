import { Context, Input } from 'telegraf'
import { ConversationManager } from '../ConversationManager'
import { BaseMessage } from '@langchain/core/messages';
import { IMessage as FlowiseIMessage, MessageType, FlowiseMemory, ICommonObject} from '../../../../src/Interface';
import { MessageContent } from '@langchain/core/messages';
import { Update, InputFile } from 'telegraf/typings/core/types/typegram';
import { PromptManager } from '../PromptManager';  
import { TelegramBot_Agents } from '../TelegramBot_Agents'; 
import { ContextAdapter, } from '../ContextAdapter';
import { ReadStream } from 'fs';
import {
    DatabaseService,
    AUTH_TYPES,
    SUBSCRIPTION_TIERS,
    type AuthType,
    type SubscriptionTier,
    type CreateUserDTO,
    type UserData
} from '../services/DatabaseService';

interface CallbackQuery {
    data: string;
    message?: {
        text?: string;
        from?: {
            id: number;
        };
    };
}
export interface ProcessUserInputResponse {
    response: string | string[];
}

export interface BotMessage {
    type: string;
    content: string;
    // Include other fields if necessary
  }


  export type TelegramMediaType = 'photo' | 'video' | 'animation' | 'audio' | 'document';

export interface InputMediaPhoto {
    type: 'photo';
    media: string | InputFile;
    caption?: string;
    parse_mode?: TelegramParseMode;
}

export interface InputMediaVideo {
    type: 'video';
    media: string | InputFile;
    caption?: string;
    parse_mode?: TelegramParseMode;
    width?: number;
    height?: number;
    duration?: number;
}

export type InputMedia = InputMediaPhoto | InputMediaVideo;

export interface EditMessageMediaOptions {
    chat_id?: number | string;
    message_id?: number;
    inline_message_id?: string;
    reply_markup?: any;
}

  
  export type TelegramParseMode = 'HTML' | 'Markdown' | 'MarkdownV2';
  export interface PhotoSource {
    source: string;  // Path to image file
}

export interface PhotoMessageOptions {
    caption?: string;
    reply_markup?: any;
    parse_mode?: TelegramParseMode;
    replyToMessageId?: number;
}

export interface MessageResponse {
    message_id: number;
    [key: string]: any;
}

export type PhotoInput = string | Buffer | InputFile | { source: string };

export interface MessageContext {
    source: 'telegram' | 'flowise'| 'webapp';
    chatId: number | string;
    messageId?: number | string;
    userId: number | string;
    username?: string;
    first_name?: string;
    input: string;
    raw: {
        message?: {
            text?: string;
            message_id: number;
            photo?: {
                file_id: string;
                width: number;
                height: number;
            }[];
            date?: number;
            chat?: {
                id: number | string;
                type: 'private' | 'group' | 'supergroup' | 'channel';
                title?: string;
                [key: string]: any;
            };
            from?: {
                id: number;
                is_bot: boolean;
                first_name: string;
                username?: string;
                [key: string]: any;
            };
            [key: string]: any;
        };
        chat?: {
            id: number | string;
            type: 'private' | 'group' | 'supergroup' | 'channel';
            title?: string;
            [key: string]: any;
        };
        from?: {
            id: number;
            is_bot: boolean;
            first_name: string;
            username?: string;
            [key: string]: any;
        };
        flowwise_chatflow_id?: string;
        metadata?: {
            chatflowId?: string;
            [key: string]: any;
        };
        [key: string]: any;
    };
    replyWithPhoto?: (
        photo: { source: string | Buffer } | string,
        options?: PhotoMessageOptions
    ) => Promise<MessageResponse>;
    replyWithDocument?: (
        document: { source: string | Buffer } | string,
        options?: any
    ) => Promise<any>;
    callbackQuery?: {
        data: string;
        message?: {
            message_id?: number; // Add this property
            text?: string;
            from?: {
                id: number;
            };
        };
    };
    isAI: boolean;
    isReply: boolean;
    replyToMessage?: { message_id: number; text: string };
}
export interface MyContext extends Context<Update> {
    match: RegExpExecArray | null;
  }
export interface ExtendedIMessage extends Omit<FlowiseIMessage, 'message'> {
    message: MessageContent;
    text?: MessageContent;
    type: MessageType;
    input?: MessageContent,
    output?: MessageContent,
    additional_kwargs?: { message_id?: number };
    metadata?: {
        userId?: string;
        sessionId?: string;
        timestamp?: number;
        [key: string]: any;
    };
}
export interface ScoredDocument {
    content: string;
    score: number;
    metadata: DocumentMetadata;
}
export interface SourceCitation {
    author: string;
    title: string;
    fileName: string;
    chunkOrder: number;
    relevance: number;
    text: string;
    source: string;
    lines: string;
    content: string;
}
export interface DocumentMetadata {
    author?: string;
    title?: string;
    fileName?: string;
    loc?: {
        lines?: {
            from: number;
            to: number;
        };
    };
    chunk_order?: number;
    // Add any other properties that might be present in your metadata
}


export interface IMessage {
    text: string;
    type: MessageType;
    additional_kwargs?: { message_id?: number };
}

export interface IExtendedMemory extends FlowiseMemory {
    getStorageKey(userId: string, sessionId: string): string;
    initSession?: (userId: string, sessionId: string, metadata?: any) => Promise<void>;
    hasSession?: (userId: string, sessionId: string) => Promise<boolean>;
    getChatMessagesExtended(
        userId: string,
        sessionId: string,
        returnBaseMessages?: boolean,
        prependMessages?: ExtendedIMessage[]
    ): Promise<BaseMessage[] | ExtendedIMessage[]>;
    addChatMessagesExtended(msgArray: ExtendedIMessage[], userId: string, sessionId: string): Promise<void>;
    clearChatMessagesExtended(userId: string, sessionId: string): Promise<void>;
    clearAllChatMessages(): Promise<void>;  // Make sure this is here
    getMemoryType(): string;
}
export interface UserQuestionData {
    questions: string[];
    currentPage: number;
    lastActionTime: number;
    setId: string;
    expirationTime: number;
    messageId: number;
    chatId: number;
}
export interface UserCitationData {
    citations: SourceCitation[];
    currentPage: number;
    lastActionTime: number;
    setId: string;
    expirationTime: number;
    messageId: number;
    chatId: number; // Add this if it wasn't there before
}
export type MemoryType = FlowiseMemory | IExtendedMemory;

export type GroupMemberInfo = {
    is_bot: boolean;
    is_admin: boolean;
    username?: string;
    first_name?: string;
};

export type InteractionType = 'greeting' | 'command' | 'factual_question' | 'explanatory_question' | 'general_question' | 'statement' | 'continuation' | 'short_input' | 'general_input' | 'rag' | 'game';
export type ContextRequirement = 'rag' | 'chat' | 'tool' | 'none' | 'game';

export interface Command {
    name: string;
    description: string;
    adminOnly?: boolean;
    execute: (
        adapter: ContextAdapter,
        conversationManager: ConversationManager,
        memory: IExtendedMemory | null,
        userId: string,
        sessionId: string,
        promptManager: PromptManager | null,
        telegramBot: TelegramBot_Agents
    ) => Promise<void>;
}
export interface BotInfo {
    id: number;
    firstName: string;
    username: string;
    is_bot: boolean;
    is_admin: boolean;
}

export interface FunctionDefinition {
    name: string;
    description?: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  }
  export interface IUpdateMemory {
    updateMemory(adapter: ContextAdapter, messages: BaseMessage[], messageId?: number): Promise<void | { sessionId: string }>;
}

export interface TelegramAuthData {
    id: number;
    first_name: string;
    username?: string;
    auth_date: number;
    hash: string;
    photo_url?: string;
    language_code?: string;
    [key: string]: any;  // Additional Telegram auth data
}

export interface WalletAuthData {
    address: string;
    chainId: number;
    signature?: string;
    message?: string;
    nonce?: string;
    network?: string;
    [key: string]: any;  // Additional wallet auth data
}

export interface UserAccount {
    id: string;
    type: AuthType;
    telegramId?: number;
    telegramUsername?: string;
    walletAddress?: string;
    email?: string;
    password_hash?: string;
    subscription_tier: SubscriptionTier;
    token_quota: number;
    token_usage: number;
    tokens_purchased: number;
    created_at: Date;
    last_active: Date;
    last_reset: Date;
    metadata?: {
        auth_timestamp?: number;
        auth_type?: string;
        auth_data?: any;
        deviceInfo?: any;
        userAgent?: string;
        [key: string]: any;  // Allow for additional metadata properties
    };
    stats: UserStats;
}

export type UserStatus = 'active' | 'suspended' | 'restricted' | 'deleted';

export interface UserSettings {
    language?: string;
    notifications: boolean;
    ragMode: boolean;
    timezone?: string;
    preferredModel?: string;
}
export interface UserStats {
    id: string;
    subscription_tier: SubscriptionTier;
    token_usage: number;
    token_quota: number;
    total_tokens: number;
    total_messages: number;
    available_tokens: number;
    last_reset: Date;
    next_reset_date: Date | null;
    last_active: Date;
    active_sessions: number;
    telegram_username: string;
}


// Storage interface that can be implemented for different storage solutions
export interface IStorage {
    // User methods
    getUser(userId: string): Promise<UserAccount | null>;
    createUser(user: UserAccount): Promise<UserAccount>;
    updateUser(userId: string, updates: Partial<UserAccount>): Promise<UserAccount>;
    
    // Session methods
    getSession(sessionId: string): Promise<SessionInfo | null>;
    createSession(session: SessionInfo): Promise<SessionInfo>;
    updateSession(sessionId: string, updates: Partial<SessionInfo>): Promise<SessionInfo>;
    deleteSession(sessionId: string): Promise<boolean>;
    
    // Token tracking
    updateTokenUsage(userId: string, tokensUsed: number): Promise<number>;
    resetTokenUsage(userId: string): Promise<void>;
}
export type SessionStatus = 'active' | 'expired' | 'terminated';

export interface SessionData {
    userId: string;
    sessionId: string;
    type?: 'private' | 'group';
    source: 'telegram' | 'flowise' | 'webapp';
    lastActive?: Date;
    metadata?: Record<string, any>;
}
export interface TokenUsage {
    total_tokens: number;
    available_tokens: number;
    token_usage: number;
    next_reset_date?: Date | null;
    subscription_tier: SubscriptionTier;
}
export interface UserDataRetriever {
    findUserById(userId: string): Promise<UserAccount | null>;
    findUserBy(field: keyof UserAccount, value: any): Promise<UserAccount | null>;
    saveUser(user: UserAccount): Promise<UserAccount>;
    updateUser(userId: string, data: Partial<UserAccount>): Promise<UserAccount>;
    deleteUser(userId: string): Promise<boolean>;
    
    // Token management
    getTokenUsage(userId: string): Promise<TokenUsage>;
    updateTokenUsage(userId: string, tokensUsed: number): Promise<TokenUsage>;
    resetTokenQuota(userId: string): Promise<TokenUsage>;
    
    // Session management
    getSessions(userId: string): Promise<SessionInfo[]>;
    cleanupExpiredSessions(): Promise<void>;
}

export interface AuthRequest {
    type: 'telegram' | 'wallet' | 'email' | 'flowise';
    data: TelegramAuthData | WalletAuthData;
    timestamp: number;
    sessionId: string;
    token?: string;
    deviceInfo?: DeviceInfo;
    metadata?: {
        chatflowId?: string;
        [key: string]: any;
    };
}
export interface WebAuthResponse {
    user: UserAccount;
    tokens: AuthTokens;
    sessionId: string;
}
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}
export interface WebAuthData {
    type: AuthType;
    telegramUser?: {
        id: number;
        username?: string;
        first_name?: string;
    };
    walletAddress?: string;
    flowiseSessionId?: string;
    source?: 'webapp' | 'flowise';
    token?: string;  // Add this field for temp auth tokens
    metadata?: Record<string, any>;
}

export interface DeviceInfo {
    userAgent: string;
    ip?: string;
    platform?: string;
    lastLogin?: Date;
}

/**
 * Type guard for TelegramAuthData
 */
export function isTelegramAuthData(data: any): data is TelegramAuthData {
    return 'id' in data && 'username' in data && 'auth_date' in data && 'hash' in data;
}

/**
 * Type guard for WalletAuthData
 */
export function isWalletAuthData(data: any): data is WalletAuthData {
    return 'address' in data && 'signature' in data && 'chainId' in data;
}
export interface FormattedResponse {
    text?: string;
    content?: string;
    tokenUsage?: number;
    usageStats?: {
        queries: number;
        tokens: number;
    };
    metadata?: {
        source?: string;
        type?: string;
        interface?: string;
        timestamp?: string;
        tokenStats?: {
            quota: number;
            used: number;
            remaining: number;
            messages: number;
            lastReset: string;
            nextReset: string | null;
            subscription: string;
        };
        [key: string]: any;  // Allow for additional metadata fields
    };
    error?: string;
    errorCode?: string;
    requireAuth?: boolean;
    showAuthModal?: boolean;
    requireUpgrade?: boolean;
    
    // Add new fields for webapp/flowise responses
    question?: string;
    chatId?: string;
    chatMessageId?: string;
    isStreamValid?: boolean;
    sessionId?: string;
    memoryType?: any;  // Using any for now, can be typed more specifically if needed
}

/**
 * Response format for token-related requests
 */
export interface TokenResponse {
    success: boolean;
    tokens?: TokenUsage;
    error?: string;
    requireUpgrade?: boolean;
}
/**
 * Response format for auth-related requests
 */
export interface AuthResponse {
    success: boolean;
    user?: {
        id: string;
        subscription_tier: SubscriptionTier;
        available_tokens: number;
        total_tokens: number;
        next_reset_date?: Date;
    };
    session?: {
        id: string;
        type: string;
    };
    error?: string;
}
export interface SafeOptions extends ICommonObject {
    question: string;
    sessionId: string;
    userId: string;
    chatId: string;
    source: 'telegram' | 'flowise' | 'webapp';
    firstName?: string;
    username?: string;
    chatflowId?: string;
    headers?: Record<string, string>;
    chatType: 'private' | 'group';
    messageId?: string | number;
    auth?: {
        type: AuthType;  // Using the imported AuthType type
        id?: string;
        username?: string;
    };
}
export interface SessionInfo {
    id: string;
    userId: string;
    sessionId: string;
    type: 'private' | 'group';
    source: 'telegram' | 'flowise' | 'webapp';
    chat_id?: string;
    flowwiseChatflowId?: string;
    created_at: string;
    last_active: string;
    expires_at: string;
    status: 'active' | 'expired' | 'terminated';
    metadata?: any;
    auth: {
        type: string;
        id: string;
        username: string;
    };
}
export interface ChatRequest {
    question: string;
    sessionId: string;
    chatId: string;
    userId: string;
    firstName?: string;
    chatflowId: string;
    streaming: boolean;
    source: 'webapp';
    auth: {
        type: string;
        id: string;
    };
}
export interface WebappChatIdData {
    sessionId: string;
    userId: string;
    firstName?: string;
    source: 'webapp';
}
export interface SavedConversation {
    id: string;
    title: string;
    description?: string;
    tags: string[];
    createdAt: string;
    updatedAt: string;
    isFavorite: boolean;
    messageCount: number;
}

export interface ConversationMessage {
    role: string;
    content: string;
    timestamp: string;
}

export interface ConversationMetadata {
    conversations?: {
        list?: SavedConversation[];
        current?: {
            id: string;
            messages: ConversationMessage[];
        };
    };
}
export interface RawMessageInput {
    role?: string;
    content?: string;
    message?: string;
    timestamp?: string;
}
export type ConversationOperation = 'conversation_list' | 'conversation_save' | 'conversation_load' | 'conversation_update';

export interface RateLimit {
    max: number;
    window: number;  // in seconds
}

export type RateLimits = {
    [K in ConversationOperation]: RateLimit;
}

/////////////////////////////////////START-GAME_STUFF's/////////////////////////////////////////////////


// Game-related types
export type GameType = 'millionaire' | 'trivia' | 'quiz';
export type GameStatus = 'initializing' | 'awaiting_start' | 'in_progress' | 'awaiting_answer' | 'showing_result' | 'game_over';


export interface Lifelines {
    fiftyFifty: boolean;
    phoneAFriend: boolean;
    askTheAudience: boolean;
}

export interface Question {
    question: string;
    options: string[];
    correctAnswer: number;
    difficulty: QuestionDifficulty;
    explanation?: string;
    source?: string;
    category: string;
    usedLifelines: LifelineType[];
}

export type QuestionDifficulty = 'easy' | 'medium' | 'hard' | 'very_hard';
export type LifelineType = keyof Lifelines;

export interface GameSession {
    id: string;
    userId: string;
    gameType: GameType;
    state: GameState;
    config: GameConfig;
    startTime: Date;
    endTime?: Date;
}

export interface GameConfig {
    moneyTree?: number[];
    timeLimit?: number;
    lifelines?: LifelineType[];
}

// Add gameMetadata to EnhancedResponse
export interface GameMetadata {
    gameState: GameState | null;
    keyboard: any | null;  // For Telegram inline keyboard markup
}

export type ResponseType = string[] | EnhancedResponse;

export interface GameResponse {
    response: string[];
    metadata: {
        gameState: GameState | null;
        keyboard: any;
        requiresInput?: boolean;
        availableActions?: string[];
        messageId?: number;
    };
}

export interface EnhancedResponse {
    response: string[];
    sourceCitations?: SourceCitation[];
    followUpQuestions?: string[];
    externalAgentSuggestion?: string | null;
    gameMetadata?: {
        gameState: any;
        keyboard: any;
    } | null;
    patternMetadata?: {
        keyboard: any;
        pattern: string;
        description: string;
        confidence: number;
    } | null;
    skipStandardMenu?: boolean; // New flag to control menu display
}

export interface GameState {
    userId: string;
    type: GameType;
    status: GameStatus;
    currentLevel: number;
    moneyWon: number;
    startTime: Date;
    isActive: boolean;
    awaitingAnswer: boolean;
    currentQuestion: Question | null;
    questionBank: Question[];  // Add this to store pre-generated questions
    questionHistory: Question[];
    lifelines: Lifelines;
    safeHavens: number[];
    lastMessageId?: number;
    responseAlreadySent?: boolean; // Add this optional flag
    
}


// Utility functions and type guards
export function isGameState(obj: any): obj is GameState {
    return obj && 
           typeof obj.userId === 'string' &&
           typeof obj.isActive === 'boolean' &&
           typeof obj.currentLevel === 'number' &&
           typeof obj.moneyWon === 'number' &&
           obj.lifelines && 
           typeof obj.lifelines === 'object';
}

export function isQuestion(obj: any): obj is Question {
    return obj && 
           typeof obj.question === 'string' &&
           Array.isArray(obj.options) &&
           typeof obj.correctAnswer === 'number' &&
           typeof obj.difficulty === 'string' &&
           typeof obj.category === 'string';
}

// Helper function to create initial game state
export function createInitialGameState(userId: string, type: GameType = 'millionaire'): GameState {
    return {
        userId,
        type,
        status: 'initializing',
        currentLevel: 1,
        moneyWon: 0,
        startTime: new Date(),
        isActive: true,
        awaitingAnswer: false,
        currentQuestion: null,
        questionBank: [],
        questionHistory: [],
        lifelines: {
            fiftyFifty: true,
            phoneAFriend: true,
            askTheAudience: true
        },
        safeHavens: [5, 10, 15]  // Default safe havens
    };
}

// Constants
export const DEFAULT_MONEY_TREE = [
    100, 200, 300, 500, 1000,          // Level 1-5
    2000, 4000, 8000, 16000, 32000,    // Level 6-10
    64000, 125000, 250000, 500000, 1000000  // Level 11-15
];

export const DEFAULT_GAME_CONFIG: GameConfig = {
    moneyTree: DEFAULT_MONEY_TREE,
    timeLimit: 45,  // seconds per question
    lifelines: ['fiftyFifty', 'phoneAFriend', 'askTheAudience']
};

export interface QuestionData {
    question: string;
    options: string[];
    correctAnswer: number;
    explanation: string;
    category: string;
    difficulty: string;
    conversationReference: string;
}
/////////////////////////Start-From_OLD-Discontinued_GameTypes-Might_need_reworking//////////////////////////////

export interface GameButtons {
    // Essential game control
    END_GAME: 'millionaire_quit',
    
    // Answer options
    ANSWER_A: 'millionaire_answer:A',
    ANSWER_B: 'millionaire_answer:B',
    ANSWER_C: 'millionaire_answer:C',
    ANSWER_D: 'millionaire_answer:D',
    
    // Lifelines (these could be dynamically shown/hidden based on availability)
    LIFELINE_5050: 'millionaire_lifeline:5050',
    LIFELINE_PHONE: 'millionaire_lifeline:phone',
    LIFELINE_AUDIENCE: 'millionaire_lifeline:audience'
};


export interface MillionaireState extends GameState {
    lifelines: {
        fiftyFifty: boolean;
        phoneAFriend: boolean;
        askTheAudience: boolean;
    };
    safeHavens: number[];
    currentQuestion: Question | null;
};

export interface PhoneAFriendResult extends BaseLifelineResult {
    type: 'phoneAFriend';
    result?: {
        suggestedAnswer: string;
        confidence: number;
        reasoning: string;
    };
};

export interface FiftyFiftyResult extends BaseLifelineResult {
    type: 'fiftyFifty';
    remainingOptions?: string[];
    result?: number[];
}

export interface AskTheAudienceResult extends BaseLifelineResult {
    type: 'askTheAudience';
    votes?: Map<string, number>;
    result?: number[];
}

export type LifelineResult = PhoneAFriendResult | FiftyFiftyResult | AskTheAudienceResult;

export interface BaseLifelineResult {
    type: LifelineType;
    message: string;
    success?: boolean;
}


/////////////////////////End-From_OLD-Discontinued_GameTypes-Might_need_reworking//////////////////////////////


/////////////////////////////////////END-GAME_STUFF's/////////////////////////////////////////////////


export interface PatternContextData {
    input: string;
    interactionType: InteractionType;
    contextRequirement: ContextRequirement;
    timestamp: number;
    chatHistory?: BaseMessage[];
    originalMessageId?: number; // Store the original message ID
    currentPatternState: number | string;
    metadata?: {
        isReply?: boolean;
        replyToMessage?: { message_id: number; text: string };
        userId?: string;
        messageId?: number | string;
        hasFile?: boolean;
        fileType?: string;
        suggestion?: any; // Store the suggestion in metadata
        isResponse?: boolean; // Add this property for response context
        responseLength?: number; // Add this for response size information
    };
    processed?: boolean; // Flag to indicate if pattern processing has been completed
    processedContent?: string; // The result of pattern processing
}

// Update the PatternAnalysis interface
export interface PatternAnalysis {
    characteristics: {
        contentType: string;
        length: number;
        complexity: number;
        hasCode: boolean;
        hasUrls: boolean;
        hasTechnicalTerms: boolean;
        isQuestion: boolean;
        topicCategory: string;
        format: string;
        intent: string;
        hasFile?: boolean;
        fileType?: string;
        specialFeatures?: string[];
        requestedPattern?: string; // Add this new property
    };
}


// In types.ts
export interface PatternData {
    originalInput: string;
    inputChunks?: {
        chunks: string[];
        currentChunk?: number;
        lastAccessed?: number;
    };
    processedOutputs: {
        [patternName: string]: {
            output: string;
            timestamp: number;
            chunks?: string[];
            currentChunk?: number;
            messageIds?: number[];
            menuMessageId?: number;  
            sourceName?: string;
            sourceChunkIndex?: number;
            batchResults?: Array<string>; 
            isBatch?: boolean;            
            sourceCitations?: SourceCitation[]; 

        }
    };
    currentPatternState: {
        activePage?: number;
        lastProcessedPattern?: string;
        lastMessageId?: number;
        useProcessedOutput?: string;
        selectedInputChunk?: number;
    };
    
    sourceInfo?: {
        title?: string;
        url?: string;
        type?: string;
        metadata?: any;
    };

    contextInfo?: {
        relevantContext?: string;
        lastUpdated?: number;
    };
}

// Add these interfaces to types.ts or a new file
export interface QuestionAnalysisResult {
    isQuestion: boolean;
    confidence: number;
    possibleTargets: string[];
    sensitivity: 'low' | 'medium' | 'high';
    knowledgeRequired: 'general' | 'specific' | 'personal';
    recommendedAction: 'answer' | 'offer_help' | 'stay_silent' | 'continue_conversation';
    requiresRagMode: boolean;
    reasoning: string;
}

export interface ConversationContext {
    isOngoing: boolean;
    lastBotMessageTimestamp: number;
    recentMessages: number;
    recentMentions: number;
    lastUserIds: string[];
}

// Define the cached question data type
export interface CachedQuestionData {
    userId: string;
    sessionId: string;
    question: string;
    analysis: QuestionAnalysisResult;
    timestamp: number;
}

export type TranscriptionProvider = 'local-cuda' | 'local-cpu' | 'assemblyai' | 'google' | 'azure' | 'aws' | 'ibm';

export interface TranscriptionOptions {
  provider?: TranscriptionProvider;
  modelSize?: 'tiny' | 'base' | 'small' | 'medium' | 'large';
  language?: string;
  apiKey?: string;
}

export interface TranscriptionEstimate {
    videoId: string;
    estimatedMinutes: number;
    timestamp: number;
}