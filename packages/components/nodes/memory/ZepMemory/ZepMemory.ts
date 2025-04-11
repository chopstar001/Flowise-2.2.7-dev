import { BaseChatMemory } from 'langchain/memory';
import {
    BaseMessage,
    SystemMessage,
    HumanMessage,
    AIMessage,
    ChatMessage,
    MessageContent,
    MessageContentComplex, // Import specific complex types if needed
    MessageContentText     // Import specific complex types if needed
} from '@langchain/core/messages';
import { InputValues, MemoryVariables, OutputValues, getInputValue, getOutputValue } from 'langchain/memory';
import { IMessage, INode, INodeData, INodeParams, MemoryMethods, MessageType, ICommonObject } from '../../../src/Interface';
import {
    convertBaseMessagetoIMessage,
    getBaseClasses,
    getCredentialData,
    getCredentialParam,
    mapChatMessageToBaseMessage
} from '../../../src/utils';

// Define API message structure directly
interface ZepAPIMessage {
    role: string;
    role_type: 'user' | 'assistant' | 'system' | 'function' | 'tool'; // Use string literals
    content: string;
    metadata?: Record<string, any>;
    created_at?: string; // Optional, present in responses
    uuid?: string; // Optional, present in responses
}

// Define structure for memory endpoint response
interface ZepMemoryResponse {
    messages?: ZepAPIMessage[];
    relevant_facts?: any[]; // Keep this for fact retrieval
    summary?: {
        uuid?: string;
        created_at?: string;
        content?: string;
        metadata?: Record<string, any>;
        token_count?: number;
    };
    context?: string; // Keep context field
    // Other potential fields like row_count, total_count etc.
}

class ZepMemory_Memory implements INode {
    label: string;
    name: string;
    version: number;
    description: string;
    type: string;
    icon: string;
    category: string;
    baseClasses: string[];
    credential: INodeParams;
    inputs: INodeParams[];

    constructor() {
        this.label = 'Zep Memory - StandaloneZep'
        this.name = 'ZepMemory'
        this.version = 2.1 // Updated version reflecting changes
        this.type = 'ZepMemory'
        this.icon = 'zep.svg'
        this.category = 'Memory'
        this.description = 'Summarizes conversation and stores memory in Zep server using direct API calls. Retrieves messages and relevant facts.'

        // Include BaseChatMemory in base classes for compatibility
        this.baseClasses = [
            this.type,
            'BaseChatMemory',
            'BaseMemory'
        ]

        this.credential = {
            label: 'Connect Credential',
            name: 'credential',
            type: 'credential',
            optional: true,
            description: 'Zep API Key (using Api-Key authentication)',
            credentialNames: ['zepMemoryApi']
        }

        this.inputs = [
            {
                label: 'Base URL',
                name: 'baseURL',
                type: 'string',
                default: 'http://127.0.0.1:8000',
                description: 'URL of your Zep instance (e.g., http://localhost:8000)'
            },
            {
                label: 'Session ID',
                name: 'sessionId',
                type: 'string',
                description:
                    'Unique identifier for the conversation session. If not specified, a random ID will be used. Special characters are replaced with underscores.',
                default: '',
                additionalParams: true,
                optional: true
            },
            {
                label: 'User ID',
                name: 'userId',
                type: 'string',
                default: '',
                description: 'Optional User ID to associate with messages and sessions. Defaults to Session ID if not provided.',
                additionalParams: true,
                optional: true
            },
            {
                label: 'Message Window Size (k)',
                name: 'k',
                type: 'number',
                default: '10',
                description: 'Number of most recent messages (user and AI pairs) to retrieve. Set to 0 or leave empty to retrieve all.',
                additionalParams: true,
                optional: true // Make k optional
            },
            {
                label: 'Memory Key',
                name: 'memoryKey',
                type: 'string',
                default: 'chat_history',
                description: 'Key name for the chat history messages in memory variables.',
                additionalParams: true
            },
            {
                label: 'Input Key',
                name: 'inputKey',
                type: 'string',
                default: 'input',
                description: 'Key name for the user input in memory variables.',
                additionalParams: true
            },
            {
                label: 'Output Key',
                name: 'outputKey',
                type: 'string',
                default: 'output',
                description: 'Key name for the AI output in memory variables.',
                additionalParams: true
            },
            {
                label: 'Human Prefix',
                name: 'humanPrefix',
                type: 'string',
                default: 'human',
                description: 'Prefix used to identify human messages (used by Langchain).',
                additionalParams: true
            },
            {
                label: 'AI Prefix',
                name: 'aiPrefix',
                type: 'string',
                default: 'ai',
                description: 'Prefix used to identify AI messages (used by Langchain).',
                additionalParams: true
            },
            {
                label: 'Debug Mode',
                name: 'debugMode',
                type: 'boolean',
                default: false,
                description: 'Enable detailed logging for memory operations.',
                additionalParams: true,
                optional: true
            }
            // Removed enableGraph and autoExtractFacts as direct graph manipulation is not supported via API
        ]
    }

    async init(nodeData: INodeData, _: string, options: ICommonObject): Promise<any> {
        return await initializeZep(nodeData, options);
    }
}

// Define our standalone Zep memory implementation that extends BaseChatMemory
class StandaloneZepMemory extends BaseChatMemory implements MemoryMethods {
    sessionId: string;
    baseURL: string;
    apiKey?: string;
    memoryKey: string;
    inputKey: string;
    outputKey: string;
    humanPrefix: string;
    aiPrefix: string;
    lastN?: number; // Corresponds to 'k' input
    debugMode: boolean;
    userId: string;
    type: string = 'ZepMemory';

    zepAvailable: boolean = false; // Default to false until connection confirmed

    // In-memory fallback storage
    private messages: Array<{ role: string, content: string, metadata?: any }> = [];

    constructor(config: {
        sessionId: string;
        baseURL: string;
        apiKey?: string;
        memoryKey?: string;
        inputKey?: string;
        outputKey?: string;
        returnMessages?: boolean;
        aiPrefix?: string;
        humanPrefix?: string;
        k?: number; // Use 'k' from input
        debugMode?: boolean;
        userId?: string;
    }) {
        super({
            returnMessages: config.returnMessages ?? true,
            inputKey: config.inputKey,
            outputKey: config.outputKey,
            chatHistory: undefined // We handle chat history ourselves
        });

        this.sessionId = config.sessionId;
        this.baseURL = config.baseURL.replace(/\/$/, ''); // Remove trailing slash if present
        this.apiKey = config.apiKey;
        this.memoryKey = config.memoryKey || 'chat_history';
        this.inputKey = config.inputKey || 'input';
        this.outputKey = config.outputKey || 'output';
        this.humanPrefix = config.humanPrefix || 'human';
        this.aiPrefix = config.aiPrefix || 'ai';
        this.lastN = config.k; // Assign k to lastN
        this.debugMode = config.debugMode || false;
        // Ensure userId is set, defaulting to sessionId if empty
        this.userId = config.userId || config.sessionId || '';

        // Initialize connection test
        this.initializeConnection();
    }

    /**
   * Initialize the connection test to Zep
   * @returns Promise<void>
   */
    private async initializeConnection(): Promise<void> {
        if (this.debugMode) {
            console.log(`[StandaloneZepMemory] Initializing connection test to: ${this.baseURL}`);
            if (this.apiKey) {
                const keyLength = this.apiKey.length;
                const firstChars = this.apiKey.substring(0, 3);
                const lastChars = this.apiKey.substring(keyLength - 3);
                console.log(`[StandaloneZepMemory] API Key format: ${firstChars}...${lastChars} (${keyLength} chars)`);
            } else {
                console.warn(`[StandaloneZepMemory] No API key provided. Authentication will likely fail.`);
            }
        }

        try {
            // Test connection with a simple API call using fetch
            const testUrl = `${this.baseURL}/api/v2/sessions-ordered?limit=1`;
            if (this.debugMode) {
                console.log(`[StandaloneZepMemory] Testing API connection with GET ${testUrl}`);
            }

            const headers: HeadersInit = {
                'Accept': 'application/json'
            };
            if (this.apiKey) {
                headers['Authorization'] = `Api-Key ${this.apiKey}`;
            }

            const testResponse = await fetch(testUrl, { headers });

            if (testResponse.ok) {
                const data = await testResponse.json();
                if (this.debugMode) {
                    console.log(`[StandaloneZepMemory] ✅ Connection successful. Found ${data?.sessions?.length ?? 0} sessions.`);
                }
                this.zepAvailable = true;

                // Ensure session and user exist after confirming connection
                await this.ensureSessionCustom();
                // User creation is implicitly handled by session creation if needed,
                // or can be managed separately if Zep adds explicit user endpoints later.
                // await this.ensureUserCustom(); // Keep commented unless needed

            } else {
                const errorText = await testResponse.text();
                console.warn(`[StandaloneZepMemory] ❌ Connection test failed: ${testResponse.status} - ${errorText}`);
                this.zepAvailable = false;
            }
        } catch (testError) {
            console.error(`[StandaloneZepMemory] ❌ Connection test error:`, testError);
            this.zepAvailable = false;
        }
    }

    // Custom implementation for user management (if needed in future Zep versions)
    // Currently, user creation is often tied to session creation or message metadata
    private async ensureUserCustom(): Promise<void> {
        if (!this.zepAvailable || !this.userId) return; // Only proceed if Zep is up and userId is set

        // Zep CE v2 doesn't have a dedicated /api/v2/users/{userId} GET endpoint for checking existence easily.
        // User creation happens implicitly when a session is created with a userId,
        // or when messages are added with userId in metadata.
        // We can attempt to list users, but it might require specific permissions.

        if (this.debugMode) {
            console.log(`[StandaloneZepMemory] ensureUserCustom: Checking/ensuring user ${this.userId} (Note: Zep CE v2 user management is limited)`);
        }

        try {
            // Optional: Attempt to list users to see if ours exists (might fail depending on Zep config/version)
            const listUrl = `${this.baseURL}/api/v2/users?limit=100`; // Adjust limit as needed
            const headers: HeadersInit = { 'Accept': 'application/json' };
            if (this.apiKey) headers['Authorization'] = `Api-Key ${this.apiKey}`;

            const response = await fetch(listUrl, { headers });

            if (response.ok) {
                const userList = await response.json();
                const userExists = userList?.users?.some((user: any) => user.user_id === this.userId);
                if (userExists) {
                    if (this.debugMode) console.log(`[StandaloneZepMemory] User ${this.userId} found in list.`);
                    return; // User exists
                } else {
                    if (this.debugMode) console.log(`[StandaloneZepMemory] User ${this.userId} not found in list. Will be created implicitly if needed.`);
                }
            } else {
                // Listing users might fail (e.g., 404 if endpoint doesn't exist, 401/403 for permissions)
                if (this.debugMode) console.warn(`[StandaloneZepMemory] Failed to list users (status ${response.status}). This might be expected in some Zep versions/configs.`);
            }

            // No explicit user creation needed here for CE v2 - it happens with sessions/messages.
            // If Zep adds a POST /api/v2/users endpoint later, the creation logic would go here.

        } catch (error) {
            console.warn(`[StandaloneZepMemory] Error during ensureUserCustom check:`, error);
        }
    }

    // BaseChatMemory interface implementation
    async getMessages(): Promise<BaseMessage[]> {
        const result = await this.getChatMessages(this.sessionId, true) as BaseMessage[];
        return result;
    }

    // Override to match LangChain's ZepMemory interface
    get memoryKeys(): string[] {
        return [this.memoryKey];
    }

    async saveContext(inputValues: InputValues, outputValues: OutputValues): Promise<void> {
        const input = getInputValue(inputValues, this.inputKey);
        const output = getOutputValue(outputValues, this.outputKey);

        // Convert input/output to string for preview and saving
        const inputString = input?.toString() ?? '';
        const outputString = output?.toString() ?? '';

        if (this.debugMode) {
            // Pass the string versions to getContentPreview
            console.log(`[StandaloneZepMemory] saveContext: Input received: ${this.getContentPreview(inputString)}`);
            console.log(`[StandaloneZepMemory] saveContext: Output received: ${this.getContentPreview(outputString)}`);
        }

        // Ensure both input and output have content before saving
        if (inputString && outputString) {
            await this.addChatMessages([
                { text: inputString, type: 'userMessage' },
                { text: outputString, type: 'apiMessage' }
            ]);
        } else {
            if (this.debugMode) {
                console.warn(`[StandaloneZepMemory] saveContext: Missing input or output content, not saving.`);
            }
        }
    }


    async clear(): Promise<void> {
        await this.clearChatMessages();
    }

    /**
   * Loads memory variables from Zep, with proper ordering of messages
   * @param _values Input values (not used in this implementation)
   * @param overrideSessionId Optional session ID override
   * @param overrideUserId Optional user ID override
   * @returns MemoryVariables containing the chat history
   */
    async loadMemoryVariables(_values: InputValues, overrideSessionId = '', overrideUserId = ''): Promise<MemoryVariables> {
        const effectiveSessionId = overrideSessionId || this.sessionId;
        const effectiveUserId = overrideUserId || this.userId; // Determine the ID to use

        if (overrideSessionId && overrideSessionId !== this.sessionId) {
            if (this.debugMode) console.log(`[StandaloneZepMemory] loadMemoryVariables: Overriding session ID from ${this.sessionId} to ${overrideSessionId}`);
            this.sessionId = overrideSessionId;
        }
        if (overrideUserId && overrideUserId !== this.userId) {
            if (this.debugMode) console.log(`[StandaloneZepMemory] loadMemoryVariables: Overriding user ID from ${this.userId} to ${overrideUserId}`);
            this.userId = overrideUserId; // Update instance userId if overridden
        }

        if (this.debugMode) {
            console.log(`[StandaloneZepMemory] loadMemoryVariables: Loading for session=${effectiveSessionId}, userId=${effectiveUserId}`);
            await this.debugSessions(); // Log available sessions for debugging
        }

        let messages: BaseMessage[] = [];

        if (this.zepAvailable) {
            try {
                // Use the /api/v2/sessions/{sessionId}/memory endpoint which includes messages, summary, and facts
                const memoryUrl = `${this.baseURL}/api/v2/sessions/${effectiveSessionId}/memory`;
                // Add lastN parameter if k is specified and greater than 0
                const urlWithParams = this.lastN && this.lastN > 0 ? `${memoryUrl}?lastn=${this.lastN}` : memoryUrl;

                if (this.debugMode) console.log(`[StandaloneZepMemory] loadMemoryVariables: Fetching memory from ${urlWithParams}`);

                const headers: HeadersInit = {
                    'Accept': 'application/json',
                    'Cache-Control': 'no-cache' // Prevent caching
                };
                if (this.apiKey) {
                    headers['Authorization'] = `Api-Key ${this.apiKey}`;
                }

                const response = await fetch(urlWithParams, { headers });

                if (response.ok) {
                    const memoryResult: ZepMemoryResponse = await response.json();
                    const rawMessages = memoryResult?.messages || [];

                    if (this.debugMode) {
                        // Log the entire fetched memory object for inspection
                        console.log(`[StandaloneZepMemory] loadMemoryVariables: Full memory object fetched:`, JSON.stringify(memoryResult, null, 2));

                        console.log(`[StandaloneZepMemory] loadMemoryVariables: Retrieved ${rawMessages.length} raw messages from memory endpoint.`);
                        console.log(`[StandaloneZepMemory] loadMemoryVariables: Summary available: ${!!memoryResult?.summary?.content}`);
                        console.log(`[StandaloneZepMemory] loadMemoryVariables: Relevant facts available: ${memoryResult?.relevant_facts?.length ?? 0}`);
                        if (rawMessages.length > 0) {
                            console.log(`[StandaloneZepMemory] Raw message date range: ${rawMessages[0].created_at} to ${rawMessages[rawMessages.length - 1].created_at}`);
                            console.log(`[StandaloneZepMemory] Sample raw message:`, JSON.stringify(rawMessages[0]).substring(0, 200) + '...');
                        }
                    }

                    if (rawMessages.length > 0) {
                        // Messages from /memory endpoint are typically oldest first already.
                        // No reversal needed here unless API behavior changes.
                        messages = rawMessages.map((msg: ZepAPIMessage) => {
                            const role = (msg.role || 'unknown').toLowerCase();
                            const content = msg.content || '';

                            if (this.debugMode) {
                                console.log(`[StandaloneZepMemory] Converting message: role=${role}, content=${this.getContentPreview(content)}`);
                            }

                            if (role === 'human' || role === 'user') {
                                return new HumanMessage(content);
                            } else if (role === 'ai' || role === 'assistant') {
                                return new AIMessage(content);
                            } else if (role === 'system') {
                                return new SystemMessage(content);
                            } else {
                                // Use ChatMessage for other roles like 'function', 'tool'
                                return new ChatMessage(content, role);
                            }
                        });
                        if (this.debugMode) console.log(`[StandaloneZepMemory] loadMemoryVariables: Mapped ${messages.length} messages.`);

                    } else {
                        if (this.debugMode) console.log(`[StandaloneZepMemory] No messages found in memory endpoint response for session ${effectiveSessionId}.`);
                    }
                } else {
                    const errorBody = await response.text();
                    console.warn(`[StandaloneZepMemory] loadMemoryVariables: Failed to fetch memory: ${response.status} - ${errorBody}`);
                    // Fallback to in-memory messages if API fails
                    messages = this.getInMemoryMessages(effectiveUserId);
                }
            } catch (error) {
                console.error(`[StandaloneZepMemory] loadMemoryVariables: Error fetching Zep memory:`, error);
                // Fallback to in-memory messages on error
                messages = this.getInMemoryMessages(effectiveUserId);
            }
        } else {
            if (this.debugMode) console.log(`[StandaloneZepMemory] loadMemoryVariables: Zep not available, using in-memory messages.`);
            messages = this.getInMemoryMessages(effectiveUserId);
        }

        // Log the first and last message to verify ordering
        if (this.debugMode && messages.length > 0) {
            console.log(`[StandaloneZepMemory] First message loaded: ${this.getContentPreview(messages[0].content)}`);
            console.log(`[StandaloneZepMemory] Last message loaded: ${this.getContentPreview(messages[messages.length - 1].content)}`);
        }

        if (this.debugMode) console.log(`[StandaloneZepMemory] loadMemoryVariables: Loaded ${messages.length} final messages for session=${effectiveSessionId}, userId=${effectiveUserId}`);

        // Return messages in the format expected by Langchain
        return { [this.memoryKey]: messages };
    }

    // Helper to get filtered in-memory messages
    private getInMemoryMessages(userId: string): BaseMessage[] {
        if (this.debugMode) console.log(`[StandaloneZepMemory] Retrieving from in-memory store (${this.messages.length} total). Filtering for userId: ${userId}`);

        const filtered = this.messages.filter(msg => {
            const msgUserId = msg.metadata?.userId;
            // Keep message if it has no userId metadata OR if its userId matches the requested userId
            const keep = !msgUserId || msgUserId === userId;
            if (this.debugMode && msgUserId) {
                console.log(`[StandaloneZepMemory] In-memory filter: msgUserId=${msgUserId}, effectiveUserId=${userId}, keep=${keep}`);
            }
            return keep;
        });

        if (this.debugMode) console.log(`[StandaloneZepMemory] Filtered in-memory messages: ${filtered.length}`);

        // Map to BaseMessage format
        const baseMessages = filtered.map(msg => {
            const role = msg.role.toLowerCase();
            if (role === 'human' || role === 'user') return new HumanMessage(msg.content);
            if (role === 'ai' || role === 'assistant') return new AIMessage(msg.content);
            if (role === 'system') return new SystemMessage(msg.content);
            return new ChatMessage(msg.content, role);
        });

        // Apply lastN limit if specified
        if (this.lastN && this.lastN > 0 && baseMessages.length > this.lastN) {
            if (this.debugMode) console.log(`[StandaloneZepMemory] Applying lastN limit (${this.lastN}) to in-memory messages.`);
            return baseMessages.slice(-this.lastN);
        }

        return baseMessages;
    }


    // Add this new debug method to the class
    async debugSessions(): Promise<void> {
        if (!this.zepAvailable || !this.debugMode) return;

        try {
            if (this.debugMode) console.log(`[StandaloneZepMemory] Debugging sessions... Fetching up to 20 sessions.`);
            const headers: HeadersInit = { 'Accept': 'application/json' };
            if (this.apiKey) headers['Authorization'] = `Api-Key ${this.apiKey}`;

            const response = await fetch(`${this.baseURL}/api/v2/sessions-ordered?limit=20`, { headers });

            if (response.ok) {
                const data = await response.json();
                const sessions = data.sessions || [];
                if (this.debugMode) console.log(`[StandaloneZepMemory] Found ${sessions.length} sessions (showing max 20):`);

                sessions.forEach((session: any) => {
                    if (this.debugMode) console.log(`  - Session ${session.session_id}: ${session.message_count || 0} messages, UserID: ${session.user_id || 'N/A'}, Created: ${session.created_at}`);
                });

                // Check our current session specifically
                const currentSessionInfo = sessions.find((s: any) => s.session_id === this.sessionId);
                if (currentSessionInfo) {
                    if (this.debugMode) console.log(`[StandaloneZepMemory] Current session ${this.sessionId} found in list: ${currentSessionInfo.message_count || 0} messages.`);
                } else {
                    if (this.debugMode) console.log(`[StandaloneZepMemory] Warning: Current session ${this.sessionId} not found in the first 20 sessions listed.`);
                }
            } else {
                console.warn(`[StandaloneZepMemory] Failed to list sessions for debugging: ${response.status}`);
            }
        } catch (error) {
            console.error(`[StandaloneZepMemory] Error debugging sessions:`, error);
        }
    }

    async addChatMessages(msgArray: { text: string; type: MessageType }[], overrideSessionId = '', overrideUserId = ''): Promise<void> {
        const effectiveSessionId = overrideSessionId || this.sessionId;
        const effectiveUserId = overrideUserId || this.userId;

        // Update instance state if overrides are provided
        if (overrideSessionId && overrideSessionId !== this.sessionId) {
            if (this.debugMode) console.log(`[StandaloneZepMemory] addChatMessages: Updating session ID from ${this.sessionId} to ${overrideSessionId}`);
            this.sessionId = overrideSessionId;
        }
        if (overrideUserId && overrideUserId !== this.userId) {
            if (this.debugMode) console.log(`[StandaloneZepMemory] addChatMessages: Updating user ID from ${this.userId} to ${overrideUserId}`);
            this.userId = overrideUserId; // Update instance userId
        }

        if (this.debugMode) {
            console.log(`[StandaloneZepMemory] addChatMessages: Adding ${msgArray.length} messages for session=${effectiveSessionId}, userId=${effectiveUserId}`);
            msgArray.forEach((msg, index) => {
                console.log(`[StandaloneZepMemory] addChatMessages: Message ${index + 1}: type=${msg.type}, content=${this.getContentPreview(msg.text)}`);
            });
        }

        // Format messages for API and in-memory storage
        const formattedMessages: ZepAPIMessage[] = msgArray.map(msg => {
            const role = msg.type === 'userMessage' ? 'human' : 'ai';
            // Map MessageType to Zep's role_type string literals
            const roleType: ZepAPIMessage['role_type'] = msg.type === 'userMessage' ? 'user' : 'assistant';
            return {
                role: role,
                role_type: roleType,
                content: msg.text,
                metadata: {
                    userId: effectiveUserId, // Includes effective userId
                    sessionId: effectiveSessionId, // Include effective sessionId
                    timestamp: new Date().toISOString()
                    // Add any other relevant metadata here
                }
            };
        });

        if (this.debugMode) {
            console.log(`[StandaloneZepMemory] addChatMessages: Formatted messages with metadata`,
                formattedMessages.map(m => `role=${m.role}, role_type=${m.role_type}, metadata=${JSON.stringify(m.metadata)}`));
        }

        // Add to in-memory storage first
        this.messages.push(...formattedMessages.map(msg => ({
            role: msg.role,
            content: msg.content,
            metadata: msg.metadata
        })));
        if (this.debugMode) console.log(`[StandaloneZepMemory] addChatMessages: Added to in-memory storage, now has ${this.messages.length} messages`);

        // Try to add to Zep using direct API ONLY
        if (this.zepAvailable) {
            try {
                if (this.debugMode) console.log(`[StandaloneZepMemory] addChatMessages: Ensuring session exists before adding messages`);
                await this.ensureSessionCustom(); // Uses direct fetch

                if (this.debugMode) console.log(`[StandaloneZepMemory] Attempting to add messages via direct API call...`);
                const success = await this.addMessagesToZep(effectiveSessionId, formattedMessages); // Uses direct fetch

                if (!success) {
                    console.error(`[StandaloneZepMemory] ❌ Failed to add messages to Zep via direct API`);
                    // Messages remain in the in-memory store as a fallback
                }
            } catch (error) {
                console.warn(`[StandaloneZepMemory] Error in addChatMessages during Zep interaction:`, error);
            }
        } else {
            if (this.debugMode) console.log(`[StandaloneZepMemory] Zep not available, messages stored only in memory`);
        }
    }

    private async ensureSessionCustom(): Promise<void> {
        if (!this.zepAvailable) {
            if (this.debugMode) console.log(`[StandaloneZepMemory] ensureSessionCustom: Zep not available, skipping`);
            return;
        }

        try {
            if (this.debugMode) console.log(`[StandaloneZepMemory] ensureSessionCustom: Checking if session ${this.sessionId} exists`);

            const headers: HeadersInit = { 'Accept': 'application/json' };
            if (this.apiKey) headers['Authorization'] = `Api-Key ${this.apiKey}`;

            // Check if session exists
            const checkUrl = `${this.baseURL}/api/v2/sessions/${this.sessionId}`;
            const checkResponse = await fetch(checkUrl, { headers });

            if (checkResponse.ok) {
                if (this.debugMode) console.log(`[StandaloneZepMemory] ensureSessionCustom: Session ${this.sessionId} exists`);
            } else if (checkResponse.status === 404) {
                // Create session if it doesn't exist (404)
                if (this.debugMode) console.log(`[StandaloneZepMemory] ensureSessionCustom: Session ${this.sessionId} not found (404), creating...`);

                const sessionData: { session_id: string; user_id?: string; metadata?: Record<string, any> } = {
                    session_id: this.sessionId,
                    metadata: {
                        source: 'Flowise StandaloneZepMemory', // Identify source
                        created_at: new Date().toISOString()
                    }
                };
                // Include userId in the session creation payload if it's available
                if (this.userId) {
                    sessionData.user_id = this.userId;
                }

                if (this.debugMode) console.log(`[StandaloneZepMemory] ensureSessionCustom: Session creation payload:`, JSON.stringify(sessionData));

                const createUrl = `${this.baseURL}/api/v2/sessions`;
                const createHeaders: HeadersInit = {
                    ...headers, // Include auth header if apiKey exists
                    'Content-Type': 'application/json'
                };

                const createResponse = await fetch(createUrl, {
                    method: 'POST',
                    headers: createHeaders,
                    body: JSON.stringify(sessionData)
                });

                if (createResponse.ok) {
                    if (this.debugMode) console.log(`[StandaloneZepMemory] ensureSessionCustom: Session ${this.sessionId} created successfully`);
                } else {
                    const errorText = await createResponse.text();
                    console.error(`[StandaloneZepMemory] ensureSessionCustom: Failed to create session: ${createResponse.status} - ${errorText}`);
                    // Consider if we should set zepAvailable to false here, maybe not, other endpoints might work
                }
            } else {
                // Handle other non-OK statuses during check
                const errorText = await checkResponse.text();
                console.warn(`[StandaloneZepMemory] ensureSessionCustom: Error checking session ${this.sessionId}: ${checkResponse.status} - ${errorText}`);
            }
        } catch (error) {
            console.error(`[StandaloneZepMemory] ensureSessionCustom: Network or other error:`, error);
            // Potentially set zepAvailable to false if connection fails completely
            // this.zepAvailable = false;
        }
    }

    /**
   * Gets chat messages for a session
   * @param overrideSessionId Optional session ID override
   * @param returnBaseMessages Whether to return BaseMessage objects or IMessage objects
   * @param prependMessages Optional messages to prepend to the returned messages
   * @param overrideUserId Optional user ID override
   * @returns Array of messages in chronological order (oldest first)
   */
    async getChatMessages(
        overrideSessionId = '',
        returnBaseMessages = false,
        prependMessages?: IMessage[],
        overrideUserId = ''
    ): Promise<IMessage[] | BaseMessage[]> {
        const effectiveSessionId = overrideSessionId || this.sessionId;
        const effectiveUserId = overrideUserId || this.userId;

        // Update instance state if overrides are provided
        if (overrideSessionId && overrideSessionId !== this.sessionId) {
            if (this.debugMode) console.log(`[StandaloneZepMemory] getChatMessages: Updating session ID from ${this.sessionId} to ${overrideSessionId}`);
            this.sessionId = overrideSessionId;
        }
        if (overrideUserId && overrideUserId !== this.userId) {
            if (this.debugMode) console.log(`[StandaloneZepMemory] getChatMessages: Updating user ID from ${this.userId} to ${overrideUserId}`);
            this.userId = overrideUserId;
        }

        if (this.debugMode) console.log(`[StandaloneZepMemory] getChatMessages: Getting messages for session=${effectiveSessionId}, userId=${effectiveUserId}`);

        // Call loadMemoryVariables to get messages (already in chronological order)
        const memoryVariables = await this.loadMemoryVariables({}, effectiveSessionId, effectiveUserId);
        const baseMessages: BaseMessage[] = memoryVariables[this.memoryKey] || [];

        if (this.debugMode) console.log(`[StandaloneZepMemory] getChatMessages: Got ${baseMessages.length} base messages from memory in chronological order`);

        // Create a new array to avoid modifying the original
        let finalMessages: BaseMessage[] = [...baseMessages];

        // Add prepend messages if provided - add them to the BEGINNING
        if (prependMessages?.length) {
            if (this.debugMode) console.log(`[StandaloneZepMemory] getChatMessages: Prepending ${prependMessages.length} additional messages`);
            const mappedPrependMessages = await mapChatMessageToBaseMessage(prependMessages);
            finalMessages = [...mappedPrependMessages, ...finalMessages];
        }

        // Convert to IMessage if needed
        const finalResult: IMessage[] | BaseMessage[] = returnBaseMessages
            ? finalMessages
            : convertBaseMessagetoIMessage(finalMessages);

        if (this.debugMode) {
            console.log(`[StandaloneZepMemory] getChatMessages: Returning ${finalResult.length} ${returnBaseMessages ? 'BaseMessages' : 'IMessages'} in chronological order`);
            // Log a sample message to verify
            if (finalResult.length > 0) {
                const sampleMessage = finalResult[0];
                let preview = 'Unknown content';
                // Safely access content based on type
                if ('content' in sampleMessage && sampleMessage.content !== undefined) {
                    preview = this.getContentPreview(sampleMessage.content);
                } else if ('text' in sampleMessage && typeof sampleMessage.text === 'string') {
                    preview = this.getContentPreview(sampleMessage.text);
                } else if ('message' in sampleMessage && typeof sampleMessage.message === 'string') {
                    preview = this.getContentPreview(sampleMessage.message);
                }
                console.log(`[StandaloneZepMemory] First returned message content: "${preview}"`);
            }
        }

        return finalResult;
    }

    /**
     * Safely gets a string preview of message content, handling various types including complex ones.
     * @param content Message content (string, complex array, object, undefined, null)
     * @param maxLength Maximum length of the preview string
     * @returns String preview of the content
     */
    private getContentPreview(content: MessageContent | undefined | string | unknown, maxLength: number = 30): string {
        if (content === null || content === undefined) {
            return '[empty]';
        }

        let textContent = '';

        if (typeof content === 'string') {
            textContent = content;
        } else if (Array.isArray(content)) {
            // Handle complex content arrays (like multimodal messages)
            // Find the first text part, otherwise stringify the array
            const firstTextPart = content.find((part): part is MessageContentText => typeof part === 'object' && part !== null && part.type === 'text');
            textContent = firstTextPart ? firstTextPart.text : JSON.stringify(content);
        } else if (typeof content === 'object') {
             // Handle potential object inputs (e.g., from getInputValue)
             // Check if it's a structured text content part
             if ('type' in content && content.type === 'text' && 'text' in content && typeof content.text === 'string') {
                 textContent = content.text;
             } else {
                 // Fallback for other objects: convert to string
                 textContent = content.toString();
                 // If toString() gives a generic object representation, try stringify
                 if (textContent === '[object Object]') {
                     try {
                         textContent = JSON.stringify(content);
                     } catch {
                         // Ignore stringify errors, keep '[object Object]'
                     }
                 }
             }
        } else {
             // Handle other types (like numbers, booleans from getInputValue) by converting to string
             textContent = String(content);
        }


        // Truncate if necessary
        return textContent.length > maxLength ? `${textContent.substring(0, maxLength)}...` : textContent;
    }


    async clearChatMessages(overrideSessionId = ''): Promise<void> {
        const id = overrideSessionId ? overrideSessionId : this.sessionId;
        const methodName = 'clearChatMessages';

        if (this.debugMode) console.log(`[StandaloneZepMemory:${methodName}] Starting to clear chat messages for session: ${id}`);

        // Clear in-memory storage first
        const previousMessagesCount = this.messages.length;
        this.messages = [];
        if (this.debugMode) console.log(`[StandaloneZepMemory:${methodName}] Cleared ${previousMessagesCount} in-memory messages`);

        // Try to clear in Zep using direct DELETE API call
        if (this.zepAvailable) {
            try {
                if (this.debugMode) console.log(`[StandaloneZepMemory:${methodName}] Attempting to clear Zep memory for session: ${id} via DELETE API`);

                const apiUrl = `${this.baseURL}/api/v2/sessions/${id}/memory`;
                if (this.debugMode) console.log(`[StandaloneZepMemory:${methodName}] Sending DELETE request to: ${apiUrl}`);

                const headers: HeadersInit = {
                    'Accept': 'application/json'
                };
                if (this.apiKey) {
                    headers['Authorization'] = `Api-Key ${this.apiKey}`;
                }

                const response = await fetch(apiUrl, { method: 'DELETE', headers });

                if (response.ok) {
                    if (this.debugMode) console.log(`[StandaloneZepMemory:${methodName}] ✅ DELETE request successful (status: ${response.status}). Zep memory cleared.`);
                    // Optionally recreate the session immediately after clearing
                    if (this.debugMode) console.log(`[StandaloneZepMemory:${methodName}] Re-ensuring session ${id} exists after clearing.`);
                    await this.ensureSessionCustom(); // Recreate session
                } else {
                    const errorText = await response.text();
                    console.error(`[StandaloneZepMemory:${methodName}] ❌ DELETE request failed: ${response.status} - ${errorText}`);
                    // Decide if this should mark Zep as unavailable or just log the error
                }
            } catch (directError) {
                console.error(`[StandaloneZepMemory:${methodName}] ❌ Error during direct DELETE request:`, directError);
            }
        } else {
            console.warn(`[StandaloneZepMemory:${methodName}] Zep is not available, only cleared in-memory messages`);
        }
    }

    async clearAllChatMessages(): Promise<void> {
        const methodName = 'clearAllChatMessages';
        if (this.debugMode) console.log(`[StandaloneZepMemory:${methodName}] Starting to clear all chat sessions`);

        // Clear in-memory storage
        const previousMessagesCount = this.messages.length;
        this.messages = [];
        if (this.debugMode) console.log(`[StandaloneZepMemory:${methodName}] Cleared ${previousMessagesCount} in-memory messages`);

        // Try to clear all sessions in Zep
        if (this.zepAvailable) {
            let allSessions: any[] = [];
            let pageNumber = 1;
            const pageSize = 100;
            let hasMoreSessions = true;

            const headers: HeadersInit = { 'Accept': 'application/json' };
            if (this.apiKey) headers['Authorization'] = `Api-Key ${this.apiKey}`;

            if (this.debugMode) console.log(`[StandaloneZepMemory:${methodName}] Fetching all sessions using /sessions-ordered endpoint...`);

            // Paginate through all sessions
            while (hasMoreSessions) {
                try {
                    if (this.debugMode) console.log(`[StandaloneZepMemory:${methodName}] Fetching page ${pageNumber} (size ${pageSize})`);
                    const sessionsUrl = `${this.baseURL}/api/v2/sessions-ordered?page_number=${pageNumber}&page_size=${pageSize}`;
                    const response = await fetch(sessionsUrl, { headers });

                    if (!response.ok) {
                        const errorText = await response.text();
                        console.error(`[StandaloneZepMemory:${methodName}] Error fetching sessions page ${pageNumber}: ${response.status} - ${errorText}`);
                        break; // Stop pagination on error
                    }

                    const result = await response.json();
                    const sessionsOnPage = result.sessions || [];
                    allSessions = [...allSessions, ...sessionsOnPage];

                    // Determine if more pages exist
                    const totalCount = result.total_count;
                    hasMoreSessions = totalCount !== undefined
                        ? allSessions.length < totalCount
                        : sessionsOnPage.length === pageSize; // Fallback if total_count is missing

                    if (this.debugMode) console.log(`[StandaloneZepMemory:${methodName}] Fetched ${sessionsOnPage.length} sessions on page ${pageNumber}. Total collected: ${allSessions.length}/${totalCount ?? 'unknown'}`);
                    pageNumber++;

                } catch (pageError) {
                    console.error(`[StandaloneZepMemory:${methodName}] Error fetching page ${pageNumber}:`, pageError);
                    break; // Stop pagination on error
                }
            }

            if (this.debugMode) console.log(`[StandaloneZepMemory:${methodName}] Fetched ${allSessions.length} sessions total. Now deleting memory for each...`);

            // Delete memory for each session
            let successCount = 0;
            for (const session of allSessions) {
                const sessionId = session.session_id;
                if (!sessionId) continue; // Skip if session_id is missing

                try {
                    if (this.debugMode) console.log(`[StandaloneZepMemory:${methodName}] Deleting memory for session: ${sessionId}`);
                    const deleteUrl = `${this.baseURL}/api/v2/sessions/${sessionId}/memory`;
                    const deleteResponse = await fetch(deleteUrl, { method: 'DELETE', headers }); // Re-use headers

                    if (deleteResponse.ok) {
                        successCount++;
                        if (this.debugMode) console.log(`[StandaloneZepMemory:${methodName}] Successfully deleted memory for session: ${sessionId}`);
                    } else {
                        const errorText = await deleteResponse.text();
                        console.warn(`[StandaloneZepMemory:${methodName}] Failed to delete memory for session ${sessionId}: ${deleteResponse.status} - ${errorText}`);
                    }
                } catch (deleteError) {
                    console.warn(`[StandaloneZepMemory:${methodName}] Error deleting memory for session ${sessionId}:`, deleteError);
                }
            }
            if (this.debugMode) console.log(`[StandaloneZepMemory:${methodName}] Finished clearing. Successfully deleted memory for ${successCount}/${allSessions.length} sessions.`);

        } else {
            console.warn(`[StandaloneZepMemory:${methodName}] Zep is not available, cannot clear all chat sessions from server.`);
        }
    }

    /**
   * Add messages to Zep using the direct API call with correct authentication format
   */
    private async addMessagesToZep(sessionId: string, messages: ZepAPIMessage[]): Promise<boolean> {
        if (!this.zepAvailable) {
            if (this.debugMode) console.log(`[StandaloneZepMemory] addMessagesToZep: Zep not available, skipping API call.`);
            return false;
        }

        try {
            if (this.debugMode) console.log(`[StandaloneZepMemory] addMessagesToZep: Adding ${messages.length} messages via direct API`);

            // API expects snake_case 'role_type' and specific string literals
            const formattedApiMessages = messages.map(msg => ({
                role: msg.role,
                role_type: msg.role_type, // Already formatted correctly in addChatMessages
                content: msg.content,
                metadata: msg.metadata || {}
            }));

            const apiUrl = `${this.baseURL}/api/v2/sessions/${sessionId}/memory`;
            const headers: HeadersInit = {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            };
            if (this.apiKey) {
                headers['Authorization'] = `Api-Key ${this.apiKey}`; // Exact format required!
            }

            if (this.debugMode) {
                const apiKeyPreview = this.apiKey ? `Api-Key ${this.apiKey.substring(0, 3)}...` : 'No API Key';
                console.log(`[StandaloneZepMemory] addMessagesToZep: POST ${apiUrl} with Auth: ${apiKeyPreview}`);
                // Avoid logging full message bodies unless absolutely necessary for deep debugging
                // console.log(`[StandaloneZepMemory] addMessagesToZep: Payload:`, JSON.stringify({ messages: formattedApiMessages }));
            }

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({ messages: formattedApiMessages })
            });

            if (response.ok) {
                if (this.debugMode) console.log(`[StandaloneZepMemory] ✅ Successfully added messages via direct API!`);
                return true;
            } else {
                const errorText = await response.text();
                console.error(`[StandaloneZepMemory] ❌ API error adding messages: ${response.status} - ${errorText}`);
                if (response.status === 401) {
                    console.error(`[StandaloneZepMemory] 401 Unauthorized: Check API key format ('Api-Key <key>') and value.`);
                }
                return false;
            }
        } catch (error) {
            console.error(`[StandaloneZepMemory] ❌ Error in direct API call (addMessagesToZep):`, error);
            return false;
        }
    }

    /**
     * Gets memory-related facts retrieved from the /memory endpoint.
     * Note: This does not interact with separate graph endpoints.
     */
    async getChatFacts(sessionId?: string): Promise<any[]> {
        const effectiveSessionId = sessionId || this.sessionId;
        if (!this.zepAvailable) {
             if (this.debugMode) console.log(`[StandaloneZepMemory] getChatFacts: Zep not available.`);
             return [];
        }

        try {
            if (this.debugMode) console.log(`[StandaloneZepMemory] getChatFacts: Fetching memory for session ${effectiveSessionId} to extract facts.`);

            const memoryUrl = `${this.baseURL}/api/v2/sessions/${effectiveSessionId}/memory`;
            const headers: HeadersInit = { 'Accept': 'application/json' };
            if (this.apiKey) headers['Authorization'] = `Api-Key ${this.apiKey}`;

            const response = await fetch(memoryUrl, { headers });

            if (!response.ok) {
                const errorBody = await response.text();
                console.error(`[StandaloneZepMemory] getChatFacts: Failed to fetch memory: ${response.status} - ${errorBody}`);
                return [];
            }

            const memory: ZepMemoryResponse = await response.json();
            const relevantFacts = memory?.relevant_facts || [];

            if (this.debugMode) {
                console.log(`[StandaloneZepMemory] getChatFacts: Found ${relevantFacts.length} relevant facts in memory response for session ${effectiveSessionId}`);
            }

            return relevantFacts;
        } catch (error) {
            console.error(`[StandaloneZepMemory] getChatFacts: Error fetching/processing memory:`, error);
            return [];
        }
    }

    /**
     * Gets session summary retrieved from the /memory endpoint.
     */
    async getSessionSummary(sessionId?: string): Promise<any> {
        const effectiveSessionId = sessionId || this.sessionId;
         if (!this.zepAvailable) {
             if (this.debugMode) console.log(`[StandaloneZepMemory] getSessionSummary: Zep not available.`);
             return null;
         }

        try {
            if (this.debugMode) console.log(`[StandaloneZepMemory] getSessionSummary: Fetching memory for session ${effectiveSessionId} to extract summary.`);

            const memoryUrl = `${this.baseURL}/api/v2/sessions/${effectiveSessionId}/memory`;
            const headers: HeadersInit = { 'Accept': 'application/json' };
            if (this.apiKey) headers['Authorization'] = `Api-Key ${this.apiKey}`;

            const response = await fetch(memoryUrl, { headers });

            if (!response.ok) {
                const errorBody = await response.text();
                console.error(`[StandaloneZepMemory] getSessionSummary: Failed to fetch memory: ${response.status} - ${errorBody}`);
                return null;
            }

            const memory: ZepMemoryResponse = await response.json();
            const summary = memory?.summary;

            if (this.debugMode) {
                console.log(`[StandaloneZepMemory] getSessionSummary: Summary ${summary ? 'found' : 'not found'} in memory response for session ${effectiveSessionId}`);
            }

            return summary || null;
        } catch (error) {
            console.error(`[StandaloneZepMemory] getSessionSummary: Error fetching/processing memory:`, error);
            return null;
        }
    }

    // Helper method to get memory type (simplified)
    getMemoryType(): string {
        // Since graph methods are removed, always return 'ZepMemory'
        return 'ZepMemory';
    }
}

// Function to initialize the standalone memory
const initializeZep = async (nodeData: INodeData, options: ICommonObject): Promise<StandaloneZepMemory> => {
    const baseURL = nodeData.inputs?.baseURL as string;
    const aiPrefix = nodeData.inputs?.aiPrefix as string ?? 'ai';
    const humanPrefix = nodeData.inputs?.humanPrefix as string ?? 'human';
    const memoryKey = nodeData.inputs?.memoryKey as string ?? 'chat_history';
    const inputKey = nodeData.inputs?.inputKey as string ?? 'input';
    const outputKey = nodeData.inputs?.outputKey as string ?? 'output';
    const kRaw = nodeData.inputs?.k; // Keep raw value
    const sessionIdRaw = nodeData.inputs?.sessionId as string ?? '';
    const debugMode = nodeData.inputs?.debugMode as boolean ?? false;
    const userIdRaw = nodeData.inputs?.userId as string ?? ''; // Get raw userId

    // Clean session ID: replace invalid chars, generate if empty
    const cleanedSessionId = sessionIdRaw
        ? sessionIdRaw.replace(/[^a-zA-Z0-9_-]/g, '_')
        : `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    // Use cleanedSessionId as default userId if userIdRaw is empty
    const effectiveUserId = userIdRaw || cleanedSessionId;

    const credentialData = await getCredentialData(nodeData.credential ?? '', options);
    const apiKey = getCredentialParam('apiKey', credentialData, nodeData);

    // Parse k, ensuring it's a valid number >= 0
    let k: number | undefined = undefined;
    if (kRaw !== undefined && kRaw !== null && kRaw !== '') {
        const parsedK = parseInt(String(kRaw), 10);
        if (!isNaN(parsedK) && parsedK >= 0) {
            k = parsedK;
        } else if (debugMode) {
             console.warn(`[StandaloneZepMemory Init] Invalid value for k: '${kRaw}'. Ignoring message window size.`);
        }
    }
     // If k is 0, treat it as undefined (meaning retrieve all messages)
     if (k === 0) {
        k = undefined;
        if (debugMode) console.log(`[StandaloneZepMemory Init] k is 0, will retrieve all messages.`);
    }


    if (debugMode) {
        console.log(`[StandaloneZepMemory Init] Initializing with:`);
        console.log(`  - Session ID: ${cleanedSessionId}`);
        console.log(`  - User ID: ${effectiveUserId}`);
        console.log(`  - Base URL: ${baseURL}`);
        console.log(`  - API Key Set: ${!!apiKey}`);
        console.log(`  - k (lastN): ${k ?? 'All'}`);
        console.log(`  - Debug Mode: ${debugMode}`);
    }

    return new StandaloneZepMemory({
        sessionId: cleanedSessionId,
        baseURL,
        apiKey,
        memoryKey,
        inputKey,
        outputKey,
        returnMessages: true, // Standard for Langchain memory
        aiPrefix,
        humanPrefix,
        k: k, // Pass the parsed k value
        debugMode,
        userId: effectiveUserId // Pass the determined userId
    });
}

module.exports = { nodeClass: ZepMemory_Memory };