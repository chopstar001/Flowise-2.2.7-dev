// AgentManager.ts
import { BaseMessage } from '@langchain/core/messages';
import { Tool } from '@langchain/core/tools';
import { logInfo, logError, logWarn, logDebug } from './loggingUtility';
import { ConversationManager } from './ConversationManager';
import { TelegramBot_Agents } from './TelegramBot_Agents';
import { IUpdateMemory, MessageContext } from './commands/types';
import { ToolManager } from './ToolManager';
import { PromptManager } from './PromptManager';
import { BaseAgent, RAGAgent, ConversationAgent, GameAgent, PatternPromptAgent } from './agents';
import { AgentFactory } from './agents/AgentFactory';
import { AgentPlugin } from './AgentPlugin';
import { ContextAdapter } from './ContextAdapter';

type SendReplyFunction = (text: string, replyToMessageId?: number) => Promise<void>;

export class AgentManager {
    private agents: Map<string, BaseAgent> = new Map();
    private conversationManager: ConversationManager | null = null;
    private collaborators: AgentManager[] = [];
    private toolManager: ToolManager;
    private telegramBot: TelegramBot_Agents | null = null;
    private promptManager: PromptManager;
    private flowId: string; // Unique identifier for the flow

    constructor(flowId: string, toolManager: ToolManager, promptManager: PromptManager) {
        this.flowId = flowId;
        this.toolManager = toolManager;
        this.promptManager = promptManager;
        this.initializeAgents();
    }

    setConversationManager(conversationManager: ConversationManager) {
        this.conversationManager = conversationManager;
        this.updateAgentsWithConversationManager();
    }

    private initializeAgents() {
        const ragAgent = AgentFactory.createAgent('rag', this.flowId, this.conversationManager, this.toolManager, this.promptManager);
        if (ragAgent) this.registerAgent('rag', ragAgent);
    
        const gameAgent = AgentFactory.createAgent(
            'game',
            this.flowId,
            this.conversationManager,
            this.toolManager,
            this.promptManager,
        );
        if (gameAgent) this.registerAgent('game', gameAgent);

        const patternAgent = AgentFactory.createAgent(
            'pattern',
            this.flowId,
            this.conversationManager,
            this.toolManager,
            this.promptManager
        );
        if (patternAgent) this.registerAgent('pattern', patternAgent);
    
    
        const conversationAgent = AgentFactory.createAgent('conversation', this.flowId, this.conversationManager, this.toolManager, this.promptManager);
        if (conversationAgent) this.registerAgent('conversation', conversationAgent);

        // Log initialization status
        logInfo('AgentManager', `Initialized agents for flow ${this.flowId}`, {
            ragAgent: !!ragAgent,
            gameAgent: !!gameAgent,
            conversationAgent: !!conversationAgent
        });
    }

    public setTelegramBot(bot: TelegramBot_Agents) {
        this.telegramBot = bot;
        logInfo('AgentManager', `[FlowID: ${this.flowId}] TelegramBot_Agents reference set`);
        
        // Reinitialize game agent with telegramBot
        const gameAgent = AgentFactory.createAgent(
            'game',
            this.flowId,
            this.conversationManager,
            this.toolManager,
            this.promptManager,
            bot
        );
        if (gameAgent) {
            this.registerAgent('game', gameAgent);
            logInfo('AgentManager', `Game agent reinitialized with TelegramBot`);
        }
    }

    registerAgent(type: string, agent: BaseAgent) {
        this.agents.set(type, agent);
        logInfo('AgentManager', `Registered agent of type: ${type}`);
    }

    getAgent(type: string): BaseAgent | null {
        const agent = this.agents.get(type);
        if (agent) {
            return agent;
        }
        logWarn('AgentManager', `Agent type '${type}' not found`);
        return null;
    }

    private updateAgentsWithConversationManager() {
        if (this.conversationManager) {
            this.agents.forEach((agent, type) => {
                if (agent && typeof agent === 'object' && 'setConversationManager' in agent) {
                    (agent as any).setConversationManager(this.conversationManager);
                    logInfo('AgentManager', `Updated ConversationManager for agent type: ${type}`);
                } else {
                    logWarn('AgentManager', `Agent of type ${type} does not have setConversationManager method or is undefined`);
                }
            });
        }
    }
    ///////////////////////////////////

    toggleRAGMode(userId: string, enable: boolean): void {
        const ragAgent = this.getAgent('rag') as RAGAgent;
        if (ragAgent) {
            ragAgent.toggleRAGMode(userId, enable);
        } else {
            console.warn(`[FlowID: ${this.flowId}] Failed to toggle RAG mode: RAG agent not found for user ${userId}`);
        }
    }

    isRAGModeEnabled(userId: string): boolean {
        const ragAgent = this.getAgent('rag') as RAGAgent;
        return ragAgent ? ragAgent.isRAGModeEnabled(userId) : false;
    }


    loadPlugin(plugin: AgentPlugin) {
        const agent = plugin.createAgent(this.flowId, this.conversationManager, this.toolManager, this.promptManager);
        if (agent) {
            this.registerAgent(plugin.type, agent);
            if (this.conversationManager && 'setConversationManager' in agent) {
                (agent as any).setConversationManager(this.conversationManager);
            }
            console.log(`[FlowID: ${this.flowId}] Plugin ${plugin.type} loaded successfully`);
        } else {
            console.warn(`[FlowID: ${this.flowId}] Failed to load plugin: ${plugin.type}`);
        }
    }

    public getRAGAgent(): RAGAgent | null {
        const ragAgent = this.agents.get('rag');
        return ragAgent instanceof RAGAgent ? ragAgent : null;
    }

    public addCollaborator(collaborator: AgentManager) {
        this.collaborators.push(collaborator);
        logInfo('AgentManager', `[FlowID: ${this.flowId}] Added a collaborator`);
    }

    async collaborativeResponse(
        userId: string, 
        sessionId: string, 
        userInput: string, 
        chatHistory: BaseMessage[], 
        sendReply: SendReplyFunction,
        adapter: ContextAdapter,
        messageId?: number
    ): Promise<string> {
        const methodName = 'collaborativeResponse';
        logInfo(methodName, `Generating response for user ${userId} in session ${sessionId}`, { flowId: this.flowId });
        
        if (!this.conversationManager) {
            const error = new Error('ConversationManager is not initialized');
            logError(methodName, error.message, error);
            if (sendReply && messageId) {
                await sendReply("I'm sorry, but I'm not ready to process messages yet.", messageId);
            }
            return "Error: ConversationManager not initialized";
        }

        logInfo(methodName, `Processing user input`, { userId, sessionId, flowId: this.flowId });

        const userMessageChunks = this.promptManager.splitAndTruncateMessage(userInput);
        let fullResponse = '';

        for (const chunk of userMessageChunks) {
            logDebug(methodName, `Processing chunk`, { userId, sessionId, chunkPreview: chunk.substring(0, 50), flowId: this.flowId });
            const resultChunks = await this.conversationManager.generateResponse(chunk, chatHistory, false, userId, adapter);
            fullResponse += resultChunks.join('\n') + '\n';
        }

        if (!fullResponse.trim()) {
            logWarn(methodName, 'Empty response generated', { userId, sessionId, flowId: this.flowId });
            if (sendReply && messageId) {
                await sendReply("I'm sorry, but I couldn't process your request. Please try again.", messageId);
            }
            return "Error: Empty response generated";
        }

        logDebug(methodName, `Response generated`, { userId, sessionId, responseLength: fullResponse.length, flowId: this.flowId });
        logInfo(methodName, `Finished processing user input`, { userId, sessionId, flowId: this.flowId });
        return fullResponse;
    }

    private determineAgentType(userInput: string, chatHistory: BaseMessage[]): string {
        if (userInput.toLowerCase().includes('search') || userInput.toLowerCase().includes('find')) {
            return 'rag';
        } else if (this.toolManager.hasToolForInput(userInput)) {
            return 'tool';
        }
        return 'conversation';
    }

    public async executeToolAction(toolName: string, input: string): Promise<string> {
        return this.toolManager.executeTool(toolName, input);
    }

    public async updateMemory(userId: string, sessionId: string, message: BaseMessage): Promise<void> {
        try {
            if (this.telegramBot) {
                const mockAdapter = this.createMockContext(userId, sessionId);
                await this.telegramBot.updateMemory(mockAdapter, [message]);
            } else {
                console.warn(`[FlowID: ${this.flowId}] TelegramBot_Agents or updateMemory method not available`);
            }
        } catch (error) {
            console.error(`[FlowID: ${this.flowId}] Error updating memory:`, error);
            throw error;
        }
    }
    
    private createMockContext(userId: string, sessionId: string): ContextAdapter {
        const mockMessageContext: MessageContext = {
            source: 'flowise', // Using 'webapi' as the generic source for mock contexts
            chatId: parseInt(sessionId, 10),
            messageId: Date.now(),
            userId: parseInt(userId, 10),
            username: 'mock_user',
            input: '',
            raw: {},
            isAI: false,
            isReply: false
        };

        return new ContextAdapter(mockMessageContext, this.promptManager);
    }
    public async cleanup(): Promise<void> {
        console.log(`[AgentManager] Starting cleanup...`);
        
        // Clean up each agent
        for (const [agentType, agent] of this.agents.entries()) {
            if (typeof (agent as any).cleanup === 'function') {
                await (agent as any).cleanup();
            }
            console.log(`[AgentManager] Cleaned up ${agentType} agent.`);
        }

        // Clear the agents map
        this.agents.clear();

        // Clean up the tool manager
        if (this.toolManager && typeof this.toolManager.cleanup === 'function') {
            await this.toolManager.cleanup();
        }

        console.log(`[AgentManager] Cleanup completed.`);
    }
}

export default AgentManager;
