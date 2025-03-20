// MenuManager.ts
import { Markup, Context } from 'telegraf';
import { InlineKeyboardMarkup, ReplyKeyboardMarkup, InlineKeyboardButton } from 'telegraf/typings/core/types/typegram';
import { Command, BotInfo } from './commands/types';
import { TelegramBot_Agents } from './TelegramBot_Agents';
import { ContextAdapter, } from './ContextAdapter';

export class MenuManager {
    constructor(private telegramBot: TelegramBot_Agents | null, flowId: string) {
        this.botInfo = telegramBot ? telegramBot.getAllBotInfo() : [];
        this.flowId = flowId;
    }
    private menuTimeouts: Map<number, NodeJS.Timeout> = new Map();
    private botInfo: BotInfo[]
    private flowId: string;



    createBotCommandMenu(botId: number, commands?: Command[], page: number = 0): Markup.Markup<InlineKeyboardMarkup> {
        console.log(`Creating command menu for bot ID: ${botId} of FlowID: ${this.flowId} with commands:`, commands);

        // Ensure commands is always an array
        const safeCommands = commands || [];

        // Early return if no commands
        if (safeCommands.length === 0) {
            return Markup.inlineKeyboard([[
                Markup.button.callback('🗑️ Remove Menu', 'remove_menu')
            ]]);
        }

        const chunkedCommands = this.chunkArray(safeCommands, 10);
        let Page = 0;

        const createKeyboard = (page: number) => {
            const startIndex = page * 10;
            const pageCommands = chunkedCommands[page] || [];  // Add fallback empty array
            const commandButtons = [];

            for (let i = 0; i < pageCommands.length; i += 2) {
                const row = [];
                if (pageCommands[i]) {
                    row.push(Markup.button.callback(`/${pageCommands[i].name}`, `execute_command:${botId}:${pageCommands[i].name}`));
                }
                if (pageCommands[i + 1]) {
                    row.push(Markup.button.callback(`/${pageCommands[i + 1].name}`, `execute_command:${botId}:${pageCommands[i + 1].name}`));
                }
                if (row.length > 0) {  // Only push if row has buttons
                    commandButtons.push(row);
                }
            }

            const navigationButtons = [];
            if (page > 0) {
                navigationButtons.push(Markup.button.callback('◀️ Previous', `change_page:${botId}:${page - 1}`));
            }
            if (page < chunkedCommands.length - 1) {
                navigationButtons.push(Markup.button.callback('Next ▶️', `change_page:${botId}:${page + 1}`));
            }

            if (navigationButtons.length > 0) {
                commandButtons.push(navigationButtons);
            }

            // Add remove menu button
            commandButtons.push([Markup.button.callback('🗑️ Remove Menu', 'remove_menu')]);

            return Markup.inlineKeyboard(commandButtons);
        };

        return createKeyboard(page);
    }

    private chunkArray<T>(array: T[], size: number): T[][] {
        if (!Array.isArray(array)) {
            console.warn('Invalid array provided to chunkArray:', array);
            return [[]];
        }
        const chunked = [];
        for (let i = 0; i < array.length; i += size) {
            chunked.push(array.slice(i, i + size));
        }
        return chunked.length > 0 ? chunked : [[]];
    }

    public setMenuTimeout(adapter: ContextAdapter, messageId: number, timeout: number = 60000): void {
        // Clear any existing timeout for this message
        this.clearMenuTimeout(messageId);

        // Set a new timeout
        const timeoutId = setTimeout(async () => {
            try {
                await adapter.deleteMessage(messageId);
                console.log(`Menu with message ID ${messageId} auto-deleted after ${timeout}ms`);
            } catch (error) {
                console.error(`Failed to auto-delete menu with message ID ${messageId}:`, error);
            }
        }, timeout);

        this.menuTimeouts.set(messageId, timeoutId);
    }

    clearMenuTimeout(messageId: number): void {
        const existingTimeout = this.menuTimeouts.get(messageId);
        if (existingTimeout) {
            clearTimeout(existingTimeout);
            this.menuTimeouts.delete(messageId);
        }
    }

    // In MenuManager.ts

    public createStartKeyboardMenu(adapter: ContextAdapter): Markup.Markup<ReplyKeyboardMarkup> {
        if (!this.telegramBot) {
            console.warn('TelegramBot_Agents is null in MenuManager. Returning default menu.');
            return Markup.keyboard([['Help']]).resize();
        }

        const chatType = adapter.chat?.type;
        const isPrivateChat = chatType === 'private';

        // Get fresh bot info directly from telegramBot
        const allBotInfo = this.telegramBot?.getAllBotInfo() || this.botInfo || [];
        const currentBotInfo = adapter.botInfo?.id ?
            allBotInfo.find(bot => bot.id === adapter.botInfo?.id) :
            allBotInfo[0]; // Default to first bot if no specific bot found

        if (!currentBotInfo) {
            console.error('Current bot info not found');
            return Markup.keyboard([['Help']]).resize();
        }

        if (isPrivateChat) {
            // For private chats, only show options for the current bot
            return Markup.keyboard([
                ['Help', 'Show Commands']
            ]).resize();
        } else {
            // For group chats, show options for all bots
            const botButtons = allBotInfo.map((bot) => [`Start ${bot.firstName}`]);

            return Markup.keyboard([
                ...botButtons,
                ['Help', 'Show Commands']
            ]).resize();
        }
    }

    public async createStartInlineMenu(adapter: ContextAdapter): Promise<Markup.Markup<InlineKeyboardMarkup>> {
        if (!this.telegramBot) {
            console.warn('TelegramBot_Agents is null in MenuManager. Returning default menu.');
            return Markup.inlineKeyboard([[Markup.button.callback('Help', 'help_command')]]);
        }

        const context = adapter.getMessageContext();
        const chatType = adapter.chat?.type;
        const isPrivateChat = chatType === 'private';
        const userId = context.userId.toString();
        const firstName = context.raw?.from?.first_name.toString();

        try {
            // Get normalized user ID from database first
            const userRecord = await this.telegramBot.databaseService.getUserById(`tg_${userId}`);
            if (!userRecord) {
                console.error(`[MenuManager] User record not found for ID: tg_${userId}`);
                return Markup.inlineKeyboard([[Markup.button.callback('Help', 'help_command')]]);
            }

            // Use the normalized user ID from the database
            const authToken = await this.telegramBot.authService.generateTempAuthToken(userRecord.id);
            console.log(`[MenuManager] Generated auth token for user ${userRecord.id}`);

            const webappUrl = process.env.WEBAPP_URL ?
                `${process.env.WEBAPP_URL}?bot=${context.chatId}&userId=${userId}&firstName=${firstName}&token=${authToken}` :
                null;

            const allBotInfo = this.telegramBot.getAllBotInfo();
            const currentBotInfo = allBotInfo.find(bot => bot.id === adapter.botInfo?.id);

            if (!currentBotInfo) {
                console.error('[MenuManager] Current bot info not found');
                return Markup.inlineKeyboard([[Markup.button.callback('Help', 'help_command')]]);
            }

            if (isPrivateChat) {
                const buttons: InlineKeyboardButton[][] = [
                    [Markup.button.callback('Help', 'help_command')],
                    [Markup.button.callback('Show Commands', `show_commands:${currentBotInfo.id}`)]
                ];

                if (webappUrl) {
                    buttons.push([Markup.button.url('🌐 Open Web Chat', webappUrl)]);
                }

                console.log(`[MenuManager] Created private chat menu for user ${userRecord.id}`);
                return Markup.inlineKeyboard(buttons);
            } else {
                const botButtons: InlineKeyboardButton[][] = allBotInfo.map((bot) => [
                    Markup.button.callback(`Start ${bot.firstName}`, `select_${bot.id}`)
                ]);

                const buttons: InlineKeyboardButton[][] = [
                    ...botButtons,
                    [Markup.button.callback('Help', 'help_command')],
                    [Markup.button.callback('Show Commands', 'show_commands')]
                ];

                if (webappUrl) {
                    buttons.push([Markup.button.url('🌐 Open Web Chat', webappUrl)]);
                }

                console.log(`[MenuManager] Created group chat menu for user ${userRecord.id}`);
                return Markup.inlineKeyboard(buttons);
            }
        } catch (error) {
            console.error('[MenuManager] Error creating inline menu:', error);
            // Return a basic menu as fallback
            return Markup.inlineKeyboard([[Markup.button.callback('Help', 'help_command')]]);
        }
    }

    createStartMenu(): Markup.Markup<InlineKeyboardMarkup> {
        if (!this.telegramBot) {
            console.warn('TelegramBot_Agents is null in MenuManager. Returning default menu.');
            return Markup.inlineKeyboard([[Markup.button.callback('Help', 'help_command')]]);
        }

        const botInfo = this.telegramBot.getAllBotInfo();
        const botButtons = botInfo.map((bot) => [
            Markup.button.callback(`Start Bot ${bot.firstName}`, `start_${bot.id}`)
        ]);

        // Add a Help button
        const helpButton = [Markup.button.callback('Help', 'help_command')];

        return Markup.inlineKeyboard([
            ...botButtons,
            helpButton // Help button at the end
        ]);
    }



    createBotSelectionMenu(botInfo: BotInfo[]): Markup.Markup<InlineKeyboardMarkup> {
        const botButtons = botInfo.map(bot => [
            Markup.button.callback(`Start ${bot.firstName}`, `select_bot:${bot.id}`)
        ]);
        return Markup.inlineKeyboard(botButtons);
    }



    createTextMenu(options: string[]): string {
        if (!options || options.length === 0) {
            throw new Error("No options provided for text menu creation");
        }
        return options.map((option, index) => `${index + 1}. ${option}`).join('\n');
    }

    ///////////////////////////////////////////////////////////////////////////////////////////////////////
    // Menus working with patterns:

    // Main method to create pattern selection menu


    /**
     * Creates a menu for patterns in a specific category
     */
    createCategoryPatternsMenu(
        patterns: any[],
        category: string,
        page: number = 0,
        totalPages: number = 1
    ): Markup.Markup<InlineKeyboardMarkup> {
        const buttons = [];

        // Create buttons for patterns (2 per row)
        for (let i = 0; i < patterns.length; i += 2) {
            const row = [];

            // Add first button
            row.push(Markup.button.callback(
                patterns[i].name,
                `pattern_use:${patterns[i].name}`
            ));

            // Add second button if it exists
            if (i + 1 < patterns.length) {
                row.push(Markup.button.callback(
                    patterns[i + 1].name,
                    `pattern_use:${patterns[i + 1].name}`
                ));
            }

            buttons.push(row);
        }

        // Add navigation buttons
        const navButtons = [];

        // Back button always present
        navButtons.push(Markup.button.callback('« Back', 'pattern_categories'));

        // Add page navigation if needed
        if (totalPages > 1) {
            if (page > 0) {
                navButtons.push(Markup.button.callback('◀️', `pattern_prev_page:${category}:${page}`));
            }

            if (page < totalPages - 1) {
                navButtons.push(Markup.button.callback('▶️', `pattern_next_page:${category}:${page}`));
            }
        }

        // Cancel button
        navButtons.push(Markup.button.callback('❌ Cancel', 'pattern_skip'));

        buttons.push(navButtons);

        return Markup.inlineKeyboard(buttons);
    }

    /**
     * Helper method to format category names
     */

    // Chunk navigation menu
    createChunkNavigationMenu(
        patternName: string,
        currentChunk: number,
        totalChunks: number
    ): Markup.Markup<InlineKeyboardMarkup> {
        const buttons = [
            [
                Markup.button.callback('⬅️ Previous', `pattern_chunk:${patternName}:prev`),
                Markup.button.callback(`${currentChunk + 1}/${totalChunks}`, 'pattern_noop'),
                Markup.button.callback('Next ➡️', `pattern_chunk:${patternName}:next`)
            ],
            [
                Markup.button.callback('🔍 Apply Pattern to This Chunk', `pattern_apply_to_chunk:${patternName}:${currentChunk}`),
                Markup.button.callback('📄 Download as Text', `pattern_download:${patternName}:text`),
                Markup.button.callback('📑 Download as PDF', `pattern_download:${patternName}:pdf`)
            ],
            [
                Markup.button.callback('🔝 Main Menu', 'pattern_back_to_menu'),
                Markup.button.callback('✅ Done', 'pattern_skip')
            ]
        ];

        return Markup.inlineKeyboard(buttons);
    }

    // Helper method for category emojis
    private getCategoryEmoji(category: string): string {
        const categoryEmojis: Record<string, string> = {
            'analysis': '🔍',
            'summarization': '📝',
            'extraction': '🔎',
            'creation': '✨',
            'explanation': '📚',
            'general': '🧩'
        };

        return categoryEmojis[category] || '📋';
    }

    // Helper method for formatting category names
    public formatCategoryName(category: string): string {
        return category.charAt(0).toUpperCase() + category.slice(1);
    }


    /**
     * Creates an advanced pattern options menu
     */
    createAdvancedPatternMenu(
        hasInputChunks: boolean,
        hasProcessedOutputs: boolean,
        outputPatterns: string[] = []
    ): Markup.Markup<InlineKeyboardMarkup> {
        const buttons = [];

        // Input selection options
        buttons.push([
            Markup.button.callback('🔍 Browse Input Chunks', 'pattern_browse_input'),
            Markup.button.callback('🔄 Use Original Input', 'pattern_use_full_input')
        ]);

        // Output selection if any exist
        if (hasProcessedOutputs && outputPatterns.length > 0) {
            buttons.push([
                Markup.button.callback('📝 Choose from Processed Results', 'pattern_choose_output')
            ]);
        }

        // Standard patterns
        const standardPatterns = [
            { name: 'summarize', emoji: '📝' },
            { name: 'improve_writing', emoji: '✍️' }
        ];

        buttons.push([
            Markup.button.callback(`${standardPatterns[0].emoji} Summarize`, `pattern_use:${standardPatterns[0].name}`),
            Markup.button.callback(`${standardPatterns[1].emoji} Improve`, `pattern_use:${standardPatterns[1].name}`)
        ]);

        buttons.push([
            Markup.button.callback('📄 Download as Text', `pattern_download:original:text`),
            Markup.button.callback('📑 Download as PDF', `pattern_download:original:pdf`)
        ]);

        // Navigation buttons
        buttons.push([
            Markup.button.callback('📋 More Patterns', 'pattern_more'),
            Markup.button.callback('🔝 Main Menu', 'pattern_back_to_menu'),
            Markup.button.callback('⏭️ Process Normally', 'pattern_skip')
        ]);

        return Markup.inlineKeyboard(buttons);
    }


    public cleanup(): void {
        console.log(`[MenuManager] Starting cleanup...`);

        // Clear any active menu timeouts
        for (const timeoutId of this.menuTimeouts.values()) {
            clearTimeout(timeoutId);
        }
        this.menuTimeouts.clear();

        // Clear any stored menus or other state
        // Add any additional cleanup logic here

        console.log(`[MenuManager] Cleanup completed.`);
    }


    /**
     * Creates a menu for pattern selection for a specific chunk
     */
    createChunkPatternMenu(
        standardPatterns = [
            { name: 'summarize', emoji: '📝' },
            { name: 'improve_writing', emoji: '✍️' },
            { name: 'extract_wisdom', emoji: '💡' },
            { name: 'write_essay', emoji: '📚' }
        ]
    ): Markup.Markup<InlineKeyboardMarkup> {
        const buttons = [];

        // Standard patterns - two per row
        buttons.push([
            Markup.button.callback(`${standardPatterns[0].emoji} Summarize`, `pattern_use:${standardPatterns[0].name}`),
            Markup.button.callback(`${standardPatterns[1].emoji} Improve`, `pattern_use:${standardPatterns[1].name}`)
        ]);

        buttons.push([
            Markup.button.callback(`${standardPatterns[2].emoji} Extract Wisdom`, `pattern_use:${standardPatterns[2].name}`),
            Markup.button.callback(`${standardPatterns[3].emoji} Write Essay`, `pattern_use:${standardPatterns[3].name}`)
        ]);

        // Navigation buttons
        buttons.push([
            Markup.button.callback('📋 More Patterns', 'pattern_more'),
            Markup.button.callback('🔝 Main Menu', 'pattern_back_to_menu'),
            Markup.button.callback('✅ Done', 'pattern_skip')
        ]);

        return Markup.inlineKeyboard(buttons);
    }

    /**
     * Creates a menu of processed outputs
     */
    createProcessedOutputsMenu(
        outputPatterns: string[]
    ): Markup.Markup<InlineKeyboardMarkup> {
        const buttons = [];

        // Group outputs by pairs for the menu
        for (let i = 0; i < outputPatterns.length; i += 2) {
            const row = [];

            // Add first output
            row.push(Markup.button.callback(
                `${outputPatterns[i]}`,
                `pattern_select_output:${outputPatterns[i]}`
            ));

            // Add second output if it exists
            if (i + 1 < outputPatterns.length) {
                row.push(Markup.button.callback(
                    `${outputPatterns[i + 1]}`,
                    `pattern_select_output:${outputPatterns[i + 1]}`
                ));
            }

            buttons.push(row);
        }

        // Add navigation buttons
        buttons.push([
            Markup.button.callback('🔙 Back', 'pattern_advanced'),
            Markup.button.callback('🔝 Main Menu', 'pattern_back_to_menu'),
            Markup.button.callback('✅ Done', 'pattern_skip')
        ]);

        return Markup.inlineKeyboard(buttons);
    }

    /**
     * Creates a menu for batch processing all chunks
     */
    createBatchProcessingMenu(
        chunkCount: number
    ): Markup.Markup<InlineKeyboardMarkup> {
        const methodName = 'createBatchProcessingMenu';
        console.log(`[${methodName}] Creating menu for ${chunkCount} chunks`);

        const buttons = [];

        // Add a header row with information
        buttons.push([
            Markup.button.callback(`📊 Process ${chunkCount} Chunks`, 'pattern_noop')
        ]);

        // Most common patterns in first row (2 per row)
        const commonPatterns = [
            { name: 'summarize', emoji: '📝', description: 'Summarize content' },
            { name: 'extract_insights', emoji: '💡', description: 'Extract key insights' },
            { name: 'improve_writing', emoji: '✍️', description: 'Improve writing style' },
            { name: 'analyze_content', emoji: '🔍', description: 'Analyze content' }
        ];

        // Add common patterns (2 per row)
        for (let i = 0; i < commonPatterns.length; i += 2) {
            const row = [];

            row.push(Markup.button.callback(
                `${commonPatterns[i].emoji} ${commonPatterns[i].name}`,
                `pattern_process_all:${commonPatterns[i].name}`
            ));

            if (i + 1 < commonPatterns.length) {
                row.push(Markup.button.callback(
                    `${commonPatterns[i + 1].emoji} ${commonPatterns[i + 1].name}`,
                    `pattern_process_all:${commonPatterns[i + 1].name}`
                ));
            }

            buttons.push(row);
        }

        // Download options row for the merged content
        buttons.push([
            Markup.button.callback('📄 Download as Text', `pattern_download:merged_chunks:text`),
            Markup.button.callback('📑 Download as PDF', `pattern_download:merged_chunks:pdf`)
        ]);

        // Additional options row
        buttons.push([
            Markup.button.callback('📋 More Patterns', 'pattern_more'),
            Markup.button.callback('🧩 Advanced', 'pattern_advanced')
        ]);

        // Navigation buttons
        buttons.push([
            Markup.button.callback('🔙 Back', 'pattern_browse_input'),
            Markup.button.callback('✅ Done', 'pattern_skip')
        ]);

        return Markup.inlineKeyboard(buttons);
    }

    /**
     * Creates a navigation menu for batch results
     */
    createBatchResultNavigationMenu(
        batchKey: string,
        currentIndex: number,
        totalResults: number
    ): Markup.Markup<InlineKeyboardMarkup> {
        const buttons = [];

        // Navigation for results
        buttons.push([
            Markup.button.callback(
                '⬅️ Previous',
                `pattern_view_batch:${batchKey}:${Math.max(0, currentIndex - 1)}`
            ),
            Markup.button.callback(
                `${currentIndex + 1}/${totalResults}`,
                'pattern_noop'
            ),
            Markup.button.callback(
                'Next ➡️',
                `pattern_view_batch:${batchKey}:${Math.min(totalResults - 1, currentIndex + 1)}`
            )
        ]);

        // Action buttons
        buttons.push([
            Markup.button.callback('🔙 Back to Summary', `pattern_view_batch_summary:${batchKey}`),
            Markup.button.callback('✅ Done', 'pattern_skip')
        ]);

        return Markup.inlineKeyboard(buttons);
    }


    /**
     * Creates a menu for batch processing completion
     */
    createBatchCompletionMenu(
        batchKey: string
    ): Markup.Markup<InlineKeyboardMarkup> {
        const buttons = [
            [Markup.button.callback('🔍 View Results', `pattern_view_batch:${batchKey}:0`)],
            [
                Markup.button.callback('🔙 Back', 'pattern_select_all_chunks'),
                Markup.button.callback('🔝 Main Menu', 'pattern_back_to_menu'),
                Markup.button.callback('✅ Done', 'pattern_skip')
            ]
        ];

        return Markup.inlineKeyboard(buttons);
    }

    // In MenuManager.ts, add these helper methods

    // Helper method to create consistent navigation footer
    // In MenuManager.ts - update the relevant buttons in your menu creation methods
    // For example, in createNavigationFooter:

    createNavigationFooter(
        includeBack: boolean = true,
        includeHome: boolean = true,
        includeCancel: boolean = true,
        deleteOnCancel: boolean = false  // Add this parameter
    ): InlineKeyboardButton[][] {
        const footer = [];
        const navRow = [];

        if (includeBack) {
            navRow.push(Markup.button.callback('🔝 Main Menu', 'pattern_back_to_menu'));
        }

        if (includeHome) {
            navRow.push(Markup.button.callback('🏠 Categories Menu', 'pattern_categories'));
        }

        if (includeCancel) {
            // Use pattern_delete instead of pattern_skip if deleteOnCancel is true
            navRow.push(Markup.button.callback('❌ Cancel',
                deleteOnCancel ? 'pattern_delete' : 'pattern_skip'));
        }

        if (navRow.length > 0) {
            footer.push(navRow);
        }

        return footer;
    }

    // Helper to display breadcrumbs for navigation context
    createBreadcrumb(path: string[]): string {
        return path.join(' > ');
    }

    // In MenuManager.ts, update the createPatternSelectionMenu method
    createPatternSelectionMenu(
        originalSuggestion?: any,
        alternativePatterns?: string[]
    ): Markup.Markup<InlineKeyboardMarkup> {
        const buttons = [];
        // Add main suggestion section if available
        if (originalSuggestion) {
            // Heading for recommended pattern (not a button)
            buttons.push([
                Markup.button.callback(`✨ Use ${originalSuggestion.pattern}`, `pattern_use:${originalSuggestion.pattern}`)
            ]);

            // Add alternative patterns if available
            if (alternativePatterns?.length) {
                const alternativeRows = [];
                for (let i = 0; i < Math.min(alternativePatterns.length, 4); i += 2) {
                    const row = [];
                    row.push(Markup.button.callback(`🔄 ${alternativePatterns[i]}`, `pattern_use:${alternativePatterns[i]}`));

                    if (i + 1 < alternativePatterns.length) {
                        row.push(Markup.button.callback(`🔄 ${alternativePatterns[i + 1]}`, `pattern_use:${alternativePatterns[i + 1]}`));
                    }

                    alternativeRows.push(row);
                }
                buttons.push(...alternativeRows);
            }

            // Visual separator (empty button with no callback)
            buttons.push([Markup.button.callback('━━━━━━━━━━━━━━━', 'pattern_noop')]);
        }

        // Common patterns section - organized by type
        buttons.push([
            Markup.button.callback(`📝 Summarize`, `pattern_use:summarize`),
            Markup.button.callback(`💡 Extract Insights`, `pattern_use:extract_insights`)
        ]);

        buttons.push([
            Markup.button.callback(`✍️ Improve Writing`, `pattern_use:improve_writing`),
            Markup.button.callback(`🧘‍♀️ Extract Wisdom`, `pattern_use:extract_wisdom`)
        ]);

        buttons.push([
            Markup.button.callback('📄 Download as Text', `pattern_download:original:text`),
            Markup.button.callback('📑 Download as PDF', `pattern_download:original:pdf`)
        ]);

        // Navigation and advanced options
        const actionRow = [
            Markup.button.callback('🔝 Main Menu', 'pattern_back_to_menu'),
            Markup.button.callback('📋 More Patterns', 'pattern_more')
        ];

        if (originalSuggestion) {
            actionRow.push(Markup.button.callback('🧩 Advanced', 'pattern_advanced'));
        }

        buttons.push(actionRow);

        // Add standard navigation footer
        buttons.push(...this.createNavigationFooter(false, false, true, true));

        return Markup.inlineKeyboard(buttons);
    }
    // In MenuManager.ts, update the createPatternCategoriesMenu method
    createPatternCategoriesMenu(categories: string[]): Markup.Markup<InlineKeyboardMarkup> {
        const buttons = [];

        // Add header
        buttons.push([
            Markup.button.callback('📋 Pattern Categories', 'pattern_noop')
        ]);

        // Create category mapping with friendly names and emojis
        const categoryConfig = {
            'analysis': { emoji: '🔍', name: 'Analysis' },
            'summarization': { emoji: '📝', name: 'Summarization' },
            'extraction': { emoji: '🔎', name: 'Extraction' },
            'creation': { emoji: '✨', name: 'Creation' },
            'explanation': { emoji: '📚', name: 'Explanation' },
            'general': { emoji: '🧩', name: 'General' }
        };

        // Group categories into rows of 2
        for (let i = 0; i < categories.length; i += 2) {
            const row = [];

            // Add first button
            const cat1 = categories[i];
            const config1 = categoryConfig[cat1 as keyof typeof categoryConfig] || { emoji: '📋', name: this.formatCategoryName(cat1) };
            row.push(Markup.button.callback(
                `${config1.emoji} ${config1.name}`,
                `pattern_category:${cat1}`
            ));

            // Add second button if it exists
            if (i + 1 < categories.length) {
                const cat2 = categories[i + 1];
                const config2 = categoryConfig[cat2 as keyof typeof categoryConfig] || { emoji: '📋', name: this.formatCategoryName(cat2) };
                row.push(Markup.button.callback(
                    `${config2.emoji} ${config2.name}`,
                    `pattern_category:${cat2}`
                ));
            }

            buttons.push(row);
        }

        // Add navigation footer
        buttons.push(...this.createNavigationFooter(true, false, true, true));

        return Markup.inlineKeyboard(buttons);
    }

    // In MenuManager.ts - verify this is properly implemented
    createInputChunkNavigationMenu(
        currentChunk: number,
        totalChunks: number
    ): Markup.Markup<InlineKeyboardMarkup> {
        const buttons = [];

        // Navigation controls
        const navRow = [];

        // First/prev buttons
        if (currentChunk > 0) {
            navRow.push(Markup.button.callback('⏮️ First', `pattern_input_chunk:first`));
            navRow.push(Markup.button.callback('◀️ Prev', `pattern_input_chunk:prev`));
        } else {
            navRow.push(Markup.button.callback('⏮️', 'pattern_noop'));
            navRow.push(Markup.button.callback('◀️', 'pattern_noop'));
        }

        // Progress indicator
        navRow.push(Markup.button.callback(`${currentChunk + 1}/${totalChunks}`, 'pattern_noop'));

        // Next/last buttons
        if (currentChunk < totalChunks - 1) {
            navRow.push(Markup.button.callback('▶️ Next', `pattern_input_chunk:next`));
            navRow.push(Markup.button.callback('⏭️ Last', `pattern_input_chunk:last`));
        } else {
            navRow.push(Markup.button.callback('▶️', 'pattern_noop'));
            navRow.push(Markup.button.callback('⏭️', 'pattern_noop'));
        }

        buttons.push(navRow);

        // Action buttons for the current chunk
        buttons.push([
            Markup.button.callback('✨ Process This Chunk', `pattern_select_chunk:${currentChunk}`)
        ]);

        // Add batch processing option
        buttons.push([
            Markup.button.callback('🔄 Process All Chunks', `pattern_select_all_chunks`)
        ]);

        // Download options for this chunk
        buttons.push([
            Markup.button.callback('📄 Download This Chunk', `pattern_download:chunk_${currentChunk}:text`),
            Markup.button.callback('📑 Download All Chunks', `pattern_download:merged_chunks:pdf`)
        ]);

        // Add navigation footer
        buttons.push([
            Markup.button.callback('🔙 Back', 'pattern_back_to_menu'),
            Markup.button.callback('✅ Done', 'pattern_skip')
        ]);

        return Markup.inlineKeyboard(buttons);
    }

    // In MenuManager.ts, update the createOutputActionsMenu method
    createOutputActionsMenu(
        patternName: string
    ): Markup.Markup<InlineKeyboardMarkup> {
        const buttons = [];

        // Header
        buttons.push([
            Markup.button.callback(`✅ Processed with ${patternName}`, 'pattern_noop')
        ]);

        // Primary actions
        buttons.push([
            Markup.button.callback('🔝 Main Menu', 'pattern_back_to_menu'),
            Markup.button.callback('📄 Download as Text', `pattern_download:${patternName}:text`),
            Markup.button.callback('📑 Download as PDF', `pattern_download:${patternName}:pdf`)
        ]);

        // Secondary actions
        buttons.push([
            Markup.button.callback('🔄 Use Original Input', 'pattern_use_full_input'),
            Markup.button.callback('🧩 Advanced Options', 'pattern_advanced')
        ]);

        // Add navigation footer with "Done" instead of "Cancel"
        buttons.push([
            Markup.button.callback('📋 More Patterns', 'pattern_more'),
            Markup.button.callback('✅ Done', 'pattern_skip')
        ]);

        return Markup.inlineKeyboard(buttons);
    }

    // Add to MenuManager.ts

    /**
     * Creates a standardized chat menu with essential options
     * @param isGroupChat Whether this is being shown in a group chat
     * @param botId The current bot's ID
     * @returns A markup object with the standardized menu
     */
    /**
 * Creates a standardized chat menu with essential options
 * @param isGroupChat Whether this is being shown in a group chat
 * @param botId The current bot's ID
 * @param context Optional context about the current message
 * @returns A markup object with the standardized menu
 */
    createStandardChatMenu(
        isGroupChat: boolean,
        botId: number,
        context?: {
            isResponse?: boolean;
            hasContent?: boolean;
            contentLength?: number;
            isRagEnabled?: boolean; // Add this new property
        }
    ): Markup.Markup<InlineKeyboardMarkup> {
        const buttons = [];

        // First row - primary actions based on context
        if (context?.isResponse) {
            // If this is attached to a response, show response-specific actions
            buttons.push([
                Markup.button.callback('📝 Process with Pattern', `standard_menu:pattern:${botId}`),
                Markup.button.callback(
                    `RAG Mode: ${context.isRagEnabled ? '✅ ON' : '❌ OFF'}`,
                    `execute_command:${botId}:ragmode`
                )
            ]);

            buttons.push([
                Markup.button.callback('📚 Sources', `standard_menu:sources:${botId}`),
                Markup.button.callback('❓ Follow-up Q', `standard_menu:follow_up:${botId}`),
            ]);

            // Third row - sources and download options
            const thirdRow = [];

            // Add download options if response has significant content
            if (context.hasContent && context.contentLength && context.contentLength > 200) {
                thirdRow.push(
                    Markup.button.callback('📄 Download as Text', `pattern_download:original:text`),
                    Markup.button.callback('📑 Download as PDF', `pattern_download:original:pdf`),
                );
            }

            if (thirdRow.length > 0) {
                buttons.push(thirdRow);
            }
        } else {
            // Standard primary actions
            buttons.push([
                Markup.button.callback('💬 Ask Question', `standard_menu:query:${botId}`),
                Markup.button.callback('📋 Commands', `standard_menu:commands:${botId}`),
            ]);
        }
        /*
                // Last row - contextual options
                if (isGroupChat) {
                    // Group chat options
                    buttons.push([
                        Markup.button.callback('🤖 Select Bot', `standard_menu:select_bot:${botId}`),
                        Markup.button.callback('⚙️ Settings', `standard_menu:settings:${botId}`)
                    ]);
                } else {
                    // Private chat options
                    const lastRow = [
                        Markup.button.callback('⚙️ Settings', `standard_menu:settings:${botId}`)
                    ];
        
                    // Add help button in regular menu context
                    if (!context?.isResponse) {
                        lastRow.unshift(Markup.button.callback('❓ Help', `standard_menu:help:${botId}`));
                    }
        
                    buttons.push(lastRow);
                }
        */
        return Markup.inlineKeyboard(buttons);
    }
    /**
 * Sets a timeout to auto-hide the standard menu after inactivity
 * @param adapter Context adapter
 * @param messageId Message ID of the menu to hide
 * @param timeout Timeout in milliseconds (default 15 minutes)
 */
    // Update in MenuManager.ts
    setStandardMenuTimeout(adapter: ContextAdapter, messageId: number, timeout: number = 900000): void {
        // Use the existing setMenuTimeout method if it exists
        if (typeof this.setMenuTimeout === 'function') {
            this.setMenuTimeout(adapter, messageId, timeout);
            return;
        }

        // Fall back to our custom implementation if needed
        const chatId = adapter.getMessageContext().chatId;
        const menuKey = `${chatId}:${messageId}`;

        // Clear any existing timeout
        this.clearMenuTimeout(messageId);

        // Set a new timeout
        const timeoutId = setTimeout(async () => {
            try {
                // Edit the message to remove the menu
                await adapter.editMessageReplyMarkup(messageId, undefined);
                console.log(`Standard menu ${menuKey} auto-hidden after ${timeout / 1000} seconds`);
            } catch (error) {
                console.error(`Failed to auto-hide standard menu ${menuKey}:`, error);
            }
        }, timeout);

        this.menuTimeouts.set(messageId, timeoutId);
    }


}