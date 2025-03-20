// agents/AgentFactory.ts
import { BaseAgent, RAGAgent, ConversationAgent, GameAgent, PatternPromptAgent } from './';
import { ConversationManager } from '../ConversationManager';
import { ToolManager } from '../ToolManager';
import { PromptManager } from '../PromptManager';
import { TelegramBot_Agents } from '../TelegramBot_Agents';

export class AgentFactory {
    static createAgent(
        type: string | null,
        flowId: string,
        conversationManager: ConversationManager | null,
        toolManager: ToolManager,
        promptManager: PromptManager,
        telegramBot?: TelegramBot_Agents  // Add optional telegramBot parameter
    ): BaseAgent | null {
        switch (type) {
            case 'rag':
                return new RAGAgent(flowId, conversationManager, toolManager, promptManager);
            case 'game':
                if (!telegramBot) {
                    console.warn('TelegramBot not provided for GameAgent. Falling back to ConversationAgent.');
                    return new ConversationAgent(flowId, conversationManager, toolManager, promptManager);
                }
                return new GameAgent(flowId, conversationManager, toolManager, promptManager);
            case 'pattern':
                return new PatternPromptAgent(flowId, conversationManager, toolManager, promptManager);
            case 'tool':
                console.warn('ToolAgent not implemented yet. Falling back to ConversationAgent.');
            // Fallthrough intentional
            case 'conversation':
            case null:
            case undefined:
            default:
                return new ConversationAgent(flowId, conversationManager, toolManager, promptManager);
        }
    }
}