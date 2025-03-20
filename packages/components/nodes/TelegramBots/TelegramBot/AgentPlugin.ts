// AgentPlugin.ts
import { ToolManager } from './ToolManager';
import { PromptManager } from './PromptManager';
import { ConversationManager } from './ConversationManager';
import { BaseAgent } from './agents';
export interface AgentPlugin {
    type: string;
    createAgent(
        flowId: string,
        conversationManager: ConversationManager | null,
        toolManager: ToolManager,
        promptManager: PromptManager
    ): BaseAgent | null;
}