// GameAgent.ts
import { BaseAgent } from './BaseAgent';
import { ConversationManager } from '../ConversationManager';
import { ToolManager } from '../ToolManager';
import { PromptManager } from '../PromptManager';
import { MenuManager } from '../MenuManager';
import { ThinkingManager } from '../ThinkingManager';
import { cleanModelResponse, messageContentToString, hasThinkTags } from '../utils/utils';
import { ContextAdapter } from '../ContextAdapter';
import { Markup, } from 'telegraf';
import { BaseMessage, HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';
import {
    logInfo,
    logWarn,
    logError
} from '../loggingUtility';
import {
    Question,
    InputMediaVideo,
    InteractionType,
    GameState,
    createInitialGameState,
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
    EnhancedResponse,
    PhotoSource,
    type ResponseType,
    LifelineResult  // Add this import
} from '../commands/types';
import { invokeModelWithFallback } from '../utils/modelUtility';
import { PhoneAFriendAgent } from './PhoneAFriendAgent';
import { TelegramBot_Agents } from '../TelegramBot_Agents';
import { ReadStream, createReadStream, existsSync } from 'fs';

import * as path from 'path';

export class GameAgent extends BaseAgent {
    public gameStates: Map<string, GameState> = new Map();
    private gameTimeouts: Map<string, NodeJS.Timeout> = new Map();
    private readonly GAME_TIMEOUT = 5 * 60 * 1000; // 5 minutes
    private readonly flowId: string;
    private lastPresentation: string | null = null;  // Add this property
    private telegramBot: TelegramBot_Agents | null = null;
    private generalSystemPrompt: string | undefined;
    public menuManager: MenuManager;
    private thinkingManager: ThinkingManager | null = null;
    private activeSessions: Map<string, {
        userId: string,
        startTime: Date,
        chatId: string | number
    }> = new Map();



    constructor(
        flowId: string,
        conversationManager: ConversationManager | null,
        toolManager: ToolManager,
        promptManager: PromptManager
    ) {
        super(conversationManager, toolManager, promptManager);
        this.flowId = flowId;
        this.thinkingManager = new ThinkingManager(this.flowId); // Initialize ThinkingManager

    }
    // Method to check if chat has active session
    private isSessionActiveInChat(chatId: string | number): boolean {
        return Array.from(this.activeSessions.values())
            .some(session => session.chatId === chatId);
    }

    // Method to validate session ownership
    public isSessionOwner(userId: string, chatId: string | number): boolean {
        const session = Array.from(this.activeSessions.values())
            .find(session => session.chatId === chatId);
        return session?.userId === userId;
    }

    // Method to add new session
    private addSession(userId: string, chatId: string | number): void {
        const sessionId = `${chatId}`;
        this.activeSessions.set(sessionId, {
            userId,
            startTime: new Date(),
            chatId
        });
    }

    // Method to remove session
    private removeSession(chatId: string | number): void {
        const sessionId = `${chatId}`;
        this.activeSessions.delete(sessionId);
    }

    public setThinkingManager(thinkingManager: ThinkingManager) {
        this.thinkingManager = thinkingManager;
    }
    public setConversationManager(manager: ConversationManager): void {
        this.conversationManager = manager;
        console.log(`[GameAgent:${this.flowId}] ConversationManager set successfully`);
    }
    private formatGameStateForPrompt(state: GameState): string {
        return `Prize Level: $${this.getPrizeForLevel(state.currentLevel).toLocaleString()}
    Current Level: ${state.currentLevel}/15
    Safe Havens: ${state.safeHavens.map(level => `$${this.getPrizeForLevel(level).toLocaleString()}`).join(', ')}
    Available Lifelines: ${Object.entries(state.lifelines)
                .filter(([_, available]) => available)
                .map(([name]) => name)
                .join(', ')}
    Questions Answered: ${state.questionHistory.length}`;
    }

    private formatQuestionForPrompt(question: Question | null): string {
        if (!question) return 'No active question';
        return `Question: ${question.question}
    Options:
     ${question.options[0]}
     ${question.options[1]}
     ${question.options[2]}
     ${question.options[3]}
    Correct Answer: ${['A', 'B', 'C', 'D'][question.correctAnswer]}
    Difficulty: ${question.difficulty}
    Category: ${question.category}`;
    }
    private async getLLMResponse(
        adapter: ContextAdapter,
        systemPrompt: string,
        input: string,
        chatHistory: BaseMessage[],
        interactionType: InteractionType,
        gameState: GameState,
        replyToMessage?: { message_id: number; text: string },
    ): Promise<GameResponse> {
        if (!this.conversationManager) {
            throw new Error('ConversationManager not initialized');
        }
        const methodName = 'getLLMResponse';
        const context = adapter.getMessageContext();
        const { userId, sessionId } = await this.conversationManager.getSessionInfo(context);

        try {

            // Format the game state information
            const gameStateInfo = this.formatGameStateForPrompt(gameState);
            console.log(`[${methodName}] Formatted game state:`, {
                gameState: gameStateInfo,
                currentLevel: gameState.currentLevel,
                moneyWon: gameState.moneyWon,
                status: gameState.status,
                lastMessageId: gameState.lastMessageId
            });

            const questionInfo = this.formatQuestionForPrompt(gameState.currentQuestion);
            console.log(`[${methodName}] Formatted question info:`, {
                question: gameState.currentQuestion?.question,
                formattedInfo: questionInfo
            });

            // Inject the game state into the system prompt
            const enhancedSystemPrompt = systemPrompt
                .replace('{gameState}', gameStateInfo)
                .replace('{currentQuestion}', questionInfo);
            console.log(`[${methodName}] Enhanced system prompt:`, {
                original: systemPrompt,
                enhanced: enhancedSystemPrompt,
                replacements: {
                    gameState: gameStateInfo,
                    questionInfo: questionInfo
                }
            });

            const recentContextSummary = this.promptManager.generateRecentContextSummary(chatHistory);
            console.log(`[${methodName}] Recent context summary:`, {
                summary: recentContextSummary,
                historyLength: chatHistory.length
            });

            const contextualizedQuery = await this.conversationManager.constructContextualizedQuery(
                input,
                chatHistory,
                interactionType,
                adapter,
                replyToMessage
            );
            console.log(`[${methodName}] Contextualized query:`, {
                originalInput: input,
                contextualizedQuery,
                interactionType
            });

            const userMessage = new HumanMessage(
                this.promptManager.constructUserPrompt(contextualizedQuery, "", 'game')
            );
            console.log(`[${methodName}] Constructed user message:`, {
                content: userMessage.content,
                type: userMessage.getType()
            });

            // Prepare messages with proper BaseMessage types - NOTE: Using enhanced prompt now
            const messages: BaseMessage[] = [
                new SystemMessage(`${enhancedSystemPrompt}\n\n${recentContextSummary}`),
                userMessage
            ];

            console.warn(`[${methodName}] Total messages to send: ${messages.length}`);
            console.warn(`[${methodName}] Estimated token count: ${this.estimateTokenCount(messages)}`);
            // Add this logging section
            console.warn(`[${methodName}] Messages to be sent to the model:`);
            messages.forEach((msg, index) => {
                console.warn(`Message ${index + 1}:`);
                console.warn(`  Type: ${msg.getType()}`);
                console.warn(`  Content: ${this.truncateContent(msg.content as string)}`);
                if (msg.additional_kwargs) {
                    console.warn(`  Additional kwargs: ${JSON.stringify(msg.additional_kwargs)}`);
                }
            });

            // Use invokeModelWithFallback
            const response = await invokeModelWithFallback(
                this.conversationManager.SpModel,
                this.conversationManager.chatModel,
                this.conversationManager.summationModel,
                messages,
                { initialTimeout: 60000, maxTimeout: 200000, retries: 2 }
            );
            console.log(`[${methodName}] Raw response content:`, {
                contentType: typeof response.content,
                hasThinkTags: hasThinkTags(response.content),
                preview: typeof response.content === 'string' ?
                    response.content.substring(0, 200) :
                    'Non-string content'
            });

            let responseContent: string;
            if (this.thinkingManager) {
                console.log(`[${methodName}] Using ThinkingManager to clean response`);
                try {
                    responseContent = this.thinkingManager.cleanThinkTags(response.content) as string;
                    console.log(`[${methodName}] ThinkingManager cleaning result:`, {
                        cleanedContentLength: responseContent.length,
                        preview: responseContent.substring(0, 200),
                        stillHasThinkTags: hasThinkTags(responseContent)
                    });
                } catch (cleaningError) {
                    console.error(`[${methodName}] Error in ThinkingManager cleaning:`, cleaningError);
                    // Fallback to basic cleaning
                    responseContent = cleanModelResponse(response.content, false).content;
                }
            } else {
                console.log(`[${methodName}] No ThinkingManager available, using basic cleaning`);
                const cleanedResponse = cleanModelResponse(response.content, false);
                responseContent = cleanedResponse.content;
                console.log(`[${methodName}] Basic cleaning result:`, {
                    cleanedContentLength: responseContent.length,
                    preview: responseContent.substring(0, 200),
                    stillHasThinkTags: hasThinkTags(responseContent)
                });
            }

            // Final verification check
            if (hasThinkTags(responseContent)) {
                console.warn(`[${methodName}] Warning: Cleaned response still contains think tags`);
                // Additional cleanup if needed
                responseContent = responseContent.replace(/<think>.*?<\/think>/gs, '');
                responseContent = responseContent.replace(/\[.*?thinking.*?\]/gi, '');
            }
            // Use TelegramBot_Agents' updateMemory method
            if (this.telegramBot && !gameState.isActive) {  // Only update memory for non-game interactions
                try {
                    await this.telegramBot.updateMemory(adapter, messages);
                    logInfo(methodName, 'Memory updated successfully', {
                        userId,
                        sessionId,
                        messageCount: messages.length
                    });
                } catch (error) {
                    console.error(`[${methodName}] Error updating memory:`, error);
                }
            }

            if (adapter.context.messageId) {
                // Convert to number if it's a string
                gameState.lastMessageId = typeof adapter.context.messageId === 'string'
                    ? parseInt(adapter.context.messageId, 10)
                    : adapter.context.messageId;

                // Only set if conversion was successful
                if (!isNaN(gameState.lastMessageId)) {
                    this.gameStates.set(userId, gameState);
                    console.log(`[getLLMResponse] Stored message ID: ${gameState.lastMessageId}`);
                } else {
                    console.warn(`[getLLMResponse] Invalid message ID: ${adapter.context.messageId}`);
                    gameState.lastMessageId = undefined;
                }
            }

            // Add image for first question (when game is starting)
            if (gameState.currentLevel === 1 && gameState.status === 'awaiting_answer') {
                try {
                    // Fix path for correct directory structure
                    const getAssetPath = (filename: string): string => {
                        return path.join(__dirname, '..', 'assets', filename);
                    };

                    const videoPath = getAssetPath('first_question.mp4');
                    const imagePath = getAssetPath('first_question.jpg');

                    console.log(`[${methodName}] Looking for first question image at: ${imagePath}`);

                    if (existsSync(videoPath)) {
                        console.log(`[${methodName}] Found video for first question: ${videoPath}`);
                        const video = { source: videoPath };
                        const currentMsgId = adapter.context.messageId;

                        // Send video with response as caption
                        const videoMessage = await adapter.replyWithVideo(
                            video,
                            {
                                caption: responseContent,
                                parse_mode: 'HTML',
                                reply_markup: this.createGameKeyboard(gameState)
                            },
                            { messageType: 'game_question' }
                        );

                        console.log(`[${methodName}] Sent first question with video, message_id: ${videoMessage?.message_id}`);

                        // Update gameState with the message ID
                        if (videoMessage && videoMessage.message_id) {
                            gameState.lastMessageId = videoMessage.message_id;
                            this.gameStates.set(userId, gameState);
                        } else {
                            gameState.lastMessageId = typeof currentMsgId === 'string'
                                ? parseInt(currentMsgId, 10)
                                : currentMsgId as number;
                            this.gameStates.set(userId, gameState);
                        }

                        gameState.responseAlreadySent = true;

                        return {
                            response: [""],
                            metadata: {
                                gameState: gameState,
                                keyboard: null,
                                requiresInput: true,
                                messageId: gameState.lastMessageId
                            }
                        };
                    }
                    // Continue with image logic if video not found
                    else if (existsSync(imagePath)) {
                        const photo: PhotoSource = { source: imagePath };


                        // Get current message ID to use for lastMessageId
                        const currentMsgId = adapter.context.messageId;
                        // gameState.lastMessageIsMedia = true;
                        //  this.gameStates.set(userId, gameState);
                        // Send image with response as caption
                        const photoMessage = await adapter.replyWithPhoto(
                            photo,
                            {
                                caption: responseContent,
                                parse_mode: 'HTML',
                                reply_markup: this.createGameKeyboard(gameState)
                            },
                            { messageType: 'game_question' }
                        );

                        console.log(`[${methodName}] Sent first question with image, message_id: ${photoMessage?.message_id}`);

                        // Update gameState with the new message ID from the photo response
                        if (photoMessage && photoMessage.message_id) {
                            gameState.lastMessageId = photoMessage.message_id;
                            this.gameStates.set(userId, gameState);
                        } else {
                            // Keep original message ID as fallback
                            gameState.lastMessageId = typeof currentMsgId === 'string'
                                ? parseInt(currentMsgId, 10)
                                : currentMsgId as number;
                            this.gameStates.set(userId, gameState);
                        }

                        gameState.responseAlreadySent = true;

                        // Return standard GameResponse
                        return {
                            response: [""], // Empty response since we already sent it with the image
                            metadata: {
                                gameState: gameState,
                                keyboard: null, // No keyboard needed since it's included with the image
                                requiresInput: true,
                                messageId: gameState.lastMessageId
                            }
                        };
                    } else {
                        console.warn(`[${methodName}] First question image not found at: ${imagePath}, falling back to text response`);
                    }
                } catch (imageError) {
                    console.error(`[${methodName}] Error sending first question image:`, imageError);
                    // Continue to normal return below
                }
            }

            // Normal return if not first question or if image failed
            return {
                response: [responseContent],
                metadata: {
                    gameState: gameState,
                    keyboard: this.createGameKeyboard(gameState),
                    requiresInput: true,
                    messageId: gameState.lastMessageId
                }
            };

        } catch (error) {
            console.error('Error in getLLMResponse:', error);
            return {
                response: ["I apologize, but I encountered an error. Let's try that again."],
                metadata: {
                    gameState: gameState,
                    keyboard: this.createGameKeyboard(gameState),
                    requiresInput: true,
                    availableActions: ['quit']
                }
            };
        }
    }
    // Modify initializeGame to include session control
    public async initializeGame(userId: string, chatHistory: BaseMessage[], adapter: ContextAdapter): Promise<GameState> {
        const chatId = adapter.getMessageContext().chatId;

        if (this.isSessionActiveInChat(chatId)) {
            throw new Error('A game is already in progress in this chat');
        }

        console.log(`[GameAgent] Initializing game for user: ${userId} in chat: ${chatId}`);
        const gameState = createInitialGameState(userId);

        // Add the new session
        this.addSession(userId, chatId);

        // Generate question bank
        gameState.questionBank = await this.generateQuestionBank(adapter, 'easy', chatHistory);
        gameState.currentQuestion = gameState.questionBank[0];
        gameState.status = 'awaiting_answer';

        // Store the game state
        this.gameStates.set(userId, gameState);

        return gameState;
    }
    /*
    public getGameState(userId: string): GameState | null {
        console.log(`[GameAgent] Getting game state for user: ${userId}`);
        const state = this.gameStates.get(userId);
        console.log(`[GameAgent] Current game states in map:`, Array.from(this.gameStates.keys()));
        console.log(`[GameAgent] Retrieved state:`, state);
        return state || null;
    }
*/
    public getGameState(userId: string, verbose: boolean = false): GameState | null {
        const state = this.gameStates.get(userId);

        // Only log if verbose is true and state exists and is active
        if (verbose && state?.isActive) {
            console.log(`[GameAgent] Getting game state for user: ${userId}`);
            console.log(`[GameAgent] Current game states in map:`, Array.from(this.gameStates.keys()));
            console.log(`[GameAgent] Retrieved state:`, state);
        }
        return state || null;
    }




    private async generateQuestionBank(
        adapter: ContextAdapter,
        difficulty: QuestionDifficulty,
        chatHistory: BaseMessage[],
        count: number = 15
    ): Promise<Question[]> {
        await adapter.replyWithAutoDelete("❓Hold tight, this may take a minute or two... Generating questions for Game....", 120000);
        await adapter.replyWithAutoDelete("💫", 120000);

        try {
            if (!this.conversationManager) {
                throw new Error('ConversationManager not initialized');
            }

            console.log(`Attempting to generate ${count} questions`);
            const questionData = await this.conversationManager.generateGameQuestion(
                adapter,
                difficulty,
                chatHistory,
                count
            );

            if (!questionData) {
                throw new Error('No question data generated');
            }

            const questions = JSON.parse(questionData) as Question[];

            // Define difficulty order
            const difficultyOrder = {
                'easy': 0,
                'medium': 1,
                'hard': 2,
                'very_hard': 3
            };

            // Sort questions by difficulty
            const sortedQuestions = questions.sort((a, b) => {
                const diffA = difficultyOrder[a.difficulty as keyof typeof difficultyOrder];
                const diffB = difficultyOrder[b.difficulty as keyof typeof difficultyOrder];
                return diffA - diffB;
            });

            console.log(`Successfully generated ${questions.length} questions`);
            return sortedQuestions;

        } catch (error) {
            console.error('Error in question bank generation:', error);
            throw error; // Let ConversationManager handle fallback
        }
    }

    private getPrizeForLevel(level: number): number {
        const prizes = [100, 200, 300, 500, 1000, 2000, 4000, 8000, 16000, 32000, 64000, 125000, 250000, 500000, 1000000];
        return prizes[level - 1] || 100;
    }

    public async processQuery(
        input: string,
        context: string,
        chatHistory: BaseMessage[],
        interactionType: InteractionType,
        userId: string,
        adapter: ContextAdapter,
        progressKey?: string,
    ): Promise<EnhancedResponse> {
        const methodName = 'processQuery (GameAgent)';

        if (!this.conversationManager) {
            return {
                response: ["Game system is not initialized. Please try again later."],
                gameMetadata: {
                    gameState: null,
                    keyboard: null
                }
            };
        }

        try {
            const gameState = this.gameStates.get(userId) || createInitialGameState(userId);
            console.log(`[${methodName}] PromptManager debug:`, this.promptManager.getGameSystemPromptDebug());

            const systemPrompt = this.promptManager.constructSystemPrompt('game', 'game');
            console.warn(`[${methodName}] Game systemPrompt to be used!: ${systemPrompt} interactionType: ${interactionType} `);

            const response = await this.getLLMResponse(adapter!, systemPrompt, input, chatHistory, interactionType, gameState);

            // Update game state
            const updatedGameState = response.metadata?.gameState || gameState;
            if (response.metadata?.gameState) {
                this.gameStates.set(userId, updatedGameState);
            }

            // Create keyboard based on updated game state
            const keyboard = this.createGameKeyboard(updatedGameState);
            console.log(`[${methodName}] Created game keyboard:`, keyboard);

            return {
                response: response.response,
                gameMetadata: {
                    gameState: updatedGameState,
                    keyboard: keyboard
                }
            };

        } catch (error) {
            console.error('Error in processQuery:', error);
            return {
                response: ["Sorry, something went wrong. Please try again."],
                gameMetadata: {
                    gameState: null,
                    keyboard: null
                }
            };
        }
    }

    public createGameKeyboard(gameState: GameState): any {
        if (!gameState) {
            console.warn('No game state provided to createGameKeyboard');
            return null;
        }

        try {
            const buttons = [];

            if (gameState.status === 'awaiting_answer') {
                buttons.push([
                    Markup.button.callback('A', 'millionaire_answer:A'),
                    Markup.button.callback('B', 'millionaire_answer:B'),
                    Markup.button.callback('C', 'millionaire_answer:C'),
                    Markup.button.callback('D', 'millionaire_answer:D'),
                ]);
            }

            const lifelineButtons = [];
            if (gameState.lifelines.fiftyFifty) {
                lifelineButtons.push(Markup.button.callback('50:50 💫', 'millionaire_lifeline:5050'));
            }
            if (gameState.lifelines.phoneAFriend) {
                lifelineButtons.push(Markup.button.callback('Phone 📞', 'millionaire_lifeline:phone'));
            }
            if (gameState.lifelines.askTheAudience) {
                lifelineButtons.push(Markup.button.callback('Audience 👥', 'millionaire_lifeline:audience'));
            }
            if (lifelineButtons.length > 0) {
                buttons.push(lifelineButtons);
            }

            if (gameState.isActive) {
                buttons.push([Markup.button.callback('End Game ❌', 'millionaire_quit')]);
            }

            const keyboard = Markup.inlineKeyboard(buttons);
            return keyboard.reply_markup;  // Return just the reply_markup object
        } catch (error) {
            console.error('Error creating game keyboard:', error);
            return null;
        }
    }

    public createGameKeyboardForFiftyFifty(gameState: GameState, remainingIndices: number[]): any {
        if (!gameState) {
            console.warn('No game state provided to createGameKeyboardForFiftyFifty');
            return null;
        }

        try {
            const buttons = [];
            const letters = ['A', 'B', 'C', 'D'];

            // Create answer buttons only for remaining options
            const answerButtons = letters.map((letter, index) => {
                if (remainingIndices.includes(index)) {
                    return Markup.button.callback(letter, `millionaire_answer:${letter}`);
                }
                return null;
            }).filter(button => button !== null);

            buttons.push(answerButtons);

            // Add lifeline buttons (except fifty-fifty which is now used)
            const lifelineButtons = [];
            if (gameState.lifelines.phoneAFriend) {
                lifelineButtons.push(Markup.button.callback('Phone 📞', 'millionaire_lifeline:phone'));
            }
            if (gameState.lifelines.askTheAudience) {
                lifelineButtons.push(Markup.button.callback('Audience 👥', 'millionaire_lifeline:audience'));
            }
            if (lifelineButtons.length > 0) {
                buttons.push(lifelineButtons);
            }

            // Add quit button
            buttons.push([Markup.button.callback('End Game ❌', 'millionaire_quit')]);

            const keyboard = Markup.inlineKeyboard(buttons);
            return keyboard.reply_markup;

        } catch (error) {
            console.error('Error creating fifty-fifty game keyboard:', error);
            return null;
        }
    }


    public async cleanup(): Promise<void> {
        // Clear all game states and timeouts
        this.gameStates.clear();
        for (const timeout of this.gameTimeouts.values()) {
            clearTimeout(timeout);
        }
        this.gameTimeouts.clear();
    }

    public async useLifeline(
        adapter: ContextAdapter,
        userId: string,
        lifeline: LifelineType
    ): Promise<LifelineResult> {
        const methodName = 'useLifeline';
        console.log(`[${methodName}] Starting lifeline use:`, {
            userId,
            lifeline,
            timestamp: new Date().toISOString()
        });
        await adapter.answerCallbackQuery("");

        const state = this.gameStates.get(userId) as MillionaireState;
        if (!state || !state.currentQuestion) {
            throw new Error('No active game or question');
        }

        if (!state.lifelines[lifeline]) {
            throw new Error('Lifeline not available');
        }

        if (!state.lastMessageId) {
            throw new Error('No message ID found for game');
        }

        try {
            // First update message to show "Using lifeline..."
            await adapter.editMessageCaption(
                `${state.currentQuestion.question}\n\n🤔 Using ${lifeline} lifeline...`,
                {
                    reply_markup: { inline_keyboard: [] },
                    parse_mode: 'HTML'
                }
            );

            // Add dramatic pause
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Execute the lifeline and handle different result types
            let keyboard;
            let result: LifelineResult;

            switch (lifeline) {
                case 'fiftyFifty': {
                    const fiftyResult = await this.executeFiftyFifty(state);
                    result = fiftyResult;
                    keyboard = this.createGameKeyboardForFiftyFifty(state, fiftyResult.result || []);
                    break;
                }
                case 'phoneAFriend': {
                    const phoneResult = await this.executePhoneAFriend(state, adapter);
                    result = phoneResult;
                    keyboard = this.createGameKeyboard(state);
                    break;
                }
                case 'askTheAudience': {
                    const audienceResult = await this.executeAskTheAudience(state, adapter);
                    result = audienceResult;
                    keyboard = this.createGameKeyboard(state);
                    break;
                }
                default:
                    throw new Error(`Unknown lifeline: ${lifeline}`);
            }

            // Update game state
            this.gameStates.set(userId, state);

            // Update message with result and new keyboard
            await adapter.editMessageCaption(
                `${state.currentQuestion.question}\n\n${result.message}`,
                {
                    reply_markup: keyboard,
                    parse_mode: 'HTML'
                }
            );

            console.log(`[${methodName}] Lifeline used successfully:`, {
                userId,
                lifeline,
                resultType: result.type,
                messageId: state.lastMessageId
            });

            return result;

        } catch (error) {
            console.error(`[${methodName}] Error using lifeline:`, error);

            // Try to restore the game display if there's an error
            try {
                await adapter.editMessageCaption(
                    `${state.currentQuestion.question}\n\n❌ Error using lifeline. Please try again.`,
                    {
                        reply_markup: this.createGameKeyboard(state),
                        parse_mode: 'HTML'
                    }
                );
            } catch (editError) {
                console.error(`[${methodName}] Error restoring game display:`, editError);
            }

            throw error;
        }
    }
    private async executeFiftyFifty(state: MillionaireState): Promise<FiftyFiftyResult> {
        if (!state.currentQuestion) {
            throw new Error('No active question');
        }

        // Get indices of all wrong answers
        const wrongAnswerIndices = state.currentQuestion.options
            .map((_, index) => index)
            .filter(index => index !== state.currentQuestion!.correctAnswer);

        // Randomly select one wrong answer to keep
        const keepWrongIndex = Math.floor(Math.random() * wrongAnswerIndices.length);
        const remainingIndices = [
            state.currentQuestion.correctAnswer,
            wrongAnswerIndices[keepWrongIndex]
        ].sort();

        // Create message with remaining options
        const remainingOptions = remainingIndices.map(index => {
            const letter = ['A', 'B', 'C', 'D'][index];
            return `${letter}) ${state.currentQuestion!.options[index]}`;
        });

        // Mark lifeline as used
        state.lifelines.fiftyFifty = false;
        state.currentQuestion.usedLifelines.push('fiftyFifty');

        // Update game state
        this.gameStates.set(state.userId, state);

        return {
            type: 'fiftyFifty',
            result: remainingIndices,
            message: `Two incorrect answers have been removed! 🎯\n\nYour remaining options are:\n${remainingOptions.join('\n')}`
        };
    }

    private async executePhoneAFriend(state: MillionaireState, adapter: ContextAdapter): Promise<PhoneAFriendResult> {
        const methodName = 'executePhoneAFriend';
        console.log(`[${methodName}] Executing Phone-A-Friend lifeline`);

        if (!state.currentQuestion) {
            throw new Error('No active question');
        }
        if (!this.conversationManager) {
            throw new Error('ConversationManager not initialized');
        }
        const getAssetPath = (filename: string): string => {
            return path.join(__dirname, '..', 'assets', filename);
        };
        try {
            const phoneFreindVideo = getAssetPath('phone_a_friend.mp4');
            if (existsSync(phoneFreindVideo)) {
                const media: InputMediaVideo = {
                    type: 'video',
                    media: { source: phoneFreindVideo },
                    caption: `${state.currentQuestion.question}\n\n📞 Using Phone-A-Friend lifeline...\nConnecting to your friend...`,
                    parse_mode: 'HTML'
                };
                const messageId = typeof state.lastMessageId === 'string' ?
                    parseInt(state.lastMessageId, 10) :
                    state.lastMessageId as number;

                // Initial message
                await adapter.editMessageMedia(
                    media,
                    {
                        message_id: messageId,
                        reply_markup: { inline_keyboard: [] }
                    }
                );
            }

            // Get chat history
            const messages = await this.conversationManager.getMemory(adapter);
            const chatHistory = messages.map(msg => {
                if (msg.type === 'userMessage') {
                    return new HumanMessage(msg.message || '');
                } else {
                    return new AIMessage(msg.message || '');
                }
            });

            // Get or create PhoneAFriendAgent
            const agentManager = this.conversationManager.getAgentManager();
            if (!agentManager) {
                throw new Error('AgentManager not initialized');
            }

            let friendAgent = agentManager.getAgent('phoneAFriend') as PhoneAFriendAgent;
            if (!friendAgent) {
                console.log(`[${methodName}] Creating new PhoneAFriendAgent`);
                friendAgent = new PhoneAFriendAgent(
                    this.flowId,
                    this.conversationManager,
                    this.toolManager,
                    this.promptManager
                );
                agentManager.registerAgent('phoneAFriend', friendAgent);
            }

            // Add dramatic pause
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Execute the phone a friend lifeline
            const result = await friendAgent.answerQuestion(
                state.currentQuestion,
                chatHistory,
                adapter
            );

            if (!result.success) {
                throw new Error('Phone-A-Friend call failed');
            }

            // Mark lifeline as used before any potential errors in response display
            state.lifelines.phoneAFriend = false;
            state.currentQuestion.usedLifelines.push('phoneAFriend');
            this.gameStates.set(state.userId, state);

            // Display result with game show flair
            await adapter.editMessageCaption(
                `${state.currentQuestion.question}\n\n${result.message}`,
                {
                    reply_markup: this.createGameKeyboard(state),
                    parse_mode: 'Markdown'
                }
            );

            return result;

        } catch (error) {
            console.error(`[${methodName}] Error:`, error);

            // Don't mark lifeline as used if there was an error
            const errorResult: PhoneAFriendResult = {
                type: 'phoneAFriend',
                success: false,
                message: "📞❌ Sorry! We couldn't connect to your friend. Technical difficulties! The lifeline is still available.",
            };

            // Display error message
            await adapter.editMessageCaption(
                `${state.currentQuestion.question}\n\n${errorResult.message}`,
                {
                    reply_markup: this.createGameKeyboard(state),
                    parse_mode: 'Markdown'
                }
            );

            return errorResult;
        }
    }

    private async executeAskTheAudience(state: MillionaireState, adapter: ContextAdapter): Promise<AskTheAudienceResult> {
        if (!state.currentQuestion || !this.conversationManager || !this.promptManager) {
            throw new Error('Required components not initialized');
        }

        try {
            // Generate audience response with bias towards correct answer based on difficulty
            const percentages = this.generateAudiencePercentages(
                state.currentQuestion.correctAnswer,
                state.currentQuestion.difficulty
            );

            // Mark lifeline as used
            state.lifelines.askTheAudience = false;
            state.currentQuestion.usedLifelines.push('askTheAudience');

            // Update game state
            this.gameStates.set(state.userId, state);

            return {
                type: 'askTheAudience',
                success: true,
                result: percentages,
                message: this.formatAudienceResponse(percentages, state.currentQuestion.options)
            };
        } catch (error) {
            console.error(`[GameAgent:${this.flowId}] Error generating audience response:`, error);
            throw new Error('Failed to get audience response');
        }
    }

    private generateAudiencePercentages(correctAnswer: number, difficulty: QuestionDifficulty): number[] {
        // Base confidence levels by difficulty
        const confidenceLevels = {
            'easy': 0.85,
            'medium': 0.65,
            'hard': 0.45,
            'very_hard': 0.35
        };

        const baseConfidence = confidenceLevels[difficulty];
        const percentages = Array(4).fill(0);

        // Allocate percentage to correct answer based on difficulty
        percentages[correctAnswer] = Math.round(baseConfidence * 100);

        // Distribute remaining percentage among wrong answers
        const remainingPercentage = 100 - percentages[correctAnswer];
        const wrongAnswers = [0, 1, 2, 3].filter(i => i !== correctAnswer);

        // Add some randomness to wrong answers
        wrongAnswers.forEach((index, i) => {
            if (i === wrongAnswers.length - 1) {
                // Last wrong answer gets whatever is left to ensure sum is 100
                percentages[index] = remainingPercentage - wrongAnswers.slice(0, -1)
                    .reduce((sum, idx) => sum + percentages[idx], 0);
            } else {
                // Random distribution for other wrong answers
                const maxShare = remainingPercentage / (wrongAnswers.length - i);
                percentages[index] = Math.round(Math.random() * maxShare);
            }
        });

        return percentages;
    }

    private formatAudienceResponse(percentages: number[], options: string[]): string {
        const letters = ['A', 'B', 'C', 'D'];
        const maxBarLength = 20; // Maximum number of blocks for 100%
        const graphBars = percentages.map(p => '█'.repeat(Math.round((p / 100) * maxBarLength)));

        return "📊 The audience has voted!\n\n" +
            percentages.map((p, i) =>
                `${letters[i]}: ${graphBars[i]} ${p}%`
            ).join('\n') +
            "\n\n👥 Remember, the audience isn't always right!";
    }

    public async submitAnswer(
        adapter: ContextAdapter,
        userId: string,
        answer: number
    ): Promise<{
        correct: boolean;
        newState: GameState;
        explanation?: string;
        moneyWon: number;
    }> {
        const methodName = 'submitAnswer';
        console.log(`[${methodName}] Starting answer submission:`, {
            userId,
            answer,
            timestamp: new Date().toISOString()
        });

        // Get and validate state
        const state = this.getGameState(userId) as MillionaireState;
        console.log(`[${methodName}] Retrieved game state:`, {
            exists: !!state,
            isActive: state?.isActive,
            currentLevel: state?.currentLevel,
            currentQuestion: state?.currentQuestion?.question,
            correctAnswer: state?.currentQuestion?.correctAnswer
        });

        if (!state || !state.currentQuestion) {
            console.error(`[${methodName}] Invalid game state:`, {
                hasState: !!state,
                hasQuestion: !!state?.currentQuestion
            });
            throw new Error('No active question');
        }

        // Get and validate config
        const config = this.getDefaultMillionaireConfig();
        const moneyTree = config.moneyTree;
        console.log(`[${methodName}] Game configuration:`, {
            hasMoneyTree: !!moneyTree,
            moneyTreeLevels: moneyTree?.length,
            currentLevel: state.currentLevel
        });

        if (!moneyTree) {
            console.error(`[${methodName}] Money tree configuration missing`);
            throw new Error('Game configuration error: money tree not found');
        }

        // Process answer

        const isCorrect = answer === state.currentQuestion.correctAnswer;
        console.log(`[${methodName}] Answer evaluation:`, {
            submittedAnswer: answer,
            correctAnswer: state.currentQuestion.correctAnswer,
            isCorrect,
            questionText: state.currentQuestion.question
        });

        if (!state.lastMessageId) {
            console.warn(`[${methodName}] No message ID available, cannot edit media`);
            // Fallback to traditional caption editing...
            return this.fallbackSubmitAnswer(adapter, userId, answer, isCorrect, state);
        }

        // Helper for asset paths
        const getAssetPath = (filename: string): string => {
            return path.join(__dirname, '..', 'assets', filename);
        };

        try {
            // First update - show "Is that your final answer?" with final_answer.mp4
            const finalAnswerVideo = getAssetPath('final_answer.mp4');
            if (existsSync(finalAnswerVideo)) {
                // Prepare media for update
                const media: InputMediaVideo = {
                    type: 'video',
                    media: { source: finalAnswerVideo },
                    caption: `${state.currentQuestion.question}\n\n${state.currentQuestion.options[answer]}\n\n🤔 Is that your final answer? Let me check.....\n\n🔎...`,
                    parse_mode: 'HTML'
                };

                if (state.lastMessageId) {
                    // Make sure lastMessageId is a number
                    const messageId = typeof state.lastMessageId === 'string' ?
                        parseInt(state.lastMessageId, 10) :
                        state.lastMessageId;

                    await adapter.editMessageMedia(
                        media,
                        {
                            message_id: messageId,
                            chat_id: adapter.context.chatId,
                            reply_markup: { inline_keyboard: [] }
                        }
                    );
                }

                // Add dramatic pause
                await new Promise(resolve => setTimeout(resolve, 1000));

                // Second update - show result with appropriate video
                const resultVideo = getAssetPath(isCorrect ? 'correct_answer.mp4' : 'wrong_answer.mp4');
                if (existsSync(resultVideo)) {
                    const submittedAnswerLetter = ['A', 'B', 'C', 'D'][answer];
                    const submittedAnswerText = state.currentQuestion.options[answer];
                    const correctAnswerLetter = ['A', 'B', 'C', 'D'][state.currentQuestion.correctAnswer];
                    const correctAnswerText = state.currentQuestion.options[state.currentQuestion.correctAnswer];

                    const resultMessage = isCorrect ?
                        `✅ That's correct! : ${correctAnswerText}` :
                        `❌ Sorry, that's incorrect.\nThe correct answer was: ${correctAnswerText}`;

                    // Get message ID as number
                    const messageId = typeof state.lastMessageId === 'string' ?
                        parseInt(state.lastMessageId, 10) :
                        state.lastMessageId as number;

                    // Create media object with proper typing
                    const media: InputMediaVideo = {
                        type: 'video',
                        media: { source: resultVideo }, // Let adapter handle stream creation
                        caption: `${state.currentQuestion.question}\n\n` +
                            `Your Answer is: ${submittedAnswerLetter}\n` +
                            `${resultMessage}`,
                        parse_mode: 'HTML'
                    };

                    if (messageId && !isNaN(messageId)) {
                        await adapter.editMessageMedia(
                            media,
                            {
                                message_id: messageId,
                                chat_id: adapter.context.chatId,
                                reply_markup: isCorrect ? undefined : Markup.inlineKeyboard([
                                    [Markup.button.callback('Play Again 🔄', 'millionaire_new')]
                                ]).reply_markup
                            }
                        );
                    }
                }
            }
        } catch (mediaEditError) {
            console.error(`[${methodName}] Error updating message media:`, mediaEditError);
            // Fall back to caption editing if media editing fails
            return this.fallbackSubmitAnswer(adapter, userId, answer, isCorrect, state);
        }

        // Continue with state updates...
        // await new Promise(resolve => setTimeout(resolve, 3500));

        // Update question history
        state.questionHistory.push(state.currentQuestion);

        if (isCorrect) {
            console.log(`[${methodName}] Processing correct answer`);
            state.currentLevel++;
            const newMoneyAmount = moneyTree[Math.min(state.currentLevel - 1, moneyTree.length - 1)];
            state.moneyWon = newMoneyAmount;

            console.log(`[${methodName}] Updated game state:`, {
                newLevel: state.currentLevel,
                newMoneyWon: state.moneyWon,
                totalLevels: moneyTree.length
            });

            // Only end the game AFTER they've answered the final question
            if (state.currentLevel > moneyTree.length) {  // Changed from >= to >
                // Add million dollar celebration sequence
                await this.celebrateMillionDollarWin(adapter);
                await this.exitGame(adapter, userId, 'game_over');
            }
        } else {
            console.log(`[${methodName}] Processing incorrect answer`);

            // Calculate fallback money immediately
            const lastSafeHaven = Math.max(...state.safeHavens.filter(level => level < state.currentLevel));
            const fallbackMoney = lastSafeHaven > 0 ? moneyTree[lastSafeHaven - 1] : 0;
            state.moneyWon = fallbackMoney;

            // Update state before any message edits
            state.isActive = false;
            state.status = 'game_over';
            this.gameStates.set(userId, state);

            // Single message edit for result
            if (state.lastMessageId) {
                const correctAnswerLetter = ['A', 'B', 'C', 'D'][state.currentQuestion.correctAnswer];
                const correctAnswerText = state.currentQuestion.options[state.currentQuestion.correctAnswer];

                await adapter.editMessageCaption(
                    `${state.currentQuestion.question}\n\n` +
                    `❌ Sorry, that's incorrect.\n` +
                    `The correct answer was: ${correctAnswerLetter}) ${correctAnswerText}\n` +
                    `You've secured $${fallbackMoney}. Better luck next time!`,
                    {
                        reply_markup: Markup.inlineKeyboard([
                            [Markup.button.callback('Play Again 🔄', 'millionaire_new')]
                        ]).reply_markup,
                        parse_mode: 'HTML'
                    }
                );
            }

            await new Promise(resolve => setTimeout(resolve, 3500)); // 3-second pause

            // Calculate the fallback money based on the last safe haven
            state.moneyWon = fallbackMoney;
            console.log(`[${methodName}] Updated game state after incorrect answer:`, {
                lastSafeHaven,
                fallbackMoney: state.moneyWon,
                safeHavens: state.safeHavens
            });

            // Inform the player of the fallback amount
            await adapter.replyWithAutoDelete(`You've secured \$${fallbackMoney}. Better luck next time, mate!`, 120000);
            this.gameStates.set(userId, state);

            // End the game with a game-over status
            await this.exitGame(adapter, userId, 'game_over');
            return {
                correct: isCorrect,
                newState: state,
                explanation: state.currentQuestion.explanation,
                moneyWon: state.moneyWon
            };
        }

        // Update game state in map
        this.gameStates.set(userId, state);
        console.log(`[${methodName}] Final game state updated:`, {
            userId,
            mapSize: this.gameStates.size,
            finalLevel: state.currentLevel,
            finalMoney: state.moneyWon
        });

        return {
            correct: isCorrect,
            newState: state,
            explanation: state.currentQuestion.explanation,
            moneyWon: state.moneyWon
        };
    }
    private async fallbackSubmitAnswer(
        adapter: ContextAdapter,
        userId: string,
        answer: number,
        isCorrect: boolean,
        state: MillionaireState
    ): Promise<{
        correct: boolean;
        newState: GameState;
        explanation?: string;
        moneyWon: number;
    }> {
        const methodName = 'submitAnswer';
        console.log(`[${methodName}] Starting answer submission:`, {
            userId,
            answer,
            timestamp: new Date().toISOString()
        });

        // Get and validate state
        //   const state = this.getGameState(userId) as MillionaireState;
        console.log(`[${methodName}] Retrieved game state:`, {
            exists: !!state,
            isActive: state?.isActive,
            currentLevel: state?.currentLevel,
            currentQuestion: state?.currentQuestion?.question,
            correctAnswer: state?.currentQuestion?.correctAnswer
        });

        if (!state || !state.currentQuestion) {
            console.error(`[${methodName}] Invalid game state:`, {
                hasState: !!state,
                hasQuestion: !!state?.currentQuestion
            });
            throw new Error('No active question');
        }

        // Get and validate config
        const config = this.getDefaultMillionaireConfig();
        const moneyTree = config.moneyTree;
        console.log(`[${methodName}] Game configuration:`, {
            hasMoneyTree: !!moneyTree,
            moneyTreeLevels: moneyTree?.length,
            currentLevel: state.currentLevel
        });

        if (!moneyTree) {
            console.error(`[${methodName}] Money tree configuration missing`);
            throw new Error('Game configuration error: money tree not found');
        }

        // Reset timeout
        this.resetGameTimeout(adapter, userId);
        const messageId = state.lastMessageId;

        // Process answer
        //  const isCorrect = answer === state.currentQuestion.correctAnswer;
        console.log(`[${methodName}] Answer evaluation:`, {
            submittedAnswer: answer,
            correctAnswer: state.currentQuestion.correctAnswer,
            isCorrect,
            questionText: state.currentQuestion.question
        });
        state.questionHistory.push(state.currentQuestion);

        if (state.lastMessageId) {
            try {
                await adapter.editMessageCaption(
                    `${state.currentQuestion.question}\n\n🤔 Is that your final answer? Let me check......`,
                    {
                        message_id: state.lastMessageId,
                        reply_markup: { inline_keyboard: [] },
                        parse_mode: 'HTML'
                    }
                );
            } catch (captionError) {
                console.warn('Failed to edit caption, falling back to new message:', captionError);
                await adapter.reply(
                    `${state.currentQuestion.question}\n\n🤔 Is that your final answer? Let me check......`
                );
            }
        }
        // Add dramatic pause and response
        await new Promise(resolve => setTimeout(resolve, 3000)); // 3 second pause
        // Get the actual answer texts
        const submittedAnswerLetter = ['A', 'B', 'C', 'D'][answer];
        const submittedAnswerText = state.currentQuestion.options[answer];
        const correctAnswerLetter = ['A', 'B', 'C', 'D'][state.currentQuestion.correctAnswer];
        const correctAnswerText = state.currentQuestion.options[state.currentQuestion.correctAnswer];

        // Format the result message
        const resultMessage = isCorrect ?
            `✅ That's correct! : ${correctAnswerText}` :
            `❌ Sorry, that's incorrect.\nThe correct answer was: ${correctAnswerText}`;


        await adapter.editMessageCaption(
            `${state.currentQuestion.question}\n\n` +
            `Your Answer: ${submittedAnswerText}\n` +
            `${resultMessage}`,
            {
                message_id: state.lastMessageId,
                reply_markup: { inline_keyboard: [] },
                parse_mode: 'HTML'
            },
            //{ messageType: 'thirty_min' }
        );

        await new Promise(resolve => setTimeout(resolve, 3500));

        // Update question history
        state.questionHistory.push(state.currentQuestion);

        if (isCorrect) {
            console.log(`[${methodName}] Processing correct answer`);
            state.currentLevel++;
            const newMoneyAmount = moneyTree[Math.min(state.currentLevel - 1, moneyTree.length - 1)];
            state.moneyWon = newMoneyAmount;

            console.log(`[${methodName}] Updated game state:`, {
                newLevel: state.currentLevel,
                newMoneyWon: state.moneyWon,
                totalLevels: moneyTree.length
            });

            // Only end the game AFTER they've answered the final question
            if (state.currentLevel > moneyTree.length) {  // Changed from >= to >
                // Add million dollar celebration sequence
                await this.celebrateMillionDollarWin(adapter);
                await this.exitGame(adapter, userId, 'game_over');
            }
        } else {
            console.log(`[${methodName}] Processing incorrect answer`);

            // Calculate fallback money immediately
            const lastSafeHaven = Math.max(...state.safeHavens.filter(level => level < state.currentLevel));
            const fallbackMoney = lastSafeHaven > 0 ? moneyTree[lastSafeHaven - 1] : 0;
            state.moneyWon = fallbackMoney;

            // Update state before any message edits
            state.isActive = false;
            state.status = 'game_over';
            this.gameStates.set(userId, state);

            // Single message edit for result
            if (state.lastMessageId) {
                const correctAnswerLetter = ['A', 'B', 'C', 'D'][state.currentQuestion.correctAnswer];
                const correctAnswerText = state.currentQuestion.options[state.currentQuestion.correctAnswer];

                await adapter.editMessageCaption(
                    `${state.currentQuestion.question}\n\n` +
                    `❌ Sorry, that's incorrect.\n` +
                    `The correct answer was: ${correctAnswerLetter}) ${correctAnswerText}\n` +
                    `You've secured $${fallbackMoney}. Better luck next time!`,
                    {
                        reply_markup: Markup.inlineKeyboard([
                            [Markup.button.callback('Play Again 🔄', 'millionaire_new')]
                        ]).reply_markup,
                        parse_mode: 'HTML'
                    }
                );
            }

            await new Promise(resolve => setTimeout(resolve, 3500)); // 3-second pause

            // Calculate the fallback money based on the last safe haven
            state.moneyWon = fallbackMoney;
            console.log(`[${methodName}] Updated game state after incorrect answer:`, {
                lastSafeHaven,
                fallbackMoney: state.moneyWon,
                safeHavens: state.safeHavens
            });

            // Inform the player of the fallback amount
            await adapter.replyWithAutoDelete(`You've secured \$${fallbackMoney}. Better luck next time, mate!`, 120000);
            this.gameStates.set(userId, state);

            // End the game with a game-over status
            await this.exitGame(adapter, userId, 'game_over');
            return {
                correct: isCorrect,
                newState: state,
                explanation: state.currentQuestion.explanation,
                moneyWon: state.moneyWon
            };
        }

        // Update game state in map
        this.gameStates.set(userId, state);
        console.log(`[${methodName}] Final game state updated:`, {
            userId,
            mapSize: this.gameStates.size,
            finalLevel: state.currentLevel,
            finalMoney: state.moneyWon
        });

        return {
            correct: isCorrect,
            newState: state,
            explanation: state.currentQuestion.explanation,
            moneyWon: state.moneyWon
        };
    }

    private getDefaultMillionaireConfig(): GameConfig {
        return {
            moneyTree: [
                100, 200, 300, 500, 1000,  // Level 1-5
                2000, 4000, 8000, 16000, 32000,  // Level 6-10
                64000, 125000, 250000, 500000, 1000000  // Level 11-15
            ],
            timeLimit: 60,  // Seconds per question
            lifelines: ['fiftyFifty', 'phoneAFriend', 'askTheAudience']
        };
    }

    private resetGameTimeout(adapter: ContextAdapter, userId: string): void {
        this.clearGameTimeout(userId);
        const timeout = setTimeout(async () => {
            await this.exitGame(adapter, userId, 'timeout');
        }, this.GAME_TIMEOUT);
        this.gameTimeouts.set(userId, timeout);
    }

    private clearGameTimeout(userId: string): void {
        const existingTimeout = this.gameTimeouts.get(userId);
        if (existingTimeout) {
            clearTimeout(existingTimeout);
            this.gameTimeouts.delete(userId);
        }
    }

    public async exitGame(
        adapter: ContextAdapter,
        userId: string,
        reason: 'user_exit' | 'timeout' | 'game_over'
    ): Promise<void> {
        const methodName = 'exitGame';
        console.log(`[${methodName}] Starting game exit process:`, {
            userId,
            reason,
            timestamp: new Date().toISOString()
        });
        const chatId = adapter.getMessageContext().chatId;

        const state = this.gameStates.get(userId);
        if (!state) {
            console.warn(`[${methodName}] No game state found for user ${userId}`);
            return;
        }

        try {
            // Clear any existing timeout
            this.clearGameTimeout(userId);

            // Update the game state before finalizing
            state.isActive = false;
            state.status = 'game_over';

            // Calculate final statistics
            const finalStats = {
                questionsAnswered: state.questionHistory.length,
                moneyWon: state.moneyWon || 0,
                timeSpent: state.startTime ?
                    Math.floor((Date.now() - state.startTime.getTime()) / 1000) : 0,
                finalLevel: state.currentLevel,
                lifelinesUsed: this.calculateLifelinesUsed(state),
                endReason: reason
            };

            // Log the final game state
            console.log(`[${methodName}] Final game state:`, {
                userId,
                stats: finalStats,
                gameStatus: state.status,
                isActive: state.isActive
            });

            // Update state one last time before removing
            this.gameStates.set(userId, state);
            // Fix path for correct directory structure
            const getAssetPath = (filename: string): string => {
                return path.join(__dirname, '..', 'assets', filename);
            };

            // Format and send the exit message
            const questionVideo = getAssetPath('Millionaire3.mp4');

            const exitMessage = this.formatExitMessage(reason, finalStats, adapter);
            const media: InputMediaVideo = {
                type: 'video',
                media: { source: questionVideo },
                caption: exitMessage,
                parse_mode: 'HTML'
            };
            await adapter.editMessageMedia(
                media,
                {
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('Play Again 🔄', 'millionaire_new')]
                    ]).reply_markup
                },
            );

            // After successful message send, remove the game state
            this.gameStates.delete(userId);
            console.log(`[${methodName}] Game state successfully removed for user ${userId}`);
            this.removeSession(chatId);

        } catch (error) {
            console.error(`[${methodName}] Error during game exit:`, {
                userId,
                error: error.message,
                stack: error.stack
            });

            // Always ensure game state is removed
            this.clearGameTimeout(userId);
            this.gameStates.delete(userId);
            this.removeSession(chatId);

            // Attempt to notify user of error
            try {
                await adapter.reply("Sorry, there was an error ending the game. You can start a new game with /millionaire");
            } catch (replyError) {
                console.error(`[${methodName}] Failed to send error message:`, replyError);
            }
        }
    }

    private calculateLifelinesUsed(state: GameState): { [key in LifelineType]?: boolean } {
        return {
            fiftyFifty: !state.lifelines.fiftyFifty,
            phoneAFriend: !state.lifelines.phoneAFriend,
            askTheAudience: !state.lifelines.askTheAudience
        };
    }

    private formatExitMessage(reason: 'user_exit' | 'timeout' | 'game_over', stats: any, adapter: ContextAdapter): string {
        const reasonEmojis = {
            user_exit: "🚪",
            timeout: "⏰",
            game_over: "🎮"
        };
        const context = adapter.getMessageContext();
        const firstName = context.first_name || context.raw?.from?.first_name || 'Contestant';

        const reasonMessages = {
            user_exit: "You've chosen to end the game.",
            timeout: "Game ended due to inactivity.",
            game_over: stats.moneyWon > 0 ?
                `Congratulations ${firstName} on completing your game!` :
                "Game over! Better luck next time!"
        };

        const lifelineStatus = Object.entries(stats.lifelinesUsed || {})
            .map(([name, used]) => `${name}: ${used ? '✓' : '✗'}`)
            .join('\n');

        return `${reasonEmojis[reason]} ${reasonMessages[reason]}\n\n` +
            `📊 Final Stats:\n` +
            `💰 Money Won: $${stats.moneyWon.toLocaleString()}\n` +
            `📝 Questions Answered: ${stats.questionsAnswered}\n` +
            `🎯 Final Level: ${stats.finalLevel}/15\n` +
            `⏱️ Time Played: ${Math.floor(stats.timeSpent / 60)}m ${stats.timeSpent % 60}s\n\n` +
            `🎲 Lifelines Used:\n${lifelineStatus}\n\n` +
            `Thanks for playing! Want to try again? 🎮`;
    }


    private estimateTokenCount(messages: BaseMessage[]): number {
        // This is a very rough estimate. You might want to use a more accurate tokenizer.
        return messages.reduce((count, msg) => count + (msg.content as string).split(/\s+/).length, 0);
    }
    private truncateContent(content: string, maxLength: number = 10000): string {
        if (content.length <= maxLength) {
            return content;
        }
        return content.substring(0, maxLength) + '...';
    }
    getAgentName(): string {
        return "GameAgent";
    }

    private async celebrateMillionDollarWin(adapter: ContextAdapter) {

        // Get user's first name from the context
        const context = adapter.getMessageContext();
        const firstName = context.first_name || context.raw?.from?.first_name || 'Contestant';

        // Add dramatic pause with building excitement
        await adapter.replyWithAutoDelete("💫", 20000);
        await new Promise(resolve => setTimeout(resolve, 1000));
        await adapter.replyWithAutoDelete("✨", 20000);
        await new Promise(resolve => setTimeout(resolve, 1000));
        await adapter.replyWithAutoDelete("🌟", 20000);
        await new Promise(resolve => setTimeout(resolve, 1000));
        await adapter.replyWithAutoDelete("💰", 20000);
        await new Promise(resolve => setTimeout(resolve, 1500));
        const celebratoryMessages = [
            `"${firstName}...You LOCKED IT IN... Mate! YOU'VE JUST WON A MILLION DOLLARS! 🎉🎊",
            "You've done it! You're our newest MILLIONAIRE! 💰",
            "HISTORY HAS BEEN MADE! We have a MILLIONAIRE! 🏆",
            "A MILLION DOLLARS! Can you believe it?! CONGRATULATIONS! 🎯"`
        ];

        await adapter.replyWithAutoDelete(
            `${celebratoryMessages[Math.floor(Math.random() * celebratoryMessages.length)]}
            
            🎊 🎉 💰 🎊 🎉 💰 🎊 🎉 💰
            
            You've conquered every question and climbed to the very top!
            An absolutely incredible performance!`,
            60000
        );
    }

    public async progressToNextQuestion(adapter: ContextAdapter, userId: string): Promise<GameResponse> {
        const methodName = 'progressToNextQuestion';
        const state = this.getGameState(userId);
        this.logGameState(methodName, state, 'Game state before progression');

        if (!state) {
            throw new Error('No active game found');
        }

        // Add transition emoji before new question
        await adapter.replyWithAutoDelete(this.getRandomTransitionEmoji(), 60000);
        await new Promise(resolve => setTimeout(resolve, 1000)); // Brief pause after emoji

        const nextQuestionIndex = state.currentLevel - 1;
        if (nextQuestionIndex >= state.questionBank.length) {
            await this.exitGame(adapter, userId, 'game_over');
            return {
                response: ["Congratulations! You've completed the game!"],
                metadata: {
                    gameState: null,
                    keyboard: null
                }
            };
        }

        // Select the new question from the question bank
        state.currentQuestion = state.questionBank[nextQuestionIndex];
        state.status = 'awaiting_answer';

        // Get message ID from the context
        const context = adapter.getMessageContext();
        if (context.messageId) {
            state.lastMessageId = typeof context.messageId === 'string' ?
                parseInt(context.messageId) : context.messageId;
            console.log(`[${methodName}] Stored message ID: ${state.lastMessageId}`);
        } else if (context.raw?.message?.message_id) {
            state.lastMessageId = context.raw.message.message_id;
            console.log(`[${methodName}] Stored raw message ID: ${state.lastMessageId}`);
        }

        // Update state with new question and message ID
        this.gameStates.set(userId, state);

        const prizeAmount = this.getPrizeForLevel(state.currentLevel);
        const presentation = this.formatQuestionPresentation(
            state.currentQuestion,
            `For $${prizeAmount.toLocaleString()}, here's your question...`,
            state.currentLevel
        );
        // Fix path for correct directory structure
        const getAssetPath = (filename: string): string => {
            return path.join(__dirname, '..', 'assets', filename);
        };

        const questionVideo = getAssetPath(this.getRandomVoideo());
        const keyboard = this.createGameKeyboard(state);

        if (existsSync(questionVideo)) {
            // Get the appropriate keyboard for the new question
            const media: InputMediaVideo = {
                type: 'video',
                media: { source: questionVideo },
                caption: presentation,
                parse_mode: 'HTML'
            };
            const messageId = typeof state.lastMessageId === 'string' ?
                parseInt(state.lastMessageId, 10) :
                state.lastMessageId as number;
            // If we have a message ID, update the existing message
            if (state.lastMessageId) {
                await adapter.editMessageMedia(
                    media,
                    {
                        message_id: messageId,
                        chat_id: adapter.context.chatId,
                        reply_markup: keyboard,
                    }
                );
            }
        }

        console.log(`[${methodName}] Question progressed`, {
            userId,
            level: state.currentLevel,
            question: state.currentQuestion.question,
            messageId: state.lastMessageId
        });

        return {
            response: [presentation],
            metadata: {
                gameState: state,
                keyboard: keyboard,
                requiresInput: true,
                messageId: state.lastMessageId
            }
        };
    }

    private getHostComment(level: number, prizeAmount: number): string {
        // Different arrays for different stages of the game
        const earlyGamePhrases = [
            `Alright, let's keep the momentum going! For <b>$${prizeAmount.toLocaleString()}</b>...`,
            `Feeling confident? Here's your <b>$${prizeAmount.toLocaleString()}</b> question...`,
            `You're doing great! Now, for <b>$${prizeAmount.toLocaleString()}</b>...`,
            `No pressure, but <b>$${prizeAmount.toLocaleString()}</b> is looking pretty good right about now...`,
            `Right then, let's see how you handle this <b>$${prizeAmount.toLocaleString()}</b> question...`
        ];

        const midGamePhrases = [
            `The stakes are getting higher! For <b>$${prizeAmount.toLocaleString()}</b>, pay attention to this one...`,
            `Now it's getting serious - <b>$${prizeAmount.toLocaleString()}</b> on the line...`,
            `<b>$${prizeAmount.toLocaleString()}</b> could change your day! Ready?`,
            `Things are heating up! Here's your shot at <b>$${prizeAmount.toLocaleString()}</b>...`,
            `The tension is building... For <b>$${prizeAmount.toLocaleString()}</b>...`
        ];

        const highStakesPhrases = [
            `This is the big league now - <b>$${prizeAmount.toLocaleString()}</b> hanging in the balance...`,
            `For a massive <b>$${prizeAmount.toLocaleString()}</b>, and this is a tough one...`,
            `The pressure's on! <b>$${prizeAmount.toLocaleString()}</b> is a life-changing amount...`,
            `Take your time with this one - <b>$${prizeAmount.toLocaleString()}</b> isn't pocket change...`,
            `Alright, steady nerves needed here. For <b>$${prizeAmount.toLocaleString()}</b>...`
        ];

        const finalStretchPhrases = [
            `We're in <b>rarefied air</b> now! For an incredible <b>$${prizeAmount.toLocaleString()}</b>...`,
            `Not many players make it this far! <b>$${prizeAmount.toLocaleString()}</b> question coming up...`,
            `This is what we call <b>'Eddie's territory'</b> - <b>$${prizeAmount.toLocaleString()}</b> on the line...`,
            `<b>History could be made here!</b> For <b>$${prizeAmount.toLocaleString()}</b>...`,
            `The tension in the studio is palpable! For <b>$${prizeAmount.toLocaleString()}</b>...`
        ];

        // Select appropriate array based on game level
        let phrases;
        if (level <= 5) {
            phrases = earlyGamePhrases;
        } else if (level <= 10) {
            phrases = midGamePhrases;
        } else if (level <= 13) {
            phrases = highStakesPhrases;
        } else {
            phrases = finalStretchPhrases;
        }

        // Add some special comments for milestone questions
        if (level === 5) {
            phrases = [
                `<b>First safe haven</b> coming up! For <b>$${prizeAmount.toLocaleString()}</b>...`,
                `Let's secure that <b>first safety net!</b> <b>$${prizeAmount.toLocaleString()}</b> question...`,
                `<b>First milestone question</b> - <b>$${prizeAmount.toLocaleString()}</b> coming up...`
            ];
        } else if (level === 10) {
            phrases = [
                `<b>Big moment</b> - second safe haven! For <b>$${prizeAmount.toLocaleString()}</b>...`,
                `This could secure you <b>$32,000!</b> Ready?`,
                `<b>Major milestone question</b> coming up - <b>$${prizeAmount.toLocaleString()}</b> at stake...`
            ];
        } else if (level === 15) {
            phrases = [
                `<b>This is it - the million dollar question!</b> Are you ready to make history?`,
                `For <b>$1,000,000...</b> The question that could <b>change your life</b>...`,
                `It all comes down to this - <b>the big one!</b> For <b>one million dollars</b>...`
            ];
        }

        return phrases[Math.floor(Math.random() * phrases.length)];
    }

    private formatQuestionPresentation(
        question: Question,
        intro: string,
        level: number
    ): string {
        const prizeAmount = this.getPrizeForLevel(level);
        const hostComment = this.getHostComment(level, prizeAmount);

        return `${hostComment}
    
    ${question.question}
    
     ${question.options[0]}
     ${question.options[1]}
     ${question.options[2]}
     ${question.options[3]}
    
    Lock in your answer when ready! 🎯`;
    }

    public getGameStatesSize(): number {
        return this.gameStates.size;
    }

    private logGameState(methodName: string, state: GameState | null, action: string) {
        console.log(`[GameAgent:${methodName}] ${action}:`, {
            exists: !!state,
            userId: state?.userId,
            level: state?.currentLevel,
            status: state?.status,
            isActive: state?.isActive,
            hasQuestion: !!state?.currentQuestion,
            questionText: state?.currentQuestion?.question?.substring(0, 50),
            moneyWon: state?.moneyWon,
            mapSize: this.gameStates.size
        });
    }
    private getMediaType(filePath: string): 'photo' | 'animation' | 'video' {
        const ext = path.extname(filePath).toLowerCase();
        if (['.gif'].includes(ext)) {
            return 'animation';
        } else if (['.mp4', '.avi', '.mov', '.wmv'].includes(ext)) {
            return 'video';
        }
        return 'photo'; // Default to photo for jpg, png, etc.
    }

    private getRandomTransitionEmoji(): string {
        const transitionEmojis = [
            "😎", // smooth
            "🎯", // target/focus
            "🙂", // smile
            "✨", // sparkles
            "🥂", // refresh/next
            "💫", // dizzy
            "🎲", // dice/chance
            "👏", // clapping/showtime
            "🎬", // action/next scene
            "😃", // happy
            "🌟", // star
            "💡"  // idea
        ];
        return transitionEmojis[Math.floor(Math.random() * transitionEmojis.length)];
    }

    private getRandomVoideo(): string {
        const transitionVideo = [
            'Millionaire3.mp4',
            'first_question.mp4'
        ];
        return transitionVideo[Math.floor(Math.random() * transitionVideo.length)];
    }

}