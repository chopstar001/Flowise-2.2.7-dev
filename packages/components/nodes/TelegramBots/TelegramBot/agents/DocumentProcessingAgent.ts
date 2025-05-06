// packages/components/nodes/TelegramBots/TelegramBot/agents/DocumentProcessingAgent.ts
import { BaseAgent } from './BaseAgent';
import { ConversationManager } from '../ConversationManager';
import { ToolManager } from '../ToolManager';
import { PromptManager } from '../PromptManager';
import { DatabaseService } from '../services/DatabaseService'; // Assuming path
import { BaseMessage } from '@langchain/core/messages';
import { EnhancedResponse, InteractionType, SessionInfo } from '../commands/types'; // Import SessionInfo
import { ContextAdapter } from '../ContextAdapter';
import * as fs from 'fs/promises';
import * as path from 'path';
import { logInfo, logError, logWarn } from '../loggingUtility'; // Assuming path
import { Markup } from 'telegraf'; // Import Markup directly
import { set, get, cloneDeep, merge } from 'lodash'; // Import lodash functions
import { v4 as uuidv4 } from 'uuid'; // <-- Import uuid
// Consider adding a date formatting library if needed for generation rules
// import { format } from 'date-fns';

// Define interfaces for our configuration map structure (mirroring the JSON)
interface PlaceholderDefinition {
    _type: string;
    description: string;
    ask?: string | { [key: string]: string }; // Allow string or object for structured asks
    options?: string[];
    _conditional_hint?: string;
    example?: string;
    validationRule?: string; // Regex pattern as a string
    _internal_flag?: boolean; // Mark internal flags
}

interface EntityFieldMap {
    [fieldName: string]: PlaceholderDefinition;
}

interface EntityDefinition {
    description: string;
    fields: EntityFieldMap;
    _allow_multiple?: boolean;
    _conditional_hint?: string;
}

interface GenerationRule {
    uses: string[]; // Input keys from collectedData
    logic?: string; // Optional description or legacy field
    operation: string; // Specific operation type (e.g., 'combine_names', 'format_date')
    params?: any; // Parameters for the operation (e.g., { separator: ' ', format: 'YYYY-MM-DD' })
    _conditional_hint?: string;
}

interface CentralMap {
    entities: { [entityName: string]: EntityDefinition };
    generation_rules: { [placeholder: string]: GenerationRule };
    global_placeholders: { [placeholder: string]: PlaceholderDefinition };
}

// Type for the items returned by scanTemplateDirectory
type TemplateStructureItem = {
    name: string;
    type: 'folder' | 'file';
    path: string;
    children?: TemplateStructureItem[];
};


// Interface for the state managed per user/session for this agent
interface DocumentProcessingState {
    chatId?: number | string; // <-- Add chatId to store the original chat ID
    selectedTemplatePath?: string;
    requiredPlaceholders?: string[]; // List of SPECIFIC keys needed for the template (from scanning)
    collectedData?: any; // Stores the structured data { user: {...}, property: [{...}], ... }
    currentQuestionKey?: string; // e.g., "user.base_name.first", "property[0].property_address_full", "user.is_married?"
    currentEntityIndex?: number; // For handling multiple instances (e.g., index of the property being asked about)
    status: 'idle' | 'selecting_template' | 'collecting_data' | 'generating_document' | 'awaiting_webapp_data' | 'error'; // <-- Add new status
    lastMessageId?: number; // Store the ID of the message with the keyboard for editing
    // Store loaded config for the current template
    currentConfig?: CentralMap | null;
    currentSystemPrompt?: string;
    // Store descriptions and instructions from README
    directoryDescription?: string;
    fileDescription?: string;
    additionalLLMInstructions?: string;
    // Added field to store the current level of templates for keyboard navigation
    currentTemplatesStructure?: TemplateStructureItem[];
    currentFolderPath?: string; // Store the current folder path being viewed
}


export class DocumentProcessingAgent extends BaseAgent {
    private dbService: DatabaseService | null = null; // Initialize as null
    private centralMap: CentralMap | null = null;
    // Key: sessionId (unique identifier for the interaction)
    public agentState: Map<string, DocumentProcessingState> = new Map(); // <-- Make public

    constructor(
        private flowId: string, // Added flowId
        conversationManager: ConversationManager | null, // Keep allowing null for flexibility, but check later
        toolManager: ToolManager,
        promptManager: PromptManager,
        dbService: DatabaseService | null // Make dbService optional in constructor
    ) {
        super(conversationManager, toolManager, promptManager);
        this.dbService = dbService; // Assign if provided
        // Ensure conversationManager is set during construction or via setConversationManager
        if (!this.conversationManager) {
             logWarn(this.getAgentName(), "ConversationManager not provided during construction. Ensure it's set before use.");
        }
        // Log warning if dbService is not provided initially
        if (!this.dbService) {
             logWarn(this.getAgentName(), "DatabaseService not provided during construction. Ensure setDatabaseService is called before use.");
        }
        this.loadCentralMap().catch(err => logError(this.getAgentName(), "Failed to load central map on init", err));
    }

    protected getAgentName(): string {
        return 'DocumentProcessingAgent';
    }

    // Required by BaseAgent
    setConversationManager(manager: ConversationManager): void {
        this.conversationManager = manager;
        logInfo(this.getAgentName(), 'ConversationManager set.');
    }

    // Setter for DatabaseService
    setDatabaseService(dbService: DatabaseService): void {
        this.dbService = dbService;
        logInfo(this.getAgentName(), 'DatabaseService set via setter.');
    }


    // Required by BaseAgent
    public async cleanup(): Promise<void> {
        logInfo(this.getAgentName(), 'Cleanup called.');
        this.agentState.clear();
    }

    private async loadCentralMap(): Promise<void> {
        try {
            // TODO: Make this path configurable
            const mapPath = path.join(__dirname, '../../../../../../server/bin/Reconveyence/central_placeholder_map.json');
            const fileContent = await fs.readFile(mapPath, 'utf-8');
            this.centralMap = JSON.parse(fileContent);
            logInfo(this.getAgentName(), 'Central placeholder map loaded successfully.');
        } catch (error) {
            logError(this.getAgentName(), 'Error loading central placeholder map:', error);
            this.centralMap = null;
        }
    }

    /**
     * Scans the template directory recursively and builds a structured list.
     */
    private async scanTemplateDirectory(
        baseDir: string,
        currentPath: string = ''
    ): Promise<TemplateStructureItem[]> {
        const fullPath = path.join(baseDir, currentPath);
        let entries;
        try {
            entries = await fs.readdir(fullPath, { withFileTypes: true });
        } catch (error) {
             logError(this.getAgentName(), `Error reading directory ${fullPath}:`, error);
             return [];
        }
        const items: TemplateStructureItem[] = [];
        for (const entry of entries) {
            if (entry.name.startsWith('.') || ['node_modules', 'README.md', 'placeholder_reference.md'].includes(entry.name) || entry.name.endsWith('.docx') || entry.name.endsWith('.js')) {
                continue;
            }
            const entryRelativePath = path.join(currentPath, entry.name);
            if (entry.isDirectory()) {
                const children = await this.scanTemplateDirectory(baseDir, entryRelativePath);
                if (children.length > 0) {
                    items.push({ name: entry.name, type: 'folder', path: entryRelativePath, children: children });
                }
            } else if (entry.isFile() && entry.name.endsWith('.md')) {
                 items.push({ name: entry.name.replace('.md', ''), type: 'file', path: entryRelativePath });
            }
        }
        items.sort((a, b) => {
            if (a.type === 'folder' && b.type === 'file') return -1;
            if (a.type === 'file' && b.type === 'folder') return 1;
            return a.name.localeCompare(b.name);
        });
        return items;
    }

    /**
     * Creates a Telegram inline keyboard markup from the structured template list.
     * Uses index in callback data to avoid exceeding Telegram's 64-byte limit.
     */
    private createTemplateSelectionKeyboard(
        templates: TemplateStructureItem[],
        currentLevelPath: string = ''
    ): any | null {
        const buttons: any[] = [];
        const maxButtonsPerRow = 1;
        let currentRow: any[] = [];

        // Use index in callback data
        templates.forEach((item, index) => {
            let buttonText = item.name;
            let callbackData = '';
            if (item.type === 'folder') {
                buttonText = `📁 ${item.name}`;
                callbackData = `docproc_nav:${index}`; // Use index for nav
            } else {
                buttonText = `📄 ${item.name}`;
                callbackData = `docproc_select:${index}`; // Use index for select
            }
            if (buttonText.length > 30) {
                buttonText = buttonText.substring(0, 47) + '...';
            }
            currentRow.push(Markup.button.callback(buttonText, callbackData));
            if (currentRow.length >= maxButtonsPerRow) {
                buttons.push(currentRow);
                currentRow = [];
            }
        });

        if (currentRow.length > 0) {
            buttons.push(currentRow);
        }

        // Add Back button if not at the root
        if (currentLevelPath) {
             // Use a fixed callback prefix for the back button
             buttons.push([Markup.button.callback('⬅️ Back', 'docproc_back')]);
        }
         buttons.push([Markup.button.callback('❌ Cancel Process', 'docproc_cancel')]);
        if (buttons.length === 0) return null;
        return Markup.inlineKeyboard(buttons);
    }

    /**
     * Loads the central configuration map and merges overrides from a template-specific README.md if it exists.
     * Also extracts descriptions and additional LLM instructions.
     */
    private async loadTemplateConfig(templateRelativePath: string): Promise<{
        mergedMap: CentralMap | null,
        requiredKeys?: string[],
        systemPrompt?: string,
        directoryDescription?: string, // Added
        fileDescription?: string,      // Added
        additionalLLMInstructions?: string // Added
    }> {
        const methodName = 'loadTemplateConfig';
        if (!this.centralMap) {
            logError(this.getAgentName(), `${methodName}: Central map is not loaded.`, new Error("Central map missing"));
            return { mergedMap: null };
        }
        let mergedMap = cloneDeep(this.centralMap);
        let systemPrompt: string | undefined = undefined;
        let requiredKeys: string[] | undefined = undefined;
        let directoryDescription: string | undefined = undefined; // Added
        let fileDescription: string | undefined = undefined;      // Added
        let additionalLLMInstructions: string | undefined = undefined; // Added
        const baseTemplateDir = path.join(__dirname, '../../../../../../server/bin/Reconveyence'); // TODO: Configurable
        const templateDir = path.dirname(path.join(baseTemplateDir, templateRelativePath));
        const readmePath = path.join(templateDir, 'README.md');

        try {
            const readmeContent = await fs.readFile(readmePath, 'utf-8');
            logInfo(this.getAgentName(), `${methodName}: Found README.md for ${templateRelativePath}`);
            const overrideRegex = /## Placeholder Overrides\s*```json\s*([\s\S]*?)\s*```/i;
            const overrideMatch = readmeContent.match(overrideRegex);
            if (overrideMatch?.[1]) {
                try {
                    const overrides = JSON.parse(overrideMatch[1]);
                    mergedMap = merge(mergedMap, overrides);
                    logInfo(this.getAgentName(), `${methodName}: Applied placeholder overrides.`);
                } catch (e) { logError(this.getAgentName(), `${methodName}: Failed to parse JSON overrides`, e); }
            }
            const promptRegex = /## LLM System Prompt\s*```(?:text)?\s*([\s\S]*?)\s*```/i;
            const promptMatch = readmeContent.match(promptRegex);
            if (promptMatch?.[1]?.trim()) {
                systemPrompt = promptMatch[1].trim();
                logInfo(this.getAgentName(), `${methodName}: Found custom LLM system prompt.`);
            }
            const requiredKeysRegex = /## Required Placeholders\s*([\s\S]*?)(?:\n##|$)/i;
            const requiredKeysMatch = readmeContent.match(requiredKeysRegex);
            if (requiredKeysMatch?.[1]) {
                requiredKeys = requiredKeysMatch[1].split(/[\n,]+/).map(k => k.trim()).filter(Boolean);
                if (requiredKeys.length > 0) {
                    logInfo(this.getAgentName(), `${methodName}: Found explicit required keys: ${requiredKeys.join(', ')}`);
                } else { requiredKeys = undefined; }
            }

            // Extract Directory Description
            const dirDescRegex = /## Directory Description\s*([\s\S]*?)(?:\n##|$)/i;
            const dirDescMatch = readmeContent.match(dirDescRegex);
            if (dirDescMatch?.[1]?.trim()) {
                directoryDescription = dirDescMatch[1].trim();
                logInfo(this.getAgentName(), `${methodName}: Found Directory Description.`);
            }

            // Extract File Description
            const fileDescRegex = /## File Description\s*([\s\S]*?)(?:\n##|$)/i;
            const fileDescMatch = readmeContent.match(fileDescRegex);
            if (fileDescMatch?.[1]?.trim()) {
                fileDescription = fileDescMatch[1].trim();
                logInfo(this.getAgentName(), `${methodName}: Found File Description.`);
            }

            // Extract Additional LLM Instructions
            const instructionsRegex = /## Additional LLM Instructions\s*```(?:text)?\s*([\s\S]*?)\s*```/i;
            const instructionsMatch = readmeContent.match(instructionsRegex);
            if (instructionsMatch?.[1]?.trim()) {
                additionalLLMInstructions = instructionsMatch[1].trim();
                logInfo(this.getAgentName(), `${methodName}: Found Additional LLM Instructions.`);
            }

        } catch (error: any) {
            if (error.code !== 'ENOENT') { // Ignore file not found errors
                logError(this.getAgentName(), `${methodName}: Error reading README.md at ${readmePath}`, error);
            } else {
                 logInfo(this.getAgentName(), `${methodName}: No README.md found for ${templateRelativePath}.`);
            }
            // Return central map and undefined for others if README doesn't exist or causes error
            return { mergedMap: this.centralMap, requiredKeys: undefined, systemPrompt: undefined, directoryDescription: undefined, fileDescription: undefined, additionalLLMInstructions: undefined };
        }
        return { mergedMap, requiredKeys, systemPrompt, directoryDescription, fileDescription, additionalLLMInstructions };
    }


    // --- Public method to start the process ---
    public async initiateDocumentProcess(adapter: ContextAdapter): Promise<EnhancedResponse> {
        const methodName = 'initiateDocumentProcess';
        logInfo(this.getAgentName(), `${methodName}: Initiating document process.`);

        if (!this.conversationManager) {
            logError(this.getAgentName(), `${methodName}: ConversationManager is not set.`, new Error("Manager missing"));
            return { response: ["Error: Agent Conversation Manager service not initialized."] };
        }
         if (!this.dbService) {
            logError(this.getAgentName(), `${methodName}: DatabaseService is not set.`, new Error("Service missing"));
            return { response: ["Error: Agent Database service not initialized."] };
        }

        // Get session info
        let sessionInfo: SessionInfo;
        try {
             sessionInfo = await this.conversationManager.getSessionInfo(adapter);
        } catch (sessionError) {
             logError(this.getAgentName(), `${methodName}: Failed to get session info.`, sessionError);
             return { response: ["Error: Could not retrieve session details."] };
        }
        const { userId, sessionId } = sessionInfo;
        const stateKey = sessionId;

        // Reset or initialize state for this session
        const profileData = await this.dbService.getDocumentProfile(userId);
        const initialState: DocumentProcessingState = {
            status: 'idle', // Start at idle to trigger template selection
            collectedData: profileData || {}
        };
        this.agentState.set(stateKey, initialState);
        logInfo(this.getAgentName(), `${methodName}: Reset state for ${stateKey}`);

        // Call the method that shows the template selection
        return await this.presentTemplateSelection(adapter, initialState);
    }

    // --- Core Logic ---
    async processQuery(
        input: string,
        context: string,
        chatHistory: BaseMessage[],
        interactionType: InteractionType,
        _userId_from_base: string, // Parameter from BaseAgent, renamed as we get it from session
        adapter: ContextAdapter,
        progressKey?: string | undefined
    ): Promise<EnhancedResponse> {
        const methodName = 'processQuery';
        // Ensure critical services are available before proceeding
        if (!this.conversationManager) {
            logError(this.getAgentName(), `${methodName}: ConversationManager is not set.`, new Error("Manager missing"));
            return { response: ["Error: Agent Conversation Manager service not initialized."] };
        }
         if (!this.dbService) {
            logError(this.getAgentName(), `${methodName}: DatabaseService is not set.`, new Error("Service missing"));
            return { response: ["Error: Agent Database service not initialized."] };
        }

        // Get session info using ConversationManager
        let sessionInfo: SessionInfo;
        try {
             sessionInfo = await this.conversationManager.getSessionInfo(adapter);
        } catch (sessionError) {
             logError(this.getAgentName(), `${methodName}: Failed to get session info.`, sessionError);
             return { response: ["Error: Could not retrieve session details."] };
        }

        const { userId, sessionId } = sessionInfo; // Use normalized userId and unique sessionId
        const stateKey = sessionId; // Use sessionId as the unique key for state
        let currentState = this.agentState.get(stateKey);

        // --- Callback Query Handling (Moved to handleDocProcCallback) ---


        // Initialize state if not present
        if (!currentState) {
            const profileData = await this.dbService.getDocumentProfile(userId); // Use userId from sessionInfo
            currentState = { status: 'idle', collectedData: profileData || {} };
            this.agentState.set(stateKey, currentState);
            logInfo(this.getAgentName(), `Initialized state for ${stateKey}`);
        }

        // --- State Machine Logic ---
        try {
            switch (currentState.status) {
                case 'idle':
                    return await this.presentTemplateSelection(adapter, currentState);

                case 'selecting_template':
                    logWarn(this.getAgentName(), `Received text input in selecting_template state for ${stateKey}`);
                    return { response: ["Please use the buttons above to select a document or navigate folders."]};

                case 'collecting_data':
                    const currentKey = currentState.currentQuestionKey;
                    const fieldConfig = this.getFieldConfig(currentKey, currentState.currentConfig);
                    const isButtonQuestion = currentKey && (currentKey.endsWith('?') || fieldConfig?._type === 'choice');

                    if (isButtonQuestion) {
                        logWarn(this.getAgentName(), `Received text input for a button-based question key: ${currentState.currentQuestionKey}`);
                        return await this.askNextQuestion(currentState, adapter, "Please use the buttons provided for the previous question.");
                    }

                    const isValid = await this.processAnswer(input, currentState);
                    if (!isValid) {
                        const validationErrorMsg = this.getValidationError(input, fieldConfig, currentKey) || "Invalid input. Please try again.";
                        return await this.askNextQuestion(currentState, adapter, validationErrorMsg);
                    }
                    await this.dbService.saveDocumentProfile(userId, currentState.collectedData); // Use userId from sessionInfo
                    const nextQuestionKey = this.findNextQuestionKey(currentState);
                    if (nextQuestionKey) {
                        currentState.currentQuestionKey = nextQuestionKey;
                        this.agentState.set(stateKey, currentState);
                        return await this.askNextQuestion(currentState, adapter);
                    } else {
                        logInfo(this.getAgentName(), `Data collection complete for ${stateKey}`);
                        currentState.status = 'generating_document';
                        this.agentState.set(stateKey, currentState);
                        // Pass userId from sessionInfo
                        return await this.processQuery('', context, chatHistory, interactionType, userId, adapter, progressKey);
                    }

                case 'generating_document':
                    const populatedDocument = await this.generateDocument(currentState);
                    logInfo(this.getAgentName(), `Document generated for ${stateKey}`);
                    this.agentState.delete(stateKey);
                    return {
                         response: [ "Document generation complete:", "```markdown\n" + populatedDocument + "\n```" ],
                         skipStandardMenu: true
                    };

                case 'error':
                default:
                    logWarn(this.getAgentName(), `Unhandled state: ${currentState.status} for ${stateKey}`);
                    currentState.status = 'idle';
                    this.agentState.set(stateKey, currentState);
                    return { response: ["An internal error occurred. Please try starting again."] };
            }
        } catch (error) {
             logError(this.getAgentName(), `Error processing query in state ${currentState?.status}:`, error);
             if (currentState) {
                 currentState.status = 'error';
                 this.agentState.set(stateKey, currentState);
             }
             return { response: ["Sorry, an error occurred while processing your request."] };
        }
    }

    /**
     * Handles callback queries specific to the DocumentProcessingAgent.
     * This method is called by the main TelegramBot_Agents class.
     */
    public async handleDocProcCallback(adapter: ContextAdapter, callbackData: string): Promise<EnhancedResponse | void> {
        const methodName = 'handleDocProcCallback';
        // Ensure critical services are available before proceeding
        if (!this.conversationManager) {
            logError(this.getAgentName(), `${methodName}: ConversationManager is not set.`, new Error("Manager missing"));
            await adapter.answerCallbackQuery('Error: Agent service not ready.');
            return { response: ["Error: Agent Conversation Manager service not initialized."] };
        }
        if (!this.dbService) {
            logError(this.getAgentName(), `${methodName}: DatabaseService is not set.`, new Error("Service missing"));
            await adapter.answerCallbackQuery('Error: Agent service not ready.');
            return { response: ["Error: Agent Database service not initialized."] };
        }

        // Get session info using ConversationManager
        let sessionInfo: SessionInfo;
        try {
            sessionInfo = await this.conversationManager.getSessionInfo(adapter);
        } catch (sessionError) {
            logError(this.getAgentName(), `${methodName}: Failed to get session info.`, sessionError);
            await adapter.answerCallbackQuery('Error: Could not get session.');
            return { response: ["Error: Could not retrieve session details."] };
        }

        const { userId, sessionId } = sessionInfo;
        const stateKey = sessionId;
        let currentState = this.agentState.get(stateKey);

        // --- Start of Moved Callback Logic ---
        const action = callbackData.split(':')[0];
        const value = callbackData.substring(action.length + 1);
        logInfo(this.getAgentName(), `${methodName}: Handling callback. Action: ${action}, Value: ${value}`);

        if (!currentState) {
            currentState = { status: 'idle', collectedData: {} };
            this.agentState.set(stateKey, currentState);
            await adapter.answerCallbackQuery('Session expired, please start again.');
            // We need to return something here, but the original logic didn't explicitly return
            // Let's send a message instead of returning an EnhancedResponse which might confuse the caller
            await adapter.reply("It seems your session expired. Please start the document process again.");
            return; // Return void as we sent a reply
        }

        // Handle answers from Yes/No/Choice keyboards
        if (action === 'docproc_answer') {
            if (currentState.status === 'collecting_data' && currentState.currentQuestionKey) {
                const answerProcessed = await this.processAnswer(String(value), currentState);
                if (answerProcessed) {
                    await this.dbService.saveDocumentProfile(userId, currentState.collectedData);
                    const nextKey = this.findNextQuestionKey(currentState);
                    if (nextKey) {
                        currentState.currentQuestionKey = nextKey;
                        this.agentState.set(stateKey, currentState);
                        await adapter.answerCallbackQuery('');
                        if (currentState.lastMessageId) {
                            try { await adapter.editMessageReplyMarkup(currentState.lastMessageId); } catch (e) { logWarn(this.getAgentName(), `Failed to remove keyboard: ${e}`); }
                        }
                        // Instead of returning, we call askNextQuestion which sends the reply
                        await this.askNextQuestion(currentState, adapter);
                        return; // Return void
                    } else {
                        currentState.status = 'generating_document';
                        this.agentState.set(stateKey, currentState);
                        await adapter.answerCallbackQuery('');
                        if (currentState.lastMessageId) {
                            try { await adapter.editMessageReplyMarkup(currentState.lastMessageId); } catch (e) { logWarn(this.getAgentName(), `Failed to remove keyboard: ${e}`); }
                        }
                        // Trigger document generation (processQuery handles this state)
                        // We need a way to re-enter processQuery or call generate directly
                        // For now, let's just log and send a message
                        logInfo(this.getAgentName(), `${methodName}: Data collection complete, triggering generation for ${stateKey}`);
                        await adapter.reply("All data collected. Generating document...");
                        const genResponse = await this.processQuery('', '', [], 'command', userId, adapter); // Re-enter processQuery
                        // The caller (TelegramBot_Agents) doesn't expect a response here,
                        // but processQuery returns one. We need to handle this.
                        // For now, let's assume processQuery handles sending the final doc.
                        return; // Return void
                    }
                } else {
                    await adapter.answerCallbackQuery('Invalid answer.');
                    // Call askNextQuestion to re-ask with error
                    await this.askNextQuestion(currentState, adapter, "Invalid input. Please select one of the options.");
                    return; // Return void
                }
            } else {
                await adapter.answerCallbackQuery('Unexpected answer.');
                await adapter.reply("Cannot process this answer right now.");
                return; // Return void
            }
        }

        // Handle navigation/selection/cancel
        if (action === 'docproc_cancel') {
            await adapter.answerCallbackQuery('Process cancelled.');
            try { if (currentState.lastMessageId) await adapter.editMessageText('Document process cancelled.', currentState.lastMessageId); }
            catch (e) { logWarn(this.getAgentName(), `Failed edit on cancel: ${e}`); }
            this.agentState.delete(stateKey);
            // No response needed, just cleanup state
            return; // Return void
        }

        // Handle Back button
        if (action === 'docproc_back') {
            const currentPath = currentState.currentFolderPath || '';
            const parentPath = currentPath ? path.dirname(currentPath) : '';
            const finalParentPath = parentPath === '.' ? '' : parentPath;
            logInfo(this.getAgentName(), `${methodName}: Handling 'Back' button. Current path: '${currentPath}', Navigating to parent path: '${finalParentPath}'`);
            currentState.currentTemplatesStructure = undefined;
            currentState.currentFolderPath = finalParentPath;
            this.agentState.set(stateKey, currentState);
            await adapter.answerCallbackQuery('Navigating back...');
            // Call presentTemplateSelection to show the parent folder
            await this.presentTemplateSelection(adapter, currentState, finalParentPath);
            return; // Return void
        }

        if (currentState.status === 'selecting_template' && currentState.currentTemplatesStructure) {
            const index = parseInt(value, 10);
            if (!isNaN(index) && index >= 0 && index < currentState.currentTemplatesStructure.length) {
                const selectedItem = currentState.currentTemplatesStructure[index];
                if (action === 'docproc_nav') {
                    if (selectedItem.type === 'folder') {
                        logInfo(this.getAgentName(), `${methodName}: Navigating to folder: ${selectedItem.path}`);
                        currentState.currentTemplatesStructure = undefined;
                        currentState.currentFolderPath = selectedItem.path;
                        this.agentState.set(stateKey, currentState);
                        await adapter.answerCallbackQuery(`Opening folder: ${selectedItem.name}`);
                        await this.presentTemplateSelection(adapter, currentState, selectedItem.path);
                        return; // Return void
                    } else {
                        logWarn(this.getAgentName(), `${methodName}: Received docproc_nav for a file: ${selectedItem.path}`);
                        await adapter.answerCallbackQuery('Cannot navigate into a file.');
                        await adapter.reply("Please select a folder to navigate or a document to process.");
                        return; // Return void
                    }
                } else if (action === 'docproc_select') {
                    if (selectedItem.type === 'file') {
                        const templatePath = selectedItem.path;
                        logInfo(this.getAgentName(), `${methodName}: Template file selected for Web App: ${templatePath}`);

                        // --- Web App Launch Logic ---
                        const docSessionId = uuidv4(); // Generate unique ID for this form session
                        const webAppBaseUrl = process.env.WEBAPP_URL || 'https://telegram-bot-webapp.on-fleek.app/'; // Replace with your actual URL or env var

                        if (webAppBaseUrl === 'https://your-webapp-on-ipfs.xyz') {
                            logWarn(methodName, 'Placeholder TELEGRAM_DOC_WEBAPP_URL is being used. Please configure the actual URL.');
                        }

                        // Construct URL with necessary parameters, ensuring chat_id is defined
                        const chatIdParam = sessionInfo.chat_id ?? ''; // Fallback to empty string if undefined
                        const chatflowId = this.flowId; // Get the chatflowId from the agent instance
                         if (!chatIdParam) {
                             logWarn(methodName, `sessionInfo.chat_id is undefined for userId ${userId}. Web App URL might be incomplete.`);
                         }
                        const webAppUrl = `${webAppBaseUrl}?userId=${encodeURIComponent(userId)}&chatId=${encodeURIComponent(chatIdParam)}&docSessionId=${encodeURIComponent(docSessionId)}&templatePath=${encodeURIComponent(templatePath)}&chatflowId=${encodeURIComponent(chatflowId)}`; // <-- Add chatflowId

                         logInfo(methodName, `Constructed Web App URL: ${webAppUrl}`);

                        // Store minimal state keyed by the docSessionId
                        // Note: We use docSessionId as the key here, NOT the bot's main sessionId (stateKey)
                        const webAppState: DocumentProcessingState = {
                            status: 'awaiting_webapp_data',
                            selectedTemplatePath: templatePath,
                            collectedData: {}, // Start with empty data for webapp
                            chatId: sessionInfo.chat_id, // <-- Store original chatId
                            // userId: userId // userId is implicitly linked via sessionInfo if needed later
                        };
                        this.agentState.set(docSessionId, webAppState);
                        logInfo(methodName, `Stored initial agent state for docSessionId: ${docSessionId}`);

                        // Remove the old keyboard/message
                        if (currentState.lastMessageId) {
                            try {
                                await adapter.editMessageReplyMarkup(currentState.lastMessageId);
                                logInfo(methodName, `Removed keyboard from message ID: ${currentState.lastMessageId}`);
                            } catch (e) {
                                logWarn(this.getAgentName(), `Failed to remove keyboard on webapp launch: ${e}`);
                            }
                        }

                        // Send the Web App button
                        await adapter.reply(
                            `📄 Please fill out the details for "${selectedItem.name}" using the form:`,
                            Markup.keyboard([
                                Markup.button.webApp('📝 Open Form', webAppUrl)
                            ]).resize().oneTime() // Show as a reply keyboard button
                        );

                        await adapter.answerCallbackQuery(`Opening form for ${selectedItem.name}...`);

                        // --- End Web App Launch Logic ---

                        // We don't call handleTemplateSelection anymore for webapp flow
                        // await this.handleTemplateSelection(selectedItem.path, currentState, adapter, stateKey, userId);
                        return; // Return void
                    } else {
                        logWarn(this.getAgentName(), `${methodName}: Received docproc_select for a folder: ${selectedItem.path}`);
                        await adapter.answerCallbackQuery('Please select a document, not a folder.');
                        await adapter.reply("Please select a document to process.");
                        return; // Return void
                    }
                }
            } else {
                logWarn(this.getAgentName(), `${methodName}: Invalid index received in callback data: ${value}`);
                await adapter.answerCallbackQuery('Invalid selection.');
                await adapter.reply("Invalid selection. Please try again.");
                return; // Return void
            }
        } else {
            logWarn(this.getAgentName(), `${methodName}: Received unexpected callback data in state ${currentState.status} or missing template structure: ${callbackData}`);
            await adapter.answerCallbackQuery('Cannot process this action right now.');
            await adapter.reply("Cannot perform that action right now.");
            return; // Return void
        }
        // --- End of Moved Callback Logic ---
    }

     /**
     * Presents the template selection menu to the user.
     */
    private async presentTemplateSelection(
        adapter: ContextAdapter,
        currentState: DocumentProcessingState,
        folderPath: string = ''
    ): Promise<EnhancedResponse> {
        const baseTemplateDir = path.join(__dirname, '../../../../../../server/bin/Reconveyence'); // TODO: Configurable
        // Get session info to build state key correctly
        if (!this.conversationManager) throw new Error("ConversationManager not set in presentTemplateSelection");
        const sessionInfo = await this.conversationManager.getSessionInfo(adapter);
        const stateKey = sessionInfo.sessionId; // Use sessionId as the key

        const methodName = 'presentTemplateSelection'; // Added for logging
        try {
            // Attempt to load README for the current folder path to get description
            let directoryDescription: string | undefined;
            if (folderPath) { // Only load if we are in a subfolder
                try {
                    // Construct a dummy file path within the folder to load its README
                    const dummyFilePath = path.join(folderPath, 'dummy.md');
                    const folderConfig = await this.loadTemplateConfig(dummyFilePath);
                    directoryDescription = folderConfig.directoryDescription;
                } catch (readmeError) {
                    logWarn(this.getAgentName(), `${methodName}: Could not load README for folder ${folderPath}`, readmeError);
                }
            }

            const templatesStructure = await this.scanTemplateDirectory(baseTemplateDir, folderPath); // Corrected variable name
            logInfo(this.getAgentName(), `${methodName}: Scanned directory '${folderPath || baseTemplateDir}'. Found ${templatesStructure.length} items.`); // Corrected variable name

            // Store the templates structure and current path in the state for callback handling
            currentState.currentTemplatesStructure = templatesStructure;
            currentState.currentFolderPath = folderPath; // Store current path
            this.agentState.set(stateKey, currentState);
            logInfo(this.getAgentName(), `${methodName}: Stored templates structure and path '${folderPath}' in state for ${stateKey}.`);


            const keyboard = this.createTemplateSelectionKeyboard(templatesStructure, folderPath);
            logInfo(this.getAgentName(), `${methodName}: Generated keyboard object:`, keyboard ? JSON.stringify(keyboard).substring(0, 200) + '...' : 'null');

            if (!keyboard) {
                logWarn(this.getAgentName(), `No templates found or keyboard could not be created for path: ${folderPath}`);
                currentState.status = 'idle';
                this.agentState.set(stateKey, currentState);
                return { response: ["No document templates found or could not display options."] };
            }

            let messageText = folderPath ? `📁 \`${folderPath}\`\n\nSelect a document or sub-folder:` : "Please select the type of document you want to generate:";
            // Prepend directory description if found
            if (directoryDescription) {
                messageText = `📁 \`${folderPath}\`\n\n*Description:* ${directoryDescription}\n\nSelect a document or sub-folder:`;
            }
            let messageIdToStore: number | undefined;

            const replyOptions: any = { reply_markup: keyboard.reply_markup }; // Ensure we pass the inner markup
            // Use Markdown if we added a description, otherwise default
            if (directoryDescription) {
                replyOptions.parse_mode = 'Markdown';
            }
            logInfo(this.getAgentName(), `${methodName}: Prepared reply options:`, replyOptions);


            if (currentState.lastMessageId && adapter.context.callbackQuery) {
                 try {
                     const msgId = typeof currentState.lastMessageId === 'number' ? currentState.lastMessageId : parseInt(String(currentState.lastMessageId), 10);
                     if (!isNaN(msgId) && adapter.telegramContext?.telegram) {
                        await adapter.telegramContext.telegram.editMessageText(
                            adapter.context.chatId, msgId, undefined, messageText,
                            replyOptions // Use constructed options
                        );
                         logInfo(this.getAgentName(), `${methodName}: Edited message with ID: ${msgId}`);
                         messageIdToStore = msgId;
                     } else {
                         logWarn(this.getAgentName(), `Cannot edit message ${currentState.lastMessageId}, sending new one.`);
                         const sentMessage = await adapter.reply(messageText, replyOptions); // Use constructed options
                         messageIdToStore = sentMessage?.message_id;
                         logInfo(this.getAgentName(), `${methodName}: Sent new message after edit failed, ID: ${messageIdToStore}`);
                     }
                     await adapter.answerCallbackQuery('');
                 } catch (editError) {
                      logError(this.getAgentName(), `${methodName}: Failed to edit message [${currentState.lastMessageId}]`, editError); // Log the error
                       // Attempt to send a new message if edit fails
                       try {
                           const sentMessage = await adapter.reply(messageText, replyOptions);
                           messageIdToStore = sentMessage?.message_id;
                           logInfo(this.getAgentName(), `${methodName}: Sent new message after edit failed, ID: ${messageIdToStore}`);
                       } catch (replyError) {
                           logError(this.getAgentName(), `${methodName}: Error sending fallback reply`, replyError);
                           // Handle failure to send even the fallback message
                           currentState.status = 'error';
                           this.agentState.set(stateKey, currentState);
                           return { response: ["Sorry, I couldn't display the document options or update the message."] };
                       }
                  }
            } else {
                // This is the initial message send (not an edit)
                try {
                    const sentMessage = await adapter.reply(messageText, replyOptions); // Use constructed options
                    messageIdToStore = sentMessage?.message_id;
                    logInfo(this.getAgentName(), `${methodName}: Sent initial message with ID: ${messageIdToStore}`);
                } catch (replyError) {
                    logError(this.getAgentName(), `${methodName}: Error sending initial reply`, replyError);
                    // If sending fails, we can't proceed with selection
                    currentState.status = 'error';
                    this.agentState.set(stateKey, currentState);
                    return { response: ["Sorry, I couldn't display the document options."] };
                }
            }

            currentState.status = 'selecting_template';
            currentState.lastMessageId = messageIdToStore;
            this.agentState.set(stateKey, currentState);
            return { response: [], skipStandardMenu: true };

        } catch (error) {
             logError(this.getAgentName(), 'Error presenting template selection:', error);
             currentState.status = 'error';
             this.agentState.set(stateKey, currentState);
             return { response: ["Sorry, I couldn't load the document templates."] };
        }
    }

    /**
     * Handles the selection of a specific template file.
     */
    private async handleTemplateSelection(
        selectedPath: string,
        currentState: DocumentProcessingState,
        adapter: ContextAdapter,
        stateKey: string, // Pass stateKey which is sessionId
        userId: string // Pass userId explicitly
    ): Promise<EnhancedResponse> {
         // Add null check for dbService
         if (!this.dbService) {
             logError(this.getAgentName(), `handleTemplateSelection: DatabaseService is not set.`, new Error("Service missing"));
             return { response: ["Error: Agent database service not initialized."] };
         }
         try {
             logInfo(this.getAgentName(), `Template selected: ${selectedPath} for ${stateKey}`);
             currentState.selectedTemplatePath = selectedPath;

             // Load config, including descriptions and instructions
             const {
                 mergedMap,
                 requiredKeys,
                 systemPrompt,
                 fileDescription, // Get new fields
                 additionalLLMInstructions // Get new fields
             } = await this.loadTemplateConfig(selectedPath);

             if (!mergedMap) {
                 throw new Error("Failed to load configuration for the selected template.");
             }
             currentState.currentConfig = mergedMap;
             currentState.currentSystemPrompt = systemPrompt;
             // Store new fields in state
             currentState.fileDescription = fileDescription;
             currentState.additionalLLMInstructions = additionalLLMInstructions;

             // Determine required placeholders: Use explicit list from README first, fallback if needed
             if (requiredKeys && requiredKeys.length > 0) {
                 currentState.requiredPlaceholders = requiredKeys;
                 logInfo(this.getAgentName(), `Using explicit required keys from README: ${requiredKeys.join(', ')}`);
             } else {
                 // Fallback: Scan the template file for {{...}} placeholders
                 logWarn(this.getAgentName(), `No explicit required keys found in README for ${selectedPath}. Scanning template file...`);
                 currentState.requiredPlaceholders = await this.scanTemplateForPlaceholders(selectedPath);
                 logInfo(this.getAgentName(), `Found keys by scanning template: ${currentState.requiredPlaceholders.join(', ')}`);
             }

             const profileData = await this.dbService.getDocumentProfile(userId); // Use passed userId
             currentState.collectedData = profileData || {};

             const nextQuestionKey = this.findNextQuestionKey(currentState);

             if (nextQuestionKey) {
                 currentState.currentQuestionKey = nextQuestionKey;
                 currentState.status = 'collecting_data';
                 try {
                    let confirmationText = `📄 **Selected:** ${path.basename(selectedPath)}\n\n`;
                    if (currentState.fileDescription) {
                        confirmationText += `*Description:* ${currentState.fileDescription}\n\n`;
                    }
                    confirmationText += `Starting data collection...`;

                    const replyOptions: any = {};
                    if (currentState.fileDescription) {
                        replyOptions.parse_mode = 'Markdown';
                    }

                    if(currentState.lastMessageId) {
                        // Corrected call signature for editMessageText
                        await adapter.editMessageText(confirmationText, currentState.lastMessageId, replyOptions);
                    } else {
                        await adapter.reply(confirmationText, replyOptions); // Pass options
                    }
                    await adapter.answerCallbackQuery(`Selected: ${path.basename(selectedPath)}`);
                 } catch (editError) {
                     logWarn(this.getAgentName(), `Failed to edit message on selection: ${editError}`);
                     // Attempt to reply if edit failed
                     try {
                         let confirmationText = `📄 **Selected:** ${path.basename(selectedPath)}\n\n`;
                         if (currentState.fileDescription) {
                             confirmationText += `*Description:* ${currentState.fileDescription}\n\n`;
                         }
                         confirmationText += `Starting data collection...`;
                         const replyOptions: any = {};
                         if (currentState.fileDescription) {
                             replyOptions.parse_mode = 'Markdown';
                         }
                         await adapter.reply(confirmationText, replyOptions);
                     } catch (replyError) {
                          logError(this.getAgentName(), `Failed to send confirmation reply after edit error`, replyError);
                     }
                 }
                 this.agentState.set(stateKey, currentState);
                 return await this.askNextQuestion(currentState, adapter);
             } else {
                 logInfo(this.getAgentName(), `All data already present for ${selectedPath}, proceeding to generation.`);
                 currentState.status = 'generating_document';
                 try {
                     let confirmationText = `📄 **Selected:** ${path.basename(selectedPath)}\n\n`;
                     if (currentState.fileDescription) {
                         confirmationText += `*Description:* ${currentState.fileDescription}\n\n`;
                     }
                     confirmationText += `All data found, generating document...`;

                     const replyOptions: any = {};
                     if (currentState.fileDescription) {
                         replyOptions.parse_mode = 'Markdown';
                     }

                     if(currentState.lastMessageId) {
                         // Corrected call signature for editMessageText
                         await adapter.editMessageText(confirmationText, currentState.lastMessageId, replyOptions);
                     } else {
                         await adapter.reply(confirmationText, replyOptions); // Pass options
                     }
                    await adapter.answerCallbackQuery(`Selected: ${path.basename(selectedPath)}`);
                 } catch (editError) {
                     logWarn(this.getAgentName(), `Failed to edit message on pre-generation: ${editError}`);
                      // Attempt to reply if edit failed
                     try {
                         let confirmationText = `📄 **Selected:** ${path.basename(selectedPath)}\n\n`;
                         if (currentState.fileDescription) {
                             confirmationText += `*Description:* ${currentState.fileDescription}\n\n`;
                         }
                         confirmationText += `All data found, generating document...`;
                         const replyOptions: any = {};
                         if (currentState.fileDescription) {
                             replyOptions.parse_mode = 'Markdown';
                         }
                         await adapter.reply(confirmationText, replyOptions);
                     } catch (replyError) {
                          logError(this.getAgentName(), `Failed to send confirmation reply after edit error`, replyError);
                     }
                 }
                 this.agentState.set(stateKey, currentState);
                 // Pass userId explicitly
                 return await this.processQuery('', '', [], 'command', userId, adapter);
             }

         } catch (error) {
             logError(this.getAgentName(), `Error handling template selection ${selectedPath}:`, error);
             currentState.status = 'error';
             this.agentState.set(stateKey, currentState);
             try {
                await adapter.answerCallbackQuery('Error processing selection.');
                if(currentState.lastMessageId) {
                    await adapter.editMessageText('An error occurred selecting that template.', currentState.lastMessageId);
                }
             } catch (ackError) {
                 logWarn(this.getAgentName(), `Failed to acknowledge callback or edit message on selection error: ${ackError}`);
             }
             return { response: ["Sorry, there was an error processing your selection."] };
         }
    }


    // --- Placeholder Helper Methods ---

    /**
     * Fallback method to scan a template file for {{placeholder}} patterns.
     */
    private async scanTemplateForPlaceholders(templateRelativePath: string): Promise<string[]> {
        const methodName = 'scanTemplateForPlaceholders';
        const baseTemplateDir = path.join(__dirname, '../../../../../../server/bin/Reconveyence'); // TODO: Configurable
        const templateFullPath = path.join(baseTemplateDir, templateRelativePath);
        try {
            const content = await fs.readFile(templateFullPath, 'utf-8');
            const regex = /\{\{([\w\.\[\]]+)\}\}/g; // Matches {{key.path}} or {{key[0].path}}
            const matches = new Set<string>();
            let match;
            while ((match = regex.exec(content)) !== null) {
                // Normalize array placeholders like property[0].name to property[].name
                const key = match[1].replace(/\[\d+\]/g, '[]');
                matches.add(key);
            }
            return Array.from(matches);
        } catch (error) {
            logError(this.getAgentName(), `${methodName}: Error scanning template file ${templateFullPath}`, error);
            return []; // Return empty list on error
        }
    }


    /**
     * Finds the next specific question key to ask the user, handling conditionals and arrays.
     * Prioritizes the requiredKeys list for the current template.
     */
    private findNextQuestionKey(currentState: DocumentProcessingState): string | null {
        const methodName = 'findNextQuestionKey';
        const config = currentState.currentConfig;
        const collectedData = currentState.collectedData || {};
        const requiredKeys = currentState.requiredPlaceholders || []; // Keys needed for THIS template

        if (!config) {
            logError(this.getAgentName(), `${methodName}: currentConfig is missing.`, new Error("Config missing"));
            return null;
        }
        if (!requiredKeys.length) {
             logWarn(this.getAgentName(), `${methodName}: No required keys specified for this template.`);
             return null; // Nothing explicitly required
        }

        // --- 1. Check Preliminary Flags ---
        // Determine which preliminary flags are relevant based on requiredKeys
        const relevantFlags: { [flagKey: string]: { entity: string, question: string } } = {};
        if (requiredKeys.some(k => k.startsWith('spouse.'))) relevantFlags['user.is_married?'] = { entity: 'spouse', question: 'Are you currently married?' };
        if (requiredKeys.some(k => k.startsWith('baby[]') || k.startsWith('father.') || k.startsWith('mother.'))) relevantFlags['user.has_offspring_to_record?'] = { entity: 'baby', question: 'Do you have offspring to record?' };
        if (requiredKeys.some(k => k.startsWith('property[]'))) relevantFlags['user.has_property_to_record?'] = { entity: 'property', question: 'Do you have property to reconvey?' };
        if (requiredKeys.some(k => k.startsWith('power_of_attorney_exception.'))) relevantFlags['user.wants_poa_exception?'] = { entity: 'power_of_attorney_exception', question: 'Do you need to keep any Powers of Attorney active?' };

        for (const flagKey in relevantFlags) {
            const flagBaseKey = flagKey.slice(0, -1); // Remove '?'
            if (get(collectedData, flagBaseKey) === undefined) {
                logInfo(this.getAgentName(), `${methodName}: Preliminary question needed: ${flagKey}`);
                return flagKey; // Ask the preliminary question
            }
        }

        // --- 2. Iterate through Required Keys ---
        let currentlyCheckingArrayEntity: string | null = null;
        let requiredFieldsForCurrentArrayIndexChecked = true; // Assume true until proven otherwise

        for (const requiredKeyTemplate of requiredKeys) { // e.g., "user.dob", "property[].address.line1"
            const keyParts = requiredKeyTemplate.split('.');
            const baseEntityKey = keyParts[0]; // e.g., "user", "property[]", "global_key"
            const entityName = baseEntityKey.replace(/\[\]$/, ''); // "user", "property", "global_key"

            const entityConfig = config.entities[entityName];
            const isArrayEntity = entityConfig?._allow_multiple ?? false;

            // --- Apply Conditional Logic ---
            if (entityConfig?._conditional_hint) {
                if (entityName === 'spouse' && get(collectedData, 'user.is_married') !== true) continue;
                if (['father', 'mother', 'baby'].includes(entityName) && get(collectedData, 'user.has_offspring_to_record') !== true) continue;
                if (entityName === 'property' && get(collectedData, 'user.has_property_to_record') !== true) continue;
                if (entityName === 'power_of_attorney_exception' && get(collectedData, 'user.wants_poa_exception') !== true) continue;
                // Add more conditions as needed
            }

            let specificKeyToCheck: string;

            if (isArrayEntity) {
                const currentEntityIndex = currentState.currentEntityIndex ?? 0;
                // Construct the specific key for the current instance
                // e.g., "property[].address.line1" -> "property[0].address.line1"
                specificKeyToCheck = requiredKeyTemplate.replace('[]', `[${currentEntityIndex}]`);

                // Track which array entity we are currently checking
                if (currentlyCheckingArrayEntity !== entityName) {
                    // Starting a new array entity or first time checking this one
                    currentlyCheckingArrayEntity = entityName;
                    requiredFieldsForCurrentArrayIndexChecked = true; // Reset for this entity/index
                }

            } else {
                // Simple entity or global placeholder
                specificKeyToCheck = requiredKeyTemplate;
                 // If we switch from an array entity back to a non-array, reset the tracking
                 if (currentlyCheckingArrayEntity !== null) {
                    currentlyCheckingArrayEntity = null;
                    requiredFieldsForCurrentArrayIndexChecked = true;
                 }
            }

            // --- Check if this is a generated placeholder ---
            const generationRule = config.generation_rules[requiredKeyTemplate];
            if (generationRule) {
                let allInputsPresent = true;
                let missingInputKey: string | null = null;
                for (const inputKey of generationRule.uses) {
                    // Need to handle potential array indices in input keys if rules depend on specific array elements
                    // For now, assume rules use base paths like 'user.gender' or 'user.base_name.first'
                    const inputValue = get(collectedData, inputKey);
                    if (inputValue === undefined || inputValue === null || (typeof inputValue === 'string' && inputValue.trim() === '')) {
                        // Allow optional middle name input to be missing for generation rules that use it
                        if (inputKey.endsWith('.middle')) {
                            const inputFieldConfig = this.getFieldConfig(inputKey, config);
                            if (inputFieldConfig?._type === 'name') {
                                logInfo(this.getAgentName(), `${methodName}: Optional middle name input '${inputKey}' for rule '${requiredKeyTemplate}' is missing, allowing rule to proceed.`);
                                continue; // Check next input for the rule
                            }
                        }
                        // Found a missing input needed for the generation rule
                        allInputsPresent = false;
                        missingInputKey = inputKey;
                        logInfo(this.getAgentName(), `${methodName}: Required placeholder '${requiredKeyTemplate}' needs input '${inputKey}', which is missing.`);
                        break; // Stop checking inputs for this rule
                    }
                }

                if (!allInputsPresent && missingInputKey) {
                    // Ask for the missing input key needed by the rule
                    return missingInputKey;
                } else {
                    // All inputs for the generation rule are present.
                    // We don't need to ask for the generated placeholder itself.
                    logInfo(this.getAgentName(), `${methodName}: All inputs for generated placeholder '${requiredKeyTemplate}' are present. Skipping.`);
                    continue; // Move to the next required key
                }
            }

            // --- Not a generated placeholder, or generation failed (shouldn't happen with above logic) ---
            // Check if the value for the specific key is missing directly
            const value = get(collectedData, specificKeyToCheck);
            if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
                 // Special handling for optional middle name - if the key ends with '.middle', allow empty/null
                 if (specificKeyToCheck.endsWith('.middle')) {
                     const fieldConfig = this.getFieldConfig(specificKeyToCheck, config);
                     if (fieldConfig?._type === 'name') {
                         // It's an optional middle name, skip asking if undefined/null/empty
                         logInfo(this.getAgentName(), `${methodName}: Optional middle name '${specificKeyToCheck}' is missing, skipping.`);
                         continue; // Move to the next required key
                     }
                 }

                 // Found a required key that is missing
                 logInfo(this.getAgentName(), `${methodName}: Next question key found: ${specificKeyToCheck}`);
                 // If it was an array key, ensure the state reflects the index being worked on
                 if (isArrayEntity) {
                     currentState.currentEntityIndex = currentState.currentEntityIndex ?? 0;
                 }
                 return specificKeyToCheck;
            } else {
                 // Value exists for this specific required key
                 if (isArrayEntity) {
                     // We are still checking required fields for the current array index
                 }
            }
        } // End loop through requiredKeys

        // --- 3. Check for 'add_another?' ---
        // If we finished iterating through requiredKeys and were checking an array entity...
        if (currentlyCheckingArrayEntity) {
            const currentEntityIndex = currentState.currentEntityIndex ?? 0;
            const entityArrayPath = currentlyCheckingArrayEntity;
            const currentInstancePath = `${entityArrayPath}[${currentEntityIndex}]`;

            // Check if we have already asked 'add_another?' for this instance
            if (get(collectedData, `${currentInstancePath}.asked_add_another`) !== true) {
                logInfo(this.getAgentName(), `${methodName}: All required fields for ${currentlyCheckingArrayEntity}[${currentEntityIndex}] collected. Asking to add another.`);
                return `${currentlyCheckingArrayEntity}.add_another?`;
            } else {
                 // We already asked and user said 'no' or we moved on.
                 // This case should ideally not be reached if logic is correct,
                 // as saying 'no' should reset currentEntityIndex.
                 logWarn(this.getAgentName(), `${methodName}: Reached end of loop, was checking array '${currentlyCheckingArrayEntity}', but 'add_another' was already handled.`);
            }
        }

        // --- 4. All Data Collected ---
        currentState.currentEntityIndex = undefined; // Reset index if we finished
        logInfo(this.getAgentName(), `${methodName}: All required placeholders for this template seem collected.`);
        return null;
    }


    /**
     * Asks the next question based on the current state.
     */
    private async askNextQuestion(
        currentState: DocumentProcessingState,
        adapter: ContextAdapter,
        prefixMessage?: string
    ): Promise<EnhancedResponse> {
        const methodName = 'askNextQuestion';
        const key = currentState.currentQuestionKey;
        const config = currentState.currentConfig;
        const stateKey = `${adapter.context.userId}_${adapter.context.chatId}`;

        if (!key) {
             logError(this.getAgentName(), `${methodName}: Called without currentQuestionKey`, new Error("Missing currentQuestionKey"));
             currentState.status = 'error';
             this.agentState.set(stateKey, currentState);
             return { response: ["Internal error: Cannot determine next question."] };
        }
        if (!config) {
             logError(this.getAgentName(), `${methodName}: Called without currentConfig`, new Error("Missing currentConfig"));
             currentState.status = 'error';
             this.agentState.set(stateKey, currentState);
             return { response: ["Internal error: Configuration not loaded."] };
        }

        let questionText = "";
        let keyboard = undefined;
        let finalMessage = "";

        // Handle special keys (preliminary flags, add another)
        if (key.endsWith('?')) {
            const baseKey = key.slice(0, -1);
            const preliminaryFlags: { [flagKey: string]: { entity: string, question: string } } = {
                'user.is_married': { entity: 'spouse', question: 'Are you currently married?' },
                'user.has_offspring_to_record': { entity: 'baby', question: 'Do you have offspring to record?' },
                'user.has_property_to_record': { entity: 'property', question: 'Do you have property to reconvey?' },
                'user.wants_poa_exception': { entity: 'power_of_attorney_exception', question: 'Do you need to keep any Powers of Attorney active?' }
            };

            if (baseKey.endsWith('.add_another')) {
                const entityName = baseKey.split('.')[0];
                questionText = `Do you need to add another ${entityName}?`;
            } else if (preliminaryFlags[baseKey]) {
                questionText = preliminaryFlags[baseKey].question;
            } else {
                questionText = `Please confirm: ${baseKey}?`; // Fallback
            }
            keyboard = Markup.inlineKeyboard([
                 Markup.button.callback('Yes', `docproc_answer:yes`),
                 Markup.button.callback('No', `docproc_answer:no`)
            ]);
            finalMessage = prefixMessage ? `${prefixMessage}\n${questionText}` : questionText;

        } else {
            // Handle regular data fields
            const fieldConfig = this.getFieldConfig(key, config); // Use helper to get config

            if (fieldConfig?.ask && typeof fieldConfig.ask === 'string') {
                questionText = fieldConfig.ask;
            } else {
                // Fallback if 'ask' is missing or not a string
                questionText = `Please provide: ${key}`; // Use the specific key (e.g., user.base_name.first)
                logWarn(this.getAgentName(), `${methodName}: No specific question found for key ${key}. Using fallback.`);
            }

            finalMessage = prefixMessage ? `${prefixMessage}\n${questionText}` : questionText;

            if (fieldConfig?._type === 'choice' && fieldConfig.options) {
                 keyboard = Markup.inlineKeyboard(
                     fieldConfig.options.map(option =>
                        Markup.button.callback(option, `docproc_answer:${option}`)
                     ),
                     { columns: fieldConfig.options.length > 2 ? 2 : 1 }
                 );
            }
        }

        const sentMessage = await adapter.reply(finalMessage, keyboard ? { reply_markup: keyboard } : undefined);
        currentState.lastMessageId = sentMessage?.message_id;
        this.agentState.set(stateKey, currentState);

        return { response: [], skipStandardMenu: true };
    }

    /**
     * Processes and validates the user's answer.
     */
    private async processAnswer(input: string, currentState: DocumentProcessingState): Promise<boolean> {
        const methodName = 'processAnswer';
        const key = currentState.currentQuestionKey;
        const config = currentState.currentConfig;
        logInfo(this.getAgentName(), `${methodName}: Processing answer for key: ${key}, Input: ${input}`);

        if (!key || !config) {
             logError(this.getAgentName(), `${methodName}: Missing key or config`, new Error("State error"));
            return false;
        }

        // Handle special key answers (Yes/No for flags and add_another)
        if (key.endsWith('?')) {
            const baseKey = key.slice(0, -1);
            const answer = input.toLowerCase(); // Input here is 'yes' or 'no' from callback

            if (answer !== 'yes' && answer !== 'no') {
                logWarn(this.getAgentName(), `Invalid boolean answer received for ${key}: ${input}`);
                return false; // Invalid answer
            }
            const booleanValue = answer === 'yes';

            if (baseKey.endsWith('.add_another')) {
                const entityName = baseKey.split('.')[0];
                const currentInstancePath = `${entityName}[${currentState.currentEntityIndex ?? 0}]`;
                set(currentState.collectedData, `${currentInstancePath}.asked_add_another`, true); // Use set

                if (booleanValue) {
                    currentState.currentEntityIndex = (currentState.currentEntityIndex ?? 0) + 1;
                    logInfo(this.getAgentName(), `User wants to add another ${entityName}. Incrementing index to ${currentState.currentEntityIndex}.`);
                } else {
                    currentState.currentEntityIndex = undefined; // Reset index
                    logInfo(this.getAgentName(), `User is done adding ${entityName}.`);
                }
            } else {
                 set(currentState.collectedData, baseKey, booleanValue); // Use set
                 logInfo(this.getAgentName(), `Stored boolean flag for ${baseKey}: ${booleanValue}`);
            }
             currentState.currentQuestionKey = undefined; // Clear current question key after handling
             return true; // Processed successfully

        } else {
            // --- Process regular data input ---
            const fieldConfig = this.getFieldConfig(key, config); // Use helper to get config

            // Perform validation using the new helper
            const validationError = this.getValidationError(input, fieldConfig, key); // Pass key here
            if (validationError !== null) {
                logWarn(this.getAgentName(), `${methodName}: Validation failed for key ${key}. Error: ${validationError}`);
                // We don't return the error message here, askNextQuestion will handle prefixing it
                return false; // Indicate validation failure
            }

            // Store validated data
            try {
                set(currentState.collectedData, key, input.trim());
                logInfo(this.getAgentName(), `Stored answer for ${key}: ${input.trim()}`);
                currentState.currentQuestionKey = undefined;
                return true;
            } catch (e) {
                logError(this.getAgentName(), `Error setting value for key ${key}`, e);
                return false;
            }
        }
    }

    /**
     * Validates user input based on the field configuration.
     */
    private getValidationError(
        input: string,
        fieldConfig: PlaceholderDefinition | undefined,
        currentQuestionKey: string | undefined // Pass the key
    ): string | null {
        const methodName = 'getValidationError';
        if (!fieldConfig) {
            return null; // No config, no validation
        }

        const trimmedInput = input.trim();

        // Basic non-empty check
        if (!trimmedInput) {
            // Allow empty string for optional middle name
             if (fieldConfig._type === 'name' && currentQuestionKey?.endsWith('.middle')) {
                 return null;
             }
            return "Input cannot be empty.";
        }

        // Type-specific validation
        switch (fieldConfig._type) {
            case 'date':
                if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmedInput)) {
                    return "Invalid date format. Please use YYYY-MM-DD.";
                }
                break;
            case 'year':
                 if (!/^\d{4}$/.test(trimmedInput)) {
                     return "Invalid year format. Please use YYYY.";
                 }
                 break;
            case 'day_of_month':
                 const day = parseInt(trimmedInput, 10);
                 if (isNaN(day) || day < 1 || day > 31) {
                     return "Invalid day. Please enter a number between 1 and 31.";
                 }
                 break;
            case 'number':
                 if (isNaN(Number(trimmedInput))) {
                     return "Invalid number. Please enter a valid number.";
                 }
                 break;
            case 'choice':
                 // Check if the input is one of the allowed options (case-insensitive check might be better)
                 if (fieldConfig.options && !fieldConfig.options.includes(trimmedInput)) {
                     return `Invalid choice. Please select one of: ${fieldConfig.options.join(', ')}`;
                 }
                 break;
        }

        // Regex validation rule
        if (fieldConfig.validationRule) {
            try {
                const regex = new RegExp(fieldConfig.validationRule);
                if (!regex.test(trimmedInput)) {
                    logWarn(this.getAgentName(), `${methodName}: Input failed validation regex for config: ${JSON.stringify(fieldConfig)} Input: ${trimmedInput}`);
                    return fieldConfig.description ? `Invalid format for ${fieldConfig.description}.` : "Input format is invalid.";
                }
            } catch (regexError) {
                 logError(this.getAgentName(), `${methodName}: Invalid validation regex in config for key ${currentQuestionKey}`, regexError);
            }
        }
        return null; // All checks pass
    }


    /**
     * Generates the final document content, applying generation rules.
     */
    private async generateDocument(currentState: DocumentProcessingState): Promise<string> {
        const methodName = 'generateDocument';
        if (!currentState.selectedTemplatePath) {
            logError(this.getAgentName(), `${methodName}: No template path selected in state.`, new Error("Template path missing"));
            return "Error: No template selected.";
        }
        if (!currentState.collectedData) {
            logWarn(this.getAgentName(), `${methodName}: No collected data found in state.`);
            // Proceed, but placeholders might be missing
        }
        if (!currentState.currentConfig) {
            logError(this.getAgentName(), `${methodName}: No currentConfig found in state.`, new Error("Config missing"));
            return "Error: Configuration not loaded for template.";
        }

        const baseTemplateDir = path.join(__dirname, '../../../../../../server/bin/Reconveyence'); // TODO: Configurable
        const templateFullPath = path.join(baseTemplateDir, currentState.selectedTemplatePath);

        try {
            const templateContent = await fs.readFile(templateFullPath, 'utf-8');
            let populatedContent = templateContent;
            const placeholderRegex = /\{\{([\w\.\[\]]+)\}\}/g;
            const placeholders = new Set<string>();
            let match;

            // Find all unique placeholders in the template
            while ((match = placeholderRegex.exec(templateContent)) !== null) {
                placeholders.add(match[1]);
            }

            logInfo(this.getAgentName(), `${methodName}: Found ${placeholders.size} unique placeholders in template: ${currentState.selectedTemplatePath}`);

            const generationRules = currentState.currentConfig.generation_rules || {};
            const collectedData = currentState.collectedData || {};

            // Replace each placeholder
            placeholders.forEach(key => {
                let value: string | undefined;
                const rule = generationRules[key];

                if (rule) {
                    // --- Apply Generation Rule ---
                    logInfo(this.getAgentName(), `${methodName}: Applying generation rule for placeholder: ${key}`);
                    try {
                        value = this.applyGenerationRule(rule, collectedData);
                    } catch (ruleError) {
                        logError(this.getAgentName(), `${methodName}: Error applying rule for ${key}`, ruleError);
                        value = `[RULE_ERROR:${key}]`;
                    }
                } else {
                    // --- Simple Substitution ---
                    const simpleValue = get(collectedData, key); // Use lodash.get
                    // Ensure the simple value is a string or handle appropriately
                    if (simpleValue !== undefined && simpleValue !== null) {
                        value = String(simpleValue);
                    }
                }

                // Handle missing values or rule errors
                if (value === undefined || value === null) {
                    value = `[${key}_MISSING]`;
                    logWarn(this.getAgentName(), `${methodName}: Value for placeholder ${key} is missing.`);
                }

                // Replace placeholder in content
                const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const replaceRegex = new RegExp(`\\{\\{${escapedKey}\\}\\}`, 'g');
                populatedContent = populatedContent.replace(replaceRegex, value); // Value is already string or error string
            });

            logInfo(this.getAgentName(), `${methodName}: Document populated successfully.`);
            return `--- Document: ${currentState.selectedTemplatePath} ---\n\n${populatedContent}\n\n--- End Document ---`;

        } catch (error) {
             logError(this.getAgentName(), `${methodName}: Error reading or processing template file ${templateFullPath}`, error);
             return `Error generating document: Could not read or process template file.`;
        }
    }

    /**
     * Applies a specific generation rule to produce a placeholder value.
     */
    private applyGenerationRule(rule: GenerationRule, data: any): string {
        const methodName = 'applyGenerationRule';
        const inputValues: { [key: string]: any } = {};
        let missingInput = false;

        // Gather required input values specified in 'uses'
        rule.uses.forEach(inputKey => {
            const val = get(data, inputKey);
            // Allow empty strings for optional fields (like middle name) but flag undefined/null
            if (val === undefined || val === null) {
                 // Check if the missing key corresponds to an optional field (e.g., middle name)
                 // This requires looking up the config, which might be complex here.
                 // For now, we'll log a warning but allow the rule to proceed if possible.
                 logWarn(this.getAgentName(), `${methodName}: Input '${inputKey}' is missing or null for rule using keys: ${rule.uses.join(', ')}`);
                 // If the rule absolutely cannot function without this input, set missingInput = true
                 // Example: A date formatting rule needs the date.
                 if (rule.operation === 'format_date') missingInput = true;
            }
            inputValues[inputKey] = val ?? ''; // Default to empty string if null/undefined
        });

        if (missingInput) {
            return `[RULE_INPUT_MISSING: Required input for ${rule.uses.join(', ')}]`;
        }

        // Execute logic based on operation
        try {
            switch (rule.operation) {
                case 'combine_names': {
                    // uses: ["user.base_name.first", "user.base_name.middle", "user.base_name.last"]
                    // params: { format: "first_middle_last" | "last_first_middle" | "first_last", separator: " " }
                    const format = rule.params?.format || "first_middle_last";
                    const separator = rule.params?.separator || " ";
                    const first = String(inputValues[rule.uses[0]] || '');
                    const middle = String(inputValues[rule.uses[1]] || '');
                    const last = String(inputValues[rule.uses[2]] || '');
                    let parts: string[] = [];

                    if (format === "first_middle_last") {
                        parts = [first, middle, last];
                    } else if (format === "last_first_middle") {
                        parts = [last, first, middle];
                    } else if (format === "first_last") {
                        parts = [first, last];
                    } else {
                         parts = [first, middle, last]; // Default
                    }
                    return parts.filter(Boolean).join(separator);
                }

                case 'format_date': {
                    // uses: ["user.dob"]
                    // params: { inputFormat?: "YYYY-MM-DD", outputFormat: "DD MMMM YYYY" | "YYYY-MM-DD" | "MM/DD/YYYY" }
                    // Requires a date library like date-fns
                    const dateValStr = String(inputValues[rule.uses[0]] || '');
                    const outputFormat = rule.params?.outputFormat || "DD MMMM YYYY"; // Default format

                    if (!dateValStr) return '[DATE_MISSING]';

                    // Basic validation (assuming YYYY-MM-DD input for now)
                    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValStr)) {
                        return `[INVALID_DATE_INPUT: ${dateValStr}]`;
                    }

                    try {
                        const date = new Date(dateValStr + 'T00:00:00Z'); // Treat as UTC to avoid timezone issues
                        if (isNaN(date.getTime())) throw new Error("Invalid date object");

                        // Manual formatting (replace with date-fns later if needed)
                        const year = date.getUTCFullYear();
                        const month = date.getUTCMonth(); // 0-indexed
                        const day = date.getUTCDate();
                        const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

                        if (outputFormat === "DD MMMM YYYY") {
                            return `${String(day).padStart(2, '0')} ${monthNames[month]} ${year}`;
                        } else if (outputFormat === "YYYY-MM-DD") {
                            return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                        } else if (outputFormat === "MM/DD/YYYY") {
                            return `${String(month + 1).padStart(2, '0')}/${String(day).padStart(2, '0')}/${year}`;
                        } else {
                            return dateValStr; // Default to original if format unknown
                        }
                    } catch (e) {
                        logError(this.getAgentName(), `${methodName}: Error formatting date '${dateValStr}'`, e);
                        return `[DATE_FORMAT_ERROR: ${dateValStr}]`;
                    }
                }

                case 'conditional_text': {
                     // uses: ["user.is_married"]
                     // params: { ifTrue: "Married", ifFalse: "Single", ifNullOrUndefined: "Unknown" }
                     const conditionKey = rule.uses[0];
                     const conditionValue = get(data, conditionKey); // Use get directly on original data
                     const params = rule.params || {};

                     if (conditionValue === true) {
                         return params.ifTrue ?? 'True';
                     } else if (conditionValue === false) {
                         return params.ifFalse ?? 'False';
                     } else {
                         return params.ifNullOrUndefined ?? '[CONDITION_VALUE_MISSING]';
                     }
                }

                // TODO: Add more cases for other operations
                // case 'calculate_age':
                // case 'generate_list':
                // case 'lookup_value':

                default:
                    logWarn(this.getAgentName(), `${methodName}: Unknown rule operation '${rule.operation}' for rule: ${JSON.stringify(rule)}`);
                    return `[UNKNOWN_RULE_OP:${rule.operation}]`;
            }
        } catch (error) {
             logError(this.getAgentName(), `${methodName}: Unexpected error during rule execution for operation '${rule.operation}'`, error);
             return `[RULE_EXECUTION_ERROR:${rule.operation}]`;
        }
    }


    /**
     * Helper to get field configuration, handling nested paths and array indices.
     */
     private getFieldConfig(key: string | undefined, config: CentralMap | null | undefined): PlaceholderDefinition | undefined {
         if (!config || !key) return undefined;
         const methodName = 'getFieldConfig'; // For logging

         // Handle special keys first (boolean flags, add_another)
         if (key.endsWith('?')) {
             const baseKey = key.slice(0, -1);
             if (baseKey.endsWith('.add_another')) {
                 const entityName = baseKey.split('.')[0];
                 return { _type: 'boolean', description: `Add another ${entityName}?` };
             } else {
                 // Config for a preliminary flag (e.g., user.is_married?)
                 // We can return a generic boolean config here, the actual question text
                 // is handled elsewhere based on the key itself.
                 return { _type: 'boolean', description: `Confirmation for ${baseKey}` };
             }
         }

         // Regular keys (e.g., user.dob, user.base_name.first, property[0].address.line1)
         const keyParts = key.split('.');
         const firstPart = keyParts[0]; // e.g., "user" or "property[0]" or "global_placeholder"

         // Try global placeholders first
         if (config.global_placeholders && config.global_placeholders[key]) {
             return config.global_placeholders[key];
         }

         // Check entities
         const entityMatch = firstPart.match(/^(\w+)(?:\[(\d+)\])?$/); // Matches "entity" or "entity[index]"
         if (entityMatch) {
             const entityName = entityMatch[1]; // e.g., "property" or "user"
             const entityConfig = config.entities[entityName];

             if (entityConfig) {
                 // Construct the path relative to the entity's fields
                 // e.g., for "property[0].address.line1", relative path is "address.line1"
                 // e.g., for "user.base_name.first", relative path is "base_name.first"
                 // e.g., for "property[0].name", relative path is "name"
                 const relativeFieldPath = keyParts.slice(1).join('.'); // "address.line1" or "base_name.first" or "name"

                 if (!relativeFieldPath) {
                      logWarn(this.getAgentName(), `${methodName}: Key '${key}' seems to be just an entity name with index, cannot get field config.`);
                      return undefined; // Cannot get config for just the entity name + index
                 }

                 // Find the top-level field within the entity config
                 // e.g., for "address.line1", the top-level field is "address"
                 // e.g., for "base_name.first", the top-level field is "base_name"
                 // e.g., for "name", the top-level field is "name"
                 const topLevelFieldName = relativeFieldPath.split('.')[0]; // "address" or "base_name" or "name"
                 const topLevelFieldConfig = entityConfig.fields[topLevelFieldName];

                 if (!topLevelFieldConfig) {
                      logWarn(this.getAgentName(), `${methodName}: No config found for top-level field '${topLevelFieldName}' in entity '${entityName}' for key '${key}'.`);
                      return undefined;
                 }

                 // Check if the key refers to a sub-field of a structured type (name, address)
                 const subFieldPath = relativeFieldPath.substring(topLevelFieldName.length + 1); // e.g., "line1" or "first" or ""

                 if (subFieldPath && (topLevelFieldConfig._type === 'name' || topLevelFieldConfig._type === 'address')) {
                     // It's a sub-field of a known structured type.
                     // We need the 'ask' text specific to this sub-field.
                     const subAsk = (typeof topLevelFieldConfig.ask === 'object' && topLevelFieldConfig.ask !== null)
                         ? topLevelFieldConfig.ask[subFieldPath] // Get specific ask text if available
                         : undefined;

                     // Return a *copy* of the top-level config, but override the 'ask' text
                     // and potentially adjust the description for clarity.
                     return {
                         ...topLevelFieldConfig, // Copy base type, validation etc.
                         description: `${topLevelFieldConfig.description} (${subFieldPath})`, // Add sub-field context
                         ask: subAsk ?? `Please provide the ${subFieldPath.replace(/_/g, ' ')} for ${topLevelFieldName.replace(/_/g, ' ')}:` // Generate fallback ask text
                     };
                 } else if (!subFieldPath) {
                     // It's a direct field of the entity (or the top-level of a structured type asked as a whole, though unlikely)
                     return topLevelFieldConfig;
                 } else {
                      logWarn(this.getAgentName(), `${methodName}: Key '${key}' has sub-path '${subFieldPath}' but parent field '${topLevelFieldName}' is not a recognized structured type ('name' or 'address'). Returning top-level config.`);
                      return topLevelFieldConfig; // Fallback for unexpected structures
                 }
             }
         }

         // Fallback if not found in globals or entities
         logWarn(this.getAgentName(), `${methodName}: No configuration found for key '${key}'.`);
         return undefined;
     }

    // --- Public State Management Methods ---
    public getState(docSessionId: string): DocumentProcessingState | undefined {
        return this.agentState.get(docSessionId);
    }

    public deleteState(docSessionId: string): boolean {
        return this.agentState.delete(docSessionId);
    }
    // --- End Public State Management Methods ---
}