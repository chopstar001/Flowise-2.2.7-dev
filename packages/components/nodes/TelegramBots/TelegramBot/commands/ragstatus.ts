// commands/ragstatus.ts:
import { Command } from '../commands/types';
import { ContextAdapter } from '../ContextAdapter';
import { ConversationManager } from '../ConversationManager';
import { IExtendedMemory } from '../commands/types';
import { RAGAgent } from '../agents/RAGAgent';
import { PromptManager } from '../PromptManager';
import { TelegramBot_Agents } from '../TelegramBot_Agents';

export const ragstatus: Command = {
    name: 'ragstatus',
    description: 'Display current RAG mode status and statistics',
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
        const agentManager = conversationManager.getAgentManager();
        if (!agentManager) {
            await adapter.reply("RAG Agent not available.");
            return;
        }
        
        const ragAgent = agentManager.getAgent('rag') as RAGAgent;
        if (!ragAgent) {
            await adapter.reply("RAG Agent not available.");
            return;
        }
        
        // Generate a usage report
        const report = ragAgent.generateRagUsageReport();
        
        // Format for user viewing
        let statusMessage = `📊 **RAG Mode Status Report**\n\n`;
        statusMessage += `📅 Report Time: ${new Date().toLocaleString()}\n`;
        statusMessage += `👥 Active RAG Users: ${report.activeRagUsers}\n`;
        statusMessage += `🔄 Total Tracked Users: ${report.totalTrackedUsers}\n`;
        statusMessage += `⏱️ Inactivity Timeout: ${report.inactivityTimeout}\n\n`;
        
        statusMessage += `📈 **Activity Statistics**:\n`;
        statusMessage += `• Active in last 5 min: ${report.activityStats.activeInLast5Min}\n`;
        statusMessage += `• Active in last 30 min: ${report.activityStats.activeInLast30Min}\n`;
        statusMessage += `• Active in last hour: ${report.activityStats.activeInLastHour}\n`;
        statusMessage += `• Active in last 24 hours: ${report.activityStats.activeInLast24Hours}\n`;
        statusMessage += `• Older than 24 hours: ${report.activityStats.olderThan24Hours}\n\n`;
        
        // Include active user IDs (limited to first 10)
        const activeUsers = ragAgent.getActiveRagUsers().slice(0, 10);
        if (activeUsers.length > 0) {
            statusMessage += `🔑 **Active User IDs** (first 10):\n`;
            for (const userId of activeUsers) {
                const expiryTime = ragAgent.getTimeUntilRagModeExpiry(userId);
                statusMessage += `• ${userId} (expires in ${Math.floor(expiryTime / 1000 / 60)} min)\n`;
            }
        }
        
        await adapter.reply(statusMessage);
    }
};