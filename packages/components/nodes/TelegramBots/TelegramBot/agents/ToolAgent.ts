// ToolAgent.ts

/*
import { BaseAgent } from './BaseAgent';
import { BaseMessage } from '@langchain/core/messages';

export class ToolAgent extends BaseAgent {
    async generateResponse(input: string, context: string, chatHistory: BaseMessage[]): Promise<string[]> {
        const prompt = this.promptManager.getContextAwarePrompt('tool', chatHistory);
        const tool = this.toolManager.selectTool(input);
        if (tool) {
            const toolResult = await this.toolManager.executeTool(tool.name, input);
            return await this.conversationManager.generateAnswer(input, toolResult, chatHistory, 'command');
        }
        return "I'm sorry, I couldn't find an appropriate tool to handle your request.";
    }
}
    */