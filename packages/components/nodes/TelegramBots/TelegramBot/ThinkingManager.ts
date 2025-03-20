// ThinkingManager.ts

import { ContextAdapter } from './ContextAdapter';
import { ThinkingDisplayMode, ThinkingPreferences, ThinkingBlock } from './utils/types/ThinkingTypes';
import { Markup } from 'telegraf';
import { logDebug, logError } from './loggingUtility';
import { cleanModelResponse, CleanedResponse, hasThinkTags, messageContentToString } from './utils/utils';
import { BaseMessage, HumanMessage, AIMessage, SystemMessage, MessageContent } from '@langchain/core/messages';


export class ThinkingManager {
    private readonly CACHE_TIMEOUT = 12 * 60 * 60 * 1000; // 12 hours 
    private thinkingCache = new Map<string, { 
        content: string; 
        timestamp: number;
        isExpanded: boolean; // Track expanded state
    }>();
    private userPreferences = new Map<string, ThinkingPreferences>();
    private readonly defaultPreferences: ThinkingPreferences = {
        showThinking: true,
        thinkingDuration: 120000,
        displayMode: ThinkingDisplayMode.INTERACTIVE,
        format: 'detailed',
        autoDelete: true
    };

    private readonly emojis = {
        thinking: ['🤔', '💭', '🧐', '💡', '🔍'],
        categories: {
            analysis: '📊',
            reasoning: '🔄',
            decision: '⚖️',
            research: '📚',
            calculation: '🔢'
        }
    };
    public getPreferences(userId: string): ThinkingPreferences {
        return this.userPreferences.get(userId) || this.defaultPreferences;
    }
    
    constructor(private flowId: string) {}
    public async updatePreferences(
        userId: string, 
        preferences: Partial<ThinkingPreferences>
    ): Promise<void> {
        const currentPrefs = this.userPreferences.get(userId) || this.defaultPreferences;
        
        // Update preferences with new values
        const updatedPrefs: ThinkingPreferences = {
            ...currentPrefs,
            ...preferences
        };
    
        // Store the updated preferences
        this.userPreferences.set(userId, updatedPrefs);
    
        console.log(`Updated thinking preferences for user ${userId}:`, {
            oldPrefs: currentPrefs,
            newPrefs: updatedPrefs
        });
    }
    public formatThinkingProcess(thinking: string[] | ThinkingBlock[]): string {
        return thinking.map((thought, index) => {
            const emoji = this.emojis.thinking[index % this.emojis.thinking.length];
            if (typeof thought === 'string') {
                return `${emoji} ${thought}`;
            } else {
                const categoryEmoji = thought.metadata?.category ? 
                    this.emojis.categories[thought.metadata.category as keyof typeof this.emojis.categories] || '💡' : 
                    emoji;
                return `${categoryEmoji} ${thought.content}${
                    thought.metadata?.confidence ? 
                    ` (${Math.round(thought.metadata.confidence * 100)}% confident)` : 
                    ''
                }`;
            }
        }).join('\n');
    }

    public async displayThinking(
        adapter: ContextAdapter,
        thinking: string[] | ThinkingBlock[],
        overridePreferences?: Partial<ThinkingPreferences>
    ): Promise<void> {
        const context = adapter.getMessageContext();
        const userId = context.userId.toString();
        const userPrefs = this.getPreferences(userId);
        
        // Merge default, user, and override preferences
        const prefs: ThinkingPreferences = {
            ...this.defaultPreferences,
            ...userPrefs,
            ...overridePreferences
        };
    
        if (!prefs.showThinking || thinking.length === 0) {
            return;
        }
    
        try {
            switch (prefs.displayMode) {
                case ThinkingDisplayMode.INTERACTIVE:
                    await this.showInteractiveThinking(adapter, thinking);
                    break;
    
                case ThinkingDisplayMode.SEPARATE_MESSAGE:
                    await this.showSeparateThinking(adapter, thinking, prefs);
                    break;
    
                case ThinkingDisplayMode.INLINE:
                    await this.showInlineThinking(adapter, thinking);
                    break;
    
                case ThinkingDisplayMode.DEBUG_ONLY:
                    this.logThinkingForDebug(thinking);
                    break;
    
                default:
                    logDebug('displayThinking', 'Thinking display mode not recognized, defaulting to separate');
                    await this.showSeparateThinking(adapter, thinking, prefs);
            }
        } catch (error) {
            logError('displayThinking', 'Error displaying thinking process:', error as Error);
        }
    }

    private async showInteractiveThinking(
        adapter: ContextAdapter,
        thinking: string[] | ThinkingBlock[]
    ): Promise<void> {
        const formattedThinking = this.formatThinkingProcess(thinking);
        const preview = formattedThinking.split('\n').slice(0, 2).join('\n') + '\n...';

        // Send initial collapsed view
        const response = await adapter.reply('💭 Bots Thinking Process:', {
            reply_markup: Markup.inlineKeyboard([[
                Markup.button.callback('Show More 🔍', 'thinking_toggle')
            ]]).reply_markup
        });

        // Store thinking content with expanded state
        const messageId = response.message_id?.toString();
        if (messageId) {
            this.cacheThinkingContent(messageId, formattedThinking, false);

            // Set auto-cleanup after 24 hours
            setTimeout(() => {
                this.cleanupThinkingMessage(adapter, messageId);
            }, 24 * 60 * 60 * 1000); // 24 hours
        }
    }
    private async cleanupThinkingMessage(adapter: ContextAdapter, messageId: string) {
        try {
            const numericMessageId = parseInt(messageId);
            if (!isNaN(numericMessageId)) {
                await adapter.deleteMessage(numericMessageId);
            }
            this.thinkingCache.delete(messageId);
        } catch (error) {
            console.error('Error cleaning up thinking message:', error);
        }
    }
    // Update the cache method to use string keys
    private cacheThinkingContent(messageId: string, content: string, isExpanded: boolean): void {
        this.thinkingCache.set(messageId, {
            content,
            timestamp: Date.now(),
            isExpanded
        });
    }
    public async handleThinkingToggle(adapter: ContextAdapter, messageId: string): Promise<void> {
        const cached = this.thinkingCache.get(messageId);
        if (!cached) {
            await adapter.answerCallbackQuery('Thinking process no longer available');
            return;
        }

        // Check if cache is still valid
        if (Date.now() - cached.timestamp > this.CACHE_TIMEOUT) {
            this.thinkingCache.delete(messageId);
            await adapter.answerCallbackQuery('Thinking process has expired');
            return;
        }

        try {
            const newIsExpanded = !cached.isExpanded;
            const displayText = newIsExpanded ? 
                `💭 Bots Thinking Process:\n${cached.content}` : 
                '💭 Bots Thinking Process:';
            
            const buttonText = newIsExpanded ? 'Hide 🔒' : 'Show More 🔍';

            await adapter.editMessageText(displayText, {
                reply_markup: Markup.inlineKeyboard([[
                    Markup.button.callback(buttonText, 'thinking_toggle')
                ]]).reply_markup
            });

            // Update cache with new state
            this.cacheThinkingContent(messageId, cached.content, newIsExpanded);
            
            await adapter.answerCallbackQuery(
                newIsExpanded ? 'Showing full thinking process' : 'Thinking process collapsed'
            );

        } catch (error) {
            console.error('Error toggling thinking display:', error);
            await adapter.answerCallbackQuery('Error updating display');
        }
    }
    public getCachedThinking(messageId: string): { 
        content: string; 
        isExpanded: boolean; 
    } | undefined {
        const cached = this.thinkingCache.get(messageId);
        if (!cached) return undefined;

        // Check if cache is still valid
        if (Date.now() - cached.timestamp > this.CACHE_TIMEOUT) {
            this.thinkingCache.delete(messageId);
            return undefined;
        }

        return {
            content: cached.content,
            isExpanded: cached.isExpanded
        };
    }

    private async showSeparateThinking(
        adapter: ContextAdapter,
        thinking: string[] | ThinkingBlock[],
        preferences: ThinkingPreferences
    ): Promise<void> {
        const formattedThinking = this.formatThinkingProcess(thinking);
        if (preferences.autoDelete) {
            await adapter.replyWithAutoDelete(
                `💭 Bots Thinking Process:\n${formattedThinking}`,
                preferences.thinkingDuration
            );
        } else {
            await adapter.reply(`💭 Bots Thinking Process:\n${formattedThinking}`);
        }
    }

    private async showInlineThinking(
        adapter: ContextAdapter,
        thinking: string[] | ThinkingBlock[]
    ): Promise<void> {
        const formattedThinking = this.formatThinkingProcess(thinking);
        await adapter.reply(`💭 *Bots Thinking Process:*\n\`\`\`\n${formattedThinking}\n\`\`\``, {
            parse_mode: 'Markdown'
        });
    }

    private logThinkingForDebug(thinking: string[] | ThinkingBlock[]): void {
        logDebug('ThinkingManager', 'Thinking process:', {
            thinking: Array.isArray(thinking) ? thinking : [thinking],
            flowId: this.flowId
        });
    }
    public cleanThinkTags(content: MessageContent): string {
        if (hasThinkTags(content)) {
            const cleaned = cleanModelResponse(content, true);
            return cleaned.content;
        }
        return messageContentToString(content);
    }

}