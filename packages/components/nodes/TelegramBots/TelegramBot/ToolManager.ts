// ToolManager.ts

import { Tool } from '@langchain/core/tools';
import { logInfo, logError } from './loggingUtility';
import { YouTubeTool } from './tools/YouTubeTool';



export class ToolManager {
    private tools: Map<string, Tool>;
    private flowId: string;

    constructor(tools: Tool[]) {
        if (!Array.isArray(tools)) {
            throw new Error("Tools must be an array.");
        }
        this.tools = new Map(tools.map(tool => [tool.name, tool]));
        logInfo('ToolManager', `Initialized with ${this.tools.size} tools`);
        this.flowId = this.flowId;
    }

    public async executeTool(toolName: string, input: string): Promise<string> {
        try {
            const tool = this.tools.get(toolName);
            if (!tool) {
                throw new Error(`Tool ${toolName} not found`);
            }
            logInfo('ToolManager.executeTool', `Executing tool: ${toolName}`);
            return await tool.invoke(input);
        } catch (error) {
            logError('ToolManager.executeTool', `Error executing tool ${toolName}`, error as Error);
            throw error;
        }
    }

    public getToolNames(): string[] {
        return Array.from(this.tools.keys());
    }

    public addTool(tool: Tool): void {
        this.tools.set(tool.name, tool);
        logInfo('ToolManager.addTool', `Added new tool: ${tool.name}`);
    }

    public removeTool(toolName: string): boolean {
        const removed = this.tools.delete(toolName);
        if (removed) {
            logInfo('ToolManager.removeTool', `Removed tool: ${toolName}`);
        } else {
            logInfo('ToolManager.removeTool', `Tool not found: ${toolName}`);
        }
        return removed;
    }
    public hasToolForInput(input: string): boolean {
        const lowercaseInput = input.toLowerCase();
        return Array.from(this.tools.values()).some((tool: Tool) =>
            this.isToolRelevant(tool, lowercaseInput)
        );
    }

    public selectTool(input: string): Tool | null {
        const lowercaseInput = input.toLowerCase();
        const relevantTool = Array.from(this.tools.values()).find((tool: Tool) =>
            this.isToolRelevant(tool, lowercaseInput)
        );
        return relevantTool || null;
    }

    private isToolRelevant(tool: Tool, lowercaseInput: string): boolean {
        const lowercaseName = tool.name.toLowerCase();
        const lowercaseDescription = tool.description.toLowerCase();

        return lowercaseInput.includes(lowercaseName) ||
            lowercaseDescription.split(' ').some((word: string) =>
                lowercaseInput.includes(word)
            );
    }
    // ToolManager.ts (add to existing file)


    // Inside ToolManager class:
    public registerYouTubeTool(apiKey: string): void {
        if (!apiKey) {
            console.warn('No YouTube API key provided, YouTube tool will not be available');
            return;
        }
        
        try {
            const youtubeTool = new YouTubeTool(apiKey);
            this.addTool(youtubeTool);
            console.log('YouTube tool registered successfully');
        } catch (error) {
            console.error('Error registering YouTube tool:', error);
        }
    }
    public async cleanup(): Promise<void> {
        console.log(`[ToolManager] Starting cleanup...`);

        // Clean up each tool if it has a cleanup method
        for (const [toolName, tool] of this.tools.entries()) {
            if (typeof (tool as any).cleanup === 'function') {
                await (tool as any).cleanup();
            }
            console.log(`[ToolManager] Cleaned up tool: ${toolName}`);
        }

        // Clear the tools map
        this.tools.clear();

        console.log(`[ToolManager] Cleanup completed.`);
    }
}

export default ToolManager;