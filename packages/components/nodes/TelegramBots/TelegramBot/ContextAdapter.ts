// ContextAdapter.ts
import { MessageContext, TelegramParseMode, PhotoMessageOptions, MessageResponse, PhotoSource, InputMedia, EditMessageMediaOptions } from './commands/types';
import { PromptManager } from './PromptManager';
import { TelegramBot_Agents } from './TelegramBot_Agents';
import { Context, Telegraf, Telegram } from 'telegraf';
import { Update, Message, Chat, CallbackQuery, InputFile } from 'telegraf/typings/core/types/typegram';
import { ExtraEditMessageText, ExtraReplyMessage } from 'telegraf/typings/telegram-types';
import { FmtString } from 'telegraf/typings/format';
import { FormatConverter } from './utils/FormatConverter';
import { ReadStream, createReadStream, existsSync } from 'fs';
import * as fs from 'fs/promises';
import * as fsPromises from 'fs/promises';
import { ConversationManager } from './ConversationManager';




declare module 'telegraf' {
    interface Context {
        match: RegExpExecArray | null;
    }
}

export class ContextAdapter {
    public context: MessageContext;
    private bot: Telegraf<Context>;
    public telegramContext?: Context<Update>;  // Add this
    private messageAutoDeleteTimes: Record<string, number> = {
        'game_welcome': 1800000,    // 30 minutes
        'game_question': 1800000,   // 30 minutes
        'result': 600000,           // 10 minutes
        'ten_min': 600000,          // 10 minutes
        'five_min': 300000,         // 5 minutes
        'one_min': 60000            // 1 minute
    };
    public chat?: Chat;
    public botInfo: Context['botInfo'];
    private promptManager: PromptManager | null;
    private conversationManager: ConversationManager | null = null;



    constructor(input: Context<Update> | MessageContext, promptManager: PromptManager | null) {
        if (this.isTelegramContext(input)) {
            // Store both the Telegram context and converted MessageContext
            this.telegramContext = input;
            this.context = this.convertTelegramContext(input);
            this.chat = this.convertChat(input.chat);
            this.botInfo = input.botInfo;
            this.bot = this.bot;

            // Handle message ID for callback queries
            if (input.callbackQuery && 'message' in input.callbackQuery && input.callbackQuery.message) {
                this.context.messageId = input.callbackQuery.message.message_id;
            }
        } else {
            this.context = input;

            // Important fix: If this is a telegram message from a custom context
            if (input.source === 'telegram') {
                // Try to extract telegram object from the raw data
                // To avoid type issues, access properties more carefully
                const rawObj = input.raw as any;

                // Check if we can find the telegram client in the raw field
                if (rawObj && typeof rawObj === 'object') {
                    if ('telegram' in rawObj && 'update' in rawObj) {
                        // This might be a Telegraf context
                        this.telegramContext = rawObj as Context<Update>;
                        console.log('[ContextAdapter] Found telegramContext in raw field');
                    } else if (rawObj.message && rawObj.chat) {
                        // We have enough pieces to use the telegram API
                        // Create a minimal telegram context for API calls
                        const botInfo = input.raw?.botInfo;

                        // We need to create a minimal Telegram context that can send messages
                        if (this.bot && this.bot.telegram) {
                            // If we have access to the bot instance
                            this.telegramContext = {
                                telegram: this.bot.telegram,
                                botInfo: botInfo,
                                chat: rawObj.chat,
                                message: rawObj.message
                            } as unknown as Context<Update>;

                            console.log('[ContextAdapter] Created minimal telegramContext');
                        }
                    }
                }
            }

            this.chat = this.convertChat(input.raw?.chat);
            this.botInfo = input.raw?.botInfo;
            // For non-Telegram contexts, telegramContext remains undefined
        }
        this.promptManager = promptManager;
    }
    public getBotInfo(): Context['botInfo'] | undefined {
        return this.botInfo;
    }

    public getChatType(): string | undefined {
        return this.chat?.type;
    }

    private convertChat(chat: any): Chat | undefined {
        if (!chat) return undefined;

        const baseChat = {
            id: chat.id,
            type: chat.type,
            title: chat.title,
            username: chat.username,
            first_name: chat.first_name,
            last_name: chat.last_name,
            ...chat
        };

        switch (chat.type) {
            case 'private':
                return {
                    ...baseChat,
                    type: 'private' as const,
                    first_name: chat.first_name || ''
                };
            case 'group':
                return {
                    ...baseChat,
                    type: 'group' as const,
                    title: chat.title || ''
                };
            case 'supergroup':
                return {
                    ...baseChat,
                    type: 'supergroup' as const,
                    title: chat.title || ''
                };
            case 'channel':
                return {
                    ...baseChat,
                    type: 'channel' as const,
                    title: chat.title || ''
                };
            default:
                // Default to private chat if type is unknown
                return {
                    ...baseChat,
                    type: 'private' as const,
                    first_name: chat.first_name || ''
                };
        }
    }
    private isTelegramContext(input: Context<Update> | MessageContext): input is Context<Update> {
        return 'telegram' in input && 'botInfo' in input;
    }

    private isDataCallbackQuery(query: CallbackQuery): query is CallbackQuery & { data: string } {
        return 'data' in query;
    }

    private convertTelegramContext(ctx: Context<Update>): MessageContext {
        // Get the input text from either message or callback query
        let input = '';
        if (ctx.message && 'text' in ctx.message) {
            input = ctx.message.text;
        } else if (ctx.message && 'caption' in ctx.message) {
            input = ctx.message.caption || '';
        } else if (ctx.callbackQuery && this.isDataCallbackQuery(ctx.callbackQuery)) {
            input = ctx.callbackQuery.data;
        }

        // Handle callback query
        const callbackQuery = ctx.callbackQuery && this.isDataCallbackQuery(ctx.callbackQuery)
            ? { data: ctx.callbackQuery.data }
            : undefined;

        return {
            source: 'telegram',
            chatId: ctx.chat?.id || 0,
            messageId: ctx.message?.message_id,
            userId: ctx.from?.id || 0,
            username: ctx.from?.username,
            first_name: ctx.from?.first_name,
            input,
            raw: ctx,
            isAI: false,
            isReply: false,
            callbackQuery
        };
    }

    public getMessageContext(): MessageContext {
        return this.context;
    }




    public async reply(text: string, options?: { replyToMessageId?: number, reply_markup?: any, parse_mode?: 'HTML' | 'Markdown' | 'MarkdownV2' }): Promise<{ message_id: number }> {
        console.log('ContextAdapter.ts: [Entering: reply]: PromptManager state:', this.promptManager ? 'Initialized' : 'Not initialized');
    
        if (this.context.source === 'telegram' && this.context.raw && 'reply' in this.context.raw) {
            try {
                let chunks: string[];
                if (this.promptManager) {
                    console.warn(`[reply] Using PromptManager to split message`);
                    chunks = this.promptManager.splitAndTruncateMessage(text);
                    console.warn(`[reply] Message split into ${chunks.length} chunks`);
                } else {
                    console.warn('PromptManager is not initialized. Sending message without splitting.');
                    chunks = [text];
                }
    
                let lastSentMessage;
                for (let i = 0; i < chunks.length; i++) {
                    console.warn(`[reply] Sending chunk ${i + 1}/${chunks.length}, length: ${chunks[i].length}`);
                    
                    // Clean up any unsupported tags before sending
                    const cleanChunk = this.cleanHtmlForTelegram(chunks[i]);
                    
                    // Replace <think> tags specifically (these might be used in internal processing)
                    const formattedChunk = cleanChunk.replace(/<\/?think>/g, '');
                    
                    console.warn(`[reply] Cleaned chunk, new length: ${formattedChunk.length}`);
    
                    const extra: any = {
                        parse_mode: options?.parse_mode || 'HTML',
                        reply_to_message_id: i === 0 ? options?.replyToMessageId : undefined
                    };
                    
                    if (options?.reply_markup) {
                        extra.reply_markup = options.reply_markup;
                    }
    
                    try {
                        lastSentMessage = await this.context.raw.telegram.sendMessage(this.context.chatId, formattedChunk, extra);
                        console.warn(`[reply] Chunk ${i + 1} sent successfully`);
                    } catch (sendError) {
                        // If HTML parsing fails, try sending without parse_mode
                        if (sendError.description && sendError.description.includes("can't parse entities")) {
                            console.warn(`[reply] HTML parsing failed, trying without formatting: ${sendError.description}`);
                            // Try again without HTML parsing
                            extra.parse_mode = undefined;
                            lastSentMessage = await this.context.raw.telegram.sendMessage(this.context.chatId, formattedChunk, extra);
                        } else {
                            throw sendError;
                        }
                    }
    
                    if (i < chunks.length - 1) {
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }
                }
                return lastSentMessage;
            } catch (error) {
                console.error('[reply] Error details:', error);
                
                // Attempt to send a plain text message without any formatting as a fallback
                try {
                    return await this.context.raw.telegram.sendMessage(
                        this.context.chatId, 
                        "Sorry, I encountered an error while formatting the message. Please try again."
                    );
                } catch (fallbackError) {
                    console.error('[reply] Even fallback message failed:', fallbackError);
                    throw error; // Re-throw the original error if fallback fails
                }
            }
        } else {
            // For non-Telegram sources (e.g., Flowise)
            console.log(`Simulating reply for ${this.context.source}: ${text}`);
            const formattedText = FormatConverter.genericToMarkdown(text);
            // In a real implementation, you would send this formatted text to Flowise or other platforms
            return { message_id: Date.now() };
        }
    }

    public async answerCallbackQuery(text: string): Promise<boolean> {
        if (this.context.raw && 'answerCbQuery' in this.context.raw) {
            return this.context.raw.answerCbQuery(text);
        } else {
            console.log(`Simulating answerCallbackQuery: ${text}`);
            return true;
        }
    }

    public isCallbackQuery(): boolean {
        return !!(this.context.raw && 'callbackQuery' in this.context.raw && this.context.raw.callbackQuery);
    }
    public async safeAnswerCallbackQuery(text: string): Promise<void> {
        try {
            if (this.context.raw && 'answerCbQuery' in this.context.raw) {
                await this.context.raw.answerCbQuery(text);
            } else {
                console.log(`Simulating safeAnswerCallbackQuery: ${text}`);
            }
        } catch (error) {
            if (error.description && error.description.includes('query is too old')) {
                console.log('Callback query too old, sending fallback message');
                await this.reply(text);
            } else {
                console.error('Error answering callback query:', error);
            }
        }
    }


    public async updateProgress(flowId: string, progressKey: string, stage: string): Promise<boolean> {
        console.log(`[ContextAdapter:${flowId}] Attempting to update progress: ${stage}`);

        if (this.context.source !== 'telegram' || !this.context.raw || !('telegram' in this.context.raw)) {
            console.log(`[ContextAdapter:${flowId}] Not a Telegram message, skipping progress update`);
            return false;
        }

        const ctx = this.context.raw as Context;
        const chatId = this.context.chatId;
        const [, messageId] = progressKey.split(':');

        if (!chatId || !messageId) {
            console.error(`[ContextAdapter:${flowId}] Invalid progressKey: ${progressKey} for chatId: ${chatId} and messageId: ${messageId}`);
            return false;
        }

        try {
            const result = await ctx.telegram.editMessageText(
                chatId,
                parseInt(messageId),
                undefined,
                stage,
                { parse_mode: 'HTML' } as ExtraEditMessageText
            );

            if (result === true || (typeof result === 'object' && 'text' in result)) {
                console.log(`[ContextAdapter:${flowId}] Successfully updated progress message`);
                return true;
            } else {
                console.warn(`[ContextAdapter:${flowId}] Failed to update progress message, unexpected result:`, result);
                return false;
            }
        } catch (error) {
            if (error.response && error.response.description === 'Bad Request: message is not modified') {
                console.log(`[ContextAdapter:${flowId}] Message content unchanged, considered as successful update`);
                return true;
            } else {
                console.error(`[ContextAdapter:${flowId}] Error updating progress message  for chatId: ${chatId} and messageId: ${messageId}:`, error);
                return false;
            }
        }
    }

    public async editMessageText(
        text: string,
        extra?: ExtraEditMessageText | number,
        maxRetries: number = 3
    ): Promise<true | (Update.Edited & Message.TextMessage) | undefined> {
        if (this.context.raw && 'editMessageText' in this.context.raw) {
            const ctx = this.context.raw as Context;
            let lastError;

            // Try up to maxRetries times
            for (let attempt = 0; attempt < maxRetries; attempt++) {
                try {
                    if (typeof extra === 'number') {
                        // If extra is a number, it's a message ID
                        console.log(`[ContextAdapter] Attempting to edit message with ID: ${extra} (attempt ${attempt + 1}/${maxRetries})`);
                        return await ctx.telegram.editMessageText(
                            this.context.chatId,
                            extra,
                            undefined,
                            text,
                            { parse_mode: 'HTML' }
                        );
                    } else if (ctx.callbackQuery?.message) {
                        // If it's a callback query context
                        console.log(`[ContextAdapter] Attempting to edit message in callback query context (attempt ${attempt + 1}/${maxRetries})`);
                        return await ctx.editMessageText(text, extra);
                    } else {
                        // If it's neither, try to edit the last sent message
                        console.log(`[ContextAdapter] Attempting to edit last sent message (attempt ${attempt + 1}/${maxRetries})`);
                        return await ctx.editMessageText(text, extra);
                    }
                } catch (error) {
                    lastError = error;
                    console.warn(`[ContextAdapter] Error editing message on attempt ${attempt + 1}:`, error);

                    // For network errors, wait and retry
                    if (
                        error.code === 'ECONNRESET' ||
                        error.code === 'ETIMEDOUT' ||
                        error.type === 'system' ||
                        (error.message && error.message.includes('ECONNRESET'))
                    ) {
                        console.log(`[ContextAdapter] Network error detected, waiting before retry...`);
                        // Exponential backoff: wait longer with each retry
                        const waitTime = Math.min(1000 * Math.pow(2, attempt), 5000);
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                        continue;
                    }

                    // For other errors (like message not found or content issues), don't retry
                    break;
                }
            }

            // If we got here, all retries failed
            console.error(`[ContextAdapter] All ${maxRetries} attempts to edit message failed`);
            return undefined;
        } else {
            console.log(`[ContextAdapter] Simulating editMessageText: ${text}`);
            return {
                message_id: typeof extra === 'number' ? extra : Date.now(),
                chat: this.context.raw?.chat,
                date: Math.floor(Date.now() / 1000),
                text: text,
                edit_date: Math.floor(Date.now() / 1000)
            } as Update.Edited & Message.TextMessage;
        }
    }

    public async replyWithHTML(text: string, extra?: ExtraReplyMessage): Promise<Message.TextMessage> {
        if (this.context.raw && 'replyWithHTML' in this.context.raw) {
            return this.context.raw.replyWithHTML(text, extra);
        } else {
            console.log(`Simulating replyWithHTML: ${text}`);
            return { message_id: Date.now() } as Message.TextMessage; // Simulated message
        }
    }

    // In the ContextAdapter class
    async deleteMessage(messageId?: number): Promise<boolean> {
        const methodName = 'deleteMessage';
        console.log(`[${methodName}] Attempting to delete message ${messageId || 'current'}`);
        
        if (this.isTelegramMessage()) {
            try {
                const context = this.getMessageContext();
                const chatId = context.chatId;
                let idToDelete: number;
                
                if (messageId) {
                    // If specific ID is provided, use it
                    idToDelete = messageId;
                } else if (this.telegramContext?.callbackQuery?.message?.message_id) {
                    // If it's a callback query, use the message_id from the callback query's message
                    idToDelete = this.telegramContext.callbackQuery.message.message_id;
                } else if (context.messageId && typeof context.messageId === 'number') {
                    // Otherwise use the context's message ID
                    idToDelete = context.messageId;
                } else if (typeof context.messageId === 'string') {
                    // If it's a string, convert to number
                    idToDelete = parseInt(context.messageId, 10);
                } else {
                    // No valid ID to delete
                    console.warn(`[${methodName}] No valid message ID found for deletion`);
                    return false;
                }
                
                if (isNaN(idToDelete)) {
                    console.error(`[${methodName}] Invalid message ID for deletion: ${idToDelete}`);
                    return false;
                }
                
                console.log(`[${methodName}] Deleting message ${idToDelete} in chat ${chatId}`);
                
                await this.telegramContext!.telegram.deleteMessage(chatId, idToDelete);
                console.log(`[${methodName}] Successfully deleted message ${idToDelete}`);
                return true;
            } catch (error) {
                // If message was already deleted, consider it a success
                if (error.description && error.description.includes('message to delete not found')) {
                    console.log(`[${methodName}] Message already deleted`);
                    return true;
                }
                console.error(`[${methodName}] Error deleting message:`, error);
                return false;
            }
        } else {
            console.log(`[${methodName}] Simulating delete message for ${this.context.source}: ${messageId || 'current'}`);
            return true;
        }
    }

    public async replyWithAutoDelete(text: string, deleteAfter: number = 60000): Promise<void> {
        try {
            const message = await this.reply(text);
            if (message && 'message_id' in message) {
                setTimeout(async () => {
                    try {
                        await this.deleteMessage(message.message_id);
                    } catch (error) {
                        // Silently handle deletion errors
                        console.log(`Auto-delete failed for message ${message.message_id} (possibly already deleted)`);
                    }
                }, deleteAfter);
            }
        } catch (error) {
            console.error('Error sending auto-delete message:', error);
        }
    }
    // In ContextAdapter.ts
    public async replyEditMessageTextWithAutoDelete(
        content: string,
        extra?: ExtraEditMessageText,
        options?: {
            deleteAfter?: number;
            messageType?: 'status' | 'result' | 'error' | 'two_min' | 'five_min' | 'ten_min' | 'thirty_min';
        }
    ): Promise<void> {
        // Default deletion times for different message types
        const defaultTimes = {
            status: 30000,
            result: 60000,
            error: 45000,
            two_min: 120000,
            five_min: 300000,
            ten_min: 600000,
            thirty_min: 1800000
        };

        const deleteAfter = options?.deleteAfter ??
            (options?.messageType ? defaultTimes[options.messageType] : 60000);

        try {
            // Get the messageId from extra and ensure it's a number
            let messageId: number | undefined;
            if (typeof extra === 'number') {
                messageId = extra;
            } else if (this.context.messageId) {
                messageId = typeof this.context.messageId === 'string' ?
                    parseInt(this.context.messageId, 10) :
                    this.context.messageId as number;
            }

            // Check if the message is a photo/media message that needs caption editing
            let editedMessage;

            try {
                // First, try to edit the message text
                editedMessage = await this.editMessageText(content, extra);
            } catch (editError) {
                // If error mentions "no text in the message", try editing caption instead
                if (editError.response?.description?.includes('no text in the message')) {
                    console.log(`[ContextAdapter] Message is media, trying caption edit instead`);

                    // Prepare correctly typed options for caption edit
                    const captionExtra = {
                        message_id: messageId,
                        chat_id: this.context.chatId,
                        reply_markup: typeof extra === 'object' ? extra.reply_markup : undefined,
                        parse_mode: (typeof extra === 'object' ? extra.parse_mode : undefined) as TelegramParseMode
                    };

                    editedMessage = await this.editMessageCaption(content, captionExtra);
                } else {
                    // If it's another type of error, rethrow
                    throw editError;
                }
            }

            // Check if editedMessage is an object (not boolean true) and has message_id
            if (editedMessage && typeof editedMessage === 'object' && 'message_id' in editedMessage) {
                // Set timeout to delete the message
                setTimeout(async () => {
                    try {
                        await this.deleteMessage(editedMessage.message_id);
                        console.log(`[ContextAdapter] Auto-deleted edited message: ${editedMessage.message_id}`);
                    } catch (error) {
                        console.warn('[ContextAdapter] Failed to auto-delete edited message:', error);
                    }
                }, deleteAfter);

                console.log(`[ContextAdapter] Set auto-delete timer for edited message: ${editedMessage.message_id}`);
            }
        } catch (error) {
            console.error('[ContextAdapter] Error in replyEditMessageTextWithAutoDelete:', error);
            // Fall back to sending a new message if all editing fails
            try {
                const message = await this.reply(content, {
                    reply_markup: typeof extra === 'object' ? extra.reply_markup : undefined,
                    parse_mode: typeof extra === 'object' ?
                        (extra.parse_mode as 'HTML' | 'Markdown' | 'MarkdownV2') :
                        undefined
                });

                // Set auto-delete for fallback message too
                if (message && 'message_id' in message) {
                    setTimeout(() => {
                        this.deleteMessage(message.message_id).catch(err => {
                            console.warn('[ContextAdapter] Failed to delete fallback message:', err);
                        });
                    }, deleteAfter);
                }
            } catch (replyError) {
                console.error('[ContextAdapter] Even fallback reply failed:', replyError);
            }
        }
    }
    // In ContextAdapter:
    async replyWithPhoto(
        photo: string | Buffer | InputFile | PhotoSource,
        options: PhotoMessageOptions = {},
        autoDeleteOptions?: { messageType: string }
    ): Promise<MessageResponse | void> {
        if (this.isTelegramMessage()) {
            try {
                if (!this.telegramContext) {
                    throw new Error('Telegram context not available');
                }

                let telegramPhoto: string | InputFile;

                if (typeof photo === 'string') {
                    // If it's a URL or file_id, use directly
                    telegramPhoto = photo;
                } else if (Buffer.isBuffer(photo)) {
                    // If it's a Buffer
                    telegramPhoto = { source: photo };
                } else if ('source' in photo && typeof photo.source === 'string') {
                    // If it's a file path, read it
                    if (existsSync(photo.source)) {
                        const stream = createReadStream(photo.source);
                        telegramPhoto = { source: stream };
                    } else {
                        throw new Error('File not found');
                    }
                } else {
                    // If it's already an InputFile
                    telegramPhoto = photo as InputFile;
                }

                const message = await this.telegramContext.replyWithPhoto(telegramPhoto, {
                    ...options,
                    parse_mode: (options.parse_mode || 'HTML') as TelegramParseMode
                });

                if (autoDeleteOptions) {
                    await this.scheduleAutoDelete(message.message_id, autoDeleteOptions.messageType);
                }

                return message;
            } catch (error) {
                console.error('Error sending photo:', error);
                if (options.caption) {
                    return this.reply(options.caption, {
                        reply_markup: options.reply_markup,
                        parse_mode: options.parse_mode
                    });
                }
            }
        } else {
            // For non-Telegram platforms, just send the caption
            if (options.caption) {
                return this.reply(options.caption);
            }
        }
    }

    async editMessageCaption(
        caption: string,
        options: {
            message_id?: number;
            chat_id?: number | string;
            reply_markup?: any;
            parse_mode?: TelegramParseMode;
        } = {}
    ): Promise<true | Message.CaptionableMessage | undefined> {
        if (this.isTelegramMessage() && this.telegramContext) {
            try {
                const messageId = options.message_id || this.context.messageId;
                const chatId = options.chat_id || this.context.chatId;

                if (!messageId) {
                    console.warn('No message ID provided for caption edit');
                    return undefined;
                }

                return await this.telegramContext.telegram.editMessageCaption(
                    chatId,
                    messageId as number,
                    undefined,
                    caption,
                    {
                        parse_mode: options.parse_mode || 'HTML',
                        reply_markup: options.reply_markup
                    }
                );
            } catch (error) {
                console.error('Error editing message caption:', error);
                return undefined;
            }
        } else {
            console.log(`Simulating editMessageCaption: ${caption}`);
            return undefined;
        }
    }

    // In ContextAdapter.ts, add a method for sending videos:
    async replyWithVideo(
        video: string | { source: string | Buffer },
        options: PhotoMessageOptions = {},
        autoDeleteOptions?: { messageType: string }
    ): Promise<MessageResponse | void> {
        if (this.isTelegramMessage() && this.telegramContext) {
            try {
                // Initialize the variable with a type assertion
                let telegramVideo: string | InputFile;

                if (typeof video === 'string') {
                    telegramVideo = video;
                } else if ('source' in video) {
                    if (typeof video.source === 'string') {
                        if (existsSync(video.source)) {
                            const stream = createReadStream(video.source);
                            telegramVideo = { source: stream } as InputFile;
                        } else {
                            throw new Error(`Video file not found: ${video.source}`);
                        }
                    } else {
                        telegramVideo = { source: video.source } as InputFile;
                    }
                } else {
                    // Default initialization if none of the above conditions match
                    throw new Error('Invalid video format provided');
                }

                const message = await this.telegramContext.replyWithVideo(telegramVideo, {
                    ...options,
                    parse_mode: (options.parse_mode || 'HTML') as TelegramParseMode
                });

                if (autoDeleteOptions) {
                    await this.scheduleAutoDelete(message.message_id, autoDeleteOptions.messageType);
                }

                return message;
            } catch (error) {
                console.error('Error sending video:', error);
                if (options.caption) {
                    return this.reply(options.caption, {
                        reply_markup: options.reply_markup,
                        parse_mode: options.parse_mode
                    });
                }
            }
        } else {
            if (options.caption) {
                return this.reply(options.caption);
            }
        }
    }
    async editMessageMedia(
        media: InputMedia,
        options: EditMessageMediaOptions
    ): Promise<any> {
        if (this.isTelegramMessage() && this.telegramContext) {
            try {
                // Get message ID and ensure it's a number
                let messageId: number | undefined;
                if (options.message_id) {
                    messageId = options.message_id;
                } else if (this.context.messageId) {
                    messageId = typeof this.context.messageId === 'string' ?
                        parseInt(this.context.messageId, 10) :
                        this.context.messageId as number;
                }

                if (messageId === undefined || isNaN(messageId)) {
                    throw new Error('Invalid or missing message ID');
                }

                // For file paths, convert to streams
                if (media.type === 'video' && typeof media.media === 'object' && 'source' in media.media) {
                    const sourcePath = media.media.source as string;
                    if (typeof sourcePath === 'string' && existsSync(sourcePath)) {
                        media.media = { source: createReadStream(sourcePath) } as InputFile;
                    }
                }

                return await this.telegramContext.telegram.editMessageMedia(
                    options.chat_id || this.context.chatId,
                    messageId,
                    undefined,
                    media,
                    { reply_markup: options.reply_markup }
                );
            } catch (error) {
                console.error('Error editing message media:', error);
                throw error;
            }
        } else {
            console.log(`Simulating editMessageMedia for ${media.type}`);
            return undefined;
        }
    }
    private async scheduleAutoDelete(messageId: number, messageType: string): Promise<void> {
        const deleteTime = this.getDeleteTime(messageType);

        setTimeout(async () => {
            try {
                await this.deleteMessage(messageId);
            } catch (error) {
                console.error(`Failed to auto-delete message ${messageId}:`, error);
            }
        }, deleteTime);
    }

    private getDeleteTime(messageType: string): number {
        return this.messageAutoDeleteTimes[messageType] || 60000; // Default to 1 minute
    }

    /*
    public isTelegramMessage(): boolean {
        console.log('[ContextAdapter:isTelegramMessage] Checking message source:', {
            source: this.context.source,
            hasTelegramContext: !!this.telegramContext,
            contextType: this.context.raw ? typeof this.context.raw : 'undefined'
        });
        return this.context.source === 'telegram' && !!this.telegramContext;
    }s
        */
    // Helper method to check if this is a Telegram message context
    public isTelegramMessage(): boolean {
        const context = this.getMessageContext();
        const hasTelegramContext = !!this.context && typeof this.context === 'object';

        console.log(`[ContextAdapter:isTelegramMessage] Checking message source: { source: '${context.source}', hasTelegramContext: ${hasTelegramContext}, contextType: '${typeof this.context}' }`);

        return context.source === 'telegram' && hasTelegramContext;
    }
    /**
     * Cleans HTML content to be compatible with Telegram's limited HTML support
     * Telegram only supports: <b>, <i>, <u>, <s>, <a>, <code>, <pre>
     */
    private cleanHtmlForTelegram(html: string): string {
        if (!html) return '';
    
        // Replace <br> tags with newlines
        let cleaned = html.replace(/<br\s*\/?>/gi, '\n');
    
        // Replace lists with simpler formats
        cleaned = cleaned.replace(/<ul>([\s\S]*?)<\/ul>/gi, function(match: string, content: string) {
            return content.replace(/<li>([\s\S]*?)<\/li>/gi, '• $1\n');
        });
    
        cleaned = cleaned.replace(/<ol>([\s\S]*?)<\/ol>/gi, function(match: string, content: string) {
            let index = 1;
            return content.replace(/<li>([\s\S]*?)<\/li>/gi, function(m: string, item: string) {
                return `${index++}. ${item}\n`;
            });
        });
    
        // Keep only supported HTML tags
        // Telegram only supports <b>, <i>, <u>, <s>, <a>, <code>, <pre>
        const supportedTagsRegex = /<(?!\/?(?:b|i|u|s|a|code|pre)\b)[^>]+>/gi;
        cleaned = cleaned.replace(supportedTagsRegex, '');
    
        // Remove consecutive newlines (more than 2)
        cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
    
        return cleaned;
    }

    // Add to ContextAdapter.ts

/**
 * Edits the reply markup of a message
 * @param messageId Message ID to edit
 * @param replyMarkup New reply markup, or undefined to remove markup
 * @returns Result of the edit operation
 */
public async editMessageReplyMarkup(
    messageId: number, 
    replyMarkup?: any
): Promise<any> {
    if (this.isTelegramMessage() && this.telegramContext) {
        try {
            return await this.telegramContext.telegram.editMessageReplyMarkup(
                this.context.chatId,
                messageId,
                undefined,
                replyMarkup
            );
        } catch (error) {
            console.error('Error editing message reply markup:', error);
            return false;
        }
    } else {
        console.log(`Simulating editMessageReplyMarkup for message ${messageId}`);
        return true;
    }
}
    // Add more methods as needed, with platform-specific handling
}