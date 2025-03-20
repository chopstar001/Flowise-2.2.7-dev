// RAGAgent.ts
import { BaseAgent } from './BaseAgent';
import { BaseMessage } from '@langchain/core/messages';
import { ConversationManager } from '../ConversationManager';
import { ToolManager } from '../ToolManager';
import { PromptManager } from '../PromptManager';
import { InteractionType, EnhancedResponse, SourceCitation, DocumentMetadata, ScoredDocument } from '../commands/types';
import { ContextAdapter } from '../ContextAdapter';
import { logDebug, logInfo, logWarn, logError } from '../loggingUtility';



export class RAGAgent extends BaseAgent {
    private removeDisclaimers: boolean;
    private ragModeStatus: Map<string, boolean> = new Map();
    private flowId: string;
    // Add new properties for activity tracking
    private userLastActivity: Map<string, number> = new Map();
    private inactivityTimers: Map<string, NodeJS.Timeout> = new Map();
    private INACTIVITY_TIMEOUT = 30 * 60 * 1000; // 30 minutes in milliseconds
    
    public setConversationManager(manager: ConversationManager): void {
        this.conversationManager = manager;
        console.log(`[RAGAgent:${this.flowId}] ConversationManager set successfully`);
    }
    constructor(
        flowId: string,
        conversationManager: ConversationManager | null,
        toolManager: ToolManager,
        promptManager: PromptManager,
        removeDisclaimers: boolean = true
    ) {
        super(conversationManager, toolManager, promptManager);
        this.removeDisclaimers = removeDisclaimers;
        this.flowId
    }


    getAgentName(): string {
        return "RAGAgent";
    }


    public async processQuery(
        input: string,
        context: string,
        chatHistory: BaseMessage[],
        interactionType: InteractionType,
        userId: string,
        adapter: ContextAdapter,
        progressKey?: string,
    ): Promise<EnhancedResponse> {
        const methodName = 'processQuery';
        console.log(`[${methodName}] Starting RAG query processing:`, {
            inputPreview: input.substring(0, 50),
            hasContext: !!context,
            contextLength: context?.length || 0,
            chatHistoryLength: chatHistory.length,
            userId
        });

        if (!this.conversationManager) {
            return {
                response: ["RAG system is not initialized"],
                sourceCitations: undefined,
                followUpQuestions: undefined,
                externalAgentSuggestion: undefined,
                gameMetadata: {
                    gameState: null,
                    keyboard: null
                }
            };
        }

        if (progressKey && adapter) {
            console.log(`[${methodName}:${this.flowId}] Updating progress: Preparing response`);
            await this.updateProgress(adapter, progressKey, "☕️");
        }

        const isRAGEnabled = this.isRAGModeEnabled(userId);
        const shouldUseRAG = this.shouldUseRAG(interactionType, isRAGEnabled);

        console.log(`[${methodName}] RAG status:`, {
            isRAGEnabled,
            shouldUseRAG,
            userId
        });

        let response = await this.conversationManager.generateResponse(
            input,
            chatHistory,
            false,
            userId,
            adapter
        );

        // Ensure response is an array of strings
        let responseArray = Array.isArray(response) ? response : [response];

        if (shouldUseRAG && this.removeDisclaimers) {
            console.log(`[${methodName}] Removing disclaimers from response`);
            responseArray = this.removeDisclaimersAndNotes(responseArray);
        }

        if (progressKey && adapter) {
            console.log(`[${methodName}:${this.flowId}] Updating progress: Preparing response`);
            await this.updateProgress(adapter, progressKey, "📚");
        }

        if (this.conversationManager.shouldPostProcess(input, interactionType)) {
            if (progressKey && adapter) {
                console.log(`[${methodName}:${this.flowId}] Updating progress: Applying post processing`);
                await this.updateProgress(adapter, progressKey, "🧐 Applying post processing...✈️");
            }
            response = [await this.conversationManager.postProcessResponse(response[0], input, interactionType)];
        }

        let sourceCitations: SourceCitation[] | undefined;
        let followUpQuestions: string[] | undefined;

        if (shouldUseRAG) {
            try {
                console.log(`[${methodName}] Generating source citations for context`);
                sourceCitations = await this.generateSourceCitations(context);
                console.log(`[${methodName}] Generated citations:`, {
                    count: sourceCitations?.length || 0,
                    firstCitation: sourceCitations?.[0]?.text.substring(0, 50)
                });
            } catch (error) {
                console.error(`[${methodName}] Error generating citations:`, error);
            }

            try {
                console.log(`[${methodName}] Generating follow-up questions`);
                followUpQuestions = await this.conversationManager.generateFollowUpQuestions(
                    context,
                    chatHistory,
                    true
                );
                console.log(`[${methodName}] Generated follow-up questions:`, {
                    count: followUpQuestions?.length || 0,
                    firstQuestion: followUpQuestions?.[0]?.substring(0, 50)
                });
            } catch (error) {
                console.error(`[${methodName}] Error generating follow-up questions:`, error);
            }
        }

        const enhancedResponse: EnhancedResponse = {
            response: responseArray,
            sourceCitations,
            followUpQuestions,
            externalAgentSuggestion: shouldUseRAG ?
                await this.checkForExternalAgentAssistance(input, responseArray.join('\n')) :
                undefined,
            gameMetadata: {
                gameState: null,
                keyboard: null
            }
        };

        console.log(`[${methodName}] Final enhanced response:`, {
            responseLength: enhancedResponse.response.length,
            hasCitations: !!enhancedResponse.sourceCitations && enhancedResponse.sourceCitations.length > 0,
            citationsCount: enhancedResponse.sourceCitations?.length || 0,
            hasFollowUps: !!enhancedResponse.followUpQuestions && enhancedResponse.followUpQuestions.length > 0,
            followUpsCount: enhancedResponse.followUpQuestions?.length || 0,
            shouldUseRAG
        });

        return enhancedResponse;
    }
    public removeDisclaimersAndNotes(response: string[]): string[] {
        if (!this.removeDisclaimers) {
            return response; // Return the original response if removeDisclaimers is false
        }
        const disclaimerPhrases = [
            "it's important to note",
            "it's worth mentioning",
            "please note",
            "note:",
            "disclaimer:",
            "keep in mind",
            "it should be noted",
            "it is crucial to understand",
            "it is essential to remember",
            "be aware that",
            "remember that",
            "important:",
            "caution:",
            "warning:",
            "sovereign citizens",
            "sovereign citizen",
            "allegedly",
            "it's crucial to understand",
            "it's essential to remember",
        ];

        return response.map(paragraph => {
            let modifiedParagraph = paragraph;

            disclaimerPhrases.forEach(phrase => {
                const regex = new RegExp(`(?<=\\.|^)\\s*.*${phrase}.*?(?=\\.|$)`, 'gi');
                modifiedParagraph = modifiedParagraph.replace(regex, '');
            });

            modifiedParagraph = modifiedParagraph.replace(/(?<=\.|^)\s*(However,|Although,).*?(?=\\.|$)/gi, '');
            return modifiedParagraph.trim();
        }).filter(paragraph => paragraph.length > 0);
    }

    public isRAGModeEnabled(userId: string): boolean {
        // Update the last activity timestamp whenever RAG mode is checked
        this.updateUserActivity(userId);
        const isEnabled = this.ragModeStatus.get(userId) || false;
        
        // Log at debug level to avoid excessive logging
        logDebug('isRAGModeEnabled', `Checking RAG mode for user ${userId}`, {
            userId,
            isEnabled,
            flowId: this.flowId
        });
        
        return isEnabled;
    }

    public toggleRAGMode(userId: string, enable: boolean): void {
        const methodName = 'toggleRAGMode';
        const previousState = this.ragModeStatus.get(userId) || false;
        
        // Only log if the state is changing
        if (previousState !== enable) {
            logInfo(methodName, `${enable ? 'Enabling' : 'Disabling'} RAG mode for user ${userId}`, {
                userId,
                previousState,
                newState: enable,
                flowId: this.flowId
            });
        }
        
        // Clear any existing inactivity timer
        this.clearInactivityTimer(userId);
        
        // Update the RAG mode status
        this.ragModeStatus.set(userId, enable);
        
        // Update user activity
        this.updateUserActivity(userId);
        
        // If enabling RAG mode, set a timer to disable it after inactivity
        if (enable) {
            logInfo(methodName, `Setting inactivity timer for user ${userId}`, {
                userId,
                timeout: `${this.INACTIVITY_TIMEOUT / 1000 / 60} minutes`,
                flowId: this.flowId
            });
            
            this.setInactivityTimer(userId);
        }
    }
    
    /**
     * Updates the last activity timestamp for a user
     * @param userId The user ID
     */
    private updateUserActivity(userId: string): void {
        const methodName = 'updateUserActivity';
        const previousTimestamp = this.userLastActivity.get(userId);
        const now = Date.now();
        
        this.userLastActivity.set(userId, now);
        
        // Log only if this is a new user or significant time has passed
        if (!previousTimestamp) {
            logDebug(methodName, `Tracking new user activity`, {
                userId,
                timestamp: new Date(now).toISOString(),
                flowId: this.flowId
            });
        } else {
            const elapsed = now - previousTimestamp;
            // Only log if more than 5 minutes have passed since the last activity update
            if (elapsed > 5 * 60 * 1000) {
                logInfo(methodName, `User active after ${Math.floor(elapsed / 1000 / 60)} minutes`, {
                    userId,
                    previousActivity: new Date(previousTimestamp).toISOString(),
                    currentActivity: new Date(now).toISOString(),
                    flowId: this.flowId
                });
            }
        }
    }
    
   /**
     * Sets a timer to disable RAG mode after a period of inactivity
     * @param userId The user ID
     */
   private setInactivityTimer(userId: string): void {
    const methodName = 'setInactivityTimer';
    
    // Clear any existing timer first
    this.clearInactivityTimer(userId);
    
    logDebug(methodName, `Setting inactivity timer`, {
        userId,
        timeout: `${this.INACTIVITY_TIMEOUT / 1000 / 60} minutes`,
        flowId: this.flowId
    });
    
    // Set a new timer
    const timer = setTimeout(() => {
        const lastActivity = this.userLastActivity.get(userId) || 0;
        const now = Date.now();
        const elapsed = now - lastActivity;
        
        // Check if the user has been inactive for the timeout period
        if (elapsed >= this.INACTIVITY_TIMEOUT) {
            logInfo(methodName, `Disabling RAG mode due to inactivity`, {
                userId,
                inactiveTime: `${Math.floor(elapsed / 1000 / 60)} minutes`,
                lastActivity: new Date(lastActivity).toISOString(),
                flowId: this.flowId
            });
            
            this.ragModeStatus.set(userId, false);
            this.inactivityTimers.delete(userId);
        } else {
            // User has been active, reset the timer
            logDebug(methodName, `User still active, resetting timer`, {
                userId,
                elapsed: `${Math.floor(elapsed / 1000)} seconds`,
                lastActivity: new Date(lastActivity).toISOString(),
                flowId: this.flowId
            });
            
            this.setInactivityTimer(userId);
        }
    }, this.INACTIVITY_TIMEOUT);
    
    // Store the timer reference
    this.inactivityTimers.set(userId, timer);
}

/**
 * Clears any existing inactivity timer for a user
 * @param userId The user ID
 */
private clearInactivityTimer(userId: string): void {
    const methodName = 'clearInactivityTimer';
    const timer = this.inactivityTimers.get(userId);
    
    if (timer) {
        logDebug(methodName, `Clearing inactivity timer`, {
            userId,
            flowId: this.flowId
        });
        
        clearTimeout(timer);
        this.inactivityTimers.delete(userId);
    }
}
    
    /**
     * Cleans up resources when the agent is destroyed
     * Clears all inactivity timers
     */
    async cleanup(): Promise<void> {
        const methodName = 'cleanup';
        
        logInfo(methodName, `Cleaning up RAG Agent resources`, {
            activeUsers: this.getActiveRagUsers().length,
            activeTimers: this.inactivityTimers.size,
            flowId: this.flowId
        });
        
        // Clear all inactivity timers
        for (const [userId, timer] of this.inactivityTimers.entries()) {
            logDebug(methodName, `Clearing timer for user`, {
                userId,
                flowId: this.flowId
            });
            
            clearTimeout(timer);
        }
        
        this.inactivityTimers.clear();
        
        // Log the count of active RAG users being cleared
        const activeRagUsers = this.getActiveRagUsers();
        if (activeRagUsers.length > 0) {
            logInfo(methodName, `Disabling RAG mode for all active users`, {
                userCount: activeRagUsers.length,
                users: activeRagUsers,
                flowId: this.flowId
            });
        }
        
        // Clear other data structures to avoid memory leaks
        this.userLastActivity.clear();
        this.ragModeStatus.clear();
        
        logInfo(methodName, `RAG Agent resources cleaned up successfully`, {
            flowId: this.flowId
        });
    }

    setRemoveDisclaimers(remove: boolean): void {
        this.removeDisclaimers = remove;
        console.log(`Disclaimer removal in RAG mode ${remove ? 'enabled' : 'disabled'}`);
    }

    private shouldUseRAG(interactionType: InteractionType, isRAGEnabled: boolean): boolean {
        if (isRAGEnabled) {
            return Math.random() < 0.8 || this.isComplexQuery(interactionType);
        }
        return this.isComplexQuery(interactionType);
    }

    private isComplexQuery(interactionType: InteractionType): boolean {
        return interactionType === 'explanatory_question' || interactionType === 'factual_question';
    }
    private async updateProgress(adapter: ContextAdapter, progressKey: string, stage: string): Promise<boolean> {
        if (adapter.isTelegramMessage()) {
            console.log(`[ConversationManager:${this.flowId}] Updating progress: ${stage}`);
            return await adapter.updateProgress(this.flowId, progressKey, stage);
        }
        return false;
    }


    private async generateSourceCitations(context: string | undefined): Promise<SourceCitation[]> {
        if (!context) {
            console.warn("[generateSourceCitations] Received undefined context");
            return [];
        }

        const documentBlocks = context.split(/(?=\[Relevance:)/g).filter(block => block.trim().length > 0);
        //console.log(`[generateSourceCitations] Found ${documentBlocks.length} document blocks.`);

        const documents = documentBlocks.map((block, index) => {
            // console.log(`[generateSourceCitations] Processing document block ${index + 1}:`, block.substring(0, 100) + '...');
            return this.parseDocumentBlock(block);
        });

        const sortedDocuments = documents.sort((a, b) => b.relevance - a.relevance);

        const citations: SourceCitation[] = sortedDocuments.slice(0, 8).map((doc, index) => {
            const citation: SourceCitation = {
                author: this.trimField(doc.metadata.author || 'Unknown author', 50),
                title: this.trimField(doc.metadata.title || 'Untitled', 100),
                fileName: doc.metadata.fileName || 'Unknown file',
                chunkOrder: doc.metadata.chunk_order ?? 0,
                relevance: doc.relevance,
                text: this.formatCitationText(doc.metadata, index + 1, doc.relevance),
                source: doc.metadata.fileName || 'Unknown file',
                lines: 'N/A',
                content: 'N/A'
            };

            console.log(`[generateSourceCitations] Generated citation ${index + 1}:`, citation);
            return citation;
        });

        console.log("[generateSourceCitations] Final citations:", citations);
        return citations;
    }
    /**
 * Generates source citations directly from scored documents
 * @param documents Array of scored documents
 * @returns Array of source citations
 */
    public async generateSourceCitationsFromDocs(documents: ScoredDocument[]): Promise<SourceCitation[]> {
        if (!documents || documents.length === 0) {
            console.warn("[generateSourceCitationsFromDocs] Received empty documents array");
            return [];
        }

        console.log(`[generateSourceCitationsFromDocs] Processing ${documents.length} documents`);

        const sortedDocuments = documents.sort((a, b) => b.score - a.score);

        const citations: SourceCitation[] = sortedDocuments.slice(0, 8).map((doc, index) => {
            const citation: SourceCitation = {
                author: this.trimField(doc.metadata.author || 'Unknown author', 50),
                title: this.trimField(doc.metadata.title || 'Untitled', 100),
                fileName: doc.metadata.fileName || 'Unknown file',
                chunkOrder: doc.metadata.chunk_order ?? 0,
                relevance: doc.score,
                text: this.formatCitationText(doc.metadata, index + 1, doc.score),
                source: doc.metadata.fileName || 'Unknown file',
                lines: 'N/A',
                content: 'N/A'
            };

            console.log(`[generateSourceCitationsFromDocs] Generated citation ${index + 1}:`, citation);
            return citation;
        });

        console.log("[generateSourceCitationsFromDocs] Final citations:", citations);
        return citations;
    }
    private formatCitationText(metadata: DocumentMetadata, index: number, relevance: number): string {
        const author = this.trimField(metadata.author || 'Unknown author', 50);
        const title = this.trimField(metadata.title || 'Untitled', 100);
        const fileName = metadata.fileName || 'Unknown file';
        const chunkOrder = metadata.chunk_order ?? 0;
        return `[${index}] ${author}: "${title}", File: ${fileName}, Chunk: ${chunkOrder}, Relevance: ${relevance.toFixed(3)}`;
    }

    private trimField(field: string, maxLength: number): string {
        return field.length <= maxLength ? field : field.substring(0, maxLength - 3) + '...';
    }

    private parseDocumentBlock(block: string): { content: string; metadata: DocumentMetadata; relevance: number } {
        const relevanceMatch = block.match(/\[Relevance: ([\d.]+)\]/);
        const relevance = relevanceMatch ? parseFloat(relevanceMatch[1]) : 0;

        // Remove the relevance line if it exists
        let contentAndMetadata = relevanceMatch ? block.replace(relevanceMatch[0], '').trim() : block;

        // Split content and metadata
        const metadataSplit = contentAndMetadata.split('--- Metadata: ');
        const content = metadataSplit[0].trim();
        const metadataStr = metadataSplit[1] ? metadataSplit[1].trim() : '';

        let metadata: DocumentMetadata = {
            author: 'Unknown',
            title: 'Untitled',
            fileName: 'Unknown file'
        };

        if (metadataStr) {
            try {
                const parsedMetadata = JSON.parse(metadataStr);
                metadata = { ...metadata, ...parsedMetadata };
            } catch (error) {
                console.warn("[parseDocumentBlock] Error parsing metadata:", error);
            }
        }

        // If no title in metadata, use the first 50 characters of content as title
        if (metadata.title === 'Untitled' && content) {
            metadata.title = content.split('.')[0].trim().substring(0, 50);
            if (metadata.title.length === 50) metadata.title += '...';
        }

        return { content, metadata, relevance };
    }


    private async checkForExternalAgentAssistance(input: string, response: string): Promise<string | null> {
        // Implementation for checking if external agent assistance is needed
        return null;
    }


    /**
     * Gets the time in milliseconds since the user's last activity
     * @param userId The user ID
     * @returns The time in milliseconds since the last activity, or Infinity if no activity
     */
    public getTimeSinceLastActivity(userId: string): number {
        const methodName = 'getTimeSinceLastActivity';
        const lastActivity = this.userLastActivity.get(userId);
        
        if (!lastActivity) {
            logDebug(methodName, `No activity record found for user`, {
                userId,
                flowId: this.flowId
            });
            
            return Infinity;
        }
        
        const elapsed = Date.now() - lastActivity;
        
        logDebug(methodName, `Time since last activity`, {
            userId,
            elapsed: `${Math.floor(elapsed / 1000)} seconds`,
            lastActivity: new Date(lastActivity).toISOString(),
            flowId: this.flowId
        });
        
        return elapsed;
    }
    
    /**
     * Gets the remaining time in milliseconds before RAG mode is disabled due to inactivity
     * @param userId The user ID
     * @returns The time in milliseconds before RAG mode is disabled, or 0 if not active
     */
    public getTimeUntilRagModeExpiry(userId: string): number {
        const methodName = 'getTimeUntilRagModeExpiry';
        
        if (!this.isRAGModeEnabled(userId)) {
            logDebug(methodName, `RAG mode not enabled for user`, {
                userId,
                flowId: this.flowId
            });
            
            return 0;
        }
        
        const lastActivity = this.userLastActivity.get(userId) || 0;
        const elapsed = Date.now() - lastActivity;
        const remaining = Math.max(0, this.INACTIVITY_TIMEOUT - elapsed);
        
        logDebug(methodName, `Time until RAG mode expiry`, {
            userId,
            elapsed: `${Math.floor(elapsed / 1000)} seconds`,
            remaining: `${Math.floor(remaining / 1000)} seconds`,
            lastActivity: new Date(lastActivity).toISOString(),
            flowId: this.flowId
        });
        
        return remaining;
    }
    
    /**
     * Resets the inactivity timer for a user without changing their RAG mode status
     * @param userId The user ID
     */
    public refreshUserActivity(userId: string): void {
        const methodName = 'refreshUserActivity';
        
        logInfo(methodName, `Manually refreshing user activity`, {
            userId,
            ragModeEnabled: this.isRAGModeEnabled(userId),
            flowId: this.flowId
        });
        
        this.updateUserActivity(userId);
        
        if (this.isRAGModeEnabled(userId)) {
            this.setInactivityTimer(userId);
        }
    }
    
    /**
     * Gets all users with active RAG mode
     * @returns Array of user IDs with active RAG mode
     */
    public getActiveRagUsers(): string[] {
        const methodName = 'getActiveRagUsers';
        
        const activeUsers = Array.from(this.ragModeStatus.entries())
            .filter(([_, enabled]) => enabled)
            .map(([userId, _]) => userId);
        
        logDebug(methodName, `Retrieved active RAG users`, {
            count: activeUsers.length,
            users: activeUsers,
            flowId: this.flowId
        });
        
        return activeUsers;
    }
    
    /**
     * Sets the inactivity timeout period
     * @param timeoutMs Timeout in milliseconds
     */
    public setInactivityTimeout(timeoutMs: number): void {
        const methodName = 'setInactivityTimeout';
        
        if (timeoutMs < 60000) { // Minimum 1 minute
            logWarn(methodName, `Inactivity timeout must be at least 60000ms (1 minute)`, {
                requestedTimeout: timeoutMs,
                actualTimeout: 60000,
                flowId: this.flowId
            });
            
            this.INACTIVITY_TIMEOUT = 60000;
        } else {
            this.INACTIVITY_TIMEOUT = timeoutMs;
            
            logInfo(methodName, `Inactivity timeout set to ${timeoutMs}ms`, {
                minutes: timeoutMs / 1000 / 60,
                flowId: this.flowId
            });
        }
        
        // Reset all timers with the new timeout
        const activeUsers = this.getActiveRagUsers();
        
        if (activeUsers.length > 0) {
            logInfo(methodName, `Resetting timers for all active users with new timeout`, {
                userCount: activeUsers.length,
                newTimeout: `${this.INACTIVITY_TIMEOUT / 1000 / 60} minutes`,
                flowId: this.flowId
            });
            
            for (const userId of activeUsers) {
                this.setInactivityTimer(userId);
            }
        }
    }
    
    /**
     * Adds a periodic logging of active RAG users for monitoring
     * @param intervalMs How often to log active users (defaults to 15 minutes)
     * @returns Timer ID that can be used to clear the logging
     */
    public startActiveUserLogging(intervalMs: number = 15 * 60 * 1000): NodeJS.Timeout {
        const methodName = 'startActiveUserLogging';
        
        logInfo(methodName, `Starting periodic logging of active RAG users`, {
            interval: `${intervalMs / 1000 / 60} minutes`,
            flowId: this.flowId
        });
        
        return setInterval(() => {
            const activeUsers = this.getActiveRagUsers();
            const activeTimers = this.inactivityTimers.size;
            
            logInfo(methodName, `Active RAG users periodic report`, {
                activeUserCount: activeUsers.length,
                activeTimers,
                users: activeUsers,
                flowId: this.flowId
            });
            
            // For each active user, log when their RAG mode will expire
            for (const userId of activeUsers) {
                const timeUntilExpiry = this.getTimeUntilRagModeExpiry(userId);
                const lastActivity = this.userLastActivity.get(userId) || 0;
                
                logInfo(methodName, `RAG mode expiry details`, {
                    userId,
                    minutesUntilExpiry: Math.floor(timeUntilExpiry / 1000 / 60),
                    lastActivity: new Date(lastActivity).toISOString(),
                    flowId: this.flowId
                });
            }
        }, intervalMs);
    }
    
    /**
     * Generates a system report of RAG mode usage
     * @returns A report object with statistics on RAG mode usage
     */
    public generateRagUsageReport(): any {
        const methodName = 'generateRagUsageReport';
        const now = Date.now();
        
        // Count users by activity time range
        const activityStats = {
            activeInLast5Min: 0,
            activeInLast30Min: 0,
            activeInLastHour: 0,
            activeInLast24Hours: 0,
            olderThan24Hours: 0
        };
        
        for (const [userId, lastActivity] of this.userLastActivity.entries()) {
            const elapsed = now - lastActivity;
            
            if (elapsed < 5 * 60 * 1000) {
                activityStats.activeInLast5Min++;
            }
            if (elapsed < 30 * 60 * 1000) {
                activityStats.activeInLast30Min++;
            }
            if (elapsed < 60 * 60 * 1000) {
                activityStats.activeInLastHour++;
            }
            if (elapsed < 24 * 60 * 60 * 1000) {
                activityStats.activeInLast24Hours++;
            } else {
                activityStats.olderThan24Hours++;
            }
        }
        
        const report = {
            timestamp: new Date(now).toISOString(),
            activeRagUsers: this.getActiveRagUsers().length,
            totalTrackedUsers: this.userLastActivity.size,
            activeTimers: this.inactivityTimers.size,
            inactivityTimeout: `${this.INACTIVITY_TIMEOUT / 1000 / 60} minutes`,
            activityStats,
            flowId: this.flowId
        };
        
        logInfo(methodName, `Generated RAG usage report`, report);
        
        return report;
    }
}