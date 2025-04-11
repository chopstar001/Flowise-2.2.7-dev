// In commands/zepknowledge.ts

import { Command } from '../commands/types';
import { ContextAdapter } from '../ContextAdapter';
import { ConversationManager } from '../ConversationManager';
import { IExtendedMemory } from '../commands/types';
import { PromptManager } from '../PromptManager';
import { TelegramBot_Agents } from '../TelegramBot_Agents';
import { logDebug, logError, logInfo, logWarn } from '../loggingUtility';
import { Markup } from 'telegraf';
// Removed: import { ZepGraphApi } from '../services/ZepGraphApi';

// At the top of the file, add these interfaces
interface ZepNodeResult {
    created_at: string;
    name: string;
    summary: string;
    uuid: string;
    attributes?: Record<string, any>;
    labels?: string[];
}

interface ZepEdgeResult {
    created_at: string;
    fact: string;
    name: string;
    source_node_uuid: string;
    target_node_uuid: string;
    uuid: string;
    episodes?: string[];
    expired_at?: string;
    invalid_at?: string;
    valid_at?: string;
}

// If you prefer, you can also import these from your types file
// import { ZepNodeResult, ZepEdgeResult } from './commands/types';

export const zepKnowledgeCommand: Command = {
    name: 'zepknowledge',
    description: 'Test and use Zep knowledge graph features',
    adminOnly: true,
    execute: async (
        adapter: ContextAdapter,
        conversationManager: ConversationManager,
        memory: IExtendedMemory | null,
        userId: string,
        sessionId: string,
        promptManager: PromptManager | null,
        telegramBot: TelegramBot_Agents
    ): Promise<void> => {
        const methodName = 'zepknowledgeCommand';
        logInfo(methodName, 'Starting Zep knowledge test', {
            userId,
            sessionId
        });

        const context = adapter.getMessageContext();
        const input = context.input;
        const parts = input.split(' ');

        // Check for subcommand
        let subCommand = parts.length > 1 ? parts[1] : 'diagnostic';
        let params = parts.slice(2).join(' ');

        if (!telegramBot || !conversationManager) {
            logError(methodName, 'Bot or ConversationManager not available', '');
            await adapter.reply('Bot or ConversationManager not available');
            return;
        }

        // Get memory client information
        const memoryInfo = await getMemoryClientInfo(memory);
        logInfo(methodName, 'Memory client info', memoryInfo);

        // Check if the memory is a Zep-based memory
        const memoryType = memory?.getMemoryType?.() || 'Unknown';
        const isZepMemory = memoryType.toLowerCase().includes('zep');

        if (!isZepMemory || !memory) { // Added !memory check
            await adapter.reply('⚠️ Current memory is not Zep-based or not available. This command only works with Zep memory.');
            await adapter.reply(`Memory type: ${memoryType}`);
            return;
        }

        // Removed ZepGraphApi initialization

        // Process subcommand
        switch (subCommand.toLowerCase()) {
            case 'diagnostic':
                await runDiagnostics(adapter, memory, userId, sessionId, methodName); // Removed graphApi
                break;

            case 'search':
                if (!params) {
                    await adapter.reply('Please provide a search query. Example: `/zepknowledge search what do I know about programming`');
                    return;
                }

                // Try to use direct memory method
                if (memory && typeof (memory as any).searchGraph === 'function') {
                    try {
                        await adapter.reply(`🔍 Searching graph using memory.searchGraph for: "${params}"`);
                        const searchResults = await (memory as any).searchGraph(params, { userId });

                        const edgeCount = searchResults?.edges?.length || 0; // Added null checks
                        const nodeCount = searchResults?.nodes?.length || 0; // Added null checks

                        if (edgeCount === 0 && nodeCount === 0) {
                            await adapter.reply(`ℹ️ No results found for "${params}" using memory.searchGraph`);
                            return;
                        }

                        await adapter.reply(`✅ Found ${edgeCount} relationships and ${nodeCount} entities using memory.searchGraph`);

                        // Format and display edges (relationships)
                        if (edgeCount > 0 && searchResults.edges) { // Added null check
                            let edgeDisplay = `**Relationships:**\n\n`;

                            searchResults.edges.slice(0, 5).forEach((edge: ZepEdgeResult, index: number) => {
                                edgeDisplay += `${index + 1}. ${edge.fact || `${edge.source_node_uuid} ${edge.name} ${edge.target_node_uuid}`}\n`;
                            });

                            if (edgeCount > 5) {
                                edgeDisplay += `\n... and ${edgeCount - 5} more relationships`;
                            }

                            await adapter.reply(edgeDisplay);
                        }

                        // Format and display nodes (entities)
                        if (nodeCount > 0 && searchResults.nodes) { // Added null check
                            let nodeDisplay = `**Entities:**\n\n`;

                            searchResults.nodes.slice(0, 5).forEach((node: ZepNodeResult, index: number) => {
                                nodeDisplay += `${index + 1}. **${node.name}**: ${node.summary || 'No summary'}\n`;
                            });

                            if (nodeCount > 5) {
                                nodeDisplay += `\n... and ${nodeCount - 5} more entities`;
                            }

                            await adapter.reply(nodeDisplay);
                        }

                    } catch (error: any) { // Added type annotation
                        logError(methodName, 'Error searching with memory.searchGraph:', error);
                        await adapter.reply(`❌ Error searching graph via memory: ${error.message || 'Unknown error'}`);
                    }
                } else {
                    await adapter.reply('❌ Memory object does not support the `searchGraph` method.');
                }
                break;

            case 'add':
                if (!params) {
                    await adapter.reply('Usage: `/zepknowledge add [message|text|json] content`\n\nExample: `/zepknowledge add text TypeScript is a programming language`');
                    return;
                }

                const firstSpace = params.indexOf(' ');
                if (firstSpace === -1) {
                    await adapter.reply('Invalid format. Please specify data type and content.');
                    return;
                }

                const dataType = params.substring(0, firstSpace).toLowerCase();
                const content = params.substring(firstSpace + 1);

                await addToGraph(adapter, memory, userId, dataType, content, methodName); // Use memory
                break;

            case 'fact':
                if (!params) {
                    await adapter.reply('Usage: `/zepknowledge fact factName|subject|relationship|object`\n\nExample: `/zepknowledge fact WORKS_AT|John|works at|Acme Inc`');
                    return;
                }

                await addFactTriple(adapter, memory, userId, params, methodName); // Use memory
                break;

            case 'nodes':
                // Try to use direct memory method
                if (memory && typeof (memory as any).getUserNodes === 'function') {
                    try {
                        await adapter.reply(`🔍 Retrieving your nodes using memory.getUserNodes...`);
                        const nodes = await (memory as any).getUserNodes(userId);

                        if (!nodes || nodes.length === 0) {
                            await adapter.reply(`ℹ️ No nodes found for your user ID using memory.getUserNodes`);
                            return;
                        }

                        await adapter.reply(`Found ${nodes.length} nodes using memory.getUserNodes`);

                        // Group nodes by label for better organization
                        const nodesByLabel: Record<string, any[]> = {};

                        nodes.forEach((node: ZepNodeResult) => {
                            const labels = node.labels || ['Unlabeled'];

                            labels.forEach((label: string) => {
                                if (!nodesByLabel[label]) {
                                    nodesByLabel[label] = [];
                                }
                                nodesByLabel[label].push(node);
                            });
                        });

                        // Display nodes by category
                        for (const [label, labelNodes] of Object.entries(nodesByLabel)) {
                            let display = `**${label} Nodes (${labelNodes.length})**\n\n`;

                            labelNodes.slice(0, 5).forEach((node: ZepNodeResult, index: number) => {
                                display += `${index + 1}. **${node.name}**: ${node.summary || 'No summary'}\n`;

                                // Add attributes if available
                                if (node.attributes && Object.keys(node.attributes).length > 0) {
                                    display += `   - Attributes: ${JSON.stringify(node.attributes)}\n`;
                                }
                            });

                            if (labelNodes.length > 5) {
                                display += `\n... and ${labelNodes.length - 5} more ${label} nodes`;
                            }

                            await adapter.reply(display);
                        }

                    } catch (error: any) { // Added type annotation
                        logError(methodName, 'Error getting nodes with memory.getUserNodes:', error);
                        await adapter.reply(`❌ Error getting nodes via memory: ${error.message || 'Unknown error'}`);
                    }
                } else {
                    await adapter.reply('❌ Memory object does not support the `getUserNodes` method.');
                }
                break;

            case 'edges':
                 // Try to use direct memory method
                if (memory && typeof (memory as any).getUserEdges === 'function') {
                    await getUserEdges(adapter, memory, userId, methodName); // Use memory
                } else {
                     await adapter.reply('❌ Memory object does not support the `getUserEdges` method.');
                }
                break;

            case 'summary': // New case for summary
                if (memory && typeof (memory as any).getSessionSummary === 'function') {
                    try {
                        await adapter.reply(`🔍 Fetching session summary using memory.getSessionSummary...`);
                        const summary = await (memory as any).getSessionSummary(userId, sessionId);
                        if (summary && summary.content) {
                            await adapter.reply(`**Session Summary:**\n\n${summary.content}`);
                            await adapter.reply(`(Summary UUID: ${summary.uuid}, Tokens: ${summary.token_count})`);
                        } else {
                            await adapter.reply(`ℹ️ No summary available for this session yet.`);
                        }
                    } catch (error: any) {
                        logError(methodName, 'Error fetching summary with memory.getSessionSummary:', error);
                        await adapter.reply(`❌ Error fetching summary: ${error.message || 'Unknown error'}`);
                    }
                } else {
                    await adapter.reply('❌ Memory object does not support the `getSessionSummary` method.');
                }
                break;

            case 'test-graph':
                await testGraphFlow(adapter, userId, methodName, memory); // Removed graphApi
                break;

            case 'help':
            default:
                await showHelp(adapter);
                break;
        }
    }
};

// Function to test the entire graph flow using memory methods
async function testGraphFlow(
    adapter: ContextAdapter,
    userId: string,
    methodName: string,
    memory: IExtendedMemory | null // Now takes memory directly
): Promise<void> {
    try {
        await adapter.reply(`🧪 Running a complete graph test using memory methods...`);

        if (!memory) {
            await adapter.reply(`❌ Memory object is not available.`);
            return;
        }

        // Step 1: Check if the memory has graph support
        let graphAvailable = false;
        if (typeof (memory as any).isGraphAvailable === 'function') {
            try {
                graphAvailable = await (memory as any).isGraphAvailable();
                await adapter.reply(`Graph API available via memory: ${graphAvailable ? '✅' : '❌'}`);
            } catch (error: any) {
                await adapter.reply(`❌ Error checking graph availability via memory: ${error.message}`);
                graphAvailable = false; // Assume not available if check fails
            }
        } else {
            await adapter.reply(`ℹ️ Memory doesn't have an 'isGraphAvailable' method.`);
            // We can still try calling other methods, they might exist even if isGraphAvailable doesn't
        }

        // Step 2: Test adding content to graph
        if (typeof (memory as any).addToGraph === 'function') {
            try {
                const textContent = `This is a test message about Zep knowledge graphs created on ${new Date().toISOString()}`;
                const result = await (memory as any).addToGraph('text', textContent, userId);

                if (result && result.uuid) {
                    await adapter.reply(`✅ Successfully added text using memory.addToGraph! Episode UUID: ${result.uuid}`);
                } else {
                    await adapter.reply(`⚠️ Text data added via memory.addToGraph but no UUID returned`);
                }
            } catch (error: any) {
                await adapter.reply(`❌ Error using memory.addToGraph: ${error.message}`);
            }
        } else {
             await adapter.reply(`ℹ️ Memory doesn't have 'addToGraph' method.`);
        }

        // Step 3: Test adding fact triple
        if (typeof (memory as any).addFactTriple === 'function') {
            try {
                const fact = "Zep provides knowledge graph capabilities";
                const factResult = await (memory as any).addFactTriple(
                    fact,
                    "PROVIDES", // factName
                    "Knowledge Graph Capabilities", // targetNodeName
                    "Zep", // sourceNodeName
                    userId
                );

                if (factResult && factResult.edge) {
                    await adapter.reply(`✅ Successfully added fact triple using memory.addFactTriple! Edge UUID: ${factResult.edge.uuid}`);
                } else {
                    await adapter.reply(`⚠️ Fact triple added via memory.addFactTriple but no edge returned`);
                }
            } catch (error: any) {
                await adapter.reply(`❌ Error using memory.addFactTriple: ${error.message}`);
            }
        } else {
             await adapter.reply(`ℹ️ Memory doesn't have 'addFactTriple' method.`);
        }

        // Step 4: Wait a moment for processing
        await adapter.reply(`Step 4: Waiting for graph processing...`);
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Step 5: Test searching the graph
        if (typeof (memory as any).searchGraph === 'function') {
            try {
                await adapter.reply(`Searching graph via memory...`);
                const searchResults = await (memory as any).searchGraph("knowledge graph", { userId });

                if (searchResults &&
                    ((searchResults.edges && searchResults.edges.length > 0) ||
                     (searchResults.nodes && searchResults.nodes.length > 0))) {

                    await adapter.reply(`✅ Search successful via memory! Found ${searchResults.nodes?.length || 0} nodes and ${searchResults.edges?.length || 0} edges.`);
                } else {
                    await adapter.reply(`ℹ️ Search via memory completed but no results found yet. The graph may need more time to process.`);
                }
            } catch (error: any) {
                await adapter.reply(`❌ Error searching graph via memory: ${error.message}`);
            }
        } else {
             await adapter.reply(`ℹ️ Memory doesn't have 'searchGraph' method.`);
        }

        // Step 6: Test getting user nodes
        if (typeof (memory as any).getUserNodes === 'function') {
            try {
                const nodes = await (memory as any).getUserNodes(userId);
                await adapter.reply(`Found ${nodes?.length || 0} nodes for user using memory.getUserNodes`);
            } catch (error: any) {
                await adapter.reply(`❌ Error getting user nodes via memory: ${error.message}`);
            }
        } else {
             await adapter.reply(`ℹ️ Memory doesn't have 'getUserNodes' method.`);
        }

        await adapter.reply(`✅ Graph test using memory methods completed!`);

    } catch (error: any) { // Added type annotation
        logError(methodName, 'Error in graph test flow:', error);
        await adapter.reply(`❌ Error during graph test: ${error.message || 'Unknown error'}`);
    }
}

// Removed createGraphApi function

async function showHelp(adapter: ContextAdapter): Promise<void> {
    const helpText = `📚 **Zep Knowledge Graph Command**

    This command allows you to interact with the Zep knowledge graph using the configured memory component.

    **Basic Commands:**
    - \`/zepknowledge test-graph\` - Run a complete test of graph functionality via memory
    - \`/zepknowledge add [type] [content]\` - Add content to knowledge graph via memory
      - Types: message, text, json
    - \`/zepknowledge fact [factName|subject|relationship|object]\` - Add a fact triple via memory
    - \`/zepknowledge search [query]\` - Search across the knowledge graph via memory
    - \`/zepknowledge summary\` - View the latest session summary
    - \`/zepknowledge diagnostic\` - Run diagnostics on memory system
    - \`/zepknowledge nodes\` - List nodes associated with your user ID via memory
    - \`/zepknowledge edges\` - List edges (relationships) associated with your user ID via memory

    **Examples:**
    \`/zepknowledge add text TypeScript is a programming language developed by Microsoft\`
    \`/zepknowledge fact WORKS_AT|John|works at|Acme Inc\`
    \`/zepknowledge search TypeScript\`
    \`/zepknowledge test-graph\`

    **Note:** Graph features require a Zep memory component with graph support enabled. There may be a delay between adding data and being able to search for it.`;
    await adapter.reply(helpText);
}

async function runDiagnostics(
    adapter: ContextAdapter,
    memory: IExtendedMemory | null, // Keep memory
    userId: string,
    sessionId: string,
    methodName: string
    // Removed graphApi parameter
): Promise<void> {
    try {
        await adapter.reply('🔍 Running Zep memory and graph diagnostics...');

        if (!memory) {
             await adapter.reply('❌ Memory object is not available.');
             return;
        }

        // Check basic memory functions
        const hasBasicMethods = {
            getChatMessagesExtended: typeof memory?.getChatMessagesExtended === 'function',
            addChatMessages: typeof memory?.addChatMessages === 'function', // Check for the correct method
            clearChatMessagesExtended: typeof memory?.clearChatMessagesExtended === 'function',
            getMemoryType: typeof memory?.getMemoryType === 'function'
        };

        await adapter.reply(`📋 Memory Methods:
Basic Methods:
- getChatMessagesExtended: ${hasBasicMethods.getChatMessagesExtended ? '✅' : '❌'}
- addChatMessages: ${hasBasicMethods.addChatMessages ? '✅' : '❌'}
- clearChatMessagesExtended: ${hasBasicMethods.clearChatMessagesExtended ? '✅' : '❌'}
- getMemoryType: ${hasBasicMethods.getMemoryType ? '✅' : '❌'}`);

        // Test basic memory
        await adapter.reply('🧪 Testing basic memory...');
        try {
            let messages: any[] = [];
            if (typeof memory.getChatMessagesExtended === 'function') {
                // Prefer the extended method if available
                messages = await memory.getChatMessagesExtended(userId, sessionId);
                await adapter.reply(`✅ Retrieved ${messages.length} messages using getChatMessagesExtended`);
            } else if (typeof memory.getChatMessages === 'function') {
                // Fallback to the basic method
                messages = await memory.getChatMessages(sessionId, false); // overrideSessionId, returnBaseMessages=false
                await adapter.reply(`✅ Retrieved ${messages.length} messages using getChatMessages`);
            } else {
                await adapter.reply(`❌ No suitable method found to retrieve messages.`);
            }
        } catch (error: any) {
            await adapter.reply(`❌ Error retrieving messages: ${error.message}`);
        }

        // Test server info from memory object
        const memoryAny = memory as any;
        let baseUrl = memoryAny.baseURL || memoryAny.baseUrl || 'Unknown';
        if (baseUrl === 'Unknown' && memoryAny.client) { // Check client if direct property not found
             baseUrl = memoryAny.client.baseUrl || memoryAny.client.config?.baseUrl || 'Unknown';
        }

        await adapter.reply(`🔄 Zep Server Base URL (from memory object): ${baseUrl}`);

        // Check if graph API is available via memory
        await adapter.reply('🧪 Testing graph availability via memory...');
        let graphAvailable = false;
        if (typeof (memory as any).isGraphAvailable === 'function') {
             try {
                 graphAvailable = await (memory as any).isGraphAvailable();
                 await adapter.reply(`✅ Graph available according to memory.isGraphAvailable: ${graphAvailable}`);
             } catch (error: any) {
                 await adapter.reply(`❌ Error calling memory.isGraphAvailable: ${error.message}`);
             }
        } else {
             await adapter.reply(`ℹ️ Memory object does not have 'isGraphAvailable' method. Graph features might still work if underlying client supports them.`);
             // Attempt a simple graph call to check
             if (typeof (memory as any).searchGraph === 'function') {
                 try {
                     await (memory as any).searchGraph("diagnostic_test", { userId, limit: 1 });
                     await adapter.reply(`✅ Simple graph search test succeeded.`);
                     graphAvailable = true;
                 } catch (error: any) {
                     await adapter.reply(`❌ Simple graph search test failed: ${error.message}. Graph features likely unavailable or misconfigured.`);
                 }
             } else {
                 await adapter.reply(`❌ Memory object also lacks 'searchGraph'. Graph features unavailable.`);
             }
        }

        if (!graphAvailable) {
            await adapter.reply(`ℹ️ **Zep Graph Limitations**

Your Zep memory component does not seem to support graph features, or they are not configured correctly.

**Possible Reasons:**
1. Using Zep Community Edition without graph support enabled.
2. Configuration issue in the Zep memory node.
3. Network issue connecting to the Zep graph endpoints.

You can still use basic memory features for conversation history.`);
            return;
        }

        await adapter.reply('✅ Diagnostics completed.');

    } catch (error: any) { // Added type annotation
        logError(methodName, 'Error in diagnostics:', error);
        await adapter.reply(`❌ Error running diagnostics: ${error.message || 'Unknown error'}`);
    }
}

// Removed searchGraph function

async function addToGraph(
    adapter: ContextAdapter,
    memory: IExtendedMemory, // Use memory
    userId: string,
    dataType: string,
    content: string,
    methodName: string
): Promise<void> {
    try {
        // Validate data type
        if (!['message', 'text', 'json'].includes(dataType)) {
            await adapter.reply('Invalid data type. Please use "message", "text", or "json"');
            return;
        }

        if (typeof (memory as any).addToGraph !== 'function') {
            await adapter.reply('❌ Memory object does not support the `addToGraph` method.');
            return;
        }

        await adapter.reply(`🔄 Adding ${dataType} to graph via memory for user ${userId}...`);

        const result = await (memory as any).addToGraph(dataType, content, userId);

        if (result) {
            await adapter.reply(`✅ Successfully added ${dataType} to graph via memory!`);

            if (result.uuid) {
                await adapter.reply(`Episode created with UUID: ${result.uuid}`);

                // After adding data, try to search for it right away using memory
                await adapter.reply(`🔄 Now trying to search for this content via memory...`);

                if (typeof (memory as any).searchGraph === 'function') {
                    try {
                        const searchText = dataType === 'json' ? 'json data' : content.substring(0, 30);
                        const searchResults = await (memory as any).searchGraph(searchText, { userId });

                        if (searchResults &&
                            ((searchResults.edges && searchResults.edges.length > 0) ||
                             (searchResults.nodes && searchResults.nodes.length > 0))) {
                            await adapter.reply(`✅ Found results via memory! The graph is working!`);

                            // Display some of the results
                            let resultText = "";
                            if (searchResults.nodes && searchResults.nodes.length > 0) {
                                resultText += `Found ${searchResults.nodes.length} nodes\n`;
                                searchResults.nodes.slice(0, 3).forEach((node: ZepNodeResult, i: number) => {
                                    resultText += `${i + 1}. ${node.name}: ${node.summary || 'No summary'}\n`;
                                });
                            }

                            if (searchResults.edges && searchResults.edges.length > 0) {
                                resultText += `Found ${searchResults.edges.length} relationships\n`;
                                searchResults.edges.slice(0, 3).forEach((edge: ZepEdgeResult, i: number) => {
                                    resultText += `${i + 1}. ${edge.fact || edge.name}\n`;
                                });
                            }

                            await adapter.reply(resultText);
                        } else {
                            await adapter.reply(`ℹ️ No search results found via memory yet. The graph may need time to process.`);
                        }
                    } catch (error: any) {
                        await adapter.reply(`ℹ️ Search via memory failed: ${error.message}. The graph may need time to process.`);
                    }
                } else {
                     await adapter.reply(`ℹ️ Memory doesn't support searchGraph for immediate verification.`);
                }
            }

            // Inform about processing time
            await adapter.reply(`ℹ️ Note: It may take a few moments for Zep to process this data and update the knowledge graph. Try searching for it later.`);
        } else {
            await adapter.reply(`⚠️ Operation completed via memory but no result returned`);
        }
    } catch (error: any) { // Added type annotation
        logError(methodName, `Error adding ${dataType} to graph via memory:`, error);
        await adapter.reply(`❌ Error: ${error.message || 'Unknown error'}`);
    }
}

async function addFactTriple(
    adapter: ContextAdapter,
    memory: IExtendedMemory, // Use memory
    userId: string,
    paramsString: string,
    methodName: string
): Promise<void> {
    try {
        // Parse parameters - expected format: factName|subject|relationship|object
        const parts = paramsString.split('|');
        if (parts.length < 4) {
            await adapter.reply('⚠️ Invalid format. Expected: factName|subject|relationship|object');
            return;
        }

        const [factName, sourceNode, relationship, targetNode] = parts;

        // Create the fact string
        const fact = `${sourceNode} ${relationship} ${targetNode}`;

        logInfo(methodName, 'Adding fact triple via memory', {
            userId,
            factName,
            sourceNode,
            relationship,
            targetNode,
            fact
        });

        if (typeof (memory as any).addFactTriple !== 'function') {
            await adapter.reply('❌ Memory object does not support the `addFactTriple` method.');
            return;
        }

        await adapter.reply(`🔄 Adding fact triple to knowledge graph via memory:
Fact Name: ${factName}
Source Node: ${sourceNode}
Relationship: ${relationship}
Target Node: ${targetNode}
Fact: ${fact}`);

        // Note: Parameter order for memory.addFactTriple is different
        const result = await (memory as any).addFactTriple(
            fact,
            factName.toUpperCase(), // factName
            targetNode, // targetNodeName
            sourceNode, // sourceNodeName
            userId
        );

        if (result) {
            await adapter.reply(`✅ Fact added successfully via memory`);

            if (result.edge) {
                await adapter.reply(`Created relationship:
ID: ${result.edge.uuid || 'Unknown'}
Type: ${result.edge.name || factName}
Fact: ${result.edge.fact || fact}`);
            }

            if (result.source_node && result.target_node) {
                await adapter.reply(`Connected nodes:
From: ${result.source_node.name || 'Unknown'} (${result.source_node.uuid})
To: ${result.target_node.name || 'Unknown'} (${result.target_node.uuid})`);
            }
        } else {
            await adapter.reply(`⚠️ Operation completed via memory but no result returned`);
        }
    } catch (error: any) { // Added type annotation
        logError(methodName, 'Error adding fact triple via memory:', error);
        await adapter.reply(`❌ Error adding fact via memory: ${error.message || 'Unknown error'}`);
    }
}

// Removed getUserNodes function

async function getUserEdges(
    adapter: ContextAdapter,
    memory: IExtendedMemory, // Use memory
    userId: string,
    methodName: string
): Promise<void> {
    try {
        if (typeof (memory as any).getUserEdges !== 'function') {
            await adapter.reply('❌ Memory object does not support the `getUserEdges` method.');
            return;
        }

        await adapter.reply(`🔍 Retrieving your edges (relationships) via memory...`);

        const edges = await (memory as any).getUserEdges(userId);

        if (!edges || edges.length === 0) {
            await adapter.reply(`ℹ️ No edges found for your user ID via memory`);
            return;
        }

        await adapter.reply(`Found ${edges.length} edges via memory`);

        // Group edges by relationship type
        const edgesByType: Record<string, any[]> = {};

        edges.forEach((edge: ZepEdgeResult) => { // Added type
            const relationshipType = edge.name || 'Unknown';

            if (!edgesByType[relationshipType]) {
                edgesByType[relationshipType] = [];
            }

            edgesByType[relationshipType].push(edge);
        });

        // Display edges by relationship type
        for (const [relationType, typeEdges] of Object.entries(edgesByType)) {
            let display = `**${relationType} Relationships (${typeEdges.length})**\n\n`;

            typeEdges.slice(0, 5).forEach((edge: ZepEdgeResult, index: number) => { // Added type
                display += `${index + 1}. ${edge.fact}\n`;

                // Add temporal data if available
                if (edge.valid_at || edge.invalid_at) {
                    const validAt = edge.valid_at ? new Date(edge.valid_at).toLocaleDateString() : 'Always';
                    const invalidAt = edge.invalid_at ? new Date(edge.invalid_at).toLocaleDateString() : 'Never';
                    display += `   - Valid: ${validAt} to ${invalidAt}\n`;
                }
            });

            if (typeEdges.length > 5) {
                display += `\n... and ${typeEdges.length - 5} more ${relationType} relationships`;
            }

            await adapter.reply(display);
        }
    } catch (error: any) { // Added type annotation
        logError(methodName, 'Error getting user edges via memory:', error);
        await adapter.reply(`❌ Error retrieving edges via memory: ${error.message || 'Unknown error'}`);
    }
}

// Helper function to get memory client info
async function getMemoryClientInfo(memory: IExtendedMemory | null): Promise<{
    type: string;
    hasClient: boolean;
    hasZepClient: boolean;
    baseUrl?: string;
    hasApiKey: boolean;
    methods: string[];
    graphEnabled?: boolean;
}> {
    if (!memory) {
        return {
            type: 'null',
            hasClient: false,
            hasZepClient: false,
            hasApiKey: false,
            methods: []
        };
    }

    // Cast to any to allow indexing by string
    const memoryAny = memory as any;

    // Get memory type
    const type = memory.getMemoryType?.() || 'unknown';

    // Inspect the memory object to find client info
    let hasClient = false;
    let hasZepClient = false;
    let baseUrl: string | undefined = memoryAny.baseURL || memoryAny.baseUrl; // Get base URL directly first
    let hasApiKey = !!memoryAny.apiKey; // Check direct apiKey property
    let graphEnabled = !!memoryAny.enableGraph; // Check direct enableGraph property

    // Better method detection - get all methods, including those on the prototype
    const methods: string[] = [];

    // Function to recursively get methods
    const getAllMethods = (obj: object | null): string[] => {
        let props: string[] = [];
        let currentObj = obj;
        while (currentObj && currentObj !== Object.prototype) {
            props = props.concat(Object.getOwnPropertyNames(currentObj));
            currentObj = Object.getPrototypeOf(currentObj);
        }
        // Filter for functions and remove duplicates/built-ins
        return [...new Set(props)].filter(key =>
            obj && typeof (obj as any)[key] === 'function' &&
            key !== 'constructor' &&
            !key.startsWith('__') &&
            !['hasOwnProperty', 'propertyIsEnumerable', 'toString',
                'valueOf', 'toLocaleString', 'isPrototypeOf'].includes(key)
        );
    };

    methods.push(...getAllMethods(memory));


    // Look for Zep client specifically if direct properties weren't enough
    for (const key of Object.keys(memoryAny)) {
        if (key.toLowerCase().includes('client')) {
            hasClient = true;
            try {
                const client = memoryAny[key];
                if (client &&
                    (client.constructor?.name?.includes('Zep') ||
                     client.baseUrl ||
                     client.apiKey ||
                     client.config // Check for config object too
                     )) {

                    hasZepClient = true;
                    if (!baseUrl) { // Only set if not found directly on memory
                         baseUrl = client.baseUrl || client.config?.baseUrl;
                    }
                    if (!hasApiKey) { // Only set if not found directly on memory
                         hasApiKey = !!client.apiKey || !!client.config?.apiKey;
                    }
                }
            } catch (e) {
                // Ignore errors in inspection
            }
        }
    }

    return {
        type,
        hasClient,
        hasZepClient,
        baseUrl,
        hasApiKey,
        methods: methods.sort(), // Sort for consistent output
        graphEnabled
    };
}

export default zepKnowledgeCommand;