// packages/components/nodes/TelegramBots/TelegramBot/plugins/DocumentProcessingAgentPlugin.ts
import { AgentPlugin } from '../AgentPlugin';
import { BaseAgent } from '../agents/BaseAgent';
import { DocumentProcessingAgent } from '../agents/DocumentProcessingAgent'; // Adjust path if needed
import { ConversationManager } from '../ConversationManager';
import { ToolManager } from '../ToolManager';
import { PromptManager } from '../PromptManager';
// DatabaseService is NOT imported here as the interface doesn't provide it
import { logError } from '../loggingUtility'; // Assuming path

export class DocumentProcessingAgentPlugin implements AgentPlugin {
    public readonly type = 'document_processor'; // Unique type identifier

    // Note: DatabaseService is NOT passed here by the standard AgentManager.loadPlugin
    createAgent(
        flowId: string,
        conversationManager: ConversationManager | null,
        toolManager: ToolManager,
        promptManager: PromptManager
        // dbService is missing here based on the interface
    ): BaseAgent | null {
        const methodName = 'DocumentProcessingAgentPlugin.createAgent';
        try {
            // Instantiate the agent, passing null for dbService.
            // The DatabaseService must be injected later using the setDatabaseService method.
            const agent = new DocumentProcessingAgent(
                flowId,
                conversationManager,
                toolManager,
                promptManager,
                null // Pass null for dbService initially
            );
            return agent;

        } catch (error) {
            logError(methodName, `Failed to create DocumentProcessingAgent`, error);
            return null;
        }
    }
}

// Export an instance for easy import and registration
export const documentProcessingAgentPlugin = new DocumentProcessingAgentPlugin();