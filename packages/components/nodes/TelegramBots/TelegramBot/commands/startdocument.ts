import { Command } from './types';
import { ContextAdapter } from '../ContextAdapter';
import { ConversationManager } from '../ConversationManager';
import { IExtendedMemory } from './types';
import { PromptManager } from '../PromptManager';
import { AgentManager } from '../AgentManager';
import { DocumentProcessingAgent } from '../agents/DocumentProcessingAgent'; // Adjust path if needed
import { TelegramBot_Agents } from '../TelegramBot_Agents';
import { logInfo, logError } from '../loggingUtility';

export const startDocumentCommand: Command = {
    name: 'start_document',
    description: 'Begin the process of generating a document from a template.',
    execute: async (
        adapter: ContextAdapter,
        conversationManager: ConversationManager | null,
        memory: IExtendedMemory | null,
        userId: string,
        sessionId: string,
        promptManager: PromptManager | null,
        telegramBot: TelegramBot_Agents | null
    ) => {
        const methodName = 'startDocumentCommand.execute';
        logInfo(methodName, `User ${userId} initiated document process.`);

        if (!telegramBot) {
            logError(methodName, 'TelegramBot instance is not available.', new Error('TelegramBot null'));
            await adapter.reply("Sorry, the document processing system is not available right now.");
            return;
        }

        const agentManager = telegramBot.getAgentManager();
        if (!agentManager) {
            logError(methodName, 'AgentManager is not available.', new Error('AgentManager null'));
            await adapter.reply("Sorry, the document processing system is not available right now.");
            return;
        }

        const docAgent = agentManager.getAgent('document_processor');

        if (docAgent instanceof DocumentProcessingAgent) {
            try {
                // We need a method on the agent to initiate the process
                // Let's assume a method `initiateDocumentProcess` exists
                // This method will likely just call presentTemplateSelection internally
                // We pass the adapter so the agent can reply
                await docAgent.initiateDocumentProcess(adapter);
            } catch (error) {
                logError(methodName, 'Error initiating document process via agent:', error);
                await adapter.reply("An error occurred while starting the document process. Please try again.");
            }
        } else {
            logError(methodName, 'DocumentProcessingAgent not found or not the correct type.', new Error('Agent not found/wrong type'));
            await adapter.reply("Sorry, the document processing feature is not configured correctly.");
        }
    }
};