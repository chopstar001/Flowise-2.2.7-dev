// QuestionAnalyzer.ts
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { SystemMessage, HumanMessage, AIMessage, BaseMessage } from '@langchain/core/messages';
import { invokeModelWithFallback } from './utils/modelUtility';
import { MessageContext, GroupMemberInfo } from './commands/types';
import { logInfo, logDebug, logError, logWarn } from './loggingUtility';
import { ConversationManager } from './ConversationManager';

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
    isOngoing: boolean;         // Whether the bot is already in an active conversation
    lastBotMessageTimestamp: number;  // When the bot last sent a message
    recentMessages: number;     // Number of messages in the last N minutes
    recentMentions: number;     // How many times the bot was mentioned recently
    lastUserIds: string[];      // The last few users who participated
}

interface CacheStats {
    hits: number;
    misses: number;
    size: number;
    lastCleanup: number;
}

interface CachedAnalysis {
    result: QuestionAnalysisResult;
    timestamp: number;
    usageCount: number;
    lastUsed: number;
}

interface GroupContextData {
    recentQuestions: {
        message: string;
        result: QuestionAnalysisResult;
        timestamp: number;
    }[];
    conversationSummary?: {
        text: string;
        timestamp: number;
        messages: number;
    };
    lastActivity: number;
}

export class QuestionAnalyzer {
    private conversationManager: ConversationManager | null;
    private summationModel: BaseChatModel;
    private chatModel: BaseChatModel;
    private spModel: BaseChatModel;
    private utilityModel: BaseChatModel;
    private flowId: string;
    private cache: Map<string, CachedAnalysis> = new Map();
    private cacheStats: CacheStats = {
        hits: 0,
        misses: 0,
        size: 0,
        lastCleanup: Date.now()
    };
    private readonly CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
    private readonly CACHE_CLEANUP_INTERVAL = 15 * 60 * 1000; // 15 minutes
    private readonly MAX_CACHE_SIZE = 1000; // Maximum items to store
    private readonly CONVERSATION_TIMEOUT = 5 * 60 * 1000; // 5 minutes

    // Track active conversations per chat
    private conversationTracker: Map<string, ConversationContext> = new Map();

    private groupContexts: Map<string, GroupContextData> = new Map();
    private readonly MAX_GROUP_QUESTIONS = 10;
    private readonly SUMMARY_THRESHOLD = 50; // Messages before offering summary
    private readonly SUMMARY_EXPIRY = 60 * 60 * 1000; // 1 hour


    constructor(
        utilityModel: BaseChatModel, 
        summationModel: BaseChatModel, 
        chatModel: BaseChatModel,
        spModel: BaseChatModel,
        flowId: string,
        conversationManager?: ConversationManager | null
    ) {
        this.utilityModel = utilityModel;
        this.summationModel = summationModel;
        this.chatModel = chatModel;
        this.spModel = spModel;
        this.flowId = flowId;
        this.conversationManager = conversationManager || null;
    }
    public setConversationManager(conversationManager: ConversationManager) {
        this.conversationManager = conversationManager;
    }

    /**
     * Updates the conversation context for a specific chat
     */
    public updateConversationContext(
        chatId: string,
        userId: string,
        isBotMessage: boolean,
        botMentioned: boolean = false
    ): void {
        const now = Date.now();
        let context = this.conversationTracker.get(chatId);

        if (!context) {
            context = {
                isOngoing: false,
                lastBotMessageTimestamp: 0,
                recentMessages: 0,
                recentMentions: 0,
                lastUserIds: []
            };
        }

        // Update timestamps and counters
        if (isBotMessage) {
            context.lastBotMessageTimestamp = now;
            context.isOngoing = true;
        }

        // Add user to recent participants if not already there
        if (!context.lastUserIds.includes(userId)) {
            context.lastUserIds.unshift(userId);
            context.lastUserIds = context.lastUserIds.slice(0, 5); // Keep last 5 users
        }

        // Increment counters
        context.recentMessages++;
        if (botMentioned) {
            context.recentMentions++;
        }

        // Check if conversation should be considered ongoing
        const isTimedOut = (now - context.lastBotMessageTimestamp) > this.CONVERSATION_TIMEOUT;
        context.isOngoing = !isTimedOut && context.isOngoing;

        this.conversationTracker.set(chatId, context);
    }

    /**
     * Gets the conversation context for a chat
     */
    public getConversationContext(chatId: string): ConversationContext {
        return this.conversationTracker.get(chatId) || {
            isOngoing: false,
            lastBotMessageTimestamp: 0,
            recentMessages: 0,
            recentMentions: 0,
            lastUserIds: []
        };
    }

    /**
     * Analyzes a message to determine if it's a question and how the bot should respond,
     * taking into account the current conversation context
     */
    public async analyzeQuestion(
        message: string,
        context: MessageContext,
        chatHistory: BaseMessage[] = [],
        groupMembers?: Map<number, GroupMemberInfo>
    ): Promise<QuestionAnalysisResult> {
        const methodName = 'analyzeQuestion';

        // Apply pre-filtering to skip obvious non-questions
        if (this.shouldSkipAnalysis(message, context)) {
            logDebug(methodName, 'Skipping analysis - pre-filter detected non-question content');
            return this.getFallbackQuestionAnalysis(message, this.getConversationContext(context.chatId.toString()));
        }

        // Even if it's not a question, check if it's suitable for pattern processing
        if (message.length > 500) {
            logInfo(methodName, `Message Length: ${message.length}`);
            if (!this.conversationManager) {
                logWarn(methodName, "ConversationManager not intitilised", "");
            }
            // Add null check before calling shouldSuggestPattern
            if (this.conversationManager) {
                try {
                    const shouldSuggestPattern = await this.conversationManager.shouldSuggestPattern(
                        message, 'statement', context
                    );

                    if (shouldSuggestPattern) {
                        // Adjust the analysis result to recommend pattern processing
                        return {
                            isQuestion: false,
                            confidence: 0.8,
                            possibleTargets: [],
                            sensitivity: 'low',
                            knowledgeRequired: 'general',
                            recommendedAction: 'offer_help', // This will get the bot to respond
                            requiresRagMode: false,
                            reasoning: 'Content appears suitable for pattern-based processing'
                        };
                    }
                } catch (error) {
                    console.warn(`[analyzeQuestionProgressively] Error checking pattern suggestion:`, error);
                    // Continue with normal analysis if pattern check fails
                }
            }
        }
        // Get chatId for group context
        const chatId = context.chatId.toString();

        // Check for similar questions in group context first
        const similarQuestion = this.findSimilarQuestion(chatId, message);
        if (similarQuestion) {
            logInfo(methodName, 'Found similar question in group context', {
                question: message,
                chatId
            });
            return similarQuestion;
        }

        // Create a cache key based on the message
        const cacheKey = `question_analysis:${Buffer.from(message).toString('base64').substring(0, 40)}`;

        // Check cache first (but only use cache if we don't have recent chat history)
        const cachedResult = chatHistory.length === 0 ? this.getCachedAnalysis(cacheKey) : null;
        if (cachedResult) {
            logDebug(methodName, 'Using cached analysis result');
            return cachedResult;
        }

        try {
            // Get conversation context
            const conversationContext = this.getConversationContext(chatId);

            // Extract recent chat messages for context
            const lastMessages = chatHistory.slice(-5).map(msg => {
                const role = msg.getType() === 'human' ? 'User' : 'Bot';
                const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
                return `${role}: ${content}`;
            }).join('\n');

            // Prepare list of group members if available
            let membersContext = '';
            if (groupMembers && groupMembers.size > 0) {
                membersContext = 'Group members:\n' +
                    Array.from(groupMembers.entries())
                        .map(([id, info]) => `- ${info.first_name || 'Unknown'} (${info.is_bot ? 'Bot' : 'Human'})`)
                        .join('\n');
            }

            // Create the analysis prompt
            const systemPrompt = new SystemMessage(
                `You are analyzing a message from a group chat to determine if it's a question and how a bot should respond.
                Take a deep breath and think step by step to provide a structured analysis in valid JSON format with these fields:
                {
                  "isQuestion": boolean,
                  "confidence": number (0.0-1.0),
                  "possibleTargets": string[] (empty if not directed at anyone specific),
                  "sensitivity": "low"|"medium"|"high" (how sensitive/personal the topic is),
                  "knowledgeRequired": "general"|"specific"|"personal" (what kind of knowledge is needed),
                  "recommendedAction": "answer"|"offer_help"|"stay_silent"|"continue_conversation",
                  "requiresRagMode": boolean (if answering requires searching documentation),
                  "reasoning": string (brief explanation)
                }
                
                Guidelines:
                - If we're already in an ongoing conversation, the bot should continue engaging ("continue_conversation")
                - If the message is clearly part of an ongoing discussion with the bot, use "answer" directly
                - If it's a new question not in a conversation with the bot, but it's appropriate for the bot, use "offer_help"
                - The bot should NOT interject when a question is clearly directed at someone else
                - For very personal questions, the bot should stay silent
                - For general knowledge questions not directed at anyone, the bot can offer help
                - If message isn't a question, all fields except isQuestion and confidence should still be filled in
                - If unsure or the message seems ambiguous or unclear then the bot should stay silent ("stay_silent")
                - Important! Your response must be valid JSON, nothing else.`
            );

            const userPrompt = new HumanMessage(
                `Analyze this message from a group chat:
                "${message}"
                
                ${lastMessages ? `Recent conversation:\n${lastMessages}\n\n` : ''}
                ${membersContext ? `${membersContext}\n\n` : ''}
                
                Conversation context:
                - Ongoing conversation with bot: ${conversationContext.isOngoing ? 'Yes' : 'No'}
                - Time since bot's last message: ${Math.floor((Date.now() - conversationContext.lastBotMessageTimestamp) / 1000)} seconds
                - Recent messages in chat: ${conversationContext.recentMessages}
                - Recent bot mentions: ${conversationContext.recentMentions}
                
                Respond with valid JSON only.`
            );

            // Enhanced retry logic for model invocation
            let responseContent: string;
            let retryCount = 0;
            const MAX_RETRIES = 3;
            let result: QuestionAnalysisResult | null = null;

            while (retryCount < MAX_RETRIES && result === null) {
                try {
                    // Invoke the utility model
                    const response: AIMessage = await invokeModelWithFallback(
                        this.spModel,
                        this.spModel, // Fallback to same model as primary
                        this.utilityModel,
                        [systemPrompt, userPrompt],
                        { initialTimeout: 30000, maxTimeout: 70000, retries: 2 }
                    );

                    // Parse the JSON response
                    responseContent = response.content as string;

                    // Use our optimized JSON extraction
                    responseContent = this.extractJsonFromResponse(responseContent);

                    try {
                        // Attempt to parse the JSON response
                        const parsedResult = JSON.parse(responseContent);

                        // Validate required fields are present and of correct type
                        if (
                            typeof parsedResult.isQuestion === 'boolean' &&
                            typeof parsedResult.confidence === 'number' &&
                            Array.isArray(parsedResult.possibleTargets) &&
                            ['low', 'medium', 'high'].includes(parsedResult.sensitivity) &&
                            ['general', 'specific', 'personal'].includes(parsedResult.knowledgeRequired) &&
                            ['answer', 'offer_help', 'stay_silent', 'continue_conversation'].includes(parsedResult.recommendedAction) &&
                            typeof parsedResult.requiresRagMode === 'boolean' &&
                            typeof parsedResult.reasoning === 'string'
                        ) {
                            // All required fields present and valid
                            result = parsedResult;
                            break;
                        } else {
                            // Missing or invalid fields
                            logInfo(methodName, 'Parsed result missing required fields or has invalid types, retrying', {
                                retryCount,
                                parsedResult
                            });
                            retryCount++;
                        }
                    } catch (parseError) {
                        logInfo(methodName, 'Error parsing JSON response, retrying', {
                            retryCount,
                            error: parseError,
                            responsePreview: responseContent.substring(0, 100)
                        });
                        retryCount++;
                    }
                } catch (apiError) {
                    // API call error
                    logError(methodName, 'Error calling utility model, retrying', apiError as Error);
                    retryCount++;

                    // Add exponential backoff
                    await new Promise(resolve => setTimeout(resolve, Math.min(1000 * Math.pow(2, retryCount), 8000)));
                }
            }

            // If we still don't have a valid result after all retries, use the default fallback
            if (result === null) {
                logInfo(methodName, 'Failed to get valid result after max retries, using fallback');
                result = this.getFallbackQuestionAnalysis(message, conversationContext);
            }

            // Store in both standard cache and group context
            if (chatHistory.length === 0) {
                this.setCachedAnalysis(cacheKey, result);
            }
            this.storeQuestionInGroupContext(chatId, message, result);

            logInfo(methodName, 'Question analysis result', {
                isQuestion: result.isQuestion,
                confidence: result.confidence,
                recommendedAction: result.recommendedAction,
                conversationIsOngoing: conversationContext.isOngoing
            });

            return result;
        } catch (error) {
            logError(methodName, 'Error analyzing question', error as Error);

            // Get conversation context for default fallback logic
            const conversationContext = this.getConversationContext(chatId);

            // Return a default result in case of error
            return this.getFallbackQuestionAnalysis(message, conversationContext);
        }
    }

    // Helper method to get a fallback question analysis
    private getFallbackQuestionAnalysis(message: string, conversationContext: ConversationContext): QuestionAnalysisResult {
        return {
            isQuestion: message.includes('?'),
            confidence: 0.5,
            possibleTargets: [],
            sensitivity: 'low',
            knowledgeRequired: 'general',
            // If we're in an ongoing conversation, continue it
            recommendedAction: conversationContext.isOngoing ? 'continue_conversation' : 'stay_silent',
            requiresRagMode: false,
            reasoning: 'Error in analysis, defaulting based on conversation state'
        };
    }

    /**
 * Enhanced JSON extraction and fixing with prioritized strategies
 */
    private extractJsonFromResponse(response: string): string {
        const methodName = 'extractJsonFromResponse';

        // Define different strategies for extracting valid JSON
        const strategies = [
            // Strategy 1: Find JSON between curly braces
            (text: string): string | null => {
                const jsonStartIdx = text.indexOf('{');
                const jsonEndIdx = text.lastIndexOf('}');

                if (jsonStartIdx >= 0 && jsonEndIdx > jsonStartIdx) {
                    const potentialJson = text.substring(jsonStartIdx, jsonEndIdx + 1);
                    try {
                        JSON.parse(potentialJson); // Validate
                        return potentialJson;
                    } catch (error) {
                        return null;
                    }
                }
                return null;
            },

            // Strategy 2: Find JSON using regex pattern matching
            (text: string): string | null => {
                const jsonRegex = /\{(?:[^{}]|(?:\{[^{}]*\}))*\}/g;
                const matches = text.match(jsonRegex);

                if (matches && matches.length > 0) {
                    // Try each match
                    for (const match of matches) {
                        try {
                            JSON.parse(match); // Validate
                            return match;
                        } catch (error) {
                            continue;
                        }
                    }
                }
                return null;
            },

            // Strategy 3: Basic JSON fix for common issues
            (text: string): string | null => {
                let fixed = text;

                // Replace single quotes with double quotes
                fixed = fixed.replace(/'/g, '"');

                // Fix missing quotes around property names
                fixed = fixed.replace(/(\{|\,)\s*([a-zA-Z0-9_]+)\s*\:/g, '$1"$2":');

                // Fix trailing commas
                fixed = fixed.replace(/,\s*\}/g, '}').replace(/,\s*\]/g, ']');

                try {
                    JSON.parse(fixed); // Validate
                    return fixed;
                } catch (error) {
                    return null;
                }
            },

            // Strategy 4: Advanced JSON fixing for more complex issues
            (text: string): string | null => {
                let fixed = text;

                // Fix missing quotes around string values for known enum fields
                const enumFields = ['sensitivity', 'knowledgeRequired', 'recommendedAction', 'reasoning'];
                for (const field of enumFields) {
                    fixed = fixed.replace(
                        new RegExp(`"${field}"\\s*:\\s*([a-zA-Z_]+)`, 'g'),
                        `"${field}":"$1"`
                    );
                }

                // Fix boolean values
                fixed = fixed.replace(/"(isQuestion|requiresRagMode)"\s*:\s*(true|false)/gi, (match, field, value) => {
                    return `"${field}":${value.toLowerCase()}`;
                });

                try {
                    JSON.parse(fixed); // Validate
                    return fixed;
                } catch (error) {
                    return null;
                }
            }
        ];

        // Try each strategy in order
        for (const strategy of strategies) {
            const result = strategy(response);
            if (result) {
                return result;
            }
        }

        // If all strategies fail, return a fallback
        logWarn(methodName, 'All JSON extraction strategies failed', {
            responsePreview: response.substring(0, 100)
        });

        return this.getFallbackJsonResponse();
    }

    /**
     * Returns a fallback JSON response when all extraction methods fail
     */
    private getFallbackJsonResponse(): string {
        return JSON.stringify({
            isQuestion: false,
            confidence: 0.3,
            possibleTargets: [],
            sensitivity: 'low',
            knowledgeRequired: 'general',
            recommendedAction: 'stay_silent',
            requiresRagMode: false,
            reasoning: 'Failed to parse model response'
        });
    }

    // Enhanced JSON fixing function
    private attemptToFixJson(badJson: string): string {
        try {
            // Step 1: Extract only the text that looks like JSON
            let potentialJson = badJson;

            // If we have opening brace but no closing, add one
            if (potentialJson.includes('{') && !potentialJson.includes('}')) {
                potentialJson += '}';
            }

            // Replace single quotes with double quotes
            potentialJson = potentialJson.replace(/'/g, '"');

            // Fix missing quotes around property names
            potentialJson = potentialJson.replace(/(\{|\,)\s*([a-zA-Z0-9_]+)\s*\:/g, '$1"$2":');

            // Fix trailing commas
            potentialJson = potentialJson.replace(/,\s*\}/g, '}').replace(/,\s*\]/g, ']');

            // Fix missing quotes around string values for known enum fields
            const enumFields = ['sensitivity', 'knowledgeRequired', 'recommendedAction', 'reasoning'];
            for (const field of enumFields) {
                potentialJson = potentialJson.replace(
                    new RegExp(`"${field}"\\s*:\\s*([a-zA-Z_]+)`, 'g'),
                    `"${field}":"$1"`
                );
            }

            // Check if the fixed JSON is valid
            JSON.parse(potentialJson);
            return potentialJson;
        } catch (error) {
            // If we still can't fix it, return a more comprehensive default JSON
            return `{
            "isQuestion": false,
            "confidence": 0.3,
            "possibleTargets": [],
            "sensitivity": "low",
            "knowledgeRequired": "general",
            "recommendedAction": "stay_silent",
            "requiresRagMode": false,
            "reasoning": "Failed to parse model response"
        }`;
        }
    }

    /**
     * Clears the cache
     */
    public clearCache(): void {
        this.cache.clear();
    }

    /**
 * Perform cleanup of expired conversation contexts
 */
    public cleanupExpiredConversations(): void {
        const now = Date.now();

        // Add null check for conversationTracker
        if (!this.conversationTracker || !(this.conversationTracker instanceof Map)) {
            console.log('Cannot clean up conversations: conversationTracker is not initialized');
            return;
        }

        try {
            for (const [chatId, context] of this.conversationTracker.entries()) {
                // Add null check for context properties
                if (context && typeof context.lastBotMessageTimestamp === 'number') {
                    if ((now - context.lastBotMessageTimestamp) > this.CONVERSATION_TIMEOUT) {
                        context.isOngoing = false;
                        this.conversationTracker.set(chatId, context);
                    }
                }
            }
        } catch (error) {
            console.error('Error in cleanupExpiredConversations:', error);
        }
    }
    // Add this method to QuestionAnalyzer class
    private shouldSkipAnalysis(message: string, context: MessageContext): boolean {
        // Skip very short messages
        if (message.length < 5) return true;

        // Skip common acknowledgements and reactions
        const commonResponses = /^(ok|yes|no|thanks|lol|haha|👍|👏|🙏|cool|nice|great|awesome|wow)$/i;
        if (commonResponses.test(message.trim())) return true;

        // Skip commands
        if (message.startsWith('/')) return true;

        // Skip URLs or messages that are primarily URLs
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        const urlMatches = message.match(urlRegex) || [];
        if (urlMatches.length > 0 && urlMatches.join('').length > message.length * 0.7) {
            return true;
        }

        // Skip messages with just emoji
        const emojiOnlyRegex = /^[\u{1F300}-\u{1F6FF}\u{2600}-\u{26FF}\s]+$/u;
        if (emojiOnlyRegex.test(message.trim())) return true;

        // Skip code blocks (likely not questions)
        if (message.includes('```') && message.split('```').length > 2) return true;

        // Skip messages directed at specific users (except the bot)
        const atMentionRegex = /@([a-zA-Z0-9_]+)/g;
        const mentions = message.match(atMentionRegex) || [];
        const botUsername = context.raw?.message?.chat?.username || '';
        if (mentions.length > 0 && !mentions.some(m => m.includes(botUsername))) {
            return true;
        }

        return false;
    }
    // Add these new methods to QuestionAnalyzer class

    /**
     * Progressively analyzes a message with increasing levels of sophistication
     */
    public async analyzeQuestionProgressively(
        message: string,
        context: MessageContext,
        chatHistory: BaseMessage[] = [],
        groupMembers?: Map<number, GroupMemberInfo>
    ): Promise<QuestionAnalysisResult> {
        const methodName = 'analyzeQuestionProgressively';
        logInfo(methodName, 'Entering analyzeQuestionProgressively');

        // Check pre-filter first (already implemented)
        if (this.shouldSkipAnalysis(message, context)) {
            logDebug(methodName, 'Skipping analysis - pre-filter detected non-question content');
            return this.getFallbackQuestionAnalysis(message, this.getConversationContext(context.chatId.toString()));
        }

        // Stage 1: Quick binary classification
        const isLikelyQuestion = await this.quickClassifyQuestion(message);
        logDebug(methodName, `quickClassifyQuestion Result: ${isLikelyQuestion}`);

        // Stage 2: Full analysis for likely questions
        logDebug(methodName, 'Quick classification identified potential question, proceeding with full analysis');
        return this.analyzeQuestion(message, context, chatHistory, groupMembers);
    }

    /**
     * Performs quick binary classification to determine if a message is likely a question
     * Uses heuristics and lightweight approach before expensive LLM call
     */
    private async quickClassifyQuestion(message: string): Promise<boolean> {
        const methodName = 'quickClassifyQuestion';
        logInfo(methodName, 'Entered quickClassifyQuestion');

        // Simple heuristics first
        const questionEnds = message.endsWith('?');
        const questionWords = /(what|where|when|why|how|who|which|can|could|would|should|is|are|am|will|do|does|did|has|have|had)/i;
        const questionWordsPresent = questionWords.test(message.toLowerCase());

        // If it's obviously a question by structure, return true immediately
        if (questionEnds || (questionWordsPresent && message.length < 100)) {
            return true;
        }

        // For more complex cases, use a lightweight model if available
        if (this.utilityModel) {
            try {
                const systemPrompt = new SystemMessage(
                    `You are a binary classifier. Determine if the user's message is a question or request for information.
                 Reply only with "YES" if it's a question or request, or "NO" if it's not.`
                );

                const userPrompt = new HumanMessage(message);

                // Use the smallest model available with short timeout
                const response = await invokeModelWithFallback(
                    this.utilityModel,
                    this.utilityModel,
                    this.utilityModel,
                    [systemPrompt, userPrompt],
                    { initialTimeout: 20000, maxTimeout: 60000, retries: 0 }
                );

                const content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
                return content.toUpperCase().includes('YES');
            }
            catch (error) {
                // On error, rely on basic heuristics
                logWarn('quickClassifyQuestion', 'Error using model for classification', { error });
                return questionWordsPresent || questionEnds;
            }
        }

        // Fallback to heuristics if no model
        return questionWordsPresent || questionEnds;
    }

    /**
     * Returns a default "not a question" result
     */
    private getNotQuestionResult(message: string): QuestionAnalysisResult {
        return {
            isQuestion: false,
            confidence: 0.9, // High confidence it's not a question
            possibleTargets: [],
            sensitivity: 'low',
            knowledgeRequired: 'general',
            recommendedAction: 'stay_silent',
            requiresRagMode: false,
            reasoning: 'Quick classification determined this is not a question'
        };
    }

    /**
 * Gets an item from cache with statistics tracking
 */
    private getCachedAnalysis(key: string): QuestionAnalysisResult | null {
        const cachedItem = this.cache.get(key);

        if (!cachedItem) {
            this.cacheStats.misses++;
            return null;
        }

        const now = Date.now();

        // Check if expired
        if (now - cachedItem.timestamp > this.CACHE_DURATION) {
            this.cache.delete(key);
            this.cacheStats.misses++;
            this.cacheStats.size = this.cache.size;
            return null;
        }

        // Update usage stats
        cachedItem.usageCount++;
        cachedItem.lastUsed = now;
        this.cacheStats.hits++;

        // Maybe run cleanup
        this.maybeRunCacheCleanup();

        return cachedItem.result;
    }

    /**
     * Stores an item in cache with statistics tracking
     */
    private setCachedAnalysis(key: string, result: QuestionAnalysisResult): void {
        // Maybe run cleanup first if cache is getting large
        if (this.cache.size >= this.MAX_CACHE_SIZE * 0.9) {
            this.cleanupCache(true);
        }

        this.cache.set(key, {
            result,
            timestamp: Date.now(),
            usageCount: 1,
            lastUsed: Date.now()
        });

        this.cacheStats.size = this.cache.size;
    }

    /**
     * Runs cache cleanup if it's been a while
     */
    private maybeRunCacheCleanup(): void {
        const now = Date.now();
        if (now - this.cacheStats.lastCleanup > this.CACHE_CLEANUP_INTERVAL) {
            this.cleanupCache();
        }
    }

    /**
     * Cleans up the cache based on age and usage
     */
    private cleanupCache(forceFull: boolean = false): void {
        const now = Date.now();
        this.cacheStats.lastCleanup = now;

        // Always remove expired items
        let removedCount = 0;
        for (const [key, item] of this.cache.entries()) {
            if (now - item.timestamp > this.CACHE_DURATION) {
                this.cache.delete(key);
                removedCount++;
            }
        }

        // If forced or still too many items, remove least used/oldest
        if (forceFull || this.cache.size > this.MAX_CACHE_SIZE * 0.8) {
            // Convert to array for sorting
            const entries = Array.from(this.cache.entries());

            // Sort by usage count and last used time
            entries.sort((a, b) => {
                // Primary sort by usage count
                const usageDiff = a[1].usageCount - b[1].usageCount;
                if (usageDiff !== 0) return usageDiff;

                // Secondary sort by last used time
                return a[1].lastUsed - b[1].lastUsed;
            });

            // Remove the least valuable 20% of entries
            const removeCount = Math.ceil(entries.length * 0.2);
            for (let i = 0; i < removeCount && i < entries.length; i++) {
                this.cache.delete(entries[i][0]);
                removedCount++;
            }
        }

        this.cacheStats.size = this.cache.size;

        logInfo('cleanupCache', `Removed ${removedCount} items from cache`, {
            remainingSize: this.cache.size,
            cacheStats: this.cacheStats
        });
    }

    /**
 * Stores a question analysis in the group context
 */
    private storeQuestionInGroupContext(
        chatId: string,
        message: string,
        result: QuestionAnalysisResult
    ): void {
        // Initialize group context if needed
        if (!this.groupContexts.has(chatId)) {
            this.groupContexts.set(chatId, {
                recentQuestions: [],
                lastActivity: Date.now()
            });
        }

        const context = this.groupContexts.get(chatId)!;

        // Add the new question
        context.recentQuestions.unshift({
            message,
            result,
            timestamp: Date.now()
        });

        // Trim to max length
        if (context.recentQuestions.length > this.MAX_GROUP_QUESTIONS) {
            context.recentQuestions = context.recentQuestions.slice(0, this.MAX_GROUP_QUESTIONS);
        }

        // Update activity timestamp
        context.lastActivity = Date.now();
    }

    /**
     * Checks if a similar question was recently analyzed in the same chat
     */
    private findSimilarQuestion(
        chatId: string,
        message: string
    ): QuestionAnalysisResult | null {
        const context = this.groupContexts.get(chatId);
        if (!context || context.recentQuestions.length === 0) {
            return null;
        }

        // Simple similarity check (can be enhanced with embeddings or other techniques)
        const similarityThreshold = 0.8;
        const messageLower = message.toLowerCase();

        for (const entry of context.recentQuestions) {
            const similarity = this.calculateTextSimilarity(
                messageLower,
                entry.message.toLowerCase()
            );

            if (similarity >= similarityThreshold) {
                logInfo('findSimilarQuestion', `Found similar question with similarity ${similarity.toFixed(2)}`, {
                    original: entry.message,
                    new: message
                });
                return entry.result;
            }
        }

        return null;
    }

    /**
     * Calculates simple text similarity score
     */
    private calculateTextSimilarity(text1: string, text2: string): number {
        // Simple word overlap similarity - can be replaced with better algorithm
        const words1 = new Set(text1.split(/\s+/).filter(w => w.length > 3));
        const words2 = new Set(text2.split(/\s+/).filter(w => w.length > 3));

        if (words1.size === 0 || words2.size === 0) return 0;

        let matches = 0;
        for (const word of words1) {
            if (words2.has(word)) matches++;
        }

        return (2 * matches) / (words1.size + words2.size);
    }

    /**
     * Generates or updates a conversation summary for a group chat
     */
    public async generateGroupChatSummary(
        chatId: string,
        messages: BaseMessage[],
        forceUpdate: boolean = false
    ): Promise<string | null> {
        const methodName = 'generateGroupChatSummary';

        // Get or initialize group context
        if (!this.groupContexts.has(chatId)) {
            this.groupContexts.set(chatId, {
                recentQuestions: [],
                lastActivity: Date.now()
            });
        }

        const context = this.groupContexts.get(chatId)!;

        // Check if we already have a recent summary
        const now = Date.now();
        if (!forceUpdate &&
            context.conversationSummary &&
            now - context.conversationSummary.timestamp < this.SUMMARY_EXPIRY &&
            messages.length <= context.conversationSummary.messages + this.SUMMARY_THRESHOLD / 2) {

            logInfo(methodName, 'Using existing summary', {
                age: (now - context.conversationSummary.timestamp) / 1000,
                messageCount: messages.length,
                previousCount: context.conversationSummary.messages
            });

            return context.conversationSummary.text;
        }

        // Generate new summary if we have enough messages
        if (messages.length < this.SUMMARY_THRESHOLD && !forceUpdate) {
            logInfo(methodName, 'Not enough messages for summary generation', {
                messageCount: messages.length,
                threshold: this.SUMMARY_THRESHOLD
            });
            return null;
        }

        try {
            const systemPrompt = new SystemMessage(
                `You are a conversation summarizer. Create a concise summary of this group chat conversation.
             Focus on the main topics discussed, key questions and answers, and any decisions or conclusions reached.
             Keep your summary under 200 words and organize it by topic where possible.`
            );

            // Convert messages to a readable format
            const formattedMessages = messages.map(msg => {
                const role = msg.getType() === 'human' ? 'User' : 'Bot';
                const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
                return `${role}: ${content}`;
            }).join('\n\n');

            const userPrompt = new HumanMessage(
                `Here's a conversation to summarize:\n\n${formattedMessages}`
            );

            const response = await invokeModelWithFallback(
                this.summationModel,  // Use summation model as primary
                this.chatModel,       // Fallback to chat model
                this.utilityModel,    // Last fallback to utility model
                [systemPrompt, userPrompt],
                { initialTimeout: 45000, maxTimeout: 90000, retries: 1 }
            );

            const summary = typeof response.content === 'string'
                ? response.content
                : JSON.stringify(response.content);

            // Store the summary
            context.conversationSummary = {
                text: summary,
                timestamp: now,
                messages: messages.length
            };

            logInfo(methodName, 'Generated new conversation summary', {
                messageCount: messages.length,
                summaryLength: summary.length,
                timestamp: new Date(now).toISOString()
            });

            return summary;
        }
        catch (error) {
            logError(methodName, 'Error generating conversation summary', error as Error);
            return null;
        }
    }

    // Add this method to QuestionAnalyzer
    public shouldSuggestSummary(chatId: string, messageCount: number): boolean {
        const context = this.groupContexts.get(chatId);
        if (!context) return false;

        // Check if we already have a summary
        if (context.conversationSummary) {
            const now = Date.now();

            // If summary is recent and for similar message count, don't suggest
            if (now - context.conversationSummary.timestamp < this.SUMMARY_EXPIRY &&
                Math.abs(messageCount - context.conversationSummary.messages) < this.SUMMARY_THRESHOLD / 2) {
                return false;
            }

            // If we have substantially more messages than the last summary, suggest
            if (messageCount > context.conversationSummary.messages + this.SUMMARY_THRESHOLD) {
                return true;
            }
        }
        else if (messageCount >= this.SUMMARY_THRESHOLD) {
            // No existing summary and enough messages
            return true;
        }

        return false;
    }

    // In TelegramBot_Agents
}