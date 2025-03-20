/**
 * The `DatabaseService` class provides an interface for interacting with the application's databases, including a Telegram bot database and a Flowise database.
 *
 * The class handles the initialization of the databases, user management, session management, and integration with the Flowise API.
 *
 * Key features:
 * - Manages user accounts, including creating, retrieving, and updating user data.
 * - Handles session management, including creating, retrieving, and updating sessions.
 * - Provides methods for processing Flowise requests, including logging the requests and responses.
 * - Includes utility methods for querying the Flowise database and managing the bot database.
 * - Supports cleanup and database connection management.
 */
// DatabaseService.ts

import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'path';
import { logWarn, logInfo, logError } from '../loggingUtility';
import { IStorage, SessionData, SessionInfo, UserStats, ExtendedIMessage, ConversationMessage, SavedConversation } from '../commands/types'
import { v4 as uuidv4 } from 'uuid';

export {
    AUTH_TYPES,
    SUBSCRIPTION_TIERS,
    type AuthType,
    type SubscriptionTier,
    type CreateUserDTO,
    type SessionCreationDTO,
    type UserData
};
const AUTH_TYPES = {
    TELEGRAM: 'telegram' as const,
    WALLET: 'wallet' as const,
    EMAIL: 'email' as const,
    FLOWISE: 'flowise' as const,
    WEBAPP: 'webapp' as const
} as const;
const SUBSCRIPTION_TIERS = {
    FREE: 'free' as const,
    FLEX: 'flex' as const
} as const;

type AuthType = typeof AUTH_TYPES[keyof typeof AUTH_TYPES];
type SubscriptionTier = typeof SUBSCRIPTION_TIERS[keyof typeof SUBSCRIPTION_TIERS];

interface CreateUserDTO {
    id: string;
    type: AuthType;
    telegram_id?: number;           // Changed from number | null to number | undefined
    telegram_username?: string;     // Using undefined instead of null
    wallet_address?: string;        // Using undefined instead of null
    email?: string;
    password_hash?: string;
    subscription_tier: SubscriptionTier;
    token_quota: number;
    metadata?: any;
    stats?: number;
}
interface SessionCreationDTO {
    id: string;
    userId: string;
    type: 'private' | 'group';
    source: 'telegram' | 'flowise' | 'webapp';
    chatId: string;
    created_at?: string;
    last_active?: string;
    expires_at: string;
    status: string;
    flowwiseChatflowId?: string;
    metadata?: any;
}

interface UserData extends CreateUserDTO {
    token_usage: number;
    created_at?: string;
    last_active?: string;
    last_reset: string;
    stats?: number;
}
export interface SessionCreationData {
    id: string;
    userId: string;
    sessionId: string;
    type: 'private' | 'group';
    source: 'telegram' | 'flowise' | 'webapp';
    chatId: string;
    created_at?: string;
    last_active?: string;
    expires_at: string;
    status: string;
    flowwiseChatflowId?: string;
    metadata?: any;
}
interface UserData {
    id: string;
    type: AuthType;
    email?: string;
    email_verified?: boolean;
    password_hash?: string;
    telegram_id?: number;
    telegram_username?: string;
    wallet_address?: string;
    subscription_tier: SubscriptionTier;
    tokens_purchased: number;
    token_quota: number;
    token_usage: number;
    created_at?: string;
    last_active?: string;
    stats?: number;
}

export class DatabaseService {
    // private db: Database;
    //private flowId: string;
    private readonly botDbPath: string;
    private readonly flowiseDbPath: string;
    private botDb: Database | null = null;
    private flowiseDb: Database | null = null;
    private readonly flowId: string;
    public readonly DEFAULT_TOKEN_QUOTA = 10000; // Add this class property


    constructor(flowId: string) {
        this.flowId = flowId;

        // Use DATABASE_PATH from env for base directory
        const baseDir = process.env.DATABASE_PATH || './';

        // Set up paths for both databases
        this.flowiseDbPath = path.join(baseDir, 'database.sqlite');
        this.botDbPath = path.join(baseDir, 'telegram_bot.sqlite');

        logInfo('DatabaseService', `Initializing with paths:`, {
            flowiseDb: this.flowiseDbPath,
            botDb: this.botDbPath
        });
    }

    async initialize(): Promise<void> {
        try {
            // Initialize bot database
            this.botDb = await open({
                filename: this.botDbPath,
                driver: sqlite3.Database
            });

            // Drop existing sessions table to ensure new schema
            await this.botDb.exec('DROP TABLE IF EXISTS sessions');

            // Initialize read-only connection to Flowise database
            this.flowiseDb = await open({
                filename: this.flowiseDbPath,
                driver: sqlite3.Database,
                mode: sqlite3.OPEN_READONLY
            });

            await this.createBotTables();
            logInfo('DatabaseService', `Both databases initialized successfully`, { flowId: this.flowId });
        } catch (error) {
            logError('DatabaseService', 'Failed to initialize databases', error as Error);
            throw error;
        }
    }

    /**
         * User Management Methods
         */
    public async createUser(userData: CreateUserDTO): Promise<void> {
        if (!this.botDb) throw new Error('Bot database not initialized');

        try {
            const {
                id,
                type,
                telegram_id,
                telegram_username,
                wallet_address,
                email,
                subscription_tier = 'free',
                token_quota = 10000,
                metadata
            } = userData;

            await this.botDb.run(
                `INSERT INTO user_accounts (
                    id, type, telegram_id, telegram_username, wallet_address, 
                    email, subscription_tier, token_quota, metadata,
                    created_at, last_active, last_reset
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                [
                    id,
                    type,
                    telegram_id,
                    telegram_username,
                    wallet_address,
                    email,
                    subscription_tier,
                    token_quota,
                    metadata ? JSON.stringify(metadata) : null
                ]
            );
        } catch (error) {
            console.error(`[DatabaseService.createUser] Error creating user:`, error);
            throw error;
        }
    }

    public async normalizeUserId(userId: string, type: AuthType): Promise<string> {
        try {
            // First remove all possible prefixes
            const cleanId = userId
                .replace(/^tg_telegram_/, '')
                .replace(/^tg_/, '')
                .replace(/^telegram_/, '')
                .replace(/^flowise_/, '')
                .replace(/^webapp_/, '')
                .replace(/^wallet_/, '')
                .replace(/^email_/, '');

            // Add the appropriate prefix based on type
            switch (type) {
                case AUTH_TYPES.TELEGRAM:
                    return `tg_${cleanId}`; // Consistent tg_ prefix
                case AUTH_TYPES.FLOWISE:
                    return `flowise_${cleanId}`;
                case AUTH_TYPES.WEBAPP:
                    return `tg_${cleanId}`;
                case AUTH_TYPES.WALLET:
                    return `wallet_${cleanId.toLowerCase()}`;
                case AUTH_TYPES.EMAIL:
                    return `email_${cleanId.toLowerCase()}`;
                default:
                    throw new Error(`Invalid auth type: ${type}`);
            }
        } catch (error) {
            console.error(`[normalizeUserId] Error normalizing user ID:`, {
                originalUserId: userId,
                type,
                error
            });
            throw error;
        }
    }



    async getUserById(userId: string): Promise<any> {
        if (!this.botDb) throw new Error('Database not initialized');

        try {
            return await this.botDb.get(`
            SELECT 
                ua.*,
                us.available_tokens,
                us.total_tokens,
                us.next_reset_date,
                us.active_sessions
            FROM user_accounts ua
            LEFT JOIN user_stats us ON ua.id = us.id
            WHERE ua.id = ?
        `, [userId]);
        } catch (error) {
            logError('DatabaseService.getUserById', 'Error getting user', error as Error);
            throw error;
        }
    }


    async updateUserLastActive(userId: string): Promise<boolean> {
        if (!this.botDb) throw new Error('Database not initialized');

        try {
            await this.botDb.run(`
            UPDATE user_accounts
            SET last_active = datetime('now')
            WHERE id = ?
        `, [userId]);
            return true;
        } catch (error) {
            logError('DatabaseService.updateUserLastActive', 'Error updating last active', error as Error);
            return false;
        }
    }
    public async updateUserStats(
        userId: string,
        updates: Partial<UserStats>
    ): Promise<void> {
        const methodName = 'updateUserStats';
        if (!this.botDb) throw new Error('Database not initialized');
        try {
            const query = `
                UPDATE user_accounts 
                SET 
                    token_usage = ?,
                    total_messages = ?,
                    token_quota = ?
                WHERE id = ?
            `;

            await this.botDb.run(query, [
                updates.token_usage,
                updates.total_messages,
                updates.token_quota,
                userId
            ]);

            // Log update
            logInfo(methodName, 'user_accounts stats updated:', {
                userId,
                tokenUsage: updates.token_usage,
                tokenQuota: updates.token_quota,
                totalMessages: updates.total_messages,
            });
        } catch (error) {
            logError(methodName, 'Error updating user stats:', error as Error);
            throw error;
        }
    }
    async getStatsForUser(userId: string): Promise<any> {
        const methodName = 'getStatsForUser';
        if (!this.botDb) throw new Error('Database not initialized');

        try {
            const stats = await this.botDb.get(`
                SELECT 
                    id,
                    subscription_tier,
                    token_usage,
                    total_messages,  -- Added comma here
                    CASE 
                        WHEN subscription_tier = 'free' THEN 25000
                        ELSE tokens_purchased
                    END as total_tokens,
                    CASE 
                        WHEN subscription_tier = 'free' THEN 
                            25000 - token_usage
                        ELSE 
                            tokens_purchased - token_usage
                    END as available_tokens,  -- This is calculated, not stored
                    last_reset,
                    CASE 
                        WHEN subscription_tier = 'free' 
                        THEN datetime(last_reset, '+1 month')
                        ELSE NULL
                    END as next_reset_date,
                    last_active,
                    telegram_username,  -- Include telegram_username
                    (
                        SELECT COUNT(*) 
                        FROM sessions 
                        WHERE user_id = user_accounts.id 
                        AND status = 'active'
                    ) as active_sessions
                FROM user_accounts
                WHERE id = ?
            `, [userId]);

            logInfo(methodName, 'Retrieved user stats:', {
                userId,
                hasStats: !!stats,
                tokenUsage: stats?.token_usage,
                totalMessages: stats?.total_messages
            });

            return stats;
        } catch (error) {
            logError(methodName, 'Error getting user stats', error as Error);
            throw error;
        }
    }

    public async updateTokenUsage(userId: string, tokenCount: number): Promise<void> {
        const methodName = 'updateTokenUsage';
        if (!this.botDb) throw new Error('Database not initialized');

        try {
            // Get current user stats
            const user = await this.getUserById(userId);
            if (!user) {
                logError(methodName, 'User not found:', { userId });
                throw new Error('User not found');
            }

            // Update token usage - single atomic operation, no transaction needed
            await this.botDb.run(
                `UPDATE user_accounts 
                 SET token_quota = token_quota - ? 
                 WHERE id = ?`,
                [tokenCount, userId]
            );

            logInfo(methodName, 'Token usage updated:', {
                userId,
                tokenCount
            });
        } catch (error) {
            logError(methodName, 'Error updating token usage:', error as Error);
            throw error;
        }
    }


    public async createBotTables(): Promise<void> {
        const methodName = 'createBotTables';
        if (!this.botDb) throw new Error('Bot database not initialized');
        try {
            // Enable foreign keys
            await this.botDb.exec('PRAGMA foreign_keys = ON;');

            // Create tables in the bot database
            await this.botDb.exec(`
                -- User accounts table (extended)
                CREATE TABLE IF NOT EXISTS user_accounts (
                    id TEXT PRIMARY KEY,
                    type TEXT NOT NULL CHECK (type IN ('telegram', 'wallet', 'email', 'flowise')),
                    telegram_id INTEGER UNIQUE,
                    telegram_username TEXT,
                    wallet_address TEXT UNIQUE,
                    email TEXT UNIQUE,
                    email_verified BOOLEAN DEFAULT FALSE,
                    password_hash TEXT,  -- For email authentication
                    subscription_tier TEXT NOT NULL DEFAULT 'free' CHECK (subscription_tier IN ('free', 'flex')),
                    token_quota INTEGER DEFAULT 25000,
                    token_usage INTEGER DEFAULT 0,
                    tokens_purchased INTEGER DEFAULT 0,
                    total_messages INTEGER DEFAULT 0,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    last_active DATETIME DEFAULT CURRENT_TIMESTAMP,
                    last_reset DATETIME DEFAULT CURRENT_TIMESTAMP,
                    metadata TEXT
                );
        
                -- Auth tokens table (for session management)
                CREATE TABLE IF NOT EXISTS auth_tokens (
                    token TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    type TEXT NOT NULL CHECK (type IN ('access', 'refresh')),
                    expires_at DATETIME NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES user_accounts(id)
                );
        
                -- Email verification table
                CREATE TABLE IF NOT EXISTS email_verifications (
                    token TEXT PRIMARY KEY,
                    email TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    expires_at DATETIME NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES user_accounts(id)
                );
        
                -- Password reset table
                CREATE TABLE IF NOT EXISTS password_resets (
                    token TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    expires_at DATETIME NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES user_accounts(id)
                );

                -- Sessions table
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    type TEXT NOT NULL CHECK (type IN ('private', 'group', 'web')),
                    source TEXT NOT NULL CHECK (source IN ('telegram', 'wallet', 'email', 'flowise')),
                    chat_id TEXT NOT NULL,
                    flowwise_chatflow_id TEXT,  -- Reference to Flowise chatflow
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    last_active DATETIME DEFAULT CURRENT_TIMESTAMP,
                    expires_at DATETIME NOT NULL,
                    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'expired', 'terminated')),
                    metadata TEXT,
                    expires_in INTEGER DEFAULT 86400,  -- Added expires_in column with default 24 hours in seconds
                    FOREIGN KEY (user_id) REFERENCES user_accounts(id)
                );

                -- Temporary auth tokens table
                CREATE TABLE IF NOT EXISTS temp_auth_tokens (
                    token TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    expires_at DATETIME NOT NULL,
                    used BOOLEAN DEFAULT 0,
                    FOREIGN KEY (user_id) REFERENCES user_accounts(id)
                );

                -- Session logs table
                CREATE TABLE IF NOT EXISTS session_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    action TEXT NOT NULL,
                    occurred_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    metadata TEXT,
                    FOREIGN KEY (session_id) REFERENCES sessions(id),
                    FOREIGN KEY (user_id) REFERENCES user_accounts(id)
                );

                -- Chat history table (for maintaining conversation context)
                CREATE TABLE IF NOT EXISTS chat_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
                    content TEXT NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    metadata TEXT,
                    FOREIGN KEY (session_id) REFERENCES sessions(id),
                    FOREIGN KEY (user_id) REFERENCES user_accounts(id)
                );

                -- User preferences table
                CREATE TABLE IF NOT EXISTS user_preferences (
                    user_id TEXT PRIMARY KEY,
                    rag_mode_enabled BOOLEAN DEFAULT 0,
                    language TEXT DEFAULT 'en',
                    timezone TEXT,
                    notification_preferences TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES user_accounts(id)
                );

                -- Saved conversations table
                CREATE TABLE IF NOT EXISTS saved_conversations (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    description TEXT,
                    tags TEXT,  -- Comma-separated tags for filtering
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    last_accessed DATETIME,
                    is_favorite BOOLEAN DEFAULT 0,
                    FOREIGN KEY (user_id) REFERENCES user_accounts(id)
                );

                -- Conversation messages table
                CREATE TABLE IF NOT EXISTS conversation_messages (
                    id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
                    content TEXT NOT NULL,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                    metadata TEXT,  -- JSON string for additional data
                    FOREIGN KEY (conversation_id) REFERENCES saved_conversations(id) ON DELETE CASCADE
                );

                -- Rate limits table
                CREATE TABLE IF NOT EXISTS rate_limits (
                    key TEXT NOT NULL,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                    operation TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    FOREIGN KEY (user_id) REFERENCES user_accounts(id)
                );
            `);

            // Create indices
            await this.botDb.exec(`
                CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
                CREATE INDEX IF NOT EXISTS idx_sessions_chat_id ON sessions(chat_id);
                CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
                CREATE INDEX IF NOT EXISTS idx_session_logs_session ON session_logs(session_id);
                CREATE INDEX IF NOT EXISTS idx_chat_history_session ON chat_history(session_id);
                CREATE INDEX IF NOT EXISTS idx_chat_history_user ON chat_history(user_id);
                CREATE INDEX IF NOT EXISTS idx_saved_conversations_user ON saved_conversations(user_id);
                CREATE INDEX IF NOT EXISTS idx_saved_conversations_updated ON saved_conversations(updated_at);
                CREATE INDEX IF NOT EXISTS idx_conversation_messages_conv ON conversation_messages(conversation_id);
                CREATE INDEX IF NOT EXISTS idx_conversation_messages_timestamp ON conversation_messages(conversation_id, timestamp);
                -- Create index for rate limiting queries
                CREATE INDEX IF NOT EXISTS idx_rate_limits_key_time 
                ON rate_limits(key, timestamp);
            `);


            // Create views
            await this.botDb.exec(`
                CREATE VIEW IF NOT EXISTS user_stats AS
                SELECT 
                    ua.id,
                    ua.subscription_tier,
                    ua.token_usage,
                    ua.total_messages,
                    CASE 
                        WHEN ua.subscription_tier = 'free' THEN 25000
                        ELSE ua.tokens_purchased
                    END as total_tokens,
                    CASE 
                        WHEN ua.subscription_tier = 'free' THEN 
                            25000 - ua.token_usage
                        ELSE 
                            ua.tokens_purchased - ua.token_usage
                    END as available_tokens,
                    ua.last_reset,
                    CASE 
                        WHEN ua.subscription_tier = 'free' 
                        THEN datetime(ua.last_reset, '+1 month')
                        ELSE NULL
                    END as next_reset_date,
                    ua.last_active,
                    (SELECT COUNT(*) FROM sessions s WHERE s.user_id = ua.id AND s.status = 'active') as active_sessions
                FROM user_accounts ua;
        `);

            logInfo(methodName, 'Tables created successfully');
        } catch (error) {
            logError(methodName, 'Error creating tables:', error as Error);
            throw error;
        }
    }

    // Add method to link with Flowise data
    async getFlowiseData(chatflowId: string): Promise<any> {
        if (!this.flowiseDb) throw new Error('Flowise database not initialized');

        try {
            // Get chatflow details
            const chatflow = await this.flowiseDb.get(
                'SELECT * FROM chat_flow WHERE id = ?',
                [chatflowId]
            );

            if (!chatflow) {
                throw new Error(`Chatflow ${chatflowId} not found`);
            }

            // Get associated messages
            const messages = await this.flowiseDb.all(
                'SELECT * FROM chat_message WHERE chatflowid = ? ORDER BY createdDate DESC',
                [chatflowId]
            );

            return {
                chatflow,
                messages
            };
        } catch (error) {
            logError('DatabaseService', `Error getting Flowise data`, error as Error);
            throw error;
        }
    }
    // Method to query Flowise database (read-only)
    async queryFlowiseDb(sql: string, params: any[] = []): Promise<any> {
        if (!this.flowiseDb) throw new Error('Flowise database not initialized');
        return await this.flowiseDb.all(sql, params);
    }



    // Add new method for web session handling
    async createWebSession(data: {
        userId: string;
        sessionId: string;
        flowiseSessionId?: string;
        source?: string;  // Add source parameter
    }): Promise<any> {
        if (!this.botDb) throw new Error('Database not initialized');

        // Normalize userId format if coming from Telegram
        const normalizedUserId = data.userId.startsWith('telegram_') ?
            data.userId :
            `telegram_${data.userId}`;

        try {
            const result = await this.botDb.run(
                `INSERT INTO sessions (
                    id, user_id, type, source, chat_id,
                    flowise_chatflow_id, created_at, last_active,
                    expires_at, status, metadata
                ) VALUES (?, ?, 'web', ?, ?,
                    ?, datetime('now'), datetime('now'),
                    datetime('now', '+1 day'), 'active', ?)`,
                [
                    data.sessionId,
                    normalizedUserId,
                    data.source || 'flowise',
                    data.sessionId,  // Using sessionId as chat_id for web sessions
                    this.flowId,
                    JSON.stringify({
                        flowiseSessionId: data.flowiseSessionId,
                        source: data.source || 'flowise'
                    })
                ]
            );

            return this.getSession(data.sessionId);
        } catch (error) {
            console.error('Error creating web session:', error);
            throw error;
        }
    }
    // Add method to link Flowise responses with our database
    async logFlowiseInteraction(data: {
        userId: string;
        sessionId: string;
        flowiseResponse: any;
        tokenUsage: number;
    }): Promise<void> {
        if (!this.botDb) throw new Error('Database not initialized');

        try {
            // Update token usage
            await this.botDb.run(
                `UPDATE user_accounts 
                SET token_usage = token_usage + ?,
                    last_active = datetime('now')
                WHERE id = ?`,
                [data.tokenUsage, data.userId]
            );

            // Log interaction
            await this.botDb.run(
                `INSERT INTO chat_history (
                    session_id, user_id, role, content, metadata
                ) VALUES (?, ?, 'assistant', ?, ?)`,
                [
                    data.sessionId,
                    data.userId,
                    data.flowiseResponse.text || '',
                    JSON.stringify({
                        flowiseResponse: data.flowiseResponse,
                        tokenUsage: data.tokenUsage
                    })
                ]
            );
        } catch (error) {
            console.error('Error logging Flowise interaction:', error);
            throw error;
        }
    }


    /**
     * Retrieves or creates a session for the given session information.
     *
     * This method performs the following steps:
     * 1. Checks if the database is initialized.
     * 2. Determines the user ID based on the session information, normalizing it for different authentication types and sources.
     * 3. Checks if the user already exists in the database, and creates a new user if necessary.
     * 4. Checks if an active session already exists for the given session ID, and creates a new session if necessary.
     * 5. Returns the session information, including the normalized user ID and session status.
     *
     * @param sessionInfo - The session information, including the user ID, session ID, source, and metadata.
     * @param skipUserCreation - An optional flag to skip user creation if the user already exists.
     * @returns The session information, including the normalized user ID and session status.
     * @throws Error if the database is not initialized.
     */
    public async getOrCreateSession(
        sessionInfo: SessionInfo,
        skipUserCreation: boolean = false
    ): Promise<SessionInfo> {
        const methodName = 'getOrCreateSession';
        if (!this.botDb) throw new Error('Database not initialized');

        try {
            // For Flowise chat window, check source first
            const isFlowiseChat = sessionInfo.source === 'flowise';

            // Get the chatflowId
            const chatflowId = sessionInfo.flowwiseChatflowId ||
                sessionInfo.metadata?.chatflowId ||
                this.flowId;

            // Determine database source (use 'telegram' for webapp)
            const dbSource = sessionInfo.source === 'webapp' ? 'telegram' : sessionInfo.source;

            // First normalize the user ID
            const normalizedUserId = isFlowiseChat ?
                `flowise_${chatflowId}` :  // Always create valid userId for flowise
                `tg_${sessionInfo.userId.replace(/^tg_/, '')}`;

            // Begin transaction
            await this.botDb.run('BEGIN TRANSACTION');

            try {
                // Check if user exists in user_accounts
                const existingUser = await this.botDb.get(
                    'SELECT * FROM user_accounts WHERE id = ?',
                    [normalizedUserId]
                );

                // For flowise, always create user if it doesn't exist
                const shouldCreateUser = !existingUser && (isFlowiseChat || !skipUserCreation);

                logInfo(methodName, 'Session creation attempt:', {
                    originalUserId: sessionInfo.userId,
                    normalizedUserId,
                    sessionId: sessionInfo.sessionId,
                    dbSource,
                    skipUserCreation,
                    isFlowiseChat,
                    chatflowId,
                    shouldCreateUser
                });

                logInfo(methodName, 'User lookup result:', {
                    lookupId: normalizedUserId,
                    userFound: !!existingUser,
                    skipUserCreation,
                    shouldCreateUser
                });

                if (shouldCreateUser) {
                    // Create user if needed
                    const metadata = isFlowiseChat ? {
                        source: 'flowise',
                        created_at: new Date().toISOString(),
                        chatflowId
                    } : {
                        original_id: sessionInfo.userId,
                        source: dbSource,
                        created_at: new Date().toISOString(),
                        interface: sessionInfo.metadata?.interface || 'telegram'
                    };

                    await this.createUser({
                        id: normalizedUserId,
                        type: isFlowiseChat ? 'flowise' : 'telegram',
                        subscription_tier: SUBSCRIPTION_TIERS.FREE,
                        token_quota: this.DEFAULT_TOKEN_QUOTA,
                        metadata
                    });

                    logInfo(methodName, 'Created new user:', {
                        userId: normalizedUserId,
                        type: isFlowiseChat ? 'flowise' : 'telegram'
                    });
                }

                // Check for existing session
                let session = await this.botDb.get(
                    'SELECT * FROM sessions WHERE id = ? AND status = ?',
                    [sessionInfo.sessionId, 'active']
                );

                if (!session) {
                    // Sanitize metadata before storage
                    const sanitizedMetadata = this.sanitizeMetadata({
                        ...sessionInfo.metadata,
                        original_user_id: isFlowiseChat ? chatflowId : sessionInfo.userId,
                        normalized_user_id: normalizedUserId,
                        source: sessionInfo.source,
                        originalSource: sessionInfo.source,
                        interface: sessionInfo.source === 'webapp' ? 'webapp' : 'telegram',
                        chatflowId
                    });

                    // Create new session
                    await this.botDb.run(
                        `INSERT INTO sessions (
                            id, user_id, type, source, chat_id,
                            flowwise_chatflow_id, created_at, last_active,
                            expires_at, status, metadata
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [
                            sessionInfo.sessionId,           // id
                            normalizedUserId,                // user_id
                            sessionInfo.type || 'private',   // type
                            dbSource,                        // source
                            sessionInfo.chat_id,             // chat_id
                            chatflowId,                      // flowwise_chatflow_id
                            sessionInfo.created_at || new Date().toISOString(),      // created_at
                            sessionInfo.last_active || new Date().toISOString(),     // last_active
                            sessionInfo.expires_at || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),  // expires_at
                            'active',                        // status
                            JSON.stringify(sanitizedMetadata) // metadata
                        ]
                    );

                    // Verify session was created
                    session = await this.botDb.get(
                        'SELECT * FROM sessions WHERE id = ?',
                        [sessionInfo.sessionId]
                    );

                    if (!session) {
                        throw new Error(`Failed to create session: ${sessionInfo.sessionId}`);
                    }

                    logInfo(methodName, 'Created new session:', {
                        sessionId: sessionInfo.sessionId,
                        userId: normalizedUserId,
                        type: sessionInfo.type || 'private',
                        source: dbSource
                    });
                }

                await this.botDb.run('COMMIT');

                return {
                    ...sessionInfo,
                    source: dbSource,  // Use database-compatible source
                    userId: normalizedUserId,
                    metadata: {
                        ...sessionInfo.metadata,
                        originalSource: sessionInfo.source,
                        interface: sessionInfo.source === 'webapp' ? 'webapp' : 'telegram'
                    }
                };

            } catch (error) {
                await this.botDb.run('ROLLBACK');
                throw error;
            }
        } catch (error) {
            logError(methodName, 'Session creation error:', error as Error);
            throw error;
        }
    }
    private analyzeContentMismatch(original: string, inserted: string): {
        matches: boolean;
        analysis: {
            exactMatch: boolean;
            emojiAnalysis: {
                original: string[];
                inserted: string[];
                matches: boolean;
            };
            textAnalysis: {
                lengthDiff: number;
                linesDiff: number;
                firstDifference: { index: number; char1: string; char2: string; } | null;
            };
            structureAnalysis: {
                original: {
                    length: number;
                    lines: number;
                    hasEmojis: boolean;
                };
                inserted: {
                    length: number;
                    lines: number;
                    hasEmojis: boolean;
                };
            };
        };
    } {
        // Check for exact match first
        const exactMatch = original === inserted;
        if (exactMatch) {
            return {
                matches: true,
                analysis: {
                    exactMatch: true,
                    emojiAnalysis: {
                        original: [],
                        inserted: [],
                        matches: true
                    },
                    textAnalysis: {
                        lengthDiff: 0,
                        linesDiff: 0,
                        firstDifference: null
                    },
                    structureAnalysis: {
                        original: {
                            length: original.length,
                            lines: original.split('\n').length,
                            hasEmojis: false
                        },
                        inserted: {
                            length: inserted.length,
                            lines: inserted.split('\n').length,
                            hasEmojis: false
                        }
                    }
                }
            };
        }

        // Extract and compare emojis
        const emojiRegex = /(\p{Extended_Pictographic}|\p{Emoji})/gu;
        const originalEmojis = original.match(emojiRegex) || [];
        const insertedEmojis = inserted.match(emojiRegex) || [];
        const emojiMatches = originalEmojis.length === insertedEmojis.length &&
            originalEmojis.every((emoji, i) => emoji === insertedEmojis[i]);

        // Compare structure
        const originalLines = original.split('\n');
        const insertedLines = inserted.split('\n');
        const linesDiff = Math.abs(originalLines.length - insertedLines.length);

        // Find first difference
        const firstDiff = this.findFirstDifference(original, inserted);

        // Analyze structure
        const structureAnalysis = {
            original: {
                length: original.length,
                lines: originalLines.length,
                hasEmojis: originalEmojis.length > 0
            },
            inserted: {
                length: inserted.length,
                lines: insertedLines.length,
                hasEmojis: insertedEmojis.length > 0
            }
        };

        // For content with emojis, require exact matches
        const requiresExactMatch = originalEmojis.length > 0 || insertedEmojis.length > 0;
        const matches = requiresExactMatch ? exactMatch :
            this.normalizeContent(original) === this.normalizeContent(inserted);

        return {
            matches,
            analysis: {
                exactMatch,
                emojiAnalysis: {
                    original: originalEmojis,
                    inserted: insertedEmojis,
                    matches: emojiMatches
                },
                textAnalysis: {
                    lengthDiff: Math.abs(original.length - inserted.length),
                    linesDiff,
                    firstDifference: firstDiff
                },
                structureAnalysis
            }
        };
    }

    private findFirstDifference(str1: string, str2: string): { index: number; char1: string; char2: string; } | null {
        const minLength = Math.min(str1.length, str2.length);
        for (let i = 0; i < minLength; i++) {
            if (str1[i] !== str2[i]) {
                return {
                    index: i,
                    char1: str1[i],
                    char2: str2[i]
                };
            }
        }
        if (str1.length !== str2.length) {
            return {
                index: minLength,
                char1: str1[minLength] || 'END',
                char2: str2[minLength] || 'END'
            };
        }
        return null;
    }

    private normalizeContent(content: string): string {
        if (!content) return '';

        // Handle basic normalization while preserving emojis and newlines
        return content
            .replace(/\\n/g, '\n')  // Handle escaped newlines
            .replace(/\r\n/g, '\n')  // Normalize line endings
            .replace(/\u200B/g, '')  // Remove zero-width spaces
            .replace(/[^\S\n]+/g, ' ')  // Normalize whitespace except newlines
            .trim();
    }

    private compareContent(original: string, inserted: string): boolean {
        // For content with emojis, require exact match
        if (/(\p{Extended_Pictographic}|\p{Emoji})/gu.test(original) ||
            /(\p{Extended_Pictographic}|\p{Emoji})/gu.test(inserted)) {
            return original === inserted;
        }

        // For text-only content, compare normalized versions
        const normalizedOriginal = this.normalizeContent(original);
        const normalizedInserted = this.normalizeContent(inserted);

        return normalizedOriginal === normalizedInserted;
    }

    private compareEmojis(original: string, inserted: string): {
        original: string[];
        inserted: string[];
        matches: boolean;
        matchedCount: number;
    } {
        const emojiRegex = /(\p{Extended_Pictographic}|\p{Emoji})/gu;
        const originalEmojis = original.match(emojiRegex) || [];
        const insertedEmojis = inserted.match(emojiRegex) || [];

        const matchedCount = originalEmojis.filter((emoji, i) => emoji === insertedEmojis[i]).length;

        return {
            original: originalEmojis,
            inserted: insertedEmojis,
            matches: originalEmojis.length === insertedEmojis.length &&
                matchedCount === originalEmojis.length,
            matchedCount
        };
    }

    private compareText(original: string, inserted: string): {
        original: string;
        inserted: string;
        matches: boolean;
        lengthDiff: number;
        similarity: number;
    } {
        const emojiRegex = /(\p{Extended_Pictographic}|\p{Emoji})/gu;
        const originalText = this.normalizeContent(original.replace(emojiRegex, ''));
        const insertedText = this.normalizeContent(inserted.replace(emojiRegex, ''));

        const lengthDiff = Math.abs(originalText.length - insertedText.length);

        // Calculate similarity score
        let similarity = 0;
        const minLength = Math.min(originalText.length, insertedText.length);
        for (let i = 0; i < minLength; i++) {
            if (originalText[i] === insertedText[i]) similarity++;
        }
        similarity = minLength > 0 ? similarity / minLength : 1;

        return {
            original: originalText,
            inserted: insertedText,
            matches: lengthDiff <= 2 && similarity > 0.9,
            lengthDiff,
            similarity
        };
    }


    private getContentPreview(content: string, maxLength: number = 50): string {
        const normalized = this.normalizeContent(content);
        return normalized.length > maxLength ?
            `${normalized.substring(0, maxLength)}...` :
            normalized;
    }

    private async insertConversationMessage(
        conversationId: string,
        msg: any,
        methodName: string
    ): Promise<void> {
        if (!this.botDb) throw new Error('Database not initialized');

        const messageId = `msg_${uuidv4()}`;
        const role = msg.role || 'user';
        const rawContent = msg.content || msg.text || '';

        // Validate content
        if (!rawContent) {
            logError(methodName, 'Empty message content:', {
                messageId,
                role,
                conversationId
            });
            throw new Error('Message content cannot be empty');
        }

        // Use the original timestamp exactly as is
        // Only set current time if there is no timestamp at all
        const timestamp = msg.timestamp || new Date().toLocaleString('en-AU', {
            timeZone: 'Australia/Brisbane',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        });

        // Log timestamp handling
        if (!msg.timestamp) {
            logInfo(methodName, 'New message with generated timestamp:', {
                messageId,
                timestamp
            });
        } else {
            logInfo(methodName, 'Using original timestamp:', {
                messageId,
                timestamp: msg.timestamp
            });
        }

        // Prepare metadata with content analysis
        const metadata = {
            ...msg.metadata,
            contentAnalysis: {
                hasEmojis: /(\p{Extended_Pictographic}|\p{Emoji})/gu.test(rawContent),
                hasNewlines: rawContent.includes('\n'),
                originalLength: rawContent.length,
                timestamp: {
                    original: msg.timestamp,
                    preserved: !!msg.timestamp,
                    isNew: !msg.timestamp
                }
            }
        };

        // Insert message
        await this.botDb.run(
            `INSERT INTO conversation_messages (
                id,
                conversation_id,
                role,
                content,
                timestamp,
                metadata
            ) VALUES (?, ?, ?, ?, datetime(?), ?)`,
            [
                messageId,
                conversationId,
                role,
                rawContent,
                msg.timestamp || timestamp, // Use original timestamp if exists
                JSON.stringify(metadata)
            ]
        );

        // Verify insertion with exact content matching
        const inserted = await this.botDb.get(
            'SELECT * FROM conversation_messages WHERE id = ?',
            [messageId]
        );

        if (!inserted) {
            throw new Error('Failed to verify message insertion');
        }

        // Verify content exactly matches
        if (inserted.content !== rawContent) {
            logError(methodName, 'Content verification failed:', {
                messageId,
                original: {
                    content: rawContent,
                    length: rawContent.length,
                    preview: rawContent.substring(0, 50)
                },
                stored: {
                    content: inserted.content,
                    length: inserted.content.length,
                    preview: inserted.content.substring(0, 50)
                },
                analysis: {
                    lengthMatch: inserted.content.length === rawContent.length,
                    firstDifference: this.findFirstDifference(rawContent, inserted.content)
                }
            });
            throw new Error('Message content verification failed');
        }

        // Log message insertion
        logInfo(methodName, 'Message inserted and verified:', {
            messageId,
            originalTimestamp: msg.timestamp,
            contentLength: rawContent.length,
            metadata: {
                hasEmojis: /(\p{Extended_Pictographic}|\p{Emoji})/gu.test(rawContent),
                hasNewlines: rawContent.includes('\n'),
                originalLength: rawContent.length,
                timestamp: {
                    original: msg.timestamp,
                    isPreserved: !!msg.timestamp,
                    isGenerated: !msg.timestamp
                }
            }
        });
    }

    private parseTags(tags: any): string[] {
        const methodName = 'parseTags';
        try {
            if (typeof tags === 'string') {
                try {
                    // Handle nested JSON strings
                    let parsed = tags;
                    while (typeof parsed === 'string' && (parsed.startsWith('[') || parsed.startsWith('{'))) {
                        parsed = JSON.parse(parsed);
                    }

                    if (Array.isArray(parsed)) {
                        return parsed.map(tag => {
                            if (typeof tag === 'string') {
                                // Try to parse any remaining JSON strings
                                try {
                                    const parsedTag = JSON.parse(tag);
                                    return typeof parsedTag === 'string' ? parsedTag : JSON.stringify(parsedTag);
                                } catch {
                                    return tag;
                                }
                            }
                            return JSON.stringify(tag);
                        }).filter(Boolean);
                    }

                    // If not an array after parsing, split by comma
                    return parsed.split(',').filter(Boolean);
                } catch {
                    // If JSON parsing fails, split by comma
                    return tags.split(',').filter(Boolean);
                }
            }
            if (Array.isArray(tags)) {
                return tags.map(tag => {
                    if (typeof tag === 'string') {
                        try {
                            const parsed = JSON.parse(tag);
                            return typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
                        } catch {
                            return tag;
                        }
                    }
                    return JSON.stringify(tag);
                }).filter(Boolean);
            }
            return [];
        } catch (error) {
            logError(methodName, 'Error parsing tags:', error as Error, { originalTags: tags });
            return [];
        }
    }

    private normalizeTags(tags: any): string {
        const methodName = 'normalizeTags';
        try {
            logInfo(methodName, 'Normalizing tags input:', {
                originalTags: tags,
                type: typeof tags,
                isArray: Array.isArray(tags)
            });

            const parsedTags = this.parseTags(tags);

            logInfo(methodName, 'Tags after parsing:', {
                parsedTags,
                count: parsedTags.length
            });

            const normalizedTags = parsedTags.join(',');

            logInfo(methodName, 'Final normalized tags:', {
                normalizedTags,
                originalInput: tags
            });

            return normalizedTags;
        } catch (error) {
            logError(methodName, 'Error normalizing tags:', error as Error, {
                originalTags: tags
            });
            return '';
        }
    }

    private sanitizeMetadata(metadata: any): any {
        const seen = new WeakSet();

        const sanitize = (obj: any): any => {
            if (!obj || typeof obj !== 'object') return obj;
            if (seen.has(obj)) return '[Circular]';
            seen.add(obj);

            if (obj instanceof Date) return obj.toISOString();

            if (Array.isArray(obj)) {
                return obj.map(item => sanitize(item));
            }

            const result: any = {};
            for (const [key, value] of Object.entries(obj)) {
                // Skip known problematic properties
                if (['_readableState', 'pipes', 'parent'].includes(key)) continue;
                if (value && typeof value === 'object' && 'constructor' in value) {
                    if (['Console', 'DerivedLogger', 'ReadableState'].includes(value.constructor.name)) {
                        continue;
                    }
                }
                result[key] = sanitize(value);
            }
            return result;
        };

        return sanitize(metadata);
    }

    async cleanup(): Promise<void> {
        try {
            if (this.botDb) {
                await this.botDb.run(
                    `UPDATE sessions 
                    SET status = 'expired' 
                    WHERE expires_at <= datetime('now') 
                    AND status = 'active'`
                );
                await this.botDb.close();
                this.botDb = null;
            }

            if (this.flowiseDb) {
                await this.flowiseDb.close();
                this.flowiseDb = null;
            }

            logInfo('DatabaseService', `Cleanup completed for flowId: ${this.flowId}`);
        } catch (error) {
            logError('DatabaseService', `Error during cleanup`, error as Error);
            throw error;
        }
    }
    async getUserByEmail(email: string): Promise<UserData | null> {
        if (!this.botDb) throw new Error('Database not initialized');

        try {
            const user = await this.botDb.get<UserData>(
                `SELECT * FROM user_accounts WHERE email = ? AND type = 'email'`,
                [email.toLowerCase()]
            );

            return user || null;
        } catch (error) {
            logError('DatabaseService', `Error getting user by email: ${email}`, error as Error);
            throw error;
        }
    }

    public async storeAuthTokens(userId: string, accessToken: string, refreshToken: string): Promise<void> {
        if (!this.botDb) throw new Error('Database not initialized');

        try {
            // Always normalize to tg_[id] format
            const normalizedUserId = userId.replace(/^tg_telegram_/, 'tg_')
                .replace(/^telegram_/, 'tg_')
                .replace(/^tg_tg_/, 'tg_');

            // Verify user exists before attempting to store tokens
            const user = await this.getUserById(normalizedUserId);
            if (!user) {
                throw new Error(`User ${normalizedUserId} not found when storing auth tokens`);
            }

            console.log(`[DatabaseService] Storing auth tokens for user ${normalizedUserId}`, {
                userExists: !!user,
                originalUserId: userId,
                normalizedUserId
            });

            // Begin transaction
            await this.botDb.run('BEGIN TRANSACTION');

            try {
                // Remove any existing tokens for this user
                await this.botDb.run(
                    `DELETE FROM auth_tokens 
                    WHERE user_id = ? AND type IN ('access', 'refresh')`,
                    [normalizedUserId]
                );

                // Insert new access token
                await this.botDb.run(
                    `INSERT INTO auth_tokens (token, user_id, type, expires_at)
                    VALUES (?, ?, 'access', datetime('now', '+1 hour'))`,
                    [accessToken, normalizedUserId]
                );

                // Insert new refresh token
                await this.botDb.run(
                    `INSERT INTO auth_tokens (token, user_id, type, expires_at)
                    VALUES (?, ?, 'refresh', datetime('now', '+7 days'))`,
                    [refreshToken, normalizedUserId]
                );

                // Commit transaction
                await this.botDb.run('COMMIT');
                console.log(`[DatabaseService] Auth tokens stored successfully for user ${normalizedUserId}`);
            } catch (error) {
                await this.botDb.run('ROLLBACK');
                throw error;
            }
        } catch (error) {
            console.error('[DatabaseService] Error storing auth tokens:', {
                error,
                userId,
                normalizedUserId: userId.replace(/^tg_telegram_/, 'tg_')
                    .replace(/^telegram_/, 'tg_')
                    .replace(/^tg_tg_/, 'tg_')
            });
            throw error;
        }
    }
    public async beginTransaction(): Promise<void> {
        if (!this.botDb) throw new Error('Database not initialized');
        await this.botDb.run('BEGIN TRANSACTION');
    }

    public async commitTransaction(): Promise<void> {
        if (!this.botDb) throw new Error('Database not initialized');
        await this.botDb.run('COMMIT');
    }

    public async rollbackTransaction(): Promise<void> {
        if (!this.botDb) throw new Error('Database not initialized');
        await this.botDb.run('ROLLBACK');
    }

    public async hasValidAuthToken(userId: string): Promise<boolean> {
        const methodName = 'hasValidAuthToken';
        if (!this.botDb) throw new Error('Database not initialized');

        try {
            // Use SQLite datetime functions for comparison
            const tokenRecord = await this.botDb.get(
                `SELECT expires_at, used, created_at,
                        datetime('now', 'localtime') as current_time,
                        (strftime('%s', expires_at) - strftime('%s', 'now', 'localtime')) / 60 as minutes_remaining
                 FROM temp_auth_tokens 
                 WHERE user_id = ? 
                 AND used = 0
                 ORDER BY created_at DESC 
                 LIMIT 1`,
                [userId]
            );

            if (!tokenRecord) {
                logInfo(methodName, 'Token validation result:', {
                    userId,
                    isValid: false,
                    reason: 'No valid token found'
                });
                return false;
            }

            const minutesRemaining = parseInt(tokenRecord.minutes_remaining);
            const isValid = !tokenRecord.used && minutesRemaining > 0;

            // Format dates for display only
            const now = new Date();
            const currentAEST = now.toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' });
            const expiryAEST = new Date(tokenRecord.expires_at).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' });

            logInfo(methodName, 'Token validation details:', {
                userId,
                isValid,
                currentAEST,
                expiryAEST,
                minutesRemaining,
                isUsed: tokenRecord.used === 1,
                reason: isValid ? 'Valid token' :
                    tokenRecord.used ? 'Token used' :
                        'Token expired',
                debug: {
                    sqliteCurrentTime: tokenRecord.current_time,
                    rawExpiryAt: tokenRecord.expires_at,
                    rawCreatedAt: tokenRecord.created_at
                }
            });

            return isValid;
        } catch (error) {
            logError(methodName, 'Error checking token:', error as Error);
            return false;
        }
    }

    // Add method to get token details for debugging
    public async getAuthToken(userId: string): Promise<any> {
        if (!this.botDb) throw new Error('Database not initialized');

        try {
            return await this.botDb.get(
                'SELECT * FROM temp_auth_tokens WHERE user_id = ?',
                [userId]
            );
        } catch (error) {
            logError('getAuthToken', 'Error getting token:', error as Error);
            return null;
        }
    }

    public async invalidateAuthTokenForUser(userId: string): Promise<void> {
        const methodName = 'invalidateAuthTokenForUser';
        if (!this.botDb) throw new Error('Database not initialized');

        try {
            await this.botDb.run(
                `UPDATE temp_auth_tokens 
                 SET used = 1 
                 WHERE user_id = ?`,
                [userId]
            );

            logInfo(methodName, 'Token marked as used:', {
                userId,
                timestamp: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })
            });
        } catch (error) {
            logError(methodName, 'Error marking token as used:', error as Error);
            throw error;
        }
    }

    async validateAuthToken(token: string): Promise<boolean> {
        if (!this.botDb) throw new Error('Database not initialized');

        try {
            const tokenRecord = await this.botDb.get(
                `SELECT * FROM auth_tokens 
                WHERE token = ?
        AND expires_at > datetime('now')`,
                [token]
            );

            return !!tokenRecord;
        } catch (error) {
            logError('DatabaseService', 'Error validating auth token', error as Error);
            throw error;
        }
    }

    async invalidateAuthTokens(userId: string): Promise<void> {
        if (!this.botDb) throw new Error('Database not initialized');

        try {
            await this.botDb.run(
                'DELETE FROM auth_tokens WHERE user_id = ?',
                [userId]
            );

            logInfo('DatabaseService', `Auth tokens invalidated for user ${userId}`);
        } catch (error) {
            logError('DatabaseService', 'Error invalidating auth tokens', error as Error);
            throw error;
        }
    }
    public async storeTempAuthToken(userId: string, token: string, expiryTime: Date): Promise<void> {
        const methodName = 'storeTempAuthToken';
        if (!this.botDb) throw new Error('Database not initialized');

        try {
            // Store in SQLite datetime format: YYYY-MM-DD HH:MM:SS
            const formattedExpiry = expiryTime.toLocaleString('en-AU', {
                timeZone: 'Australia/Brisbane',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            }).replace(/(\d+)\/(\d+)\/(\d+),\s*(\d+):(\d+):(\d+)/, '$3-$2-$1 $4:$5:$6');

            logInfo(methodName, 'Storing token with dates:', {
                userId,
                formattedExpiry,
                originalExpiry: expiryTime.toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })
            });

            await this.botDb.run(
                `INSERT INTO temp_auth_tokens (
                    token, user_id, expires_at, used
                ) VALUES (?, ?, ?, 0)`,
                [token, userId, formattedExpiry]
            );
        } catch (error) {
            logError(methodName, 'Error storing token:', error as Error);
            throw error;
        }
    }
    public async validateTempAuthToken(token: string): Promise<boolean> {
        const result = await this.botDb?.get(
            `SELECT * FROM temp_auth_tokens 
             WHERE token = ? AND expires_at > datetime('now') 
             AND used = 0`,
            [token]
        );
        return !!result;
    }

    public async invalidateTempAuthToken(token: string): Promise<void> {
        await this.botDb?.run(
            `UPDATE temp_auth_tokens SET used = 1 
             WHERE token = ?`,
            [token]
        );
    }
    public async getOrCreateUser(userData: CreateUserDTO): Promise<UserData> {
        if (!this.botDb) {
            await this.initialize();
        }
        try {
            // Normalize the user ID based on the auth type
            const normalizedId = await this.normalizeUserId(userData.id, userData.type);

            // Try to get existing user first
            const existingUser = await this.getUserById(normalizedId);
            if (existingUser) {
                console.log(`[DatabaseService] Found existing user:`, {
                    userId: normalizedId,
                    type: existingUser.type
                });
                // Update last active timestamp
                await this.botDb?.run(
                    'UPDATE user_accounts SET last_active = CURRENT_TIMESTAMP WHERE id = ?',
                    [normalizedId]
                );
                return existingUser;
            }
            console.log(`[DatabaseService] Creating new user:`, {
                userId: normalizedId,
                type: userData.type
            });
            // Create new user with normalized ID
            const newUserData = {
                ...userData,
                id: normalizedId,
                created_at: new Date().toISOString(),
                last_active: new Date().toISOString(),
                last_reset: new Date().toISOString()
            };

            await this.createUser(newUserData);

            const createdUser = await this.getUserById(normalizedId);
            if (!createdUser) {
                throw new Error(`Failed to retrieve created user ${normalizedId}`);
            }

            console.log(`[DatabaseService] Successfully created user:`, {
                userId: normalizedId,
                type: createdUser.type
            });

            return createdUser as UserData;
        } catch (error) {
            console.error(`[DatabaseService.getOrCreateUser] Error:`, {
                error,
                userData
            });
            throw error;
        }
    }

    public async getOrCreateFlowiseUser(chatflowId: string): Promise<string> {
        const methodName = 'getOrCreateFlowiseUser';

        try {
            // Create a stable userId based on chatflowId
            const stableUserId = `flowise_${chatflowId}`;

            // Try to get existing user
            const existingUser = await this.getUserById(stableUserId);

            if (existingUser) {
                console.log(`[${methodName}] Found existing Flowise user for chatflow:`, chatflowId);
                return stableUserId;
            }

            // Create new user if doesn't exist
            const userData: CreateUserDTO = {
                id: stableUserId,
                type: AUTH_TYPES.FLOWISE,
                subscription_tier: SUBSCRIPTION_TIERS.FREE,
                token_quota: this.DEFAULT_TOKEN_QUOTA,
                metadata: {
                    chatflowId,
                    source: 'flowise',
                    created_at: new Date().toISOString(),
                    auth_type: AUTH_TYPES.FLOWISE
                }
            };

            await this.createUser(userData);
            console.log(`[${methodName}] Created new Flowise user for chatflow:`, chatflowId);

            return stableUserId;
        } catch (error) {
            console.error(`[${methodName}] Error managing Flowise user:`, error);
            throw error;
        }
    }

    /**
     * Processes a request from the Flowise service, logging the request and response in the chat history table.
     *
     * @param requestData - An object containing the user ID, session ID, input, and Flowise request data.
     * @returns The response from the Flowise service.
     * @throws {Error} If the database is not initialized or an error occurs during the request processing.
     */
    async processFlowiseRequest(requestData: {
        userId: string;
        sessionId: string;
        input: string;
        flowiseRequest: any;
    }): Promise<any> {
        if (!this.botDb) throw new Error('Database not initialized');

        try {
            // Normalize the userId
            const normalizedUserId = await this.normalizeUserId(requestData.userId, 'flowise');

            // Log the request
            await this.botDb.run(`
                INSERT INTO chat_history (
                    session_id,
                    user_id,
                    role,
                    content,
                    metadata
                ) VALUES (?, ?, 'user', ?, ?)
            `, [
                requestData.sessionId,
                normalizedUserId,
                requestData.input,
                JSON.stringify({
                    flowiseRequest: requestData.flowiseRequest,
                    original_user_id: requestData.userId,
                    normalized_user_id: normalizedUserId
                })
            ]);

            // Query Flowise DB
            const response = await this.queryFlowiseDb(
                'prediction',
                requestData.flowiseRequest
            );

            // Log the response
            await this.botDb.run(`
                INSERT INTO chat_history (
                    session_id,
                    user_id,
                    role,
                    content,
                    metadata
                ) VALUES (?, ?, 'assistant', ?, ?)
            `, [
                requestData.sessionId,
                normalizedUserId,
                response.text || response.content || '',
                JSON.stringify({
                    flowiseResponse: response,
                    original_user_id: requestData.userId,
                    normalized_user_id: normalizedUserId
                })
            ]);

            return response;
        } catch (error) {
            logError('DatabaseService.processFlowiseRequest', 'Error processing Flowise request', error as Error);
            throw error;
        }
    }

    public async ensureChatMessagesTable(): Promise<void> {
        if (!this.botDb) throw new Error('Database not initialized');

        try {
            // Check if table exists
            const tableExists = await this.botDb.get(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='chat_messages'"
            );

            if (!tableExists) {
                await this.botDb.exec(`
                    CREATE TABLE IF NOT EXISTS chat_messages (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        user_id TEXT NOT NULL,
                        session_id TEXT NOT NULL,
                        message_type TEXT NOT NULL,
                        content TEXT NOT NULL,
                        metadata TEXT,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        FOREIGN KEY (user_id) REFERENCES user_accounts(id) ON DELETE CASCADE,
                        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
                    );
    
                    CREATE INDEX IF NOT EXISTS idx_chat_messages_user ON chat_messages(user_id);
                    CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);
                `);
            }

            console.log('[DatabaseService] Chat messages table verified');
        } catch (error) {
            console.error('[DatabaseService] Error ensuring chat_messages table:', error);
            throw error;
        }
    }

    public async getSession(sessionId: string): Promise<any> {
        if (!this.botDb) throw new Error('Database not initialized');

        try {
            const session = await this.botDb.get(
                'SELECT * FROM sessions WHERE id = ?',
                [sessionId]
            );
            return session;
        } catch (error) {
            console.error('[DatabaseService] Error getting session:', error);
            throw error;
        }
    }

    public async createSession(sessionData: SessionCreationDTO): Promise<void> {
        if (!this.botDb) throw new Error('Database not initialized');

        try {
            await this.botDb.run(`
                INSERT INTO sessions (
                    id,
                    user_id,
                    type,
                    source,
                    chat_id,
                    flowwise_chatflow_id,
                    created_at,
                    last_active,
                    expires_at,
                    status,
                    metadata
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                sessionData.id,
                sessionData.userId,
                sessionData.type,
                sessionData.source,
                sessionData.chatId,
                sessionData.flowwiseChatflowId || null,
                sessionData.created_at,
                sessionData.last_active,
                sessionData.expires_at,
                sessionData.status,
                JSON.stringify(sessionData.metadata)
            ]);
        } catch (error) {
            console.error('[DatabaseService] Error creating session:', error);
            throw error;
        }
    }

    /**
     * Gets a user by chatflow ID. This method is specifically for Flowise chat window use.
     * It ensures we only have one user account per chatflow ID.
     * 
     * @param chatflowId - The ID of the chatflow
     * @returns The user data if found, null otherwise
     */
    public async getUserByChatflowId(chatflowId: string): Promise<UserData | null> {
        if (!this.botDb) throw new Error('Bot database not initialized');

        try {
            // First, try to find an existing user with this chatflowId in metadata
            const user = await this.botDb.get<UserData>(
                `SELECT * FROM user_accounts 
             WHERE type = ? 
             AND json_extract(metadata, '$.chatflowId') = ?`,
                [AUTH_TYPES.FLOWISE, chatflowId]
            );

            if (user) {
                console.log(`[getUserByChatflowId] Found existing Flowise user for chatflow: ${chatflowId}`);
                return user;
            }

            // If no user exists, create one with the chatflowId
            const userId = `flowise_${chatflowId}`;
            const newUser: CreateUserDTO = {
                id: userId,
                type: AUTH_TYPES.FLOWISE,
                subscription_tier: SUBSCRIPTION_TIERS.FREE,
                token_quota: this.DEFAULT_TOKEN_QUOTA,
                metadata: {
                    chatflowId,
                    source: 'flowise',
                    created_at: new Date().toISOString(),
                    auth_type: AUTH_TYPES.FLOWISE
                }
            };

            await this.createUser(newUser);
            console.log(`[getUserByChatflowId] Created new Flowise user for chatflow: ${chatflowId}`);

            // Return the newly created user
            return await this.getUserById(userId);
        } catch (error) {
            console.error(`[getUserByChatflowId] Error getting/creating user for chatflow ${chatflowId}:`, error);
            throw error;
        }
    }

    public async updateAuthTokenExpiry(userId: string): Promise<void> {
        const methodName = 'updateAuthTokenExpiry';
        if (!this.botDb) throw new Error('Database not initialized');

        try {
            // Get current token before update
            const beforeUpdate = await this.botDb.get(
                `SELECT expires_at 
                 FROM temp_auth_tokens 
                 WHERE user_id = ? 
                 AND used = 0 
                 ORDER BY created_at DESC 
                 LIMIT 1`,
                [userId]
            );

            // Calculate new expiry using SQLite datetime functions
            await this.botDb.run(
                `UPDATE temp_auth_tokens 
                 SET expires_at = datetime('now', 'localtime', '+30 minutes')
                 WHERE user_id = ? 
                 AND used = 0 
                 AND rowid = (
                    SELECT rowid FROM temp_auth_tokens 
                    WHERE user_id = ? 
                    AND used = 0 
                    ORDER BY created_at DESC 
                    LIMIT 1
                 )`,
                [userId, userId]
            );

            // Verify the update using SQLite datetime functions
            const afterUpdate = await this.botDb.get(
                `SELECT expires_at,
                        datetime('now', 'localtime') as current_time,
                        (strftime('%s', expires_at) - strftime('%s', 'now', 'localtime')) / 60 as minutes_remaining
                 FROM temp_auth_tokens 
                 WHERE user_id = ? 
                 AND used = 0 
                 ORDER BY created_at DESC 
                 LIMIT 1`,
                [userId]
            );

            logInfo(methodName, 'Token expiry update details:', {
                userId,
                currentTime: afterUpdate?.current_time,
                newExpiry: afterUpdate?.expires_at,
                minutesRemaining: afterUpdate?.minutes_remaining,
                beforeUpdate: beforeUpdate ? {
                    expiryAt: beforeUpdate.expires_at
                } : null,
                afterUpdate: afterUpdate ? {
                    expiryAt: afterUpdate.expires_at
                } : null,
                updateSuccessful: !!afterUpdate && afterUpdate.expires_at !== beforeUpdate?.expires_at
            });
        } catch (error) {
            logError(methodName, 'Error updating token expiry:', error as Error);
            throw error;
        }
    }

    // Add methods for saved conversations
    public async getConversationById(conversationId: string, userId: string): Promise<any> {
        const methodName = 'getConversationById';
        if (!this.botDb) throw new Error('Database not initialized');
        try {
            logInfo(methodName, 'Looking up conversation:', {
                conversationId,
                userId
            });

            // First check if conversation exists at all
            const anyConversation = await this.botDb.get(
                'SELECT id, user_id FROM saved_conversations WHERE id = ?',
                [conversationId]
            );

            if (!anyConversation) {
                logError(methodName, 'Conversation not found:', {
                    conversationId,
                    userId
                });
                throw new Error(`Conversation ${conversationId} not found`);
            }

            // Then check ownership
            if (anyConversation.user_id !== userId) {
                logError(methodName, 'Conversation access denied:', {
                    conversationId,
                    requestedBy: userId,
                    ownedBy: anyConversation.user_id
                });
                throw new Error(`Access denied to conversation ${conversationId}`);
            }

            // Get full conversation data
            const conversation = await this.botDb.get(
                'SELECT * FROM saved_conversations WHERE id = ?',
                [conversationId]
            );

            logInfo(methodName, 'Retrieved conversation:', {
                conversationId,
                userId,
                found: !!conversation,
                metadata: conversation ? {
                    title: conversation.title,
                    description: conversation.description,
                    tags: conversation.tags,
                    isFavorite: conversation.is_favorite
                } : null
            });

            return conversation;
        } catch (error) {
            logError(methodName, 'Error getting saved conversation:', error as Error);
            throw error;
        }
    }

    public async updateConversation(
        conversationId: string,
        userId: string,
        messages: any[],
        options: {
            title?: string;
            description?: string;
            tags?: string[];
            isFavorite?: boolean;
        } = {}
    ): Promise<void> {
        if (!this.botDb) throw new Error('Database not initialized');
        const methodName = 'updateConversation';
        try {
            // First verify the conversation belongs to the user
            const conversation = await this.getConversationById(conversationId, userId);
            if (!conversation || conversation.user_id !== userId) {
                throw new Error('Conversation not found or unauthorized');
            }

            logInfo(methodName, 'Starting conversation update:', {
                conversationId,
                userId,
                messageCount: messages.length,
                hasTitle: !!options.title,
                hasDescription: !!options.description,
                hasTags: !!options.tags
            });

            // Start transaction
            await this.botDb.run('BEGIN TRANSACTION');

            try {
                // Get existing conversation data to preserve fields if not provided
                const existingConversation = await this.botDb.get(
                    'SELECT title, description, tags, is_favorite FROM saved_conversations WHERE id = ? AND user_id = ?',
                    [conversationId, userId]
                );

                if (!existingConversation) {
                    logError(methodName, 'Conversation not found during update:', {
                        conversationId,
                        userId
                    });
                    throw new Error(`Conversation ${conversationId} not found or access denied`);
                }

                // Handle tags with detailed logging
                let normalizedTags;
                if (options.tags) {
                    logInfo(methodName, 'Processing new tags:', {
                        originalTags: options.tags,
                        type: typeof options.tags,
                        isArray: Array.isArray(options.tags)
                    });
                    normalizedTags = this.normalizeTags(options.tags);
                } else {
                    normalizedTags = existingConversation.tags;
                }

                // Update conversation metadata and last_accessed
                const updateResult = await this.botDb.run(
                    `UPDATE saved_conversations
                    SET title = ?,
                        description = ?,
                        tags = ?,
                        is_favorite = ?,
                        updated_at = CURRENT_TIMESTAMP,
                        last_accessed = CURRENT_TIMESTAMP
                    WHERE id = ? AND user_id = ?`,
                    [
                        options.title || existingConversation.title,
                        options.description || existingConversation.description,
                        normalizedTags,
                        options.isFavorite !== undefined ? options.isFavorite : existingConversation.is_favorite,
                        conversationId,
                        userId
                    ]
                );

                // Verify metadata update
                if (!updateResult?.changes) {
                    throw new Error(`Failed to update conversation metadata for ID: ${conversationId}`);
                }

                // Delete existing messages
                await this.botDb.run(
                    'DELETE FROM conversation_messages WHERE conversation_id = ?',
                    [conversationId]
                );

                // Sort messages by timestamp in ascending order (oldest first)
                const sortedMessages = [...messages].sort((a, b) => {
                    const timeA = new Date(a.timestamp || 0).getTime();
                    const timeB = new Date(b.timestamp || 0).getTime();
                    return timeA - timeB;
                });

                // Use bulk insert for better performance
                await this.bulkInsertMessages(conversationId, sortedMessages, methodName);

                // Verify messages were inserted correctly
                await this.verifyMessages(conversationId, sortedMessages, methodName);

                // All operations successful, commit the transaction
                await this.botDb.run('COMMIT');

                logInfo(methodName, 'Conversation updated successfully:', {
                    conversationId,
                    userId,
                    messageCount: messages.length
                });

            } catch (error) {
                // Any error during the process, rollback everything
                await this.botDb.run('ROLLBACK');

                // Enhance error message based on error type
                let errorMessage = 'Failed to update conversation';
                if (error instanceof Error) {
                    if (error.message.includes('not found')) {
                        errorMessage = `Conversation ${conversationId} not found`;
                    } else if (error.message.includes('access denied')) {
                        errorMessage = `Access denied to conversation ${conversationId}`;
                    } else if (error.message.includes('mismatch')) {
                        errorMessage = `Content verification failed: ${error.message}`;
                    }
                }

                logError(methodName, errorMessage, error as Error, {
                    conversationId,
                    userId,
                    phase: 'transaction',
                    details: {
                        hasError: true,
                        errorType: error instanceof Error ? error.name : typeof error,
                        errorMessage: error instanceof Error ? error.message : String(error)
                    }
                });

                throw new Error(errorMessage);
            }
        } catch (error) {
            logError(methodName, 'Failed to update conversation', error as Error);
            throw error;
        }
    }
    // Add this method to get latest messages efficiently
    public async getLatestMessages(conversationId: string, limit: number = 2): Promise<any[]> {
        if (!this.botDb) throw new Error('Database not initialized');

        try {
            return await this.botDb.all(
                `SELECT * FROM conversation_messages 
                 WHERE conversation_id = ? 
                 ORDER BY timestamp DESC, rowid DESC 
                 LIMIT ?`,
                [conversationId, limit]
            );
        } catch (error) {
            logError('getLatestMessages', 'Failed to get latest messages', error as Error);
            throw error;
        }
    }

    public async saveConversation(
        userId: string,
        title: string,
        messages: Array<{ role: string; content: string; metadata?: any }>,
        options?: {
            description?: string;
            tags?: string[];
            isFavorite?: boolean;
        }
    ): Promise<string> {
        const methodName = 'saveConversation';
        if (!this.botDb) throw new Error('Database not initialized');

        try {
            const conversationId = `conv_${uuidv4()}`;

            // Prepare conversation data
            const description = options?.description || '';
            const tags = options?.tags?.join(',') || '';
            const isFavorite = options?.isFavorite ? 1 : 0;

            logInfo(methodName, 'Saving conversation with metadata:', {
                userId,
                conversationId,
                title,
                description,
                tags,
                isFavorite,
                messageCount: messages.length
            });

            await this.botDb.run(
                `INSERT INTO saved_conversations (
                id, user_id, title, description, tags, is_favorite, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                [
                    conversationId,
                    userId,
                    title,
                    description,
                    tags,
                    isFavorite
                ]
            );

            // Insert messages
            for (const msg of messages) {
                await this.insertConversationMessage(conversationId, msg, methodName);
            }

            logInfo(methodName, 'Conversation saved:', {
                userId,
                conversationId,
                messageCount: messages.length
            });

            return conversationId;
        } catch (error) {
            logError(methodName, 'Error saving conversation:', error as Error);
            throw error;
        }
    }

    public async getSavedConversations(
        userId: string,
        options?: {
            limit?: number;
            offset?: number;
            tag?: string;
            favoritesOnly?: boolean;
        }
    ): Promise<Array<{
        id: string;
        title: string;
        description: string;
        tags: string[];
        createdAt: string;
        updatedAt: string;
        isFavorite: boolean;
        messageCount: number;
    }>> {
        const methodName = 'getSavedConversations';
        if (!this.botDb) throw new Error('Database not initialized');

        try {
            let query = `
            SELECT 
                sc.*,
                COUNT(cm.id) as message_count
            FROM saved_conversations sc
            LEFT JOIN conversation_messages cm ON cm.conversation_id = sc.id
            WHERE sc.user_id = ?
        `;

            const params: any[] = [userId];

            if (options?.tag) {
                query += ` AND sc.tags LIKE ?`;
                params.push(`%${options.tag}%`);
            }

            if (options?.favoritesOnly) {
                query += ` AND sc.is_favorite = 1`;
            }

            query += ` GROUP BY sc.id ORDER BY sc.updated_at DESC`;

            if (options?.limit) {
                query += ` LIMIT ?`;
                params.push(options.limit);

                if (options?.offset) {
                    query += ` OFFSET ?`;
                    params.push(options.offset);
                }
            }

            const conversations = await this.botDb.all(query, params);

            const mappedConversations = conversations.map(conv => {
                const result = {
                    id: conv.id,
                    title: conv.title,
                    description: conv.description || '', // Ensure description is never undefined
                    tags: conv.tags ? this.parseTags(conv.tags) : [],
                    createdAt: conv.created_at,
                    updatedAt: conv.updated_at,
                    isFavorite: !!conv.is_favorite,
                    messageCount: conv.message_count
                };

                logInfo(methodName, 'Mapped conversation:', {
                    id: conv.id,
                    hasDescription: !!conv.description,
                    description: conv.description
                });

                return result;
            });

            return mappedConversations;
        } catch (error) {
            logError(methodName, 'Error getting saved conversations:', error as Error);
            throw error;
        }
    }

    public async getConversationMessages(
        conversationId: string,
        userId: string
    ): Promise<Array<{
        role: string;
        content: string;
        timestamp: string;
        metadata?: any;
    }>> {
        const methodName = 'getConversationMessages';
        if (!this.botDb) throw new Error('Database not initialized');

        try {
            // Verify user owns this conversation
            const conversation = await this.botDb.get(
                'SELECT id FROM saved_conversations WHERE id = ? AND user_id = ?',
                [conversationId, userId]
            );

            if (!conversation) {
                throw new Error('Conversation not found or access denied');
            }

            // Get messages in chronological order (oldest first)
            const messages = await this.botDb.all(
                `SELECT role, content, timestamp, metadata, rowid
                 FROM conversation_messages
                 WHERE conversation_id = ?
                 ORDER BY 
                    CASE 
                        WHEN timestamp LIKE '%T%Z' THEN 
                            strftime('%s', substr(timestamp, 1, 19))
                        WHEN timestamp LIKE '%+%' THEN 
                            strftime('%s', substr(timestamp, 1, 19))
                        ELSE 
                            strftime('%s', timestamp)
                    END ASC`,
                [conversationId]
            );

            logInfo(methodName, 'Retrieved messages:', {
                conversationId,
                count: messages.length,
                timestamps: messages.map(m => ({
                    timestamp: m.timestamp,
                    rowid: m.rowid,
                    preview: (m.content || '').substring(0, 50)
                }))
            });

            // Process messages while maintaining order
            const processedMessages = messages.map(msg => {
                // Parse metadata if it exists
                let metadata = undefined;
                try {
                    metadata = msg.metadata ? JSON.parse(msg.metadata) : undefined;
                } catch (error) {
                    logError(methodName, 'Error parsing message metadata:', error as Error);
                }

                // Ensure proper newline handling
                const content = msg.content || '';

                logInfo(methodName, 'Processing message:', {
                    role: msg.role,
                    timestamp: msg.timestamp,
                    rowid: msg.rowid,
                    contentLength: content.length,
                    hasNewlines: content.includes('\n'),
                    preview: content.substring(0, 50)
                });

                // Preserve original timestamp
                return {
                    role: msg.role,
                    content: content,
                    timestamp: msg.timestamp,
                    metadata
                };
            });

            logInfo(methodName, 'Final message order:', {
                conversationId,
                messageOrder: processedMessages.map(m => ({
                    timestamp: m.timestamp,
                    preview: m.content.substring(0, 50)
                }))
            });

            return processedMessages;
        } catch (error) {
            logError(methodName, 'Error getting conversation messages:', error as Error);
            throw error;
        }
    }

    public async getConversationCount(userId: string): Promise<number> {
        const methodName = 'getConversationCount';
        if (!this.botDb) throw new Error('Database not initialized');

        try {
            const result = await this.botDb.get(
                'SELECT COUNT(*) as count FROM saved_conversations WHERE user_id = ?',
                [userId]
            );
            return result?.count || 0;
        } catch (error) {
            logError(methodName, 'Error getting conversation count:', error as Error);
            return 0;
        }
    }

    public async deleteOldConversations(ageInMs: number): Promise<number> {
        const methodName = 'deleteOldConversations';
        if (!this.botDb) throw new Error('Database not initialized');

        try {
            const cutoffDate = new Date(Date.now() - ageInMs).toISOString();
            const result = await this.botDb.run(
                'DELETE FROM saved_conversations WHERE updated_at < ?',
                [cutoffDate]
            );
            return result?.changes || 0;
        } catch (error) {
            logError(methodName, 'Error deleting old conversations:', error as Error);
            return 0;
        }
    }
    public async getRateLimit(key: string): Promise<number> {
        const methodName = 'getRateLimit';
        if (!this.botDb) throw new Error('Database not initialized');

        try {
            // Get rate limit from the last hour
            const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
            const result = await this.botDb.get(
                `SELECT COUNT(*) as count 
                 FROM rate_limits 
                 WHERE key = ? AND timestamp > ?`,
                [key, hourAgo]
            );
            return result?.count || 0;
        } catch (error) {
            logError(methodName, 'Error getting rate limit:', error as Error);
            return 0;
        }
    }
    public async cleanupRateLimits(ageInMs: number): Promise<number> {
        const methodName = 'cleanupRateLimits';
        if (!this.botDb) throw new Error('Database not initialized');

        try {
            const cutoffDate = new Date(Date.now() - ageInMs).toISOString();
            const result = await this.botDb.run(
                'DELETE FROM rate_limits WHERE timestamp < ?',
                [cutoffDate]
            );
            return result?.changes || 0;
        } catch (error) {
            logError(methodName, 'Error cleaning up rate limits:', error as Error);
            return 0;
        }
    }
    private async bulkInsertMessages(
        conversationId: string,
        messages: any[],
        methodName: string
    ): Promise<void> {
        if (!this.botDb) throw new Error('Database not initialized');

        // Create parameterized query with multiple value sets
        const placeholders = messages.map(() => '(?, ?, ?, ?, ?)').join(',');
        const query = `
            INSERT INTO conversation_messages (id, conversation_id, role, content, timestamp)
            VALUES ${placeholders}
        `;

        // Flatten message data into array of parameters
        const params = messages.flatMap(msg => [
            `msg_${uuidv4()}`,
            conversationId,
            msg.role || 'user',
            msg.content || msg.message || '',
            this.normalizeTimestamp(msg.timestamp)
        ]);

        try {
            await this.botDb.run(query, params);

            logInfo(methodName, 'Bulk insert completed:', {
                conversationId,
                messageCount: messages.length
            });
        } catch (error) {
            logError(methodName, 'Bulk insert failed:', error as Error, {
                conversationId,
                messageCount: messages.length
            });
            throw error;
        }
    }

    private normalizeTimestamp(timestamp: string): string {
        try {
            if (!timestamp) {
                return new Date().toISOString();
            }
            // Handle both ISO and regular format
            const date = new Date(timestamp);
            // Always store in ISO format for consistency
            return date.toISOString();
        } catch {
            // If parsing fails, return current time
            return new Date().toISOString();
        }
    }
    private async verifyMessages(
        conversationId: string,
        originalMessages: any[],
        methodName: string
    ): Promise<void> {
        const insertedMessages = await this.botDb!.all(
            `SELECT * FROM conversation_messages 
             WHERE conversation_id = ? 
             ORDER BY 
                CASE 
                    WHEN timestamp LIKE '%T%Z' THEN strftime('%s', substr(timestamp, 1, 19))
                    ELSE strftime('%s', timestamp)
                END ASC`,
            [conversationId]
        );

        if (insertedMessages.length !== originalMessages.length) {
            throw new Error(`Message count mismatch: expected ${originalMessages.length}, got ${insertedMessages.length}`);
        }

        // Verify content matches
        for (let i = 0; i < originalMessages.length; i++) {
            const original = originalMessages[i];
            const inserted = insertedMessages[i];

            const originalContent = original.content || original.message || '';
            const insertedContent = inserted.content || '';

            if (originalContent !== insertedContent) {
                throw new Error(`Content mismatch at position ${i}`);
            }
        }
    }
    async updateAndGetConversation(
        conversationId: string,
        userId: string,
        messages: ConversationMessage[],
        options: Partial<SavedConversation>
    ): Promise<SavedConversation & { messages: ConversationMessage[] }> {
        await this.updateConversation(conversationId, userId, messages, options);
        return this.getConversationById(conversationId, userId);
    }
    
    // Add this method to DatabaseService class
    public async getActiveSessions(limit: number = 100): Promise<SessionInfo[]> {
        const methodName = 'getActiveSessions';
        if (!this.botDb) throw new Error('Database not initialized');

        try {
            const query = `
            SELECT id, user_id as userId, type, source, chat_id, status
            FROM sessions 
            WHERE status = 'active'
            ORDER BY last_active DESC
            LIMIT ?
        `;

            const sessions = await this.botDb.all(query, [limit]);

            logInfo(methodName, `Retrieved ${sessions.length} active sessions`);

            return sessions.map(session => ({
                id: session.id,
                userId: session.userId,
                sessionId: session.id,
                type: session.type as 'private' | 'group',
                source: session.source as 'telegram' | 'flowise' | 'webapp',
                chat_id: session.chat_id,
                status: session.status,
                created_at: '',     // Default values for required fields
                last_active: '',
                expires_at: '',
                auth: {             // Default auth object
                    type: session.source || 'telegram',
                    id: session.userId,
                    username: ''
                }
            }));
        } catch (error) {
            logError(methodName, 'Error retrieving active sessions', error as Error);
            return [];
        }
    }
    // Add methods for user management, chat history, etc.

}
