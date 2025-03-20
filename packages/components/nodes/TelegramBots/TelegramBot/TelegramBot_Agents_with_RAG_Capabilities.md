# TelegramBot_Agents with RAG Capabilities

## Overview

TelegramBot_Agents is an advanced Telegram bot implementation with Retrieval-Augmented Generation (RAG) capabilities. It combines the power of Large Language Models (LLMs) with a dynamic retrieval system to provide contextually relevant and informed responses to user queries.

## Core Components

1. TelegramBot_Agents: Main class handling Telegram API integration and overall bot management.
2. ConversationManager: Manages conversation flow, context retrieval, and response generation.
3. CommandHandler: Processes and executes bot commands.
4. AgentManager: Manages different types of agents (RAG, Tool, Conversation).
5. ToolManager: Handles tool-related operations and integrations.
6. PromptManager: Manages prompt templates and generation.
7. MemoryManager: Handles conversation memory and history.

## Key Features

- Integration with Telegram API
- RAG (Retrieval-Augmented Generation) functionality
- Dynamic context summarization
- Adaptive response generation
- Configurable system prompts
- Conversation memory management
- Tool integration capabilities
- Multi-modal support
- Group chat functionality with bot-specific interactions

## System Architecture

The system follows a modular "Lego-like" architecture, allowing for easy extension and modification of components.

## Authorization System

The TelegramBot_Agents implements a robust authorization system that handles both Telegram bot interactions and web application access. The system uses temporary authentication tokens and maintains user sessions with proper token management.

### Core Components

1. **AuthService**
   - Handles token generation, validation, and refresh operations
   - Key methods:
     - `generateTempAuthToken(userId: string)`: Creates JWT tokens for webapp auth
     - `refreshAuthToken(userId: string)`: Extends token validity if currently valid
     - `verifyTempAuthToken(token: string)`: Validates JWT tokens

2. **DatabaseService**
   - Manages token storage and validation in SQLite database
   - Key methods:
     - `hasValidAuthToken(userId: string)`: Checks token validity and expiry
     - `storeTempAuthToken(userId, token, expiryTime)`: Stores new auth tokens
     - `updateAuthTokenExpiry(userId, newExpiry)`: Updates token expiry times
     - `invalidateAuthTokenForUser(userId)`: Marks tokens as used/invalid

3. **AccountManager**
   - Handles user account operations and token usage
   - Key methods:
     - `validateMessageRequest(userId, input, source, auth?)`: Validates request auth
     - `updateTokenUsageFromText(userId, text, source)`: Updates usage and refreshes token
     - `getUserStats(userId)`: Retrieves user token usage statistics

### Authentication Flow

1. **Initial Authentication**
   - User starts with `/start auth` command in Telegram
   - `startCommand` in start.ts provides simplified auth-specific welcome
   - MenuManager generates auth token via `createStartInlineMenu`
   - Token stored in database with 30-minute expiry

2. **Web Application Access**
   - Web app requests include token in chatId format
   - `run` method in TelegramBot_Agents validates token:
     ```typescript
     if (webappData) {
         const normalizedUserId = `tg_${webappData.userId}`;
         const hasValidToken = await this.databaseService.hasValidAuthToken(normalizedUserId);
         // Handle auth status...
     }
     ```

3. **Token Refresh**
   - Tokens automatically refresh during active usage
   - Handled in `updateTokenUsageFromText`
   - 30-minute extension from last activity

4. **Token Validation**
   - Checks performed in SQLite using local time (AEST)
   - Tokens marked as used when expired
   - Validation includes:
     - Token existence
     - Expiry time
     - Used status

### User Stats and Token Usage

1. **Stats Tracking**
   - Token usage tracked per user
   - Stats included in API responses
   - Fields tracked:
     ```typescript
     {
         quota: number;
         used: number;
         remaining: number;
         total: number;
         messages: number;
         lastReset: string;
         nextReset: string | null;
         subscription: string;
     }
     ```

2. **Response Format**
   - Auth errors include current stats:
     ```typescript
     {
         text: '🔒 Authentication Required',
         error: 'Authentication required',
         requireAuth: true,
         showAuthModal: true,
         metadata: {
             type: 'auth_error',
             timestamp: string,
             tokenStats: {...}
         }
     }
     ```

### Security Considerations

1. **Token Management**
   - Tokens expire after 30 minutes of inactivity
   - One active token per user
   - Automatic invalidation of expired tokens

2. **User ID Normalization**
   - Telegram IDs prefixed with 'tg_'
   - Consistent ID format across systems
   - Example: `tg_1234567890`

3. **Error Handling**
   - Graceful handling of expired tokens
   - Clear error messages
   - Automatic cleanup of invalid tokens

### Integration Points

1. **Telegram Bot**
   - `/start auth` command
   - Menu system for token generation
   - User account initialization

2. **Web Application**
   - Token validation on each request
   - Stats tracking and updates
   - Auth modal triggering

3. **Database**
   - Token storage
   - User stats tracking
   - Session management

This authorization system ensures secure access to the bot's capabilities while maintaining proper usage tracking and token management.

## User ID Normalization and Token Stats

### User ID Handling
- User IDs are normalized with a 'tg_' prefix for both Telegram and webapp users
- Important: Check for existing prefix before normalizing to avoid double prefixing
- Example: `1414981328` becomes `tg_1414981328`

### Token Stats Flow
1. In executeRun:
   ```typescript
   // Correct way to normalize userId
   const normalizedUserId = options.userId.startsWith('tg_') ? 
       options.userId : 
       `tg_${options.userId}`;
       
### Flow Chart

run (TelegramBot_Agents.ts)
└── handleMessage
    ├── handleNonTelegramMessage (for non-Telegram sources)
    │   └── processMessage
    │       └── prepareAndProcessUserInput
    │           └── processUserInput
    │               ├── getChatHistory
    │               └── conversationManager.processWithRAGAgent
    │                   └── (see RAG pipeline below)
    └── processMessage (for Telegram sources)
        └── prepareAndProcessUserInput
            └── (same as above, starting from processUserInput)

RAG Pipeline (conversationManager.processWithRAGAgent):
└── ragAgent.processQuery (RAGAgent.ts)
    ├── getRelevantContext (ConversationManager.ts)
    │   └── CustomRetriever.getRelevantDocuments
    └── generateResponse (ConversationManager.ts)
        ├── determineInteractionType
        ├── shouldPromptRagMode
        ├── detectContextRequirement
        ├── getContextAwarePrompt
        │   └── generateRecentContextSummary
        ├── shouldUseTool
        └── generateAnswer (based on context requirement) (ConversationManager.ts)
            ├── chat (for 'chat' requirement)
            │   └── generateSimpleResponse
            ├── rag (for 'rag' requirement)
            │   ├── getStandaloneQuestion
            │   ├── getDynamicContext
            │   │   ├── getRelevantContext (if not already retrieved)
            │   │   ├── assessContextComplexity
            │   │   └── assessQuestionComplexity
            │   ├── summarizeContext (if needed)
            │   ├── prepareChatPrompt
            │   ├── generateAnswer
            │   │   └── chatModel.invoke
            │   ├── responseIncludesContext
            │   ├── regenerateWithExplicitContext (if needed)
            │   ├── removeDisclaimersAndNotes (if enabled)
            │   ├── generateSourceCitations
            │   └── generateFollowUpQuestions
            └── tool (for 'tool' requirement)
                └── executeToolAgent

handleEnhancedResponse (TelegramBot_Agents.ts)
├── sendResponse
│   └── splitAndTruncateMessage
├── sendPaginatedCitations (if applicable)
└── sendPaginatedQuestions (if applicable)

updateMemory (TelegramBot_Agents.ts)
└── addChatMessages

formatResponse

Additional utility methods: (TelegramBot_Agents.ts)
- convertToBaseMessages
- serializeChatHistory
- constructContextualizedQuery
- summarizeText
- handleRagModeResponse (for RAG mode continuation prompts)
- isBotInGroup (for Telegram group chats)
- isAIUser
- generateUUID (for chat message IDs)
- extractTopics
- analyzeSentiment

Error handling:
- handleProcessingError

Memory management: (TelegramBot_Agents.ts)
- getChatHistory
- clearMemory
- clearAllMemory

Command handling:
- executeCommand
- executeCommandByName
- showCommandMenu

## Configuration Variables

The following variables can be configured in the TelegramBot_Agents node interface:

1. **botToken**: Telegram Bot API token
2. **retriever**: BaseRetriever instance for document retrieval
3. **chatModel**: BaseChatModel instance for response generation
4. **memory**: FlowiseMemory instance for conversation history management
5. **tools**: Array of Tool instances for additional functionalities
6. **ragSystemPrompt**: System prompt for RAG-based responses
7. **generalSystemPrompt**: System prompt for general conversations
8. **humanMessageTemplate**: Template for formatting human messages
9. **summarizeSystemPrompt**: System prompt for context summarization

## ConversationManager Configurable Methods

The ConversationManager class contains several methods with configurable parameters:

1. **splitAndTruncateMessage**
   - `maxLength`: Maximum length of each message chunk (default: 4000)

2. **assessContextComplexity**
   - Adjust the complexity calculation formula in the method body

3. **assessQuestionComplexity**
   - Modify the `complexityIndicators` list and adjust the complexity calculation formula

4. **getRelevantContext**
   - Adjust the number of top documents retrieved (currently set to 10)

5. **getDynamicContext**
   - `baseLength`: Base length for dynamic context (default: 6000)
   - `complexityFactor`: Minimum complexity factor (default: 0.9)

6. **summarizeContext**
   - `targetLength`: Target length for summarized context

7. **truncateChatHistory**
   - `maxTokens`: Maximum number of tokens to keep in chat history (default: 3000)

## Usage

To use the TelegramBot_Agents in your project:

1. Install the required dependencies
2. Configure the TelegramBot_Agents node with appropriate values for the configuration variables
3. Initialize the bot using the `init` method
4. Start the bot using the `run` method

## Error Handling

The system includes comprehensive error handling and logging. Check the console output and log files for detailed information about the bot's operation and any issues that may arise.

## Performance Optimization

To optimize performance:

1. Adjust the `baseLength` and `complexityFactor` in `getDynamicContext` method
2. Fine-tune the relevance scoring algorithm in `getRelevantContext` method
3. Optimize the summarization process in `summarizeContext` method

## Contributing

Contributions to improve TelegramBot_Agents are welcome. Please submit pull requests with detailed descriptions of your changes.

## License

[Specify your license here]=TBA



Certainly! I'll review the TelegramBot_Agents_with_RAG_Capabilities.md file and update the relevant sections to reflect our recent progress. Here's a summary of the updates:

## Project Status (As of August 6, 2024)

1. Memory Management:
   - Successfully implemented and integrated ZepMemoryExtended as an external memory solution.
   - Adapted the external memory to work with our IExtendedMemory interface without modifying the external node.
   - Resolved issues with memory initialization and usage in the TelegramBot_Agents class.

2. Session Management:
   - Improved session handling to differentiate between private and group chats.
   - Implemented a robust getSessionInfo method that generates appropriate session IDs for different chat types.

3. Context Retrieval:
   - The RAG system's context retrieval process is functioning as intended, with successful integration of the CustomRetriever.

4. Command Handling:
   - Basic command functionality is in place and working correctly.
   - Successfully registered and initialized all commands in the CommandHandler.

5. Persona Implementation:
   - The bot's persona consistency has improved, with the ability to maintain context across conversations.


## Project Status (As of August 8, 2024)

1. Memory Management:
   - Successfully implemented and integrated ZepMemoryExtended as an external memory solution.
   - Adapted the external memory to work with our IExtendedMemory interface without modifying the external node.
   - Resolved issues with memory initialization and usage in the TelegramBot_Agents class.
   - Implemented chunking for long messages to comply with memory storage limitations.

2. Session Management:
   - Improved session handling to differentiate between private and group chats.
   - Implemented a robust getSessionInfo method that generates appropriate session IDs for different chat types.

3. Context Retrieval:
   - The RAG system's context retrieval process is functioning as intended, with successful integration of the CustomRetriever.

4. Command Handling:
   - Basic command functionality is in place and working correctly.
   - Successfully registered and initialized all commands in the CommandHandler.
   - Implemented a /searchweb command that utilizes the WebBrowser tool for real-time web searches.

5. Persona Implementation:
   - The bot's persona consistency has improved, with the ability to maintain context across conversations.
   - Implemented a toggleable persona feature that can be enabled or disabled as needed.

6. Tool Integration:
   - Successfully integrated the WebBrowser tool and ToolAgent for enhanced functionality.
   - Implemented a method to use tools when explicitly instructed, particularly for web searches.

7. Multi-Modal Capabilities:
   - Added support for handling image inputs when the multi-modal option is enabled.


## Project Status (As of August 11, 2024)

1. Core Functionality:
   - Successfully implemented a Telegram bot with RAG (Retrieval-Augmented Generation) capabilities.
   - Integrated external memory solutions with a fallback to a custom MemoryManager.
   - Implemented a ConversationManager for handling complex conversational flows.

2. Memory Management:
   - Implemented adaptive memory system that can use external memory nodes or fall back to a custom MemoryManager.
   - Successfully integrated ZepMemoryExtended as an external memory solution.
   - Implemented methods to handle chat history retrieval and updates.

3. Session Management:
   - Improved session handling to differentiate between private and group chats.
   - Implemented robust getSessionInfo method for appropriate session ID generation.

4. Context Retrieval:
   - Implemented RAG system's context retrieval process with CustomRetriever integration.
   - Added dynamic context generation based on query complexity.

5. Command Handling:
   - Implemented a CommandHandler for managing various bot commands.
   - Successfully registered and initialized multiple commands.

6. Tool Integration:
   - Integrated WebBrowser tool and set up foundation for ToolAgent functionality.

7. Multi-Modal Capabilities:
   - Added initial support for handling image inputs when multi-modal option is enabled.

8. Persona Implementation:
   - Implemented toggleable persona feature for more dynamic conversations.

## Project Status (As of August 14, 2024)

1. Modular Architecture:
   - Successfully implemented a modular structure with AgentManager, ToolManager, PromptManager, and ConversationManager.
   - Refactored existing code to fit into the new modular structure.
   - Created BaseAgent class and specific agent implementations (RAGAgent, ToolAgent, ConversationAgent).

2. AgentManager:
   - Implemented AgentManager as the central coordinator for agent-based interactions.
   - Added collaborativeResponse method to handle message processing and agent selection.

3. PromptManager:
   - Centralized prompt management and generation in the PromptManager class.
   - Moved system prompts and related functionality from ConversationManager to PromptManager.

4. ConversationManager:
   - Updated to work with the new agent structure while maintaining core conversation handling logic.
   - Retained methods for interaction type determination and context requirement detection.

5. TelegramBot_Agents:
   - Updated to use the new modular structure, particularly integrating AgentManager for message processing.
   - Implemented a hybrid approach that maintains existing functionality while setting the stage for multi-agent processing.

6. Memory Management:
   - Retained and adapted the existing memory management system to work with the new structure.

7. Error Handling and Logging:
   - Implemented comprehensive error handling and logging across all new classes and methods.

8. Command Handling:
   - Maintained existing command handling structure, updated to work with the new modular architecture.

## Project Status (As of September 5, 2024)

1. Citation System:
   - Redesigned to be chat-specific rather than user-specific.
   - Implemented HTML formatting for better readability.
   - Removed content display from citations, focusing on essential reference information.

2. Question Pagination:
   - Updated to be consistent with the citation system, making it chat-specific.
   - Improved error handling and added fallback mechanisms for message sending.

3. Modular Architecture:
   - Refined the roles of AgentManager, ToolManager, and PromptManager for better separation of concerns.

4. Group Chat Functionality:
   - Enhanced support for group chats, allowing shared interaction with citations and questions.

5. Memory Management:
   - Improved chunking and storage of long messages.
   - Enhanced cleanup processes for expired data.

## Next Steps

1. Testing and Refinement:
   - Conduct thorough testing of the new chat-specific citation and question systems, especially in group chat scenarios.
   - Refine error handling and edge case management based on test results.

2. Performance Optimization:
   - Profile the system to identify any performance bottlenecks, particularly in RAG processes and memory management.

3. Documentation:
   - Update inline documentation to reflect recent changes.
   - Create or update user guides for new features and functionalities.

4. Multi-Agent Collaboration:
   - Further develop the system for multiple agents to collaborate on complex queries.
   - Implement a supervisor agent to oversee and coordinate multi-agent interactions.

5. Extended Tool Integration:
   - Explore integration of additional tools to enhance bot capabilities.

6. User Interface Enhancements:
   - Consider implementing a web interface for bot management and analytics.

7. Scalability:
   - Assess and improve the system's ability to handle increased load and multiple concurrent users.

8. Security Audit:
   - Conduct a comprehensive security review, focusing on data protection and privacy in group chat scenarios.

This project continues to evolve, aiming to create a powerful, flexible, and user-friendly conversational AI system with advanced RAG and multi-modal capabilities. The recent improvements in citation and question handling, along with the refinements in the modular architecture, have significantly enhanced the bot's functionality and user experience.

## Architecture Overview

The TelegramBot_Agents system is being restructured into a more modular, "Lego-like" architecture:

1. Core Components:
   - TelegramBot_Agents: Main entry point and bot initialization
   - ConversationManager: High-level conversation flow management

2. Modular Components:
   - AgentManager: Manages different types of agents (RAG, Tool, Conversation)
   - MemoryManager: Handles conversation memory with external adapter support
   - ToolManager: Manages and executes various tools
   - PromptManager: Handles prompt templates and generation

3. Agent Components:
   - BaseAgent: Abstract base class for all agents
   - RAGAgent: Handles retrieval-augmented generation
   - ToolAgent: Manages tool usage
   - ConversationAgent: Handles general conversation

4. Utility Components:
   - CommandHandler: Manages bot commands
   - Individual command files

This modular structure aims to improve code maintainability, ease of extension, and overall system flexibility.

## Current Challenges

1. Balancing flexibility with type safety in TypeScript, especially when dealing with different model types and their specific requirements.
2. Ensuring smooth integration between the modular components while maintaining performance.
3. Handling the complexity of multi-modal inputs and outputs in a unified system.
4. Managing the growing number of commands and tools efficiently.

## Short Term Future Considerations

1. Implementing a plugin system for easier addition of new tools and capabilities.
2. Exploring advanced NLP techniques for better understanding of user intent and context.
3. Investigating potential integration with other messaging platforms beyond Telegram.
4. Considering the implementation of a web interface for bot management and analytics.

The project continues to evolve, aiming to create a powerful, flexible, and user-friendly conversational AI system with advanced RAG and multi-modal capabilities.

## Memory Management and Session Handling

Our project now uses a custom memory management system that successfully integrates with external memory solutions like ZepMemoryExtended while maintaining compatibility with the FlowiseMemory interface.

Key Points:
1. External Memory Adaptation:
   - Implemented an adaptMemory method that allows seamless integration of external memory solutions.
   - Maintains compatibility with both IExtendedMemory and FlowiseMemory interfaces.

2. Session ID Generation:
   - Implemented a robust getSessionInfo method that generates unique session IDs for different chat types (private vs. group).
   - Private chats use the format: `telegram-private-${userId}`
   - Group chats use the format: `telegram-group-${chatId}`

3. Memory Operations:
   - Successfully implemented addChatMessages, getChatMessages, and clearChatMessages methods that work with the adapted external memory.
   - Conversion methods (convertToFlowiseIMessages, convertToBaseMessages) ensure proper message format handling between different interfaces.

4. Persistent Storage:
   - ZepMemoryExtended provides persistent storage for chat histories, allowing the bot to maintain context across sessions and restarts.

5. Flexibility:
   - The current implementation allows for easy switching between different memory solutions without modifying the core TelegramBot_Agents code.

## Other Future Considerations:

1. Embeddable Web App Node:
   - Leverage Flowise's React-based infrastructure to create a custom node for an embeddable web app.
   - This node can generate a React component serving as the webapp interface.
   - Utilize Flowise's existing embedding capabilities for seamless integration with Telegram Mini Apps or other web platforms.
   - Benefits include easier customization, seamless data flow between bot logic and web interface, and streamlined deployment.

2. Token-Based Subscription Model:
   - Implement a token-based subscription system to align with common LLM pricing models (pay per million tokens).
   - Track token usage per user or per chat session.
   - Offer subscription tiers based on token allowances (e.g., 1M tokens/month, 5M tokens/month).
   - Implement real-time token usage tracking and alerts for users approaching their limit.

3. Telegram Payment Integration:
   - Utilize Telegram's built-in payment system for handling subscriptions and pay-per-use models.
   - Implement commands like `/subscribe` to initiate the payment process within Telegram.
   - Handle successful payments to grant appropriate access levels or token allowances.

4. Crypto Wallet Integration:
   - Leverage Telegram's TON Wallet or guide users to make crypto payments to a specified wallet address.
   - Implement a system to verify crypto transactions and activate subscriptions accordingly.

5. Enhanced Web App Functionality:
   - Develop a more comprehensive dashboard for users to view their subscription status, token usage, and interaction history.
   - Implement advanced query interfaces and data visualizations from the knowledge base.
   - Create an account management system integrated with the bot and web app.

6. API Development:
   - Design a robust API that can serve the bot, web app, and potential future applications.
   - Ensure the API can handle user authentication, query processing, and subscription management.

7. Scalability and Database Integration:
   - Implement a scalable database solution to store user information, subscriptions, and interaction history.
   - Design the system architecture to handle increased load as the user base grows.

8. Authentication System:
   - Develop a unified authentication system that works across the bot, web app, and API.
   - Implement secure methods for managing user sessions and permissions.

9. Modular Architecture:
   - Ensure the codebase remains modular and easily extensible to accommodate future features and integrations.

10. Potential Standalone Application:
    - Consider developing a standalone mobile or desktop application if user demand justifies it.
    - Ensure the core functionality is platform-agnostic to ease potential transitions or expansions.

By focusing on these areas, we can create a more robust, scalable, and user-friendly system that leverages the strengths of both Flowise and Telegram while preparing for potential future expansions and monetization strategies.

These updates reflect the significant progress made in implementing and integrating the external memory solution, improving session handling, and enhancing the overall functionality of the TelegramBot_Agents with RAG capabilities.

### Note for Developers:

When working with memory-related functionality, be aware of this dual approach. Always prefer the newer, more granular methods for new implementations. If you encounter methods using `overrideSessionId`, consider updating them to use the 'Extended' versions if appropriate.
