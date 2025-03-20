// In commands directory, add a new file ragconfig.ts:
import { Command } from '../commands/types';
import { ContextAdapter } from '../ContextAdapter';
import { ConversationManager } from '../ConversationManager';
import { IExtendedMemory } from '../commands/types';
import { RAGAgent } from '../agents/RAGAgent';
import { PromptManager } from '../PromptManager';
import { TelegramBot_Agents } from '../TelegramBot_Agents';

export const ragconfig: Command = {
    name: 'ragconfig',
    description: 'Configure RAG mode settings',
    adminOnly: true,
    execute: async (
        adapter: ContextAdapter,
        conversationManager: ConversationManager,
        memory: IExtendedMemory | null,
        userId: string,
        sessionId: string,
        promptManager: PromptManager | null,
        telegramBot: TelegramBot_Agents
    ) => {
        const context = adapter.getMessageContext();
        const input = context.input;
        const args = input.split(' ').slice(1); // Remove the command itself
        
        if (args.length === 0) {
            await adapter.reply(
                "Usage: /ragconfig [option] [value]\n\n" +
                "Available options:\n" +
                "- timeout <minutes>: Set the RAG mode inactivity timeout\n" +
                "- logging <minutes>: Set the RAG activity logging interval\n" +
                "- logging off: Disable periodic activity logging\n"
            );
            return;
        }
        
        const agentManager = conversationManager.getAgentManager();
        if (!agentManager) {
            await adapter.reply("Agent manager not available.");
            return;
        }
        
        const ragAgent = agentManager.getAgent('rag') as RAGAgent;
        if (!ragAgent) {
            await adapter.reply("RAG Agent not available.");
            return;
        }
        
        if (args[0] === 'timeout' && args.length >= 2) {
            const minutes = parseInt(args[1]);
            if (isNaN(minutes) || minutes < 1) {
                await adapter.reply("Timeout must be a positive number in minutes.");
                return;
            }
            
            // Convert minutes to milliseconds
            ragAgent.setInactivityTimeout(minutes * 60 * 1000);
            
            await adapter.reply(`RAG mode inactivity timeout set to ${minutes} minutes.`);
        } 
        else if (args[0] === 'logging' && args.length >= 2) {
            if (args[1].toLowerCase() === 'off') {
                // Disable logging
                telegramBot.clearPeriodicLogger('ragActivityReport');
                await adapter.reply("RAG activity logging disabled.");
            } else {
                const minutes = parseInt(args[1]);
                if (isNaN(minutes) || minutes < 1) {
                    await adapter.reply("Logging interval must be a positive number in minutes.");
                    return;
                }
                
                // Set up logging with the new interval
                telegramBot.setPeriodicLogger('ragActivityReport', () => {
                    try {
                        const report = ragAgent.generateRagUsageReport();
                        console.log(`[RAG Activity Report] ${JSON.stringify(report)}`);
                    } catch (error) {
                        console.error(`[RAG Activity Report] Error generating report:`, error);
                    }
                }, minutes * 60 * 1000);
                
                await adapter.reply(`RAG activity logging interval set to ${minutes} minutes.`);
            }
        }
        else {
            await adapter.reply(
                "Unknown configuration option.\n\n" +
                "Available options:\n" +
                "- timeout <minutes>: Set the RAG mode inactivity timeout\n" +
                "- logging <minutes>: Set the RAG activity logging interval\n" +
                "- logging off: Disable periodic activity logging\n"
            );
        }
    }
};