// ConversationAgent.ts
import { BaseAgent } from './BaseAgent';
import { BaseMessage } from '@langchain/core/messages';
import { ConversationManager } from '../ConversationManager';
import { ToolManager } from '../ToolManager';
import { PromptManager } from '../PromptManager';
import { EnhancedResponse, InteractionType } from '../commands/types';
import { ContextAdapter } from '../ContextAdapter';

export class ConversationAgent extends BaseAgent {
    private readonly flowId: string;
    public setConversationManager(manager: ConversationManager): void {
        this.conversationManager = manager;
        console.log(`[ConversationAgent] ConversationManager set successfully`);
    }

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
        return "ConversationAgent";
    }

    async cleanup(): Promise<void> {
        // Cleanup operations can be added here if necessary
        console.log(`[ConversationAgent] Cleanup completed`);
    }

    async generateResponse(input: string, context: string, chatHistory: BaseMessage[], userId: string, adapter: ContextAdapter): Promise<string[]> {
        if (!this.conversationManager) {
            console.warn('ConversationManager is not set in ConversationAgent');
            return ['Error: ConversationManager not initialized'];
        }
        // Determine the interaction type
        const interactionType = this.conversationManager.determineInteractionType(input, userId);
        
        // Use the existing generateResponse method from ConversationManager
        return await this.conversationManager.generateResponse(input, chatHistory, false, userId, adapter);
    }

    async processQuery(
        input: string,
        context: string,
        chatHistory: BaseMessage[],
        interactionType: InteractionType,
        userId: string,
        adapter: ContextAdapter,
        progressKey?: string,
    ): Promise<EnhancedResponse> {
        const response = await this.generateResponse(input, context, chatHistory, userId, adapter);
        
        return {
            response,
            // For now, we're not including additional enhancements for the basic conversation flow
            sourceCitations: undefined,
            followUpQuestions: undefined,
            externalAgentSuggestion: undefined,
            gameMetadata: {
                gameState: {},
                keyboard: {}
            }
        };
    }
}