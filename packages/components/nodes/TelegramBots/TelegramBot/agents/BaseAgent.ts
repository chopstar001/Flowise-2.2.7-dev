// BaseAgent.ts
import { ConversationManager } from '../ConversationManager';
import { ToolManager } from '../ToolManager';
import { PromptManager } from '../PromptManager';
import { BaseMessage } from '@langchain/core/messages';
import { EnhancedResponse, InteractionType  } from '../commands/types';
import { ContextAdapter } from '../ContextAdapter';

export abstract class BaseAgent {
    protected conversationManager: ConversationManager | null;
    protected toolManager: ToolManager;
    protected promptManager: PromptManager;
    protected abstract getAgentName(): string;
    public abstract cleanup(): Promise<void>;

    constructor(
        conversationManager: ConversationManager | null,
        toolManager: ToolManager,
        promptManager: PromptManager
    ) {
        this.conversationManager = conversationManager;
        this.toolManager = toolManager;
        this.promptManager = promptManager;
    }

    abstract setConversationManager(manager: ConversationManager): void;

    abstract processQuery(
        input: string,
        context: string,
        chatHistory: BaseMessage[],
        interactionType: InteractionType,
        userId: string,
        adapter: ContextAdapter,
        progressKey?: string,
    ): Promise<EnhancedResponse>;
    
}