// agents/PatternPromptAgent.ts
import { BaseAgent } from './BaseAgent';
import { Context, Telegraf, Markup } from 'telegraf';
import { EnhancedResponse, InteractionType, PatternAnalysis } from '../commands/types';
import { ContextAdapter } from '../ContextAdapter';
import { ConversationManager } from '../ConversationManager';
import { PromptManager } from '../PromptManager';
import { ToolManager } from '../ToolManager';
import { BaseMessage, HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ThinkingManager } from '../ThinkingManager';
import { invokeModelWithFallback } from '../utils/modelUtility';


interface PatternSuggestion {
    pattern: string;
    category: string;
    alternativePatterns?: string[];
    confidence: number;
}
interface Pattern {
    name: string;
    systemPrompt: string;
    userPrompt?: string;
    category: string;
    description: string;
}


interface PatternReasoningResult {
    pattern: string;
    confidence: number;
    reasoning: string;
    alternativePatterns?: string[];
}

interface ExtendedPattern extends Pattern {
    keywords?: string[];
    examples?: string[];
    relatedPatterns?: string[];
}

type PatternCategory = 'analysis' | 'creation' | 'extraction' | 'summarization' | 'explanation' | 'general';


// agents/PatternPromptAgent.ts

export class PatternPromptAgent extends BaseAgent {
    private patterns: Map<string, Pattern>;
    private readonly patternsPath: string;
    private patternCategories: Set<string>;
    private readonly flowId: string;
    private thinkingManager: ThinkingManager | null = null;



    constructor(
        flowId: string,
        conversationManager: ConversationManager | null,
        toolManager: ToolManager,
        promptManager: PromptManager
    ) {
        super(conversationManager, toolManager, promptManager);
        this.flowId = flowId;
        this.patterns = new Map();
        this.patternCategories = new Set();
        // Assuming assets folder is two levels up from the agent
        this.patternsPath = path.join(__dirname, '../../TelegramBot/assets/patterns');
        this.loadPatterns();
        this.thinkingManager = new ThinkingManager(this.flowId); // Initialize ThinkingManager
        this.suggestPattern = this.suggestPattern.bind(this);

    }
    public setConversationManager(manager: ConversationManager): void {
        this.conversationManager = manager;
        console.log(`[PatternPromptAgent:${this.flowId}] ConversationManager set successfully`);
    }
    public getAgentName(): string {
        return "PatternPromptAgent";
    }
    public async processWithPattern(
        patternName: string,
        input: string,
        adapter: ContextAdapter
    ): Promise<string> {
        if (!this.conversationManager) {
            throw new Error('ConversationManager not initialized');
        }

        const pattern = this.patterns.get(patternName);
        if (!pattern) {
            throw new Error(`Pattern "${patternName}" not found`);
        }

        const messages = [
            new SystemMessage(pattern.systemPrompt)
        ];

        if (pattern.userPrompt) {
            messages.push(new HumanMessage(pattern.userPrompt));
        }

        messages.push(new HumanMessage(input));

        try {
            const response: AIMessage = await invokeModelWithFallback(
                this.conversationManager.SpModel,
                this.conversationManager.chatModel,
                this.conversationManager.summationModel,
                messages,
                { initialTimeout: 60000, maxTimeout: 120000, retries: 2 }
            );
    
            const contentWithoutThinkTags = this.thinkingManager!.cleanThinkTags(response.content) as string;

            // Then clean HTML to make it Telegram-compatible
            return this.cleanHTMLForTelegram(contentWithoutThinkTags);
        } catch (error) {
            console.error('Error processing pattern:', error);
            throw error;
        }
    }

    /**
     * Converts HTML to a format Telegram can understand (for safe display)
     */
    private cleanHTMLForTelegram(html: string): string {
        if (typeof html !== 'string') {
            return String(html);
        }

        // Replace paragraph tags with newlines
        let result = html.replace(/<\/?p>/g, '\n');

        // Replace lists with simple formatting
        result = result.replace(/<ul>([\s\S]*?)<\/ul>/g, (match, content) => {
            return content.replace(/<li>([\s\S]*?)<\/li>/g, '• $1\n');
        });

        result = result.replace(/<ol>([\s\S]*?)<\/ol>/g, (match, content) => {
            let index = 1;
            return content.replace(/<li>([\s\S]*?)<\/li>/g, () => {
                return `${index++}. $1\n`;
            });
        });

        // Preserve basic formatting that Telegram supports
        // Telegram supports <b>, <i>, <u>, <s>, <a>, <code>, <pre>

        // Remove any other HTML tags
        result = result.replace(/<(?!\/?(b|i|u|s|a|code|pre))[^>]*>/g, '');

        // Clean up excessive newlines
        result = result.replace(/\n{3,}/g, '\n\n');

        return result.trim();
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
        if (!this.conversationManager) {
            throw new Error('ConversationManager not initialized');
        }

        // First get a pattern suggestion
        const suggestion = await this.suggestPattern(input, context, interactionType);
        if (!suggestion) {
            throw new Error('Could not determine appropriate pattern');
        }

        const pattern = this.patterns.get(suggestion.pattern);
        if (!pattern) {
            throw new Error(`Pattern "${suggestion.pattern}" not found`);
        }

        const messages: BaseMessage[] = [
            new SystemMessage(pattern.systemPrompt)
        ];

        if (pattern.userPrompt) {
            messages.push(new HumanMessage(pattern.userPrompt));
        }

        messages.push(new HumanMessage(input));

        const response: AIMessage = await invokeModelWithFallback(
            this.conversationManager.SpModel,
            this.conversationManager.chatModel,
            this.conversationManager.summationModel,
            messages,
            { initialTimeout: 60000, maxTimeout: 120000, retries: 2 }
        );

        const content = this.thinkingManager!.cleanThinkTags(response.content) as string;


        return {
            response: [content],
            sourceCitations: undefined,
            followUpQuestions: undefined,
            externalAgentSuggestion: null,
            gameMetadata: {
                gameState: null,
                keyboard: null
            }
        };
    }


    private async loadPatterns(): Promise<void> {
        try {
            const patternDirs = await fs.readdir(this.patternsPath);

            for (const dir of patternDirs) {
                // Skip non-directory files
                if (dir === 'pattern_explanations.md' || dir === 'raycast') continue;

                const patternPath = path.join(this.patternsPath, dir);
                const stat = await fs.stat(patternPath);

                if (!stat.isDirectory()) continue;

                try {
                    // Read system.md
                    const systemPath = path.join(patternPath, 'system.md');
                    const systemContent = await fs.readFile(systemPath, 'utf-8');

                    // Try to read user.md if it exists
                    let userContent: string | undefined;
                    try {
                        const userPath = path.join(patternPath, 'user.md');
                        userContent = await fs.readFile(userPath, 'utf-8');
                    } catch (e) {
                        // user.md is optional
                    }

                    // Determine category based on pattern name
                    let category = 'general';
                    if (dir.startsWith('analyze_')) category = 'analysis';
                    else if (dir.startsWith('create_')) category = 'creation';
                    else if (dir.startsWith('extract_')) category = 'extraction';
                    else if (dir.startsWith('summarize_')) category = 'summarization';
                    else if (dir.startsWith('explain_')) category = 'explanation';

                    this.patternCategories.add(category);

                    // Extract description from system prompt (first line or section)
                    const description = this.extractDescription(systemContent);

                    this.patterns.set(dir, {
                        name: dir,
                        systemPrompt: systemContent,
                        userPrompt: userContent,
                        category,
                        description
                    });

                } catch (error) {
                    console.warn(`Error loading pattern ${dir}:`, error);
                }
            }

            console.log(`Loaded ${this.patterns.size} patterns in ${this.patternCategories.size} categories`);

        } catch (error) {
            console.error('Error loading patterns:', error);
            throw error;
        }
    }

    private extractDescription(systemContent: string): string {
        // Try to extract description from the first line or section
        const lines = systemContent.split('\n');
        let description = lines[0].replace(/^#\s*/, '').trim();

        // If first line is too long or seems like a header, look for a description section
        if (description.length > 100 || description.match(/^[A-Z\s]+$/)) {
            const descMatch = systemContent.match(/(?:description|purpose|about):\s*([^\n]+)/i);
            if (descMatch) {
                description = descMatch[1].trim();
            }
        }

        return description;
    }

    // In PatternPromptAgent.ts

    public suggestPattern = async (
        input: string,
        context: string,
        interactionType: InteractionType
    ): Promise<{
        pattern: string;
        description: string;
        confidence: number;
        reasoning: string;
        category: string;
        alternativePatterns?: string[];
        keyboard?: any;
        result?: string; // Add this to hold the processed result
    } | null> => {
        // First check for explicit pattern requests in the input
        const explicitPattern = this.detectExplicitPatternRequest(input);
        if (explicitPattern) {
            console.log(`[suggestPattern] Detected explicit pattern request: ${explicitPattern}`);
            const pattern = this.patterns.get(explicitPattern);

            // If the explicitly requested pattern exists, process it immediately
            if (pattern) {
                try {
                    if (!this.conversationManager) {
                        throw new Error('ConversationManager not initialized');
                    }
                    console.log(`[suggestPattern] Immediately processing with pattern: ${explicitPattern}`);

                    // Create messages for the model
                    const messages = [
                        new SystemMessage(pattern.systemPrompt)
                    ];

                    if (pattern.userPrompt) {
                        messages.push(new HumanMessage(pattern.userPrompt));
                    }

                    // Extract any content after the pattern request
                    const contentAfterPattern = this.extractContentAfterPattern(input, explicitPattern);
                    messages.push(new HumanMessage(contentAfterPattern || input));

                    // Process with SP model
                    const response: AIMessage = await invokeModelWithFallback(
                        this.conversationManager.SpModel,
                        this.conversationManager.chatModel,
                        this.conversationManager.summationModel,
                        messages,
                        { initialTimeout: 60000, maxTimeout: 120000, retries: 2 }
                    );
            
                    const result = this.thinkingManager!.cleanThinkTags(response.content) as string;

                    return {
                        pattern: explicitPattern,
                        description: pattern.description,
                        confidence: 0.98, // Very high confidence for direct execution
                        reasoning: `This pattern was explicitly requested by the user and has been processed immediately.`,
                        category: pattern.category,
                        alternativePatterns: [],
                        keyboard: null, // No keyboard needed since we've already processed
                        result: result, // Include the processed result

                    };
                } catch (error) {
                    console.error(`[suggestPattern] Error processing explicit pattern:`, error);
                    // If there's an error, fall back to the regular flow
                }
            }
        }

        // If no explicit pattern request, requested pattern not found, or error in processing,
        // proceed with normal analysis
        const analysis = await this.analyzeInput(input);
        const suggestion = await this.reasonAboutPattern(input, analysis, interactionType, explicitPattern);

        if (!suggestion) return null;

        const pattern = this.patterns.get(suggestion.pattern);
        if (!pattern) {
            console.warn(`Suggested pattern ${suggestion.pattern} not found`);
            return null;
        }

        return {
            pattern: suggestion.pattern,
            description: pattern.description,
            confidence: suggestion.confidence,
            reasoning: suggestion.reasoning,
            category: pattern.category,
            alternativePatterns: suggestion.alternativePatterns,
            keyboard: this.createPatternKeyboard({
                pattern: suggestion.pattern,
                category: pattern.category,
                alternativePatterns: suggestion.alternativePatterns,
                confidence: suggestion.confidence
            })
        };
    }

    // Helper method to extract content after a pattern request
    private extractContentAfterPattern(input: string, patternName: string): string | null {
        // Convert pattern name underscores to spaces for matching
        const patternNameSpaced = patternName.replace(/_/g, ' ');

        // Try different regex patterns to extract content
        const patterns = [
            // For direct pattern name commands like "extract_wisdom: content"
            new RegExp(`${patternName}\\s*[:;-]\\s*(.+)`, 's'),

            // For spaced pattern name commands like "extract wisdom: content"
            new RegExp(`${patternNameSpaced}\\s*[:;-]\\s*(.+)`, 's'),

            // For "please summarize this" type patterns
            new RegExp(`(please|can you)\\s+${patternNameSpaced}\\s+(?:this|the following|these)\\s*[:;.-]?\\s*(.+)`, 's'),

            // For "I need a summary of" type patterns
            new RegExp(`I\\s+need\\s+a\\s+${patternNameSpaced}\\s+of\\s*[:;.-]?\\s*(.+)`, 's')
        ];

        for (const regex of patterns) {
            const match = input.match(regex);
            if (match && match[1]) {
                return match[1].trim();
            }
        }

        // If we can't clearly extract the content, return null to use the full input
        return null;
    }

    // Add this new method to detect explicit pattern requests
    private detectExplicitPatternRequest(input: string): string | null {
        // Normalize input for pattern matching
        const normalizedInput = input.toLowerCase().trim();

        // Direct pattern name detection with more flexible matching
        const patternNames = Array.from(this.patterns.keys());
        for (const patternName of patternNames) {
            // Check for direct mentions of the pattern name
            if (normalizedInput.includes(`use ${patternName}`) ||
                normalizedInput.includes(`using ${patternName}`) ||
                normalizedInput.includes(`with ${patternName}`)) {
                return patternName;
            }

            // Check for pattern name at the start
            if (normalizedInput.startsWith(patternName)) {
                return patternName;
            }

            // Look for pattern name as a command
            if (normalizedInput.match(new RegExp(`^${patternName}\\s+this`, 'i'))) {
                return patternName;
            }
        }

        // More flexible pattern mappings - don't require exact phrasing at the start
        const patternMappings = [
            // Summarization patterns
            { phrases: ['summarize', 'summary', 'summarization', 'tldr', 'summary of'], pattern: 'summarize' },

            // Extraction patterns
            { phrases: ['extract wisdom', 'extract insights', 'extract key points', 'wisdom from'], pattern: 'extract_wisdom' },
            { phrases: ['extract main idea', 'core message', 'main point'], pattern: 'extract_main_idea' },
            { phrases: ['extract recommendations', 'recommendations from', 'what should i do'], pattern: 'extract_recommendations' },

            // Analysis patterns
            { phrases: ['analyze paper', 'paper analysis', 'analyze this paper', 'analyze article'], pattern: 'analyze_paper' },
            { phrases: ['analyze code', 'code analysis', 'review code'], pattern: 'explain_code' },

            // Writing patterns
            { phrases: ['improve writing', 'enhance writing', 'edit text', 'make this better'], pattern: 'improve_writing' },
            { phrases: ['write essay', 'create essay', 'essay about'], pattern: 'write_essay' },
            { phrases: ['write latex', 'latex format', 'in latex'], pattern: 'write_latex' },

            // Explanation patterns
            { phrases: ['explain code', 'code explanation', 'how does this code work'], pattern: 'explain_code' },
            { phrases: ['explain math', 'math explanation', 'explain this formula'], pattern: 'explain_math' },
        ];

        // Check for phrases anywhere in the first 100 characters (not just at the beginning)
        const inputStart = normalizedInput.substring(0, 100);
        for (const mapping of patternMappings) {
            for (const phrase of mapping.phrases) {
                if (inputStart.includes(phrase)) {
                    return mapping.pattern;
                }
            }
        }

        // Check for intent-based expressions
        const intentPhrases = [
            // Request-based intents with broader matching
            { regex: /can you .{0,20}(summarize|summary)/i, pattern: 'summarize' },
            { regex: /please .{0,20}(summarize|summary)/i, pattern: 'summarize' },
            { regex: /i need .{0,20}(a summary|summarize)/i, pattern: 'summarize' },
            { regex: /could you .{0,20}(summarize|summary)/i, pattern: 'summarize' },

            // Extract intents
            { regex: /(extract|pull out|identify) .{0,20}(wisdom|insights|key points)/i, pattern: 'extract_wisdom' },
            { regex: /(extract|pull out|identify) .{0,20}(main idea|main point|core message)/i, pattern: 'extract_main_idea' },

            // Analysis intents
            { regex: /(analyze|review|assess) .{0,20}(paper|article|document)/i, pattern: 'analyze_paper' },
            { regex: /(analyze|review|check) .{0,20}(code|program|script)/i, pattern: 'explain_code' },

            // Writing intents
            { regex: /(improve|enhance|fix|edit) .{0,20}(writing|text|document)/i, pattern: 'improve_writing' },
            { regex: /(write|create) .{0,20}(essay|paper|article)/i, pattern: 'write_essay' },

            // Explanation intents
            { regex: /(explain|describe|clarify) .{0,20}(code|program|script)/i, pattern: 'explain_code' },
            { regex: /(explain|describe|clarify) .{0,20}(math|formula|equation)/i, pattern: 'explain_math' },
        ];

        for (const intent of intentPhrases) {
            if (intent.regex.test(inputStart)) {
                return intent.pattern;
            }
        }

        return null;
    }
    private async reasonAboutPattern(
        input: string,
        analysis: any,
        interactionType: InteractionType,
        explicitPattern: string | null = null
    ): Promise<{
        pattern: string;
        confidence: number;
        reasoning: string;
        alternativePatterns?: string[];
    } | null> {
        // If explicit pattern is provided, short-circuit the reasoning process
        if (explicitPattern && this.patterns.has(explicitPattern)) {
            const pattern = this.patterns.get(explicitPattern)!;
            return {
                pattern: explicitPattern,
                confidence: 0.95,
                reasoning: `The user explicitly requested the "${explicitPattern}" pattern, which is designed for ${pattern.category} tasks. This pattern was directly selected based on user intent without additional analysis.`,
                alternativePatterns: []
            };
        }

        // Otherwise proceed with the normal reasoning process
        const systemPrompt = `You are an expert system for selecting the most effective processing pattern for content analysis and transformation.
    
    Your task is to thoroughly analyze the provided input along with its detailed characteristics and then determine which pattern is most suitable. Use your advanced reasoning ability to compare at least two alternative patterns, discuss their trade-offs, and explain why the selected pattern is the most useful for the given input. 
    
    Consider the following factors:
    - Input content type, format, and complexity
    - User intent and needs
    - Has the user explicitly requested a specific pattern? If so, check if we can accommodate their request
    - Interaction type (${interactionType})
    - Any special requirements (e.g., extraction, summarization, explanation, creation)
    - The typical use cases of different pattern categories
    
    Available pattern categories are:
    ${Array.from(this.patternCategories).map(cat => `- ${cat}`).join('\n')}
    
    Respond in JSON format with the following structure:
    {
        "pattern": "selected_pattern_name",
        "confidence": number between 0 and 1,
        "reasoning": "A concise explanation comparing alternative patterns and discussing trade-offs, leading to why the chosen pattern is best suited",
        "alternativePatterns": ["pattern1", "pattern2"]
    }
    
    Be as specific as possible, detailing how the input characteristics match the chosen pattern and why it provides the best solution.`;

        // Rest of the method remains the same...
        const patternsInfo = Array.from(this.patterns.entries()).map(([name, pattern]) => ({
            name,
            category: pattern.category,
            description: pattern.description
        }));

        // Create the human message with analysis and patterns
        const characteristics = (analysis && (analysis.characteristics || analysis)) || {};
        const humanMessage = JSON.stringify({
            input: {
                content: input.substring(0, 500), // Preview of input
                length: input.length,
                type: characteristics.contentType || characteristics.content_type,
                format: characteristics.format || (characteristics.format_and_structure ? characteristics.format_and_structure.description : undefined)
            },
            analysis: characteristics,
            interactionType,
            availablePatterns: patternsInfo
        }, null, 2);

        try {
            if (!this.conversationManager) {
                throw new Error('ConversationManager not initialized');
            }
            const messages = [
                new SystemMessage(systemPrompt),
                new HumanMessage(humanMessage)
            ];
            // Use SP model for reasoning
            const response: AIMessage = await invokeModelWithFallback(
                this.conversationManager.SpModel,
                this.conversationManager.chatModel,
                this.conversationManager.summationModel,
                messages,
                { initialTimeout: 60000, maxTimeout: 120000, retries: 2 }
            );
    
            const cleanedResponse = this.thinkingManager!.cleanThinkTags(response.content) as string;
            const jsonMatch = cleanedResponse.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                throw new Error("JSON not found in response");
            }
            const result = JSON.parse(jsonMatch[0]);

            // Validate the suggested pattern exists
            if (!this.patterns.has(result.pattern)) {
                console.warn(`SP model suggested non-existent pattern: ${result.pattern}`);

                // Try to find a similar pattern
                const similarPattern = this.findSimilarPattern(result.pattern);
                if (similarPattern) {
                    result.pattern = similarPattern;
                    result.confidence *= 0.8; // Reduce confidence for fallback
                } else {
                    return null;
                }
            }

            // Validate alternative patterns
            if (result.alternativePatterns) {
                result.alternativePatterns = result.alternativePatterns
                    .filter((p: string) => this.patterns.has(p))
                    .slice(0, 3); // Limit to top 3 alternatives
            }

            return {
                pattern: result.pattern,
                confidence: result.confidence,
                reasoning: result.reasoning,
                alternativePatterns: result.alternativePatterns
            };

        } catch (error) {
            console.error('Error in pattern reasoning:', error);
            return null;
        }
    }

    private findSimilarPattern(suggestedPattern: string): string | null {
        // Get the suggested pattern's prefix (e.g., "analyze_", "create_", etc.)
        const prefix = suggestedPattern.split('_')[0];

        // Find patterns with the same prefix
        const similarPatterns = Array.from(this.patterns.keys())
            .filter(name => name.startsWith(`${prefix}_`));

        if (similarPatterns.length > 0) {
            // Return the first similar pattern found
            return similarPatterns[0];
        }

        return null;
    }

    private async analyzeInput(input: string): Promise<{
        characteristics: {
            contentType: string;
            length: number;
            complexity: number;
            hasCode: boolean;
            hasUrls: boolean;
            hasTechnicalTerms: boolean;
            isQuestion: boolean;
            topicCategory: string;
            format: string;
            intent: string;
            hasFile?: boolean;
            fileType?: string;
            specialFeatures?: string[];
        }
    }> {
        const systemPrompt = `Analyze the provided input and determine its characteristics. 
    Consider:
    - Content type (text, code, documentation, question, etc.)
    - Complexity (1-10 scale)
    - Format and structure
    - Special features or requirements
    - Apparent user intent
    - Topic category
    - Technical depth
    - Presence of special elements (code, URLs, technical terms)
    
    Provide analysis in JSON format with detailed reasoning for each characteristic.`;

        try {
            if (!this.conversationManager) {
                throw new Error('ConversationManager not initialized');
            }
            const messages = [
                new SystemMessage(systemPrompt),
                new HumanMessage(input)
            ];

            const response: AIMessage = await invokeModelWithFallback(
                this.conversationManager.SpModel,
                this.conversationManager.chatModel,
                this.conversationManager.summationModel,
                messages,
                { initialTimeout: 60000, maxTimeout: 120000, retries: 2 }
            );
    
            return JSON.parse(this.thinkingManager!.cleanThinkTags(response.content) as string);

        } catch (error) {
            console.error('Error analyzing input:', error);
            // Return basic analysis if advanced fails
            return {
                characteristics: {
                    contentType: 'text',
                    length: input.length,
                    complexity: 5,
                    hasCode: input.includes('```') || /[{};()]/.test(input),
                    hasUrls: /https?:\/\/[^\s]+/.test(input),
                    hasTechnicalTerms: false,
                    isQuestion: input.includes('?'),
                    topicCategory: 'general',
                    format: 'plain',
                    intent: 'unknown'
                }
            };
        }
    }

    private createPatternKeyboard(suggestion: PatternSuggestion): any {

        const buttons = [];
        // Main suggestion with category
        buttons.push([
            Markup.button.callback(
                `Use ${suggestion.pattern} (${suggestion.category})`,
                `pattern_use:${suggestion.pattern}`
            )
        ]);

        // Similar patterns in same category
        const similarPatterns = Array.from(this.patterns.entries())
            .filter(([name, pattern]) =>
                pattern.category === suggestion.category &&
                name !== suggestion.pattern
            )
            .slice(0, 2);

        if (similarPatterns.length > 0) {
            buttons.push(
                similarPatterns.map(([name]) =>
                    Markup.button.callback(`Try ${name}`, `pattern_use:${name}`)
                )
            );
        }

        // Category selection
        buttons.push([
            Markup.button.callback('Show More Patterns', `pattern_category:${suggestion.category}`),
            Markup.button.callback('Process Normally', 'pattern_skip')
        ]);

        return Markup.inlineKeyboard(buttons);
    }
    // Add a pattern in PatternPromptAgent.ts
    public async processForPDF(
        patternName: string,
        input: string,
        adapter: ContextAdapter
    ): Promise<string> {
        // Create a specific system prompt for PDF-formatted content that preserves original message
        const systemPrompt = `You are an expert document content analyst tasked with providing excellent structural formatting of any writing or body of text to PDF.
        
    IMPORTANT: Do NOT change the meaning, message, intent, or wording of the original content. Your task is ONLY to improve the structural formatting while preserving the exact language of the source material.
    
    Take a deep breath and think step by step about how to best accomplish this goal using the following steps. 

    First, identify what type of content this is (transcript, article, notes, etc.) and then apply appropriate formatting:
    
    Guidelines:
    - Preserve ALL original wording, terminology, and meaning
    - Add organizational structure without changing content
    - Structure the content logically into clear sections where appropriate
    - Use # for main headings and ## for subheadings when needed for organization
    - For content that represents lists, format with bullet points (- or •) or numbered lists (1., 2., etc.)
    - Enclose direct quotes in "quotation marks"
    - Ensure proper spacing between paragraphs and sections
    - If needed, add simple informative headings that reflect the existing content (like "Introduction" or "Key Points")
    - DO NOT add your own analysis, summaries, or change the language style
    
    Example of acceptable changes:
    Original: "the main points were first that AI is changing rapidly second we need new regulations and third more research is needed"
    
    Formatted: 
    ## Main Points
    1. AI is changing rapidly
    2. We need new regulations
    3. More research is needed
    
    Remember: Your role is strictly to improve readability through formatting, NOT to rewrite or modify the substance of the content.`;
    
        // Get the response from LLM
        const messages = [
            new SystemMessage(systemPrompt),
            new HumanMessage(input)
        ];
    
        try {
            if (!this.conversationManager) {
                throw new Error('ConversationManager not initialized');
            }
            console.log(`[processForPDF] Processing content of length ${input.length} for pattern: ${patternName}`);
            const response: AIMessage = await invokeModelWithFallback(
                this.conversationManager.SpModel,
                this.conversationManager.chatModel,
                this.conversationManager.summationModel,
                messages,
                { initialTimeout: 60000, maxTimeout: 120000, retries: 2 }
            );
    
            const contentWithoutThinkTags = this.thinkingManager!.cleanThinkTags(response.content) as string;
            
            console.log(`[processForPDF] Successfully formatted content for PDF, output length: ${contentWithoutThinkTags.length}`);
            return contentWithoutThinkTags;
        } catch (error) {
            console.error(`[processForPDF] Error formatting content for PDF:`, error);
            // In case of error, return the original content with minimal formatting
            console.log(`[processForPDF] Falling back to original content with minimal formatting`);
            return this.applyMinimalFormatting(input);
        }
    }
    
    // Fallback method to apply minimal formatting if the LLM call fails
    private applyMinimalFormatting(input: string): string {
        // Add a basic title if none exists
        let formatted = input;
        
        // Check if the content already has headings
        if (!formatted.includes('# ')) {
            formatted = `# Document\n\n${formatted}`;
        }
        
        // Ensure proper spacing between paragraphs
        formatted = formatted.replace(/\n{3,}/g, '\n\n');
        
        return formatted;
    }

    public getPatternsByCategory(category: string): Pattern[] {
        return Array.from(this.patterns.entries())
            .filter(([_, pattern]) => pattern.category === category)
            .map(([_, pattern]) => pattern);
    }

    public getCategories(): string[] {
        return Array.from(this.patternCategories);
    }

    // Gets a specific pattern's prompts
    public getPattern(name: string): Pattern | undefined {
        return this.patterns.get(name);
    }

    private cleanThinkTags(content: any): string {
        if (typeof content !== 'string') {
            content = content.toString();
        }
        let cleaned = content.replace(/<think>[\s\S]*?<\/think>/g, '');
        cleaned = cleaned.replace(/```(?:json)?/gi, '');
        return cleaned.trim();
    }

    public async cleanup(): Promise<void> {
        // No cleanup necessary for PatternPromptAgent
    }


}