// AccountManager.ts

import { ICommonObject, IMessage as FlowiseIMessage } from '../../../src/Interface';
import { BaseRetriever } from '@langchain/core/retrievers';
import { logInfo, logError, logWarn } from './loggingUtility';
import { ConversationManager } from './ConversationManager';
import { DatabaseService } from './services/DatabaseService';
import { AuthService } from './services/AuthService';
import { ContextAdapter } from './ContextAdapter';
import {
    UserAccount,
    UserStats,
    TokenUsage,
    AuthRequest,
    TelegramAuthData,
    WalletAuthData
} from './commands/types';
import {
    AUTH_TYPES,
    SUBSCRIPTION_TIERS,
    type AuthType,
    type SubscriptionTier,
    type CreateUserDTO,
    type UserData
} from './services/DatabaseService';

export class AccountManager {
    private databaseService: DatabaseService;
    private defaultTokenQuota: number;
    private flowId: string;
    private conversationManager: ConversationManager;
    private readonly DEFAULT_TOKEN_QUOTA = 10000; // Default monthly token quota for free tier
    private authService: AuthService;  // Add AuthService

    constructor(
        databaseService: DatabaseService,
        conversationManager: ConversationManager,
        flowId: string,
        defaultTokenQuota: number = 25000,
        authService: AuthService  // Add to constructor
    ) {
        this.databaseService = databaseService;
        this.flowId = flowId;
        this.conversationManager = conversationManager;
        this.defaultTokenQuota = defaultTokenQuota;
        this.authService = authService;

        logInfo('AccountManager', `Initialized with flowId: ${flowId}`);
    }

    async processFlowiseRequest(userId: string, input: string, sessionId: string): Promise<any> {
        const flowiseRequest = {
            chatflowId: this.flowId,
            message: input,
            userId: userId,
            sessionId: sessionId,
            source: 'flowise',
        };

        return await this.databaseService.processFlowiseRequest({
            userId,
            sessionId,
            input,
            flowiseRequest
        });
    }

    // Update handleWebRequest to use this method
    async handleWebRequest(userId: string, requestData: any): Promise<any> {
        const userAccount = await this.databaseService.getUserById(userId);
        if (!userAccount) {
            throw new Error('User not found');
        }

        if (userAccount.token_usage >= userAccount.token_quota) {
            return {
                error: 'TOKEN_LIMIT_EXCEEDED',
                quota: userAccount.token_quota,
                usage: userAccount.token_usage
            };
        }

        const response = await this.processFlowiseRequest(
            userId,
            requestData.input,
            requestData.sessionId
        );

        await this.databaseService.logFlowiseInteraction({
            userId,
            sessionId: requestData.sessionId,
            flowiseResponse: response,
            tokenUsage: this.calculateTokenUsage(response.text || response.content || '')
        });

        return response;
    }

    /**
      * Validates message processing request and checks token availability
      */
    public async validateMessageRequest(
        userId: string,
        input: string,
        source: string,
        auth?: { type: string; id: string }
    ): Promise<{
        isValid: boolean;
        error?: string;
        metadata?: any;
    }> {
        const methodName = 'validateMessageRequest';
        logInfo(methodName, 'Validating request:', {
            userId,
            source,
            hasAuth: !!auth,
            authType: auth?.type
        });
        // Skip auth validation for flowise source
        if (source === 'flowise') {
            return {
                isValid: true,
                metadata: {
                    source: 'flowise',
                    requiresAuth: false
                }
            };
        }
        // Handle Telegram and webapp authenticated sessions
        if (auth?.type === AUTH_TYPES.TELEGRAM || source === 'webapp') {
            const normalizedUserId = await this.databaseService.normalizeUserId(
                userId,
                AUTH_TYPES.TELEGRAM
            );
            const user = await this.databaseService.getUserById(normalizedUserId);

            logInfo(methodName, 'Auth validation:', {
                normalizedUserId,
                userFound: !!user,
                source,
                authType: auth?.type
            });

            if (!user) {
                return {
                    isValid: false,
                    error: 'Authentication required',
                    metadata: { requireAuth: true }
                };
            }

            return { isValid: true };
        }

        // Only validate non-Telegram requests
        if (source === 'telegram') {
            return { isValid: true };
        }

        // For other sources (flowise), check user stats
        const userStats = await this.getUserStats(userId);
        if (!userStats) {
            return {
                isValid: false,
                error: 'Authentication required',
                metadata: { requireAuth: true }
            };
        }

        const estimatedTokens = this.estimateTokens(input);
        const tokenCheck = await this.checkTokenAvailability(userId, estimatedTokens);

        if (!tokenCheck.hasTokens) {
            return {
                isValid: false,
                error: this.getInsufficientTokensMessage(tokenCheck.tokenUsage),
                metadata: {
                    requireUpgrade: true,
                    ...tokenCheck.tokenUsage
                }
            };
        }

        return { isValid: true };
    }
    /**
     * Check if user has sufficient tokens for estimated usage
     */
    public async checkTokenAvailability(
        userId: string,
        estimatedTokens: number
    ): Promise<{
        hasTokens: boolean;
        tokenUsage?: TokenUsage;
        error?: string;
    }> {
        const methodName = 'checkTokenAvailability';

        try {
            const user = await this.databaseService.getUserById(userId);
            if (!user) {
                return { hasTokens: false, error: 'User account not found' };
            }

            const stats = await this.getUserStats(userId);
            if (!stats) {
                return { hasTokens: false, error: 'Failed to retrieve user stats' };
            }

            const hasEnoughTokens = stats.available_tokens >= estimatedTokens;

            return {
                hasTokens: hasEnoughTokens,
                tokenUsage: {
                    total_tokens: stats.total_tokens,
                    available_tokens: stats.available_tokens,
                    token_usage: stats.token_usage,
                    next_reset_date: stats.next_reset_date,
                    subscription_tier: stats.subscription_tier
                }
            };

        } catch (error) {
            logError(methodName, `Error checking tokens`, error as Error);
            return { hasTokens: false, error: 'Error checking token availability' };
        }
    }

    /**
  * Get user statistics including token usage
  */
    public async getUserStats(userId: string): Promise<UserStats | null> {
        const methodName = 'getUserStats';

        try {
            if (!this.databaseService) {
                logWarn(methodName, 'Database service not initialized');
                return null;
            }

            // Skip stats for flowise users
            if (userId.startsWith('flowise_')) {
                logInfo(methodName, 'Skipping stats for flowise user:', { userId });
                return null;
            }

            const userRecord = await this.databaseService.getUserById(userId);
            if (!userRecord) {
                logWarn(methodName, 'User not found:', { userId });
                return null;
            }

            const stats = await this.databaseService.getStatsForUser(userId);
            if (!stats) {
                // Create default stats if none exist
                return {
                    id: userId,
                    subscription_tier: 'free',
                    token_quota: userRecord.token_quota || 25000,
                    token_usage: 0,
                    total_tokens: 0,
                    total_messages: 0,
                    available_tokens: userRecord.token_quota || 25000,
                    last_reset: new Date(),
                    next_reset_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
                    last_active: new Date(),
                    active_sessions: 0,
                    telegram_username: userRecord.telegram_username
                };
            }

            return {
                id: stats.id,
                subscription_tier: stats.subscription_tier,
                token_quota: userRecord.token_quota,
                token_usage: stats.token_usage,
                total_tokens: stats.total_tokens,
                total_messages: stats.total_messages,
                available_tokens: stats.available_tokens,
                last_reset: new Date(stats.last_reset),
                next_reset_date: stats.next_reset_date ? new Date(stats.next_reset_date) : null,
                last_active: new Date(stats.last_active),
                active_sessions: stats.active_sessions,
                telegram_username: stats.telegram_username
            };
        } catch (error) {
            logError(methodName, `Error getting user stats`, error as Error);
            return null;
        }
    }

    public async updateTokenUsageFromText(
        userId: string,
        outputText: string,
        source: string,
        options?: {
            inputText?: string;
        }
    ): Promise<{ tokenRefreshed: boolean }> {
        const methodName = 'updateTokenUsageFromText';
        try {
            if (source === 'flowise' || userId.startsWith('flowise_')) {
                logInfo(methodName, 'Skipping token usage update for flowise user:', {
                    userId,
                    source
                });
                return { tokenRefreshed: false };
            }

            // Count both input and output tokens
            const outputTokens = this.calculateTokenCount(outputText);
            const inputTokens = options?.inputText ? 
                this.calculateTokenCount(options.inputText, true) : 0;
            const totalTokens = outputTokens + inputTokens;

            logInfo(methodName, 'Token calculation:', {
                inputTokens,
                outputTokens,
                totalTokens,
                inputLength: options?.inputText?.length,
                outputLength: outputText.length
            });

            await this.updateTokenUsage(userId, totalTokens, source);

            // Refresh token for webapp users if token is valid
            if (source === 'webapp') {
                const normalizedUserId = await this.databaseService.normalizeUserId(userId, AUTH_TYPES.TELEGRAM);
                const tokenRefreshed = await this.authService.refreshAuthToken(normalizedUserId);

                logInfo(methodName, 'Token refresh attempt for webapp user:', {
                    userId: normalizedUserId,
                    tokenRefreshed
                });

                return { tokenRefreshed };
            }

            return { tokenRefreshed: false };
        } catch (error) {
            logError(methodName, 'Error in token usage update:', error as Error);
            return { tokenRefreshed: false };
        }
    }

    
    public async updateTokenUsage(
        userId: string,
        tokenCount: number,
        source: string
    ): Promise<void> {
        const methodName = 'updateTokenUsage';
        try {
            // Skip token tracking for flowise users
            if (source === 'flowise' || userId.startsWith('flowise_')) {
                logInfo(methodName, 'Skipping token usage update for flowise user:', {
                    userId,
                    tokenCount,
                    source
                });
                return;
            }
    
            // Normalize userId for telegram/webapp sources
            const normalizedUserId = (source === 'telegram' || source === 'webapp') ?
                await this.databaseService.normalizeUserId(userId, AUTH_TYPES.TELEGRAM) :
                userId;
    
            // Get current stats first
            const currentStats = await this.getUserStats(normalizedUserId);
    
            if (!currentStats) {
                logError(methodName, 'User stats not found:', { userId: normalizedUserId });
                return;
            }
    
            // Calculate new usage
            const currentUsage = currentStats.token_usage || 0;
            const newUsage = currentUsage + tokenCount;
            const quota = 25000; // Fixed quota for free tier
            const remaining = Math.max(0, quota - newUsage);
    
            // Update database with new totals
            await this.databaseService.updateUserStats(normalizedUserId, {
                token_usage: newUsage,
                total_messages: (currentStats.total_messages || 0) + 1,
                token_quota: quota  // Ensure quota is set
            });
    
            // Log the update
            logInfo(methodName, 'Token usage updated:', {
                userId: normalizedUserId,
                previousUsage: currentUsage,
                tokenCount,
                newUsage,
                quota,
                remaining
            });
    
            // Get updated stats to verify
            const updatedStats = await this.getUserStats(normalizedUserId);
            if (updatedStats) {
                logInfo(methodName, 'Token usage verified:', {
                    userId: normalizedUserId,
                    finalUsage: updatedStats.token_usage,
                    finalQuota: updatedStats.token_quota,
                    finalRemaining: Math.max(0, quota - (updatedStats.token_usage || 0))
                });
            }
    
        } catch (error) {
            logError(methodName, 'Error updating token usage:', error as Error);
            throw error;
        }
    }
    public calculateTokenCount(text: string, isInput: boolean = false): number {
        const methodName = 'calculateTokenCount';
        
        let tokenCount = 0;
        
        // Count emoji (they use more tokens)
        const emojiCount = (text.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
        tokenCount += emojiCount * 3;
        
        // Remove emoji from text for regular counting
        const textWithoutEmoji = text.replace(/[\u{1F300}-\u{1F9FF}]/gu, '');
        
        // Count code blocks (they use more tokens)
        const codeBlocks = textWithoutEmoji.match(/```[\s\S]*?```/g) || [];
        let codeLength = 0;
        codeBlocks.forEach(block => {
            codeLength += block.length;
            tokenCount += Math.ceil(block.length / 3);
        });
        
        // Remove code blocks for regular text counting
        const regularText = textWithoutEmoji.replace(/```[\s\S]*?```/g, '');
        
        // Count URLs (they use more tokens)
        const urls = regularText.match(/https?:\/\/[^\s]+/g) || [];
        let urlLength = 0;
        urls.forEach(url => {
            urlLength += url.length;
            tokenCount += Math.ceil(url.length / 2);
        });
        
        // Regular text counting
        const remainingLength = regularText.length - urlLength;
        tokenCount += Math.ceil(remainingLength / 4);
        
        // Add overhead for input messages
        if (isInput) {
            tokenCount = Math.ceil(tokenCount * 1.2);
        }
        
        logInfo(methodName, 'Token calculation:', {
            totalTokens: tokenCount,
            textLength: text.length,
            emojiCount,
            codeBlocksCount: codeBlocks.length,
            urlsCount: urls.length,
            isInput
        });
        
        return tokenCount;
    }
    // Utility methods
    private estimateTokens(input: string): number {
        return Math.ceil(input.length / 4);
    }

    public calculateTokenUsage(response: string): number {
        return Math.ceil(response.length / 4);
    }

    private getInsufficientTokensMessage(tokenUsage?: TokenUsage): string {
        return tokenUsage?.next_reset_date
            ? `Insufficient tokens. Your tokens will reset on ${new Date(tokenUsage.next_reset_date).toLocaleDateString()}.`
            : 'Insufficient tokens. Please upgrade to Flex tier to purchase more tokens.';
    }

    // Type guards
    private isTelegramAuthData(data: any): data is TelegramAuthData {
        return 'id' in data && 'username' in data;
    }

    private isWalletAuthData(data: any): data is WalletAuthData {
        return 'address' in data && 'signature' in data;
    }

    private isValidAuthTimestamp(timestamp: number): boolean {
        return Date.now() - timestamp <= 300000; // 5 minutes expiry
    }

    // Private helper methods
    private async validateAndGetUserId(authData: AuthRequest): Promise<string> {
        if (this.isTelegramAuthData(authData.data)) {
            await this.validateTelegramAuth(authData.data);
            return `tg_${authData.data.id}`;
        } else if (this.isWalletAuthData(authData.data)) {
            await this.validateWalletAuth(authData.data);
            return `wallet_${authData.data.address.toLowerCase()}`;
        }
        throw new Error('Invalid authentication data');
    }

    private async validateTelegramAuth(authData: TelegramAuthData): Promise<void> {
        // Implement Telegram-specific validation
        // Verify hash, check timestamps, etc.
    }

    private async validateWalletAuth(authData: WalletAuthData): Promise<void> {
        // Implement wallet-specific validation
        // Verify signature, check chainId, etc.
    }
}
