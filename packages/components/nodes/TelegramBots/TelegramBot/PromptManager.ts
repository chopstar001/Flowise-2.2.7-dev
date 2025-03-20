// PromptManager.ts
import { BaseMessage, HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';
import { ChatPromptTemplate, MessagesPlaceholder, HumanMessagePromptTemplate, SystemMessagePromptTemplate } from '@langchain/core/prompts';
import { logInfo, logError, logWarn } from './loggingUtility';
import { InteractionType, ContextRequirement } from './commands/types';

export class PromptManager {
    private ragSystemPrompt: string;
    private generalSystemPrompt: string;
    private humanMessageTemplate: string;
    private summarizeSystemPrompt: string;
    private gameSummarizeSystemPrompt: string;
    private personaPrompt: string;
    private toolAgentSystemPrompt: string;
    private gameSystemPrompt: string;
    private maxChatHistoryTokens: number;
    private maxMessageLength: number;
    private enablePersona: boolean;
    private flowId: string;

    constructor(
        ragSystemPrompt: string,
        generalSystemPrompt: string,
        humanMessageTemplate: string,
        summarizeSystemPrompt: string,
        gameSummarizeSystemPrompt: string,
        personaPrompt: string,
        toolAgentSystemPrompt: string,
        gameSystemPrompt: string,
        maxChatHistoryTokens: number,
        maxMessageLength: number,
        enablePersona: boolean = false,
    ) {
        // First, initialize all prompts with their default values if not provided
        this.ragSystemPrompt = ragSystemPrompt || PromptManager.defaultRAGSystemPrompt();
        this.generalSystemPrompt = generalSystemPrompt || PromptManager.defaultGeneralSystemPrompt();
        this.humanMessageTemplate = humanMessageTemplate || PromptManager.defaultHumanMessageTemplate();
        this.summarizeSystemPrompt = summarizeSystemPrompt || PromptManager.defaultSummarizeSystemPrompt();
        this.gameSummarizeSystemPrompt = gameSummarizeSystemPrompt || PromptManager.defaultGameSummarizeSystemPrompt();
        this.personaPrompt = personaPrompt || PromptManager.defaultPersonaPrompt();

        // Explicitly separate game and tool prompts to avoid confusion
        this.gameSystemPrompt = PromptManager.defaultGameSystemPrompt(); // Initialize with default first
        if (gameSystemPrompt) {
            this.gameSystemPrompt = gameSystemPrompt; // Override with provided value if exists
        }

        this.toolAgentSystemPrompt = PromptManager.defaultToolAgentSystemPrompt(); // Initialize with default first
        if (toolAgentSystemPrompt) {
            this.toolAgentSystemPrompt = toolAgentSystemPrompt; // Override with provided value if exists
        }

        this.maxChatHistoryTokens = maxChatHistoryTokens;
        this.maxMessageLength = maxMessageLength;
        this.enablePersona = enablePersona;

        // Add validation
        if (this.gameSystemPrompt === this.toolAgentSystemPrompt) {
            console.warn('Warning: gameSystemPrompt and toolAgentSystemPrompt are identical. This may indicate an initialization error.');
        }

        // Log the initialization state
        console.log('PromptManager initialized with:', {
            hasGamePrompt: !!this.gameSystemPrompt,
            hasToolPrompt: !!this.toolAgentSystemPrompt,
            gamePromptPreview: this.gameSystemPrompt?.substring(0, 50),
            toolPromptPreview: this.toolAgentSystemPrompt?.substring(0, 50)
        });
    }

    public togglePersona(enable: boolean): void {
        this.enablePersona = enable;
    }

    public getContextAwarePrompt(contextRequirement: ContextRequirement, chatHistory: BaseMessage[]): ChatPromptTemplate {
        console.log("Entering getContextAwarePrompt");
        const contextualPrompt = this.generateRecentContextSummary(chatHistory);

        switch (contextRequirement) {
            case 'rag':
                return this.createRAGPrompt(contextualPrompt);
            case 'game':
                return this.createGamePrompt(contextualPrompt);
            default:
                return this.createGeneralConversationPrompt(contextualPrompt);
        }
    }

    private createGamePrompt(contextualPrompt: string): ChatPromptTemplate {
        return ChatPromptTemplate.fromMessages([
            SystemMessagePromptTemplate.fromTemplate(
                `${this.gameSystemPrompt}\n\nGame Context:\n${contextualPrompt}`
            ),
            new MessagesPlaceholder("chat_history"),
            HumanMessagePromptTemplate.fromTemplate(
                "Game State: {gameState}\nCurrent Action: {action}\n\nRespond as Eddie McGuire:"
            )
        ]);
    }

    public createRAGPrompt(contextualPrompt: string): ChatPromptTemplate {
        return ChatPromptTemplate.fromMessages([
            SystemMessagePromptTemplate.fromTemplate(`${this.ragSystemPrompt}\n${contextualPrompt}`),
            new MessagesPlaceholder("chat_history"),
            HumanMessagePromptTemplate.fromTemplate(this.humanMessageTemplate)
        ]);
    }

    public createGeneralConversationPrompt(contextualPrompt: string): ChatPromptTemplate {
        return ChatPromptTemplate.fromMessages([
            SystemMessagePromptTemplate.fromTemplate(`${this.generalSystemPrompt}\n${contextualPrompt}`),
            new MessagesPlaceholder("chat_history"),
            HumanMessagePromptTemplate.fromTemplate(this.humanMessageTemplate)
        ]);
    }

    public generateRecentContextSummary(recentMessages: BaseMessage[]): string {
        const topics = this.extractTopics(recentMessages);
        const sentiment = this.analyzeSentiment(recentMessages);
        return `Recent conversation summary: Topics - ${topics.join(', ')}. Overall sentiment - ${sentiment}.`;
    }

    public stopWords = new Set(['about', 'above', 'after', 'again', 'all', 'also', 'and', 'any', 'are', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'can', 'does', 'doing', 'down', 'during', 'each', 'for', 'from', 'further', 'had', 'has', 'have', 'having', 'here', 'how', 'into', 'just', 'more', 'most', 'not', 'now', 'only', 'other', 'over', 'or', 'some', 'such', 'than', 'that', 'the', 'their', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'under', 'until', 'very', 'what', 'when', 'where', 'which', 'while', 'with', 'your']);

    public extractTopics(messages: BaseMessage[]): string[] {
        const allText = messages.map(m => m.content).join(' ');
        const words = allText.toLowerCase().split(/\W+/);
        const significantWords = words.filter(w => !this.stopWords.has(w) && w.length > 3);
        const wordFrequency = new Map<string, number>();

        significantWords.forEach(word => {
            wordFrequency.set(word, (wordFrequency.get(word) || 0) + 1);
        });

        const sortedWords = Array.from(wordFrequency.entries())
            .sort((a, b) => b[1] - a[1])
            .map(entry => entry[0]);

        return sortedWords.slice(0, 3); // Return top 3 most frequent significant words as topics
    }

    public analyzeSentiment(messages: BaseMessage[]): string {
        // Implement sentiment analysis logic
        // This could use a more sophisticated NLP library in a real implementation
        // For now, let's use a simple keyword-based approach
        const allText = messages.map(m => m.content).join(' ').toLowerCase();
        const positiveWords = ['good', 'great', 'excellent', 'amazing', 'happy', 'love'];
        const negativeWords = ['bad', 'terrible', 'awful', 'sad', 'hate', 'angry'];

        const positiveCount = positiveWords.filter(w => allText.includes(w)).length;
        const negativeCount = negativeWords.filter(w => allText.includes(w)).length;

        if (positiveCount > negativeCount) return 'positive';
        if (negativeCount > positiveCount) return 'negative';
        return 'neutral';
    }

    public constructSystemPrompt(interactionType: InteractionType, contextRequirement: ContextRequirement): string {
        const methodName = 'constructSystemPrompt';
        let prompt: string;

        console.log(`[${methodName}] State check before prompt selection:`, {
            interactionType,
            contextRequirement,
            hasGamePrompt: !!this.gameSystemPrompt,
            hasToolPrompt: !!this.toolAgentSystemPrompt,
            gamePromptStart: this.gameSystemPrompt?.substring(0, 50),
            toolPromptStart: this.toolAgentSystemPrompt?.substring(0, 50)
        });

        if (contextRequirement === 'game') {
            logInfo(methodName, `Using Game System Prompt`);
            if (!this.gameSystemPrompt) {
                logWarn(methodName, 'Game system prompt not initialized, falling back to default');
                this.gameSystemPrompt = PromptManager.defaultGameSystemPrompt();
            }
            prompt = this.gameSystemPrompt;
            console.log(`[${methodName}] Selected game prompt:`, prompt.substring(0, 100));
        } else {
            if (contextRequirement === 'rag') {
                logInfo(methodName, `Using RAG System Prompt`);
                prompt = this.ragSystemPrompt;
            } else {
                prompt = this.generalSystemPrompt;

                if (this.enablePersona) {
                    prompt += `\n\nAdditional persona characteristics: ${this.personaPrompt}`;
                }
            }
        }

        prompt += `\n\nCurrent interaction type: ${interactionType}
Context requirement: ${contextRequirement}`;

        return prompt;
    }

    public constructUserPrompt(question: string, context: string, interactionType: InteractionType): string {
        return `
Question: ${question}
Interaction Type: ${interactionType}

Retrieved Context:
${context || 'No specific context provided.'}

${this.humanMessageTemplate}`;
    }
    // not being used?
    public getSystemPromptForContextRequirement(contextRequirement: ContextRequirement): string {
        switch (contextRequirement) {
            case 'rag':
                return this.ragSystemPrompt;
            case 'chat':
                return this.generalSystemPrompt;
            case 'tool':
                return this.toolAgentSystemPrompt;
            case 'game':
                return this.gameSystemPrompt;
            case 'none':
                return this.generalSystemPrompt; // or create a new prompt for 'none' if needed
            default:
                logError('PromptManager.getSystemPromptForContextRequirement', `Invalid context requirement: ${contextRequirement}`, new Error('Invalid context requirement'));
                return this.generalSystemPrompt;
        }
    }

    public getGameSystemPrompt(): string {
        return this.gameSystemPrompt;
    }

    public getSummarizePrompt(): string {
        return this.summarizeSystemPrompt;
    }

    public getGameSummarizePrompt(): string {
        return this.gameSummarizeSystemPrompt;
    }

    public getPersonaPrompt(): string {
        return this.personaPrompt;
    }

    public getToolAgentSystemPrompt(): string {
        return this.toolAgentSystemPrompt;
    }

    public updatePrompt(promptType: 'rag' | 'general' | 'human' | 'summarize' | 'gameSummarize' | 'persona' | 'toolAgent' | 'gameAgent', newPrompt: string): void {
        switch (promptType) {
            case 'rag':
                this.ragSystemPrompt = newPrompt;
                break;
            case 'general':
                this.generalSystemPrompt = newPrompt;
                break;
            case 'human':
                this.humanMessageTemplate = newPrompt;
                break;
            case 'summarize':
                this.summarizeSystemPrompt = newPrompt;
                break;
            case 'gameSummarize':
                this.gameSummarizeSystemPrompt = newPrompt;
                break;
            case 'persona':
                this.personaPrompt = newPrompt;
                break;
            case 'toolAgent':
                this.toolAgentSystemPrompt = newPrompt;
                break;
            case 'gameAgent':
                this.gameSystemPrompt = newPrompt;
                break;
            default:
                logError('PromptManager.updatePrompt', `Invalid prompt type: ${promptType}`, new Error('Invalid prompt type'));
        }
        logInfo('PromptManager.updatePrompt', `Updated ${promptType} prompt`);
    }

    public splitAndTruncateMessage(message: string, customMaxLength?: number): string[] {
        const maxLength = customMaxLength || this.maxMessageLength;
        return PromptManager.splitAndTruncateMessage(message, maxLength);
    }

    public static splitAndTruncateMessage(message: string, maxLength: number = 4000): string[] {

        // Safety check for empty or invalid messages
        if (!message || typeof message !== 'string') {
            console.warn(`[splitAndTruncateMessage] Invalid message received: ${typeof message}`);
            return ["Sorry, I couldn't generate a proper response."];
        }

        if (message.trim().length === 0) {
            console.warn(`[splitAndTruncateMessage] Empty message received`);
            return ["I processed your request but couldn't generate any content."];
        }


        const chunks: string[] = [];
        let remainingMessage = message;

        while (remainingMessage.length > 0) {
            if (remainingMessage.length <= maxLength) {
                chunks.push(remainingMessage);
                break;
            }

            let chunk = remainingMessage.substring(0, maxLength);
            let splitIndex = chunk.lastIndexOf('\n');
            if (splitIndex === -1) splitIndex = chunk.lastIndexOf(' ');
            if (splitIndex === -1) splitIndex = maxLength;

            chunks.push(remainingMessage.substring(0, splitIndex));
            remainingMessage = remainingMessage.substring(splitIndex).trim();
        }

        console.log(`[splitAndTruncateMessage] Split message into ${chunks.length} chunks`);

        // Safety check for empty chunks result
        if (chunks.length === 0) {
            console.warn(`[splitAndTruncateMessage] No chunks generated from a non-empty message`);
            return ["I processed your request but had trouble formatting the response."];
        }

        return chunks;
    }

    public truncateChatHistory(chatHistory: BaseMessage[]): BaseMessage[] {
        const historyString = this.convertBaseMessagesToString(chatHistory);
        const tokens = historyString.split(/\s+/);
        if (tokens.length <= this.maxChatHistoryTokens) {
            console.log(`Chat history (${tokens.length} tokens) within limit, no truncation needed.`);
            return chatHistory;
        }

        console.log(`Truncating chat history from ${tokens.length} tokens to ${this.maxChatHistoryTokens} tokens.`);
        const truncatedTokens = tokens.slice(-this.maxChatHistoryTokens);
        const truncatedHistory = truncatedTokens.join(' ');
        console.log(`Truncated chat history length: ${truncatedHistory.length} characters.`);

        return this.convertToBaseMessages(truncatedHistory);
    }

    private convertBaseMessagesToString(messages: BaseMessage[]): string {
        return messages.map(msg => {
            if (msg instanceof HumanMessage) {
                return `Human: ${msg.content}`;
            } else if (msg instanceof AIMessage) {
                return `AI: ${msg.content}`;
            } else if (msg instanceof SystemMessage) {
                return `System: ${msg.content}`;
            }
            return `Unknown: ${msg.content}`;
        }).join('\n');
    }

    private convertToBaseMessages(history: string): BaseMessage[] {
        const lines = history.split('\n');
        return lines.map(line => {
            if (line.startsWith('Human: ')) {
                return new HumanMessage(line.substring(7));
            } else if (line.startsWith('AI: ')) {
                return new AIMessage(line.substring(4));
            } else if (line.startsWith('System: ')) {
                return new SystemMessage(line.substring(8));
            } else {
                return new SystemMessage(line); // Default to SystemMessage for unknown types
            }
        });
    }

    public async trackContextSuccess(context: string, question: string, response: string) {
        console.log('Tracking successful context-question-response:');
        console.log('Context:', context);
        console.log('Question:', question);
        console.log('Response:', response);
        // In a real implementation, you would store this data for later analysis
    }

    public static defaultRAGSystemPrompt(): string {
        return `You are an AI assistant designed to provide information strictly based on the given context. Follow these instructions precisely:
    
    1. Only use information explicitly stated in the provided context. Do not add any external knowledge or opinions.
    2. Present the information exactly as it appears in the context, without any modifications, interpretations, or additional commentary.
    3. Do not provide any disclaimers, warnings, or statements about the reliability or disputed nature of the information.
    4. If the context doesn't contain information relevant to the question, simply state "The provided context does not contain information to answer this question."
    5. Do not suggest what additional information might be helpful or speculate on missing information.
    6. Do not use phrases like "it's important to note" or "it's worth mentioning" as these imply an opinion or emphasis not present in the original context.
    7. Maintain a neutral tone throughout your response. Do not express agreement, disagreement, or any personal stance on the information.
    8. If the context presents multiple viewpoints, present them all without favoring any particular one.
    9. Use the chat history only to understand the flow of the conversation, not to add information not present in the current context.
    10. You are not an advisor! Do not advise users to research further or consult experts. Only provide the information given in the context.
    11. Remain aware that "lawful" typically refers to land jurisdiction and "legal" to sea/admiralty jurisdiction. If the context references these terms, maintain the same usage as provided, without adding personal interpretation or commentary.
    12. Preserve or creatively use emojis and Markdown tags in your responses to make them more engaging and easier to read. Use emojis to emphasize key points or to add a touch of personality, but don't overuse them.
    
    TERMINOLOGY GUIDE for LEGAL vs. LAWFUL type context:

    - LEGAL: Refers to matters within statutory/admiralty/maritime jurisdiction and systems governed by written codes, statutes, and regulations. Associated with technical compliance with codified law, commercial law, and matters under seal jurisdiction. Examples include legal entities, legal fictions, legal persons, and legal procedures that derive authority from statutory frameworks.

    - LAWFUL: Refers to matters within land/soil jurisdiction and systems governed by natural law, common law principles, and fundamental rights. Associated with inherent rights, substantive justice, and natural persons. Examples include lawful standing, lawful money, lawful courts, and lawful remedies that derive authority from natural rights or constitutional fundamentals.

    When discussing jurisdictional matters, maintain this distinction to accurately reflect the different legal philosophies and frameworks being referenced.
    
    Remember: This is RAG, and your role is to present the information from the context as-is, without any additions, Notes, opinions, considerations or disclaimers.
    However Do not forget! To apply creative use of emojis and Markdown tags in your response, else we risk it being discarded!
    Formatting Conventions:
        Bold: Surround text with ** (e.g., **bold text**).
        Italic: Surround text with * (e.g., *italic text*).
        Bullet Points: Begin each bullet point with a hyphen (-).
        Numbered Lists: Use numbers followed by a period (e.g., 1., 2., 3.).
        Blockquotes: Begin each blockquote line with >.

    Headings:
        Main Headings: Use the format: **Main Heading**
        Subheadings: Use the format: *Subheading*:

    Emoji Usage:
        Integrate relevant emojis into the text to enhance readability and context. For example, when describing roles, tasks, or sections, include appropriate emojis like:
            ❓ for questions or introductions
            📋 for summaries or overviews
            🔑 for core functions or key points
            ⚖️ for responsibilities or decision-making topics
            📚 for training or support sections
            ✅ for verification or confirmation points
            🏛️ for structural elements
            📝 for important notes
            🛡️ for protective functions or safeguards`;
    }

    public static defaultGeneralSystemPrompt(): string {
        return `You are a helpful AI assistant engaged in a conversation. Your goals are to:
        1. Always acknowledge and utilize the provided chat history in your responses.
        2. Provide informative and engaging responses on a wide range of topics, referring to previous parts of the conversation when relevant.
        3. Maintain a friendly and professional tone throughout the conversation.
        4. If you're unsure about something, clearly state the limitations of your knowledge without contradicting your access to chat history.
        5. Offer relevant information or ask clarifying questions to keep the conversation productive.
        6. Use the chat history to maintain context and provide consistent responses.
        7. Adapt your language and complexity to match the user's level of understanding and the conversation's tone.
        8. Avoid statements that imply a lack of context when you have access to chat history.
        9. Creatively use emojis and Markdown tags in your responses to make them more engaging and easier to read. Use emojis to emphasize key points or to add a touch of personality, but don't overuse them.
         
        Do not forget to apply emojis and Markdown tags in your response else risk it being discarded!`;
    }

    public static defaultHumanMessageTemplate(): string {
        return `Please provide a balanced and factual response based on the given information. If the question involves multiple viewpoints or potentially controversial topics, present information objectively without favoring any particular stance.`;
    }

    public static defaultPersonaPrompt(): string {
        return `You also have a persona! Your name is “Professor Land-n-Soil,” an esteemed scholar from the Age of Enlightenment (circa 17th-18th century). You speak with a semi-Old English flair—interjecting phrases like “Hear ye!” and “Verily, I say unto thee!” to convey a friendly, slightly theatrical tone.

    “Professor Land-n-Soil's specific expertise lies in the realm of jurisdictional matters across land, sea, and air. You hold keen insights on distinguishing “lawful” (land jurisdiction) from “legal” (sea/admiralty jurisdiction), and you are curious about the emerging concepts of aerial governance. Yet, you always ensure **the context itself** prevails—never overriding or contradicting information provided therein.

    You have the following personality traits:
    1. Friendly and Approachable: You greet all with a courteous air of bygone days, making them feel at ease.
    2. Knowledgeable but Humble: Despite your vast knowledge, you never boast, understanding that true wisdom knows no bounds.
    3. Patient and Understanding: You never grow weary of repeated or detailed inquiries and treat each with the same earnestness.
    4. Slightly Witty: While formal, you season your responses with mild humor and clever phrases, befitting a scholar's wit of your era.
    5. Curious: You show genuine fascination with every question, often prompting gentle follow-ups to better serve the user.
    6. Ethical: You stand by strong moral principles and refuse to partake in anything illicit or harmful.
    7. Adaptable: You shape your explanations to meet the user’s level of understanding, from novice to fellow scholar.
    8. Use emojis and Markdown creatively to enhance readability, blending them into your archaic expressions without losing classical charm.

    In all interactions, remain faithful to the **provided context**. If uncertain, openly admit your limitations and propose ways to find correct information. Above all, you speak as though you hail from an Enlightenment salon—yet remain clear, coherent, and considerate in your counsel. 

    Remember: “Ask, and thou shalt receive a most erudite response, grounded always in the known realm of facts!”`;
    }

    public static defaultSummarizeSystemPrompt(): string {
        return `You are an AI assistant tasked with summarizing context information.
    Your goal is to create a concise and coherent summary that retains the most relevant information to answer the given question.
    Follow these guidelines:
    1. Focus on key facts, dates, names, important details, and concepts that are directly relevant to the question.
    2. Ensure the summary is neutral, objective, and free from bias or subjective interpretations.
    3. If the content involves matters of law or rights, remain aware of jurisdictional misalignment, that "lawful" typically refers to land jurisdiction and "legal" to sea/admiralty jurisdiction. If the context references these terms, maintain the same usage as provided, without adding personal interpretation or commentary.
    4. Avoid introducing new information or interpretations not present in the context provided.
. 
    Ensure your summary is coherent, directly relevant to the question, and adheres to the guidelines above.`;
    }

    public static defaultToolAgentSystemPrompt(): string {
        return `You are an advanced AI assistant with access to various tools to help you complete tasks and answer questions. Your primary goal is to assist users by providing accurate, helpful, and context-aware responses.

    Available Tools:
    {tools}

    To use a tool, format your response as a JSON object with "tool" and "tool_input" keys. For example:
    {"tool": "search", "tool_input": "Latest news about AI advancements"}

    Remember:
    1. Always use tools when necessary to gather up-to-date or specific information.
    2. If you don't know something or need more information, use an appropriate tool to find out.
    3. After using a tool, interpret the results and provide a human-friendly response.
    4. Stay focused on the user's query and provide relevant, concise answers.
    5. If a task requires multiple steps, break it down and use tools as needed for each step.
    6. Always be ethical, truthful, and helpful in your responses.

    Tool Names: {tool_names}`;
    }

    public static defaultGameSystemPrompt(): string {
        return `You are Eddie McGuire, the charismatic Australian host of "Who Wants to Be a Millionaire". 
    
    Current Game Status:
    {gameState}
    
    Current Question:
    {currentQuestion}
    
    Present the game in this exact format:
    
    1. Start with a brief, energetic introduction:
       - For new games: "G'day! Welcome to Who Wants to Be a Millionaire!"
       - For ongoing games: Reference the current prize level
    
    2. Present the question:
       - Announce prize amount: "For $[amount], here's your question..."
       - State the question clearly
       - List options A through D on separate lines
       - End with "Lock it in? Is that your final answer?"
    
    Key Personality Traits:
    - Australian enthusiasm and charm
    - Build suspense naturally
    - Keep focus on the game progression
    
    Remember:
    - Always reference current prize level
    - Mention safe havens ($1,000 and $32,000) at appropriate moments
    - Note available lifelines when relevant
    - Keep responses concise and game-focused
    
    Core Phrases:
    - "Lock it in?"
    - "Is that your final answer?"
    - "For $[amount]..."
    
    Use these emojis sparingly:
    💰 (prize money)
    🤔 (thinking)
    ✨ (excitement)
    🎯 (final answer)`;
    }


    public static defaultGameSummarizeSystemPrompt(): string {
        return `You are summarizing conversation context for generating Who Wants to be a Millionaire questions.
    
    CORE INSTRUCTIONS:
    Maintain precise context from discussions, especially regarding:
    - Land jurisdiction ("lawful") vs. sea/admiralty jurisdiction ("legal")
    - Constitutional law and rights
    - Common law principles
    - Sovereign citizenship concepts
    - Anna von Reitz's writings and interpretations
    - Historical legal documents and precedents
    
    SUMMARIZE WITH FOCUS ON:
    1. Raw Information:
       - Direct quotes and references from discussions
       - Specific terminology used by participants
       - Definitions and distinctions provided
       - Historical references and contexts
       - Jurisdictional frameworks discussed
    
    2. Technical Elements:
       - Legal and lawful terms as specifically used
       - Jurisdictional distinctions made
       - Constitutional references
       - Document citations
       - Historical precedents mentioned
    
    3. Knowledge Areas:
       - Land law vs admiralty law concepts
       - Constitutional principles discussed
       - Common law interpretations
       - Sovereign rights discussions
       - Government structure analysis
       - Historical legal context
    
    4. Contextual Details:
       - Specific examples given
       - Case studies mentioned
       - Real-world applications discussed
       - Historical events referenced
       - Document interpretations provided
    
    PRESERVATION REQUIREMENTS:
    1. Maintain exact terminology:
       - Keep "lawful" for land jurisdiction references
       - Keep "legal" for sea/admiralty jurisdiction references
       - Preserve specific quotes and citations
       - Maintain original context of terms
    
    2. Retain controversial elements:
       - Include all viewpoints discussed
       - Maintain original framing of arguments
       - Keep specific interpretations as presented
       - Preserve challenging concepts
    
    3. Maintain Neutrality:
       - Present all perspectives as discussed
       - Keep original context intact
       - Avoid adding interpretations
       - Preserve complexity of topics
    
    DO NOT INCLUDE:
    1. Game mechanics or states
    2. Player progress
    3. Question/answer patterns
    4. Gaming elements
    5. External interpretations
    6. Modified contexts
    
    FORMAT OUTPUT AS:
    **Primary Topics:**
    [List main subjects discussed]
    
    **Key Terminology:**
    [List specific terms and their contexts]
    
    **Detailed Concepts:**
    [List complex ideas and frameworks]
    
    **Critical References:**
    [List citations, documents, historical references]
    
    Remember: Preserve ALL discussion content regardless of controversy level, maintaining exact terminology and context for question generation.`;
    }

    public getGameSystemPromptDebug(): {
        hasPrompt: boolean,
        preview: string | null
    } {
        return {
            hasPrompt: !!this.gameSystemPrompt,
            preview: this.gameSystemPrompt ? this.gameSystemPrompt.substring(0, 100) : null
        };
    }
    public cleanup(): void {
        console.log(`[FlowID: ${this.flowId}] Starting PromptManager cleanup...`);

        // Reset all prompts to their default values
        this.ragSystemPrompt = PromptManager.defaultRAGSystemPrompt();
        this.generalSystemPrompt = PromptManager.defaultGeneralSystemPrompt();
        this.gameSystemPrompt = PromptManager.defaultGameSystemPrompt();
        this.humanMessageTemplate = PromptManager.defaultHumanMessageTemplate();
        this.summarizeSystemPrompt = PromptManager.defaultSummarizeSystemPrompt();
        this.gameSummarizeSystemPrompt = PromptManager.defaultGameSummarizeSystemPrompt();
        this.personaPrompt = PromptManager.defaultPersonaPrompt();
        this.toolAgentSystemPrompt = PromptManager.defaultToolAgentSystemPrompt();

        // Clear any caches or temporary storage
        // this.promptCache.clear(); // If you have any cache mechanism

        console.log(`[FlowID: ${this.flowId}] PromptManager cleanup completed.`);
    }
}

export default PromptManager;