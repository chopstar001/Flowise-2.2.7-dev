// agents/PhoneAFriendAgent.ts

import { BaseAgent } from './BaseAgent';
import { ConversationManager } from '../ConversationManager';
import { ToolManager } from '../ToolManager';
import { PromptManager } from '../PromptManager';
import { EnhancedResponse, InteractionType } from '../commands/types';
import { Question, PhoneAFriendResult } from '../commands/types';
import { ChatPromptTemplate, SystemMessagePromptTemplate, HumanMessagePromptTemplate } from '@langchain/core/prompts';
import { ContextAdapter, } from '../ContextAdapter';
import { BaseMessage, HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';
import { invokeModelWithFallback } from '../utils/modelUtility';


export class PhoneAFriendAgent extends BaseAgent {
    private readonly flowId: string;
    private readonly friendPersonas = [
        {
            name: "Professor Pat",
            expertise: "Academic knowledge and theory",
            confidence: 0.9,
            style: "methodical and analytical",
            specialties: ["history", "science", "geography", "literature"]
        },
        {
            name: "Tech Tim",
            expertise: "Technical and programming topics",
            confidence: 0.85,
            style: "precise and detailed",
            specialties: ["technology", "computers", "gaming", "internet"]
        },
        {
            name: "Business Barbara",
            expertise: "Process and system design",
            confidence: 0.8,
            style: "practical and experience-based",
            specialties: ["economics", "business", "current affairs", "politics"]
        },
        // New personas
        {
            name: "Sports Sam",
            expertise: "Sports and entertainment",
            confidence: 0.87,
            style: "enthusiastic and energetic",
            specialties: ["sports", "games", "entertainment", "pop culture"]
        },
        {
            name: "Culture Claire",
            expertise: "Arts and entertainment",
            confidence: 0.82,
            style: "creative and insightful",
            specialties: ["movies", "music", "arts", "popular media"]
        }
    ];

    constructor(
        flowId: string,
        conversationManager: ConversationManager | null,
        toolManager: ToolManager,
        promptManager: PromptManager
    ) {
        super(conversationManager, toolManager, promptManager);
        this.flowId = flowId;
    }
    getAgentName(): string {
        return "PhoneAFriendAgent";
    }

    async cleanup(): Promise<void> {
        console.log(`[PhoneAFriendAgent:${this.flowId}] Performing cleanup`);
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
        // Phone a Friend agent doesn't really need to process queries directly
        // but we need to implement the abstract method
        return {
            response: ["The Phone a Friend feature should be accessed through the main game."],
            sourceCitations: undefined,
            followUpQuestions: undefined,
            externalAgentSuggestion: null,
            gameMetadata: {
                gameState: null,
                keyboard: null
            }
        };
    }
    public async answerQuestion(
        question: Question,
        chatHistory: BaseMessage[],
        adapter: ContextAdapter
    ): Promise<PhoneAFriendResult> {
        const methodName = 'answerQuestion';
        console.log(`[${methodName}] Processing Phone-A-Friend for question: "${question.question}"`);
    
        if (!this.conversationManager) {
            throw new Error('ConversationManager not initialized');
        }
    
        try {
            const friend = this.selectFriend(question.category);
            console.log(`[${methodName}] Selected friend: ${friend.name} for category: ${question.category}`);
    
            // Get relevant context from recent chat history
            const recentHistory = chatHistory.slice(-5)
                .map(msg => `${msg.getType()}: ${msg.content}`)
                .join('\n');
    
            // Fix indentation in system prompt
            const systemPrompt = `You are ${friend.name}, a friend who's being called for help on "Who Wants to be a Millionaire".
    You are an expert in ${friend.expertise} and speak in a ${friend.style} way.
    
    Recent conversation context:
    ${recentHistory}
    
    Based on the conversation context and the question, you should:
    1. Think about any related topics discussed
    2. Consider your expertise area: ${friend.expertise}
    3. Express appropriate confidence based on your knowledge
    4. Stay in character as ${friend.name}
    5. Give natural, conversational responses
    
    Do not reveal that you're an AI or mention being a language model.
    Respond as if you're a real friend trying to help.`;
    
            console.log(`[${methodName}] Invoking model with system prompt`);
            const response = await invokeModelWithFallback(
                this.conversationManager.SpModel,
                this.conversationManager.chatModel,
                this.conversationManager.summationModel,
                [
                    new SystemMessage(systemPrompt),
                    new HumanMessage(`The question is: ${question.question}
    
    Options:
     ${question.options[0]}
     ${question.options[1]}
     ${question.options[2]}
     ${question.options[3]}
    
    Think through this carefully before answering.`)
                ],
                { initialTimeout: 30000, maxTimeout: 120000, retries: 2 }
            );
    
            // Process the response and format appropriately
            const suggestedAnswer = question.correctAnswer;
            const responseContent = response.content as string;
            const baseConfidence = this.calculateConfidence(friend, question);
    
            console.log(`[${methodName}] Generated response with confidence: ${baseConfidence}`);
    
            return {
                type: 'phoneAFriend',
                success: true,
                message: this.formatFriendResponse(
                    friend.name,
                    responseContent,
                    baseConfidence,
                    ['A', 'B', 'C', 'D'][suggestedAnswer]
                ),
                result: {
                    suggestedAnswer: ['A', 'B', 'C', 'D'][suggestedAnswer], // Fix type issue by converting to letter
                    confidence: baseConfidence,
                    reasoning: responseContent
                }
            };
    
        } catch (error) {
            console.error(`[${methodName}] Error:`, error);
            return {
                type: 'phoneAFriend',
                success: false,
                message: "📞❌ Sorry! We couldn't connect to your friend. Technical difficulties!"
            };
        }
    }
    private calculateConfidence(friend: typeof this.friendPersonas[0], question: Question): number {
        const difficultyPenalty = {
            'easy': 0,
            'medium': 0.1,
            'hard': 0.2,
            'very_hard': 0.3
        }[question.difficulty];

        return Math.max(0.3, friend.confidence - difficultyPenalty);
    }
    private selectFriend(category: string): typeof this.friendPersonas[0] {
        const matchedFriends = this.friendPersonas.filter(friend =>
            friend.specialties.some(specialty =>
                category.toLowerCase().includes(specialty) ||
                specialty.includes(category.toLowerCase())
            )
        );

        if (matchedFriends.length > 0) {
            // Return best matching friend
            return matchedFriends.reduce((best, current) => {
                const bestMatches = best.specialties.filter(s =>
                    category.toLowerCase().includes(s)).length;
                const currentMatches = current.specialties.filter(s =>
                    category.toLowerCase().includes(s)).length;
                return currentMatches > bestMatches ? current : best;
            });
        }

        // Fallback to random friend if no good match
        return this.friendPersonas[Math.floor(Math.random() * this.friendPersonas.length)];
    }
    
    // Enhance thinking process formatting
    private formatFriendResponse(
        friendName: string,
        dialogue: string,
        confidence: number,
        suggestedOption: string
    ): string {
        const thinkingTime = Math.floor(Math.random() * 3) + 2; // 2-4 seconds
        const thinkingSounds = [
            "Hmm...",
            "Let me think...",
            "Give me a moment...",
            "Ah, I know this one...",
            "Oh wait..."
        ];

        const confidencePhrases = this.getConfidencePhrases(confidence);
        const randomThinking = thinkingSounds[Math.floor(Math.random() * thinkingSounds.length)];
        const randomConfidence = confidencePhrases[Math.floor(Math.random() * confidencePhrases.length)];

        return [
            `📞 Calling ${friendName}...`,
            `💭 *${thinkingTime} seconds later*`,
            ``,
            `${friendName}: "${randomThinking}`,
            ``,
            `${dialogue}`,
            ``,
            `I'm leaning towards: ${suggestedOption}`,
            `${randomConfidence}"`,
            ``,
            `[Call ends after 30 seconds] ⏲️`
        ].join('\n');
    }

    private getConfidencePhrases(confidence: number): string[] {
        if (confidence > 0.9) {
            return [
                "I'm absolutely certain about this!",
                "Trust me on this one, mate!",
                "I'd bet my house on it!"
            ];
        } else if (confidence > 0.7) {
            return [
                "I'm pretty confident about this.",
                "I've dealt with something similar before.",
                "This is definitely familiar territory."
            ];
        } else if (confidence > 0.5) {
            return [
                "I think that might be right, but double-check.",
                "That's my best guess, but no guarantees.",
                "Sounds right, but don't stake it all on my answer."
            ];
        } else {
            return [
                "Take this with a grain of salt...",
                "I'm really not sure about this one.",
                "This isn't my strong suit, but..."
            ];
        }
    }
    public setConversationManager(manager: ConversationManager): void {
        this.conversationManager = manager;
        console.log(`[PhoneAFriendAgent:${this.flowId}] ConversationManager set successfully`);
    }
}